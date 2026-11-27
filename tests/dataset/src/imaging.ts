/**
 * Pixel analysis on raw 8-bit RGB images: cropping, perceptual hash,
 * sharpness and the squad-name redaction. Pure functions; `media.ts` does the
 * decoding and encoding.
 */

import type { Rect } from "./geometry.ts";

export interface RgbImage {
  width: number;
  height: number;
  /** `width * height * 3` bytes, rows top to bottom. */
  data: Uint8Array;
}

export function createImage(width: number, height: number): RgbImage {
  return { width, height, data: new Uint8Array(width * height * 3) };
}

export function crop(image: RgbImage, rect: Rect): RgbImage {
  const out = createImage(rect.width, rect.height);
  for (let row = 0; row < rect.height; row++) {
    const start = ((rect.y + row) * image.width + rect.x) * 3;
    out.data.set(
      image.data.subarray(start, start + rect.width * 3),
      row * rect.width * 3,
    );
  }
  return out;
}

/** Rec. 709 luminance of every pixel, 0-255. */
export function luminance(image: RgbImage): Float32Array {
  const out = new Float32Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.2126 * image.data[i * 3] + 0.7152 * image.data[i * 3 + 1] +
      0.0722 * image.data[i * 3 + 2];
  }
  return out;
}

/** Area-averaged resize of a luminance plane. */
function shrink(
  plane: Float32Array,
  width: number,
  height: number,
  toWidth: number,
  toHeight: number,
): Float32Array {
  const sum = new Float64Array(toWidth * toHeight);
  const count = new Float64Array(toWidth * toHeight);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y * toHeight / height) * toWidth;
    for (let x = 0; x < width; x++) {
      const cell = row + Math.floor(x * toWidth / width);
      sum[cell] += plane[y * width + x];
      count[cell]++;
    }
  }
  return Float32Array.from(sum, (v, i) => count[i] === 0 ? 0 : v / count[i]);
}

const HASH_SIDE = 16;

/** 256-bit difference hash as 64 hex digits. */
export function differenceHash(image: RgbImage): string {
  const small = shrink(
    luminance(image),
    image.width,
    image.height,
    HASH_SIDE + 1,
    HASH_SIDE,
  );
  let hex = "";
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < HASH_SIDE; y++) {
    for (let x = 0; x < HASH_SIDE; x++) {
      const left = small[y * (HASH_SIDE + 1) + x];
      const right = small[y * (HASH_SIDE + 1) + x + 1];
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      if (++bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

/** Number of different bits of two equal-length hex hashes. */
export function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let diff = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (diff !== 0) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}

/**
 * Variance of the Laplacian of the luminance: higher is sharper. Use it to
 * compare images of the same size, such as frames of one video.
 */
export function sharpness(image: RgbImage): number {
  const { width, height } = image;
  if (width < 3 || height < 3) return 0;
  const l = luminance(image);
  let sum = 0;
  let squares = 0;
  const n = (width - 2) * (height - 2);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = 4 * l[i] - l[i - 1] - l[i + 1] - l[i - width] - l[i + width];
      sum += v;
      squares += v * v;
    }
  }
  const mean = sum / n;
  return Math.round((squares / n - mean * mean) * 10) / 10;
}

/** Masks several areas; see `redact`. */
export function redactAll(image: RgbImage, areas: Rect[]): RgbImage {
  return areas.reduce(redact, image);
}

/**
 * Overwrites `band` with a coarse mosaic. Each block becomes its average
 * colour; blocks are taller than a text line and several letters wide, so the
 * names cannot be recovered. Pixels outside the band are untouched.
 */
export function redact(image: RgbImage, band: Rect): RgbImage {
  const out = { ...image, data: image.data.slice() };
  const blockWidth = Math.max(24, Math.round(image.width / 48));
  const blockHeight = Math.max(24, Math.ceil(band.height / 2));
  const right = band.x + band.width;
  const bottom = band.y + band.height;
  for (let y0 = band.y; y0 < bottom; y0 += blockHeight) {
    for (let x0 = band.x; x0 < right; x0 += blockWidth) {
      const x1 = Math.min(right, x0 + blockWidth);
      const y1 = Math.min(bottom, y0 + blockHeight);
      const total = [0, 0, 0];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * image.width + x) * 3;
          for (let c = 0; c < 3; c++) total[c] += image.data[i + c];
        }
      }
      const pixels = (x1 - x0) * (y1 - y0);
      const mean = total.map((v) => Math.round(v / pixels));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          out.data.set(mean, (y * image.width + x) * 3);
        }
      }
    }
  }
  return out;
}
