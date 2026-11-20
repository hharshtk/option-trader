import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { roundTripCharges } from "../trading/charges.ts";
import { FOLLOWABLE_RULES } from "../engine/trading.ts";
import { CANDIDATES, RANDOM_SCHEDULES, RULES, ruleById, type Rule } from "./rules.ts";
import { movement, scorecard } from "./score.ts";
import { DEFAULT_EXITS, simulateDay, type DayData, type MinuteQuote } from "./simulate.ts";
import type { MinuteState } from "./state.ts";

const OPEN = Date.UTC(2026, 10, 18, 3, 45);

/** A day of `n` minutes with NIFTY at `nifty(t)` and one call and one put at 25,000 priced by `price(t, type)`. */
function day(n: number, nifty: (t: number) => number, price: (t: number, type: "CE" | "PE") => { bid: number | null; ask: number | null; ltp: number }): DayData {
  const states: MinuteState[] = [];
  const quotes: MinuteQuote[][] = [];
  for (let t = 0; t < n; t += 1) {
    states[t] = { t, at: OPEN + t * 60_000, nifty: nifty(t) } as unknown as MinuteState;
    quotes[t] = (["CE", "PE"] as const).map((type) => ({ key: `${type}25000`, strike: 25_000, type, lotSize: 65, ...price(t, type) }));
  }
  return { date: "2026-11-18", states, quotes };
}

const at = (minutes: number[], direction: 1 | -1 = 1): Rule => ({ id: "test", name: "Test", idea: "", decide: (now) => (minutes.includes(now.t) ? direction : null) });
const flat = (bid: number, ask: number, ltp = (bid + ask) / 2) => () => ({ bid, ask, ltp });

describe("simulating a rule over a day", () => {
  it("buys at the ask plus slippage, sells at the bid minus slippage when the hold is up, after charges", () => {
    // The call rises a rupee a minute from 100/100.5.
    const d = day(60, () => 25_000, (t) => ({ bid: 100 + t, ask: 100.5 + t, ltp: 100.25 + t }));
    const { trades } = simulateDay(at([10]), d, { ...DEFAULT_EXITS, holdMinutes: 5, targetPct: 0 });
    assert.equal(trades.length, 1);
    const [trade] = trades;
    assert.equal(trade.buy, 110.55);
    assert.equal(trade.sell, 114.95);
    assert.equal(trade.exit, "hold");
    assert.equal(trade.exitMinute, 15);
    const charges = roundTripCharges(110.55 * 65, 114.95 * 65).total;
    assert.equal(trade.gross, Math.round((114.95 - 110.55) * 65 * 100) / 100);
    assert.equal(trade.net, Math.round(((114.95 - 110.55) * 65 - charges) * 100) / 100);
  });

  it("stops out on the last price, takes a target, and sells on an opposite vote", () => {
    const falling = day(60, () => 25_000, (t) => ({ bid: 100 - 3 * t + 30, ask: 100.5 - 3 * t + 30, ltp: 100.25 - 3 * t + 30 }));
    assert.equal(simulateDay(at([10]), falling).trades[0].exit, "stop");
    const rising = day(60, () => 25_000, (t) => ({ bid: 100 + 5 * (t - 10), ask: 100.5 + 5 * (t - 10), ltp: 100.25 + 5 * (t - 10) }));
    assert.equal(simulateDay(at([10]), rising).trades[0].exit, "target");
    const flip: Rule = { id: "flip", name: "", idea: "", decide: (now) => (now.t === 10 ? 1 : now.t === 13 ? -1 : null) };
    const [first] = simulateDay(flip, day(60, () => 25_000, flat(100, 100.5))).trades;
    assert.deepEqual([first.exit, first.exitMinute], ["opposite", 13]);
  });

  it("holds one position at a time, waits after a sale, keeps to the entry window and squares off at 15:10", () => {
    const d = day(375, () => 25_000, flat(100, 100.5));
    const everyMinute: Rule = { id: "always", name: "", idea: "", decide: () => 1 };
    const { trades } = simulateDay(everyMinute, d, { ...DEFAULT_EXITS, holdMinutes: 3, stopPct: 0, targetPct: 0 });
    // Buy at 10, sell at 13, wait 2, buy at 15, …: one every 5 minutes up to 14:45 (minute 330).
    assert.deepEqual(trades.slice(0, 3).map((t) => [t.entryMinute, t.exitMinute]), [[10, 13], [15, 18], [20, 23]]);
    assert.ok(trades.every((t) => t.entryMinute >= 10 && t.entryMinute <= 330));
    const late = simulateDay(at([330]), d, { ...DEFAULT_EXITS, holdMinutes: 60, stopPct: 0, targetPct: 0 }).trades[0];
    assert.deepEqual([late.exit, late.exitMinute], ["square-off", 355]);
  });

  it("skips what can't be traded: no quote, too wide a spread, too cheap", () => {
    const noQuotes: DayData = { ...day(60, () => 25_000, flat(100, 100.5)), quotes: [] };
    assert.deepEqual(simulateDay(at([10]), noQuotes), { trades: [], skipped: { "no quote": 1 }, priced: false });
    assert.deepEqual(simulateDay(at([10]), day(60, () => 25_000, flat(100, 110))).skipped, { "spread too wide": 1 });
    assert.deepEqual(simulateDay(at([10]), day(60, () => 25_000, flat(3, 3.05))).skipped, { "premium too low": 1 });
    assert.deepEqual(simulateDay(at([10]), day(60, () => 25_500, flat(100, 100.5))).skipped, { "no quote near the money" : 1 });
  });

  it("buys a put on a short vote and falls back to the last price without a book", () => {
    const d = day(60, () => 25_010, (t, type) => (type === "PE" ? { bid: null, ask: null, ltp: 80 } : { bid: 100, ask: 100.5, ltp: 100.2 }));
    const [trade] = simulateDay(at([10], -1), d).trades;
    assert.equal(trade.type, "PE");
    assert.equal(trade.buy, 80.5);
    assert.equal(trade.sell, 79.5);
  });
});

