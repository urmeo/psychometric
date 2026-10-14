const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const serveApplication = require("./test-server");

const STORAGE_LOCK = "psychometric-session-storage";

async function openPage(context, origin, lang, options = {}) {
  const page = await context.newPage();
  await page.evaluateOnNewDocument((ignoreStorageEvents) => {
    window.__TEST__ = {};
    window.testAlerts = [];
    window.alert = (message) => window.testAlerts.push(message);
    if (ignoreStorageEvents) window.addEventListener("storage", (event) => event.stopImmediatePropagation(), true);
  }, !!options.ignoreStorageEvents);
  await page.goto(origin + "/" + lang + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#participantIdInput, #resumeBtn, #downloadStoredBackup");
  return page;
}

async function settled(page) {
  await page.evaluate(() => window.__TEST__.whenPersistenceSettled());
}

async function start(page, participant = "persistence fixture") {
  await page.evaluate((participantId) => {
    document.getElementById("participantIdInput").value = participantId;
    document.querySelectorAll(".test-checkbox").forEach((box) => {
      box.checked = window.CONFIG.tests[Number(box.value)].name === "HADS";
    });
    document.getElementById("nextBtn").click();
  }, participant);
  await settled(page);
}

// Native clicks wait for layout observers, so foreground the participant tab first.
async function click(page, selector) {
  await page.bringToFront();
  await page.locator(selector).click();
}

async function answer(page, option = 0) {
  await page.bringToFront();
  await page.waitForFunction(() => {
    const next = document.getElementById("nextBtn");
    return !next.disabled && document.getElementById("option0");
  }, { polling: 50 });
  await click(page, "#option" + option);
  await click(page, "#nextBtn");
  await settled(page);
}

async function status(page) {
  return page.evaluate(() => {
    const T = window.__TEST__, C = window.CONFIG;
    const node = document.getElementById("persistence-status");
    return {
      text: node ? node.textContent : "",
      statusRole: node ? node.getAttribute("role") : null,
      expected: C.ui,
      answers: T.state.answers,
      cursor: T.state.currentQuestionIndex,
      active: T.state.testInProgress,
      completed: !!T.state.testEndTime,
      nextDisabled: document.getElementById("nextBtn").disabled,
      raw: localStorage.getItem(C.storageKey),
      backup: T.state.testInProgress || T.state.testEndTime ? JSON.parse(T.buildProgressBackup()) : null,
    };
  });
}

async function injectWriteFailure(page, mode) {
  await page.evaluate((failure) => {
    const originalSet = Storage.prototype.setItem;
    const originalGet = Storage.prototype.getItem;
    let writeAttempted = false;
    window.testStorageWriteAttempts = 0;
    window.restoreTestStorage = () => {
      Storage.prototype.setItem = originalSet;
      Storage.prototype.getItem = originalGet;
    };
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === window.CONFIG.storageKey) {
        writeAttempted = true;
        window.testStorageWriteAttempts++;
        if (failure === "throw") throw new DOMException("Quota exhausted", "QuotaExceededError");
        if (failure === "no-op") return;
      }
      return originalSet.apply(this, arguments);
    };
    Storage.prototype.getItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey && (failure === "pre-read" || writeAttempted && failure === "verify-read")) {
        throw new DOMException("Storage blocked", "SecurityError");
      }
      return originalGet.apply(this, arguments);
    };
  }, mode);
}

async function writeFailureCases(context, origin, lang) {
  for (const mode of ["throw", "no-op", "pre-read", "verify-read"]) {
    const page = await openPage(context, origin, lang);
    await page.evaluate(() => window.__TEST__.clearAllData());
    await start(page);
    const before = await status(page);
    assert.equal(before.text, before.expected.progressSaved, `${lang}: initial save verified`);
    assert.equal(before.statusRole, "status", `${lang}: persistence updates use an accessible live status`);
    await injectWriteFailure(page, mode);
    await answer(page, 1);
    const failure = await page.evaluate(() => ({
      text: document.getElementById("persistence-status").textContent,
      expected: window.CONFIG.ui.progressSaveFailed,
      answers: window.__TEST__.state.answers.length,
      writeAttempts: window.testStorageWriteAttempts,
      backup: window.__TEST__.buildProgressBackup(),
      backupVisible: !document.getElementById("downloadBackup").classList.contains("hidden"),
      retryVisible: !document.getElementById("retrySave").classList.contains("hidden"),
      scoringRejected: (() => { try { window.__TEST__.calculateSummaryScores(); return false; } catch (error) { return true; } })(),
    }));
    assert.equal(failure.text, failure.expected, `${lang}: ${mode} is reported as unsaved`);
    assert.equal(failure.answers, 1, `${lang}: ${mode} preserves the participant's response`);
    if (mode === "pre-read") assert.equal(failure.writeAttempts, 0, `${lang}: denied prerequisite read prevents all writes`);
    assert.equal(JSON.parse(failure.backup).answers.length, 1, `${lang}: ${mode} backup contains unsaved response`);
    assert.equal(failure.backupVisible, true, `${lang}: ${mode} backup action offered`);
    assert.equal(failure.retryVisible, true, `${lang}: ${mode} retry action offered`);
    assert.equal(failure.scoringRejected, true, `${lang}: incomplete backup never becomes a scored result`);
    await page.evaluate(() => window.restoreTestStorage());
    if (mode === "verify-read") {
      // The write landed. A subsequent denied write must not lose ownership of that read-back revision.
      await injectWriteFailure(page, "throw");
      await click(page, "#retrySave");
      await settled(page);
      const retryFailure = await status(page);
      assert.equal(retryFailure.text, retryFailure.expected.progressSaveFailed, `${lang}: retry write denial remains an explicit save failure`);
      assert.equal(JSON.parse(retryFailure.raw).answers.length, 1, `${lang}: retry write denial preserves this tab's earlier unverified write`);
      await page.evaluate(() => window.restoreTestStorage());
      await click(page, "#retrySave");
      await settled(page);
      const retried = await status(page);
      assert.equal(retried.text, retried.expected.progressSaved, `${lang}: retry confirms this tab's previously unverified write`);
      assert.equal(JSON.parse(retried.raw).answers.length, 1);
    } else {
      await click(page, "#retrySave");
      await settled(page);
      const retried = await status(page);
      assert.equal(retried.text, retried.expected.progressSaved, `${lang}: retry confirms recovered persistence`);
      assert.equal(JSON.parse(retried.raw).answers.length, 1, `${lang}: retry saves unsaved response`);
    }
    await page.evaluate(() => window.__TEST__.clearAllData());
    await page.close();
  }
}

