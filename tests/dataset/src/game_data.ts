/**
 * Part categories from WFInfo's cached databases in the app data folder:
 * market_items.json (slugs), market_data.json (price sheet), eqmt_data.json
 * (prime sets, vaulted state) and relic_data.json (which relics drop a part,
 * and how rarely). All read only.
 */

import { DatasetError } from "./errors.ts";

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Json
    : {};
}

function number(value: unknown): number | null {
  const n = typeof value === "string" && value !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export type Rarity = "common" | "uncommon" | "rare";

export interface PartInfo {
  name: string;
  slug: string | null;
  /** Prime set, for example "Octavia Prime"; null for Forma and the like. */
  set: string | null;
  /** "Blueprint", "Chassis", "Barrel" and so on. */
  component: string | null;
  /** eqmt_data's type, for example "Warframes" or "Primary". */
  itemType: string | null;
  vaulted: boolean | null;
  ducats: number | null;
  /** The price sheet's value when the entry was made. */
  platSheet: number | null;
  /** Rarities under which relics drop the part. */
  rarity: Rarity[];
  relicCount: number;
  /** Relics that are not vaulted, for example "Lith O2" (12 at most). */
  unvaultedRelics: string[];
}

interface Relic {
  name: string;
  rarity: Rarity;
  vaulted: boolean;
}

export interface GameData {
  describe(part: string): PartInfo;
}

export function buildGameData(files: {
  marketItems: unknown;
  marketData: unknown;
  equipment?: unknown;
  relics?: unknown;
}): GameData {
  const slugs = new Map<string, string>();
  for (const value of Object.values(object(files.marketItems))) {
    const [name, slug, full] = String(value).split("|");
    if (!slug) continue;
    if (name) slugs.set(name, slug);
    if (full) slugs.set(full, slug);
  }

  // A blueprint part has two rows; the one with ducats is the one that counts.
  const prices = new Map<string, { plat: number | null; ducats: number }>();
  for (const [key, value] of Object.entries(object(files.marketData))) {
    const row = object(value);
    const entry = {
      plat: number(row.plat),
      ducats: number(row.ducats) ?? 0,
    };
    for (const name of [key, typeof row.name === "string" ? row.name : ""]) {
      if (!name) continue;
      if ((prices.get(name)?.ducats ?? 0) > 0 && entry.ducats <= 0) continue;
      prices.set(name, entry);
    }
  }

  const parts = new Map<string, { set: string; type: string; v: boolean }>();
  for (const [set, value] of Object.entries(object(files.equipment))) {
    const info = object(value);
    for (const [part, data] of Object.entries(object(info.parts))) {
      parts.set(part, {
        set,
        type: String(info.type ?? ""),
        v: object(data).vaulted === true,
      });
    }
  }

  const relics = new Map<string, Relic[]>();
  for (const [era, byName] of Object.entries(object(files.relics))) {
    for (const [relic, value] of Object.entries(object(byName))) {
      const info = object(value);
      for (const [slot, part] of Object.entries(info)) {
        const rarity = /^(common|uncommon|rare)\d$/.exec(slot)?.[1];
        if (!rarity || typeof part !== "string") continue;
        const list = relics.get(part) ?? [];
        list.push({
          name: `${era} ${relic}`,
          rarity: rarity as Rarity,
          vaulted: info.vaulted === true,
        });
        relics.set(part, list);
      }
    }
  }

  const order: Rarity[] = ["common", "uncommon", "rare"];
  return {
    describe(name: string): PartInfo {
      const known = parts.get(name) ?? parts.get(`${name} Blueprint`);
      const drops = relics.get(name) ?? relics.get(`${name} Blueprint`) ?? [];
      const price = prices.get(name);
      const set = known?.set ?? /^(.*? Prime)\b/.exec(name)?.[1] ?? null;
      return {
        name,
        slug: slugs.get(name) ?? null,
        set,
        component: set && name.startsWith(`${set} `)
          ? name.slice(set.length + 1)
          : null,
        itemType: known?.type || null,
        vaulted: known?.v ?? null,
        ducats: price?.ducats ?? null,
        platSheet: price?.plat ?? null,
        rarity: order.filter((r) => drops.some((d) => d.rarity === r)),
        relicCount: drops.length,
        unvaultedRelics: drops.filter((d) => !d.vaulted).map((d) => d.name)
          .sort().slice(0, 12),
      };
    },
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(path));
}

export async function loadGameData(folder: string): Promise<GameData> {
  const required = async (name: string) => {
    try {
      return await readJson(`${folder}/${name}`);
    } catch {
      throw new DatasetError("DST-004", `${folder}/${name}`);
    }
  };
  const optional = async (name: string) => {
    try {
      return await readJson(`${folder}/${name}`);
    } catch {
      console.warn(`warning: no ${name}; some part categories stay unknown`);
      return undefined;
    }
  };
  return buildGameData({
    marketItems: await required("market_items.json"),
    marketData: await required("market_data.json"),
    equipment: await optional("eqmt_data.json"),
    relics: await optional("relic_data.json"),
  });
}
