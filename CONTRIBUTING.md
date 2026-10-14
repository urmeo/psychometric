# Contributing

Branch from `main` and describe the behavior changed, expected results and checks run. Use a short lowercase commit title, such as `updated scoring`. Read [instrument rights](NOTICE.md) before changing questionnaire content.

## Questionnaire changes

Preserve instrument wording, scoring keys and copyright notices. Use primary sources for scoring changes and add a regression with synthetic responses. English STAI uses Forms X-1/X-2; French STAI uses Forms Y-1/Y-2 with different keys.

## Verification

Use Node.js 22.12 or later:

```sh
npm ci
npm run check:vendor
npm test
npm audit --audit-level=high
```

Check both languages and actual downloads. Use synthetic responses in tests, screenshots and reports.

GitHub Actions runs these checks on Node.js 22 and 24. After both pass on `main`, it publishes the app to GitHub Pages. Pull requests run checks without deploying. The workflow can also be run manually on `main` to verify and redeploy the current version.

`npm run prepare:site` creates a fresh `_site/` directory with the application pages, assets, software license and instrument notices. The deployment uploads that directory. Source PDFs, test code, npm dependencies and report downloads are excluded.

For persistence changes, also check these behaviors:

- Submit an answer with **Next** and confirm the saved status. Block writes, submit another answer, and confirm that saving fails visibly while retry and JSON backup remain available. A browser without safe saving support must direct the participant to keep the tab open and download a backup.
- Restore unfinished and completed JSON backups in the matching language after clearing any existing save. Unreadable or incompatible saves must remain available for original-data backup and explicit clearing.
- Open the same saved session in two tabs. A write in one tab must prevent the other from overwriting that revision. Clearing must prevent old tabs from recreating responses, even when their writes previously failed.
- Complete a session, reload and reopen the results. CSV, PDF and JSON downloads must leave the browser save intact. Clearing the displayed save affects one language; **Clear app data** removes both. A failed final save must leave the open tab's answers available for retry or download without reporting them as saved.

## Storage coordination

Responses are stored in localStorage. Writes use a shared browser lock and an IndexedDB coordination record to check the expected revision and response hash. A save is confirmed only after the response write is read back and the coordination transaction commits. A tab's cached localStorage value alone is insufficient to establish the current revision.

Clearing advances a per-language epoch, including when no response write succeeded. Other tabs check that epoch before writing. IndexedDB retains storage keys, SHA-256 hashes, revisions and operation tokens; localStorage markers notify other tabs. This metadata contains no participant IDs or responses, has no automatic expiry and remains after response clearing so older tabs can detect the clear.
