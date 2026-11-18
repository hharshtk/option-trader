import assert from "node:assert/strict";
import { test } from "node:test";
import type { JournalSession, SessionStrike } from "../engine/protocol.ts";
import { black76, derivativesSnapshot, derivativesView, impliedDeviation, impliedMove, maxPain, normCdf, optionView, parityForward, positioning, tradingMinutesToExpiry } from "./derivatives.ts";

const ist = (value: string) => Date.parse(`${value}+05:30`);
const near = (actual: number | null | undefined, expected: number, tolerance: number) => assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test("the normal distribution and Black-76 hold their textbook identities", () => {
  near(normCdf(0), 0.5, 1e-7);
  near(normCdf(1.96), 0.975, 1e-4);
  near(normCdf(-1.96), 0.025, 1e-4);
  // Put-call parity on the forward: call − put = forward − strike.
  const [f, k, s] = [25_200, 25_000, 0.02];
  near(black76(f, k, s, "CE") - black76(f, k, s, "PE"), f - k, 1e-6);
  // At the money the straddle is about 0.8 × forward × σ√T.
  near(black76(f, f, s, "CE") + black76(f, f, s, "PE"), 0.7979 * f * s, 0.5);
});

test("implied volatility gives back the price it came from, and refuses impossible prices", () => {
  const price = black76(25_100, 25_200, 0.018, "PE");
  near(impliedDeviation(price, 25_100, 25_200, "PE"), 0.018, 1e-6);
  assert.equal(impliedDeviation(50, 25_100, 25_200, "PE"), null, "below intrinsic value");
  assert.equal(impliedDeviation(30_000, 25_100, 25_200, "CE"), null, "above the forward");
});

test("an at-the-money option has a delta near a half and loses time value over a hold", () => {
  const premium = black76(25_000, 25_000, 0.015, "CE");
  const call = optionView({ premium, forward: 25_000, strike: 25_000, type: "CE", minutesToExpiry: 1_500, holdMinutes: 15 })!;
  near(call.delta, 0.5, 0.01);
  // Time value goes with √time: 15 of 1,500 minutes costs about 1 − √0.99 of the premium.
  near(call.decay, premium * (1 - Math.sqrt(0.99)), 0.05);
  const put = optionView({ premium, forward: 25_000, strike: 25_000, type: "PE", minutesToExpiry: 1_500, holdMinutes: 15 })!;
  near(put.delta, -0.5, 0.01);
  assert.equal(optionView({ premium, forward: 25_000, strike: 25_000, type: "CE", minutesToExpiry: 0, holdMinutes: 15 }), null);
});

test("the straddle's expected move shrinks with the square root of time", () => {
  assert.equal(impliedMove(300, 1_500, 15), 30);
  assert.equal(impliedMove(300, 10, 15), 300, "never more than the move to expiry");
  assert.equal(impliedMove(null, 1_500, 15), null);
});

test("trading minutes to expiry skip weekends and count what is left of today", () => {
  const session = { open: ist("2026-11-18T09:15:00"), close: ist("2026-11-18T15:30:00") };
  // Wednesday 12:04 to Monday's close: 206 minutes today, then Thursday, Friday and Monday.
  assert.equal(tradingMinutesToExpiry(ist("2026-11-18T12:04:00"), "2026-11-23", "2026-11-18", session), 206 + 3 * 375);
  assert.equal(tradingMinutesToExpiry(ist("2026-11-18T08:00:00"), "2026-11-18", "2026-11-18", session), 375, "before the open, the whole session");
  assert.equal(tradingMinutesToExpiry(ist("2026-11-18T12:00:00"), "2026-11-17", "2026-11-18", session), 0, "expired");
});

test("price against open interest reads as the four kinds of positioning", () => {
  assert.equal(positioning(0.002, 0.003), "long build-up");
  assert.equal(positioning(-0.002, 0.003), "short build-up");
  assert.equal(positioning(0.002, -0.003), "short covering");
  assert.equal(positioning(-0.002, -0.003), "long unwinding");
  assert.equal(positioning(0.00001, 0.003), null, "price barely moved");
  assert.equal(positioning(null, 0.003), null);
});

const quote = (key: string, oi: number, ltp: number) => ({ key, ltp, bid: ltp - 0.5, ask: ltp + 0.5, oi, oiBefore: oi / 2, volume: 1 });

test("max pain is the settlement that pays option holders least; parity gives the forward", () => {
  const strikes: SessionStrike[] = [24_900, 25_000, 25_100].map((strike) => ({ strike, call: quote(`c${strike}`, strike === 25_100 ? 900 : 100, 50), put: quote(`p${strike}`, strike === 24_900 ? 900 : 100, 50) }));
  assert.equal(maxPain(strikes), 25_000);
  assert.equal(parityForward({ strike: 25_000, call: quote("c", 1, 120), put: quote("p", 1, 100) }), 25_020);
});

