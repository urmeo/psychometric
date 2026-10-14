const puppeteer = require("puppeteer");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const assert = require("node:assert/strict");

const TEST_FILES = [
  { file: "tests/test-scoring.html", label: "English" },
  { file: "tests/test-scoring-fr.html", label: "French" },
];

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const value = text[i];
    if (value === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (value === "," && !quoted) { row.push(field); field = ""; }
    else if ((value === "\r" || value === "\n") && !quoted) {
      row.push(field); rows.push(row); row = []; field = "";
      if (value === "\r" && text[i + 1] === "\n") i++;
    } else field += value;
  }
  assert.equal(quoted, false, "downloaded CSV has balanced quoting");
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function waitForDownload(directory, filename) {
  const target = path.join(directory, filename);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const bytes = await fs.readFile(target);
      if (bytes.length > 0) return bytes;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`download did not finish: ${filename}`);
}

function pdfText(stream) {
  const strings = [];
  for (const match of stream.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) {
    strings.push(match[1].replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, escaped) => {
      const controls = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (controls[escaped]) return controls[escaped];
      if (/^[0-7]/.test(escaped)) {
        return new TextDecoder("windows-1252").decode(Uint8Array.of(parseInt(escaped, 8)));
      }
      return escaped;
    }));
  }
  return strings;
}

