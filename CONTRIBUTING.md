# Contributing

Branch from `main`. Describe the changed behavior, expected results and checks run. Use a short lowercase commit title, such as `updated code`, `updated tests` or `updated readme`.

Language pages are in `en/` and `fr/`; code, styles and translations are in `assets/`; instrument source PDFs and diagrams are in `docs/`; verification code is in `scripts/` and `tests/`.

## Questionnaire changes

Read [instrument rights](NOTICE.md). Preserve wording, scoring keys and copyright notices. Support scoring changes with primary sources and synthetic regression cases. English STAI uses Forms X-1/X-2; French STAI uses Forms Y-1/Y-2 with different keys.

## Verification

Use Node.js 22.12 or later:

```sh
npm ci
npm run check:vendor
npm test
npm audit --audit-level=high
```

Check both languages and actual downloads. Use synthetic responses in tests, screenshots and reports.

GitHub Actions checks Node.js 22 and 24 before publishing `main` to GitHub Pages. Pull requests run checks without deploying. Run the workflow manually on `main` to verify and redeploy the current version.

`npm run prepare:site` creates the deployment's `_site/` directory with application pages, assets, license and instrument notices. It excludes source PDFs, tests, npm dependencies and report downloads.

For persistence changes, also check these behaviors:

- Submit with **Next** and confirm saving. Block writes and confirm visible failure with retry and JSON backup available. Unsupported browsers must advise keeping the tab open and downloading a backup.
- Restore unfinished and completed JSON backups in the matching language, after clearing existing saves. Unreadable or incompatible saves must remain available for original-data backup and explicit clearing.
- Open one session in two tabs. A write in one must block the other's stale write. Clearing must prevent old tabs from recreating responses, including previously unsaved answers.
- Complete, reload and reopen results. CSV, PDF and JSON downloads must preserve the save. Clearing the displayed save affects one language; **Clear app data** removes both. Failed final saves must retain answers for retry or download without claiming they are saved.

## Storage coordination

Responses use localStorage. A shared browser lock and IndexedDB coordination record check the expected revision and response hash before writes. Saving is confirmed only after the write is read back and the coordination transaction commits. Cached localStorage alone cannot establish the current revision.

Clearing advances a per-language epoch, even if no response write succeeded. Tabs check it before writing. IndexedDB retains storage keys, SHA-256 hashes, revisions and operation tokens; localStorage markers notify other tabs. This metadata contains no participant IDs or responses, has no automatic expiry and remains after clearing so older tabs can detect it.

## Pipeline diagram

The [Figma / FigJam board](https://www.figma.com/board/alZQw9y4qKnjlBXoksGf26) is a manual design reference, subject to its access settings. The README uses [editable SVG](docs/design/pipeline.svg); [Mermaid source](docs/design/pipeline.mmd) describes the FigJam overview. Import the SVG into Figma to edit its layout. Mermaid is not used at runtime.

Keep both sources consistent with the app, language configurations and deployment workflow. Check arrows, text wrapping and readability. Results must remain independent of successful saving. JSON restores sessions; CSV/PDF are reports. Imports preserve existing saves. Both verification jobs must pass before deployment; pull requests do not deploy.
