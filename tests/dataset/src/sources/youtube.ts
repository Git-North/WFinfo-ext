/**
 * Reward-screen frames from relic videos: yt-dlp downloads a video into a
 * temporary folder, ffmpeg samples frames, the scanner keeps those with 1-4
 * reward names, one per reward screen, and the video is deleted.
 *
 * yt-dlp runs without any configuration file and without cookies. A sign-in or
 * bot check is a refusal (DST-009), not something to get round.
 */

import { DatasetError, describeError } from "../errors.ts";
import { type Analysis, analyze, storeHit } from "../ingest.ts";
import { run, sampleFrames } from "../media.ts";
import { mapWithScanners } from "../scanner.ts";
import { groupRewardScreens, selectFrames } from "../selection.ts";
import { makeTempFolder, removeTempFolder } from "../temp.ts";
import { type CollectContext, countStored, newReport } from "./collect.ts";
import type { RunReport } from "./collect.ts";

const BASE_ARGS = ["--ignore-config", "--no-warnings", "--no-playlist"];
const ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com"];

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** The video id of a YouTube address or a bare id. */
export function videoId(input: string): string {
  if (ID.test(input)) return input;
  let url: URL | null = null;
  try {
    url = new URL(input);
  } catch {
    // reported below
  }
  let id: string | null = null;
  if (url?.protocol === "https:" && url.hostname === "youtu.be") {
    id = url.pathname.slice(1);
  } else if (url?.protocol === "https:" && WATCH_HOSTS.includes(url.hostname)) {
    id = url.searchParams.get("v") ??
      /^\/(?:shorts|live)\/([^/]+)/.exec(url.pathname)?.[1] ?? null;
  }
  if (id !== null && ID.test(id)) return id;
  throw new DatasetError("DST-001", `not a YouTube video: ${input}`);
}

export interface VideoMeta {
  id: string;
  title: string | null;
  author: string | null;
  authorUrl: string | null;
  publishedAt: string | null;
  /** As yt-dlp reports it: set for Creative Commons uploads, else null. */
  license: string | null;
  durationSeconds: number | null;
  live: boolean;
}

export function parseVideoMeta(json: unknown): VideoMeta {
  const o = (json ?? {}) as Record<string, unknown>;
  const text = (key: string) =>
    typeof o[key] === "string" && o[key] !== "" ? o[key] as string : null;
  const id = text("id");
  if (!id || !ID.test(id)) {
    throw new DatasetError("DST-013", "yt-dlp gave no video id");
  }
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(text("upload_date") ?? "");
  return {
    id,
    title: text("title"),
    author: text("uploader") ?? text("channel"),
    authorUrl: text("channel_url") ?? text("uploader_url"),
    publishedAt: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
    license: text("license"),
    durationSeconds: typeof o.duration === "number" ? o.duration : null,
    live: o.is_live === true || o.live_status === "is_upcoming",
  };
}

export function parseSearch(json: unknown): string[] {
  const entries = (json as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) {
    throw new DatasetError("DST-013", "yt-dlp gave no search results");
  }
  return entries.map((e) => String((e as { id?: unknown }).id ?? ""))
    .filter((id) => ID.test(id));
}

/** DST-009 when YouTube asks for a sign-in or suspects a bot, else DST-017. */
export function ytdlpError(stderr: string): DatasetError {
  const line = stderr.split("\n").filter((l) => l.startsWith("ERROR")).at(-1) ??
    stderr.trim().split("\n").at(-1) ?? "";
  return new DatasetError(
    /sign in|not a bot|captcha|HTTP Error 403|HTTP Error 429/i.test(line)
      ? "DST-009"
      : "DST-017",
    line.slice(0, 300),
  );
}

async function ytdlp(args: string[], timeoutMs: number): Promise<string> {
  const result = await run("yt-dlp", [...BASE_ARGS, ...args], { timeoutMs });
  if (result.code !== 0) throw ytdlpError(result.stderr);
  return new TextDecoder().decode(result.stdout);
}

export async function searchVideos(
  query: string,
  count: number,
): Promise<string[]> {
  return parseSearch(JSON.parse(
    await ytdlp(
      ["--flat-playlist", "-J", `ytsearch${count}:${query}`],
      120_000,
    ),
  ));
}

export async function videoMeta(id: string): Promise<VideoMeta> {
  return parseVideoMeta(
    JSON.parse(await ytdlp(["-J", "--", watchUrl(id)], 120_000)),
  );
}

export interface VideoFile {
  path: string;
  formatId: string;
  width: number;
  height: number;
  codec: string;
  bytes: number;
}

