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
