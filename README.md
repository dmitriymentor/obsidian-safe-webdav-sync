# Safe WebDAV Sync

Free, mobile-compatible Obsidian sync for an existing encrypted Remotely Save
WebDAV folder. It imports the local Remotely Save settings without printing or
publishing credentials.

## Safety model

- Markdown uses a real three-way, line-based merge (`local`, `last common`,
  `remote`). Non-overlapping edits merge automatically.
- Conflicting regions keep only the newer version, without conflict markers.
  Both complete originals are backed up separately in `Safe Sync Backups`.
  The winner is determined from valid, differing YAML `updated` dates when
  both notes have them, otherwise local mtime versus WebDAV Last-Modified.
  Equal or unknown times prefer the server. These are file-level dates, not
  per-line edit history; server upload times and device clock skew can affect
  the fallback. Update the plugin on every device for consistent behavior.
- Changes align against the common base using content (LCS), so insertions
  above a line do not turn into same-number conflicts. Unambiguous unchanged
  moved blocks carry edits from the other device into their new position.
  Duplicate or simultaneously rewritten blocks cannot always be identified
  as moves. If both sides move the same recognized block to different places,
  the newer complete document wins to avoid duplicate copies of that block.
- Version 0.2.1 repairs legacy conflict markers before ordinary synchronization,
  including nested conflicts and saved common bases from older clients. It uses
  preserved branch dates; equal dates prefer the server. Undated fragments reuse
  side-specific dates only when unambiguous at the same nesting level. Broken
  or undated unequal blocks stop that note with an error, never a guessed repair.
  A partial two-document conflict is repaired only when both documents match
  apart from `updated`. Ordinary repeated lines outside conflicts are preserved.
  Verified grouped local/server backups precede conditional repair writes;
  concurrent changes stop the repair. The summary reports the cleaned count.
  Update every device to 0.2.1 before syncing old affected notes.
- Missing files alone never cause cross-device deletion. Version 0.2.0 adds
  opt-in deletion events after a successful baseline sync. Update every device
  first, then enable "Синхронизировать удаление файлов" on each device.
- Observed delete/rename events are saved locally before publication as immutable,
  encrypted journal records. A deletion refers to a path and observed SHA-256
  revision, not a wall-clock winner. An edited file is preserved until the user
  chooses keep/delete in a manual run. Background runs never decide this conflict.
- Deletion creates verified encrypted archives before conditional WebDAV DELETE
  with a strong ETag. Local originals move into the recoverable backup tree.
  Ten files, or at least two exceeding 20% of the vault, require confirmation.
  Renames upload the destination first; concurrent edits to the old path remain
  a conflict rather than being silently erased.
- Tombstones and explicit cancellation records never expire automatically. Known
  journal entries disappearing abort sync. "Восстановить удалённый файл" restores
  a verified server archive without overwriting an existing local note, then
  cancels the observed deletions. Run sync afterwards to distribute the restore.
- This tracks events observed while Obsidian and the plugin are running, not
  deletions performed while the app was closed. Previously missing files are not
  retroactively deleted. All clients must use 0.2.0 before enabling deletion;
  older clients cannot honor its journal. Unknown re-creations at a deleted path
  require conflict resolution or explicit restore. File and archive retention
  is indefinite; there is no automatic permanent purge or device-expiry shortcut.
- A mass-change guard aborts the run if WebDAV suddenly returns less than half
  of the previously indexed remote files.
- Non-text conflicts keep both versions instead of silently choosing one.
- The `updated:` YAML field is merged separately to avoid timestamp-only
  conflicts caused by “Update time on edit”.
- Routine save/delete/timer syncs no longer show completion toasts (0.2.2).
  Startup still announces completion. Manual runs report in their progress
  window, or a toast if it has been closed; errors remain visible in all modes.
  Manually opening a background run's progress enables its completion notice.
  The progress window shows the current phase, file, processed count,
  percentage, elapsed time, and final summary. Pressing sync
  during a background run opens the same run's progress instead of starting a
  second run. Closing and reopening the window keeps the current progress.
  While the server is being scanned, an indeterminate indicator and the number
  of scanned folders are shown; 100% is displayed only after completion.
- New backups share a date/run directory, subdivided into conflicts and deleted
  files with original paths. Old one-file timestamp directories are grouped by
  date after a successful sync, or via "Сгруппировать старые бекапы". Timestamp
  suffixes preserve every distinct old version; occupied destinations are skipped,
  and only empty old directories are removed. Internal server archive directories
  are excluded from normal traversal; encrypted backup contents remain retained.

## Installation

Install with BRAT from this repository, then disable the original Remotely Save
plugin. Safe WebDAV Sync reads its settings file locally, so no password is
stored in this repository.

The first installed run is intentionally manual. Use “Проверить план” once,
then enable automatic sync after the initial index has been created.

> Do not enable two synchronization plugins at the same time.

When Remotely Save's remote directory field is empty, this plugin mirrors its
behavior and uses the vault name. This prevents mobile devices from syncing to
the WebDAV account root by mistake.
