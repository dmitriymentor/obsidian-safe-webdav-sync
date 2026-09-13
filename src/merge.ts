import { diffIndices } from "node-diff3";

export interface MarkdownMergeResult {
  text: string;
  conflict: boolean;
}

const UPDATED = /^([ \t]*updated[ \t]*:[ \t]*)(.*)$/im;

export interface MergeTimes {
  localMtime: number;
  remoteMtime: number;
}

interface Edit {
  start: number;
  end: number;
  lines: string[];
  side: "local" | "remote";
}

function edits(base: string[], version: string[], side: Edit["side"]): Edit[] {
  return diffIndices(base, version).map((change) => ({
    start: change.buffer1[0], end: change.buffer1[0] + change.buffer1[1],
    lines: change.buffer2Content, side
  }));
}

function overlaps(a: Edit, b: Edit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

function applyEdits(base: string[], changes: Edit[], start: number, end: number): string[] {
  const result: string[] = [];
  let cursor = start;
  for (const change of [...changes].sort((a, b) => a.start - b.start || a.end - b.end)) {
    result.push(...base.slice(cursor, change.start), ...change.lines);
    cursor = change.end;
  }
  result.push(...base.slice(cursor, end));
  return result;
}

// Carry edits into a uniquely identifiable, unchanged block moved by the
// other device. A move changes position, not the block's edit timestamp.
function followMoves(base: string[], own: Edit[], other: Edit[], winner: Edit["side"]): Edit[] {
  let remaining = [...other];
  for (const deletion of own.filter((edit) => edit.lines.length === 0 && edit.end > edit.start)) {
    const original = base.slice(deletion.start, deletion.end);
    const matches = own.filter((edit) => edit.start === edit.end &&
      JSON.stringify(edit.lines) === JSON.stringify(original));
    const occurrences = base.reduce((count, _, index) => count + (
      JSON.stringify(base.slice(index, index + original.length)) === JSON.stringify(original) ? 1 : 0), 0);
    if (matches.length !== 1 || occurrences !== 1) continue;
    const inside = remaining.filter((edit) => edit.start >= deletion.start && edit.end <= deletion.end &&
      (edit.start !== edit.end || (edit.start > deletion.start && edit.start < deletion.end)));
    if (!inside.length || remaining.some((edit) => overlaps(edit, deletion) && !inside.includes(edit))) continue;
    const fullyDeleted = inside.length === 1 && inside[0]!.start === deletion.start &&
      inside[0]!.end === deletion.end && inside[0]!.lines.length === 0;
    if (!fullyDeleted || deletion.side !== winner) {
      matches[0]!.lines = applyEdits(base, inside, deletion.start, deletion.end);
    }
    remaining = remaining.filter((edit) => !inside.includes(edit));
  }
  return remaining;
}

// No per-line clocks are available. Prefer note edit dates when both exist;
// otherwise compare local filesystem mtime and WebDAV Last-Modified.
export function newerSide(local: string, remote: string, times: MergeTimes): "local" | "remote" {
  const localDate = Date.parse(extractUpdated(local) ?? "");
  const remoteDate = Date.parse(extractUpdated(remote) ?? "");
  if (Number.isFinite(localDate) && Number.isFinite(remoteDate) && localDate !== remoteDate) {
    return localDate > remoteDate ? "local" : "remote";
  }
  const localMtime = Number.isFinite(times.localMtime) ? times.localMtime : 0;
  const remoteMtime = Number.isFinite(times.remoteMtime) ? times.remoteMtime : 0;
  // With equal or unknown times prefer the already published server version.
  return localMtime > remoteMtime ? "local" : "remote";
}

function extractUpdated(text: string): string | undefined {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return frontmatter?.match(UPDATED)?.[2]?.trim().replace(/^(['"])(.*)\1$/, "$2");
}

function neutralizeUpdated(text: string, base: string): string {
  const baseValue = extractUpdated(base);
  if (!baseValue) return text;
  return replaceUpdated(text, baseValue);
}

function replaceUpdated(text: string, value: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
    (frontmatter) => frontmatter.replace(UPDATED, (_all, prefix: string) => `${prefix}${value}`));
}

function newestUpdated(...values: Array<string | undefined>): string | undefined {
  return values.filter((v): v is string => Boolean(v)).sort((a, b) => {
    const da = Date.parse(a);
    const db = Date.parse(b);
    if (Number.isFinite(da) && Number.isFinite(db)) return db - da;
    return b.localeCompare(a);
  })[0];
}

export function mergeMarkdown(
  local: string, base: string, remote: string,
  times: MergeTimes = { localMtime: 0, remoteMtime: 0 }
): MarkdownMergeResult {
  const winner = newerSide(local, remote, times);
  const localUpdated = extractUpdated(local);
  const remoteUpdated = extractUpdated(remote);
  const baseUpdated = extractUpdated(base);
  const a = neutralizeUpdated(local, base);
  const b = neutralizeUpdated(remote, base);
  const original = base.split(/\r?\n/);
  let localEdits = edits(original, a.split(/\r?\n/), "local");
  let remoteEdits = edits(original, b.split(/\r?\n/), "remote");
  for (const deletion of localEdits.filter((edit) => edit.lines.length === 0 && edit.end > edit.start)) {
    const otherDeletion = remoteEdits.find((edit) => edit.start === deletion.start && edit.end === deletion.end && edit.lines.length === 0);
    if (!otherDeletion) continue;
    const moved = JSON.stringify(original.slice(deletion.start, deletion.end));
    const leftMove = localEdits.find((edit) => edit.start === edit.end && JSON.stringify(edit.lines) === moved);
    const rightMove = remoteEdits.find((edit) => edit.start === edit.end && JSON.stringify(edit.lines) === moved);
    if (leftMove && rightMove && leftMove.start !== rightMove.start) {
      // Incompatible reorderings have no shared target. Keep the newer document
      // as one coherent ordering rather than publishing two copies of the block.
      return { text: winner === "local" ? local : remote, conflict: true };
    }
  }
  remoteEdits = followMoves(original, localEdits, remoteEdits, winner);
  localEdits = followMoves(original, remoteEdits, localEdits, winner);
  const pending = [...localEdits, ...remoteEdits].sort((x, y) => x.start - y.start || x.end - y.end);
  const lines: string[] = [];
  let conflict = false;
  let cursor = 0;
  while (pending.length) {
    const group = [pending.shift()!];
    for (let index = 0; index < pending.length;) {
      if (group.some((edit) => overlaps(edit, pending[index]!))) {
        group.push(pending.splice(index, 1)[0]!);
        index = 0;
      } else index++;
    }
    const start = Math.min(...group.map((edit) => edit.start));
    const end = Math.max(...group.map((edit) => edit.end));
    lines.push(...original.slice(cursor, start));
    const left = group.filter((edit) => edit.side === "local");
    const right = group.filter((edit) => edit.side === "remote");
    if (!left.length || !right.length) lines.push(...applyEdits(original, group, start, end));
    else {
      const leftLines = applyEdits(original, left, start, end);
      const rightLines = applyEdits(original, right, start, end);
      if (JSON.stringify(leftLines) !== JSON.stringify(rightLines)) conflict = true;
      lines.push(...(winner === "local" ? leftLines : rightLines));
    }
    cursor = end;
  }
  lines.push(...original.slice(cursor));
  let text = lines.join("\n");
  const latest = newestUpdated(localUpdated, remoteUpdated, baseUpdated);
  if (latest) text = replaceUpdated(text, latest);
  return { text, conflict };
}