async function downloadVideo(
  id: string,
  folder: string,
  maxHeight: number,
  maxMegabytes: number,
): Promise<VideoFile> {
  const out = await ytdlp([
    "-f",
    `bv*[height<=${maxHeight}]/b[height<=${maxHeight}]`,
    "--max-filesize",
    `${maxMegabytes}M`,
    "-o",
    `${folder}/video.%(ext)s`,
    "--no-simulate",
    "--print",
    "after_move:%(format_id)s\t%(width)s\t%(height)s\t%(vcodec)s\t%(filepath)s",
    "--",
    watchUrl(id),
  ], 30 * 60_000);
  const [formatId, width, height, codec, path] = out.trim().split("\n").at(-1)
    ?.split("\t") ?? [];
  if (!path) {
    throw new DatasetError(
      "DST-012",
      `${id}: larger than ${maxMegabytes} MB, or no format`,
    );
  }
  return {
    path,
    formatId,
    width: Number(width),
    height: Number(height),
    codec,
    bytes: (await Deno.stat(path)).size,
  };
}

export interface YoutubeOptions {
  videos: string[];
  /** Seconds between sampled frames. A reward screen stays about 15 s. */
  interval: number;
  maxHeight: number;
  maxDurationSeconds: number;
  maxMegabytes: number;
}

export async function collectYoutube(
  context: CollectContext,
  options: YoutubeOptions,
): Promise<RunReport> {
  const report = newReport();
  for (const id of options.videos) {
    let outcome: string;
    let detail: string | undefined;
    try {
      ({ outcome, detail } = await collectVideo(context, id, options, report));
    } catch (error) {
      if (
        !(error instanceof DatasetError) ||
        ["DST-002", "DST-009"].includes(error.code)
      ) {
        throw error;
      }
      report.errors++;
      context.log(describeError(error));
      outcome = error.code;
      detail = error.detail;
    }
    report.items.push({ item: id, outcome, detail });
    context.log(`youtube ${id}: ${outcome}${detail ? ` (${detail})` : ""}`);
  }
  return report;
}

async function collectVideo(
  context: CollectContext,
  id: string,
  options: YoutubeOptions,
  report: RunReport,
): Promise<{ outcome: string; detail?: string }> {
  if (context.store.outcome("youtube", id)) {
    return { outcome: "skipped", detail: "handled in an earlier run" };
  }
  const meta = await videoMeta(id);
  const duration = meta.durationSeconds;
  if (meta.live || duration === null || duration > options.maxDurationSeconds) {
    return {
      outcome: "skipped",
      detail: `live, or longer than ${options.maxDurationSeconds} s`,
    };
  }

  const folder = await makeTempFolder("youtube");
  try {
    const video = await downloadVideo(
      id,
      folder,
      options.maxHeight,
      options.maxMegabytes,
    );
    report.downloads++;
    report.downloadedBytes += video.bytes;
    await Deno.mkdir(`${folder}/frames`);
    const frames = await sampleFrames(
      video.path,
      `${folder}/frames`,
      options.interval,
    );
    await Deno.remove(video.path);

    let failed = 0;
    const analyses = await mapWithScanners(
      context.scanners,
      frames,
      async (frame, scanner): Promise<Analysis | null> => {
        try {
          const hit = await analyze(
            frame.path,
            frame.seconds,
            scanner,
            context.constants,
          );
          // Only frames that can be kept need to stay on disk.
          if (!hit) await Deno.remove(frame.path);
          return hit;
        } catch (error) {
          if (!(error instanceof DatasetError) || error.code === "DST-002") {
            throw error;
          }
          if (failed++ === 0) context.log(describeError(error));
          return null;
        }
      },
    );
    report.scanned += frames.length - failed;
    report.errors += failed;
    if (frames.length > 0 && failed === frames.length) {
      throw new DatasetError("DST-005", `every frame of ${id} failed`);
    }

    const hits = analyses.filter((a): a is Analysis => a !== null);
    report.rewardScreens += hits.length;
    const maxGap = options.interval * 2.5;
    const chosen = selectFrames(hits, maxGap);
    let stored = 0;
    for (const hit of chosen) {
      const outcome = await storeHit(context, hit, {
        kind: "youtube",
        url: `${watchUrl(id)}&t=${Math.floor(hit.seconds)}s`,
        itemId: id,
        title: meta.title,
        author: meta.author,
        authorUrl: meta.authorUrl,
        publishedAt: meta.publishedAt,
        timestampSeconds: Math.round(hit.seconds * 10) / 10,
        license: meta.license,
        downloadedAt: new Date().toISOString(),
        detail: {
          videoFormat: video.formatId,
          videoCodec: video.codec,
          videoWidth: video.width,
          videoHeight: video.height,
          videoSeconds: duration,
        },
      }, { lossySource: true, sourceCodec: video.codec });
      if (outcome.stored) stored++;
      countStored(report, outcome);
    }
    await context.store.remember("youtube", id, `stored ${stored}`);
    return {
      outcome: stored > 0 ? "stored" : "no-reward-screen",
      detail: `${video.width}x${video.height} ${video.codec}, ` +
        `${(video.bytes / 1e6).toFixed(0)} MB, ${frames.length} frames, ` +
        `${hits.length} with reward names, ` +
        `${groupRewardScreens(hits, maxGap).length} screens, ${stored} stored`,
    };
  } finally {
    await removeTempFolder(folder);
  }
}
