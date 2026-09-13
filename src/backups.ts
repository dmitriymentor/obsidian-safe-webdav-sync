import { TFolder, type App } from "obsidian";
export const BACKUPS = "Safe Sync Backups";

// Old releases used a different timestamp directory for every file. Group by
// day and kind; retain the original timestamp in the filename so even distinct
// versions of the same note cannot overwrite each other.
export function legacyBackupTarget(path: string): string | undefined {
  const match = path.match(/^Safe Sync Backups\/(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2}-\d{3}Z)-(конфликт|удал[^/]*)\/(.+)$/);
  if (!match) return undefined;
  const [, day, time, kind, original] = match;
  const slash = original!.lastIndexOf("/");
  const folder = slash < 0 ? "" : original!.slice(0, slash + 1);
  const file = original!.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const suffix = ` [${time}-${kind}]`;
  const name = dot > 0 ? file.slice(0, dot) + suffix + file.slice(dot) : file + suffix;
  return `${BACKUPS}/Архив/${day}/${kind === "конфликт" ? "Конфликты" : "Удалённые"}/${folder}${name}`;
}

export function backupRunId(): string {
  return `${new Date().toISOString().slice(0, 10)}/Запуск ${new Date().toISOString().slice(11, 23).replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function groupLegacyBackups(app: App): Promise<number> {
  const files = app.vault.getFiles().filter(file => legacyBackupTarget(file.path));
  let moved = 0;
  const oldFolders = new Set<string>();
  for (const file of files) {
    const target = legacyBackupTarget(file.path)!;
    if (app.vault.getAbstractFileByPath(target)) continue; // Never overwrite.
    const parts = target.split("/"); parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await app.vault.adapter.exists(current)) await app.vault.createFolder(current);
    }
    let parent = file.parent;
    while (parent && parent.path !== BACKUPS) { oldFolders.add(parent.path); parent = parent.parent; }
    await app.vault.rename(file, target);
    moved++;
  }
  // Only empty old directories are removed. All versions remain in the archive.
  for (const path of [...oldFolders].sort((a, b) => b.length - a.length)) {
    const folder = app.vault.getAbstractFileByPath(path);
    if (folder instanceof TFolder && folder.children.length === 0) await app.vault.delete(folder);
  }
  return moved;
}
