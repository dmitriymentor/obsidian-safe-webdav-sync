import type { App, TFile } from "obsidian";
import type { RcloneCrypto } from "./crypto";
import type { NameRepair } from "./types";
import { syncWriteOptions } from "./file-times";

const encoder = new TextEncoder();
const buffer = (text: string): ArrayBuffer => encoder.encode(text).buffer as ArrayBuffer;
const digest = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map(x => x.toString(16).padStart(2, "0")).join("");
const canonical = (path: string) => path.normalize("NFC").toLowerCase();

export function preserveFullTitle(text: string, title: string): string {
  if (text.startsWith("\uFEFF")) return "\uFEFF" + preserveFullTitle(text.slice(1), title);
  const heading = "# " + title.replace(/[\\`*_{}\[\]<>#!|]/g, "\\$&");
  if (text.split(/\r?\n/).some(line => line === heading || line === "# " + title)) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let offset = 0;
  if (/^---\r?\n/.test(text)) {
    const frontmatter = text.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/);
    if (!frontmatter) throw new Error("Незакрытые свойства заметки — имя не изменено");
    offset = frontmatter[0].length;
  }
  const prefix = text.slice(0, offset);
  return prefix + (prefix && !prefix.endsWith("\n") ? newline : "") + heading + newline + newline + text.slice(offset);
}

export async function shorterNotePath(path: string, crypt: Pick<RcloneCrypto, "encryptPath">,
  occupied: Iterable<string>): Promise<string | undefined> {
  const encrypted = (await crypt.encryptPath(path)).split("/");
  if (encrypted.every(part => encoder.encode(part).length <= 255)) return undefined;
  if (encrypted.slice(0, -1).some(part => encoder.encode(part).length > 255)) {
    throw new Error("Слишком длинное имя папки: автоматическое сокращение применяется только к названиям заметок");
  }
  const match = path.match(/^(.*\/)?([^/]+)(\.(?:md|markdown))$/i);
  if (!match) throw new Error("Слишком длинное имя вложения: сократите его вручную; файл сохранён");
  const [, parent = "", stem = "", extension = ""] = match;
  const reserved = new Set([...occupied].map(canonical));
  const suffixHash = (await digest(buffer(path))).slice(0, 10);
  const chars = Array.from(stem);
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = ` — ${suffixHash}${attempt ? "-" + attempt : ""}${extension}`;
    let lo = 1, hi = chars.length, best = "";
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = chars.slice(0, mid).join("").trimEnd() + suffix;
      if (encoder.encode(await crypt.encryptPath(candidate)).length <= 255) {
        best = candidate; lo = mid + 1;
      } else hi = mid - 1;
    }
    if (!best) throw new Error("Не удалось подобрать безопасное короткое имя; файл сохранён");
    const target = parent + best;
    if (!reserved.has(canonical(target))) return target;
  }
  throw new Error("Все варианты короткого имени заняты; файл сохранён");
}

export async function applyNameRepair(app: App, file: TFile, target: string, crypt: RcloneCrypto,
  history: NameRepair[], persist: () => Promise<void>): Promise<void> {
  const from = file.path;
  if (app.vault.getAbstractFileByPath(target) || await app.vault.adapter.exists(target)) {
    throw new Error("Короткое имя уже занято — существующий файл сохранён");
  }
  const original = await app.vault.read(file);
  const title = from.slice(from.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "");
  const content = preserveFullTitle(original, title);
  const originalBytes = buffer(original);
  const backupPath = `.safe-sync-name-repairs/${await digest(buffer(from))}-${await digest(originalBytes)}.bin`;
  const adapter = app.vault.adapter;
  if (!await adapter.exists(".safe-sync-name-repairs")) await adapter.mkdir(".safe-sync-name-repairs");
  if (!await adapter.exists(backupPath)) await adapter.writeBinary(backupPath, await crypt.encrypt(originalBytes));
  if (await digest(await crypt.decrypt(await adapter.readBinary(backupPath))) !== await digest(originalBytes)) {
    throw new Error("Не удалось проверить резервную копию — имя не изменено");
  }
  // Durable provenance before modifying either the text or the path. A failed
  // rename leaves the full title in the original file, and a retry is idempotent.
  const record: NameRepair = { from, to: target, backupPath, at: new Date().toISOString(), completed: false };
  history.push(record);
  await persist();
  if (file.path !== from || app.vault.getAbstractFileByPath(from) !== file) {
    throw new Error("Заметка перемещена во время проверки — повторите синхронизацию");
  }
  const options = syncWriteOptions(from, originalBytes, file.stat);
  if (content !== original) {
    await app.vault.process(file, current => {
      if (current !== original) throw new Error("Заметка изменена во время проверки — имя сохранено");
      return content;
    }, options);
  } else if (await app.vault.read(file) !== original) {
    throw new Error("Заметка изменена во время проверки — имя сохранено");
  }
  if (app.vault.getAbstractFileByPath(target) || await adapter.exists(target)) {
    throw new Error("Короткое имя занято во время проверки; полный заголовок сохранён в исходной заметке");
  }
  // Use Obsidian's rename API, including its configured link-update behavior.
  await app.fileManager.renameFile(file, target);
  record.completed = true;
  await persist();
}
