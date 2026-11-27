# headless/ — Linux/macOS-Native OCR/Theme Runner

## Purpose

`WFInfo.Headless` is a .NET 9 console project that runs WFInfo's real OCR/theme
core natively on Linux and macOS. On macOS a Swift helper (`macos/`) gives
the runner Apple Vision (Neural Engine capable) and ScreenCaptureKit. It links the actual WFInfo sources — no copies, no
mocks — and supplies compile-time seams for Windows-only types so the shared
code type-checks without WPF/WinForms/Win32.

## Ownership

- `WFInfo.Headless.csproj` — which shared files are linked (see the csproj
  `Compile Include` list); keep it the single source of truth for the core
  boundary.
- `Program.cs` — CLI: `--test <map.json> [out.json]`, `--theme-test
  <folder> [uiScale]` (`--theme-debug` accepted), `--selfcheck`, `--scan
  [options]`. `--selfcheck` takes `--ocr auto|vision|tesseract`.
  Every `--test` run also copies the suite results to
  `<app dir>/ocr_runs/` (`latest.json` + one timestamped file, newest 60 kept)
  for the Warframe Info dashboard; every `--scan` run writes
  `<app dir>/scans/latest.json` (same retention) plus `scans/last.png`.
- `Scan/` — the reward-screen scan feature (Linux-only, real behavior):
  `ScanRunner.cs` (capture → OCR → price → recommend → persist → notify),
  `ScreenCapture.cs` (grim + wlr-randr), `EeLog.cs` (EE.log discovery + tail),
  `ScanWatcher.cs` (EE.log-driven automatic scanning), `PriceCache.cs` (local
  platinum cache with on-demand warframe.market refresh), `MarketSheet.cs`
  (indexes `market_items.json`/`market_data.json`), `Notifier.cs` (notify-send),
  `ScanModels.cs`/`ScanOptions.cs`/`Shell.cs`. The record shape is a contract
  with the dashboard's Scan page: the field list is in `README.md` (Scan) and
  the reader is `dashboard/src/lib/scan.ts` — change both together.
- The scan captures one image per candidate: `--file` (an image on disk),
  `--region "X,Y WxH"` (one layout region, i.e. a window frame), `--output`
  (one monitor), else every output then the joined image. Region coordinates are
  the compositor's own client geometry, so no conversion is needed.
- `--watch` scans automatically: `ScanWatcher` tails EE.log and runs a scan per
  "Got rewards" line. The game writes that line before the panel is on screen,
  so a triggered scan re-captures until a part is recognised (or `--wait`
  expires) and writes no record for a screen it could not read. EE.log lives in
  the Steam/Proton prefix; `--log`/`$WFINFO_EE_LOG` override the search.
