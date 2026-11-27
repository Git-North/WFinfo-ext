import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
  assertTrue,
} from "./testutil.ts";
import { resolveAppDir } from "./fsdata.ts";

/**
 * Route proof for the overlay: GET /overlay, GET /api/scan?view=overlay and
 * the server-sent events of GET /api/scan/events. src/main.ts resolves its
 * app-data dir at import time, so WFINFO_DATA_DIR is set BEFORE the dynamic
 * import. On macOS the app dir is under HOME (as for the .NET app, which
 * ignores WFINFO_DATA_DIR there) and on Windows under APPDATA, so both point at
 * the fixture root too. Own file on purpose: each test file gets its own worker.
 */

function record(part: string, plat: number, extra: Record<string, unknown>) {
  return {
    Version: 1,
    StartedAt: "2026-09-10T14:31:02.123Z",
    DurationMs: 1357,
    CaptureSource: "grim",
    CaptureTarget: "DP-2",
    Choices: [
      {
        Index: 1,
        Part: "Volt & Prime <Blueprint>",
        Slug: "volt_prime_blueprint",
        Plat: "12.5",
        PlatSource: "cache",
        Ducats: 25,
        Best: false,
      },
      {
        Index: 2,
        Part: part,
        Slug: "mirage_prime_systems",
        Plat: plat,
        PlatSource: "wfm",
        Ducats: 45,
        Best: true,
      },
      { Index: 3, Part: "Forma Blueprint", Plat: null, Ducats: null },
      { Index: 4, Part: "Lex Prime Barrel", Plat: 4, Ducats: 15 },
    ],
    Best: { Index: 2, Part: part, Plat: plat },
    PriceCache: { Hits: 1, Fetched: 1, Failed: 0, Entries: 137 },
    Error: null,
    ...extra,
  };
}

