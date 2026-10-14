const assert = require("node:assert/strict");
const serveApplication = require("./test-server");

async function open(context, origin, lang, ignoreStorageEvents) {
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  await page.evaluateOnNewDocument((ignore) => {
    window.__TEST__ = {};
    window.alert = () => {};
    if (ignore) window.addEventListener("storage", (event) => event.stopImmediatePropagation(), true);
  }, !!ignoreStorageEvents);
  await page.goto(origin + "/" + lang + "/index.html", { waitUntil: "domcontentloaded" });
  return page;
}

async function startSession(page, participant, memoryOnly) {
  await page.bringToFront();
  await page.evaluate(async ({ id, failWrites }) => {
    if (failWrites) {
      const set = Storage.prototype.setItem;
      window.restoreResponseWrites = () => { Storage.prototype.setItem = set; };
      Storage.prototype.setItem = function (key) {
        if (this === localStorage && key === window.CONFIG.storageKey) throw new DOMException("Storage full", "QuotaExceededError");
        return set.apply(this, arguments);
      };
    }
    document.getElementById("participantIdInput").value = id;
    document.querySelectorAll(".test-checkbox").forEach((box) => {
      box.checked = window.CONFIG.tests[Number(box.value)].name === "HADS";
    });
    document.getElementById("nextBtn").click();
    await window.__TEST__.whenPersistenceSettled();
  }, { id: participant, failWrites: !!memoryOnly });
}

async function submitAnswer(page) {
  await page.bringToFront();
  await page.waitForFunction(() => !document.getElementById("nextBtn").disabled);
  await page.evaluate(async () => {
    document.getElementById("option1").click();
    document.getElementById("nextBtn").click();
    await window.__TEST__.whenPersistenceSettled();
  });
}

async function memoryOnlyClearCases(context, origin, lang) {
  for (const ignoreEvents of [false, true]) {
    const memory = await open(context, origin, lang, ignoreEvents);
    await startSession(memory, "unsaved answers before clear", true);
    await submitAnswer(memory);
    assert.equal(await memory.evaluate(() => localStorage.getItem(window.CONFIG.storageKey)), null, `${lang}: failed initial saves leave the response key absent`);
    const beforeMarker = await memory.evaluate(() => localStorage.getItem(window.CONFIG.storageKey + ":clear-epoch"));
    const owner = await open(context, origin, lang);
    const ownerClear = await owner.evaluate(async () => ({
      result: await window.__TEST__.clearAllData(),
      marker: localStorage.getItem(window.CONFIG.storageKey + ":clear-epoch"),
      raw: localStorage.getItem(window.CONFIG.storageKey),
      status: document.querySelector('#setup-area [role="status"]').textContent,
    }));
    assert.equal(ownerClear.result, true, `${lang}: fixture clearing must succeed; ${JSON.stringify(ownerClear)}`);
    assert.equal(ownerClear.raw, null, `${lang}: fixture clearing must remove saved responses`);
    assert.notEqual(ownerClear.marker, beforeMarker, `${lang}: fixture clearing must replace the previous marker`);
    if (!ignoreEvents) await memory.waitForFunction(() => !window.__TEST__.state.testInProgress);
    const saveResult = await memory.evaluate(async () => {
      window.restoreResponseWrites();
      return window.__TEST__.saveProgress();
    });
    const cleared = await memory.evaluate(() => ({
      active: window.__TEST__.state.testInProgress,
      answers: window.__TEST__.state.answers.length,
      raw: localStorage.getItem(window.CONFIG.storageKey),
      marker: localStorage.getItem(window.CONFIG.storageKey + ":clear-epoch"),
      status: document.getElementById("persistence-status").textContent,
      clock: {
        now: new Date().toISOString(),
        started: window.__TEST__.state.testStartTime && window.__TEST__.state.testStartTime.toISOString(),
        questionStarted: window.__TEST__.state.questionStartTime && window.__TEST__.state.questionStartTime.toISOString(),
        lastAnswer: window.__TEST__.state.answers.length ? window.__TEST__.state.answers[window.__TEST__.state.answers.length - 1].answerTime : null,
      },
    }));
    const diagnostic = { ignoreEvents, beforeMarker, ownerClear, saveResult, cleared: { ...cleared, raw: cleared.raw === null ? null : { savedAnswers: JSON.parse(cleared.raw).answers.length } } };
    assert.equal(cleared.active, false, `${lang}: ${ignoreEvents ? "pre-write check" : "marker event"} ends an unsaved session after another tab clears; ${JSON.stringify(diagnostic)}`);
    assert.equal(cleared.answers, 0, `${lang}: cleared unsaved responses cannot return from memory`);
    assert.equal(cleared.raw, null, `${lang}: retry cannot resurrect responses after cross-tab clearing`);

    await startSession(memory, "new session after clear", true);
    await submitAnswer(memory);
    const before = await memory.evaluate(() => localStorage.getItem(window.CONFIG.storageKey));
    await memory.evaluate(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: window.CONFIG.storageKey + ":clear-epoch", newValue: "delayed earlier event", storageArea: localStorage }));
      window.dispatchEvent(new StorageEvent("storage", { key: window.CONFIG.storageKey, newValue: null, storageArea: localStorage }));
    });
    assert.equal(await memory.evaluate(() => window.__TEST__.state.testInProgress), true, `${lang}: delayed clear marker event does not invalidate a newly started session`);
    assert.equal(await memory.evaluate(() => window.__TEST__.state.answers.length), 1, `${lang}: delayed response-key deletion event preserves new memory-only answers`);
    assert.equal(await memory.evaluate(() => localStorage.getItem(window.CONFIG.storageKey)), before, `${lang}: delayed clear marker event preserves the new save`);
    await owner.evaluate(() => window.__TEST__.clearAllData());
    await Promise.all([memory.close(), owner.close()]);
  }
}

