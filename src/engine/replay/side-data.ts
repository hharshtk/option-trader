// The research recorder's side data, 20-level books and option chains, as of a moment: the
// latest received when live, and what had been recorded by the replay's position in a replay.
// Live, the depth feed's frames and the recorder's chain snapshots are kept as they arrive. In a
// replay, the day's `.depth` and `.chain` files are indexed and read back at the position.

import path from "node:path";
import type { BookLevel, ChainSnapshot, ChainView, DepthBook, DepthView } from "../../lib/engine/protocol.ts";
import { parseDepthFrame } from "../../lib/live/feed/depth-packets.ts";
import { fileSource } from "../journal/byte-source.ts";
import { createDepthOfi, type DepthOfi } from "../journal/depth-ofi.ts";
import { createChainIndex, createDepthIndex, liveLevels, toChainSnapshot, type ChainIndex, type DepthIndex } from "../journal/side-index.ts";

export interface Contract {
  name: string;
  kind: "future" | "option";
  underlying: string;
  expiry: string;
  strike: number | null;
  type: "CE" | "PE" | null;
}

export interface SideData {
  source: "live" | "replay";
  /** Live: now. Replay: the replay's position. */
  at(): number;
  /** Contracts with a 20-level book so far, in the order they were added. */
  depthKeys(): string[];
  /** What a contract is, from the recorder's `instruments` records. */
  contract(key: string): Contract | null;
  book(key: string): DepthBook | null;
  /** Expiries of `underlying` with a chain snapshot so far, nearest first. */
  chainExpiries(underlying: string): string[];
  chain(underlying: string, expiry: string): ChainSnapshot | null;
}

export interface LiveSideData extends SideData {
  /** A raw frame from the depth feed. */
  addDepthFrame(frame: ArrayBuffer | ArrayBufferView, at: number): void;
  /** A control record the recorder wrote: `option-chain` to the chain file, `instruments` to the journal. */
  addControl(kind: string, data: Record<string, unknown>, at: number): void;
}

/** Keeps the latest book per contract and the latest chain per expiry, as the recorder receives them. */
export function createLiveSideData(now: () => number): LiveSideData {
  const books = new Map<string, { bids: BookLevel[]; asks: BookLevel[]; bidAt: number; askAt: number }>();
  const contracts = new Map<string, Contract>();
  const chains = new Map<string, ChainSnapshot>();
  return {
    source: "live",
    at: now,
    depthKeys: () => [...books.keys()],
    contract: (key) => contracts.get(key) ?? null,
    book(key) {
      const b = books.get(key);
      return b ? { key, name: contracts.get(key)?.name ?? null, at: Math.max(b.bidAt, b.askAt), bids: b.bids, asks: b.asks } : null;
    },
    chainExpiries: (underlying) => [...chains.values()].filter((s) => s.underlying === underlying).map((s) => s.expiry).sort(),
    chain: (underlying, expiry) => chains.get(`${underlying} ${expiry}`) ?? null,
    addDepthFrame(frame, at) {
      for (const packet of parseDepthFrame(frame)) {
        if (packet.kind !== "depth") continue;
        let b = books.get(packet.key);
        if (!b) books.set(packet.key, (b = { bids: [], asks: [], bidAt: 0, askAt: 0 }));
        const levels = liveLevels(packet.levels);
        if (packet.side === "bid") Object.assign(b, { bids: levels, bidAt: at });
        else Object.assign(b, { asks: levels, askAt: at });
      }
    },
    addControl(kind, data, at) {
      if (kind === "instruments" && Array.isArray(data.items)) {
        for (const item of data.items as Record<string, unknown>[]) {
          const contract = toContract(item);
          if (contract) contracts.set(item.key as string, contract);
        }
      } else if (kind === "option-chain") {
        const snapshot = toChainSnapshot(data, at);
        if (snapshot) chains.set(`${snapshot.underlying} ${snapshot.expiry}`, snapshot);
      }
    },
  };
}