describe("rules and the scorecard", () => {
  it("has the no-signal bar and one rule per Pulse signal, reading the state's votes", () => {
    const random = RULES.find((r) => r.id === "random")!;
    const fires = Array.from({ length: 60 }, (_, t) => random.decide({ t } as MinuteState, [])).filter((v) => v !== null);
    assert.deepEqual(fires, [1, -1, 1, -1]);
    // 30 schedules: each starting minute of 15, call or put first.
    assert.equal(RANDOM_SCHEDULES.length, 30);
    const putFirstAt7 = RANDOM_SCHEDULES.find((r) => r.id === "random:7:put")!;
    assert.deepEqual(Array.from({ length: 40 }, (_, t) => putFirstAt7.decide({ t } as MinuteState, [])).flatMap((v, t) => (v === null ? [] : [[t, v]])), [[7, -1], [22, 1], [37, -1]]);
    const momentum = RULES.find((r) => r.id === "signal:momentum")!;
    assert.equal(momentum.decide({ t: 20, sig_momentum: -1 } as unknown as MinuteState, []), -1);
    assert.equal(momentum.decide({ t: 20, sig_momentum: 0 } as unknown as MinuteState, []), null);
  });

  it("sums each rule's trades by hold, with its worst and best day, counting days it didn't trade", () => {
    const trade = (date: string, rule: string, hold: number, net: number) =>
      ({ date, rule, hold, net, checked: false, exits: "fixed" }) as Parameters<typeof scorecard>[0][number];
    const rows = scorecard(
      [trade("2026-11-17", "signal:flow", 10, -100), trade("2026-11-18", "signal:flow", 10, 50), trade("2026-11-18", "signal:flow", 10, -30)],
      ["2026-11-17", "2026-11-18", "2026-11-19"],
    );
    const flow = rows.find((r) => r.rule === "signal:flow" && r.hold === 10 && !r.checked && r.exits === "fixed")!;
    assert.equal(rows.find((r) => r.rule === "signal:flow" && r.hold === 10 && r.checked && r.exits === "fixed")!.trades, 0, "these were taken without the cost check");
    assert.deepEqual([flow.trades, flow.wins, flow.net, flow.perTrade], [3, 1, -80, -26.67]);
    assert.deepEqual(flow.worstDay, { date: "2026-11-17", net: -100 });
    assert.deepEqual(flow.bestDay, { date: "2026-11-18", net: 20 });
    // No signal averages its 30 schedules: 60 trades of −₹90 across them is 2 trades and −₹180 a day.
    const schedules = RANDOM_SCHEDULES.flatMap((r) => [trade("2026-11-18", r.id, 10, -90), trade("2026-11-18", r.id, 10, -90)]);
    const random = scorecard(schedules, ["2026-11-18"]).find((r) => r.rule === "random" && r.hold === 10 && !r.checked && r.exits === "fixed")!;
    assert.deepEqual([random.trades, random.net, random.perTrade, random.worstDay?.net], [2, -180, -90, -180]);
    const quiet = rows.find((r) => r.rule === "signal:momentum" && r.hold === 10 && !r.checked && r.exits === "fixed")!;
    assert.deepEqual([quiet.trades, quiet.perTrade, quiet.worstDay], [0, null, { date: "2026-11-17", net: 0 }]);
  });
});

