// The market context sent to the decision API (state version 2), built from a Pulse of a small
// synthetic day: with futures and options, and without them.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { JournalSession, SessionInstrument } from "../../lib/engine/protocol.ts";
import { DEFAULT_TRADING_CONFIG, type OptionRef } from "../../lib/engine/trading.ts";
import { computePulse } from "../../lib/insight/pulse.ts";
import { buildDecisionState, decisionKey, STATE_VERSION } from "./decision.ts";
import { readSignal } from "./strategy.ts";

const OPEN = Date.parse("2026-11-18T09:15:00+05:30");
const MIN = 60_000;
const N = 40;
const PUT: OptionRef = { securityId: "2", feedKey: "NSE_FNO:2", name: "NIFTY 23 NOV 25000 PUT", strike: 25_000, type: "PE", expiry: "2026-11-23", lotSize: 65, tickSize: 0.05 };

function session(withDerivatives: boolean): JournalSession {
  // NIFTY falling 0.02% a minute: 15-minute momentum votes short from minute 15.
  const index = Array.from({ length: N }, (_, t) => 25_200 * (1 - 0.0002 * t));
  const flat = (v: number) => index.map(() => v);
  const nifty: SessionInstrument = {
    key: "IDX_I:13",
    symbol: "NIFTY",
    name: null,
    sector: "Index",
    mode: "ticker",
    packets: N,
    reference: 25_250,
    ltp: index.at(-1)!,
    open: index[0],
    high: index[0],
    low: index.at(-1)!,
    vwap: null,
    volume: null,
    buyQty: null,
    sellQty: null,
    firstAt: OPEN,
    lastAt: OPEN + N * MIN,
    closes: index,
  };
  const q = (key: string, ltp: number, oi: number) => ({ key, ltp, bid: ltp - 0.5, ask: ltp + 0.5, oi, oiBefore: oi - 1_000, volume: 1 });
  return {
    date: "2026-11-18",
    session: { open: OPEN, close: OPEN + 375 * MIN },
    builtAt: OPEN + N * MIN,
    readMs: 0,
    file: { bytes: 0, records: 0, frames: 0, controls: 0, packets: {}, events: {}, firstFrameAt: OPEN, lastFrameAt: OPEN + N * MIN + 1_500 },
    runs: [],
    gaps: [],
    states: [],
    benchmark: "IDX_I:13",
    minutes: index.map((v, t) => ({ at: OPEN + t * MIN, frames: 1, packets: 1, bar: [v, v, v, v], advancers: 0, decliners: 0 })),
    instruments: [nifty],
    ...(withDerivatives
      ? {
          derivatives: {
            future: {
              key: "NSE_FNO:1",
              name: "NIFTY NOV FUT",
              expiry: "2026-11-24",
              lotSize: 65,
              oiBefore: 1_000_000,
              closes: index.map((v) => v + 15),
              oi: index.map((_, t) => 1_000_000 + t * 1_000),
              vwap: flat(25_150),
              buys: flat(300),
              sells: flat(700),
              bidQty: flat(100),
              askQty: flat(300),
            },
            options: {
              expiry: "2026-11-23",
              lotSize: 65,
              step: 50,
              band: 10,
              atm: flat(25_000),
              callOi: index.map((_, t) => 1_000_000 + t * 5_000),
              putOi: flat(1_000_000),
              straddle: flat(300),
              strikes: [
                { strike: 24_950, call: q("a", 175, 10_000), put: q("b", 125, 650_000) },
                { strike: 25_000, call: q("c", 150, 20_000), put: q("d", 150, 30_000) },
                { strike: 25_050, call: q("e", 125, 1_300_000), put: q("f", 175, 10_000) },
              ],
            },
          },
        }
      : {}),
  };
}

