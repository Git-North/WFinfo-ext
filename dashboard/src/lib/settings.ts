/**
 * WFInfo-ext settings: `<app dir>/wfinfo-ext-settings.json`,
 * `{"version":1,"notifications":false,"overlayPin":false}`.
 *
 * The dashboard is the only writer, and this module is its only write path:
 * a temporary file in the same folder, then a rename, so a reader never sees
 * half a file. The headless runner only reads the file
 * (`headless/Scan/ExtSettings.cs`), at each scan start and each EE.log
 * trigger, so a change applies without a restart.
 *
 * Read rules (the same in ExtSettings.cs): a missing file means the defaults
 * (every switch off) with no warning. A file that cannot be read, is not a
 * JSON object, has a version other than 1, or has a switch that is not
 * true/false means the defaults plus SET-001. Unknown keys are ignored; a
 * missing switch is off.
 */

import { remoteClient } from "./targets.ts";

export const SETTINGS_FILE = "wfinfo-ext-settings.json";
export const SETTINGS_VERSION = 1;
/** errors/catalog.json: the settings file could not be read (warning). */
export const SETTINGS_UNREADABLE = "SET-001";
/** errors/catalog.json: the dashboard could not write the settings file. */
export const SETTINGS_NOT_SAVED = "SET-002";

/** The switches, in the order the page shows them. */
export const SWITCH_KEYS = ["notifications", "overlayPin"] as const;
export type SwitchKey = typeof SWITCH_KEYS[number];

export interface ExtSettings {
  version: 1;
  /** Desktop notifications for EE.log-triggered scans. */
  notifications: boolean;
  /** Pin the overlay after a scan with names. */
  overlayPin: boolean;
}

export const DEFAULT_SETTINGS: Readonly<ExtSettings> = Object.freeze({
  version: 1,
  notifications: false,
  overlayPin: false,
});

/** What a read found: the settings to use, and a warning code when the file was not usable. */
export interface SettingsRead {
  settings: ExtSettings;
  /** `SET-001` when the file exists but could not be used, else null. */
  warning: string | null;
  /** A few words on why (never a path or the file text), else null. */
  detail: string | null;
}

/** Largest settings file or request body read, in bytes. */
const MAX_BYTES = 16 * 1024;

export function settingsPath(appDir: string): string {
  return `${appDir}/${SETTINGS_FILE}`;
}

const defaults = (): ExtSettings => ({ ...DEFAULT_SETTINGS });

const unreadable = (detail: string): SettingsRead => ({
  settings: defaults(),
  warning: SETTINGS_UNREADABLE,
  detail,
});

/** Parse the file text with the shared read rules. Never throws. */
export function parseSettings(text: string): SettingsRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unreadable("the file is not valid JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return unreadable("the file is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if ("version" in obj && obj.version !== SETTINGS_VERSION) {
    return unreadable(`the file version is not ${SETTINGS_VERSION}`);
  }
  const settings = defaults();
  for (const key of SWITCH_KEYS) {
    if (!(key in obj)) continue;
    const value = obj[key];
    if (typeof value !== "boolean") {
      return unreadable("a switch is not true or false");
    }
    settings[key] = value;
  }
  return { settings, warning: null, detail: null };
}

/** Read `<appDir>/wfinfo-ext-settings.json`. Never throws. */
export async function readSettings(appDir: string): Promise<SettingsRead> {
  const path = settingsPath(appDir);
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) return unreadable("the settings path is not a file");
    if (stat.size > MAX_BYTES) return unreadable("the file is too large");
    return parseSettings(await Deno.readTextFile(path));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { settings: defaults(), warning: null, detail: null };
    }
    return unreadable(
      `the file could not be read (${
        err instanceof Error ? err.name : "unknown error"
      })`,
    );
  }
}

/** The exact file text: one line of JSON with the version first. */
export function serializeSettings(settings: ExtSettings): string {
  return `${
    JSON.stringify({
      version: SETTINGS_VERSION,
      notifications: settings.notifications,
      overlayPin: settings.overlayPin,
    })
  }\n`;
}

/**
 * Write the file atomically: a temporary file next to it, then a rename over
 * it. On failure the temporary file is removed and the error is thrown.
 */
