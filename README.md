# Safe WebDAV Sync

Free, mobile-compatible Obsidian sync for an existing encrypted Remotely Save
WebDAV folder. Configure the connection directly in Safe WebDAV Sync, or import
local Remotely Save settings without printing or publishing credentials.

## Safety model

- Markdown uses a real three-way, line-based merge (`local`, `last common`,
  `remote`). Non-overlapping edits merge automatically.
- Conflicting regions keep only the newer version, without conflict markers.
  Both distinct complete originals are retained in the protected backup archive
  (0.2.5); older visible copies remain in `Safe Sync Backups`.
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
- Version 0.2.3 preserves Markdown `created`/`updated` file times when applying
  synchronized content, so “Update time on edit” does not mistake a download
  for a new edit. Identical bytes are not rewritten. Notes without valid dates
  fall back to the known source/file times. Real edits still update dates.
  Backup writes no longer enqueue save-triggered syncs. Update every device
  before synchronizing restored historical dates.
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
- Older backups share a date/run directory, subdivided into conflicts and deleted
  files with original paths. Old one-file timestamp directories are grouped by
  date after a successful sync, or via "Сгруппировать старые бекапы". Timestamp
  suffixes preserve every distinct old version; occupied destinations are skipped,
  and only empty old directories are removed. Internal server archive directories
  are excluded from normal traversal; encrypted backup contents remain retained.

## Installation

Version 0.2.8 automatically shortens overlong Markdown filenames that have never
been uploaded, after checking the remote index and before reading local content.
It first retains the complete original title as a heading after YAML frontmatter,
without truncating existing content. The shorter filename keeps its extension
and a deterministic path-hash suffix, is checked using actual Rclone encryption,
and never overwrites a local destination. Normal names stay unchanged. A remote
counterpart with the same deterministic name and complete heading is reconciled
by normal sync; unrelated occupied names get another suffix.

Before changing a note, a verified encrypted original is retained locally in
`.safe-sync-name-repairs/`; the original path, destination and backup location are
persisted in plugin data (`nameRepairs`) and shown in the last-report window.
Keep both the hidden archive and plugin data in device backups. YAML dates are
not rewritten, and file times use the existing date-preservation logic. Obsidian's
FileManager performs the rename and honors the user's automatic link-update
preference. Dry runs do not rename or write. Already-synced/deletion-tracked long
paths, overlong folder names and binary attachments still require manual action.

Version 0.2.7 bypasses native HTTP response caches on all object reads, including
post-write verification, archives, journal reads and weak-validator retries.
Each GET has a unique query and no-cache/no-store headers; object paths and write
conditions are unchanged. Unexpected or mismatched verification still stops
the operation without replacing the local note. Encrypted path components over
255 bytes are rejected with an actionable rename message before network writes.
No notes or archives are automatically renamed, removed or migrated.

Version 0.2.6 reads GET/PUT ETag headers case-insensitively (including `Etag`)
and trims surrounding whitespace. Conflicting header values fail closed. Weak
validators still trigger a fresh-read retry, never conversion into strong ones.
Conditional repair/deletion require a complete strong quoted validator. A repair
with an unusable validator now stops before making backups and explains whether
the header is missing/ambiguous, weak or malformed. Failed runs are labeled as
errors, not "Готово". No concurrency protection or If-Match condition is removed.

Version 0.2.5 protects new backup contents from Markdown plugins. They are
encrypted with the existing vault encryption password and written via the data
adapter as hidden `.safe-sync-backups/v1` binary objects. Local JSON metadata
contains original paths, hashes, kind and first archive time, not note content.
Keep this hidden directory and the encryption password when backing up a device.
The key is stored locally in Safe WebDAV Sync after importing or saving a connection.
Legacy installations can still read it from Remotely Save until imported.

Each original path/content hash/kind has one local copy, even after restart or
failed upload. Verified remote versions are reused with create-only conditional
publication; corrupted archives stop processing and are never overwritten.
Deletion archives retain the old remote path for cross-version restore support.
No old backup is migrated or removed, and verification checks are not disabled.
Use settings → **Защищённые бекапы → Открыть архив** to decrypt a selected version
into a new visible copy, never over the working note. Exported copies and the
originals moved into the deletion recovery tree are ordinary visible files;
their protected archive remains immutable. Hidden archive contents stay out of
the note index and regular sync traversal.

Settings → **Последний отчёт → Открыть** shows all errors from the last run and
retains the last failed report after a subsequent success. Reports persist in
the plugin data on this device; opening them does not start sync. Any sync error
pauses automatic retries across restarts; only a successful real manual run
clears the pause (a dry run does not). The user's auto-sync toggles are preserved.
Reports before installing 0.2.5 cannot be reconstructed from the new report UI.

Version 0.2.4 scans up to four server directories concurrently and reuses the
clean remote body already fetched for legacy-conflict inspection within that
single file operation. The reused body retains its own GET validator. Remote
data is never cached across runs; post-repair verification is still a fresh
read. A failed directory aborts the whole listing after pending reads drain.
Every run still checks all local files, the server tree and deletion journal.
There is no change to encryption, server format, conflict or deletion rules.
Local caching was deferred: measurements on the development vault showed local
reading/hashing under 0.1 seconds; network latency dominated. Speedups depend
on network conditions and the number of changed remote fingerprints.

