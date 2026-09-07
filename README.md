# Safe WebDAV Sync

Free, mobile-compatible Obsidian sync for an existing encrypted Remotely Save
WebDAV folder. It imports the local Remotely Save settings without printing or
publishing credentials.

## Safety model

- Markdown uses a real three-way, line-based merge (`local`, `last common`,
  `remote`). Non-overlapping edits merge automatically.
- Overlapping edits are kept in the note with visible conflict markers and both
  complete versions are copied to `Safe Sync Backups`.
- Deletions are recoverable: remote deletions are backed up locally; local
  deletions move the encrypted remote object into `.safe-sync-safety`.
- Non-text conflicts keep both versions instead of silently choosing one.
- The `updated:` YAML field is merged separately to avoid timestamp-only
  conflicts caused by “Update time on edit”.

## Installation

Install with BRAT from this repository, then disable the original Remotely Save
plugin. Safe WebDAV Sync reads its settings file locally, so no password is
stored in this repository.

The first installed run is intentionally manual. Use “Проверить план” once,
then enable automatic sync after the initial index has been created.

> Do not enable two synchronization plugins at the same time.