async function waitForDownload(directory, filename) {
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
}

async function backupCases(context, origin, lang, directory) {
  const page = await openPage(context, origin, lang);
  await page.evaluate(() => window.__TEST__.clearAllData());
  await start(page, "participant cœur 東京 🙂");
  await injectWriteFailure(page, "throw");
  await answer(page, 2);
  const expected = await page.evaluate(() => ({ filename: window.CONFIG.export.backupFilename, text: window.__TEST__.buildProgressBackup() }));
  const exportFailure = await page.evaluate(() => {
    const create = URL.createObjectURL;
    URL.createObjectURL = () => { throw new Error("Download blocked"); };
    let success;
    try { success = window.__TEST__.generateProgressBackup(); }
    finally { URL.createObjectURL = create; }
    return { success, alerts: window.testAlerts, expected: window.CONFIG.ui.backupDownloadFailed };
  });
  assert.equal(exportFailure.success, false, `${lang}: failed backup download never reports success`);
  assert.ok(exportFailure.alerts.includes(exportFailure.expected), `${lang}: failed backup download offers localized feedback`);
  await click(page, "#downloadBackup");
  const download = await waitForDownload(directory, expected.filename);
  const downloadedBackup = JSON.parse(download.bytes.toString("utf8"));
  const expectedBackup = JSON.parse(expected.text);
  assert.ok(Number.isFinite(Date.parse(downloadedBackup.generatedAt)), `${lang}: backup records generation time`);
  delete downloadedBackup.generatedAt;
  delete expectedBackup.generatedAt;
  assert.deepEqual(downloadedBackup, expectedBackup, `${lang}: actual backup download preserves complete unsaved prefix`);
  const valid = await page.evaluate((text) => !!window.__TEST__.validateSession(JSON.parse(text)), download.bytes.toString("utf8"));
  assert.equal(valid, true, `${lang}: downloaded backup is resumable and validated`);
  await page.evaluate(() => window.restoreTestStorage());
  await page.evaluate(() => window.__TEST__.clearAllData());
  await page.reload({ waitUntil: "domcontentloaded" });
  const input = await page.$("#restoreBackupInput");
  assert.ok(input, `${lang}: setup offers backup restoration`);
  await input.uploadFile(download.target);
  await page.waitForFunction(() => window.__TEST__.state.testInProgress, { polling: 50 });
  await settled(page);
  const restored = await status(page);
  assert.equal(restored.answers.length, 1, `${lang}: backup import restores cursor and answer`);
  assert.equal(restored.cursor, 1, `${lang}: backup import resumes next item`);
  assert.equal(restored.backup.participantId, "participant cœur 東京 🙂", `${lang}: backup import preserves Unicode participant ID`);
  assert.equal(JSON.parse(restored.raw).answers[0].optionIndex, 2, `${lang}: restored backup is persisted`);
  const previous = restored.raw;
  await page.evaluate(() => { window.__TEST__.resetState(); window.__TEST__.showSetupScreen(); });
  await page.evaluate((text) => window.__TEST__.restoreProgressBackup(text), expected.text);
  const conflict = await page.evaluate(() => ({ raw: localStorage.getItem(window.CONFIG.storageKey), alerts: window.testAlerts, expected: window.CONFIG.ui.backupRestoreConflict, text: document.getElementById("persistence-status").textContent }));
  assert.equal(conflict.raw, previous, `${lang}: import refuses to overwrite saved progress`);
  assert.ok(conflict.alerts.includes(conflict.expected) || conflict.text === conflict.expected, `${lang}: conflicting import explains refusal`);
  await page.evaluate(() => window.__TEST__.clearAllData());
  for (const bad of ["{", "null", JSON.stringify({ version: 1 }), JSON.stringify({ ...JSON.parse(expected.text), revision: "obsolete" })]) {
    await page.evaluate((text) => window.__TEST__.restoreProgressBackup(text), bad);
    const invalid = await page.evaluate(() => ({ active: window.__TEST__.state.testInProgress, raw: localStorage.getItem(window.CONFIG.storageKey), alerts: window.testAlerts, expected: window.CONFIG.ui.invalidBackup, text: document.getElementById("persistence-status")?.textContent }));
    assert.equal(invalid.active, false, `${lang}: invalid import never creates active answers`);
    assert.equal(invalid.raw, null, `${lang}: invalid import never writes storage`);
    assert.ok(invalid.alerts.includes(invalid.expected) || invalid.text === invalid.expected, `${lang}: invalid import gives localized feedback`);
  }
  await page.close();
}

async function resumeSameSession(first, second) {
  await first.evaluate(() => window.__TEST__.clearAllData());
  await start(first);
  await second.reload({ waitUntil: "domcontentloaded" });
  await click(second, "#resumeBtn");
  await settled(second);
  const baseline = await status(first);
  assert.equal((await status(second)).raw, baseline.raw, "two tabs resume exact same storage revision");
  return baseline;
}

async function concurrentCase(context, origin, lang) {
  const first = await openPage(context, origin, lang);
  const second = await openPage(context, origin, lang, { ignoreStorageEvents: true });
  await resumeSameSession(first, second);
  await first.evaluate((lockName) => new Promise((resolve) => {
    navigator.locks.request(lockName, () => new Promise((release) => {
      window.releaseTestLock = release;
      resolve();
    }));
  }), STORAGE_LOCK);
  for (const [page, option] of [[first, 0], [second, 1]]) {
    await page.evaluate((selectedOption) => {
      const T = window.__TEST__;
      document.getElementById("option" + selectedOption).click();
      if (!T.recordAnswer()) throw new Error("Could not prepare concurrent response");
      T.state.currentQuestionIndex++;
      window.concurrentSave = T.saveProgress();
    }, option);
  }
  await first.evaluate(() => window.releaseTestLock());
  await Promise.all([settled(first), settled(second)]);
  const snapshots = await Promise.all([status(first), status(second)]);
  const saved = snapshots.filter((value) => value.text === value.expected.progressSaved);
  const conflicts = snapshots.filter((value) => value.text === value.expected.progressConflict);
  assert.equal(saved.length, 1, `${lang}: simultaneous saves have exactly one winner`);
  assert.equal(conflicts.length, 1, `${lang}: simultaneous stale writer reports conflict`);
  assert.equal(saved[0].raw, conflicts[0].raw, `${lang}: tabs observe one persisted revision`);
  assert.equal(JSON.parse(saved[0].raw).answers[0].optionIndex, saved[0].answers[0].optionIndex, `${lang}: stored answer belongs to winner`);
  assert.notEqual(saved[0].answers[0].optionIndex, conflicts[0].answers[0].optionIndex, `${lang}: losing tab preserves its distinct answer`);
  assert.equal(conflicts[0].backup.answers[0].optionIndex, conflicts[0].answers[0].optionIndex, `${lang}: losing tab can back up its answer`);
  assert.equal(conflicts[0].nextDisabled, true, `${lang}: conflict pauses questionnaire progression`);
  const loser = snapshots[0].text === snapshots[0].expected.progressConflict ? first : second;
  await loser.evaluate(() => window.__TEST__.saveProgress());
  assert.equal((await status(loser)).raw, saved[0].raw, `${lang}: conflict retry cannot overwrite winning revision`);
  await first.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([first.close(), second.close()]);
}

