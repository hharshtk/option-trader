// The scalp lab: fast triggers on NIFTY's near-month future, checked every second and scored as
// pretend trades in one lot of the at-the-money option, after charges. It never trades.
//
// Why it exists: the Pulse signals are read once a minute, which is too slow for scalping. These
// triggers read the future's order book and trades second by second. On 18 November 2026, the
// first day with order-book data, none of them beat the costs (docs/trading.md#scalp-lab), and one
// day proves nothing either way, so the lab scores them every day, live and on replays, until the
// record says whether any is worth trading.
//
// A pretend trade buys at the option's ask plus slippage 300 ms after the trigger, and sells at the
// bid less slippage after each hold, paying Dhan's charges on both orders. The levels below were set
// from 18 November's spread of each reading (its top or bottom 5–10%) and are fixed, so later days
// test them honestly.
//
// Pure apart from its inputs: packets in, a scorecard out. The trader feeds it live and replayed
// frames; `npm run scalp:lab` feeds it a recorded day.

import type { Packet } from "../../lib/live/feed/packets.ts";
import type { ScalpCell, ScalpFiring, ScalpLabStatus, ScalpTriggerId } from "../../lib/engine/trading.ts";
import { roundTripCharges } from "../../lib/trading/charges.ts";
import { pickContract, type ChainRow } from "./contracts.ts";
import type { MarketQuote } from "./market.ts";

/** Holds each pretend trade is scored at, in seconds. */
export const SCALP_HOLDS = [30, 60, 120, 180] as const;

export const SCALP_LEVELS = {
  /** Burst: the future's move over 10 seconds, in points, and the share of trades on that side. */
  burstPoints: 4.3,
  burstFlow: 0.75,
  /** Fade: the future's move over 30 seconds, in points. */
  fadePoints: 10,
  /** Order-book lean: waiting buy versus sell orders, against their 15-minute average. */
  lean: 0.05,
  /** No signal: one pretend trade this often, in seconds. */
  baselineEvery: 120,
} as const;

const TRIGGERS: readonly { id: ScalpTriggerId; name: string; about: string }[] = [
  {
    id: "burst",
    name: "Burst with buyers",
    about: `The future jumps ${SCALP_LEVELS.burstPoints}+ points in 10 seconds while most trades hit the ask (or falls as much while most hit the bid). Buys with the move.`,
  },
  {
    id: "fade",
    name: "Fade a spike",
    about: `The future moves ${SCALP_LEVELS.fadePoints}+ points in 30 seconds. Buys against it, betting on a snap-back.`,
  },
  {
    id: "lean",
    name: "Fade the order book",
    about: `Waiting buy and sell orders lean ${SCALP_LEVELS.lean * 100}%+ further to one side than their 15-minute average. Buys the other way.`,
  },
  {
    id: "baseline",
    name: "No signal",
    about: `A call or a put every ${SCALP_LEVELS.baselineEvery / 60} minutes, taking turns. What trading costs with no edge: a trigger has to beat this.`,
  },
];

const SECOND = 1_000;
const LATENCY_MS = 300;
const SLIPPAGE = 0.05;
const COOLDOWN_MS = 60 * SECOND;
const WARM_UP_MS = 60 * SECOND;
/** No new firing this close to the close, so the longest hold finishes while options trade. */
const LAST_FIRING_BEFORE_CLOSE_MS = 5 * 60 * SECOND;
const ENTRY_STALE_MS = 5 * SECOND;
const EXIT_STALE_MS = 10 * SECOND;
/** A gap in the future's ticks this long starts the readings over. */
const GAP_MS = 2 * 60 * SECOND;
const FLOW_SECONDS = 20;
const LEAN_SECONDS = 900;
const RECENT = 30;

export interface ScalpLabSetup {
  session: { open: number; close: number };
  /** NIFTY's near-month future, once known. */
  future: () => { key: string; name: string } | null;
  /** The option chain the pretend trades pick from (the trader's expiry), once loaded. */
  chain: () => readonly ChainRow[] | null;
  /** NIFTY's feed key, for the at-the-money strike. */
  spotKey: string;
  /** The latest quote of an instrument: NIFTY and the options. */
  quote: (key: string) => MarketQuote | undefined;
}

export interface ScalpLab {
  /** Starts over for a new run; null turns the lab off. */
  reset(setup: ScalpLabSetup | null): void;
  /** Every packet of the feed, in order, with its time on the market's clock. */
  onPacket(packet: Packet, at: number): void;
  /** Moves the clock: finishes seconds, prices entries and exits that are due. */
  advance(at: number): void;
  status(): ScalpLabStatus;
}

interface Running extends ScalpFiring {
  entryDue: number;
  entryAt: number | null;
  lotSize: number;
  feedKey: string | null;
  done: boolean[];
}

const signed = (value: number, digits = 1) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;

