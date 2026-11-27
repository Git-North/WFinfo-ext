/** Geometry, pixel analysis, theme estimate, frame selection and ffmpeg. */

import {
  aspectClass,
  aspectRatio,
  chatArea,
  resolutionClass,
  slotNameRects,
  squadNameBand,
} from "../src/geometry.ts";
import {
  crop,
  differenceHash,
  hashDistance,
  redact,
  sharpness,
} from "../src/imaging.ts";
import { decodeRgb, encodePng, parseShowinfoTimes } from "../src/media.ts";
import {
  bestFrame,
  groupRewardScreens,
  type Hit,
  isNearDuplicate,
  selectFrames,
} from "../src/selection.ts";
import { estimateTheme, matchTheme, textColor } from "../src/themes.ts";
import { loadWfinfoConstants } from "../src/wfinfo_source.ts";
import {
  assertCode,
  assertEquals,
  assertTrue,
  drawStrokes,
  filled,
} from "./helpers.ts";

const constants = await loadWfinfoConstants();

Deno.test("resolution categories", () => {
  const classes = [
    [1920, 1080],
    [2560, 1440],
    [3440, 1440],
    [2560, 1080],
    [1920, 1200],
    [5120, 1440],
    [1280, 1024],
    [1000, 1000],
  ].map(([w, h]) => aspectClass(w, h));
  assertEquals(classes, [
    "16:9",
    "16:9",
    "21:9",
    "21:9",
    "16:10",
    "32:9",
    "5:4",
    "other",
  ]);
  assertEquals(aspectRatio(2560, 1080), "64:27");
  assertEquals([720, 1080, 1440, 2160].map(resolutionClass), [
    "720p",
    "1080p",
    "1440p",
    "2160p-or-more",
  ]);
});

Deno.test("name rectangles sit where a real 1080p screen has its names", () => {
  // wfinfo-ng's capture: four names centred near x 596, 838, 1080 and 1322,
  // text between y 414 and 457.
  const rects = slotNameRects(1920, 1080, 4, 1, constants.layout);
  assertEquals(
    rects.map((r) => Math.round(r.x + r.width / 2)),
    [597, 839, 1081, 1323],
  );
  assertTrue(rects[0].y <= 414 && rects[0].y + rects[0].height >= 457);
});

Deno.test("the squad band covers the names and spares the reward names", () => {
  // Real positions at 1080p and UI scale 1: reward names end at y 457; squad
  // names run from y 503 and can stack down to about y 600.
  for (const source of ["ee.cfg", "estimated"] as const) {
    const band = squadNameBand(1920, 1080, 1, source);
    assertEquals([band.x, band.width], [0, 1920]);
    assertTrue(band.y >= 459 && band.y <= 500, `top ${band.y}`);
    assertTrue(band.y + band.height >= 600);
  }
  // An estimate 10 % low or high still covers the true rows.
  for (const actual of [0.9, 1.1]) {
    const band = squadNameBand(1920, 1080, 1, "estimated");
    assertTrue(band.y <= 540 - 37 * actual);
    assertTrue(band.y + band.height >= 540 + 60 * actual);
  }
  const unknown = squadNameBand(1920, 1080, null, "unknown");
  assertTrue(unknown.y <= 540 - 37 * 1.25);
  assertTrue(unknown.y + unknown.height >= 540 + 60 * 1.25);
});

Deno.test("redaction removes the strokes and changes nothing outside", () => {
  const image = filled(640, 360, [20, 20, 30]);
  const band = { x: 0, y: 150, width: 640, height: 80 };
  drawStrokes(image, { x: 100, y: 170, width: 200, height: 20 }, [255, 255, 0]);
  drawStrokes(image, { x: 100, y: 20, width: 200, height: 20 }, [255, 0, 0]);
  const out = redact(image, band);
  for (let y = 0; y < 360; y++) {
    if (y >= band.y && y < band.y + band.height) continue;
    const row = (b: Uint8Array) => b.subarray(y * 640 * 3, (y + 1) * 640 * 3);
    assertEquals(row(out.data), row(image.data), `row ${y}`);
  }
  const before = sharpness(crop(image, band));
  assertTrue(sharpness(crop(out, band)) < before / 10);
  assertTrue(textColor(crop(out, { ...band, x: 100, width: 200 })) === null);
  assertEquals(image.data[(172 * 640 + 102) * 3], 255, "input untouched");
});

Deno.test("hashes separate different pictures", () => {
  const a = filled(320, 100, [10, 10, 10]);
  drawStrokes(a, { x: 10, y: 10, width: 120, height: 60 }, [200, 200, 200]);
  const b = filled(320, 100, [10, 10, 10]);
  drawStrokes(b, { x: 180, y: 30, width: 120, height: 60 }, [200, 200, 200]);
  assertEquals(differenceHash(a).length, 64);
  assertEquals(hashDistance(differenceHash(a), differenceHash(a)), 0);
  assertTrue(hashDistance(differenceHash(a), differenceHash(b)) > 24);
  assertEquals(hashDistance("ff", "f"), Infinity);
});

