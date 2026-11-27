/**
 * The path every downloaded image takes: the real scanner decides whether it
 * shows a reward screen, then the image is categorised, its squad-name row is
 * masked and it is stored with its sidecar, unless the dataset already has it.
 */

import type { ScanResult } from "../../../dashboard/src/lib/scan.ts";
import type { GameData } from "./game_data.ts";
import {
  cardRegion,
  chatArea,
  type Rect,
  slotNameRects,
  squadNameBand,
} from "./geometry.ts";
import { crop, differenceHash, redactAll, sharpness } from "./imaging.ts";
import { decodeRgb, encodePng, probeImage } from "./media.ts";
import type { Scanner } from "./scanner.ts";
import type { Hit } from "./selection.ts";
import { buildSidecar, scanInfo, type SourceInfo } from "./sidecar.ts";
import { type DatasetStore, sha256Hex } from "./store.ts";
import { makeTempFolder, removeTempFolder } from "./temp.ts";
import { estimateTheme } from "./themes.ts";
import type { WfinfoConstants } from "./wfinfo_source.ts";

/** A reward screen shows one card per squad member who cracked a relic. */
export const MIN_SLOTS = 1;
export const MAX_SLOTS = 4;

export interface Analysis extends Hit {
  path: string;
  record: ScanResult;
  codec: string;
  originalSha256: string;
}

/** The scale the layout used; the scanner estimated it from the text. */
export function usedUiScale(record: ScanResult): number {
  return record.uiScaling && record.uiScaling > 0 ? record.uiScaling : 1;
}

/**
 * The union of the name rectangles of every card, for the sharpness of the
 * text that the scanner has to read.
 */
function nameStrip(rects: Rect[]): Rect {
  const first = rects[0];
  const last = rects[rects.length - 1];
  return { ...first, width: last.x + last.width - first.x };
}

/** Runs the scanner on one candidate; null when it reads no reward screen. */
export async function analyze(
  path: string,
  seconds: number,
  scanner: Scanner,
  constants: WfinfoConstants,
): Promise<Analysis | null> {
  const { record } = await scanner.scan(path);
  const slots = record.choices.length;
  if (slots < MIN_SLOTS || slots > MAX_SLOTS) return null;

  const [info, image, bytes] = await Promise.all([
    probeImage(path),
    decodeRgb(path),
    Deno.readFile(path),
  ]);
  const scale = usedUiScale(record);
  const rects = slotNameRects(
    image.width,
    image.height,
    slots,
    scale,
    constants.layout,
  );
  return {
    path,
    seconds,
    record,
    codec: info.codec,
    originalSha256: await sha256Hex(bytes),
    parts: [...record.choices].sort((a, b) => a.index - b.index)
      .map((c) => c.part),
    width: image.width,
    height: image.height,
    sharpness: sharpness(crop(image, nameStrip(rects))),
    hash: differenceHash(
      crop(
        image,
        cardRegion(image.width, image.height, scale, constants.layout),
      ),
    ),
  };
}

export interface StoreContext {
  store: DatasetStore;
  constants: WfinfoConstants;
  gameData: GameData;
  /** Mask the squad-name row and the chat area. */
  redactNames: boolean;
}

const KEPT_FORMATS: Record<string, "png" | "jpg" | "webp"> = {
  png: "png",
  mjpeg: "jpg",
  webp: "webp",
};

export type StoreOutcome =
  | { stored: true; id: string; bytes: number }
  | { stored: false; duplicateOf: string };

/** Categorises one recognised download and adds it to the dataset. */
export async function storeHit(
  context: StoreContext,
  hit: Analysis,
  source: Omit<SourceInfo, "originalSha256">,
  options: { lossySource: boolean | null; sourceCodec?: string },
): Promise<StoreOutcome> {
  const { store, constants } = context;
  const duplicate = store.findDuplicate(hit.originalSha256, hit);
  if (duplicate) return { stored: false, duplicateOf: duplicate.id };

  const image = await decodeRgb(hit.path);
  const scale = usedUiScale(hit.record);
  const theme = estimateTheme(
    image,
    slotNameRects(
      image.width,
      image.height,
      hit.parts.length,
      scale,
      constants.layout,
    ),
    constants.themes,
  );

  // An image that stays as it is keeps its own bytes and format; a masked one
  // is written as PNG, which adds no further loss.
  const masks = context.redactNames
    ? [
      squadNameBand(image.width, image.height, scale, "estimated"),
      chatArea(image.width, image.height),
    ]
    : [];
  let format = KEPT_FORMATS[hit.codec];
  let bytes: Uint8Array;
  if (masks.length === 0 && format !== undefined) {
    bytes = await Deno.readFile(hit.path);
  } else {
    const folder = await makeTempFolder("encode");
    try {
      await encodePng(
        redactAll(image, masks),
        `${folder}/image.png`,
      );
      bytes = await Deno.readFile(`${folder}/image.png`);
      format = "png";
    } finally {
      await removeTempFolder(folder);
    }
  }

  const id = `${source.kind}-${hit.originalSha256.slice(0, 16)}`;
  const entry = await store.addImage(
    source.kind,
    id,
    format,
    bytes,
    (stored) =>
      buildSidecar({
        id,
        addedAt: new Date(),
        image: stored,
        width: image.width,
        height: image.height,
        source: { ...source, originalSha256: hit.originalSha256 },
        // The scan ran on a local candidate file: only its result matters.
        scan: { ...scanInfo(hit.record), captureTarget: null },
        parts: hit.parts.map((part) => context.gameData.describe(part)),
        theme,
        uiScale: scale,
        uiScaleSource: "estimated",
        // The sandbox scanner matches English item names only.
        language: "en",
        languageSource: "matched-english-names",
        lossySource: options.lossySource,
        game: null,
        sourceCodec: options.sourceCodec ?? hit.codec,
        nameSharpness: hit.sharpness,
        redactedAreas: masks,
        cardHash: hit.hash,
      }),
  );
  return { stored: true, id, bytes: entry.image!.bytes };
}
