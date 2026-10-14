const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

async function serveApplication() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const target = path.resolve(ROOT, "." + pathname);
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
  page.on("dialog", (dialog) => dialog.accept());
  await page.evaluateOnNewDocument(({ denyOpen }) => {
    window.__TEST__ = {};
    window.auditAlerts = [];
    window.alert = (message) => window.auditAlerts.push(message);
    window.auditClockOffset = 0;
    const NativeDate = Date;
    window.Date = class AuditDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [NativeDate.now() + window.auditClockOffset])); }
      static now() { return NativeDate.now() + window.auditClockOffset; }
    };
    // The storage cache is allowed to update; only the app's early notification is suppressed.
    window.addEventListener("storage", (event) => event.stopImmediatePropagation(), true);
    const nativeGet = Storage.prototype.getItem;
    window.auditActualRaw = () => nativeGet.call(localStorage, window.CONFIG.storageKey);
    window.auditActualMarker = () => nativeGet.call(localStorage, window.CONFIG.storageKey + ":clear-epoch");
    window.restoreAuditStorage = () => {};
    window.restoreAuditCoordinator = () => {};
    if (denyOpen) {
      const open = IDBFactory.prototype.open;
      window.restoreAuditCoordinator = () => { IDBFactory.prototype.open = open; };
      IDBFactory.prototype.open = function () { throw new DOMException("Coordinator denied", "SecurityError"); };
    }
  }, { denyOpen: !!options.denyOpen });
  await page.goto(origin + "/" + lang + "/index.html", { waitUntil: "domcontentloaded" });
  return page;
}

async function settled(page) {
  await page.evaluate(() => window.__TEST__.whenPersistenceSettled());
}

async function start(page, participant, memoryOnly = false) {
  await page.bringToFront();
  await page.evaluate(async ({ id, failResponseWrites }) => {
    if (failResponseWrites) {
      const set = Storage.prototype.setItem;
      window.restoreAuditResponseWrites = () => { Storage.prototype.setItem = set; };
      Storage.prototype.setItem = function (key) {
        if (this === localStorage && key === window.CONFIG.storageKey) throw new DOMException("Responses full", "QuotaExceededError");
        return set.apply(this, arguments);
      };
    }
    document.getElementById("participantIdInput").value = id;
    document.querySelectorAll(".test-checkbox").forEach((box) => { box.checked = window.CONFIG.tests[Number(box.value)].name === "HADS"; });
    document.getElementById("nextBtn").click();
    await window.__TEST__.whenPersistenceSettled();
  }, { id: participant, failResponseWrites: memoryOnly });
}

async function answer(page, option = 0) {
  await page.waitForFunction(() => !document.getElementById("nextBtn").disabled, { polling: 50 });
  await page.evaluate(async (choice) => {
    document.getElementById("option" + choice).click();
    document.getElementById("nextBtn").click();
    await window.__TEST__.whenPersistenceSettled();
  }, option);
}

async function inspect(page) {
  return page.evaluate(() => ({
    text: document.getElementById("persistence-status").textContent, ui: window.CONFIG.ui,
    active: window.__TEST__.state.testInProgress, answers: window.__TEST__.state.answers.length,
    actualRaw: window.auditActualRaw(), retryVisible: !document.getElementById("retrySave").classList.contains("hidden"),
  }));
}

async function staleReads(page, raw, marker) {
  await page.evaluate(({ oldRaw, oldMarker }) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    let ownRaw;
    window.auditResponseWrites = 0;
    window.restoreAuditStorage = () => { Storage.prototype.getItem = get; Storage.prototype.setItem = set; };
    Storage.prototype.getItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey) return ownRaw === undefined ? oldRaw : ownRaw;
      if (this === localStorage && key === window.CONFIG.storageKey + ":clear-epoch") return oldMarker;
      return get.apply(this, arguments);
    };
    Storage.prototype.setItem = function (key, value) {
      const result = set.apply(this, arguments);
      if (this === localStorage && key === window.CONFIG.storageKey) {
        ownRaw = String(value);
        window.auditResponseWrites++;
      }
      return result;
    };
  }, { oldRaw: raw, oldMarker: marker });
}

