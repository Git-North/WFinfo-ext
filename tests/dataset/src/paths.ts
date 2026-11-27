/**
 * Where things are: the repository, the dataset folder, the WFInfo app data
 * folder. Also the guard that keeps dataset files out of git.
 */

import { resolveAppDir } from "../../../dashboard/src/lib/fsdata.ts";
import { DatasetError } from "./errors.ts";

// A URL path is percent-encoded: a folder with a space would not be found.
export const REPO_ROOT = decodeURIComponent(
  new URL("../../../", import.meta.url).pathname,
).replace(/\/$/, "");

export function defaultAppDir(): string {
  return resolveAppDir(Deno.env.toObject());
}

/** Absolute, normalised form of a path that may not exist yet. */
export function absolutePath(path: string, cwd = Deno.cwd()): string {
  const joined = path.startsWith("/") ? path : `${cwd}/${path}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

async function nearestExisting(path: string): Promise<string> {
  let current = path;
  while (current !== "/") {
    try {
      if ((await Deno.stat(current)).isDirectory) return current;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    current = current.slice(0, current.lastIndexOf("/")) || "/";
  }
  return current;
}

async function git(
  folder: string,
  args: string[],
): Promise<{ code: number; out: string }> {
  try {
    const result = await new Deno.Command("git", {
      args: ["-C", folder, ...args],
      stdout: "piped",
      stderr: "null",
    }).output();
    return {
      code: result.code,
      out: new TextDecoder().decode(result.stdout).trim(),
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new DatasetError("DST-002", "git is not on PATH");
    }
    throw error;
  }
}

/**
 * Refuses a dataset folder whose files git could pick up. Inside any git work
 * tree, every kind of file the tools write must be ignored there; in this
 * repository the folder must also be `training/` or below it.
 */
export async function assertSafeOutput(
  folder: string,
  repoRoot = REPO_ROOT,
): Promise<void> {
  const existing = await nearestExisting(folder);
  const real = await Deno.realPath(existing) + folder.slice(existing.length);
  const repo = await Deno.realPath(repoRoot);
  const training = `${repo}/training`;
  if (
    (real === repo || real.startsWith(`${repo}/`)) &&
    real !== training && !real.startsWith(`${training}/`)
  ) {
    throw new DatasetError("DST-008", `${folder} is in the repository`);
  }

  const inside = await git(existing, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out !== "true") return;
  for (
    const probe of [
      "images/youtube/probe.png",
      "images/reddit/probe.jpg",
      "images/own/probe.json",
      "records/own/probe.json",
      "index.csv",
      "index.json",
      "seen.json",
    ]
  ) {
    const ignored = await git(existing, [
      "check-ignore",
      "-q",
      "--no-index",
      `${folder}/${probe}`,
    ]);
    if (ignored.code !== 0) {
      throw new DatasetError(
        "DST-008",
        `git does not ignore ${folder}/${probe}`,
      );
    }
  }
}