async function verifyActualDownloads(page, directory) {
  const expected = await page.evaluate(() => window.__TEST__.prepareDownloadFixture());
  await page.locator("#downloadCsv").click();
  const csv = await waitForDownload(directory, expected.filenames.csvFilename);
  assert.deepEqual([...csv.subarray(0, 3)], [0xEF, 0xBB, 0xBF], "actual CSV has UTF-8 BOM");
  const rows = parseCSV(csv.toString("utf8"));
  const metadata = (label) => rows.find((row) => row[0] === label);
  assert.equal(metadata(expected.ui.csvLanguage)?.[1], expected.lang, "actual CSV locale");
  assert.equal(metadata(expected.ui.csvRevision)?.[1], expected.revision, "actual CSV revision");
  assert.equal(metadata(expected.ui.csvStarted)?.[1], expected.started, "actual CSV assessment start");
  assert.equal(metadata(expected.ui.csvCompleted)?.[1], expected.completed, "actual CSV assessment end");
  assert.equal(metadata(expected.ui.csvParticipant)?.[1], "'" + expected.participant, "actual CSV safe participant ID");
  assert.equal(metadata(expected.ui.csvDisclaimer)?.[1], expected.ui.disclaimer, "actual CSV disclaimer");
  const detailIndex = rows.findIndex((row) => row.join(",") === expected.ui.csvHeaders);
  assert.ok(detailIndex >= 0, "actual CSV has localized detail headers");
  const details = rows.slice(detailIndex + 1).filter((row) => row.length === 10);
  assert.equal(details.length, 88, "actual CSV has every response");
  const ids = details.map((row) => `${row[0]}:${row[1]}`);
  assert.equal(new Set(ids).size, 88, "actual CSV item IDs are unique");
  assert.deepEqual(ids, expected.answers.map((answer) => `${answer.test}:${answer.questionIndex}`));
  details.forEach((row, index) => {
    const answer = expected.answers[index];
    assert.equal(row[2], String(answer.optionIndex), "actual CSV option ID");
    assert.equal(row[3], answer.question, "actual CSV complete item wording");
    assert.equal(row[4], answer.answer, "actual CSV response text");
    assert.equal(row[6], String(answer.score), "actual CSV keyed score");
  });
  assert.equal(details.find((row) => row[0] === "FQ" && row[1] === "1")[5], expected.description, "actual CSV full descriptive response");
  for (const [name, instrument] of Object.entries(expected.metadata)) {
    for (const [label, key] of [[expected.ui.csvForm, "form"], [expected.ui.csvSource, "source"], [expected.ui.csvNotice, "notice"]]) {
      assert.ok(rows.some((row) => row[0] === label && row[1] === name && row[2] === instrument[key]), `actual CSV ${name} ${key}`);
    }
  }

  await page.locator("#downloadPdf").click();
  const pdf = await waitForDownload(directory, expected.filenames.pdfFilename);
  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-", "actual PDF header");
  assert.ok(pdf.toString("latin1").trimEnd().endsWith("%%EOF"), "actual PDF is complete");
  assert.ok(pdf.length > 1000, "actual PDF has content");
  assert.equal(pdf.includes(0), false, "actual PDF has no NUL-corrupted text");
  const decoded = new TextDecoder("windows-1252").decode(pdf);
  const pages = [...decoded.matchAll(/\/Type \/Page\b/g)].length;
  const streams = [...decoded.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((match) => pdfText(match[1]));
  assert.equal(streams.length, pages, "actual PDF page content is readable");
  assert.ok(pages > 1, "actual PDF paginates all responses");
  const strings = streams.flat();
  const itemHeaders = strings.filter((text) => text.startsWith(expected.ui.pdfTest + " ") && text.includes(" | " + expected.ui.pdfQuestion + " "));
  assert.equal(itemHeaders.length, 88, "actual PDF has all item headers");
  assert.equal(new Set(itemHeaders).size, 88, "actual PDF item identities are unique");
  for (const answer of expected.answers) {
    assert.ok(itemHeaders.includes(`${expected.ui.pdfTest} ${answer.test} | ${expected.ui.pdfQuestion} ${answer.questionIndex}`), "actual PDF stable item identity");
  }
  const notice = expected.metadata["STAI-S"].notice.replace(/\s+/g, " ");
  streams.forEach((items) => assert.ok(items.join(" ").replace(/\s+/g, " ").includes(notice), "actual PDF carries STAI notice on every page"));
  assert.ok(strings.join(" ").includes("cœur"), "actual PDF preserves the French ligature");
  console.log(`  Actual downloads: CSV 88 unique responses; PDF ${pages} pages, 88 unique items, notices intact.`);
}

async function runTestFile(browser, { file, label }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "psychometric-download-"));
  const context = await browser.createBrowserContext({
    downloadBehavior: { policy: "allow", downloadPath: directory },
  });
  try {
    const page = await context.newPage();
    let pageErrors = 0;
    page.on("pageerror", (error) => {
      pageErrors++;
      console.error(`  Page error: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") console.error(`  Console error: ${message.text()}`);
    });
    console.log(`\n--- ${label} tests (${file}) ---`);
    await page.goto(`file://${path.resolve(__dirname, "..", file)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#test-results h2", { timeout: 15000 });
    const results = await page.evaluate(() => {
      const h2 = document.querySelector("#test-results h2");
      const tests = [...document.querySelectorAll("#test-results table tbody tr")].map((row) => ({
        name: row.cells[1].textContent.trim(),
        passed: row.cells[0].classList.contains("interp-normal"),
      }));
      return { summary: h2 ? h2.textContent.trim() : "", tests };
    });
    console.log(`  ${results.summary}`);
    const parsed = results.summary.match(/(\d+) passed, (\d+) failed/);
    if (!parsed) throw new Error("could not parse the results summary");
    const declared = { passed: +parsed[1], failed: +parsed[2] };
    if (declared.passed + declared.failed === 0) throw new Error("no assertions ran");
    if (results.tests.length !== declared.passed + declared.failed) throw new Error(`scraped ${results.tests.length} rows but summary declares ${declared.passed + declared.failed}`);
    const failures = results.tests.filter((test) => !test.passed);
    failures.forEach((test) => console.log(`  FAIL: ${test.name}`));
    if (failures.length !== declared.failed) throw new Error("row status disagrees with summary");
    if (failures.length) return failures.length + pageErrors;
    await verifyActualDownloads(page, directory);
    if (pageErrors) throw new Error(`${pageErrors} uncaught page errors`);
    return 0;
  } catch (error) {
    console.error(`  ${label} error: ${error.message}`);
    return 1;
  } finally {
    await context.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    let totalFailed = 0;
    for (const testFile of TEST_FILES) totalFailed += await runTestFile(browser, testFile);
    totalFailed += await require("./test-persistence")(browser);
    totalFailed += await require("./test-review-regressions")(browser);
    totalFailed += await require("./test-boundary-regressions")(browser);
    await browser.close();
    console.log(totalFailed === 0 ? "\nAll tests and actual downloads passed." : `\n${totalFailed} test/download gates failed.`);
    process.exit(totalFailed === 0 ? 0 : 1);
  } catch (error) {
    console.error("Test runner error:", error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
})();
