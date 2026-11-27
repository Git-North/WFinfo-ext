/**
 * The command line of the Swift helper: its subcommands, their JSON answers and
 * their error messages. Live screen capture needs the Screen Recording
 * permission and is not run here; it would open a permission prompt.
 */

import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
  assertTrue,
} from "../../dashboard/src/lib/testutil.ts";
import { answer, fails, helper, LAYOUT, macTest, synth } from "./helper.ts";

const text = new TextEncoder();

/** `ocr --frames` input: each image after its 4-byte big-endian length. */
function frames(...images: Uint8Array[]): Uint8Array {
  const total = images.reduce((sum, image) => sum + 4 + image.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const image of images) {
    view.setUint32(offset, image.length);
    out.set(image, offset + 4);
    offset += 4 + image.length;
  }
  return out;
}

/** An image with one line of known text. */
async function textImage(dir: string, words: string): Promise<string> {
  const path = `${dir}/${words.replaceAll(" ", "-")}.png`;
  await answer(["selfcheck", "--text", words, "--save", path]);
  return path;
}

macTest("a missing or unknown subcommand is a usage error", async () => {
  await fails([], "usage: wfinfo-mac", 2);
  await fails(["nonsense"], "unknown subcommand nonsense", 2);
});

macTest("a value flag without a value is refused", async () => {
  await fails(["synth", "--out"], "--out expects a value");
});

// ---- synth -------------------------------------------------------------------

macTest("synth draws the same screen for the same seed", async (dir) => {
  const truth = await synth(
    `${dir}/a.png`,
    "Forma Blueprint|Soma Prime Stock",
    [
      "--seed",
      "5",
      "--squad",
      "one|two",
    ],
  );
  await synth(`${dir}/b.png`, "Forma Blueprint|Soma Prime Stock", [
    "--seed",
    "5",
    "--squad",
    "one|two",
  ]);

  assertEquals([truth.width, truth.height, truth.seed], [1920, 1080, 5]);
  assertEquals(
    truth.slots.map((s: { name: string; squad: string }) => [s.name, s.squad]),
    [["FORMA BLUEPRINT", "one"], ["SOMA PRIME STOCK", "two"]],
  );
  assertEquals(
    await Deno.readFile(`${dir}/a.png`),
    await Deno.readFile(`${dir}/b.png`),
  );
});

macTest("synth accepts a seed above the signed 64-bit range", async (dir) => {
  const result = await helper([
    "synth",
    "--out",
    `${dir}/a.png`,
    "--names",
    "Forma Blueprint",
    "--width",
    "640",
    "--height",
    "360",
    "--seed",
    "18446744073709551615",
  ]);
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.text, "18446744073709551615");
});

macTest("synth refuses bad input by name", async (dir) => {
  const out = ["synth", "--out", `${dir}/x.png`];
  const named = [...out, "--names", "Forma"];
  await fails(["synth", "--names", "A"], "synth needs --out");
  await fails(out, "synth needs --names");
  await fails([...out, "--names", "a|b|c|d|e"], "1 to 4 non-empty names");
  await fails([...out, "--names", "a||c"], "1 to 4 non-empty names");
  await fails([...named, "--width", "10"], "--width and --height");
  await fails([...named, "--ui-scale", "0"], "--ui-scale must be positive");
  await fails([...named, "--ui-scale", "x"], "--ui-scale expects a number");
  await fails([...named, "--seed", "-1"], "--seed expects a whole number");
  await fails([...named, "--color", "red"], "--color expects #RRGGBB");
  await fails(
    [...out, "--names", "W".repeat(300)],
    "does not fit in two lines",
  );
  await fails(
    ["synth", "--out", `${dir}/no/such/folder.png`, "--names", "Forma"],
    "cannot write",
  );
});

// ---- ocr ---------------------------------------------------------------------

macTest(
  "ocr keeps the input order for more images than it reads at once",
  async (dir) => {
    const words = ["Volt", "Ash", "Nekros", "Rhino", "Trinity", "Hydroid"];
    const paths = [];
    for (const word of words) {
      paths.push(await textImage(dir, `${word} Prime`));
    }

    const result = await answer(["ocr", ...paths]);

    assertEquals(result.engine, "vision");
    assertEquals(
      result.results.map((r: { text: string }) => r.text.split(" ")[0]),
      words,
    );
  },
);