Deno.test("the theme follows the colour of the names", () => {
  for (const name of ["VITRUVIAN", "CORPUS", "NIDUS", "GRINEER"]) {
    const theme = constants.themes.find((t) => t.name === name)!;
    const image = filled(1920, 1080, [25, 22, 28]);
    const rects = slotNameRects(1920, 1080, 3, 1, constants.layout);
    for (const rect of rects) drawStrokes(image, rect, theme.primary);
    const estimate = estimateTheme(image, rects, constants.themes);
    assertEquals([estimate.name, estimate.matched], [name, "primary"]);
  }
});

Deno.test("the theme stays unknown without text or a close colour", () => {
  const blank = filled(1920, 1080, [25, 22, 28]);
  const rects = slotNameRects(1920, 1080, 2, 1, constants.layout);
  assertEquals(estimateTheme(blank, rects, constants.themes).name, null);
  const odd = matchTheme([0, 255, 255], constants.themes);
  assertEquals([odd.name, odd.confidence], [null, "none"]);
  // Several themes write in white, so white is never a confident answer.
  const white = matchTheme([255, 255, 255], constants.themes);
  assertEquals(white.confidence, "low");
  assertTrue(white.ambiguousWith.length > 0);
});

function hit(seconds: number, parts: string[], over: Partial<Hit> = {}): Hit {
  return {
    seconds,
    parts,
    sharpness: 10,
    hash: "0".repeat(64),
    width: 1920,
    height: 1080,
    ...over,
  };
}

Deno.test("frames of one reward screen group and the fullest one wins", () => {
  const hits = [
    hit(12, ["A", "B", "C"], { sharpness: 99 }),
    hit(8, ["A"]),
    hit(16, ["A", "B", "C", "D"], { sharpness: 5 }),
    hit(20, ["A", "B", "C", "D"], { sharpness: 8 }),
    hit(24, ["X", "Y", "Z"]),
    hit(300, ["X", "Y", "Z"], { hash: "f".repeat(64) }),
  ];
  const groups = groupRewardScreens(hits, 10);
  assertEquals(groups.map((g) => g.length), [4, 1, 1]);
  assertEquals(bestFrame(groups[0]).seconds, 20);
  assertEquals(selectFrames(hits, 10).map((h) => h.seconds), [20, 24, 300]);
});

Deno.test("a misread part of a screen does not become a second screen", () => {
  // From the pilot: 4 s after four cards, one card was read, as another part.
  const full = hit(352, ["Astilla", "B", "C", "D"]);
  const tail = hit(356, ["Baza"]);
  assertEquals(selectFrames([full, tail], 10), [full]);
  assertEquals(selectFrames([full, hit(400, ["Baza"])], 10).length, 2);
});

Deno.test("the chat area is the bottom left", () => {
  const area = chatArea(1920, 1080);
  assertTrue(area.x === 0 && area.width >= 460);
  assertTrue(area.y <= 755 && area.y + area.height === 1080);
});

Deno.test("near-duplicates need the same names, size and picture", () => {
  const a = hit(0, ["A", "B"]);
  assertTrue(isNearDuplicate(a, hit(9, ["A", "B"])));
  assertTrue(!isNearDuplicate(a, hit(9, ["B", "A"])));
  assertTrue(!isNearDuplicate(a, hit(9, ["A", "B"], { height: 1440 })));
  assertTrue(
    !isNearDuplicate(a, hit(9, ["A", "B"], { hash: "f".repeat(64) })),
  );
  // A replay of a screen later in the same video is dropped.
  assertEquals(selectFrames([a, hit(500, ["A", "B"])], 10).length, 1);
});

Deno.test("showinfo times are read in frame order", () => {
  const log = "[Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0 x\n" +
    "noise pts_time:99\n" +
    "[Parsed_showinfo_1 @ 0x1] n:   1 pts:   4004 pts_time:4.004 x\n";
  assertEquals(parseShowinfoTimes(log), [0, 4.004]);
});

Deno.test("ffmpeg writes and reads pixels exactly", async () => {
  const folder = await Deno.makeTempDir();
  try {
    const image = filled(33, 17, [190, 169, 102]);
    drawStrokes(image, { x: 0, y: 0, width: 33, height: 17 }, [1, 2, 3]);
    await encodePng(image, `${folder}/a.png`);
    assertEquals(await decodeRgb(`${folder}/a.png`), image);
    await Deno.writeTextFile(`${folder}/bad.png`, "not an image");
    await assertCode("DST-006", () => decodeRgb(`${folder}/bad.png`));
  } finally {
    await Deno.remove(folder, { recursive: true });
  }
});
