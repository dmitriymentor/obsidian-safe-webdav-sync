import test from "node:test";
import assert from "node:assert/strict";
import { BackupStore, digest } from "../src/backup-store";
import { RcloneCrypto } from "../src/crypto";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
function fixture() {
  const files = new Map<string, string | ArrayBuffer>(), folders = new Set<string>(), remote = new Map<string, ArrayBuffer>();
  let localWrites = 0, puts = 0;
  const adapter: any = {
    exists: async (p: string) => files.has(p) || folders.has(p),
    mkdir: async (p: string) => { folders.add(p); },
    read: async (p: string) => files.get(p), write: async (p: string, s: string) => { files.set(p, s); },
    readBinary: async (p: string) => files.get(p),
    writeBinary: async (p: string, b: ArrayBuffer) => {
      assert.ok(p.startsWith(".safe-sync-backups/")); assert.ok(p.endsWith(".bin"));
      localWrites++; files.set(p, b);
    },
    list: async (p: string) => ({ files: [...files.keys()].filter(k => k.slice(0, k.lastIndexOf("/")) === p), folders: [...folders].filter(k => k.slice(0, k.lastIndexOf("/")) === p) })
  };
  const crypt: any = { encryptPath: async (p: string) => p,
    encrypt: async (b: ArrayBuffer) => new Uint8Array(b).map(x => x ^ 123).buffer,
    decrypt: async (b: ArrayBuffer) => new Uint8Array(b).map(x => x ^ 123).buffer };
  const webdav: any = {
    getObject: async (p: string) => remote.has(p) ? { bytes: remote.get(p), etag: '"stored"' } : undefined,
    put: async (p: string, b: ArrayBuffer, headers: any) => {
      assert.equal(headers["If-None-Match"], "*"); if (remote.has(p)) throw Error("412");
      puts++; remote.set(p, b); return '"stored"';
    }
  };
  return { files, remote, adapter, crypt, webdav, store: new BackupStore(adapter, crypt, webdav), writes: () => ({ localWrites, puts }) };
}
test("identical versions reuse verified encrypted backups across runs and preserve exact old-format dates", async () => {
  const f = fixture(), content = bytes("---\nupdated: 2026-09-13 14:36\n---\ntext\n");
  const a = await f.store.save("Base/note.md", content, "conflict");
  const otherRun = new BackupStore(f.adapter, f.crypt, f.webdav);
  const b = await otherRun.save("Base/note.md", content, "conflict");
  assert.deepEqual(a, b); assert.deepEqual(f.writes(), { localWrites: 1, puts: 1 });
  assert.deepEqual(await otherRun.read(a), content);
  const stored = [...f.files].find(([p]) => p.endsWith(".bin"))![1];
  assert.notDeepEqual(stored, content);
  assert.deepEqual(await otherRun.list(), [a]);
  await otherRun.save("Base/note.md", bytes("new version"), "conflict");
  await otherRun.save("Base/different.md", content, "conflict");
  assert.equal((await otherRun.list()).length, 3);
});
test("interrupted remote upload retries the same local archive without multiplying files", async () => {
  const f = fixture(), content = bytes("note"), put = f.webdav.put;
  f.webdav.put = async () => { throw Error("offline"); };
  await assert.rejects(f.store.save("note.md", content, "conflict"), /offline/);
  const inventory = [...f.files.keys()];
  f.webdav.put = put;
  await new BackupStore(f.adapter, f.crypt, f.webdav).save("note.md", content, "conflict");
  assert.deepEqual([...f.files.keys()], inventory);
  assert.deepEqual(f.writes(), { localWrites: 1, puts: 1 });
});
test("corrupt local or remote archives stop retries without overwriting evidence", async () => {
  for (const side of ["local", "remote"]) {
    const f = fixture(), content = bytes("original");
    await f.store.save("note.md", content, "conflict");
    const p = side === "local" ? [...f.files.keys()].find(p => p.endsWith(".bin"))! : [...f.remote.keys()][0]!;
    if (side === "local") f.files.set(p, bytes("corrupt")); else f.remote.set(p, bytes("corrupt"));
    await assert.rejects(f.store.save("note.md", content, "conflict"), /бекап не прошёл проверку/);
    assert.deepEqual(f.writes(), { localWrites: 1, puts: 1 });
  }
});
test("publication races accept only the same verified content, deletion paths stay compatible", async () => {
  const f = fixture(), content = bytes("original");
  f.webdav.put = async (p: string, b: ArrayBuffer) => { f.remote.set(p, b); throw Error("412"); };
  await f.store.save("note.md", content, "deletion");
  assert.ok(f.remote.has(`.safe-sync-safety/Удалённые/${await digest(content)}/note.md`));
});
test("real Rclone ciphertext round-trips and cannot be read using a different password", async () => {
  const f = fixture(), content = bytes("---\nupdated: 2026-09-13 14:36\n---\nprivate note\n");
  const crypt = new RcloneCrypto("test-only-backup-key");
  const store = new BackupStore(f.adapter, crypt, f.webdav);
  const r = await store.save("note.md", content, "conflict");
  assert.deepEqual(await store.read(r), content);
  assert.equal(new TextDecoder().decode([...f.files].find(([p]) => p.endsWith(".bin"))![1] as ArrayBuffer).includes("private note"), false);
  await assert.rejects(new BackupStore(f.adapter, new RcloneCrypto("wrong-test-key"), f.webdav).read(r));
});