async function cleanup(first, others = []) {
  for (const page of [first, ...others]) {
    await page.evaluate(() => {
      window.restoreAuditStorage();
      window.restoreAuditCoordinator();
      if (window.restoreAuditResponseWrites) window.restoreAuditResponseWrites();
    });
  }
  await first.evaluate(() => window.__TEST__.clearAllData());
  await Promise.all([first, ...others].map((page) => page.close()));
}

async function resumeSecond(context, origin, lang, first) {
  const second = await openPage(context, origin, lang);
  await second.evaluate(() => document.getElementById("resumeBtn").click());
  await settled(second);
  const baseline = await first.evaluate(() => ({ raw: window.auditActualRaw(), marker: window.auditActualMarker() }));
  return { second, baseline };
}

async function staleConcurrentWritersCase(context, origin, lang) {
  const first = await openPage(context, origin, lang);
  await start(first, "stale renderer writer fixture");
  const { second, baseline } = await resumeSecond(context, origin, lang, first);
  await Promise.all([staleReads(first, baseline.raw, baseline.marker), staleReads(second, baseline.raw, baseline.marker)]);
  await Promise.all([answer(first, 0), answer(second, 1)]);
  const views = await Promise.all([inspect(first), inspect(second)]);
  assert.equal(views.filter((item) => item.text === item.ui.progressSaved).length, 1, `${lang}: authoritative coordination allows exactly one winner despite two stale renderer caches`);
  assert.equal(views.filter((item) => item.text === item.ui.progressConflict).length, 1, `${lang}: the stale renderer receives a conflict instead of overwriting the winner`);
  const writes = await Promise.all([first, second].map((page) => page.evaluate(() => window.auditResponseWrites)));
  assert.equal(writes.reduce((sum, count) => sum + count, 0), 1, `${lang}: stale concurrent revisions produce only one response-storage write`);
  assert.ok(views.every((item) => item.answers === 1), `${lang}: both tabs retain their submitted response in memory`);
  for (const page of [first, second]) {
    const backup = await page.evaluate(() => JSON.parse(window.__TEST__.buildProgressBackup()));
    assert.equal(backup.answers.length, 1, `${lang}: a conflicted renderer can back up its submitted response`);
  }
  const pages = [first, second];
  const winner = views.findIndex((item) => item.text === item.ui.progressSaved);
  await cleanup(pages[winner], [pages[1 - winner]]);
}

async function staleClearGenerationCase(context, origin, lang) {
  const memory = await openPage(context, origin, lang);
  await start(memory, "unsaved responses before authoritative clear", true);
  await answer(memory, 1);
  const baseline = await memory.evaluate(() => ({ raw: window.auditActualRaw(), marker: window.auditActualMarker() }));
  assert.equal(baseline.raw, null, `${lang}: the clear fixture starts with memory-only responses`);
  const owner = await openPage(context, origin, lang);
  await owner.evaluate(() => window.__TEST__.clearAllData());
  await memory.evaluate(() => window.restoreAuditResponseWrites());
  await staleReads(memory, baseline.raw, baseline.marker);
  const saved = await memory.evaluate(() => window.__TEST__.saveProgress());
  const cleared = await inspect(memory);
  assert.equal(saved, false, `${lang}: authoritative clearing rejects a stale-cache save retry`);
  assert.equal(cleared.active, false, `${lang}: authoritative clearing ends the old memory-only generation`);
  assert.equal(cleared.answers, 0, `${lang}: explicitly cleared in-memory responses cannot return`);
  assert.equal(await memory.evaluate(() => window.auditResponseWrites), 0, `${lang}: a stale clear marker never permits response resurrection`);
  assert.equal(await owner.evaluate(() => window.auditActualRaw()), null, `${lang}: authoritative clearing keeps response storage empty`);
  await memory.evaluate(() => window.restoreAuditStorage());
  await start(memory, "new generation after authoritative clear");
  await answer(memory, 0);
  const fresh = await inspect(memory);
  assert.equal(fresh.text, fresh.ui.progressSaved, `${lang}: a new post-clear generation remains savable`);
  assert.equal(JSON.parse(fresh.actualRaw).answers.length, 1, `${lang}: the new generation retains its submitted response`);
  await cleanup(memory, [owner]);
}

