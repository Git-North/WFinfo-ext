/**
 * Which frames of a video to keep, and when two images are near-identical.
 * Pure functions.
 */

import { hashDistance } from "./imaging.ts";

/** What selection needs to know about an image with a recognised reward. */
export interface Hit {
  /** Recognised part names, left to right. */
  parts: string[];
  /** Position in the video, seconds (0 for a single image). */
  seconds: number;
  sharpness: number;
  /** Difference hash of the card region. */
  hash: string;
  width: number;
  height: number;
}

/**
 * Two images of the same names at the same size whose card regions differ in at
 * most this many of 256 hash bits show the same reward screen.
 */
export const DUPLICATE_BITS = 24;

export function isNearDuplicate(
  a: Pick<Hit, "parts" | "hash" | "width" | "height">,
  b: Pick<Hit, "parts" | "hash" | "width" | "height">,
): boolean {
  return a.width === b.width && a.height === b.height &&
    a.parts.length === b.parts.length &&
    a.parts.every((part, i) => part === b.parts[i]) &&
    hashDistance(a.hash, b.hash) <= DUPLICATE_BITS;
}

function sharesPart(a: Hit, b: Hit): boolean {
  return a.parts.some((part) => b.parts.includes(part));
}

/** A read of at most half the cards, which may also name them wrongly. */
function partialRead(a: Hit, b: Hit): boolean {
  const [few, many] = [a.parts.length, b.parts.length].sort((x, y) => x - y);
  return few * 2 <= many;
}

/**
 * Groups the hits of one video into reward screens. A hit belongs to the
 * screen before it when it follows within `maxGapSeconds` and names one of
 * the same parts, or one of the two reads at most half as many cards: while
 * the panel animates in or out, the scanner reads only some of them, and not
 * always rightly. Two real reward screens are minutes apart in play.
 */
export function groupRewardScreens<T extends Hit>(
  hits: T[],
  maxGapSeconds: number,
): T[][] {
  const groups: T[][] = [];
  for (const hit of [...hits].sort((a, b) => a.seconds - b.seconds)) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (
      group && previous &&
      hit.seconds - previous.seconds <= maxGapSeconds &&
      // Against the fullest frame, so one early partial read cannot join
      // two different screens.
      (group.some((member) => sharesPart(member, hit)) ||
        partialRead(bestFrame(group), hit))
    ) {
      group.push(hit);
    } else {
      groups.push([hit]);
    }
  }
  return groups;
}

/** The frame that shows most of a screen: most cards, then sharpest, then first. */
export function bestFrame<T extends Hit>(group: T[]): T {
  return group.reduce((best, hit) =>
    hit.parts.length > best.parts.length ||
      (hit.parts.length === best.parts.length &&
        hit.sharpness > best.sharpness)
      ? hit
      : best
  );
}

/**
 * One frame per reward screen of a video, without near-identical repeats (a
 * replayed intro or recap shows the same screen again).
 */
export function selectFrames<T extends Hit>(
  hits: T[],
  maxGapSeconds: number,
): T[] {
  const chosen: T[] = [];
  for (const group of groupRewardScreens(hits, maxGapSeconds)) {
    const best = bestFrame(group);
    if (!chosen.some((other) => isNearDuplicate(other, best))) {
      chosen.push(best);
    }
  }
  return chosen;
}