async function storageEventConflictCase(context, origin, lang) {
  const first = await openPage(context, origin, lang);
  const second = await openPage(context, origin, lang);
  await resumeSameSession(first, second);
  await answer(first, 2);
  await second.waitForFunction(() => document.getElementById("persistence-status").textContent === window.CONFIG.ui.progressConflict, { polling: 50 });
  const conflict = await status(second);
  assert.equal(conflict.nextDisabled, true, `${lang}: real storage event pauses a competing tab immediately`);
  assert.equal(conflict.backup.answers.length, 0, `${lang}: real storage conflict preserves local prefix for backup`);
  assert.equal(JSON.parse(conflict.raw).answers[0].optionIndex, 2, `${lang}: real storage conflict keeps winning answer`);
  await first.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([first.close(), second.close()]);
}

async function queuedSameTabSavesCase(context, origin, lang) {
  const page = await openPage(context, origin, lang);
  await page.evaluate(() => window.__TEST__.clearAllData());
  await start(page);
  await page.evaluate((lockName) => new Promise((resolve) => {
    navigator.locks.request(lockName, () => new Promise((release) => {
      window.releaseTestLock = release;
      resolve();
    }));
  }), STORAGE_LOCK);
  await page.evaluate(() => {
    const T = window.__TEST__, C = window.CONFIG;
    window.savedStatusSnapshots = [];
    window.savedStatusObserver = new MutationObserver(() => {
      if (document.getElementById("persistence-status").textContent === C.ui.progressSaved) {
        window.savedStatusSnapshots.push(JSON.parse(localStorage.getItem(C.storageKey)).answers.length);
      }
    });
    window.savedStatusObserver.observe(document.getElementById("persistence-status"), { childList: true, subtree: true, characterData: true });
    for (const option of [0, 1]) {
      document.getElementById("option" + option).click();
      if (!T.recordAnswer()) throw new Error("Could not prepare queued response");
      T.state.currentQuestionIndex++;
      T.loadTest(T.state.tests[0]);
      T.saveProgress();
    }
  });
  const pending = await page.evaluate(() => ({ text: document.getElementById("persistence-status").textContent, expected: window.CONFIG.ui.progressSaving }));
  assert.equal(pending.text, pending.expected, `${lang}: queued answers remain visibly pending`);
  await page.evaluate(() => window.releaseTestLock());
  await settled(page);
  const saved = await status(page);
  const announced = await page.evaluate(() => { window.savedStatusObserver.disconnect(); return window.savedStatusSnapshots; });
  assert.equal(saved.text, saved.expected.progressSaved, `${lang}: latest queued same-tab save succeeds`);
  assert.equal(JSON.parse(saved.raw).answers.length, 2, `${lang}: queued same-tab writes retain both answers`);
  assert.ok(announced.length > 0 && announced.every((count) => count === 2), `${lang}: Saved is never announced for an outdated queued answer prefix`);
  await page.evaluate(() => window.__TEST__.clearAllData());
  await page.close();
}

async function queuedClearCase(context, origin, lang) {
  const page = await openPage(context, origin, lang);
  await page.evaluate(() => window.__TEST__.clearAllData());
  await start(page);
  await page.evaluate((lockName) => new Promise((resolve) => {
    navigator.locks.request(lockName, () => new Promise((release) => {
      window.releaseTestLock = release;
      resolve();
    }));
  }), STORAGE_LOCK);
  await page.evaluate(() => { window.pendingSaveBeforeClear = window.__TEST__.saveProgress(); });
  // Let the old save request reach the held lock before Clear invalidates its generation.
  await page.evaluate(() => { window.pendingClear = window.__TEST__.clearAllData(); });
  await page.evaluate(() => window.releaseTestLock());
  await settled(page);
  const cleared = await page.evaluate(() => ({
    active: window.__TEST__.state.testInProgress,
    answers: window.__TEST__.state.answers.length,
    raw: localStorage.getItem(window.CONFIG.storageKey),
    text: document.querySelector('#setup-area [role="status"]').textContent,
    expected: window.CONFIG.ui.dataCleared,
  }));
  assert.equal(cleared.active, false, `${lang}: Clear invalidates queued session immediately`);
  assert.equal(cleared.answers, 0, `${lang}: Clear removes queued in-memory answers`);
  assert.equal(cleared.raw, null, `${lang}: queued save cannot resurrect data after Clear`);
  assert.equal(cleared.text, cleared.expected, `${lang}: queued Clear verifies removal`);
  await page.close();
}

async function staleStartNewCase(context, origin, lang) {
  const first = await openPage(context, origin, lang);
  await first.evaluate(() => window.__TEST__.clearAllData());
  await start(first);
  const second = await openPage(context, origin, lang, { ignoreStorageEvents: true });
  await answer(first, 1);
  const updated = await status(first);
  await click(second, "#newSessionBtn");
  await settled(second);
  const stale = await second.evaluate(() => ({
    raw: localStorage.getItem(window.CONFIG.storageKey),
    text: document.getElementById("persistence-status").textContent,
    expected: window.CONFIG.ui.progressConflict,
    resumePresent: !!document.getElementById("resumeBtn"),
  }));
  assert.equal(stale.raw, updated.raw, `${lang}: stale Start New cannot delete a newer revision`);
  assert.equal(stale.text, stale.expected, `${lang}: stale Start New reports competing revision`);
  assert.equal(stale.resumePresent, true, `${lang}: stale Start New retains safe resume action`);
  await click(second, "#resumeBtn");
  await settled(second);
  assert.equal((await status(second)).answers.length, 1, `${lang}: stale prompt resumes current revision safely`);
  await first.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([first.close(), second.close()]);
}

