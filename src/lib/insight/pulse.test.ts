import assert from "node:assert/strict";
import { test } from "node:test";
import type { JournalSession, SessionInstrument } from "../engine/protocol.ts";
import { computePulse, ridge, wilson } from "./pulse.ts";

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
