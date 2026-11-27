/** Shared test helpers: assertions, synthetic images and a scan record. */

import { assertTrue } from "../../../dashboard/src/lib/testutil.ts";
import { DatasetError } from "../src/errors.ts";
import type { Rect } from "../src/geometry.ts";
import { createImage, type RgbImage } from "../src/imaging.ts";
import type { Rgb } from "../src/wfinfo_source.ts";

export {
  assertEquals,
  assertTrue,
} from "../../../dashboard/src/lib/testutil.ts";

export async function assertCode(
  code: string,
  work: () => unknown,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    assertTrue(
      error instanceof DatasetError && error.code === code,
      `expected ${code}, got ${error}`,
    );
    return;
  }
  throw new Error(`expected ${code}, nothing was thrown`);
}

export function filled(width: number, height: number, color: Rgb): RgbImage {
  const image = createImage(width, height);
  for (let i = 0; i < width * height; i++) image.data.set(color, i * 3);
  return image;
}

/** Thin vertical strokes inside `rect`, like the stems of small text. */
export function drawStrokes(image: RgbImage, rect: Rect, color: Rgb): void {
  for (let y = rect.y + 2; y < rect.y + rect.height - 2; y++) {
    for (let x = rect.x + 2; x < rect.x + rect.width - 2; x += 9) {
      for (let dx = 0; dx < 2; dx++) {
        image.data.set(color, (y * image.width + x + dx) * 3);
      }
    }
  }
}

export function scanRecordJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    Version: 1,
    StartedAt: "2026-11-27T11:43:55.259Z",
    FinishedAt: "2026-11-27T11:43:55.775Z",
    DurationMs: 515,
    CaptureSource: "screencapturekit",
    CaptureTarget: "display 1",
    ScreenshotPath: "/home/someone/app/WFInfo/scans/last.png",
    ScreenshotWidth: 640,
    ScreenshotHeight: 360,
    UiScaling: 1,
    Theme: null,
    OcrEngine: "vision-layout",
    Choices: [
      { Index: 2, Part: "Lex Prime Barrel", Slug: "lex_prime_barrel" },
      { Index: 1, Part: "Octavia Prime Systems" },
    ],
    Error: null,
    ...overrides,
  };
}

export const GAME_DATA_FILES = {
  marketItems: {
    a: "Lex Prime Barrel|lex_prime_barrel|Lex Prime Barrel",
    b: "Octavia Prime Systems|octavia_prime_systems_blueprint|Octavia Prime Systems Blueprint",
  },
  marketData: {
    "Lex Prime Barrel": { plat: "4.0", ducats: 15 },
    "Octavia Prime Systems Blueprint": {
      name: "Octavia Prime Systems Blueprint",
      plat: "6",
      ducats: 0,
    },
    "Octavia Prime Systems": {
      name: "Octavia Prime Systems Blueprint",
      plat: "6",
      ducats: 15,
    },
  },
  equipment: {
    "Octavia Prime": {
      type: "Warframes",
      parts: { "Octavia Prime Systems": { vaulted: true } },
    },
    "Lex Prime": {
      type: "Secondary",
      parts: { "Lex Prime Barrel": { vaulted: false } },
    },
  },
  relics: {
    Lith: {
      A1: { vaulted: false, common1: "Lex Prime Barrel" },
      B2: { vaulted: true, rare1: "Lex Prime Barrel" },
    },
    Axi: { C3: { vaulted: true, uncommon2: "Octavia Prime Systems" } },
  },
};
