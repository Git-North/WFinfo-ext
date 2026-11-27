import { assertEquals, assertStringIncludes, assertTrue } from "./testutil.ts";
import {
  type CommandOutput,
  type CommandRunner,
  discoverTargets,
  macDisplayLabel,
  macWindowLabel,
  parseMacDisplays,
  parseMacWindows,
  parseMangoWindows,
  parseRandrDisplays,
  parseRandrTextDisplays,
  parseToken,
  parseToplevelNames,
  regionOf,
  remoteClient,
  resolveCapture,
  type ScanTargets,
  toOptions,
  withheldTargets,
} from "./targets.ts";

/** A stand-in host: file name + first argument → canned output. */
function fakeRunner(
  responses: Record<string, CommandOutput>,
): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      run(file, args) {
        const key = `${file} ${args.join(" ")}`.trim();
        calls.push(key);
        return Promise.resolve(
          responses[key] ?? { code: null, stdout: "" },
        );
      },
    },
  };
}

Deno.test("wlr-randr JSON becomes displays with size and layout position", () => {
  const displays = parseRandrDisplays([
    {
      name: "DP-2",
      model: "HUAWEI AD80HW",
      enabled: true,
      position: { x: 1920, y: 0 },
      scale: 1,
      modes: [
        { width: 1280, height: 720, current: false },
        { width: 1920, height: 1080, current: true },
      ],
    },
    {
      name: "HDMI-A-1",
      enabled: false,
      position: { x: 0, y: 0 },
      modes: [{ width: 1920, height: 1080, current: true }],
    },
  ]);

  assertEquals(displays.length, 1, "a disabled output is not capturable");
  assertEquals(displays[0], {
    name: "DP-2",
    model: "HUAWEI AD80HW",
    width: 1920,
    height: 1080,
    x: 1920,
    y: 0,
  });
});

Deno.test("wlr-randr JSON without a current mode keeps the name", () => {
  const displays = parseRandrDisplays([{ name: "DP-1", enabled: true }]);

  assertEquals(displays, [{
    name: "DP-1",
    model: null,
    width: null,
    height: null,
    x: null,
    y: null,
  }]);
});

Deno.test("plain wlr-randr text yields enabled output names", () => {
  const text = [
    'DP-2 "Huawei Technologies Co., Inc. HUAWEI AD80HW (DP-2)"',
    "  Make: Huawei Technologies Co., Inc.",
    "  Enabled: yes",
    'HDMI-A-1 "Unknown (HDMI-A-1)"',
    "  Enabled: no",
    'DP-1 "AOC 24G2W1G3- (DP-1)"',
    "  Enabled: yes",
  ].join("\n");

  assertEquals(parseRandrTextDisplays(text).map((d) => d.name), [
    "DP-2",
    "DP-1",
  ]);
});

Deno.test("mango client list becomes windows with a capture rectangle", () => {
  const windows = parseMangoWindows({
    clients: [
      {
        id: 4,
        appid: "com.mitchellh.ghostty",
        title: "NIXPC: dendritic",
        monitor: "DP-1",
        x: 10,
        y: 44,
        width: 1900,
        height: 1026,
        is_focused: true,
        is_visible: true,
      },
      {
        id: 7,
        appid: "steam_app_230410",
        title: "Warframe",
        monitor: "DP-2",
        x: 1920,
        y: 0,
        width: 1920,
        height: 1080,
        is_focused: false,
        is_visible: true,
      },
      {
        id: 9,
        appid: "hidden",
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        is_visible: false,
      },
      { id: 11, appid: "minimized", x: 0, y: 0, width: 0, height: 0 },
    ],
  });

  assertEquals(windows.map((w) => w.id), ["4", "7"], "visible clients only");
  assertEquals(windows[1], {
    id: "7",
    appId: "steam_app_230410",
    title: "Warframe",
    monitor: "DP-2",
    x: 1920,
    y: 0,
    width: 1920,
    height: 1080,
    focused: false,
  });
  assertTrue(windows[0].focused, "the focused window sorts first");
});

Deno.test("wlrctl toplevel names are readable but carry no geometry", () => {
  assertEquals(
    parseToplevelNames(
      "com.mitchellh.ghostty: NIXPC: dendritic\nsteam_app_230410: Warframe\n",
    ),
    ["com.mitchellh.ghostty — NIXPC: dendritic", "steam_app_230410 — Warframe"],
  );
});

