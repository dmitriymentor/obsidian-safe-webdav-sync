import test from "node:test";
import assert from "node:assert/strict";
import { DeletionJournal, JOURNAL, deletionConflicts, needsMassConfirmation, userPath, validateIntent } from "../src/deletions";
import type { DeleteIntent, DeletionState } from "../src/types";

const intent: DeleteIntent = { id: "11111111-1111-4111-8111-111111111111", deviceId: "22222222-2222-4222-8222-222222222222",
  path: "Base/note.md", baseHash: "a".repeat(64), createdAt: "2026-09-13T10:00:00Z" };
const data = (): DeletionState => ({ deviceId: intent.deviceId, pending: [], knownIds: [], baselineReady: true });
const fixture = () => {
  const files = new Map<string, ArrayBuffer>();
  const webdav: any = {
    get: async (p: string) => { if (!files.has(p)) throw Error("404"); return files.get(p); },
    getObject: async (p: string) => files.has(p) ? { bytes: files.get(p), etag: '"etag"' } : undefined,
    put: async (p: string, b: ArrayBuffer, headers: any) => {
      assert.equal(headers["If-None-Match"], "*");
      if (files.has(p)) throw Error("412"); files.set(p, b); return '"etag"';
    }
  };
  const crypt: any = { encryptPath: async (p: string) => p, encrypt: async (b: ArrayBuffer) => b, decrypt: async (b: ArrayBuffer) => b };
  return { files, webdav, crypt, paths: () => [...files.keys()] };
};

test("deletions compare observed content versions, never device clocks", () => {
  assert.equal(deletionConflicts([intent.baseHash, undefined], [intent]), false);
  assert.equal(deletionConflicts(["b".repeat(64), intent.baseHash], [intent]), true);
  assert.equal(deletionConflicts([undefined, undefined], [intent]), false);
});
test("journal publication is immutable, encrypted by the transport, retryable and visible to an offline device", async () => {
  const f = fixture(), source = data();
  const j = new DeletionJournal(f.webdav, f.crypt, source);
  await j.publish(intent); await j.publish(intent);
  assert.equal(f.files.size, 1);
  const receiver = new DeletionJournal(f.webdav, f.crypt, data());
  await receiver.load(f.paths());
  assert.equal(receiver.active.get(intent.path)![0]!.baseHash, intent.baseHash);
  await assert.rejects(j.publish({ ...intent, baseHash: "b".repeat(64) }), /412/);
});
test("canceling a deletion does not erase its durable history", async () => {
  const f = fixture(), d = data(), j = new DeletionJournal(f.webdav, f.crypt, d);
  await j.publish(intent); await j.keep([intent]);
  assert.equal(f.files.size, 2);
  assert.equal(j.active.size, 0);
  const receiver = new DeletionJournal(f.webdav, f.crypt, d);
  await receiver.load(f.paths());
  assert.equal(receiver.active.size, 0);
  await assert.rejects(receiver.load(f.paths().filter(p => !p.includes("keep-"))), /Исчезла/);
});
test("concurrent operations are independent; canceling one does not cancel an unseen deletion", async () => {
  const f = fixture(), j = new DeletionJournal(f.webdav, f.crypt, data());
  const second = { ...intent, id: "33333333-3333-4333-8333-333333333333" };
  await j.publish(intent); await j.publish(second); await j.keep([intent]);
  assert.equal(j.active.get(intent.path)!.length, 1);
  assert.equal(j.active.get(intent.path)![0]!.id, second.id);
});
test("malformed paths and unknown journal formats fail closed", async () => {
  for (const path of ["../file", "/file", ".obsidian/data.json", "Safe Sync Backups/x", "x/../y", "x\\y"]) {
    assert.equal(userPath(path), false);
    assert.throws(() => validateIntent({ ...intent, path }));
  }
  const f = fixture();
  f.files.set(`${JOURNAL}bad.json`, new TextEncoder().encode("{}").buffer);
  await assert.rejects(new DeletionJournal(f.webdav, f.crypt, data()).load(f.paths()), /Неизвестная/);
});
test("mass deletion thresholds require explicit confirmation", () => {
  assert.equal(needsMassConfirmation(1, 2), false);
  assert.equal(needsMassConfirmation(2, 5), true);
  assert.equal(needsMassConfirmation(9, 100), false);
  assert.equal(needsMassConfirmation(10, 100), true);
});
