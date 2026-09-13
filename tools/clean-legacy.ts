import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Cipher } from "@fyears/rclone-crypt";
import { hasLegacyConflicts, planLegacyRepair } from "../src/repair";

// Offline maintenance: close Obsidian on the Mac and pause other clients first.
// No deletes. All server writes use strong validators; original remote bytes
// are saved losslessly outside the vault, before any working note is changed.
async function main() {
  const [vault, snapshot, evidence, mode] = process.argv.slice(2);
  if (!vault || !snapshot || !evidence || !["--plan", "--apply"].includes(mode!)) throw Error("vault snapshot evidence --plan|--apply");
  const hash = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
  const statePath = path.join(vault, ".obsidian/plugins/safe-webdav-sync/data.json");
  const stateOriginal = await fs.readFile(statePath, "utf8");
  const state = JSON.parse(stateOriginal);
  if (state.deletionState?.pending.length) throw Error("Pending deletions must be reviewed first");
  const raw = JSON.parse(await fs.readFile(path.join(vault, ".obsidian/plugins/remotely-save/data.json"), "utf8"));
  const config = raw.d ? JSON.parse(Buffer.from([...raw.d].reverse().join(""), "base64url").toString()) : raw;
  const w = config.webdav;
  const root = `${w.address.replace(/\/+$/, "")}/${encodeURIComponent(w.remoteBaseDir || path.basename(vault))}/`;
  if (!root.startsWith("https://")) throw Error("HTTPS required");
  const authorization = `Basic ${Buffer.from(`${w.username}:${w.password}`).toString("base64")}`;
  const cipher = new Cipher("base64");
  await cipher.key(config.password, "");
  const request = (url: string, init: RequestInit = {}) => fetch(url, { ...init,
    headers: { Authorization: authorization, "Accept-Encoding": "identity", ...init.headers }, signal: AbortSignal.timeout(30000) });
  async function get(url: string) {
    for (let i = 0; i < 3; i++) {
      const r = await request(url);
      if (!r.ok) throw Error(`GET ${r.status}`);
      const bytes = Buffer.from(await cipher.decryptData(new Uint8Array(await r.arrayBuffer())));
      const etag = r.headers.get("etag") ?? "";
      if (etag.startsWith('"')) return { text: bytes.toString("utf8"), etag, mtime: Date.parse(r.headers.get("last-modified") ?? "") };
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw Error("No strong ETag");
  }
  function patch(file: string, before: string | undefined, after: string) {
    const lines = (s: string) => s.replace(/\n$/, "").split("\n");
    const operation = before === undefined ? `*** Add File: ${file}\n` : `*** Update File: ${file}\n@@\n${lines(before).map(l => `-${l}`).join("\n")}\n`;
    const result = spawnSync("apply_patch", [], { input: `*** Begin Patch\n${operation}${lines(after).map(l => `+${l}`).join("\n")}\n*** End Patch\n`, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) throw Error("apply_patch failed");
  }
  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "Safe Sync Backups") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...await walk(full));
      else out.push(full);
    }
    return out.sort();
  }
  const all = await walk(vault);
  const plan = [];
  for (const file of all.filter(f => /\.md$/i.test(f))) {
    const rel = path.relative(vault, file);
    const local = await fs.readFile(file, "utf8");
    const base = state.state[rel]?.baseText ?? "";
    const url = root + (await cipher.encryptFileName(rel)).split("/").map(encodeURIComponent).join("/");
    const remote = await get(url);
    if (![local, base, remote.text].some(hasLegacyConflicts)) continue;
    const repair = planLegacyRepair(local, base, remote.text, { localMtime: (await fs.stat(file)).mtimeMs, remoteMtime: remote.mtime })!;
    if (hasLegacyConflicts(repair.text)) throw Error(`Unresolved ${rel}`);
    if (await fs.readFile(path.join(snapshot, rel), "utf8") !== local) throw Error(`Snapshot mismatch ${rel}`);
    const old = state.state[rel];
    plan.push({ rel, file, local, remote, url, result: repair.text, blocks: repair.blocks, old });
  }
  console.log(JSON.stringify({ phase: "plan", files: all.length, affected: plan.length,
    changedNotes: plan.filter(p => p.local !== p.result || p.remote.text !== p.result).length,
    paths: plan.map(p => p.rel) }));
  if (mode !== "--apply") return;
  if (await fs.stat(evidence).then(() => true, () => false)) throw Error("Evidence file already exists; do not overwrite");
  patch(evidence, undefined, JSON.stringify({ createdAt: new Date().toISOString(), snapshot,
    files: plan.map(p => ({ path: p.rel, local: Buffer.from(p.local).toString("base64"), remote: Buffer.from(p.remote.text).toString("base64"), result: Buffer.from(p.result).toString("base64"), state: p.old })) }, null, 2) + "\n");
  const saved = JSON.parse(await fs.readFile(evidence, "utf8"));
  if (saved.files.length !== plan.length || saved.files.some((p: any, i: number) => Buffer.from(p.remote, "base64").toString() !== plan[i]!.remote.text)) throw Error("Backup verification failed");
  let count = 0;
  for (const p of plan) {
    if (await fs.readFile(p.file, "utf8") !== p.local) throw Error(`Local changed ${p.rel}`);
    const fresh = await get(p.url);
    if (fresh.text !== p.remote.text) throw Error(`Remote changed ${p.rel}`);
    // Upload a terminal newline, matching apply_patch's representation.
    const result = p.result.endsWith("\n") ? p.result : p.result + "\n";
    const put = await request(p.url, { method: "PUT", headers: { "If-Match": fresh.etag, "Content-Type": "application/octet-stream" }, body: await cipher.encryptData(new Uint8Array(Buffer.from(result)), undefined) as BodyInit });
    if (!put.ok) throw Error(`Conditional PUT ${put.status}: ${p.rel}`);
    let verified = await get(p.url);
    if (verified.text !== result) throw Error(`Server verification ${p.rel}`);
    if (await fs.readFile(p.file, "utf8") !== p.local) throw Error(`Local changed ${p.rel}`);
    if (p.local !== result) patch(p.file, p.local, result);
    const actual = await fs.readFile(p.file, "utf8");
    if (actual !== result) {
      if (actual.trimEnd() !== result.trimEnd()) throw Error(`Local verification ${p.rel}`);
      const normalized = await request(p.url, { method: "PUT", headers: { "If-Match": verified.etag }, body: await cipher.encryptData(new Uint8Array(Buffer.from(actual)), undefined) as BodyInit });
      if (!normalized.ok) throw Error(`Normalization ${normalized.status}`);
      verified = await get(p.url);
      if (verified.text !== actual) throw Error(`Final verification ${p.rel}`);
    }
    state.state[p.rel] = { baseHash: hash(actual), baseText: actual, localHash: hash(actual), remoteFingerprint: verified.etag, existsLocal: true, existsRemote: true, lastSync: Date.now() };
    count++;
    if (count % 10 === 0) console.log(JSON.stringify({ repaired: count, total: plan.length }));
  }
  if (await fs.readFile(statePath, "utf8") !== stateOriginal) throw Error("Sync state changed; app must remain closed");
  patch(statePath, stateOriginal, JSON.stringify(state, null, 2) + "\n");
  const actualState = JSON.parse(await fs.readFile(statePath, "utf8"));
  if (JSON.stringify(actualState) !== JSON.stringify(state)) throw Error("State verification");
  if (JSON.stringify(await walk(vault)) !== JSON.stringify(all)) throw Error("Path inventory changed");
  console.log(JSON.stringify({ repaired: count, verified: true, files: all.length, noFilesDeleted: true }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
