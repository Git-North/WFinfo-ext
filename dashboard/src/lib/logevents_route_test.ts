import { assertEquals, assertStringIncludes, streamText } from "./testutil.ts";
import { resolveAppDir } from "./fsdata.ts";
import { logHub } from "./logwatch.ts";

/**
 * Route proof for GET /api/logs/events through the real handler. src/main.ts
 * resolves its app dir from the environment at import time, so the fixture
 * is set up BEFORE the dynamic import (own file: Deno gives each test file its
 * own worker). On macOS the app dir lives under HOME, so HOME points at the
 * fixture root too. The test only writes inside its temp dir.
 */
Deno.test("GET /api/logs/events: debug.log and ocr_runs changes reach the client", async () => {
  const root = await Deno.makeTempDir({ prefix: "wfinfo_logevents_route_" });
  const savedHome = Deno.env.get("HOME");
  const savedData = Deno.env.get("WFINFO_DATA_DIR");
  try {
    const appDir = resolveAppDir({ WFINFO_DATA_DIR: root, HOME: root });
    await Deno.mkdir(`${appDir}/ocr_runs`, { recursive: true });
    await Deno.writeTextFile(
      `${appDir}/debug.log`,
      "[01/01/2026 10:00:00] a\n",
    );

    Deno.env.set("WFINFO_DATA_DIR", root);
    Deno.env.set("HOME", root);
    const { handler } = await import("../main.ts");

    const bad = await handler(
      new Request("http://localhost/api/logs/events?source=nope"),
    );
    assertEquals(bad.status, 400);
    await bad.body?.cancel();

    const resp = await handler(
      new Request("http://localhost/api/logs/events"),
    );
    assertEquals(resp.status, 200);
    assertEquals(
      resp.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );
    const sse = streamText(resp.body!);
    await sse.until("event: ready");
    assertStringIncludes(sse.text, '"sources":["debug.log","ocr_runs","scan"]');

    await Deno.writeTextFile(
      `${appDir}/debug.log`,
      "[01/01/2026 10:00:01] b\n",
      { append: true },
    );
    await sse.until('data: {"source":"debug.log"}');

    await Deno.writeTextFile(`${appDir}/ocr_runs/run.json`, "{}");
    await sse.until('data: {"source":"ocr_runs"}');

    // The existing JSON endpoint still serves the payload the page re-fetches.
    const logs = await handler(new Request("http://localhost/api/logs"));
    const body = await logs.json();
    assertEquals(body.lines[0], "[01/01/2026 10:00:01] b");

    await sse.cancel(); // What a closed tab does to the stream.
    assertEquals(logHub.counts, { dirs: 0, targets: 0 }, "watchers closed");
    await logHub.idle();
  } finally {
    if (savedHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", savedHome);
    if (savedData === undefined) Deno.env.delete("WFINFO_DATA_DIR");
    else Deno.env.set("WFINFO_DATA_DIR", savedData);
    await Deno.remove(root, { recursive: true });
  }
});
