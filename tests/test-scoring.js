(function () {
  "use strict";

  var passed = 0;
  var failed = 0;
  var results = [];

  function assert(condition, message) {
    if (condition) {
      passed++;
      results.push({ pass: true, msg: message });
    } else {
      failed++;
      results.push({ pass: false, msg: message });
    }
  }

  function approxEqual(a, b) {
    return Math.abs(a - b) < 0.001;
  }

  function renderResults() {
    var container = document.getElementById("test-results");
    if (!container) return;
    var html = "<h2>Test Results: " + passed + " passed, " + failed + " failed</h2>";
    html += '<table class="table table-bordered"><thead><tr><th>Status</th><th>Test</th></tr></thead><tbody>';
    results.forEach(function (r) {
      var cls = r.pass ? "interp-normal" : "interp-abnormal";
      html += '<tr><td class="' + cls + '">' + (r.pass ? "PASS" : "FAIL") + "</td><td>" + r.msg + "</td></tr>";
    });
    html += "</tbody></table>";
    container.innerHTML = html;
  }

  async function run() {
    var C = window.CONFIG;
    var T = window.__TEST__;

    if (!C || !T) {
      document.getElementById("test-results").innerHTML = "<p>ERROR: CONFIG or __TEST__ not found.</p>";
      return;
    }

    var state = T.state;
    var calcScores = T.calculateSummaryScores;
    var getInterp = T.getInterpretation;
    var csvEscape = T.csvEscape;

    function response(testName, question, index, score) {
      var option = question.scores.indexOf(score);
      return {
        test: testName, questionIndex: index + 1, optionIndex: option,
        question: question.q, answer: question.options[option], score: score, description: "",
        time: 1,
        questionStartTime: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        answerTime: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      };
    }
    function assertThrows(callback, message) {
      var rejected = false;
      try { callback(); } catch (error) { rejected = true; }
      assert(rejected, message);
    }

    function mockAnswers(testName, scoreValue) {
      var test = C.tests.find(function (item) { return item.name === testName; });
      return test.questions.map(function (q, i) {
        return response(testName, q, i, scoreValue);
      });
    }

    function mockAnswersPerItem(testName, scores) {
      var test = C.tests.find(function (item) { return item.name === testName; });
      return test.questions.map(function (q, i) {
        return response(testName, q, i, scores[i]);
      });
    }

    state.tests = C.tests.filter(function (t) { return t.name === "HADS"; });
    state.answers = mockAnswers("HADS", 0);
    var s = calcScores();
    assert(s.HADS.Anxiety === 0, "HADS all-zero: Anxiety = 0");
    assert(s.HADS.Depression === 0, "HADS all-zero: Depression = 0");

    state.answers = mockAnswers("HADS", 3);
    s = calcScores();
    assert(s.HADS.Anxiety === 21, "HADS all-3: Anxiety = 21");
    assert(s.HADS.Depression === 21, "HADS all-3: Depression = 21");

    state.tests = C.tests.filter(function (t) { return t.name === "STAI-S"; });
    state.answers = mockAnswers("STAI-S", 1);
    s = calcScores();
    assert(s["STAI-S"] === 20, "STAI-S all-1: Total = 20");

    state.answers = mockAnswers("STAI-S", 4);
    s = calcScores();
    assert(s["STAI-S"] === 80, "STAI-S all-4: Total = 80");

    state.tests = C.tests.filter(function (t) { return t.name === "STAI-T"; });
    state.answers = mockAnswers("STAI-T", 1);
    s = calcScores();
    assert(s["STAI-T"] === 20, "STAI-T all-1: Total = 20");

    state.answers = mockAnswers("STAI-T", 4);
    s = calcScores();
    assert(s["STAI-T"] === 80, "STAI-T all-4: Total = 80");

    state.tests = C.tests.filter(function (t) { return t.name === "BFI"; });
    state.answers = mockAnswers("BFI", 3);
    s = calcScores();
    assert(approxEqual(s.BFI.Openness, 3.0), "BFI all-3: Openness = 3.0");
    assert(approxEqual(s.BFI.Conscientiousness, 3.0), "BFI all-3: Conscientiousness = 3.0");
    assert(approxEqual(s.BFI.Extraversion, 3.0), "BFI all-3: Extraversion = 3.0");
    assert(approxEqual(s.BFI.Agreeableness, 3.0), "BFI all-3: Agreeableness = 3.0");
    assert(approxEqual(s.BFI.Neuroticism, 3.0), "BFI all-3: Neuroticism = 3.0");

    var fqCfg = C.scoring.FQ.subscales;
    assert(fqCfg.Agoraphobia.length === 5, "FQ config: 5 Agoraphobia items");
    assert(fqCfg.BloodInjuryPhobia.length === 5, "FQ config: 5 BloodInjuryPhobia items");
    assert(fqCfg.SocialPhobia.length === 5, "FQ config: 5 SocialPhobia items");
    assert(fqCfg.TotalPhobia.length === 15, "FQ config: 15 TotalPhobia items");

    state.tests = C.tests.filter(function (t) { return t.name === "FQ"; });
    state.answers = mockAnswers("FQ", 0);
    s = calcScores();
    assert(s.FQ.Agoraphobia === 0, "FQ all-0: Agoraphobia = 0");
    assert(s.FQ.TotalPhobia === 0, "FQ all-0: TotalPhobia = 0");

    state.answers = mockAnswers("FQ", 8);
    s = calcScores();
    assert(s.FQ.Agoraphobia === 40, "FQ all-8: Agoraphobia = 40");
    assert(s.FQ.BloodInjuryPhobia === 40, "FQ all-8: BloodInjuryPhobia = 40");
    assert(s.FQ.SocialPhobia === 40, "FQ all-8: SocialPhobia = 40");
    assert(s.FQ.TotalPhobia === 120, "FQ all-8: TotalPhobia = 120");

    assert(getInterp("HADS", "Anxiety", 0) !== "", "HADS interp: score 0 has label");
    assert(getInterp("HADS", "Anxiety", 7) === getInterp("HADS", "Anxiety", 0), "HADS interp: 7 same as 0 (Normal/Normal)");
    assert(getInterp("HADS", "Anxiety", 8) !== getInterp("HADS", "Anxiety", 7), "HADS interp: 8 differs from 7 (boundary)");
    assert(getInterp("HADS", "Anxiety", 11) !== getInterp("HADS", "Anxiety", 10), "HADS interp: 11 differs from 10 (boundary)");

    assert(getInterp("STAI-S", "Total", 20) === "", "STAI-S: raw score has no universal severity band");
    assert(getInterp("STAI-T", "Total", 80) === "", "STAI-T: raw score has no universal severity band");
    assert(JSON.stringify(T.scoreRange("STAI-S", "Total")) === "[20,80]", "STAI-S possible range = 20-80");

    assert(getInterp("BFI", "Openness", 1.5) !== "", "BFI interp: 1.5 has label");
    assert(getInterp("BFI", "Openness", 2) !== getInterp("BFI", "Openness", 3), "BFI interp: 2 vs 3 boundary");
    assert(T.interpClass(getInterp("BFI", "Openness", 5)) === "", "BFI: top of scale is not colored as clinical severity");

    var bfiMid = C.thresholds.BFI._default.ranges[1][2];
    assert(getInterp("BFI", "Openness", 2.5) === bfiMid, "BFI interp: 2.5 -> middle band");
    assert(getInterp("BFI", "Openness", 3.5) === bfiMid, "BFI interp: 3.5 -> middle band");

    assert(getInterp("HADS", "Anxiety", -1) === "", "HADS interp: below-min -> no label");
    assert(getInterp("HADS", "Anxiety", 99) === "", "HADS interp: above-max -> no label");
    assert(getInterp("STAI-S", "Total", 0) === "", "STAI-S interp: below-min -> no label");
    assert(getInterp("BFI", "Openness", 0.5) === "", "BFI interp: below-min -> no label");
    assert(getInterp("BFI", "Openness", 5.5) === "", "BFI interp: above-max -> no label");

    assert(getInterp("FQ", "Agoraphobia", 5) === "", "FQ: raw score has no universal severity band");
    assert(getInterp("FQ", "GlobalPhobiaRating", 0) === "", "FQ: no-phobia anchor is not labeled mild");

    var hadsQs = C.tests.find(function (test) { return test.name === "HADS"; }).questions;
    state.tests = C.tests.filter(function (t) { return t.name === "HADS"; });
    var built = hadsQs.map(function (q, i) {
      return response("HADS", q, i, i % 4);
    });
    state.answers = built.slice().reverse();
    s = calcScores();
    assert(s.HADS.Anxiety === built.filter(function (a) { return a.questionIndex % 2 === 1; }).reduce(function (sum, a) { return sum + a.score; }, 0), "HADS scoring follows questionIndex even when answers are shuffled");
    assert(s.HADS.Depression === built.filter(function (a) { return a.questionIndex % 2 === 0; }).reduce(function (sum, a) { return sum + a.score; }, 0), "HADS Depression follows questionIndex when shuffled");

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    assert(T.validateConfig(C).length === 0, "validateConfig: live config has no structural problems");
    var badScores = clone(C); badScores.tests[0].questions[0].scores = [1, 2];
    assert(T.validateConfig(badScores).length > 0, "validateConfig: catches options/scores length mismatch");
    var badIndex = clone(C); badIndex.scoring.HADS.subscales.Anxiety.push(99);
    assert(T.validateConfig(badIndex).length > 0, "validateConfig: catches out-of-range item index");
    var badRange = clone(C); badRange.thresholds.HADS.Anxiety.ranges[0] = [10, 0, "Bad"];
    assert(T.validateConfig(badRange).length > 0, "validateConfig: catches lo > hi range");
    var badOverlap = clone(C); badOverlap.thresholds.HADS.Anxiety.ranges = [[0, 7, "A"], [7, 21, "B"]];
    assert(T.validateConfig(badOverlap).length > 0, "validateConfig: catches shared-boundary overlap");

    assert(csvEscape("hello") === "hello", "csvEscape: plain text unchanged");
    assert(csvEscape("hello,world") === '"hello,world"', "csvEscape: comma wrapped in quotes");
    assert(csvEscape('say "hi"') === '"say ""hi"""', "csvEscape: quotes doubled and wrapped");
    assert(csvEscape("line1\nline2") === '"line1\nline2"', "csvEscape: newline wrapped in quotes");
    assert(csvEscape("line1\rline2") === '"line1\rline2"', "csvEscape: carriage return wrapped in quotes");
    assert(csvEscape("\r=1+1") === "\"'\r=1+1\"", "csvEscape: CR guard composes with quoting");
    assert(csvEscape("\n=1+1") === "\"'\n=1+1\"", "csvEscape: LF prefix guarded and quoted");
    ["＝", "＋", "－", "＠"].forEach(function (prefix) {
      assert(csvEscape(prefix + "1+1") === "'" + prefix + "1+1", "csvEscape: full-width formula prefix guarded " + prefix);
    });

    assert(csvEscape("=1+1") === "'=1+1", "csvEscape: = prefix neutralized");
    assert(csvEscape("+SUM(A1)") === "'+SUM(A1)", "csvEscape: + prefix neutralized");
    assert(csvEscape("-2") === "'-2", "csvEscape: - prefix neutralized");
    assert(csvEscape("@cmd") === "'@cmd", "csvEscape: @ prefix neutralized");
    assert(csvEscape("=a,b") === "\"'=a,b\"", "csvEscape: injection guard composes with quoting");

    var fmt = T.formatScoreValue;
    assert(fmt(3) === "3", "formatScoreValue: integer unchanged");
    assert(fmt(4) === "4", "formatScoreValue: whole number gets no decimals");
    assert(fmt(3.33333) === "3.33", "formatScoreValue: non-integer rounded to 2 decimals");


    var hadsAnx = C.scoring.HADS.subscales.Anxiety;
    state.tests = C.tests.filter(function (t) { return t.name === "HADS"; });
    var hadsScores = state.tests[0].questions.map(function (q, i) {
      return hadsAnx.indexOf(i + 1) !== -1 ? 1 : 0;
    });
    state.answers = mockAnswersPerItem("HADS", hadsScores);
    s = calcScores();
    assert(s.HADS.Anxiety === hadsAnx.length, "HADS mapping: Anxiety isolates its own items");
    assert(s.HADS.Depression === 0, "HADS mapping: Depression unaffected by Anxiety items");

    state.tests = C.tests.filter(function (t) { return t.name === "BFI"; });
    state.answers = mockAnswersPerItem("BFI", [1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
    s = calcScores();
    assert(approxEqual(s.BFI.Extraversion, 1.0), "BFI mapping: Extraversion = items 1,6");
    assert(approxEqual(s.BFI.Agreeableness, 2.0), "BFI mapping: Agreeableness = items 2,7");
    assert(approxEqual(s.BFI.Conscientiousness, 3.0), "BFI mapping: Conscientiousness = items 3,8");
    assert(approxEqual(s.BFI.Neuroticism, 4.0), "BFI mapping: Neuroticism = items 4,9");
    assert(approxEqual(s.BFI.Openness, 5.0), "BFI mapping: Openness = items 5,10");

    var fqAgora = C.scoring.FQ.subscales.Agoraphobia;
    state.tests = C.tests.filter(function (t) { return t.name === "FQ"; });
    var fqScores = state.tests[0].questions.map(function (q, i) {
      return fqAgora.indexOf(i + 1) !== -1 ? 8 : 0;
    });
    state.answers = mockAnswersPerItem("FQ", fqScores);
    s = calcScores();
    assert(s.FQ.Agoraphobia === fqAgora.length * 8, "FQ mapping: Agoraphobia isolates its own items");
    assert(s.FQ.SocialPhobia === 0, "FQ mapping: SocialPhobia unaffected");
    assert(s.FQ.BloodInjuryPhobia === 0, "FQ mapping: BloodInjuryPhobia unaffected");
    assert(s.FQ.TotalPhobia === fqAgora.length * 8, "FQ mapping: TotalPhobia includes Agoraphobia items");

    if (C.lang === "en") {
      var bfi = C.tests.find(function (test) { return test.name === "BFI"; }).questions;
      assert(bfi[0].scores[0] === 1, "BFI keying: 'reserved' + strongly agree -> low Extraversion");
      assert(bfi[5].scores[0] === 5, "BFI keying: 'outgoing' + strongly agree -> high Extraversion");
      assert(bfi[3].scores[0] === 1, "BFI keying: 'handles stress well' + strongly agree -> low Neuroticism");
      assert(bfi[8].scores[0] === 5, "BFI keying: 'nervous easily' + strongly agree -> high Neuroticism");

      var staiS = C.tests.find(function (test) { return test.name === "STAI-S"; }).questions;
      assert(staiS[0].scores[0] === 4, "STAI-S keying: 'I feel calm' reverse-scored (not at all -> 4)");
      assert(staiS[2].scores[0] === 1, "STAI-S keying: 'I am tense' direct-scored (not at all -> 1)");
    }

    var fqSub = C.scoring.FQ.subscales;
    var expectedFq = C.lang === "fr"
      ? { GlobalPhobiaRating: [24], AnxietyDepression: [18, 19, 20, 21, 22] }
      : { GlobalPhobiaRating: [18], AnxietyDepression: [19, 20, 21, 22, 23] };
    assert(JSON.stringify(fqSub.GlobalPhobiaRating) === JSON.stringify(expectedFq.GlobalPhobiaRating), "FQ config: GlobalPhobiaRating indices match this language's form");
    assert(JSON.stringify(fqSub.AnxietyDepression) === JSON.stringify(expectedFq.AnxietyDepression), "FQ config: AnxietyDepression indices match this language's form");

    state.tests = C.tests.filter(function (t) { return t.name === "FQ"; });
    var gItems = fqSub.GlobalPhobiaRating;
    var gScores = state.tests[0].questions.map(function (q, i) { return gItems.indexOf(i + 1) !== -1 ? 8 : 0; });
    state.answers = mockAnswersPerItem("FQ", gScores);
    s = calcScores();
    assert(s.FQ.GlobalPhobiaRating === gItems.length * 8, "FQ mapping: GlobalPhobiaRating isolates its own item(s)");
    assert(s.FQ.AnxietyDepression === 0, "FQ mapping: AnxietyDepression unaffected by GlobalPhobiaRating");

    var adItems = fqSub.AnxietyDepression;
    var adScores = state.tests[0].questions.map(function (q, i) { return adItems.indexOf(i + 1) !== -1 ? 8 : 0; });
    state.answers = mockAnswersPerItem("FQ", adScores);
    s = calcScores();
    assert(s.FQ.AnxietyDepression === adItems.length * 8, "FQ mapping: AnxietyDepression isolates its own items");
    assert(s.FQ.GlobalPhobiaRating === 0, "FQ mapping: GlobalPhobiaRating unaffected by AnxietyDepression");
    assert(s.FQ.TotalPhobia === 0, "FQ mapping: TotalPhobia excludes AnxietyDepression items");

    function reverseSet(name) {
      var qs = C.tests.find(function (test) { return test.name === name; }).questions;
      var out = [];
      qs.forEach(function (q, i) { if (q.scores[0] === 4) out.push(i + 1); });
      return out;
    }
    assert(JSON.stringify(reverseSet("STAI-S")) === JSON.stringify([1, 2, 5, 8, 10, 11, 15, 16, 19, 20]), "STAI-S reverse set matches this language form");
    var expectedT = C.lang === "fr" ? [1, 3, 6, 7, 10, 13, 14, 16, 19] : [1, 6, 7, 10, 13, 16, 19];
    assert(JSON.stringify(reverseSet("STAI-T")) === JSON.stringify(expectedT), "STAI-T reverse set matches this language's form");

    var staiTQs = C.tests.find(function (test) { return test.name === "STAI-T"; }).questions;
    var cleanKeying = staiTQs.every(function (q) {
      var k = JSON.stringify(q.scores);
      return k === "[4,3,2,1]" || k === "[1,2,3,4]";
    });
    assert(cleanKeying, "STAI-T: every item is a clean reverse (4..1) or direct (1..4) keying");

    state.tests = C.tests.filter(function (t) { return t.name === "STAI-T"; });
    var mixT = staiTQs.map(function (q, i) { return q.scores[i % 4]; });
    state.answers = mockAnswersPerItem("STAI-T", mixT);
    s = calcScores();
    assert(s["STAI-T"] === mixT.reduce(function (a, b) { return a + b; }, 0), "STAI-T mixed answers total correctly");

    var hadsR = C.thresholds.HADS.Anxiety.ranges;
    assert(getInterp("HADS", "Anxiety", 7) === hadsR[0][2], "HADS band: 7 -> band 1");
    assert(getInterp("HADS", "Anxiety", 8) === hadsR[1][2], "HADS band: 8 -> band 2");
    assert(getInterp("HADS", "Anxiety", 10) === hadsR[1][2], "HADS band: 10 -> band 2");
    assert(getInterp("HADS", "Anxiety", 11) === hadsR[2][2], "HADS band: 11 -> band 3");

    [20, 37, 38, 44, 45, 80].forEach(function (value) {
      assert(getInterp("STAI-S", "Total", value) === "", "STAI-S raw score: no band at " + value);
    });
    [0, 30, 31, 60, 61, 120].forEach(function (value) {
      assert(getInterp("FQ", "TotalPhobia", value) === "", "FQ raw score: no band at " + value);
    });

    var ic = T.interpClass;
    ["Anxiety", "Depression"].forEach(function (subscale) {
      C.thresholds.HADS[subscale].ranges.forEach(function (range, index) {
        var expectedClass = ["interp-normal", "interp-moderate", "interp-abnormal"][index];
        assert(ic(range[2]) === expectedClass, "interpClass: configured HADS " + subscale + " band " + (index + 1) + " uses its screening color");
      });
    });
    assert(ic("High anxiety, severe or abnormal") === "", "interpClass: unknown clinical-sounding labels carry no screening color");
    assert(ic("") === "", "interpClass: empty label -> no class");

    state.tests = C.tests.slice();
    var battery = [];
    [["HADS", 2], ["STAI-S", 3], ["STAI-T", 2], ["BFI", 4], ["FQ", 4]].forEach(function (p) {
      battery = battery.concat(mockAnswers(p[0], p[1]));
    });
    state.answers = battery;
    var full = calcScores();
    assert(full.HADS.Anxiety === 14 && full.HADS.Depression === 14, "battery: HADS subscales = 14 each");
    assert(full["STAI-S"] === 60, "battery: STAI-S total = 60");
    assert(full["STAI-T"] === 40, "battery: STAI-T total = 40");
    assert(approxEqual(full.BFI.Openness, 4.0), "battery: BFI Openness mean = 4.0");
    assert(full.FQ.Agoraphobia === 20 && full.FQ.TotalPhobia === 60, "battery: FQ Agoraphobia = 20, TotalPhobia = 60");
    assert(T.interpClass(getInterp("HADS", "Anxiety", full.HADS.Anxiety)) === "interp-abnormal", "battery: HADS Anxiety 14 -> abnormal");
    assert(getInterp("STAI-S", "Total", full["STAI-S"]) === "", "battery: STAI-S 60 remains a raw score");
    assert(T.interpClass(getInterp("BFI", "Openness", full.BFI.Openness)) === "", "battery: BFI trait carries no clinical color");

    await browserRegressions(C, T, state, mockAnswers, assert, assertThrows, clone);
    renderResults();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