macTest(
  "ocr reads one image from stdin and several from frames",
  async (dir) => {
    const volt = await Deno.readFile(await textImage(dir, "Volt Prime"));
    const forma = await Deno.readFile(await textImage(dir, "Forma Blueprint"));

    const one = await answer(["ocr", "--fast", "-"], volt);
    assertEquals(one.level, "fast");
    assertStringIncludes(one.results[0].text, "Volt");

    const two = await answer(
      ["ocr", "--frames", "--correction", "--lang", "en-US", "--device", "cpu"],
      frames(volt, forma),
    );
    assertEquals(two.results.map((r: { frame: number }) => r.frame), [0, 1]);
    assertStringIncludes(two.results[1].text, "Forma");
    assertEquals(two.languageCorrection, true);
  },
);

macTest(
  "ocr reports a bad image in its own entry and reads the others",
  async (dir) => {
    const good = await textImage(dir, "Volt Prime");
    await Deno.writeTextFile(`${dir}/bad.png`, "not an image");

    const result = await answer([
      "ocr",
      `${dir}/bad.png`,
      `${dir}/none.png`,
      good,
    ]);

    assertStringIncludes(result.results[0].error, "not an image");
    assertStringIncludes(result.results[1].error, "cannot read");
    assertEquals(result.results[2].error, null);
  },
);

macTest("ocr refuses missing or broken input", async () => {
  await fails(["ocr"], "ocr expects image paths");
  await fails(["ocr", "--frames"], "got no frames", 1, new Uint8Array(0));
  await fails(
    ["ocr", "--frames"],
    "truncated frame header",
    1,
    text.encode("ab"),
  );
  await fails(
    ["ocr", "--frames"],
    "truncated frame 0",
    1,
    new Uint8Array([0, 0, 0, 9, 1]),
  );
  await fails(["ocr", "--device", "tpu", "x.png"], "unknown --device 'tpu'");
});

// ---- devices, displays, windows ----------------------------------------------

macTest("devices lists the Vision compute devices", async () => {
  const result = await answer(["devices"]);
  assertTrue(result.allComputeDevices.includes("cpu"));
  assertEquals(typeof result.canPinComputeDevice, "boolean");
});

macTest("displays and windows answer with lists", async () => {
  for (const display of await answer(["displays"])) {
    assertEquals(typeof display.id, "number");
    assertTrue(display.width > 0 && display.pixelWidth > 0);
  }
  for (const window of await answer(["windows"])) {
    assertEquals(typeof window.id, "number");
    assertTrue(window.width >= 200 && window.height >= 150);
  }
});

macTest(
  "capture needs an output path before it touches the screen",
  async () => {
    await fails(["capture"], "capture expects an output .png path");
  },
);

// ---- rewards -----------------------------------------------------------------

macTest(
  "rewards reads a screen from stdin and saves it on request",
  async (dir) => {
    const png = `${dir}/screen.png`;
    await synth(png, "Forma Blueprint", ["--ui-scale", "1.0"]);

    const reading = await answer(
      [
        "rewards",
        "--file",
        "-",
        ...LAYOUT,
        "--ui-scale-min",
        "0.5",
        "--ui-scale-max",
        "1.25",
        "--save",
        `${dir}/saved.png`,
      ],
      await Deno.readFile(png),
    );

    assertEquals(
      [reading.source, reading.width, reading.height],
      ["file -", 1920, 1080],
    );
    assertEquals([reading.uiScaleMin, reading.uiScaleMax], [0.5, 1.25]);
    assertEquals(reading.saved, `${dir}/saved.png`);
    assertTrue((await Deno.stat(reading.saved)).size > 0);
    assertTrue(
      reading.lines.some((l: { text: string }) => /FORMA/i.test(l.text)),
      JSON.stringify(reading.lines),
    );
    // Boxes are in full-image pixels, inside the crop.
    for (const line of reading.lines) {
      assertTrue(line.box.x >= reading.crop.x && line.box.y >= reading.crop.y);
    }
  },
);

