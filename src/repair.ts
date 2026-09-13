import { newerSide } from "./merge";

export function repairLegacyConflicts(text: string): { text: string; blocks: number; ties: number } {
  const start = "<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ";
  const count = text.split(start).length - 1;
  let blocks = 0;
  let ties = 0;
  const date = (branch: string) => Date.parse(branch.match(/^updated:[ \t]*(.*)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2") ?? "");
  let repaired = text.replace(
    /^<<<<<<< ЛОКАЛЬНАЯ ВЕРСИЯ\r?\n([\s\S]*?)^\|{7} ПОСЛЕДНЯЯ ОБЩАЯ\r?\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>> ВЕРСИЯ С СЕРВЕРА(?:\r?\n|$)/gm,
    (_whole, local: string, base: string, remote: string) => {
      if ([local, base, remote].some((branch) => branch.includes(start))) throw new Error("Вложенный конфликт требует отдельного разбора");
      const a = date(local);
      const b = date(remote);
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Не сохранились даты обеих исходных версий");
      blocks++;
      if (a === b) ties++;
      return newerSide(local, remote, { localMtime: a, remoteMtime: b }) === "local" ? local : remote;
    }
  );
  if (blocks !== count || /^>>>>>>> ВЕРСИЯ С СЕРВЕРА|^\|{7} ПОСЛЕДНЯЯ ОБЩАЯ/m.test(repaired)) {
    throw new Error("Повреждённые или незавершённые маркеры конфликта");
  }
  // Update time on edit inserted an outer metadata block ahead of the old
  // conflict. Recover the original created/tags while retaining latest updated.
  repaired = repaired.replace(/^---\r?\n((?:(?:created|updated):[^\r\n]*\r?\n)+)---\r?\n(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/,
    (_whole, outer: string, inner: string) => {
      const outerDate = date(outer);
      if (Number.isFinite(outerDate) && outerDate > date(inner)) {
        const updated = outer.match(/^updated:[ \t]*(.*)$/m)![1];
        return inner.replace(/^updated:.*$/m, `updated: ${updated}`);
      }
      return inner;
    });
  return { text: repaired, blocks, ties };
}
