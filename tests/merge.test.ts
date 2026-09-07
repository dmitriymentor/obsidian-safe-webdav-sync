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

test("preserves both overlapping edits with markers", () => {
  const result = mergeMarkdown("item local\n", "item\n", "item remote\n");
  assert.equal(result.conflict, true);
  assert.match(result.text, /ЛОКАЛЬНАЯ ВЕРСИЯ/);
  assert.match(result.text, /item local/);
  assert.match(result.text, /item remote/);
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
