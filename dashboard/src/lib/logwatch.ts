/**
 * Change notification for WFInfo's logs: `debug.log` (a file) and the
 * `ocr_runs/` directory. The /logs and /recent pages subscribe through the
 * server-sent events route (`logEventsResponse`), and re-fetch their existing
 * JSON endpoint on each `change` event.
 *
 * Two sources feed one check per target:
 *
 * - `Deno.watchFs` on a directory (low latency). A file target watches its
 *   parent directory, filtered by file name, because the file may not exist
 *   yet. A directory target watches the directory itself. One watcher per
 *   directory is shared by every target in it, and it is reference counted:
 *   it closes when the last subscriber goes.
 * - Polling as the fallback: every `pollMs` (3 s) while no watcher runs
 *   (`Deno.watchFs` threw, or the directory does not exist yet), else every
 *   `safetyPollMs` as a safety net. Each poll tries to start the watcher again.
 *
 * A check compares a stat stamp (size + mtime; for a directory, the stamp of
 * every entry), never the file text: `debug.log` can be large and grows on
 * every log line. Events inside `debounceMs` are coalesced into one check.
 *
 * Read-only: this module only stats, lists and watches. It never writes.
 *
 * Why not `filewatch.ts` (overlay branch): it compares the full text of one
 * small file (two reads per check) and cannot watch a directory.
 */

export type ChangeListener = () => void;

export interface WatchOptions {
  /** Poll interval while no filesystem watcher runs (ms). */
  pollMs?: number;
  /** Poll interval while a filesystem watcher runs (ms). */
  safetyPollMs?: number;
  /** Coalescing window after a filesystem event (ms). */
  debounceMs?: number;
  /** Set false to use polling only (tests, filesystems without events). */
  watch?: boolean;
}

export type TargetKind = "file" | "dir";

function sepIndex(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

function dirOf(path: string): string {
  const i = sepIndex(path);
  return i <= 0 ? (i === 0 ? path.slice(0, 1) : ".") : path.slice(0, i);
}

function baseOf(path: string): string {
  return path.slice(sepIndex(path) + 1);
}

function statOrNull(path: string): Deno.FileInfo | null {
  try {
    return Deno.statSync(path);
  } catch {
    return null;
  }
}

function infoStamp(info: Deno.FileInfo): string {
  return `${info.size}:${info.mtime?.getTime() ?? 0}:${info.ino ?? 0}`;
}

/** A cheap change stamp: "none" when absent, else size/mtime/inode. */
export function stampOf(path: string, kind: TargetKind): string {
  const info = statOrNull(path);
  if (info === null) return "none";
  if (kind === "file" || !info.isDirectory) return `f:${infoStamp(info)}`;
  const parts: string[] = [];
  try {
    for (const entry of Deno.readDirSync(path)) {
      const child = statOrNull(`${path}/${entry.name}`);
      parts.push(`${entry.name}=${child === null ? "?" : infoStamp(child)}`);
    }
  } catch {
    return "unreadable";
  }
  return `d:${parts.sort().join("|")}`;
}

/** Hooks a target gives its shared directory watcher. */
interface DirListener {
  onPaths: (paths: string[]) => void;
  onEnd: () => void;
}

/** One `Deno.watchFs` on one directory, shared by every target inside it. */
class SharedDir {
  #listeners = new Set<DirListener>();
  #watcher: Deno.FsWatcher | null = null;
  #ino: number | null = null;
  loop: Promise<void> | null = null;

  constructor(readonly path: string, readonly useWatch: boolean) {}

  get size(): number {
    return this.#listeners.size;
  }

  get active(): boolean {
    return this.#watcher !== null;
  }

  add(listener: DirListener): void {
    this.#listeners.add(listener);
  }

  remove(listener: DirListener): void {
    this.#listeners.delete(listener);
  }

  /** Start the watcher when possible; restart it if the directory changed. */
  ensure(): void {
    if (!this.useWatch) return;
    const info = statOrNull(this.path);
    if (this.#watcher !== null) {
      // The directory was removed or replaced: the old watcher is stale.
      if (info === null || !info.isDirectory || info.ino !== this.#ino) {
        this.close();
      } else return;
    }
    if (info === null || !info.isDirectory) return; // A poll retries later.
    let watcher: Deno.FsWatcher;
    try {
      watcher = Deno.watchFs(this.path, { recursive: false });
    } catch {
      return; // No filesystem events here: polling carries the updates.
    }
    this.#watcher = watcher;
    this.#ino = info.ino;
    this.loop = (async () => {
      try {
        for await (const event of watcher) {
          for (const l of [...this.#listeners]) l.onPaths(event.paths);
        }
      } catch {
        // Watcher failed (directory removed, backend error): fall back.
      } finally {
        if (this.#watcher === watcher) {
          this.#watcher = null;
          for (const l of [...this.#listeners]) l.onEnd();
        }
      }
    })();
  }

  close(): void {
    const watcher = this.#watcher;
    this.#watcher = null;
    if (watcher === null) return;
    try {
      watcher.close();
    } catch {
      // Already closed.
    }
  }
}

/** One watched path (file or directory) and its subscribers. */
class Target {
  listeners = new Set<ChangeListener>();
  stamp = "none";
  pollTimer: ReturnType<typeof setTimeout> | null = null;
  debounceTimer: ReturnType<typeof setTimeout> | null = null;
  readonly name: string;
  readonly hook: DirListener;

  constructor(
    readonly path: string,
    readonly kind: TargetKind,
    readonly dir: SharedDir,
    readonly hub: WatchHub,
  ) {
    this.name = baseOf(path);
    this.hook = {
      onPaths: (paths) => {
        if (
          this.kind === "dir" || paths.some((p) => baseOf(p) === this.name)
        ) {
          this.debounce();
        }
      },
      onEnd: () => {
        this.check();
        this.schedulePoll();
      },
    };
  }

  debounce(): void {
    if (this.debounceTimer !== null || this.listeners.size === 0) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.check();
    }, this.hub.debounceMs);
  }

  schedulePoll(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    if (this.listeners.size === 0) return;
    const delay = this.dir.active ? this.hub.safetyPollMs : this.hub.pollMs;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.listeners.size === 0) return;
      this.dir.ensure();
      this.check();
      this.schedulePoll();
    }, delay);
  }

  check(): void {
    if (this.listeners.size === 0) return;
    const stamp = stampOf(this.path, this.kind);
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // One failing subscriber must not stop the others.
      }
    }
  }

  stop(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
  }
}

