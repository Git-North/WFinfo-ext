/**
 * Warframe's EE.cfg and EE.log, read only. Both are opened for reading and
 * closed at once; nothing in the game's folders is written.
 *
 * EE.log holds PC specifications, the public IP address and the account e-mail
 * address. This module takes two named values from it, each matched by a
 * narrow pattern and then checked, and returns nothing else: no line, no path.
 */

/** Graphics settings of EE.cfg that describe how a screenshot looks. */
const GRAPHICS_KEYS = new Set([
  "AnisotropicFiltering",
  "AntiAliasing",
  "AutoDetectGraphicsSettings",
  "EnableContactShadows",
  "EnableDOF",
  "EnableDistortions",
  "EnableHDR",
  "EnableMotionBlur",
  "HLODDistanceScale",
  "ImposterDistanceScale",
  "ParticleSysQuality",
  "SSAOMode",
  "SSGI",
  "ShadowQuality",
  "TextureQuality",
  "TrilinearFiltering",
  "UpscaleMethod",
  "UpscaleQuality",
  "VSyncMode",
]);

/** An enum word or a number: no spaces, paths or addresses. */
const SETTING_VALUE = /^(?:[A-Z][A-Z0-9_]{0,63}|-?\d{1,9}(?:\.\d{1,9})?)$/;

export interface GameConfig {
  /** WFInfo's rule: 5 % steps, 0.5-1.25; 1.0 when the line is absent. */
  uiScale: number | null;
  graphics: Record<string, string>;
}

export function parseEeCfg(text: string): GameConfig {
  let uiScale: number | null = 1;
  const graphics: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const scale = /^Flash\.FlashDrawScale=(.*?)\r?$/i.exec(line);
    if (scale) {
      const raw = Number(scale[1].trim() || NaN);
      uiScale = Number.isFinite(raw)
        ? Math.max(0.5, Math.min(1.25, Math.round(raw * 20) / 20))
        : null;
      continue;
    }
    const setting = /^Graphics\.([A-Za-z0-9]+)=(.*?)\r?$/.exec(line);
    if (!setting) continue;
    const [, key, value] = setting;
    if (GRAPHICS_KEYS.has(key) && SETTING_VALUE.test(value)) {
      graphics[key] = value;
    }
  }
  return { uiScale, graphics };
}

/** Language codes the game's -language switch takes. */
const LANGUAGES = new Set(
  "de en es fr it ja ko pl pt ru tc th tr uk zh".split(" "),
);

export interface GameLogFields {
  /** Game build, for example "2026.10.28.09.54". */
  build: string | null;
  /** The game's language switch, for example "en". */
  language: string | null;
}

export function parseEeLogFields(text: string): GameLogFields {
  const build = /Build Label: (\d{4}(?:\.\d{2}){4})(?![0-9])/.exec(text)?.[1];
  const language = /(?:^|\s)-language:([a-z]{2})(?=[\s"]|$)/m.exec(text)?.[1];
  return {
    build: build ?? null,
    language: language && LANGUAGES.has(language) ? language : null,
  };
}

/** Both values are logged during start-up, in the first few hundred lines. */
const LOG_HEAD_BYTES = 1024 * 1024;

async function readHead(path: string, limit: number): Promise<string> {
  using file = await Deno.open(path, { read: true });
  const buffer = new Uint8Array(limit);
  let length = 0;
  while (length < limit) {
    const read = await file.read(buffer.subarray(length));
    if (read === null) break;
    length += read;
  }
  return new TextDecoder().decode(buffer.subarray(0, length));
}

const PREFIX = "drive_c/users/steamuser/AppData/Local/Warframe/EE.log";
const BOTTLE = "drive_c/users/crossover/AppData/Local/Warframe/EE.log";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * EE.log: the given path, else $WFINFO_EE_LOG, else the newest one in the usual
 * Steam and CrossOver prefixes. Unlike the runner it does not read Steam's
 * library list; pass the path for a game on another library.
 */
export async function findEeLog(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (explicit) return await isFile(explicit) ? explicit : null;
  const named = env.WFINFO_EE_LOG;
  if (named && await isFile(named)) return named;

  const home = env.HOME ?? "";
  const mac = `${home}/Library/Application Support`;
  const candidates = [
    `${home}/.steam/steam`,
    `${home}/.steam/root`,
    `${home}/.local/share/Steam`,
    `${home}/.var/app/com.valvesoftware.Steam/data/Steam`,
    `${mac}/Steam`,
    ...(env.STEAM_ROOT ? [env.STEAM_ROOT] : []),
  ].map((root) => `${root}/steamapps/compatdata/230410/pfx/${PREFIX}`);
  try {
    for await (const bottle of Deno.readDir(`${mac}/CrossOver/Bottles`)) {
      candidates.push(`${mac}/CrossOver/Bottles/${bottle.name}/${BOTTLE}`);
    }
  } catch {
    // no CrossOver here
  }

  let newest: string | null = null;
  let newestTime = -1;
  for (const path of candidates) {
    if (!await isFile(path)) continue;
    const time = (await Deno.stat(path)).mtime?.getTime() ?? 0;
    if (time > newestTime) [newest, newestTime] = [path, time];
  }
  return newest;
}

export interface GameInfo extends GameLogFields {
  uiScaleConfig: number | null;
  graphics: Record<string, string> | null;
}

/** What EE.log and the EE.cfg beside it say, or null without a game install. */
export async function readGameInfo(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
): Promise<GameInfo | null> {
  const log = await findEeLog(explicit, env);
  if (log === null) return null;
  let fields: GameLogFields = { build: null, language: null };
  let config: GameConfig | null = null;
  try {
    fields = parseEeLogFields(await readHead(log, LOG_HEAD_BYTES));
  } catch {
    // unreadable: the fields stay unknown
  }
  try {
    const cfg = log.replace(/[^/]*$/, "EE.cfg");
    config = parseEeCfg(await readHead(cfg, LOG_HEAD_BYTES));
  } catch {
    // no EE.cfg: the settings stay unknown
  }
  return {
    ...fields,
    uiScaleConfig: config?.uiScale ?? null,
    graphics: config?.graphics ?? null,
  };
}