export function createScalpLab(): ScalpLab {
  let setup: ScalpLabSetup | null = null;
  let firings: Running[] = [];
  let cells = new Map<ScalpTriggerId, ScalpCell[]>();
  let nextId = 1;

  // The future, second by second.
  let last: { ltp: number; bid: number; ask: number; volume: number; buyQty: number; sellQty: number; at: number } | null = null;
  let second: number | null = null;
  let buying = 0;
  let selling = 0;
  let mids: (number | null)[] = [];
  let buys: number[] = [];
  let sells: number[] = [];
  let leans: number[] = [];
  let leanSum = 0;
  const lastFired = new Map<ScalpTriggerId, number>();
  let baselineSide: 1 | -1 = 1;

  function clearReadings() {
    last = null;
    second = null;
    buying = selling = 0;
    mids = [];
    buys = [];
    sells = [];
    leans = [];
    leanSum = 0;
  }

  function reset(next: ScalpLabSetup | null) {
    setup = next;
    firings = [];
    cells = new Map(TRIGGERS.map((t) => [t.id, SCALP_HOLDS.map((holdSeconds) => ({ holdSeconds, trades: 0, wins: 0, net: 0 }))]));
    lastFired.clear();
    baselineSide = 1;
    clearReadings();
  }

  /** Closes every whole second up to `at`, checking the triggers at the end of each. */
  function roll(at: number) {
    const now = Math.floor(at / SECOND);
    if (second === null) {
      second = now;
      return;
    }
    if (now - second > GAP_MS / SECOND) {
      clearReadings();
      second = now;
      return;
    }
    while (second < now) {
      finish(second);
      second += 1;
    }
  }

  function push<T>(list: T[], value: T, keep: number) {
    list.push(value);
    if (list.length > keep) list.shift();
  }

  function finish(sec: number) {
    const end = (sec + 1) * SECOND;
    const fresh = last !== null && end - last.at <= ENTRY_STALE_MS;
    const mid = fresh && last!.bid > 0 && last!.ask >= last!.bid ? (last!.bid + last!.ask) / 2 : fresh ? last!.ltp : null;
    push(mids, mid, 31);
    push(buys, buying, FLOW_SECONDS);
    push(sells, selling, FLOW_SECONDS);
    buying = selling = 0;
    if (last && last.buyQty + last.sellQty > 0) {
      const imbalance = (last.buyQty - last.sellQty) / (last.buyQty + last.sellQty);
      // The lean is measured against the average of the seconds before this one.
      const average = leans.length === LEAN_SECONDS ? leanSum / LEAN_SECONDS : null;
      leans.push(imbalance);
      leanSum += imbalance;
      if (leans.length > LEAN_SECONDS) leanSum -= leans.shift()!;
      if (average !== null && mid !== null) check(end, mid, imbalance - average);
      else if (mid !== null) check(end, mid, null);
    } else if (mid !== null) check(end, mid, null);
  }

  function check(at: number, mid: number, lean: number | null) {
    if (!setup) return;
    const { open, close } = setup.session;
    if (at < open + WARM_UP_MS || at > close - LAST_FIRING_BEFORE_CLOSE_MS) return;
    const back = (seconds: number) => mids[mids.length - 1 - seconds] ?? null;
    const ten = back(10);
    const thirty = back(30);

    if (ten !== null) {
      const move = mid - ten;
      const b = buys.reduce((s, v) => s + v, 0);
      const s = sells.reduce((t, v) => t + v, 0);
      const flow = b + s > 0 ? (b - s) / (b + s) : 0;
      const side = move >= SCALP_LEVELS.burstPoints && flow >= SCALP_LEVELS.burstFlow ? 1 : move <= -SCALP_LEVELS.burstPoints && flow <= -SCALP_LEVELS.burstFlow ? -1 : 0;
      if (side) fire("burst", side, at, `${signed(move)} points in 10 s, ${Math.round(((side > 0 ? b : s) / (b + s)) * 100)}% of trades ${side > 0 ? "at the ask" : "at the bid"}`);
    }
    if (thirty !== null) {
      const move = mid - thirty;
      if (Math.abs(move) >= SCALP_LEVELS.fadePoints) fire("fade", move > 0 ? -1 : 1, at, `${signed(move)} points in 30 s`);
    }
    if (lean !== null && Math.abs(lean) >= SCALP_LEVELS.lean) {
      fire("lean", lean > 0 ? -1 : 1, at, `orders lean ${Math.abs(lean * 100).toFixed(1)}% more to ${lean > 0 ? "buyers" : "sellers"} than usual`);
    }
    if (Math.floor((at - open) / SECOND) % SCALP_LEVELS.baselineEvery === 0) {
      fire("baseline", baselineSide, at, `every ${SCALP_LEVELS.baselineEvery / 60} min`);
      baselineSide = baselineSide > 0 ? -1 : 1;
    }
  }

  function fire(trigger: ScalpTriggerId, direction: 1 | -1, at: number, reading: string) {
    if (!setup) return;
    const previous = lastFired.get(trigger);
    if (trigger !== "baseline" && previous !== undefined && at - previous < COOLDOWN_MS) return;
    lastFired.set(trigger, at);
    const spot = setup.quote(setup.spotKey)?.ltp;
    const chain = setup.chain();
    const contract = chain && spot ? pickContract(chain, spot, direction, 0) : null;
    const firing: Running = {
      id: `s${nextId++}`,
      trigger,
      at,
      direction,
      reading,
      contract: contract?.name ?? null,
      entry: null,
      results: SCALP_HOLDS.map(() => null),
      note: contract ? null : "No option contract to price it on",
      entryDue: at + LATENCY_MS,
      entryAt: null,
      lotSize: contract?.lotSize ?? 0,
      feedKey: contract?.feedKey ?? null,
      done: SCALP_HOLDS.map(() => !contract),
    };
    firings.push(firing);
  }

  /** Prices entries and exits that have come due. */
  function settle(at: number) {
    if (!setup) return;
    for (const f of firings) {
      if (!f.feedKey || f.done.every(Boolean)) continue;
      const q = setup.quote(f.feedKey);
      if (f.entryAt === null) {
        if (at < f.entryDue) continue;
        if (q && q.ask !== null && at - q.at <= ENTRY_STALE_MS) {
          f.entry = Math.round((q.ask + SLIPPAGE) * 100) / 100;
          f.entryAt = f.entryDue;
        } else if (at - f.entryDue > ENTRY_STALE_MS) {
          f.note = "No fresh order book on the option";
          f.done = f.done.map(() => true);
        }
        continue;
      }
      SCALP_HOLDS.forEach((hold, k) => {
        if (f.done[k] || at < f.entryAt! + hold * SECOND) return;
        if (q && q.bid !== null && at - q.at <= EXIT_STALE_MS) {
          const sell = Math.max(0.05, q.bid - SLIPPAGE);
          const units = f.lotSize;
          const net = (sell - f.entry!) * units - roundTripCharges(f.entry! * units, sell * units).total;
          f.results[k] = Math.round(net * 100) / 100;
          f.done[k] = true;
          const cell = cells.get(f.trigger)![k];
          cell.trades += 1;
          cell.net += net;
          if (net > 0) cell.wins += 1;
        } else if (at - (f.entryAt! + hold * SECOND) > EXIT_STALE_MS) {
          f.done[k] = true;
          f.note ??= "No fresh price to sell at for some holds";
        }
      });
    }
    // Finished firings beyond the recent list are already counted in the cells.
    if (firings.length > RECENT) {
      const keep = firings.length - RECENT;
      firings = firings.filter((f, i) => i >= keep || !f.done.every(Boolean));
    }
  }

  return {
    reset,
    onPacket(packet, at) {
      const future = setup?.future();
      if (!future) return;
      roll(at);
      if (packet.kind !== "quote" || packet.key !== future.key || !(packet.ltp > 0)) return;
      const best = packet.depth?.[0];
      const bid = best && best.bid > 0 ? best.bid : 0;
      const ask = best && best.ask > 0 ? best.ask : 0;
      if (last && packet.volume > last.volume && last.bid > 0 && last.ask > 0) {
        // A trade at or through the ask was a buyer taking it; at or through the bid, a seller.
        const traded = packet.volume - last.volume;
        if (packet.ltp >= last.ask) buying += traded;
        else if (packet.ltp <= last.bid) selling += traded;
      }
      last = { ltp: packet.ltp, bid, ask, volume: packet.volume, buyQty: packet.totalBuyQty, sellQty: packet.totalSellQty, at };
    },
    advance(at) {
      if (!setup) return;
      if (setup.future()) roll(at);
      settle(at);
    },
    status() {
      const holds = [...SCALP_HOLDS];
      const triggers = TRIGGERS.map((t) => ({ ...t, cells: (cells.get(t.id) ?? []).map((c) => ({ ...c, net: Math.round(c.net * 100) / 100 })) }));
      const recent = firings
        .slice(-RECENT)
        .reverse()
        .map(({ id, trigger, at, direction, reading, contract, entry, results, note }) => ({ id, trigger, at, direction, reading, contract, entry, results: [...results], note }));
      if (!setup) return { state: "off", note: "Starts with the next trading run", future: null, holds, triggers, recent };
      const future = setup.future()?.name ?? null;
      if (!future) return { state: "waiting", note: "Looking up today's NIFTY future", future, holds, triggers, recent };
      if (!last) return { state: "waiting", note: "Waiting for the future's first order-book tick", future, holds, triggers, recent };
      if (!setup.chain()) return { state: "waiting", note: "Waiting for the option contracts", future, holds, triggers, recent };
      return { state: "running", note: null, future, holds, triggers, recent };
    },
  };
}