describe("step 2: rule exits, caps, windows and the cost check", () => {
  it("uses a rule's own stop and target, keeps to its window and its daily cap", () => {
    const d = day(375, () => 25_000, (t) => ({ bid: 100 + (t % 40), ask: 100.5 + (t % 40), ltp: 100.25 + (t % 40) }));
    const always: Rule = { id: "x", name: "", idea: "", decide: () => 1, exits: { stopPct: 0, targetPct: 25, opposite: false }, maxTrades: 2, window: { from: 50, until: 300 } };
    const { trades } = simulateDay(always, d, { ...DEFAULT_EXITS, holdMinutes: 60 });
    assert.equal(trades.length, 2);
    assert.ok(trades.every((t) => t.entryMinute >= 50 && t.entryMinute <= 300));
    // Bought at 110.55 at minute 50, the 25% target (138.19) is crossed when the last price reaches 138.25: minute 78.
    assert.deepEqual([trades[0].entryMinute, trades[0].buy, trades[0].exit, trades[0].exitMinute], [50, 110.55, "target", 78]);
  });

  it("skips entries that fail the cost check and marks the trades it lets through", () => {
    const quiet = day(60, () => 25_000, flat(100, 100.5));
    for (const s of quiet.states) Object.assign(s!, { opt_forward: 25_000, opt_minutes_to_expiry: 1_300, minute_move: 0.5 });
    assert.deepEqual(simulateDay(at([10]), quiet, DEFAULT_EXITS, { costCheck: true }).skipped, { "cost check": 1 });
    for (const s of quiet.states) Object.assign(s!, { minute_move: 15 });
    const [trade] = simulateDay(at([10]), quiet, DEFAULT_EXITS, { costCheck: true }).trades;
    assert.equal(trade.checked, true);
    assert.equal(simulateDay(at([10]), quiet).trades[0].checked, false);
  });

  it("measures what options priced against what NIFTY delivered", () => {
    const states = Array.from({ length: 30 }, (_, t) => ({ t, nifty: 25_000 + (t % 2) * 10, priced_move: 20 }) as unknown as MinuteState);
    // Over every 10 minutes NIFTY ends where it started or 10 points away, alternately: 5 points on average.
    assert.deepEqual(movement(states), { priced: 20, delivered: 0, minutes: 20 });
    states.forEach((s, t) => Object.assign(s, { nifty: 25_000 + t }));
    assert.deepEqual(movement(states), { priced: 20, delivered: 10, minutes: 20 });
  });
});

describe("the candidates", () => {
  const state = (fields: Partial<Record<string, number | null>>) => ({ t: 100, ...fields }) as unknown as MinuteState;

  it("are the rules the trader can follow, under the same names", () => {
    assert.deepEqual(CANDIDATES.map((r) => [r.id, r.name]), FOLLOWABLE_RULES.map((r) => [r.id, r.name]));
    assert.equal(ruleById("trend"), CANDIDATES[0]);
  });

  it("Trend day needs a big move from the open, breadth and futures flow all agreeing", () => {
    const trend = ruleById("trend")!;
    const up = { nifty: 25_100, nifty_from_open: 80, advancers: 35, decliners: 15, fut_flow_15m: 0.3 };
    assert.equal(trend.decide(state(up), []), 1);
    assert.equal(trend.decide(state({ ...up, nifty_from_open: -80, advancers: 15, decliners: 35, fut_flow_15m: -0.3 }), []), -1);
    assert.equal(trend.decide(state({ ...up, nifty_from_open: 40 }), []), null, "under 0.25% from the open");
    assert.equal(trend.decide(state({ ...up, advancers: 28, decliners: 22 }), []), null, "breadth not clear");
    assert.equal(trend.decide(state({ ...up, fut_flow_15m: -0.2 }), []), null, "futures flow against");
    assert.equal(trend.decide(state({ ...up, fut_flow_15m: null }), []), null, "a day without futures");
  });

  it("Momentum when options are cheap follows momentum only when NIFTY moves at least what the straddle prices", () => {
    const rule = ruleById("cheap-momentum")!;
    assert.equal(rule.decide(state({ sig_momentum: -1, actual_move: 25, priced_move: 20 }), []), -1);
    assert.equal(rule.decide(state({ sig_momentum: -1, actual_move: 15, priced_move: 20 }), []), null);
    assert.equal(rule.decide(state({ sig_momentum: 0, actual_move: 25, priced_move: 20 }), []), null);
  });

  it("Fade at the walls buys a put after a climb to just under the biggest call strike, and a call at the put strike", () => {
    const rule = ruleById("wall-fade")!;
    assert.equal(rule.decide(state({ nifty: 25_480, nifty_points_15m: 45, chain_call_wall: 25_500, chain_put_wall: 25_000 }), []), -1);
    assert.equal(rule.decide(state({ nifty: 25_020, nifty_points_15m: -45, chain_call_wall: 25_500, chain_put_wall: 25_000 }), []), 1);
    assert.equal(rule.decide(state({ nifty: 25_480, nifty_points_15m: 10, chain_call_wall: 25_500 }), []), null, "no climb");
    assert.equal(rule.decide(state({ nifty: 25_300, nifty_points_15m: 45, chain_call_wall: 25_500 }), []), null, "too far from the wall");
    assert.equal(rule.decide(state({ nifty: 25_480, nifty_points_15m: 45, chain_call_wall: null, opt_call_wall: 25_500 }), []), -1, "the journal's window without a chain");
  });
});

