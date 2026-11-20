// The trader end to end on fakes: frames in, paper trades out. No network: the decision API,
// contracts and candles are injected, and the tables go to a temporary folder.

import assert from "node:assert/strict";
import type { MoveProfile } from "../../lib/trading/moves.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getParquetStore } from "../../lib/db/parquet-store.ts";
import type { JournalSession, SessionInstrument } from "../../lib/engine/protocol.ts";
import type { TradingConfig, TradingUpdate } from "../../lib/engine/trading.ts";
import { paise, roundTripCharges } from "../../lib/trading/charges.ts";
import { exitLevels } from "../../lib/trading/exits.ts";
import { createSessionCalendar } from "../market/session-calendar.ts";
import type { Logger } from "../telemetry/logger.ts";
import { buildContractBook } from "./contracts.ts";
import type { DecisionAnswer, DecisionProvider } from "./decision.ts";
import { createTradingStore } from "./store.ts";
import { createTrader, type Candle, type ReplayPosition, type Trader } from "./trader.ts";

const DATE = "2026-11-16";
const OPEN = Date.UTC(2026, 10, 16, 3, 45); // 09:15 IST
const MIN = 60_000;
const LOT = 65;
const CALL_25900 = 1259000;

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

/** Strikes 25700 to 26100; a call's id is 1_000_000 + strike × 10, a put's 2_000_000 + strike × 10. */
function contracts() {
  const rows = [];
  for (let strike = 25700; strike <= 26100; strike += 50) {
    for (const [type, base] of [["CE", 1_000_000], ["PE", 2_000_000]] as const) {
      rows.push({ security_id: String(base + strike * 10), name: `NIFTY 17 NOV ${strike} ${type === "CE" ? "CALL" : "PUT"}`, strike, option_type: type, expiry: "2026-11-17", lot_size: LOT, tick_size: 0.05, file_date: DATE });
    }
  }
  return buildContractBook(rows, DATE, DATE)!;
}

/** NIFTY rising 0.02% a minute: the 15-minute momentum signal votes long from the 16th minute on. */
function session(minutes: number, perMinute = 0.0002): JournalSession {
  const closes = Array.from({ length: minutes }, (_, t) => 25_900 * (1 + perMinute * t));
  const index: SessionInstrument = {
    key: "IDX_I:13",
    symbol: "NIFTY",
    name: null,
    sector: "Index",
    mode: "ticker",
    packets: minutes,
    reference: 25_880,
    ltp: closes.at(-1)!,
    open: closes[0],
    high: Math.max(...closes),
    low: Math.min(...closes),
    vwap: null,
    volume: null,
    buyQty: null,
    sellQty: null,
    firstAt: OPEN,
    lastAt: OPEN + minutes * MIN,
    closes,
  };
  return {
    date: DATE,
    session: { open: OPEN, close: OPEN + 375 * MIN },
    builtAt: OPEN + minutes * MIN,
    readMs: 1,
    file: { bytes: 0, records: 0, frames: 0, controls: 0, packets: {}, events: {}, firstFrameAt: OPEN, lastFrameAt: OPEN + minutes * MIN },
    runs: [],
    gaps: [],
    states: [],
    benchmark: "IDX_I:13",
    minutes: closes.map((v, t) => ({ at: OPEN + t * MIN, frames: 1, packets: 1, bar: [v, v, v, v], advancers: 25, decliners: 25 })),
    instruments: [index],
  };
}

function header(view: DataView, code: number, length: number, segment: number, securityId: number) {
  view.setUint8(0, code);
  view.setInt16(1, length, true);
  view.setUint8(3, segment);
  view.setInt32(4, securityId, true);
}

function niftyTick(ltp: number) {
  const view = new DataView(new ArrayBuffer(16));
  header(view, 2, 16, 0, 13);
  view.setFloat32(8, ltp, true);
  return view.buffer;
}

