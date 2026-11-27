/** Command line of the reward-screen dataset tools. See README.md. */

import { parseArgs } from "./src/cli.ts";
import { DatasetError, describeError, reportCrash } from "./src/errors.ts";
import { loadGameData } from "./src/game_data.ts";
import { readGameInfo } from "./src/game_files.ts";
import { formatSpread } from "./src/index_file.ts";
import { PoliteClient } from "./src/net.ts";
import { absolutePath, defaultAppDir, REPO_ROOT } from "./src/paths.ts";
import {
  createSandboxScanner,
  findRunner,
  type Scanner,
} from "./src/scanner.ts";
import type { CollectContext, RunReport } from "./src/sources/collect.ts";
import { archiveOnce, type OwnContext, watchScans } from "./src/sources/own.ts";
import * as reddit from "./src/sources/reddit.ts";
import * as wfinfong from "./src/sources/wfinfong.ts";
import {
  collectYoutube,
  searchVideos,
  videoId,
} from "./src/sources/youtube.ts";
import { DatasetStore } from "./src/store.ts";
import type { SourceKind } from "./src/sidecar.ts";
import { removeAllTempFolders } from "./src/temp.ts";
import { loadWfinfoConstants } from "./src/wfinfo_source.ts";

const HELP = `Warframe reward-screen dataset tools

Usage: deno task dataset <command> [options]

Commands
  own         archive your scans from the WFInfo app data folder (read only)
  wfinfo-ng   fetch the test screenshot of knoellle/wfinfo-ng
  reddit      collect reward screens from public Reddit posts
  youtube     collect reward-screen frames from YouTube videos
  label <id> <reward|other>
              record what you saw in an image (--note <text>)
  index       rebuild index.csv and index.json from the sidecars
  stats       print the category spread

All commands
  --out <folder>        dataset folder (default: training/ in the repository)

own
  --app-dir <folder>    WFInfo app data folder (default: the scanner's)
  --ee-log <path>       EE.log to read (default: Steam or CrossOver prefix)
  --watch               keep running and archive every new scan
  --no-history          skip the older records, which have no screenshot
  --blur-squad          mask squad names and chat (default: as captured)

wfinfo-ng, reddit, youtube
  --db-dir <folder>     market databases (default: the app data folder)
  --runner <dll>        WFInfo.Headless.dll (default: headless/bin/...)
  --no-blur-squad       keep squad names and chat (default: masked)

reddit
  --limit <n>           images to download at most (default 50)
  --subreddit <name>    repeatable (default Warframe)
  --query <text>        repeatable (default: three relic searches)

youtube
  --url <video>         repeatable
  --search <text>       repeatable; adds search results
  --max-videos <n>      videos at most (default 5)
  --interval <s>        seconds between frames (default 4)
  --max-height <px>     tallest format (default 2160)
  --max-duration <s>    skip longer videos (default 1200)
  --max-megabytes <n>   skip larger downloads (default 700)
  --jobs <n>            parallel scans (default 3)
`;

const SPEC = {
  flags: ["help", "watch", "no-history", "blur-squad", "no-blur-squad"],
  values: [
    "out",
    "note",
    "app-dir",
    "ee-log",
    "db-dir",
    "runner",
    "limit",
    "max-videos",
    "interval",
    "max-height",
    "max-duration",
    "max-megabytes",
    "jobs",
  ],
  lists: ["url", "search", "subreddit", "query"],
};

