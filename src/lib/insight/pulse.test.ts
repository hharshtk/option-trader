import assert from "node:assert/strict";
import { test } from "node:test";
import type { JournalSession, SessionInstrument } from "../engine/protocol.ts";
import { AUCTION_MINUTE, computePulse, ridge, wilson } from "./pulse.ts";

const OPEN = Date.UTC(2026, 10, 16, 3, 45);

function instrument(key: string, reference: number, closes: number[], extra: Partial<SessionInstrument> = {}): SessionInstrument {
  return {
    key,
    symbol: key,
    name: null,
    sector: null,
    mode: "quote",
    packets: closes.length,
    reference,
    ltp: closes.at(-1)!,
    open: closes[0],
    high: Math.max(...closes),
    low: Math.min(...closes),
    vwap: null,
    volume: null,
    buyQty: null,
    sellQty: null,
    firstAt: OPEN,
    lastAt: OPEN + closes.length * 60_000,
    closes,
    ...extra,
  };
}

/** Two stocks; NIFTY is exactly 70% A + 30% B, while the prior says 50/50. */
function session(minutes: number): JournalSession {
  const a = Array.from({ length: minutes }, (_, t) => 100 * (1 + 0.01 * Math.sin(t / 7)));
  const b = Array.from({ length: minutes }, (_, t) => 200 * (1 + 0.01 * Math.cos(t / 5)));
  const index = a.map((_, t) => 1000 * (1 + 0.7 * (a[t] / 100 - 1) + 0.3 * (b[t] / 200 - 1)));
  return {
    date: "2026-11-16",
    session: { open: OPEN, close: OPEN + 375 * 60_000 },
    builtAt: OPEN + minutes * 60_000,
    readMs: 1,
    file: { bytes: 0, records: 0, frames: 0, controls: 0, packets: {}, events: {}, firstFrameAt: OPEN, lastFrameAt: OPEN + minutes * 60_000 },
    runs: [],
    gaps: [],
    states: [],
    benchmark: "IDX_I:13",
    minutes: index.map((v, t) => ({ at: OPEN + t * 60_000, frames: 1, packets: 1, bar: [v, v, v, v], advancers: 1, decliners: 1 })),
    instruments: [instrument("IDX_I:13", 1000, index, { mode: "ticker" }), instrument("NSE_EQ:1", 100, a, { vwap: 99 }), instrument("NSE_EQ:2", 200, b, { vwap: 999 })],
  };
}

const constituents = [
  { key: "NSE_EQ:1", symbol: "A", sector: "One", prior: 1 },
  { key: "NSE_EQ:2", symbol: "B", sector: "Two", prior: 1 },
];