describe("volatility exits in the lab", () => {
  it("sets each trade's stop and target from NIFTY's typical move at entry, the target twice the stop", () => {
    const d = day(60, () => 25_000, flat(100, 100.5));
    for (const st of d.states) Object.assign(st!, { opt_forward: 25_000, opt_minutes_to_expiry: 1_300, minute_move: 6 });
    const [trade] = simulateDay(at([10]), d, { ...DEFAULT_EXITS, from: "volatility", holdMinutes: 10 }).trades;
    assert.equal(trade.exits, "volatility");
    // About 19 points of NIFTY in 10 minutes, about 9.5 rupees on a 100-rupee at-the-money option.
    assert.ok(trade.stopPct > 7 && trade.stopPct < 12, `stop ${trade.stopPct}%`);
    assert.ok(Math.abs(trade.targetPct / trade.stopPct - 2) < 0.01);
    // A candidate keeps its own ratio: Trend day's 15% and 45% make the target three stops.
    const ratio: Rule = { ...at([10]), exits: { stopPct: 15, targetPct: 45 } };
    const [wide] = simulateDay(ratio, d, { ...DEFAULT_EXITS, from: "volatility", holdMinutes: 10 }).trades;
    assert.ok(Math.abs(wide.targetPct / wide.stopPct - 3) < 0.01);
    // With recent days stored, their typical move at this time of day sets the levels: 30 points over 10 minutes here,
    // against today's formula of 6 × √10 ≈ 19, so the stop is further away.
    const dates = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    const profiled: DayData = { ...d, profile: { dates, closes: dates.map(() => Array.from({ length: 360 }, (_, t) => 25_000 + 3 * t)) } };
    const [measured] = simulateDay(at([10]), profiled, { ...DEFAULT_EXITS, from: "volatility", holdMinutes: 10 }).trades;
    assert.ok(measured.stopPct > trade.stopPct, `${measured.stopPct}% against ${trade.stopPct}%`);
    // Without the market's movement the fixed percents stand in.
    for (const st of d.states) Object.assign(st!, { minute_move: null });
    const [fallback] = simulateDay(at([10]), d, { ...DEFAULT_EXITS, from: "volatility" }).trades;
    assert.deepEqual([fallback.stopPct, fallback.targetPct], [20, 30]);
  });
});

