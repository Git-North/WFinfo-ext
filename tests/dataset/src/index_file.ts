/**
 * The flat index (one row per sidecar) and the category spread. Pure
 * functions.
 */

import type { Sidecar } from "./sidecar.ts";

export type Row = Record<string, string | number | boolean | null>;

const list = (values: string[]) => values.join(";");

export function indexRow(entry: Sidecar): Row {
  const c = entry.categories;
  return {
    id: entry.id,
    file: entry.image?.file ?? null,
    hasImage: entry.image !== null,
    bytes: entry.image?.bytes ?? null,
    source: entry.source.kind,
    sourceId: entry.source.itemId,
    sourceUrl: entry.source.url,
    timestampSeconds: entry.source.timestampSeconds,
    author: entry.source.author,
    license: entry.source.license,
    publishedAt: entry.source.publishedAt,
    downloadedAt: entry.source.downloadedAt,
    width: c.width,
    height: c.height,
    resolutionClass: c.resolutionClass,
    aspectRatio: c.aspectRatio,
    aspectClass: c.aspectClass,
    slotCount: c.slotCount,
    parts: list(entry.parts.map((p) => p.name)),
    rarities: list(c.rarities),
    itemTypes: list(c.itemTypes),
    sets: list(c.sets),
    anyVaulted: c.anyVaulted,
    hasForma: c.hasForma,
    theme: c.theme,
    themeConfidence: c.themeConfidence,
    textColor: entry.theme.textColor,
    uiScale: c.uiScale,
    uiScaleSource: c.uiScaleSource,
    language: c.language,
    languageSource: c.languageSource,
    ocrEngine: c.ocrEngine,
    scanMs: entry.scan.durationMs,
    captureSource: entry.scan.captureSource,
    lossySource: c.lossySource,
    sourceCodec: entry.quality.sourceCodec,
    nameSharpness: entry.quality.nameSharpness,
    namesRedacted: entry.privacy.namesRedacted,
    screen: entry.review.screen,
    reviewNote: entry.review.note,
    gameBuild: entry.game?.build ?? null,
    addedAt: entry.addedAt,
  };
}

/**
 * One CSV cell. Titles and author names come from strangers, so text that a
 * spreadsheet would run as a formula gets a leading apostrophe.
 */
export function csvCell(value: Row[string]): string {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: Row[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(",")),
  ].join("\n") + "\n";
}

const SPREAD_COLUMNS = [
  "source",
  "resolutionClass",
  "aspectClass",
  "slotCount",
  "theme",
  "themeConfidence",
  "uiScale",
  "uiScaleSource",
  "language",
  "ocrEngine",
  "sourceCodec",
  "lossySource",
  "anyVaulted",
  "hasForma",
  "namesRedacted",
  "screen",
];

/** How many rows fall in each value of each category. */
export function spread(rows: Row[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const column of [...SPREAD_COLUMNS, "rarities", "itemTypes"]) {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const raw = row[column] === null || row[column] === ""
        ? "unknown"
        : String(row[column]);
      // List columns count every member of the list.
      for (const value of raw.split(";")) {
        counts[value] = (counts[value] ?? 0) + 1;
      }
    }
    out[column] = counts;
  }
  return out;
}

export function formatSpread(rows: Row[]): string {
  const images = rows.filter((r) => r.hasImage === true);
  const bytes = images.reduce((sum, r) => sum + Number(r.bytes ?? 0), 0);
  const parts = new Set(
    images.flatMap((r) => String(r.parts).split(";")).filter((p) => p !== ""),
  );
  const lines = [
    `${images.length} images (${(bytes / 1e6).toFixed(1)} MB), ` +
    `${rows.length - images.length} records without an image, ` +
    `${parts.size} different parts`,
  ];
  for (const [column, counts] of Object.entries(spread(images))) {
    const values = Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([value, n]) => `${value} ${n}`).join(", ");
    if (values) lines.push(`  ${column.padEnd(17)} ${values}`);
  }
  return lines.join("\n");
}
