/**
 * LCOV to SonarQube's generic coverage format, for the languages whose LCOV
 * report SonarQube cannot read directly (the Swift helper, via llvm-cov).
 */

/** Hits per line number, per source file. */
export type LineHits = Map<string, Map<number, number>>;

/** Reads the `SF`, `DA` and `end_of_record` lines; records of one file add up. */
export function parseLcov(text: string): LineHits {
  const files: LineHits = new Map();
  let lines: Map<number, number> | undefined;
  for (const raw of text.split("\n")) {
    const row = raw.trim();
    if (row.startsWith("SF:")) {
      const path = row.slice(3);
      lines = files.get(path) ?? new Map();
      files.set(path, lines);
    } else if (row === "end_of_record") {
      lines = undefined;
    } else if (lines && row.startsWith("DA:")) {
      const [line, hits] = row.slice(3).split(",").map(Number);
      if (Number.isInteger(line) && line > 0 && Number.isFinite(hits)) {
        lines.set(line, (lines.get(line) ?? 0) + hits);
      }
    }
  }
  return files;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * The generic report for the files below `root`, with paths relative to it.
 * Files outside `root` (SDK or toolchain sources) are left out.
 */
export function toSonarGeneric(files: LineHits, root: string): string {
  const prefix = root.replaceAll("\\", "/").replace(/\/*$/, "/");
  const out = ['<coverage version="1">'];
  const paths = [...files.keys()].sort();
  for (const path of paths) {
    const normal = path.replaceAll("\\", "/");
    if (!normal.startsWith(prefix)) continue;
    out.push(`  <file path="${escapeXml(normal.slice(prefix.length))}">`);
    const lines = [...files.get(path)!].sort((a, b) => a[0] - b[0]);
    for (const [line, hits] of lines) {
      out.push(`    <lineToCover lineNumber="${line}" covered="${hits > 0}"/>`);
    }
    out.push("  </file>");
  }
  out.push("</coverage>", "");
  return out.join("\n");
}

/** Covered and total lines of the files that `keep` accepts. */
export function lineTotals(
  files: LineHits,
  keep: (path: string) => boolean = () => true,
): { covered: number; total: number } {
  let covered = 0;
  let total = 0;
  for (const [path, lines] of files) {
    if (!keep(path)) continue;
    for (const hits of lines.values()) {
      total++;
      if (hits > 0) covered++;
    }
  }
  return { covered, total };
}
