// The always-on universe: instruments the engine subscribes at start and never releases, so
// sessions are journaled whether or not anyone has a page open. Pages still add what they
// show on top. Defined in config/engine/universe.json.

import defaultUniverse from "../../../config/engine/universe.json" with { type: "json" };
import { INDEX } from "../../lib/dhan/instruments.ts";
import { INDEX_CONSTITUENTS } from "../../lib/index-constituents.ts";
import { isFeedMode, MODE_RANK, parseInstrumentKey, type FeedMode, type Instrument } from "../../lib/live/feed/packets.ts";

/** `mode` defaults to ticker. */
export type UniverseEntry = (
  | { kind: "index"; index: string }
  | { kind: "constituents"; index: string }
  | { kind: "instrument"; key: string }
) & { mode?: FeedMode };

export interface UniverseConfig {
  version: number;
  name: string;
  include: UniverseEntry[];
  /** Extra instrument keys, `SEGMENT:SECURITY_ID`. */
  instruments: string[];
}

export interface Universe {
  name: string;
  instruments: Instrument[];
  /** Each instrument's mode; an instrument listed twice gets the richer mode. */
  modes: Map<string, FeedMode>;
  problems: string[];
}

/** The universe's instruments grouped by mode, for subscribing. */
export function byMode(universe: Universe): [FeedMode, Instrument[]][] {
  const groups = new Map<FeedMode, Instrument[]>();
  for (const instrument of universe.instruments) {
    const mode = universe.modes.get(`${instrument.segment}:${instrument.securityId}`) ?? "ticker";
    groups.set(mode, [...(groups.get(mode) ?? []), instrument]);
  }
  return [...groups];
}

export function resolveUniverse(config: UniverseConfig = defaultUniverse as UniverseConfig): Universe {
  const modes = new Map<string, FeedMode>();
  const problems: string[] = [];
  let mode: FeedMode = "ticker";
  const add = (key: string, source: string) => {
    if (!parseInstrumentKey(key)) return problems.push(`${source}: invalid instrument ${key}`);
    const current = modes.get(key);
    if (!current || MODE_RANK[mode] > MODE_RANK[current]) modes.set(key, mode);
  };

  for (const entry of config.include) {
    if (entry.mode !== undefined && !isFeedMode(entry.mode)) {
      problems.push(`Unknown mode ${String(entry.mode)}; using ticker`);
      mode = "ticker";
    } else {
      mode = entry.mode ?? "ticker";
    }
    if (entry.kind === "index") {
      const index = INDEX[entry.index as keyof typeof INDEX];
      if (index) add(`IDX_I:${index.securityId}`, `index ${entry.index}`);
      else problems.push(`Unknown index ${entry.index}`);
    } else if (entry.kind === "constituents") {
      const list = INDEX_CONSTITUENTS[entry.index as keyof typeof INDEX_CONSTITUENTS];
      if (!list) {
        problems.push(`No constituents for ${entry.index}`);
        continue;
      }
      // BSE indices list BSE scrip codes; NSE indices list NSE security IDs.
      const segment = entry.index === "SENSEX" || entry.index === "BANKEX" ? "BSE_EQ" : "NSE_EQ";
      for (const stock of list) add(`${segment}:${stock.securityId}`, `${entry.index} constituent ${stock.symbol}`);
    } else if (entry.kind === "instrument") {
      add(entry.key, "include");
    }
  }
  mode = "ticker";
  for (const key of config.instruments) add(key, "instruments");

  return {
    name: config.name,
    instruments: [...modes.keys()].map((key) => parseInstrumentKey(key)!),
    modes,
    problems,
  };
}
