# Safe WebDAV Sync

Free, mobile-compatible Obsidian sync for an existing encrypted Remotely Save
WebDAV folder. It imports the local Remotely Save settings without printing or
publishing credentials.

## Safety model

- Markdown uses a real three-way, line-based merge (`local`, `last common`,
  `remote`). Non-overlapping edits merge automatically.
- Overlapping edits are kept in the note with visible conflict markers and both
  complete versions are copied to `Safe Sync Backups`.
- Missing files are restored from the other side. Automatic deletion is
  intentionally disabled until durable cross-device tombstones are available.
- A mass-change guard aborts the run if WebDAV suddenly returns less than half
  of the previously indexed remote files.
- Non-text conflicts keep both versions instead of silently choosing one.
- The `updated:` YAML field is merged separately to avoid timestamp-only
  conflicts caused by “Update time on edit”.
- Manual sync displays a live progress window with the current phase, file,
  processed count, percentage, and final summary.

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
