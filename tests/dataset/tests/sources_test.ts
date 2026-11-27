/** The public sources, with a stand-in for the network and the scanner. */

import { parseScanResult } from "../../../dashboard/src/lib/scan.ts";
import { buildGameData } from "../src/game_data.ts";
import { type Analysis, storeHit } from "../src/ingest.ts";
import { PoliteClient, USER_AGENT } from "../src/net.ts";
import { parseListing, searchUrl } from "../src/sources/reddit.ts";
import {
  parseLfsPointer,
  parseRepositoryFile,
} from "../src/sources/wfinfong.ts";
import {
  parseSearch,
  parseVideoMeta,
  videoId,
  ytdlpError,
} from "../src/sources/youtube.ts";
import { encodePng } from "../src/media.ts";
import { DatasetStore } from "../src/store.ts";
import { loadWfinfoConstants } from "../src/wfinfo_source.ts";
import {
  assertCode,
  assertEquals,
  assertTrue,
  filled,
  GAME_DATA_FILES,
  scanRecordJson,
} from "./helpers.ts";

function client(responses: Response[], waits: number[] = []) {
  const asked: { url: string; agent: string | null }[] = [];
  const polite = new PoliteClient({
    hosts: ["i.redd.it"],
    pauseMs: 0,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    fetch: (input, init) => {
      asked.push({
        url: String(input),
        agent: new Headers(init?.headers).get("user-agent"),
      });
      return Promise.resolve(responses.shift()!);
    },
  });
  return { polite, asked, waits };
}

Deno.test("requests carry a generic agent and stay on listed hosts", async () => {
  const { polite, asked } = client([
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/x.png" },
    }),
  ]);
  await assertCode(
    "DST-012",
    () => polite.get("https://i.redd.it/a.png", 100),
  );
  assertEquals(asked, [{
    url: "https://i.redd.it/a.png",
    agent: USER_AGENT,
  }]);
  assertTrue(!/@|north/i.test(USER_AGENT));
  for (
    const url of [
      "http://i.redd.it/a.png",
      "https://i.redd.it:8443/a.png",
      "https://pat@i.redd.it/a.png",
      "file:///etc/passwd",
    ]
  ) {
    await assertCode("DST-012", () => polite.get(url, 100));
  }
});

Deno.test("a refusal ends it, a short rate limit is waited out", async () => {
  const refused = client([new Response("blocked", { status: 403 })]);
  await assertCode(
    "DST-009",
    () => refused.polite.get("https://i.redd.it/a", 9),
  );
  assertEquals(refused.asked.length, 1, "no second try");

  const limited = client([
    new Response(null, { status: 429, headers: { "retry-after": "5" } }),
    new Response("ok"),
  ]);
  const body = await limited.polite.get("https://i.redd.it/a", 9);
  assertEquals(new TextDecoder().decode(body), "ok");
  assertEquals(limited.waits, [5000]);

  const long = client([
    new Response(null, { status: 429, headers: { "retry-after": "3600" } }),
  ]);
  await assertCode("DST-010", () => long.polite.get("https://i.redd.it/a", 9));
});

Deno.test("size limits, HTTP errors and bad JSON have their codes", async () => {
  const large = client([new Response("0123456789")]);
  await assertCode("DST-012", () => large.polite.get("https://i.redd.it/a", 4));
  const gone = client([new Response("", { status: 404 })]);
  await assertCode("DST-011", () => gone.polite.get("https://i.redd.it/a", 4));
  const html = client([new Response("<html>")]);
  await assertCode(
    "DST-013",
    () => html.polite.getJson("https://i.redd.it/a"),
  );
});

Deno.test("a Reddit listing yields direct and gallery images only", () => {
  const listing = parseListing({
    data: {
      after: "t3_next",
      children: [
        {
          data: {
            id: "abc123",
            url: "https://i.redd.it/one.png",
            title: "rewards",
            author: "someone",
            subreddit: "Warframe",
            permalink: "/r/Warframe/comments/abc123/x/",
            created_utc: 0,
          },
        },
        {
          data: {
            id: "def456",
            url: "https://www.reddit.com/gallery/def456",
            gallery_data: { items: [{ media_id: "m1" }, { media_id: "m2" }] },
            media_metadata: {
              m1: { status: "valid", m: "image/jpg" },
              m2: { status: "failed", m: "image/png" },
            },
          },
        },
        {
          data: { id: "nsfw99", url: "https://i.redd.it/x.png", over_18: true },
        },
        { data: { id: "link77", url: "https://evil.example/i.redd.it.png" } },
        { data: { id: "../up", url: "https://i.redd.it/y.png" } },
      ],
    },
  });
  assertEquals(listing.after, "t3_next");
  assertEquals(listing.images.map((i) => [i.postId, i.url]), [
    ["abc123", "https://i.redd.it/one.png"],
    ["def456", "https://i.redd.it/m1.jpg"],
  ]);
  assertEquals(listing.images[0].publishedAt, "1970-01-01T00:00:00.000Z");
});