async function staleEmptySavedPrefixCase(context, origin, lang) {
  const page = await openPage(context, origin, lang);
  await start(page, "saved prefix with a newer unsaved response");
  await answer(page, 0);
  const baseline = await page.evaluate(() => ({ raw: window.auditActualRaw(), marker: window.auditActualMarker() }));
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    window.restoreAuditResponseWrites = () => { Storage.prototype.setItem = set; };
    Storage.prototype.setItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey) throw new DOMException("Responses full", "QuotaExceededError");
      return set.apply(this, arguments);
    };
  });
  await answer(page, 1);
  assert.equal(await page.evaluate(() => window.__TEST__.state.answers.length), 2, `${lang}: the stale-absence fixture keeps one response beyond its saved prefix`);
  await page.evaluate(() => window.restoreAuditResponseWrites());
  await staleReads(page, null, baseline.marker);
  await page.waitForFunction(() => !document.getElementById("nextBtn").disabled, { polling: 50 });
  await page.evaluate(() => {
    document.getElementById("option0").click();
    document.getElementById("nextBtn").click();
  });
  await settled(page);
  const retained = await inspect(page);
  assert.equal(retained.active, true, `${lang}: unexplained cached absence cannot end a saved questionnaire session`);
  assert.equal(retained.answers, 2, `${lang}: unexplained cached absence preserves newer unsaved responses`);
  assert.equal(retained.actualRaw, baseline.raw, `${lang}: cached absence does not remove the actual saved prefix`);
  assert.equal(retained.text, retained.ui.progressConflict, `${lang}: cached absence reports a conflict instead of falsely claiming data was cleared`);
  assert.equal(await page.evaluate(() => JSON.parse(window.__TEST__.buildProgressBackup()).answers.length), 2, `${lang}: both saved and unsaved responses remain available in JSON backup`);
  assert.equal(await page.evaluate(() => window.auditResponseWrites), 0, `${lang}: unexplained cached absence never starts another response write`);
  await cleanup(page);
}

async function injectCoordinatorFailure(page, mode) {
  await page.evaluate((failure) => {
    const get = IDBObjectStore.prototype.get;
    const put = IDBObjectStore.prototype.put;
    const set = Storage.prototype.setItem;
    window.auditResponseWrites = 0;
    window.auditCoordinatorPuts = 0;
    window.restoreAuditCoordinator = () => {
      IDBObjectStore.prototype.get = get;
      IDBObjectStore.prototype.put = put;
      Storage.prototype.setItem = set;
    };
    Storage.prototype.setItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey) window.auditResponseWrites++;
      return set.apply(this, arguments);
    };
    IDBObjectStore.prototype.get = function () {
      if (failure === "read-throw") throw new DOMException("Coordinator read denied", "SecurityError");
      const request = get.apply(this, arguments);
      if (failure === "read-abort") this.transaction.abort();
      return request;
    };
    IDBObjectStore.prototype.put = function () {
      window.auditCoordinatorPuts++;
      if (failure === "reserve-throw" || failure === "confirm-throw" && window.auditCoordinatorPuts === 2) {
        throw new DOMException("Coordinator write denied", "QuotaExceededError");
      }
      const request = put.apply(this, arguments);
      if (failure === "reserve-abort" || failure === "confirm-abort" && window.auditCoordinatorPuts === 2) this.transaction.abort();
      return request;
    };
  }, mode);
}

async function coordinatorFailureCases(context, origin, lang) {
  for (const mode of ["read-throw", "read-abort", "reserve-throw", "reserve-abort"]) {
    const page = await openPage(context, origin, lang);
    await start(page, "coordinator failure " + mode);
    const baseline = await page.evaluate(() => window.auditActualRaw());
    await injectCoordinatorFailure(page, mode);
    await answer(page, 1);
    const failed = await inspect(page);
    assert.notEqual(failed.text, failed.ui.progressSaved, `${lang}: ${mode} never reports confirmed saving`);
    assert.equal(failed.answers, 1, `${lang}: ${mode} preserves the response in memory`);
    assert.equal(failed.actualRaw, baseline, `${lang}: ${mode} preserves the previously saved response prefix`);
    assert.equal(await page.evaluate(() => window.auditResponseWrites), 0, `${lang}: ${mode} prevents response writes without an authoritative reservation`);
    assert.equal(failed.retryVisible, true, `${lang}: ${mode} offers recovery by retry`);
    assert.equal(await page.evaluate(() => JSON.parse(window.__TEST__.buildProgressBackup()).answers.length), 1, `${lang}: ${mode} keeps JSON backup available`);
    await page.evaluate(() => window.restoreAuditCoordinator());
    await page.bringToFront();
    await page.locator("#retrySave").click();
    await settled(page);
    const retried = await inspect(page);
    assert.equal(retried.text, retried.ui.progressSaved, `${lang}: ${mode} recovers once coordinator access returns`);
    assert.equal(JSON.parse(retried.actualRaw).answers.length, 1, `${lang}: ${mode} retry saves the original response`);
    await cleanup(page);
  }
}