async function clearRetryAndScopeCase(context, origin, lang) {
  const owner = await open(context, origin, lang, true);
  await startSession(owner, "old saved session");
  await submitAnswer(owner);
  const old = await owner.evaluate(() => localStorage.getItem(window.CONFIG.storageKey));
  await owner.evaluate((raw) => {
    window.__TEST__.resetState();
    window.__TEST__.showResumeScreen(JSON.parse(raw));
    const remove = Storage.prototype.removeItem;
    const get = Storage.prototype.getItem;
    let removed = false, failed = false;
    window.restoreClearReads = () => { Storage.prototype.removeItem = remove; Storage.prototype.getItem = get; };
    Storage.prototype.removeItem = function (key) {
      const result = remove.apply(this, arguments);
      if (this === localStorage && key === window.CONFIG.storageKey) removed = true;
      return result;
    };
    Storage.prototype.getItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey && removed && !failed) {
        failed = true;
        throw new DOMException("Read blocked after deletion", "SecurityError");
      }
      return get.apply(this, arguments);
    };
    document.getElementById("newSessionBtn").click();
  }, old);
  await owner.evaluate(() => window.__TEST__.whenPersistenceSettled());
  await owner.evaluate(() => window.restoreClearReads());
  assert.equal(await owner.evaluate(() => localStorage.getItem(window.CONFIG.storageKey)), null, `${lang}: failed read-back can follow a successful deletion`);
  const epoch = await owner.evaluate(() => localStorage.getItem(window.CONFIG.storageKey + ":clear-epoch"));
  const newer = await open(context, origin, lang, true);
  await startSession(newer, "new memory-only session", true);
  await submitAnswer(newer);
  const otherLang = lang === "en" ? "fr" : "en";
  const other = await open(context, origin, otherLang);
  await startSession(other, "other language memory-only session", true);
  await submitAnswer(other);

  await owner.evaluate(async () => {
    document.getElementById("newSessionBtn").click();
    await window.__TEST__.whenPersistenceSettled();
  });
  assert.ok(await owner.$("#participantIdInput"), `${lang}: retry verifies an already completed removal and returns to setup`);
  assert.equal(await owner.evaluate(() => localStorage.getItem(window.CONFIG.storageKey + ":clear-epoch")), epoch, `${lang}: deletion retry does not invalidate a newer memory-only session`);
  for (const page of [newer, other]) {
    await page.evaluate(async () => { window.restoreResponseWrites(); await window.__TEST__.saveProgress(); });
    const retained = await page.evaluate(() => ({ active: window.__TEST__.state.testInProgress, answers: JSON.parse(localStorage.getItem(window.CONFIG.storageKey)).answers.length }));
    assert.equal(retained.active, true, `${lang}: scoped clearing/retry preserves later and other-language sessions`);
    assert.equal(retained.answers, 1, `${lang}: later and other-language answers remain savable`);
  }
  await owner.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([owner.close(), newer.close(), other.close()]);
}

