# tests/dataset/ — Reward-Screen Dataset Tools

## Purpose

Deno tools that fill the local, git-ignored `../../training/` folder with
categorised reward screenshots: the user's own scans and public sources. Usage,
rights and limits are in `README.md`.

## Ownership

- `main.ts` — command line. `src/` — logic; `src/sources/` — one file per
  source. `tests/` — offline tests. `deno.json` — tasks.

## Local Contracts

- No image or index is ever committed. Every command opens the dataset through
  `DatasetStore.open`, which refuses a folder that git could pick up
  (`DST-008`). Keep that check.
- Game files and the app data folder are read only. From `EE.log`, only named
  fields matched by narrow patterns; never copy, print or store a line. Never
  touch the game.
- Never run the scanner against the user's app data folder. Candidates run in
  the sandbox (`src/scanner.ts`). On macOS only `CFFIXED_USER_HOME` moves
  .NET's app data folder; keep it with `HOME`.
- Do not change the runner. Read its files. The scan record is parsed by
  `dashboard/src/lib/scan.ts`; the extra fields are optional.
- Theme colours and layout constants come from `WFInfo/Ocr.cs`
  (`src/wfinfo_source.ts`). Do not copy the values and do not edit that file.
- Sites: https, listed hosts, pauses, a generic User-Agent without personal
  data. A refusal (403, bot check, sign-in) ends the run. Never add cookies, a
  browser User-Agent or another way round.
- Do not claim that any image is free to use. Every sidecar keeps source,
  author, id, date, stated licence and rights note.
- Squad-name rows and the chat area of downloaded images are masked by
  default.
- A kept image is only a scanner hit. `review` holds what a person saw; the
  tools never set it themselves.
- Downloads default to pilot sizes (5 videos, 50 images). The user approves a
  larger run.
- No remote or package imports. Linux and macOS: no tool that only one has.
- Errors are `DatasetError` with a `DST-` code in `../../errors/catalog.json`
  (rules in `../../errors/AGENTS.md`).
- Temporary folders come from `src/temp.ts` and are removed on success, error
  and interrupt.

## Verification

- In this folder: `deno task check`, `lint`, `fmt:check`, `test` (offline;
  needs ffmpeg and git).
- After a change to geometry, themes or masking, check a real reward screen
  (`deno task dataset wfinfo-ng --out <temp folder>`): theme VITRUVIAN with
  high confidence, four parts, squad names and chat area unreadable.

## Child DOX Index

None.
