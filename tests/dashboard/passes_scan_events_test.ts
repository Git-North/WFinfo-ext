import {
  assertEquals,
  assertStringIncludes,
  streamText,
} from "../../dashboard/src/lib/testutil.ts";
import { resolveAppDir } from "../../dashboard/src/lib/fsdata.ts";
import { logHub } from "../../dashboard/src/lib/logwatch.ts";

/**
 * The "scan" source of GET /api/logs/events: each publish of
 * scans/latest.json (a rename, as the runner does it) sends a change, and the
 * re-fetched scan body shows the fast stage and the notice. main.ts resolves
 * its app dir at import time, so HOME / WFINFO_DATA_DIR point at a temp root
 * BEFORE the import, and the test refuses to run on the real app dir.
 */
Deno.test("scan source: each latest.json publish is a change event", async () => {
  const root = await Deno.makeTempDir({ prefix: "wfinfo_passes_events_" });
  const realAppDir = resolveAppDir(Deno.env.toObject());
  const savedHome = Deno.env.get("HOME");
  const savedData = Deno.env.get("WFINFO_DATA_DIR");
  try {
    const appDir = resolveAppDir({ WFINFO_DATA_DIR: root, HOME: root });
    if (appDir === realAppDir || !appDir.startsWith(root)) {
      throw new Error(`refusing to write into the real app dir ${appDir}`);
    }
    const scans = `${appDir}/scans`;
    await Deno.mkdir(scans, { recursive: true });
    const publish = async (record: Record<string, unknown>) => {
      await Deno.writeTextFile(
        `${scans}/latest.json.1.tmp`,
        JSON.stringify(record),
      );
      await Deno.rename(`${scans}/latest.json.1.tmp`, `${scans}/latest.json`);
    };
    const base = {
      Version: 1,
      StartedAt: "2026-11-27T14:32:00.000Z",
      ScanId: "20261127_143200000-1",
      Trigger: "watch",
      Choices: [{ Index: 1, Part: "Forma Blueprint", Plat: 10 }],
    };

    Deno.env.set("WFINFO_DATA_DIR", root);
    Deno.env.set("HOME", root);
    const { handler } = await import("../../dashboard/src/main.ts");

    const resp = await handler(
      new Request("http://localhost/api/logs/events?source=scan"),
    );
    assertEquals(resp.status, 200);
    const sse = streamText(resp.body!);
    await sse.until("event: ready");
    assertStringIncludes(sse.text, '"sources":["scan"]');

    await publish({ ...base, Stage: "fast" });
    await sse.until('data: {"source":"scan"}');
    const fast = await (await handler(new Request("http://localhost/api/scan")))
      .json();
    assertStringIncludes(fast.body, "refining");

    await publish({
      ...base,
      Stage: "deep",
      Notice: "Last scan found nothing at 14:32",
    });
    // The deep publish is a second change event.
    const change = 'event: change\ndata: {"source":"scan"}\n\n';
    await sse.until(change + change);
    const deep = await (await handler(new Request("http://localhost/api/scan")))
      .json();
    assertStringIncludes(deep.body, "Last scan found nothing at 14:32");
    assertEquals(deep.body.includes("refining"), false);

    await sse.cancel();
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