async function failedClearMarkerCase(context, origin, lang) {
  const page = await open(context, origin, lang);
  for (const mode of ["throw", "no-op", "read-back"]) {
    await page.evaluate(async (failure) => {
      const set = Storage.prototype.setItem;
      const get = Storage.prototype.getItem;
      const key = window.CONFIG.storageKey + ":clear-epoch";
      Storage.prototype.setItem = function (candidate) {
        if (this === localStorage && candidate === key) {
          if (failure === "throw") throw new DOMException("Marker denied", "QuotaExceededError");
          if (failure === "no-op") return;
        }
        return set.apply(this, arguments);
      };
      Storage.prototype.getItem = function (candidate) {
        if (this === localStorage && candidate === key && failure === "read-back") throw new DOMException("Marker verification denied", "SecurityError");
        return get.apply(this, arguments);
      };
      try { await window.__TEST__.clearAllData(); }
      finally { Storage.prototype.setItem = set; Storage.prototype.getItem = get; }
    }, mode);
    const status = await page.evaluate(() => ({ text: document.querySelector('#setup-area [role="status"]').textContent, expected: window.CONFIG.ui.alertClearDataFail }));
    assert.equal(status.text, status.expected, `${lang}: ${mode} clearing coordination failure is reported accurately`);
  }
  await page.evaluate(() => window.__TEST__.clearAllData());
  await page.close();
}

async function scopedClearGenerationCase(context, origin, lang) {
  const owner = await open(context, origin, lang);
  const completed = await open(context, origin, lang, true);
  await startSession(completed, "old memory-only completed results", true);
  const count = await completed.evaluate(() => window.__TEST__.state.totalQuestions);
  for (let i = 0; i < count; i++) await submitAnswer(completed);
  assert.ok(await completed.$("#newSessionBtn"), `${lang}: memory-only completed results have an explicit clear control`);
  const otherLang = lang === "en" ? "fr" : "en";
  const other = await open(context, origin, otherLang);
  await startSession(other, "other language before scoped clear", true);
  await submitAnswer(other);
  await startSession(owner, "saved session cleared by its owner");
  await submitAnswer(owner);
  await owner.evaluate(async () => {
    const raw = localStorage.getItem(window.CONFIG.storageKey);
    window.__TEST__.resetState();
    window.__TEST__.showResumeScreen(JSON.parse(raw));
    document.getElementById("newSessionBtn").click();
    await window.__TEST__.whenPersistenceSettled();
  });
  const epoch = await owner.evaluate(() => localStorage.getItem(window.CONFIG.storageKey + ":clear-epoch"));
  const newer = await open(context, origin, lang, true);
  await startSession(newer, "new memory-only session after scoped clear", true);
  await submitAnswer(newer);
  await completed.evaluate(async () => {
    document.getElementById("newSessionBtn").click();
    await window.__TEST__.whenPersistenceSettled();
  });
  assert.equal(await completed.evaluate(() => window.__TEST__.state.testEndTime), null, `${lang}: stale completed results recognize that their generation was already cleared`);
  assert.equal(await owner.evaluate(() => localStorage.getItem(window.CONFIG.storageKey + ":clear-epoch")), epoch, `${lang}: stale completed clear cannot invalidate a newer memory-only generation`);
  for (const page of [newer, other]) {
    await page.evaluate(async () => { window.restoreResponseWrites(); await window.__TEST__.saveProgress(); });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(window.CONFIG.storageKey)));
    assert.equal(saved.answers.length, 1, `${lang}: scoped clear preserves newer and other-language submitted answers`);
  }
  await owner.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([owner.close(), completed.close(), other.close(), newer.close()]);
}

async function scopedMarkerReadRetryCase(context, origin, lang) {
  const page = await open(context, origin, lang);
  await startSession(page, "retained after marker read failure");
  await submitAnswer(page);
  const raw = await page.evaluate(() => localStorage.getItem(window.CONFIG.storageKey));
  await page.evaluate((saved) => {
    window.__TEST__.resetState();
    window.__TEST__.showResumeScreen(JSON.parse(saved));
    const set = Storage.prototype.setItem;
    const get = Storage.prototype.getItem;
    const marker = window.CONFIG.storageKey + ":clear-epoch";
    let written = false, failed = false;
    window.restoreMarkerReads = () => { Storage.prototype.setItem = set; Storage.prototype.getItem = get; };
    Storage.prototype.setItem = function (key) {
      const result = set.apply(this, arguments);
      if (this === localStorage && key === marker) written = true;
      return result;
    };
    Storage.prototype.getItem = function (key) {
      if (this === localStorage && key === marker && written && !failed) {
        failed = true;
        throw new DOMException("Marker read-back blocked", "SecurityError");
      }
      return get.apply(this, arguments);
    };
    document.getElementById("newSessionBtn").click();
  }, raw);
  await page.evaluate(() => window.__TEST__.whenPersistenceSettled());
  await page.evaluate(() => window.restoreMarkerReads());
  assert.equal(await page.evaluate(() => localStorage.getItem(window.CONFIG.storageKey)), raw, `${lang}: marker verification failure preserves saved responses`);
  assert.ok(await page.$("#resumeBtn"), `${lang}: marker verification failure keeps recovery controls`);
  await page.evaluate(async () => {
    document.getElementById("newSessionBtn").click();
    await window.__TEST__.whenPersistenceSettled();
  });
  assert.equal(await page.evaluate(() => localStorage.getItem(window.CONFIG.storageKey)), null, `${lang}: scoped clear retry recognizes its own unverified marker and deletes the responses`);
  assert.ok(await page.$("#participantIdInput"), `${lang}: scoped clear retry returns to setup only after successful deletion`);
  await page.close();
}

