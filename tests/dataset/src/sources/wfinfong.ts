/**
 * The test screenshot of knoellle/wfinfo-ng (GPL-3.0). The file is in Git LFS:
 * the repository holds a pointer with its size and SHA-256, which the download
 * must match.
 */

import { DatasetError, describeError } from "../errors.ts";
import { analyze, storeHit } from "../ingest.ts";
import type { PoliteClient } from "../net.ts";
import { sha256Hex } from "../store.ts";
import { makeTempFolder, removeTempFolder } from "../temp.ts";
import { type CollectContext, countStored, newReport } from "./collect.ts";
import type { RunReport } from "./collect.ts";

export const REPOSITORY = "knoellle/wfinfo-ng";
export const DEFAULT_PATH = "test-images/1.png";
export const HOSTS = [
  "api.github.com",
  "raw.githubusercontent.com",
  "media.githubusercontent.com",
];

const MAX_IMAGE_BYTES = 40_000_000;

export function parseLfsPointer(
  text: string,
): { sha256: string; size: number } | null {
  if (!text.startsWith("version https://git-lfs.github.com/spec/")) return null;
  const sha256 = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = Number(/^size (\d+)$/m.exec(text)?.[1] ?? NaN);
  return sha256 && Number.isFinite(size) ? { sha256, size } : null;
}

export interface RepositoryFile {
  commit: string;
  committedAt: string | null;
  author: string;
  license: string | null;
}

export function parseRepositoryFile(
  repository: unknown,
  commits: unknown,
): RepositoryFile {
  const license = (repository as { license?: { spdx_id?: unknown } })
    ?.license?.spdx_id;
  const first = (Array.isArray(commits) ? commits[0] : undefined) as {
    sha?: unknown;
    commit?: { author?: { date?: unknown } };
    author?: { login?: unknown };
  } | undefined;
  const sha = first?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new DatasetError("DST-013", "GitHub listed no commit for the file");
  }
  const date = first?.commit?.author?.date;
  const login = first?.author?.login;
  return {
    commit: sha,
    committedAt: typeof date === "string" ? date : null,
    author: typeof login === "string" ? login : REPOSITORY.split("/")[0],
    license: typeof license === "string" && license !== "NOASSERTION"
      ? license
      : null,
  };
}

export async function collectWfinfoNg(
  context: CollectContext,
  client: PoliteClient,
  path = DEFAULT_PATH,
): Promise<RunReport> {
  if (!/^[A-Za-z0-9_./-]+\.(png|jpg)$/.test(path) || path.includes("..")) {
    throw new DatasetError("DST-001", `not an image path: ${path}`);
  }
  const report = newReport();
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  const file = parseRepositoryFile(
    await client.getJson(api),
    await client.getJson(`${api}/commits?path=${path}&per_page=1`),
  );
  const key = `${path}@${file.commit}`;
  if (context.store.outcome("wfinfo-ng", key)) {
    report.items.push({ item: key, outcome: "skipped" });
    return report;
  }

  const folder = await makeTempFolder("wfinfo-ng");
  try {
    const at = `${file.commit}/${path}`;
    let bytes = await client.get(
      `https://raw.githubusercontent.com/${REPOSITORY}/${at}`,
      MAX_IMAGE_BYTES,
    );
    const pointer = parseLfsPointer(
      new TextDecoder().decode(bytes.subarray(0, 512)),
    );
    if (pointer) {
      bytes = await client.get(
        `https://media.githubusercontent.com/media/${REPOSITORY}/${at}`,
        MAX_IMAGE_BYTES,
      );
      if (
        bytes.length !== pointer.size ||
        await sha256Hex(bytes) !== pointer.sha256
      ) {
        throw new DatasetError("DST-014", path);
      }
    }
    report.downloads++;
    const local = `${folder}/candidate.png`;
    await Deno.writeFile(local, bytes);

    let outcome = "no-reward-screen";
    try {
      const hit = await analyze(
        local,
        0,
        context.scanners[0],
        context.constants,
      );
      report.scanned++;
      if (hit) {
        report.rewardScreens++;
        outcome = countStored(
          report,
          await storeHit(context, hit, {
            kind: "wfinfo-ng",
            url: `https://github.com/${REPOSITORY}/blob/${at}`,
            itemId: file.commit,
            title: path,
            author: file.author,
            authorUrl: `https://github.com/${file.author}`,
            publishedAt: file.committedAt,
            timestampSeconds: null,
            license: file.license,
            downloadedAt: new Date().toISOString(),
            detail: { repository: REPOSITORY },
          }, { lossySource: false }),
        );
      }
      await context.store.remember("wfinfo-ng", key, outcome);
    } catch (error) {
      if (!(error instanceof DatasetError)) throw error;
      report.errors++;
      context.log(describeError(error));
      outcome = error.code;
    }
    report.items.push({ item: key, outcome });
    context.log(`${path}: ${outcome}`);
  } finally {
    await removeTempFolder(folder);
    report.downloadedBytes = client.received;
  }
  return report;
}
