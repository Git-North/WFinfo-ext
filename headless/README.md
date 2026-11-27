# WFInfo.Headless — run WFInfo's OCR core natively on Linux and macOS

A .NET 9 console runner that links the real WFInfo core sources (`Ocr.cs`,
`Data.cs`, language processors, Tesseract service, settings, test harness) and
runs them on Linux and macOS without WPF/WinForms/Win32. No code forks, no mocks: the OCR
suite and theme detector execute the production pipelines.

## Quick start

```bash
nix develop
dotnet build headless/WFInfo.Headless.csproj
dotnet run --project headless -- --selfcheck          # end-to-end OCR proof
dotnet run --project headless -- --test tests/map.json out.json   # OCR suite
dotnet run --project headless -- --theme-test <folder-with-pngs>  # theme detector
```

The dev shell wires up native `libtesseract50.so`/`libleptonica-1.82.0.so`
(exact sonames the wrapper dlopens), `libgdiplus` (System.Drawing), fonts, and
`.NET` runtime libs via environment variables.

## macOS (Apple Silicon, no Nix)

The runner builds on macOS with Homebrew's .NET, and a small Swift helper,
`wfinfo-mac`, gives it Apple's Vision framework (the Swift
`RecognizeTextRequest` API, accurate mode; Vision can run it on the Neural
Engine) and ScreenCaptureKit. The helper needs macOS 15 or later.
`--selfcheck` reads its sample with Vision and loads no libgdiplus.

