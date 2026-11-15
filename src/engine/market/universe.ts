// The always-on universe: instruments the engine subscribes at start and never releases, so
// sessions are journaled whether or not anyone has a page open. Pages still add what they
// show on top. Defined in config/engine/universe.json.

import defaultUniverse from "../../../config/engine/universe.json" with { type: "json" };
import { INDEX } from "../../lib/dhan/instruments.ts";
import { INDEX_CONSTITUENTS } from "../../lib/index-constituents.ts";
import { parseInstrumentKey, type Instrument } from "../../lib/live/feed/packets.ts";

export type UniverseEntry =
  | { kind: "index"; index: string }
  | { kind: "constituents"; index: string }
  | { kind: "instrument"; key: string };

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
  problems: string[];
}

export function resolveUniverse(config: UniverseConfig = defaultUniverse as UniverseConfig): Universe {
  const keys = new Set<string>();
  const problems: string[] = [];
  const add = (key: string, source: string) => {
    if (parseInstrumentKey(key)) keys.add(key);
    else problems.push(`${source}: invalid instrument ${key}`);
  };

  for (const entry of config.include) {
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
  for (const key of config.instruments) add(key, "instruments");

  return {
    name: config.name,
    instruments: [...keys].map((key) => parseInstrumentKey(key)!),
    problems,
  };
}