/** A Full packet for an NSE_FNO contract with one level of depth. */
function optionQuote(securityId: number, ltp: number, bid: number, ask: number) {
  const view = new DataView(new ArrayBuffer(162));
  header(view, 8, 162, 2, securityId);
  view.setFloat32(8, ltp, true);
  view.setInt32(62, 650, true);
  view.setInt32(66, 650, true);
  view.setFloat32(74, bid, true);
  view.setFloat32(78, ask, true);
  return view.buffer;
}

interface Harness {
  trader: Trader;
  /** Sets the wall clock (the market's clock when live) and runs a tick. */
  tickAt(time: number): Promise<void>;
  feed(frame: ArrayBuffer, at: number): void;
  acquired: string[];
  asked: unknown[];
  published: TradingUpdate[];
  state: { session: JournalSession | null; replay: ReplayPosition | null; answer: DecisionAnswer | Error; candles: Candle[] };
  restart(): Harness;
  close(): Promise<void>;
}

async function harness(config: { strategy?: object; decision?: object; risk?: object } = {}, extras: { moveProfile?: MoveProfile | null } = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "trader-test-"));
  const book = contracts();

  function build(): Harness {
    let wall = OPEN - 10 * MIN;
    const state: Harness["state"] = {
      session: null,
      replay: null,
      answer: { probability: 0.9, regime: "trend_up", regimeProbabilities: null, quality: 0.8, model: "fake", inputTokens: 100, cost: 0 },
      candles: [],
    };
    const acquired: string[] = [];
    const asked: unknown[] = [];
    const published: TradingUpdate[] = [];
    const fake: DecisionProvider = {
      ready: true,
      async ask({ state: context }) {
        asked.push(context);
        if (state.answer instanceof Error) throw state.answer;
        return state.answer;
      },
    };
    const decisions = { openrouter: fake, liquid: fake };
    const trader = createTrader({
      namespace: "test",
      directory: path.join(root, "trading"),
      version: "test",
      calendar: createSessionCalendar(),
      log: quiet,
      health: { set() {} },
      now: () => wall,
      store: createTradingStore(getParquetStore(path.join(root, "store")), "test"),
      hub: () => ({ acquire: (instruments) => void acquired.push(...instruments.map((i) => `${i.segment}:${i.securityId}`)), release() {} }),
      replay: () => state.replay,
      hold: () => () => {},
      session: async () => state.session,
      decisions,
      loadContracts: async () => ({ book, problem: null }),
      loadCandles: async () => {
        if (state.candles.length === 0) throw new Error("no candles");
        return state.candles;
      },
      publish: (update) => void published.push(update),
      ...(extras.moveProfile !== undefined ? { loadMoveProfile: async () => extras.moveProfile! } : {}),
    });
    return {
      trader,
      async tickAt(time) {
        wall = time;
        if (state.replay) state.replay = { ...state.replay, at: time };
        trader.tick();
        await trader.idle();
      },
      feed: (frame, at) => trader.onFrame(frame, at),
      acquired,
      asked,
      published,
      state,
      restart: build,
      close: () => rm(root, { recursive: true, force: true }),
    };
  }

  const first = build();
  await first.trader.start();
  // Fixed percent exits unless a test asks for volatility exits: most tests check order mechanics at known levels.
  const patch = { ...config, strategy: { signal: "momentum", exitsFrom: "fixed", ...config.strategy }, decision: { mode: "off", ...config.decision } };
  const merged = await first.trader.command({ action: "config", patch });
  assert.ok(merged.ok, merged.message);
  await first.trader.command({ action: "arm" });
  return first;
}

/** Brings the run to the close of the 17th minute, where momentum has just voted long, with the 25900 call quoted. */
async function toSignal(h: Harness, quote: { ltp: number; bid: number; ask: number } | null = { ltp: 100.05, bid: 100, ask: 100.1 }) {
  await h.tickAt(OPEN - 10 * MIN);
  h.state.session = session(18);
  const at = OPEN + 17 * MIN + 2_000;
  h.feed(niftyTick(25_905), at - 500);
  if (quote) h.feed(optionQuote(CALL_25900, quote.ltp, quote.bid, quote.ask), at - 400);
  h.feed(niftyTick(25_905), at);
  await h.trader.idle();
  return at;
}

