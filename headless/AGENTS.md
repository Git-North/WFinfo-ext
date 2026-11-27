# headless/ — Linux/macOS-Native OCR/Theme Runner

## Purpose

`WFInfo.Headless` is a .NET 9 console project that runs WFInfo's real OCR/theme
core natively on Linux and macOS. On macOS, Apple Vision reads the reward-strip
text (Neural Engine capable) and ScreenCaptureKit captures the screen. It links the actual WFInfo sources — no copies, no
mocks — and supplies compile-time seams for Windows-only types so the shared
code type-checks without WPF/WinForms/Win32.

## Ownership

- `WFInfo.Headless.csproj` — which shared files are linked (see the csproj
  `Compile Include` list); keep it the single source of truth for the core
  boundary.
- `Program.cs` — CLI: `--test <map.json> [out.json]`, `--theme-test
  <folder> [uiScale]` (`--theme-debug` accepted), `--selfcheck`, `--scan
  [options]`. `--selfcheck` and `--scan` take `--ocr auto|vision|tesseract`.
  Every `--test` run also copies the suite results to
  `<app dir>/ocr_runs/` (`latest.json` + one timestamped file, newest 60 kept)
  for the Warframe Info dashboard; every `--scan` run writes
  `<app dir>/scans/latest.json` (same retention) plus `scans/last.png`.
- `Scan/` — the reward-screen scan feature (Linux and macOS, real behavior):
  `ScanRunner.cs` (capture → OCR → price → recommend → persist → notify),
  `ScreenCapture.cs` (grim + wlr-randr; macOS: ScreenCaptureKit through
  `wfinfo-mac`), `EeLog.cs` (EE.log discovery + tail),
  `ScanWatcher.cs` (EE.log-driven automatic scanning), `PriceCache.cs` (local
  platinum cache with on-demand warframe.market refresh), `MarketSheet.cs`
  (indexes `market_items.json`/`market_data.json`), `Notifier.cs` (notify-send;
  macOS: osascript), `ExtSettings.cs` (reads `wfinfo-ext-settings.json`),
  `ScanModels.cs`/`ScanOptions.cs`/`Shell.cs`. The record shape is a contract
  with the dashboard's Scan page: the field list is in `README.md` (Scan) and
  the reader is `dashboard/src/lib/scan.ts` — change both together.
- The scan captures one image per candidate: `--file` (an image on disk),
  `--region "X,Y WxH"` (one layout region, i.e. a window frame), `--output`
  (one monitor), else every output then the joined image. Region coordinates are
  the compositor's own client geometry, so no conversion is needed. On macOS,
  `--window <id>` (a CGWindowID) captures one window, `--output <id>` (a
  CGDirectDisplayID) one display, else every display, main display first.
  macOS refuses `--region` at option parse (exit 2): it is a Linux layout
  region, and a display capture in its place is the wrong target.
- `--watch` scans automatically: `ScanWatcher` tails EE.log and runs a scan per
  "Got rewards" line. The game writes that line before the panel is on screen,
  so a triggered scan re-captures until a part is recognised (or `--wait`
  expires). EE.log lives in
  the Steam/Proton prefix (macOS: `~/Library/Application Support/Steam`
  compatdata, or a CrossOver bottle; the newest log wins); `--log`/
  `$WFINFO_EE_LOG` override the search. The watch is event-based on every OS
  (see "Log-watch contract").
- `macos/` — the macOS platform code (real behavior, not seams):
  `wfinfo-mac.swift` (Swift helper: `rewards`, `selfcheck`, `ocr`, `devices`,
  `displays`, `windows`, `capture`, `hotkey`, `synth`; JSON on stdout; Vision
  through the Swift `RecognizeTextRequest`, so the minimum is macOS 15),
  `Package.swift` (SwiftPM build of the same file, tools 5.9,
  `.macOS("15.0")`), `MacHelper.cs` (finds and runs the helper),
  `OcrEngines.cs` (auto/vision/tesseract choice),
  `VisionRewardScan.cs` (the macOS reward scan, see below), `layout/` (Rust
  crate `wfinfo-layout`, a cdylib: Vision lines → reward slots; its tests run
  with `cargo test`), `NoTesseractService.cs` (no engines for Vision-only
  runs), `MacNative.cs` (libgdiplus and Tesseract links for the developer
  modes only). The csproj target `BuildMacHelper` compiles the helper
  with `swiftc -target <arch>-apple-macos15.0` next to the runner on macOS
  only (swiftc ignores `MACOSX_DEPLOYMENT_TARGET`). The target
  `PublishMacHelper` copies it into the `dotnet publish` folder, also on
  macOS only.
  The helper MUST build with
  the macOS 15 SDK (Xcode 16) as well as newer ones: code that needs a newer
  SDK goes behind `#if compiler(>=6.2)` (Xcode 26) with a working fallback.
  Today that is only compute-device pinning
  (`RecognizeTextRequest.supportedComputeStageDevices`/`setComputeDevice`);
  everything else the helper uses is macOS 14/15 API.
