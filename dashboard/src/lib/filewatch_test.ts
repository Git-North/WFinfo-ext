import { assertEquals, assertTrue } from "./testutil.ts";
import { FileWatch } from "./filewatch.ts";

/** Resolve with the next text a listener gets, or fail after `ms`. */
function nextChange(
  queue: (string | null)[],
  ms: number,
): Promise<string | null> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (queue.length > 0) return resolve(queue.shift()!);
      if (Date.now() > deadline) {
        return reject(new Error(`no change within ${ms} ms`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const watch of [true, false]) {
  const mode = watch ? "watchFs" : "polling only";

  Deno.test(`FileWatch (${mode}): reports create, rewrite and removal`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "wfinfo_filewatch_" });
    const file = `${dir}/latest.json`;
    const fw = new FileWatch({
      path: file,
      watch,
      pollMs: 100,
      safetyPollMs: 400,
      debounceMs: 30,
      settleMs: 10,
    });
    const seen: (string | null)[] = [];
    const sub = fw.subscribe((text) => seen.push(text));
    try {
      assertEquals(sub.current, null, "no file yet");
      if (watch) assertTrue(fw.watching, "watchFs is active");

      await Deno.writeTextFile(file, '{"a":1}');
      assertEquals(await nextChange(seen, 1500), '{"a":1}');

      await Deno.writeTextFile(file, '{"a":2}');
      assertEquals(await nextChange(seen, 1500), '{"a":2}');

      // Same text again: no event (a change is a change of content).
      await Deno.writeTextFile(file, '{"a":2}');
      await sleep(300);
      assertEquals(seen.length, 0, "rewrite with the same text is silent");

      await Deno.remove(file);
      assertEquals(await nextChange(seen, 1500), null);
    } finally {
      sub.unsubscribe();
      await fw.idle();
      assertEquals(fw.size, 0);
      assertTrue(!fw.watching, "watcher closed with the last subscriber");
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("FileWatch: the baseline is the current text, and unsubscribe stops events", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wfinfo_filewatch_" });
  const file = `${dir}/latest.json`;
  await Deno.writeTextFile(file, "first");
  const fw = new FileWatch({
    path: file,
    watch: false,
    pollMs: 50,
    settleMs: 5,
  });
  const seen: (string | null)[] = [];
  const sub = fw.subscribe((text) => seen.push(text));
  try {
    assertEquals(sub.current, "first");
    sub.unsubscribe();
    await Deno.writeTextFile(file, "second");
    await sleep(250);
    assertEquals(seen.length, 0, "no event after unsubscribe");

    // A new subscriber starts from the text on disk now.
    const again = fw.subscribe(() => {});
    assertEquals(again.current, "second");
    again.unsubscribe();
  } finally {
    await fw.idle();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FileWatch: a missing directory falls back to polling until it appears", async () => {
  const root = await Deno.makeTempDir({ prefix: "wfinfo_filewatch_" });
  const file = `${root}/scans/latest.json`;
  const fw = new FileWatch({
    path: file,
    pollMs: 50,
    safetyPollMs: 400,
    debounceMs: 20,
    settleMs: 5,
  });
  const seen: (string | null)[] = [];
  const sub = fw.subscribe((text) => seen.push(text));
  try {
    assertTrue(!fw.watching, "no directory, no watcher");
    await Deno.mkdir(`${root}/scans`);
    await Deno.writeTextFile(file, "record");
    assertEquals(await nextChange(seen, 1500), "record");
  } finally {
    sub.unsubscribe();
    await fw.idle();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("FileWatch: a Windows event path with a backslash is seen", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wfinfo_filewatch_sep_" });
  const file = `${dir}/latest.json`;
  // A stand-in watcher that reports paths the way Windows does: the watched
  // folder as given, then a backslash before the file name.
  const realWatch = Deno.watchFs;
  let emit: (path: string) => void = () => {};
  let end: () => void = () => {};
  Deno.watchFs = () => {
    const queue: string[] = [];
    let wake: () => void = () => {};
    let closed = false;
    emit = (path) => {
      queue.push(path);
      wake();
    };
    end = () => {
      closed = true;
      wake();
    };
    const events = async function* () {
      while (!closed) {
        while (queue.length > 0) {
          yield { kind: "modify", paths: [queue.shift()!] } as Deno.FsEvent;
        }
        if (!closed) await new Promise<void>((resolve) => wake = resolve);
      }
    }();
    return Object.assign(events, {
      close: () => end(),
    }) as unknown as Deno.FsWatcher;
  };
  // The polls are too slow to help: only the event can report the change.
  const fw = new FileWatch({
    path: file,
    pollMs: 60_000,
    safetyPollMs: 60_000,
    debounceMs: 10,
    settleMs: 10,
  });
  const seen: (string | null)[] = [];
  const sub = fw.subscribe((text) => seen.push(text));
  try {
    await Deno.writeTextFile(file, "new record");
    emit(`${dir}\\latest.json`);
    assertEquals(await nextChange(seen, 1500), "new record");
  } finally {
    sub.unsubscribe();
    await fw.idle();
    Deno.watchFs = realWatch;
    await Deno.remove(dir, { recursive: true });
  }
});