test("a signal buys the at-the-money call on the book, and a target sells it, with Dhan's charges", async () => {
  const h = await harness();
  try {
    const at = await toSignal(h);
    let status = h.trader.status();
    assert.equal(status.run?.id, `live-${DATE}`);
    assert.equal(status.signal?.vote, 1);
    assert.deepEqual(status.intents.map((i) => [i.outcome, i.contract?.name]), [["taken", "NIFTY 17 NOV 25900 CALL"]]);
    assert.ok(h.acquired.includes(`NSE_FNO:${CALL_25900}`), "the option window is subscribed");
    assert.equal(status.positions.length, 0, "not filled until the latency has passed");

    // 300 ms later the buy fills at the ask plus slippage.
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    status = h.trader.status();
    assert.equal(status.positions.length, 1);
    const position = status.positions[0];
    assert.equal(position.entryPrice, 100.15);
    assert.equal(position.entrySource, "book");
    assert.equal(position.quantity, LOT);
    assert.ok(Math.abs(position.targetPrice! - 100.15 * 1.3) < 1e-9);

    // The premium reaches the target; the sell fills at the bid less slippage.
    h.feed(optionQuote(CALL_25900, 131, 130.9, 131.1), at + 60_000);
    h.feed(optionQuote(CALL_25900, 131, 130.9, 131.1), at + 60_400);
    status = h.trader.status();
    assert.equal(status.positions.length, 0);
    const [trade] = status.trades;
    assert.deepEqual([trade.exitReason, trade.exitPrice, trade.exitSource], ["target", 130.85, "book"]);
    const charges = roundTripCharges(100.15 * LOT, 130.85 * LOT).total;
    assert.ok(Math.abs(trade.gross - (130.85 - 100.15) * LOT) < 1e-9);
    assert.ok(Math.abs(trade.charges.total - charges) < 1e-9);
    assert.ok(Math.abs(trade.net - (trade.gross - charges)) < 1e-9);
    assert.equal(status.totals.paper.trades, 1);
    assert.equal(status.totals.paper.wins, 1);

    // Stopping saves the run's tables; they read back from Parquet.
    await h.trader.stop();
    const history = await h.trader.history(`live-${DATE}`);
    assert.equal(history.runs.length, 1);
    assert.equal(history.runs[0].net, paise(trade.net));
    assert.equal(history.trades.length, 1);
    assert.equal(history.trades[0].charges, paise(charges));
    assert.equal(history.trades[0].contract, "NIFTY 17 NOV 25900 CALL");
  } finally {
    await h.close();
  }
});

test("scalping: rupee exits trigger on the bid and net the target after charges", async () => {
  const h = await harness({ strategy: { exitIn: "rupees", targetNet: 250, stopNet: 200, scalpHoldMinutes: 3 }, risk: { scalpCooldownMinutes: 0 } });
  try {
    const at = await toSignal(h);
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    let status = h.trader.status();
    const [position] = status.positions;
    assert.equal(position.entryPrice, 100.15);
    assert.equal(position.exitIn, "rupees");
    const expected = exitLevels({ exitIn: "rupees", stopLossPct: 0, targetPct: 0, targetNet: 250, stopNet: 200 }, 100.15, LOT, 0.05, 0.05);
    assert.deepEqual([position.stopPrice, position.targetPrice], [expected.stopPrice, expected.targetPrice]);
    assert.ok(position.targetPrice! < 100.15 * 1.3, "far nearer than the 30% target");

    // The last trade reaches the target but the bid doesn't: nothing is sold yet.
    const target = position.targetPrice!;
    h.feed(optionQuote(CALL_25900, target + 0.1, target - 0.2, target + 0.2), at + 20_000);
    assert.equal(h.trader.status().positions[0].status, "open");

    // The bid reaches it: sold at the bid less slippage, netting at least ₹250 after charges.
    h.feed(optionQuote(CALL_25900, target + 0.1, target, target + 0.2), at + 30_000);
    h.feed(optionQuote(CALL_25900, target + 0.1, target, target + 0.2), at + 30_400);
    status = h.trader.status();
    assert.equal(status.positions.length, 0);
    const [trade] = status.trades;
    assert.equal(trade.exitReason, "target");
    assert.ok(trade.net >= 250 && trade.net < 250 + LOT * 0.05 + 1, `net ${trade.net}`);
  } finally {
    await h.close();
  }
});

