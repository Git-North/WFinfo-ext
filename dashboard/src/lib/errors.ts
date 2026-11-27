/**
 * The WFInfo-ext error catalog (errors/catalog.json, see errors/AGENTS.md)
 * for the dashboard: lookup, generated GEN- codes, and the GOV.UK error block.
 * A JSON import, so still zero runtime dependencies.
 */
import catalog from "../../../errors/catalog.json" with { type: "json" };
import { escapeHtml } from "./html.ts";

export interface ErrorEntry {
  code: string;
  name: string;
  area: string;
  severity: "error" | "warning" | "info";
  title: string;
  description: string;
  action: string;
  /** True for a GEN- code (no catalog entry). */
  generated: boolean;
}

interface CatalogFile {
  areas: Record<string, string>;
  generated: { words: string[] };
  errors: Omit<ErrorEntry, "generated">[];
}

const file = catalog as unknown as CatalogFile;

/** Every catalog entry, in catalog order. */
export const ERRORS: readonly ErrorEntry[] = file.errors.map((e) => ({
  ...e,
  generated: false,
}));

/** Area prefix → meaning. */
export const AREAS: Readonly<Record<string, string>> = file.areas;

const BY_CODE = new Map(ERRORS.map((e) => [e.code, e]));

const GENERATED_TEXT = {
  area: "GEN",
  severity: "error" as const,
  title: "Unexpected error",
  description:
    "An error happened that has no catalog entry. The same bug always gets the same code.",
  action:
    "Look at the crash report in crash-reports/ and report the code with it.",
  generated: true,
};

/** FNV-1a 32-bit over the UTF-8 bytes of the text. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The generated entry for `<exception type>|<site>` (rule in the catalog). */
export function generated(input: string): ErrorEntry {
  const hash = fnv1a32(input);
  const words = file.generated.words;
  const code = "GEN-" + ((hash >>> 8) & 0xffffff).toString(16).padStart(6, "0");
  const name = words.length === 0 ? "Unknown" : words[hash % words.length];
  return { code, name, ...GENERATED_TEXT };
}

/**
 * The entry for a code: the catalog entry, a generic GEN- entry (the name is
 * not recoverable from the code), or null for an empty or unknown code.
 */
export function lookup(code: string | null | undefined): ErrorEntry | null {
  if (!code) return null;
  const known = BY_CODE.get(code);
  if (known) return known;
  if (/^GEN-[0-9a-f]{6}$/.test(code)) {
    return { code, name: "Generated", ...GENERATED_TEXT };
  }
  return null;
}

/**
 * The GOV.UK error block for a scan or a dashboard failure: code, name,
 * title, description and action from the catalog, the detail text, and the
 * crash-report path when there is one. Every value is escaped.
 */
export function errorBlockHtml(
  error: string | ErrorEntry | null | undefined,
  detail: string | null | undefined,
  crashReport: string | null = null,
): string {
  const entry = typeof error === "object" && error !== null
    ? error
    : lookup(error);
  const code = typeof error === "string" ? error : entry?.code;
  const rows: string[] = [];
  if (entry) {
    rows.push(
      `<h2 class="govuk-heading-s wf-err">${escapeHtml(entry.code)} ${
        escapeHtml(entry.name)
      }: ${escapeHtml(entry.title)}</h2>`,
      `<p class="govuk-body">${escapeHtml(entry.description)}</p>`,
    );
  } else {
    const label = code ? `Error ${code}` : "Error";
    rows.push(
      `<h2 class="govuk-heading-s wf-err">${escapeHtml(label)}</h2>`,
    );
  }
  if (detail) {
    rows.push(
      `<p class="govuk-body-s">Detail: ${escapeHtml(detail)}</p>`,
    );
  }
  if (entry?.action) {
    rows.push(
      `<p class="govuk-body"><strong>What to do:</strong> ${
        escapeHtml(entry.action)
      }</p>`,
    );
  }
  if (crashReport) {
    rows.push(
      `<p class="govuk-body-s">Crash report: <code>${
        escapeHtml(crashReport)
      }</code></p>`,
    );
  }
  return `<div class="govuk-inset-text wf-error-block" data-error-code="${
    escapeHtml(entry?.code ?? code ?? "")
  }">
  ${rows.join("\n  ")}
</div>`;
}
