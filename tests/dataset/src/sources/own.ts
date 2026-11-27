/**
 * Archives the user's own scans. It only reads what the scanner already wrote
 * (scans/latest.json, scans/last.png, the scan-*.json history, debug.log) and
 * the game's EE.cfg and EE.log; it changes none of them and never touches the
 * game.
 *
 * Only the newest record still has its screenshot: every scan overwrites
 * last.png. Older records are kept without an image. `--watch` archives each
 * scan as it appears.
 */

import {
  parseScanResult,
  type ScanResult,
} from "../../../../dashboard/src/lib/scan.ts";
import { DatasetError, describeError } from "../errors.ts";
import type { GameData } from "../game_data.ts";
import type { GameInfo } from "../game_files.ts";
import {
  cardRegion,
  chatArea,
  slotNameRects,
  squadNameBand,
} from "../geometry.ts";
import { crop, differenceHash, redactAll, sharpness } from "../imaging.ts";
import { decodeRgb, encodePng } from "../media.ts";
import {
  buildSidecar,
  type ScanExtras,
  scanInfo,
  type SourceInfo,
  type UiScaleSource,
} from "../sidecar.ts";
import { type DatasetStore, sha256Hex } from "../store.ts";
import { makeTempFolder, removeTempFolder } from "../temp.ts";
import { estimateTheme, type ThemeEstimate } from "../themes.ts";
import type { WfinfoConstants } from "../wfinfo_source.ts";

export interface FileTimes {
  modifiedMs: number;
  /** Inode change time (a rename sets it); null where the OS has none. */
  changedMs: number | null;
}

/** Clocks of one scan may differ by file-system time-stamp rounding. */
const SLACK_MS = 2000;

/**
 * Null when the screenshot belongs to the record, else why not. The runner
 * writes the screenshot before the record and publishes it first, so neither
 * of its times may be later than the record's, and one of them must fall
 * after the scan started.
 */
export function pairProblem(
  record: ScanResult,
  image: FileTimes & { width: number; height: number },
  recordFile: FileTimes,
): string | null {
  const path = record.screenshotPath?.replaceAll("\\", "/");
  if (!path?.endsWith("/scans/last.png")) {
    return "the record does not point to scans/last.png";
  }
  if (
    image.width !== record.screenshotWidth ||
    image.height !== record.screenshotHeight
  ) {
    return "last.png has another size than the record";
  }
  if (
    image.modifiedMs > recordFile.modifiedMs + SLACK_MS ||
    (image.changedMs !== null && recordFile.changedMs !== null &&
      image.changedMs > recordFile.changedMs + SLACK_MS)
  ) {
    return "last.png is newer than the record";
  }
  const latest = Math.max(image.modifiedMs, image.changedMs ?? 0);
  if (!(latest >= record.startedMs - SLACK_MS)) {
    return "last.png is older than the scan";
  }
  return null;
}

/**
 * The UI-scale estimates debug.log notes between two moments. The log's date
 * order follows the machine's locale, so both orders are tried.
 */
export function scaleEstimates(
  log: string,
  fromMs: number,
  toMs: number,
): number[] {
  const pattern =
    /^\[(\d{1,2})[./](\d{1,2})[./](\d{4}) (\d{1,2}):(\d{2}):(\d{2})[^\]]*\]\s*Reward layout: ui scale estimated (\d+[.,]\d+)/gm;
  const found: number[] = [];
  for (const m of log.matchAll(pattern)) {
    const [a, b, year, hour, minute, second] = m.slice(1, 7).map(Number);
    const inWindow = [[a, b], [b, a]].some(([day, month]) => {
      const time = Date.UTC(year, month - 1, day, hour, minute, second);
      // The log keeps whole seconds.
      return time >= fromMs - 1000 && time <= toMs + 1000;
    });
    if (inWindow) found.push(Number(m[7].replace(",", ".")));
  }
  return found;
}

/** Whether the record's image came from this machine's screen. */
export function isLiveCapture(record: ScanResult): boolean {
  return record.captureSource !== null && record.captureSource !== "file";
}

