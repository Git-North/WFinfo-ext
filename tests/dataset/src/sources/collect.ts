/** What the three public sources share: their tools and their run report. */

import type { StoreContext, StoreOutcome } from "../ingest.ts";
import type { Scanner } from "../scanner.ts";

export interface CollectContext extends StoreContext {
  scanners: Scanner[];
  log: (line: string) => void;
}

export interface ItemReport {
  item: string;
  /** "stored", "duplicate", "no-reward-screen", "skipped" or an error code. */
  outcome: string;
  detail?: string;
}

export interface RunReport {
  startedAt: string;
  finishedAt: string | null;
  /** Images or videos downloaded. */
  downloads: number;
  downloadedBytes: number;
  /** Images given to the scanner. */
  scanned: number;
  /** Images in which the scanner read 1-4 reward names. */
  rewardScreens: number;
  stored: number;
  storedBytes: number;
  duplicates: number;
  errors: number;
  items: ItemReport[];
}

export function newReport(): RunReport {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    downloads: 0,
    downloadedBytes: 0,
    scanned: 0,
    rewardScreens: 0,
    stored: 0,
    storedBytes: 0,
    duplicates: 0,
    errors: 0,
    items: [],
  };
}

/** Counts one store outcome and says it in words. */
export function countStored(report: RunReport, outcome: StoreOutcome): string {
  if (outcome.stored) {
    report.stored++;
    report.storedBytes += outcome.bytes;
    return `stored ${outcome.id}`;
  }
  report.duplicates++;
  return `duplicate of ${outcome.duplicateOf}`;
}