async function seedNearCompletion(page, allTests = false) {
  await page.evaluate(async (includeAllTests) => {
    const T = window.__TEST__, C = window.CONFIG;
    await T.resetAuthorityForFixture();
    const tests = includeAllTests ? C.tests : C.tests.filter((item) => item.name === "HADS");
    const test = tests[tests.length - 1];
    const start = Date.now() - 600000;
    const questions = tests.flatMap((item) => item.questions.map((question, index) => ({ test: item, question, index })));
    const saved = {
      version: 1, lang: C.lang, revision: C.revision, configSignature: T.configSignature(),
      participantId: "near completion", selectedTestNames: tests.map((item) => item.name), currentTestIndex: tests.length - 1,
      currentQuestionIndex: test.questions.length - 1, testStartTime: new Date(start).toISOString(),
      answers: questions.slice(0, -1).map((item, sequence) => ({
        test: item.test.name, questionIndex: item.index + 1, optionIndex: 0,
        question: item.question.q, answer: item.question.options[0], score: item.question.scores[0],
        description: item.question.description ? "cœur, recovery" : "", time: 1,
        questionStartTime: new Date(start + sequence * 1000).toISOString(),
        answerTime: new Date(start + (sequence + 1) * 1000).toISOString(),
      })),
    };
    localStorage.setItem(C.storageKey, JSON.stringify(saved));
    T.showResumeScreen(saved);
    document.getElementById("resumeBtn").click();
  }, allTests);
  await settled(page);
}

async function completedSnapshot(page) {
  return page.evaluate(() => {
    const T = window.__TEST__;
    return {
      active: T.state.testInProgress, answers: T.state.answers,
      started: T.state.testStartTime && T.state.testStartTime.toISOString(),
      completed: T.state.testEndTime && T.state.testEndTime.toISOString(),
      summary: T.calculateSummaryScores(),
      resultsVisible: !document.getElementById("results-area").classList.contains("hidden"),
      exportsVisible: !document.getElementById("download-buttons").classList.contains("hidden"),
      questionVisible: !!document.querySelector("#test-area .question"),
    };
  });
}

