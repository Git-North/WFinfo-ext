/** The store, the git guard, the index and the archive of the user's scans. */

import { buildGameData } from "../src/game_data.ts";
import { csvCell, formatSpread, toCsv } from "../src/index_file.ts";
import { encodePng } from "../src/media.ts";
import { assertSafeOutput, REPO_ROOT } from "../src/paths.ts";
import { sandboxEnv, seededPriceCache } from "../src/scanner.ts";
import {
  archiveOnce,
  type OwnContext,
  ownId,
  pairProblem,
  parseOwnRecord,
  scaleEstimates,
  uiScaleOrigin,
} from "../src/sources/own.ts";
import { DatasetStore } from "../src/store.ts";
import { loadWfinfoConstants } from "../src/wfinfo_source.ts";
import {
  assertCode,
  assertEquals,
  assertTrue,
  drawStrokes,
  filled,
  GAME_DATA_FILES,
  scanRecordJson,
} from "./helpers.ts";

const record = parseOwnRecord(JSON.stringify(scanRecordJson()))!;
const started = record.record.startedMs;
const image = {
  width: 640,
  height: 360,
  modifiedMs: started + 100,
  changedMs: started + 400,
};
const recordFile = { modifiedMs: started + 500, changedMs: started + 500 };

Deno.test("a screenshot is paired only with its own record", () => {
  assertEquals(pairProblem(record.record, image, recordFile), null);
  const problem = (over: object) =>
    pairProblem(record.record, { ...image, ...over }, recordFile);
  assertTrue(problem({ width: 800 }));
  // A newer scan wrote last.png, its record is not published yet.
  assertTrue(problem({ modifiedMs: started + 9000 }));
  assertTrue(problem({ changedMs: started + 9000 }));
  // last.png is left over from before this scan.
  assertTrue(
    problem({ modifiedMs: started - 60_000, changedMs: started - 60_000 }),
  );
  // A --file copy keeps an old modification time; the change time is new.
  assertEquals(problem({ modifiedMs: started - 60_000 }), null);
  const elsewhere = parseOwnRecord(
    JSON.stringify(scanRecordJson({ ScreenshotPath: "/tmp/shot.png" })),
  )!;
  assertTrue(pairProblem(elsewhere.record, image, recordFile));
});

Deno.test("debug.log estimates are found in either date order", () => {
  const line = (date: string) =>
    `[${date} 11:43:55]   Reward layout: ui scale estimated 0.90 (range)`;
  for (const date of ["27.11.2026", "11/27/2026", "27/11/2026"]) {
    assertEquals(scaleEstimates(line(date), started, started + 500), [0.9]);
  }
  assertEquals(scaleEstimates(line("26.11.2026"), started, started), []);
});

Deno.test("the UI scale says where it came from", () => {
  const game = {
    build: null,
    language: null,
    uiScaleConfig: 1,
    graphics: null,
  };
  assertEquals(uiScaleOrigin(record.record, [1.0], game), "estimated");
  assertEquals(uiScaleOrigin(record.record, [], game), "ee.cfg");
  const file = { ...record.record, captureSource: "file" };
  assertEquals(uiScaleOrigin(file, [], game), "record");
  assertEquals(
    uiScaleOrigin({ ...record.record, uiScaling: 0 }, [], game),
    "unknown",
  );
});

Deno.test("a scan keeps one id over its fast and deep records", () => {
  const withId = (Stage: string) =>
    parseOwnRecord(
      JSON.stringify(
        scanRecordJson({ ScanId: "20261127_114355259-42", Stage }),
      ),
    )!;
  assertEquals(ownId(withId("fast")), ownId(withId("deep")));
  assertEquals(ownId(record), "own-20261127T114355259Z");
  assertEquals(parseOwnRecord("{half"), null);
});

