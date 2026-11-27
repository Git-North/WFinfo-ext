/** Errors, WFInfo constants, game files, part data and the command line. */

import { parseArgs } from "../src/cli.ts";
import {
  catalog,
  crashReportText,
  DatasetError,
  describeError,
  errorSite,
  fnv1a32,
  generatedCode,
} from "../src/errors.ts";
import { buildGameData } from "../src/game_data.ts";
import {
  findEeLog,
  parseEeCfg,
  parseEeLogFields,
  readGameInfo,
} from "../src/game_files.ts";
import {
  loadWfinfoConstants,
  parseWfinfoConstants,
} from "../src/wfinfo_source.ts";
import {
  assertCode,
  assertEquals,
  assertTrue,
  GAME_DATA_FILES,
} from "./helpers.ts";

Deno.test("the catalog is consistent and its vectors reproduce", () => {
  const codes = catalog.errors.map((e) => e.code);
  const names = catalog.errors.map((e) => e.name);
  assertEquals(new Set(codes).size, codes.length, "codes");
  assertEquals(new Set(names).size, names.length, "names");
  for (const entry of catalog.errors) {
    assertTrue(entry.area in catalog.areas, entry.code);
    assertTrue(entry.code.startsWith(`${entry.area}-`), entry.code);
  }
  for (const vector of catalog.generated.testVectors) {
    assertEquals(
      fnv1a32(vector.input).toString(16).padStart(8, "0"),
      vector.hash,
    );
    assertEquals(generatedCode(vector.input), {
      code: vector.code,
      name: vector.name,
    });
  }
});

Deno.test("an error names its code, its action and no home folder", () => {
  const error = new DatasetError("DST-003", "/nowhere/WFInfo.Headless.dll");
  const text = describeError(error);
  assertTrue(text.startsWith("DST-003 Chisel: Scanner not built"));
  assertTrue(text.includes("What to do:"));
});

Deno.test("crash reports redact the home folder and name the site", () => {
  const error = new TypeError("bad /home/pat/file");
  error.stack = "TypeError: bad /home/pat/file\n" +
    "    at decodeRgb (file:///home/pat/repo/tests/dataset/src/media.ts:9:3)";
  assertEquals(errorSite(error.stack), "dataset.media.decodeRgb");
  const report = crashReportText(error, new Date(0), "/home/pat");
  assertTrue(!report.text.includes("/home/pat"), report.text);
  assertEquals(
    report.code,
    generatedCode("TypeError|dataset.media.decodeRgb").code,
  );
});

Deno.test("theme colours and layout come from WFInfo/Ocr.cs", async () => {
  const { themes, layout } = await loadWfinfoConstants();
  assertEquals(themes.length, 19);
  assertEquals(themes[0], {
    name: "VITRUVIAN",
    primary: [190, 169, 102],
    secondary: [245, 227, 173],
  });
  assertEquals(themes.at(-1)?.name, "POM_2");
  assertEquals(layout, {
    rewardWidth: 968,
    rewardHeight: 235,
    rewardY: 316,
    lineHeight: 48,
  });
});

Deno.test("a changed Ocr.cs fails loudly", async () => {
  await assertCode("DST-007", () => parseWfinfoConstants("class OCR {}"));
});

Deno.test("EE.cfg gives the UI scale and listed graphics settings only", () => {
  const config = parseEeCfg([
    "[Windows_Config,/EE/Types/Base/Config]",
    "Flash.FlashDrawScale=0.77\r",
    "Graphics.TextureQuality=TQ_HIGH",
    "Graphics.HLODDistanceScale=0.80000001",
    "Graphics.Adapter=SomeGpuModel",
    "Graphics.VSyncMode=has spaces /and/paths",
    "Client.Email=person@example.com",
  ].join("\n"));
  assertEquals(config, {
    uiScale: 0.75,
    graphics: { TextureQuality: "TQ_HIGH", HLODDistanceScale: "0.80000001" },
  });
  assertEquals(parseEeCfg("x=1").uiScale, 1);
  assertEquals(parseEeCfg("Flash.FlashDrawScale=junk").uiScale, null);
  assertEquals(parseEeCfg("Flash.FlashDrawScale=9").uiScale, 1.25);
});

