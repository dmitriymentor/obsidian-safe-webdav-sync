import { mergeMarkdown, type MergeTimes } from "./merge";

const START = "<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ";
const BASE = "||||||| ПОСЛЕДНЯЯ ОБЩАЯ";
const SEP = "=======";
const END = ">>>>>>> ВЕРСИЯ С СЕРВЕРА";
type Node = string | { local: Node[]; base: Node[]; remote: Node[] };

export function hasLegacyConflicts(text: string): boolean {
  return /^(<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ|\|{7} ПОСЛЕДНЯЯ ОБЩАЯ|>>>>>>> ВЕРСИЯ С СЕРВЕРА)\r?$/m.test(text);
}

const date = (text: string) => Date.parse(text.match(/^updated:[ \t]*(.*)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2") ?? "");

export function repairLegacyConflicts(text: string): { text: string; blocks: number; ties: number } {
  if (!hasLegacyConflicts(text)) return { text, blocks: 0, ties: 0 };
  // A historical partial merge lost its opening markers. Repair only two
  // complete documents with identical metadata/body except updated; never
  // guess which content to discard in an incomplete unequal conflict.
  const orphan = text.match(/^([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>> ВЕРСИЯ С СЕРВЕРА(?:\r?\n)?$/m);
  if (!text.includes(START) && !text.includes(BASE) && orphan && orphan[0] === text) {
    const a = orphan[1]!, b = orphan[2]!;
    const document = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
    const comparable = (s: string) => s.replace(document, m => m.replace(/^updated:.*$/m, "updated:")).trimEnd();
    if (document.test(a) && document.test(b) && comparable(a) === comparable(b) &&
        Number.isFinite(date(a)) && Number.isFinite(date(b))) {
      const chosen = date(a) > date(b) ? a : b;
      if (!hasLegacyConflicts(chosen)) return { text: chosen.trimEnd() + "\n", blocks: 1, ties: date(a) === date(b) ? 1 : 0 };
    }
  }
  // Older clients can wrap a conflict in another conflict; regex pairing fails.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let index = 0, blocks = 0, ties = 0;
  const marker = () => lines[index]?.replace(/\r?\n$/, "");
  const malformed = () => new Error("Повреждённые маркеры старого конфликта — файл сохранён без изменений");
  function parse(stop?: string, depth = 0): Node[] {
    if (depth > 50) throw malformed();
    const nodes: Node[] = [];
    while (index < lines.length) {
      const line = marker();
      if (stop && line === stop) { index++; return nodes; }
      if (line === START) {
        index++; blocks++;
        const local = parse(BASE, depth + 1);
        const base = parse(SEP, depth + 1);
        const remote = parse(END, depth + 1);
        nodes.push({ local, base, remote });
      } else {
        if (line === BASE || line === END || (stop && line === SEP)) throw malformed();
        nodes.push(lines[index++]!);
      }
    }
    if (stop) throw malformed();
    return nodes;
  }
  // Dates must belong to this branch, not to its nested conflicts.
  const directDate = (nodes: Node[]) => date(nodes.filter((n): n is string => typeof n === "string").join(""));
  const uniqueDate = (values: number[]) => {
    const unique = [...new Set(values.filter(Number.isFinite))];
    return unique.length === 1 ? unique[0]! : NaN;
  };
  function render(nodes: Node[]): string {
    const conflicts = nodes.filter((n): n is Exclude<Node, string> => typeof n !== "string");
    // Fragment conflicts from the same merge can follow a dated conflict.
    // Reuse side-specific dates only when unambiguous at this nesting level.
    const localDate = uniqueDate(conflicts.map((n) => directDate(n.local)));
    const remoteDate = uniqueDate(conflicts.map((n) => directDate(n.remote)));
    return nodes.map((node) => {
      if (typeof node === "string") return node;
      if (JSON.stringify(node.local) === JSON.stringify(node.remote)) return render(node.local);
      const a = Number.isFinite(directDate(node.local)) ? directDate(node.local) : localDate;
      const b = Number.isFinite(directDate(node.remote)) ? directDate(node.remote) : remoteDate;
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error("Не сохранились даты исходных версий старого конфликта — нужен отдельный разбор");
      }
      if (a === b) ties++;
      return render(a > b ? node.local : node.remote);
    }).join("");
  }
  let repaired = render(parse());
  // Update time on edit inserted an outer metadata block ahead of the old
  // conflict. Recover the original created/tags while retaining latest updated.
  for (;;) {
  const next = repaired.replace(/^---\r?\n((?:(?:created|updated):[^\r\n]*\r?\n)+)---\r?\n(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/,
    (_whole, outer: string, inner: string) => {
      const outerDate = date(outer);
      if (Number.isFinite(outerDate) && outerDate > date(inner)) {
        const updated = outer.match(/^updated:[ \t]*(.*)$/m)![1];
        return inner.replace(/^updated:.*$/m, `updated: ${updated}`);
      }
      return inner;
    });
  if (next === repaired) break;
  repaired = next;
  }
  if (hasLegacyConflicts(repaired)) throw malformed();
  return { text: repaired, blocks, ties };
}

export function planLegacyRepair(local: string, base: string, remote: string, times: MergeTimes) {
  if (![local, base, remote].some(hasLegacyConflicts)) return undefined;
  const l = repairLegacyConflicts(local);
  const b = repairLegacyConflicts(base);
  const r = repairLegacyConflicts(remote);
  // Clean the saved base too, so old markers cannot be interpreted as new edits.
  const merged = l.text === r.text ? { text: l.text, conflict: false }
    : l.text === b.text ? { text: r.text, conflict: false }
    : r.text === b.text ? { text: l.text, conflict: false }
    : mergeMarkdown(l.text, b.text, r.text, times);
  return { ...merged, blocks: l.blocks + b.blocks + r.blocks };
}
