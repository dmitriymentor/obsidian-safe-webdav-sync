Pressing Sync now opens live progress even when an automatic run is already
active. It attaches to the current run and does not start a second sync.

The window shows the phase, scanned folder count, processed files, current file,
elapsed time, and final result or error. It can be closed and reopened during
the same run. Server discovery uses an indeterminate indicator; 100% appears
only when the run finishes. The installed version is visible in plugin settings.

The 0.1.4 merge policy and backups are unchanged. This update does not add
automatic legacy repair or arbitrary duplicate-line removal.

Validation: 20 passing tests, including background-run attachment, reopening,
progress completion and error display; TypeScript check and production build.

Update through BRAT and reload Obsidian to activate version 0.1.5.
