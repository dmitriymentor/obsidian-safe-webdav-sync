import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

class Element {
  text = ""; style = {}; value = 0;
  setText(value: string) { this.text = value; }
  empty() {}
  setAttr() {}
  removeAttribute() {}
  createEl(_tag: string, options?: { text?: string }) { const e = new Element(); e.text = options?.text ?? ""; return e; }
  createDiv() { return new Element(); }
}
class Modal {
  titleEl = new Element(); contentEl = new Element(); opens = 0;
  constructor(public app: any) {}
  open() { this.opens++; (this as any).onOpen(); }
  close() { (this as any).onClose(); }
}
class TFile { constructor(public path: string) {} }
const notices: string[] = [];
const obsidian = { Modal, TFile, FuzzySuggestModal: Modal, TFolder: class {}, normalizePath: (p: string) => p,
  Plugin: class {}, PluginSettingTab: class {}, Notice: class { constructor(text: string) { notices.push(text); } },
  Setting: class { addButton(callback: any) { const b: any = { setCta: () => b, setButtonText: () => b, onClick: () => b }; callback(b); } } };
const runtime = (entry: string) => {
  const code = buildSync({ entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "browser", external: ["obsidian"] }).outputFiles[0]!.text;
  const module = { exports: {} as any };
  runInNewContext(code, { module, exports: module.exports, require: () => obsidian,
    console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, crypto: webcrypto,
    window: { setTimeout, clearTimeout, setInterval, clearInterval } });
  return module.exports;
};
const Plugin = runtime("src/main.ts").default;
const { legacyBackupTarget, groupLegacyBackups } = runtime("src/backups.ts");
const { SyncEngine } = runtime("src/sync.ts");
const buffer = (s: string) => new TextEncoder().encode(s).buffer;
const digest = async (b: ArrayBuffer) => Buffer.from(await webcrypto.subtle.digest("SHA-256", b)).toString("hex");
function notificationFixture(options: { conflicts?: number; errors?: string[]; thrown?: boolean; duringRun?: (plugin: any) => Promise<void> } = {}) {
  const plugin = new Plugin();
  plugin.app = { vault: { getFiles: () => [] } };
  plugin.sourcePluginEnabled = () => false;
  plugin.data.deletionState = { baselineReady: true };
  plugin.persist = async () => {};
  plugin.createEngine = async () => ({ run: async () => {
    if (options.duringRun) await options.duringRun(plugin);
    if (options.thrown) throw Error("test connection failure");
    return { uploaded: 1, downloaded: 0, merged: 0, conflicts: options.conflicts ?? 0,
      deleted: 0, repaired: 0, unchanged: 0, errors: options.errors ?? [] };
  } });
  return plugin;
}

test("save, deletion and timer syncs stay quiet including automatically resolved conflicts", async () => {
  for (const reason of ["после сохранения", "после удаления", "по расписанию"]) {
    notices.length = 0;
    await notificationFixture({ conflicts: 1 }).sync(false, reason);
    assert.deepEqual(notices, []);
  }
});

test("startup announces completion; manual sync keeps its visible progress or reports after closing", async () => {
  notices.length = 0;
  await notificationFixture().sync(false, "при запуске");
  assert.equal(notices.length, 1);
  for (const reason of ["вручную", "командой", "настройки", "проверка"]) {
    notices.length = 0;
    const plugin = notificationFixture();
    try { await plugin.sync(false, reason); assert.equal(plugin.progressModal.visible, true); assert.equal(notices.length, 0); }
    finally { plugin.progressModal.close(); }
    await notificationFixture({ duringRun: async p => p.progressModal.close() }).sync(false, reason);
    assert.equal(notices.length, 1);
  }
});

test("manual attachment to a background sync enables its completion notice if progress is closed", async () => {
  notices.length = 0;
  await notificationFixture({ duringRun: async p => { await p.sync(false, "вручную"); p.progressModal.close(); } }).sync(false, "после сохранения");
  assert.equal(notices.length, 1);
});

