import assert from "node:assert/strict";
import { test } from "node:test";
import { OPTION_RATES, planTrades, roundTripCharges, simulateTrades, type OptionChoices } from "./option-trades.ts";

const M = 60_000;
const T0 = Date.UTC(2026, 10, 16, 5, 0);
const strikes: OptionChoices["strikes"] = [25100, 25150, 25200, 25250, 25300].map((strike) => ({
  strike,
  CE: { securityId: `C${strike}`, name: `${strike} CALL` },
  PE: { securityId: `P${strike}`, name: `${strike} PUT` },
}));
const spotAt = (at: number) => (at === T0 ? 25210 : at === T0 + 5 * M ? 25230 : null);
const long = { at: T0, vote: 1 as const, outcome: 20 };
const short = { at: T0, vote: -1 as const, outcome: 20 };

test("strikes follow the money: OTM is above spot for calls and below for puts", () => {
  const [ce] = planTrades([long], spotAt, strikes, { kind: "relative", offset: 1 }, "both");
  const [pe] = planTrades([short], spotAt, strikes, { kind: "relative", offset: 1 }, "both");
  assert.deepEqual([ce.type, ce.strike], ["CE", 25250]);
  assert.deepEqual([pe.type, pe.strike], ["PE", 25150]);
  const [atm] = planTrades([long], spotAt, strikes, { kind: "relative", offset: 0 }, "both");
  assert.equal(atm.strike, 25200);
});

test("a side filter drops the other direction; a fixed strike stays fixed", () => {
  assert.equal(planTrades([long, short], spotAt, strikes, { kind: "relative", offset: 0 }, "calls").length, 1);
  const [fixed] = planTrades([short], spotAt, strikes, { kind: "fixed", strike: 25300 }, "puts");
  assert.equal(fixed.leg?.securityId, "P25300");
});

test("a trade buys at the firing minute's close and sells at the close a horizon later, after slippage and charges", () => {
  const planned = planTrades([long], spotAt, strikes, { kind: "relative", offset: 0 }, "both");
  const candles = { C25200: { t: [T0, T0 + 2 * M, T0 + 5 * M], o: [0, 0, 0], c: [100, 104, 110], v: [1, 1, 1] } };
  const [trade] = simulateTrades(planned, candles, { horizon: 5, qty: 65, slippage: 0.5, spotAt });
  assert.equal(trade.skipped, null);
  assert.deepEqual([trade.entry, trade.exit], [100, 110]);
  assert.equal(trade.gross, (109.5 - 100.5) * 65);
  assert.ok(Math.abs(trade.charges - roundTripCharges(100.5 * 65, 109.5 * 65, OPTION_RATES)) < 1e-9);
  assert.equal(trade.ratio, 0.5);
});

test("a trade waits until Dhan has the exit minute's candle", () => {
  const planned = planTrades([long], spotAt, strikes, { kind: "relative", offset: 0 }, "both");
  const candles = { C25200: { t: [T0, T0 + 2 * M], o: [0, 0], c: [100, 104], v: [1, 1] } };
  const [trade] = simulateTrades(planned, candles, { horizon: 5, qty: 65, slippage: 0, spotAt });
  assert.match(trade.skipped ?? "", /Waiting/);
  assert.equal(trade.net, 0);
});

test("round-trip charges include brokerage on both orders and STT on the sell side only", () => {
  const zero = roundTripCharges(0, 0, OPTION_RATES);
  assert.ok(Math.abs(zero - 40 * 1.18) < 1e-9);
  assert.ok(roundTripCharges(0, 10_000, OPTION_RATES) - roundTripCharges(10_000, 0, OPTION_RATES) > 0);
});