Deno.test("Reddit input is checked", async () => {
  await assertCode("DST-013", () => parseListing({ error: 403 }));
  await assertCode("DST-001", () => searchUrl("a/../b", "q", null));
  assertTrue(
    searchUrl("Warframe", "a&b=1", "t3_x").includes("q=a%26b%3D1"),
  );
});

Deno.test("YouTube addresses, metadata and refusals", async () => {
  const id = "abcDEF12_-9";
  for (
    const input of [
      id,
      `https://youtu.be/${id}`,
      `https://www.youtube.com/watch?v=${id}&t=3`,
      `https://youtube.com/shorts/${id}`,
    ]
  ) {
    assertEquals(videoId(input), id);
  }
  for (
    const bad of ["--exec=rm", `https://evil.example/watch?v=${id}`, "abc"]
  ) {
    await assertCode("DST-001", () => videoId(bad));
  }
  const meta = parseVideoMeta({
    id,
    title: "relics",
    channel: "someone",
    upload_date: "20260102",
    duration: 60,
  });
  assertEquals([meta.author, meta.publishedAt, meta.license, meta.live], [
    "someone",
    "2026-01-02",
    null,
    false,
  ]);
  assertEquals(parseSearch({ entries: [{ id }, { id: "-bad" }] }), [id]);
  assertEquals(
    ytdlpError("ERROR: Sign in to confirm you're not a bot").code,
    "DST-009",
  );
  assertEquals(ytdlpError("ERROR: Video unavailable").code, "DST-017");
});

Deno.test("wfinfo-ng: LFS pointer and repository facts", async () => {
  const sha = "a".repeat(64);
  assertEquals(
    parseLfsPointer(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${sha}\nsize 12\n`,
    ),
    { sha256: sha, size: 12 },
  );
  assertEquals(parseLfsPointer("\x89PNG"), null);
  assertEquals(
    parseRepositoryFile({ license: { spdx_id: "GPL-3.0" } }, [{
      sha: "b".repeat(40),
      author: { login: "dev" },
      commit: { author: { date: "2022-08-24T09:37:30Z" } },
    }]),
    {
      commit: "b".repeat(40),
      committedAt: "2022-08-24T09:37:30Z",
      author: "dev",
      license: "GPL-3.0",
    },
  );
  await assertCode("DST-013", () => parseRepositoryFile({}, []));
});

Deno.test("a recognised download is masked, recorded and not stored twice", async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = `${root}/candidate.png`;
    await encodePng(filled(640, 360, [200, 200, 200]), path);
    const store = await DatasetStore.open(`${root}/set`);
    const context = {
      store,
      constants: await loadWfinfoConstants(),
      gameData: buildGameData(GAME_DATA_FILES),
      redactNames: true,
    };
    const hit: Analysis = {
      path,
      record: parseScanResult(scanRecordJson({ CaptureTarget: path }))!,
      codec: "png",
      originalSha256: "c".repeat(64),
      parts: ["Octavia Prime Systems", "Lex Prime Barrel"],
      seconds: 12.5,
      sharpness: 1,
      hash: "0".repeat(64),
      width: 640,
      height: 360,
    };
    const source = {
      kind: "youtube" as const,
      url: "https://www.youtube.com/watch?v=abcDEF12_-9&t=12s",
      itemId: "abcDEF12_-9",
      title: "=cmd",
      author: "someone",
      authorUrl: null,
      publishedAt: null,
      timestampSeconds: 12.5,
      license: null,
      downloadedAt: "2026-11-28T00:00:00.000Z",
      detail: {},
    };
    const first = await storeHit(context, hit, source, { lossySource: true });
    assertTrue(first.stored);
    const entry = store.entries[0];
    assertEquals(
      [
        entry.privacy.namesRedacted,
        entry.categories.slotCount,
        entry.categories.languageSource,
        entry.categories.uiScaleSource,
        entry.source.license,
        entry.scan.captureTarget,
        entry.game,
      ],
      [true, 2, "matched-english-names", "estimated", null, null, null],
    );
    assertTrue(entry.rights.includes("Local use only"));
    assertTrue(!JSON.stringify(entry).includes(root));
    await Deno.stat(`${root}/set/${entry.image!.file}`);

    const second = await storeHit(
      context,
      { ...hit, originalSha256: "d".repeat(64) },
      source,
      { lossySource: true },
    );
    assertEquals(second, { stored: false, duplicateOf: entry.id });

    await store.remember("youtube", source.itemId, "stored 1");
    const reopened = await DatasetStore.open(`${root}/set`);
    assertEquals(reopened.entries.length, 1);
    assertEquals(reopened.outcome("youtube", source.itemId), "stored 1");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