Deno.test("discovery reads displays and windows from this host", async () => {
  const { runner, calls } = fakeRunner({
    "wlr-randr --json": {
      code: 0,
      stdout: JSON.stringify([{
        name: "DP-1",
        enabled: true,
        position: { x: 0, y: 0 },
        modes: [{ width: 1920, height: 1080, current: true }],
      }]),
    },
    "mmsg get all-clients": {
      code: 0,
      stdout: JSON.stringify({
        clients: [{
          id: 4,
          appid: "steam_app_230410",
          title: "Warframe",
          monitor: "DP-1",
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
          is_focused: true,
        }],
      }),
    },
  });

  const targets = await discoverTargets(runner, { os: "linux" });

  assertEquals(targets.displays.map((d) => d.name), ["DP-1"]);
  assertEquals(targets.windows.map((w) => w.id), ["4"]);
  assertEquals(targets.notes, []);
  assertEquals(calls, ["wlr-randr --json", "mmsg get all-clients"]);
});

Deno.test("discovery without compositor tools reports what is missing", async () => {
  const { runner } = fakeRunner({});

  const targets = await discoverTargets(runner, { os: "linux" });

  assertEquals(targets.displays, []);
  assertEquals(targets.windows, []);
  assertEquals(targets.notes.length, 2);
  assertStringIncludes(targets.notes[0], "wlr-randr is not on PATH");
  assertStringIncludes(targets.notes[1], "mmsg");
});

Deno.test("discovery names windows it cannot place when only wlrctl answers", async () => {
  const { runner } = fakeRunner({
    "wlrctl toplevel list": {
      code: 0,
      stdout: "steam_app_230410: Warframe\n",
    },
  });

  const targets = await discoverTargets(runner, { os: "linux" });

  assertEquals(targets.windows, []);
  assertStringIncludes(targets.notes.join(" "), "steam_app_230410 — Warframe");
});

const host: ScanTargets = {
  displays: [{
    name: "DP-2",
    model: "HUAWEI AD80HW",
    width: 1920,
    height: 1080,
    x: 1920,
    y: 0,
  }],
  windows: [{
    id: "7",
    appId: "steam_app_230410",
    title: "Warframe",
    monitor: "DP-2",
    x: 1930,
    y: 44,
    width: 1900,
    height: 1026,
    focused: true,
  }],
  notes: [],
};

Deno.test("a chosen window becomes the grim region of its frame", () => {
  const resolution = resolveCapture(host, "", "window:7");

  assertTrue(resolution.ok);
  if (!resolution.ok) return;
  assertEquals(resolution.capture.args, ["--region", "1930,44 1900x1026"]);
  assertStringIncludes(resolution.capture.label, "steam_app_230410");
  assertStringIncludes(resolution.capture.label, "Warframe");
});

Deno.test("a window wins over the display it sits on", () => {
  const resolution = resolveCapture(host, "display:DP-2", "window:7");

  assertTrue(resolution.ok);
  if (!resolution.ok) return;
  assertEquals(resolution.capture.args[0], "--region");
});

Deno.test("a chosen display becomes the grim output", () => {
  const resolution = resolveCapture(host, "display:DP-2", "");

  assertTrue(resolution.ok);
  if (!resolution.ok) return;
  assertEquals(resolution.capture, {
    args: ["--output", "DP-2"],
    label: "DP-2",
  });
});

Deno.test("no choice leaves the runner its own every-output default", () => {
  const resolution = resolveCapture(host, "", "");

  assertTrue(resolution.ok);
  if (!resolution.ok) return;
  assertEquals(resolution.capture.args, []);
});

Deno.test("a stale window or display is refused, never substituted", () => {
  const gone = resolveCapture(host, "", "window:42");
  assertTrue(!gone.ok);
  if (gone.ok) return;
  assertStringIncludes(gone.error, "not open any more");

  const unplugged = resolveCapture(host, "display:HDMI-A-1", "");
  assertTrue(!unplugged.ok);
  if (unplugged.ok) return;
  assertStringIncludes(unplugged.error, "not connected any more");

  const nonsense = resolveCapture(host, "", "window:7; rm -rf /");
  assertTrue(!nonsense.ok, "a token that is not a token is refused");

  const wrongKind = resolveCapture(host, "", "display:DP-2");
  assertTrue(!wrongKind.ok, "a display token in the window field is refused");
});

Deno.test("tokens round-trip and reject anything else", () => {
  assertEquals(parseToken("display:DP-2"), { kind: "display", name: "DP-2" });
  assertEquals(parseToken("window:7"), { kind: "window", id: "7" });
  assertEquals(parseToken("window:$(whoami)"), null);
  assertEquals(parseToken(""), null);

  const options = toOptions(host);
  assertEquals(options.displays[0].value, "display:DP-2");
  assertStringIncludes(options.displays[0].label, "1920×1080");
  assertEquals(options.windows[0].value, "window:7");
  assertEquals(regionOf(1930, 44, 1900, 1026), "1930,44 1900x1026");
});

/* ------------------------------------------------------------------ */
/* macOS: the wfinfo-mac helper                                        */
/* ------------------------------------------------------------------ */