test("nothing is proposed while entries are off", async () => {
  const h = await harness();
  try {
    await h.trader.command({ action: "disarm" });
    await toSignal(h);
    const status = h.trader.status();
    assert.equal(status.state, "disarmed");
    assert.equal(status.signal?.vote, 1, "signals are still read");
    assert.equal(status.intents.length, 0);
  } finally {
    await h.close();
  }
});

test("the decision gate turns a trade down, and the shadow book follows what it would have made", async () => {
  const h = await harness({ decision: { mode: "gate", minProbability: 0.55 } });
  try {
    h.state.answer = { probability: 0.3, regime: "range", regimeProbabilities: null, quality: 0.2, model: "fake", inputTokens: 100, cost: 0 };
    const at = await toSignal(h);
    let status = h.trader.status();
    assert.equal(h.asked.length, 1);
    assert.equal((h.asked[0] as { proposal: { contract: string } }).proposal.contract, "NIFTY 17 NOV 25900 CALL");
    assert.deepEqual(status.intents.map((i) => i.outcome), ["shadowed"]);
    assert.equal(status.decisions[0].approved, false);
    assert.match(status.decisions[0].reason, /0\.30 is below 0\.55/);
    // The page can read back exactly what was sent with that answer.
    const sent = h.trader.decisionRequest(status.decisions[0].id);
    assert.deepEqual(sent?.state, h.asked[0]);
    assert.deepEqual(Object.keys(sent?.questions ?? {}), ["take_trade", "regime", "quality"]);
    assert.equal(h.trader.decisionRequest("d-missing"), null);

    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    status = h.trader.status();
    assert.deepEqual(status.positions.map((p) => p.book), ["shadow"]);

    // The same signal a minute later isn't asked about again while its shadow trade runs.
    h.state.session = session(19);
    h.feed(niftyTick(25_905), at + MIN);
    await h.trader.idle();
    assert.equal(h.asked.length, 1);

    // The premium falls through the stop: the gate was right, and the paper book lost nothing.
    h.feed(optionQuote(CALL_25900, 79, 78.9, 79.1), at + 2 * MIN);
    h.feed(optionQuote(CALL_25900, 79, 78.9, 79.1), at + 2 * MIN + 400);
    status = h.trader.status();
    assert.equal(status.totals.paper.trades, 0);
    assert.equal(status.totals.shadow.trades, 1);
    assert.ok(status.totals.shadow.net < 0);
    assert.equal(status.decisionScore.vetoed, 1);
    assert.equal(status.decisionScore.vetoedTrades, 1);
    assert.ok(status.decisionScore.vetoedNet < 0);
  } finally {
    await h.close();
  }
});

test("an approved trade goes to the paper book; a decision that fails skips the entry", async () => {
  const approved = await harness({ decision: { mode: "gate" } });
  try {
    const at = await toSignal(approved);
    approved.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    const status = approved.trader.status();
    assert.deepEqual(status.positions.map((p) => p.book), ["paper"]);
    assert.equal(status.decisions[0].approved, true);
  } finally {
    await approved.close();
  }

  const failing = await harness({ decision: { mode: "gate", onError: "skip" } });
  try {
    failing.state.answer = new Error("timed out");
    await toSignal(failing);
    const status = failing.trader.status();
    assert.deepEqual(status.intents.map((i) => i.outcome), ["rejected"]);
    assert.match(status.intents[0].reason ?? "", /No decision: timed out/);
    assert.equal(status.positions.length, 0);
  } finally {
    await failing.close();
  }
});

