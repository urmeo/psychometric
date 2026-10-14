# Security

The app does not upload responses or participant IDs. Hosting receives ordinary page and asset requests. Submitted responses and IDs are stored in this browser's localStorage and included in downloaded reports or backups. Use coded participant IDs.

Browser saves have no automatic expiry and remain after export. **Clear app data** ends the current session and removes both language saves. Other clear controls remove the displayed language's save. Downloads remain on disk. Response-free coordination metadata stays in localStorage and IndexedDB so older tabs can detect clearing. Clear this site's data in browser settings to remove all its browser storage.

Browser storage can fail or be cleared. Check the saving status and keep a separate JSON backup when needed. A requested download does not confirm that the file was saved.

Only the current `main` branch is supported. [Report a vulnerability privately](https://github.com/urmeo/psychometric/security/advisories/new) with the revision, browser, steps to reproduce and impact. Use synthetic responses and omit real participant data.
