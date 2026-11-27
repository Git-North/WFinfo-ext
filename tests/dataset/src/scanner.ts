/**
 * Runs the real headless scanner on candidate images, inside a throw-away app
 * data folder. The runner is not changed.
 *
 * A normal `--scan` writes scans/ (60 records kept) and may fetch prices, so
 * candidates must never run against the user's own folder: that would replace
 * their scan history. Each sandbox is its own HOME with copies of the market
 * databases and a price cache that already holds every slug, so the runner
 * also sends no price request.
 */

import {
  parseScanResult,
  type ScanResult,
} from "../../../dashboard/src/lib/scan.ts";
import { DatasetError } from "./errors.ts";
import { run } from "./media.ts";
import { REPO_ROOT } from "./paths.ts";
import { makeTempFolder, removeTempFolder } from "./temp.ts";

const DLL = "WFInfo.Headless.dll";

export async function findRunner(
  explicit: string | undefined,
  repoRoot = REPO_ROOT,
): Promise<string> {
  const candidates = explicit
    ? [explicit]
    : ["Release", "Debug"].map((c) =>
      `${repoRoot}/headless/bin/${c}/net9.0/${DLL}`
    );
  let newest: string | null = null;
  let newestTime = -1;
  for (const path of candidates) {
    try {
      const time = (await Deno.stat(path)).mtime?.getTime() ?? 0;
      if (time > newestTime) [newest, newestTime] = [path, time];
    } catch {
      // not built
    }
  }
  if (newest === null) throw new DatasetError("DST-003", candidates.join(", "));
  return newest;
}

/** A price cache in which every slug is fresh. */
export function seededPriceCache(marketItems: string, now: Date): string {
  const fetchedAt = now.toISOString();
  const prices: Record<string, unknown> = {};
  for (const value of Object.values(JSON.parse(marketItems))) {
    const slug = String(value).split("|")[1];
    if (slug) prices[slug] = { plat: 0, volume: 0, fetchedAt };
  }
  return JSON.stringify({ version: 1, updated: fetchedAt, prices });
}

/** The runner's environment: every app-data root points into the sandbox. */
export function sandboxEnv(
  base: Record<string, string>,
  root: string,
): Record<string, string> {
  const env: Record<string, string> = {
    ...base,
    HOME: root,
    CFFIXED_USER_HOME: root,
    XDG_CONFIG_HOME: `${root}/.config`,
    WFINFO_DATA_DIR: `${root}/.config`,
    DOTNET_CLI_HOME: root,
  };
  delete env.WFINFO_EE_LOG;
  delete env.APPDATA;
  return env;
}

export interface Scanned {
  record: ScanResult;
  /** Time the whole runner process took. */
  wallMs: number;
}

export interface Scanner {
  scan(image: string): Promise<Scanned>;
  dispose(): Promise<void>;
}

const DATABASES = ["market_items.json", "market_data.json", "name_data.json"];

export async function createSandboxScanner(options: {
  runner: string;
  databases: string;
}): Promise<Scanner> {
  const root = await makeTempFolder("scanner");
  const env = sandboxEnv(Deno.env.toObject(), root);
  const appDir = Deno.build.os === "darwin"
    ? `${root}/Library/Application Support/WFInfo`
    : `${root}/.config/WFInfo`;
  try {
    await Deno.mkdir(appDir, { recursive: true });
    for (const name of DATABASES) {
      try {
        await Deno.copyFile(
          `${options.databases}/${name}`,
          `${appDir}/${name}`,
        );
      } catch {
        throw new DatasetError("DST-004", `${options.databases}/${name}`);
      }
    }
    await Deno.writeTextFile(
      `${appDir}/price_cache.json`,
      seededPriceCache(
        await Deno.readTextFile(`${appDir}/market_items.json`),
        new Date(),
      ),
    );
    // Tesseract (Linux) reads its language data from here; without a link it
    // would download it into every sandbox.
    try {
      await Deno.stat(`${options.databases}/tessdata`);
      await Deno.symlink(
        await Deno.realPath(`${options.databases}/tessdata`),
        `${appDir}/tessdata`,
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  } catch (error) {
    await removeTempFolder(root);
    throw error;
  }

  const latest = `${appDir}/scans/latest.json`;
  return {
    async scan(image: string): Promise<Scanned> {
      await Deno.remove(latest).catch(() => {});
      const started = performance.now();
      const result = await run("dotnet", [
        options.runner,
        "--scan",
        "--no-notify",
        "--file",
        image,
        "--ui-scale",
        "unknown",
        "--ttl",
        "100000",
      ], { env, clearEnv: true, timeoutMs: 180_000 });
      let record: ScanResult | null = null;
      try {
        record = parseScanResult(JSON.parse(await Deno.readTextFile(latest)));
      } catch {
        // no record: reported below
      }
      if (record === null || record.error !== null) {
        const why = record?.error ?? result.stderr.trim().split("\n").at(-1);
        throw new DatasetError("DST-005", `exit ${result.code}: ${why ?? ""}`);
      }
      return { record, wallMs: Math.round(performance.now() - started) };
    },
    dispose: () => removeTempFolder(root),
  };
}

/**
 * Applies `work` to every item with one scanner per lane, so two runs never
 * share a sandbox. Results keep the order of the items.
 */
export async function mapWithScanners<T, R>(
  scanners: Scanner[],
  items: T[],
  work: (item: T, scanner: Scanner, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(scanners.map(async (scanner) => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], scanner, index);
    }
  }));
  return results;
}
