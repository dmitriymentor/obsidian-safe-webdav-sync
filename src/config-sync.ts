import { Platform, type App } from "obsidian";
import type { ImportedConfig } from "./types";
import { WebDav, isStrongEtag } from "./webdav";
import { RcloneCrypto } from "./crypto";

const PREFIX = ".safe-sync-settings/v1/";
const GLOBAL = new Set(["app.json", "appearance.json", "core-plugins.json", "community-plugins.json", "hotkeys.json", "types.json", "templates.json", "daily-notes.json", "bookmarks.json", "graph.json"]);
const PRIVATE = new Set(["safe-webdav-sync", "remotely-save", "obsidian-local-rest-api", "realclaudian", "agent-client"]);
export interface ConfigState { localHash: string; remoteHash: string; remoteFingerprint?: string }
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
function buffer(bytes: Uint8Array): ArrayBuffer { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
async function hash(bytes: ArrayBuffer): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join(""); }
function allowed(path: string): boolean {
  if (!path.startsWith(".obsidian/") || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === "..") || /[\u0000-\u001f]/.test(path)) return false;
  const relative = path.slice(10), parts = relative.split("/");
  if (parts.length === 1) return GLOBAL.has(relative);
  if (["snippets", "themes"].includes(parts[0]!)) return !parts.some(p => p.startsWith(".")) && /\.(css|json)$/.test(path);
  if (parts[0] !== "plugins" || parts.length !== 3) return false;
  // Binaries can update the sync client itself, but its runtime journal is private.
  if (["main.js", "manifest.json", "styles.css"].includes(parts[2]!)) return !["obsidian-local-rest-api", "realclaudian", "agent-client"].includes(parts[1]!);
  return parts[2] === "data.json" && !PRIVATE.has(parts[1]!);
}

