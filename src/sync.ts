import { normalizePath, TFile, type App } from "obsidian";
import { RcloneCrypto } from "./crypto";
import { mergeMarkdown, type MergeTimes } from "./merge";
import { hasLegacyConflicts, planLegacyRepair, repairLegacyConflicts } from "./repair";
import type { FileState, ImportedConfig, RemoteEntry, SyncProgress, SyncSummary } from "./types";
import { WebDav, isStrongEtag, type RawRemoteEntry } from "./webdav";
import { DeletionJournal, JOURNAL, deletionConflicts, needsMassConfirmation, userPath } from "./deletions";
import { backupRunId } from "./backups";
import { syncWriteOptions } from "./file-times";
import { BackupStore, type BackupRecord } from "./backup-store";
import type { DeletionHooks, DeleteIntent } from "./types";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();
const SAFETY_PREFIX = ".safe-sync-safety/";
const LOCAL_BACKUPS = "Safe Sync Backups";
const MAX_BASE_TEXT_BYTES = 2 * 1024 * 1024;

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function shouldSkip(path: string): boolean {
  const p = path.replace(/^\/+/, "");
  return !userPath(p);
}

export async function hashBuffer(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function fingerprint(entry: RawRemoteEntry): string {
  return entry.etag || `${entry.size}:${entry.mtime}`;
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export class SyncEngine {
  private readonly app: App;
  private readonly config: ImportedConfig;
  private readonly webdav: WebDav;
  private readonly crypt: RcloneCrypto;
  private readonly state: Record<string, FileState>;
  private readonly saveState: () => Promise<void>;
  private readonly onProgress?: (progress: SyncProgress) => void;
  private readonly runId = backupRunId();
  private journalPaths: string[] = [];
  private journal?: DeletionJournal;

  constructor(
    app: App,
    config: ImportedConfig,
    state: Record<string, FileState>,
    saveState: () => Promise<void>,
    onProgress?: (progress: SyncProgress) => void,
    private readonly deletionHooks?: DeletionHooks
  ) {
    this.app = app;
    this.config = config;
    this.state = state;
    this.saveState = saveState;
    this.onProgress = onProgress;
    this.webdav = new WebDav(config.address, config.username, config.webdavPassword, config.remoteBaseDir);
    this.crypt = new RcloneCrypto(config.encryptionPassword);
  }

  async check(): Promise<void> {
    await this.webdav.check();
    const first = (await this.webdav.list()).find((x) => !x.isDirectory);
    if (first) await this.crypt.decryptPath(first.encryptedPath);
  }

  async run(dryRun = false): Promise<SyncSummary> {
    const summary: SyncSummary = {
      uploaded: 0, downloaded: 0, merged: 0, conflicts: 0,
      deleted: 0, unchanged: 0, repaired: 0, errors: []
    };
    const local = new Map<string, { file: TFile; bytes: ArrayBuffer; hash: string; mtime: number }>();
    const localFiles = this.app.vault.getFiles().filter((file) => !shouldSkip(file.path));
    this.progress("local", "Читаю локальные файлы", 0, localFiles.length);
    for (let index = 0; index < localFiles.length; index++) {
      const file = localFiles[index]!;
      if (shouldSkip(file.path)) continue;
      const bytes = await this.app.vault.readBinary(file);
      local.set(file.path, { file, bytes, hash: await hashBuffer(bytes), mtime: file.stat.mtime });
      this.progress("local", "Читаю локальные файлы", index + 1, localFiles.length, file.path);
    }
    this.progress("remote", "Получаю список с сервера", 0, 1);
    const remote = await this.readRemoteIndex();
    if (this.deletionHooks) {
      this.journal = new DeletionJournal(this.webdav, this.crypt, this.deletionHooks.data);
      await this.journal.load(this.journalPaths);
      if (!dryRun) { this.journal.remember(); await this.saveState(); }
    }
    this.progress("remote", "Список с сервера получен", 1, 1);
    const expectedRemoteCount = Object.values(this.state).filter((item) => item.existsRemote).length;
    const acknowledgedDeletions = this.journal?.active.size ?? 0;
    if (expectedRemoteCount >= 10 && remote.size + acknowledgedDeletions < expectedRemoteCount * 0.5) {
      throw new Error(
        `Защитная остановка: сервер вернул только ${remote.size} из ожидаемых ${expectedRemoteCount} файлов. Локальные файлы не изменены.`
      );
    }
    const pending = [...(this.deletionHooks?.data.pending ?? [])];
    const deletionPaths = [...new Set([...pending.map(p => p.path), ...(this.journal?.active.keys() ?? [])])];
    const effectiveDeletions = deletionPaths.filter(p => local.has(p) || remote.has(p));
    if (needsMassConfirmation(effectiveDeletions.length, Math.max(local.size, remote.size)) && !dryRun) {
      if (!await this.deletionHooks?.confirmMass?.(effectiveDeletions)) {
        throw new Error(`Ожидают подтверждения ${effectiveDeletions.length} удалений. Запустите синхронизацию вручную`);
      }
    }
    const paths = [...new Set([...local.keys(), ...remote.keys(), ...Object.keys(this.state)])]
      .filter(p => !deletionPaths.includes(p)).sort();

    for (let index = 0; index < paths.length; index++) {
      const path = paths[index]!;
      this.progress("files", "Синхронизирую файлы", index, paths.length, path);
      try {
        if (this.deletionHooks?.data.pending.some(intent => intent.path === path)) continue;
        await this.syncOne(path, local.get(path), remote.get(path), dryRun, summary);
      } catch (error) {
        summary.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.progress("files", "Синхронизирую файлы", index + 1, paths.length, path);
    }
    for (const path of deletionPaths) {
      this.progress("files", "Проверяю удаление", 0, 0, path);
      try {
        const intent = pending.find(p => p.path === path);
        if (intent && !dryRun) {
          // A local re-creation cancels an unpublished event. A rename is
          // published only after its destination has reached the server.
          if (this.app.vault.getAbstractFileByPath(path)) {
            this.deletionHooks!.data.pending = this.deletionHooks!.data.pending.filter(p => p.id !== intent.id);
            await this.saveState();
            continue;
          }
          if (intent.renameTo) {
            const target = this.app.vault.getAbstractFileByPath(intent.renameTo);
            const object = await this.webdav.getObject(await this.crypt.encryptPath(intent.renameTo));
            if (!(target instanceof TFile) || !object ||
                await hashBuffer(await this.crypt.decrypt(object.bytes)) !== await hashBuffer(await this.app.vault.readBinary(target))) {
              throw new Error("Переименование ожидает загрузки нового пути; старый файл на сервере сохранён");
            }
          }
          await this.journal!.publish(intent);
          this.deletionHooks!.data.pending = this.deletionHooks!.data.pending.filter(p => p.id !== intent.id);
          await this.saveState();
        }
        const intents = this.journal?.active.get(path) ?? (intent ? [intent] : []);
        if (intents.length) await this.applyDeletion(path, intents, dryRun, summary);
      } catch (error) { summary.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!dryRun) {
      this.progress("saving", "Сохраняю индекс синхронизации", 0, 1);
      await this.saveState();
      this.progress("saving", "Индекс сохранён", 1, 1);
    }
    return summary;
  }

  private progress(
    phase: SyncProgress["phase"],
    label: string,
    completed: number,
    total: number,
    path?: string
  ): void {
    this.onProgress?.({ phase, label, completed, total, path });
  }

  private async readRemoteIndex(): Promise<Map<string, RemoteEntry>> {
    const index = new Map<string, RemoteEntry>();
    this.journalPaths = [];
    for (const raw of await this.webdav.list((completed, total) =>
      this.progress("remote", "Читаю папки сервера", completed, total), async encryptedPath => {
        const path = (await this.crypt.decryptPath(encryptedPath)).replace(/\/+$/, "") + "/";
        return !path.startsWith(SAFETY_PREFIX) && !path.startsWith(`${LOCAL_BACKUPS}/`) && !path.startsWith(".obsidian/");
      })) {
      try {
        const path = (await this.crypt.decryptPath(raw.encryptedPath)).replace(/^\/+/, "").replace(/\/+$/, "");
        if (!raw.isDirectory && path.startsWith(JOURNAL)) this.journalPaths.push(path);
        if (!path || raw.isDirectory || shouldSkip(path)) continue;
        index.set(path, { path, encryptedPath: raw.encryptedPath, isDirectory: false,
          size: raw.size, mtime: raw.mtime, etag: fingerprint(raw) });
      } catch {
        // A foreign or damaged object must never stop the rest of the vault.
      }
    }
    return index;
  }

  private async remoteBytes(entry: RemoteEntry): Promise<ArrayBuffer> {
    return this.crypt.decrypt(await this.webdav.get(entry.encryptedPath));
  }

  private async upload(path: string, bytes: ArrayBuffer): Promise<string> {
    const encryptedPath = await this.crypt.encryptPath(path);
    return this.webdav.put(encryptedPath, await this.crypt.encrypt(bytes));
  }

  private async syncOne(
    path: string,
    local: { file: TFile; bytes: ArrayBuffer; hash: string; mtime: number } | undefined,
    remote: RemoteEntry | undefined,
    dryRun: boolean,
    summary: SyncSummary
  ): Promise<void> {
    const previous = this.state[path];
    let inspectedRemote: ArrayBuffer | undefined;
    if (isMarkdown(path) && await this.tryLegacyRepair(path, local, remote, previous, dryRun, summary,
      (bytes) => { inspectedRemote = bytes; })) return;
    // The legacy check may already have downloaded this exact object. Reuse it
    // only for this file/operation; repair verification and deletion stay fresh.
    const readRemote = async (entry: RemoteEntry) => inspectedRemote ?? this.remoteBytes(entry);
    if (!local && !remote) {
      if (!dryRun) delete this.state[path];
      return;
    }
    if (!previous) {
      if (local && !remote) {
        if (!dryRun) this.state[path] = await this.uploadAndState(path, local.bytes, local.hash);
        summary.uploaded++;
        return;
      }
      if (!local && remote) {
        const bytes = await readRemote(remote);
        if (!dryRun) await this.writeLocal(path, bytes, remote.mtime);
        if (!dryRun) this.state[path] = this.makeState(bytes, await hashBuffer(bytes), remote.etag);
        summary.downloaded++;
        return;
      }
      if (local && remote) {
        const rbytes = await readRemote(remote);
        const rhash = await hashBuffer(rbytes);
        if (local.hash === rhash) {
          if (!dryRun) this.state[path] = this.makeState(local.bytes, local.hash, remote.etag);
          summary.unchanged++;
        } else {
          await this.resolveBothChanged(path, local.bytes, rbytes, "", dryRun, summary,
            { localMtime: local.mtime, remoteMtime: remote.mtime });
        }
      }
      return;
    }

    if (!local && remote) {
      const rbytes = await readRemote(remote);
      const rhash = await hashBuffer(rbytes);
      // A missing local file can be an incomplete mobile listing or an app-side
      // move. Restore from the encrypted server instead of deleting remotely.
      if (!dryRun) await this.writeLocal(path, rbytes, remote.mtime);
      if (!dryRun) this.state[path] = this.makeState(rbytes, rhash, remote.etag);
      summary.downloaded++;
      return;
    }

    if (local && !remote) {
      // Never infer a remote deletion from one incomplete WebDAV response.
      // Re-uploading is lossless; explicit deletion sync can be added later
      // with durable tombstones acknowledged by both devices.
      if (!dryRun) this.state[path] = await this.uploadAndState(path, local.bytes, local.hash);
      summary.uploaded++;
      return;
    }

    const l = local!;
    const r = remote!;
    const localChanged = l.hash !== previous.baseHash;
    let remoteChanged = r.etag !== previous.remoteFingerprint;
    let rbytes: ArrayBuffer | undefined;
    let rhash = previous.baseHash;
    if (remoteChanged) {
      rbytes = await readRemote(r);
      rhash = await hashBuffer(rbytes);
      remoteChanged = rhash !== previous.baseHash;
    }

    if (!localChanged && !remoteChanged) {
      if (!dryRun) this.state[path] = { ...previous, localHash: l.hash, remoteFingerprint: r.etag, lastSync: Date.now() };
      summary.unchanged++;
    } else if (localChanged && !remoteChanged) {
      if (!dryRun) this.state[path] = await this.uploadAndState(path, l.bytes, l.hash);
      summary.uploaded++;
    } else if (!localChanged && remoteChanged) {
      rbytes ??= await readRemote(r);
      if (!dryRun) await this.writeLocal(path, rbytes, r.mtime);
      if (!dryRun) this.state[path] = this.makeState(rbytes, rhash, r.etag);
      summary.downloaded++;
    } else {
      rbytes ??= await readRemote(r);
      await this.resolveBothChanged(path, l.bytes, rbytes, previous.baseText ?? "", dryRun, summary,
        { localMtime: l.mtime, remoteMtime: r.mtime });
    }
  }

  private async tryLegacyRepair(
    path: string,
    local: { file: TFile; bytes: ArrayBuffer; hash: string; mtime: number } | undefined,
    remote: RemoteEntry | undefined,
    previous: FileState | undefined,
    dryRun: boolean,
    summary: SyncSummary,
    onInspected?: (bytes: ArrayBuffer) => void
  ): Promise<boolean> {
    const localText = local ? textDecoder.decode(local.bytes) : "";
    const base = previous?.baseText ?? "";
    if (!hasLegacyConflicts(localText) && !hasLegacyConflicts(base) &&
        (!remote || (previous && remote.etag === previous.remoteFingerprint))) return false;
    const encryptedPath = await this.crypt.encryptPath(path);
    const object = await this.webdav.getObject(encryptedPath);
    if (remote && !object) throw new Error("Файл изменился на сервере во время проверки старых конфликтов");
    const remoteBytes = object ? await this.crypt.decrypt(object.bytes) : undefined;
    const remoteText = remoteBytes ? textDecoder.decode(remoteBytes) : "";
    if (![localText, base, remoteText].some(hasLegacyConflicts)) {
      if (remote && object && remoteBytes) {
        // Pair the reused bytes with the validator from their own GET, not a
        // possibly older directory listing. Nothing persists across runs.
        remote.etag = object.etag || remote.etag;
        onInspected?.(remoteBytes);
      }
      return false;
    }
    if (!local && !object) return false;
    const repair = local && object
      ? planLegacyRepair(localText, base, remoteText, { localMtime: local.mtime, remoteMtime: remote?.mtime ?? 0 })!
      : { ...repairLegacyConflicts(local ? localText : remoteText), conflict: false };
    const bytes = toArrayBuffer(textEncoder.encode(repair.text));
    const hash = await hashBuffer(bytes);
    if (!dryRun) {
      this.progress("files", "Убираю старые конфликтные блоки", 0, 0, path);
      const assertLocalUnchanged = async () => {
        const current = this.app.vault.getAbstractFileByPath(path);
        if (this.deletionHooks?.data.pending.some(intent => intent.path === path) ||
            (local ? !(current instanceof TFile) || await hashBuffer(await this.app.vault.readBinary(current)) !== local.hash : current !== null)) {
          throw new Error("Заметка изменена во время исправления — повторите синхронизацию");
        }
      };
      await assertLocalUnchanged();
      const changesLocal = !local || local.hash !== hash;
      const changesRemote = !remoteBytes || await hashBuffer(remoteBytes) !== hash;
      // Fail before creating archives when this repair cannot be committed.
      if (changesRemote && object && !isStrongEtag(object.etag)) {
        const reason = !object.etag ? "заголовок отсутствует или неоднозначен" : object.etag.startsWith("W/") ? "сервер вернул слабый ETag" : "некорректный формат заголовка";
        throw new Error(`Нет надёжного ETag для безопасного исправления (${reason})`);
      }
      if (changesLocal || changesRemote) await this.backupBoth(path, local?.bytes, remoteBytes);
      await assertLocalUnchanged();
      if (changesRemote) {
        await this.webdav.put(encryptedPath, await this.crypt.encrypt(bytes), object
          ? { "If-Match": object.etag } : { "If-None-Match": "*" });
      }
      // Verify even when no upload was needed: another client may have written
      // while we were creating the backups. Never install an unverified base.
      const verified = await this.webdav.getObject(encryptedPath);
      if (!verified || await hashBuffer(await this.crypt.decrypt(verified.bytes)) !== hash) {
        throw new Error("Сервер изменился после исправления — локальная версия сохранена");
      }
      await assertLocalUnchanged();
      if (changesLocal) await this.writeLocal(path, bytes, Math.max(local?.mtime ?? 0, remote?.mtime ?? 0));
      this.state[path] = this.makeState(bytes, hash, verified.etag);
      await this.saveState();
    }
    summary.repaired++;
    if (repair.conflict) summary.conflicts++;
    return true;
  }

  private async resolveBothChanged(
    path: string,
    localBytes: ArrayBuffer,
    remoteBytes: ArrayBuffer,
    baseText: string,
    dryRun: boolean,
    summary: SyncSummary,
    times: MergeTimes
  ): Promise<void> {
    if (isMarkdown(path)) {
      const localText = textDecoder.decode(localBytes);
      const remoteText = textDecoder.decode(remoteBytes);
      const merged = mergeMarkdown(localText, baseText, remoteText, times);
      const mergedBytes = toArrayBuffer(textEncoder.encode(merged.text));
      if (!dryRun) {
        if (merged.conflict) await this.backupBoth(path, localBytes, remoteBytes);
        await this.writeLocal(path, mergedBytes, Math.max(times.localMtime, times.remoteMtime));
        this.state[path] = await this.uploadAndState(path, mergedBytes, await hashBuffer(mergedBytes));
      }
      summary.merged++;
      if (merged.conflict) summary.conflicts++;
      return;
    }
    if (!dryRun) {
      await this.backupBoth(path, localBytes, remoteBytes);
      this.state[path] = await this.uploadAndState(path, localBytes, await hashBuffer(localBytes));
    }
    summary.conflicts++;
  }

  private makeState(bytes: ArrayBuffer, hash: string, remoteFingerprint: string): FileState {
    let baseText: string | undefined;
    if (bytes.byteLength <= MAX_BASE_TEXT_BYTES) {
      try { baseText = textDecoder.decode(bytes); } catch { /* binary */ }
    }
    return { baseHash: hash, baseText, localHash: hash, remoteFingerprint,
      existsLocal: true, existsRemote: true, lastSync: Date.now() };
  }

  private async uploadAndState(path: string, bytes: ArrayBuffer, hash: string): Promise<FileState> {
    const etag = await this.upload(path, bytes);
    return this.makeState(bytes, hash, etag);
  }

  private async ensureLocalFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) await this.app.vault.createFolder(current);
    }
  }

  private async writeLocal(path: string, bytes: ArrayBuffer, sourceMtime?: number): Promise<void> {
    if (this.deletionHooks?.data.pending.some(intent => intent.path === path)) throw new Error("Файл удалён пользователем во время синхронизации; ожидает обработки удаления");
    await this.ensureLocalFolder(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    // Identical merges must not emit modify or move the filesystem clock.
    if (existing instanceof TFile && await hashBuffer(await this.app.vault.readBinary(existing)) === await hashBuffer(bytes)) return;
    const options = syncWriteOptions(path, bytes, existing instanceof TFile ? existing.stat : undefined, sourceMtime);
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, bytes, options);
    else await this.app.vault.createBinary(path, bytes, options);
  }

  private async backupBoth(path: string, local?: ArrayBuffer, remote?: ArrayBuffer): Promise<void> {
    const store = this.backupStore();
    for (const bytes of [local, remote]) if (bytes) await store.save(path, bytes, "conflict");
  }

  private backupStore(): BackupStore { return new BackupStore(this.app.vault.adapter, this.crypt, this.webdav); }
  async listBackups(): Promise<BackupRecord[]> { return this.backupStore().list(); }
  async exportBackup(record: BackupRecord): Promise<string> {
    const bytes = await this.backupStore().read(record);
    // Export a copy only; never replace the working note or an existing export.
    const destination = `${LOCAL_BACKUPS}/${this.runId}/Восстановленные/${record.path}`;
    if (await this.app.vault.adapter.exists(destination)) throw Error("Копия с таким путём уже есть; повторите открытие архива");
    await this.writeLocal(destination, bytes);
    return destination;
  }

  private async applyDeletion(path: string, intents: DeleteIntent[], dryRun: boolean, summary: SyncSummary): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    const local = file instanceof TFile ? await this.app.vault.readBinary(file) : undefined;
    const encryptedPath = await this.crypt.encryptPath(path);
    const object = await this.webdav.getObject(encryptedPath);
    const remote = object ? await this.crypt.decrypt(object.bytes) : undefined;
    const lhash = local ? await hashBuffer(local) : undefined;
    const rhash = remote ? await hashBuffer(remote) : undefined;
    const conflict = deletionConflicts([lhash, rhash], intents);
    if (dryRun) {
      if (conflict) summary.conflicts++; else if (local || remote) summary.deleted++;
      return;
    }
    if (conflict) {
      summary.conflicts++;
      if (local) await this.archiveDeleted(path, local, "Локальная");
      if (remote) await this.archiveDeleted(path, remote, "Сервер");
      const decision = await this.deletionHooks?.resolveConflict?.(path) ?? "later";
      if (decision === "later") throw new Error("Удаление конфликтует с правками. Версии сохранены; запустите вручную для выбора");
      if (decision === "keep") {
        await this.journal!.keep(intents);
        await this.saveState();
        // Do not merge or overwrite here. The next normal sync sees the
        // canceled tombstone and reconciles the preserved files normally.
        return;
      }
      // Record exactly the versions the user approved, never an unknown edit.
      for (const hash of new Set([lhash, rhash].filter((h): h is string => Boolean(h)))) {
        await this.journal!.publish({ id: crypto.randomUUID(), deviceId: this.deletionHooks!.data.deviceId,
          path, baseHash: hash, createdAt: new Date().toISOString() });
      }
      await this.saveState();
    }
    if (remote) await this.archiveDeleted(path, remote, "Сервер");
    if (local) await this.archiveDeleted(path, local, "Локальная");
    // Re-read the operation cancellations immediately before side effects.
    for (const intent of intents) {
      if (await this.webdav.getObject(await this.crypt.encryptPath(`${JOURNAL}keep-${intent.id}.json`))) {
        throw new Error("Удаление отменено другим устройством; повторите синхронизацию");
      }
    }
    if (object) await this.webdav.removeIfMatch(encryptedPath, object.etag);
    if (file instanceof TFile && local) {
      if (this.app.vault.getAbstractFileByPath(path) !== file || await hashBuffer(await this.app.vault.readBinary(file)) !== lhash) {
        throw new Error("Файл изменён во время удаления. Локальная версия сохранена");
      }
      const destination = `${LOCAL_BACKUPS}/${this.runId}/Удалённые/Оригиналы/${path}`;
      await this.ensureLocalFolder(destination);
      this.deletionHooks!.mutations.add(path);
      try { await this.app.vault.rename(file, destination); }
      finally { this.deletionHooks!.mutations.delete(path); }
    }
    delete this.state[path];
    await this.saveState();
    if (local || remote) summary.deleted++;
  }

  private async archiveDeleted(path: string, bytes: ArrayBuffer, _side: string): Promise<void> {
    await this.backupStore().save(path, bytes, "deletion");
  }

  async deletedPaths(): Promise<string[]> {
    if (!this.deletionHooks) return [];
    await this.readRemoteIndex();
    this.journal = new DeletionJournal(this.webdav, this.crypt, this.deletionHooks.data);
    await this.journal.load(this.journalPaths);
    return [...this.journal.active.keys()].sort();
  }

  async restoreDeleted(path: string): Promise<void> {
    await this.deletedPaths();
    const intents = this.journal!.active.get(path);
    if (!intents?.length) throw new Error("Запись об удалении не найдена");
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error("Файл с таким путём уже есть. Восстановление не будет его перезаписывать");
    let bytes: ArrayBuffer | undefined;
    for (const intent of [...intents].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const object = await this.webdav.getObject(await this.crypt.encryptPath(`${SAFETY_PREFIX}Удалённые/${intent.baseHash}/${path}`));
      if (!object) continue;
      const candidate = await this.crypt.decrypt(object.bytes);
      if (await hashBuffer(candidate) !== intent.baseHash) throw new Error("Резервная копия не прошла проверку");
      bytes = candidate; break;
    }
    if (!bytes) throw new Error("Копия ещё не загружена в корзину сервера. Проверьте локальные бекапы исходного устройства");
    await this.ensureLocalFolder(path);
    await this.writeLocal(path, bytes);
    await this.journal!.keep(intents);
    await this.saveState();
  }

}