Deno.test("the dataset folder may never reach git", async () => {
  await assertSafeOutput(`${REPO_ROOT}/training`);
  for (const folder of ["tests/data", "training-copy", "."]) {
    await assertCode(
      "DST-008",
      () => assertSafeOutput(`${REPO_ROOT}/${folder}`.replace(/\/\.$/, "")),
    );
  }
  const outside = await Deno.makeTempDir();
  try {
    await assertSafeOutput(`${outside}/set`);
    // Another repository that does not ignore the images.
    await new Deno.Command("git", { args: ["init", "-q", outside] }).output();
    await assertCode("DST-008", () => assertSafeOutput(`${outside}/set`));
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("CSV cells cannot run as formulas", () => {
  assertEquals(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assertEquals(csvCell("@a,b"), `"'@a,b"`);
  assertEquals(csvCell('say "x"'), '"say ""x"""');
  assertEquals(csvCell(-3), "-3");
  assertEquals(toCsv([{ a: 1, b: null }]), "a,b\n1,\n");
});

Deno.test("the sandbox points every app-data root away from the user", () => {
  const env = sandboxEnv(
    { HOME: "/home/pat", WFINFO_EE_LOG: "x", APPDATA: "y", PATH: "/bin" },
    "/tmp/box",
  );
  for (const name of ["HOME", "CFFIXED_USER_HOME", "XDG_CONFIG_HOME"]) {
    assertTrue(env[name].startsWith("/tmp/box"), name);
  }
  assertEquals([env.WFINFO_EE_LOG, env.APPDATA, env.PATH], [
    undefined,
    undefined,
    "/bin",
  ]);
  const cache = JSON.parse(
    seededPriceCache('{"1":"A|a_slug|A","2":"broken"}', new Date(0)),
  );
  assertEquals(Object.keys(cache.prices), ["a_slug"]);
});

async function publish(
  scans: string,
  json: Record<string, unknown>,
  shot: ReturnType<typeof filled> | null,
): Promise<void> {
  if (shot) await encodePng(shot, `${scans}/last.png`);
  const now = new Date();
  const text = JSON.stringify({
    ...json,
    StartedAt: json.StartedAt ?? new Date(now.getTime() - 1000).toISOString(),
    FinishedAt: now.toISOString(),
  });
  await Deno.writeTextFile(`${scans}/latest.json`, text);
}

Deno.test("own scans are archived with categories and no private text", async () => {
  const root = await Deno.makeTempDir();
  try {
    const appDir = `${root}/app/WFInfo`;
    const scans = `${appDir}/scans`;
    await Deno.mkdir(scans, { recursive: true });
    const constants = await loadWfinfoConstants();
    const shot = filled(640, 360, [20, 20, 28]);
    drawStrokes(
      shot,
      { x: 250, y: 137, width: 60, height: 15 },
      constants.themes[0].primary,
    );
    const old = scanRecordJson({
      StartedAt: "2026-11-20T10:00:00.000Z",
      CaptureSource: "file",
      CaptureTarget: "/home/pat/private/shot.png",
    });
    await Deno.writeTextFile(
      `${scans}/scan-20261120_100000000.json`,
      JSON.stringify(old),
    );
    await publish(
      scans,
      scanRecordJson({
        StartedAt: undefined,
        ScreenshotPath: `${scans}/last.png`,
      }),
      shot,
    );
    let reads = 0;
    const context = async (): Promise<OwnContext> => ({
      appDir,
      store: await DatasetStore.open(`${root}/set`),
      constants,
      gameData: buildGameData(GAME_DATA_FILES),
      game: () => {
        reads++;
        return Promise.resolve({
          build: "2026.10.28.09.54",
          language: "en",
          uiScaleConfig: 1,
          graphics: { SSGI: "1" },
        });
      },
      redactNames: false,
    });

    const first = await archiveOnce(await context(), { history: true });
    assertEquals(first, {
      added: 2,
      updated: 0,
      known: 0,
      withoutImage: 1,
    });
    assertEquals(reads, 1, "game files are read for the live capture only");

    const store = await DatasetStore.open(`${root}/set`);
    const [withImage] = store.entries.filter((e) => e.image);
    const [withoutImage] = store.entries.filter((e) => !e.image);
    assertEquals(withImage.parts.map((p) => p.name), [
      "Octavia Prime Systems",
      "Lex Prime Barrel",
    ]);
    assertEquals(
      [
        withImage.categories.slotCount,
        withImage.categories.aspectClass,
        withImage.categories.uiScaleSource,
        withImage.categories.language,
        withImage.categories.anyVaulted,
        withImage.categories.rarities,
      ],
      [2, "16:9", "ee.cfg", "en", true, ["common", "uncommon", "rare"].sort()],
    );
    assertEquals(withoutImage.scan.captureTarget, "shot.png");
    assertEquals(withoutImage.game, null);
    assertTrue(!JSON.stringify(withoutImage).includes("/home/pat"));

    const again = await archiveOnce(await context(), { history: true });
    assertEquals([again.added, again.updated, again.known], [0, 0, 2]);

    assertTrue(await store.label(withImage.id, { screen: "other", note: "x" }));
    assertTrue(!await store.label("missing", { screen: "other", note: null }));
    await store.writeIndex();
    const csv = await Deno.readTextFile(`${root}/set/index.csv`);
    assertEquals(csv.trim().split("\n").length, 3);
    assertTrue(formatSpread(store.rows()).startsWith("1 images"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an unpaired screenshot is not stored with the record", async () => {
  const root = await Deno.makeTempDir();
  try {
    const scans = `${root}/WFInfo/scans`;
    await Deno.mkdir(scans, { recursive: true });
    // The record names a size that last.png does not have.
    await publish(
      scans,
      scanRecordJson({
        StartedAt: undefined,
        ScreenshotPath: `${scans}/last.png`,
        ScreenshotWidth: 800,
      }),
      filled(640, 360, [0, 0, 0]),
    );
    const store = await DatasetStore.open(`${root}/set`);
    const report = await archiveOnce({
      appDir: `${root}/WFInfo`,
      store,
      constants: await loadWfinfoConstants(),
      gameData: buildGameData(GAME_DATA_FILES),
      game: () => Promise.resolve(null),
      redactNames: true,
    }, { history: false });
    assertEquals([report.added, report.withoutImage], [1, 1]);
    assertEquals(store.entries[0].image, null);
    await assertCode("DST-015", () =>
      archiveOnce({
        appDir: `${root}/nothing`,
        store,
        constants: { themes: [], layout: {} as never },
        gameData: buildGameData(GAME_DATA_FILES),
        game: () => Promise.resolve(null),
        redactNames: false,
      }, { history: true }));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
