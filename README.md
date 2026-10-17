# Psychometric

Psychometric runs five questionnaires in English or French, with 88 items in total. Choose questionnaires, submit answers, then view scores and download a CSV or PDF report. Scoring runs in the browser. Responses are not uploaded.

![Project pipeline: app use, saving and recovery, and design through tested deployment](docs/design/pipeline.svg)

[Open in Figma / FigJam](https://www.figma.com/board/alZQw9y4qKnjlBXoksGf26) · [SVG diagram](docs/design/pipeline.svg) · [Diagram source](docs/design/pipeline.mmd)

The rows show app use, saving and recovery, and design through verified deployment.

## Run the app

Use the [hosted app](https://urmeo.github.io/psychometric/), or download this repository and open `index.html`. No installation, build or server is required. Automatic saving depends on browser support and storage access; check its status before closing the tab.

1. Choose a language and questionnaires. The participant ID is optional; use a code rather than a name.
2. Submit each answer with **Next**. The current option or description remains unsaved until then.
3. View scores and download a report. Download a JSON backup to restore the session later.

Scores do not establish a diagnosis. HADS provides screening bands; BFI-10 describes traits relative to the scale midpoint. STAI and FQ report raw scores without severity bands.

## Questionnaires

| Instrument | Items | Output |
|:-----------|------:|:-------|
| HADS | 14 | Anxiety and depression: 0–21 each, with screening bands |
| STAI-S | 20 | State anxiety: 20–80 |
| STAI-T | 20 | Trait anxiety: 20–80 |
| BFI-10 | 10 | Five trait means: 1–5 each |
| FQ | 24 | Total phobia: 0–120; three phobia subscales and associated anxiety/depression: 0–40 each; main and global phobia ratings: 0–8 each |

English STAI uses Forms X-1/X-2. French STAI uses Forms Y-1/Y-2, with different scoring keys. The French BFI-10 follows [Courtois et al. (2020)](https://www.em-consulte.com/article/1361431). The [instrument rights and source notes](NOTICE.md) cover permissions and the FQ scoring convention.

Results show charts with each score's possible range and a table of exact values and interpretations. Chart positions are not percentiles.

CSV and PDF reports include submitted responses, optional FQ descriptions, scores, forms, revision and timestamps. PDF cannot represent every character; UTF-8 CSV retains unsupported characters.

## Saving and recovery

Saved answers can be reopened as unfinished sessions or completed results after a reload. A **saved** status confirms that the browser write was read back and its coordination record committed. Automatic saving requires browser locks, IndexedDB and hashing support. If it fails, is unavailable or conflicts with another tab, keep the tab open and download a JSON backup before leaving or reloading. A requested download does not confirm that the file was saved.

Each language has one browser save. A conflicting tab stops writing and keeps its answers available for backup. Clearing prevents older tabs from recreating responses, including answers that could not be saved.

JSON backups contain the participant ID and submitted responses. Restore unfinished or completed sessions from setup in the same language and questionnaire configuration. Imports are validated and do not replace existing saves: resume, view or explicitly clear that save first. CSV and PDF reports cannot restore sessions.

Unreadable or incompatible saves remain unchanged; download their original data before clearing. A matching questionnaire configuration or corrected device clock may allow recovery; damaged data may need repair. Submission pauses if the device clock moves backwards, until it is corrected.

Browser saves contain sensitive responses, have no automatic expiry and remain after download. **Clear app data** ends the session and removes both language saves; other clear controls remove the displayed language's save. Failed or unverified deletion is reported. Clearing leaves downloaded files and coordination metadata, which contains no participant IDs or responses. Browser settings can remove all this site's storage; browsers may also clear it independently. Keep a separate backup when the data matters.

<img src="outputs/setup.jpg" alt="English setup with questionnaire selections and storage controls" width="960">
<img src="outputs/results.jpg" alt="English results from synthetic responses, with questionnaire charts, exact score table and download controls" width="960">

[View the French results example](outputs/results-fr.jpg).

## Development

The app uses HTML, CSS, vanilla JavaScript, Bootstrap and jsPDF, with bundled libraries in `assets/vendor/`. Verification requires Node.js 22.12 or later. [CONTRIBUTING.md](CONTRIBUTING.md) has verification commands, file locations and editing guidance.

Puppeteer tests scoring, persistence, recovery and actual CSV/PDF downloads in both languages. A vendor check compares bundled jsPDF with its locked package. GitHub Actions checks Node.js 22 and 24 before deploying `main` to GitHub Pages.

## License and references

[MIT](LICENSE) covers the software, not questionnaire rights. STAI and HADS require permission; see [NOTICE.md](NOTICE.md) before use.

| Instrument | Source |
|---|---|
| HADS | [Snaith (2003)](https://link.springer.com/article/10.1186/1477-7525-1-29) |
| STAI | [Mind Garden, instrument and forms](https://www.mindgarden.com/145-state-trait-anxiety-inventory-for-adults) |
| BFI-10 | [Rammstedt & John (2007)](https://www.sciencedirect.com/science/article/pii/S0092656606000195) |
| FQ | [Marks & Mathews (1979)](https://www.sciencedirect.com/science/article/pii/000579677990041X) |