- `macos/` — the macOS platform code (real behavior, not seams):
  `wfinfo-mac.swift` (Swift helper: `selfcheck`, `ocr`, `devices`,
  `displays`, `windows`, `capture`, `rewards`, `hotkey`, `synth`; JSON on
  stdout; Vision through the Swift `RecognizeTextRequest`, so the minimum is
  macOS 15), `Package.swift` (SwiftPM build of the same file, tools 5.9,
  `.macOS("15.0")`), `MacHelper.cs` (finds and runs the helper),
  `OcrEngines.cs` (auto/vision/tesseract choice), `MacNative.cs` (libgdiplus
  and Tesseract links, only for WFInfo's own pipeline). The csproj target
  `BuildMacHelper` compiles the helper with
  `swiftc -target <arch>-apple-macos15.0` next to the runner on macOS only
  (swiftc ignores `MACOSX_DEPLOYMENT_TARGET`). The target `PublishMacHelper`
  copies it into the `dotnet publish` folder, also on macOS only.
  The helper MUST build with
  the macOS 15 SDK (Xcode 16) as well as newer ones: code that needs a newer
  SDK goes behind `#if compiler(>=6.2)` (Xcode 26) with a working fallback.
  Today that is only compute-device pinning
  (`RecognizeTextRequest.supportedComputeStageDevices`/`setComputeDevice`);
  everything else the helper uses is macOS 14/15 API.
- `Platform/` — seams ONLY: `HeadlessMain.cs` (stub `Main`), `HeadlessServices.cs`
  (window-info service, process finder, screenshot/log-capture stubs,
  `CustomEntrypoint` helpers), `UiSurrogates.cs` (WPF window shapes),
  `PlatformTypeShims.cs` (Point/Key/MouseButton/Screen/Clipboard),
  `BitmapPixInterop.cs` (Bitmap → Pix via lossless PNG round-trip).
- `flake.nix` (repo root) owns the build environment, not this folder.

## Local Contracts

- NEVER copy or fork shared core code into `headless/`. If a shared file needs a
  platform-neutral change (e.g. `Path.Combine`), edit the shared file — the
  Windows build treats `Path.Combine` as equivalent.
- Platform seams exist ONLY to satisfy the compiler for code paths the headless
  run never executes. Members must throw `NotSupportedException` (or no-op only
  when the Windows semantics are genuinely side-effect-free, e.g. clipboard
  copy) — never silently fake core behavior.
- Adding a Windows-only API to shared code usually requires extending a seam;
  prefer removing the Windows-only dependency from the shared file instead.
- `Scan/` and `macos/` are real feature code, not seams — seams stay in
  `Platform/`.
- The macOS port changes NO shared WFInfo file (`WFInfo/` stays upstream's).
  macOS code lives in `macos/` or behind runtime checks
  (`OperatingSystem.IsMacOS()`), never `#if`.
- `wfinfo-mac rewards` returns every line in its generous crop (squad names
  too), with full-image boxes; the caller drops lines outside the name rows.
- Vision drops lines in a wide crop that it reads in a narrow one (a wrapped
  "BLUEPRINT" under one card). With a known UI scale, `rewards` therefore also
  reads 7 narrow tiles over the strip (one per card position for 1-4 cards),
  drops tile lines cut by a tile edge, and merges duplicates (longer text
  wins). Keep this; `headless/macos/tests/rewards_regression.sh` guards it.
- On macOS the default `--selfcheck` proves the Vision stack only, not
  WFInfo's pipeline; `--selfcheck --ocr tesseract` checks that pipeline.
- On macOS `--selfcheck` never loads libgdiplus: the helper renders the sample
  with CoreText and reads it with Vision, so no `Bitmap`, `Graphics` or
  `Image` runs in .NET. Only the modes that run WFInfo's own System.Drawing
  pipeline (`--test`, `--theme-test`, `--scan`, `--selfcheck --ocr
  tesseract`) call `MacNative.EnableGdiPlus`, which links Homebrew's
  libgdiplus or tells the user to `brew install mono-libgdiplus`. Proof: run
  the DLL with the real `libexec/dotnet` and `DYLD_PRINT_LIBRARIES=1`; no
  `libgdiplus` line may appear for the self-check (Homebrew's `bin/dotnet` is
  a bash script, and SIP strips `DYLD_*` there).
  The scan shells out to `grim` (capture), `wlr-randr` (output list) and
  `notify-send` (verdict); the flake's dev shell and the `.#scan` app put all
  three on PATH, so never assume they exist system-wide.
- The scan reads `market_items.json`/`market_data.json` straight from disk
  instead of calling `Data.Update()`: a hotkey press must not wait for a network
  database refresh. Deeper price lookups go through `PriceCache`
  (`<app dir>/price_cache.json`): cache hits answer instantly, missing or stale
  slugs are fetched from warframe.market in parallel, failed fetches are NOT
  cached, and the sheet value is the offline fallback.
- The scan writes only `<app dir>/scans/` (records + `last.png`) and
  `<app dir>/price_cache.json`. It never writes the Windows-side files and never
  touches the ocr_runs history.
- Native library names are exact (wrapper dlopens them):
  `libtesseract50.so`, `libleptonica-1.82.0.so`; supplied by the flake's
  `tesseract-native` farm through `WFINFO_NATIVE_LIBS`. On macOS without that
  variable, `MacNative.EnableTesseract` links Homebrew's
  `libtesseract.5`/`libleptonica.6` into `<bin>/macos-native/` under the same
  names — only when Tesseract runs; the Vision self-check never loads or
  mentions Tesseract. `MacNative.EnableGdiPlus` links `libgdiplus.dylib` next
  to `System.Drawing.Common.dll` (dyld does not search the Homebrew prefix).
- `System.Drawing.Common` is pinned to 6.0.0: versions ≥ 7 throw
  PlatformNotSupportedException on Linux even with `EnableUnixSupport`.
- Env vars honored by `Program.cs`:
  - `WFINFO_NATIVE_LIBS` — dir with tesseract/leptonica libs (flake sets it).
  - `WFINFO_DATA_DIR` — overrides the app-data root (tessdata + market DBs).
    No effect on macOS (the runner warns): .NET does not read
    `XDG_CONFIG_HOME` there.
  - `WFINFO_OCR_ENGINE` — default `--selfcheck --ocr` (auto, vision,
    tesseract).
  - `WFINFO_VISION_DEVICE` — Vision compute device (auto, ane, gpu, cpu).
    Pinning needs the macOS 26 SDK (Xcode 26); see the Swift build rule.
  - `WFINFO_MAC_HELPER` — path of `wfinfo-mac` (default: next to the runner).
    Trimmed; blank counts as unset. On macOS a missing file is an error
    (`OcrEngines.Resolve` throws), never a silent fall back to Tesseract.
- Environment for OCR data dirs derives from the OS XDG config dir when
  `WFINFO_DATA_DIR` is unset — do not assume Windows `%APPDATA%`. On macOS the
  app dir is `~/Library/Application Support/WFInfo`.
- `RollForward=Major`: the runner targets net9.0 but runs on a newer runtime
  when 9 is absent (Homebrew ships only the newest .NET).

## Work Guidance

- Build/run inside the flake dev shell: `nix develop -c dotnet ...`.
- The dev stack (`nix run .#dev-all`) rebuilds and re-runs `--scan` after every
  edit here, next to the live-reload dashboard. It passes `--no-notify` so one
  scan per edit does not post a notification.
- Self-check renders "Volt Prime Blueprint" and OCRs it — the fastest end-to-end
  proof that natives, tessdata, and imaging work on the current machine.
- `tests/data/*.png` fixtures are currently absent from the repo; until they
  exist the OCR suite reports "PNG not found" errors for every scenario while
  still exercising DB update + engine init (this is the pre-existing repo state,
  not a regression).
- Scan runs: `nix run .#scan -- --no-notify` (flake app; builds the runner in
  the checkout, then captures every output) or, inside the dev shell,
  `dotnet run --project headless -- --scan --no-notify`. Use `--file <png>` to
  price an existing screenshot without capturing, `--output <monitor>` to pin a
  single monitor, `--region "X,Y WxH"` to pin one window frame in layout
  coordinates (what the dashboard sends for a chosen window) and `--json` to
  print the record. A reward screen is only available while the game shows one
  — verify the plumbing with `--file` and the capture path with a plain
  `--scan` on any desktop.

- macOS (no Nix): `brew install dotnet`, then plain `dotnet build`/`dotnet run
  --project headless -- ...`. `mono-libgdiplus` and `tesseract` are needed
  only for WFInfo's own pipeline (`--test`, `--theme-test`, `--scan`,
  `--selfcheck --ocr tesseract`). The first Vision call of a new helper
  binary prepares Apple's models (40–50 s once); later calls take about
  190 ms.
- `wfinfo-mac capture`/`rewards` need Screen Recording for the app that
  starts them. Without it the error names the setting.
- `wfinfo-mac hotkey [--key ctrl+option+s] [--url http://127.0.0.1:8000/scan/run]`
  registers a global hotkey (Carbon, no Accessibility permission) that POSTs
  the dashboard's scan route. `--fire` sends one request and exits (the test
  path without a key press).

