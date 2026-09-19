import { requestUrl, type RequestUrlResponse } from "obsidian";
import { Buffer } from "buffer";

export interface RawRemoteEntry {
  encryptedPath: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  etag: string;
}

function xmlText(parent: Element, localName: string): string {
  const nodes = parent.getElementsByTagNameNS("*", localName);
  return nodes.item(0)?.textContent?.trim() ?? "";
}

function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

// Native and desktop transports can use different casing for HTTP fields.
// Ambiguous duplicate values must not become a write precondition.
export function responseHeader(headers: Record<string, string>, name: string): string {
  const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === name.toLowerCase())
    .map(([, value]) => typeof value === "string" ? value.trim() : "");
  return values.length && new Set(values).size === 1 ? values[0]! : "";
}

export function isStrongEtag(value: string): boolean {
  return /^"[\x21\x23-\x7E\x80-\xFF]*"$/.test(value);
}

export class WebDav {
  private readonly address: string;
  private readonly rootUrl: string;
  private readonly auth: string;
  private readonly readSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private readSequence = 0;

  constructor(address: string, username: string, password: string, remoteBaseDir: string) {
    this.address = address.replace(/\/+$/, "");
    const base = encodePath(remoteBaseDir.replace(/^\/+|\/+$/g, ""));
    this.rootUrl = `${this.address}/${base}/`;
    this.auth = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  }

  private url(encryptedPath = "", directory = false): string {
    if (encryptedPath.split("/").some(part => Buffer.byteLength(part, "utf8") > 255)) {
      throw new Error("Слишком длинное имя после шифрования (более 255 байт). Сократите название заметки или папки; локальный файл сохранён");
    }
    const encoded = encodePath(encryptedPath);
    if (!encoded) return this.rootUrl;
    return `${this.rootUrl}${encoded}${directory ? "/" : ""}`;
  }

  private freshReadUrl(encryptedPath: string): string {
    // iOS requestUrl may serve a cached body without reaching WebDAV, including
    // after PUT. A unique read-only query also bypasses already cached responses
    // whose original headers allowed caching. It never changes the object path.
    return `${this.url(encryptedPath)}?safe-sync-read=${this.readSession}-${++this.readSequence}`;
  }

  private async request(
    method: string,
    url: string,
    body?: string | ArrayBuffer,
    headers: Record<string, string> = {}
  ): Promise<RequestUrlResponse> {
    const response = await requestUrl({
      url,
      method,
      body,
      headers: { Authorization: this.auth, "Accept-Encoding": "identity", ...headers },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`WebDAV ${method}: HTTP ${response.status}`);
    }
    return response;
  }

  async check(): Promise<void> {
    await this.request("PROPFIND", this.rootUrl, PROPFIND_BODY, {
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8"
    });
  }

