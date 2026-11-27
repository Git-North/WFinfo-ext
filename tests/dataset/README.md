# Reward-screen dataset tools

These tools collect Warframe fissure reward screenshots into the local,
git-ignored [`training/`](../../training/README.md) folder and categorise each
one. They run on Linux and macOS.

**The images are not known to be free to use or share.** Read
[`training/README.md`](../../training/README.md) first. Keep the set local.

## Needs

- Deno, ffmpeg, git. For `youtube`: yt-dlp. For the public sources: .NET and a
  built runner (`dotnet build headless/WFInfo.Headless.csproj`).
- macOS: `brew install deno ffmpeg yt-dlp dotnet rust`. Linux: `nix develop`.
- WFInfo's market databases in the app data folder (one scan or one OCR-suite
  run creates them).

## Use

Run in `tests/dataset/`:

```bash
deno task dataset own                 # archive your scans
deno task dataset own --watch         # ...and every new one, while you play
deno task dataset wfinfo-ng           # one GPL-3.0 test screenshot
deno task dataset reddit              # at most 50 images
deno task dataset youtube --search "warframe radshare"   # at most 5 videos
deno task dataset stats               # category spread
deno task dataset label <id> reward   # or: other (a scanner false positive)
deno task dataset --help              # every option
```

The defaults are pilot sizes. `--limit` and `--max-videos` raise them.

### Your own scans

`own` only reads: `scans/latest.json`, `scans/last.png`, the `scan-*.json`
history and `debug.log` in the app data folder, and the game's `EE.cfg` and
`EE.log`. Each scan overwrites `last.png`, so only the newest record has its
image; older records are stored without one. Use `--watch` to keep every image.
The screenshot is stored only when its size and file times show that it belongs
to the record.

From `EE.cfg` it takes the UI scale and a fixed list of graphics settings. From
`EE.log` it takes two values, the game build and the `-language` switch, and
stores nothing else: the log holds PC specifications, the public IP address and
the account e-mail address. Both files are read only for a live capture that is
archived with its image. It never touches the game.

### Public sources

Each candidate goes to the real scanner (`WFInfo.Headless --scan --file`) in a
temporary sandbox: its own app data folder (`HOME` and `CFFIXED_USER_HOME`),
copies of the market databases and a pre-filled price cache. Your scan history
is not touched and no price request is sent. An image is kept when the scanner
reads 1-4 reward names.

- **YouTube:** one frame every 4 s (`--interval`). Frames of one reward screen
  are grouped, and the one with the most cards, then the sharpest, is kept. The
  video is deleted afterwards. yt-dlp runs without configuration or cookies.
- **Reddit:** the public search JSON, one request per 7 s, with a generic
  User-Agent. Reddit's `robots.txt` disallows all automated clients, and one
  test request during development (2026-11) got HTTP 403 ("blocked by network
  security"). On such an answer the tool stops (`DST-009`). Do not work around
  it. No live run of this collector has been made. The permitted route would be
  Reddit's Data API with access that Reddit has approved; the tool does not use
  it.
- **wfinfo-ng:** `test-images/1.png`, checked against its Git LFS SHA-256.

A bot check or sign-in request from any site also ends the run.

## What a sidecar holds

| Block | Contents |
|---|---|
| `categories` | size, resolution and aspect class, card count, theme, UI scale and where it came from, language and its basis, OCR engine, rarities, item types, prime sets, vaulted, Forma |
| `parts[]` | name, slug, set, component, item type, vaulted, ducats, sheet price, rarity, relic count, relics that are not vaulted |
| `theme` | estimate from the pixels of the reward names, text colour, distance, confidence, near ties |
| `scan` | start, duration, capture source and target, engine, and `ScanId`/`Stage`/`Trigger`/`ErrorCode` when the record has them |
| `game` | build, language, UI scale and graphics settings (own live scans only) |
| `quality` | source codec, bits per pixel, sharpness of the name rows |
| `source`, `rights` | address, id, author, date, stated licence, download date, video format, rights note |
| `privacy`, `dedupe` | whether and where names are masked; hash of the cards |
| `review` | what a person saw: `unreviewed`, `reward` or `other`, with a note |

`index.csv` has one row per sidecar. Lists are joined with `;`.

## Review every image

**"The scanner reads 1-4 names" does not prove a reward screen.** In the first
pilot (5 videos, 16 kept frames), 6 frames showed a reward screen (one of them
twice, now grouped) and 10 showed the Foundry, relic refinement or selection,
Nightwave offerings or a text slide. All 5 frames with 3-4 cards were reward
screens; 10 of the 11 frames with 1-2 cards were not. So filter on `slotCount`
3-4, or look at each image and label it. Labelled false positives are useful
test cases too: today's scanner reports parts on them.

## Limits

- **Biased sample.** Downloaded images are kept only when today's scanner can
  read them. The set cannot show the scanner's misses, and so it must not be
  used to measure how often the scanner succeeds.
- **English only for downloads.** The sandbox scanner matches English item
  names, so screens in other game languages are rejected.
- **A name is not proof.** The scanner's name matching is fuzzy: a name can be
  wrong. `parts` is the scanner's reading, not ground truth.
- **UI scale of downloads is the scanner's estimate.** Scaled or cropped videos
  change it, and a letterboxed video keeps its black bars.
- **Theme** is a guess from text colour. Video compression and dim frames move
  colours (two dim gold frames of the pilot read as EQUINOX, `low`), and
  several themes share white or near colours (`confidence`, `ambiguousWith`).
- **Card count** is what the scanner read: the squad had at least that many.
- **OCR device** is unknown: the scan record does not hold it.
- **Masking** covers the squad-name row (placed from the estimated UI scale)
  and the bottom-left chat area. A moved chat window or a streamer's overlay
  stays. Look at the images before you rely on it.

## Duplicates

The same source bytes are stored once. A download is also dropped when the set
already has the same names at the same size with an almost equal picture of the
cards (24 of 256 hash bits). `seen.json` stops a later run from downloading a
handled item again.

## Check

```bash
deno task check && deno task lint && deno task fmt:check && deno task test
```

The tests use no network. They need ffmpeg and git. Errors have `DST-` codes
from [`errors/catalog.json`](../../errors/catalog.json); an unknown error gets
a `GEN-` code and a report in `<app dir>/crash-reports/`.
