/**
 * The per-image JSON sidecar: what the image shows, how it was categorised,
 * where it came from and what rights apply. Sidecars are the dataset's source
 * of truth; index.csv and index.json are rebuilt from them.
 */

import type { ScanResult } from "../../../dashboard/src/lib/scan.ts";
import type { PartInfo, Rarity } from "./game_data.ts";
import type { GameInfo } from "./game_files.ts";
import {
  aspectClass,
  aspectRatio,
  type Rect,
  resolutionClass,
} from "./geometry.ts";
import type { ThemeEstimate } from "./themes.ts";

export type SourceKind = "own" | "wfinfo-ng" | "reddit" | "youtube";

export type UiScaleSource = "ee.cfg" | "record" | "estimated" | "unknown";

/** What each source's images may be used for. Facts only, no permission. */
export const RIGHTS: Record<SourceKind, string> = {
  own:
    "The user's own capture. It shows Digital Extremes' game and may show other players' names. Local use only.",
  "wfinfo-ng":
    "From knoellle/wfinfo-ng, published there under the repository licence recorded in source.license. It shows Digital Extremes' game. Local use only.",
  reddit:
    "Belongs to the person who posted it. No licence to copy or redistribute is known; Reddit's terms and Public Content Policy restrict automated collection. Local use only: do not share or publish.",
  youtube:
    "A frame of a video that belongs to its uploader. Unless source.license says otherwise, no licence to copy or redistribute is known, and YouTube's terms restrict downloading. Local use only: do not share or publish.",
};

export interface SourceInfo {
  kind: SourceKind;
  url: string | null;
  /** Reddit post id, YouTube video id or git commit. */
  itemId: string | null;
  title: string | null;
  author: string | null;
  authorUrl: string | null;
  publishedAt: string | null;
  /** Position in the video, seconds. */
  timestampSeconds: number | null;
  /** The licence exactly as the source states it; null means none stated. */
  license: string | null;
  downloadedAt: string | null;
  /** SHA-256 of the captured or downloaded bytes, before any change. */
  originalSha256: string | null;
  /** Source-specific facts, such as the video format. */
  detail: Record<string, string | number | null>;
}

export interface ImageEntry {
  /** Path below the dataset folder. */
  file: string;
  sha256: string;
  bytes: number;
  format: string;
}

export interface ScanInfo {
  startedAt: string | null;
  durationMs: number | null;
  captureSource: string | null;
  captureTarget: string | null;
  ocrEngine: string | null;
  /** The scan record does not say which compute device Vision used. */
  ocrDevice: string | null;
  scanId: string | null;
  stage: string | null;
  trigger: string | null;
  /** The theme WFInfo's probe reported (Tesseract pipeline only). */
  scannerTheme: string | null;
  error: string | null;
  errorCode: string | null;
  notice: string | null;
}

export interface Categories {
  width: number | null;
  height: number | null;
  resolutionClass: string | null;
  aspectRatio: string | null;
  aspectClass: string | null;
  /** Reward cards the scanner read: at least this many players cracked one. */
  slotCount: number;
  theme: string | null;
  themeConfidence: string;
  uiScale: number | null;
  uiScaleSource: UiScaleSource;
  language: string | null;
  languageSource: "ee.log" | "matched-english-names" | "unknown";
  ocrEngine: string | null;
  lossySource: boolean | null;
  rarities: Rarity[];
  itemTypes: string[];
  sets: string[];
  anyVaulted: boolean;
  hasForma: boolean;
}

export interface Sidecar {
  schema: 1;
  id: string;
  addedAt: string;
  image: ImageEntry | null;
  source: SourceInfo;
  rights: string;
  categories: Categories;
  scan: ScanInfo;
  parts: (PartInfo & { index: number })[];
  theme: ThemeEstimate;
  /** The user's game settings at archive time; live captures with an image. */
  game: GameInfo | null;
  quality: {
    sourceCodec: string | null;
    bitsPerPixel: number | null;
    /** Laplacian variance of the name rows; compare equal sizes only. */
    nameSharpness: number | null;
  };
  privacy: {
    /** True when the squad-name row and the chat area are masked. */
    namesRedacted: boolean;
    redactedAreas: Rect[];
    note: string;
  };
  review: Review;
  dedupe: { cardHash: string | null };
}