test("entries are refused on a stale quote, a wide spread or too little premium", async () => {
  for (const [quote, config, reason] of [
    [null, {}, /No quote/],
    [{ ltp: 100, bid: 95, ask: 105 }, {}, /Spread 10\.0%/],
    [{ ltp: 3, bid: 2.95, ask: 3 }, {}, /below the minimum/],
    [{ ltp: 500, bid: 499.9, ask: 500.1 }, { risk: { maxPremiumPerTrade: 20_000 } }, /above the limit/],
  ] as const) {
    const h = await harness(config);
    try {
      await toSignal(h, quote);
      const [intent] = h.trader.status().intents;
      assert.equal(intent.outcome, "rejected");
      assert.match(intent.reason ?? "", reason);
    } finally {
      await h.close();
    }
  }
});

test("the daily loss limit stops the day and blocks the next signal", async () => {
  const h = await harness({ risk: { maxDailyLoss: 500, cooldownMinutes: 0 } });
  try {
    const at = await toSignal(h);
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    // Stop loss: 20% below 100.15.
    h.feed(optionQuote(CALL_25900, 79, 78.9, 79.1), at + 30_000);
    h.feed(optionQuote(CALL_25900, 79, 78.9, 79.1), at + 30_400);
    let status = h.trader.status();
    assert.equal(status.trades[0].exitReason, "stop");
    assert.ok(status.totals.paper.net < -500);
    assert.equal(status.state, "halted");
    assert.match(status.halt?.reason ?? "", /Daily loss limit/);

    h.state.session = session(20);
    h.feed(niftyTick(25_905), at + 2 * MIN);
    await h.trader.idle();
    assert.equal(h.trader.status().intents.length, 1, "no new proposal while halted");

    // Resuming lifts the stop.
    assert.ok((await h.trader.command({ action: "resume" })).ok);
    status = h.trader.status();
    assert.equal(status.halt, null);
  } finally {
    await h.close();
  }
});

test("a position is sold when its hold time runs out and at the square-off time", async () => {
  const h = await harness({ strategy: { holdMinutes: 3, stopLossPct: 0, targetPct: 0 } });
  try {
    const at = await toSignal(h);
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    h.feed(optionQuote(CALL_25900, 104, 103.9, 104.1), at + 3 * MIN + 500);
    h.feed(optionQuote(CALL_25900, 104, 103.9, 104.1), at + 3 * MIN + 900);
    const [trade] = h.trader.status().trades;
    assert.deepEqual([trade.exitReason, trade.exitPrice], ["time", 103.85]);
  } finally {
    await h.close();
  }
});

test("with two positions allowed, a signal that stays on buys again after the cooldown, then waits for room", async () => {
  const h = await harness({ strategy: { holdMinutes: 60, stopLossPct: 0, targetPct: 0, exitOnOpposite: false }, risk: { maxOpenPositions: 2, cooldownMinutes: 2 } });
  try {
    const at = await toSignal(h);
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    const minute = async (m: number) => {
      h.state.session = session(m + 1);
      const t = OPEN + m * MIN + 2_000;
      h.feed(niftyTick(25_905), t - 500);
      h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), t - 400);
      h.feed(niftyTick(25_905), t);
      await h.trader.idle();
      h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), t + 400);
    };
    await minute(18); // inside the 2 minutes after the first buy
    assert.equal(h.trader.status().positions.length, 1);
    await minute(19);
    assert.equal(h.trader.status().positions.length, 2, "a second position opens alongside the first");
    await minute(22);
    const status = h.trader.status();
    assert.equal(status.positions.length, 2, "no third position");
    assert.equal(status.intents.filter((i) => i.outcome === "taken").length, 2);
    assert.match(status.note, /Holding 2 positions/);
  } finally {
    await h.close();
  }
});

