import test from "node:test";
import assert from "node:assert/strict";
import { noteDate, syncWriteOptions } from "../src/file-times";
const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const note = '---\ncreated: "2024-01-02 09:00"\nupdated: 2026-09-02T16:58\n---\nbody\n';

test("sync uses the original note dates, not download or upload time", () => {
  const options = syncWriteOptions("note.md", bytes(note), { mtime: Date.now(), ctime: Date.now() }, Date.now());
  assert.equal(options.mtime, Date.parse("2026-09-02T16:58"));
  assert.equal(options.ctime, Date.parse("2024-01-02T09:00"));
  assert.equal(noteDate(note, "updated"), options.mtime);
});

test("timezone-qualified and quoted CRLF dates work; body fields never supply clocks", () => {
  assert.equal(noteDate("---\r\nupdated: '2026-09-02T10:00:00+03:00'\r\n---\r\n", "updated"), Date.parse("2026-09-02T07:00:00Z"));
  assert.equal(noteDate("# note\nupdated: 2026-09-02", "updated"), undefined);
  assert.equal(noteDate("---\nupdated: invalid\n---\nupdated: 2026-09-02", "updated"), undefined);
});

test("missing dates and non-markdown use known clocks without inventing a YAML date", () => {
  assert.deepEqual(syncWriteOptions("note.md", bytes("text"), { mtime: 1000, ctime: 500 }, 2000), { mtime: 2000, ctime: 500 });
  assert.deepEqual(syncWriteOptions("image.bin", bytes(note), undefined, 2000), { mtime: 2000, ctime: 2000 });
  assert.deepEqual(syncWriteOptions("note.md", bytes("text"), { mtime: 1000, ctime: 500 }, NaN), { mtime: 1000, ctime: 500 });
});
