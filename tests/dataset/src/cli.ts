/** A small, strict option parser: unknown options and bad values are errors. */

import { DatasetError } from "./errors.ts";

export interface ArgSpec {
  flags: string[];
  /** Options that take one value. */
  values: string[];
  /** Options that take a value and may repeat. */
  lists: string[];
}

export interface Args {
  positional: string[];
  /** The option names that were given. */
  given: string[];
  flag(name: string): boolean;
  value(name: string): string | undefined;
  list(name: string, fallback: string[]): string[];
  integer(name: string, fallback: number, min: number, max: number): number;
}

export function parseArgs(argv: string[], spec: ArgSpec): Args {
  const positional: string[] = [];
  const found = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (spec.flags.includes(name)) {
      found.set(name, []);
      continue;
    }
    const repeats = spec.lists.includes(name);
    if (!repeats && !spec.values.includes(name)) {
      throw new DatasetError("DST-001", `unknown option ${arg}`);
    }
    const value = argv[++i];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new DatasetError("DST-001", `${arg} needs a value`);
    }
    if (!repeats && found.has(name)) {
      throw new DatasetError("DST-001", `${arg} was given twice`);
    }
    found.set(name, [...(found.get(name) ?? []), value]);
  }
  return {
    positional,
    given: [...found.keys()],
    flag: (name) => found.has(name),
    value: (name) => found.get(name)?.[0],
    list: (name, fallback) => found.get(name) ?? fallback,
    integer(name, fallback, min, max) {
      const text = found.get(name)?.[0];
      if (text === undefined) return fallback;
      const number = /^\d+$/.test(text) ? Number(text) : NaN;
      if (!(number >= min && number <= max)) {
        throw new DatasetError(
          "DST-001",
          `--${name} needs a whole number from ${min} to ${max}`,
        );
      }
      return number;
    },
  };
}
