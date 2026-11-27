# tests/scan-flow — scan-flow tests (temporary place)

New tests of the scan-flow work. The lead moves them to the final layout
(`tests/headless/`, `tests/dashboard/`). Dev only: not in `WFInfo.sln`, and
the headless build does not build them.

## Commands (from the repository root)

- C# (xUnit 2, errors catalog, error mapping, crash reports):
  `dotnet test tests/scan-flow/dotnet`
- Deno (dashboard `src/lib/errors.ts`):
  `cd dashboard && deno test -A ../tests/scan-flow/deno`
- Rust layout errors stay in the crate:
  `cd headless/macos/layout && CARGO_TARGET_DIR=../../obj/rust-layout cargo test --locked`

## Rules

- Tests never write the real app dir. Crash-report tests write to a new temp
  folder and refuse to run when it is inside the real app dir.
- A test that runs the runner sets `HOME` and `CFFIXED_USER_HOME` (macOS; and
  `WFINFO_DATA_DIR` on Linux) to a temp root with
  `<root>/Library/Application Support` made first. .NET on macOS ignores a
  changed `HOME` alone.


## Settings (wfinfo-ext-settings.json)

Every test uses a temporary app dir. A guard refuses to run on the real app
dir (`~/Library/Application Support/WFInfo` on macOS, `~/.config/WFInfo` on
Linux).

- `deno/settings_file_test.ts` — read rules (missing file, invalid file →
  defaults plus SET-001, unknown keys), round trip, the atomic write leaves no
  temporary file, a failed write, concurrent changes.
- `deno/settings_route_test.ts` — `POST /settings` and `GET /api/settings`:
  loopback JSON and form posts, cross-site and remote posts refused,
  `WFINFO_SCAN_REMOTE`, bad requests, SET-002 on a failed write.
- `deno/settings_page_test.ts` — the switches on `/scan`, and the routes
  through `main.ts` with `HOME`/`WFINFO_DATA_DIR` on a temp root.
- `dotnet-settings/` — xUnit 2 tests for `headless/Scan/ExtSettings.cs`:
  defaults, valid file, invalid file → defaults plus SET-001, unknown keys.

Run:

```bash
cd dashboard && deno test -A ../tests/scan-flow/deno
dotnet test tests/scan-flow/dotnet-settings
```