/** Reads `event: scan` messages from an SSE body, one at a time. */
class SseReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #decoder = new TextDecoder();
  #buffer = "";

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  /** The next `scan` event's JSON data, or a failure after `ms`. */
  async next(ms: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    while (true) {
      const end = this.#buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        const lines = block.split("\n");
        if (lines.includes("event: scan")) {
          const data = lines.filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6)).join("\n");
          return JSON.parse(data);
        }
        continue; // retry:, comments
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no scan event within ${ms} ms`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("SSE read timed out")), left);
      });
      try {
        const { value, done } = await Promise.race([
          this.#reader.read(),
          timeout,
        ]);
        if (done) throw new Error("SSE stream ended");
        this.#buffer += this.#decoder.decode(value, { stream: true });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel();
  }
}

Deno.test("overlay routes: page, polling API and live events", async () => {
  const root = await Deno.makeTempDir({ prefix: "wfinfo_overlay_route_" });
  const savedHome = Deno.env.get("HOME");
  const savedAppData = Deno.env.get("APPDATA");
  try {
    const appDir = resolveAppDir({
      WFINFO_DATA_DIR: root,
      HOME: root,
      APPDATA: root,
    });
    const scanFile = `${appDir}/scans/latest.json`;
    Deno.env.set("WFINFO_DATA_DIR", root);
    Deno.env.set("HOME", root);
    if (Deno.build.os === "windows") Deno.env.set("APPDATA", root);
    const { handler } = await import("../main.ts");

    // No scans/ directory, no record: the empty state.
    const empty = await handler(new Request("http://localhost/overlay"));
    assertEquals(empty.status, 200);
    const emptyText = await empty.text();
    assertStringIncludes(emptyText, "No scan yet");
    assertStringIncludes(emptyText, "scans/latest.json");

    await Deno.mkdir(`${appDir}/scans`, { recursive: true });
    await Deno.writeTextFile(
      scanFile,
      JSON.stringify(record("Mirage Prime Systems", 62, {})),
    );

    // GET /overlay — compact page: no GOV.UK chrome, every part with plat
    // and ducats, the best pick marked, escaped names, the scan time.
    const page = await handler(
      new Request("http://localhost/overlay?display=display:DP-2&window=%22x"),
    );
    assertEquals(page.status, 200);
    const pageText = await page.text();
    assertMatch(pageText, /<title>Scan overlay — Warframe Info<\/title>/);
    assertTrue(!pageText.includes("govuk-header"), "no GOV.UK header");
    assertTrue(!pageText.includes("govuk-footer"), "no GOV.UK footer");
    assertTrue(!pageText.includes("wf-tabs"), "no page tabs");
    assertStringIncludes(pageText, "/assets/overlay.css");
    assertStringIncludes(pageText, "/assets/overlay.js");
    assertStringIncludes(pageText, "Volt &amp; Prime &lt;Blueprint&gt;");
    assertMatch(
      pageText,
      /<tr class="wf-ov__row wf-ov__row--best">\s*<th[^>]*><span class="wf-ov__part-name">Mirage Prime Systems<\/span> <strong class="wf-ov__best">Best<\/strong><\/th>\s*<td class="wf-ov__num wf-ov__num--plat">62<\/td>\s*<td class="wf-ov__num wf-ov__num--ducats">45<\/td>/,
    );
    assertStringIncludes(pageText, ">12.5</td>");
    assertStringIncludes(pageText, ">25</td>");
    assertStringIncludes(pageText, 'datetime="2026-09-10T14:31:02.123Z"');
    assertEquals(
      (pageText.match(/class="wf-ov__row[ "]/g) ?? []).length,
      4,
      "four rows",
    );
    // The Scan button carries the URL's capture tokens, escaped.
    assertStringIncludes(pageText, 'id="wf-ov-scan"');
    assertStringIncludes(pageText, 'data-display="display:DP-2"');
    assertStringIncludes(pageText, 'data-window="&quot;x"');

    // GET /api/scan?view=overlay — the polling fallback: same body markup.
    const api = await handler(
      new Request("http://localhost/api/scan?view=overlay"),
    );
    assertEquals(api.status, 200);
    const apiJson = await api.json();
    assertEquals(typeof apiJson.updatedAt, "number");
    assertEquals(typeof apiJson.version, "string");
    assertStringIncludes(apiJson.body as string, "wf-ov__row--best");
    assertTrue(
      !(apiJson.body as string).includes("govuk-panel"),
      "overlay body, not the /scan page body",
    );
    // The default /api/scan stays the /scan page body.
    const plain = await (await handler(
      new Request("http://localhost/api/scan"),
    )).json();
    assertStringIncludes(plain.body as string, "Take: Mirage Prime Systems");

    // GET /api/scan/events — opens with the current state, then pushes each
    // change of scans/latest.json.
    const events = await handler(
      new Request("http://localhost/api/scan/events"),
    );
    assertEquals(events.status, 200);
    assertMatch(
      events.headers.get("content-type") ?? "",
      /^text\/event-stream/,
    );
    assertEquals(events.headers.get("cache-control"), "no-store");
    const sse = new SseReader(events.body!);
    try {
      const first = await sse.next(2000);
      assertStringIncludes(first.body as string, "Mirage Prime Systems");
      assertEquals(first.version, apiJson.version);

      // A new scan: the event arrives well within a second.
      const t0 = Date.now();
      await Deno.writeTextFile(
        scanFile,
        JSON.stringify(record("Saryn Prime Neuroptics", 85, {})),
      );
      const second = await sse.next(3000);
      const latency = Date.now() - t0;
      assertStringIncludes(second.body as string, "Saryn Prime Neuroptics");
      assertStringIncludes(second.body as string, ">85</td>");
      assertTrue(second.version !== first.version, "new version stamp");
      assertTrue(latency < 1000, `pushed in ${latency} ms (< 1000 ms)`);

      // A scan with an error: the error state, escaped.
      await Deno.writeTextFile(
        scanFile,
        JSON.stringify({
          ...record("x", 1, {}),
          Choices: [],
          Best: null,
          Error: "no reward <screen>",
        }),
      );
      const failed = await sse.next(3000);
      assertStringIncludes(failed.body as string, "Scan error");
      assertStringIncludes(failed.body as string, "no reward &lt;screen&gt;");

      // A record that does not parse: the unreadable state.
      await Deno.writeTextFile(scanFile, "{ not json");
      const broken = await sse.next(3000);
      assertStringIncludes(broken.body as string, "Scan record unreadable");

      // The record removed: back to the empty state.
      await Deno.remove(scanFile);
      const gone = await sse.next(3000);
      assertStringIncludes(gone.body as string, "No scan yet");
      assertEquals(gone.version, "none");
    } finally {
      await sse.cancel();
    }

    // Wait for the shared watcher to wind down, so no timer or watch outlives
    // the test (Deno's sanitizers check this).
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    if (savedHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", savedHome);
    if (savedAppData === undefined) Deno.env.delete("APPDATA");
    else Deno.env.set("APPDATA", savedAppData);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("overlay: no-choice record shows the no-reward-screen state", async () => {
  const { overlayBodyHtml } = await import("./overlay.ts");
  const body = overlayBodyHtml({
    status: "scan",
    recordPath: "/x/scans/latest.json",
    scan: {
      startedMs: null,
      finishedMs: null,
      durationMs: null,
      captureSource: null,
      captureTarget: null,
      screenshot: false,
      choices: [],
      best: null,
      priceCache: { hits: 0, fetched: 0, failed: 0, entries: 0 },
      error: null,
    },
  });
  assertStringIncludes(body, "No reward screen found");
  assertStringIncludes(body, "Time unknown");
  assertTrue(!body.includes("<table"), "no empty table");
});
