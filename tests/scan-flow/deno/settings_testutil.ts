/**
 * Shared helpers for the settings tests: a temporary app dir that is never the
 * user's real WFInfo app dir. The guard fails loudly instead of touching the
 * real wfinfo-ext-settings.json.
 */
import { resolveAppDir } from "../../../dashboard/src/lib/fsdata.ts";

/** The real app dirs of this user: the resolved one and both OS defaults. */
function realAppDirs(): string[] {
  const env = Deno.env.toObject();
  const home = env.HOME ?? "";
  return [
    resolveAppDir(env),
    `${home}/Library/Application Support/WFInfo`,
    `${home}/.config/WFInfo`,
  ].filter((dir) => dir.length > 0).map(normalize);
}

const normalize = (dir: string): string => dir.replace(/\/+$/, "");

/** Throw when `appDir` is a real WFInfo app dir of this user. */
export function guardNotRealAppDir(appDir: string, real = realAppDirs()): void {
  const dir = normalize(appDir);
  if (real.includes(dir)) {
    throw new Error(`Refusing to run: ${appDir} is the real WFInfo app dir.`);
  }
}

/** Make a temporary app dir, run `fn` with it, then delete it. */
export async function withTempAppDir(
  fn: (appDir: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "wfinfo_ext_settings_" });
  const appDir = `${root}/WFInfo`;
  guardNotRealAppDir(appDir);
  try {
    await fn(appDir);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** The file names in `dir` (empty when it does not exist). */
export async function listNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export const loopback: Deno.ServeHandlerInfo = {
  remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 50000 },
  completed: Promise.resolve(),
};

export const otherHost: Deno.ServeHandlerInfo = {
  remoteAddr: { transport: "tcp", hostname: "192.168.1.50", port: 50000 },
  completed: Promise.resolve(),
};
