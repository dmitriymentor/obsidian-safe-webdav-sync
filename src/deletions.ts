import type { DeleteIntent, DeletionState } from "./types";
import type { RcloneCrypto } from "./crypto";
import type { WebDav } from "./webdav";

export const JOURNAL = ".safe-sync-meta/deletions/";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
type Record = { version: 1; kind: "delete"; intent: DeleteIntent } |
  { version: 1; kind: "keep"; deleteId: string };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);

export function userPath(path: string): boolean {
  return Boolean(path) && !path.includes("\\") && !path.startsWith("/") &&
    !/[\u0000-\u001f]/.test(path) && path.split("/").every(p => p !== "" && p !== "." && p !== "..") &&
    !path.startsWith(".") && path !== "Safe Sync Backups" && !path.startsWith("Safe Sync Backups/");
}

export function validateIntent(value: DeleteIntent): void {
  if (!value || !uuid(value.id) || !uuid(value.deviceId) || !userPath(value.path) ||
      !/^[a-f0-9]{64}$/.test(value.baseHash) || !Number.isFinite(Date.parse(value.createdAt)) ||
      (value.renameTo !== undefined && (!userPath(value.renameTo) || value.renameTo === value.path))) {
    throw new Error("Некорректная запись об удалении — синхронизация остановлена");
  }
}

export function needsMassConfirmation(count: number, total: number): boolean {
  return count >= 10 || (count >= 2 && count > total * 0.2);
}

export function deletionConflicts(hashes: Array<string | undefined>, intents: DeleteIntent[]): boolean {
  return hashes.some(hash => hash !== undefined && !intents.some(intent => intent.baseHash === hash));
}

export class DeletionJournal {
  readonly active = new Map<string, DeleteIntent[]>();
  private records = new Map<string, Record>();
  constructor(private webdav: WebDav, private crypt: RcloneCrypto, private data: DeletionState) {}

  async load(paths: string[]): Promise<void> {
    const ids = paths.filter(p => p.startsWith(JOURNAL)).map(p => p.slice(JOURNAL.length));
    for (const known of this.data.knownIds) if (!ids.includes(known)) {
      throw new Error("Исчезла часть журнала удалений. Файлы не изменены; проверьте сервер");
    }
    for (const name of ids) {
      if (!/^(delete|keep)-[a-f0-9-]{36}\.json$/.test(name)) throw new Error("Неизвестная версия журнала удалений");
      const raw = await this.webdav.get(await this.crypt.encryptPath(JOURNAL + name));
      const record = JSON.parse(decoder.decode(await this.crypt.decrypt(raw))) as Record;
      if (record.version !== 1) throw new Error("Обновите Safe Sync: неизвестная версия журнала");
      if (record.kind === "delete") {
        validateIntent(record.intent);
        if (name !== `delete-${record.intent.id}.json`) throw new Error("Неверный ID удаления");
      } else if (record.kind !== "keep" || !uuid(record.deleteId) || name !== `keep-${record.deleteId}.json`) {
        throw new Error("Некорректная отмена удаления");
      }
      this.records.set(name, record);
    }
    this.rebuild();
  }

  private rebuild(): void {
    this.active.clear();
    for (const record of this.records.values()) {
      if (record.kind !== "delete" || this.records.has(`keep-${record.intent.id}.json`)) continue;
      const list = this.active.get(record.intent.path) ?? [];
      list.push(record.intent);
      this.active.set(record.intent.path, list);
    }
  }

  remember(): void { this.data.knownIds = [...this.records.keys()].sort(); }

  async publish(intent: DeleteIntent): Promise<void> {
    validateIntent(intent);
    await this.append(`delete-${intent.id}.json`, { version: 1, kind: "delete", intent });
  }

  async keep(intents: DeleteIntent[]): Promise<void> {
    for (const intent of intents) await this.append(`keep-${intent.id}.json`, { version: 1, kind: "keep", deleteId: intent.id });
  }

  private async append(name: string, record: Record): Promise<void> {
    const path = await this.crypt.encryptPath(JOURNAL + name);
    const value = JSON.stringify(record);
    const encoded = encoder.encode(value);
    try {
      await this.webdav.put(path, await this.crypt.encrypt(encoded.buffer as ArrayBuffer), { "If-None-Match": "*" });
    } catch (error) {
      // Retrying the same durable operation is allowed; overwriting it isn't.
      const existing = await this.webdav.getObject(path);
      if (!existing || decoder.decode(await this.crypt.decrypt(existing.bytes)) !== value) throw error;
    }
    const stored = await this.webdav.get(path);
    if (decoder.decode(await this.crypt.decrypt(stored)) !== value) throw new Error("Не удалось проверить запись об удалении");
    this.records.set(name, record);
    this.rebuild();
    this.remember();
  }
}