async function confirmationFailureCase(context, origin, lang, mode) {
  const first = await openPage(context, origin, lang);
  await start(first, "unconfirmed authoritative write");
  const { second, baseline } = await resumeSecond(context, origin, lang, first);
  await injectCoordinatorFailure(first, mode);
  await answer(first, 0);
  const failed = await inspect(first);
  assert.notEqual(failed.text, failed.ui.progressSaved, `${lang}: failed final coordination never claims a verified save`);
  assert.equal(failed.retryVisible, true, `${lang}: failed final coordination offers retry`);
  assert.equal(await first.evaluate(() => window.auditResponseWrites), 1, `${lang}: confirmation failure occurs after the local response write lands`);
  assert.equal(JSON.parse(failed.actualRaw).answers.length, 1, `${lang}: a landed but unconfirmed response remains in browser storage`);
  await staleReads(second, baseline.raw, baseline.marker);
  await answer(second, 1);
  const competing = await inspect(second);
  assert.equal(competing.text, competing.ui.progressConflict, `${lang}: another stale renderer cannot overwrite an unconfirmed authoritative reservation`);
  assert.equal(await second.evaluate(() => window.auditResponseWrites), 0, `${lang}: the unconfirmed write remains protected against stale response writes`);
  await first.evaluate(() => window.restoreAuditCoordinator());
  await first.bringToFront();
  await first.locator("#retrySave").click();
  await settled(first);
  const retried = await inspect(first);
  assert.equal(retried.text, retried.ui.progressSaved, `${lang}: the original writer retries its landed response without a false conflict`);
  assert.equal(JSON.parse(retried.actualRaw).answers[0].optionIndex, 0, `${lang}: confirmation retry keeps the original writer's response`);
  await cleanup(first, [second]);
}

async function coordinatorOpenRecoveryCase(context, origin, lang) {
  const page = await openPage(context, origin, lang, { denyOpen: true });
  await start(page, "coordinator initially unavailable");
  await answer(page, 1);
  const failed = await inspect(page);
  assert.notEqual(failed.text, failed.ui.progressSaved, `${lang}: denied IndexedDB open is visible instead of reported as Saved`);
  assert.equal(failed.actualRaw, null, `${lang}: denied IndexedDB open never performs an uncoordinated response write`);
  assert.equal(failed.answers, 1, `${lang}: denied IndexedDB open keeps submitted responses in memory`);
  assert.equal(failed.retryVisible, true, `${lang}: denied IndexedDB open offers retry`);
  await page.evaluate(() => window.restoreAuditCoordinator());
  await page.bringToFront();
  await page.locator("#retrySave").click();
  await settled(page);
  const restored = await inspect(page);
  assert.equal(restored.text, restored.ui.progressSaved, `${lang}: retry can reopen IndexedDB after an initial denied open`);
  assert.equal(JSON.parse(restored.actualRaw).answers.length, 1, `${lang}: reopened coordinator saves the retained response`);
  await cleanup(page);
}

