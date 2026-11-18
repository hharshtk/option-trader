// The research recorder: on every trading day it records what any strategy might later need,
// whether or not the trader uses it. From 30 minutes before the F&O open to 10 minutes after the
// close, for each index in RECORDED (NIFTY, then BANKNIFTY), it holds on the live feed in Full mode
// (last trade, volume, OI and 5-level depth):
//
//   - every unexpired future on the index;
//   - options on its nearest expiries, a window of strikes around the money per expiry. The window
//     follows the index and only grows during the day, so every series is unbroken.
//
// and beside the main journal:
//
//   - 20-level depth on Dhan's depth connection (one socket, 50 instruments, NIFTY first), in
//     `YYYY-MM-DD.depth.bin`;
//   - the option chain (IV, greeks, OI, best bid/ask for strikes within 10% of the index) for its
//     nearest expiries once a minute while the market is open, in `YYYY-MM-DD.chain.bin`. On by
//     default; `recordChain: false` (ENGINE_RECORD_OPTION_CHAIN=false) turns it off, so a second
//     engine on the same Dhan account doesn't collide with the first on the option chain's rate limit.
//
// Every instrument it adds is described in the main journal (an `instruments` control record), so
// a day can be read after its contracts have expired and left Dhan's instrument file.

import type { RecorderStatus } from "../../lib/engine/protocol.ts";
import type { OptionRef } from "../../lib/engine/trading.ts";
import type { OptionChain } from "../../lib/dhan/types.ts";
import type { FeedHub } from "../../lib/live/feed/feed-hub.ts";
import { instrumentKey, parseFrame, parseInstrumentKey, type Instrument } from "../../lib/live/feed/packets.ts";
import type { Journal } from "../journal/writer.ts";
import type { SessionCalendar } from "../market/session-calendar.ts";
import type { Health } from "../telemetry/health.ts";
import type { Logger } from "../telemetry/logger.ts";
import { windowContracts, type ContractBook } from "../trading/contracts.ts";
import type { DepthFeed } from "./depth-feed.ts";
import type { IndexFuture } from "./futures.ts";

const MINUTE_MS = 60_000;
export const RECORD_LEAD_MS = 30 * MINUTE_MS;
export const RECORD_TAIL_MS = 10 * MINUTE_MS;
const RETRY_MS = 2 * MINUTE_MS;
/** Option chain strikes kept: within this fraction of the index. */
export const CHAIN_BAND = 0.1;
/** Seconds into each minute the chain is fetched, after the minute's last ticks. */
const CHAIN_OFFSET_MS = 5_000;

/** What the recorder keeps for one index. */
export interface RecordedIndex {
  /** Dhan's underlying symbol, e.g. "NIFTY". */
  name: string;
  /** The index's feed key, whose level centres the option windows. */
  spotKey: string;
  /** Strikes each side of the money, per expiry, nearest expiry first. Its length is how many expiries. */
  optionWindows: readonly number[];
  /** Nearest futures given 20-level depth. */
  depthFutures: number;
  /** Strikes each side of the money on the nearest expiry given 20-level depth; 0 for none. */
  depthOptionStrikes: number;
  /** Nearest expiries whose option chain is saved each minute. */
  chainExpiries: number;
}

/**
 * NIFTY is the one being built on; BANKNIFTY is kept so it can be tested later. BANKNIFTY has only
 * monthly expiries, and only its two nearest futures get 20-level depth so NIFTY keeps the rest of
 * the depth connection's 50 instruments.
 */
export const RECORDED: readonly RecordedIndex[] = [
  { name: "NIFTY", spotKey: "IDX_I:13", optionWindows: [15, 10, 5], depthFutures: 2, depthOptionStrikes: 5, chainExpiries: 3 },
  { name: "BANKNIFTY", spotKey: "IDX_I:25", optionWindows: [15, 10], depthFutures: 2, depthOptionStrikes: 0, chainExpiries: 2 },
];

export interface Recorder {
  /** Every live frame, for the index levels the option windows follow. */
  onFrame(frame: ArrayBuffer): void;
  /** Call once a second. */
  tick(): void;
  status(): RecorderStatus;
  shutdown(): void;
}

interface Leg {
  plan: RecordedIndex;
  book: ContractBook | null;
  futures: IndexFuture[];
  problem: string | null;
}

interface Day {
  date: string;
  window: { start: number; end: number };
  open: number;
  close: number;
  legs: Leg[];
  loading: boolean;
  loadedAt: number;
  /** Instruments held on the hub, and which hub holds them (a replay swaps the hub out). */
  held: Map<string, Instrument>;
  heldOn: object | null;
  /** Keys already described in the journal. */
  described: Set<string>;
  depth: Map<string, Instrument>;
  lastChainMinute: number;
}

