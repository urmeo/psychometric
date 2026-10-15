# Project pipeline

The diagram covers app use, browser saving and recovery, and design through deployment. It describes the current implementation; Figma is a manual design reference.

- [Figma / FigJam board](https://www.figma.com/board/alZQw9y4qKnjlBXoksGf26): editable flowchart, subject to the board's access settings.
- [pipeline.svg](pipeline.svg): the README diagram, with editable text and vector shapes. Import it into a Figma design file to edit the layout.
- [pipeline.mmd](pipeline.mmd): Mermaid source for the FigJam overview. The app does not use Mermaid at runtime.

Keep both diagram sources consistent with [app.js](../../assets/js/app.js), the [language configurations](../../assets/lang/) and the [verification and deployment workflow](../../.github/workflows/test.yml). Check arrow directions, text wrapping and readability after edits.

Submitted responses can produce results even when autosave fails. JSON restores unfinished or completed sessions; CSV and PDF are reports. Imports do not replace an existing browser save. Both Node.js verification jobs must pass before `main` deploys; pull requests do not deploy.