describe("exits inside a minute", () => {
  it("sells a stop crossed inside a minute near its level, not at the minute's close", () => {
    // Flat at 100/100.5, except minute 13 dips to 75 inside the minute and closes back at 100.
    const d = day(60, () => 25_000, (t) => ({ bid: 100, ask: 100.5, ltp: 100.25, low: t === 13 ? 75 : 100.25, high: 100.25 }) as { bid: number; ask: number; ltp: number });
    const [trade] = simulateDay(at([10]), d, { ...DEFAULT_EXITS, holdMinutes: 30 }).trades;
    // Bought at 100.55; the 20% stop is 80.44: sold less half the spread (0.25) and slippage (0.05), rounded down.
    assert.deepEqual([trade.exit, trade.exitMinute, trade.sell], ["stop", 13, 80.1]);
  });

  it("takes the stop first when a minute crossed both, and uses the close when there is no range", () => {
    const both = day(60, () => 25_000, (t) => ({ bid: 100, ask: 100.5, ltp: 100.25, low: t === 13 ? 70 : 100.25, high: t === 13 ? 140 : 100.25 }) as { bid: number; ask: number; ltp: number });
    assert.equal(simulateDay(at([10]), both, { ...DEFAULT_EXITS, holdMinutes: 30 }).trades[0].exit, "stop");
    const noRange = day(60, () => 25_000, (t) => ({ bid: t >= 13 ? 75 : 100, ask: t >= 13 ? 75.5 : 100.5, ltp: t >= 13 ? 75.25 : 100.25 }));
    const [trade] = simulateDay(at([10]), noRange, { ...DEFAULT_EXITS, holdMinutes: 30 }).trades;
    assert.deepEqual([trade.exit, trade.sell], ["stop", 74.95]);
  });
});

describe("trailing stops and holding to the close", () => {
  it("trails the stop up behind the best price, with no target, and says it was the trailing stop", () => {
    // Bought at 100.55 at minute 10; rises 2 a minute to minute 30 (last price 140.25), then falls 2 a minute.
    const path = (t: number) => (t <= 30 ? 100 + 2 * Math.max(0, t - 10) : 140 - 2 * (t - 30));
    const d = day(120, () => 25_000, (t) => ({ bid: path(t), ask: path(t) + 0.5, ltp: path(t) + 0.25 }));
    const [trade] = simulateDay(at([10]), d, { ...DEFAULT_EXITS, from: "trailing", holdMinutes: 60 }).trades;
    assert.equal(trade.exits, "trailing");
    assert.equal(trade.targetPct, 0, "no target: the fixed 30% target would have sold at 130.72");
    // Best last price 140.25 makes the stop 112.20; the close falls through it at minute 45 (110.25).
    assert.equal(trade.exit, "trail");
    assert.equal(trade.exitMinute, 45);
    assert.ok(trade.net > 0, `kept most of the run: ${trade.net}`);
    // Without the run, the trailing stop is the plain stop.
    const falling = day(60, () => 25_000, (t) => ({ bid: 100 - 3 * Math.max(0, t - 10), ask: 100.5 - 3 * Math.max(0, t - 10), ltp: 100.25 - 3 * Math.max(0, t - 10) }));
    assert.equal(simulateDay(at([10]), falling, { ...DEFAULT_EXITS, from: "trailing", holdMinutes: 60 }).trades[0].exit, "stop");
  });

  it("a rule's own hold keeps the trade until 15:10, filed under the hold being scored", () => {
    const d = day(375, () => 25_000, flat(100, 100.5));
    const held: Rule = { ...at([100]), exits: { stopPct: 25, trail: true, opposite: false, holdMinutes: 360 } };
    const [trade] = simulateDay(held, d, { ...DEFAULT_EXITS, holdMinutes: 10 }).trades;
    assert.deepEqual([trade.exit, trade.exitMinute, trade.hold, trade.targetPct], ["square-off", 355, 10, 0]);
  });
});