test("selling one position by hand leaves the others open", async () => {
  const h = await harness({ strategy: { holdMinutes: 60, stopLossPct: 0, targetPct: 0, exitOnOpposite: false }, risk: { maxOpenPositions: 2, cooldownMinutes: 1 } });
  try {
    const at = await toSignal(h);
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    h.state.session = session(19);
    const t = OPEN + 18 * MIN + 2_000;
    h.feed(niftyTick(25_905), t - 500);
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), t - 400);
    h.feed(niftyTick(25_905), t);
    await h.trader.idle();
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), t + 400);
    const [first, second] = h.trader.status().positions;
    assert.ok(first && second, "two positions open");

    assert.equal((await h.trader.command({ action: "sell", positionId: "p999" })).ok, false, "an unknown position is refused");
    const sold = await h.trader.command({ action: "sell", positionId: first.id });
    assert.ok(sold.ok, sold.message);
    assert.match((await h.trader.command({ action: "sell", positionId: first.id })).message, /already being sold/);

    // The premium has risen; the sale fills at the bid less slippage after the latency.
    h.feed(optionQuote(CALL_25900, 120, 119.9, 120.1), t + 1_000);
    const status = h.trader.status();
    assert.deepEqual(status.positions.map((p) => p.id), [second.id], "the other position stays open");
    assert.equal(status.trades.length, 1);
    assert.equal(status.trades[0].id, first.id, "a trade keeps its position's id");
    assert.deepEqual([status.trades[0].exitReason, status.trades[0].exitPrice], ["manual", 119.85]);
    assert.ok(status.trades[0].net > 0);
  } finally {
    await h.close();
  }
});

test("a trailing stop follows the best price up, replaces the target, and sells as a trailing stop", async () => {
  const h = await harness({ strategy: { holdMinutes: 120, stopLossPct: 20, targetPct: 30, trailStop: true, exitOnOpposite: false } });
  try {
    const at = await toSignal(h);
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    let [position] = h.trader.status().positions;
    assert.equal(position.entryPrice, 100.15);
    assert.equal(position.targetPrice, null, "no target with a trailing stop");
    assert.ok(Math.abs(position.stopPrice! - 100.15 * 0.8) < 1e-9);

    // Past where the 30% target was (130.20): still held, and the stop has climbed 20% below the best price.
    h.feed(optionQuote(CALL_25900, 150, 149.9, 150.1), at + 60_000);
    [position] = h.trader.status().positions;
    assert.equal(position.status, "open");
    assert.equal(position.stopPrice, 120);
    assert.equal(position.trail?.raised, true);
    // A dip that stays above it changes nothing; the stop never comes down.
    h.feed(optionQuote(CALL_25900, 125, 124.9, 125.1), at + 90_000);
    assert.equal(h.trader.status().positions[0].stopPrice, 120);

    h.feed(optionQuote(CALL_25900, 119.5, 119.4, 119.6), at + 120_000);
    h.feed(optionQuote(CALL_25900, 119.5, 119.4, 119.6), at + 120_400);
    const status = h.trader.status();
    assert.equal(status.positions.length, 0);
    assert.equal(status.trades[0].exitReason, "trail");
    assert.ok(status.trades[0].net > 0, "the trade kept part of the run");
  } finally {
    await h.close();
  }
});