async function clockRollbackAfterClearCase(context, origin, lang) {
  const memory = await open(context, origin, lang, true);
  await startSession(memory, "memory-only responses before clock rollback", true);
  await submitAnswer(memory);
  const owner = await open(context, origin, lang);
  assert.equal(await owner.evaluate(() => window.__TEST__.clearAllData()), true, `${lang}: clearing before clock rollback succeeds`);
  const retried = await memory.evaluate(async () => {
    const RealDate = window.Date;
    const set = Storage.prototype.setItem;
    let writes = 0;
    window.restoreResponseWrites();
    const restoredSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey) writes++;
      return restoredSet.apply(this, arguments);
    };
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [RealDate.now() - 120000])); }
      static now() { return RealDate.now() - 120000; }
    };
    try {
      const snapshotValid = !!window.__TEST__.validateSession(JSON.parse(window.__TEST__.buildProgressBackup()));
      const result = await window.__TEST__.saveProgress();
      return {
        snapshotValid,
        result,
        active: window.__TEST__.state.testInProgress,
        answers: window.__TEST__.state.answers.length,
        raw: localStorage.getItem(window.CONFIG.storageKey),
        status: document.querySelector('#setup-area [role="status"]')?.textContent,
        expectedStatus: window.CONFIG.ui.dataCleared,
        writes,
      };
    } finally { window.Date = RealDate; Storage.prototype.setItem = set; }
  });
  assert.equal(retried.snapshotValid, false, `${lang}: rollback makes the pending snapshot invalid before retry`);
  assert.equal(retried.active, false, `${lang}: explicit clearing invalidates an old session before refusing its clock-invalid snapshot; ${JSON.stringify(retried)}`);
  assert.equal(retried.answers, 0, `${lang}: clock rollback cannot retain responses after explicit clearing`);
  assert.equal(retried.raw, null, `${lang}: clock rollback cannot resurrect cleared responses`);
  assert.equal(retried.writes, 0, `${lang}: invalid/cleared snapshot never writes responses`);
  assert.equal(retried.status, retried.expectedStatus, `${lang}: retry explains that another tab cleared the session`);
  await Promise.all([memory.close(), owner.close()]);
}

