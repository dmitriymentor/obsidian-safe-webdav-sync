Version 0.2.0 adds opt-in file deletion sync and grouped backups.

IMPORTANT: update EVERY device to 0.2.0, restart Obsidian and complete a normal
sync before enabling "Синхронизировать удаление файлов" on each device. It is
off by default. Previous missing files are never retroactively deleted.

New observed delete/rename events are persisted as immutable encrypted journal
records. Changed files require an explicit keep/delete decision in a manual run.
Mass deletion requires confirmation. Remote deletion uses a verified encrypted
archive and a strong If-Match precondition; local originals move into backups.
Rename destinations must reach the server first. Journals and archives are
retained indefinitely, preventing old offline copies from silently returning.
"Восстановить удалённый файл" restores a verified archive without overwriting
an existing note; sync afterwards to distribute the restored file.

New backups are grouped by date and sync run, with conflict/deleted categories
and original paths. Old one-file folders are grouped by day after a successful
sync or using "Сгруппировать старые бекапы". Every old version retains its timestamp;
occupied targets are skipped. No backup content is purged. Normal server scans
skip archive trees, while live sync progress remains available.

Validation: 34 passing tests, production build and TypeScript checks. Isolated
tests on the configured server confirmed conditional creation/deletion and
preservation on wrong ETag. Newly written weak ETags are re-read, never weakened.
