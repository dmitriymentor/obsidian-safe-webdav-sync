import test from "node:test";
import assert from "node:assert/strict";
import { repairLegacyConflicts, planLegacyRepair } from "../src/repair";

const legacy = (a: string, b: string) => `<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ\n${a}||||||| ПОСЛЕДНЯЯ ОБЩАЯ\n=======\n${b}>>>>>>> ВЕРСИЯ С СЕРВЕРА\n`;
test("orphaned ending is repaired only for otherwise identical complete documents", () => {
  const a = "---\ntags: [work]\nupdated: 2026-09-13\n---\n- task\n\n";
  const b = a.replace("2026-09-13", "2026-09-08");
  const damaged = a + "=======\n" + b + ">>>>>>> ВЕРСИЯ С СЕРВЕРА";
  assert.equal(repairLegacyConflicts(damaged).text, a.trimEnd() + "\n");
  assert.throws(() => repairLegacyConflicts(damaged.replace("- task", "- changed")));
  assert.throws(() => repairLegacyConflicts(damaged + "\nvaluable tail"));
});
test("repair picks newer original and preserves text outside conflict", () => {
  const a = "---\ncreated: 2024-01-01\nupdated: 2026-09-09\ntags: [work]\n---\nnew\n";
  const b = a.replace("2026-09-09", "2026-09-08").replace("new", "old");
  const result = repairLegacyConflicts(`---\ncreated: 2026-09-12\nupdated: 2026-09-12\n---\n${legacy(a, b)}Tail\n`);
  assert.equal(result.text, a.replace("2026-09-09", "2026-09-12") + "Tail\n");
  assert.equal(result.blocks, 1);
});
test("equal original timestamps choose the server branch", () => {
  const a = "---\nupdated: 2026-09-12\n---\nlocal\n";
  const b = a.replace("local", "remote");
  assert.deepEqual(repairLegacyConflicts(legacy(a, b)), { text: b, blocks: 1, ties: 1 });
});
test("repair refuses missing dates or broken blocks", () => {
  assert.throws(() => repairLegacyConflicts(legacy("local\n", "remote\n")));
  assert.throws(() => repairLegacyConflicts("<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ\npartial\n"));
});

test("nested old conflict and trailing fragments are repaired using dates at their own level", () => {
  const old = "---\ncreated: 2024-01-01\nupdated: 2026-09-08\ntags: [work]\n---\nold\n";
  const clean = old.replace("2026-09-08", "2026-09-09").replace("old", "new");
  const nested = "---\ncreated: 2026-09-10\nupdated: 2026-09-10\n---\n" + legacy(clean, old);
  const server = clean.replace("2026-09-09", "2026-09-10");
  const damaged = legacy(nested, server) + legacy("extra\n", "") + "Tail\n";
  const repaired = repairLegacyConflicts(damaged);
  assert.equal(repaired.text, server + "Tail\n");
  assert.equal(repaired.blocks, 3);
  assert.equal(repairLegacyConflicts(repaired.text).text, repaired.text);
});

test("a chosen nested branch is also repaired and generated metadata shells collapse", () => {
  const clean = "---\ncreated: 2024-01-01\nupdated: 2026-09-09\ntags: [work]\n---\nnew\n";
  const nested = "---\ncreated: 2026-09-10\nupdated: 2026-09-10\n---\n" + legacy(clean, clean.replace("2026-09-09", "2026-09-08"));
  assert.equal(repairLegacyConflicts(legacy(nested, clean)).text, clean.replace("2026-09-09", "2026-09-10"));
});

test("migration normalizes the saved base and preserves edits made after the old merge", () => {
  const clean = "---\nupdated: 2026-09-09\n---\nA\nB\nC\n";
  const dirty = legacy(clean, clean.replace("2026-09-09", "2026-09-08"));
  const local = dirty + "phone addition\n";
  const remote = clean.replace("A\n", "A edited on Mac\n");
  const result = planLegacyRepair(local, dirty, remote, { localMtime: 10, remoteMtime: 20 })!;
  assert.equal(result.text, remote + "phone addition\n");
  assert.equal(planLegacyRepair(result.text, result.text, result.text, { localMtime: 0, remoteMtime: 0 }), undefined);
});

test("legitimate repeated lines and blank lines outside markers are not deduplicated", () => {
  const text = "# Note\n\n\n- repeat\n- repeat\n";
  assert.deepEqual(repairLegacyConflicts(text), { text, blocks: 0, ties: 0 });
});

test("fragment-only conflicts without reliable dates fail closed", () => {
  assert.throws(() => repairLegacyConflicts("---\nupdated: 2026-09-13\n---\n" + legacy("a\n", "b\n")));
});
