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
  Existing conflict markers are not rewritten automatically by sync. The
  separate repair utility requires preserved original dates and makes backups
  before conditional, verified WebDAV writes.
- Missing files are restored from the other side. Automatic deletion is
  intentionally disabled until durable cross-device tombstones are available.
- A mass-change guard aborts the run if WebDAV suddenly returns less than half
  of the previously indexed remote files.
- Non-text conflicts keep both versions instead of silently choosing one.
- The `updated:` YAML field is merged separately to avoid timestamp-only
  conflicts caused by “Update time on edit”.
- Manual sync displays a live progress window with the current phase, file,
  processed count, percentage, elapsed time, and final summary. Pressing sync
  during a background run opens the same run's progress instead of starting a
  second run. Closing and reopening the window keeps the current progress.
  While the server is being scanned, an indeterminate indicator and the number
  of scanned folders are shown; 100% is displayed only after completion.

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
