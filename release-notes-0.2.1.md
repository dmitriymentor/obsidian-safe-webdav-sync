Version 0.2.1 cleans old nested conflict blocks before syncing, including saved
common bases from earlier clients. Update every device, restart Obsidian, then
run sync to completion. The result includes the number of cleaned notes.

Preserved branch dates select the newer version (equal dates prefer the server).
Ambiguous/incomplete unequal conflicts stop that note with a visible error.
The narrow orphaned-ending case is repaired only for complete documents with
identical text and metadata apart from updated. Normal repeated lines are not
globally deduplicated. Generated redundant metadata shells are collapsed.

Originals are retained in verified, grouped local and encrypted remote backups.
Repair uses conditional writes and a final server read; concurrent edits or
pending deletions stop the repair. Deletion-journal behavior is unchanged.

Validation: 45 passing tests, including nested/partial conflicts, stale mobile
bases, legitimate repeats, dry runs, pending deletions and concurrent server
changes; TypeScript and production build checks.