describe("the candidates written on 19 November", () => {
  const state = (t: number, fields: Partial<Record<string, number | null>>) => ({ t, ...fields }) as unknown as MinuteState;

  it("are tested only from 20 November; the earlier ones from 19 November", () => {
    assert.deepEqual(CANDIDATES.map((r) => [r.id, r.since]), [
      ["trend", "2026-11-19"],
      ["cheap-momentum", "2026-11-19"],
      ["wall-fade", "2026-11-19"],
      ["trend-hold", "2026-11-20"],
      ["breadth-buildup", "2026-11-20"],
      ["flow-fade", "2026-11-20"],
    ]);
  });

  it("Trend day, held enters as Trend day does, from 10:00 to 13:00, and keeps the trade with a trailing stop", () => {
    const rule = ruleById("trend-hold")!;
    const up = { nifty: 25_100, nifty_from_open: 80, advancers: 35, decliners: 15, fut_flow_15m: 0.3 };
    assert.equal(rule.decide(state(100, up), []), ruleById("trend")!.decide(state(100, up), []));
    assert.deepEqual(rule.window, { from: 45, until: 225 });
    assert.deepEqual(rule.exits, { stopPct: 25, trail: true, opposite: false, holdMinutes: 360 });
  });

  it("Breadth and OI build-up agree needs both on one side within 15 minutes, neither against, one of them now", () => {
    const rule = ruleById("breadth-buildup")!;
    const quiet = (t: number) => state(t, { sig_breadth: 0, sig_buildup: 0 });
    const before = [quiet(90), state(91, { sig_breadth: 0, sig_buildup: 1 }), ...Array.from({ length: 8 }, (_, i) => quiet(92 + i))];
    assert.equal(rule.decide(state(100, { sig_breadth: 1, sig_buildup: 0 }), before), 1);
    assert.equal(rule.decide(state(100, { sig_breadth: 0, sig_buildup: 0 }), before), null, "neither votes now");
    assert.equal(rule.decide(state(100, { sig_breadth: 1, sig_buildup: -1 }), before), null, "build-up turned the other way");
    const old = [state(80, { sig_breadth: 0, sig_buildup: 1 }), ...Array.from({ length: 19 }, (_, i) => quiet(81 + i))];
    assert.equal(rule.decide(state(100, { sig_breadth: 1, sig_buildup: 0 }), old), null, "build-up's vote is over 15 minutes old");
    const down = [state(95, { sig_breadth: -1, sig_buildup: 0 })];
    assert.equal(rule.decide(state(100, { sig_breadth: 0, sig_buildup: -1 }), down), -1);
  });

  it("Fade futures order flow buys the other way", () => {
    const rule = ruleById("flow-fade")!;
    assert.equal(rule.decide(state(100, { sig_flow: 1 }), []), -1);
    assert.equal(rule.decide(state(100, { sig_flow: -1 }), []), 1);
    assert.equal(rule.decide(state(100, { sig_flow: 0 }), []), null);
  });
});

describe("the scorecard against random trades on the same side", () => {
  const trade = (date: string, rule: string, type: "CE" | "PE", net: number) =>
    ({ date, rule, hold: 10, net, type, checked: false, exits: "fixed" }) as Parameters<typeof scorecard>[0][number];
  // On 18 Nov random calls made ₹300 a trade and random puts lost ₹500; on 19 Nov the other way.
  const randomDay = (date: string, call: number, put: number) => RANDOM_SCHEDULES.flatMap((r) => [trade(date, r.id, "CE", call), trade(date, r.id, "PE", put)]);
  const random = [...randomDay("2026-11-18", 300, -500), ...randomDay("2026-11-19", -500, 300)];
  const row = (rows: ReturnType<typeof scorecard>, rule: string) => rows.find((r) => r.rule === rule && r.hold === 10 && !r.checked && r.exits === "fixed")!;

  it("compares calls with random calls and puts with random puts, day by day", () => {
    // Flow bought calls on 18 Nov (₹250 each, under the ₹300 random calls made) and a put on 19 Nov (₹400 against ₹300).
    const rows = scorecard([...random, trade("2026-11-18", "signal:flow", "CE", 250), trade("2026-11-18", "signal:flow", "CE", 250), trade("2026-11-19", "signal:flow", "PE", 400)], ["2026-11-18", "2026-11-19"]);
    const flow = row(rows, "signal:flow");
    assert.equal(flow.vsSameSide, Math.round(((250 - 300) * 2 + (400 - 300)) / 3 * 100) / 100);
    assert.deepEqual(flow.byDay, [
      { date: "2026-11-18", tested: true, trades: 2, net: 500, bar: 600 },
      { date: "2026-11-19", tested: true, trades: 1, net: 400, bar: 300 },
    ]);
    assert.deepEqual([flow.daysTraded, flow.daysAhead], [2, 1]);
    assert.equal(row(rows, "random").vsSameSide, null);
  });

  it("counts a candidate's figures only from the day that tests it, and still shows the days before", () => {
    const rows = scorecard([...random, trade("2026-11-18", "trend", "CE", 900), trade("2026-11-19", "trend", "CE", -200)], ["2026-11-18", "2026-11-19"]);
    const trend = row(rows, "trend");
    assert.deepEqual([trend.days, trend.trades, trend.net, trend.vsSameSide, trend.daysTraded, trend.daysAhead], [1, 1, -200, 300, 1, 1]);
    assert.deepEqual(trend.byDay.map((d) => [d.date, d.tested, d.net]), [["2026-11-18", false, 900], ["2026-11-19", true, -200]]);
    assert.deepEqual(trend.worstDay, { date: "2026-11-19", net: -200 });
  });
});
