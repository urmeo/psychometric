const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules/jspdf/dist/jspdf.umd.min.js");
const bundled = path.join(root, "assets/vendor/jspdf.umd.min.js");

try {
  if (!fs.readFileSync(source).equals(fs.readFileSync(bundled))) {
    throw new Error("Bundled jsPDF differs from the locked package; copy its dist file to assets/vendor/.");
  }
  console.log("Bundled jsPDF matches the locked package.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
