/**
 * Regression of `wfinfo-mac rewards`: on synthetic reward screens it must
 * return every name line the screen shows. "wrapped-white" is the screen where
 * Vision dropped the wrapped "BLUEPRINT" under "ASH PRIME NEUROPTICS" when it
 * read the strip as one wide crop. Needs macOS (Apple Vision).
 */

import { answer, LAYOUT, macTest, synth } from "./helper.ts";

interface Screen {
  name: string;
  size: [number, number];
  uiScale: string;
  color: string;
  seed: string;
  names: string[];
  squad: string[];
}

const SCREENS: Screen[] = [
  {
    name: "wrapped-white",
    size: [1920, 1080],
    uiScale: "0.9",
    color: "#FFFFFF",
    seed: "7",
    names: [
      "Volt Prime Systems",
      "Ash Prime Neuroptics Blueprint",
      "Forma Blueprint",
      "Akstiletto Prime Barrel",
    ],
    squad: ["Tenno1", "Tenno2", "Tenno3", "Tenno4"],
  },
  {
    name: "wrapped-white-real",
    size: [1920, 1080],
    uiScale: "0.9",
    color: "#FFFFFF",
    seed: "7",
    names: [
      "Volt Prime Systems Blueprint",
      "Ash Prime Neuroptics Blueprint",
      "Nekros Prime Chassis Blueprint",
      "Soma Prime Stock",
    ],
    squad: ["Tenno1", "Tenno2", "Tenno3", "Tenno4"],
  },
  {
    name: "four-gold",
    size: [1920, 1080],
    uiScale: "1.0",
    color: "#BEA966",
    seed: "1",
    names: [
      "Volt Prime Blueprint",
      "Hydroid Prime Neuroptics Blueprint",
      "Forma Blueprint",
      "Paris Prime Upper Limb",
    ],
    squad: ["a", "b", "c", "d"],
  },
  {
    name: "three-white-80",
    size: [2560, 1440],
    uiScale: "0.8",
    color: "#FFFFFF",
    seed: "2",
    names: [
      "Nikana Prime Hilt",
      "Akstiletto Prime Barrel",
      "Braton Prime Receiver",
    ],
    squad: ["Ash", "Mag Main", ""],
  },
  {
    name: "two-blue-ultrawide",
    size: [3440, 1440],
    uiScale: "1.0",
    color: "#6EC3E8",
    seed: "3",
    names: ["Rhino Prime Chassis Blueprint", "Lex Prime Barrel"],
    squad: ["Solo", "Duo"],
  },
  {
    name: "one-gold-125",
    size: [1728, 1117],
    uiScale: "1.25",
    color: "#BEA966",
    seed: "4",
    names: ["Trinity Prime Systems Blueprint"],
    squad: [],
  },
];

interface Line {
  text: string;
}

for (const screen of SCREENS) {
  macTest(`rewards reads every name line: ${screen.name}`, async (dir) => {
    const png = `${dir}/${screen.name}.png`;
    const truth = await synth(png, screen.names.join("|"), [
      "--width",
      String(screen.size[0]),
      "--height",
      String(screen.size[1]),
      "--ui-scale",
      screen.uiScale,
      "--color",
      screen.color,
      "--seed",
      screen.seed,
      "--squad",
      screen.squad.join("|"),
    ]);
    const reading = await answer([
      "rewards",
      "--file",
      png,
      ...LAYOUT,
      "--ui-scale",
      screen.uiScale,
    ]);

    const read: string[] = reading.lines.map((l: Line) => l.text.toUpperCase());
    const wanted: string[] = truth.slots.flatMap((slot: { lines: Line[] }) =>
      slot.lines.map((l) => l.text.toUpperCase())
    );
    const missing = wanted.filter((line) => !read.includes(line));
    if (missing.length > 0) {
      throw new Error(
        `missing: ${missing.join(", ")}; read: ${read.join(", ")}`,
      );
    }
  });
}