Install with BRAT from this repository. Disable Remotely Save if installed.
Configure the connection in Safe WebDAV Sync or import its legacy settings.
No password is stored in this repository.

The first installed run is intentionally manual. Use “Проверить план” once,
then enable automatic sync after the initial index has been created.

> Do not enable two synchronization plugins at the same time.

When Remotely Save's remote directory field is empty, this plugin mirrors its
behavior and uses the vault name. This prevents mobile devices from syncing to
the WebDAV account root by mistake.

## Shared settings and plugins (0.3.0)

Safe WebDAV Sync 0.3.0 adds optional encrypted synchronization of shared Obsidian settings, plugin files and ordinary plugin settings, themes, snippets, and hotkeys. Enable “Синхронизировать настройки и плагины” on each device. Restart Obsidian after downloading settings or plugin updates.

Sync journals, connection credentials, workspace layouts, and desktop AI/REST integrations stay local. Mobile skips desktop-only plugins. Concurrent settings edits retain both originals and report a conflict. Missing settings are not treated as deletion events.

Validation: production build completed. Tests were not run at the user’s request.

## Standalone connection and mobile setup (0.3.1+)

A fresh device no longer requires Remotely Save. In Safe WebDAV Sync settings,
enter the HTTPS WebDAV address, username, WebDAV password, RClone Crypt password
and exact remote folder, then save. In 0.3.2, choose **Показать QR** on the
configured device and **Сканировать QR** on the new one. Confirm the displayed
server and remote folder before saving. The QR includes the shared-settings
switch; journals and automatic deletion settings stay local.

QR codes contain plaintext credentials: show them only to your own device,
never publish screenshots. Codes are generated and decoded locally, without
an external QR service. The plugin never writes the QR image to disk. Clipboard
transfer was available in 0.3.1; 0.3.2 replaces it with QR transfer.


On a new phone, run synchronization manually after importing, then restart
Obsidian to apply downloaded plugins and settings. Enable automatic sync after
this succeeds. Existing installations can choose **Импортировать** once to keep
their legacy connection locally and stop relying on Remotely Save's data file.
Connection settings remain excluded from shared-settings synchronization.

Changing server, account, folder or encryption key with an existing journal is
blocked; use a new vault for a different remote. Editing fields does not change
the active connection until Save is pressed. The password fields are masked;
local plugin data is not a secure keystore. Sync errors now display a stopped
progress state rather than an ongoing operation.

## QR connection transfer (0.3.2)

The scanner requests the rear camera and decodes frames locally. If the WebView
does not expose camera access or permission is denied, **Считать с фотографии**
reads a selected QR image locally. The camera stream is stopped when the modal
closes or a connection QR is accepted, including late permission responses.

The QR is also an `obsidian://safe-webdav-sync` link. The system Camera app can
open it in Obsidian when supported by the operating system. Have the intended
vault open and the updated plugin enabled. Both the built-in scanner and the
protocol link require a confirmation showing the server and folder. Neither
starts synchronization automatically; existing-journal restrictions still apply.

Production build completed. No tests were run at the user's request. Camera and
protocol-link behavior on the iPhone must be confirmed on the device.

## Mobile plugin compatibility and navigation (0.3.3)

Obsidian community plugins generally distribute one package for desktop and
mobile. `isDesktopOnly` controls mobile compatibility; `minAppVersion` controls
the required Obsidian version. Synchronizing an installed package does not
select a separate mobile edition or fetch the latest store version. Update
community plugins through Obsidian's store and sync the resulting files.

On mobile, shared settings now validate plugin manifests and the available
Obsidian API version before copying plugin files. The enabled-plugin list is
processed after the files. Only compatible plugins with a local manifest and
main.js can enter that list; a failed binary transfer excludes that plugin.
Desktop-only integrations and unavailable plugins are excluded on the phone,
while their server enable-list entries are retained on mobile uploads. Legacy
manifests without an explicit minimum version remain supported.

Workspace layouts remain device-local. Third-party plugin source and defaults
are unchanged. New enabled plugins with no existing settings are initialized
through Obsidian's user-initiated enable pipeline **before** their shared
`data.json` is imported. The pipeline awaits normal plugin loading and calls its
own `onUserEnable` hook, as store installation does; no specific plugin command,
view type or settings key is used.

First-install intent and completion are recorded locally in Safe Sync data,
which is excluded from shared settings. Failed initialization blocks that
plugin's settings import and reports an error. Plugin defaults created during
initialization are backed up before shared preferences replace them. Existing
plugins and their workspace layout are not reset. After synchronization, restart
Obsidian to apply the imported preferences. Plugins with additional onboarding
prompts can still require the user's normal responses.

The implementation uses Obsidian's internal plugin manager, inspected in the
installed 1.14.4 app. If required methods are unavailable, settings import for
the new plugin is paused with instructions to enable it in Obsidian's settings.
There is no generic official public API for store-style community plugin setup.

Production build completed; no tests were run at the user's request. Mobile
compatibility filtering and first-install initialization still need confirmation on iPhone.
