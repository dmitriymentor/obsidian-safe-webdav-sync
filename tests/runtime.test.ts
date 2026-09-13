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
const obsidian = { Modal, TFile, normalizePath: (p: string) => p,
  Plugin: class {}, PluginSettingTab: class {}, Notice: class {},
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