/** A recorded day's side files, indexed. Either is null when the day has none (days before 18 November 2026). */
export interface SideFiles {
  depth: DepthIndex | null;
  chain: ChainIndex | null;
  /** The near-month future's five-level OFI at each minute, from the depth file. */
  ofi: DepthOfi | null;
  /** Why a file couldn't be used, for the log. */
  problems: string[];
  /** Indexes what was written since the last call: for today's files, still growing. */
  refresh(): Promise<void>;
  close(): void;
}

/** Opens and indexes the day's `.depth` and `.chain` files. A missing file is no problem. */
export async function loadSideFiles(directory: string, date: string): Promise<SideFiles> {
  const problems: string[] = [];
  const open = (suffix: string) => {
    try {
      return fileSource(path.join(directory, `${date}${suffix}.bin`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${suffix.slice(1)} file: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const depth = open(".depth");
  const chain = open(".chain");
  const files: SideFiles = {
    depth: depth && createDepthIndex(depth),
    chain: chain && createChainIndex(chain),
    // The same file, read forward record by record.
    ofi: depth && createDepthOfi(depth),
    problems,
    async refresh() {
      for (const name of ["depth", "chain"] as const) {
        try {
          await files[name]?.refresh();
        } catch (error) {
          problems.push(`${name} file: ${error instanceof Error ? error.message : String(error)}`);
          files[name]?.close();
          files[name] = null;
          if (name === "depth") files.ofi = null;
        }
      }
    },
    close() {
      files.depth?.close();
      files.chain?.close();
    },
  };
  await files.refresh();
  return files;
}

/** Side data from a replayed day's files, at whatever time `at()` says. */
export function replaySideData(files: SideFiles, contracts: Map<string, Record<string, unknown>>, at: () => number): SideData {
  const contract = (key: string) => toContract(contracts.get(key));
  return {
    source: "replay",
    at,
    contract,
    depthKeys: () => files.depth?.keysAt(at()) ?? [],
    book(key) {
      const book = files.depth?.book(key, at());
      return book ? { key, name: contract(key)?.name ?? null, ...book } : null;
    },
    chainExpiries: (underlying) => files.chain?.expiries(underlying, at()) ?? [],
    chain(underlying, expiry) {
      const index = files.chain?.latest(underlying, expiry, at()) ?? -1;
      return index < 0 ? null : files.chain!.snapshot(underlying, expiry, index);
    },
  };
}

/** What `GET /v1/depth` answers. */
export function depthView(sides: SideData, key: string | null): DepthView {
  // NIFTY's futures first, nearest expiry first, so the near-month future is the default; then
  // other futures, then options by expiry and strike.
  const order = (k: string): readonly (string | number)[] => {
    const c = sides.contract(k);
    return c ? [c.kind === "future" ? (c.underlying === "NIFTY" ? 0 : 1) : 2, c.expiry, c.strike ?? 0, c.type ?? ""] : [3, "", 0, k];
  };
  const sorted = sides
    .depthKeys()
    .map((k) => ({ k, o: order(k) }))
    .sort((a, b) => {
      for (let i = 0; i < 4; i += 1) if (a.o[i] !== b.o[i]) return a.o[i] < b.o[i] ? -1 : 1;
      return 0;
    });
  const instruments = sorted.map(({ k }) => ({ key: k, name: sides.contract(k)?.name ?? null }));
  const wanted = key ?? instruments[0]?.key ?? null;
  return { source: sides.source, at: sides.at(), instruments, book: wanted ? sides.book(wanted) : null };
}

/** What `GET /v1/chain` answers. */
export function chainView(sides: SideData, underlying: string, expiry: string | null): ChainView {
  const expiries = sides.chainExpiries(underlying);
  const wanted = expiry ?? expiries[0] ?? null;
  return { source: sides.source, at: sides.at(), underlying, expiries, snapshot: wanted ? sides.chain(underlying, wanted) : null };
}

export function toContract(item: Record<string, unknown> | undefined): Contract | null {
  if (!item || typeof item.name !== "string" || (item.kind !== "future" && item.kind !== "option")) return null;
  return {
    name: item.name,
    kind: item.kind,
    underlying: String(item.underlying ?? ""),
    expiry: String(item.expiry ?? ""),
    strike: typeof item.strike === "number" ? item.strike : null,
    type: item.type === "CE" || item.type === "PE" ? item.type : null,
  };
}
