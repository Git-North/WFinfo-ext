import {
  assertEquals,
  assertStringIncludes,
  assertTrue,
  streamText,
} from "./testutil.ts";
import { logEventsResponse, stampOf, WatchHub } from "./logwatch.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `count()` passes `n`, or fail after `ms`. */
async function waitFor(
  what: string,
  ok: () => boolean,
  ms = 2000,
): Promise<number> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) {
      throw new Error(`${what}: not within ${ms} ms`);
    }
    await sleep(10);
  }
  return Date.now() - start;
}

const fast = { pollMs: 80, safetyPollMs: 300, debounceMs: 20 };

for (const watch of [true, false]) {
  const mode = watch ? "watchFs" : "polling only";

  Deno.test(`WatchHub (${mode}): file create, append, no-op, removal`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "wfinfo_logwatch_" });
    const hub = new WatchHub({ ...fast, watch });
    const file = `${dir}/debug.log`;
    let n = 0;
    const off = hub.subscribe(file, "file", () => n++);
    try {
      if (watch) assertTrue(hub.watching(file), "watchFs is active");
      else assertTrue(!hub.watching(file), "polling only");

      await Deno.writeTextFile(file, "[01/01/2026 10:00:00] start\n");
      await waitFor("create", () => n === 1);

      await Deno.writeTextFile(file, "[01/01/2026 10:00:01] more\n", {
        append: true,
      });
      await waitFor("append", () => n === 2);

      // A sibling file in the same directory is not a debug.log change.
      await Deno.writeTextFile(`${dir}/other.txt`, "x");
      await sleep(watch ? 150 : 250);
      assertEquals(n, 2, "a sibling file is silent");

      await Deno.remove(file);
      await waitFor("removal", () => n === 3);
    } finally {
      off();
      await hub.idle();
      assertEquals(hub.counts, { dirs: 0, targets: 0 });
      await Deno.remove(dir, { recursive: true });
    }
  });

  Deno.test(`WatchHub (${mode}): directory target sees a new run file`, async () => {
    const root = await Deno.makeTempDir({ prefix: "wfinfo_logwatch_" });
    const runs = `${root}/ocr_runs`;
    await Deno.mkdir(runs);
    const hub = new WatchHub({ ...fast, watch });
    let n = 0;
    const off = hub.subscribe(runs, "dir", () => n++);
    try {
      await Deno.writeTextFile(`${runs}/run1.json`, "{}");
      await waitFor("new file", () => n >= 1);
      const before = n;
      await Deno.writeTextFile(`${runs}/run1.json`, '{"a":1}');
      await waitFor("rewrite", () => n > before);
    } finally {
      off();
      await hub.idle();
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("WatchHub: one shared watcher per directory, reference counted", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wfinfo_logwatch_" });
  const hub = new WatchHub(fast);
  const file = `${dir}/debug.log`;
  let a = 0;
  let b = 0;
  let c = 0;
  const offA = hub.subscribe(file, "file", () => a++);
  const offB = hub.subscribe(file, "file", () => b++);
  const offC = hub.subscribe(`${dir}/other.log`, "file", () => c++);
  try {
    assertEquals(hub.counts, { dirs: 1, targets: 2 });
    await Deno.writeTextFile(file, "line\n");
    await waitFor("both subscribers", () => a === 1 && b === 1);
    assertEquals(c, 0, "the other target in the same dir is silent");

    offA();
    offA(); // A second call is a no-op.
    assertEquals(hub.counts, { dirs: 1, targets: 2 });
    await Deno.writeTextFile(file, "line\n", { append: true });
    await waitFor("remaining subscriber", () => b === 2);
    assertEquals(a, 1, "an unsubscribed listener gets nothing");

    offB();
    assertEquals(hub.counts, { dirs: 1, targets: 1 });
    offC();
    assertEquals(hub.counts, { dirs: 0, targets: 0 });
  } finally {
    offA();
    offB();
    offC();
    await hub.idle();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("WatchHub: a missing app dir polls, then watches once it exists", async () => {
  const root = await Deno.makeTempDir({ prefix: "wfinfo_logwatch_" });
  const appDir = `${root}/WFInfo`;
  const file = `${appDir}/debug.log`;
  const hub = new WatchHub(fast);
  let n = 0;
  const off = hub.subscribe(file, "file", () => n++);
  try {
    assertTrue(!hub.watching(file), "no directory: polling");
    await Deno.mkdir(appDir);
    await Deno.writeTextFile(file, "first\n");
    await waitFor("poll sees the new file", () => n === 1);
    await waitFor("watcher starts", () => hub.watching(file));
    await Deno.writeTextFile(file, "second\n", { append: true });
    await waitFor("watcher sees the append", () => n === 2);
  } finally {
    off();
    await hub.idle();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stampOf: never reads file content, changes with size", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wfinfo_logwatch_" });
  try {
    assertEquals(stampOf(`${dir}/nope`, "file"), "none");
    await Deno.writeTextFile(`${dir}/a`, "1");
    const s1 = stampOf(`${dir}/a`, "file");
    await Deno.writeTextFile(`${dir}/a`, "12");
    assertTrue(stampOf(`${dir}/a`, "file") !== s1, "size change");
    const d1 = stampOf(dir, "dir");
    await Deno.writeTextFile(`${dir}/b`, "");
    assertTrue(stampOf(dir, "dir") !== d1, "new entry");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logEventsResponse: ready, change, ping, unknown source, cleanup", async () => {
  const root = await Deno.makeTempDir({ prefix: "wfinfo_logwatch_" });
  const hub = new WatchHub(fast);
  const sources = {
    "debug.log": { path: `${root}/debug.log`, kind: "file" as const },
    ocr_runs: { path: `${root}/ocr_runs`, kind: "dir" as const },
  };
  try {
    const bad = logEventsResponse(
      new Request("http://localhost/api/logs/events?source=EE.log"),
      sources,
      hub,
    );
    assertEquals(bad.status, 400);
    assertStringIncludes(await bad.text(), "EE.log");
    assertEquals(hub.counts, { dirs: 0, targets: 0 });

    const resp = logEventsResponse(
      new Request("http://localhost/api/logs/events?source=debug.log"),
      sources,
      hub,
      100,
    );
    assertEquals(resp.status, 200);
    assertEquals(
      resp.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );
    assertEquals(hub.counts, { dirs: 1, targets: 1 }, "only debug.log");
    const sse = streamText(resp.body!);
    await sse.until("event: ready");
    assertStringIncludes(sse.text, "retry: 3000");
    assertStringIncludes(
      sse.text,
      'data: {"sources":["debug.log"],"watching":{"debug.log":true}}',
    );

    await Deno.writeTextFile(sources["debug.log"].path, "line\n");
    await sse.until("event: change");
    assertStringIncludes(
      sse.text,
      'event: change\ndata: {"source":"debug.log"}\n\n',
    );
    await sse.until(": ping\n\n");

    await sse.cancel(); // What a closed tab does to the stream.
    assertEquals(hub.counts, { dirs: 0, targets: 0 }, "client gone: cleaned");
  } finally {
    await hub.idle();
    await Deno.remove(root, { recursive: true });
  }
});