- On macOS a scan writes NO temporary files: `wfinfo-mac rewards` captures
  and reads in memory and writes the capture only into `scans/` (`--save`).
  Every helper call gets its own path, `scans/capture-<pid>-<n>.png` (process
  id + a per-process counter: candidates, retries, both unknown-scale passes
  and every scan of a watch). The selected attempt's file becomes
  `scans/last.png`; every other file is deleted. The `--ocr tesseract` path gets
  its capture on the helper's stdout (`capture ... -`). Keep it that way. The
  Linux grim path still uses a per-run temp dir and deletes it.
- The `rewards` JSON is a contract with the Rust layout (`layout/`) and
  `VisionRewardScan.cs`: `source`, `width`, `height`, `screenScaling`,
  `uiScaleMin`/`uiScaleMax`, `crop`, `lines[]` (`text`, `confidence`, `box`
  in full-image pixels with a top-left origin), `saved`, `ms`. Keep it stable
  when the Vision API changes.
- `Platform/` — seams ONLY: `HeadlessMain.cs` (stub `Main`), `HeadlessServices.cs`
  (window-info service, process finder, screenshot/log-capture stubs,
  `CustomEntrypoint` helpers), `UiSurrogates.cs` (WPF window shapes),
  `PlatformTypeShims.cs` (Point/Key/MouseButton/Screen/Clipboard),
  `BitmapPixInterop.cs` (Bitmap → Pix via lossless PNG round-trip).
- `Errors/` — the error contract (codes from `errors/catalog.json`):
  `ErrorCatalog.cs` (lookup, generated GEN- codes, `ScanFailure`),
  `ErrorMapping.cs` (codes from helper text, any component's JSON error
  object, missing native libraries), `ErrorConsole.cs` (the stderr line,
  `Fail` for a mode), `CrashReport.cs` (crash reports), `Redact.cs` (the
  personal-data scrub), `AssemblyInfo.cs` (internals for the dev tests).
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
- `wfinfo-mac rewards` returns every line in its generous crop (squad names
  too), with full-image boxes; the caller drops lines outside the name rows.
- Vision drops lines in a wide crop that it reads in a narrow one (a wrapped
  "BLUEPRINT" under one card). With a known UI scale, `rewards` therefore also
  reads 7 narrow tiles over the strip (one per card position for 1-4 cards),
  drops tile lines cut by a tile edge, and merges duplicates (longer text
  wins). Keep this; `headless/macos/tests/rewards_regression.sh` guards it.
- On macOS the default `--selfcheck` proves the Vision stack only, not
  WFInfo's pipeline; `--selfcheck --ocr tesseract` checks that pipeline.
  The scan shells out to `grim` (capture), `wlr-randr` (output list) and
  `notify-send` (verdict); the flake's dev shell and the `.#scan` app put all
  three on PATH, so never assume they exist system-wide.
