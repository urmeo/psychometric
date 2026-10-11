(function () {
  "use strict";

  var C = window.CONFIG || {};
  var ui = C.ui || {};
  var allTests = Array.isArray(C.tests) ? C.tests : [];
  var SESSION_VERSION = 1;
  var sessionGeneration = 0;
  var invalidSavedSession = false;
  var progressPersisted = false;
  var state = {
    currentTestIndex: 0,
    currentQuestionIndex: 0,
    totalQuestions: 0,
    answers: [],
    testStartTime: null,
    testEndTime: null,
    questionStartTime: null,
    resultsExported: false,
    testInProgress: false,
    participantId: "",
    tests: [],
  };

  function isInt(value) {
    return typeof value === "number" && Number.isFinite(value) && Math.floor(value) === value;
  }
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
    return allTests.filter(function (test) { return test.name === name; })[0];
  }

  function resetState() {
    sessionGeneration++;
    progressPersisted = false;
    state.currentTestIndex = 0;
    state.currentQuestionIndex = 0;
    state.totalQuestions = 0;
    state.answers = [];
    state.testStartTime = null;
    state.testEndTime = null;
    state.questionStartTime = null;
    state.resultsExported = false;
    state.testInProgress = false;
    state.participantId = "";
    state.tests = [];
  }

  function configSignature() {
    return JSON.stringify({
      lang: C.lang,
      revision: C.revision,
      tests: allTests.map(function (test) {
        return { name: test.name, questions: test.questions, metadata: C.testMetadata[test.name] };
      }),
      scoring: C.scoring,
    });
  }

  function canonicalAnswer(answer, test, questionIndex, checkTimes) {
    if (!isObject(answer) || answer.test !== test.name || answer.questionIndex !== questionIndex) return null;
    var question = test.questions[questionIndex - 1];
    if (!question || !isInt(answer.optionIndex) || answer.optionIndex < 0 || answer.optionIndex >= question.options.length) return null;
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

  function validateSession(saved) {
    if (!isObject(saved) || saved.version !== SESSION_VERSION || saved.lang !== C.lang || saved.revision !== C.revision || saved.configSignature !== configSignature()) return null;
    if (typeof saved.participantId !== "string" || !validDate(saved.testStartTime) || !Array.isArray(saved.answers) || !Array.isArray(saved.selectedTestNames) || !saved.selectedTestNames.length) return null;
    var names = saved.selectedTestNames;
    if (names.some(function (name, index) { return typeof name !== "string" || !testByName(name) || names.indexOf(name) !== index; })) return null;
    var tests = allTests.filter(function (test) { return names.indexOf(test.name) !== -1; });
    if (tests.some(function (test, index) { return test.name !== names[index]; })) return null;
    if (!isInt(saved.currentTestIndex) || saved.currentTestIndex < 0 || saved.currentTestIndex >= tests.length) return null;
    var currentTest = tests[saved.currentTestIndex];
    if (!isInt(saved.currentQuestionIndex) || saved.currentQuestionIndex < 0 || saved.currentQuestionIndex >= currentTest.questions.length) return null;
    var prefix = [];
    tests.forEach(function (test, index) {
      var count = index < saved.currentTestIndex ? test.questions.length : index === saved.currentTestIndex ? saved.currentQuestionIndex : 0;
      for (var question = 1; question <= count; question++) prefix.push({ test: test, question: question });
    });
    if (saved.answers.length !== prefix.length) return null;
    var previousTime = Date.parse(saved.testStartTime);
    var now = Date.now();
    if (previousTime > now) return null;
    var answers = [];
    for (var i = 0; i < prefix.length; i++) {
      var answer = canonicalAnswer(saved.answers[i], prefix[i].test, prefix[i].question, true);
      if (!answer || Date.parse(answer.questionStartTime) < previousTime || Date.parse(answer.answerTime) > now) return null;
      previousTime = Date.parse(answer.answerTime);
      answers.push(answer);
    }
    return {
      version: SESSION_VERSION,
      lang: C.lang,
      revision: C.revision,
      configSignature: configSignature(),
      participantId: saved.participantId,
      currentTestIndex: saved.currentTestIndex,
      currentQuestionIndex: saved.currentQuestionIndex,
      answers: answers,
      testStartTime: saved.testStartTime,
      selectedTestNames: names.slice(),
    };
  }

  function storedProgressAvailable() {
    if (!progressPersisted) return true;
    var raw;
    try {
      raw = localStorage.getItem(C.storageKey);
    } catch (error) { return true; }
    var saved;
    try { saved = JSON.parse(raw); } catch (error) { saved = null; }
    if (!saved || saved.testStartTime !== state.testStartTime.toISOString()) {
      resetState();
      showSetupScreen(raw === null ? ui.dataCleared : ui.invalidSession);
      return false;
    }
    return true;
  }
  function saveProgress() {
    if (!state.testInProgress || !storedProgressAvailable()) return;
    try {
      localStorage.setItem(C.storageKey, JSON.stringify({
        version: SESSION_VERSION,
        lang: C.lang,
        revision: C.revision,
        configSignature: configSignature(),
        participantId: state.participantId,
        currentTestIndex: state.currentTestIndex,
        currentQuestionIndex: state.currentQuestionIndex,
        answers: state.answers,
        testStartTime: state.testStartTime.toISOString(),
        selectedTestNames: state.tests.map(function (test) { return test.name; }),
      }));
      progressPersisted = true;
    } catch (error) { }
  }
  function clearProgress() {
    try { localStorage.removeItem(C.storageKey); } catch (error) { }
  }
  function loadProgress() {
    invalidSavedSession = false;
    try {
      var raw = localStorage.getItem(C.storageKey);
      if (raw === null) return null;
      var saved = validateSession(JSON.parse(raw));
      if (saved) return saved;
    } catch (error) { }
    invalidSavedSession = true;
    clearProgress();
    return null;
  }
  function clearAllData() {
    ["psychometric_progress_en", "psychometric_progress_fr", C.storageKey].forEach(function (key) {
      try { localStorage.removeItem(key); } catch (error) { }
    });
    resetState();
    showSetupScreen(ui.dataCleared);
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
      if (!test || !isInt(answer.questionIndex)) throw new Error(ui.invalidResults);
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
      var config = C.scoring[test.name];
      if (config.type === "total") {
        scores[test.name] = test.questions.reduce(function (sum, question, index) { return sum + byQuestion[index + 1]; }, 0);
      } else {
        var groups = config.subscales || config.traits;
        scores[test.name] = {};
        Object.keys(groups).forEach(function (name) {
          var sum = groups[name].reduce(function (total, index) { return total + byQuestion[index]; }, 0);
          scores[test.name][name] = config.type === "trait-average" ? sum / groups[name].length : sum;
        });
      }
    });
    return scores;
  }
  function getInterpretation(testName, subscale, score) {
    var threshold = C.thresholds[testName];
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
    var configuredHads = C.thresholds.HADS;
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
    var config = C.scoring[testName];
    var groups = config.subscales || config.traits;
    var indices = groups ? groups[subscale] : test.questions.map(function (question, index) { return index + 1; });
    return ["min", "max"].map(function (bound) {
      var total = indices.reduce(function (sum, index) { return sum + Math[bound].apply(Math, test.questions[index - 1].scores); }, 0);
      return config.type === "trait-average" ? total / indices.length : total;
    });
  }
  function formatScoreValue(value) {
    return typeof value === "number" && !isInt(value) ? value.toFixed(2) : String(value);
  }
  function summaryRows(summary) {
    var rows = [];
    Object.keys(summary).forEach(function (name) {
      var values = typeof summary[name] === "object" ? summary[name] : { Total: summary[name] };
      Object.keys(values).forEach(function (key) {
        rows.push({
          test: name, key: key, label: key === "Total" ? ui.totalLabel : C.subscaleLabels[key],
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
      "clearDataBtn", "dataCleared", "consent", "participantLabel", "participantPlaceholder",
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
    ["csvFilename", "pdfFilename"].forEach(function (key) {
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
        if (indices.some(function (index, position) { return !isInt(index) || index < 1 || !Array.isArray(byName[name].questions) || index > byName[name].questions.length || indices.indexOf(index) !== position; })) problems.push(name + "." + group + ": invalid or duplicate item index");
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
    var button = $("#nextBtn");
    button.textContent = ui.startBtn;
    button.disabled = false;
    show(button);
  }
  function showResumeScreen(saved) {
    var snapshot = validateSession(saved);
    if (!snapshot) {
      clearProgress();
      resetState();
      showSetupScreen(ui.invalidSession);
      return;
    }
    var generation = ++sessionGeneration;
    var area = $("#setup-area");
    empty(area);
    var message = ui.resumeFound;
    if (snapshot.participantId) message += " (" + ui.resumeParticipant + ": " + snapshot.participantId + ")";
    message += ": " + snapshot.answers.length + " " + ui.resumeAnswers;
    var resume = el("button", { id: "resumeBtn", className: "btn btn-primary me-2", text: ui.resumeBtn });
    var start = el("button", { id: "newSessionBtn", className: "btn btn-outline-secondary", text: ui.newSessionBtn });
    area.appendChild(el("div", { className: "resume-prompt" }, [el("p", { text: message }), resume, start]));
    hide($("#nextBtn"));
    resume.addEventListener("click", function () {
      if (generation !== sessionGeneration) return;
      var session = loadProgress();
      if (!session || session.testStartTime !== snapshot.testStartTime || session.participantId !== snapshot.participantId || JSON.stringify(session.selectedTestNames) !== JSON.stringify(snapshot.selectedTestNames)) {
        resetState();
        showSetupScreen(ui.dataCleared);
        return;
      }
      resetState();
      state.participantId = session.participantId;
      state.currentTestIndex = session.currentTestIndex;
      state.currentQuestionIndex = session.currentQuestionIndex;
      state.answers = session.answers;
      state.testStartTime = new Date(session.testStartTime);
      state.tests = allTests.filter(function (test) { return session.selectedTestNames.indexOf(test.name) !== -1; });
      state.totalQuestions = state.tests.reduce(function (sum, test) { return sum + test.questions.length; }, 0);
      state.testInProgress = true;
      progressPersisted = true;
      empty(area);
      show($("#progress-container"));
      var button = $("#nextBtn");
      button.textContent = ui.nextBtn;
      button.disabled = false;
      show(button);
      loadTest(state.tests[state.currentTestIndex]);
    });
    start.addEventListener("click", function () {
      if (generation !== sessionGeneration) return;
      clearProgress();
      resetState();
      showSetupScreen();
    });
  }
  function loadTest(test) {
    var area = $("#instruction-area");
    empty(area);
    if (test.instructions) area.appendChild(el("div", { className: "instruction", text: test.instructions }));
    loadQuestion(test.questions[state.currentQuestionIndex]);
  }
  function loadQuestion(question) {
    state.questionStartTime = new Date();
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
    area.appendChild(el("p", { className: "instrument-notice", text: C.testMetadata[state.tests[state.currentTestIndex].name].notice }));
    updateProgressBar();
    prompt.focus();
  }
  function recordAnswer() {
    var selected = $('#test-area input[type="radio"]:checked');
    if (!selected || !/^\d+$/.test(selected.value)) return false;
    var index = Number(selected.value);
    var test = state.tests[state.currentTestIndex];
    var question = test.questions[state.currentQuestionIndex];
    if (!isInt(index) || index >= question.options.length) return false;
    var now = new Date();
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
    row([ui.csvLanguage, C.lang]);
    row([ui.csvRevision, C.revision]);
    row([ui.csvStarted, state.testStartTime.toISOString()]);
    row([ui.csvCompleted, state.testEndTime.toISOString()]);
    row([ui.csvGenerated, new Date().toISOString()]);
    row([ui.csvDuration, sessionMinutes(2)]);
    row([ui.csvTestsCompleted, state.tests.map(function (test) { return test.name; }).join("; ")]);
    state.tests.forEach(function (test) {
      var metadata = C.testMetadata[test.name];
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
      var blob = new Blob([buildCSV()], { type: "text/csv;charset=utf-8;" });
      var link = el("a", { download: C.export.csvFilename });
      var url = URL.createObjectURL(blob);
      link.href = url;
      link.style.visibility = "hidden";
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); URL.revokeObjectURL(url); }
      state.resultsExported = true;
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
    Object.keys(C.subscaleLabels).forEach(function (key) { text.push(C.subscaleLabels[key]); });
    state.tests.forEach(function (test) {
      var metadata = C.testMetadata[test.name];
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
    var notices = state.tests.map(function (test) { return C.testMetadata[test.name].notice; }).filter(function (notice, index, list) { return list.indexOf(notice) === index; });
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
    write(ui.pdfLanguage + " " + C.lang + " | " + ui.pdfRevision + " " + C.revision);
    write(ui.pdfStarted + " " + state.testStartTime.toISOString());
    write(ui.pdfCompleted + " " + state.testEndTime.toISOString());
    write(ui.pdfDuration + " " + sessionMinutes(1) + " " + ui.minutes);
    state.tests.forEach(function (test) {
      var metadata = C.testMetadata[test.name];
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
      buildPDF().save(C.export.pdfFilename);
      state.resultsExported = true;
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
    if (state.testInProgress && !storedProgressAvailable()) return;
    button.disabled = true;
    setTimeout(function () { button.disabled = false; }, 300);
    if (!state.testInProgress) {
      var input = $("#participantIdInput");
      if (!input) { button.disabled = false; return; }
      var participant = input.value.trim();
      var selected = Array.prototype.map.call($$(".test-checkbox:checked"), function (checkbox) { return Number(checkbox.value); });
      if (!selected.length || selected.some(function (index) { return !isInt(index) || !allTests[index]; })) { alert(ui.alertSelectTest); button.disabled = false; return; }
      resetState();
      state.participantId = participant;
      state.tests = selected.map(function (index) { return allTests[index]; });
      state.totalQuestions = state.tests.reduce(function (sum, test) { return sum + test.questions.length; }, 0);
      state.testStartTime = new Date();
      state.testInProgress = true;
      empty($("#setup-area"));
      show($("#progress-container"));
      loadTest(state.tests[0]);
      button.textContent = ui.nextBtn;
      saveProgress();
      return;
    }
    if (!recordAnswer()) { alert(ui.alertAnswer); button.disabled = false; return; }
    if (state.currentQuestionIndex < state.tests[state.currentTestIndex].questions.length - 1) {
      state.currentQuestionIndex++;
      loadQuestion(state.tests[state.currentTestIndex].questions[state.currentQuestionIndex]);
    } else if (state.currentTestIndex < state.tests.length - 1) {
      state.currentTestIndex++;
      state.currentQuestionIndex = 0;
      loadTest(state.tests[state.currentTestIndex]);
    } else {
      state.testInProgress = false;
      state.testEndTime = new Date();
      clearProgress();
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
    var problems = validateConfig(C);
    if (problems.length) {
      console.error("CONFIG validation problems:", problems);
      empty($("#setup-area"));
      $("#setup-area").appendChild(el("div", { role: "alert", className: "disclaimer", text: (ui.configError || "Configuration error:") + " " + problems.join("; ") }));
      hide($("#nextBtn"));
      return;
    }
    document.title = ui.pageTitle;
    if ($("h1")) $("h1").textContent = ui.heading;
    $("#downloadCsv").textContent = ui.downloadCsvBtn;
    $("#downloadPdf").textContent = ui.downloadPdfBtn;
    var saved = loadProgress();
    if (saved) showResumeScreen(saved);
    else showSetupScreen(invalidSavedSession ? ui.invalidSession : "");
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
      if ((event.key === C.storageKey || event.key === null) && event.newValue === null && (state.testInProgress || $("#resumeBtn") || state.testEndTime)) {
        resetState();
        showSetupScreen(ui.dataCleared);
      }
    });
    window.addEventListener("beforeunload", function (event) {
      if (state.testInProgress || (state.testEndTime && !state.resultsExported)) { event.preventDefault(); event.returnValue = ""; }
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
      state: state,
    };
    Object.keys(hooks).forEach(function (key) { window.__TEST__[key] = hooks[key]; });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
