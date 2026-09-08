import { normalizePath, TFile, type App } from "obsidian";
import { RcloneCrypto } from "./crypto";
import { mergeMarkdown } from "./merge";
import type { FileState, ImportedConfig, RemoteEntry, SyncProgress, SyncSummary } from "./types";
import { WebDav, type RawRemoteEntry } from "./webdav";

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
  return p.startsWith(".obsidian/") || p.startsWith(`${LOCAL_BACKUPS}/`) || p.startsWith(SAFETY_PREFIX);
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

  constructor(
    app: App,
    config: ImportedConfig,
    state: Record<string, FileState>,
    saveState: () => Promise<void>,
    onProgress?: (progress: SyncProgress) => void
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
      deleted: 0, unchanged: 0, errors: []
    };
    const local = new Map<string, { file: TFile; bytes: ArrayBuffer; hash: string }>();
    const localFiles = this.app.vault.getFiles().filter((file) => !shouldSkip(file.path));
    this.progress("local", "Читаю локальные файлы", 0, localFiles.length);
    for (let index = 0; index < localFiles.length; index++) {
      const file = localFiles[index]!;
      if (shouldSkip(file.path)) continue;
      const bytes = await this.app.vault.readBinary(file);
      local.set(file.path, { file, bytes, hash: await hashBuffer(bytes) });
      this.progress("local", "Читаю локальные файлы", index + 1, localFiles.length, file.path);
    }
    this.progress("remote", "Получаю список с сервера", 0, 1);
    const remote = await this.readRemoteIndex();
    this.progress("remote", "Список с сервера получен", 1, 1);
    const paths = [...new Set([...local.keys(), ...remote.keys(), ...Object.keys(this.state)])].sort();

    for (let index = 0; index < paths.length; index++) {
      const path = paths[index]!;
      this.progress("files", "Синхронизирую файлы", index, paths.length, path);
      try {
        await this.syncOne(path, local.get(path), remote.get(path), dryRun, summary);
      } catch (error) {
        summary.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.progress("files", "Синхронизирую файлы", index + 1, paths.length, path);
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
    for (const raw of await this.webdav.list()) {
      try {
        const path = (await this.crypt.decryptPath(raw.encryptedPath)).replace(/^\/+/, "").replace(/\/+$/, "");
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
    local: { file: TFile; bytes: ArrayBuffer; hash: string } | undefined,
    remote: RemoteEntry | undefined,
    dryRun: boolean,
    summary: SyncSummary
  ): Promise<void> {
    const previous = this.state[path];
    if (!local && !remote) {
      delete this.state[path];
      return;
    }
    if (!previous) {
      if (local && !remote) {
        if (!dryRun) this.state[path] = await this.uploadAndState(path, local.bytes, local.hash);
        summary.uploaded++;
        return;
      }
      if (!local && remote) {
        const bytes = await this.remoteBytes(remote);
        if (!dryRun) await this.writeLocal(path, bytes);
        if (!dryRun) this.state[path] = this.makeState(bytes, await hashBuffer(bytes), remote.etag);
        summary.downloaded++;
        return;
      }
      if (local && remote) {
        const rbytes = await this.remoteBytes(remote);
        const rhash = await hashBuffer(rbytes);
        if (local.hash === rhash) {
          if (!dryRun) this.state[path] = this.makeState(local.bytes, local.hash, remote.etag);
          summary.unchanged++;
        } else {
          await this.resolveBothChanged(path, local.bytes, rbytes, "", dryRun, summary);
        }
      }
      return;
    }

    if (!local && remote) {
      const rbytes = await this.remoteBytes(remote);
      const rhash = await hashBuffer(rbytes);
      if (previous.existsLocal && rhash === previous.baseHash) {
        if (!dryRun) await this.archiveRemoteDeletion(path, remote);
        if (!dryRun) delete this.state[path];
        summary.deleted++;
      } else {
        if (!dryRun) await this.writeLocal(path, rbytes);
        if (!dryRun) this.state[path] = this.makeState(rbytes, rhash, remote.etag);
        summary.downloaded++;
      }
      return;
    }

    if (local && !remote) {
      const localChanged = local.hash !== previous.baseHash;
      if (previous.existsRemote && !localChanged) {
        if (!dryRun) await this.backupLocal(path, local.bytes, "удалено-на-сервере");
        if (!dryRun) await this.app.fileManager.trashFile(local.file);
        if (!dryRun) delete this.state[path];
        summary.deleted++;
      } else {
        if (!dryRun) this.state[path] = await this.uploadAndState(path, local.bytes, local.hash);
        summary.uploaded++;
      }
      return;
    }

    const l = local!;
    const r = remote!;
    const localChanged = l.hash !== previous.baseHash;
    let remoteChanged = r.etag !== previous.remoteFingerprint;
    let rbytes: ArrayBuffer | undefined;
    let rhash = previous.baseHash;
    if (remoteChanged) {
      rbytes = await this.remoteBytes(r);
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
      rbytes ??= await this.remoteBytes(r);
      if (!dryRun) await this.writeLocal(path, rbytes);
      if (!dryRun) this.state[path] = this.makeState(rbytes, rhash, r.etag);
      summary.downloaded++;
    } else {
      rbytes ??= await this.remoteBytes(r);
      await this.resolveBothChanged(path, l.bytes, rbytes, previous.baseText ?? "", dryRun, summary);
    }
  }

  private async resolveBothChanged(
    path: string,
    localBytes: ArrayBuffer,
    remoteBytes: ArrayBuffer,
    baseText: string,
    dryRun: boolean,
    summary: SyncSummary
  ): Promise<void> {
    if (isMarkdown(path)) {
      const localText = textDecoder.decode(localBytes);
      const remoteText = textDecoder.decode(remoteBytes);
      const merged = mergeMarkdown(localText, baseText, remoteText);
      const mergedBytes = toArrayBuffer(textEncoder.encode(merged.text));
      if (!dryRun) {
        if (merged.conflict) await this.backupBoth(path, localBytes, remoteBytes);
        await this.writeLocal(path, mergedBytes);
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

  private async writeLocal(path: string, bytes: ArrayBuffer): Promise<void> {
    await this.ensureLocalFolder(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, bytes);
    else await this.app.vault.createBinary(path, bytes);
  }

  private async backupLocal(path: string, bytes: ArrayBuffer, reason: string): Promise<void> {
    const backupPath = `${LOCAL_BACKUPS}/${safeTimestamp()}-${reason}/${path}`;
    await this.writeLocal(backupPath, bytes);
  }

  private async backupBoth(path: string, local: ArrayBuffer, remote: ArrayBuffer): Promise<void> {
    const stamp = safeTimestamp();
    await this.writeLocal(`${LOCAL_BACKUPS}/${stamp}-конфликт/Локальная/${path}`, local);
    await this.writeLocal(`${LOCAL_BACKUPS}/${stamp}-конфликт/Сервер/${path}`, remote);
    await this.upload(`${SAFETY_PREFIX}${stamp}/local/${path}`, local);
    await this.upload(`${SAFETY_PREFIX}${stamp}/remote/${path}`, remote);
  }

  private async archiveRemoteDeletion(path: string, remote: RemoteEntry): Promise<void> {
    const archived = await this.crypt.encryptPath(`${SAFETY_PREFIX}${safeTimestamp()}/deleted-local/${path}`);
    await this.webdav.move(remote.encryptedPath, archived);
  }
}