export function uiScaleOrigin(
  record: ScanResult,
  estimates: number[],
  game: GameInfo | null,
): UiScaleSource {
  const scale = record.uiScaling;
  if (scale === null || scale <= 0) return "unknown";
  if (estimates.some((e) => Math.abs(e - scale) <= 0.051)) return "estimated";
  if (isLiveCapture(record) && game?.uiScaleConfig === scale) return "ee.cfg";
  return "record";
}

function extrasOf(raw: unknown): ScanExtras {
  const o = raw as Record<string, unknown>;
  const text = (key: string) =>
    typeof o[key] === "string" && o[key] !== "" ? o[key] as string : null;
  return {
    scanId: text("ScanId"),
    stage: text("Stage"),
    trigger: text("Trigger"),
    errorCode: text("ErrorCode"),
    notice: text("Notice"),
  };
}

export interface OwnRecord {
  record: ScanResult;
  extras: ScanExtras;
}

export function parseOwnRecord(text: string): OwnRecord | null {
  try {
    const raw = JSON.parse(text);
    const record = parseScanResult(raw);
    return record && Number.isFinite(record.startedMs)
      ? { record, extras: extrasOf(raw) }
      : null;
  } catch {
    return null;
  }
}

/** One scan keeps one id; its fast and deep records share it. */
export function ownId({ record, extras }: OwnRecord): string {
  const key = extras.scanId ?? new Date(record.startedMs).toISOString();
  return `own-${key.replace(/[^0-9A-Za-z]/g, "")}`;
}

/** An image beats a record alone; the deep pass beats the fast one. */
function rank(hasImage: boolean, stage: string | null | undefined): number {
  return (hasImage ? 2 : 0) + (stage === "deep" ? 1 : 0);
}

export interface OwnContext {
  appDir: string;
  store: DatasetStore;
  constants: WfinfoConstants;
  gameData: GameData;
  /** Reads EE.log and EE.cfg; called for live captures only. */
  game: () => Promise<GameInfo | null>;
  redactNames: boolean;
}

async function times(path: string): Promise<FileTimes> {
  const stat = await Deno.stat(path);
  return {
    modifiedMs: stat.mtime?.getTime() ?? 0,
    changedMs: stat.ctime?.getTime() ?? null,
  };
}

const LOG_TAIL_BYTES = 512 * 1024;

async function readTail(path: string, limit: number): Promise<string> {
  try {
    using file = await Deno.open(path, { read: true });
    const size = (await file.stat()).size;
    await file.seek(Math.max(0, size - limit), Deno.SeekMode.Start);
    const buffer = new Uint8Array(Math.min(size, limit));
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer.subarray(length));
      if (read === null) break;
      length += read;
    }
    return new TextDecoder().decode(buffer.subarray(0, length));
  } catch {
    return "";
  }
}

interface LatestScan extends OwnRecord {
  png: Uint8Array | null;
  recordFile: FileTimes;
  imageFile: FileTimes | null;
}

/**
 * latest.json with the screenshot as one consistent pair: when the record
 * changes while the screenshot is read, both are read again.
 */