## Verification

- macOS: `headless/macos/tests/rewards_regression.sh` (dev only) — every case
  PASS: synthetic reward screens whose name lines `rewards` must all return.

- `nix develop -c dotnet build headless/WFInfo.Headless.csproj` — clean build.
- `nix develop -c dotnet run --project headless -- --selfcheck` — PASS expected.
- `nix develop -c dotnet run --project headless -- --test tests/map.json out.json`
  — runs the suite; exit 0/1/2 per the runner contract.
- `nix develop -c dotnet run --project headless -- --scan --no-notify` — must
  print a capture line, write `<app dir>/scans/latest.json` and leave a
  `Choice`-free record (exit 0) when no reward screen is on screen.
- `nix develop -c dotnet run --project headless -- --scan --no-notify --file <png>`
  — prices an existing screenshot; the second run with the same PNG must report
  cache hits instead of fetches.
- `nix develop -c dotnet run --project headless -- --scan --watch --once --log
  <path> --no-notify` — with a reward screen on the captured output, appending a
  line containing "Got rewards" to `<path>` must produce one priced record and
  exit 0. This is the trigger-path check that needs no game session; verify it
  before claiming the watch works.

- macOS: `dotnet run --project headless -- --selfcheck` (Vision) — PASS, and
  no libgdiplus in the loaded images (see the proof above);
  `--selfcheck --ocr tesseract` — PASS with Homebrew's libraries.
- macOS: `headless/bin/Debug/net9.0/wfinfo-mac devices` lists the compute
  devices Vision offers; `swift build -c release` in `headless/macos` must
  build the same helper.

## Child DOX Index

None (no durable sub-boundaries inside this folder).
