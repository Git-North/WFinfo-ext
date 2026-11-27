/**
 * The one entry point for the tests of this fork's code. Cross-platform: Deno
 * runs it, and each suite skips with a message where it cannot run.
 *
 *   deno run -A tests/run.ts [suite ...] [--coverage <dir outside the repo>]
 *
 * Suites (default: all):
 *   scripts    format, type check, lint and unit tests of the files in tests/
 *   dashboard  dashboard/src and tests/dashboard
 *   rust       every tracked Cargo.toml: fmt, clippy (no warnings), tests
 *   swift      tests/swift against the built wfinfo-mac (macOS only)
 *   dotnet     tests/headless in a sandbox app-data folder
 *
 * With --coverage the folder gets one report per language and `sonar.args`,
 * the SonarQube scanner arguments for the reports that exist (one per line).
 * It needs cargo-llvm-cov and the llvm-tools component for Rust.
 */

import { lineTotals, parseLcov, toSonarGeneric } from "./lib/lcov.ts";

const SUITES = ["scripts", "dashboard", "rust", "swift", "dotnet"] as const;
type Suite = (typeof SUITES)[number];

const ROOT = new URL("../", import.meta.url);
const root = fromUrl(ROOT);
const darwin = Deno.build.os === "darwin";

/** A directory URL as a native path without the trailing separator. */
function fromUrl(url: URL): string {
  let path = decodeURIComponent(url.pathname);
  if (Deno.build.os === "windows") path = path.replace(/^\//, "");
  return path.replace(/\/+$/, "");
}

function at(...parts: string[]): string {
  return [root, ...parts].join("/");
}

function usage(message: string): never {
  console.error(message);
  console.error(
    `usage: deno run -A tests/run.ts [${
      SUITES.join("|")
    } ...] [--coverage <dir>]`,
  );
  Deno.exit(2);
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** Runs a command with its output on the terminal; throws when it fails. */
async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<void> {
  console.log(`$ ${command} ${args.join(" ")}`);
  const status = await new Deno.Command(command, {
    args,
    cwd: options.cwd ?? root,
    env: options.env,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    throw new Error(`${command} ${args[0]} exited with ${status.code}`);
  }
}

/** Runs a command and returns its standard output. */
async function output(command: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(command, { args, cwd: root }).output();
  if (!result.success) {
    const error = new TextDecoder().decode(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed: ${error}`);
  }
  return new TextDecoder().decode(result.stdout);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function filesBelow(dir: string, name: RegExp): Promise<string[]> {
  const found: string[] = [];
  if (!await exists(dir)) return found;
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) found.push(...await filesBelow(path, name));
    else if (name.test(entry.name)) found.push(path);
  }
  return found.sort();
}

// ---- suites ----------------------------------------------------------------

async function scripts(): Promise<void> {
  const cwd = at("tests");
  await run("deno", ["fmt", "--check"], { cwd });
  await run("deno", ["lint"], { cwd });
  await run("deno", ["check", "."], { cwd });
  await run("deno", ["test", "-A", "lib"], { cwd });
}

async function dashboard(coverage: string | undefined): Promise<void> {
  const cwd = at("dashboard");
  const targets = ["src"];
  if ((await filesBelow(at("tests", "dashboard"), /_test\.ts$/)).length > 0) {
    targets.push("../tests/dashboard");
  }
  if (!coverage) {
    await run("deno", ["test", "-A", ...targets], { cwd });
    return;
  }
  const raw = `${coverage}/dashboard-raw`;
  try {
    await run("deno", ["test", "-A", `--coverage=${raw}`, ...targets], { cwd });
  } finally {
    // The report still covers every test that ran.
    await run("deno", [
      "coverage",
      raw,
      "--lcov",
      `--output=${coverage}/dashboard.lcov`,
    ], { cwd });
    await Deno.remove(raw, { recursive: true });
  }
}

async function crates(): Promise<string[]> {
  const listed = await output("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "Cargo.toml",
    "*/Cargo.toml",
  ]);
  return listed.split("\n").filter((line) => line !== "").sort();
}

async function rust(coverage: string | undefined): Promise<void> {
  for (const manifest of await crates()) {
    // From the crate folder, so rustup uses its rust-toolchain.toml.
    const cwd = at(manifest.replace(/\/?Cargo\.toml$/, "") || ".");
    await run("cargo", ["fmt", "--check"], { cwd });
    await run("cargo", [
      "clippy",
      "--locked",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ], { cwd });
    if (!coverage) {
      await run("cargo", ["test", "--locked"], { cwd });
      continue;
    }
    const name = manifest.replace(/\/?Cargo\.toml$/, "").replaceAll("/", "-") ||
      "root";
    await run("cargo", [
      "llvm-cov",
      "--locked",
      "--lcov",
      "--output-path",
      `${coverage}/rust-${name}.lcov`,
    ], { cwd });
  }
}

const HELPER_SOURCE = "headless/macos/wfinfo-mac.swift";
const HELPER_BUILT = "headless/bin/Debug/net9.0/wfinfo-mac";

/** The helper to test: the runner's build, or a new one in `work`. */
async function buildHelper(work: string, instrument: boolean): Promise<string> {
  const given = Deno.env.get("WFINFO_TEST_HELPER");
  if (given && !instrument) return given;
  if (!instrument && await exists(at(HELPER_BUILT))) return at(HELPER_BUILT);
  const helper = `${work}/wfinfo-mac`;
  const arch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64";
  await run("swiftc", [
    ...(instrument
      ? ["-profile-generate", "-profile-coverage-mapping"]
      : ["-O"]),
    "-target",
    `${arch}-apple-macos15.0`,
    "-o",
    helper,
    at(HELPER_SOURCE),
  ]);
  return helper;
}

async function swift(
  helper: string,
  env: Record<string, string>,
): Promise<void> {
  await run("deno", ["test", "-A", "swift"], {
    cwd: at("tests"),
    env: { ...env, WFINFO_TEST_HELPER: helper },
  });
}

/** Turns the helper's raw profiles into SonarQube's generic report. */
async function swiftReport(
  helper: string,
  profiles: string,
  coverage: string,
): Promise<void> {
  const raw = await filesBelow(profiles, /\.profraw$/);
  if (raw.length === 0) return;
  const find = async (tool: string) =>
    (await output("xcrun", ["--find", tool])).trim();
  const merged = `${profiles}/merged.profdata`;
  const list = `${profiles}/inputs.txt`;
  await Deno.writeTextFile(list, raw.join("\n"));
  await run(await find("llvm-profdata"), [
    "merge",
    "--sparse",
    `--input-files=${list}`,
    "-o",
    merged,
  ]);
  const lcov = await output(await find("llvm-cov"), [
    "export",
    "--format=lcov",
    `--instr-profile=${merged}`,
    helper,
  ]);
  // llvm-cov prints resolved paths; the repo path can go through a symlink.
  const real = await Deno.realPath(root);
  await Deno.writeTextFile(
    `${coverage}/swift.xml`,
    toSonarGeneric(parseLcov(lcov), real),
  );
  await Deno.writeTextFile(`${coverage}/swift.lcov`, lcov);
}

const TEST_PROJECT = "tests/headless/WFInfo.Headless.Tests.csproj";

/**
 * Runs the .NET tests with a new app-data folder. The environment must be set
 * before the test process starts: on macOS .NET ignores a temporary HOME for
 * ApplicationData and needs CFFIXED_USER_HOME, and the folder must exist.
 */
async function dotnet(
  coverage: string | undefined,
  extra: Record<string, string>,
): Promise<void> {
  await run("dotnet", ["build", TEST_PROJECT, "--nologo", "-v:q"]);
  const sandbox = await Deno.makeTempDir({ prefix: "wfinfo-sandbox-" });
  try {
    await Deno.writeTextFile(`${sandbox}/.wfinfo-test-sandbox`, "");
    await Deno.mkdir(`${sandbox}/Library/Application Support`, {
      recursive: true,
    });
    await Deno.mkdir(`${sandbox}/.config`);
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
    const args = ["test", TEST_PROJECT, "--no-build", "--nologo"];
    if (coverage) {
      args.push(
        "--collect:XPlat Code Coverage",
        "--settings",
        "tests/headless/coverage.runsettings",
        "--results-directory",
        `${coverage}/dotnet`,
      );
    }
    await run("dotnet", args, {
      env: {
        ...extra,
        HOME: sandbox,
        CFFIXED_USER_HOME: sandbox,
        XDG_CONFIG_HOME: `${sandbox}/.config`,
        WFINFO_TEST_SANDBOX: sandbox,
        // The dotnet command itself keeps the user's settings and packages.
        DOTNET_CLI_HOME: Deno.env.get("DOTNET_CLI_HOME") ?? home,
        NUGET_PACKAGES: Deno.env.get("NUGET_PACKAGES") ??
          `${home}/.nuget/packages`,
      },
    });
  } finally {
    await Deno.remove(sandbox, { recursive: true });
  }
}

// ---- reports ---------------------------------------------------------------

/** Writes `sonar.args` and prints the line coverage of each report. */
async function summarize(coverage: string): Promise<void> {
  const args: string[] = [];
  const add = (property: string, files: string[]) => {
    if (files.length > 0) args.push(`/d:${property}=${files.join(",")}`);
  };
  const dashboardLcov = await filesBelow(coverage, /^dashboard\.lcov$/);
  const rustLcov = await filesBelow(coverage, /^rust-.*\.lcov$/);
  const opencover = await filesBelow(
    `${coverage}/dotnet`,
    /^coverage\.opencover\.xml$/,
  );
  const swiftXml = await filesBelow(coverage, /^swift\.xml$/);
  add("sonar.javascript.lcov.reportPaths", dashboardLcov);
  add("sonar.rust.lcov.reportPaths", rustLcov);
  add("sonar.cs.opencover.reportsPaths", opencover);
  add("sonar.coverageReportPaths", swiftXml);
  await Deno.writeTextFile(
    `${coverage}/sonar.args`,
    args.map((line) => `${line}\n`).join(""),
  );

  console.log("\nLine coverage of the files in each report:");
  const lcovs = [
    ...dashboardLcov,
    ...rustLcov,
    ...await filesBelow(coverage, /^swift\.lcov$/),
  ];
  for (const file of lcovs) {
    const { covered, total } = lineTotals(
      parseLcov(await Deno.readTextFile(file)),
      (path) => !/\/tests\/|_test\.ts$|testutil\.ts$/.test(path),
    );
    const percent = total === 0 ? 0 : (100 * covered) / total;
    console.log(
      `  ${file.split("/").pop()}: ${covered}/${total} (${
        percent.toFixed(1)
      }%)`,
    );
  }
  if (opencover.length > 0) {
    console.log(`  dotnet: ${opencover.join(", ")}`);
  }
}

// ---- main ------------------------------------------------------------------

function parseArguments(args: string[]) {
  const suites: Suite[] = [];
  let coverage: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--coverage") {
      coverage = args[++i];
      if (!coverage) usage("--coverage needs a folder");
    } else if ((SUITES as readonly string[]).includes(args[i])) {
      suites.push(args[i] as Suite);
    } else {
      usage(`unknown argument '${args[i]}'`);
    }
  }
  return { suites: suites.length > 0 ? suites : [...SUITES], coverage };
}

if (import.meta.main) {
  const options = parseArguments(Deno.args);
  let coverage = options.coverage;
  if (coverage) {
    await Deno.mkdir(coverage, { recursive: true });
    coverage = await Deno.realPath(coverage);
    if (`${coverage}/`.startsWith(`${await Deno.realPath(root)}/`)) {
      usage("the coverage folder must be outside the repository");
    }
  }

  const work = await Deno.makeTempDir({ prefix: "wfinfo-tests-" });
  const failed: string[] = [];
  const attempt = async (name: string, body: () => Promise<void>) => {
    console.log(`\n==== ${name} ====`);
    try {
      await body();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      failed.push(name);
    }
  };

  try {
    const profiles = `${work}/profiles`;
    await Deno.mkdir(profiles);
    const profileEnv: Record<string, string> = coverage
      ? { LLVM_PROFILE_FILE: `${profiles}/%p-%m.profraw` }
      : {};
    const usesHelper = options.suites.some((s) =>
      s === "swift" || s === "dotnet"
    );
    let helper: string | undefined;
    if (darwin && usesHelper && coverage) {
      await attempt("build the instrumented helper", async () => {
        helper = await buildHelper(work, true);
      });
    }

    for (const suite of options.suites) {
      await attempt(suite, async () => {
        switch (suite) {
          case "scripts":
            return await scripts();
          case "dashboard":
            return await dashboard(coverage);
          case "rust":
            return await rust(coverage);
          case "swift":
            if (!darwin) {
              console.log("skipped: the Swift helper needs macOS");
              return;
            }
            helper ??= await buildHelper(work, false);
            return await swift(helper, profileEnv);
          case "dotnet":
            // The .NET scan tests drive the same helper, so they add to its
            // coverage. Without a coverage build they use the runner's own.
            return await dotnet(coverage, {
              ...(coverage && helper
                ? { ...profileEnv, WFINFO_TEST_HELPER: helper }
                : {}),
            });
        }
      });
    }

    if (coverage && helper && darwin) {
      await attempt(
        "swift coverage report",
        () => swiftReport(helper!, profiles, coverage),
      );
    }
    if (coverage) await summarize(coverage);
  } finally {
    await Deno.remove(work, { recursive: true });
  }

  if (failed.length > 0) {
    console.error(`\nFAILED: ${failed.join(", ")}`);
    Deno.exit(1);
  }
  console.log("\nAll requested suites passed.");
}
