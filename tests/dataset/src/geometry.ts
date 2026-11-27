/**
 * Pixel geometry of the reward screen, from WFInfo's constants, and the
 * resolution categories of an image. All rectangles are in image pixels with a
 * top-left origin.
 */

import type { RewardLayout } from "./wfinfo_source.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** UI-scale limits Warframe offers (WFInfo clamps EE.cfg to this range). */
export const UI_SCALE_MIN = 0.5;
export const UI_SCALE_MAX = 1.25;

export function clampRect(rect: Rect, width: number, height: number): Rect {
  const x0 = Math.min(width, Math.max(0, Math.floor(rect.x)));
  const y0 = Math.min(height, Math.max(0, Math.floor(rect.y)));
  const x1 = Math.min(width, Math.max(x0, Math.ceil(rect.x + rect.width)));
  const y1 = Math.min(height, Math.max(y0, Math.ceil(rect.y + rect.height)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** WFInfo's screen scaling: 1080p units to pixels at 100 % UI scale. */
export function screenScaling(width: number, height: number): number {
  return Math.min(width / 1920, height / 1080);
}

/** One rectangle per reward card, covering the name rows, left to right. */
export function slotNameRects(
  width: number,
  height: number,
  slots: number,
  uiScale: number,
  layout: RewardLayout,
): Rect[] {
  const k = screenScaling(width, height) * uiScale;
  const slot = layout.rewardWidth / 4 * k;
  const top = height / 2 -
    (layout.rewardY - layout.rewardHeight + layout.lineHeight) * k;
  return Array.from({ length: slots }, (_, i) => {
    const centre = width / 2 + (i - (slots - 1) / 2) * slot;
    return clampRect(
      {
        x: centre - slot * 0.48,
        y: top,
        width: slot * 0.96,
        height: layout.lineHeight * k,
      },
      width,
      height,
    );
  });
}

/** The cards with their names, without the squad-name row below them. */
export function cardRegion(
  width: number,
  height: number,
  uiScale: number,
  layout: RewardLayout,
): Rect {
  const k = screenScaling(width, height) * uiScale;
  const strip = layout.rewardWidth * k;
  return clampRect(
    {
      x: width / 2 - strip / 2,
      y: height / 2 - layout.rewardY * k,
      width: strip,
      height: layout.rewardHeight * k,
    },
    width,
    height,
  );
}

/**
 * The squad-name row, in 1080p units below the screen centre. Measured on
 * wfinfo-ng's 1080p capture: the rarity divider ends at about +54 units above
 * the centre, names start about 37 above it, and a card that several players
 * chose stacks their names (27 units per line, four at most).
 */
const SQUAD_TOP_ABOVE_CENTRE = 58;
const SQUAD_BOTTOM_BELOW_CENTRE = 105;

/**
 * The full-width band that holds squad names. The band grows with the error the
 * UI scale may have: a scale read from EE.cfg is exact to one 5 % step, an
 * estimate can be 10 % off, and an unknown scale covers Warframe's whole range.
 */
export function squadNameBand(
  width: number,
  height: number,
  uiScale: number | null,
  scaleSource: "ee.cfg" | "record" | "estimated" | "unknown",
): Rect {
  const margin = scaleSource === "estimated" ? 0.1 : 0.05;
  const high = uiScale === null || uiScale <= 0
    ? UI_SCALE_MAX
    : uiScale + margin;
  const s = screenScaling(width, height) * high;
  const top = height / 2 - SQUAD_TOP_ABOVE_CENTRE * s;
  const bottom = height / 2 + SQUAD_BOTTOM_BELOW_CENTRE * s;
  return clampRect(
    { x: 0, y: top, width, height: bottom - top },
    width,
    height,
  );
}

/**
 * Where the chat window sits on the reward screen: the bottom left. It lists
 * other players' names and messages. Measured on 1080p video frames (about
 * 460 x 310 pixels), with room for a larger window. A moved window is missed.
 */
export function chatArea(width: number, height: number): Rect {
  return clampRect(
    { x: 0, y: height * 0.68, width: width * 0.32, height: height * 0.32 },
    width,
    height,
  );
}

const ASPECTS: [string, number][] = [
  ["5:4", 5 / 4],
  ["4:3", 4 / 3],
  ["3:2", 3 / 2],
  ["16:10", 16 / 10],
  ["5:3", 5 / 3],
  ["16:9", 16 / 9],
  ["17:9", 17 / 9],
  ["2:1", 2],
  // 2560x1080, 3440x1440 and 3840x1600 are all sold as 21:9.
  ["21:9", 64 / 27],
  ["21:9", 43 / 18],
  ["21:9", 12 / 5],
  ["32:9", 32 / 9],
];

/** The common name of the aspect ratio, within 1.5 %; else "other". */
export function aspectClass(width: number, height: number): string {
  const ratio = width / height;
  let best = "other";
  let error = 0.015;
  for (const [name, value] of ASPECTS) {
    const e = Math.abs(ratio - value) / value;
    if (e < error) {
      best = name;
      error = e;
    }
  }
  return best;
}

/** The reduced ratio, for example "64:27" for 2560x1080. */
export function aspectRatio(width: number, height: number): string {
  let a = width;
  let b = height;
  while (b !== 0) [a, b] = [b, a % b];
  return `${width / a}:${height / a}`;
}

/** The vertical resolution class. Odd window sizes round down. */
export function resolutionClass(height: number): string {
  if (height < 700) return "below-720p";
  if (height < 890) return "720p";
  if (height < 1060) return "900p";
  if (height < 1180) return "1080p";
  if (height < 1400) return "1200p";
  if (height < 1560) return "1440p";
  if (height < 2100) return "1600p";
  return "2160p-or-more";
}