- Log-watch contract (EE.log; binding, every OS):
  - Events, not polling: a `FileSystemWatcher` on the log's directory,
    filtered to the log's file name (inotify / FSEvents /
    ReadDirectoryChangesW), so a replaced log is seen. A 3 s backup poll
    covers missed events and session replacement. A buffer overflow only
    forces a read; any other watcher error or a missing directory switches to
    a 250 ms poll and retries the watcher every 10 s.
  - Passive: open game and Steam files only through `EeLog.OpenPassive`
    (read-only, `FileShare.ReadWrite | FileShare.Delete`) and close them
    after each read. Never write, rename or create anything in the game's
    folders or the Wine/Proton/CrossOver prefix; never touch the game's
    process, memory or input.
  - Private: `LogTail.ReadNewMatches` returns only trigger phrases. No other
    EE.log text may be printed, logged (`debug.log`), stored (scan record) or
    sent anywhere: EE.log holds PC specs, the public IP and the account
    e-mail. Print the trigger phrase, never the line.
  - Scope: read only what WFInfo itself reads from the game (EE.cfg; the
    EE.log lines that WFInfo gets from the debug channel). Add no new game
    file without the user's approval (EULA risk). The "Game access" table in
    `README.md` lists every access; keep it current.
  - Wine/Proton/CrossOver: the game writes EE.log into a host folder, so host
    events fire; Wine share modes do not bind host processes. Writes can be
    buffered, so a trigger can be late; the scan's re-capture wait covers it.
- The scan reads `market_items.json`/`market_data.json` straight from disk
  instead of calling `Data.Update()`: a hotkey press must not wait for a network
  database refresh. Deeper price lookups go through `PriceCache`
  (`<app dir>/price_cache.json`): cache hits answer instantly, missing or stale
  slugs are fetched from warframe.market in parallel, failed fetches are NOT
  cached, and the sheet value is the offline fallback.
