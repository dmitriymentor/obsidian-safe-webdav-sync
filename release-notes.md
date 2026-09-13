Conflict resolution now keeps one variant in each overlapping Markdown region,
chosen from the newer note. Independent edits still merge. Content-based
alignment handles shifted lines and carries edits into uniquely recognized moved
blocks. Incompatible moves of the same block keep the newer document.

The comparison uses original YAML updated dates, falling back to filesystem and
WebDAV modification times. Equal dates prefer the server. This is file-level
recency, not per-line edit history. Original conflict versions remain in separate
backups. Automatic file deletion remains disabled.

Validation: 17 passing tests covering shifted lines, moved blocks, adjacent edits,
timestamp precedence, conflict selection and legacy conflict repair; TypeScript
checks and production bundle build.

Update every device through BRAT before continuing to edit and sync.