/** An EE.log as it starts, with the private facts it really holds. */
const SECRETS = ["pat@example.com", "203.0.113.77", "SECRET-CPU", "PatPlayer"];
const FAKE_LOG = [
  "0.001 Sys [Info]: CPU: SECRET-CPU 16 cores",
  "0.002 Net [Info]: public address 203.0.113.77",
  "0.003 Sys [Info]: Logged in PatPlayer (pat@example.com)",
  "0.004 Sys [Diag]: Command line: Warframe.x64.exe -language:de -cluster:public",
  "0.005 Sys [Diag]: Build Label: 2026.10.28.09.54/abcdef",
].join("\r\n");

Deno.test("EE.log gives two checked fields and nothing else", () => {
  assertEquals(parseEeLogFields(FAKE_LOG), {
    build: "2026.10.28.09.54",
    language: "de",
  });
  assertEquals(parseEeLogFields("-language:xx Build Label: today"), {
    build: null,
    language: null,
  });
});

Deno.test("reading the game files leaks nothing from EE.log", async () => {
  const home = await Deno.makeTempDir();
  try {
    const older = `${home}/older.log`;
    await Deno.writeTextFile(older, "old");
    const folder = `${home}/.local/share/Steam/steamapps/compatdata/230410/` +
      "pfx/drive_c/users/steamuser/AppData/Local/Warframe";
    await Deno.mkdir(folder, { recursive: true });
    await Deno.writeTextFile(`${folder}/EE.log`, FAKE_LOG);
    await Deno.writeTextFile(
      `${folder}/EE.cfg`,
      "Flash.FlashDrawScale=0.9\nGraphics.SSGI=1\n",
    );
    assertEquals(
      await findEeLog(undefined, { HOME: home }),
      `${folder}/EE.log`,
    );
    assertEquals(await findEeLog(older, { HOME: home }), older);
    assertEquals(await findEeLog(`${home}/missing`, { HOME: home }), null);
    const info = await readGameInfo(undefined, { HOME: home });
    assertEquals(info, {
      build: "2026.10.28.09.54",
      language: "de",
      uiScaleConfig: 0.9,
      graphics: { SSGI: "1" },
    });
    for (const secret of [...SECRETS, home]) {
      assertTrue(!JSON.stringify(info).includes(secret), secret);
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("parts get set, vaulted state, ducats, rarity and relics", () => {
  const data = buildGameData(GAME_DATA_FILES);
  assertEquals(data.describe("Lex Prime Barrel"), {
    name: "Lex Prime Barrel",
    slug: "lex_prime_barrel",
    set: "Lex Prime",
    component: "Barrel",
    itemType: "Secondary",
    vaulted: false,
    ducats: 15,
    platSheet: 4,
    rarity: ["common", "rare"],
    relicCount: 2,
    unvaultedRelics: ["Lith A1"],
  });
  const systems = data.describe("Octavia Prime Systems");
  assertEquals([systems.vaulted, systems.ducats, systems.rarity], [
    true,
    15,
    ["uncommon"],
  ]);
  const unknown = data.describe("Forma Blueprint");
  assertEquals([unknown.set, unknown.vaulted, unknown.relicCount], [
    null,
    null,
    0,
  ]);
});

Deno.test("the command line refuses what it does not know", async () => {
  const spec = { flags: ["watch"], values: ["limit"], lists: ["url"] };
  const args = parseArgs(
    ["youtube", "--url", "a", "--url", "b", "--limit", "7", "--watch"],
    spec,
  );
  assertEquals(args.positional, ["youtube"]);
  assertEquals(args.list("url", []), ["a", "b"]);
  assertEquals(args.integer("limit", 50, 1, 100), 7);
  assertTrue(args.flag("watch"));
  for (
    const bad of [
      ["--nope"],
      ["--limit"],
      ["--limit", "--watch"],
      ["--limit", "1", "--limit", "2"],
    ]
  ) {
    await assertCode("DST-001", () => parseArgs(bad, spec));
  }
  await assertCode(
    "DST-001",
    () => parseArgs(["--limit", "1e3"], spec).integer("limit", 1, 1, 5000),
  );
});