module.exports = async function runReviewRegressions(browser) {
  const { server, origin } = await serveApplication();
  const context = await browser.createBrowserContext();
  try {
    console.log("\n--- Review regressions: recovery prompt storage pairing ---");
    for (const lang of ["en", "fr"]) {
      const page = await context.newPage();
      page.on("dialog", (dialog) => dialog.accept());
      await page.evaluateOnNewDocument(() => { window.__TEST__ = {}; window.alert = () => {}; });
      await page.goto(origin + "/" + lang + "/index.html", { waitUntil: "domcontentloaded" });
      await page.evaluate(async () => {
        document.getElementById("participantIdInput").value = "prompt race participant";
        document.querySelectorAll(".test-checkbox").forEach((box) => {
          box.checked = window.CONFIG.tests[Number(box.value)].name === "HADS";
        });
        document.getElementById("nextBtn").click();
        await window.__TEST__.whenPersistenceSettled();
      });
      for (let i = 0; i < 2; i++) {
        await page.waitForFunction(() => !document.getElementById("nextBtn").disabled);
        await page.evaluate(async () => {
          document.getElementById("option1").click();
          document.getElementById("nextBtn").click();
          await window.__TEST__.whenPersistenceSettled();
        });
        if (i === 0) await page.evaluate(() => { window.raceOldRaw = localStorage.getItem(window.CONFIG.storageKey); });
      }
      const records = await page.evaluate(() => ({ old: window.raceOldRaw, newer: localStorage.getItem(window.CONFIG.storageKey) }));
      // Another document can write between loadProgress's read and rendering the prompt.
      // Return the first read while replacing storage, reproducing that exact interleaving.
      await page.evaluateOnNewDocument(({ old, newer }) => {
        const get = Storage.prototype.getItem;
        const set = Storage.prototype.setItem;
        let injected = false;
        Storage.prototype.getItem = function (key) {
          if (!injected && this === localStorage && window.CONFIG && key === window.CONFIG.storageKey) {
            injected = true;
            set.call(this, key, newer);
            return old;
          }
          return get.apply(this, arguments);
        };
      }, records);
      await page.reload({ waitUntil: "domcontentloaded" });
      const prompt = await page.evaluate(() => ({ text: document.getElementById("setup-area").textContent, ui: window.CONFIG.ui }));
      assert.ok(prompt.text.includes(": 1 " + prompt.ui.resumeAnswers), `${lang}: prompt describes the exact first-read draft`);
      await page.evaluate(async () => {
        document.getElementById("newSessionBtn").click();
        await window.__TEST__.whenPersistenceSettled();
      });
      const protectedSave = await page.evaluate(() => ({ raw: localStorage.getItem(window.CONFIG.storageKey), status: document.getElementById("persistence-status").textContent, expected: window.CONFIG.ui.progressConflict }));
      assert.equal(protectedSave.raw, records.newer, `${lang}: prompt cannot clear an unseen competing revision`);
      assert.equal(protectedSave.status, protectedSave.expected, `${lang}: prompt explains the competing revision`);
      await page.evaluate(async () => {
        document.getElementById("resumeBtn").click();
        await window.__TEST__.whenPersistenceSettled();
      });
      assert.equal(await page.evaluate(() => window.__TEST__.state.answers.length), 2, `${lang}: stale prompt can resume the latest saved draft`);

      // Direct callers with only a parsed session must also refuse a different raw record.
      await page.evaluate(({ old, newer }) => {
        window.__TEST__.resetState();
        localStorage.setItem(window.CONFIG.storageKey, newer);
        window.__TEST__.showResumeScreen(JSON.parse(old));
        document.getElementById("newSessionBtn").click();
      }, records);
      await page.evaluate(() => window.__TEST__.whenPersistenceSettled());
      assert.equal(await page.evaluate(() => localStorage.getItem(window.CONFIG.storageKey)), records.newer, `${lang}: parsed-session prompt refuses to clear a different record`);

      const unavailable = await page.evaluate(async (newer) => {
        window.__TEST__.resetState();
        window.__TEST__.showResumeScreen(JSON.parse(newer));
        const incompatible = JSON.parse(newer);
        incompatible.revision = "different questionnaire revision";
        const raw = JSON.stringify(incompatible);
        localStorage.setItem(window.CONFIG.storageKey, raw);
        document.getElementById("resumeBtn").click();
        await window.__TEST__.whenPersistenceSettled();
        return {
          original: raw,
          current: localStorage.getItem(window.CONFIG.storageKey),
          backupVisible: !!document.getElementById("downloadStoredBackup"),
          startVisible: !!document.getElementById("participantIdInput"),
        };
      }, records.newer);
      assert.equal(unavailable.current, unavailable.original, `${lang}: stale Resume retains newly incompatible saved responses`);
      assert.equal(unavailable.backupVisible, true, `${lang}: stale Resume offers backup of newly incompatible saved responses`);
      assert.equal(unavailable.startVisible, false, `${lang}: incompatible saved responses require explicit clearing before setup`);
      // The direct incompatible-record mutation models a legacy writer. Remove
      // its deliberately stale coordination fixture before cleaning up.
      await page.evaluate(async () => {
        await window.__TEST__.resetAuthorityForFixture(window.CONFIG.storageKey);
        await window.__TEST__.clearAllData();
      });
      await page.close();
      console.log(`  ${lang}: load/render interleaving cannot delete unseen responses; latest draft remains resumable.`);
      await memoryOnlyClearCases(context, origin, lang);
      await clearRetryAndScopeCase(context, origin, lang);
      await scopedClearGenerationCase(context, origin, lang);
      await scopedMarkerReadRetryCase(context, origin, lang);
      await failedClearMarkerCase(context, origin, lang);
      await clockRollbackAfterClearCase(context, origin, lang);
      console.log(`  ${lang}: cross-tab clearing invalidates unsaved sessions even after clock rollback, delayed events preserve new sessions, scoped retry is idempotent, and marker failures are reported.`);
    }
    return 0;
  } catch (error) {
    console.error("  Review regression failed:", error.stack);
    return 1;
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
  }
};

module.exports.memoryOnlyClearCases = memoryOnlyClearCases;
module.exports.clockRollbackAfterClearCase = clockRollbackAfterClearCase;
