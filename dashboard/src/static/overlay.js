/**
 * Warframe Info scan overlay — client behaviour for /overlay.
 *
 * - Live body: an EventSource on /api/scan/events. Every `scan` event carries
 *   the server-rendered (already escaped) body; the script swaps it in when
 *   its version differs.
 * - Fallback: if the event stream fails, poll /api/scan?view=overlay every
 *   second and try the event stream again every 15 s.
 * - Updates do NOT pause while the page reports itself hidden: a pinned
 *   in-game window can count as hidden and must still update.
 * - Scan button: POST /scan/run (same origin) with the capture tokens from the
 *   page URL; the status line shows running, done or the error.
 * - Clock and age: scan times are shown in the viewer's locale, with the age
 *   ("12 s ago") refreshed every second.
 */
(function () {
  "use strict";

  var POLL_MS = 1000;
  var RETRY_SSE_MS = 15000;

  var bodyEl = null;
  var liveEl = null;
  var version = null;
  var source = null;
  var pollTimer = null;
  var polling = false;
  var retryTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function setLive(state, label) {
    if (!liveEl) return;
    liveEl.setAttribute("data-state", state);
    liveEl.textContent = label;
  }

  function applyPayload(data) {
    if (!data || typeof data.body !== "string") return;
    if (data.version !== undefined && data.version === version) return;
    version = data.version;
    bodyEl.innerHTML = data.body;
    localiseTimes();
    refreshAges();
  }

  /* ------------------------------------------------------------------ */
  /* Clock text                                                          */
  /* ------------------------------------------------------------------ */

  function localiseTimes() {
    var times = bodyEl.querySelectorAll("time[data-wf-ms]");
    for (var i = 0; i < times.length; i++) {
      var ms = Number(times[i].getAttribute("data-wf-ms"));
      if (!isFinite(ms)) continue;
      times[i].textContent = new Date(ms).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
  }

  function ageText(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + " s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " min ago";
    var h = Math.floor(m / 60);
    if (h < 48) return h + " h ago";
    return Math.floor(h / 24) + " days ago";
  }

  function refreshAges() {
    var ages = bodyEl.querySelectorAll("[data-wf-age]");
    for (var i = 0; i < ages.length; i++) {
      var ms = Number(ages[i].getAttribute("data-wf-age"));
      if (!isFinite(ms)) continue;
      ages[i].textContent = "· " + ageText(ms);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Live updates                                                        */
  /* ------------------------------------------------------------------ */

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function poll() {
    if (polling) return;
    polling = true;
    pollTimer = null;
    fetch("/api/scan?view=overlay", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    }).then(function (resp) {
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.json();
    }).then(function (data) {
      applyPayload(data);
      if (!source) setLive("poll", "Polling");
    }).catch(function () {
      if (!source) setLive("off", "Offline");
    }).finally(function () {
      polling = false;
      if (!source && !pollTimer) pollTimer = setTimeout(poll, POLL_MS);
    });
  }

  function startPolling() {
    if (pollTimer || polling) return;
    poll();
  }

  function scheduleSseRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      openStream();
    }, RETRY_SSE_MS);
  }

  function openStream() {
    if (typeof EventSource === "undefined") {
      startPolling();
      return;
    }
    var es;
    try {
      es = new EventSource("/api/scan/events");
    } catch (_err) {
      startPolling();
      scheduleSseRetry();
      return;
    }
    source = es;
    es.addEventListener("open", function () {
      if (source !== es) return;
      stopPolling();
      setLive("live", "Live");
    });
    es.addEventListener("scan", function (event) {
      if (source !== es) return;
      try {
        applyPayload(JSON.parse(event.data));
      } catch (_err) {
        // A malformed message: the next one replaces it.
      }
    });
    es.addEventListener("error", function () {
      if (source !== es) return;
      // Drop the stream and poll instead, so updates keep arriving even when
      // the browser gives up reconnecting; the stream is tried again later.
      es.close();
      source = null;
      setLive("poll", "Polling");
      startPolling();
      scheduleSseRetry();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Scan button                                                         */
  /* ------------------------------------------------------------------ */

  function setStatus(text, kind) {
    var status = $("wf-ov-status");
    if (!status) return;
    status.setAttribute("data-kind", kind || "");
    status.textContent = text;
  }

  function startScan(button) {
    var body = new URLSearchParams();
    var display = button.getAttribute("data-display") || "";
    var win = button.getAttribute("data-window") || "";
    if (display) body.set("display", display);
    if (win) body.set("window", win);

    button.disabled = true;
    setStatus("Scanning…", "running");
    fetch("/scan/run", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: body,
    }).then(function (resp) {
      return resp.json().catch(function () {
        return {};
      }).then(function (data) {
        if (resp.ok && data.ok) {
          var secs = typeof data.durationMs === "number"
            ? " in " + (data.durationMs / 1000).toFixed(1) + " s"
            : "";
          setStatus("Done" + secs, "done");
          return;
        }
        setStatus(
          data.error || data.message || "Scan failed (HTTP " + resp.status +
              ")",
          "error",
        );
      });
    }).catch(function (err) {
      setStatus("Scan request failed: " + err.message, "error");
    }).finally(function () {
      button.disabled = false;
      // The event stream normally delivers the new record already; one fetch
      // makes sure the body is current even while the stream reconnects.
      if (!pollTimer) poll();
    });
  }

  function initScanButton() {
    var button = $("wf-ov-scan");
    if (!button) return;
    button.hidden = false;
    button.addEventListener("click", function () {
      if (!button.disabled) startScan(button);
    });
  }

  /* ------------------------------------------------------------------ */

  function init() {
    bodyEl = $("wf-ov-body");
    liveEl = $("wf-ov-live");
    if (!bodyEl) return;
    localiseTimes();
    refreshAges();
    setInterval(refreshAges, 1000);
    initScanButton();
    setLive("off", "Connecting");
    openStream();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
