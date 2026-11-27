/**
 * The dataset folder:
 *
 *   images/<source>/<id>.<ext>   with <id>.json beside it
 *   records/<source>/<id>.json   scan records whose screenshot is gone
 *   index.csv, index.json        rebuilt from the sidecars
 *   seen.json                    source items already handled
 *   runs/                        one report per collection run
 */

import { DatasetError, describeError } from "./errors.ts";
import { indexRow, type Row, toCsv } from "./index_file.ts";
import { assertSafeOutput } from "./paths.ts";
import { type Hit, isNearDuplicate } from "./selection.ts";
import type { ImageEntry, Review, Sidecar, SourceKind } from "./sidecar.ts";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Writes a file whole: readers never see half of it. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${Deno.pid}.tmp`;
  await Deno.writeTextFile(temp, text);
  await Deno.rename(temp, path);
}

function isSidecar(value: unknown): value is Sidecar {
  const v = value as Partial<Sidecar> | null;
  return v?.schema === 1 && typeof v.id === "string" &&
    typeof v.source?.kind === "string" && Array.isArray(v.parts) &&
    typeof v.categories === "object" && typeof v.privacy === "object" &&
    typeof v.review === "object";
}

async function* jsonFiles(folder: string): AsyncGenerator<string> {
  try {
    for await (const entry of Deno.readDir(folder)) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory) yield* jsonFiles(path);
      else if (entry.name.endsWith(".json")) yield path;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export class DatasetStore {
  private constructor(
    readonly root: string,
    private readonly byId: Map<string, Sidecar>,
    private readonly seen: Record<string, string>,
  ) {}

  /** Opens the folder after checking that git cannot pick its files up. */
  static async open(root: string): Promise<DatasetStore> {
    await assertSafeOutput(root);
    await Deno.mkdir(root, { recursive: true });
    const byId = new Map<string, Sidecar>();
    for (const folder of ["images", "records"]) {
      for await (const path of jsonFiles(`${root}/${folder}`)) {
        try {
          const value = JSON.parse(await Deno.readTextFile(path));
          if (!isSidecar(value)) throw new Error("not a sidecar");
          byId.set(value.id, value);
        } catch {
          console.warn(describeError(new DatasetError("DST-018", path)));
        }
      }
    }
    let seen: Record<string, string> = {};
    try {
      seen = JSON.parse(await Deno.readTextFile(`${root}/seen.json`));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return new DatasetStore(root, byId, seen);
  }

  get entries(): Sidecar[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): Sidecar | undefined {
    return this.byId.get(id);
  }

  /** An entry with the same source bytes or a near-identical card region. */
  findDuplicate(
    originalSha256: string,
    hit?: Pick<Hit, "parts" | "hash" | "width" | "height">,
  ): Sidecar | undefined {
    return this.entries.find((entry) => {
      if (!entry.image) return false;
      if (entry.source.originalSha256 === originalSha256) return true;
      const { width, height } = entry.categories;
      return hit !== undefined && entry.source.kind !== "own" &&
        entry.dedupe.cardHash !== null && width !== null && height !== null &&
        isNearDuplicate(hit, {
          parts: entry.parts.map((p) => p.name),
          hash: entry.dedupe.cardHash,
          width,
          height,
        });
    });
  }

  /** What happened to a source item in an earlier run, if it was handled. */
  outcome(kind: SourceKind, itemKey: string): string | undefined {
    return this.seen[`${kind}:${itemKey}`];
  }

  async remember(
    kind: SourceKind,
    itemKey: string,
    outcome: string,
  ): Promise<void> {
    this.seen[`${kind}:${itemKey}`] = outcome;
    await writeAtomic(
      `${this.root}/seen.json`,
      JSON.stringify(this.seen, null, 2) + "\n",
    );
  }

  private sidecarPath(entry: Sidecar): string {
    return entry.image
      ? `${this.root}/${entry.image.file.replace(/\.[a-z0-9]+$/, ".json")}`
      : `${this.root}/records/${entry.source.kind}/${entry.id}.json`;
  }

  /**
   * Stores an image's bytes, then the sidecar that `build` makes for them. An
   * entry with the same id is replaced.
   */
  async addImage(
    kind: SourceKind,
    id: string,
    format: "png" | "jpg" | "webp",
    bytes: Uint8Array,
    build: (image: ImageEntry) => Sidecar,
  ): Promise<Sidecar> {
    const file = `images/${kind}/${id}.${format}`;
    await Deno.mkdir(`${this.root}/images/${kind}`, { recursive: true });
    const temp = `${this.root}/${file}.${Deno.pid}.tmp`;
    await Deno.writeFile(temp, bytes);
    const entry = build({
      file,
      sha256: await sha256Hex(bytes),
      bytes: bytes.length,
      format,
    });
    await this.drop(id);
    await Deno.rename(temp, `${this.root}/${file}`);
    await this.write(entry);
    return entry;
  }

  /** Records what a person saw in an entry. */
  async label(id: string, review: Review): Promise<boolean> {
    const entry = this.byId.get(id);
    if (!entry) return false;
    await this.write({ ...entry, review });
    return true;
  }

  /** Stores a sidecar that has no image. */
  async addRecord(entry: Sidecar): Promise<void> {
    await this.drop(entry.id);
    await Deno.mkdir(`${this.root}/records/${entry.source.kind}`, {
      recursive: true,
    });
    await this.write(entry);
  }

  private async write(entry: Sidecar): Promise<void> {
    await writeAtomic(
      this.sidecarPath(entry),
      JSON.stringify(entry, null, 2) + "\n",
    );
    this.byId.set(entry.id, entry);
  }

  private async drop(id: string): Promise<void> {
    const old = this.byId.get(id);
    if (!old) return;
    await Deno.remove(this.sidecarPath(old)).catch(() => {});
    if (old.image) {
      await Deno.remove(`${this.root}/${old.image.file}`).catch(() => {});
    }
    this.byId.delete(id);
  }

  rows(): Row[] {
    return this.entries.map(indexRow);
  }

  async writeIndex(): Promise<void> {
    const rows = this.rows();
    await writeAtomic(`${this.root}/index.csv`, toCsv(rows));
    await writeAtomic(
      `${this.root}/index.json`,
      JSON.stringify(rows, null, 2) + "\n",
    );
  }

  async writeRunReport(kind: SourceKind, report: unknown): Promise<string> {
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    await Deno.mkdir(`${this.root}/runs`, { recursive: true });
    const path = `${this.root}/runs/${stamp}-${kind}.json`;
    await writeAtomic(path, JSON.stringify(report, null, 2) + "\n");
    return path;
  }
}