export function createRecorder({
  log,
  health,
  now,
  calendar,
  hub,
  journal,
  depth,
  chainJournal,
  loadContracts,
  loadFutures,
  fetchChain,
  depthFile,
  chainFile,
  indices = RECORDED,
  recordChain = true,
}: {
  log: Logger;
  health: Health;
  now: () => number;
  calendar: SessionCalendar;
  /** The live feed's hub; null during a replay, when nothing is recorded. */
  hub: () => Pick<FeedHub, "acquire" | "release"> | null;
  /** The main journal, for the `instruments` records. */
  journal: Pick<Journal, "control">;
  depth: DepthFeed;
  chainJournal: Pick<Journal, "control">;
  loadContracts: (marketDate: string, live: boolean, underlying: string) => Promise<{ book: ContractBook | null; problem: string | null }>;
  loadFutures: (marketDate: string, underlying: string) => Promise<{ futures: IndexFuture[]; problem: string | null }>;
  fetchChain: (underlying: string, expiry: string) => Promise<OptionChain>;
  depthFile: () => RecorderStatus["depth"]["file"];
  chainFile: () => RecorderStatus["chain"]["file"];
  indices?: readonly RecordedIndex[];
  /** False: no option chain requests to Dhan and no chain file. Futures, windows and depth are unchanged. */
  recordChain?: boolean;
}): Recorder {
  let day: Day | null = null;
  const spots = new Map<string, number>();
  const spotKeys = new Set(indices.map((plan) => plan.spotKey));
  let chainBusy = false;
  const chain = { snapshots: 0, lastAt: null as number | null, errors: 0, lastError: null as string | null, lastErrorAt: 0 };

  function windowFor(time: number) {
    const date = calendar.istDate(time);
    const session = calendar.session("NSE_FNO", date);
    if (!session) return null;
    return { date, open: session.open, close: session.close, start: session.open - RECORD_LEAD_MS, end: session.close + RECORD_TAIL_MS };
  }

  function dayProblem(current: Day) {
    const problems = current.legs.filter((leg) => leg.problem).map((leg) => `${leg.plan.name}: ${leg.problem}`);
    return problems.length > 0 ? problems.join("; ") : null;
  }

  function releaseAll(current: Day) {
    const live = hub();
    if (live && current.heldOn === live && current.held.size > 0) live.release([...current.held.values()]);
    current.held.clear();
    current.heldOn = null;
    current.depth.clear();
    depth.set([]);
  }

  async function loadLeg(current: Day, leg: Leg) {
    const { name } = leg.plan;
    try {
      const contracts = await loadContracts(current.date, true, name);
      const futures = await loadFutures(current.date, name);
      if (day !== current) return;
      const changed = leg.book?.fileDate !== contracts.book?.fileDate || leg.futures.length !== futures.futures.length;
      leg.book = contracts.book;
      leg.futures = futures.futures;
      leg.problem = !contracts.book ? contracts.problem : futures.futures.length === 0 ? futures.problem : null;
      if (changed) {
        const expiries = contracts.book?.expiries.slice(0, leg.plan.optionWindows.length).join(", ") || "no expiry";
        log.info(`recording ${current.date}: ${futures.futures.length} ${name} futures, options on ${expiries}`);
      }
      if (contracts.problem) log.warn(`${name} contracts: ${contracts.problem}`);
      if (futures.problem) log.warn(`${name} futures: ${futures.problem}`);
    } catch (error) {
      if (day !== current) return;
      leg.problem = `Could not load contracts: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
      log.warn(`${name}: ${leg.problem}`);
    }
  }

  async function load(current: Day) {
    current.loading = true;
    current.loadedAt = now();
    try {
      // One after another: the first may download Dhan's instrument file, which the rest then reuse.
      for (const leg of current.legs) await loadLeg(current, leg);
    } finally {
      current.loading = false;
    }
  }

  function optionWindow(leg: Leg, expiry: string, each: number): OptionRef[] {
    const spot = spots.get(leg.plan.spotKey);
    if (!leg.book || spot === undefined) return [];
    return windowContracts(leg.book.chain(expiry), spot, each);
  }

  /** What the main feed should carry now: per index, its futures, then each expiry's window. */
  function wanted(current: Day) {
    const out: { instrument: Instrument; describe: Record<string, unknown> }[] = [];
    for (const leg of current.legs) {
      const underlying = leg.plan.name;
      for (const future of leg.futures) {
        const instrument = parseInstrumentKey(future.feedKey);
        if (instrument) out.push({ instrument, describe: { kind: "future", underlying, name: future.name, expiry: future.expiry, lotSize: future.lotSize } });
      }
      leg.book?.expiries.slice(0, leg.plan.optionWindows.length).forEach((expiry, i) => {
        for (const ref of optionWindow(leg, expiry, leg.plan.optionWindows[i])) {
          const instrument = parseInstrumentKey(ref.feedKey);
          if (instrument) out.push({ instrument, describe: describeOption(ref, underlying) });
        }
      });
    }
    return out;
  }

  function depthWanted(current: Day): Instrument[] {
    const keys: string[] = [];
    for (const leg of current.legs) {
      for (const future of leg.futures.slice(0, leg.plan.depthFutures)) keys.push(future.feedKey);
      const expiry = leg.book?.expiries[0];
      if (expiry && leg.plan.depthOptionStrikes > 0) {
        for (const ref of optionWindow(leg, expiry, leg.plan.depthOptionStrikes)) keys.push(ref.feedKey);
      }
    }
    return keys.map(parseInstrumentKey).filter((instrument): instrument is Instrument => instrument !== null);
  }

  function hold(current: Day) {
    const live = hub();
    if (!live) return;
    if (current.heldOn !== live) {
      // A new feed (back from a replay): nothing held carries over.
      current.held.clear();
      current.heldOn = live;
    }
    const added: Instrument[] = [];
    const items: Record<string, unknown>[] = [];
    for (const { instrument, describe } of wanted(current)) {
      const key = instrumentKey(instrument);
      if (current.held.has(key)) continue;
      current.held.set(key, instrument);
      added.push(instrument);
      if (!current.described.has(key)) {
        current.described.add(key);
        items.push({ key, ...describe });
      }
    }
    if (added.length > 0) live.acquire(added, "full");
    if (items.length > 0) journal.control("instruments", { source: "recorder", date: current.date, items }, now());

    // Depth only grows during the day (a removal reconnects). Past the connection's 50 the
    // depth feed drops the newest, so what was there first keeps its place.
    let grew = false;
    for (const instrument of depthWanted(current)) {
      const key = instrumentKey(instrument);
      if (!current.depth.has(key)) {
        current.depth.set(key, instrument);
        grew = true;
      }
    }
    if (grew) depth.set([...current.depth.values()]);
  }

  async function pollChain(current: Day, minute: number) {
    chainBusy = true;
    try {
      for (const leg of current.legs) {
        for (const expiry of leg.book?.expiries.slice(0, leg.plan.chainExpiries) ?? []) {
          const underlying = leg.plan.name;
          try {
            const snapshot = await fetchChain(underlying, expiry);
            const lastPrice = snapshot.last_price;
            const oc = Object.fromEntries(
              Object.entries(snapshot.oc ?? {}).filter(([strike]) => Math.abs(Number(strike) / lastPrice - 1) <= CHAIN_BAND),
            );
            chainJournal.control("option-chain", { underlying, expiry, minute, lastPrice, oc }, now());
            chain.snapshots += 1;
            chain.lastAt = now();
          } catch (error) {
            chain.errors += 1;
            chain.lastError = `${underlying} ${expiry}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
            // One warning a minute is plenty.
            if (now() - chain.lastErrorAt > MINUTE_MS) log.warn(`option chain: ${chain.lastError}`);
            chain.lastErrorAt = now();
          }
        }
      }
    } finally {
      chainBusy = false;
    }
  }

  function reportHealth(current: Day | null) {
    if (!current) return health.set("recorder", "ok");
    const depthState = depth.status().state;
    const chainFailing = chain.lastError !== null && now() - chain.lastErrorAt < 5 * MINUTE_MS;
    const problem = dayProblem(current);
    if (problem) health.set("recorder", "degraded", problem);
    else if (depthState.state === "stopped") health.set("recorder", "degraded", `Depth feed stopped: ${depthState.reason}`);
    else if (depthState.state === "reconnecting") health.set("recorder", "degraded", `Depth feed reconnecting (${depthState.reason})`);
    else if (chainFailing) health.set("recorder", "degraded", `Option chain: ${chain.lastError}`);
    else health.set("recorder", "ok");
  }

  return {
    onFrame(frame) {
      // Only the index levels matter here; most frames don't carry them.
      for (const packet of parseFrame(frame)) {
        if ((packet.kind === "ticker" || packet.kind === "quote") && spotKeys.has(packet.key) && packet.ltp > 0) spots.set(packet.key, packet.ltp);
      }
    },

    tick() {
      const time = now();
      const today = windowFor(time);
      const active = today !== null && time >= today.start && time <= today.end && hub() !== null;

      if (!active || (day && day.date !== today?.date)) {
        if (day) {
          releaseAll(day);
          log.info(`recording ${day.date} stopped: ${chain.snapshots} option chain snapshots this run`);
          day = null;
        }
        if (!active) return reportHealth(null);
      }
      if (!today) return;

      if (!day) {
        day = {
          date: today.date,
          window: { start: today.start, end: today.end },
          open: today.open,
          close: today.close,
          legs: indices.map((plan) => ({ plan, book: null, futures: [], problem: null })),
          loading: false,
          loadedAt: 0,
          held: new Map(),
          heldOn: null,
          described: new Set(),
          depth: new Map(),
          lastChainMinute: -1,
        };
        void load(day);
      } else if (
        !day.loading &&
        day.legs.some((leg) => leg.problem || !leg.book || leg.book.fileDate < day!.date) &&
        time - day.loadedAt > RETRY_MS
      ) {
        // Missing or yesterday's instrument file: Dhan may publish today's later.
        void load(day);
      }

      if (!day.loading) hold(day);

      const minute = Math.floor((time - CHAIN_OFFSET_MS) / MINUTE_MS);
      // Every minute the market is open, plus one at the close.
      const due = time >= day.open + CHAIN_OFFSET_MS && time <= day.close + MINUTE_MS + CHAIN_OFFSET_MS;
      if (recordChain && due && !chainBusy && day.legs.some((leg) => leg.book) && minute !== day.lastChainMinute) {
        day.lastChainMinute = minute;
        void pollChain(day, minute * MINUTE_MS);
      }
      reportHealth(day);
    },

    status() {
      const time = now();
      const today = windowFor(time);
      const d = depth.status();
      const live = hub() !== null;
      const legs = day?.legs ?? [];
      const anyBook = legs.some((leg) => leg.book);
      const problem = day ? dayProblem(day) : null;
      const waitingFor = legs.filter((leg) => !spots.has(leg.plan.spotKey)).map((leg) => leg.plan.name);
      const state: RecorderStatus["state"] = !day ? "idle" : day.loading && !anyBook ? "loading" : problem && !anyBook ? "waiting" : "recording";
      const note = !live
        ? "Paused: the feed is replaying a recorded day"
        : !day
          ? today && time < today.start
            ? `Starts at ${istClock(today.start)} IST, 30 minutes before the F&O open`
            : "Market closed: starts 30 minutes before the next F&O session"
          : problem ??
            (waitingFor.length > 0
              ? `Waiting for the ${waitingFor.join(" and ")} level to centre the option window`
              : `Recording until ${istClock(day.window.end)} IST`);
      return {
        state,
        note,
        date: day?.date ?? null,
        // Today's window until it has passed; after that the next session's is unknown here.
        window: day?.window ?? (today && time < today.end ? { start: today.start, end: today.end } : null),
        indices: (day ? legs : indices.map((plan) => ({ plan, book: null, futures: [], problem: null }) as Leg)).map((leg) => {
          const counts = new Map<string, { contracts: number; strikes: Set<number> }>();
          if (day && leg.book) {
            for (const key of day.held.keys()) {
              const ref = leg.book.byKey(key);
              if (!ref) continue;
              const entry = counts.get(ref.expiry) ?? { contracts: 0, strikes: new Set<number>() };
              entry.contracts += 1;
              entry.strikes.add(ref.strike);
              counts.set(ref.expiry, entry);
            }
          }
          return {
            name: leg.plan.name,
            spot: spots.get(leg.plan.spotKey) ?? null,
            futures: leg.futures.map((future) => ({ key: future.feedKey, name: future.name, expiry: future.expiry })),
            expiries: [...counts]
              .map(([expiry, entry]) => ({ expiry, contracts: entry.contracts, strikes: entry.strikes.size }))
              .sort((a, b) => a.expiry.localeCompare(b.expiry)),
            problem: leg.problem,
          };
        }),
        instruments: day?.held.size ?? 0,
        depth: { state: d.state, instruments: d.instruments, frames: d.frames, packets: d.packets, lastFrameAt: d.lastFrameAt, dropped: d.dropped, file: depthFile() },
        chain: { enabled: recordChain, snapshots: chain.snapshots, lastAt: chain.lastAt, errors: chain.errors, lastError: chain.lastError, file: chainFile() },
      };
    },

    shutdown() {
      if (day) releaseAll(day);
      day = null;
      depth.shutdown();
    },
  };
}

function describeOption(ref: OptionRef, underlying: string) {
  return { kind: "option", underlying, name: ref.name, expiry: ref.expiry, strike: ref.strike, type: ref.type, lotSize: ref.lotSize };
}

function istClock(time: number) {
  return new Date(time + 5.5 * 3_600_000).toISOString().slice(11, 16);
}