/** Registry of shared directory watchers and watched targets. */
export class WatchHub {
  readonly pollMs: number;
  readonly safetyPollMs: number;
  readonly debounceMs: number;
  readonly useWatch: boolean;

  #dirs = new Map<string, SharedDir>();
  #targets = new Map<string, Target>();
  #ended: Promise<void>[] = [];

  constructor(options: WatchOptions = {}) {
    this.pollMs = options.pollMs ?? 3000;
    this.safetyPollMs = options.safetyPollMs ?? 15000;
    this.debounceMs = options.debounceMs ?? 200;
    this.useWatch = options.watch ?? true;
  }

  /** Call `listener` after each change of `path`; returns the unsubscribe. */
  subscribe(
    path: string,
    kind: TargetKind,
    listener: ChangeListener,
  ): () => void {
    let target = this.#targets.get(path);
    if (target === undefined) {
      const dirPath = kind === "file" ? dirOf(path) : path;
      let dir = this.#dirs.get(dirPath);
      if (dir === undefined) {
        dir = new SharedDir(dirPath, this.useWatch);
        this.#dirs.set(dirPath, dir);
      }
      target = new Target(path, kind, dir, this);
      this.#targets.set(path, target);
      target.stamp = stampOf(path, kind);
      dir.add(target.hook);
      dir.ensure();
    }
    const first = target.listeners.size === 0;
    target.listeners.add(listener);
    if (first) target.schedulePoll();

    const t = target;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      t.listeners.delete(listener);
      if (t.listeners.size > 0) return;
      t.stop();
      this.#targets.delete(t.path);
      t.dir.remove(t.hook);
      if (t.dir.size === 0) {
        t.dir.close();
        if (t.dir.loop !== null) this.#ended.push(t.dir.loop);
        this.#dirs.delete(t.dir.path);
      }
    };
  }

  /** True while a filesystem watcher (not only polling) serves `path`. */
  watching(path: string): boolean {
    return this.#targets.get(path)?.dir.active ?? false;
  }

  /** Open directory watchers / watched targets (for tests and diagnostics). */
  get counts(): { dirs: number; targets: number } {
    return { dirs: this.#dirs.size, targets: this.#targets.size };
  }

  /** Resolve once every closed watcher loop has ended. */
  async idle(): Promise<void> {
    const loops = this.#ended;
    this.#ended = [];
    await Promise.all(loops);
  }
}

/** The process-wide hub the dashboard routes use. */
export const logHub = new WatchHub();

/** Interval of the SSE comment line that keeps idle connections open. */
export const SSE_PING_MS = 25_000;

export interface LogSourceSpec {
  path: string;
  kind: TargetKind;
}

/**
 * GET /api/logs/events — server-sent events. Opens with `retry` and an
 * `event: ready` (the sources and whether each one has a filesystem watcher),
 * then one `event: change` with `{"source": name}` per change, and a comment
 * line every `pingMs`. `?source=` (repeatable) picks the sources; default:
 * all. A closed tab cancels the stream (`cancel`), which ends the
 * subscriptions. `req.signal` is not used: Deno.serve aborts it after every
 * response (legacy behavior), and `cancel` already covers a disconnect.
 */
export function logEventsResponse(
  req: Request,
  sources: Record<string, LogSourceSpec>,
  hub: WatchHub = logHub,
  pingMs: number = SSE_PING_MS,
): Response {
  const asked = new URL(req.url).searchParams.getAll("source")
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const names = asked.length > 0 ? [...new Set(asked)] : Object.keys(sources);
  const unknown = names.filter((n) => !Object.hasOwn(sources, n));
  if (unknown.length > 0) {
    return new Response(
      JSON.stringify({
        error: `Unknown source: ${unknown.join(", ")}`,
        sources: Object.keys(sources),
      }),
      {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  const encoder = new TextEncoder();
  let cleanup = (): void => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const unsubscribes: (() => void)[] = [];
      let ping: ReturnType<typeof setInterval> | null = null;

      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      cleanup = () => {
        if (closed) return;
        closed = true;
        for (const u of unsubscribes) u();
        if (ping !== null) clearInterval(ping);
        try {
          controller.close();
        } catch {
          // The client already went away.
        }
      };

      // Subscribe before `ready`: the page re-fetches on `ready`, so a change
      // between the page render and the stream start is never lost.
      for (const name of names) {
        const spec = sources[name];
        unsubscribes.push(
          hub.subscribe(spec.path, spec.kind, () =>
            send(
              `event: change\ndata: ${JSON.stringify({ source: name })}\n\n`,
            )),
        );
      }
      const watching: Record<string, boolean> = {};
      for (const name of names) {
        watching[name] = hub.watching(sources[name].path);
      }
      send("retry: 3000\n\n");
      send(
        `event: ready\ndata: ${
          JSON.stringify({ sources: names, watching })
        }\n\n`,
      );
      ping = setInterval(() => send(": ping\n\n"), pingMs);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
