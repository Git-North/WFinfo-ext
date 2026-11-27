# errors/ — WFInfo-ext Error Catalog

## Purpose

`catalog.json` is the one list of WFInfo-ext error codes. The C# runner
(`headless/`), the Swift helper (`headless/macos/wfinfo-mac.swift`), the Rust
libraries and the dashboard all read codes from it. Every failure a user can
meet has an entry: a stable code, a memorable name, a title, a description and
what to do. An error without an entry gets a generated code (see below).

## Ownership

- `catalog.json` — the catalog. Format below.
- The readers: `headless/Errors/` (C#), the dashboard's `src/lib/errors.ts`,
  and each Rust/Swift component that reports codes.

## Format (version 1)

- `areas`: area prefix → meaning. Codes are `<AREA>-<NNN>` (three digits).
- `reserved`: ranges another component owns. PLG-001..099 belong to the
  overlay client crate; DST-001..099 to the dataset tools.
- `errors[]`: `code` (unique, never reused), `name` (one neutral word, unique
  in the catalog; no game or company trademarks), `area`, `severity`
  (`error` | `warning` | `info`), `title` (a few words), `description` (what
  happened, one or two sentences), `action` (what the user does next).
- `generated`: the rule for errors with no entry.

## Local Contracts

- A code is stable: never change what a code means, and never reuse a deleted
  code. To retire one, keep the entry and say so in its description.
- Add codes in your own area or reserved range, in code order. Names are
  single neutral words (animals, weather, tools, places). Check the name is
  not already used.
- Generated codes: FNV-1a 32-bit over the UTF-8 text
  `<exception type full name>|<site>`, where the site is
  `Namespace.Type.Method` of the innermost stack frame in WFInfo-ext code
  (no line numbers). Code = `GEN-` + 6 lower-case hex digits of
  `(hash >> 8) & 0xFFFFFF`; name = `words[hash % 64]`. Every implementation
  must reproduce `generated.testVectors`.
- Crash reports (any unhandled error, and any GEN- code) go to
  `<app dir>/crash-reports/crash-<yyyy-MM-dd_HH.mm.ss>-<component>.txt`, like
  Minecraft Java. Layout: a `---- WFInfo-ext Crash Report ----` header, an
  optional one-line quip, `Time:`, `Description:` (code, name, title), the
  error with its stack, then `-- System Details --` (OS, runtime, helper and
  library versions, WFInfo-ext settings, OCR engine).
- No personal data in any report, record or log: never an EE.log line, an IP
  address, an e-mail address, a user name or a home-directory path. Write paths
  under the home directory as `~/…`.
- Scan records and the dashboard show `ErrorCode`, `ErrorName` and the
  description/action from this catalog.

## Verification

- `python3 -I -c "import json; json.load(open('errors/catalog.json'))"` — valid JSON.
- Each reader's tests check: codes unique, names unique, every area known, and
  the generated test vectors reproduce.

## Child DOX Index

None.