export async function writeSettings(
  appDir: string,
  settings: ExtSettings,
): Promise<void> {
  const path = settingsPath(appDir);
  const tmp = `${path}.${Deno.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    await Deno.mkdir(appDir, { recursive: true });
    await Deno.writeTextFile(tmp, serializeSettings(settings));
    await Deno.rename(tmp, path);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
}

/** One read-change-write at a time in this process, so no change is lost. */
let pending: Promise<unknown> = Promise.resolve();

/**
 * Apply `patch` to the current settings and write the result. An unreadable
 * file counts as the defaults, so a change also repairs a broken file.
 */
export function updateSettings(
  appDir: string,
  patch: Partial<Record<SwitchKey, boolean>>,
): Promise<ExtSettings> {
  const run = pending.then(async () => {
    const { settings } = await readSettings(appDir);
    for (const key of SWITCH_KEYS) {
      const value = patch[key];
      if (typeof value === "boolean") settings[key] = value;
    }
    await writeSettings(appDir, settings);
    return settings;
  });
  pending = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------------ */
/* Routes: GET /api/settings, POST /settings                           */
/* ------------------------------------------------------------------ */

export interface SettingsRouteOptions {
  appDir: string;
  /** The client's address (`Deno.ServeHandlerInfo.remoteAddr`). */
  remoteAddr?: Deno.Addr;
  /** WFINFO_SCAN_REMOTE: accept other hosts. */
  allowRemote: boolean;
  /** The HTML failure page for a form post (view.ts `errorPageHtml`). */
  errorPage: (message: string) => string;
}

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

/** GET /api/settings: the settings in use, and the read warning (or null). */
export async function apiSettings(appDir: string): Promise<Response> {
  const read = await readSettings(appDir);
  return jsonResponse({ ...read.settings, warning: read.warning });
}

/** A same-origin request has no Origin header (curl) or one that names this host. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

type Patch = Partial<Record<SwitchKey, boolean>>;
type PatchResult = { ok: true; patch: Patch } | { ok: false; error: string };

const ON_VALUES = new Set(["on", "true", "1", "yes"]);

/**
 * The change a request asks for. A form post sets every switch: a checked box
 * is sent ("on"), an unchecked one is not sent, so it is off. A JSON body
 * sets only the switches it names: `{"notifications": true}`.
 */
export async function readPatch(req: Request): Promise<PatchResult> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  const text = await req.text();
  if (text.length > MAX_BYTES) {
    return { ok: false, error: "The request body is too large." };
  }

  if (type.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(text);
    const patch: Patch = {};
    for (const key of SWITCH_KEYS) {
      patch[key] = ON_VALUES.has((form.get(key) ?? "").trim().toLowerCase());
    }
    return { ok: true, patch };
  }

  if (type.includes("application/json")) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: "The request body is not valid JSON." };
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, error: "The request body is not a JSON object." };
    }
    const patch: Patch = {};
    for (const [key, value] of Object.entries(body)) {
      if (!(SWITCH_KEYS as readonly string[]).includes(key)) {
        return {
          ok: false,
          error: `Unknown setting "${key}". Known settings: ${
            SWITCH_KEYS.join(", ")
          }.`,
        };
      }
      if (typeof value !== "boolean") {
        return {
          ok: false,
          error: `The setting "${key}" must be true or false.`,
        };
      }
      patch[key as SwitchKey] = value;
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: "The request names no setting." };
    }
    return { ok: true, patch };
  }

  return {
    ok: false,
    error: "Send a form post or a JSON body (Content-Type application/json).",
  };
}

const wantsJson = (req: Request): boolean =>
  (req.headers.get("accept") ?? "").includes("application/json");

/**
 * POST /settings: change one or more switches. The dashboard has no
 * authentication, so the route follows POST /scan/run: same origin only, and
 * only from this host unless WFINFO_SCAN_REMOTE is set. A form post is
 * redirected back to /scan; a request that accepts JSON gets JSON.
 */
export async function settingsRoute(
  req: Request,
  opts: SettingsRouteOptions,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  const json = wantsJson(req);
  const fail = (message: string, status: number): Response =>
    json
      ? jsonResponse({ ok: false, error: message }, status)
      : new Response(opts.errorPage(message), {
        status,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });

  if (!sameOrigin(req)) {
    return fail("This request did not come from the dashboard page.", 403);
  }
  const remote = remoteClient(opts.remoteAddr, opts.allowRemote);
  if (remote !== null) {
    return fail(
      `Settings change what the machine that hosts the dashboard does, and ${remote} is another host. Set WFINFO_SCAN_REMOTE=1 to accept changes from other hosts.`,
      403,
    );
  }

  const parsed = await readPatch(req);
  if (!parsed.ok) return fail(parsed.error, 400);

  let settings: ExtSettings;
  try {
    settings = await updateSettings(opts.appDir, parsed.patch);
  } catch (err) {
    const reason = err instanceof Error ? err.name : "unknown error";
    console.error(`${SETTINGS_NOT_SAVED}: settings not saved (${reason})`);
    const message =
      `${SETTINGS_NOT_SAVED} Seal: the settings were not saved (${reason}). Check the permissions of the WFInfo app data folder.`;
    return json
      ? jsonResponse(
        { ok: false, code: SETTINGS_NOT_SAVED, error: message },
        500,
      )
      : fail(message, 500);
  }

  if (!json) {
    return new Response(null, { status: 303, headers: { location: "/scan" } });
  }
  return jsonResponse({
    ok: true,
    settings,
    message: `Saved. Notify on automatic scans: ${
      settings.notifications ? "on" : "off"
    }. Pin the overlay after a scan: ${settings.overlayPin ? "on" : "off"}.`,
  });
}
