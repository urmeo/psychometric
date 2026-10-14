async function browserRegressions(C, T, state, mockAnswers, assert, assertThrows, clone) {
  var originalKey = C.storageKey;
  C.storageKey += "-tests";
  async function storeLegacySession(saved) {
    await T.resetAuthorityForFixture();
    localStorage.setItem(C.storageKey, typeof saved === "string" ? saved : JSON.stringify(saved));
  }
  var startTime = "2026-01-01T00:00:00.000Z";
  function savedSession(names, testIndex, questionIndex) {
    var answers = [];
    names.forEach(function (name, index) {
      var test = C.tests.filter(function (item) { return item.name === name; })[0];
      var count = index < testIndex ? test.questions.length : index === testIndex ? questionIndex : 0;
      answers = answers.concat(mockAnswers(name, test.questions[0].scores[0]).slice(0, count));
    });
    answers.forEach(function (answer, index) {
      answer.questionStartTime = new Date(Date.parse(startTime) + index * 1000).toISOString();
      answer.answerTime = new Date(Date.parse(startTime) + (index + 1) * 1000).toISOString();
    });
    return {
      version: 1, lang: C.lang, revision: C.revision, configSignature: T.configSignature(),
      participantId: "fixture", selectedTestNames: names,
      currentTestIndex: testIndex, currentQuestionIndex: questionIndex,
      answers: answers, testStartTime: startTime,
    };
  }
  function fullSession() {
    T.resetState();
    state.tests = C.tests.slice();
    state.answers = [];
    state.tests.forEach(function (test) {
      state.answers = state.answers.concat(mockAnswers(test.name, test.questions[0].scores[0]));
    });
    state.answers.forEach(function (answer, index) {
      answer.questionStartTime = new Date(Date.parse(startTime) + index * 1000).toISOString();
      answer.answerTime = new Date(Date.parse(startTime) + (index + 1) * 1000).toISOString();
    });
    state.testStartTime = new Date(startTime);
    state.testEndTime = new Date(Date.parse(startTime) + state.answers.length * 1000);
    state.participantId = '=SUM("a,b")\r' + "W".repeat(600);
  }
  function parseCSV(text) {
    var rows = [], row = [], field = "", quoted = false;
    text = text.replace(/^\uFEFF/, "");
    for (var i = 0; i < text.length; i++) {
      var value = text[i];
      if (value === '"') {
        if (quoted && text[i + 1] === '"') { field += '"'; i++; }
        else quoted = !quoted;
      } else if (value === "," && !quoted) { row.push(field); field = ""; }
      else if ((value === "\r" || value === "\n") && !quoted) {
        row.push(field); rows.push(row); row = []; field = "";
        if (value === "\r" && text[i + 1] === "\n") i++;
      } else field += value;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  T.prepareDownloadFixture = function () {
    fullSession();
    var description = 'cœur, "quotes" and accents\nFull descriptive response.';
    var firstPhobia = state.answers.filter(function (answer) { return answer.test === "FQ" && answer.questionIndex === 1; })[0];
    firstPhobia.description = description;
    ["setup-area", "instruction-area", "test-area"].forEach(function (id) { document.getElementById(id).replaceChildren(); });
    document.getElementById("nextBtn").classList.add("hidden");
    document.getElementById("progress-container").classList.add("hidden");
    T.displayResults(T.calculateSummaryScores());
    document.getElementById("download-buttons").classList.remove("hidden");
    return {
      lang: C.lang, revision: C.revision, participant: state.participantId,
      started: state.testStartTime.toISOString(), completed: state.testEndTime.toISOString(),
      description: description, filenames: C.export, ui: C.ui, metadata: C.testMetadata,
      answers: state.answers.map(function (answer) { return { test: answer.test, questionIndex: answer.questionIndex, optionIndex: answer.optionIndex, question: answer.question, answer: answer.answer, score: answer.score }; }),
    };
  };

  var valid = savedSession(["HADS"], 0, 2);
  assert(!!T.validateSession(valid), "resume: complete valid prefix accepted");
  assert(!!T.validateSession(savedSession(["HADS"], 0, 0)), "resume: started zero-answer session accepted");
  var completed = savedSession(C.tests.map(function (test) { return test.name; }), C.tests.length - 1, C.tests[C.tests.length - 1].questions.length);
  completed.status = "completed";
  completed.testEndTime = completed.answers[completed.answers.length - 1].answerTime;
  var canonicalCompleted = T.validateSession(completed);
  assert(!!canonicalCompleted && canonicalCompleted.status === "completed" && canonicalCompleted.testEndTime === completed.testEndTime, "completed save preserves its state and completion timestamp");
  assert(!!canonicalCompleted && canonicalCompleted.answers.length === 88, "completed save validates all 88 canonical answers");
  var invalidCompletedCases = [
    ["missing completion timestamp", function (saved) { delete saved.testEndTime; }],
    ["invalid completion timestamp", function (saved) { saved.testEndTime = "not-a-date"; }],
    ["completion before last answer", function (saved) { saved.testEndTime = saved.testStartTime; }],
    ["future completion", function (saved) { saved.testEndTime = new Date(Date.now() + 3600000).toISOString(); }],
    ["missing final answer", function (saved) { saved.answers.pop(); }],
    ["duplicate completed answer", function (saved) { saved.answers[1] = clone(saved.answers[0]); }],
    ["edited completed score", function (saved) { saved.answers[0].score = 999; }],
    ["unfinished final cursor", function (saved) { saved.currentQuestionIndex--; }],
    ["wrong final instrument", function (saved) { saved.currentTestIndex = 0; }],
    ["unknown completion status", function (saved) { saved.status = "exported"; }],
    ["completed answers without state", function (saved) { delete saved.status; }],
    ["obsolete completed revision", function (saved) { saved.revision = "obsolete"; }],
    ["completed language mismatch", function (saved) { saved.lang = C.lang === "en" ? "fr" : "en"; }],
  ];
  invalidCompletedCases.forEach(function (entry) {
    var saved = clone(completed);
    entry[1](saved);
    assert(T.validateSession(saved) === null, "completed resume rejects " + entry[0]);
  });
  var invalidCases = [
    ["legacy version", function (saved) { delete saved.version; }],
    ["revision", function (saved) { saved.revision = "obsolete"; }],
    ["language", function (saved) { saved.lang = C.lang === "en" ? "fr" : "en"; }],
    ["content signature", function (saved) { saved.configSignature = "changed-keys"; }],
    ["unknown selected test", function (saved) { saved.selectedTestNames = ["unknown"]; }],
    ["duplicate selected test", function (saved) { saved.selectedTestNames = ["HADS", "HADS"]; }],
    ["no selected test", function (saved) { saved.selectedTestNames = []; }],
    ["fractional test cursor", function (saved) { saved.currentTestIndex = 0.5; }],
    ["outdated test cursor", function (saved) { saved.currentTestIndex = 99; }],
    ["undefined question cursor", function (saved) { delete saved.currentQuestionIndex; }],
    ["fractional question cursor", function (saved) { saved.currentQuestionIndex = 1.5; }],
    ["negative question cursor", function (saved) { saved.currentQuestionIndex = -1; }],
    ["outdated question cursor", function (saved) { saved.currentQuestionIndex = 999; }],
    ["missing prefix answer", function (saved) { saved.answers.pop(); }],
    ["extra prefix answer", function (saved) { saved.answers.push(clone(saved.answers[0])); }],
    ["duplicate question", function (saved) { saved.answers[1] = clone(saved.answers[0]); }],
    ["shuffled prefix", function (saved) { saved.answers.reverse(); }],
    ["foreign answer", function (saved) { saved.answers[0].test = "BFI"; }],
    ["edited score", function (saved) { saved.answers[0].score = 999; }],
    ["invalid option", function (saved) { saved.answers[0].optionIndex = 99; }],
    ["fractional option", function (saved) { saved.answers[0].optionIndex = 0.5; }],
    ["edited question text", function (saved) { saved.answers[0].question = "obsolete item"; }],
    ["edited answer text", function (saved) { saved.answers[0].answer = "obsolete option"; }],
    ["invalid description type", function (saved) { saved.answers[0].description = {}; }],
    ["description on fixed item", function (saved) { saved.answers[0].description = "unexpected"; }],
    ["invalid start date", function (saved) { saved.testStartTime = "not-a-date"; }],
    ["invalid answer date", function (saved) { saved.answers[0].answerTime = "not-a-date"; }],
    ["invalid duration", function (saved) { saved.answers[0].time = Infinity; }],
    ["negative duration", function (saved) { saved.answers[0].time = -1; }],
    ["inconsistent duration", function (saved) { saved.answers[0].time = 99; }],
    ["answer before session", function (saved) { saved.testStartTime = "2026-01-02T00:00:00.000Z"; }],
    ["future start", function (saved) { saved.testStartTime = new Date(Date.now() + 3600000).toISOString(); }],
    ["future answer", function (saved) { saved.answers[1].questionStartTime = new Date(Date.now() + 3600000).toISOString(); saved.answers[1].answerTime = new Date(Date.now() + 3601000).toISOString(); }],
    ["completion timestamp on unfinished save", function (saved) { saved.testEndTime = saved.answers[1].answerTime; }],
    ["unknown session status", function (saved) { saved.status = "unknown"; }],
    ["incomplete answers marked completed", function (saved) { saved.status = "completed"; saved.testEndTime = saved.answers[1].answerTime; }],
  ];
  invalidCases.forEach(function (entry) {
    var saved = clone(valid);
    entry[1](saved);
    assert(T.validateSession(saved) === null, "resume rejects " + entry[0]);
  });
  assert(T.validateSession(null) === null, "resume rejects null state");
  var originalScore = C.tests[0].questions[0].scores[0];
  C.tests[0].questions[0].scores[0] = 999;
  assert(T.validateSession(valid) === null, "resume rejects changed live item scoring");
  C.tests[0].questions[0].scores[0] = originalScore;
  await storeLegacySession("{");
  assert(T.loadProgress() === null, "malformed JSON cannot resume");
  await T.whenPersistenceSettled();
  assert(localStorage.getItem(C.storageKey) === "{", "malformed save remains unchanged for backup and explicit clearing");
  for (var preservedCase of ["revision", "content signature", "future start"]) {
    var incompatible = clone(valid);
    invalidCases.filter(function (entry) { return entry[0] === preservedCase; })[0][1](incompatible);
    var incompatibleRaw = JSON.stringify(incompatible);
    await storeLegacySession(incompatibleRaw);
    assert(T.loadProgress() === null, "unavailable draft cannot resume: " + preservedCase);
    await T.whenPersistenceSettled();
    assert(localStorage.getItem(C.storageKey) === incompatibleRaw, "unavailable draft is preserved exactly: " + preservedCase);
  }
  T.showResumeScreen(incompatible);
  assert(!!document.getElementById("downloadStoredBackup") && !document.getElementById("resumeBtn"), "direct invalid resume offers original-data backup without resuming");
  assert(localStorage.getItem(C.storageKey) === incompatibleRaw, "direct invalid resume preserves original saved bytes");

  state.tests = C.tests.filter(function (test) { return test.name === "HADS"; });
  state.answers = mockAnswers("HADS", 0);
  state.answers.pop();
  assertThrows(T.calculateSummaryScores, "partial HADS cannot produce a normal/zero summary");
  state.answers = mockAnswers("HADS", 0);
  state.answers[1] = clone(state.answers[0]);
  assertThrows(T.calculateSummaryScores, "duplicate HADS item cannot be scored");
  state.answers = mockAnswers("HADS", 0);
  state.answers[0].optionIndex = 99;
  assertThrows(T.calculateSummaryScores, "unknown option cannot be scored");
  state.answers = mockAnswers("HADS", 0);
  state.answers[0].score = 3;
  assertThrows(T.calculateSummaryScores, "score conflicting with valid option cannot be scored");
  state.answers = mockAnswers("HADS", 0);
  state.answers[0].test = "unknown";
  assertThrows(T.calculateSummaryScores, "unknown test response cannot be scored");

  var badConfigs = [
    ["unsupported scoring type", function (config) { config.scoring.HADS.type = "typo"; }],
    ["infinite option score", function (config) { config.tests[0].questions[0].scores[0] = Infinity; }],
    ["empty tests", function (config) { config.tests = []; }],
    ["empty questions", function (config) { config.tests[0].questions = []; }],
    ["empty options", function (config) { config.tests[0].questions[0].options = []; }],
    ["duplicate test name", function (config) { config.tests.push(clone(config.tests[0])); }],
    ["duplicate group index", function (config) { config.scoring.HADS.subscales.Anxiety.push(1); }],
    ["empty group", function (config) { config.scoring.HADS.subscales.Anxiety = []; }],
    ["malformed group", function (config) { config.scoring.HADS.subscales.Anxiety = "wrong"; }],
    ["missing group label", function (config) { delete config.subscaleLabels.Anxiety; }],
    ["missing instrument metadata", function (config) { delete config.testMetadata.HADS; }],
    ["nonfinite threshold", function (config) { config.thresholds.HADS.Anxiety.ranges[0][1] = Infinity; }],
    ["malformed threshold", function (config) { config.thresholds.HADS.Anxiety.ranges[0] = null; }],
    ["unknown threshold subscale", function (config) { config.thresholds.HADS.Typo = { ranges: [[0, 7, "range"]] }; }],
    ["missing UI label", function (config) { delete config.ui.colRange; }],
    ["missing Clear Data failure message", function (config) { delete config.ui.alertClearDataFail; }],
    ["misaligned CSV columns", function (config) { config.ui.csvHeaders = "only,two"; }],
    ["missing export filename", function (config) { delete config.export.csvFilename; }],
  ];
  badConfigs.forEach(function (entry) {
    var config = clone(C);
    entry[1](config);
    assert(T.validateConfig(config).length > 0, "config rejects " + entry[0]);
  });
  assert(T.validateConfig(null).length > 0, "config rejects null without throwing");

  await storeLegacySession(valid);
  T.showResumeScreen(valid);
  document.getElementById("resumeBtn").click();
  await T.whenPersistenceSettled();
  assert(state.answers.length === 2 && state.currentQuestionIndex === 2, "resume loads validated answers and cursor");
  assert(document.querySelector("#test-area .question").textContent === C.tests[0].questions[2].q, "resume displays correct next question");
  var longIdSave = clone(valid);
  longIdSave.participantId = "W".repeat(600);
  T.showResumeScreen(longIdSave);
  assert(document.documentElement.scrollWidth <= window.innerWidth, "resume wraps long unbroken participant ID");
  T.showResumeScreen(valid);
  var oldResume = document.getElementById("resumeBtn");
  await storeLegacySession(valid);
  await T.resetAuthorityForFixture("psychometric_progress_en");
  await T.resetAuthorityForFixture("psychometric_progress_fr");
  localStorage.setItem("psychometric_progress_en", "en-snapshot");
  localStorage.setItem("psychometric_progress_fr", "fr-snapshot");
  localStorage.setItem("psychometric-unrelated-test", "keep");
  document.getElementById("clearDataBtn").click();
  await T.whenPersistenceSettled();
  oldResume.click();
  assert(!document.getElementById("resumeBtn"), "Clear removes the stale Resume prompt");
  assert(!!document.getElementById("participantIdInput"), "Clear returns to setup");
  assert(state.answers.length === 0 && !state.testInProgress, "detached Resume cannot revive cleared data");
  assert(localStorage.getItem("psychometric_progress_en") === null && localStorage.getItem("psychometric_progress_fr") === null, "Clear removes both known locale saves");
  assert(localStorage.getItem(C.storageKey) === null, "Clear removes the configured storage key");
  assert(document.querySelector('#setup-area [role="status"]').textContent === C.ui.dataCleared, "Clear reports success after all saves are removed");
  assert(localStorage.getItem("psychometric-unrelated-test") === "keep", "Clear preserves unrelated storage");
  localStorage.removeItem("psychometric-unrelated-test");

  var clearKeys = ["psychometric_progress_en", "psychometric_progress_fr", C.storageKey];
  for (var failure of ["remove throws", "remove silently fails", "verification throws"]) {
    for (var failedKey of clearKeys) {
      for (var clearKey of clearKeys) await T.resetAuthorityForFixture(clearKey);
      clearKeys.forEach(function (key) { localStorage.setItem(key, "saved responses"); });
      localStorage.setItem(C.storageKey, JSON.stringify(valid));
      T.showResumeScreen(valid);
      document.getElementById("resumeBtn").click();
      await T.whenPersistenceSettled();
      var originalRemove = Storage.prototype.removeItem;
      var originalGet = Storage.prototype.getItem;
      var removalAttempts = [];
      var label = failure + " for " + failedKey;
      Storage.prototype.removeItem = function (key) {
        if (this === localStorage) {
          removalAttempts.push(key);
          if (key === failedKey && failure === "remove throws") throw new Error("Storage deletion denied");
          if (key === failedKey && failure === "remove silently fails") return;
        }
        return originalRemove.apply(this, arguments);
      };
      Storage.prototype.getItem = function (key) {
        if (this === localStorage && key === failedKey && failure === "verification throws") throw new Error("Storage verification denied");
        return originalGet.apply(this, arguments);
      };
      try {
        document.getElementById("clearDataBtn").click();
        await T.whenPersistenceSettled();
        var clearStatus = document.querySelector('#setup-area [role="status"]');
        assert(!!clearStatus && clearStatus.textContent === C.ui.alertClearDataFail && clearStatus.textContent !== C.ui.dataCleared, "Clear reports localized failure: " + label);
        assert(clearKeys.every(function (key) { return removalAttempts.indexOf(key) !== -1; }), "Clear attempts all saves after failure: " + label);
        assert(state.answers.length === 0 && !state.testInProgress && state.testStartTime === null && state.testEndTime === null, "Clear resets active session despite failure: " + label);
        assert(!!document.getElementById("participantIdInput") && !document.getElementById("resumeBtn"), "Clear returns to setup despite failure: " + label);
      } finally {
        Storage.prototype.removeItem = originalRemove;
        Storage.prototype.getItem = originalGet;
      }
      assert(clearKeys.every(function (key) { return key === failedKey || localStorage.getItem(key) === null; }), "Clear removes unaffected saves: " + label);
      if (failure !== "verification throws") {
        assert(localStorage.getItem(failedKey) !== null, "failed Clear still has saved responses: " + label);
      }
      await T.clearAllData();
      assert(clearKeys.every(function (key) { return localStorage.getItem(key) === null; }) && document.querySelector('#setup-area [role="status"]').textContent === C.ui.dataCleared, "Clear retry succeeds after storage recovers: " + label);
    }
  }

  await storeLegacySession(valid);
  T.showResumeScreen(valid);
  var externalResume = document.getElementById("resumeBtn");
  localStorage.removeItem(C.storageKey);
  window.dispatchEvent(new StorageEvent("storage", { key: C.storageKey, newValue: null, storageArea: localStorage }));
  await T.whenPersistenceSettled();
  externalResume.click();
  await T.whenPersistenceSettled();
  assert(state.answers.length === 0 && !!document.getElementById("participantIdInput"), "external storage removal invalidates detached Resume closure");
  await storeLegacySession(valid);
  T.showResumeScreen(valid);
  document.getElementById("resumeBtn").click();
  await T.whenPersistenceSettled();
  window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: null, storageArea: localStorage }));
  assert(state.testInProgress && state.answers.length === 2, "unrelated storage removal does not reset this session");
  var otherKey = C.lang === "en" ? "psychometric_progress_fr" : "psychometric_progress_en";
  window.dispatchEvent(new StorageEvent("storage", { key: otherKey, newValue: null, storageArea: localStorage }));
  assert(state.testInProgress && state.answers.length === 2, "other-locale removal alone does not reset this session");
  localStorage.removeItem(C.storageKey);
  document.getElementById("option0").click();
  document.getElementById("nextBtn").click();
  await T.whenPersistenceSettled();
  assert(state.answers.length === 2 && localStorage.getItem(C.storageKey) === null && document.getElementById("nextBtn").disabled, "unexplained missing save preserves submitted answers and blocks replacing browser data");
  assert(JSON.parse(T.buildProgressBackup()).answers.length === 2 && document.getElementById("persistence-status").textContent === C.ui.progressConflict, "unexplained missing save offers intact progress backup and conflict feedback");


  await storeLegacySession(valid);
  T.showResumeScreen(valid);
  var clearedResume = document.getElementById("resumeBtn");
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null, storageArea: localStorage }));
  assert(!document.getElementById("resumeBtn"), "external storage clear removes Resume prompt immediately");
  clearedResume.click();
  assert(state.answers.length === 0 && !!document.getElementById("participantIdInput"), "external storage clear invalidates detached Resume closure");

  await storeLegacySession(valid);
  T.showResumeScreen(valid);
  document.getElementById("resumeBtn").click();
  await T.whenPersistenceSettled();
  window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null, storageArea: sessionStorage }));
  assert(state.testInProgress && state.answers.length === 2, "sessionStorage clear does not reset local progress");
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null, storageArea: localStorage }));
  assert(state.answers.length === 0 && !state.testInProgress && !!document.getElementById("participantIdInput"), "external storage clear ends active session immediately");

  T.prepareDownloadFixture();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null, storageArea: localStorage }));
  assert(state.answers.length === 0 && state.testEndTime === null, "external storage clear invalidates completed results");
  assert(document.getElementById("results-area").classList.contains("hidden") && document.getElementById("download-buttons").classList.contains("hidden"), "external storage clear hides completed results and exports");

  var stale = clone(valid);
  stale.currentTestIndex = 99;
  T.showResumeScreen(stale);
  assert(!document.getElementById("resumeBtn"), "obsolete resume is rejected before offering Resume");
  assert(state.answers.length === 0, "rejected save never contaminates live answers");
  Array.prototype.forEach.call(document.querySelectorAll(".test-checkbox"), function (checkbox) { checkbox.checked = checkbox.value === "0"; });
  document.getElementById("nextBtn").click();
  await T.whenPersistenceSettled();
  assert(state.answers.length === 0 && state.testInProgress, "new session starts clean after rejected resume");
  assertThrows(T.calculateSummaryScores, "new incomplete session cannot score as normal");
  await new Promise(function (resolve) { setTimeout(resolve, 320); });
  document.getElementById("option0").click();
  document.getElementById("nextBtn").click();
  await T.whenPersistenceSettled();
  assert(state.answers.length === 1 && !!localStorage.getItem(C.storageKey), "active answer creates resumable progress");
  document.getElementById("clearDataBtn").click();
  await T.whenPersistenceSettled();
  await T.saveProgress();
  assert(state.answers.length === 0 && localStorage.getItem(C.storageKey) === null, "Clear during progress stops the old session from saving again");
  assert(document.getElementById("results-area").classList.contains("hidden") && document.getElementById("download-buttons").classList.contains("hidden"), "Clear hides old results and exports");

  T.resetState();
  state.tests = C.tests.filter(function (test) { return test.name === "FQ"; });
  state.testStartTime = new Date();
  state.testInProgress = true;
  state.totalQuestions = state.tests[0].questions.length;
  T.loadTest(state.tests[0]);
  var description = document.getElementById("question-description");
  assert(!!description, "FQ main phobia accepts a description");
  description.value = 'Fears 123, "quotes" and accents: cœur <b>plain text</b>\n=1+1';
  var entered = description.value;
  var number = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
  var enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  description.dispatchEvent(number);
  description.dispatchEvent(enter);
  assert(!number.defaultPrevented && !enter.defaultPrevented && !document.querySelector('#test-area input[type="radio"]:checked'), "description typing does not trigger answer shortcuts");
  document.getElementById("option2").click();
  assert(T.recordAnswer(), "FQ descriptive question records its numeric option");
  assert(state.answers[0].description === entered && state.answers[0].optionIndex === 2, "description and option identity stay separate");
  state.currentQuestionIndex = 1;
  await T.saveProgress();
  var descriptionSave = T.loadProgress();
  assert(!!descriptionSave && descriptionSave.answers[0].description === entered, "description survives saved-session validation");
  T.showResumeScreen(descriptionSave);
  document.getElementById("resumeBtn").click();
  await T.whenPersistenceSettled();
  assert(state.answers[0].description === entered, "description survives resume");
  await T.clearAllData();

  T.resetState();
  state.tests = C.tests.filter(function (test) { return test.name === "STAI-S"; });
  T.loadTest(state.tests[0]);
  assert(document.querySelector(".instrument-notice").textContent === C.testMetadata["STAI-S"].notice, "STAI item screen carries the instrument notice");

  fullSession();
  var descriptive = state.answers.filter(function (answer) { return answer.test === "FQ" && answer.questionIndex === 1; })[0];
  descriptive.description = entered;
  var before = T.calculateSummaryScores().FQ;
  descriptive.description += " extra description";
  assert(JSON.stringify(T.calculateSummaryScores().FQ) === JSON.stringify(before), "free text does not alter FQ normative scores");
  descriptive.description = entered;
  T.displayResults(T.calculateSummaryScores());
  var summaryCells = Array.prototype.map.call(document.querySelectorAll("#results-area tbody tr"), function (row) { return Array.prototype.map.call(row.cells, function (cell) { return cell.textContent; }); });
  assert(summaryCells.some(function (cells) { return cells[0] === "BFI" && cells[1] === C.subscaleLabels.Openness; }), "results use localized subscale labels");
  assert(summaryCells.some(function (cells) { return cells[0] === "STAI-S" && cells[3] === "20-80" && cells[4] === C.ui.rawScoreLabel; }), "results show STAI range and raw-score qualifier");
  assert(Array.prototype.every.call(document.querySelectorAll("#results-area tbody tr"), function (row) { return row.cells[0].textContent === "HADS" || !/interp-/.test(row.cells[4].className); }), "clinical color is confined to HADS screening results");
  assert(document.querySelectorAll("#results-area th").length === 5, "result table has aligned score/range/interpretation columns");

  var csv = T.buildCSV();
  assert(csv.charCodeAt(0) === 0xFEFF, "CSV retains UTF-8 BOM");
  var rows = parseCSV(csv);
  function metadata(label) { return rows.filter(function (row) { return row[0] === label; })[0]; }
  assert(metadata(C.ui.csvParticipant)[1] === "'" + state.participantId, "CSV guards and quotes formula-looking long ID with CR");
  assert(metadata(C.ui.csvLanguage)[1] === C.lang && metadata(C.ui.csvRevision)[1] === C.revision, "CSV includes locale and revision");
  assert(metadata(C.ui.csvStarted)[1] === state.testStartTime.toISOString() && metadata(C.ui.csvCompleted)[1] === state.testEndTime.toISOString(), "CSV exports frozen assessment timestamps");
  assert(metadata(C.ui.csvGenerated)[1] !== metadata(C.ui.csvStarted)[1], "CSV labels generation separately from assessment start");
  assert(metadata(C.ui.csvDisclaimer)[1] === C.ui.disclaimer, "CSV includes the screening disclaimer");
  var summaryIndex = rows.findIndex(function (row) { return row.join(",") === C.ui.csvSummaryHeaders; });
  var detailsIndex = rows.findIndex(function (row) { return row.join(",") === C.ui.csvHeaders; });
  var summaryRows = rows.slice(summaryIndex + 1, detailsIndex).filter(function (row) { return row.length === 6; });
  var detailRows = rows.slice(detailsIndex + 1).filter(function (row) { return row.length === 10; });
  assert(detailRows.length === 88, "CSV contains every one of the 88 responses");
  assert(summaryRows.some(function (row) { return row[0] === "BFI" && row[1] === "Openness" && row[2] === C.subscaleLabels.Openness; }), "CSV retains stable keys and localized display labels");
  assert(detailRows.some(function (row) { return row[0] === "FQ" && row[1] === "1" && row[5] === entered; }), "CSV preserves descriptive text, accents, quotes and newlines");
  assert(detailRows.every(function (row) { return /^\d+$/.test(row[1]) && /^\d+$/.test(row[2]); }), "CSV exports stable item and option identities");
  C.tests.forEach(function (test) {
    var metadataRow = C.testMetadata[test.name];
    assert(rows.some(function (row) { return row[0] === C.ui.csvForm && row[1] === test.name && row[2] === metadataRow.form; }), "CSV form provenance: " + test.name);
    assert(rows.some(function (row) { return row[0] === C.ui.csvNotice && row[1] === test.name && row[2] === metadataRow.notice; }), "CSV notice: " + test.name);
  });
  var duration = metadata(C.ui.csvDuration)[1];
  assert(duration === ((state.testEndTime - state.testStartTime) / 60000).toFixed(2) && T.buildCSV().includes(C.ui.csvDuration + "," + duration), "completed duration uses frozen start/end across exports");

  var RealPDF = window.jspdf.jsPDF;
  var drawn = [], splitInputs = [];
  window.jspdf.jsPDF = function () {
    var doc = new RealPDF();
    var realText = doc.text;
    var realSplit = doc.splitTextToSize;
    doc.text = function (text, x, y) {
      drawn.push({ text: text, x: x, y: y, page: doc.internal.getCurrentPageInfo().pageNumber, width: doc.getTextWidth(String(text)) });
      return realText.apply(doc, arguments);
    };
    doc.splitTextToSize = function (text, width) {
      splitInputs.push(String(text));
      return realSplit.call(doc, text, width);
    };
    return doc;
  };
  var pdf;
  try { pdf = T.buildPDF(); } finally { window.jspdf.jsPDF = RealPDF; }
  var pageWidth = pdf.internal.pageSize.getWidth();
  var pageHeight = pdf.internal.pageSize.getHeight();
  assert(pdf.internal.getNumberOfPages() > 1, "real jsPDF paginates complete responses and long ID");
  assert(drawn.every(function (item) { return item.x >= 10 && item.x + item.width <= pageWidth - 9.8 && item.y > 0 && item.y <= pageHeight - 10; }), "PDF text fits within measured page margins");
  assert(splitInputs.indexOf(C.ui.pdfParticipant + " " + state.participantId) !== -1, "PDF wraps the full long participant ID");
  assert(state.answers.every(function (answer) { return splitInputs.indexOf(answer.question) !== -1; }), "PDF retains all full item wording without 85-character truncation");
  assert(drawn.filter(function (item) { return item.text.indexOf(C.ui.pdfTest + " ") === 0; }).length === 88, "PDF includes all 88 stable item headers");
  assert(splitInputs.indexOf(C.ui.pdfDescription + " " + entered) !== -1, "PDF retains full descriptive text");
  assert(splitInputs.indexOf(C.ui.pdfDisclaimer + " " + C.ui.disclaimer) !== -1, "PDF carries the screening disclaimer");
  assert(splitInputs.some(function (text) { return text.indexOf(C.ui.pdfStarted + " " + startTime) === 0; }), "PDF includes assessment start separately from generation");
  assert(splitInputs.some(function (text) { return text.indexOf(C.ui.pdfLanguage + " " + C.lang) === 0; }), "PDF includes locale and revision");
  for (var page = 1; page <= pdf.internal.getNumberOfPages(); page++) {
    var pageText = drawn.filter(function (item) { return item.page === page; }).map(function (item) { return item.text; }).join(" ").replace(/\s+/g, " ");
    assert(pageText.includes(C.testMetadata["STAI-S"].notice.replace(/\s+/g, " ")), "PDF STAI notice on page " + page);
  }
  assert(pdf.output("arraybuffer").byteLength > 1000, "real jsPDF produces a nonempty document");
  assert(!new Uint8Array(pdf.output("arraybuffer")).includes(0), "supported PDF text produces no NUL-corrupted strings");
  assert(T.pdfTextSupported("cœur œ é ™ €"), "PDF built-in font accepts original French accents, ligature and trademark");
  assert(!T.pdfTextSupported("東京 🙂"), "PDF rejects unsupported CJK and emoji before drawing");

  var savedCreate = URL.createObjectURL, savedRevoke = URL.revokeObjectURL;
  var savedClick = HTMLAnchorElement.prototype.click, savedAlert = window.alert;
  var downloaded = [], alerts = [];
  URL.createObjectURL = function (blob) { downloaded.push(blob); return "blob:test"; };
  URL.revokeObjectURL = function () {};
  HTMLAnchorElement.prototype.click = function () {};
  window.alert = function (message) { alerts.push(message); };
  try {
    descriptive.description = "cœur 東京 🙂";
    assertThrows(T.buildPDF, "real jsPDF report is blocked before unsupported text can corrupt it");
    T.generatePDF();
    assert(downloaded.length === 1 && alerts[0] === C.ui.alertPdfEncoding, "unsupported PDF text triggers specific localized CSV fallback");
    assert((await downloaded[0].text()).includes("cœur 東京 🙂"), "Unicode fallback preserves the full original text in UTF-8 CSV");
    descriptive.description = entered;
    downloaded = [];
    alerts = [];
    window.jspdf = undefined;
    T.generatePDF();
    assert(downloaded.length === 1 && alerts[0] === C.ui.alertPdfFail, "missing PDF library falls back to a real CSV blob and localized message");
    assert((await downloaded[0].text()).includes(C.ui.csvHeaders), "fallback CSV blob contains complete response data");
  } finally {
    window.jspdf = { jsPDF: RealPDF };
    URL.createObjectURL = savedCreate;
    URL.revokeObjectURL = savedRevoke;
    HTMLAnchorElement.prototype.click = savedClick;
    window.alert = savedAlert;
  }
  var completedAt = state.testEndTime;
  state.testEndTime = new Date(Date.now() + 3600000);
  assertThrows(T.buildCSV, "future completion timestamp cannot be exported");
  state.testEndTime = completedAt;
  state.answers.pop();
  assertThrows(T.buildCSV, "incomplete answers cannot be exported as CSV");
  assertThrows(T.buildPDF, "incomplete answers cannot be exported as PDF");
  await T.clearAllData();
  C.storageKey = originalKey;
}
