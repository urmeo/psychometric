(function () {
  "use strict";

  var config = window.CONFIG || {};
  var ui = config.ui || {};
  var allTests = Array.isArray(config.tests) ? config.tests : [];
  var SESSION_VERSION = 1;
  var sessionGeneration = 0;
  var unavailableSavedRaw = null;
  var loadedSessionRaw = null;
  var progressPersisted = false;
  var completedPersisted = false;
  var storageSnapshot = null;
  var attemptedSnapshot = null;
  var persistenceBlocked = false;
  var persistenceQueue = Promise.resolve();
  var writerId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  var writeSequence = 0;
  var latestSaveRequest = 0;
  var clearSequence = 0;
  var clearEpochSnapshot;
  var authorityDatabase = null;
  var authoritySnapshot;
  var authorityCapture = Promise.resolve(null);
  var authorityCapturePending = false;
  var authorityCaptureSerial = 0;
  var attemptedAuthorityClear = null;
  var authorityClearProofs = {};
  var responseClockBlocked = false;
  var state = {
    currentTestIndex: 0,
    currentQuestionIndex: 0,
    totalQuestions: 0,
    answers: [],
    testStartTime: null,
    testEndTime: null,
    questionStartTime: null,
    testInProgress: false,
    participantId: "",
    tests: [],
  };

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function validDate(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
  }
  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return document.querySelectorAll(selector); }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "text") node.textContent = attrs[key];
      else if (key === "className") node.className = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (typeof child === "string") node.appendChild(document.createTextNode(child));
      else if (child) node.appendChild(child);
    });
    return node;
  }
  function empty(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function hide(node) { if (node) node.classList.add("hidden"); }
  function show(node) { if (node) node.classList.remove("hidden"); }
  function testByName(name) {
    return allTests.find(function (test) { return test.name === name; });
  }

  function resetState() {
    sessionGeneration++;
    progressPersisted = false;
    completedPersisted = false;
    unavailableSavedRaw = null;
    loadedSessionRaw = null;
    storageSnapshot = null;
    attemptedSnapshot = null;
    persistenceBlocked = false;
    clearEpochSnapshot = undefined;
    attemptedAuthorityClear = null;
    hide($("#persistence-area"));
    state.currentTestIndex = 0;
    state.currentQuestionIndex = 0;
    state.totalQuestions = 0;
    state.answers = [];
    state.testStartTime = null;
    state.testEndTime = null;
    state.questionStartTime = null;
    state.testInProgress = false;
    state.participantId = "";
    state.tests = [];
    captureClearEpoch();
  }

  function configSignature() {
    return JSON.stringify({
      lang: config.lang,
      revision: config.revision,
      tests: allTests.map(function (test) {
        return { name: test.name, questions: test.questions, metadata: config.testMetadata[test.name] };
      }),
      scoring: config.scoring,
    });
  }

  function clearEpochKey(storageKey) { return storageKey + ":clear-epoch"; }
  function captureClearEpoch() {
    try { clearEpochSnapshot = localStorage.getItem(clearEpochKey(config.storageKey)); }
    catch (error) { clearEpochSnapshot = undefined; }
    var generation = sessionGeneration;
    var capture = ++authorityCaptureSerial;
    authoritySnapshot = undefined;
    authorityCapturePending = true;
    authorityCapture = readAuthority(config.storageKey).then(function (record) {
      if (generation === sessionGeneration && capture === authorityCaptureSerial) { authoritySnapshot = record; authorityCapturePending = false; }
      return record;
    }, function (error) {
      if (generation === sessionGeneration && capture === authorityCaptureSerial) authorityCapturePending = false;
      throw error;
    });
    authorityCapture.catch(function () { });
  }
  function coordinationError(message, unavailable) {
    var error = new Error(message);
    if (unavailable) error.storageUnavailable = true;
    return error;
  }
  function openAuthority() {
    if (!window.indexedDB) return Promise.reject(coordinationError("Safe storage coordination unavailable", true));
    if (!authorityDatabase) {
      authorityDatabase = new Promise(function (resolve, reject) {
        var request;
        try { request = indexedDB.open("psychometric-coordination", 1); } catch (error) { reject(error); return; }
        request.onupgradeneeded = function () {
          if (!request.result.objectStoreNames.contains("sessions")) request.result.createObjectStore("sessions", { keyPath: "key" });
        };
        request.onerror = function () { reject(request.error || coordinationError("Coordination database unavailable")); };
        request.onblocked = function () { reject(coordinationError("Coordination database blocked")); };
        request.onsuccess = function () {
          var database = request.result;
          database.onversionchange = function () { database.close(); authorityDatabase = null; };
          resolve(database);
        };
      }).catch(function (error) { authorityDatabase = null; throw error; });
    }
    return authorityDatabase;
  }
  function authorityTransaction(key, mode, action) {
    return openAuthority().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction, result, failure;
        try {
          transaction = database.transaction("sessions", mode);
          var store = transaction.objectStore("sessions");
          var request = store.get(key);
          request.onsuccess = function () {
            try { result = action(request.result || null, store); }
            catch (error) { failure = error; transaction.abort(); }
          };
          request.onerror = function () { failure = request.error; };
          transaction.oncomplete = function () { resolve(result); };
          transaction.onabort = function () { reject(failure || transaction.error || coordinationError("Coordination transaction aborted")); };
          transaction.onerror = function () { failure = failure || transaction.error; };
        } catch (error) { reject(error); }
      });
    });
  }
  function validAuthority(record) {
    function hash(value) { return value === null || typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
    if (record === null) return true;
    return isObject(record) && typeof record.key === "string" && Number.isInteger(record.revision) && record.revision > 0 &&
      (record.epoch === null || typeof record.epoch === "string") && hash(record.rawHash) &&
      (record.pending === null || isObject(record.pending) && typeof record.pending.token === "string" && typeof record.pending.owner === "string" && hash(record.pending.targetHash) && typeof record.pending.clear === "boolean");
  }
  function readAuthority(key) {
    return authorityTransaction(key, "readonly", function (record) {
      if (!validAuthority(record)) throw coordinationError("Invalid coordination record");
      return record;
    });
  }
  function hashRaw(raw) {
    if (raw === null) return Promise.resolve(null);
    if (!window.crypto || !crypto.subtle || typeof TextEncoder !== "function") return Promise.reject(coordinationError("Safe storage coordination unavailable", true));
    // JSON quoting preserves distinct lone UTF-16 surrogates in original raw backups.
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(raw))).then(function (digest) {
      return Array.prototype.map.call(new Uint8Array(digest), function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
    });
  }
  function authorityEpoch(record) { return record ? record.epoch : clearEpochSnapshot; }
  function effectiveHash(record) { return record && record.pending ? record.pending.targetHash : record && record.rawHash; }
  function sameAuthority(left, right) {
    if (!left || !right) return left === right;
    return left.revision === right.revision && left.epoch === right.epoch && left.rawHash === right.rawHash &&
      (left.pending ? left.pending.token : null) === (right.pending ? right.pending.token : null);
  }
  function setAuthoritySnapshot(record) {
    authorityCaptureSerial++;
    authoritySnapshot = record;
    authorityCapturePending = false;
    authorityCapture = Promise.resolve(record);
    if (record) clearEpochSnapshot = record.epoch;
  }
  function authorityConflict(record, baseline) {
    var error = coordinationError("Saved session changed in another tab");
    error.authorityConflict = true;
    error.authorityCleared = authorityEpoch(record) !== authorityEpoch(baseline);
    error.authorityRecord = record;
    return error;
  }
  function reportAuthorityFailure(error) {
    if (error.authorityCleared) {
      resetState();
      if (error.authorityRecord && error.authorityRecord.pending && error.authorityRecord.pending.clear) showSetupScreen(ui.alertClearDataFail);
      else if (effectiveHash(error.authorityRecord) === null) showSetupScreen(ui.dataCleared);
      else showStoredSession();
      return false;
    }
    if (error.authorityConflict) return blockCompetingSession();
    return persistenceFailure(error);
  }
  function ensureAuthority(expectedRaw) {
    var generation = sessionGeneration;
    return authorityCapture.catch(function () { }).then(async function () {
      if (generation !== sessionGeneration) throw coordinationError("Session changed while coordinating storage");
      if (authoritySnapshot !== undefined) return authoritySnapshot;
      var current = await readAuthority(config.storageKey);
      var expectedHash = await hashRaw(expectedRaw);
      if (clearEpochSnapshot === undefined) throw coordinationError("Clear coordination unavailable", true);
      if (current && current.epoch !== clearEpochSnapshot) throw authorityConflict(current, { epoch: clearEpochSnapshot });
      if (current && (effectiveHash(current) !== expectedHash || current.pending && current.pending.clear)) throw authorityConflict(current, null);
      if (generation !== sessionGeneration) throw coordinationError("Session changed while coordinating storage");
      authoritySnapshot = current;
      return current;
    });
  }
  function assertAuthority(record, baseline, expectedHash, attemptedHash, clearing) {
    if (!validAuthority(record)) throw coordinationError("Invalid coordination record");
    var confirmedPending = record && baseline && !record.pending && baseline.pending && record.revision === baseline.revision && record.epoch === baseline.epoch && record.rawHash === baseline.pending.targetHash;
    if (!sameAuthority(record, baseline) && !confirmedPending) throw authorityConflict(record, baseline);
    if (!record) return;
    if (record.pending) {
      if (record.pending.owner === writerId) {
        if (clearing && record.pending.clear) return;
        if (!record.pending.clear && (expectedHash === record.rawHash || attemptedHash !== null && attemptedHash === record.pending.targetHash)) return;
      } else if (!record.pending.clear && expectedHash === record.pending.targetHash) return;
      else if (clearing && record.pending.clear && expectedHash === record.rawHash) return;
      if (!clearing && record.pending.clear && expectedHash === null) throw coordinationError("Clearing has not been verified; responses remain in memory");
      throw authorityConflict(record, baseline);
    }
    if (record.rawHash !== expectedHash) throw authorityConflict(record, baseline);
  }
  function reserveAuthority(key, baseline, expectedHash, attemptedHash, targetHash, epoch, clearing, unconditional) {
    return authorityTransaction(key, "readwrite", function (record, store) {
      if (!validAuthority(record)) throw coordinationError("Invalid coordination record");
      if (!unconditional) assertAuthority(record, baseline, expectedHash, attemptedHash, clearing);
      var priorHash = record ? record.pending && !record.pending.clear && (unconditional || expectedHash === record.pending.targetHash) ? record.pending.targetHash : record.rawHash : expectedHash;
      var reserved = {
        key: key, revision: record ? record.revision + 1 : 1,
        epoch: clearing ? epoch : record ? record.epoch : clearEpochSnapshot,
        rawHash: priorHash,
        pending: { token: writerId + ":reservation:" + (++writeSequence), owner: writerId, targetHash: targetHash, clear: !!clearing },
      };
      store.put(reserved);
      return reserved;
    });
  }
  function confirmAuthority(reserved) {
    return authorityTransaction(reserved.key, "readwrite", function (record, store) {
      if (!sameAuthority(record, reserved)) throw authorityConflict(record, reserved);
      var confirmed = { key: record.key, revision: record.revision, epoch: record.epoch, rawHash: record.pending.targetHash, pending: null };
      store.put(confirmed);
      return confirmed;
    });
  }
  function cancelAuthority(reserved, baseline) {
    return authorityTransaction(reserved.key, "readwrite", function (record, store) {
      if (!sameAuthority(record, reserved)) throw authorityConflict(record, reserved);
      if (baseline) store.put(baseline);
      else store.delete(reserved.key);
      return baseline;
    });
  }
  async function checkClearEpoch() {
    var baseline = await ensureAuthority(storageSnapshot);
    var current = await readAuthority(config.storageKey);
    if (authorityEpoch(current) !== authorityEpoch(baseline)) throw authorityConflict(current, baseline);
    return true;
  }
  async function authorityAccess(raw, backup) {
    var baseline = await ensureAuthority(raw);
    var current = await readAuthority(config.storageKey);
    if (authorityEpoch(current) !== authorityEpoch(baseline)) throw authorityConflict(current, baseline);
    if (current && !current.pending && current.rawHash === null && raw !== null) {
      var cleared = authorityConflict(current, baseline);
      cleared.authorityCleared = true;
      throw cleared;
    }
    if (backup && current && current.pending && current.pending.clear && await hashRaw(raw) !== current.rawHash) {
      throw coordinationError("The original saved data has not synchronized after the clearing failure");
    }
    if (!backup && current) {
      var rawHash = await hashRaw(raw);
      if (current.pending && current.pending.clear || effectiveHash(current) !== rawHash) throw authorityConflict(current, baseline);
    }
    return current;
  }
  function nextClearEpoch() { return writerId + ":clear:" + (++clearSequence); }
  function writeClearEpoch(storageKey, epoch) {
    var key = clearEpochKey(storageKey);
    localStorage.setItem(key, epoch);
    if (localStorage.getItem(key) !== epoch) throw new Error("Clear coordination verification failed");
  }

  function canonicalAnswer(answer, test, questionIndex, checkTimes) {
    if (!isObject(answer) || answer.test !== test.name || answer.questionIndex !== questionIndex) return null;
    var question = test.questions[questionIndex - 1];
    if (!question || !Number.isInteger(answer.optionIndex) || answer.optionIndex < 0 || answer.optionIndex >= question.options.length) return null;
    if (answer.question !== question.q || answer.answer !== question.options[answer.optionIndex] || answer.score !== question.scores[answer.optionIndex]) return null;
    var description = answer.description === undefined ? "" : answer.description;
    if (typeof description !== "string" || (!question.description && description !== "")) return null;
    if (checkTimes) {
      if (!Number.isFinite(answer.time) || answer.time < 0 || !validDate(answer.questionStartTime) || !validDate(answer.answerTime)) return null;
      var elapsed = (Date.parse(answer.answerTime) - Date.parse(answer.questionStartTime)) / 1000;
      if (elapsed < 0 || Math.abs(elapsed - answer.time) > 0.001) return null;
    }
    return {
      test: test.name,
      questionIndex: questionIndex,
      optionIndex: answer.optionIndex,
      question: question.q,
      answer: question.options[answer.optionIndex],
      description: description,
      score: question.scores[answer.optionIndex],
      time: answer.time,
      questionStartTime: answer.questionStartTime,
      answerTime: answer.answerTime,
    };
  }

  function validateSession(saved, allowFutureClock) {
    if (!isObject(saved) || saved.version !== SESSION_VERSION || saved.lang !== config.lang || saved.revision !== config.revision || saved.configSignature !== configSignature()) return null;
    var completed = saved.status === "completed";
    if (saved.status !== undefined && saved.status !== "in-progress" && !completed) return null;
    if (!completed && saved.testEndTime != null) return null;
    if (typeof saved.participantId !== "string" || !validDate(saved.testStartTime) || !Array.isArray(saved.answers) || !Array.isArray(saved.selectedTestNames) || !saved.selectedTestNames.length) return null;
    var names = saved.selectedTestNames;
    if (names.some(function (name, index) { return typeof name !== "string" || !testByName(name) || names.indexOf(name) !== index; })) return null;
    var tests = allTests.filter(function (test) { return names.indexOf(test.name) !== -1; });
    if (tests.some(function (test, index) { return test.name !== names[index]; })) return null;
    if (!Number.isInteger(saved.currentTestIndex) || saved.currentTestIndex < 0 || saved.currentTestIndex >= tests.length) return null;
    var currentTest = tests[saved.currentTestIndex];
    if (!Number.isInteger(saved.currentQuestionIndex) || saved.currentQuestionIndex < 0) return null;
    if (completed) {
      if (saved.currentTestIndex !== tests.length - 1 || saved.currentQuestionIndex !== currentTest.questions.length || !validDate(saved.testEndTime)) return null;
    } else if (saved.currentQuestionIndex >= currentTest.questions.length) return null;
    var prefix = [];
    tests.forEach(function (test, index) {
      var count = completed || index < saved.currentTestIndex ? test.questions.length : index === saved.currentTestIndex ? saved.currentQuestionIndex : 0;
      for (var question = 1; question <= count; question++) prefix.push({ test: test, question: question });
    });
    if (saved.answers.length !== prefix.length) return null;
    var previousTime = Date.parse(saved.testStartTime);
    var now = Date.now();
    // A trusted in-memory backup may preserve timestamps after a device-clock
    // correction. Stored records and imports still use the strict wall-clock check.
    var end = completed ? Date.parse(saved.testEndTime) : allowFutureClock === true ? Infinity : now;
    if (end < previousTime || allowFutureClock !== true && (previousTime > now || end > now)) return null;
    var answers = [];
    for (var i = 0; i < prefix.length; i++) {
      var answer = canonicalAnswer(saved.answers[i], prefix[i].test, prefix[i].question, true);
      if (!answer || Date.parse(answer.questionStartTime) < previousTime || Date.parse(answer.answerTime) > end) return null;
      previousTime = Date.parse(answer.answerTime);
      answers.push(answer);
    }
    return {
      version: SESSION_VERSION,
      status: completed ? "completed" : "in-progress",
      lang: config.lang,
      revision: config.revision,
      configSignature: configSignature(),
      participantId: saved.participantId,
      currentTestIndex: saved.currentTestIndex,
      currentQuestionIndex: saved.currentQuestionIndex,
      answers: answers,
      testStartTime: saved.testStartTime,
      testEndTime: completed ? saved.testEndTime : null,
      selectedTestNames: names.slice(),
    };
  }

  function setPersistenceStatus(key) {
    var area = $("#persistence-area");
    if (!area) return;
    $("#persistence-status").textContent = ui[key];
    area.classList.toggle("persistence-warning", key !== "progressSaved" && key !== "completedSaved" && key !== "progressSaving" && key !== "completedSaving");
    var hasSession = state.testInProgress || state.testEndTime;
    $("#downloadBackup").classList.toggle("hidden", !hasSession);
    $("#retrySave").classList.toggle("hidden", !hasSession || persistenceBlocked || key !== "progressSaveFailed" && key !== "completedSaveFailed" && key !== "clockChanged");
    show(area);
  }
  function storageOperation(action, explicitClear) {
    var generation = sessionGeneration;
    var task = persistenceQueue.then(function () {
      if (generation !== sessionGeneration) return false;
      if (!navigator.locks || typeof navigator.locks.request !== "function") {
        if (explicitClear) return action();
        var error = new Error("Safe storage coordination unavailable");
        error.storageUnavailable = true;
        throw error;
      }
      // Writes and automatic deletions share one lock across both language pages.
      return navigator.locks.request("psychometric-session-storage", function () {
        if (generation !== sessionGeneration) return false;
        return action();
      });
    });
    persistenceQueue = task.catch(function () { });
    return task;
  }
  function persistenceFailure(error) {
    if (state.testEndTime) {
      completedPersisted = false;
      setPersistenceStatus(error.storageUnavailable || error.name === "SecurityError" && !window.isSecureContext ? "completedStorageUnavailable" : "completedSaveFailed");
      return false;
    }
    setPersistenceStatus(error.storageUnavailable || error.name === "SecurityError" && !window.isSecureContext ? "progressStorageUnavailable" : "progressSaveFailed");
    return false;
  }
  function blockCompetingSession() {
    persistenceBlocked = true;
    completedPersisted = false;
    setPersistenceStatus(state.testEndTime ? "completedConflict" : "progressConflict");
    if (state.testInProgress) $("#nextBtn").disabled = true;
    return false;
  }
  function checkStorageSnapshot(raw) {
    if ((raw === storageSnapshot && !(raw === null && attemptedSnapshot !== null)) ||
        (attemptedSnapshot !== null && raw === attemptedSnapshot)) return true;
    // A mismatched or empty cache cannot prove that the saved session was cleared.
    return blockCompetingSession();
  }
  function storedProgressAvailable() {
    if (persistenceBlocked) return false;
    try { return checkStorageSnapshot(localStorage.getItem(config.storageKey)); }
    catch (error) {
      setPersistenceStatus("progressSaveFailed");
      // Responses may continue in memory; saveProgress must read again before any write.
      return true;
    }
  }
  function progressSnapshot() {
    return {
      version: SESSION_VERSION,
      status: state.testEndTime ? "completed" : "in-progress",
      lang: config.lang,
      revision: config.revision,
      configSignature: configSignature(),
      participantId: state.participantId,
      currentTestIndex: state.currentTestIndex,
      currentQuestionIndex: state.currentQuestionIndex,
      answers: state.answers.slice(),
      testStartTime: state.testStartTime.toISOString(),
      testEndTime: state.testEndTime ? state.testEndTime.toISOString() : null,
      selectedTestNames: state.tests.map(function (test) { return test.name; }),
    };
  }
  function saveProgress() {
    if (!(state.testInProgress || state.testEndTime) || persistenceBlocked) return Promise.resolve(false);
    var snapshot = progressSnapshot();
    var snapshotValid = !!validateSession(snapshot);
    if (!snapshotValid) {
      completedPersisted = false;
      setPersistenceStatus(validateSession(snapshot, true) ? "clockChanged" : snapshot.status === "completed" ? "completedSaveFailed" : "progressSaveFailed");
    }
    var generation = sessionGeneration;
    var request = ++latestSaveRequest;
    if (snapshotValid) setPersistenceStatus(snapshot.status === "completed" ? "completedSaving" : "progressSaving");
    var task = storageOperation(async function () {
      if (!(state.testInProgress || state.testEndTime) || persistenceBlocked || state.testEndTime && snapshot.status !== "completed") return false;
      var baseline = await ensureAuthority(storageSnapshot);
      if (generation !== sessionGeneration) return false;
      await checkClearEpoch();
      if (generation !== sessionGeneration) return false;
      if (!validateSession(snapshot)) {
        var invalidSnapshot = new Error("Session snapshot cannot be recovered");
        invalidSnapshot.clockChanged = !!validateSession(snapshot, true);
        throw invalidSnapshot;
      }
      var raw = localStorage.getItem(config.storageKey);
      if (!checkStorageSnapshot(raw)) return false;
      storageSnapshot = raw;
      attemptedSnapshot = null;
      progressPersisted = raw !== null;
      snapshot.storageRevision = baseline ? baseline.revision + 1 : 1;
      snapshot.writeId = writerId + ":" + (++writeSequence);
      var serialized = JSON.stringify(snapshot);
      var expectedHash = await hashRaw(raw);
      var targetHash = await hashRaw(serialized);
      if (generation !== sessionGeneration) return false;
      var reserved = await reserveAuthority(config.storageKey, baseline, expectedHash, expectedHash, targetHash, null, false, false);
      if (generation === sessionGeneration) authoritySnapshot = reserved;
      if (generation !== sessionGeneration || !validateSession(snapshot)) {
        try { var restored = await cancelAuthority(reserved, baseline); if (generation === sessionGeneration) authoritySnapshot = restored; } catch (error) { }
        if (generation !== sessionGeneration) return false;
        var clockError = new Error("Session snapshot cannot be recovered");
        clockError.clockChanged = !!validateSession(snapshot, true);
        throw clockError;
      }
      // A failed read-back may leave this exact write stored; recognize it on retry.
      attemptedSnapshot = serialized;
      try { localStorage.setItem(config.storageKey, serialized); }
      catch (error) {
        attemptedSnapshot = null;
        try { authoritySnapshot = await cancelAuthority(reserved, baseline); } catch (cancelError) { }
        throw error;
      }
      var verified = localStorage.getItem(config.storageKey);
      if (verified !== serialized) {
        if (verified === raw) {
          attemptedSnapshot = null;
          try { authoritySnapshot = await cancelAuthority(reserved, baseline); } catch (cancelError) { }
        }
        throw new Error("Save verification failed");
      }
      var confirmed = await confirmAuthority(reserved);
      if (generation !== sessionGeneration) return false;
      authoritySnapshot = confirmed;
      storageSnapshot = serialized;
      attemptedSnapshot = null;
      progressPersisted = true;
      if (request === latestSaveRequest) {
        completedPersisted = snapshot.status === "completed";
        setPersistenceStatus(completedPersisted ? "completedSaved" : "progressSaved");
      }
      return true;
    }).catch(function (error) {
      if (generation === sessionGeneration && request === latestSaveRequest) {
        if (error.clockChanged) { completedPersisted = false; setPersistenceStatus("clockChanged"); return false; }
        return reportAuthorityFailure(error);
      }
      return false;
    });
    persistenceQueue = task;
    return task;
  }
  function clearProgress(expected) {
    var hasExpected = expected !== undefined;
    var expectedRaw = expected;
    var generation = sessionGeneration;
    var task = storageOperation(async function () {
      var baseline = await ensureAuthority(hasExpected ? expectedRaw : storageSnapshot);
      await checkClearEpoch();
      var raw = localStorage.getItem(config.storageKey);
      if (baseline && baseline.pending && baseline.pending.owner === writerId && baseline.pending.clear && raw === null && attemptedAuthorityClear === baseline.pending.token) {
        var alreadyCleared = await confirmAuthority(baseline);
        if (generation !== sessionGeneration) return false;
        setAuthoritySnapshot(alreadyCleared);
      } else {
        if (raw !== (hasExpected ? expectedRaw : storageSnapshot) && !(attemptedSnapshot !== null && raw === attemptedSnapshot)) return blockCompetingSession();
        var rawHash = await hashRaw(raw);
        var attemptedHash = await hashRaw(attemptedSnapshot);
        var epoch = nextClearEpoch();
        var reserved = await reserveAuthority(config.storageKey, baseline, rawHash, attemptedHash, null, epoch, true, false);
        if (generation !== sessionGeneration) return false;
        setAuthoritySnapshot(reserved);
        writeClearEpoch(config.storageKey, epoch);
        if (reserved.rawHash !== rawHash) throw coordinationError("Saved data has not synchronized for deletion");
        if (localStorage.getItem(config.storageKey) !== raw) throw coordinationError("Saved data changed before deletion");
        localStorage.removeItem(config.storageKey);
        attemptedAuthorityClear = reserved.pending.token;
        if (localStorage.getItem(config.storageKey) !== null) throw new Error("Deletion verification failed");
        var confirmed = await confirmAuthority(reserved);
        if (generation !== sessionGeneration) return false;
        setAuthoritySnapshot(confirmed);
      }
      storageSnapshot = null;
      attemptedSnapshot = null;
      progressPersisted = false;
      completedPersisted = false;
      return true;
    }, true).catch(function (error) {
      if (generation === sessionGeneration) return reportAuthorityFailure(error);
      return false;
    });
    persistenceQueue = task;
    return task;
  }
  function loadProgress() {
    unavailableSavedRaw = null;
    loadedSessionRaw = null;
    var raw;
    try { raw = localStorage.getItem(config.storageKey); }
    catch (error) { return null; }
    loadedSessionRaw = raw;
    if (raw === null) return null;
    var parsed;
    try {
      parsed = JSON.parse(raw);
      var saved = validateSession(parsed);
      if (saved) return saved;
    } catch (error) { }
    // Validation determines whether a record may resume, never whether it may survive.
    // An older configuration, a corrected clock, or damaged JSON can still contain responses.
    unavailableSavedRaw = raw;
    return null;
  }
  function clearAllData() {
    resetState();
    showSetupScreen();
    $("#nextBtn").disabled = true;
    $("#restoreBackupInput").disabled = true;
    var generation = sessionGeneration;
    var keys = ["psychometric_progress_en", "psychometric_progress_fr", config.storageKey].filter(function (key, index, list) {
      return list.indexOf(key) === index;
    });
    var task = storageOperation(async function () {
      var cleared = true;
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var reserved = null, beforeHash = null, readable = true, epoch = nextClearEpoch();
        try { beforeHash = await hashRaw(localStorage.getItem(key)); } catch (error) { readable = false; cleared = false; }
        try {
          var previous = await readAuthority(key);
          if (readable && beforeHash === null && previous && previous.pending && previous.pending.owner === writerId && previous.pending.clear && authorityClearProofs[key] === previous.pending.token) {
            reserved = previous;
            epoch = previous.epoch;
          } else reserved = await reserveAuthority(key, null, readable ? beforeHash : null, null, null, epoch, true, true);
        }
        catch (error) { cleared = false; }
        if (generation !== sessionGeneration) return false;
        try { writeClearEpoch(key, epoch); } catch (error) { cleared = false; }
        var deleted = true;
        var presentBeforeDelete = false;
        // With an observed entry, native removeItem sends a deletion even if its value is stale.
        // Read immediately before removal, after every asynchronous coordination step.
        try { presentBeforeDelete = localStorage.getItem(key) !== null; } catch (error) { cleared = false; }
        try {
          localStorage.removeItem(key);
          if (reserved && readable && (presentBeforeDelete || reserved.rawHash === null && beforeHash === null || authorityClearProofs[key] === reserved.pending.token)) authorityClearProofs[key] = reserved.pending.token;
        } catch (error) { deleted = false; cleared = false; }
        try {
          if (localStorage.getItem(key) !== null) {
            deleted = false;
            cleared = false;
            if (reserved && authorityClearProofs[key] === reserved.pending.token) delete authorityClearProofs[key];
          }
        }
        catch (error) { deleted = false; cleared = false; }
        // Cached absence cannot prove deletion of an authoritative nonempty record.
        if (!reserved || !readable || authorityClearProofs[key] !== reserved.pending.token) { cleared = false; continue; }
        if (deleted) {
          try { await confirmAuthority(reserved); } catch (error) { cleared = false; }
        }
      }
      if (generation === sessionGeneration) showSetupScreen(cleared ? ui.dataCleared : ui.alertClearDataFail);
      return cleared;
    }, true).catch(function () {
      if (generation === sessionGeneration) showSetupScreen(ui.alertClearDataFail);
      return false;
    });
    persistenceQueue = task;
    return task;
  }
  function buildProgressBackup() {
    if (!(state.testInProgress || state.testEndTime)) throw new Error(ui.invalidBackup);
    var snapshot = validateSession(progressSnapshot(), true);
    if (!snapshot) throw new Error(ui.invalidBackup);
    snapshot.backupType = "psychometric-progress";
    snapshot.generatedAt = new Date().toISOString();
    return JSON.stringify(snapshot, null, 2) + "\n";
  }
  function downloadText(text, filename, mimeType) {
    var blob = new Blob([text], { type: mimeType });
    var link = el("a", { download: filename });
    var url = URL.createObjectURL(blob);
    link.href = url;
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); URL.revokeObjectURL(url); }
  }
  function generateProgressBackup() {
    try {
      downloadText(buildProgressBackup(), config.export.backupFilename, "application/json;charset=utf-8");
      return true;
    } catch (error) {
      alert(ui.backupDownloadFailed);
      return false;
    }
  }
  function resumeSession(session, raw, authority) {
    resetState();
    if (authority !== undefined) setAuthoritySnapshot(authority);
    storageSnapshot = raw;
    progressPersisted = raw !== null;
    state.participantId = session.participantId;
    state.currentTestIndex = session.currentTestIndex;
    state.currentQuestionIndex = session.currentQuestionIndex;
    state.answers = session.answers;
    state.testStartTime = new Date(session.testStartTime);
    state.tests = allTests.filter(function (test) { return session.selectedTestNames.indexOf(test.name) !== -1; });
    state.totalQuestions = state.tests.reduce(function (sum, test) { return sum + test.questions.length; }, 0);
    state.testEndTime = session.status === "completed" ? new Date(session.testEndTime) : null;
    state.testInProgress = !state.testEndTime;
    completedPersisted = !!state.testEndTime && raw !== null;
    empty($("#setup-area"));
    show($("#progress-container"));
    var button = $("#nextBtn");
    button.textContent = ui.nextBtn;
    button.disabled = false;
    show(button);
    if (state.testEndTime) {
      hide(button);
      hide($("#progress-container"));
      empty($("#instruction-area"));
      empty($("#test-area"));
      displayResults(calculateSummaryScores());
      show($("#download-buttons"));
    } else loadTest(state.tests[state.currentTestIndex]);
    setPersistenceStatus(raw === null ? "backupRestored" : state.testEndTime ? "completedSaved" : "progressSaved");
  }
  function restoreProgressBackup(text) {
    var saved;
    try { saved = validateSession(JSON.parse(text)); } catch (error) { }
    if (!saved || state.testInProgress || state.testEndTime) {
      alert(ui.invalidBackup);
      return Promise.resolve(false);
    }
    try {
      if (localStorage.getItem(config.storageKey) !== null) {
        alert(ui.backupRestoreConflict);
        return Promise.resolve(false);
      }
    } catch (error) { /* Restore into memory; saveProgress will fail closed if storage cannot be read. */ }
    resumeSession(saved, null);
    return saveProgress();
  }

  function completedAnswers(checkTimes) {
    if (!Array.isArray(state.tests) || !state.tests.length || !Array.isArray(state.answers)) throw new Error(ui.invalidResults);
    var tests = {};
    var expected = 0;
    state.tests.forEach(function (test) {
      if (!testByName(test.name) || tests[test.name]) throw new Error(ui.invalidResults);
      tests[test.name] = testByName(test.name);
      expected += test.questions.length;
    });
    if (state.answers.length !== expected) throw new Error(ui.invalidResults);
    var seen = {};
    return state.answers.map(function (answer) {
      var test = tests[answer && answer.test];
      if (!test || !Number.isInteger(answer.questionIndex)) throw new Error(ui.invalidResults);
      var key = test.name + ":" + answer.questionIndex;
      var canonical = canonicalAnswer(answer, test, answer.questionIndex, checkTimes);
      if (!canonical || seen[key]) throw new Error(ui.invalidResults);
      seen[key] = true;
      return canonical;
    });
  }
  function calculateSummaryScores() {
    var answers = completedAnswers(false);
    var scores = {};
    state.tests.forEach(function (test) {
      var byQuestion = {};
      answers.filter(function (answer) { return answer.test === test.name; }).forEach(function (answer) { byQuestion[answer.questionIndex] = answer.score; });
      var scoring = config.scoring[test.name];
      if (scoring.type === "total") {
        scores[test.name] = test.questions.reduce(function (sum, question, index) { return sum + byQuestion[index + 1]; }, 0);
      } else {
        var groups = scoring.subscales || scoring.traits;
        scores[test.name] = {};
        Object.keys(groups).forEach(function (name) {
          var sum = groups[name].reduce(function (total, index) { return total + byQuestion[index]; }, 0);
          scores[test.name][name] = scoring.type === "trait-average" ? sum / groups[name].length : sum;
        });
      }
    });
    return scores;
  }
  function getInterpretation(testName, subscale, score) {
    var threshold = config.thresholds[testName];
    var entry = threshold && (threshold[subscale || "Total"] || threshold._default);
    if (!entry || !Number.isFinite(score)) return "";
    for (var i = 0; i < entry.ranges.length; i++) {
      var range = entry.ranges[i];
      if (score >= range[0] && score <= range[1]) return range[2];
    }
    return "";
  }
  function interpClass(label) {
    if (!label) return "";
    var configuredHads = config.thresholds.HADS;
    var hads = configuredHads && configuredHads.Anxiety ? configuredHads.Anxiety.ranges : [];
    for (var i = 0; i < hads.length; i++) {
      if (label === hads[i][2]) return ["interp-normal", "interp-moderate", "interp-abnormal"][i];
    }
    var value = label.toLowerCase();
    if (/abnormal|anormal|high|severe|élevé|sévère/.test(value)) return "interp-abnormal";
    if (/moderate|borderline|average|modéré|limite|moyen/.test(value)) return "interp-moderate";
    if (/normal|low|mild|faible|léger/.test(value)) return "interp-normal";
    return "";
  }
  function scoreRange(testName, subscale) {
    var test = testByName(testName);
    var scoring = config.scoring[testName];
    var groups = scoring.subscales || scoring.traits;
    var indices = groups ? groups[subscale] : test.questions.map(function (question, index) { return index + 1; });
    return ["min", "max"].map(function (bound) {
      var total = indices.reduce(function (sum, index) { return sum + Math[bound].apply(Math, test.questions[index - 1].scores); }, 0);
      return scoring.type === "trait-average" ? total / indices.length : total;
    });
  }
  function formatScoreValue(value) {
    return typeof value === "number" && !Number.isInteger(value) ? value.toFixed(2) : String(value);
  }
  function summaryRows(summary) {
    var rows = [];
    Object.keys(summary).forEach(function (name) {
      var values = typeof summary[name] === "object" ? summary[name] : { Total: summary[name] };
      Object.keys(values).forEach(function (key) {
        rows.push({
          test: name, key: key, label: key === "Total" ? ui.totalLabel : config.subscaleLabels[key],
          score: formatScoreValue(values[key]),
          range: scoreRange(name, key).map(formatScoreValue).join("-"),
          interpretation: getInterpretation(name, key, values[key]) || ui.rawScoreLabel,
        });
      });
    });
    return rows;
  }

  function validateConfig(config) {
    var problems = [];
    if (!isObject(config)) return ["missing configuration"];
    var tests = Array.isArray(config.tests) ? config.tests : [];
    if (!tests.length) problems.push("tests must be a nonempty array");
    if (typeof config.lang !== "string" || !config.lang || typeof config.revision !== "string" || !config.revision || typeof config.storageKey !== "string" || !config.storageKey) problems.push("missing language, revision or storage key");
    if (!isObject(config.ui) || !isObject(config.export) || !isObject(config.testMetadata) || !isObject(config.subscaleLabels)) problems.push("missing UI, export, metadata or labels");
    var requiredUI = [
      "pageTitle", "heading", "startBtn", "nextBtn", "downloadCsvBtn", "downloadPdfBtn",
      "clearDataBtn", "dataCleared", "alertClearDataFail", "consent", "participantLabel", "participantPlaceholder",
      "progressSaving", "progressSaved", "progressSaveFailed", "progressConflict", "progressStorageUnavailable", "clockChanged",
      "completedFound", "viewResultsBtn", "clearResultsStartBtn", "completedRetention", "completedClearFailed",
      "savedUnavailable", "clearSavedStartBtn", "savedRetention", "savedClearFailed",
      "completedSaving", "completedSaved", "completedSaveFailed", "completedStorageUnavailable", "completedConflict",
      "retrySaveBtn", "downloadBackupBtn", "restoreBackupLabel", "backupDownloadFailed",
      "invalidBackup", "backupRestoreConflict", "backupRestored",
      "selectTests", "items", "resumeFound", "resumeParticipant", "resumeAnswers", "resumeBtn",
      "newSessionBtn", "alertSelectTest", "alertAnswer", "alertCsvFail", "alertPdfFail",
      "alertPdfError", "alertPdfEncoding", "configError", "resultsHeading", "participantLabel2", "durationLabel",
      "minutes", "colScale", "colSubscale", "colScore", "colRange", "colInterpretation",
      "totalLabel", "resultsTableCaption", "descriptionLabel", "invalidSession", "invalidResults",
      "rawScoreLabel", "csvSessionTitle", "csvParticipant", "csvDuration", "csvTestsCompleted",
      "csvLanguage", "csvRevision", "csvStarted", "csvCompleted", "csvGenerated", "csvForm",
      "csvSource", "csvNotice", "csvDisclaimer", "csvSummaryTitle", "csvSummaryHeaders",
      "csvDetailTitle", "csvHeaders", "pdfTitle", "pdfGenerated", "pdfParticipant", "pdfDuration",
      "pdfLanguage", "pdfRevision", "pdfStarted", "pdfCompleted", "pdfForm", "pdfSource",
      "pdfDisclaimer", "pdfNotice", "pdfSummary", "pdfDetailed", "pdfTest", "pdfQuestion",
      "pdfAnswer", "pdfDescription", "pdfScore", "pdfTime", "disclaimer",
    ];
    requiredUI.forEach(function (key) {
      if (!config.ui || typeof config.ui[key] !== "string" || !config.ui[key]) problems.push("missing UI label " + key);
    });
    ["csvFilename", "pdfFilename", "backupFilename"].forEach(function (key) {
      if (!config.export || typeof config.export[key] !== "string" || !config.export[key]) problems.push("missing export filename " + key);
    });
    if (config.ui && typeof config.ui.csvSummaryHeaders === "string" && config.ui.csvSummaryHeaders.split(",").length !== 6) problems.push("CSV summary needs six columns");
    if (config.ui && typeof config.ui.csvHeaders === "string" && config.ui.csvHeaders.split(",").length !== 10) problems.push("CSV responses need ten columns");
    var byName = {};
    tests.forEach(function (test) {
      if (!isObject(test) || typeof test.name !== "string" || !test.name || byName[test.name]) { problems.push("invalid or duplicate test name"); return; }
      byName[test.name] = test;
      var questions = Array.isArray(test.questions) ? test.questions : [];
      if (!questions.length) problems.push(test.name + ": no questions");
      questions.forEach(function (question, index) {
        var where = test.name + " Q" + (index + 1);
        if (!isObject(question) || typeof question.q !== "string" || !question.q || !Array.isArray(question.options) || !question.options.length || !Array.isArray(question.scores)) { problems.push(where + ": invalid question/options/scores"); return; }
        if (question.options.length !== question.scores.length) problems.push(where + ": options/scores length mismatch");
        if (question.options.some(function (option) { return typeof option !== "string" || !option; })) problems.push(where + ": invalid option text");
        if (question.scores.some(function (score) { return typeof score !== "number" || !Number.isFinite(score); })) problems.push(where + ": non-finite score");
        if (question.description !== undefined && typeof question.description !== "boolean") problems.push(where + ": invalid description flag");
      });
      var metadata = config.testMetadata && config.testMetadata[test.name];
      if (!isObject(metadata) || ["form", "source", "notice"].some(function (key) { return typeof metadata[key] !== "string" || !metadata[key]; })) problems.push(test.name + ": missing form/source/notice");
    });
    if (!isObject(config.scoring)) problems.push("missing scoring config");
    Object.keys(byName).forEach(function (name) {
      var scoring = config.scoring && config.scoring[name];
      if (!isObject(scoring) || ["total", "subscale", "trait-average"].indexOf(scoring.type) === -1) { problems.push(name + ": unsupported scoring type"); return; }
      if (scoring.type === "total") return;
      var groups = scoring.type === "subscale" ? scoring.subscales : scoring.traits;
      if (!isObject(groups) || !Object.keys(groups).length) { problems.push(name + ": no scoring groups"); return; }
      Object.keys(groups).forEach(function (group) {
        var indices = groups[group];
        if (!Array.isArray(indices) || !indices.length) { problems.push(name + "." + group + ": empty group"); return; }
        if (indices.some(function (index, position) { return !Number.isInteger(index) || index < 1 || !Array.isArray(byName[name].questions) || index > byName[name].questions.length || indices.indexOf(index) !== position; })) problems.push(name + "." + group + ": invalid or duplicate item index");
        if (!config.subscaleLabels || typeof config.subscaleLabels[group] !== "string" || !config.subscaleLabels[group]) problems.push(name + "." + group + ": missing display label");
      });
    });
    Object.keys(config.scoring || {}).forEach(function (name) { if (!byName[name]) problems.push("scoring[" + name + "]: no matching test"); });
    if (!isObject(config.thresholds)) problems.push("missing thresholds config");
    Object.keys(config.thresholds || {}).forEach(function (name) {
      var entries = config.thresholds[name];
      if (!byName[name] || !isObject(entries)) { problems.push("invalid threshold test " + name); return; }
      Object.keys(entries).forEach(function (key) {
        var entry = entries[key];
        var scoring = config.scoring && config.scoring[name];
        var groups = scoring && (scoring.subscales || scoring.traits);
        if (!scoring || (scoring.type === "total" && key !== "Total" && key !== "_default") || (scoring.type !== "total" && key !== "_default" && (!groups || !Object.prototype.hasOwnProperty.call(groups, key)))) problems.push(name + "." + key + ": unknown threshold score");
        if (!isObject(entry) || !Array.isArray(entry.ranges) || !entry.ranges.length) { problems.push(name + "." + key + ": no ranges"); return; }
        var previous = null;
        entry.ranges.forEach(function (range) {
          if (!Array.isArray(range) || range.length !== 3 || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || typeof range[2] !== "string" || !range[2] || range[0] > range[1] || (previous !== null && range[0] <= previous)) problems.push(name + "." + key + ": malformed or overlapping range");
          if (Array.isArray(range)) previous = range[1];
        });
      });
    });
    return problems;
  }

  function csvEscape(field) {
    var value = String(field);
    if (/^[=+\-@\t\r\n＝＋－＠]/.test(value)) value = "'" + value;
    return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
  }
  function sessionMinutes(decimals) {
    return ((state.testEndTime - state.testStartTime) / 60000).toFixed(decimals);
  }
  function showSetupScreen(message) {
    hide($("#persistence-area"));
    empty($("#setup-area"));
    ["#instruction-area", "#test-area", "#results-area"].forEach(function (selector) { empty($(selector)); });
    hide($("#progress-container"));
    hide($("#results-area"));
    hide($("#download-buttons"));
    var area = $("#setup-area");
    if (message) area.appendChild(el("p", { role: "status", text: message }));
    area.appendChild(el("div", { className: "consent-text" }, [el("p", { text: ui.consent })]));
    area.appendChild(el("div", { className: "mb-3" }, [
      el("label", { "for": "participantIdInput", className: "form-label fw-bold", text: ui.participantLabel }),
      el("input", { type: "text", className: "form-control participant-id-input", id: "participantIdInput", placeholder: ui.participantPlaceholder }),
    ]));
    var selection = el("div", { className: "test-selection" }, [el("p", { className: "fw-bold", text: ui.selectTests })]);
    allTests.forEach(function (test, index) {
      selection.appendChild(el("div", { className: "form-check" }, [
        el("input", { className: "form-check-input test-checkbox", type: "checkbox", id: "test" + index, value: String(index), checked: "" }),
        el("label", { className: "form-check-label", "for": "test" + index, text: test.name + " (" + test.questions.length + " " + ui.items + ")" }),
      ]));
    });
    area.appendChild(selection);
    var restore = el("input", { id: "restoreBackupInput", type: "file", accept: ".json,application/json", className: "form-control" });
    restore.addEventListener("change", async function () {
      var file = restore.files[0];
      if (!file) return;
      var generation = sessionGeneration;
      try {
        var text = await file.text();
        if (generation === sessionGeneration) await restoreProgressBackup(text);
      } catch (error) { alert(ui.invalidBackup); }
      restore.value = "";
    });
    area.appendChild(el("div", { className: "mt-3" }, [
      el("label", { "for": "restoreBackupInput", className: "form-label", text: ui.restoreBackupLabel }), restore,
    ]));
    var button = $("#nextBtn");
    button.textContent = ui.startBtn;
    button.disabled = false;
    show(button);
  }
  function showResumeScreen(saved, expectedRaw) {
    var snapshot = validateSession(saved);
    var promptRaw = expectedRaw;
    var promptMatches = true;
    if (expectedRaw === undefined) {
      try {
        promptRaw = localStorage.getItem(config.storageKey);
        var current = validateSession(JSON.parse(promptRaw));
        promptMatches = !!current && JSON.stringify(current) === JSON.stringify(snapshot);
      } catch (error) { promptRaw = undefined; }
    }
    if (!snapshot) {
      resetState();
      if (promptRaw !== undefined && promptRaw !== null) showUnavailableSaved(promptRaw);
      else showSetupScreen(ui.invalidSession);
      return;
    }
    var generation = ++sessionGeneration;
    captureClearEpoch();
    var area = $("#setup-area");
    empty(area);
    hide($("#persistence-area"));
    var completed = snapshot.status === "completed";
    var message = completed ? ui.completedFound : ui.resumeFound;
    if (snapshot.participantId) message += " (" + ui.resumeParticipant + ": " + snapshot.participantId + ")";
    message += ": " + snapshot.answers.length + " " + ui.resumeAnswers;
    var resume = el("button", { id: "resumeBtn", className: "btn btn-primary me-2", text: completed ? ui.viewResultsBtn : ui.resumeBtn });
    var start = el("button", { id: "newSessionBtn", className: "btn btn-outline-secondary", text: completed ? ui.clearResultsStartBtn : ui.newSessionBtn });
    area.appendChild(el("div", { className: "resume-prompt" }, [el("p", { text: message }), resume, start]));
    if (completed) area.appendChild(el("p", { className: "consent-text", text: ui.completedRetention }));
    hide($("#nextBtn"));
    resume.addEventListener("click", function () {
      if (generation !== sessionGeneration) return;
      resume.disabled = true;
      var observedRaw;
      var task = storageOperation(async function () {
        var raw = localStorage.getItem(config.storageKey);
        observedRaw = raw;
        var session;
        try { session = validateSession(JSON.parse(raw)); } catch (error) { session = null; }
        var authority = await authorityAccess(raw, !session);
        if (generation !== sessionGeneration) return false;
        if (!session || session.testStartTime !== snapshot.testStartTime || session.participantId !== snapshot.participantId || JSON.stringify(session.selectedTestNames) !== JSON.stringify(snapshot.selectedTestNames)) {
          resetState();
          if (raw === null) showSetupScreen(ui.dataCleared);
          else showStoredSession();
          return false;
        }
        resumeSession(session, raw, authority);
        return true;
      }, true).catch(function (error) {
        if (generation === sessionGeneration) {
          if (error.authorityConflict && !error.authorityCleared && observedRaw !== undefined && observedRaw !== null && !(error.authorityRecord && error.authorityRecord.pending && error.authorityRecord.pending.clear)) {
            resetState();
            showUnavailableSaved(observedRaw);
          } else reportAuthorityFailure(error);
        }
        return false;
      }).then(function (resumed) {
        if (generation === sessionGeneration) resume.disabled = false;
        return resumed;
      });
      persistenceQueue = task;
    });
    start.addEventListener("click", function () {
      if (generation !== sessionGeneration) return;
      if (promptRaw === undefined) { setPersistenceStatus("progressSaveFailed"); return; }
      if (!promptMatches) { setPersistenceStatus(completed ? "completedConflict" : "progressConflict"); return; }
      start.disabled = true;
      clearProgress(promptRaw).then(function (cleared) {
        if (generation !== sessionGeneration) return;
        if (cleared) { resetState(); showSetupScreen(); }
        else {
          start.disabled = false;
          if (completed) setPersistenceStatus(persistenceBlocked ? "completedConflict" : "completedClearFailed");
        }
      });
    });
  }
  function showUnavailableSaved(raw) {
    var generation = ++sessionGeneration;
    captureClearEpoch();
    var area = $("#setup-area");
    empty(area);
    hide($("#nextBtn"));
    hide($("#persistence-area"));
    var backup = el("button", { id: "downloadStoredBackup", type: "button", className: "btn btn-outline-primary me-2", text: ui.downloadBackupBtn });
    var start = el("button", { id: "newSessionBtn", type: "button", className: "btn btn-outline-secondary", text: ui.clearSavedStartBtn });
    area.appendChild(el("p", { role: "status", text: ui.savedUnavailable }));
    area.appendChild(el("p", { className: "consent-text", text: ui.savedRetention }));
    area.appendChild(backup);
    area.appendChild(start);
    backup.addEventListener("click", function () {
      if (generation !== sessionGeneration) return;
      backup.disabled = true;
      var task = storageOperation(async function () {
        var current = localStorage.getItem(config.storageKey);
        await authorityAccess(current, true);
        if (generation !== sessionGeneration) return false;
        if (current !== raw) {
          resetState();
          if (current === null) showSetupScreen(ui.dataCleared);
          else showStoredSession();
          return false;
        }
        downloadText(raw, config.export.backupFilename, "application/json;charset=utf-8");
        return true;
      }, true).catch(function (error) {
        if (generation === sessionGeneration) {
          if (error.authorityConflict || error.authorityCleared) reportAuthorityFailure(error);
          else alert(ui.backupDownloadFailed);
        }
        return false;
      }).then(function (downloaded) {
        if (generation === sessionGeneration) backup.disabled = false;
        return downloaded;
      });
      persistenceQueue = task;
    });
    start.addEventListener("click", function () {
      if (generation !== sessionGeneration) return;
      start.disabled = true;
      clearProgress(raw).then(function (cleared) {
        if (generation !== sessionGeneration) return;
        if (cleared) { resetState(); showSetupScreen(); }
        else {
          start.disabled = false;
          setPersistenceStatus(persistenceBlocked ? "progressConflict" : "savedClearFailed");
        }
      });
    });
  }
  function showStoredSession() {
    var saved = loadProgress();
    if (saved) showResumeScreen(saved, loadedSessionRaw);
    else if (unavailableSavedRaw !== null) showUnavailableSaved(unavailableSavedRaw);
    else showSetupScreen();
  }
  function loadTest(test) {
    var area = $("#instruction-area");
    empty(area);
    if (test.instructions) area.appendChild(el("div", { className: "instruction", text: test.instructions }));
    loadQuestion(test.questions[state.currentQuestionIndex]);
  }
  function loadQuestion(question) {
    var started = state.testStartTime ? state.testStartTime.getTime() : 0;
    var previous = state.answers.length ? Date.parse(state.answers[state.answers.length - 1].answerTime) : started;
    state.questionStartTime = new Date(Math.max(Date.now(), started, previous));
    var area = $("#test-area");
    empty(area);
    var id = "q-text-" + state.currentTestIndex + "-" + state.currentQuestionIndex;
    var prompt = el("p", { className: "question", id: id, tabindex: "-1", text: question.q });
    var group = el("div", { role: "radiogroup", "aria-labelledby": id });
    area.appendChild(prompt);
    if (question.description) {
      area.appendChild(el("label", { "for": "question-description", className: "form-label", text: ui.descriptionLabel }));
      area.appendChild(el("textarea", { id: "question-description", className: "form-control mb-3", rows: "3" }));
    }
    question.options.forEach(function (option, index) {
      group.appendChild(el("div", { className: "form-check" }, [
        el("input", { className: "form-check-input", type: "radio", name: "question" + state.currentTestIndex + "_" + state.currentQuestionIndex, id: "option" + index, value: String(index) }),
        el("label", { className: "form-check-label", "for": "option" + index, text: option }),
      ]));
    });
    area.appendChild(group);
    area.appendChild(el("p", { className: "instrument-notice", text: config.testMetadata[state.tests[state.currentTestIndex].name].notice }));
    updateProgressBar();
    prompt.focus();
  }
  function responseClockReady(now) {
    var latest = Math.max(
      state.testStartTime ? state.testStartTime.getTime() : 0,
      state.questionStartTime ? state.questionStartTime.getTime() : 0,
      state.answers.length ? Date.parse(state.answers[state.answers.length - 1].answerTime) : 0,
      state.testEndTime ? state.testEndTime.getTime() : 0
    );
    responseClockBlocked = now < latest;
    if (responseClockBlocked) setPersistenceStatus("clockChanged");
    return !responseClockBlocked;
  }
  function recordAnswer() {
    var now = new Date();
    if (!responseClockReady(now.getTime())) return false;
    var selected = $('#test-area input[type="radio"]:checked');
    if (!selected || !/^\d+$/.test(selected.value)) return false;
    var index = Number(selected.value);
    var test = state.tests[state.currentTestIndex];
    var question = test.questions[state.currentQuestionIndex];
    if (!Number.isInteger(index) || index >= question.options.length) return false;
    var description = $("#question-description");
    state.answers.push({
      test: test.name, questionIndex: state.currentQuestionIndex + 1, optionIndex: index,
      question: question.q, answer: question.options[index], score: question.scores[index],
      description: description ? description.value : "",
      time: (now - state.questionStartTime) / 1000,
      questionStartTime: state.questionStartTime.toISOString(), answerTime: now.toISOString(),
    });
    return true;
  }
  function updateProgressBar() {
    var progress = state.totalQuestions ? state.answers.length / state.totalQuestions * 100 : 0;
    var bar = $(".progress-bar");
    bar.style.width = progress + "%";
    bar.setAttribute("aria-valuenow", String(progress));
  }
  function displayResults(summary) {
    var area = $("#results-area");
    empty(area);
    var heading = el("h2", { tabindex: "-1", text: ui.resultsHeading });
    area.appendChild(heading);
    if (state.participantId) area.appendChild(el("p", { className: "participant-id", text: ui.participantLabel2 + " " + state.participantId }));
    area.appendChild(el("p", { text: ui.durationLabel + " " + sessionMinutes(1) + " " + ui.minutes }));
    var table = el("table", { className: "table table-bordered" });
    table.appendChild(el("caption", { className: "visually-hidden", text: ui.resultsTableCaption }));
    var head = el("tr");
    [ui.colScale, ui.colSubscale, ui.colScore, ui.colRange, ui.colInterpretation].forEach(function (label) { head.appendChild(el("th", { scope: "col", text: label })); });
    table.appendChild(el("thead", null, [head]));
    var body = el("tbody");
    summaryRows(summary).forEach(function (row) {
      var cells = [row.test, row.label, row.score, row.range].map(function (value) { return el("td", { text: value }); });
      var interpretation = el("td", { text: row.interpretation });
      var color = row.test === "HADS" ? interpClass(row.interpretation) : "";
      if (color) interpretation.classList.add(color);
      cells.push(interpretation);
      body.appendChild(el("tr", null, cells));
    });
    table.appendChild(body);
    area.appendChild(el("div", { className: "table-responsive" }, [table]));
    area.appendChild(el("div", { className: "disclaimer", text: ui.disclaimer }));
    if (state.testEndTime) {
      area.appendChild(el("p", { className: "consent-text", text: ui.completedRetention }));
      var start = el("button", { id: "newSessionBtn", type: "button", className: "btn btn-outline-secondary", text: ui.clearResultsStartBtn });
      var generation = sessionGeneration;
      start.addEventListener("click", function () {
        if (generation !== sessionGeneration) return;
        start.disabled = true;
        clearProgress().then(function (cleared) {
          if (generation !== sessionGeneration) return;
          if (cleared) { resetState(); showSetupScreen(); }
          else {
            start.disabled = false;
            setPersistenceStatus(persistenceBlocked ? "completedConflict" : "completedClearFailed");
          }
        });
      });
      area.appendChild(start);
    }
    show(area);
    heading.focus();
  }

  function requireCompletedSession() {
    if (state.testInProgress || !(state.testStartTime instanceof Date) || !(state.testEndTime instanceof Date) || !Number.isFinite(state.testStartTime.getTime()) || !Number.isFinite(state.testEndTime.getTime()) || state.testEndTime < state.testStartTime || state.testEndTime.getTime() > Date.now()) throw new Error(ui.invalidResults);
    var answers = completedAnswers(true);
    answers.forEach(function (answer) {
      if (Date.parse(answer.questionStartTime) < state.testStartTime.getTime() || Date.parse(answer.answerTime) > state.testEndTime.getTime()) throw new Error(ui.invalidResults);
    });
    return answers;
  }
  function buildCSV() {
    var answers = requireCompletedSession();
    var lines = ["\uFEFF" + ui.csvSessionTitle];
    function row(values) { lines.push(values.map(csvEscape).join(",")); }
    row([ui.csvParticipant, state.participantId || "N/A"]);
    row([ui.csvLanguage, config.lang]);
    row([ui.csvRevision, config.revision]);
    row([ui.csvStarted, state.testStartTime.toISOString()]);
    row([ui.csvCompleted, state.testEndTime.toISOString()]);
    row([ui.csvGenerated, new Date().toISOString()]);
    row([ui.csvDuration, sessionMinutes(2)]);
    row([ui.csvTestsCompleted, state.tests.map(function (test) { return test.name; }).join("; ")]);
    state.tests.forEach(function (test) {
      var metadata = config.testMetadata[test.name];
      row([ui.csvForm, test.name, metadata.form]);
      row([ui.csvSource, test.name, metadata.source]);
      row([ui.csvNotice, test.name, metadata.notice]);
    });
    row([ui.csvDisclaimer, ui.disclaimer]);
    lines.push("", ui.csvSummaryTitle, ui.csvSummaryHeaders);
    summaryRows(calculateSummaryScores()).forEach(function (summary) {
      row([summary.test, summary.key, summary.label, summary.score, summary.range, summary.interpretation]);
    });
    lines.push("", ui.csvDetailTitle, ui.csvHeaders);
    answers.forEach(function (answer) {
      row([answer.test, answer.questionIndex, answer.optionIndex, answer.question, answer.answer, answer.description, answer.score, answer.time.toFixed(2), answer.questionStartTime, answer.answerTime]);
    });
    return lines.join("\r\n") + "\r\n";
  }
  function generateCSV() {
    try {
      downloadText(buildCSV(), config.export.csvFilename, "text/csv;charset=utf-8;");
      return true;
    } catch (error) {
      console.error("CSV generation failed:", error);
      alert(ui.alertCsvFail);
      return false;
    }
  }

  function pdfTextSupported(text) {
    return !/[^\t\n\r\u0020-\u007E\u00A0-\u00FFŒœŠšŸŽžƒˆ˜\u2013\u2014‘’‚“”„†‡•…‰‹›€™]/u.test(String(text));
  }
  function checkPDFText(answers) {
    var text = [state.participantId];
    Object.keys(ui).forEach(function (key) { text.push(ui[key]); });
    Object.keys(config.subscaleLabels).forEach(function (key) { text.push(config.subscaleLabels[key]); });
    state.tests.forEach(function (test) {
      var metadata = config.testMetadata[test.name];
      text.push(test.name, metadata.form, metadata.source, metadata.notice);
    });
    answers.forEach(function (answer) { text.push(answer.question, answer.answer, answer.description); });
    if (!text.every(pdfTextSupported)) {
      var error = new Error(ui.alertPdfEncoding);
      error.code = "PDF_ENCODING";
      throw error;
    }
  }
  function buildPDF() {
    var answers = requireCompletedSession();
    checkPDFText(answers);
    var doc = new window.jspdf.jsPDF();
    var margin = 10;
    var width = doc.internal.pageSize.getWidth() - 2 * margin;
    var height = doc.internal.pageSize.getHeight();
    var notices = state.tests.map(function (test) { return config.testMetadata[test.name].notice; }).filter(function (notice, index, list) { return list.indexOf(notice) === index; });
    doc.setFontSize(8);
    var footerLines = doc.splitTextToSize(ui.pdfNotice + "\n" + notices.join("\n"), width);
    var footerTop = height - margin - footerLines.length * 3.8;
    var bottom = footerTop - 5;
    var y = margin;
    if (bottom < 60) throw new Error("Instrument notices do not fit on the PDF page");
    function footer() {
      doc.setFontSize(8);
      footerLines.forEach(function (line, index) { doc.text(line, margin, footerTop + index * 3.8); });
    }
    function write(text, size, gap) {
      size = size || 10;
      doc.setFontSize(size);
      var lines = doc.splitTextToSize(String(text), width);
      var lineHeight = size * 0.352778 * 1.3;
      lines.forEach(function (line) {
        if (y + lineHeight > bottom) { footer(); doc.addPage(); y = margin; doc.setFontSize(size); }
        doc.text(line, margin, y + lineHeight);
        y += lineHeight;
      });
      y += gap === undefined ? 2 : gap;
    }
    write(ui.pdfTitle, 16, 4);
    write(ui.pdfGenerated + " " + new Date().toISOString());
    if (state.participantId) write(ui.pdfParticipant + " " + state.participantId);
    write(ui.pdfLanguage + " " + config.lang + " | " + ui.pdfRevision + " " + config.revision);
    write(ui.pdfStarted + " " + state.testStartTime.toISOString());
    write(ui.pdfCompleted + " " + state.testEndTime.toISOString());
    write(ui.pdfDuration + " " + sessionMinutes(1) + " " + ui.minutes);
    state.tests.forEach(function (test) {
      var metadata = config.testMetadata[test.name];
      write(test.name + " | " + ui.pdfForm + " " + metadata.form);
      write(ui.pdfSource + " " + metadata.source, 9);
    });
    write(ui.pdfDisclaimer + " " + ui.disclaimer, 9, 5);
    write(ui.pdfSummary, 12, 4);
    summaryRows(calculateSummaryScores()).forEach(function (row) {
      write(row.test + " / " + row.label + ": " + row.score + " | " + ui.colRange + " " + row.range + (row.interpretation ? " | " + row.interpretation : ""));
    });
    write(ui.pdfDetailed, 12, 4);
    answers.forEach(function (answer) {
      write(ui.pdfTest + " " + answer.test + " | " + ui.pdfQuestion + " " + answer.questionIndex, 10, 1);
      write(answer.question, 9, 1);
      write(ui.pdfAnswer + " " + answer.answer, 9, 1);
      write(ui.csvHeaders.split(",")[2] + ": " + answer.optionIndex, 9, 1);
      if (answer.description) write(ui.pdfDescription + " " + answer.description, 9, 1);
      write(ui.pdfScore + " " + answer.score + " | " + ui.pdfTime + " " + answer.time.toFixed(1) + "s", 9, 4);
    });
    footer();
    return doc;
  }
  function generatePDF() {
    if (!window.jspdf) {
      if (generateCSV()) alert(ui.alertPdfFail);
      return;
    }
    try {
      buildPDF().save(config.export.pdfFilename);
    } catch (error) {
      if (error.code === "PDF_ENCODING") {
        if (generateCSV()) alert(ui.alertPdfEncoding);
        return;
      }
      console.error("PDF generation failed:", error);
      alert(ui.alertPdfError);
    }
  }

  function handleNext() {
    var button = $("#nextBtn");
    if (button.disabled) return;
    if (state.testInProgress && authorityCapturePending) return;
    if (state.testInProgress && !responseClockReady(Date.now())) return;
    if (state.testInProgress && !storedProgressAvailable()) return;
    button.disabled = true;
    var generation = sessionGeneration;
    setTimeout(function () { if (!persistenceBlocked && generation === sessionGeneration) button.disabled = false; }, 300);
    if (!state.testInProgress) {
      var input = $("#participantIdInput");
      if (!input) { button.disabled = false; return; }
      var participant = input.value.trim();
      var selected = Array.prototype.map.call($$(".test-checkbox:checked"), function (checkbox) { return Number(checkbox.value); });
      if (!selected.length || selected.some(function (index) { return !Number.isInteger(index) || !allTests[index]; })) { alert(ui.alertSelectTest); button.disabled = false; return; }
      resetState();
      state.participantId = participant;
      state.tests = selected.map(function (index) { return allTests[index]; });
      state.totalQuestions = state.tests.reduce(function (sum, test) { return sum + test.questions.length; }, 0);
      state.testStartTime = new Date();
      state.testInProgress = true;
      generation = sessionGeneration;
      empty($("#setup-area"));
      show($("#progress-container"));
      loadTest(state.tests[0]);
      button.textContent = ui.nextBtn;
      saveProgress();
      return;
    }
    if (!recordAnswer()) { if (!responseClockBlocked) alert(ui.alertAnswer); button.disabled = false; return; }
    if (state.currentQuestionIndex < state.tests[state.currentTestIndex].questions.length - 1) {
      state.currentQuestionIndex++;
      loadQuestion(state.tests[state.currentTestIndex].questions[state.currentQuestionIndex]);
    } else if (state.currentTestIndex < state.tests.length - 1) {
      state.currentTestIndex++;
      state.currentQuestionIndex = 0;
      loadTest(state.tests[state.currentTestIndex]);
    } else {
      state.testInProgress = false;
      state.testEndTime = new Date(Math.max(Date.now(), Date.parse(state.answers[state.answers.length - 1].answerTime)));
      state.currentQuestionIndex++;
      saveProgress();
      updateProgressBar();
      hide(button);
      empty($("#instruction-area"));
      empty($("#test-area"));
      try {
        displayResults(calculateSummaryScores());
        show($("#download-buttons"));
      } catch (error) {
        resetState();
        showSetupScreen(ui.invalidResults);
      }
      return;
    }
    saveProgress();
  }
  function init() {
    var problems = validateConfig(config);
    if (problems.length) {
      console.error("CONFIG validation problems:", problems);
      empty($("#setup-area"));
      $("#setup-area").appendChild(el("div", { role: "alert", className: "disclaimer", text: (ui.configError || "Configuration error:") + " " + problems.join("; ") }));
      hide($("#nextBtn"));
      return;
    }
    var panel = el("section", { id: "persistence-area", className: "persistence-panel hidden" }, [
      el("p", { id: "persistence-status", role: "status", "aria-live": "polite", "aria-atomic": "true" }),
      el("button", { id: "retrySave", type: "button", className: "btn btn-outline-primary me-2 hidden", text: ui.retrySaveBtn }),
      el("button", { id: "downloadBackup", type: "button", className: "btn btn-outline-secondary", text: ui.downloadBackupBtn }),
    ]);
    $("#progress-container").before(panel);
    $("#retrySave").addEventListener("click", saveProgress);
    $("#downloadBackup").addEventListener("click", generateProgressBackup);
    document.title = ui.pageTitle;
    if ($("h1")) $("h1").textContent = ui.heading;
    $("#downloadCsv").textContent = ui.downloadCsvBtn;
    $("#downloadPdf").textContent = ui.downloadPdfBtn;
    showStoredSession();
    document.addEventListener("keydown", function (event) {
      if (!state.testInProgress || event.metaKey || event.ctrlKey || event.altKey) return;
      var target = event.target;
      if (target && (target.isContentEditable || target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && target.type !== "radio" && target.type !== "checkbox"))) return;
      if (event.key === "Enter") {
        if (target && target.tagName === "BUTTON") return;
        event.preventDefault();
        handleNext();
      } else if (/^[1-9]$/.test(event.key)) {
        var radios = $$('#test-area input[type="radio"]');
        var index = Number(event.key) - 1;
        if (index < radios.length) { radios[index].focus(); radios[index].click(); }
      }
    });
    $("#nextBtn").addEventListener("click", handleNext);
    var downloadingCsv = false;
    var downloadingPdf = false;
    $("#downloadCsv").addEventListener("click", function () {
      if (downloadingCsv) return;
      downloadingCsv = true;
      generateCSV();
      setTimeout(function () { downloadingCsv = false; }, 1000);
    });
    $("#downloadPdf").addEventListener("click", function () {
      if (downloadingPdf) return;
      downloadingPdf = true;
      generatePDF();
      setTimeout(function () { downloadingPdf = false; }, 1000);
    });
    var clear = $("#clearDataBtn");
    if (clear) { clear.textContent = ui.clearDataBtn; clear.addEventListener("click", clearAllData); }
    window.addEventListener("storage", function (event) {
      if (event.storageArea && event.storageArea !== localStorage) return;
      var marker = event.key === clearEpochKey(config.storageKey);
      if (!marker && event.key !== config.storageKey && event.key !== null) return;
      if (!(state.testInProgress || state.testEndTime || $("#resumeBtn") || $("#downloadStoredBackup"))) return;
      var generation = sessionGeneration;
      // A browser-wide clear is explicit even when it did not update app metadata.
      if (event.key === null && event.newValue === null) {
        try { if (localStorage.getItem(config.storageKey) !== null) return; }
        catch (error) { persistenceFailure(error); return; }
        resetState();
        showSetupScreen(ui.dataCleared);
        return;
      }
      var task = storageOperation(async function () {
        await checkClearEpoch();
        if (generation !== sessionGeneration) return false;
        if (marker) return true;
        var raw = localStorage.getItem(config.storageKey);
        if (raw === null && event.newValue === null) {
          if ((state.testInProgress || state.testEndTime) && !progressPersisted && storageSnapshot === null && attemptedSnapshot === null) return true;
          // A renderer's cached absence cannot prove that the authoritative save was removed.
          var authority = await readAuthority(config.storageKey);
          if (generation !== sessionGeneration) return false;
          if (authority && (authority.pending || authority.rawHash !== null)) {
            if (state.testInProgress || state.testEndTime) blockCompetingSession();
            return false;
          }
          resetState();
          showSetupScreen(ui.dataCleared);
          return false;
        }
        if ((state.testInProgress || state.testEndTime) && raw !== storageSnapshot && raw !== attemptedSnapshot) return blockCompetingSession();
        return true;
      }, true).catch(function (error) {
        if (generation === sessionGeneration) reportAuthorityFailure(error);
        return false;
      });
      persistenceQueue = task;
    });
    window.addEventListener("beforeunload", function (event) {
      // Requesting a download does not confirm that the browser saved its file.
      if (state.testInProgress || (state.testEndTime && !completedPersisted)) { event.preventDefault(); event.returnValue = ""; }
    });
  }
  if (window.__TEST__) {
    var hooks = {
      calculateSummaryScores: calculateSummaryScores, getInterpretation: getInterpretation,
      interpClass: interpClass, csvEscape: csvEscape, formatScoreValue: formatScoreValue,
      validateConfig: validateConfig, validateSession: validateSession,
      configSignature: configSignature, loadProgress: loadProgress, saveProgress: saveProgress,
      showResumeScreen: showResumeScreen, resetState: resetState, clearAllData: clearAllData,
      showSetupScreen: showSetupScreen, loadTest: loadTest, recordAnswer: recordAnswer,
      displayResults: displayResults, scoreRange: scoreRange, summaryRows: summaryRows,
      buildCSV: buildCSV, buildPDF: buildPDF, generateCSV: generateCSV, generatePDF: generatePDF,
      pdfTextSupported: pdfTextSupported,
      buildProgressBackup: buildProgressBackup, generateProgressBackup: generateProgressBackup,
      restoreProgressBackup: restoreProgressBackup,
      resetAuthorityForFixture: function (key) {
        var target = key || config.storageKey;
        return authorityTransaction(target, "readwrite", function (record, store) { store.delete(target); return null; }).then(function () {
          if (target === config.storageKey) { captureClearEpoch(); return authorityCapture; }
        });
      },
      whenPersistenceSettled: function () { return persistenceQueue; },
      state: state,
    };
    Object.keys(hooks).forEach(function (key) { window.__TEST__[key] = hooks[key]; });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
