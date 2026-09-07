import { diff3Merge } from "node-diff3";

export interface MarkdownMergeResult {
  text: string;
  conflict: boolean;
}

const UPDATED = /^([ \t]*updated[ \t]*:[ \t]*)(.*)$/im;

function extractUpdated(text: string): string | undefined {
  return text.match(UPDATED)?.[2]?.trim();
}

function neutralizeUpdated(text: string, base: string): string {
  const baseValue = extractUpdated(base);
  if (!baseValue) return text;
  return text.replace(UPDATED, (_all, prefix: string) => `${prefix}${baseValue}`);
}

function newestUpdated(...values: Array<string | undefined>): string | undefined {
  return values.filter((v): v is string => Boolean(v)).sort((a, b) => {
    const da = Date.parse(a);
    const db = Date.parse(b);
    if (Number.isFinite(da) && Number.isFinite(db)) return db - da;
    return b.localeCompare(a);
  })[0];
}

export function mergeMarkdown(local: string, base: string, remote: string): MarkdownMergeResult {
  const localUpdated = extractUpdated(local);
  const remoteUpdated = extractUpdated(remote);
  const baseUpdated = extractUpdated(base);
  const a = neutralizeUpdated(local, base);
  const b = neutralizeUpdated(remote, base);
  const regions = diff3Merge(a, base, b, {
    excludeFalseConflicts: true,
    stringSeparator: /\r?\n/
  });
  const lines: string[] = [];
  let conflict = false;
  for (const region of regions) {
    if (region.ok) {
      lines.push(...(region.ok as string[]));
      continue;
    }
    const block = region.conflict! as { a: string[]; o: string[]; b: string[] };
    if (block.a.length === block.o.length && block.b.length === block.o.length) {
      for (let i = 0; i < block.o.length; i++) {
        const localLine = block.a[i]!;
        const baseLine = block.o[i]!;
        const remoteLine = block.b[i]!;
        if (localLine === remoteLine) lines.push(localLine);
        else if (localLine === baseLine) lines.push(remoteLine);
        else if (remoteLine === baseLine) lines.push(localLine);
        else {
          conflict = true;
          lines.push("<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ", localLine, "||||||| ПОСЛЕДНЯЯ ОБЩАЯ", baseLine,
            "=======", remoteLine, ">>>>>>> ВЕРСИЯ С СЕРВЕРА");
        }
      }
    } else {
      conflict = true;
      lines.push("<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ", ...block.a, "||||||| ПОСЛЕДНЯЯ ОБЩАЯ", ...block.o,
        "=======", ...block.b, ">>>>>>> ВЕРСИЯ С СЕРВЕРА");
    }
  }
  let text = lines.join("\n");
  const latest = newestUpdated(localUpdated, remoteUpdated, baseUpdated);
  if (latest && UPDATED.test(text)) text = text.replace(UPDATED, (_all, prefix: string) => `${prefix}${latest}`);
  const finalNewline = local.endsWith("\n") || remote.endsWith("\n") || base.endsWith("\n");
  if (finalNewline && !text.endsWith("\n")) text += "\n";
  return { text, conflict };
}
