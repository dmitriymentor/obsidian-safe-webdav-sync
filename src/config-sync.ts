import { Platform, requireApiVersion, type App } from "obsidian";
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

export async function syncConfiguration(app: App, config: ImportedConfig, state: Record<string, ConfigState>, setup: Record<string, "pending" | "initialized">, save: () => Promise<void>, progress: (label: string, done: number, total: number) => void): Promise<{ uploaded: number; downloaded: number; errors: string[]; reload: boolean }> {
  const result = { uploaded: 0, downloaded: 0, errors: [] as string[], reload: false };
  const adapter = app.vault.adapter, webdav = new WebDav(config.address, config.username, config.webdavPassword, config.remoteBaseDir), crypt = new RcloneCrypto(config.encryptionPassword);
  const local = new Map<string, ArrayBuffer>(), remote = new Map<string, { encrypted: string; etag: string }>();
  const compatible = new Set<string>();
  const failedBinaries = new Set<string>();
  const excludedBinaries = new Set(["obsidian-local-rest-api", "realclaudian", "agent-client"]);
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
  {
    const manifestPaths = [...new Set([...remote.keys(), ...local.keys()])].filter(path => /^\.obsidian\/plugins\/[^/]+\/manifest.json$/.test(path));
    for (const path of manifestPaths) {
      const entry = remote.get(path);
      const object = entry ? await webdav.getObject(entry.encrypted) : undefined;
      if (entry && !object) throw new Error("Исчез манифест плагина: " + path);
      const bytes = object ? await crypt.decrypt(object.bytes) : local.get(path);
      if (!bytes) continue;
      const manifest = JSON.parse(decoder.decode(bytes));
      const id = path.split("/")[2]!;
      if (manifest.id !== id || (manifest.minAppVersion !== undefined && typeof manifest.minAppVersion !== "string") || (manifest.isDesktopOnly !== undefined && typeof manifest.isDesktopOnly !== "boolean")) {
        throw new Error("Некорректный манифест плагина: " + id);
      }
      if ((!Platform.isMobile || !manifest.isDesktopOnly) && !excludedBinaries.has(id)) {
        if (!manifest.minAppVersion || requireApiVersion(manifest.minAppVersion)) compatible.add(id);
        else result.errors.push(`${id}: требуется Obsidian ${manifest.minAppVersion} или новее; плагин не установлен и не включён`);
      }
    }
  }
  // Install complete binaries, then invoke normal first enable, then import data.
  const rank = (path: string) => path === ".obsidian/community-plugins.json" ? 4
    : /^\.obsidian\/plugins\/[^/]+\/manifest.json$/.test(path) ? 0
    : /^\.obsidian\/plugins\/[^/]+\/(main.js|styles.css)$/.test(path) ? 1
    : /^\.obsidian\/plugins\/[^/]+\/data.json$/.test(path) ? 2 : 3;
  const paths = [...new Set([...local.keys(), ...remote.keys()])].sort((a,b) => rank(a) - rank(b) || a.localeCompare(b));
  const mobileEnabled = new Set<string>();
  const pluginIds = (bytes: ArrayBuffer): string[] => {
    const ids: unknown = JSON.parse(decoder.decode(bytes));
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id))) throw new Error("Некорректный список включённых плагинов");
    return ids as string[];
  };
  const enabledPath = ".obsidian/community-plugins.json";
  const enabledEntry = remote.get(enabledPath);
  const enabledObject = enabledEntry ? await webdav.getObject(enabledEntry.encrypted) : undefined;
  if (enabledEntry && !enabledObject) throw new Error("Исчез список включённых плагинов");
  const targetEnabled = enabledObject ? new Set(pluginIds(await crypt.decrypt(enabledObject.bytes))) : new Set<string>();
  for (const id of targetEnabled) {
    const base = `.obsidian/plugins/${id}/`;
    if (compatible.has(id) && !PRIVATE.has(id) && !setup[id] && !local.has(base + "data.json") &&
        (!local.has(base + "manifest.json") || !local.has(base + "main.js"))) setup[id] = "pending";
  }
  await save(); // Persist first-install intent before writing any plugin file.

  const devicePath = async (path: string, bytes: ArrayBuffer): Promise<ArrayBuffer> => {
    if (path !== ".obsidian/community-plugins.json" || !Platform.isMobile) return bytes;
    mobileEnabled.clear();
    for (const id of compatible) {
      if (failedBinaries.has(id)) continue;
      const base = `.obsidian/plugins/${id}/`;
      if (!await adapter.exists(base + "manifest.json") || !await adapter.exists(base + "main.js")) continue;
      const manifest = JSON.parse(await adapter.read(base + "manifest.json"));
      if (manifest.id === id && !manifest.isDesktopOnly && (!manifest.minAppVersion || (typeof manifest.minAppVersion === "string" && requireApiVersion(manifest.minAppVersion)))) mobileEnabled.add(id);
    }
    return buffer(encoder.encode(JSON.stringify(pluginIds(bytes).filter(id => mobileEnabled.has(id)), null, 2)));
  };
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
  let initializedThisRun = false;
  const activated = new Set<string>();
  const initializeNewPlugins = async () => {
    if (initializedThisRun) return;
    initializedThisRun = true;
    const manager = (app as any).plugins;
    for (const id of targetEnabled) {
      if (setup[id] !== "pending" || !compatible.has(id) || PRIVATE.has(id)) continue;
      const base = `.obsidian/plugins/${id}/`;
      if (failedBinaries.has(id) || !await adapter.exists(base + "manifest.json") || !await adapter.exists(base + "main.js")) {
        failedBinaries.add(id); continue;
      }
      try {
        // These are Obsidian's own installation hooks, not calls into a specific plugin.
        if (!manager?.loadManifests || !manager?.enablePlugin || !manager?.getPlugin) {
          throw new Error("Эта версия Obsidian не поддерживает штатное включение. Включите новый плагин в настройках и повторите синхронизацию.");
        }
        await assertLocal(enabledPath, local.get(enabledPath));
        await manager.loadManifests();
        // Same user-initiated load used by the store, without a deferred enable-list write.
        if (!await manager.enablePlugin(id, true) || !manager.getPlugin(id)) throw new Error("Obsidian не смог загрузить новый плагин");
        activated.add(id);
        // Default data written by onload is backed up before remote data is imported.
        if (await adapter.exists(base + "data.json")) local.set(base + "data.json", await adapter.readBinary(base + "data.json"));
        setup[id] = "initialized";
        await save();
      } catch (error) {
        failedBinaries.add(id);
        result.errors.push(`${id}: первый запуск не завершён; настройки не импортированы. ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index]!;
    if (rank(path) >= 2) await initializeNewPlugins();
    if (path.startsWith(".obsidian/plugins/") && (!compatible.has(path.split("/")[2]!) ||
        (path.endsWith("/data.json") && setup[path.split("/")[2]!] === "pending"))) continue;
    progress("Синхронизирую настройки и плагины", index, paths.length);
    try {
      const l = local.get(path), entry = remote.get(path), prev = state[path];
      const lh = l ? await hash(l) : undefined;
      if (!(Platform.isMobile && path === ".obsidian/community-plugins.json") && l && prev && lh === prev.localHash && entry && isStrongEtag(entry.etag) && entry.etag === prev.remoteFingerprint) continue;
      const object = entry ? await webdav.getObject(entry.encrypted) : undefined;
      if (entry && !object) throw new Error("Настройка исчезла с сервера");
      const r = object ? await crypt.decrypt(object.bytes) : undefined;
      const rh = r ? await hash(r) : undefined;
      const projected = r ? await devicePath(path,r) : undefined;
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
        let upload = await devicePath(path, l);
        if (Platform.isMobile && path === ".obsidian/community-plugins.json" && r) {
          const common = pluginIds(upload), existing = pluginIds(r);
          upload = buffer(encoder.encode(JSON.stringify([...new Set([...common, ...existing.filter(id => !mobileEnabled.has(id))])], null, 2)));
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
    } catch (error) {
      if (/^\.obsidian\/plugins\/[^/]+\/(main.js|manifest.json|styles.css)$/.test(path)) failedBinaries.add(path.split("/")[2]!);
      result.errors.push(path + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  await initializeNewPlugins();
  // The file is published last. Mirror only successful new enables into runtime state,
  // so future Obsidian settings saves do not drop them. Do not touch existing plugins.
  if (activated.size && await adapter.exists(enabledPath)) {
    const bytes = await adapter.readBinary(enabledPath);
    if (state[enabledPath]?.localHash === await hash(bytes)) {
      const enabled = new Set(pluginIds(bytes));
      const manager = (app as any).plugins;
      for (const id of activated) if (enabled.has(id)) manager?.enabledPlugins?.add?.(id);
    } else result.errors.push("Список плагинов изменился; включение новых плагинов будет применено после разрешения конфликта и перезапуска");
  }
  await save();return result;
}
