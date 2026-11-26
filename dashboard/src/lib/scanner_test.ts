import { assertEquals, assertStringIncludes, assertTrue } from "./testutil.ts";
import { Scanner } from "./scanner.ts";

/* The scanner shells out to `sh`, so the commands below are portable and
   deterministic: no network, no files written outside nothing at all. */

Deno.test("scanner runs a command and reports success", async () => {
  const scanner = new Scanner({ command: "echo scanned" });
  assertTrue(!scanner.busy, "a fresh scanner is free");

  const outcome = await scanner.run();

  assertEquals(outcome.status, "ok");
  assertEquals(outcome.exitCode, 0);
  assertStringIncludes(outcome.output, "scanned");
  assertTrue(!scanner.busy, "the scanner is free again after the run");
});

Deno.test("scanner reports a failing command with its output", async () => {
  const scanner = new Scanner({ command: "echo boom >&2; exit 3" });

  const outcome = await scanner.run();

  assertEquals(outcome.status, "failed");
  assertEquals(outcome.exitCode, 3);
  assertStringIncludes(outcome.output, "boom");
});

Deno.test("scanner refuses a second run while one is in flight", async () => {
  const scanner = new Scanner({ command: "sleep 0.4" });
  const first = scanner.run();
  assertTrue(scanner.busy, "the first run holds the scanner");

  let refused = false;
  try {
    scanner.run();
  } catch {
    refused = true;
  }
  assertTrue(refused, "the second run is refused, never queued");

  assertEquals((await first).status, "ok");
  assertTrue(!scanner.busy, "the scanner frees up when the run ends");
});

Deno.test("scanner kills a command that passes the deadline", async () => {
  // `sleep 5` would outlive the test; the deadline must end the run instead.
  const scanner = new Scanner({ command: "sleep 5", timeoutMs: 150 });
  const startedMs = Date.now();

  const outcome = await scanner.run();

  assertEquals(outcome.status, "timeout");
  assertTrue(
    Date.now() - startedMs < 3000,
    "the run ended at the deadline, not at the command's own exit",
  );
  assertTrue(!scanner.busy, "a stopped run frees the scanner");
});

/** The pid a command wrote to `file`, polled until it appears. */
async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const text = await Deno.readTextFile(file).catch(() => "");
    if (text.trim() !== "") return Number(text.trim());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no pid in ${file}`);
}

/**
 * True when `pid` still runs after three seconds. A killed orphan stays a
 * zombie (signal 0 still finds it) until init reaps it, which can take a
 * moment; a zombie runs nothing and holds no pipes, so it counts as dead.
 */
async function alive(pid: number): Promise<boolean> {
  for (let i = 0; i < 150; i++) {
    try {
      Deno.kill(pid, 0); // Signal 0 only checks that the pid exists.
    } catch {
      return false;
    }
    // Linux: field 3 of /proc/<pid>/stat is the state ("Z" = zombie).
    const stat = await Deno.readTextFile(`/proc/${pid}/stat`).catch(() => "");
    if (/^\d+ \(.*\) Z /.test(stat)) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

Deno.test({
  name: "scanner kills the grandchildren of a command at the deadline",
  // Process groups are POSIX; Windows kills the direct child only.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // `sleep 5; echo done` is a list, so every shell (bash too) forks `sleep`
    // as a grandchild that holds the output pipes. Killing `sh` alone would
    // leave the run waiting the full 5 s.
    const pidFile = await Deno.makeTempFile();
    try {
      const scanner = new Scanner({
        command: `sleep 5 & echo $! > '${pidFile}'; wait; echo done`,
        timeoutMs: 300,
      });
      const startedMs = Date.now();

      const outcome = await scanner.run();

      assertEquals(outcome.status, "timeout");
      assertTrue(
        Date.now() - startedMs < 3000,
        "the run ended at the deadline, not when the grandchild exited",
      );
      assertTrue(!outcome.output.includes("done"), "the list never finished");
      const sleepPid = await readPid(pidFile);
      assertTrue(
        !(await alive(sleepPid)),
        "the grandchild died with the group",
      );
      assertTrue(!scanner.busy, "a stopped run frees the scanner");
    } finally {
      await Deno.remove(pidFile);
    }
  },
});

Deno.test({
  name: "scanner stop kills the run in flight with its grandchildren",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const pidFile = await Deno.makeTempFile();
    try {
      const scanner = new Scanner({
        command: `sleep 5 & echo $! > '${pidFile}'; wait; echo done`,
      });
      const running = scanner.run();
      const sleepPid = await readPid(pidFile);
      const startedMs = Date.now();

      scanner.stop();
      const outcome = await running;

      assertTrue(Date.now() - startedMs < 3000, "stop ended the run at once");
      assertTrue(outcome.status !== "ok", "a stopped run is not a success");
      assertTrue(
        !(await alive(sleepPid)),
        "the grandchild died with the group",
      );
      assertTrue(!scanner.busy, "a stopped run frees the scanner");
      scanner.stop(); // A stop with nothing in flight is a no-op.
    } finally {
      await Deno.remove(pidFile);
    }
  },
});
