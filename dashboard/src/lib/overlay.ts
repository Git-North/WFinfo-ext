/**
 * The compact scan overlay (`/overlay`): the newest reward-screen scan only,
 * made to be pinned in a small in-game browser window (Steam overlay, about
 * 300–500 px wide) over Warframe.
 *
 * No GOV.UK header, footer or tabs: a dark, high-contrast page with large
 * numbers. It still loads the GOV.UK stylesheet (type face, `govuk-button`,
 * `govuk-visually-hidden`), but the bespoke `wf-ov` classes in
 * `/assets/overlay.css` style the page on their own, so it stays readable when
 * the GOV.UK assets are not cached. `/assets/overlay.js` keeps the body live (server-sent
 * events from `/api/scan/events`, polling `/api/scan?view=overlay` as the
 * fallback) and drives the Scan button.
 *
 * All file-derived text is HTML-escaped here; the script only swaps in this
 * server-rendered markup.
 */

import { escapeHtml } from "./html.ts";
import type { ScanChoiceView, ScanView } from "./view.ts";

export interface OverlayState {
  /**
   * "none": no scan record on disk. "unreadable": a record exists but does
   * not parse. "scan": `scan` holds the parsed record.
   */
  status: "none" | "unreadable" | "scan";
  scan: ScanView | null;
  /** The scan record path, shown in the empty and unreadable states. */
  recordPath: string;
}

/** Capture choice the Scan button forwards to `/scan/run` (opaque tokens). */
export interface OverlayCapture {
  display: string;
  window: string;
}

const fmtNum = (n: number | null): string => n === null ? "—" : String(n);

/** Server-side clock text; the script rewrites it in the viewer's locale. */
const fmtClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function notice(kind: "info" | "error", title: string, text: string): string {
  return `<div class="wf-ov__notice wf-ov__notice--${kind}">
  <p class="wf-ov__notice-title">${escapeHtml(title)}</p>
  <p class="wf-ov__notice-text">${text}</p>
</div>`;
}

function row(c: ScanChoiceView): string {
  const best = c.best ? ` <strong class="wf-ov__best">Best</strong>` : "";
  return `<tr class="wf-ov__row${c.best ? " wf-ov__row--best" : ""}">
  <th scope="row" class="wf-ov__part"><span class="wf-ov__part-name">${
    escapeHtml(c.part)
  }</span>${best}</th>
  <td class="wf-ov__num wf-ov__num--plat">${escapeHtml(fmtNum(c.plat))}</td>
  <td class="wf-ov__num wf-ov__num--ducats">${escapeHtml(fmtNum(c.ducats))}</td>
</tr>`;
}

/**
 * The live part of the page (everything inside `#wf-ov-body`). Also the
 * `body` of the `/api/scan/events` messages and of `/api/scan?view=overlay`.
 */
export function overlayBodyHtml(state: OverlayState): string {
  const path = `<code class="wf-ov__code">${
    escapeHtml(state.recordPath)
  }</code>`;
  if (state.status === "none") {
    return notice(
      "info",
      "No scan yet",
      `Press <strong>Scan</strong>, or the scan hotkey, on a fissure reward screen. The result appears here. Record: ${path}`,
    );
  }
  if (state.status === "unreadable" || state.scan === null) {
    return notice(
      "error",
      "Scan record unreadable",
      `The scan record is not valid JSON. Scan again. Record: ${path}`,
    );
  }

  const scan = state.scan;
  const time = scan.startedMs === null
    ? `<span class="wf-ov__time">Time unknown</span>`
    : `<time class="wf-ov__time" datetime="${
      new Date(scan.startedMs).toISOString()
    }" data-wf-ms="${scan.startedMs}">${
      escapeHtml(fmtClock(scan.startedMs))
    }</time> <span class="wf-ov__age" data-wf-age="${scan.startedMs}"></span>`;

  const parts: string[] = [`<p class="wf-ov__meta">Scan ${time}</p>`];

  if (scan.error !== null) {
    parts.push(notice("error", "Scan error", escapeHtml(scan.error)));
  }

  if (scan.choices.length === 0) {
    if (scan.error === null) {
      parts.push(notice(
        "info",
        "No reward screen found",
        "The scan recognised no reward choices. Show the fissure reward screen and scan again.",
      ));
    }
    return parts.join("\n");
  }

  parts.push(`<table class="wf-ov__table">
  <caption class="govuk-visually-hidden wf-ov__sr">Reward choices: platinum and ducat values</caption>
  <thead>
    <tr>
      <th scope="col" class="wf-ov__head">Part</th>
      <th scope="col" class="wf-ov__head wf-ov__head--num">Plat</th>
      <th scope="col" class="wf-ov__head wf-ov__head--num">Ducats</th>
    </tr>
  </thead>
  <tbody>
${scan.choices.map(row).join("\n")}
  </tbody>
</table>`);

  if (scan.best === null) {
    parts.push(
      `<p class="wf-ov__hint">No choice has a platinum price, so no pick is marked.</p>`,
    );
  }
  return parts.join("\n");
}

/** The full `/overlay` page. */
export function overlayPageHtml(
  state: OverlayState,
  capture: OverlayCapture,
): string {
  return `<!DOCTYPE html>
<html lang="en" class="govuk-template wf-ov-html">
<head>
  <meta charset="utf-8">
  <title>Scan overlay — Warframe Info</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b0c0c">
  <link rel="icon" href="/govuk/assets/images/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/govuk/govuk-frontend.min.css">
  <link rel="stylesheet" href="/assets/overlay.css">
  <script src="/assets/overlay.js" defer></script>
</head>
<body class="govuk-template__body wf-ov">
  <main class="wf-ov__main" id="main-content">
    <h1 class="govuk-visually-hidden wf-ov__sr">Warframe Info scan overlay</h1>
    <div class="wf-ov__bar">
      <button id="wf-ov-scan" class="govuk-button wf-ov__scan" type="button" data-display="${
    escapeHtml(capture.display)
  }" data-window="${escapeHtml(capture.window)}" hidden>Scan</button>
      <span id="wf-ov-status" class="wf-ov__status" role="status" aria-live="polite"></span>
      <span id="wf-ov-live" class="wf-ov__live" data-state="off">Static</span>
    </div>
    <div id="wf-ov-body" class="wf-ov__body" aria-live="polite">
${overlayBodyHtml(state)}
    </div>
  </main>
</body>
</html>`;
}