async function clockChangesDuringAuthorityReadCase(context, origin, lang) {
  const page = await openPage(context, origin, lang);
  await start(page, "clock changes during coordinator read");
  const baseline = await page.evaluate(() => window.auditActualRaw());
  await page.evaluate(() => {
    const get = IDBObjectStore.prototype.get;
    const set = Storage.prototype.setItem;
    let shifted = false;
    window.auditResponseWrites = 0;
    window.restoreAuditCoordinator = () => {
      IDBObjectStore.prototype.get = get;
      Storage.prototype.setItem = set;
      window.auditClockOffset = 0;
    };
    IDBObjectStore.prototype.get = function () {
      const request = get.apply(this, arguments);
      request.addEventListener("success", () => {
        if (!shifted) { shifted = true; window.auditClockOffset = -120000; }
      });
      return request;
    };
    Storage.prototype.setItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey) window.auditResponseWrites++;
      return set.apply(this, arguments);
    };
  });
  await answer(page, 1);
  const paused = await inspect(page);
  assert.equal(paused.text, paused.ui.clockChanged, `${lang}: clock change during an asynchronous authority read remains visible`);
  assert.equal(paused.actualRaw, baseline, `${lang}: asynchronous authority work cannot write a snapshot invalidated by a clock correction`);
  assert.equal(await page.evaluate(() => window.auditResponseWrites), 0, `${lang}: snapshot timing is checked again immediately before the response write`);
  assert.equal(await page.evaluate(() => JSON.parse(window.__TEST__.buildProgressBackup()).answers.length), 1, `${lang}: clock change during coordinator work preserves submitted backup recovery`);
  assert.equal(paused.retryVisible, true, `${lang}: clock correction during coordination offers retry`);
  await page.evaluate(() => window.restoreAuditCoordinator());
  await page.bringToFront();
  await page.locator("#retrySave").click();
  await settled(page);
  const retried = await inspect(page);
  assert.equal(retried.text, retried.ui.progressSaved, `${lang}: corrected clock retries the same authority reservation safely`);
  assert.equal(JSON.parse(retried.actualRaw).answers.length, 1, `${lang}: corrected asynchronous save retains the original response`);
  await cleanup(page);
}

async function responseFreeAuthorityCase(context, origin, lang) {
  const page = await openPage(context, origin, lang);
  await start(page, "participant never copied into coordinator metadata");
  await answer(page, 1);
  const metadata = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("psychometric-coordination", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("sessions", "readonly");
      const rows = transaction.objectStore("sessions").getAll();
      transaction.onabort = () => { db.close(); reject(transaction.error || new Error("Metadata read aborted")); };
      transaction.oncomplete = () => { db.close(); resolve({ text: JSON.stringify(rows.result), question: window.__TEST__.state.answers[0].question }); };
    };
  }));
  assert.equal(metadata.text.includes("participant never copied into coordinator metadata"), false, `${lang}: authoritative coordination stores no participant identity`);
  assert.equal(metadata.text.includes(metadata.question), false, `${lang}: authoritative coordination stores no response wording`);
  assert.equal(metadata.text.includes('"answers"'), false, `${lang}: authoritative coordination creates no second response store`);
  await cleanup(page);
}

async function staleEmptyClearCase(context, origin, lang) {
  const owner = await openPage(context, origin, lang);
  await start(owner, "saved responses must survive a falsely empty clearer cache");
  await answer(owner, 1);
  const original = await owner.evaluate(() => window.auditActualRaw());
  const clearer = await openPage(context, origin, lang);
  await clearer.evaluate(() => {
    const get = Storage.prototype.getItem;
    const remove = Storage.prototype.removeItem;
    window.restoreAuditStorage = () => { Storage.prototype.getItem = get; Storage.prototype.removeItem = remove; };
    Storage.prototype.getItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey) return null;
      return get.apply(this, arguments);
    };
    Storage.prototype.removeItem = function (key) {
      // Chromium skips the backend deletion when its renderer cache says the key is absent.
      if (this === localStorage && key === window.CONFIG.storageKey) return;
      return remove.apply(this, arguments);
    };
  });
  const result = await clearer.evaluate(() => window.__TEST__.clearAllData());
  assert.equal(result, false, `${lang}: a stale empty cache cannot confirm clearing an authoritative nonempty response record`);
  assert.equal(await owner.evaluate(() => window.auditActualRaw()), original, `${lang}: the stale clearer has not actually removed the stored responses`);
  const failure = await clearer.evaluate(() => ({ text: document.querySelector('#setup-area [role="status"]').textContent, expected: window.CONFIG.ui.alertClearDataFail }));
  assert.equal(failure.text, failure.expected, `${lang}: stale empty deletion reports an accurate clearing failure`);
  const newcomer = await openPage(context, origin, lang);
  await newcomer.evaluate(() => { window.__TEST__.resetState(); window.__TEST__.showSetupScreen(); });
  await staleReads(newcomer, null, await clearer.evaluate(() => window.auditActualMarker()));
  await start(newcomer, "new tab with stale absence during an unconfirmed clear");
  const pending = await inspect(newcomer);
  assert.notEqual(pending.text, pending.ui.progressSaved, `${lang}: foreign pending clearing cannot be confirmed from a stale empty cache`);
  assert.equal(await newcomer.evaluate(() => window.auditResponseWrites), 0, `${lang}: foreign pending clearing never authorizes replacing retained responses`);
  assert.equal(await owner.evaluate(() => window.auditActualRaw()), original, `${lang}: a foreign stale cache cannot replace responses retained by a failed clear`);
  await clearer.evaluate(() => window.restoreAuditStorage());
  const retried = await clearer.evaluate(() => window.__TEST__.clearAllData());
  assert.equal(retried, true, `${lang}: explicit clearing retry succeeds after fresh storage access returns`);
  assert.equal(await clearer.evaluate(() => window.auditActualRaw()), null, `${lang}: explicit retry removes the retained response record`);
  await cleanup(clearer, [owner, newcomer]);
}