test("background sync errors remain visible", async () => {
  notices.length = 0;
  await notificationFixture({ errors: ["note.md: HTTP 503"] }).sync(false, "по расписанию");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Ошибок: 1/);
  notices.length = 0;
  await notificationFixture({ thrown: true }).sync(false, "после сохранения");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /connection failure/);
});
async function deletionFixture() {
  const file = new TFile("note.md");
  const original = buffer("old content");
  const files = new Map([[file.path, { file, bytes: original }]]);
  const remote = new Map([[file.path, { bytes: original, etag: '"v1"' }]]);
  const deletes: string[] = [];
  const state: any = { "note.md": { baseHash: await digest(original) } };
  const engine: any = Object.create(SyncEngine.prototype);
  Object.assign(engine, { runId: "test-run", state, saveState: async () => {},
    deletionHooks: { data: { deviceId: "test-device" }, mutations: new Set() },
    crypt: { encryptPath: async (p: string) => p, encrypt: async (b: ArrayBuffer) => b, decrypt: async (b: ArrayBuffer) => b },
    webdav: {
      get: async (p: string) => remote.get(p)!.bytes,
      getObject: async (p: string) => remote.get(p),
      put: async (p: string, bytes: ArrayBuffer) => { remote.set(p, { bytes, etag: '"backup"' }); return '"backup"'; },
      removeIfMatch: async (p: string, etag: string) => {
        if (remote.get(p)?.etag !== etag) throw Error("412"); deletes.push(p); remote.delete(p);
      }
    }, app: { vault: {
      getAbstractFileByPath: (p: string) => files.get(p)?.file ?? null,
      readBinary: async (f: TFile) => files.get(f.path)!.bytes,
      modifyBinary: async (f: TFile, bytes: ArrayBuffer) => files.set(f.path, { file: f, bytes }),
      createBinary: async (p: string, bytes: ArrayBuffer) => files.set(p, { file: new TFile(p), bytes }),
      createFolder: async () => {}, adapter: { exists: async () => true },
      rename: async (f: TFile, p: string) => { const value = files.get(f.path)!; files.delete(f.path); f.path = p; files.set(p, value); }
    } } });
  const intent = { id: "id", path: "note.md", baseHash: await digest(original) };
  return { engine, files, remote, deletes, state, intent, summary: { deleted: 0, conflicts: 0 } };
}

async function legacyFixture() {
  const f = await deletionFixture();
  const clean = "---\nupdated: 2026-09-13\n---\n- keep newest\n";
  const old = clean.replace("2026-09-13", "2026-09-08").replace("newest", "oldest");
  const dirty = `<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ\n${clean}||||||| ПОСЛЕДНЯЯ ОБЩАЯ\n=======\n${old}>>>>>>> ВЕРСИЯ С СЕРВЕРА\n`;
  f.files.get("note.md")!.bytes = buffer(dirty);
  f.remote.get("note.md")!.bytes = buffer(clean);
  Object.assign(f.state["note.md"], { baseText: dirty, baseHash: await digest(buffer(dirty)), remoteFingerprint: '"previous"' });
  f.engine.deletionHooks.data.pending = [];
  const local = { file: f.files.get("note.md")!.file, bytes: buffer(dirty), hash: await digest(buffer(dirty)), mtime: 10 };
  const remote = { encryptedPath: "note.md", etag: '"v1"', mtime: 20 };
  const summary = { repaired: 0, conflicts: 0 };
  return { ...f, local, entry: remote, clean, dirty, summary };
}

test("migration repairs an old mobile base and saves only clean text on both sides", async () => {
  const f = await legacyFixture();
  assert.equal(await f.engine.tryLegacyRepair("note.md", f.local, f.entry, f.state["note.md"], false, f.summary), true);
  assert.equal(new TextDecoder().decode(f.files.get("note.md")!.bytes), f.clean);
  assert.equal(new TextDecoder().decode(f.remote.get("note.md")!.bytes), f.clean);
  assert.equal(f.state["note.md"].baseText, f.clean);
  assert.equal(f.summary.repaired, 1);
  assert.equal(f.deletes.length, 0);
  assert.ok([...f.files.keys()].some(p => p.includes("Конфликты/Локальная/note.md")));
});

test("migration dry run and malformed markers never mutate either side", async () => {
  const f = await legacyFixture();
  await f.engine.tryLegacyRepair("note.md", f.local, f.entry, f.state["note.md"], true, f.summary);
  assert.equal(f.files.size, 1);
  assert.equal(f.remote.size, 1);
  assert.equal(new TextDecoder().decode(f.files.get("note.md")!.bytes), f.dirty);
  f.local.bytes = buffer("<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ\nincomplete\n");
  await assert.rejects(f.engine.tryLegacyRepair("note.md", f.local, f.entry, f.state["note.md"], false, f.summary), /маркеры/);
  assert.equal(f.files.size, 1);
});

test("migration observes a pending user deletion and does not resurrect the note", async () => {
  const f = await legacyFixture();
  f.engine.deletionHooks.data.pending = [{ path: "note.md" }];
  await assert.rejects(f.engine.tryLegacyRepair("note.md", f.local, f.entry, f.state["note.md"], false, f.summary), /изменена/);
  assert.equal(f.files.size, 1);
  assert.equal(f.remote.size, 1);
});

