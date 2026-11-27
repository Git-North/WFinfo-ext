/**
 * Warframe Info dashboard — client behaviour (progressive enhancement).
 * - Logs page: re-fetch /api/logs and re-render the list on each "change"
 *   event for debug.log from /api/logs/events (server-sent events), with a
 *   client-side text filter that survives refreshes.
 * - Recently seen page: re-fetch /api/reward-events on a debug.log change and
 *   /api/ocr-runs on an ocr_runs change, and re-render the two card lists.
 * - Fallback: without EventSource, or after 3 stream errors in a row, the
 *   Logs page polls every 3s and the Recently seen page every 10s.
 * - Scan page: re-fetch /api/scan every 3s and swap in the re-rendered body,
 *   so a hotkey-triggered scan appears without a reload. The page's "Scan now"
 *   form posts to /scan/run with the chosen display or window; the script
 *   keeps the button busy until the scan answers and then refreshes the body.
 *   "Refresh lists" re-reads the host's displays and windows.
 *
 * Polling pauses while the tab is hidden; an event stream stays open. All
 * dynamic text is escaped.
 */
(function () {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function fmtMs(ms) {
    return new Date(ms).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function tag(text, colour) {
    return '<strong class="govuk-tag govuk-tag--' + colour + '">' + esc(text) +
      "</strong>";
  }

  function tokenChip(t, extraNote) {
    var label = t.slug
      ? '<a class="wf-chip govuk-link" href="/wfmarket/' + esc(t.slug) + '">' +
        esc(t.name) + "</a>"
      : '<span class="wf-chip wf-chip--plain">' + esc(t.name) + "</span>";
    var values = [];
    if (t.plat !== null && t.plat !== undefined) {
      values.push(esc(String(t.plat)) + " plat");
    }
    if (t.ducats !== null && t.ducats !== undefined) {
      values.push(esc(String(t.ducats)) + " ducats");
    }
    var note = values.length > 0
      ? ' <span class="wf-chip__values">(' + values.join(" &middot; ") +
        ")</span>"
      : "";
    return '<li class="wf-rewards__item">' + label + note +
      (extraNote || "") + "</li>";
  }

  function timeHtml(ms, fallback) {
    var inner = ms ? esc(fmtMs(ms)) : esc(fallback || "unknown time");
    return '<time class="govuk-body-s wf-muted" datetime="' +
      (ms ? new Date(ms).toISOString() : "") + '">' + inner + "</time>";
  }

  function fetchJson(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(
      function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      },
    );
  }

  /**
   * Run `fn` (returns a promise) one at a time: a call while one runs becomes
   * a single follow-up run, so responses never arrive out of order.
   */
  function serial(fn) {
    var busy = false;
    var again = false;
    return function run() {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      Promise.resolve().then(fn).catch(function () {}).then(function () {
        busy = false;
        if (again) {
          again = false;
          run();
        }
      });
    };
  }

  /**
   * Listen to /api/logs/events for `sources`. `onChange(source)` runs on each
   * change and with null when the stream (re)opens. `fallback()` runs once
   * when live events are not available; the caller then polls.
   */
  function watchLogEvents(sources, onChange, fallback) {
    if (!window.EventSource) {
      fallback();
      return;
    }
    var query = sources.map(function (s) {
      return "source=" + encodeURIComponent(s);
    }).join("&");
    var stream = new EventSource("/api/logs/events?" + query);
    var failures = 0;
    stream.addEventListener("ready", function () {
      failures = 0;
      onChange(null);
    });
    stream.addEventListener("change", function (event) {
      failures = 0;
      try {
        onChange(JSON.parse(event.data).source);
      } catch (_err) {
        onChange(null);
      }
    });
    stream.onerror = function () {
      failures += 1;
      if (stream.readyState === EventSource.CLOSED || failures >= 3) {
        stream.close();
        fallback();
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Logs                                                                */
  /* ------------------------------------------------------------------ */

  var logList = null;
  var logMeta = null;
  var logFilterInput = null;
  var logTimer = null;
  var logFilterValue = "";
  var logLive = false;

  function applyLogFilter() {
    if (!logList) return;
    var needle = logFilterValue.trim().toLowerCase();
    var items = logList.querySelectorAll(".wf-logline");
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle(
        "wf-hidden",
        needle.length > 0 &&
          items[i].textContent.toLowerCase().indexOf(needle) === -1,
      );
    }
  }

  function renderLogLines(lines, updatedAtMs, total) {
    var html = "";
    for (var i = 0; i < lines.length; i++) {
      html += '<li class="wf-logline">' + esc(lines[i]) + "</li>";
    }
    logList.innerHTML = html;
    if (logMeta) {
      logMeta.textContent = "Showing " + lines.length + " of " + total +
        " lines · updated " + fmtMs(updatedAtMs);
    }
    applyLogFilter();
  }

  function scheduleLogPoll(delayMs) {
    if (logTimer) clearTimeout(logTimer);
    logTimer = setTimeout(pollLogs, delayMs);
  }

  function fetchLogs() {
    return fetchJson("/api/logs").then(function (data) {
      renderLogLines(data.lines, data.updatedAt, data.total);
    }).catch(function (err) {
      if (logMeta) {
        logMeta.textContent += " · update failed, retrying…";
      }
      throw err;
    });
  }

  function pollLogs() {
    fetchLogs().then(function () {
      scheduleLogPoll(3000);
    }, function () {
      scheduleLogPoll(5000);
    });
  }

  function initLogs() {
    logList = $("wf-log-list");
    if (!logList) return;
    logMeta = $("wf-log-meta");
    logFilterInput = $("wf-log-filter");
    if (logFilterInput) {
      logFilterInput.addEventListener("input", function () {
        logFilterValue = logFilterInput.value;
        applyLogFilter();
      });
    }
    document.addEventListener("visibilitychange", function () {
      if (logLive) return;
      if (logTimer) {
        clearTimeout(logTimer);
        logTimer = null;
      }
      if (!document.hidden) scheduleLogPoll(500);
    });
    logLive = true;
    watchLogEvents(["debug.log"], serial(fetchLogs), function () {
      logLive = false;
      scheduleLogPoll(3000);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Recently seen                                                       */
  /* ------------------------------------------------------------------ */

  var recentTimer = null;
  var recentLive = false;

  function rewardCard(r, index) {
    var items = "";
    for (var i = 0; i < r.rewards.length; i++) {
      var chosenNote = i === r.chosen ? " " + tag("Chosen", "blue") : "";
      items += tokenChip(r.rewards[i], chosenNote);
    }
    return '<article class="wf-card"><div class="wf-card__head">' +
      '<h2 class="govuk-heading-s govuk-!-margin-bottom-0">Reward screen ' +
      (index + 1) + "</h2>" + timeHtml(r.ts, r.tsText) + "</div>" +
      '<ul class="govuk-list wf-rewards">' + items + "</ul></article>";
  }

  function runScenarioRow(s) {
    var parts = "";
    if (s.parts.length > 0) {
      var chips = "";
      for (var i = 0; i < s.parts.length; i++) {
        chips += tokenChip(s.parts[i]);
      }
      parts =
        '<p class="govuk-body-s wf-muted wf-!-no-margin-bottom">Recognized parts</p>' +
        '<ul class="govuk-list wf-rewards">' + chips + "</ul>";
    }
    var problems = [];
    if (s.missing.length > 0) problems.push("missing: " + s.missing.join(", "));
    if (s.extra.length > 0) problems.push("unexpected: " + s.extra.join(", "));
    var problemLine = problems.length > 0
      ? '<p class="govuk-body-s wf-err">' + esc(problems.join(" · ")) + "</p>"
      : "";
    var errorLine = s.errorMessage
      ? '<p class="govuk-body-s wf-muted">' + esc(s.errorMessage) + "</p>"
      : "";
    return '<li class="wf-run-scenario"><div class="wf-card__head">' +
      '<h3 class="govuk-heading-s govuk-!-margin-bottom-0">' + esc(s.name) +
      "</h3>" + (s.success ? tag("Pass", "green") : tag("Fail", "red")) +
      '<span class="govuk-body-s wf-muted">' +
      Number(s.accuracy).toFixed(1) + "% accuracy</span></div>" + parts +
      problemLine + errorLine + "</li>";
  }

  function runCard(r) {
    var scenarios = "";
    for (var i = 0; i < r.scenarios.length; i++) {
      scenarios += runScenarioRow(r.scenarios[i]);
    }
    return '<article class="wf-card"><div class="wf-card__head">' +
      '<h2 class="govuk-heading-s govuk-!-margin-bottom-0">' + esc(r.suite) +
      "</h2>" + timeHtml(r.startedMs, null) + "</div>" +
      '<p class="govuk-body-s wf-muted wf-!-no-margin-bottom">' + r.passed +
      "/" +
      r.total + " scenarios passed (" + Number(r.accuracy).toFixed(1) +
      "% accuracy)" + (r.errors > 0 ? " · " + r.errors + " errored" : "") +
      " · " + esc(r.fileName) + "</p>" +
      '<ul class="govuk-list wf-run-list">' + scenarios + "</ul></article>";
  }

  function scheduleRecentPoll(delayMs) {
    if (recentTimer) clearTimeout(recentTimer);
    recentTimer = setTimeout(pollRecent, delayMs);
  }

  function fetchRewards() {
    var rewardsEl = $("wf-rewards");
    if (!rewardsEl) return Promise.resolve();
    var rewardCount = $("wf-reward-count");
    var rewardsEmpty = $("wf-rewards-empty");
    return fetchJson("/api/reward-events").then(function (data) {
      var html = "";
      for (var i = 0; i < data.rewards.length; i++) {
        html += rewardCard(data.rewards[i], i);
      }
      rewardsEl.innerHTML = html;
      if (rewardCount) {
        rewardCount.textContent = "(" + data.rewards.length + ")";
      }
      if (rewardsEmpty) rewardsEmpty.hidden = data.rewards.length > 0;
    }).catch(function () {});
  }

  function fetchRuns() {
    var runsEl = $("wf-runs");
    if (!runsEl) return Promise.resolve();
    var runCount = $("wf-run-count");
    var runsEmpty = $("wf-runs-empty");
    return fetchJson("/api/ocr-runs").then(function (data) {
      var html = "";
      for (var i = 0; i < data.runs.length; i++) {
        html += runCard(data.runs[i]);
      }
      runsEl.innerHTML = html;
      if (runCount) runCount.textContent = "(" + data.runs.length + ")";
      if (runsEmpty) runsEmpty.hidden = data.runs.length > 0;
    }).catch(function () {});
  }

  function pollRecent() {
    if (!$("wf-rewards") && !$("wf-runs")) return;
    Promise.all([fetchRewards(), fetchRuns()]).then(function () {
      scheduleRecentPoll(10000);
    });
  }

  function initRecent() {
    if (!$("wf-rewards") && !$("wf-runs")) return;
    document.addEventListener("visibilitychange", function () {
      if (recentLive) return;
      if (recentTimer) {
        clearTimeout(recentTimer);
        recentTimer = null;
      }
      if (!document.hidden) scheduleRecentPoll(1000);
    });
    var refreshRewards = serial(fetchRewards);
    var refreshRuns = serial(fetchRuns);
    recentLive = true;
    watchLogEvents(["debug.log", "ocr_runs"], function (source) {
      if (source !== "ocr_runs") refreshRewards();
      if (source !== "debug.log") refreshRuns();
    }, function () {
      recentLive = false;
      scheduleRecentPoll(10000);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Scan                                                                */
  /* ------------------------------------------------------------------ */

  var scanTimer = null;

  function scheduleScanPoll(delayMs) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(pollScan, delayMs);
  }
  function pollScan() {
    var bodyEl = $("wf-scan-body");
    if (!bodyEl) return;
    fetchJson("/api/scan").then(function (data) {
      if (data && data.body) {
        // The server renders the same markup the page was built with, so the
        // empty-state inset toggling happens on the server side.
        bodyEl.innerHTML = data.body;
      }
      scheduleScanPoll(3000);
    }).catch(function () {
      scheduleScanPoll(5000);
    });
  }

  function initScan() {
    if (!$("wf-scan-body")) return;
    document.addEventListener("visibilitychange", function () {
      if (scanTimer) {
        clearTimeout(scanTimer);
        scanTimer = null;
      }
      if (!document.hidden) scheduleScanPoll(500);
    });
    scheduleScanPoll(3000);
  }

  /* ------------------------------------------------------------------ */
  /* Scan now (the /scan page's form)                                    */
  /* ------------------------------------------------------------------ */

  function setScanStatus(text, isError) {
    var status = $("wf-scan-status");
    if (!status) return;
    status.hidden = text.length === 0;
    status.className = isError ? "govuk-body wf-err" : "govuk-body wf-muted";
    status.textContent = text;
  }

  function showScanOutput(text) {
    var log = $("wf-scan-log");
    if (!log) return;
    log.hidden = text.length === 0;
    log.textContent = text;
  }

  function setScanTargetsStatus(text, isError) {
    var status = $("wf-scan-targets-status");
    if (!status) return;
    status.className = isError ? "wf-err" : "wf-muted";
    status.textContent = text;
  }

  function fillSelect(select, options, fallback) {
    var previous = select.value;
    var html = '<option value="">' + esc(fallback) + "</option>";
    for (var i = 0; i < options.length; i++) {
      html += '<option value="' + esc(options[i].value) + '">' +
        esc(options[i].label) + "</option>";
    }
    select.innerHTML = html;
    // Keep the operator's choice when it is still on the list.
    for (var j = 0; j < select.options.length; j++) {
      if (select.options[j].value === previous) {
        select.value = previous;
        return;
      }
    }
  }

  function refreshScanTargets() {
    var button = $("wf-scan-refresh");
    if (button) button.disabled = true;
    setScanTargetsStatus(
      "Reading the displays and windows of this host…",
      false,
    );
    fetchJson("/api/scan/targets?refresh=1").then(function (data) {
      fillSelect(
        $("wf-scan-display"),
        data.displays || [],
        "Every output (automatic)",
      );
      fillSelect(
        $("wf-scan-window"),
        data.windows || [],
        "No window — capture the whole display",
      );
      var counts = (data.displays || []).length + " display(s), " +
        (data.windows || []).length + " window(s)";
      var notes = data.notes || [];
      setScanTargetsStatus(
        counts + (notes.length > 0 ? " — " + notes.join(" ") : ""),
        (data.displays || []).length + (data.windows || []).length === 0,
      );
    }).catch(function (err) {
      setScanTargetsStatus(
        "Could not read the target list: " + err.message,
        true,
      );
    }).finally(function () {
      if (button) button.disabled = false;
    });
  }

  function initScanTargets() {
    var refresh = $("wf-scan-refresh");
    if (!refresh) return;
    refresh.addEventListener("click", refreshScanTargets);
  }

  function submitScan(event) {
    // Without this handler the plain form post still works: it redirects
    // back to /scan once the scan record is written.
    event.preventDefault();
    var form = event.currentTarget;
    var button = $("wf-scan-button");
    if (button) button.disabled = true;
    showScanOutput("");
    setScanStatus("Scanning the screen… this takes a few seconds.", false);

    fetch(form.action, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new FormData(form),
    }).then(function (resp) {
      return resp.json().catch(function () {
        return {};
      }).then(function (data) {
        if (resp.ok && data.ok) {
          setScanStatus(data.message || "Scan complete.", false);
          return;
        }
        showScanOutput(data.output || "");
        setScanStatus(
          data.message || data.error || "The scan failed (HTTP " + resp.status +
              ").",
          true,
        );
      });
    }).catch(function (err) {
      setScanStatus("The scan request failed: " + err.message, true);
    }).finally(function () {
      if (button) button.disabled = false;
      scheduleScanPoll(0);
    });
  }

  function initScanForm() {
    var form = $("wf-scan-form");
    if (!form) return;
    form.addEventListener("submit", submitScan);
  }

  /* ------------------------------------------------------------------ */

  function init() {
    if (window.GOVUKFrontend && GOVUKFrontend.initAll) {
      GOVUKFrontend.initAll();
    }
    initLogs();
    initRecent();
    initScan();
    initScanForm();
    initScanTargets();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