  async list(onProgress?: (completed: number, total: number) => void,
    includeDirectory?: (encryptedPath: string) => Promise<boolean>): Promise<RawRemoteEntry[]> {
    const found = new Map<string, RawRemoteEntry>();
    const queue = [""];
    const visited = new Set<string>();
    let completed = 0;
    const scan = async (current: string): Promise<void> => {
      const response = await this.request("PROPFIND", this.url(current, true), PROPFIND_BODY, {
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8"
      });
      const doc = new DOMParser().parseFromString(response.text, "application/xml");
      if (doc.getElementsByTagName("parsererror").length || !doc.getElementsByTagNameNS("*", "multistatus").length) {
        throw new Error("Некорректный список WebDAV — синхронизация остановлена");
      }
      const rows = Array.from(doc.getElementsByTagNameNS("*", "response"));
      for (const row of rows) {
        const href = xmlText(row, "href");
        if (!href) continue;
        const absolutePath = decodeURIComponent(new URL(href, this.address).pathname);
        const rootPath = decodeURIComponent(new URL(this.rootUrl).pathname);
        if (!absolutePath.startsWith(rootPath)) continue;
        let relative = absolutePath.slice(rootPath.length).replace(/^\/+/, "");
        const isDirectory = row.getElementsByTagNameNS("*", "collection").length > 0;
        relative = relative.replace(/\/+$/, "");
        if (!relative || relative === current.replace(/\/+$/, "")) continue;
        const entry: RawRemoteEntry = {
          encryptedPath: relative,
          isDirectory,
          size: Number(xmlText(row, "getcontentlength")) || 0,
          mtime: Date.parse(xmlText(row, "getlastmodified")) || 0,
          etag: xmlText(row, "getetag")
        };
        found.set(relative, entry);
        if (isDirectory && !visited.has(relative) && (!includeDirectory || await includeDirectory(relative))) queue.push(relative);
      }
      completed++;
      onProgress?.(completed, visited.size + queue.length);
    };
    while (queue.length) {
      const batch: string[] = [];
      while (queue.length && batch.length < 4) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        batch.push(current);
      }
      // Only metadata reads are parallel. Drain the batch on failure and never
      // return a partial index that could be mistaken for missing files.
      const results = await Promise.allSettled(batch.map(scan));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    }
    return [...found.values()];
  }

  async get(encryptedPath: string): Promise<ArrayBuffer> {
    const object = await this.getObject(encryptedPath, false);
    if (!object) throw new Error("WebDAV GET: HTTP 404");
    return object.bytes;
  }

  async getObject(encryptedPath: string, retryWeak = true): Promise<{ bytes: ArrayBuffer; etag: string } | undefined> {
    const response = await requestUrl({ url: this.freshReadUrl(encryptedPath), method: "GET", headers: {
      Authorization: this.auth, "Accept-Encoding": "identity",
      "Cache-Control": "no-cache, no-store, max-age=0", Pragma: "no-cache"
    }, throw: false });
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw new Error(`WebDAV GET: HTTP ${response.status}`);
    const etag = responseHeader(response.headers, "etag");
    // Apache can emit a weak validator during the first second after a write.
    // Re-read the bytes as well as the validator; never strip W/ and pretend.
    if (retryWeak && etag.startsWith("W/")) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      return this.getObject(encryptedPath, false);
    }
    return { bytes: response.arrayBuffer, etag };
  }

  async removeIfMatch(encryptedPath: string, etag: string): Promise<void> {
    if (!isStrongEtag(etag)) throw new Error("Удаление требует надёжного ETag сервера");
    const response = await requestUrl({ url: this.url(encryptedPath), method: "DELETE", headers: { Authorization: this.auth, "If-Match": etag }, throw: false });
    if (![200, 204, 404].includes(response.status)) throw new Error(`WebDAV DELETE: HTTP ${response.status}; файл не удалён`);
  }

  async ensureParents(encryptedPath: string): Promise<void> {
    this.url(encryptedPath); // Validate the whole path before creating anything.
    const parts = encryptedPath.split("/").filter(Boolean);
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const response = await requestUrl({
        url: this.url(current, true),
        method: "MKCOL",
        headers: { Authorization: this.auth },
        throw: false
      });
      if (![201, 301, 405].includes(response.status) && !(response.status >= 200 && response.status < 300)) {
        throw new Error(`WebDAV MKCOL: HTTP ${response.status}`);
      }
    }
  }

  async put(encryptedPath: string, data: ArrayBuffer, conditions: Record<string, string> = {}): Promise<string> {
    await this.ensureParents(encryptedPath);
    const response = await this.request("PUT", this.url(encryptedPath), data, {
      "Content-Type": "application/octet-stream", ...conditions
    });
    return responseHeader(response.headers, "etag");
  }

  async move(fromEncryptedPath: string, toEncryptedPath: string): Promise<void> {
    await this.ensureParents(toEncryptedPath);
    await this.request("MOVE", this.url(fromEncryptedPath), undefined, {
      Destination: this.url(toEncryptedPath),
      Overwrite: "F"
    });
  }
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop>
</d:propfind>`;