async function unloadPrevented(page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function completedRecoveryCase(context, origin, lang, directory) {
  let page = await openPage(context, origin, lang);
  await page.evaluate(() => window.__TEST__.clearAllData());
  await seedNearCompletion(page, true);
  await answer(page, 0);
  const finished = await status(page);
  const expected = await completedSnapshot(page);
  assert.equal(finished.text, finished.expected.completedSaved, `${lang}: completion announces verified browser retention`);
  assert.equal(finished.active, false, `${lang}: completion stops questionnaire input`);
  assert.equal(finished.backup.status, "completed", `${lang}: completed results remain available as a recoverable backup`);
  const stored = JSON.parse(finished.raw);
  assert.equal(stored.status, "completed", `${lang}: completion persists an explicit completed state`);
  assert.equal(stored.answers.length, 88, `${lang}: completion saves all 88 responses`);
  assert.equal(stored.testEndTime, expected.completed, `${lang}: completed storage freezes the final timestamp`);
  assert.deepEqual(stored.answers, expected.answers, `${lang}: completed storage preserves answers and per-item timing`);
  assert.equal(await unloadPrevented(page), false, `${lang}: verified completed recovery allows closing before export`);
  await page.close();

  page = await openPage(context, origin, lang);
  const prompt = await page.evaluate(() => ({
    text: document.getElementById("setup-area").textContent,
    resume: document.getElementById("resumeBtn").textContent,
    clear: document.getElementById("newSessionBtn").textContent,
    expected: window.CONFIG.ui,
  }));
  assert.ok(prompt.text.includes(prompt.expected.completedFound), `${lang}: reopening offers completed-result recovery with retention guidance`);
  assert.equal(prompt.resume, prompt.expected.viewResultsBtn, `${lang}: completed recovery offers View results`);
  assert.equal(prompt.clear, prompt.expected.clearResultsStartBtn, `${lang}: starting again explicitly clears completed results`);
  await click(page, "#resumeBtn");
  await settled(page);
  assert.deepEqual(await completedSnapshot(page), expected, `${lang}: close and reopen recovers all answers, frozen timing, and summary before any export`);
  assert.equal(expected.resultsVisible, true, `${lang}: completed recovery shows scored results`);
  assert.equal(expected.exportsVisible, true, `${lang}: completed recovery shows export controls`);
  assert.equal(expected.questionVisible, false, `${lang}: completed recovery never asks another question`);
  const filenames = await page.evaluate(() => window.CONFIG.export);
  for (const [selector, filename, type] of [
    ["#downloadCsv", filenames.csvFilename, "CSV"],
    ["#downloadPdf", filenames.pdfFilename, "PDF"],
    ["#downloadBackup", filenames.backupFilename, "JSON"],
  ]) {
    await fs.rm(path.join(directory, filename), { force: true });
    await click(page, selector);
    const download = await waitForDownload(directory, filename);
    if (type === "CSV") {
      assert.ok(download.bytes.toString("utf8").includes(expected.completed), `${lang}: recovered CSV contains original completion time`);
    } else if (type === "PDF") {
      assert.equal(download.bytes.subarray(0, 5).toString("ascii"), "%PDF-", `${lang}: recovered results download a real PDF`);
    } else {
      const backup = JSON.parse(download.bytes.toString("utf8"));
      assert.equal(backup.status, "completed", `${lang}: completed JSON download records recovery state`);
      assert.deepEqual(backup.answers, expected.answers, `${lang}: completed JSON download preserves all 88 answers`);
      assert.equal(backup.testEndTime, expected.completed, `${lang}: completed JSON download preserves completion timestamp`);
    }
    assert.equal((await status(page)).raw, finished.raw, `${lang}: ${type} export keeps the recoverable browser copy`);
  }
  await page.close();

  page = await openPage(context, origin, lang);
  await click(page, "#resumeBtn");
  await settled(page);
  assert.deepEqual(await completedSnapshot(page), expected, `${lang}: reopening after exports still recovers completed results`);
  await click(page, "#clearDataBtn");
  await settled(page);
  assert.equal((await status(page)).raw, null, `${lang}: explicit Clear Data removes completed browser copy`);
  assert.equal((await status(page)).completed, false, `${lang}: explicit Clear Data removes completed in-memory results`);
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.$("#resumeBtn"), null, `${lang}: explicitly cleared completed results do not return after reload`);
  const input = await page.$("#restoreBackupInput");
  await input.uploadFile(path.join(directory, filenames.backupFilename));
  await page.waitForFunction(() => !!window.__TEST__.state.testEndTime, { polling: 50 });
  await settled(page);
  assert.deepEqual(await completedSnapshot(page), expected, `${lang}: actual completed backup import restores finished results without repeating questions`);
  const restored = await status(page);
  assert.equal(restored.text, restored.expected.completedSaved, `${lang}: restored completed results verify persistence`);
  assert.equal(JSON.parse(restored.raw).status, "completed", `${lang}: restored completed backup saves completed browser state`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await click(page, "#newSessionBtn");
  await settled(page);
  assert.equal((await status(page)).raw, null, `${lang}: explicit Clear results and start again removes completed browser state`);
  assert.ok(await page.$("#participantIdInput"), `${lang}: clearing completed results starts at setup`);
  await page.close();
}

async function completedWriteFailureCases(context, origin, lang) {
  for (const mode of ["throw", "no-op", "pre-read", "verify-read"]) {
    const page = await openPage(context, origin, lang);
    await page.evaluate(() => window.__TEST__.clearAllData());
    await seedNearCompletion(page);
    const prior = (await status(page)).raw;
    await injectWriteFailure(page, mode);
    await answer(page, 0);
    const failed = await page.evaluate(() => ({
      completed: !!window.__TEST__.state.testEndTime,
      text: document.getElementById("persistence-status").textContent,
      expected: window.CONFIG.ui.completedSaveFailed,
      backup: JSON.parse(window.__TEST__.buildProgressBackup()),
      backupVisible: !document.getElementById("downloadBackup").classList.contains("hidden"),
      retryVisible: !document.getElementById("retrySave").classList.contains("hidden"),
      csv: window.__TEST__.buildCSV(),
    }));
    assert.equal(failed.completed, true, `${lang}: ${mode} preserves completed results in memory`);
    assert.equal(failed.text, failed.expected, `${lang}: ${mode} explains completed results are not confirmed saved`);
    assert.equal(failed.backup.status, "completed", `${lang}: ${mode} completed backup has explicit recovery state`);
    assert.equal(failed.backup.answers.length, 14, `${lang}: ${mode} completed backup includes final response`);
    assert.equal(failed.backupVisible, true, `${lang}: ${mode} completed failure offers backup export`);
    assert.equal(failed.retryVisible, true, `${lang}: ${mode} completed failure offers retry`);
    assert.ok(failed.csv.length > 1000, `${lang}: ${mode} completed failure preserves full CSV export`);
    assert.equal(await unloadPrevented(page), true, `${lang}: ${mode} older saved prefix never suppresses unsaved-results close warning`);
    await page.evaluate(() => window.restoreTestStorage());
    if (mode !== "verify-read") assert.equal((await status(page)).raw, prior, `${lang}: ${mode} never discards saved prefix after failed completed write`);
    await click(page, "#retrySave");
    await settled(page);
    const retried = await status(page);
    assert.equal(retried.text, retried.expected.completedSaved, `${lang}: ${mode} completed-save retry confirms recovery`);
    assert.equal(JSON.parse(retried.raw).testEndTime, failed.backup.testEndTime, `${lang}: ${mode} retry preserves original completion timestamp`);
    assert.deepEqual(JSON.parse(retried.raw).answers, failed.backup.answers, `${lang}: ${mode} retry persists all completed answers`);
    assert.equal(await unloadPrevented(page), false, `${lang}: ${mode} completed-save retry makes closing recoverable`);
    await page.evaluate(() => window.__TEST__.clearAllData());
    await page.close();
  }
}

async function completedConflictCase(context, origin, lang) {
  const first = await openPage(context, origin, lang);
  await first.evaluate(() => window.__TEST__.clearAllData());
  await seedNearCompletion(first);
  const second = await openPage(context, origin, lang, { ignoreStorageEvents: true });
  await click(second, "#resumeBtn");
  await settled(second);
  await first.evaluate((lockName) => new Promise((resolve) => {
    navigator.locks.request(lockName, () => new Promise((release) => {
      window.releaseTestLock = release;
      resolve();
    }));
  }), STORAGE_LOCK);
  await second.evaluate(() => { window.newerRevisionSave = window.__TEST__.saveProgress(); });
  await click(first, "#option0");
  await click(first, "#nextBtn");
  await first.evaluate(() => window.releaseTestLock());
  await Promise.all([settled(first), settled(second)]);
  const winner = await status(second);
  const completed = await first.evaluate(() => ({
    completed: !!window.__TEST__.state.testEndTime,
    raw: localStorage.getItem(window.CONFIG.storageKey),
    text: document.getElementById("persistence-status").textContent,
    expected: window.CONFIG.ui.completedConflict,
    csv: window.__TEST__.buildCSV(),
    backup: JSON.parse(window.__TEST__.buildProgressBackup()),
  }));
  assert.equal(completed.completed, true, `${lang}: pending completion retains finished local results`);
  assert.equal(completed.raw, winner.raw, `${lang}: pending completion cannot overwrite a newer saved revision`);
  assert.ok(completed.text.includes(completed.expected), `${lang}: completion explains competing saved session`);
  assert.ok(completed.csv.length > 1000, `${lang}: completion conflict preserves full result export`);
  assert.equal(completed.backup.answers.length, 14, `${lang}: completion conflict preserves final answer in backup`);
  assert.equal(completed.backup.status, "completed", `${lang}: completion conflict backup remains recoverable as finished results`);
  assert.equal(await unloadPrevented(first), true, `${lang}: competing saved draft never suppresses unsaved completed-results close warning`);
  await first.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([first.close(), second.close()]);
}

async function staleCompletedClearCase(context, origin, lang) {
  const first = await openPage(context, origin, lang);
  await first.evaluate(() => window.__TEST__.clearAllData());
  await seedNearCompletion(first);
  await answer(first, 0);
  const second = await openPage(context, origin, lang, { ignoreStorageEvents: true });
  await first.evaluate(() => window.__TEST__.saveProgress());
  const winner = await status(first);
  await click(second, "#newSessionBtn");
  await settled(second);
  const stale = await second.evaluate(() => ({
    raw: localStorage.getItem(window.CONFIG.storageKey),
    text: document.getElementById("persistence-status").textContent,
    expected: window.CONFIG.ui.completedConflict,
    viewPresent: !!document.getElementById("resumeBtn"),
  }));
  assert.equal(stale.raw, winner.raw, `${lang}: stale clear-and-start prompt cannot delete a newer completed revision`);
  assert.equal(stale.text, stale.expected, `${lang}: stale completed clear explains saved-results conflict`);
  assert.equal(stale.viewPresent, true, `${lang}: stale completed clear retains results recovery action`);
  await click(second, "#resumeBtn");
  await settled(second);
  assert.equal((await status(second)).completed, true, `${lang}: stale completed prompt safely recovers current revision`);
  await first.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([first.close(), second.close()]);
}

async function completedClearFailureCase(context, origin, lang) {
  const page = await openPage(context, origin, lang);
  await page.evaluate(() => window.__TEST__.clearAllData());
  await seedNearCompletion(page);
  await answer(page, 0);
  const before = await status(page);
  await page.evaluate(() => {
    const remove = Storage.prototype.removeItem;
    window.restoreTestRemove = () => { Storage.prototype.removeItem = remove; };
    Storage.prototype.removeItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey) throw new Error("Deletion denied");
      return remove.apply(this, arguments);
    };
  });
  await click(page, "#newSessionBtn");
  await settled(page);
  const failed = await status(page);
  assert.equal(failed.raw, before.raw, `${lang}: denied clear-and-start keeps recoverable completed storage`);
  assert.equal(failed.completed, true, `${lang}: denied clear-and-start keeps completed in-memory results`);
  assert.deepEqual(failed.answers, before.answers, `${lang}: denied clear-and-start preserves every completed answer`);
  assert.notEqual(failed.text, failed.expected.completedSaved, `${lang}: denied clear-and-start reports failure`);
  assert.equal((await completedSnapshot(page)).resultsVisible, true, `${lang}: denied clear-and-start keeps full results visible`);
  await page.evaluate(() => window.restoreTestRemove());
  await click(page, "#newSessionBtn");
  await settled(page);
  const cleared = await status(page);
  assert.equal(cleared.raw, null, `${lang}: clear-and-start retry verifies completed storage removal`);
  assert.equal(cleared.completed, false, `${lang}: clear-and-start retry clears in-memory completed results`);
  assert.ok(await page.$("#participantIdInput"), `${lang}: clear-and-start retry returns to setup`);
  await seedNearCompletion(page);
  await answer(page, 0);
  await page.evaluate(() => { window.detachedCompletedClear = document.getElementById("newSessionBtn"); });
  await page.evaluate(() => window.__TEST__.clearAllData());
  await start(page, "new session after completed results");
  const fresh = await status(page);
  await page.evaluate(() => window.detachedCompletedClear.click());
  await settled(page);
  const afterDetachedClick = await status(page);
  assert.equal(afterDetachedClick.raw, fresh.raw, `${lang}: detached old completed-results clear cannot delete a new session`);
  assert.equal(afterDetachedClick.active, true, `${lang}: detached old completed-results clear cannot reset current questionnaire`);
  assert.equal(afterDetachedClick.backup.participantId, "new session after completed results", `${lang}: detached completed clear preserves current participant`);
  await page.evaluate(() => window.__TEST__.clearAllData());
  await page.close();
}

