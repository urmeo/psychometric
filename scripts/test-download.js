const fs = require("node:fs/promises");
const path = require("node:path");

module.exports = async function waitForDownload(directory, filename) {
  const target = path.join(directory, filename);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const bytes = await fs.readFile(target);
      if (bytes.length) return { bytes, target };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Download did not finish: ${filename}`);
};
