# tests/scan-flow — scan-flow tests

Dev-only tests for the scan-flow work. Each part has its own section.

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