- The macOS reward scan ("vision-layout", `OcrEngine: "vision-layout"`) does
  NOT use WFInfo's extraction. WFInfo's extraction (theme colour filter, part
  boxes) is System.Drawing code, and System.Drawing needs libgdiplus on
  macOS; the user wants that library out of the scan, with no fallback.
  Instead: `wfinfo-mac rewards` captures, crops WFInfo's name rows (the
  `OCR.pixle*`/`pixelRewardLineHeight` constants, passed as arguments) and
  runs Vision on the raw colour crop; the Rust layout keeps the lines in the
  name rows, groups them into slots and joins wrapped names; each slot's
  candidates go through WFInfo's own `OCR.PartNameValid`,
  `Data.GetPartName` and `OCR.GetMaxAllowedLevenshteinDistance` (private, so
  bound by reflection — never copy it). The UI scale comes from EE.cfg next to
  EE.log (`--ui-scale auto`, WFInfo's rule); when it is unknown, a wide pass
  estimates it and a second pass reads the exact crop, because Vision drops
  names in a wide crop.
- New code that would be C, C# or C++ is written in Rust (user rule); existing
  files keep their language. C# stays only where code calls .NET or WFInfo
  (`VisionRewardScan.cs`, `MacHelper.cs`, `MacNative.cs`,
  `NoTesseractService.cs`, `OcrEngines.cs`). The reward layout is Rust
  (`macos/layout/`, serde + serde_json only, `Cargo.lock` and
  `rust-toolchain.toml` committed). Its C ABI: `wfinfo_layout(const char*
  json) -> char*` and `wfinfo_layout_free(char*)`; JSON in (`helper`,
  `rewardWidth`, `rewardHeight`, `rewardY`, `lineHeight`), JSON out (`uiScale`,
  `uiScaleEstimated`, `slots[].candidates`, `notes`, … or `error`). The csproj
  target `BuildRustLayout` runs `cargo build --release --locked` on macOS
  only (output under `obj/rust-layout/`) and copies `libwfinfo_layout.dylib`
  next to the runner; Linux and Windows builds need no Rust.
- The macOS port changes NO shared WFInfo file (`WFInfo/` stays upstream's).
  The OCR engine is chosen in `headless/`; use runtime checks
  (`OperatingSystem.IsMacOS()`), never `#if`.
- On macOS the normal scan and `--selfcheck` never load libgdiplus: no
  `Bitmap`, `Graphics` or `Image` runs in .NET (the helper renders the
  self-check sample with CoreText). Only the developer modes (`--ocr
  tesseract`, `--test`, `--theme-test`, `--selfcheck --ocr tesseract`) call
  `MacNative.EnableGdiPlus`, which links Homebrew's libgdiplus or tells the
  user to `brew install mono-libgdiplus`. Proof: run the DLL with the real
  `libexec/dotnet` and `DYLD_PRINT_LIBRARIES=1`; no `libgdiplus` line may
  appear for a scan or a self-check (Homebrew's `bin/dotnet` is a bash script,
  and SIP strips `DYLD_*` there).
- Scan passes (macOS Vision; `ScanRunner`): a watch scan
  (`RunWatchAsync`, `Trigger: "watch"`) runs a fast pass
  (`VisionRewardScan.RunFast`: `rewards --fast`, which reads no tiles; one
  read at the known or last estimated UI scale) with the re-capture loop and
  publishes it (`Stage: "fast"`) when it has parts. Then ALWAYS a deep pass
  on the same capture (`--file`, accurate, tiles, unknown-scale second pass),
  published with the same `ScanId` (`Stage: "deep"`). The deep record never
  shows fewer parts than the fast one. Manual scans (`Trigger: "manual"`)
  read once, accurate (`Stage: "single"`), unless `--two-pass`. Linux and
  `--ocr tesseract` read once.
- Keep-last-good (`ScanPublisher`, every OS): a record without choices does
  not replace a `latest.json` that has choices. That record stays with a
  `Notice`, `last.png` stays, and the empty or failed record goes only into
  the history (SCN-001 for nothing found). Keep `ScanPublisher.Decide` pure;
  `tests/scan-flow/dotnet-passes` tests it.
- Every caught scan failure sets `ErrorCode`/`ErrorName`/`ErrorAction` from
  the catalog: a `ScanFailure` or a known leading code in the helper's error
  text, the layout's `{"error":{"code",...}}` (a plain string is LAY-002),
  DllNotFound → SYS-005; anything else gets `ErrorCatalog.ForException` and
  `CrashReport.Write`. Bad options (`ArgumentException`) stay a fatal CLI
  error.
- Watch notifications follow `ExtSettings.Load().Notifications`, read at each
  trigger (default off; `--no-notify` wins). Manual scans follow
  `--no-notify` only.
- Tests that run the runner set `HOME` and `CFFIXED_USER_HOME` (macOS; .NET
  ignores `HOME` alone there) or `WFINFO_DATA_DIR` (Linux) to a temp root,
  and refuse to run when the app dir is the real one.
- `scans/last.png` and `scans/latest.json` are one pair: write both under
  per-process temporary names in `scans/` (`last.png.<pid>.tmp`,
  `latest.json.<pid>.tmp`), then rename the screenshot and the record last.
  Never write either file in place. Stale `.tmp` files (owner process gone,
  or older than 10 minutes) are deleted at the next scan start.
- `ExtSettings` (`<app dir>/wfinfo-ext-settings.json`,
  `{"version":1,"notifications":false,"overlayPin":false}`): the runner only
  reads it, never writes it (the dashboard owns the write). Call
  `ExtSettings.Load()` at each scan start and each watch trigger, never once
  per process. `Load` never throws: a missing file gives the defaults (all
  off); an unreadable or invalid file (not a JSON object, version not 1, a
  switch not true/false) gives the defaults and `WarningCode` "SET-001";
  record that code as a warning. Unknown keys are ignored. `Load(path)` is
  for tests on a temp dir. The rules match `dashboard/src/lib/settings.ts`;
  change both together.
- The scan writes only `<app dir>/scans/` (records + `last.png`) and
  `<app dir>/price_cache.json`. It never writes the Windows-side files and never
  touches the ocr_runs history.
- Native library names are exact (wrapper dlopens them):
  `libtesseract50.so`, `libleptonica-1.82.0.so`; supplied by the flake's
  `tesseract-native` farm through `WFINFO_NATIVE_LIBS`. On macOS without that
  variable, `MacNative.EnableTesseract` links Homebrew's
  `libtesseract.5`/`libleptonica.6` into `<bin>/macos-native/` under the same
  names — only when Tesseract runs (`--ocr tesseract`, the OCR suite); Vision
  runs never load or mention Tesseract. `MacNative.EnableGdiPlus` links
  `libgdiplus.dylib` next to `System.Drawing.Common.dll` (dyld does not search
  the Homebrew prefix) for the developer modes only.
- `System.Drawing.Common` is pinned to 6.0.0: versions ≥ 7 throw
  PlatformNotSupportedException on Linux even with `EnableUnixSupport`.
- Error contract (binding):
  - Throw `ScanFailure(code, detail)` where the cause is known; the detail
    holds no personal data. Never throw a bare exception for a known cause.
  - A mode prints a failure with `ErrorConsole.Fail(ex, component)`:
    `ERROR <code> <name>: <title> — <description> (crash report: <path>)`,
    then `Detail:` and `What to do:`, exit 2. A catalog code gets no crash
    report; anything else gets a GEN- code and a crash report. The top-level
    guard in `Main` reports every escaped exception with a crash report.
  - Catalog severity sets the word: `WARNING` for warning/info, else `ERROR`.
    DAT-001/DAT-003 (market_items/name_data missing or unreadable) stop the
    scan; DAT-002 (market_data) is a warning.
  - `wfinfo-mac` failures print `wfinfo-mac: [<CODE>] <message>` (CAP-001..005,
    OCR-001); `MacHelper` throws a `ScanFailure` with that code. Usage errors
    have no code and stay an `InvalidOperationException`. `MacHelper` itself
    throws SYS-001 (not built / cannot start), SYS-002 (timeout), SYS-003 (no
    JSON), SYS-004 (bad `WFINFO_MAC_HELPER`).
  - The layout library answers `{"error":{"code":"LAY-001"|"LAY-002","message":…}}`.
    Read any component's error object with `ErrorMapping.FromJson`; it keeps
    a well-formed code that the catalog does not list (e.g. PLG-).
  - Crash reports go only to `<app dir>/crash-reports/` (newest 20). A test or
    script that runs the runner sets `HOME` and `CFFIXED_USER_HOME` (Linux:
    `WFINFO_DATA_DIR`) to a temp root and refuses the real app dir.
    `WFINFO_FAULT=crash` is the developer hook for a forced crash.
- Env vars honored by `Program.cs`:
  - `WFINFO_NATIVE_LIBS` — dir with tesseract/leptonica libs (flake sets it).
  - `WFINFO_DATA_DIR` — overrides the app-data root (tessdata + market DBs).
    No effect on macOS (the runner warns): .NET does not read
    `XDG_CONFIG_HOME` there.
  - `WFINFO_OCR_ENGINE` — default `--ocr` (auto, vision, tesseract).
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

- macOS (no Nix): `brew install dotnet rust`, then plain `dotnet build`/`dotnet run
  --project headless -- ...`. `mono-libgdiplus` and `tesseract` are optional:
  only the developer modes (`--ocr tesseract`, `--test`, `--theme-test`) need
  them.
  The first Vision call of a new helper binary prepares Apple's models (40–50 s
  once); later calls take about 190 ms (one image) or 250 ms (eight in one
  call). `VisionRewardScan` gives each helper call 120 s for that first call;
  keep it under the dashboard's 180 s scan deadline.
- macOS capture needs Screen Recording for the app that starts the scan (the
  terminal, or the app that runs the dashboard). Without it the capture error
  names the setting.
- `wfinfo-mac hotkey [--key ctrl+option+s] [--url http://127.0.0.1:8000/scan/run]`
  registers a global hotkey (Carbon, no Accessibility permission) that POSTs
  the dashboard's scan route. `--fire` sends one request and exits (the test
  path without a key press).
- No real reward screenshot exists yet. Test the macOS scan with synthetic
  screens: `wfinfo-mac synth --out <png> --names "A|B|C" --ui-scale <u>
  [--color "#hex"] [--squad "p1|p2"]`, then `--scan --no-notify --file <png>
  --ui-scale <u|unknown>`. Synthetic screens prove the crop and the layout,
  not real game rendering.

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
  before claiming the watch works. Test a replaced log too (write a new file,
  rename it over the log), and check that no non-trigger line appears in the
  output, `debug.log` or the scan record.
- macOS: `dotnet run --project headless -- --selfcheck` (Vision) — PASS, and
  no libgdiplus in the loaded images (see the proof above).
- macOS: `cd headless/macos/layout && cargo test` — the layout cases and the
  parity fixtures PASS (offline, no capture).
- macOS: `--scan --no-notify --file <synth png> --ui-scale unknown` — every
  synthetic name priced.
- macOS: `headless/bin/Debug/net9.0/wfinfo-mac devices` lists the compute
  devices Vision offers; `swift build -c release` in `headless/macos` must
  build the same helper.

## Child DOX Index

None (no durable sub-boundaries inside this folder).
