const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const STORAGE_LOCK = "psychometric-session-storage";

async function serveApplication() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const target = path.resolve(ROOT, "." + (pathname === "/" ? "/index.html" : pathname));
      if (!target.startsWith(ROOT + path.sep)) throw new Error("Invalid path");
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(target)];
      const bytes = await fs.readFile(target);
      response.writeHead(200, { "Content-Type": type || "application/octet-stream", "Cache-Control": "no-store" });
      response.end(bytes);
    } catch (error) {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function openPage(context, origin, lang, options = {}) {
  const page = await context.newPage();
  await page.evaluateOnNewDocument((ignoreStorageEvents) => {
    window.__TEST__ = {};
    window.testAlerts = [];
    window.alert = (message) => window.testAlerts.push(message);
    if (ignoreStorageEvents) window.addEventListener("storage", (event) => event.stopImmediatePropagation(), true);
  }, !!options.ignoreStorageEvents);
  await page.goto(origin + "/" + lang + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#participantIdInput, #resumeBtn");
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

async function answer(page, option = 0) {
  await page.waitForFunction(() => {
    const next = document.getElementById("nextBtn");
    return !next.disabled && document.getElementById("option0");
  });
  await page.click("#option" + option);
  await page.click("#nextBtn");
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
      nextDisabled: document.getElementById("nextBtn").disabled,
      raw: localStorage.getItem(C.storageKey),
      backup: T.state.testInProgress ? JSON.parse(T.buildProgressBackup()) : null,
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
      // The write landed, but verification failed. A retry must safely recognize only this tab's attempted value.
      await page.click("#retrySave");
      await settled(page);
      const retried = await status(page);
      assert.equal(retried.text, retried.expected.progressSaved, `${lang}: retry confirms this tab's previously unverified write`);
      assert.equal(JSON.parse(retried.raw).answers.length, 1);
    } else {
      await page.click("#retrySave");
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
  throw new Error(`Backup download did not finish: ${filename}`);
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
  await page.click("#downloadBackup");
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
  await page.waitForFunction(() => window.__TEST__.state.testInProgress);
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
  await second.click("#resumeBtn");
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
  await second.waitForFunction(() => document.getElementById("persistence-status").textContent === window.CONFIG.ui.progressConflict);
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
  await second.click("#newSessionBtn");
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
  await second.click("#resumeBtn");
  await settled(second);
  assert.equal((await status(second)).answers.length, 1, `${lang}: stale prompt resumes current revision safely`);
  await first.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([first.close(), second.close()]);
}

async function seedNearCompletion(page) {
  await page.evaluate(() => {
    const T = window.__TEST__, C = window.CONFIG;
    const test = C.tests.find((item) => item.name === "HADS");
    const start = Date.now() - 60000;
    const saved = {
      version: 1, lang: C.lang, revision: C.revision, configSignature: T.configSignature(),
      participantId: "near completion", selectedTestNames: [test.name], currentTestIndex: 0,
      currentQuestionIndex: test.questions.length - 1, testStartTime: new Date(start).toISOString(),
      answers: test.questions.slice(0, -1).map((question, index) => ({
        test: test.name, questionIndex: index + 1, optionIndex: 0,
        question: question.q, answer: question.options[0], score: question.scores[0], description: "", time: 1,
        questionStartTime: new Date(start + index * 1000).toISOString(),
        answerTime: new Date(start + (index + 1) * 1000).toISOString(),
      })),
    };
    localStorage.setItem(C.storageKey, JSON.stringify(saved));
    T.showResumeScreen(saved);
    document.getElementById("resumeBtn").click();
  });
  await settled(page);
}

async function completionCases(context, origin, lang) {
  const first = await openPage(context, origin, lang);
  await first.evaluate(() => window.__TEST__.clearAllData());
  await seedNearCompletion(first);
  await first.evaluate(() => {
    const remove = Storage.prototype.removeItem;
    window.restoreTestRemove = () => { Storage.prototype.removeItem = remove; };
    Storage.prototype.removeItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey) throw new Error("Deletion denied");
      return remove.apply(this, arguments);
    };
  });
  await answer(first, 0);
  const failed = await first.evaluate(() => ({
    completed: !!window.__TEST__.state.testEndTime,
    raw: localStorage.getItem(window.CONFIG.storageKey),
    text: document.getElementById("persistence-status").textContent,
    expected: window.CONFIG.ui.progressCompletedClearFailed,
    csv: window.__TEST__.buildCSV(),
    backupHidden: document.getElementById("downloadBackup").classList.contains("hidden"),
  }));
  assert.equal(failed.completed, true, `${lang}: final answer still produces complete results if deletion fails`);
  assert.ok(failed.raw, `${lang}: completion deletion failure leaves its prior saved prefix`);
  assert.ok(failed.text.includes(failed.expected), `${lang}: completion reports saved data may remain`);
  assert.ok(failed.csv.length > 1000, `${lang}: completion failure preserves complete CSV export`);
  assert.equal(failed.backupHidden, true, `${lang}: completed results offer full exports`);
  await first.evaluate(() => window.restoreTestRemove());
  await first.evaluate(() => window.__TEST__.clearAllData());
  await seedNearCompletion(first);
  const second = await openPage(context, origin, lang, { ignoreStorageEvents: true });
  await second.click("#resumeBtn");
  await settled(second);
  await first.evaluate((lockName) => new Promise((resolve) => {
    navigator.locks.request(lockName, () => new Promise((release) => {
      window.releaseTestLock = release;
      resolve();
    }));
  }), STORAGE_LOCK);
  await second.evaluate(() => { window.newerRevisionSave = window.__TEST__.saveProgress(); });
  await first.click("#option0");
  await first.click("#nextBtn");
  await first.evaluate(() => window.releaseTestLock());
  await Promise.all([settled(first), settled(second)]);
  const winner = await status(second);
  const completed = await first.evaluate(() => ({
    completed: !!window.__TEST__.state.testEndTime,
    raw: localStorage.getItem(window.CONFIG.storageKey),
    text: document.getElementById("persistence-status").textContent,
    expected: window.CONFIG.ui.progressCompletedConflict,
    csv: window.__TEST__.buildCSV(),
  }));
  assert.equal(completed.completed, true, `${lang}: pending completion retains finished local results`);
  assert.equal(completed.raw, winner.raw, `${lang}: pending completion cannot remove a newer saved revision`);
  assert.ok(completed.text.includes(completed.expected), `${lang}: completion explains competing saved session`);
  assert.ok(completed.csv.length > 1000, `${lang}: completion conflict preserves full result export`);
  await first.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([first.close(), second.close()]);
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
    await page.evaluate(() => localStorage.setItem(window.CONFIG.storageKey, "old saved responses"));
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
  await Promise.all([answer(english, 0), answer(french, 1)]);
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
      await completionCases(context, origin, lang);
      await missingLocksCase(browser, origin, lang);
      console.log(`  ${lang}: verified save failures/recovery, actual backup download/import, concurrent saves, and memory-only fallback.`);
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