async function incompatibleCompletedRecoveryCase(context, origin, lang) {
  const page = await openPage(context, origin, lang);
  await page.evaluate(() => window.__TEST__.clearAllData());
  await seedNearCompletion(page);
  await answer(page, 0);
  const original = await page.evaluate(async () => {
    const saved = JSON.parse(localStorage.getItem(window.CONFIG.storageKey));
    saved.revision = "obsolete";
    const raw = JSON.stringify(saved);
    await window.__TEST__.resetAuthorityForFixture();
    localStorage.setItem(window.CONFIG.storageKey, raw);
    return raw;
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#downloadStoredBackup");
  await settled(page);
  const unavailable = await page.evaluate(() => ({
    raw: localStorage.getItem(window.CONFIG.storageKey),
    text: document.getElementById("setup-area").textContent,
    expected: window.CONFIG.ui.savedUnavailable,
    active: window.__TEST__.state.testInProgress,
    answers: window.__TEST__.state.answers.length,
    resultVisible: !document.getElementById("results-area").classList.contains("hidden"),
    question: !!document.querySelector("#test-area .question"),
    clearLabel: document.getElementById("newSessionBtn").textContent,
    expectedClear: window.CONFIG.ui.clearSavedStartBtn,
  }));
  assert.equal(unavailable.raw, original, `${lang}: incompatible completed record survives reload unchanged`);
  assert.ok(unavailable.text.includes(unavailable.expected), `${lang}: incompatible completed record explains export and explicit clearing`);
  assert.equal(unavailable.active, false, `${lang}: incompatible completed record never starts questionnaire input`);
  assert.equal(unavailable.answers, 0, `${lang}: incompatible completed record never enters live scoring state`);
  assert.equal(unavailable.resultVisible, false, `${lang}: incompatible completed record never displays stale scores`);
  assert.equal(unavailable.question, false, `${lang}: incompatible completed record never displays questions`);
  assert.equal(unavailable.clearLabel, unavailable.expectedClear, `${lang}: incompatible completed recovery labels destructive clearing explicitly`);
  const backup = await page.evaluate(async () => {
    const create = URL.createObjectURL;
    const anchorClick = HTMLAnchorElement.prototype.click;
    let blob, filename;
    URL.createObjectURL = (value) => { blob = value; return "blob:completed-backup-test"; };
    HTMLAnchorElement.prototype.click = function () { filename = this.download; };
    try {
      document.getElementById("downloadStoredBackup").click();
      await window.__TEST__.whenPersistenceSettled();
      return { text: blob && await blob.text(), filename, expectedFilename: window.CONFIG.export.backupFilename };
    } finally {
      URL.createObjectURL = create;
      HTMLAnchorElement.prototype.click = anchorClick;
    }
  });
  assert.equal(backup.text, original, `${lang}: incompatible completed backup preserves original JSON without normalization`);
  assert.equal(backup.filename, backup.expectedFilename, `${lang}: incompatible completed backup uses downloadable JSON filename`);
  assert.equal((await status(page)).raw, original, `${lang}: incompatible completed backup export retains browser record`);
  await click(page, "#newSessionBtn");
  await settled(page);
  assert.equal((await status(page)).raw, null, `${lang}: explicit clear-and-start removes incompatible completed record`);
  assert.ok(await page.$("#participantIdInput"), `${lang}: explicit incompatible-record clear returns to setup`);
  await page.evaluate(async (raw) => {
    await window.__TEST__.resetAuthorityForFixture();
    localStorage.setItem(window.CONFIG.storageKey, raw);
  }, original);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#downloadStoredBackup");
  const externalClear = await page.evaluate(async () => {
    const oldBackup = document.getElementById("downloadStoredBackup");
    localStorage.removeItem(window.CONFIG.storageKey);
    const create = URL.createObjectURL;
    let downloads = 0;
    URL.createObjectURL = () => { downloads++; return "blob:detached-completed-backup-test"; };
    let promptPresent, setupPresent;
    try {
      oldBackup.click();
      await window.__TEST__.whenPersistenceSettled();
      promptPresent = !!document.getElementById("downloadStoredBackup");
      setupPresent = !!document.getElementById("participantIdInput");
      window.dispatchEvent(new StorageEvent("storage", { key: window.CONFIG.storageKey, newValue: null, storageArea: localStorage }));
      await window.__TEST__.whenPersistenceSettled();
      oldBackup.click();
      await window.__TEST__.whenPersistenceSettled();
    }
    finally { URL.createObjectURL = create; }
    return { downloads, promptPresent, setupPresent };
  });
  assert.equal(externalClear.promptPresent, false, `${lang}: backup click before storage-event delivery invalidates cleared completed prompt`);
  assert.equal(externalClear.setupPresent, true, `${lang}: backup click before storage-event delivery returns to setup after external clear`);
  assert.equal(externalClear.downloads, 0, `${lang}: pre-event and detached incompatible-results backup clicks cannot recover explicitly cleared data`);
  await page.close();
}

async function unavailableDraftRecoveryCases(context, origin, lang) {
  for (const variant of ["legacy", "revision", "signature", "clock", "malformed"]) {
    const page = await openPage(context, origin, lang);
    page.on("dialog", (dialog) => dialog.accept());
    await page.evaluate(() => window.__TEST__.clearAllData());
    await start(page, "retained draft " + variant);
    await answer(page, 2);
    const original = await page.evaluate(async (reason) => {
      const C = window.CONFIG;
      const saved = JSON.parse(localStorage.getItem(C.storageKey));
      if (reason === "legacy") delete saved.version;
      if (reason === "revision") saved.revision = "older questionnaire revision";
      if (reason === "signature") saved.configSignature = "older questionnaire content";
      if (reason === "clock") {
        // The save was valid before the device clock moved backward on reload.
        const offset = 3600000;
        saved.testStartTime = new Date(Date.parse(saved.testStartTime) + offset).toISOString();
        saved.answers.forEach((answer) => {
          answer.questionStartTime = new Date(Date.parse(answer.questionStartTime) + offset).toISOString();
          answer.answerTime = new Date(Date.parse(answer.answerTime) + offset).toISOString();
        });
      }
      const raw = reason === "malformed" ? '\n{"answers":[{"description":"recoverable text"}]' : JSON.stringify(saved, null, 2) + "\n";
      await window.__TEST__.resetAuthorityForFixture();
      localStorage.setItem(C.storageKey, raw);
      return raw;
    }, variant);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#downloadStoredBackup");
    await settled(page);
    const retained = await page.evaluate(() => ({
      raw: localStorage.getItem(window.CONFIG.storageKey),
      text: document.getElementById("setup-area").textContent,
      expected: window.CONFIG.ui.savedUnavailable,
      clear: document.getElementById("newSessionBtn").textContent,
      expectedClear: window.CONFIG.ui.clearSavedStartBtn,
      active: window.__TEST__.state.testInProgress,
      answers: window.__TEST__.state.answers.length,
      nextHidden: document.getElementById("nextBtn").classList.contains("hidden"),
    }));
    assert.equal(retained.raw, original, `${lang}: ${variant} draft survives reload byte for byte`);
    assert.ok(retained.text.includes(retained.expected), `${lang}: ${variant} draft explains backup and recovery`);
    assert.equal(retained.clear, retained.expectedClear, `${lang}: ${variant} draft requires explicitly labelled clearing`);
    assert.equal(retained.active, false, `${lang}: ${variant} draft is not resumed without validation`);
    assert.equal(retained.answers, 0, `${lang}: ${variant} draft never enters scoring state`);
    assert.equal(retained.nextHidden, true, `${lang}: ${variant} draft cannot be replaced by starting from setup`);
    const downloaded = await page.evaluate(async () => {
      const originalCreate = URL.createObjectURL;
      const originalClick = HTMLAnchorElement.prototype.click;
      let blob;
      URL.createObjectURL = (value) => { blob = value; return "blob:unavailable-draft-backup"; };
      HTMLAnchorElement.prototype.click = function () { };
      try {
        document.getElementById("downloadStoredBackup").click();
        await window.__TEST__.whenPersistenceSettled();
        return blob && await blob.text();
      } finally {
        URL.createObjectURL = originalCreate;
        HTMLAnchorElement.prototype.click = originalClick;
      }
    });
    assert.equal(downloaded, original, `${lang}: ${variant} backup preserves original bytes including malformed JSON`);
    assert.equal((await status(page)).raw, original, `${lang}: ${variant} backup leaves original browser save retained`);
    const denied = await page.evaluate(async () => {
      const originalRemove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) {
        if (this === localStorage && key === window.CONFIG.storageKey) return;
        return originalRemove.apply(this, arguments);
      };
      try {
        document.getElementById("newSessionBtn").click();
        await window.__TEST__.whenPersistenceSettled();
        return {
          raw: localStorage.getItem(window.CONFIG.storageKey),
          text: document.getElementById("persistence-status").textContent,
          expected: window.CONFIG.ui.savedClearFailed,
          backupPresent: !!document.getElementById("downloadStoredBackup"),
        };
      } finally { Storage.prototype.removeItem = originalRemove; }
    });
    assert.equal(denied.raw, original, `${lang}: ${variant} failed clear preserves original recovery data`);
    assert.equal(denied.text, denied.expected, `${lang}: ${variant} silent clear failure is reported`);
    assert.equal(denied.backupPresent, true, `${lang}: ${variant} failed clear keeps backup available`);
    const otherKey = lang === "en" ? "psychometric_progress_fr" : "psychometric_progress_en";
    await page.evaluate(async (key) => {
      await window.__TEST__.resetAuthorityForFixture(key);
      localStorage.setItem(key, "other language save");
    }, otherKey);
    await click(page, "#newSessionBtn");
    await settled(page);
    assert.equal((await status(page)).raw, null, `${lang}: ${variant} explicit clear removes original save`);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), otherKey), "other language save", `${lang}: ${variant} explicit clear preserves other language`);
    assert.ok(await page.$("#participantIdInput"), `${lang}: ${variant} explicit clear returns to setup`);
    await page.evaluate(() => window.__TEST__.clearAllData());
    await page.close();
  }
}

