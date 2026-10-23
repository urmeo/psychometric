const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const serveApplication = require("./test-server");

async function openPage(context, origin, lang) {
  const page = await context.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__TEST__ = {};
    window.auditAlerts = [];
    window.alert = (message) => window.auditAlerts.push(message);
    window.auditClockOffset = 0;
    const NativeDate = Date;
    window.Date = class AuditDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [NativeDate.now() + window.auditClockOffset])); }
      static now() { return NativeDate.now() + window.auditClockOffset; }
    };
  });
  await page.goto(origin + "/" + lang + "/index.html", { waitUntil: "domcontentloaded" });
  return page;
}

async function clockRollbackCase(context, origin, lang) {
  const page = await openPage(context, origin, lang);
  await page.evaluate(async () => {
    const C = window.CONFIG;
    document.querySelectorAll(".test-checkbox").forEach((box) => { box.checked = C.tests[Number(box.value)].name === "FQ"; });
    document.getElementById("nextBtn").click();
    await window.__TEST__.whenPersistenceSettled();
  });
  await page.waitForFunction(() => !document.getElementById("nextBtn").disabled, { polling: 50 });
  const before = await page.evaluate(() => localStorage.getItem(window.CONFIG.storageKey));
  await page.evaluate(() => {
    document.getElementById("option1").click();
    document.getElementById("question-description").value = "Preserve this current descriptive response: cœur 東京";
    window.auditClockOffset = -120000;
    document.getElementById("nextBtn").click();
  });
  const paused = await page.evaluate(() => {
    const T = window.__TEST__, C = window.CONFIG;
    const backup = T.buildProgressBackup();
    return {
      text: document.getElementById("persistence-status").textContent, expected: C.ui.clockChanged,
      answers: T.state.answers.length, cursor: T.state.currentQuestionIndex,
      raw: localStorage.getItem(C.storageKey), selected: document.getElementById("option1").checked,
      description: document.getElementById("question-description").value, backup: JSON.parse(backup),
      strictRejected: T.validateSession(JSON.parse(backup)) === null, alerts: window.auditAlerts,
      backupVisible: !document.getElementById("downloadBackup").classList.contains("hidden"),
      recordRejected: T.recordAnswer() === false,
    };
  });
  assert.equal(paused.text, paused.expected, `${lang}: clock correction explains why Next is paused`);
  assert.equal(paused.answers, 0, `${lang}: clock correction never records a negative-duration answer`);
  assert.equal(paused.cursor, 0, `${lang}: clock correction does not advance the question`);
  assert.equal(paused.raw, before, `${lang}: clock correction never replaces the recoverable saved prefix`);
  assert.equal(paused.selected, true, `${lang}: paused Next keeps the selected response`);
  assert.equal(paused.description, "Preserve this current descriptive response: cœur 東京", `${lang}: paused Next keeps descriptive text`);
  assert.equal(paused.backup.answers.length, 0, `${lang}: trusted backup remains available for submitted prefix`);
  assert.equal(paused.strictRejected, true, `${lang}: imports retain strict future-clock validation`);
  assert.equal(paused.backupVisible, true, `${lang}: paused Next offers JSON backup`);
  assert.equal(paused.recordRejected, true, `${lang}: direct recording also guards a corrected clock`);
  assert.deepEqual(paused.alerts, [], `${lang}: clock warning never becomes an answer-selection error`);

  await page.evaluate(async () => {
    window.auditClockOffset = 0;
    document.getElementById("nextBtn").click();
    await window.__TEST__.whenPersistenceSettled();
  });
  const resumed = await page.evaluate(() => ({
    answers: window.__TEST__.state.answers.length,
    raw: localStorage.getItem(window.CONFIG.storageKey),
    valid: !!window.__TEST__.validateSession(JSON.parse(localStorage.getItem(window.CONFIG.storageKey))),
    description: window.__TEST__.state.answers[0].description,
  }));
  assert.equal(resumed.answers, 1, `${lang}: corrected clock resumes the same response`);
  assert.equal(resumed.valid, true, `${lang}: corrected clock produces a resumable stored prefix`);
  assert.equal(resumed.description, paused.description, `${lang}: corrected clock submits original descriptive text`);
  await page.waitForFunction(() => !document.getElementById("nextBtn").disabled, { polling: 50 });

  // A snapshot that was valid when queued can become future-dated before its lock is acquired.
  await page.evaluate(() => new Promise((resolve) => {
    navigator.locks.request("psychometric-session-storage", () => new Promise((release) => {
      window.releaseAuditLock = release;
      resolve();
    }));
  }));
  await page.evaluate(() => {
    window.__TEST__.saveProgress();
    window.auditClockOffset = -120000;
    window.releaseAuditLock();
  });
  await page.evaluate(() => window.__TEST__.whenPersistenceSettled());
  const queued = await page.evaluate(() => ({
    raw: localStorage.getItem(window.CONFIG.storageKey),
    text: document.getElementById("persistence-status").textContent, expected: window.CONFIG.ui.clockChanged,
  }));
  assert.equal(queued.raw, resumed.raw, `${lang}: a queued snapshot is checked again after a clock correction`);
  assert.equal(queued.text, queued.expected, `${lang}: a queued future-dated snapshot never announces Saved`);

  // Loading another question after a clock change must preserve timing order.
  const later = await page.evaluate(() => {
    const T = window.__TEST__;
    window.auditClockOffset = -120000;
    T.loadTest(T.state.tests[0]);
    const last = T.state.answers[0];
    const backup = T.buildProgressBackup();
    document.getElementById("option0").click();
    document.getElementById("nextBtn").click();
    return {
      questionStart: T.state.questionStartTime.getTime(), previousAnswer: Date.parse(last.answerTime),
      backup: JSON.parse(backup), raw: localStorage.getItem(window.CONFIG.storageKey),
      answers: T.state.answers.length, selected: document.getElementById("option0").checked,
    };
  });
  assert.ok(later.questionStart >= later.previousAnswer, `${lang}: clock correction between questions preserves timestamp order`);
  assert.equal(later.backup.answers.length, 1, `${lang}: backup preserves previously submitted responses while the clock is behind`);
  assert.equal(later.backup.answers[0].description, paused.description, `${lang}: trusted backup preserves submitted descriptive text`);
  assert.equal(later.raw, resumed.raw, `${lang}: a second paused response cannot replace the saved prefix`);
  assert.equal(later.answers, 1, `${lang}: a second paused response stays unsubmitted`);
  assert.equal(later.selected, true, `${lang}: the second paused choice stays selected`);

  // Even an internally damaged in-progress snapshot must never be announced saved.
  const invalid = await page.evaluate(async () => {
    const T = window.__TEST__, C = window.CONFIG;
    window.auditClockOffset = 0;
    const duration = T.state.answers[0].time;
    T.state.answers[0].time = -1;
    const saved = await T.saveProgress();
    T.state.answers[0].time = duration;
    return { saved, raw: localStorage.getItem(C.storageKey), text: document.getElementById("persistence-status").textContent, expected: C.ui.progressSaveFailed };
  });
  assert.equal(invalid.saved, false, `${lang}: invalid in-progress snapshot fails before writing`);
  assert.equal(invalid.raw, resumed.raw, `${lang}: invalid in-progress snapshot preserves the stored prefix`);
  assert.equal(invalid.text, invalid.expected, `${lang}: invalid in-progress snapshot reports a save failure`);

  await page.evaluate(async () => {
    document.getElementById("nextBtn").click();
    await window.__TEST__.whenPersistenceSettled();
  });
  const continued = await page.evaluate(() => ({
    answers: window.__TEST__.state.answers.length,
    valid: !!window.__TEST__.validateSession(JSON.parse(localStorage.getItem(window.CONFIG.storageKey))),
    backupValid: !!window.__TEST__.validateSession(JSON.parse(window.__TEST__.buildProgressBackup())),
  }));
  assert.equal(continued.answers, 2, `${lang}: response submission continues after correcting the clock`);
  assert.equal(continued.valid, true, `${lang}: continued autosave remains valid`);
  assert.equal(continued.backupValid, true, `${lang}: backup becomes importable after correcting the clock`);
  await page.close();
}