test("a replay of a day recorded without options trades against 1-minute candles", async () => {
  const h = await harness();
  try {
    h.state.replay = { date: DATE, at: OPEN - 10 * MIN, jumps: 1, speed: 60, ended: false };
    const minute = (index: number, o: number, high: number, l: number, c: number): Candle => ({ t: OPEN + index * MIN, o, h: high, l, c });
    // The minute after the entry opens at 100 and falls through the stop (80.40) to 75.
    h.state.candles = [minute(15, 99, 100, 98, 99.5), minute(16, 99.5, 100.5, 99, 100), minute(17, 100, 101, 75, 78), minute(18, 78, 79, 77, 78)];
    await toSignal(h, null);
    let status = h.trader.status();
    assert.equal(status.source, "replay");
    assert.match(status.run?.id ?? "", /^replay-2026-11-16-\d{14}$/);
    // Bought at once at the close of the minute that fired, plus the slippage that stands in for the spread.
    const [position] = status.positions;
    assert.deepEqual([position.entryPrice, position.entrySource], [100.5, "candle"]);
    assert.ok(Math.abs(position.stopPrice! - 80.4) < 1e-9);

    h.feed(niftyTick(25_905), OPEN + 18 * MIN + 1_000);
    status = h.trader.status();
    const [trade] = status.trades;
    // Filled at the stop's level, not the minute's low, less slippage.
    assert.deepEqual([trade.exitReason, trade.exitSource, trade.exitPrice], ["stop", "candle", 79.9]);
  } finally {
    await h.close();
  }
});

test("a replay jump ends the run and starts a new one", async () => {
  const h = await harness();
  try {
    h.state.replay = { date: DATE, at: OPEN - 10 * MIN, jumps: 1, speed: 1, ended: false };
    await h.tickAt(OPEN + MIN);
    const first = h.trader.status().run?.id;
    assert.ok(first);
    h.state.replay = { ...h.state.replay, jumps: 2 };
    await h.tickAt(OPEN + 30 * MIN + 1_000);
    await h.tickAt(OPEN + 30 * MIN + 2_000);
    const second = h.trader.status().run?.id;
    assert.ok(second && second !== first);
    const history = await h.trader.history(null);
    assert.ok(history.runs.some((run) => run.run_id === first && run.status === "running"));
  } finally {
    await h.close();
  }
});

test("an engine restarted mid-session carries on with the day's run and its open position", async () => {
  const h = await harness({ strategy: { holdMinutes: 5, stopLossPct: 0, targetPct: 0 } });
  try {
    const at = await toSignal(h);
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    assert.equal(h.trader.status().positions.length, 1);
    await h.trader.stop();

    const again = h.restart();
    await again.trader.start();
    assert.equal((again.trader.status().config as TradingConfig).armed, true, "settings are kept");
    await again.tickAt(at + MIN);
    let status = again.trader.status();
    assert.equal(status.run?.resumed, true);
    assert.deepEqual(status.positions.map((p) => [p.contract.name, p.entryPrice]), [["NIFTY 17 NOV 25900 CALL", 100.15]]);
    assert.ok(again.acquired.includes(`NSE_FNO:${CALL_25900}`), "the held contract is subscribed again");

    // Its hold time still applies.
    again.feed(optionQuote(CALL_25900, 102, 101.9, 102.1), at + 5 * MIN + 500);
    again.feed(optionQuote(CALL_25900, 102, 101.9, 102.1), at + 5 * MIN + 900);
    status = again.trader.status();
    assert.deepEqual(status.trades.map((t) => [t.exitReason, t.exitPrice]), [["time", 101.85]]);
    assert.equal(status.totals.paper.trades, 1);
  } finally {
    await h.close();
  }
});

test("the web gets the lists only when they change, and the open position's mark every second", async () => {
  const h = await harness({ strategy: { stopLossPct: 0, targetPct: 0 } });
  try {
    const at = await toSignal(h);
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    await h.tickAt(at + 1_000);
    const first = h.published.at(-1)!;
    assert.ok(first.trades && first.orders && first.intents && first.events, "a change sends the lists");
    assert.equal(first.positions.length, 1);

    // The premium moves; nothing is recorded.
    h.feed(optionQuote(CALL_25900, 103, 102.9, 103.1), at + 1_500);
    await h.tickAt(at + 2_000);
    const second = h.published.at(-1)!;
    assert.notEqual(second, first);
    assert.equal(second.trades, undefined);
    assert.equal(second.events, undefined);
    assert.equal(second.listsRevision, first.listsRevision);
    assert.equal(second.positions[0].mark, 102.9);
    assert.ok(second.positions[0].unrealisedGross > 0);
    // The whole status is always there to read.
    assert.equal(h.trader.status().orders.length, 1);
  } finally {
    await h.close();
  }
});