async function resetDuringAuthorityWorkCase(context, origin, lang) {
  const page = await openPage(context, origin, lang);
  await start(page, "old responses cleared during asynchronous coordination");
  await page.evaluate(() => {
    const digest = SubtleCrypto.prototype.digest;
    const set = Storage.prototype.setItem;
    let held = false;
    window.auditResponseWrites = 0;
    window.restoreAuditDigest = () => { SubtleCrypto.prototype.digest = digest; };
    window.restoreAuditCoordinator = () => { SubtleCrypto.prototype.digest = digest; Storage.prototype.setItem = set; };
    SubtleCrypto.prototype.digest = function () {
      const operation = digest.apply(this, arguments);
      if (held) return operation;
      held = true;
      window.auditDigestEntered = true;
      return new Promise((resolve, reject) => { window.releaseAuditDigest = () => operation.then(resolve, reject); });
    };
    Storage.prototype.setItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey) window.auditResponseWrites++;
      return set.apply(this, arguments);
    };
  });
  await page.waitForFunction(() => !document.getElementById("nextBtn").disabled, { polling: 50 });
  await page.evaluate(() => {
    document.getElementById("option1").click();
    document.getElementById("nextBtn").click();
  });
  await page.waitForFunction(() => window.auditDigestEntered);
  const lockHeld = await page.evaluate(async () => (await navigator.locks.query()).held.some((lock) => lock.name === "psychometric-session-storage"));
  assert.equal(lockHeld, true, `${lang}: the cancellation fixture holds the storage lock before resetting`);
  await page.evaluate(() => { window.pendingAuditClear = window.__TEST__.clearAllData(); });
  await page.evaluate(() => { window.restoreAuditDigest(); window.releaseAuditDigest(); });
  await settled(page);
  const cleared = await inspect(page);
  assert.equal(await page.evaluate(() => window.auditResponseWrites), 0, `${lang}: resetting while coordination awaits prevents all old response writes`);
  assert.equal(cleared.active, false, `${lang}: asynchronous authority work cannot reactivate a cleared session`);
  assert.equal(cleared.answers, 0, `${lang}: asynchronous authority work cannot restore cleared responses`);
  assert.equal(cleared.actualRaw, null, `${lang}: queued clearing removes the old saved prefix after cancellation`);
  await start(page, "fresh session after cancelled coordinator work");
  await answer(page, 0);
  const fresh = await inspect(page);
  assert.equal(fresh.text, fresh.ui.progressSaved, `${lang}: cancellation of old authority work preserves new-generation saving`);
  assert.equal(JSON.parse(fresh.actualRaw).participantId, "fresh session after cancelled coordinator work", `${lang}: cancelled authority work never replaces the new participant's record`);
  await cleanup(page);
}

