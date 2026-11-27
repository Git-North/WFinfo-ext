# tests/ — Fork Tests and OCR & Theme Regression Framework

## Test layout (code this fork adds)

One folder per component, not per feature.

| Code under test | Tests | Kind |
|---|---|---|
| C# runner (`headless/`) | `tests/headless/` | one xUnit project; add `.cs` files, no second project |
| Swift helper (`headless/macos/*.swift`) | `tests/swift/` | Deno tests that run the built helper; skipped off macOS |
| Dashboard (new tests) | `tests/dashboard/` | Deno tests that import `../../dashboard/src/` |
| Rust crates | `<crate>/tests/` | cargo integration tests; inline tests only for private items |
| Test tooling | `tests/run.ts`, `tests/lib/` | Deno (or Rust): no OS-specific tools |

Tests next to dashboard sources (`dashboard/src/**/*_test.ts`) stay there.

- One entry point, from the repository root:
  `deno run -A tests/run.ts [scripts|dashboard|rust|swift|dotnet ...] [--coverage <dir>]`.
  `rust` takes every tracked `Cargo.toml` (fmt, clippy with `-D warnings`,
  tests), so a new crate needs no change. Commit its `Cargo.lock`.
- Coverage reports go to `<dir>`, outside the repository: `dashboard.lcov`,
  `rust-<crate>.lcov`, `dotnet/**/coverage.opencover.xml`, `swift.xml`
  (SonarQube generic format) and `sonar.args` (one scanner argument per report
  that exists). The SonarQube workflow reads only `sonar.args`. Rust coverage
  needs `cargo-llvm-cov` and `rustup component add llvm-tools-preview`.
- A .NET test must never touch the user's real WFInfo data. On macOS .NET
  ignores a temporary `HOME` for ApplicationData; only `CFFIXED_USER_HOME`,
  set before the process starts, to a folder that holds
  `Library/Application Support`, moves it. `tests/run.ts` does this and puts a
  marker file in the folder. Mark a test that uses the app-data folder
  `[SandboxFact]` or `[MacSandboxFact]` and get the folder through `Sandbox`,
  which refuses a folder without the marker. A plain `dotnet test` skips them.
- Tests need no network, no game, and no Screen Recording permission. Live
  capture goes through a stand-in helper (`FakeCaptureHelper`).

## Purpose

Headless regression and accuracy testing for WFInfo's real OCR pipeline and
theme detection, run through the production code paths (no mocks/copies).

## Ownership

- `map.json` — scenario list (paths relative to it, no extensions).
- `data/` — scenario pairs: `<name>.json` (spec) + `<name>.png` (screenshot).
- Runner implementations live in `../WFInfo/Tests/` (linked into the app and
  into the headless runner); this folder holds scenario data, runner scripts and
  docs.

## Local Contracts

- Scenario spec fields (JSON): `description`, `resolution`, `scaling` (required
  int), `theme` (required), `language` (required), `parts` (required map
  index→name), `category` (`reward`|`snapit`, required), `hdr` (required bool),
  `filters` (optional list).
- Categories: `reward` → `ExtractPartBoxAutomatically` +
  `GetTextFromImage` + `GetPartName`; `snapit` → theme detection +
  `ScaleUpAndFilter` + `FindAllParts` + `GetPartName`.
- Exit codes: 0 all pass, 1 some fail/error, 2 fatal (missing files, init).
- Output: JSON report at the given path (default
  `test_results_<timestamp>.json`) plus stdout summary.
- Locales map to tesseract locale codes; only locales with tessdata on the
  WFCD libs server can run (en, ko, fr, uk, it, de, es, pt, pl, ru, zh-hans,
  zh-hant; ja/th/tr are not downloadable today).

## Work Guidance

- Add a scenario: screenshot PNG + matching JSON spec + entry in `map.json`.
- First suite run downloads market DBs and tessdata; requires network.
- Current known gap: `data/` contains only JSON specs, no PNGs — every scenario
  errors with "PNG not found" until real screenshots are added. Do not delete
  specs; add PNGs.
- Windows runner: `run_tests.bat` / `run_theme_tests.bat`. Linux runner:
  `nix develop -c dotnet run --project headless -- --test tests/map.json out.json`
  and `--theme-test` for the theme runner. Manual invocation is
  `WFInfo.exe [--test] map.json [out.json]`.

## Verification

- `deno run -A tests/run.ts` — every suite that applies to the host passes.
- Keep runner semantics aligned with `../WFInfo/AGENTS.md` exit-code contract.
- After editing specs/map: run the suite on Linux (see headless/AGENTS.md) and
  confirm the report structure and exit codes.

## Child DOX Index

None.