export async function syncConfiguration(app: App, config: ImportedConfig, state: Record<string, ConfigState>, save: () => Promise<void>, progress: (label: string, done: number, total: number) => void): Promise<{ uploaded: number; downloaded: number; errors: string[]; reload: boolean }> {
  const result = { uploaded: 0, downloaded: 0, errors: [] as string[], reload: false };
  const adapter = app.vault.adapter, webdav = new WebDav(config.address, config.username, config.webdavPassword, config.remoteBaseDir), crypt = new RcloneCrypto(config.encryptionPassword);
  const local = new Map<string, ArrayBuffer>(), remote = new Map<string, { encrypted: string; etag: string }>();
  const desktop = new Set<string>();
  async function scan(folder: string): Promise<void> {
    if (!await adapter.exists(folder)) return;
    const items = await adapter.list(folder);
    for (const file of items.files) if (allowed(file)) local.set(file, await adapter.readBinary(file));
    for (const next of items.folders) if ([".obsidian/plugins", ".obsidian/snippets", ".obsidian/themes"].some(root => next === root || next.startsWith(root + "/"))) await scan(next);
  }
  await scan(".obsidian");
  for (const entry of await webdav.list(undefined, async encrypted => { const path = (await crypt.decryptPath(encrypted)).replace(/\/+$/, "");return PREFIX.startsWith(path + "/") || path.startsWith(PREFIX); })) {
    const decoded = (await crypt.decryptPath(entry.encryptedPath)).replace(/\/+$/, "");
    if (!entry.isDirectory && decoded.startsWith(PREFIX) && allowed(decoded.slice(PREFIX.length))) remote.set(decoded.slice(PREFIX.length), { encrypted: entry.encryptedPath, etag: entry.etag });
  }
  const manifests = new Map<string, ArrayBuffer>();
  if (Platform.isMobile) {
    for (const [path, entry] of remote) if (/\/plugins\/[^/]+\/manifest.json$/.test(path)) {
      const object = await webdav.getObject(entry.encrypted);
      if (!object) throw new Error("Исчез манифест плагина: " + path);
      const bytes = await crypt.decrypt(object.bytes);manifests.set(path, bytes);
      if (JSON.parse(decoder.decode(bytes)).isDesktopOnly) desktop.add(path.split("/")[2]!);
    }
  }
  const paths = [...new Set([...local.keys(), ...remote.keys()])].sort((a,b) => a.endsWith("manifest.json") ? -1 : b.endsWith("manifest.json") ? 1 : a.localeCompare(b));
  const devicePath = (path: string, bytes: ArrayBuffer): ArrayBuffer => path === ".obsidian/community-plugins.json" && Platform.isMobile
    ? buffer(encoder.encode(JSON.stringify(JSON.parse(decoder.decode(bytes)).filter((id: string) => !desktop.has(id)), null, 2))) : bytes;
  const assertLocal = async (path: string, expected?: ArrayBuffer) => {
    const actual = await adapter.exists(path) ? await adapter.readBinary(path) : undefined;
    if ((actual ? await hash(actual) : undefined) !== (expected ? await hash(expected) : undefined)) throw new Error("Настройка изменилась во время синхронизации");
  };
  const backup = async (path: string, bytes: ArrayBuffer) => {
    const name = ".safe-sync-config-backups/" + await hash(bytes) + "/" + path;
    const parts = name.split("/");parts.pop();let current = "";
    for (const part of parts) { current = current ? current + "/" + part : part;if (!await adapter.exists(current)) await adapter.mkdir(current); }
    if (!await adapter.exists(name)) await adapter.writeBinary(name, bytes);
  };
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index]!;
    if (Platform.isMobile && desktop.has(path.split("/")[2]!)) continue;
    progress("Синхронизирую настройки и плагины", index, paths.length);
    try {
      const l = local.get(path), entry = remote.get(path), prev = state[path];
      const lh = l ? await hash(l) : undefined;
      if (l && prev && lh === prev.localHash && entry && isStrongEtag(entry.etag) && entry.etag === prev.remoteFingerprint) continue;
      const object = entry ? await webdav.getObject(entry.encrypted) : undefined;
      if (entry && !object) throw new Error("Настройка исчезла с сервера");
      const r = object ? await crypt.decrypt(object.bytes) : undefined;
      const rh = r ? await hash(r) : undefined;
      const projected = r ? devicePath(path,r) : undefined;
      if (l && projected && lh === await hash(projected)) { state[path] = {localHash: lh!, remoteHash: rh!,remoteFingerprint:object?.etag};continue; }
      if (l && r && prev && lh !== prev.localHash && rh !== prev.remoteHash) {
        await backup(path,l);await backup(path,r);throw new Error("Конфликт настройки; обе версии сохранены в .safe-sync-config-backups");
      }
      // A fresh phone adopts the published profile; absence never means deletion.
      if (r && (!l || !prev || lh === prev.localHash)) {
        if (l) await backup(path,l);
        await assertLocal(path,l);
        const parts = path.split("/");parts.pop();let folder = "";
        for (const part of parts) { folder = folder ? folder + "/" + part : part;if (!await adapter.exists(folder)) await adapter.mkdir(folder); }
        if (path.endsWith(".json")) JSON.parse(decoder.decode(projected!));
        await adapter.writeBinary(path,projected!);
        state[path] = {localHash: await hash(projected!),remoteHash: rh!,remoteFingerprint:object?.etag};result.downloaded++;result.reload = true;
      } else if (l) {
        let upload = l;
        if (Platform.isMobile && path === ".obsidian/community-plugins.json" && r) {
          const common = JSON.parse(decoder.decode(l)), existing = JSON.parse(decoder.decode(r));
          upload = buffer(encoder.encode(JSON.stringify([...new Set([...common, ...existing.filter((id: string) => desktop.has(id))])], null, 2)));
        }
        if (path.endsWith(".json")) JSON.parse(decoder.decode(upload));
        await assertLocal(path,l);
        const encrypted = await crypt.encryptPath(PREFIX + path);
        if (object && !isStrongEtag(object.etag)) throw new Error("Сервер не предоставил безопасный ETag для изменения настройки");
        await webdav.put(encrypted,await crypt.encrypt(upload),object ? {"If-Match":object.etag} : {"If-None-Match":"*"});
        const uploaded = await webdav.getObject(encrypted);
        if (!uploaded || await hash(await crypt.decrypt(uploaded.bytes)) !== await hash(upload)) throw new Error("Не подтверждена загрузка настройки");
        state[path] = {localHash:lh!,remoteHash:await hash(upload),remoteFingerprint:uploaded.etag};result.uploaded++;
      }
    } catch (error) { result.errors.push(path + ": " + (error instanceof Error ? error.message : String(error))); }
  }
  await save();return result;
}