test("migration uses the validator of the actual read and stops on conditional write failure", async () => {
  const f = await legacyFixture();
  f.remote.get("note.md")!.bytes = buffer(f.dirty);
  f.remote.get("note.md")!.etag = '"fresh-read"';
  const put = f.engine.webdav.put;
  f.engine.webdav.put = async (p: string, b: ArrayBuffer, headers: any) => {
    if (p === "note.md") { assert.equal(headers["If-Match"], '"fresh-read"'); throw Error("412"); }
    return put(p, b);
  };
  await assert.rejects(f.engine.tryLegacyRepair("note.md", f.local, f.entry, f.state["note.md"], false, f.summary), /412/);
  assert.equal(new TextDecoder().decode(f.files.get("note.md")!.bytes), f.dirty);
  assert.equal(f.state["note.md"].baseText, f.dirty);
});

test("migration verifies the remote again even when the clean server needs no write", async () => {
  const f = await legacyFixture();
  const get = f.engine.webdav.getObject;
  let reads = 0;
  f.engine.webdav.getObject = async (p: string) => {
    if (++reads > 1) return { bytes: buffer("concurrent edit"), etag: '"changed"' };
    return get(p);
  };
  await assert.rejects(f.engine.tryLegacyRepair("note.md", f.local, f.entry, f.state["note.md"], false, f.summary), /Сервер изменился/);
  assert.equal(new TextDecoder().decode(f.files.get("note.md")!.bytes), f.dirty);
});

test("deletion archives verified copies before removing only the unchanged revision", async () => {
  const f = await deletionFixture();
  f.engine.deletionHooks.data.pending = [];
  await f.engine.applyDeletion("note.md", [f.intent], false, f.summary);
  assert.equal(f.files.has("note.md"), false);
  assert.equal(f.remote.has("note.md"), false);
  assert.equal(f.deletes.length, 1);
  assert.equal(f.summary.deleted, 1);
  assert.ok([...f.files.keys()].some(p => p.includes("/Удалённые/Оригиналы/note.md")));
  assert.ok([...f.remote.keys()].some(p => p.startsWith(".safe-sync-safety/Удалённые/")));
});

test("delete-versus-edit does not delete either side without a decision", async () => {
  const f = await deletionFixture();
  f.engine.deletionHooks.data.pending = [];
  f.files.get("note.md")!.bytes = buffer("new unsynced edit");
  await assert.rejects(f.engine.applyDeletion("note.md", [f.intent], false, f.summary), /конфликтует/);
  assert.equal(f.files.has("note.md"), true);
  assert.equal(f.deletes.length, 0);
});

test("a concurrent server change rejects deletion and leaves local content intact", async () => {
  const f = await deletionFixture();
  f.engine.deletionHooks.data.pending = [];
  f.engine.webdav.removeIfMatch = async () => { throw Error("412"); };
  await assert.rejects(f.engine.applyDeletion("note.md", [f.intent], false, f.summary), /412/);
  assert.equal(f.files.has("note.md"), true);
  assert.ok(f.state["note.md"]);
});

test("dry-run deletion neither creates backups nor removes files", async () => {
  const f = await deletionFixture();
  await f.engine.applyDeletion("note.md", [f.intent], true, f.summary);
  assert.equal(f.files.size, 1);
  assert.equal(f.remote.size, 1);
  assert.equal(f.deletes.length, 0);
});

test("restore reads the verified archived revision and never overwrites an existing note", async () => {
  const f = await deletionFixture();
  const original = f.files.get("note.md")!.bytes;
  let canceled = false;
  f.engine.journal = { active: new Map([["note.md", [{ ...f.intent, createdAt: "2026-09-13" }]]]), keep: async () => { canceled = true; } };
  f.engine.deletedPaths = async () => ["note.md"];
  await assert.rejects(f.engine.restoreDeleted("note.md"), /уже есть/);
  assert.equal(canceled, false);
  f.files.delete("note.md");
  f.remote.set(`.safe-sync-safety/Удалённые/${f.intent.baseHash}/note.md`, { bytes: original, etag: '"archive"' });
  await f.engine.restoreDeleted("note.md");
  assert.equal(await digest(f.files.get("note.md")!.bytes), f.intent.baseHash);
  assert.equal(canceled, true);
});

test("legacy grouping preserves file objects and skips any occupied destination", async () => {
  const old = "Safe Sync Backups/2026-09-08T12-14-47-284Z-конфликт/Локальная/Base/note.md";
  const old2 = old.replace("284Z", "285Z");
  const one: any = new TFile(old), two: any = new TFile(old2);
  const files = new Map([[old, one], [old2, two], [legacyBackupTarget(old2), new TFile(legacyBackupTarget(old2))]]);
  let moved = 0;
  const app = { vault: {
    getFiles: () => [...files.values()],
    getAbstractFileByPath: (p: string) => files.get(p) ?? null,
    adapter: { exists: async () => true },
    rename: async (file: any, p: string) => { assert.equal(files.has(p), false); files.delete(file.path); file.path = p; files.set(p, file); moved++; }
  } };
  assert.equal(await groupLegacyBackups(app), 1);
  assert.equal(files.get(legacyBackupTarget(old)), one);
  assert.equal(files.get(old2), two);
  assert.equal(moved, 1);
});

