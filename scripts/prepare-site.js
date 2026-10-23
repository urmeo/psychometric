const fs = require("node:fs/promises");
const path = require("node:path");

async function prepareSite() {
  const root = path.join(__dirname, "..");
  const destination = path.join(root, "_site");
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination);
  for (const entry of ["index.html", "en", "fr", "assets", "LICENSE"]) {
    await fs.cp(path.join(root, entry), path.join(destination, entry), { recursive: true });
  }
  console.log("Prepared static-site files in _site/");
}

prepareSite().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