function session(): JournalSession {
  const OPEN = ist("2026-11-18T09:15:00");
  const n = 20;
  const index = Array.from({ length: n }, (_, t) => 25_000 + t);
  return {
    date: "2026-11-18",
    session: { open: OPEN, close: OPEN + 375 * 60_000 },
    builtAt: OPEN + n * 60_000,
    readMs: 0,
    file: { bytes: 0, records: 0, frames: 0, controls: 0, packets: {}, events: {}, firstFrameAt: OPEN, lastFrameAt: OPEN + n * 60_000 },
    runs: [],
    gaps: [],
    states: [],
    benchmark: "IDX_I:13",
    minutes: index.map((v, t) => ({ at: OPEN + t * 60_000, frames: 1, packets: 1, bar: [v, v, v, v], advancers: 0, decliners: 0 })),
    instruments: [],
    derivatives: {
      future: {
        key: "NSE_FNO:1",
        name: "NIFTY NOV FUT",
        expiry: "2026-11-24",
        lotSize: 65,
        oiBefore: 1_000_000,
        closes: index.map((v) => v + 20),
        oi: index.map((_, t) => 1_000_000 + t * 1_000),
        vwap: index.map(() => 25_005),
        // Buyers take 80 a minute, sellers 20, from minute 10.
        buys: index.map((_, t) => (t >= 10 ? 80 : 50)),
        sells: index.map((_, t) => (t >= 10 ? 20 : 50)),
        bidQty: index.map(() => 300),
        askQty: index.map(() => 100),
      },
      options: {
        expiry: "2026-11-23",
        lotSize: 65,
        step: 50,
        band: 10,
        atm: index.map(() => 25_000),
        callOi: index.map((_, t) => 1_000_000 + t * 1_000),
        putOi: index.map((_, t) => 1_000_000 + t * 5_000),
        straddle: index.map(() => 300),
        strikes: [
          { strike: 24_950, call: quote("a", 10_000, 90), put: quote("b", 650_000, 40) },
          { strike: 25_000, call: quote("c", 20_000, 60), put: quote("d", 30_000, 50) },
          { strike: 25_050, call: quote("e", 1_300_000, 40), put: quote("f", 10_000, 80) },
        ],
      },
    },
  };
}

test("the readers look back over their window only, and the snapshot names the walls", () => {
  const s = session();
  const view = derivativesView(s)!;
  assert.deepEqual(view.flow(14, 5), { buys: 400, sells: 100, share: 0.6 });
  assert.equal(view.flow(3, 5), null, "not enough minutes yet");
  near(view.oiChange(19, 15), 15_000 / 1_004_000, 1e-9);
  const w = view.writers(19, 15)!;
  assert.deepEqual([w.calls, w.puts], [15_000, 75_000]);
  near(w.share, 60_000 / (1_019_000 + 1_095_000), 1e-9);

  const snap = derivativesSnapshot(view, 19, { spot: (t) => 25_000 + t, at: s.session!.open + 20 * 60_000, date: s.date, session: s.session! });
  assert.equal(snap.future?.basis, 20);
  assert.equal(snap.future?.positioning15, "long build-up");
  assert.equal(snap.future?.flow5, 0.6);
  assert.equal(snap.future?.bookImbalance, 0.5);
  assert.equal(snap.options?.callWall?.strike, 25_050);
  assert.equal(snap.options?.putWall?.strike, 24_950);
  assert.equal(snap.options?.forward, 25_010);
  assert.equal(snap.options?.ivChangeSinceOpenPct !== null, true);
});

test("a session without derivatives has no view", () => {
  const s = session();
  delete s.derivatives;
  assert.equal(derivativesView(s), null);
});

test("the 20-level book and the option chain series reach the snapshot", () => {
  const s = session();
  const n = s.minutes.length;
  const flat = <T>(v: T) => Array.from({ length: n }, () => v);
  const OPEN = s.session!.open;
  s.derivatives!.book = { key: "NSE_FNO:1", bidQty: flat(600), askQty: flat(200), bidOrders: flat(10), askOrders: flat(30), spread: flat(2.5) };
  s.derivatives!.chain = {
    expiry: "2026-11-23",
    nextExpiry: "2026-12-01",
    // The first snapshot lands in minute 2.
    at: Array.from({ length: n }, (_, t) => (t < 2 ? null : OPEN + t * 60_000 + 5_000)),
    spot: flat(25_010),
    atm: flat(25_000),
    forward: flat(25_020),
    ivPct: Array.from({ length: n }, (_, t) => (t < 2 ? null : 14 + t * 0.1)),
    skewPct: flat(1.2),
    straddle: flat(330),
    callOi: flat(6_500_000),
    putOi: flat(3_250_000),
    callOiChange: flat(650_000),
    putOiChange: flat(-65_000),
    callWall: flat(25_500),
    callWallOi: flat(1_300_000),
    putWall: flat(24_500),
    putWallOi: flat(650_000),
    nextIvPct: flat(13),
    nextStraddle: flat(500),
  };
  const view = derivativesView(s)!;
  assert.deepEqual(view.book20(5), { imbalance: 0.5, orders: -0.5, spread: 2.5 });
  const snap = derivativesSnapshot(view, 19, { spot: () => 25_010, at: OPEN + 20 * 60_000, date: s.date, session: s.session! });
  assert.equal(snap.future?.book20Imbalance, 0.5);
  assert.equal(snap.future?.book20OrdersImbalance, -0.5);
  assert.equal(snap.future?.spread, 2.5);
  const c = snap.chain!;
  assert.equal(c.ageMinutes, 1);
  near(c.ivPct!, 15.9, 1e-9);
  assert.equal(c.ivChange15, 1.5);
  assert.equal(c.ivChangeSinceFirst, 1.7);
  assert.equal(c.pcr, 0.5);
  assert.equal(c.callOiChangeDayLots, 10_000);
  assert.equal(c.putOiChangeDayLots, -1_000);
  assert.deepEqual(c.callWall, { strike: 25_500, lots: 20_000, points: 490 });
  assert.deepEqual(c.putWall, { strike: 24_500, lots: 10_000, points: -510 });
  assert.equal(derivativesSnapshot(view, 1, { spot: () => 25_010, at: OPEN + 2 * 60_000, date: s.date, session: s.session! }).chain, null, "no snapshot yet");
});