/** What a person saw in the image. The scanner's word alone is not proof. */
export interface Review {
  /** "reward": a reward screen; "other": a scanner false positive. */
  screen: "unreviewed" | "reward" | "other";
  note: string | null;
}

export const PRIVACY_REDACTED =
  "The squad-name row and the chat area are masked. Other places can still hold names, such as a moved chat window or a streamer's overlay.";
export const PRIVACY_AS_CAPTURED =
  "Stored as captured: the image may show other players' names.";

export interface ScanExtras {
  scanId?: string | null;
  stage?: string | null;
  trigger?: string | null;
  errorCode?: string | null;
  notice?: string | null;
}

/** The scan fields a sidecar keeps. File paths are cut to their base names. */
export function scanInfo(
  record: ScanResult,
  extras: ScanExtras = {},
): ScanInfo {
  const target = record.captureTarget;
  return {
    startedAt: Number.isFinite(record.startedMs)
      ? new Date(record.startedMs).toISOString()
      : null,
    durationMs: record.durationMs,
    captureSource: record.captureSource,
    captureTarget: target?.includes("/") || target?.includes("\\")
      ? target.split(/[/\\]/).at(-1) ?? null
      : target,
    ocrEngine: record.ocrEngine,
    ocrDevice: null,
    scanId: extras.scanId ?? null,
    stage: extras.stage ?? null,
    trigger: extras.trigger ?? null,
    scannerTheme: null,
    error: record.error?.includes("/")
      ? record.error.replace(/(?:\/[^\s/:'"]+)+\//g, "")
      : record.error,
    errorCode: extras.errorCode ?? null,
    notice: extras.notice ?? null,
  };
}

export interface SidecarInput {
  id: string;
  addedAt: Date;
  image: ImageEntry | null;
  width: number | null;
  height: number | null;
  source: SourceInfo;
  scan: ScanInfo;
  parts: PartInfo[];
  theme: ThemeEstimate;
  uiScale: number | null;
  uiScaleSource: UiScaleSource;
  language: string | null;
  languageSource: Categories["languageSource"];
  lossySource: boolean | null;
  game: GameInfo | null;
  sourceCodec: string | null;
  nameSharpness: number | null;
  redactedAreas: Rect[];
  cardHash: string | null;
}

function unique<T>(values: (T | null)[]): T[] {
  return [...new Set(values.filter((v): v is T => v !== null))].sort();
}

export function buildSidecar(input: SidecarInput): Sidecar {
  const { width, height, parts } = input;
  const sized = width !== null && height !== null && width > 0 && height > 0;
  return {
    schema: 1,
    id: input.id,
    addedAt: input.addedAt.toISOString(),
    image: input.image,
    source: input.source,
    rights: RIGHTS[input.source.kind],
    categories: {
      width: sized ? width : null,
      height: sized ? height : null,
      resolutionClass: sized ? resolutionClass(height) : null,
      aspectRatio: sized ? aspectRatio(width, height) : null,
      aspectClass: sized ? aspectClass(width, height) : null,
      slotCount: parts.length,
      theme: input.theme.name,
      themeConfidence: input.theme.confidence,
      uiScale: input.uiScale,
      uiScaleSource: input.uiScaleSource,
      language: input.language,
      languageSource: input.languageSource,
      ocrEngine: input.scan.ocrEngine,
      lossySource: input.lossySource,
      rarities: unique(parts.flatMap((p) => p.rarity)),
      itemTypes: unique(parts.map((p) => p.itemType)),
      sets: unique(parts.map((p) => p.set)),
      anyVaulted: parts.some((p) => p.vaulted === true),
      hasForma: parts.some((p) => /\bForma\b/.test(p.name)),
    },
    scan: input.scan,
    parts: parts.map((part, i) => ({ index: i + 1, ...part })),
    theme: input.theme,
    game: input.game,
    quality: {
      sourceCodec: input.sourceCodec,
      bitsPerPixel: sized && input.image
        ? Math.round(input.image.bytes * 800 / (width * height)) / 100
        : null,
      nameSharpness: input.nameSharpness,
    },
    privacy: {
      namesRedacted: input.redactedAreas.length > 0,
      redactedAreas: input.redactedAreas,
      note: input.redactedAreas.length > 0
        ? PRIVACY_REDACTED
        : PRIVACY_AS_CAPTURED,
    },
    review: { screen: "unreviewed", note: null },
    dedupe: { cardHash: input.cardHash },
  };
}
