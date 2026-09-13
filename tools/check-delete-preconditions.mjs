import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Cipher } from "@fyears/rclone-crypt";
const vault = process.argv[2];
const raw = JSON.parse(await fs.readFile(path.join(vault, ".obsidian/plugins/remotely-save/data.json"), "utf8"));
const config = raw.d ? JSON.parse(Buffer.from([...raw.d].reverse().join(""), "base64url").toString()) : raw;
const w = config.webdav;
const root = `${w.address.replace(/\/+$/, "")}/${encodeURIComponent(w.remoteBaseDir || path.basename(vault))}/`;
const auth = `Basic ${Buffer.from(`${w.username}:${w.password}`).toString("base64")}`;
const cipher = new Cipher("base64"); await cipher.key(config.password, "");
const encryptedPath = await cipher.encryptFileName(`.safe-sync-safety/protocol-check-${randomUUID()}.txt`);
const parts = encryptedPath.split("/");
const call = (p, method, body, headers = {}) => fetch(root + p.split("/").map(encodeURIComponent).join("/"), {
  method, body, headers: { Authorization: auth, "Accept-Encoding": "identity", ...headers }, signal: AbortSignal.timeout(20000)
});
await call(parts.slice(0, -1).join("/"), "MKCOL");
const content = await cipher.encryptData(new TextEncoder().encode("Safe Sync isolated conditional request test"));
const created = await call(encryptedPath, "PUT", content, { "If-None-Match": "*" });
if (!created.ok) throw Error(`Test PUT ${created.status}`);
await new Promise(resolve => setTimeout(resolve, 1500));
const object = await call(encryptedPath, "GET"); const etag = object.headers.get("etag");
const overwrite = await call(encryptedPath, "PUT", content, { "If-None-Match": "*" });
const wrongDelete = await call(encryptedPath, "DELETE", undefined, { "If-Match": '"definitely-not-the-etag"' });
const preserved = await call(encryptedPath, "GET");
const result = { createPrecondition: overwrite.status, deletePrecondition: wrongDelete.status, preserved: preserved.status, etag, putEtag: created.headers.get("etag"), strongEtag: Boolean(etag && !etag.startsWith("W/")) };
// Only this uniquely named, agent-created test object is cleaned up.
if (preserved.ok) {
  const cleaned = await call(encryptedPath, "DELETE", undefined, { "If-Match": preserved.headers.get("etag") });
  if (![204, 200, 404].includes(cleaned.status)) result.cleanupStatus = cleaned.status;
}
console.log(JSON.stringify(result));
if (result.createPrecondition !== 412 || result.deletePrecondition !== 412 || result.preserved !== 200 || !result.strongEtag) process.exitCode = 1;

// Clean leftovers from earlier failed precondition probes, and nothing else.
const listing = await call(parts.slice(0, -1).join("/") + "/", "PROPFIND", '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', { Depth: "1", "Content-Type": "application/xml" });
if (listing.status === 207) {
  let cleaned = 0;
  for (const match of (await listing.text()).matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g)) {
    const url = new URL(match[1].replace(/&amp;/g, "&"), root);
    const rootPath = decodeURIComponent(new URL(root).pathname);
    const rel = decodeURIComponent(url.pathname).slice(rootPath.length).replace(/\/$/, "");
    let plain; try { plain = await cipher.decryptFileName(rel); } catch { continue; }
    if (!/^\.safe-sync-safety\/protocol-check-[a-f0-9-]{36}\.txt$/.test(plain)) continue;
    const r = await call(rel, "GET");
    if (!r.ok) continue;
    const content = new TextDecoder().decode(await cipher.decryptData(new Uint8Array(await r.arrayBuffer())));
    if (content !== "Safe Sync isolated conditional request test") continue;
    const tag = r.headers.get("etag");
    if (!tag || tag.startsWith("W/")) continue;
    const removed = await call(rel, "DELETE", undefined, { "If-Match": tag });
    if ([200, 204].includes(removed.status)) cleaned++;
  }
  console.log(JSON.stringify({ cleanedOwnTestObjects: cleaned }));
}
