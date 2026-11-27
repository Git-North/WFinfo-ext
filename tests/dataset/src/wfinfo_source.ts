/**
 * Reads WFInfo's theme colours and reward-screen layout constants from the
 * text of `WFInfo/Ocr.cs`. The file is read only; there is no second copy of
 * the values here, so an upstream change reaches the dataset tools, and a
 * change of shape fails loudly (DST-007).
 */

import { DatasetError } from "./errors.ts";
import { REPO_ROOT } from "./paths.ts";

export type Rgb = [number, number, number];

export interface ThemeColors {
  name: string;
  primary: Rgb;
  secondary: Rgb;
}

/** WFInfo's reward screen at 1920x1080 and 100 % UI scale, in pixels. */
export interface RewardLayout {
  rewardWidth: number;
  rewardHeight: number;
  rewardY: number;
  lineHeight: number;
}

export interface WfinfoConstants {
  themes: ThemeColors[];
  layout: RewardLayout;
}

const COLOR = String
  .raw`Color\.FromArgb\(\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\s*\)`;

function fail(what: string): never {
  throw new DatasetError("DST-007", what);
}

function intConstant(source: string, name: string): number {
  const match = new RegExp(`const int ${name}\\s*=\\s*(\\d+)\\s*;`).exec(
    source,
  );
  return match ? Number(match[1]) : fail(`const int ${name}`);
}

export function parseWfinfoConstants(source: string): WfinfoConstants {
  const enumBody = /public enum WFtheme\s*:\s*int\s*\{([^}]*)\}/.exec(source)
    ?.[1] ?? fail("enum WFtheme");
  // Members with an explicit value (AUTO, CUSTOM) are not themes.
  const names = enumBody.split(",").map((s) => s.trim())
    .filter((s) => /^[A-Z0-9_]+$/.test(s));

  const table = /ThemeInfo\[\]\s+AllThemes\s*=[^{]*\{([\s\S]*?)\n\s*\};/.exec(
    source,
  )?.[1] ?? fail("AllThemes table");
  const row = new RegExp(`Primary = ${COLOR}, Secondary = ${COLOR},`, "g");
  const rows = [...table.matchAll(row)].map((m) => m.slice(1).map(Number));
  if (names.length === 0 || rows.length !== names.length) {
    fail(`${names.length} theme names but ${rows.length} colour rows`);
  }

  return {
    themes: names.map((name, i) => ({
      name,
      primary: rows[i].slice(0, 3) as Rgb,
      secondary: rows[i].slice(3, 6) as Rgb,
    })),
    layout: {
      rewardWidth: intConstant(source, "pixleRewardWidth"),
      rewardHeight: intConstant(source, "pixleRewardHeight"),
      rewardY: intConstant(source, "pixleRewardYDisplay"),
      lineHeight: intConstant(source, "pixelRewardLineHeight"),
    },
  };
}

export async function loadWfinfoConstants(
  repoRoot = REPO_ROOT,
): Promise<WfinfoConstants> {
  return parseWfinfoConstants(
    await Deno.readTextFile(`${repoRoot}/WFInfo/Ocr.cs`),
  );
}
