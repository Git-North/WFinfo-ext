/**
 * Images of public Reddit posts, found with the public search JSON. Reddit's
 * robots.txt disallows automated clients and Reddit often answers 403; the run
 * then stops (DST-009). Do not work around that: no browser User-Agent, no
 * cookies, no other route.
 */

import { DatasetError, describeError } from "../errors.ts";
import { analyze, storeHit } from "../ingest.ts";
import type { PoliteClient } from "../net.ts";
import { makeTempFolder, removeTempFolder } from "../temp.ts";
import { type CollectContext, countStored, newReport } from "./collect.ts";
import type { RunReport } from "./collect.ts";

export const HOSTS = ["www.reddit.com", "i.redd.it", "i.imgur.com"];
/** Reddit allows about ten anonymous requests a minute. */
export const PAUSE_MS = 7000;

export const DEFAULT_SUBREDDITS = ["Warframe"];
export const DEFAULT_QUERIES = [
  "relic reward",
  "void fissure rewards",
  "relic opening",
];

const MAX_IMAGE_BYTES = 25_000_000;

export interface RedditImage {
  postId: string;
  /** Position in a gallery, from 0. */
  position: number;
  url: string;
  permalink: string;
  title: string;
  author: string;
  subreddit: string;
  publishedAt: string | null;
}

export function searchUrl(
  subreddit: string,
  query: string,
  after: string | null,
): string {
  if (!/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) {
    throw new DatasetError("DST-001", `not a subreddit name: ${subreddit}`);
  }
  const params = new URLSearchParams({
    q: query,
    restrict_sr: "1",
    type: "link",
    sort: "relevance",
    limit: "100",
    raw_json: "1",
  });
  if (after) params.set("after", after);
  return `https://www.reddit.com/r/${subreddit}/search.json?${params}`;
}

type Json = Record<string, unknown>;
const object = (v: unknown): Json =>
  typeof v === "object" && v !== null ? v as Json : {};

const DIRECT =
  /^https:\/\/(?:i\.redd\.it|i\.imgur\.com)\/[\w-]+\.(?:png|jpe?g|webp)$/i;
const MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpg": "jpg",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** The still images of one listing page, and the cursor of the next. */
export function parseListing(
  json: unknown,
): { images: RedditImage[]; after: string | null } {
  const data = object(object(json).data);
  if (!Array.isArray(data.children)) {
    throw new DatasetError("DST-013", "not a Reddit listing");
  }
  const images: RedditImage[] = [];
  for (const child of data.children) {
    const post = object(object(child).data);
    const id = String(post.id ?? "");
    if (!/^[a-z0-9]{3,12}$/.test(id) || post.over_18 === true) continue;
    const base = {
      postId: id,
      permalink: `https://www.reddit.com${String(post.permalink ?? "")}`,
      title: String(post.title ?? ""),
      author: String(post.author ?? "[unknown]"),
      subreddit: String(post.subreddit ?? ""),
      publishedAt: typeof post.created_utc === "number"
        ? new Date(post.created_utc * 1000).toISOString()
        : null,
    };
    const urls: string[] = [];
    if (DIRECT.test(String(post.url ?? ""))) urls.push(String(post.url));
    const media = object(post.media_metadata);
    const order = object(post.gallery_data).items;
    for (const item of Array.isArray(order) ? order : []) {
      const key = String(object(item).media_id ?? "");
      const info = object(media[key]);
      const extension = MIME[String(info.m ?? "")];
      if (/^\w+$/.test(key) && info.status === "valid" && extension) {
        urls.push(`https://i.redd.it/${key}.${extension}`);
      }
    }
    urls.forEach((url, position) => images.push({ ...base, url, position }));
  }
  return {
    images,
    after: typeof data.after === "string" ? data.after : null,
  };
}

export interface RedditOptions {
  subreddits: string[];
  queries: string[];
  /** Images downloaded at most, kept or not. */
  limit: number;
}

export async function collectReddit(
  context: CollectContext,
  client: PoliteClient,
  options: RedditOptions,
): Promise<RunReport> {
  const report = newReport();
  const folder = await makeTempFolder("reddit");
  const listed = new Set<string>();
  try {
    for (const subreddit of options.subreddits) {
      for (const query of options.queries) {
        let after: string | null = null;
        for (let page = 0; page < 5; page++) {
          if (report.downloads >= options.limit) return report;
          const listing = parseListing(
            await client.getJson(searchUrl(subreddit, query, after)),
          );
          for (const image of listing.images) {
            if (report.downloads >= options.limit) break;
            const key = `${image.postId}/${image.position}`;
            if (listed.has(key) || context.store.outcome("reddit", key)) {
              continue;
            }
            listed.add(key);
            await collectImage(context, client, image, folder, report);
          }
          after = listing.after;
          if (!after) break;
        }
      }
    }
    return report;
  } finally {
    report.downloadedBytes = client.received;
    await removeTempFolder(folder);
  }
}

async function collectImage(
  context: CollectContext,
  client: PoliteClient,
  image: RedditImage,
  folder: string,
  report: RunReport,
): Promise<void> {
  const key = `${image.postId}/${image.position}`;
  const local = `${folder}/candidate`;
  let outcome = "no-reward-screen";
  try {
    const bytes = await client.get(image.url, MAX_IMAGE_BYTES, "image/*");
    report.downloads++;
    await Deno.writeFile(local, bytes);
    const hit = await analyze(local, 0, context.scanners[0], context.constants);
    report.scanned++;
    if (hit) {
      report.rewardScreens++;
      outcome = countStored(
        report,
        await storeHit(context, hit, {
          kind: "reddit",
          url: image.permalink,
          itemId: image.postId,
          title: image.title,
          author: image.author,
          authorUrl: `https://www.reddit.com/user/${image.author}`,
          publishedAt: image.publishedAt,
          timestampSeconds: null,
          license: null,
          downloadedAt: new Date().toISOString(),
          detail: {
            subreddit: image.subreddit,
            imageUrl: image.url,
            galleryPosition: image.position,
          },
        }, { lossySource: hit.codec !== "png" }),
      );
    }
    await context.store.remember("reddit", key, outcome);
  } catch (error) {
    // A refusal or a rate limit ends the run; one bad image does not.
    if (
      !(error instanceof DatasetError) ||
      ["DST-002", "DST-009", "DST-010"].includes(error.code)
    ) {
      throw error;
    }
    report.errors++;
    context.log(describeError(error));
    outcome = error.code;
  } finally {
    await Deno.remove(local).catch(() => {});
  }
  report.items.push({ item: key, outcome });
  context.log(`reddit ${key}: ${outcome}`);
}