const HELPER = "/repo/headless/bin/Debug/net9.0/wfinfo-mac";

/** `wfinfo-mac displays` as the helper prints it: points plus pixels. */
const macDisplaysJson = [
  {
    id: 3,
    name: "LG HDR 4K",
    main: false,
    builtin: false,
    x: 1728,
    y: -200,
    width: 2560,
    height: 1440,
    pixelWidth: 5120,
    pixelHeight: 2880,
  },
  {
    id: 1,
    name: "Built-in Retina Display",
    main: true,
    builtin: true,
    x: 0,
    y: 0,
    width: 1728,
    height: 1117,
    pixelWidth: 3456,
    pixelHeight: 2234,
  },
];

/** `wfinfo-mac windows`: layer-0 windows; titles empty without permission. */
const macWindowsJson = [
  {
    id: 81,
    owner: "Claude",
    pid: 1339,
    title: "",
    x: 0,
    y: 33,
    width: 1728,
    height: 1084,
    frontmost: false,
  },
  {
    id: 512,
    owner: "wine64-preloader",
    pid: 4242,
    title: "Warframe",
    x: 0,
    y: 0,
    width: 1728,
    height: 1117,
    frontmost: true,
  },
  {
    id: 40,
    owner: "Finder",
    pid: 750,
    title: "",
    x: 404,
    y: 188,
    width: 920,
    height: 464,
    frontmost: false,
  },
  { id: 9, owner: "Broken", x: 0, y: 0, width: 0, height: 10 },
  { owner: "No id", x: 0, y: 0, width: 400, height: 300 },
];

Deno.test("wfinfo-mac displays become id-named displays, main first", () => {
  const displays = parseMacDisplays(macDisplaysJson);

  assertEquals(displays.map((d) => d.name), ["1", "3"]);
  assertEquals(displays[0], {
    name: "1",
    model: "Built-in Retina Display",
    width: 1728,
    height: 1117,
    x: 0,
    y: 0,
    main: true,
  });
  assertEquals(
    macDisplayLabel(displays[0]),
    "Built-in Retina Display · 1728×1117 pt · main",
  );
  assertEquals(macDisplayLabel(displays[1]), "LG HDR 4K · 2560×1440 pt");
  assertEquals(parseMacDisplays({ id: 1 }), [], "not an array");
});

Deno.test("wfinfo-mac windows sort frontmost first, then by owner", () => {
  const windows = parseMacWindows(macWindowsJson);

  assertEquals(windows.map((w) => w.id), ["512", "81", "40"]);
  assertEquals(windows.map((w) => w.appId), [
    "wine64-preloader",
    "Claude",
    "Finder",
  ]);
  assertEquals(
    macWindowLabel(windows[0]),
    "wine64-preloader · Warframe (1728×1117 pt) · frontmost",
  );
  assertEquals(macWindowLabel(windows[2]), "Finder (920×464 pt)");
});

Deno.test("macOS discovery asks the helper for displays and windows", async () => {
  const { runner, calls } = fakeRunner({
    [`${HELPER} displays`]: {
      code: 0,
      stdout: JSON.stringify(macDisplaysJson),
    },
    [`${HELPER} windows`]: {
      code: 0,
      stdout: JSON.stringify(macWindowsJson),
    },
  });

  const targets = await discoverTargets(runner, {
    os: "darwin",
    macHelper: HELPER,
  });

  assertEquals(calls, [`${HELPER} displays`, `${HELPER} windows`]);
  assertEquals(targets.os, "darwin");
  assertEquals(targets.displays.map((d) => d.name), ["1", "3"]);
  assertEquals(targets.windows.map((w) => w.id), ["512", "81", "40"]);
  assertEquals(targets.notes, [], "one titled window: no permission note");

  const options = toOptions(targets);
  assertEquals(options.displays[0], {
    value: "display:1",
    label: "Built-in Retina Display · 1728×1117 pt · main",
  });
  assertEquals(options.windows[0].value, "window:512");
  assertStringIncludes(options.windows[0].label, "frontmost");
});

Deno.test("macOS: a display is --output <id> and a window is --window <id>", async () => {
  const { runner } = fakeRunner({
    [`${HELPER} displays`]: {
      code: 0,
      stdout: JSON.stringify(macDisplaysJson),
    },
    [`${HELPER} windows`]: {
      code: 0,
      stdout: JSON.stringify(macWindowsJson),
    },
  });
  const targets = await discoverTargets(runner, {
    os: "darwin",
    macHelper: HELPER,
  });

  const byDisplay = resolveCapture(targets, "display:3", "");
  assertTrue(byDisplay.ok);
  if (!byDisplay.ok) return;
  assertEquals(byDisplay.capture, {
    args: ["--output", "3"],
    label: "LG HDR 4K · 2560×1440 pt",
  });

  const byWindow = resolveCapture(targets, "display:1", "window:512");
  assertTrue(byWindow.ok);
  if (!byWindow.ok) return;
  assertEquals(byWindow.capture.args, ["--window", "512"]);
  assertStringIncludes(byWindow.capture.label, "Warframe");

  const gone = resolveCapture(targets, "", "window:999");
  assertTrue(!gone.ok, "a closed window is refused");
  const unplugged = resolveCapture(targets, "display:7", "");
  assertTrue(!unplugged.ok, "an unknown display id is refused");
});