async function failedFirstSaveCase(context, origin, lang) {
  const first = await openPage(context, origin, lang, { ignoreStorageEvents: true });
  await first.evaluate(() => window.__TEST__.clearAllData());
  await injectWriteFailure(first, "throw");
  await start(first, "unsaved first tab");
  await first.evaluate(() => window.restoreTestStorage());
  const second = await openPage(context, origin, lang);
  await start(second, "competing second tab");
  const winner = await status(second);
  await first.evaluate(() => window.__TEST__.saveProgress());
  const loser = await status(first);
  assert.equal(loser.text, loser.expected.progressConflict, `${lang}: failed first save never adopts another tab's revision`);
  assert.equal(loser.raw, winner.raw, `${lang}: failed first save cannot overwrite competitor`);
  assert.equal(loser.backup.participantId, "unsaved first tab", `${lang}: failed first save preserves local session for backup`);
  await second.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([first.close(), second.close()]);
}

async function missingLocksCase(browser, origin, lang) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__TEST__ = {};
      Object.defineProperty(navigator, "locks", { value: undefined });
    });
    await page.goto(origin + "/" + lang + "/index.html", { waitUntil: "domcontentloaded" });
    await start(page);
    const initial = await status(page);
    assert.equal(initial.text, initial.expected.progressStorageUnavailable, `${lang}: missing Web Locks visibly falls back to memory`);
    assert.equal(initial.raw, null, `${lang}: missing Web Locks never performs uncoordinated writes`);
    await answer(page);
    const after = await status(page);
    assert.equal(after.backup.answers.length, 1, `${lang}: memory-only answers remain available for backup`);
    assert.equal(after.raw, null, `${lang}: memory-only answer never reaches storage`);
    await page.evaluate(() => window.__TEST__.clearAllData());
    await seedNearCompletion(page);
    await answer(page, 0);
    const finished = await status(page);
    assert.equal(finished.text, finished.expected.completedStorageUnavailable, `${lang}: completed results explain unavailable browser recovery`);
    assert.equal(finished.backup.status, "completed", `${lang}: missing Web Locks offers finished-result backup`);
    assert.equal(finished.backup.answers.length, 14, `${lang}: missing Web Locks preserves final answer in completed backup`);
    await page.evaluate(async () => {
      await window.__TEST__.resetAuthorityForFixture();
      localStorage.setItem(window.CONFIG.storageKey, "old saved responses");
    });
    await page.evaluate(() => window.__TEST__.clearAllData());
    const cleared = await page.evaluate(() => ({ raw: localStorage.getItem(window.CONFIG.storageKey), text: document.querySelector('#setup-area [role="status"]').textContent, expected: window.CONFIG.ui.dataCleared }));
    assert.equal(cleared.raw, null, `${lang}: explicit Clear still works without Web Locks`);
    assert.equal(cleared.text, cleared.expected, `${lang}: explicit Clear without Web Locks verifies removal`);
  } finally {
    await context.close();
  }
}

