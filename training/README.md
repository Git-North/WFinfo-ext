# training/ — local reward-screen dataset

This folder holds screenshots of Warframe reward screens for tests, and maybe
for training later. The tools in [`tests/dataset/`](../tests/dataset/README.md)
fill it. Git ignores everything here except this file and `.gitignore`.

**Never commit, push, upload or share an image or an index from this folder.**

## Rights

The images are **not** known to be free to use or to share.

- **YouTube** frames belong to the video's uploader. A video without a stated
  licence is under YouTube's standard licence, and YouTube's terms restrict
  downloading.
- **Reddit** images belong to the person who posted them. Reddit's terms and
  Public Content Policy restrict automated collection.
- **knoellle/wfinfo-ng**'s test image comes from a GPL-3.0 repository.
- All of them show Digital Extremes' game.

Each sidecar records the source address, author, item id, date, any stated
licence and the download date. A Creative Commons label on a video is the
uploader's statement; the tools do not check it. The user chose to keep this
set local and unshared.

## Privacy

Player names in a screenshot are other people's names. Downloaded images are
stored with the squad-name row under the cards and the bottom-left chat area
masked. Names can remain in other places, such as a moved chat window or a
streamer's overlay, and your own scans are stored as captured unless you pass
`--blur-squad`.

## An image here is not proof of a reward screen

The tools keep what today's scanner reads as a reward screen, and it is often
wrong for 1-2 cards. Each sidecar's `review` says what a person saw
(`unreviewed`, `reward` or `other`). See the tools' README.

## Layout

| Path | Contents |
|---|---|
| `images/<source>/<id>.png` (`.jpg`, `.webp`) | the image |
| `images/<source>/<id>.json` | its sidecar: categories, parts, source, rights |
| `records/own/<id>.json` | your older scans, whose screenshot was overwritten |
| `index.csv`, `index.json` | one flat row per sidecar, for filtering |
| `runs/` | one report per collection run |
| `seen.json` | source items already handled |

To remove an image, delete it with its `.json`, then run
`deno task dataset index` in `tests/dataset/`.
