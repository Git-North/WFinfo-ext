/**
 * Dashboard-triggered scan runs.
 *
 * The dashboard cannot OCR by itself: a scan is the headless runner
 * (`WFInfo.Headless --scan` — capture, OCR, prices, record). This module runs
 * the configured command, one run at a time, under a deadline, and reports
 * what the command did. The runner owns every file a scan writes (`scans/`,
 * `price_cache.json`); the dashboard itself still writes nothing.
 */

/** A first run compiles the runner, so the default deadline is generous. */
export const DEFAULT_SCAN_TIMEOUT_MS = 180_000;

/** How much of the command's output is kept for the response. */
const OUTPUT_TAIL_CHARS = 4000;

/**
 * How long the output pipes may stay open after `sh` is gone. A process that
 * left the group (its own `setsid`) and kept the pipes would otherwise hold
 * the run, and the scanner, until it exits.
 */
const PIPE_GRACE_MS = 1000;

export type ScanStatus = "ok" | "failed" | "timeout" | "error";

export interface ScanOutcome {
  /** `ok` only when the command exited 0 within the deadline. */
  status: ScanStatus;
  /** Exit code, or null when the command never ran to completion. */
  exitCode: number | null;
  durationMs: number;
  /** Tail of the combined stdout and stderr. */
  output: string;
}

export interface ScannerOptions {
  /** Shell command that runs one scan. */
  command: string;
  /** Deadline for one run; the process is killed when it passes. */
  timeoutMs?: number;
}

/**
 * Process groups are a POSIX feature; on Windows `Deno.kill` refuses a
 * negative pid, so there the scanner kills the direct child only.
 */
const GROUP_KILL = Deno.build.os !== "windows";

/** Read a stream as text to its end, or until `cancel` stops the read. */
function collect(stream: ReadableStream<Uint8Array>): {
  text: Promise<string>;
  cancel: () => void;
} {
  const reader = stream.getReader();
  const text = (async () => {
    const decoder = new TextDecoder();
    let out = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
    } catch {
      // A cancelled read ends the text where it is.
    }
    return out + decoder.decode();
  })();
  return { text, cancel: () => void reader.cancel().catch(() => {}) };
}

/** POSIX single-quote a value for the shell command line. */
function quoteArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class Scanner {
  readonly command: string;
  readonly timeoutMs: number;
  #running: Promise<ScanOutcome> | null = null;
  #child: Deno.ChildProcess | null = null;

  constructor(options: ScannerOptions) {
    this.command = options.command.trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  }

  /** True while a run holds the scanner. */
  get busy(): boolean {
    return this.#running !== null;
  }

  /**
   * Run one scan with extra command-line arguments (for example
   * `["--region", "10,44 1900x1026"]`). Callers test `busy` first: two runs at
   * once would capture the screen twice and race on the scan record.
   */
  run(extraArgs: string[] = []): Promise<ScanOutcome> {
    if (this.#running !== null) {
      throw new Error("a scan is already running");
    }
    const startedMs = Date.now();
    const command = extraArgs.length === 0
      ? this.command
      : `${this.command} ${extraArgs.map(quoteArg).join(" ")}`;
    const running = this.#execute(startedMs, command).finally(() => {
      this.#running = null;
    });
    this.#running = running;
    return running;
  }

  async #execute(startedMs: number, command: string): Promise<ScanOutcome> {
    const outcome = (
      status: ScanStatus,
      exitCode: number | null,
      output: string,
    ): ScanOutcome => {
      const text = output.trim();
      return {
        status,
        exitCode,
        durationMs: Date.now() - startedMs,
        output: text.length <= OUTPUT_TAIL_CHARS
          ? text
          : `…${text.slice(-OUTPUT_TAIL_CHARS)}`,
      };
    };

    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command("sh", {
        args: ["-c", command],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        // Own session and process group (setsid), so `#kill` reaches every
        // process the command starts, not only `sh`.
        detached: GROUP_KILL,
      }).spawn();
    } catch (err) {
      return outcome(
        "error",
        null,
        err instanceof Error ? err.message : `${err}`,
      );
    }

    this.#child = child;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      this.#kill(child);
    }, this.timeoutMs);

    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    try {
      const { code } = await child.status;
      // `sh` is gone; the pipes close when the last process that holds them
      // exits. Stop reading after a grace, so one that escaped the group
      // kill cannot keep the run busy.
      const grace = setTimeout(() => {
        stdout.cancel();
        stderr.cancel();
      }, PIPE_GRACE_MS);
      const [out, errOut] = await Promise.all([stdout.text, stderr.text]);
      clearTimeout(grace);
      const text = `${out}\n${errOut}`;
      if (timedOut) return outcome("timeout", code, text);
      return outcome(code === 0 ? "ok" : "failed", code, text);
    } catch (err) {
      return outcome(
        "error",
        null,
        err instanceof Error ? err.message : `${err}`,
      );
    } finally {
      clearTimeout(deadline);
      this.#child = null;
    }
  }

  /**
   * Kill the run in flight, if any, with everything it started. The server
   * calls this on shutdown: the run has its own process group, so a Ctrl-C in
   * the terminal no longer reaches it.
   */
  stop(): void {
    if (this.#child !== null) this.#kill(this.#child);
  }

  #kill(child: Deno.ChildProcess): void {
    try {
      // A negative pid signals the whole group. Killing `sh` alone (dash
      // forks even a single command; `nix run` starts `dotnet`) leaves its
      // children running, and holding the output pipes.
      if (GROUP_KILL) Deno.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // The group already exited; there is nothing left to stop.
    }
  }
}