macTest("rewards refuses bad arguments by name", async (dir) => {
  const png = `${dir}/screen.png`;
  await synth(png, "Forma Blueprint", ["--width", "640", "--height", "360"]);
  const file = ["rewards", "--file", png];
  const scale = ["--ui-scale", "1"];
  const without = (flag: string) => {
    const rest = [...LAYOUT];
    rest.splice(rest.indexOf(flag), 2);
    return rest;
  };

  await fails(
    [...file, ...without("--reward-width"), ...scale],
    "rewards needs --reward-width",
  );
  await fails([...file, ...LAYOUT], "rewards needs --ui-scale");
  await fails(
    [...file, ...LAYOUT, "--ui-scale-min", "0.5"],
    "rewards needs --ui-scale",
  );
  await fails(
    [...file, ...LAYOUT, ...scale, "--ui-scale-min", "1"],
    "not both",
  );
  await fails([...file, ...LAYOUT, "--ui-scale", "0"], "0 < min <= max");
  await fails(
    [...file, ...LAYOUT, "--ui-scale-min", "1", "--ui-scale-max", "0.5"],
    "0 < min <= max",
  );
  await fails([...file, ...LAYOUT, "--ui-scale", "NaN"], "expects a number");
  await fails(
    [...file, ...without("--line-height"), "--line-height", "0", ...scale],
    "must be positive",
  );
  await fails(
    [...file, ...LAYOUT, ...scale, "extra"],
    "unexpected argument 'extra'",
  );
  await fails([...file, "--display", "1", ...LAYOUT, ...scale], "only one of");
  await fails(
    [...file, ...without("--reward-y"), "--reward-y", "100000", ...scale],
    "the reward crop is empty",
  );
  await fails(
    [...file, ...LAYOUT, ...scale, "--save", `${dir}/no/such.png`],
    "cannot write",
  );
});

// ---- selfcheck ---------------------------------------------------------------

macTest(
  "selfcheck reads its own text, also when it must shrink it",
  async () => {
    const plain = await answer(["selfcheck"]);
    assertStringIncludes(plain.text, "Volt Prime Blueprint");
    assertEquals(plain.saved, null);

    const long = await answer([
      "selfcheck",
      "--text",
      "Akstiletto Prime Barrel and Volt Prime Systems Blueprint",
    ]);
    assertStringIncludes(long.text, "Akstiletto");
  },
);

// ---- hotkey ------------------------------------------------------------------

/** A key nobody presses; --fire sends one request without a key press. */
const KEY = ["--key", "ctrl+option+cmd+shift+f15"];

interface Seen {
  method: string;
  accept: string | null;
  path: string;
}

/** Runs `hotkey --fire` against a local server that answers `reply`. */
async function fire(reply: () => Response, query = "") {
  const seen: Seen[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        accept: request.headers.get("accept"),
        path: url.pathname + url.search,
      });
      return reply();
    },
  );
  try {
    const url =
      `http://user:hunter2@127.0.0.1:${server.addr.port}/scan/run${query}`;
    const result = await helper([
      "hotkey",
      ...KEY,
      "--quiet",
      "--fire",
      "--url",
      url,
    ]);
    return { result, seen };
  } finally {
    await server.shutdown();
  }
}

macTest(
  "hotkey --fire posts one scan request and logs no credentials",
  async () => {
    const { result, seen } = await fire(
      () => Response.json({ message: "scan finished" }),
      "?token=sekret",
    );

    assertEquals(result.code, 0, result.stderr);
    assertEquals(seen, [{
      method: "POST",
      accept: "application/json",
      path: "/scan/run?token=sekret",
    }]);
    assertStringIncludes(result.text, "scan: scan finished");
    assertTrue(!result.text.includes("hunter2"), result.text);
    assertTrue(!result.text.includes("sekret"), result.text);
    assertMatch(
      result.text,
      /hotkey: POST http:\/\/127\.0\.0\.1:\d+\/scan\/run\n/,
    );
  },
);

macTest("hotkey --fire fails when the scan request fails", async () => {
  const { result } = await fire(() =>
    Response.json({ error: "a scan is already running" }, { status: 409 })
  );
  assertEquals(result.code, 1, result.stderr);
  assertStringIncludes(result.text, "scan: a scan is already running");

  const plain = await fire(() => new Response("oops", { status: 500 }));
  assertEquals(plain.result.code, 1);
  assertStringIncludes(plain.result.text, "scan: HTTP 500");
});

macTest("hotkey refuses a key it cannot register", async () => {
  await fails(["hotkey", "--key", "ctrl+banana"], "unknown key 'banana'");
  await fails(["hotkey", "--key", "ctrl+shift"], "names no key");
});
