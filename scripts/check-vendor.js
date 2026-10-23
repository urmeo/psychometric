const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules/jspdf/dist/jspdf.umd.min.js");
const bundled = path.join(root, "assets/vendor/jspdf.umd.min.js");

try {
  if (!fs.readFileSync(source).equals(fs.readFileSync(bundled))) {
    throw new Error("Bundled jsPDF differs from the installed package; check the version before updating assets/vendor/.");
  }
  console.log("Bundled jsPDF matches the installed package.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