Deno.test("macOS discovery without the helper adds a note, never fails", async () => {
  const { runner, calls } = fakeRunner({});

  const targets = await discoverTargets(runner, {
    os: "darwin",
    macHelper: HELPER,
  });

  assertEquals(targets.displays, []);
  assertEquals(targets.windows, []);
  assertEquals(calls, [`${HELPER} displays`], "one probe is enough");
  assertEquals(targets.notes.length, 1);
  assertStringIncludes(targets.notes[0], "Build headless on macOS");
  assertStringIncludes(targets.notes[0], "WFINFO_MAC_HELPER");
  assertStringIncludes(targets.notes[0], "a scan cannot capture");
  assertTrue(
    !targets.notes[0].includes("every display"),
    "no capture is promised without the helper",
  );
  assertStringIncludes(targets.notes[0], HELPER);

  const automatic = resolveCapture(targets, "", "");
  assertTrue(automatic.ok);
  if (!automatic.ok) return;
  assertEquals(automatic.capture.args, []);
});

Deno.test("macOS: a display token is refused when no display was found", async () => {
  const { runner } = fakeRunner({});
  const targets = await discoverTargets(runner, {
    os: "darwin",
    macHelper: HELPER,
  });
  assertEquals(targets.displays, []);

  const chosen = resolveCapture(targets, "display:1", "");
  assertTrue(!chosen.ok, "an empty list knows no display id");
  if (chosen.ok) return;
  assertStringIncludes(chosen.error, "No displays were found");
});

Deno.test("Linux: an empty display list still passes an output name", () => {
  const noRandr: ScanTargets = { displays: [], windows: [], notes: [] };

  const chosen = resolveCapture(noRandr, "display:DP-2", "");
  assertTrue(chosen.ok);
  if (!chosen.ok) return;
  assertEquals(chosen.capture.args, ["--output", "DP-2"]);
});

Deno.test("macOS discovery notes failed lists and hidden window titles", async () => {
  const { runner } = fakeRunner({
    [`${HELPER} displays`]: { code: 2, stdout: "" },
    [`${HELPER} windows`]: {
      code: 0,
      stdout: JSON.stringify([macWindowsJson[0], macWindowsJson[2]]),
    },
  });

  const targets = await discoverTargets(runner, {
    os: "darwin",
    macHelper: HELPER,
  });

  assertEquals(targets.displays, []);
  assertEquals(targets.windows.length, 2);
  assertEquals(targets.notes.length, 2);
  assertStringIncludes(targets.notes[0], "exit code 2");
  assertStringIncludes(targets.notes[1], "Screen Recording");
});

const tcp = (hostname: string): Deno.Addr => ({
  transport: "tcp",
  hostname,
  port: 50000,
});

Deno.test("only a loopback client counts as this host", () => {
  assertEquals(remoteClient(tcp("127.0.0.1"), false), null);
  assertEquals(remoteClient(tcp("127.4.5.6"), false), null);
  assertEquals(remoteClient(tcp("::1"), false), null);
  assertEquals(remoteClient(tcp("::ffff:127.0.0.1"), false), null);
  assertEquals(remoteClient(undefined, false), null, "no address: in-process");
  assertEquals(
    remoteClient({ transport: "unix", path: "/tmp/wf.sock" }, false),
    null,
    "a unix socket is local",
  );
  assertEquals(remoteClient(tcp("192.168.1.50"), false), "192.168.1.50");
  assertEquals(remoteClient(tcp("::ffff:10.0.0.2"), false), "::ffff:10.0.0.2");
});

Deno.test("WFINFO_SCAN_REMOTE lets another host through", () => {
  assertEquals(remoteClient(tcp("192.168.1.50"), true), null);
});

Deno.test("another host gets no displays, no windows and a note", () => {
  const withheld = withheldTargets("192.168.1.50");
  const options = toOptions(withheld);

  assertEquals(options.displays, []);
  assertEquals(options.windows, []);
  assertEquals(options.notes.length, 1);
  assertStringIncludes(options.notes[0], "192.168.1.50 is another host");
  assertStringIncludes(options.notes[0], "WFINFO_SCAN_REMOTE=1");
});
