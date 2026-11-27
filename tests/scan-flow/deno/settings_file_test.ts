/**
 * wfinfo-ext-settings.json: read rules, round trip and the atomic write
 * (dashboard/src/lib/settings.ts). Every test runs on a temporary app dir.
 */
import {
  assertEquals,
  assertTrue,
} from "../../../dashboard/src/lib/testutil.ts";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  readSettings,
  serializeSettings,
  SETTINGS_FILE,
  settingsPath,
  updateSettings,
  writeSettings,
} from "../../../dashboard/src/lib/settings.ts";
import {
  guardNotRealAppDir,
  listNames,
  withTempAppDir,
} from "./settings_testutil.ts";

Deno.test("a missing file means the defaults, with no warning", async () => {
  await withTempAppDir(async (appDir) => {
    const read = await readSettings(appDir);
    assertEquals(read.settings, {
      version: 1,
      notifications: false,
      overlayPin: false,
    });
    assertEquals(read.warning, null);
    assertEquals(read.detail, null);
  });
});

Deno.test("write then read gives the same switches", async () => {
  await withTempAppDir(async (appDir) => {
    for (
      const [notifications, overlayPin] of [
        [true, false],
        [false, true],
        [true, true],
        [false, false],
      ]
    ) {
      await writeSettings(appDir, { version: 1, notifications, overlayPin });
      const read = await readSettings(appDir);
      assertEquals(read.settings, { version: 1, notifications, overlayPin });
      assertEquals(read.warning, null);
    }
  });
});

Deno.test("the file is one line of JSON in the contract format", async () => {
  await withTempAppDir(async (appDir) => {
    await writeSettings(appDir, {
      version: 1,
      notifications: true,
      overlayPin: false,
    });
    assertEquals(
      await Deno.readTextFile(settingsPath(appDir)),
      '{"version":1,"notifications":true,"overlayPin":false}\n',
    );
    assertEquals(settingsPath(appDir), `${appDir}/${SETTINGS_FILE}`);
    assertEquals(
      serializeSettings({ ...DEFAULT_SETTINGS }),
      '{"version":1,"notifications":false,"overlayPin":false}\n',
    );
  });
});

Deno.test("an invalid file means the defaults plus SET-001", async () => {
  const invalid = [
    "",
    "not json",
    '{"version":1,"notifications":true',
    "[true,true]",
    "true",
    "null",
    '{"version":2,"notifications":true}',
    '{"version":"1","notifications":true}',
    '{"version":1,"notifications":"true"}',
    '{"version":1,"notifications":true,"overlayPin":1}',
    '{"version":1,"notifications":null}',
  ];
  await withTempAppDir(async (appDir) => {
    await Deno.mkdir(appDir, { recursive: true });
    for (const text of invalid) {
      await Deno.writeTextFile(settingsPath(appDir), text);
      const read = await readSettings(appDir);
      assertEquals(read.settings, { ...DEFAULT_SETTINGS }, text);
      assertEquals(read.warning, "SET-001", text);
      assertTrue(read.detail !== null && read.detail.length > 0, text);
      // The detail is shown on the page: never the path or the file text.
      assertTrue(!read.detail!.includes(appDir), text);
    }
  });
});

Deno.test("a folder in place of the file means SET-001", async () => {
  await withTempAppDir(async (appDir) => {
    await Deno.mkdir(settingsPath(appDir), { recursive: true });
    const read = await readSettings(appDir);
    assertEquals(read.warning, "SET-001");
    assertEquals(read.settings, { ...DEFAULT_SETTINGS });
  });
});

Deno.test("unknown keys are ignored and missing switches are off", () => {
  const read = parseSettings(
    '{"version":1,"notifications":true,"later":{"x":[1]},"theme":"dark"}',
  );
  assertEquals(read.settings, {
    version: 1,
    notifications: true,
    overlayPin: false,
  });
  assertEquals(read.warning, null);
  assertEquals(parseSettings("{}").warning, null);
  assertEquals(parseSettings('{"overlayPin":true}').settings.overlayPin, true);
  assertEquals(parseSettings('{"version":1.0}').warning, null);
});

Deno.test("the atomic write leaves no temporary file", async () => {
  await withTempAppDir(async (appDir) => {
    await writeSettings(appDir, {
      version: 1,
      notifications: true,
      overlayPin: true,
    });
    await updateSettings(appDir, { overlayPin: false });
    assertEquals(await listNames(appDir), [SETTINGS_FILE]);
  });
});

Deno.test("a failed write throws and leaves no temporary file", async () => {
  await withTempAppDir(async (appDir) => {
    // A folder at the file's path: the rename over it fails.
    await Deno.mkdir(`${settingsPath(appDir)}/blocker`, { recursive: true });
    let failed = false;
    try {
      await writeSettings(appDir, {
        version: 1,
        notifications: true,
        overlayPin: false,
      });
    } catch {
      failed = true;
    }
    assertTrue(failed, "the write must fail");
    assertEquals(await listNames(appDir), [SETTINGS_FILE]);
    assertTrue((await Deno.stat(settingsPath(appDir))).isDirectory);
  });
});

Deno.test("concurrent changes are applied one after the other", async () => {
  await withTempAppDir(async (appDir) => {
    await Promise.all([
      updateSettings(appDir, { notifications: true }),
      updateSettings(appDir, { overlayPin: true }),
    ]);
    const read = await readSettings(appDir);
    assertEquals(read.settings, {
      version: 1,
      notifications: true,
      overlayPin: true,
    });
  });
});

Deno.test("a change repairs an invalid file", async () => {
  await withTempAppDir(async (appDir) => {
    await Deno.mkdir(appDir, { recursive: true });
    await Deno.writeTextFile(settingsPath(appDir), "{broken");
    const settings = await updateSettings(appDir, { overlayPin: true });
    assertEquals(settings, {
      version: 1,
      notifications: false,
      overlayPin: true,
    });
    assertEquals((await readSettings(appDir)).warning, null);
  });
});

Deno.test("the guard refuses the real app dir", () => {
  let refused = false;
  try {
    guardNotRealAppDir("/home/u/.config/WFInfo/", ["/home/u/.config/WFInfo"]);
  } catch {
    refused = true;
  }
  assertTrue(refused);
  guardNotRealAppDir("/tmp/x/WFInfo", ["/home/u/.config/WFInfo"]);
});
