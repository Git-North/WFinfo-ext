/**
 * Watch one small file for content changes and tell subscribers.
 *
 * The overlay's server-sent events use this to push a new scan record the
 * moment `scans/latest.json` changes. Two sources feed one check:
 *
 * - `Deno.watchFs` on the file's directory (low latency). The directory is
 *   watched, not the file, because the file may not exist yet and a writer may
 *   replace it.
 * - A polling timer as the fallback: fast (`pollMs`) while no watcher runs,
 *   slow (`safetyPollMs`) as a safety net while one does.
 *
 * A change is a change of the file's text (or of its presence), never of its
 * mtime alone. The scanner writes the file in place (`File.WriteAllText`), so a
 * check reads the file twice, `settleMs` apart, and waits for a stable read
 * before it reports: a half-written record is never pushed.
 *
 * The watcher runs only while at least one subscriber exists. It never writes.
 */

export interface FileWatchOptions {
  /** The file to watch. */
  path: string;
  /** Poll interval while no filesystem watcher runs (ms). */
  pollMs?: number;
  /** Poll interval while a filesystem watcher runs (ms). */
  safetyPollMs?: number;
  /** Quiet time after a filesystem event before the check (ms). */
  debounceMs?: number;
  /** Gap between the two reads of one check (ms). */
  settleMs?: number;
  /** Set false to use polling only (tests, filesystems without events). */
  watch?: boolean;
}

/** Called with the new file text, or null when the file is gone. */
export type FileListener = (text: string | null) => void;

export interface FileSubscription {
  /** The text the watcher holds now (the baseline for the next change). */
  current: string | null;
  unsubscribe: () => void;
}

function readOrNull(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

/** Windows reports event paths with "\\", also under a "/" path we watch. */
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

function isDir(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class FileWatch {
  readonly path: string;
  readonly pollMs: number;
  readonly safetyPollMs: number;
  readonly debounceMs: number;
  readonly settleMs: number;
  readonly useWatch: boolean;

  #listeners = new Set<FileListener>();
  #last: string | null = null;
  #watcher: Deno.FsWatcher | null = null;
  #watchLoop: Promise<void> | null = null;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #checking: Promise<void> | null = null;
  #recheck = false;

  constructor(options: FileWatchOptions) {
    this.path = options.path;
    this.pollMs = options.pollMs ?? 500;
    this.safetyPollMs = options.safetyPollMs ?? 2000;
    this.debounceMs = options.debounceMs ?? 100;
    this.settleMs = options.settleMs ?? 40;
    this.useWatch = options.watch ?? true;
  }

  /** True while a filesystem watcher (not only polling) is active. */
  get watching(): boolean {
    return this.#watcher !== null;
  }

  /** Number of active subscribers. */
  get size(): number {
    return this.#listeners.size;
  }

  subscribe(listener: FileListener): FileSubscription {
    if (this.#listeners.size === 0) this.#start();
    this.#listeners.add(listener);
    return {
      current: this.#last,
      unsubscribe: () => {
        if (!this.#listeners.delete(listener)) return;
        if (this.#listeners.size === 0) this.#stop();
      },
    };
  }

  /** Resolve once the watcher loop and any running check have ended. */
  async idle(): Promise<void> {
    await this.#watchLoop;
    await this.#checking;
  }

  #start(): void {
    this.#last = readOrNull(this.path);
    this.#startWatcher();
    this.#schedulePoll();
  }

  #stop(): void {
    if (this.#pollTimer !== null) clearTimeout(this.#pollTimer);
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    this.#pollTimer = null;
    this.#debounceTimer = null;
    const watcher = this.#watcher;
    this.#watcher = null;
    if (watcher !== null) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    }
  }

  #startWatcher(): void {
    if (!this.useWatch || this.#watcher !== null) return;
    const dir = dirOf(this.path);
    if (!isDir(dir)) return; // The poll retries once the directory exists.
    let watcher: Deno.FsWatcher;
    try {
      watcher = Deno.watchFs(dir, { recursive: false });
    } catch {
      return; // No filesystem events here: polling alone carries the updates.
    }
    this.#watcher = watcher;
    const name = baseOf(this.path);
    this.#watchLoop = (async () => {
      try {
        for await (const event of watcher) {
          if (event.paths.some((p) => baseOf(p) === name)) this.#debounce();
        }
      } catch {
        // The watcher failed (directory removed, backend error): fall back.
      } finally {
        if (this.#watcher === watcher) {
          this.#watcher = null;
          if (this.#listeners.size > 0) this.#schedulePoll();
        }
      }
    })();
  }

  #debounce(): void {
    if (this.#listeners.size === 0) return;
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this.#check();
    }, this.debounceMs);
  }

  #schedulePoll(): void {
    if (this.#pollTimer !== null) clearTimeout(this.#pollTimer);
    const delay = this.#watcher !== null ? this.safetyPollMs : this.pollMs;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      if (this.#listeners.size === 0) return;
      this.#startWatcher();
      this.#check();
      this.#schedulePoll();
    }, delay);
  }

  #check(): void {
    if (this.#checking !== null) {
      this.#recheck = true;
      return;
    }
    this.#checking = (async () => {
      try {
        do {
          this.#recheck = false;
          const text = await this.#stableRead();
          if (this.#listeners.size === 0) return;
          if (text === this.#last) continue;
          this.#last = text;
          for (const listener of [...this.#listeners]) {
            try {
              listener(text);
            } catch {
              // One failing subscriber must not stop the others.
            }
          }
        } while (this.#recheck && this.#listeners.size > 0);
      } finally {
        this.#checking = null;
      }
    })();
  }

  /** Read until two reads `settleMs` apart agree (at most a few tries). */
  async #stableRead(): Promise<string | null> {
    let text = readOrNull(this.path);
    for (let i = 0; i < 5; i++) {
      await sleep(this.settleMs);
      const again = readOrNull(this.path);
      if (again === text) return text;
      text = again;
    }
    return text;
  }
}
