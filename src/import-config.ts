import { Buffer } from "buffer";
import type { DataAdapter } from "obsidian";
import type { ImportedConfig } from "./types";

function decodeMessyConfig(raw: unknown): any {
  if (!raw || typeof raw !== "object") throw new Error("Пустой файл настроек Remotely Save");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.d !== "string") return obj;
  const reversed = Array.from(obj.d).reverse().join("");
  const normalBase64 = reversed.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(normalBase64, "base64").toString("utf8"));
}

export async function importRemotelySaveConfig(
  adapter: DataAdapter,
  sourcePluginId: string
): Promise<ImportedConfig> {
  const path = `.obsidian/plugins/${sourcePluginId}/data.json`;
  if (!(await adapter.exists(path))) {
    throw new Error(`Не найден ${path}. Remotely Save должен оставаться установленным.`);
  }
  const decoded = decodeMessyConfig(JSON.parse(await adapter.read(path)));
  if (decoded.serviceType !== "webdav") throw new Error("В Remotely Save выбран не WebDAV");
  if (decoded.encryptionMethod !== "rclone-base64") {
    throw new Error("Поддерживается существующее шифрование RClone Crypt");
  }
  const webdav = decoded.webdav;
  if (!webdav?.address || !webdav?.username || !webdav?.password || !decoded.password) {
    throw new Error("В настройках Remotely Save не хватает WebDAV или пароля шифрования");
  }
  if ((webdav.authType ?? "basic") !== "basic") {
    throw new Error("Сейчас поддерживается Basic Auth по HTTPS");
  }
  return {
    address: String(webdav.address).replace(/\/+$/, ""),
    username: String(webdav.username),
    webdavPassword: String(webdav.password),
    authType: "basic",
    remoteBaseDir: String(webdav.remoteBaseDir || "").replace(/^\/+|\/+$/g, ""),
    encryptionPassword: String(decoded.password),
    encryptionMethod: String(decoded.encryptionMethod),
    autoRunEveryMilliseconds: Number(decoded.autoRunEveryMilliseconds) || 300000,
    syncOnSaveAfterMilliseconds: Number(decoded.syncOnSaveAfterMilliseconds) || 1000
  };
}
