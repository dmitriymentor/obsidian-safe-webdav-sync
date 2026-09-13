import test from "node:test";
import assert from "node:assert/strict";
import { mergeMarkdown } from "../src/merge";

test("merges non-overlapping list additions", () => {
  const base = "# Note\n\n## iOS\n- one\n\n## Web\n- alpha\n";
  const local = "# Note\n\n## iOS\n- one\n- two\n\n## Web\n- alpha\n";
  const remote = "# Note\n\n## iOS\n- one\n\n## Web\n- alpha\n- beta\n";
  const result = mergeMarkdown(local, base, remote);
  assert.equal(result.conflict, false);
  assert.match(result.text, /- two/);
  assert.match(result.text, /- beta/);
});

test("keeps only the newer local overlapping edit", () => {
  const result = mergeMarkdown("item local\n", "item\n", "item remote\n", { localMtime: 200, remoteMtime: 100 });
  assert.equal(result.conflict, true);
  assert.equal(result.text, "item local\n");
});

test("keeps newer remote edit and resolves equal dates consistently", () => {
  for (const localMtime of [50, 100]) {
    assert.equal(mergeMarkdown("local\n", "base\n", "remote\n", {
      localMtime, remoteMtime: 100
    }).text, "remote\n");
  }
});

test("aligns conflicting edits after an insertion above the line", () => {
  const base = "Заголовок\nПункт\nКонец\n";
  const local = "Вставлено выше\nЗаголовок\nПункт ПК\nКонец\n";
  const remote = "Заголовок\nПункт телефон\nКонец\n";
  assert.equal(mergeMarkdown(local, base, remote, { localMtime: 10, remoteMtime: 20 }).text,
    "Вставлено выше\nЗаголовок\nПункт телефон\nКонец\n");
});

test("a uniquely moved block receives the other device's edit", () => {
  const base = "Начало\nПеренести\nРаздел 1\nРаздел 2\nРаздел 3\nКонец\n";
  const moved = "Начало\nРаздел 1\nРаздел 2\nРаздел 3\nПеренести\nКонец\n";
  const edited = base.replace("Перенести", "Перенести — исправлено");
  for (const [local, remote] of [[moved, edited], [edited, moved]]) {
    assert.equal(mergeMarkdown(local!, base, remote!, { localMtime: 10, remoteMtime: 20 }).text,
      moved.replace("Перенести", "Перенести — исправлено"));
  }
});

test("independent adjacent edits are merged without positional pairing", () => {
  assert.equal(mergeMarkdown("A local\nB\n", "A\nB\n", "A\nB remote\n").text,
    "A local\nB remote\n");
});

test("different simultaneous destinations do not duplicate a moved line", () => {
  const base = "A\nmove\nB\nC\nD\nE\nZ\n";
  const local = "A\nB\nC\nmove\nD\nE\nZ\n";
  const remote = "A\nB\nC\nD\nE\nmove\nZ\n";
  assert.equal(mergeMarkdown(local, base, remote, { localMtime: 10, remoteMtime: 20 }).text, remote);
});

test("newer move wins against older deletion of that block", () => {
  const base = "A\nmove\nB\nC\nD\nZ\n";
  const local = "A\nB\nC\nD\nmove\nZ\n";
  const remote = "A\nB\nC\nD\nZ\n";
  assert.equal(mergeMarkdown(local, base, remote, { localMtime: 20, remoteMtime: 10 }).text, local);
  assert.equal(mergeMarkdown(local, base, remote, { localMtime: 10, remoteMtime: 20 }).text, remote);
});

test("newer note updated date beats later server upload time", () => {
  const local = "---\nupdated: '2026-09-13T10:00:00Z'\n---\nnew\n";
  const remote = "---\nupdated: 2026-09-12T10:00:00Z\n---\nold\n";
  const base = "---\nupdated: 2026-09-11T10:00:00Z\n---\nbase\n";
  const merged = mergeMarkdown(local, base, remote, { localMtime: 10, remoteMtime: 999 });
  assert.match(merged.text, /\nnew\n$/);
  assert.doesNotMatch(merged.text, /\nold\n/);
});

test("newer deletion wins over editing the deleted line", () => {
  assert.equal(mergeMarkdown("A\nZ\n", "A\nB\nZ\n", "A\nB edited\nZ\n", {
    localMtime: 20, remoteMtime: 10
  }).text, "A\nZ\n");
});

test("a note without common history chooses a single conflicting version", () => {
  assert.equal(mergeMarkdown("local\n", "", "remote\n", {
    localMtime: 10, remoteMtime: 20
  }).text, "remote\n");
});

test("updated frontmatter timestamp does not conflict", () => {
  const base = "---\nupdated: 2026-01-01 10:00\n---\nA\nB\n";
  const local = "---\nupdated: 2026-01-02 10:00\n---\nA local\nB\n";
  const remote = "---\nupdated: 2026-01-03 10:00\n---\nA\nB remote\n";
  const result = mergeMarkdown(local, base, remote);
  assert.equal(result.conflict, false);
  assert.match(result.text, /updated: 2026-01-03 10:00/);
  assert.match(result.text, /A local/);
  assert.match(result.text, /B remote/);
});
