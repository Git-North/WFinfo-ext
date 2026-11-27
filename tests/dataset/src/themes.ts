/**
 * Estimates the UI theme from the colour of the reward names. The names sit in
 * known rectangles, drawn in one of the theme's two colours on a darker card.
 * The estimate is a category for filtering, not WFInfo's own theme probe (that
 * probe reads one pixel column of the HUD).
 */

import { crop, luminance, type RgbImage } from "./imaging.ts";
import type { Rect } from "./geometry.ts";
import type { Rgb, ThemeColors } from "./wfinfo_source.ts";

/** Mean of the pixels around each pixel, `radius` to every side. */
function localMean(
  plane: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += plane[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const out = new Float32Array(plane.length);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1] -
        integral[y1 * stride + x0] + integral[y0 * stride + x0];
      out[y * width + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Luminance step that separates a text stroke from its card. */
const MIN_CONTRAST = 30;

/**
 * The colour of the text in one name rectangle: the most common colour among
 * the pixels that are clearly brighter than their surroundings. Null when the
 * rectangle holds no such strokes (or is mostly "strokes", so not text).
 */
export function textColor(image: RgbImage): Rgb | null {
  const { width, height } = image;
  if (width < 8 || height < 8) return null;
  const plane = luminance(image);
  const mean = localMean(plane, width, height, Math.max(3, height >> 3));
  const contrast = Float32Array.from(plane, (v, i) => v - mean[i]);

  const positive = contrast.filter((v) => v > MIN_CONTRAST).sort();
  if (positive.length < width * height * 0.005) return null;
  if (positive.length > width * height * 0.4) return null;
  // Keep the cores of the strokes: anti-aliased edges mix text and card.
  const floor = Math.max(
    MIN_CONTRAST,
    positive[Math.floor(positive.length * 0.95)] * 0.6,
  );

  const ink: number[] = [];
  const bins = new Map<number, number>();
  for (let i = 0; i < contrast.length; i++) {
    if (contrast[i] < floor) continue;
    ink.push(i);
    const key = (image.data[i * 3] >> 4) << 8 |
      (image.data[i * 3 + 1] >> 4) << 4 | (image.data[i * 3 + 2] >> 4);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  let mode = 0;
  let most = 0;
  for (const [key, count] of bins) {
    if (count > most) [mode, most] = [key, count];
  }
  const centre = [(mode >> 8) * 16 + 8, ((mode >> 4) & 15) * 16 + 8];
  centre.push((mode & 15) * 16 + 8);

  const total = [0, 0, 0];
  let near = 0;
  for (const i of ink) {
    const d = Math.hypot(
      image.data[i * 3] - centre[0],
      image.data[i * 3 + 1] - centre[1],
      image.data[i * 3 + 2] - centre[2],
    );
    if (d > 32) continue;
    near++;
    for (let c = 0; c < 3; c++) total[c] += image.data[i * 3 + c];
  }
  if (near === 0) return null;
  return total.map((v) => Math.round(v / near)) as Rgb;
}

/** sRGB to CIE L*a*b* (D65). */
export function toLab([r, g, b]: Rgb): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const x = f((0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047);
  const y = f(0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
  const z = f((0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 colour difference. About 2 is just visible. */
export function colorDistance(a: Rgb, b: Rgb): number {
  const [p, q] = [toLab(a), toLab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

export function toHex(color: Rgb): string {
  return "#" +
    color.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export type Confidence = "high" | "medium" | "low" | "none";

export interface ThemeEstimate {
  /** The closest theme, or null when no theme colour is close. */
  name: string | null;
  confidence: Confidence;
  textColor: string | null;
  matched: "primary" | "secondary" | null;
  distance: number | null;
  /** Other themes whose colour fits almost as well. */
  ambiguousWith: string[];
}

const UNKNOWN: ThemeEstimate = {
  name: null,
  confidence: "none",
  textColor: null,
  matched: null,
  distance: null,
  ambiguousWith: [],
};

/** Names use the primary colour in most themes, so a secondary match costs. */
const SECONDARY_PENALTY = 3;
const MAX_DISTANCE = 22;
const TIE_MARGIN = 3;

export function matchTheme(
  color: Rgb,
  themes: ThemeColors[],
): ThemeEstimate {
  const ranked = themes.map((theme) => {
    const primary = colorDistance(color, theme.primary);
    const secondary = colorDistance(color, theme.secondary);
    const usePrimary = primary <= secondary + SECONDARY_PENALTY;
    return {
      name: theme.name,
      matched: usePrimary ? "primary" as const : "secondary" as const,
      distance: usePrimary ? primary : secondary,
      score: usePrimary ? primary : secondary + SECONDARY_PENALTY,
    };
  }).sort((a, b) => a.score - b.score);

  const [best, ...rest] = ranked;
  if (best === undefined || best.distance > MAX_DISTANCE) {
    return { ...UNKNOWN, textColor: toHex(color) };
  }
  // The penalty only breaks the order: for ties, raw distances count.
  const gaps = rest.map((r) => ({
    name: r.name,
    gap: r.distance - best.distance,
  }));
  const ambiguousWith = gaps.filter((r) => r.gap < TIE_MARGIN)
    .map((r) => r.name);
  const margin = Math.min(...gaps.map((r) => r.gap));
  const confidence: Confidence = ambiguousWith.length > 0 || best.distance > 14
    ? "low"
    : best.distance <= 8 && margin >= 6
    ? "high"
    : "medium";
  return {
    name: best.name,
    confidence,
    textColor: toHex(color),
    matched: best.matched,
    distance: Math.round(best.distance * 10) / 10,
    ambiguousWith,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** The theme of an image, from the name rectangles of all its reward cards. */
export function estimateTheme(
  image: RgbImage,
  nameRects: Rect[],
  themes: ThemeColors[],
): ThemeEstimate {
  const colors = nameRects.map((rect) => textColor(crop(image, rect)))
    .filter((c): c is Rgb => c !== null);
  if (colors.length === 0) return UNKNOWN;
  const combined = [0, 1, 2].map((c) => median(colors.map((v) => v[c]))) as Rgb;
  return matchTheme(combined, themes);
}
