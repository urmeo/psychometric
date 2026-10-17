# Security

Submitted responses and participant IDs can be stored in browser localStorage and downloaded reports or backups; they are not uploaded. Hosting receives ordinary page and asset requests. Use coded participant IDs.

Saves have no automatic expiry and remain after export. **Clear app data** ends the session and removes both language saves; other clear controls remove the displayed language's save. Downloads remain on disk. Response-free coordination metadata stays in localStorage and IndexedDB so older tabs can detect clearing. Browser settings can remove all this site's storage.

Browser storage can fail or be cleared. Check the saving status and keep a separate JSON backup when needed. A requested download does not confirm that the file was saved.

Only the current `main` branch is supported. [Report a vulnerability privately](https://github.com/urmeo/psychometric/security/advisories/new) with the revision, browser, steps to reproduce and impact. Use synthetic responses and omit real participant data.