WFInfo's own pipeline (`--test`, `--theme-test`, `--scan`, `--selfcheck --ocr
tesseract`) runs on `System.Drawing` and Tesseract, so on macOS it needs
`mono-libgdiplus` and `tesseract`. Screen capture for `--scan` is still grim
(Linux) in this runner.

```bash
brew install dotnet
brew install mono-libgdiplus tesseract           # optional: only for WFInfo's own pipeline (--test, --theme-test, --scan)
dotnet build headless/WFInfo.Headless.csproj     # also compiles headless/macos/wfinfo-mac
dotnet run --project headless -- --selfcheck     # Vision (CoreText sample, no libgdiplus)
dotnet run --project headless -- --selfcheck --ocr tesseract   # WFInfo's Tesseract stack
```

- The project targets net9.0 and rolls forward to the newest installed runtime
  (`RollForward=Major`), so Homebrew's .NET is enough.
- `mono-libgdiplus` and `tesseract` are optional. The modes that run
  WFInfo's own pipeline link Homebrew's libraries when they start (see
  `macos/MacNative.cs`), or name the `brew install` command when one is
  missing. The Vision self-check never loads them.
- The app dir is `~/Library/Application Support/WFInfo`. `WFINFO_DATA_DIR` has
  no effect on macOS.
- `wfinfo-mac capture`/`rewards` need **Screen Recording** for the app that
  starts them: System Settings > Privacy & Security > Screen & System Audio
  Recording. Restart that app after the change.
- The first Vision call of a new helper binary prepares Apple's models (40–50 s
  once). Later calls take about 190 ms for one part image and about 250 ms for
  eight in one call (accurate mode).
- `--device` (or `WFINFO_VISION_DEVICE`) pins the compute device for every
  Vision stage that lists it (`wfinfo-mac devices`). Vision accepts the pin;
  timings are nearly the same on every device, so they do not show which unit
  ran the model.

The helper `headless/bin/Debug/net9.0/wfinfo-mac` also works alone:

| Command | Effect |
|---|---|
| `wfinfo-mac ocr [--fast] [--correction] [--lang en-US] [--device auto\|ane\|gpu\|cpu] <png>... \| - \| --frames` | Vision text, lines, boxes (pixels, top-left origin) and confidences as JSON; up to 4 images run at the same time, results keep input order. `--frames` reads images from stdin, each a 4-byte big-endian length and the PNG |
| `wfinfo-mac devices` | compute devices Vision offers for text recognition |
| `wfinfo-mac displays` / `windows` | displays and on-screen windows (ids for `--output`/`--window`) |
| `wfinfo-mac capture --display <id> \| --window <id> <out.png> \| -` | one ScreenCaptureKit screenshot; `-` writes the PNG to stdout |
| `wfinfo-mac rewards [--display\|--window\|--file] --reward-width 968 --reward-height 235 --reward-y 316 --line-height 48 --ui-scale <u> [--save <png>]` | capture (or read), crop the reward-name rows, read them with Vision; lines with full-image boxes as JSON |
| `wfinfo-mac selfcheck` | render "Volt Prime Blueprint" with CoreText and read it |
| `wfinfo-mac synth --out <png> --names "A\|B" [--ui-scale u] [--color #hex] [--squad "p1\|p2"]` | synthetic reward screen for tests |
| `wfinfo-mac hotkey [--key ctrl+option+s] [--url <scan url>]` | global hotkey that starts a dashboard scan |

`hotkey` uses a Carbon hotkey, so it needs no Accessibility permission. Run it
next to the dashboard:
`wfinfo-mac hotkey --url http://127.0.0.1:8000/scan/run`. `--fire` sends one
request and exits. Log lines show the URL without user, password, query or
fragment.

## CLI

| Command | Effect |
|---|---|
| `--test <map.json> [out.json]` (or plain `<map.json>`) | OCR regression suite |
| `--theme-test <folder> [uiScale]` (`--theme-debug` also works) | theme detection over PNGs |
| `--selfcheck [--ocr <engine>]` | renders sample text and OCRs it — verifies natives + tessdata/Vision + imaging |
| `--scan [options]` | reward-screen scan: capture, OCR, price, notify, record |
| `--scan --watch` | scan automatically on every reward screen (EE.log), until stopped |

Every `--test` run also persists its results to the WFInfo data dir under
`ocr_runs/` (`latest.json` plus a timestamped copy; the newest 60 are kept).
The Warframe Info dashboard (`dashboard/`, run with `nix run .#dashboard`)
shows these runs on its "Recently seen" page together with reward screens
parsed from `debug.log`.

Exit codes: `0` all passed, `1` partial failures, `2` fatal errors.

## Scan — reward-screen hotkey

`--scan` reads the screen, runs the production OCR pipeline over the reward
strip, prices every recognised part, shows the best platinum choice as a desktop
notification, and writes a scan record the dashboard's "Scan" page displays.

The same scan runs from the dashboard: press **Scan now** on its Scan page
(the server runs the command below with `WFINFO_SCAN_ROOT` set to this
checkout, and `--no-notify` because the page reports the result). The page can
also pin one display or one window; it then passes `--output` or `--region`.

```bash
nix run .#scan                     # capture every output, notify, record
nix run .#scan -- --refresh        # ignore the price-cache TTL
nix run .#scan -- --file shot.png  # price an existing screenshot (no capture)
nix run .#scan -- --output DP-2    # capture one monitor
nix run .#scan -- --region "10,44 1900x1026"   # capture one window's frame
nix run .#scan -- --json           # print the record to stdout
```

| Option | Effect |
|---|---|
| `--file <png>` | OCR this screenshot instead of capturing the screen |
| `--output <name>` | grim output (monitor) to capture; default tries each output, then the joined image |
| `--region "X,Y WxH"` | capture one layout region — a window's frame, in the same coordinates the compositor reports for its clients |
| `--theme <name>` | force a UI theme instead of the automatic probe (`auto` restores the probe) |
| `--refresh` | ignore the local price-cache TTL for this run |
| `--ttl <hours>` | price-cache lifetime (default 6) |
| `--no-notify` | skip the desktop notification |
| `--json` | print the scan record to stdout |

Bind it to a key in the window manager (mango/dwl example, `spawn_shell`):

```
None,Print,spawn_shell,nix run /path/to/WFinfo-ext#scan
```

Each run does this:

1. Capture: `grim -o <output>` for every output (via `wlr-randr`), stopping at
   the first screen that parses, else the joined image. `--output` pins one
   output and `--region "X,Y WxH"` pins one layout region (a window's frame);
   either makes the scan a single capture, and `--file` pins an image on disk.
2. OCR: the shared `ProcessRewardScreenForTest` pipeline plus WFInfo's
   Levenshtein name correction against `market_items.json`. A failed attempt
   retries once per UI theme, because the theme probe samples a single pixel
   column. `--theme` pins one theme and skips the retries.
3. Prices: the local cache answers instantly; missing or stale slugs are fetched
   from warframe.market's public statistics endpoint in parallel. No price is
   invented: the sheet in `market_data.json` is the offline fallback.
4. Verdict: highest platinum wins (ties: more ducats, then the later choice —
   the same rule as the Windows overlay) and is posted with `notify-send`.
5. Record: `<data dir>/WFInfo/scans/latest.json`, one timestamped copy per run
   (newest 60 kept) and the OCR'd screenshot as `scans/last.png`.

`<data dir>/WFInfo/price_cache.json` holds the platinum cache keyed by
warframe.market slug (`plat`, 48-hour `volume`, `fetchedAt`). Failed fetches are
not cached, so a network hiccup retries on the next scan instead of pinning a
stale price.

### Automatic scanning (EE.log watch)

The Windows app has an "Auto" mode: it reads Warframe's debug log and shows the
overlay as soon as the game reports a reward screen. `--watch` is the Linux
equivalent — it tails `EE.log` in the Proton prefix and runs a scan for every
reward screen. The trigger is the same message the Windows watcher keys on,
`ProjectionRewardChoice.lua: Got rewards`.

```bash
nix run .#scan-watch                          # watch, notify on every reward screen
nix run .#scan-watch -- --output DP-2         # ...capturing one monitor
nix run .#scan-watch -- --once                # scan on the first trigger, then exit
nix run .#scan-watch -- --log /path/EE.log    # watch a specific log
```

| Option | Effect |
|---|---|
| `--watch` | keep running and scan on every reward screen |
| `--once` | scan on the first trigger, then exit (implies `--watch`) |
| `--log <path>` | EE.log to watch; default is the Steam/Proton prefix, else `$WFINFO_EE_LOG` |
| `--wait <seconds>` | keep re-capturing until a part is recognised (default 10 in watch mode) |
| `--cooldown <seconds>` | ignore further triggers for this long after a scan starts (default 5) |

The engines, market sheet and price cache are built once at start-up, so a
triggered scan is one capture plus the OCR — about a second with a warm price
cache.

The game writes the trigger line *before* the reward panel is on screen, so a
triggered scan re-captures every 400 ms until a part is recognised or `--wait`
runs out. A capture that finds nothing yet writes no record, so the dashboard
only shows scans whose names were read.

Bind the watch to a session start (mango example):

```
exec,nix run /path/to/WFinfo-ext#scan-watch
```

Stop it with Ctrl-C; it also exits on `SIGTERM`.

### Scan record

`scans/latest.json` (and each `scans/scan-<stamp>.json`) is the contract with
the dashboard's Scan page; `dashboard/src/lib/scan.ts` parses it.

```json
{
  "Version": 1,
  "StartedAt": "2026-09-10T14:31:02.123Z",
  "FinishedAt": "2026-09-10T14:31:03.480Z",
  "DurationMs": 1357,
  "CaptureSource": "grim",
  "CaptureTarget": "DP-2",
  "ScreenshotPath": "/home/user/.config/WFInfo/scans/last.png",
  "ScreenshotWidth": 1920,
  "ScreenshotHeight": 1080,
  "UiScaling": 1.0,
  "Theme": "STALKER",
  "ThemeWeight": 0.00398406374501992,
  "Choices": [
    {
      "Index": 1,
      "Part": "Mirage Prime Systems",
      "Slug": "mirage_prime_systems_blueprint",
      "Plat": 62.0,
      "PlatSource": "wfm",
      "PlatFetchedAt": "2026-09-10T14:31:03.201Z",
      "Volume": 41,
      "Ducats": 45,
      "Best": true
    }
  ],
  "Best": { "Index": 1, "Part": "Mirage Prime Systems", "Plat": 62.0 },
  "BestDucats": { "Index": 1, "Part": "Mirage Prime Systems", "Ducats": 45 },
  "PriceCache": { "Hits": 1, "Fetched": 2, "Failed": 0, "Entries": 137 },
  "Error": null
}
```

- Keys are always present; numbers are `null` when unknown.
- `Choices[]` is in screen order, `Index` starts at 1; `Part` is the
  OCR-corrected market name, `Slug` the warframe.market `url_name`.
- `PlatSource`: `wfm` (fetched this run), `cache`, `sheet` (offline fallback) or
  `none`.
- `Theme` is the UI theme used for the extraction: the probe result, the retry
  that matched, or the forced name. `ThemeWeight` is the probe confidence and is
  `0` when a theme is forced.
- `Best`/`BestDucats` follow the Windows overlay ranking; the same entry carries
  `"Best": true`.
- A scan with no reward screen on screen still writes a record with
  `Choices: []` (`Error: null`); a capture or database failure sets `Error`.

## Environment

- `WFINFO_NATIVE_LIBS` — directory containing `libtesseract50.so` and
  `libleptonica-1.82.0.so` (set by `nix develop`; override for other distros).
- `WFINFO_DATA_DIR` — application-data root override. tessdata and the market
  databases are stored under `<data dir>/WFInfo` (default: OS XDG config dir).
- `WFINFO_EE_LOG` — path to Warframe's `EE.log` for `--watch`; overrides the
  Steam/Proton prefix search (same as `--log`).
- `WFINFO_OCR_ENGINE` — default for `--selfcheck --ocr`: `auto` (Vision on
  macOS when the helper is built, else Tesseract), `vision` or `tesseract`.
- `WFINFO_VISION_DEVICE` — Vision compute device: `auto` (Vision chooses),
  `ane`, `gpu` or `cpu`.
- `WFINFO_MAC_HELPER` — path of `wfinfo-mac` (default: next to the runner).
  White space around the path is ignored, and a blank value counts as unset.
  On macOS a path to a missing file is an error; it does not fall back to
  Tesseract.

## Architecture

- `WFInfo.Headless.csproj` links shared sources from `../WFInfo` — this list is
  the core boundary.
- `macos/` holds the macOS code: the Swift helper and its C# callers.
- `Platform/` holds compile-time seams only (see `AGENTS.md` in this folder):
  stubs for Windows-only classes referenced by shared code, WPF/WinForms type
  shims, and a Bitmap→Pix bridge (lossless PNG round-trip).
- `System.Drawing.Common` is pinned to **6.0.0**: newer versions throw
  `PlatformNotSupportedException` on Linux.
- Shared core files must stay Windows-equivalent; path building uses
  `Path.Combine`.

See `AGENTS.md` in this folder and the repo root for contracts.
