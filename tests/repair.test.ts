import test from "node:test";
import assert from "node:assert/strict";
import { repairLegacyConflicts } from "../src/repair";

const legacy = (a: string, b: string) => `<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ\n${a}||||||| ПОСЛЕДНЯЯ ОБЩАЯ\n=======\n${b}>>>>>>> ВЕРСИЯ С СЕРВЕРА\n`;
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
