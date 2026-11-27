import {
  assertEquals,
  assertStringIncludes,
} from "../../dashboard/src/lib/testutil.ts";
import { lineTotals, parseLcov, toSonarGeneric } from "./lcov.ts";

const REPORT = [
  "SF:/repo/a/<b>.swift",
  "DA:2,0",
  "DA:1,3",
  "DA:nonsense",
  "end_of_record",
  "DA:9,1",
  "SF:/repo/a/<b>.swift",
  "DA:2,4",
  "end_of_record",
  "SF:/sdk/other.swift",
  "DA:1,0",
  "end_of_record",
  "",
].join("\r\n");

Deno.test("records of one file add up and stray rows are ignored", () => {
  const files = parseLcov(REPORT);
  assertEquals([...files.keys()], ["/repo/a/<b>.swift", "/sdk/other.swift"]);
  assertEquals([...files.get("/repo/a/<b>.swift")!], [[2, 4], [1, 3]]);
});

Deno.test("the generic report has repo-relative, escaped, sorted lines", () => {
  const xml = toSonarGeneric(parseLcov(REPORT), "/repo/");
  assertEquals(
    xml,
    [
      '<coverage version="1">',
      '  <file path="a/&lt;b&gt;.swift">',
      '    <lineToCover lineNumber="1" covered="true"/>',
      '    <lineToCover lineNumber="2" covered="true"/>',
      "  </file>",
      "</coverage>",
      "",
    ].join("\n"),
  );
});

Deno.test("an uncovered line is reported as uncovered", () => {
  const xml = toSonarGeneric(parseLcov(REPORT), "/sdk");
  assertStringIncludes(xml, '<lineToCover lineNumber="1" covered="false"/>');
});

Deno.test("totals count covered lines of the chosen files", () => {
  const files = parseLcov(REPORT);
  assertEquals(lineTotals(files), { covered: 2, total: 3 });
  assertEquals(lineTotals(files, (p) => p.startsWith("/sdk")), {
    covered: 0,
    total: 1,
  });
});