test("ridge recovers known weights", () => {
  const X = [
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  const w = ridge(X, [0.7, 0.3, 1], [0.5, 0.5], 1e-9);
  assert.ok(Math.abs(w[0] - 0.7) < 1e-6 && Math.abs(w[1] - 0.3) < 1e-6);
});

test("pulse learns the index weights and attributes its points", () => {
  const pulse = computePulse(session(120), constituents)!;
  assert.equal(pulse.weights.source, "fitted");
  assert.ok(Math.abs(pulse.contributions.find((c) => c.symbol === "A")!.weight - 0.7) < 0.02);
  assert.ok(pulse.weights.trackingPoints! < pulse.weights.priorTrackingPoints!);
  assert.ok(Math.abs(pulse.explainedPoints - pulse.nifty.points) < 0.5);
  assert.equal(pulse.breadth.weightAboveVwap !== null, true);
});

test("pulse falls back to the prior early in the session", () => {
  const pulse = computePulse(session(20), constituents)!;
  assert.equal(pulse.weights.source, "prior");
  assert.equal(pulse.contributions[0].weight, 0.5);
});

test("signals are scored only on completed outcomes", () => {
  const pulse = computePulse(session(120), constituents)!;
  for (const signal of pulse.signals)
    for (const stats of signal.stats) {
      for (const e of stats.events) assert.ok(e.at + stats.horizon * 60_000 < OPEN + 119 * 60_000);
      assert.equal(stats.longs + stats.shorts, stats.fired);
      // Firings never overlap.
      for (let i = 1; i < stats.events.length; i += 1) assert.ok(stats.events[i].at - stats.events[i - 1].at >= stats.horizon * 60_000);
    }
});

test("wilson interval widens on small samples and contains the rate", () => {
  const [lo, hi] = wilson(12, 18);
  assert.ok(lo < 12 / 18 && hi > 12 / 18 && lo < 0.5);
  const [lo2] = wilson(120, 180);
  assert.ok(lo2 > 0.5);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test("breadth counts only the index's own stocks", () => {
  const s = session(30);
  // A stock outside the index, up all day, must not count.
  s.instruments.push(instrument("NSE_EQ:3", 50, Array.from({ length: 30 }, () => 60)));
  const pulse = computePulse(s, constituents)!;
  assert.equal(pulse.breadth.advancers + pulse.breadth.decliners, 2);
  assert.ok(pulse.series.every((p) => p.advancers + p.decliners <= 2));
});

test("no signal reads the closing auction, and no outcome is measured across it", () => {
  const pulse = computePulse(session(375), constituents)!;
  for (const point of pulse.series.slice(AUCTION_MINUTE)) assert.ok(point.readings.every((r) => r === "—") && point.composite === 0);
  for (const signal of pulse.signals) for (const stats of signal.stats) for (const e of stats.events) assert.ok(e.at + stats.horizon * 60_000 < OPEN + AUCTION_MINUTE * 60_000);
});

/** NIFTY rising 0.02% a minute (15-minute momentum long from minute 15), with its future's buyers taking 80% from minute 10. */
function trending(writers: "puts" | "calls"): JournalSession {
  const n = 25;
  const index = Array.from({ length: n }, (_, t) => 25_000 * (1 + 0.0002 * t));
  const flat = (v: number) => index.map(() => v);
  return {
    ...session(n),
    instruments: [instrument("IDX_I:13", 24_990, index, { mode: "ticker" })],
    minutes: index.map((v, t) => ({ at: OPEN + t * 60_000, frames: 1, packets: 1, bar: [v, v, v, v], advancers: 0, decliners: 0 })),
    derivatives: {
      future: {
        key: "NSE_FNO:1",
        name: "NIFTY NOV FUT",
        expiry: "2026-11-24",
        lotSize: 65,
        oiBefore: 1_000_000,
        closes: index.map((v) => v + 20),
        oi: flat(1_000_000),
        vwap: flat(25_000),
        buys: index.map((_, t) => (t >= 10 ? 800 : 500)),
        sells: index.map((_, t) => (t >= 10 ? 200 : 500)),
        bidQty: flat(100),
        askQty: flat(100),
      },
      options: {
        expiry: "2026-11-23",
        lotSize: 65,
        step: 50,
        band: 10,
        atm: flat(25_000),
        // Open interest near the money grows 1% a minute on one side.
        callOi: index.map((_, t) => (writers === "calls" ? 1_000_000 * (1 + 0.01 * t) : 1_000_000)),
        putOi: index.map((_, t) => (writers === "puts" ? 1_000_000 * (1 + 0.01 * t) : 1_000_000)),
        straddle: flat(300),
        strikes: [],
      },
    },
  };
}

test("futures and options signals read the derivatives; confirmed needs them to back a price signal", () => {
  const backed = computePulse(trending("puts"), [])!;
  const vote = (id: string) => backed.signals.find((s) => s.id === id)!.vote;
  assert.equal(vote("momentum"), 1);
  assert.equal(vote("flow"), 1);
  assert.equal(vote("writers"), 1);
  assert.equal(vote("confirmed"), 1);
  assert.equal(backed.signals.find((s) => s.id === "flow")!.display, "buyers 80% in 5 min");
  // The combined votes are in the series too, for the trader.
  assert.deepEqual(backed.series.at(-1)!.combined, [0, 1]);

  // Call writers adding against a rising market: one futures-and-options signal disagrees, so nothing is confirmed.
  const against = computePulse(trending("calls"), [])!;
  assert.equal(against.signals.find((s) => s.id === "writers")!.vote, -1);
  assert.equal(against.signals.find((s) => s.id === "confirmed")!.vote, 0);
});

test("a day recorded without futures and options gives those signals no reading", () => {
  const pulse = computePulse(session(60), constituents)!;
  assert.equal(pulse.derivatives, null);
  for (const id of ["flow", "buildup", "writers", "confirmed"]) assert.equal(pulse.signals.find((s) => s.id === id)!.vote, 0);
  assert.equal(pulse.signals.find((s) => s.id === "flow")!.display, "—");
});