test("capture only records new observed deletion events after opt-in and baseline; folder rename keeps destinations", async () => {
  const plugin = new Plugin();
  plugin.ready = true;
  plugin.sourcePluginEnabled = () => false;
  plugin.persist = async () => {};
  plugin.data = { settings: { syncDeletions: false, syncOnSave: false },
    deletionState: { deviceId: "device", pending: [], baselineReady: true },
    state: { "Base/a.md": { existsRemote: true, baseHash: "a".repeat(64) },
      "Base/b.md": { existsRemote: true, baseHash: "b".repeat(64) } } };
  await plugin.captureDeletion("Base/a.md");
  assert.equal(plugin.data.deletionState.pending.length, 0);
  plugin.data.settings.syncDeletions = true;
  await plugin.captureDeletion("Base", { path: "Renamed" });
  assert.equal(plugin.data.deletionState.pending.length, 2);
  assert.equal(plugin.data.deletionState.pending[0].renameTo, "Renamed/a.md");
  await plugin.captureDeletion("Base");
  assert.equal(plugin.data.deletionState.pending.length, 2);
  await plugin.captureDeletion("Safe Sync Backups/old.md");
  assert.equal(plugin.data.deletionState.pending.length, 2);
});

test("old backup grouping retains paths and distinguishes versions without single-file directories", () => {
  const target = legacyBackupTarget("Safe Sync Backups/2026-09-08T12-14-47-284Z-конфликт/Локальная/Base/note.md");
  assert.equal(target, "Safe Sync Backups/Архив/2026-09-08/Конфликты/Локальная/Base/note [12-14-47-284Z-конфликт].md");
  assert.notEqual(target, legacyBackupTarget("Safe Sync Backups/2026-09-08T12-14-47-285Z-конфликт/Локальная/Base/note.md"));
  assert.equal(legacyBackupTarget(target), undefined);
  assert.equal(legacyBackupTarget("Safe Sync Backups/2026-09-13/Запуск 10-00-00-123-abc/Конфликты/Локальная/note.md"), undefined);
});
test("pressing sync during a background run opens live progress and can reopen it", async () => {
  const plugin = new Plugin();
  plugin.app = {};
  plugin.running = true;
  plugin.startedAt = Date.now();
  plugin.lastProgress = { phase: "files", label: "Файлы", completed: 42, total: 100, path: "note.md" };
  await plugin.sync(false, "настройки");
  const modal = plugin.progressModal;
  try {
    assert.equal(modal.visible, true);
    assert.match(modal.countEl.text, /42 из 100/);
    await plugin.sync(false, "вручную");
    assert.equal(modal.opens, 1);
    modal.close();
    await plugin.sync(false, "командой");
    assert.equal(modal.opens, 2);
    assert.equal(modal.visible, true);
  } finally { modal.close(); }
});

test("progress counts scanned folders and reaches 100 only on completion", async () => {
  const plugin = new Plugin();
  Object.assign(plugin, { app: {}, running: true, startedAt: Date.now(), lastProgress:
    { phase: "remote", label: "Читаю папки сервера", completed: 8, total: 12 } });
  await plugin.sync(false, "вручную");
  const modal = plugin.progressModal;
  try {
    assert.match(modal.countEl.text, /Проверено папок: 8/);
    modal.update({ phase: "files", label: "Файлы", completed: 100, total: 100 });
    assert.equal(modal.progressEl.value, 95);
    modal.update({ phase: "saving", label: "Индекс", completed: 1, total: 1 });
    assert.equal(modal.progressEl.value, 99);
    modal.finish("Готово", []);
    assert.equal(modal.progressEl.value, 100);
    assert.match(modal.titleEl.text, /завершена/);
  } finally { modal.close(); }
});

test("an error is visible in an attached background progress window", async () => {
  const plugin = new Plugin();
  Object.assign(plugin, { app: {}, running: true, startedAt: Date.now() });
  await plugin.sync(false, "настройки");
  const modal = plugin.progressModal;
  try {
    modal.fail("WebDAV: HTTP 503");
    assert.equal(modal.titleEl.text, "Ошибка синхронизации");
    assert.match(modal.phaseEl.text, /503/);
  } finally { modal.close(); }
});