async function abandonedReservationRecoveryCase(context, origin, lang) {
  const owner = await openPage(context, origin, lang);
  await start(owner, "retained prefix after an abandoned reservation");
  await answer(owner, 0);
  const original = await owner.evaluate(() => window.auditActualRaw());
  await owner.evaluate(() => {
    const set = Storage.prototype.setItem;
    const put = IDBObjectStore.prototype.put;
    let writes = 0;
    Storage.prototype.setItem = function (key) {
      if (this === localStorage && key === window.CONFIG.storageKey) throw new DOMException("Response write interrupted", "QuotaExceededError");
      return set.apply(this, arguments);
    };
    IDBObjectStore.prototype.put = function () {
      // Commit the reservation, then prevent cancellation after the local write fails.
      // The durable state matches a tab eviction between reservation and response write.
      if (++writes === 2) throw new DOMException("Reservation cancellation interrupted", "QuotaExceededError");
      return put.apply(this, arguments);
    };
  });
  await answer(owner, 1);
  assert.equal(await owner.evaluate(() => window.auditActualRaw()), original, `${lang}: abandoned reservation retains the prior saved response prefix`);
  await owner.close();
  const recovered = await openPage(context, origin, lang);
  await recovered.evaluate(() => document.getElementById("resumeBtn").click());
  await settled(recovered);
  const fallback = await recovered.evaluate(() => ({
    backup: !!document.getElementById("downloadStoredBackup"), active: window.__TEST__.state.testInProgress,
    raw: window.auditActualRaw(),
  }));
  assert.equal(fallback.backup, true, `${lang}: a new tab can back up the retained prefix after its reservation owner disappears`);
  assert.equal(fallback.active, false, `${lang}: abandoned authority reservation never starts an unverified questionnaire`);
  assert.equal(fallback.raw, original, `${lang}: abandoned authority reservation never deletes retained responses`);
  const downloaded = await recovered.evaluate(async () => {
    const create = URL.createObjectURL;
    const click = HTMLAnchorElement.prototype.click;
    let blob;
    URL.createObjectURL = (value) => { blob = value; return "blob:abandoned-reservation-backup"; };
    HTMLAnchorElement.prototype.click = function () {};
    try {
      document.getElementById("downloadStoredBackup").click();
      await window.__TEST__.whenPersistenceSettled();
      return blob && await blob.text();
    } finally { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; }
  });
  assert.equal(downloaded, original, `${lang}: abandoned reservation recovery exports the exact original saved prefix`);
  const cleared = await recovered.evaluate(() => window.__TEST__.clearAllData());
  assert.equal(cleared, true, `${lang}: explicit global clearing can remove a synchronized retained prefix despite an abandoned target hash`);
  assert.equal(await recovered.evaluate(() => window.auditActualRaw()), null, `${lang}: clearing an abandoned reservation removes its retained response record`);
  await start(recovered, "fresh participant after abandoned reservation recovery");
  await answer(recovered, 0);
  const fresh = await inspect(recovered);
  assert.equal(fresh.text, fresh.ui.progressSaved, `${lang}: explicit clearing restores new-session saving after an abandoned reservation`);
  assert.equal(JSON.parse(fresh.actualRaw).participantId, "fresh participant after abandoned reservation recovery", `${lang}: abandoned reservations cannot reappear in a new participant's save`);
  await cleanup(recovered);
}

module.exports = async function runAuthorityRegressions(browser) {
  const { server, origin } = await serveApplication();
  const context = await browser.createBrowserContext();
  try {
    console.log("\n--- Authoritative storage coordination with deliberately stale renderer caches ---");
    for (const lang of ["en", "fr"]) {
      await staleConcurrentWritersCase(context, origin, lang);
      await staleClearGenerationCase(context, origin, lang);
      await staleEmptySavedPrefixCase(context, origin, lang);
      await coordinatorFailureCases(context, origin, lang);
      for (const mode of ["confirm-throw", "confirm-abort"]) await confirmationFailureCase(context, origin, lang, mode);
      await coordinatorOpenRecoveryCase(context, origin, lang);
      await clockChangesDuringAuthorityReadCase(context, origin, lang);
      await responseFreeAuthorityCase(context, origin, lang);
      await staleEmptyClearCase(context, origin, lang);
      await resetDuringAuthorityWorkCase(context, origin, lang);
      await abandonedReservationRecoveryCase(context, origin, lang);
      console.log(`  ${lang}: stale caches cannot overwrite or resurrect responses; coordinator read, reservation, confirmation, and opening failures recover safely.`);
    }
    return 0;
  } catch (error) {
    console.error("  Authority regression failed:", error.stack);
    return 1;
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
  }
};

module.exports.staleConcurrentWritersCase = staleConcurrentWritersCase;
module.exports.staleClearGenerationCase = staleClearGenerationCase;
