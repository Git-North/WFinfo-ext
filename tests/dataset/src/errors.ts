/**
 * Errors of the dataset tools. Codes, titles and actions come from the shared
 * catalog `errors/catalog.json` (rules in `errors/AGENTS.md`); this module only
 * reads it. An error with no entry gets a generated `GEN-xxxxxx` code and a
 * crash report in `<app dir>/crash-reports/`.
 */

export interface CatalogEntry {
  code: string;
  name: string;
  area: string;
  severity: "error" | "warning" | "info";
  title: string;
  description: string;
  action: string;
}

export interface Catalog {
  areas: Record<string, string>;
  generated: {
    words: string[];
    testVectors: { input: string; hash: string; code: string; name: string }[];
  };
  errors: CatalogEntry[];
}

export const CATALOG_PATH = new URL(
  "../../../errors/catalog.json",
  import.meta.url,
);

export const catalog: Catalog = JSON.parse(
  Deno.readTextFileSync(CATALOG_PATH),
);

const byCode = new Map(catalog.errors.map((e) => [e.code, e]));

/** A failure the catalog knows. `detail` says what failed this time. */
export class DatasetError extends Error {
  readonly entry: CatalogEntry;

  constructor(readonly code: string, readonly detail = "") {
    const entry = byCode.get(code);
    if (entry === undefined) throw new Error(`unknown error code ${code}`);
    super(`${code} ${entry.name}: ${entry.title}`);
    this.name = "DatasetError";
    this.entry = entry;
  }
}

/** The console text of a known error: code and name, detail, what to do. */
export function describeError(error: DatasetError): string {
  const detail = error.detail === "" ? "" : `\n  ${redactHome(error.detail)}`;
  return `${error.message}${detail}\n  What to do: ${error.entry.action}`;
}

/** FNV-1a, 32 bit, over the UTF-8 bytes. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The generated code and name for `<error type>|<site>` (catalog rule). */
export function generatedCode(input: string): { code: string; name: string } {
  const hash = fnv1a32(input);
  const words = catalog.generated.words;
  return {
    code: "GEN-" + ((hash >>> 8) & 0xffffff).toString(16).padStart(6, "0"),
    name: words[hash % words.length],
  };
}

/**
 * The innermost stack frame inside the dataset tools, as
 * `dataset.<file>.<function>` (no line numbers, so an edit keeps the code).
 */
export function errorSite(stack: string | undefined): string {
  for (const line of (stack ?? "").split("\n")) {
    const frame = /^\s*at (?:async )?(?:([^\s(]+) )?\(?(\S+?):\d+:\d+\)?$/.exec(
      line,
    );
    const file = frame?.[2].match(/\/tests\/dataset\/(?:.*\/)?([^/]+)\.ts$/);
    if (file) return `dataset.${file[1]}.${frame?.[1] ?? "<module>"}`;
  }
  return "";
}

/** Replaces the user's home directory with `~` (catalog: no personal data). */
export function redactHome(
  text: string,
  home: string | undefined = Deno.env.get("HOME"),
): string {
  if (!home || home === "/") return text;
  return text.replaceAll(home, "~");
}

export function crashReportText(
  error: unknown,
  now: Date,
  home?: string,
): { code: string; name: string; text: string } {
  const type = error instanceof Error ? error.constructor.name : typeof error;
  const stack = error instanceof Error ? error.stack ?? "" : "";
  const message = error instanceof Error ? error.message : String(error);
  const { code, name } = generatedCode(`${type}|${errorSite(stack)}`);
  const text = redactHome(
    [
      "---- WFInfo-ext Crash Report ----",
      "",
      `Time: ${now.toISOString()}`,
      `Description: ${code} ${name}: unexpected error in the dataset tools`,
      "",
      stack || `${type}: ${message}`,
      "",
      "-- System Details --",
      `OS: ${Deno.build.os} ${Deno.build.arch}`,
      `Runtime: Deno ${Deno.version.deno}`,
      "Component: dataset",
      "",
    ].join("\n"),
    home,
  );
  return { code, name, text };
}

/** Writes the crash report and returns its console summary. */
export async function reportCrash(
  error: unknown,
  appDir: string,
  now = new Date(),
): Promise<string> {
  const report = crashReportText(error, now);
  const stamp = now.toISOString().slice(0, 19).replace("T", "_")
    .replaceAll(":", ".");
  const folder = `${appDir}/crash-reports`;
  const path = `${folder}/crash-${stamp}-dataset.txt`;
  const message = error instanceof Error ? error.message : String(error);
  const head = `${report.code} ${report.name}: ${redactHome(message)}`;
  try {
    await Deno.mkdir(folder, { recursive: true });
    await Deno.writeTextFile(path, report.text);
    return `${head}\n  Crash report: ${redactHome(path)}`;
  } catch {
    return `${head}\n${report.text}`;
  }
}
