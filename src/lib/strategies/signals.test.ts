import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SIGNAL_PARAMS, PATTERN_SIGNALS, readSignalAt, withDefaults, type PatternSignalId, type SignalInputs, type SignalParams } from "./signals.ts";

/** Inputs from a list of minute closes (each minute's bar is open = previous close, close = this). */
function inputs(closes: number[], reference: number, opens?: number[], cut = Number.POSITIVE_INFINITY): SignalInputs {
  const bar = (t: number): [number, number, number, number] | null => {
    if (t > cut || t >= closes.length || t < 0) return null;
    const open = opens?.[t] ?? (t === 0 ? reference : closes[t - 1]);
    return [open, Math.max(open, closes[t]), Math.min(open, closes[t]), closes[t]];
  };
  return {
    breadth: () => 0,
    basketMove: () => null,
    indexMove: () => null,
    close: (t) => (t > cut || t >= closes.length || t < 0 ? null : closes[t]),
    bar,
    reference,
  };
}

const votes = (s: SignalInputs, signal: PatternSignalId, params: SignalParams = DEFAULT_SIGNAL_PARAMS, minutes = 375) =>
  Array.from({ length: minutes }, (_, t) => readSignalAt(s, t, signal, params).vote);
const firedAt = (v: number[]) => v.flatMap((vote, t) => (vote !== 0 ? [[t, vote]] : []));

test("intraday momentum: once a day, at its minute, following the first half hour from the previous close", () => {
  const closes = Array.from({ length: 375 }, (_, t) => (t < 30 ? 25_000 + t * 2.5 : 25_075 - (t - 30)));
  const fired = firedAt(votes(inputs(closes, 25_000), "day-momentum"));
  assert.deepEqual(fired, [[328, 1]], "read at 14:44, the close of minute 328, up 0.29% by 09:45");
  const strict = withDefaults({ "day-momentum": { minPct: 0.5 } });
  assert.deepEqual(firedAt(votes(inputs(closes, 25_000), "day-momentum", strict)), [], "too small a move");
});

test("opening range breakout: only the first close beyond the first 15 minutes' range", () => {
  const closes = Array.from({ length: 60 }, (_, t) => (t < 15 ? 25_000 + (t % 2) * 20 : t < 20 ? 25_010 : t < 30 ? 25_060 : 24_900));
  const fired = firedAt(votes(inputs(closes, 25_000), "opening-range", DEFAULT_SIGNAL_PARAMS, 60));
  assert.deepEqual(fired, [[20, 1]], "breaks above at minute 20; the later break below doesn't count");
  const down = Array.from({ length: 40 }, (_, t) => (t < 15 ? 25_000 + (t % 2) * 20 : t < 25 ? 25_010 : 24_950));
  assert.deepEqual(firedAt(votes(inputs(down, 25_000), "opening-range", DEFAULT_SIGNAL_PARAMS, 40)), [[25, -1]]);
});

test("moving-average crossover: only at the close of a 5-minute bar where the averages cross", () => {
  // Falling for two hours, then rising.
  const closes = Array.from({ length: 300 }, (_, t) => (t < 150 ? 25_000 - t * 2 : 24_700 + (t - 150) * 4));
  const fired = firedAt(votes(inputs(closes, 25_000), "ema-cross", DEFAULT_SIGNAL_PARAMS, 300));
  assert.equal(fired.length, 1);
  const [[t, vote]] = fired;
  assert.equal(vote, 1);
  assert.equal((t + 1) % 5, 0, "on a bar close");
  assert.ok(t > 150, "after the turn");
});

test("Supertrend: a turn up after a fall, at a bar close", () => {
  const closes = Array.from({ length: 300 }, (_, t) => (t < 150 ? 25_000 - t * 3 : 24_550 + (t - 150) * 6));
  const fired = firedAt(votes(inputs(closes, 25_000), "supertrend", DEFAULT_SIGNAL_PARAMS, 300));
  assert.ok(fired.length >= 1);
  assert.deepEqual(fired.at(-1)?.[1], 1);
  assert.ok(fired.every(([t]) => (t + 1) % 5 === 0));
});

test("RSI reversal: a bet up as RSI climbs back above 30 after a sharp fall", () => {
  const closes = Array.from({ length: 300 }, (_, t) => (t < 100 ? 25_000 + Math.sin(t) * 5 : t < 160 ? 25_000 - (t - 100) * 8 : 24_520 + (t - 160) * 6));
  const fired = firedAt(votes(inputs(closes, 25_000), "rsi-reversal", DEFAULT_SIGNAL_PARAMS, 300));
  assert.ok(fired.some(([t, vote]) => vote === 1 && t > 160), JSON.stringify(fired));
});

test("gap fade: once, at 09:25, against a gap between 0.3% and 1%", () => {
  const flat = Array.from({ length: 60 }, () => 25_125);
  const fired = (open: number) => firedAt(votes(inputs(flat, 25_000, [open]), "gap-fade", DEFAULT_SIGNAL_PARAMS, 60));
  assert.deepEqual(fired(25_125), [[9, -1]], "a 0.5% gap up is a bet down, read at 09:25");
  assert.deepEqual(fired(24_875), [[9, 1]]);
  assert.deepEqual(fired(25_050), [], "0.2% is too small");
  assert.deepEqual(fired(25_400), [], "1.6% is too large to fade");
});

test("no pattern looks ahead: a reading at minute t is the same when the day stops at t", () => {
  let seed = 3;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  const closes: number[] = [];
  for (let t = 0, p = 25_000; t < 375; t += 1) closes.push((p += (random() - 0.5) * 30));
  const full = inputs(closes, 24_950);
  for (const signal of PATTERN_SIGNALS) {
    for (const t of [9, 14, 20, 59, 104, 149, 209, 328, 340]) {
      const cut = inputs(closes, 24_950, undefined, t);
      assert.deepEqual(readSignalAt(cut, t, signal.id, DEFAULT_SIGNAL_PARAMS), readSignalAt(full, t, signal.id, DEFAULT_SIGNAL_PARAMS), `${signal.id} at ${t}`);
    }
  }
});

test("missing numbers get their defaults; unknown ones are ignored", () => {
  const filled = withDefaults({ breadth: { stocks: 8 }, nothing: { x: 1 } } as never);
  assert.equal(filled.breadth.stocks, 8);
  assert.equal(filled.breadth.minutes, DEFAULT_SIGNAL_PARAMS.breadth.minutes);
  assert.deepEqual(filled.supertrend, DEFAULT_SIGNAL_PARAMS.supertrend);
  assert.equal("nothing" in filled, false);
});
