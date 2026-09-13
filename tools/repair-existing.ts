import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Cipher } from "@fyears/rclone-crypt";
import { repairLegacyConflicts } from "../src/repair";

async function main() {
const [vault, backupDir, mode] = process.argv.slice(2);
if (!vault || !backupDir || mode !== "--apply") throw new Error("Expected vault, backup directory, --apply");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const raw = JSON.parse(await fs.readFile(path.join(vault, ".obsidian/plugins/remotely-save/data.json"), "utf8"));
const settings = raw.d ? JSON.parse(Buffer.from([...raw.d].reverse().join(""), "base64url").toString("utf8")) : raw;
const webdav = settings.webdav;
const root = `${webdav.address.replace(/\/+$/, "")}/${encodeURIComponent(webdav.remoteBaseDir || path.basename(vault))}/`;
if (!root.startsWith("https://")) throw new Error("HTTPS required");
const authorization = `Basic ${Buffer.from(`${webdav.username}:${webdav.password}`).toString("base64")}`;
const crypt = new Cipher("base64");
await crypt.key(settings.password, "");
const request = (url: string, init: RequestInit = {}) => fetch(url, {
  ...init, headers: { Authorization: authorization, ...init.headers }, signal: AbortSignal.timeout(30000)
});
function patchFile(file: string, before: string, after: string) {
  const lines = (text: string) => text.replace(/\n$/, "").split("\n");
  const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n${lines(before).map((line) => `-${line}`).join("\n")}\n${lines(after).map((line) => `+${line}`).join("\n")}\n*** End Patch\n`;
  const result = spawnSync("apply_patch", [], { input: patch, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error("apply_patch failed; encrypted server and backup retain the data");
}
async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "Safe Sync Backups") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (full.endsWith(".md")) files.push(full);
  }
  return files;
}
const planned = [];
for (const file of await walk(vault)) {
  const original = await fs.readFile(file, "utf8");
  const relative = path.relative(vault, file);
  const backup = path.join(backupDir, relative);
  let saved: string | undefined;
  try { saved = await fs.readFile(backup, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!original.includes("<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ") && saved === undefined) continue;
  const repair = repairLegacyConflicts(saved ?? original);
  const alreadyRepaired = !original.includes("<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ");
  if (alreadyRepaired && original.trimEnd() !== repair.text.trimEnd()) throw new Error(`Repaired note changed: ${relative}`);
  const encrypted = await crypt.encryptFileName(relative);
  const url = root + encrypted.split("/").map(encodeURIComponent).join("/");
  const response = await request(url);
  if (!response.ok) throw new Error(`GET failed: ${response.status}`);
  const remote = await crypt.decryptData(new Uint8Array(await response.arrayBuffer()));
  if (hash(remote) !== hash(Buffer.from(original)) &&
      Buffer.from(remote).toString("utf8").trimEnd() !== repair.text.trimEnd()) throw new Error(`Server has changed: ${relative}`);
  const etag = response.headers.get("etag");
  if (!etag || etag.startsWith("W/")) throw new Error("A strong ETag is required before repair");
  await fs.mkdir(path.dirname(backup), { recursive: true });
  if (saved === undefined) await fs.copyFile(file, backup, 1);
  else if (!alreadyRepaired && saved !== original) throw new Error(`Original differs from backup: ${relative}`);
  if (alreadyRepaired && hash(remote) === hash(Buffer.from(original))) continue;
  if (alreadyRepaired) repair.text = original;
  planned.push({ file, original, relative, url, etag, repair });
}
console.log(JSON.stringify({ prepared: planned.length, backupDir }));
let repaired = 0;
for (const item of planned) {
  if (await fs.readFile(item.file, "utf8") !== item.original) throw new Error("Local note changed during preparation");
  const result = item.repair.text.endsWith("\n") ? item.repair.text : item.repair.text + "\n";
  const encrypted = await crypt.encryptData(new Uint8Array(Buffer.from(result)), undefined);
  const response = await request(item.url, {
    method: "PUT", headers: { "If-Match": item.etag, "Content-Type": "application/octet-stream" }, body: encrypted as BodyInit
  });
  if (!response.ok) throw new Error(`Conditional PUT stopped: ${response.status}`);
  const verified = await request(item.url);
  if (!verified.ok) throw new Error("Verification GET failed");
  const bytes = await crypt.decryptData(new Uint8Array(await verified.arrayBuffer()));
  if (hash(bytes) !== hash(Buffer.from(result))) throw new Error("Server verification mismatch");
  if (item.original !== result) patchFile(item.file, item.original, result);
  for (let retry = 0; retry < 20; retry++) {
    if (await fs.readFile(item.file, "utf8") === result) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const actual = await fs.readFile(item.file, "utf8");
  if (actual !== result) {
    // apply_patch may preserve a terminal blank line. Accept only that narrow
    // difference, then store exactly the verified local bytes on the server.
    if (actual.trimEnd() !== result.trimEnd()) throw new Error("Local verification mismatch");
    const etag = verified.headers.get("etag");
    if (!etag || etag.startsWith("W/")) throw new Error("Strong verification ETag required");
    const encryptedActual = await crypt.encryptData(new Uint8Array(Buffer.from(actual)), undefined);
    const normalized = await request(item.url, { method: "PUT", headers: { "If-Match": etag }, body: encryptedActual as BodyInit });
    if (!normalized.ok) throw new Error(`Conditional normalization stopped: ${normalized.status}`);
    const check = await request(item.url);
    if (!check.ok || hash(await crypt.decryptData(new Uint8Array(await check.arrayBuffer()))) !== hash(Buffer.from(actual))) throw new Error("Final byte verification failed");
  }
  repaired++;
}
console.log(JSON.stringify({ repaired, ties: planned.reduce((n, item) => n + item.repair.ties, 0), verified: true }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
