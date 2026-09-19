import type { DataAdapter } from "obsidian";
import type { RcloneCrypto } from "./crypto";
import type { WebDav } from "./webdav";
import { userPath } from "./deletions";

export const BACKUP_STORE = ".safe-sync-backups/v1";
export type BackupKind = "conflict" | "deletion";
export interface BackupRecord { version: 1; path: string; hash: string; kind: BackupKind; savedAt: string }
export async function digest(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Adapter writes to encrypted, non-Markdown files outside the note index.
// No original note is changed, and no unverified archive is overwritten.
export class BackupStore {
  constructor(private adapter: DataAdapter, private crypt: RcloneCrypto, private webdav: WebDav) {}
  private async base(record: Pick<BackupRecord, "path" | "hash" | "kind">): Promise<string> {
    if (!userPath(record.path) || !/^[a-f0-9]{64}$/.test(record.hash) || !["conflict", "deletion"].includes(record.kind)) throw Error("Некорректный адрес резервной копии");
    const pathHash = await digest(new TextEncoder().encode(record.path).buffer as ArrayBuffer);
    return `${BACKUP_STORE}/${record.kind}/${pathHash}/${record.hash}`;
  }
  private async folders(file: string): Promise<void> {
    const parts = file.split("/"); parts.pop(); let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await this.adapter.exists(current)) await this.adapter.mkdir(current);
    }
  }
  async save(path: string, bytes: ArrayBuffer, kind: BackupKind): Promise<BackupRecord> {
    const hash = await digest(bytes);
    let record: BackupRecord = { version: 1, path, hash, kind, savedAt: new Date().toISOString() };
    const base = await this.base(record), file = `${base}.bin`, metadata = `${base}.json`;
    await this.folders(file);
    if (!await this.adapter.exists(file)) await this.adapter.writeBinary(file, await this.crypt.encrypt(bytes));
    await this.read(record);
    if (await this.adapter.exists(metadata)) {
      const old = JSON.parse(await this.adapter.read(metadata)) as BackupRecord;
      if (old.version !== 1 || old.path !== path || old.hash !== hash || old.kind !== kind || !Number.isFinite(Date.parse(old.savedAt))) throw Error("Метаданные бекапа повреждены; архив не перезаписан");
      record = old;
    } else {
      await this.adapter.write(metadata, JSON.stringify(record));
      if (await this.adapter.read(metadata) !== JSON.stringify(record)) throw Error("Не удалось проверить описание бекапа");
    }
    // Deletion archive paths stay compatible with previously installed clients.
    const remotePath = kind === "deletion" ? `.safe-sync-safety/Удалённые/${hash}/${path}` : `.safe-sync-safety/Конфликты/${hash}/${path}`;
    const encrypted = await this.crypt.encryptPath(remotePath);
    let remote = await this.webdav.getObject(encrypted);
    if (!remote) {
      try { await this.webdav.put(encrypted, await this.crypt.encrypt(bytes), { "If-None-Match": "*" }); }
      catch (error) {
        // Another device may have published the identical version meanwhile.
        const concurrent = await this.webdav.getObject(encrypted);
        if (!concurrent || await digest(await this.crypt.decrypt(concurrent.bytes)) !== hash) throw error;
      }
      remote = await this.webdav.getObject(encrypted);
    }
    if (!remote || await digest(await this.crypt.decrypt(remote.bytes)) !== hash) throw Error("Серверный бекап не прошёл проверку; оригиналы не изменены");
    // Also recheck the local archive after the network round trip.
    await this.read(record);
    return record;
  }
  async read(record: BackupRecord): Promise<ArrayBuffer> {
    const file = `${await this.base(record)}.bin`;
    const bytes = await this.crypt.decrypt(await this.adapter.readBinary(file));
    if (await digest(bytes) !== record.hash) throw Error("Локальный бекап не прошёл проверку; архив и оригиналы не перезаписаны");
    return bytes;
  }
  async list(): Promise<BackupRecord[]> {
    if (!await this.adapter.exists(BACKUP_STORE)) return [];
    const result: BackupRecord[] = [], queue = [BACKUP_STORE];
    while (queue.length) {
      const directory = queue.shift()!;
      const { files, folders } = await this.adapter.list(directory);
      for (const folder of folders) if (folder.startsWith(`${directory}/`)) queue.push(folder);
      for (const file of files.filter(f => f.endsWith(".json"))) {
        const record = JSON.parse(await this.adapter.read(file)) as BackupRecord;
        if (record.version !== 1 || !Number.isFinite(Date.parse(record.savedAt)) || `${await this.base(record)}.json` !== file) throw Error("Некорректный индекс архива; копии сохранены");
        result.push(record);
      }
    }
    return result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
}
