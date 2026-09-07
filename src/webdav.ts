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

export class WebDav {
  private readonly address: string;
  private readonly rootUrl: string;
  private readonly auth: string;

  constructor(address: string, username: string, password: string, remoteBaseDir: string) {
    this.address = address.replace(/\/+$/, "");
    const base = encodePath(remoteBaseDir.replace(/^\/+|\/+$/g, ""));
    this.rootUrl = `${this.address}/${base}/`;
    this.auth = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  }

  private url(encryptedPath = "", directory = false): string {
    const encoded = encodePath(encryptedPath);
    if (!encoded) return this.rootUrl;
    return `${this.rootUrl}${encoded}${directory ? "/" : ""}`;
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
      headers: { Authorization: this.auth, ...headers },
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

  async list(): Promise<RawRemoteEntry[]> {
    const found = new Map<string, RawRemoteEntry>();
    const queue = [""];
    const visited = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const response = await this.request("PROPFIND", this.url(current, true), PROPFIND_BODY, {
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8"
      });
      const doc = new DOMParser().parseFromString(response.text, "application/xml");
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
        if (isDirectory) queue.push(relative);
      }
    }
    return [...found.values()];
  }

  async get(encryptedPath: string): Promise<ArrayBuffer> {
    return (await this.request("GET", this.url(encryptedPath))).arrayBuffer;
  }

  async ensureParents(encryptedPath: string): Promise<void> {
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

  async put(encryptedPath: string, data: ArrayBuffer): Promise<string> {
    await this.ensureParents(encryptedPath);
    const response = await this.request("PUT", this.url(encryptedPath), data, {
      "Content-Type": "application/octet-stream"
    });
    return response.headers.etag ?? response.headers.ETag ?? "";
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