const COMMANDS: Record<string, string[]> = {
  own: ["watch", "no-history", "blur-squad", "app-dir", "ee-log"],
  "wfinfo-ng": ["db-dir", "runner", "no-blur-squad"],
  reddit: [
    "db-dir",
    "runner",
    "no-blur-squad",
    "limit",
    "subreddit",
    "query",
  ],
  youtube: [
    "db-dir",
    "runner",
    "no-blur-squad",
    "url",
    "search",
    "max-videos",
    "interval",
    "max-height",
    "max-duration",
    "max-megabytes",
    "jobs",
  ],
  label: ["note"],
  index: [],
  stats: [],
};

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, SPEC);
  const command = args.positional[0];
  if (args.flag("help") || command === undefined) {
    console.log(HELP);
    return command === undefined && !args.flag("help") ? 2 : 0;
  }
  const accepted = COMMANDS[command];
  const operands = command === "label" ? 3 : 1;
  if (!accepted || args.positional.length !== operands) {
    throw new DatasetError("DST-001", `unknown command: ${args.positional}`);
  }
  for (const name of args.given) {
    if (name !== "out" && !accepted.includes(name)) {
      throw new DatasetError("DST-001", `${command} has no --${name}`);
    }
  }

  const out = absolutePath(args.value("out") ?? `${REPO_ROOT}/training`);
  const store = await DatasetStore.open(out);

  if (command === "label") {
    const [, id, screen] = args.positional;
    if (screen !== "reward" && screen !== "other") {
      throw new DatasetError("DST-001", "the label is reward or other");
    }
    const note = args.value("note") ?? null;
    if (!await store.label(id, { screen, note })) {
      throw new DatasetError("DST-001", `no entry ${id}`);
    }
    await store.writeIndex();
    return 0;
  }

  if (command === "stats" || command === "index") {
    if (command === "index") await store.writeIndex();
    console.log(formatSpread(store.rows()));
    return 0;
  }

  const constants = await loadWfinfoConstants();
  if (command === "own") {
    const appDir = absolutePath(args.value("app-dir") ?? defaultAppDir());
    const eeLog = args.value("ee-log");
    const context: OwnContext = {
      appDir,
      store,
      constants,
      gameData: await loadGameData(appDir),
      game: () => readGameInfo(eeLog, Deno.env.toObject()),
      redactNames: args.flag("blur-squad"),
    };
    try {
      const report = await archiveOnce(context, {
        history: !args.flag("no-history"),
      });
      console.log(
        `own scans: ${report.added} added, ${report.updated} updated, ` +
          `${report.known} already archived (${report.withoutImage} of the ` +
          `new entries have no screenshot)`,
      );
    } catch (error) {
      // A watch may start before the first scan.
      if (
        !args.flag("watch") || !(error instanceof DatasetError) ||
        error.code !== "DST-015"
      ) {
        throw error;
      }
    }
    await store.writeIndex();
    if (args.flag("watch")) {
      const stop = new AbortController();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        Deno.addSignalListener(signal, () => stop.abort());
      }
      console.log(`watching ${appDir}/scans (Ctrl-C stops)`);
      await watchScans(context, stop.signal, async (report) => {
        await store.writeIndex();
        console.log(
          `archived: ${report.added} added, ${report.updated} updated`,
        );
      });
    }
    return 0;
  }

  // The public sources run the real scanner in sandboxes.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(signal, () => {
      removeAllTempFolders();
      Deno.exit(130);
    });
  }
  const databases = absolutePath(args.value("db-dir") ?? defaultAppDir());
  const runner = await findRunner(args.value("runner"));
  const jobs = command === "youtube" ? args.integer("jobs", 3, 1, 8) : 1;
  const scanners: Scanner[] = [];
  try {
    for (let i = 0; i < jobs; i++) {
      scanners.push(await createSandboxScanner({ runner, databases }));
    }
    const context: CollectContext = {
      store,
      constants,
      gameData: await loadGameData(databases),
      redactNames: !args.flag("no-blur-squad"),
      scanners,
      log: (line) => console.log(line),
    };

    let report: RunReport;
    if (command === "wfinfo-ng") {
      report = await wfinfong.collectWfinfoNg(
        context,
        new PoliteClient({ hosts: wfinfong.HOSTS, pauseMs: 1000 }),
      );
    } else if (command === "reddit") {
      report = await reddit.collectReddit(
        context,
        new PoliteClient({ hosts: reddit.HOSTS, pauseMs: reddit.PAUSE_MS }),
        {
          limit: args.integer("limit", 50, 1, 5000),
          subreddits: args.list("subreddit", reddit.DEFAULT_SUBREDDITS),
          queries: args.list("query", reddit.DEFAULT_QUERIES),
        },
      );
    } else {
      const maxVideos = args.integer("max-videos", 5, 1, 500);
      const videos = args.list("url", []).map(videoId);
      for (const query of args.list("search", [])) {
        videos.push(...await searchVideos(query, maxVideos));
      }
      const chosen = [...new Set(videos)]
        .filter((id) => !store.outcome("youtube", id))
        .slice(0, maxVideos);
      if (chosen.length === 0) {
        throw new DatasetError(
          "DST-001",
          "no new video: give --url or --search",
        );
      }
      report = await collectYoutube(context, {
        videos: chosen,
        interval: args.integer("interval", 4, 1, 60),
        maxHeight: args.integer("max-height", 2160, 240, 4320),
        maxDurationSeconds: args.integer("max-duration", 1200, 10, 86400),
        maxMegabytes: args.integer("max-megabytes", 700, 1, 20000),
      });
    }
    report.finishedAt = new Date().toISOString();
    await store.writeIndex();
    const path = await store.writeRunReport(command as SourceKind, report);
    console.log(
      `\n${report.downloads} downloads ` +
        `(${(report.downloadedBytes / 1e6).toFixed(1)} MB), ` +
        `${report.scanned} images scanned, ` +
        `${report.rewardScreens} with reward names, ${report.stored} stored ` +
        `(${(report.storedBytes / 1e6).toFixed(1)} MB), ` +
        `${report.duplicates} duplicates, ${report.errors} errors`,
    );
    console.log(`run report: ${path}`);
    return report.errors > 0 ? 1 : 0;
  } finally {
    await Promise.all(scanners.map((s) => s.dispose()));
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (error) {
    removeAllTempFolders();
    if (error instanceof DatasetError) {
      console.error(describeError(error));
    } else {
      console.error(await reportCrash(error, defaultAppDir()));
    }
    Deno.exit(2);
  }
}
