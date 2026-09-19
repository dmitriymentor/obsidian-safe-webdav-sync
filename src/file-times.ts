import type { DataWriteOptions } from "obsidian";

// Remote Last-Modified is the time of upload, not necessarily the edit time.
// Prefer the date carried inside the encrypted note. Never rewrite its YAML.
export function noteDate(text: string, field: "created" | "updated"): number | undefined {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const value = frontmatter?.match(new RegExp(`^${field}:[ \\t]*(.*)$`, "m"))?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:$|[Tt ])/u.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function syncWriteOptions(path: string, bytes: ArrayBuffer, existing?: { mtime: number; ctime: number }, sourceMtime?: number): DataWriteOptions {
  const valid = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
  let text = "";
  if (/\.(md|markdown)$/i.test(path)) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* Binary fallback. */ }
  }
  const mtime = noteDate(text, "updated") ?? valid(sourceMtime) ?? valid(existing?.mtime);
  const ctime = noteDate(text, "created") ?? valid(existing?.ctime) ?? mtime;
  return { ...(mtime === undefined ? {} : { mtime }), ...(ctime === undefined ? {} : { ctime }) };
}
