import test from "node:test";
import assert from "node:assert/strict";
import { RcloneCrypto } from "../src/crypto";
import { applyNameRepair, preserveFullTitle, shorterNotePath } from "../src/long-names";
import type { NameRepair } from "../src/types";

const crypt = new RcloneCrypto("long-name-test-key");
const longPath = `Quick Notes/${"Идея перевода речи ".repeat(7)}.md`;
const body = "---\ncreated: 2026-01-01 10:00\nupdated: 2026-01-02 11:00\ntags: [idea]\n---\n\nТекст заметки\n- пункт\n";

test("real encrypted names fit 255 bytes; extension, Unicode and stable suffix survive", async () => {
  const target = (await shorterNotePath(longPath, crypt, []))!;
  assert.ok(target.startsWith("Quick Notes/Идея"));
  assert.match(target, / — [a-f0-9]{10}\.md$/);
  assert.equal(target, await shorterNotePath(longPath, crypt, []));
  assert.ok((await crypt.encryptPath(target)).split("/").every(x => Buffer.byteLength(x) <= 255));
  assert.equal(await shorterNotePath(target, crypt, []), undefined);
  const collision = await shorterNotePath(longPath, crypt, [target.toUpperCase()]);
  assert.notEqual(collision, target);
  assert.match(collision!, /-1\.md$/);
});

test("ordinary names are unchanged and unsupported long folders/attachments fail safely", async () => {
  assert.equal(await shorterNotePath("Base/Обычная заметка.md", crypt, []), undefined);
  await assert.rejects(shorterNotePath("я".repeat(120) + "/note.md", crypt, []), /папки/);
  await assert.rejects(shorterNotePath("я".repeat(120) + ".png", crypt, []), /вложения/);
});

test("complete original title goes after YAML, preserving existing text and dates exactly", () => {
  const title = "Полное *название* [идеи]";
  const result = preserveFullTitle(body, title);
  assert.equal(result, body.replace("---\n\nТекст", "---\n# Полное \\*название\\* \\[идеи\\]\n\n\nТекст"));
  assert.equal(preserveFullTitle(result, title), result);
  assert.equal(preserveFullTitle("# Уже есть\n\nТекст", "Уже есть"), "# Уже есть\n\nТекст");
  const crlf = body.replace(/\n/g, "\r\n");
  assert.equal(preserveFullTitle(crlf, "Полное имя"), preserveFullTitle(body, "Полное имя").replace(/\n/g, "\r\n"));
  assert.equal(preserveFullTitle("\uFEFF---\n---\nBody", "Имя"), "\uFEFF---\n---\n# Имя\n\nBody");
  assert.equal(preserveFullTitle("---\na: b\n---", "Имя"), "---\na: b\n---\n# Имя\n\n");
  assert.throws(() => preserveFullTitle("---\nunclosed: true", "Имя"), /Незакрытые/);
});

function fixture() {
  let text = body;
  const file = { path: longPath, stat: { mtime: 123456, ctime: 12345 } };
  const stored = new Map<string, ArrayBuffer>();
  const dirs = new Set<string>();
  const occupied = new Set<string>();
  const history: NameRepair[] = [];
  const options: any[] = [];
  const events: string[] = [];
  const app: any = {
    vault: {
      read: async () => text,
      getAbstractFileByPath: (p: string) => p === file.path ? file : occupied.has(p) ? {} : null,
      adapter: {
        exists: async (p: string) => stored.has(p) || dirs.has(p) || occupied.has(p),
        mkdir: async (p: string) => { dirs.add(p); },
        writeBinary: async (p: string, b: ArrayBuffer) => { stored.set(p, b); },
        readBinary: async (p: string) => stored.get(p)
      },
      process: async (_f: any, fn: (s: string) => string, opts: any) => { text = fn(text); options.push(opts); events.push("process"); }
    },
    fileManager: { renameFile: async (_f: any, target: string) => { assert.ok(text.includes("# ")); file.path = target; events.push("rename"); } }
  };
  const persist = async () => { events.push("persist"); };
  return { app, file, stored, occupied, history, options, events, persist, text: () => text, edit: (s: string) => { text = s; } };
}

test("repair verifies an encrypted original and saves provenance before text/rename; dates remain", async () => {
  const f = fixture();
  const target = (await shorterNotePath(longPath, crypt, []))!;
  await applyNameRepair(f.app, f.file as any, target, crypt, f.history, f.persist);
  assert.equal(f.file.path, target);
  const originalTitle = longPath.split("/").at(-1)!.slice(0, -3);
  assert.equal(f.text(), preserveFullTitle(body, originalTitle));
  assert.deepEqual(f.events, ["persist", "process", "rename", "persist"]);
  assert.equal(new TextDecoder().decode(await crypt.decrypt(f.stored.get(f.history[0]!.backupPath)!)), body);
  assert.equal(f.history[0]!.from, longPath);
  assert.equal(f.history[0]!.completed, true);
  assert.equal(f.options[0].mtime, Date.parse("2026-01-02 11:00"));
  assert.equal(f.options[0].ctime, Date.parse("2026-01-01 10:00"));
});

test("failed rename then retry never duplicates title and keeps original recoverable", async () => {
  const f = fixture();
  const target = (await shorterNotePath(longPath, crypt, []))!;
  const rename = f.app.fileManager.renameFile;
  f.app.fileManager.renameFile = async () => { throw Error("rename failed"); };
  await assert.rejects(applyNameRepair(f.app, f.file as any, target, crypt, f.history, f.persist), /rename failed/);
  const retained = f.text();
  assert.equal(f.file.path, longPath);
  f.app.fileManager.renameFile = rename;
  await applyNameRepair(f.app, f.file as any, target, crypt, f.history, f.persist);
  assert.equal(f.text(), retained);
  assert.equal(f.options.length, 1);
  assert.equal(f.history.at(-1)!.completed, true);
});

test("save failure, existing destination and concurrent edits never overwrite content", async () => {
  const target = (await shorterNotePath(longPath, crypt, []))!;
  const occupied = fixture(); occupied.occupied.add(target);
  await assert.rejects(applyNameRepair(occupied.app, occupied.file as any, target, crypt, occupied.history, occupied.persist), /занято/);
  assert.equal(occupied.text(), body); assert.equal(occupied.stored.size, 0);
  const failed = fixture();
  await assert.rejects(applyNameRepair(failed.app, failed.file as any, target, crypt, failed.history, async () => { throw Error("disk full"); }), /disk full/);
  assert.equal(failed.text(), body); assert.equal(failed.file.path, longPath);
  const changed = fixture();
  await assert.rejects(applyNameRepair(changed.app, changed.file as any, target, crypt, changed.history, async () => { changed.edit("User edit"); }), /изменена/);
  assert.equal(changed.text(), "User edit"); assert.equal(changed.file.path, longPath);
});