function state(withDerivatives: boolean) {
  const pulse = computePulse(session(withDerivatives), [])!;
  const reading = readSignal(pulse, OPEN + (N - 2) * MIN, "momentum")!;
  return buildDecisionState({
    pulse,
    reading,
    follow: "momentum",
    direction: -1,
    contract: PUT,
    premium: 150.5,
    quote: { bid: 149.5, ask: 150.5 },
    costPct: 0.8,
    daysToExpiry: 5,
    strategy: { ...DEFAULT_TRADING_CONFIG.strategy, holdMinutes: 15 },
    at: OPEN + N * MIN + 1_500,
    date: "2026-11-18",
    session: { open: OPEN, close: OPEN + 375 * MIN },
    today: { trades: 0, wins: 0, lastResults: [] },
  });
}

test("the state says what the trade must make back, and how far NIFTY typically moves over the hold", () => {
  const s = state(true);
  assert.equal(s.state_version, STATE_VERSION);
  assert.equal(s.proposal.followed_signal, "15-minute momentum");
  assert.ok(s.proposal.trigger.some((t) => t.startsWith("15-minute momentum")));
  const m = s.trade_math;
  assert.ok(m.delta! < -0.4 && m.delta! > -0.6, `delta ${m.delta}`);
  assert.ok(m.time_decay_over_hold_rupees! > 0);
  // Charges (0.8% of 150.5) plus the spread (1) plus decay, over |delta|.
  const expected = (0.008 * 150.5 + 1 + m.time_decay_over_hold_rupees!) / Math.abs(m.delta!);
  assert.ok(Math.abs(m.break_even_nifty_points! - expected) < 0.2, `${m.break_even_nifty_points} against ${expected}`);
  assert.ok(m.target_needs_nifty_points! > m.break_even_nifty_points!);
  assert.ok(m.expected_nifty_move_over_hold_points.priced_by_options! > 0);
  assert.equal(m.spread_pct_of_premium, 0.67);
});

test("the state carries futures and option positioning, once each, and no evidence lines", () => {
  const s = state(true);
  assert.equal(s.futures?.positioning_15m, "short build-up");
  assert.equal(s.futures?.buyers_share_of_volume_5m, 0.3);
  assert.equal(s.options_positioning?.largest_call_oi_above?.strike, 25_050);
  assert.equal(s.options_positioning?.largest_put_oi_below?.strike, 24_950);
  assert.ok(s.options_positioning!.call_oi_change_15m_lots! > 0);
  assert.equal("evidence" in s, false);
  assert.equal(s.breadth.stocks, 0);
  assert.equal(typeof s.trigger_track_record.past_year, "object");
});

test("a day without futures and options sends those sections as null", () => {
  const s = state(false);
  assert.equal(s.futures, null);
  assert.equal(s.options_positioning, null);
  // Option maths still work from NIFTY's price.
  assert.ok(s.trade_math.break_even_nifty_points! > 0);
  assert.equal(s.trade_math.expected_nifty_move_over_hold_points.priced_by_options, null);
});

test("a recorded answer is keyed by the state's version", () => {
  assert.ok(decisionKey({ model: "m", minute: 1, direction: 1, signal: "agree", securityId: "1" }).includes(`s${STATE_VERSION}`));
});

test("each signal's reading says how close it is, how it has done today and its latest firings", () => {
  const pulse = computePulse(session(true), [])!;
  // NIFTY falls 0.02% a minute: momentum votes short from minute 15 and stays on.
  const reading = readSignal(pulse, OPEN + (N - 2) * MIN, "momentum", 10)!;
  const momentum = reading.readings.find((r) => r.id === "momentum")!;
  assert.equal(momentum.threshold, 0.0012);
  assert.ok(momentum.value! < -0.0012);
  // Scored firings at a 10-minute hold: minutes 15 and 25, both right; the one at 35 is still running.
  assert.deepEqual(momentum.today, { horizon: 10, fired: 2, right: 2, points: momentum.today!.points });
  assert.ok(momentum.today!.points > 0, "NIFTY fell after both shorts: points gained by following it");
  assert.deepEqual(
    momentum.recent!.map((f) => [(f.at - OPEN) / MIN, f.vote, f.outcome === null]),
    [
      [35, -1, true],
      [25, -1, false],
      [15, -1, false],
    ],
  );
  assert.match(momentum.recent![0].reading, /% in 15 min$/);
  // Combined signals have no line of their own.
  assert.equal(reading.readings.find((r) => r.id === "agree")!.threshold, null);
});