async function deniedDownloadCase(context, origin, lang, directory) {
  const page = await openPage(context, origin, lang);
  await page.evaluate(async () => {
    const T = window.__TEST__, C = window.CONFIG;
    await T.clearAllData();
    await T.resetAuthorityForFixture(C.storageKey);
    const test = C.tests.find((item) => item.name === "HADS");
    const start = Date.now() - 600000;
    const saved = {
      version: 1, lang: C.lang, revision: C.revision, configSignature: T.configSignature(),
      participantId: "denied download", selectedTestNames: [test.name], currentTestIndex: 0,
      currentQuestionIndex: test.questions.length - 1, testStartTime: new Date(start).toISOString(),
      answers: test.questions.slice(0, -1).map((question, index) => ({
        test: test.name, questionIndex: index + 1, optionIndex: 0, question: question.q,
        answer: question.options[0], score: question.scores[0], description: "", time: 1,
        questionStartTime: new Date(start + index * 1000).toISOString(),
        answerTime: new Date(start + (index + 1) * 1000).toISOString(),
      })),
    };
    localStorage.setItem(C.storageKey, JSON.stringify(saved));
    T.showResumeScreen(saved);
    document.getElementById("resumeBtn").click();
    await T.whenPersistenceSettled();
    const set = Storage.prototype.setItem;
    window.restoreAuditStorage = () => { Storage.prototype.setItem = set; };
    Storage.prototype.setItem = function (key) {
      if (this === localStorage && key === C.storageKey) throw new DOMException("Quota exhausted", "QuotaExceededError");
      return set.apply(this, arguments);
    };
    document.getElementById("option0").click();
    document.getElementById("nextBtn").click();
    await T.whenPersistenceSettled();
  });
  for (const selector of ["#downloadBackup", "#downloadCsv", "#downloadPdf"]) {
    await page.bringToFront();
    await page.locator(selector).click();
    const guarded = await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return { prevented: event.defaultPrevented, alerts: window.auditAlerts, answers: window.__TEST__.state.answers.length, savedAnswers: JSON.parse(localStorage.getItem(window.CONFIG.storageKey)).answers.length };
    });
    assert.equal(guarded.prevented, true, `${lang}: browser-denied ${selector} never suppresses the unsaved-results close warning`);
    assert.deepEqual(guarded.alerts, [], `${lang}: download denial is silent to page JavaScript`);
    assert.equal(guarded.answers, 14, `${lang}: download denial keeps all completed responses in memory`);
    assert.equal(guarded.savedAnswers, 13, `${lang}: the saved draft alone cannot recover the final response`);
  }
  assert.deepEqual(await fs.readdir(directory), [], `${lang}: the browser saved none of the denied download requests`);
  const rolledBackCompletion = await page.evaluate(async () => {
    const T = window.__TEST__;
    const completedAt = T.state.testEndTime.toISOString();
    window.auditClockOffset = -120000;
    const saved = await T.saveProgress();
    const backup = JSON.parse(T.buildProgressBackup());
    const strictRejected = T.validateSession(backup) === null;
    return {
      backup, completedAt, strictRejected, saved,
      text: document.getElementById("persistence-status").textContent, expected: window.CONFIG.ui.clockChanged,
      retryVisible: !document.getElementById("retrySave").classList.contains("hidden"),
      nextHidden: document.getElementById("nextBtn").classList.contains("hidden"),
    };
  });
  assert.equal(rolledBackCompletion.backup.answers.length, 14, `${lang}: completed backup remains available after a clock correction`);
  assert.equal(rolledBackCompletion.backup.testEndTime, rolledBackCompletion.completedAt, `${lang}: trusted completed backup preserves the original completion timestamp`);
  assert.equal(rolledBackCompletion.strictRejected, true, `${lang}: completed imports keep strict clock validation`);
  assert.equal(rolledBackCompletion.saved, false, `${lang}: completed autosave rejects a corrected clock without changing its timestamps`);
  assert.equal(rolledBackCompletion.text, rolledBackCompletion.expected, `${lang}: completed results explain the clock correction`);
  assert.equal(rolledBackCompletion.nextHidden, true, `${lang}: completed results have no Next control`);
  assert.equal(rolledBackCompletion.retryVisible, true, `${lang}: completed clock recovery offers an actionable saving retry`);
  await page.evaluate(() => { window.auditClockOffset = 0; window.restoreAuditStorage(); });
  await page.bringToFront();
  await page.locator("#retrySave").click();
  await page.evaluate(() => window.__TEST__.whenPersistenceSettled());
  const recovered = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return { prevented: event.defaultPrevented, status: JSON.parse(localStorage.getItem(window.CONFIG.storageKey)).status };
  });
  assert.equal(recovered.status, "completed", `${lang}: storage retry saves the completed record`);
  assert.equal(recovered.prevented, false, `${lang}: verified completed recovery permits closing`);
  await page.close();
}

module.exports = async function runBoundaryRegressions(browser) {
  const { server, origin } = await serveApplication();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "psychometric-denied-download-"));
  const context = await browser.createBrowserContext({ downloadBehavior: { policy: "deny", downloadPath: directory } });
  try {
    console.log("\n--- Clock correction and denied-download recovery regressions ---");
    for (const lang of ["en", "fr"]) {
      await clockRollbackCase(context, origin, lang);
      await deniedDownloadCase(context, origin, lang, directory);
      console.log(`  ${lang}: clock changes pause without losing input, valid prefixes retain backup recovery, and denied JSON/CSV/PDF requests preserve the close warning.`);
    }
    return 0;
  } catch (error) {
    console.error("  Boundary regression failed:", error.stack);
    return 1;
  } finally {
    await context.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
};
