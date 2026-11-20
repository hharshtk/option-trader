import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { roundTripCharges } from "../trading/charges.ts";
import { calls, COIN, HORIZON, outcomes, PREDICTORS, scoreboard, type Call, type Outcome } from "./predict.ts";
import type { DayData, MinuteQuote } from "./simulate.ts";
import type { MinuteState } from "./state.ts";

const OPEN = Date.UTC(2026, 10, 18, 3, 45);

/** A day of `n` minutes with NIFTY at `nifty(t)` and one call and one put at 25,000 priced by `price(t, type)`. */
function day(n: number, nifty: (t: number) => number, price: (t: number, type: "CE" | "PE") => { bid: number | null; ask: number | null; ltp: number }, fields: (t: number) => Partial<Record<string, number | null>> = () => ({})): DayData {
  const states: MinuteState[] = [];
  const quotes: MinuteQuote[][] = [];
  for (let t = 0; t < n; t += 1) {
    states[t] = { t, at: OPEN + t * 60_000, nifty: nifty(t), nifty_from_open: nifty(t) - nifty(0), ...fields(t) } as unknown as MinuteState;
    quotes[t] = (["CE", "PE"] as const).map((type) => ({ key: `${type}25000`, strike: 25_000, type, lotSize: 65, ...price(t, type) }));
  }
  return { date: "2026-11-18", states, quotes };
}

/** NIFTY up a point a minute; the call up half a rupee a minute from 100/100.5, the put down as much. */
const rising = () =>
  day(375, (t) => 25_000 + t, (t, type) => (type === "CE" ? { bid: 100 + t / 2, ask: 100.5 + t / 2, ltp: 100.25 + t / 2 } : { bid: 200 - t / 2, ask: 200.5 - t / 2, ltp: 200.25 - t / 2 }));

describe("outcomes", () => {
  it("are NIFTY's move and one lot of each option bought now and sold 15 minutes later, after charges", () => {
    const out = outcomes(rising());
    const at20 = out.find((o) => o.t === 20)!;
    assert.equal(at20.move, HORIZON);
    // The call: bought at the ask + ₹0.05 (110.55), sold at the bid − ₹0.05 fifteen minutes later (117.45).
    const call = (117.45 - 110.55) * 65 - roundTripCharges(110.55 * 65, 117.45 * 65).total;
    assert.equal(at20.call, Math.round(call * 100) / 100);
    // The put: 190.55 bought, 182.45 sold.
    const put = (182.45 - 190.55) * 65 - roundTripCharges(190.55 * 65, 182.45 * 65).total;
    assert.equal(at20.put, Math.round(put * 100) / 100);
  });

  it("stop before the closing auction and skip an option that can't be bought", () => {
    const out = outcomes(rising());
    assert.equal(out.at(-1)!.t, 360 - HORIZON - 1, "the last outcome ends at 15:14");
    const wide = day(60, () => 25_000, () => ({ bid: 100, ask: 110, ltp: 105 }));
    const o = outcomes(wide).find((x) => x.t === 10)!;
    assert.deepEqual([o.move, o.call, o.put], [0, null, null], "a 10% spread isn't bought; the move still counts");
  });
});

describe("calls", () => {
  it("has the coin flip and 'keeps going since the open' as bars, every signal and every rule", () => {
    assert.deepEqual(PREDICTORS.slice(0, 2).map((p) => [p.id, p.kind]), [[COIN, "bar"], ["trend-open", "bar"]]);
    assert.ok(PREDICTORS.some((p) => p.id === "signal:flow") && PREDICTORS.some((p) => p.id === "trend-hold" && p.since === "2026-11-20"));
  });

  it("records each predictor's call at each minute, a rule only inside its window", () => {
    const d = day(300, (t) => 25_000 + (t < 50 ? -t : t - 100), () => ({ bid: 100, ask: 100.5, ltp: 100.25 }), (t) => ({ sig_flow: t === 30 ? 1 : 0 }));
    const all = calls(d);
    const trend = all.filter((c) => c.predictor === "trend-open");
    assert.deepEqual(trend.find((c) => c.t === 20)?.vote, -1, "below the open: calls down");
    assert.deepEqual(trend.find((c) => c.t === 200)?.vote, 1, "above the open: calls up");
    assert.deepEqual(all.filter((c) => c.predictor === "signal:flow"), [{ predictor: "signal:flow", t: 30, vote: 1 }]);
    assert.ok(all.filter((c) => c.predictor === "flow-fade").every((c) => c.t === 30 && c.vote === -1), "Fade futures order flow calls the other way");
  });
});

describe("the scoreboard", () => {
  const o = (t: number, move: number, call: number | null, put: number | null): Outcome => ({ t, move, call, put });
  const c = (predictor: string, t: number, vote: 1 | -1): Call => ({ predictor, t, vote });
  const days = [
    { date: "2026-11-18", outcomes: [o(1, 10, 300, -500), o(2, -5, -200, 100), o(3, 0, null, null)], calls: [c("signal:flow", 1, 1), c("signal:flow", 2, 1), c("signal:flow", 3, -1), c("trend-hold", 1, 1)] },
    { date: "2026-11-20", outcomes: [o(1, -8, -400, 250)], calls: [c("signal:flow", 1, -1), c("trend-hold", 1, -1)] },
  ];
  const rows = scoreboard(days);
  const row = (id: string) => rows.find((r) => r.id === id)!;

  it("grades each call on direction and on what its option made, against a coin flip at the same minutes", () => {
    const flow = row("signal:flow");
    // Right at minute 1 (up 10) and on the 20th (down 8); wrong at 2; minute 3 didn't move and had no prices.
    assert.deepEqual([flow.calls, flow.right, flow.priced, flow.paid], [4, 2, 3, 2]);
    assert.equal(flow.perCall, Math.round(((300 - 200 + 250) / 3) * 100) / 100);
    assert.equal(flow.coin, Math.round(((-100 + -50 + -75) / 3) * 100) / 100);
    assert.equal(flow.vsCoin, Math.round((flow.perCall! - flow.coin!) * 100) / 100);
    assert.deepEqual([flow.daysCalled, flow.daysAhead], [2, 2]);
    assert.deepEqual(flow.byDay.map((d) => [d.date, d.calls, d.right, d.perCall]), [["2026-11-18", 3, 1, 50], ["2026-11-20", 1, 1, 250]]);
  });

  it("counts a rule only from the day that tests it, and shows the days before", () => {
    const rule = row("trend-hold");
    assert.deepEqual([rule.calls, rule.right, rule.perCall, rule.daysCalled], [1, 1, 250, 1]);
    assert.deepEqual(rule.byDay.map((d) => [d.date, d.tested, d.calls]), [["2026-11-18", false, 1], ["2026-11-20", true, 1]]);
  });

  it("gives the coin flip every priced minute, half a call and half a put", () => {
    const coin = row(COIN);
    assert.deepEqual([coin.calls, coin.priced, coin.vsCoin, coin.daysCalled], [3, 3, null, 0]);
    assert.equal(coin.paid, 1.5, "one side of each minute paid: half of the single random trades");
    assert.equal(coin.perCall, Math.round(((-100 - 50 - 75) / 3) * 100) / 100);
    assert.equal(row("signal:momentum").calls, 0);
  });
});