async function localeIndependenceCase(context, origin) {
  const english = await openPage(context, origin, "en");
  await english.evaluate(() => window.__TEST__.clearAllData());
  const french = await openPage(context, origin, "fr");
  await Promise.all([start(english, "English tab"), start(french, "French tab")]);
  await answer(english, 0);
  await answer(french, 1);
  const en = await status(english), fr = await status(french);
  assert.equal(en.text, en.expected.progressSaved, "English save remains independent of French session");
  assert.equal(fr.text, fr.expected.progressSaved, "French save remains independent of English session");
  assert.equal(JSON.parse(en.raw).participantId, "English tab");
  assert.equal(JSON.parse(fr.raw).participantId, "French tab");
  await english.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([english.close(), french.close()]);
}

module.exports = async function runPersistenceTests(browser) {
  const { server, origin } = await serveApplication();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "psychometric-backup-"));
  const context = await browser.createBrowserContext({ downloadBehavior: { policy: "allow", downloadPath: directory } });
  try {
    console.log("\n--- Persistence and real two-tab regressions (HTTP origin) ---");
    for (const lang of ["en", "fr"]) {
      await writeFailureCases(context, origin, lang);
      await backupCases(context, origin, lang, directory);
      await concurrentCase(context, origin, lang);
      await failedFirstSaveCase(context, origin, lang);
      await storageEventConflictCase(context, origin, lang);
      await queuedSameTabSavesCase(context, origin, lang);
      await queuedClearCase(context, origin, lang);
      await staleStartNewCase(context, origin, lang);
      await completedRecoveryCase(context, origin, lang, directory);
      await completedWriteFailureCases(context, origin, lang);
      await completedConflictCase(context, origin, lang);
      await staleCompletedClearCase(context, origin, lang);
      await completedClearFailureCase(context, origin, lang);
      await incompatibleCompletedRecoveryCase(context, origin, lang);
      await unavailableDraftRecoveryCases(context, origin, lang);
      await missingLocksCase(browser, origin, lang);
      console.log(`  ${lang}: verified save failures/recovery, concurrent tabs, completed-result reopening/retention/clearing, actual CSV/PDF/JSON recovery exports, backup import, and memory-only fallback.`);
    }
    await localeIndependenceCase(context, origin);
    console.log("  Separate English and French tabs save independently.");
    return 0;
  } catch (error) {
    console.error("  Persistence regression failed:", error.stack);
    return 1;
  } finally {
    await context.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
};
