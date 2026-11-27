// Tests for dashboard/src/lib/errors.ts (catalog lookup, generated codes,
// error block). Offline; no app data is read or written.
import catalog from "../../errors/catalog.json" with { type: "json" };
import {
  assertEquals,
  assertStringIncludes,
  assertTrue,
} from "../../dashboard/src/lib/testutil.ts";
import {
  AREAS,
  errorBlockHtml,
  ERRORS,
  fnv1a32,
  generated,
  lookup,
} from "../../dashboard/src/lib/errors.ts";

Deno.test("catalog codes and names are unique and every area is known", () => {
  assertEquals(new Set(ERRORS.map((e) => e.code)).size, ERRORS.length);
  assertEquals(new Set(ERRORS.map((e) => e.name)).size, ERRORS.length);
  for (const e of ERRORS) {
    assertTrue(e.area in AREAS, `${e.code}: area ${e.area}`);
    assertTrue(e.code.startsWith(`${e.area}-`), e.code);
  }
});

Deno.test("generated codes reproduce the catalog test vectors", () => {
  for (const v of catalog.generated.testVectors) {
    assertEquals(fnv1a32(v.input).toString(16).padStart(8, "0"), v.hash);
    const entry = generated(v.input);
    assertEquals([entry.code, entry.name], [v.code, v.name], v.input);
    assertTrue(entry.generated);
  }
});

Deno.test("lookup knows catalog codes, GEN codes and nothing else", () => {
  assertEquals(lookup("CAP-001")?.name, "Shutter");
  assertEquals(lookup("GEN-a121f2")?.generated, true);
  assertEquals(lookup("XYZ-999"), null);
  assertEquals(lookup(null), null);
});

Deno.test("error block shows the catalog text, escaped, and the crash report", () => {
  const html = errorBlockHtml(
    "CAP-001",
    "<b>denied</b>",
    "~/Library/Application Support/WFInfo/crash-reports/crash-x.txt",
  );
  assertStringIncludes(html, "CAP-001 Shutter: Screen Recording not allowed");
  assertStringIncludes(html, "What to do:");
  assertStringIncludes(html, "&lt;b&gt;denied&lt;/b&gt;");
  assertStringIncludes(html, "crash-reports/crash-x.txt");
  assertTrue(!html.includes("<b>denied"), "detail is escaped");
  assertStringIncludes(errorBlockHtml("XYZ-999", null), "Error XYZ-999");
});