test("following a decision lab rule: the rule decides, not the signal", async () => {
  // Momentum votes long at minute 17, but Momentum when options are cheap also needs to know what options
  // price, which this day doesn't have: the rule stays silent and nothing is proposed.
  const h = await harness({ strategy: { rule: "cheap-momentum" } });
  try {
    await toSignal(h);
    const status = h.trader.status();
    assert.equal(status.signal?.vote, 1, "the signal still shows");
    assert.deepEqual(status.intents, []);
  } finally {
    await h.close();
  }
});

test("the cost check turns down a trade whose costs NIFTY's typical move doesn't cover three times over", async () => {
  // NIFTY rises about 5 points a minute: over a 1-minute hold that is less than 3 × the move this trade needs.
  const h = await harness({ strategy: { costCheck: true, holdMinutes: 1 } });
  try {
    await toSignal(h);
    const [intent] = h.trader.status().intents;
    assert.equal(intent.outcome, "rejected");
    assert.match(intent.reason ?? "", /^Cost check: NIFTY typically moves .* less than 3 times over$/);
  } finally {
    await h.close();
  }
});

test("volatility exits: each trade's stop and target come from how much NIFTY is moving", async () => {
  const h = await harness({ strategy: { exitsFrom: "volatility", stopMoves: 1, targetMoves: 2, holdMinutes: 10 } });
  try {
    const at = await toSignal(h);
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    const status = h.trader.status();
    const [position] = status.positions;
    const planned = position.plannedExits!;
    // NIFTY rises about 5.2 points a minute: about 16 points in 10 minutes, about 8 rupees on an at-the-money option.
    assert.ok(planned.move > 14 && planned.move < 18, `move ${planned.move}`);
    assert.ok(planned.stopPct > 4 && planned.stopPct < 12, `stop ${planned.stopPct}%`);
    // The target is twice as far as the stop.
    const below = position.entryPrice - position.stopPrice!;
    const above = position.targetPrice! - position.entryPrice;
    assert.ok(Math.abs(above / below - 2) < 0.01, `target ${above} against stop ${below}`);
    assert.ok(status.events.some((e) => /NIFTY typically moves .* points in 10 min now, from today's 1-minute move/.test(e.message)));
  } finally {
    await h.close();
  }
});

test("volatility exits measure the typical move from recent days at this time of day when they are stored", async () => {
  // Twenty days on which NIFTY drifts 3 points a minute with no back and forth: 30 points over 10 minutes.
  const dates = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  const moveProfile: MoveProfile = { dates, closes: dates.map(() => Array.from({ length: 360 }, (_, t) => 25_000 + 3 * t)) };
  const h = await harness({ strategy: { exitsFrom: "volatility", stopMoves: 1, targetMoves: 2, holdMinutes: 10 } }, { moveProfile });
  try {
    const at = await toSignal(h);
    h.feed(optionQuote(CALL_25900, 100.05, 100, 100.1), at + 400);
    const status = h.trader.status();
    assert.deepEqual(status.moveHistory, { days: 20, from: "2026-10-01", to: "2026-10-20" });
    const planned = status.positions[0].plannedExits!;
    assert.equal(planned.source, "history");
    assert.equal(planned.history, 30);
    assert.equal(planned.days, 20);
    // Today moves about 5.2 points a minute against the days' 3: busier, so a little more than 30, at most 1.5×.
    assert.ok(planned.move > 30 && planned.move <= 45, `move ${planned.move}`);
    assert.ok(status.events.some((e) => /from 30\.0 at this time over the last 20 days/.test(e.message)));
  } finally {
    await h.close();
  }
});