async function readLatest(scans: string): Promise<LatestScan | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let text: string;
    let recordFile: FileTimes;
    try {
      recordFile = await times(`${scans}/latest.json`);
      text = await Deno.readTextFile(`${scans}/latest.json`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
    let png: Uint8Array | null = null;
    let imageFile: FileTimes | null = null;
    try {
      imageFile = await times(`${scans}/last.png`);
      png = await Deno.readFile(`${scans}/last.png`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const after = await times(`${scans}/latest.json`);
    const parsed = parseOwnRecord(text);
    if (parsed && after.modifiedMs === recordFile.modifiedMs) {
      return { ...parsed, png, imageFile, recordFile };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

const NO_THEME: ThemeEstimate = {
  name: null,
  confidence: "none",
  textColor: null,
  matched: null,
  distance: null,
  ambiguousWith: [],
};

function ownSource(sha: string | null): SourceInfo {
  return {
    kind: "own",
    url: null,
    itemId: null,
    title: null,
    author: null,
    authorUrl: null,
    publishedAt: null,
    timestampSeconds: null,
    license: null,
    downloadedAt: null,
    originalSha256: sha,
    detail: {},
  };
}

/**
 * Adds one scan, with its screenshot when `pair` holds it. Returns what
 * happened: "added", "updated" or "known".
 */
async function archiveScan(
  context: OwnContext,
  scan: OwnRecord,
  pair: { png: Uint8Array; path: string } | null,
  log: string,
): Promise<"added" | "updated" | "known"> {
  const { record, extras } = scan;
  const { store, constants } = context;
  const id = ownId(scan);
  const existing = store.get(id);
  if (
    existing &&
    rank(existing.image !== null, existing.scan.stage) >=
      rank(pair !== null, extras.stage)
  ) {
    return "known";
  }
  const sha = pair ? await sha256Hex(pair.png) : null;
  // The same screenshot under another record (a repeated --file scan).
  const same = sha ? store.findDuplicate(sha) : undefined;
  if (same && same.id !== id) return "known";

  // Today's settings describe a screenshot taken just now. An older record
  // without its screenshot may come from other settings, so it gets none.
  const game = pair && isLiveCapture(record) ? await context.game() : null;
  const finished = record.finishedMs ?? record.startedMs;
  const scaleSource = uiScaleOrigin(
    record,
    scaleEstimates(log, record.startedMs, finished),
    game,
  );
  const scale = record.uiScaling && record.uiScaling > 0
    ? record.uiScaling
    : null;
  const parts = [...record.choices].sort((a, b) => a.index - b.index)
    .map((c) => context.gameData.describe(c.part));
  const info = scanInfo(record, extras);

  const common = {
    id,
    addedAt: new Date(),
    scan: info,
    parts,
    uiScale: scale,
    uiScaleSource: scaleSource,
    language: game?.language ?? null,
    languageSource: game?.language ? "ee.log" as const : "unknown" as const,
    game,
    source: ownSource(sha),
  };

  if (pair === null) {
    await store.addRecord(buildSidecar({
      ...common,
      image: null,
      width: record.screenshotWidth,
      height: record.screenshotHeight,
      theme: NO_THEME,
      lossySource: null,
      sourceCodec: null,
      nameSharpness: null,
      redactedAreas: [],
      cardHash: null,
    }));
    return existing ? "updated" : "added";
  }

  const image = await decodeRgb(pair.path);
  const slots = Math.min(4, parts.length);
  const rects = slots > 0
    ? slotNameRects(
      image.width,
      image.height,
      slots,
      scale ?? 1,
      constants.layout,
    )
    : [];
  const masks = context.redactNames
    ? [
      squadNameBand(image.width, image.height, scale, scaleSource),
      chatArea(image.width, image.height),
    ]
    : [];
  let bytes = pair.png;
  if (masks.length > 0) {
    const folder = await makeTempFolder("encode");
    try {
      await encodePng(redactAll(image, masks), `${folder}/image.png`);
      bytes = await Deno.readFile(`${folder}/image.png`);
    } finally {
      await removeTempFolder(folder);
    }
  }
  await store.addImage("own", id, "png", bytes, (stored) =>
    buildSidecar({
      ...common,
      image: stored,
      width: image.width,
      height: image.height,
      theme: estimateTheme(image, rects, constants.themes),
      // A live capture is lossless; a --file input has an unknown history.
      lossySource: isLiveCapture(record) ? false : null,
      sourceCodec: "png",
      nameSharpness: rects.length ? sharpness(crop(image, rects[0])) : null,
      redactedAreas: masks,
      cardHash: slots > 0
        ? differenceHash(
          crop(
            image,
            cardRegion(
              image.width,
              image.height,
              scale ?? 1,
              constants.layout,
            ),
          ),
        )
        : null,
    }));
  return existing ? "updated" : "added";
}

export interface ArchiveReport {
  added: number;
  updated: number;
  known: number;
  withoutImage: number;
}

/** One pass: the newest scan with its screenshot, then the older records. */
export async function archiveOnce(
  context: OwnContext,
  options: { history: boolean },
): Promise<ArchiveReport> {
  const scans = `${context.appDir}/scans`;
  const report = { added: 0, updated: 0, known: 0, withoutImage: 0 };
  const log = await readTail(`${context.appDir}/debug.log`, LOG_TAIL_BYTES);
  const latest = await readLatest(scans);

  const add = async (
    scan: OwnRecord,
    pair: { png: Uint8Array; path: string } | null,
  ) => {
    const outcome = await archiveScan(context, scan, pair, log);
    report[outcome]++;
    if (outcome !== "known" && pair === null) report.withoutImage++;
  };

  if (latest) {
    const folder = await makeTempFolder("own");
    try {
      let pair: { png: Uint8Array; path: string } | null = null;
      let problem = "there is no scans/last.png";
      if (latest.png && latest.imageFile) {
        // Work on a copy, so a new scan cannot change the bytes under us.
        const path = `${folder}/last.png`;
        await Deno.writeFile(path, latest.png);
        const { width, height } = await decodeRgb(path);
        const reason = pairProblem(
          latest.record,
          { ...latest.imageFile, width, height },
          latest.recordFile,
        );
        if (reason === null) pair = { png: latest.png, path };
        else problem = reason;
      }
      if (pair === null && !context.store.get(ownId(latest))?.image) {
        console.warn(describeError(new DatasetError("DST-016", problem)));
      }
      await add(latest, pair);
    } finally {
      await removeTempFolder(folder);
    }
  }

  if (options.history) {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(scans)) {
        if (/^scan-[0-9_]+\.json$/.test(entry.name)) names.push(entry.name);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    for (const name of names.sort()) {
      const scan = parseOwnRecord(await Deno.readTextFile(`${scans}/${name}`));
      if (!scan) continue;
      // The newest record was handled above, with its screenshot.
      if (latest && ownId(scan) === ownId(latest)) continue;
      await add(scan, null);
    }
  }

  if (!latest && report.added + report.updated + report.known === 0) {
    throw new DatasetError("DST-015", scans);
  }
  return report;
}

/**
 * Archives every new scan until `signal` aborts. File events wake it; a slow
 * poll covers a missed event or a scans folder that does not exist yet.
 */
export async function watchScans(
  context: OwnContext,
  signal: AbortSignal,
  onArchived: (report: ArchiveReport) => Promise<void>,
): Promise<void> {
  const scans = `${context.appDir}/scans`;
  let wake: () => void = () => {};
  let watcher: Deno.FsWatcher | null = null;
  signal.addEventListener("abort", () => wake());

  const listen = () => {
    try {
      watcher = Deno.watchFs(scans, { recursive: false });
    } catch {
      return; // the folder is not there yet: the poll finds it
    }
    const current = watcher;
    (async () => {
      for await (const event of current) {
        if (event.paths.some((p) => p.endsWith("latest.json"))) wake();
      }
    })().catch(() => {});
  };

  let lastSeen = "";
  try {
    while (!signal.aborted) {
      if (!watcher) listen();
      let stamp = "";
      try {
        stamp = String((await times(`${scans}/latest.json`)).modifiedMs);
      } catch {
        // no scan yet
      }
      if (stamp !== "" && stamp !== lastSeen) {
        try {
          const report = await archiveOnce(context, { history: false });
          lastSeen = stamp;
          if (report.added + report.updated > 0) await onArchived(report);
        } catch (error) {
          if (!(error instanceof DatasetError)) throw error;
          console.warn(describeError(error));
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        wake = () => {
          clearTimeout(timer);
          // Let the runner finish publishing the pair.
          setTimeout(resolve, 250);
        };
      });
    }
  } finally {
    (watcher as Deno.FsWatcher | null)?.close();
  }
}
