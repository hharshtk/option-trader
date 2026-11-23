// The live desk on a fake Dhan: no network. Each test follows the paper book through the desk and
// checks the orders it would send to Dhan, above all that it never sells what Dhan doesn't show held.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FINAL_ORDER_STATES, type LiveOrderStatus } from "../../lib/engine/live.ts";
import type { OptionRef } from "../../lib/engine/trading.ts";
import { orderCharges } from "../../lib/trading/charges.ts";
import type { Logger } from "../telemetry/logger.ts";
import { BrokerError, type BrokerOrder, type LiveBroker, type PlaceRequest } from "./dhan-broker.ts";
import { createLiveDesk, type DeskContext, type DeskQuote, type LiveDesk, type PaperView } from "./live-desk.ts";

const DATE = "2026-11-23";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
const CALL: OptionRef = { securityId: "35028", feedKey: "NSE_FNO:35028", name: "NIFTY 25 NOV 26000 CALL", strike: 26000, type: "CE", expiry: "2026-11-25", lotSize: 65, tickSize: 0.05 };
const PUT: OptionRef = { ...CALL, securityId: "35029", feedKey: "NSE_FNO:35029", name: "NIFTY 25 NOV 26000 PUT", type: "PE" };

interface FakeOrder extends BrokerOrder {
  request: PlaceRequest;
}

type Placement = { status?: LiveOrderStatus; fillAt?: number; message?: string } | BrokerError;

/** A stand-in for Dhan: an order book, positions that follow fills, and a log of every call. */
function fakeDhan() {
  const calls: string[] = [];
  const orders = new Map<string, FakeOrder>();
  const held = new Map<string, number>();
  let ids = 0;
  const fake = {
    calls,
    orders,
    held,
    killSwitchState: "INACTIVE",
    /** By default a buy fills 0.10 above the ask it was priced from, a stop rests, and a sale fills at its limit. */
    onPlace(request: PlaceRequest): Placement {
      if (request.type === "STOP_LOSS") return { status: "PENDING" };
      if (request.side === "BUY") return { status: "TRADED", fillAt: 100.2 };
      return { status: "TRADED", fillAt: request.price ?? 95 };
    },
    fill(orderId: string, at: number, quantity?: number) {
      const order = orders.get(orderId)!;
      order.status = "TRADED";
      order.filledQty = quantity ?? order.request.quantity;
      order.averagePrice = at;
      const sign = order.request.side === "BUY" ? 1 : -1;
      held.set(order.request.securityId, (held.get(order.request.securityId) ?? 0) + sign * order.filledQty);
    },
    placed: (filter?: (r: PlaceRequest) => boolean) => [...orders.values()].map((o) => o.request).filter(filter ?? (() => true)),
  };
  const broker: LiveBroker = {
    async place(request) {
      calls.push(`place ${request.side} ${request.type} ${request.quantity}${request.price !== null ? `@${request.price}` : ""}${request.trigger !== null ? ` trigger ${request.trigger}` : ""}`);
      const outcome = fake.onPlace(request);
      if (outcome instanceof BrokerError && !outcome.unknown) throw outcome;
      ids += 1;
      const orderId = `D${ids}`;
      const order: FakeOrder = { orderId, status: "PENDING", filledQty: 0, averagePrice: null, message: null, request };
      orders.set(orderId, order);
      if (outcome instanceof BrokerError) throw outcome; // Reached Dhan, but the answer was lost.
      if (outcome.message) order.message = outcome.message;
      if (outcome.status === "TRADED") fake.fill(orderId, outcome.fillAt!);
      else if (outcome.status) order.status = outcome.status;
      return { orderId, status: order.status };
    },
    async order(orderId) {
      calls.push(`order ${orderId}`);
      const { request: _r, ...order } = orders.get(orderId)!;
      void _r;
      return order;
    },
    async orderByCorrelation(correlationId) {
      calls.push(`lookup ${correlationId}`);
      const found = [...orders.values()].find((o) => o.request.correlationId === correlationId);
      if (!found) return null;
      const { request: _r, ...order } = found;
      void _r;
      return order;
    },
    async cancel(orderId) {
      calls.push(`cancel ${orderId}`);
      const order = orders.get(orderId);
      if (order && !FINAL_ORDER_STATES.has(order.status)) order.status = "CANCELLED";
    },
    async positions() {
      calls.push("positions");
      return [...held].map(([securityId, netQty]) => ({ securityId, exchangeSegment: "NSE_FNO", productType: "INTRADAY", tradingSymbol: securityId, netQty }));
    },
    async setLossExit(loss) {
      calls.push(`pnlExit ${loss}`);
      return "ACTIVE: P&L based exit configured successfully";
    },
    async killSwitch() {
      return fake.killSwitchState;
    },
    async balance() {
      return 50_000;
    },
    async whitelistedIp() {
      return "140.245.240.9";
    },
    async exitAll() {
      calls.push("exitAll");
      return "SUCCESS";
    },
  };
  return { fake, broker };
}

async function setup(options: { notAllowed?: string | null; directory?: string; broker?: ReturnType<typeof fakeDhan> } = {}) {
  const directory = options.directory ?? (await mkdtemp(path.join(tmpdir(), "live-desk-")));
  const dhan = options.broker ?? fakeDhan();
  let clock = Date.UTC(2026, 10, 23, 4, 0); // 09:30 IST
  const halts: string[] = [];
  let quote: DeskQuote = { ltp: 100, bid: 99.9, ask: 100.1, at: clock };
  const desk: LiveDesk = createLiveDesk({
    notAllowed: options.notAllowed ?? null,
    directory,
    broker: dhan.broker,
    now: () => clock,
    log: quiet,
    onLossLimit: (reason) => halts.push(reason),
  });
  const context = (positions: PaperView[], over: Partial<DeskContext> = {}): DeskContext => ({
    date: DATE,
    runId: `live-${DATE}`,
    ready: true,
    positions,
    quote: () => ({ ...quote, at: clock }),
    marketTime: clock,
    lossLimit: 3_000,
    ...over,
  });
  /** One engine tick: the paper book as it stands, then the desk's steps run to rest. */
  const tick = async (positions: PaperView[], over: Partial<DeskContext> = {}) => {
    desk.update(context(positions, over));
    await desk.idle();
  };
  const later = (ms: number) => {
    clock += ms;
  };
  // The desk opens today's records on its first tick.
  await tick([]);
  return {
    desk,
    dhan: dhan.fake,
    broker: dhan,
    directory,
    halts,
    tick,
    later,
    context,
    setQuote: (next: Partial<DeskQuote>) => {
      quote = { ...quote, ...next };
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

const paper = (id: string, status: PaperView["status"], stopFraction: number | null = null, exitReason: string | null = null, contract = CALL): PaperView => ({ id, status, contract, stopFraction, exitReason });

async function switchOn(s: Awaited<ReturnType<typeof setup>>) {
  const result = await s.desk.command({ action: "live-on", date: DATE }, s.context([]));
  assert.equal(result.ok, true, result.message);
}

/** Bought for real, with Dhan's stop resting. */
async function holding(s: Awaited<ReturnType<typeof setup>>) {
  await switchOn(s);
  await s.tick([paper("p1", "opening")]);
  s.later(1_000);
  await s.tick([paper("p1", "open", 0.2)]);
}

test("nothing is sent to Dhan while live is off", async () => {
  const s = await setup();
  try {
    await s.tick([paper("p1", "opening")]);
    await s.tick([paper("p1", "open", 0.2)]);
    assert.deepEqual(s.dhan.calls, []);
    assert.equal(s.desk.status().on, false);
    assert.equal(s.desk.summary(), null);
  } finally {
    await s.cleanup();
  }
});

test("switching on checks the kill switch, sets Dhan's P&L exit, and only for today's live run", async () => {
  const s = await setup();
  try {
    assert.equal((await s.desk.command({ action: "live-on", date: "2026-11-22" }, s.context([]))).ok, false, "another day's date");
    assert.equal((await s.desk.command({ action: "live-on", date: DATE }, s.context([], { ready: false }))).ok, false, "no live run yet");
    s.dhan.killSwitchState = "ACTIVATE";
    const blocked = await s.desk.command({ action: "live-on", date: DATE }, s.context([]));
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /kill switch is on/);
    assert.deepEqual(s.dhan.calls, []);
    s.dhan.killSwitchState = "INACTIVE";
    await switchOn(s);
    // The P&L exit, then the first check of Dhan's positions: no order.
    assert.deepEqual(s.dhan.calls, ["pnlExit 3000", "positions"]);
    const status = s.desk.status();
    assert.equal(status.on, true);
    assert.equal(status.lossLimit, 3_000);
    assert.equal(status.checks?.ip, "140.245.240.9");
    assert.equal((await s.desk.command({ action: "live-off" }, s.context([]))).ok, true);
    assert.equal(s.desk.status().on, false);
    assert.equal(s.desk.status().offReason, "Switched off by you");
  } finally {
    await s.cleanup();
  }
});

test("an engine that may not trade live never calls Dhan", async () => {
  const s = await setup({ notAllowed: "Live orders are placed only by the main engine (port 3100)" });
  try {
    const result = await s.desk.command({ action: "live-on", date: DATE }, s.context([]));
    assert.equal(result.ok, false);
    assert.match(result.message, /main engine/);
    assert.equal((await s.desk.command({ action: "live-exit-all" }, s.context([]))).ok, false);
    await s.tick([paper("p1", "opening")]);
    s.later(61_000);
    await s.tick([paper("p1", "open", 0.2)]);
    assert.deepEqual(s.dhan.calls, []);
    assert.equal(s.desk.status().allowed, false);
  } finally {
    await s.cleanup();
  }
});

test("a paper round trip, for real: buy one lot, Dhan's stop, cancel it, check Dhan's position, sell", async () => {
  const s = await setup();
  try {
    await switchOn(s);
    s.dhan.calls.length = 0;
    await s.tick([paper("p1", "opening")]);
    // 100.10 ask + 1% = 101.101, up to the tick. Its fill is read from the order's details.
    assert.deepEqual(s.dhan.calls, ["place BUY LIMIT 65@101.15", "order D1"]);
    const buy = s.dhan.placed()[0];
    assert.equal(buy.validity, "IOC");
    assert.equal(buy.securityId, CALL.securityId);
    assert.match(buy.correlationId, /^ot-[0-9a-z]+-p1-e1$/);
    assert.ok(buy.correlationId.length <= 30);
    assert.equal(s.desk.status().positions[0].state, "open");

    // The paper fill brings its stop: 20% below. Dhan's stop keeps that distance from the real fill.
    s.later(1_000);
    await s.tick([paper("p1", "open", 0.2)]);
    assert.equal(s.dhan.calls.at(-1), "place SELL STOP_LOSS 65@72.1 trigger 80.15");

    s.dhan.calls.length = 0;
    s.later(30_000); // Within the minute, so the once-a-minute check of Dhan's positions stays out of the way.
    await s.tick([paper("p1", "closing", 0.2, "the paper target")]);
    s.later(500);
    await s.tick([paper("p1", "closing", 0.2, "the paper target")]);
    s.later(500);
    await s.tick([]);
    // The stop is cancelled and confirmed before anything is sold, and only what Dhan shows is sold.
    const sequence = s.dhan.calls.filter((c) => !c.startsWith("order "));
    assert.deepEqual(sequence.slice(0, 3), ["cancel D2", "positions", "place SELL LIMIT 65@97.9"]);
    const position = s.desk.status().positions[0];
    assert.equal(position.state, "closed");
    assert.equal(position.closeReason, "the paper target");
    assert.equal(position.bought, 65);
    assert.equal(position.sold, 65);
    const charges = orderCharges("BUY", 100.2 * 65).total + orderCharges("SELL", 97.9 * 65).total;
    assert.ok(Math.abs(position.gross - (97.9 - 100.2) * 65) < 1e-6);
    assert.ok(Math.abs(position.net - ((97.9 - 100.2) * 65 - charges)) < 1e-6);
    assert.equal(s.dhan.held.get(CALL.securityId), 0);
    assert.equal(s.desk.status().totals.trades, 1);
  } finally {
    await s.cleanup();
  }
});

test("when Dhan's stop sells first, the paper exit sells nothing more", async () => {
  const s = await setup();
  try {
    await holding(s);
    const stop = [...s.dhan.orders.values()].find((o) => o.request.type === "STOP_LOSS")!;
    s.dhan.fill(stop.orderId, 80.15);
    s.later(3_500);
    await s.tick([paper("p1", "open", 0.2)]);
    assert.equal(s.desk.status().positions[0].state, "closed");
    assert.equal(s.desk.status().positions[0].note, "Sold by the stop at Dhan");
    s.later(1_000);
    await s.tick([paper("p1", "closing", 0.2, "the paper stop")]);
    await s.tick([]);
    assert.equal(s.dhan.placed((r) => r.side === "SELL" && r.type !== "STOP_LOSS").length, 0);
    assert.equal(s.dhan.held.get(CALL.securityId), 0);
  } finally {
    await s.cleanup();
  }
});

test("never sells what Dhan doesn't show held: alerts and switches live off instead", async () => {
  const s = await setup();
  try {
    await holding(s);
    // Sold outside the engine (the Dhan app, Dhan's P&L exit): Dhan now shows nothing.
    s.dhan.held.set(CALL.securityId, 0);
    await s.tick([paper("p1", "closing", 0.2, "the paper target")]);
    for (let i = 0; i < 8; i += 1) {
      s.later(1_100);
      await s.tick([paper("p1", "closing", 0.2, "the paper target")]);
    }
    assert.equal(s.dhan.placed((r) => r.side === "SELL" && r.type !== "STOP_LOSS").length, 0);
    const position = s.desk.status().positions[0];
    assert.equal(position.state, "closed");
    assert.match(position.alert ?? "", /Dhan shows nothing held/);
    assert.equal(s.desk.status().on, false);
    assert.match(s.desk.alert() ?? "", /Dhan shows nothing held/);
  } finally {
    await s.cleanup();
  }
});

test("a buy whose answer was lost is found by its correlation id, never sent twice", async () => {
  const s = await setup();
  try {
    await switchOn(s);
    s.dhan.onPlace = (request) => (request.side === "BUY" ? new BrokerError("Could not reach Dhan (timed out after 10s)", { unknown: true, fatal: false }) : { status: "PENDING" });
    await s.tick([paper("p1", "opening")]);
    assert.equal(s.desk.status().positions[0].orders[0].status, "UNKNOWN");
    // It did reach Dhan and filled.
    const reached = [...s.dhan.orders.values()][0];
    s.dhan.fill(reached.orderId, 100.3);
    s.later(1_200);
    await s.tick([paper("p1", "open", 0.2)]);
    assert.equal(s.dhan.placed((r) => r.side === "BUY").length, 1);
    const position = s.desk.status().positions[0];
    assert.equal(position.state, "open");
    assert.equal(position.buyAverage, 100.3);
    assert.ok(s.dhan.calls.some((c) => c.startsWith("lookup ot-")));
  } finally {
    await s.cleanup();
  }
});

test("a buy Dhan refuses switches live off for the day", async () => {
  const s = await setup();
  try {
    await switchOn(s);
    s.dhan.onPlace = () => ({ status: "REJECTED", message: "Insufficient funds" });
    await s.tick([paper("p1", "opening")]);
    await s.tick([paper("p1", "open", 0.2)]);
    const status = s.desk.status();
    assert.equal(status.positions[0].state, "closed");
    assert.equal(status.positions[0].bought, 0);
    assert.equal(status.on, false);
    assert.match(status.offReason ?? "", /Insufficient funds/);
    // Live stays off: the next paper entry isn't bought.
    s.dhan.onPlace = () => ({ status: "TRADED", fillAt: 100 });
    await s.tick([paper("p2", "opening")]);
    assert.equal(s.dhan.placed((r) => r.side === "BUY").length, 1);
  } finally {
    await s.cleanup();
  }
});

test("an unfilled sale is cancelled and sent again lower, then at market", async () => {
  const s = await setup();
  try {
    await holding(s);
    s.dhan.onPlace = () => ({ status: "PENDING" });
    const closing = [paper("p1", "closing", 0.2, "the hold time is over")];
    for (let i = 0; i < 40; i += 1) {
      s.later(1_000);
      await s.tick(closing);
    }
    const sales = s.dhan.placed((r) => r.side === "SELL" && r.type !== "STOP_LOSS");
    assert.deepEqual(
      sales.slice(0, 4).map((r) => (r.type === "MARKET" ? "MARKET" : r.price)),
      [97.9, 94.9, 89.9, "MARKET"],
    );
    // Each one cancelled and confirmed before the next went out: never two sales open at once.
    for (const sale of sales.slice(0, 3)) assert.equal([...s.dhan.orders.values()].find((o) => o.request === sale)!.status, "CANCELLED");
    assert.ok(sales.every((r) => r.quantity === 65));
  } finally {
    await s.cleanup();
  }
});

test("one real position at a time", async () => {
  const s = await setup();
  try {
    await switchOn(s);
    await s.tick([paper("p1", "opening"), paper("p2", "opening", null, null, PUT)]);
    assert.equal(s.dhan.placed((r) => r.side === "BUY").length, 1);
    assert.equal(s.desk.status().positions.length, 1);
  } finally {
    await s.cleanup();
  }
});

test("a restarted engine carries on with the position it held, and sells it with its paper position", async () => {
  const s = await setup();
  try {
    await holding(s);
    await s.desk.stop();
    const again = await setup({ directory: s.directory, broker: s.broker });
    await again.tick([paper("p1", "open", 0.2)]);
    const status = again.desk.status();
    assert.equal(status.on, true);
    assert.equal(status.positions[0].state, "open");
    // Its stop is still the one resting at Dhan: no second stop.
    assert.equal(again.dhan.placed((r) => r.type === "STOP_LOSS").length, 1);
    const closing = [paper("p1", "closing", 0.2, "square-off")];
    for (let i = 0; i < 4; i += 1) {
      again.later(1_000);
      await again.tick(closing);
    }
    assert.equal(again.desk.status().positions[0].state, "closed");
    assert.equal(again.dhan.held.get(CALL.securityId), 0);
    const file = await readFile(path.join(s.directory, "live", `${DATE}.jsonl`), "utf8");
    assert.match(file, /"kind":"on"/);
  } finally {
    await s.cleanup();
  }
});

test("a position whose paper position disappears is sold; so is everything when the live run ends", async () => {
  const s = await setup();
  try {
    await holding(s);
    s.desk.runEnded("the feed switched to replay");
    for (let i = 0; i < 4; i += 1) {
      s.later(1_000);
      await s.tick([], { ready: false });
    }
    const position = s.desk.status().positions[0];
    assert.equal(position.state, "closed");
    assert.match(position.closeReason ?? "", /feed switched to replay/);
    assert.equal(s.dhan.held.get(CALL.securityId), 0);
  } finally {
    await s.cleanup();
  }
});

test("a restart with no live run yet holds the position instead of selling it", async () => {
  const s = await setup();
  try {
    await holding(s);
    for (let i = 0; i < 5; i += 1) {
      s.later(1_000);
      await s.tick([], { ready: false });
    }
    assert.equal(s.desk.status().positions[0].state, "open");
    assert.equal(s.dhan.placed((r) => r.side === "SELL" && r.type !== "STOP_LOSS").length, 0);
  } finally {
    await s.cleanup();
  }
});

test("the live day's loss limit stops the day and switches live off", async () => {
  const s = await setup();
  try {
    await holding(s);
    s.setQuote({ ltp: 53, bid: 53, ask: 53.5 });
    await s.tick([paper("p1", "open", 0.2)]);
    // (53 − 100.20) × 65 = −₹3,068, past the ₹3,000 limit.
    assert.equal(s.halts.length, 1);
    assert.match(s.halts[0], /Live daily loss limit/);
    assert.equal(s.desk.status().on, false);
  } finally {
    await s.cleanup();
  }
});

test("Dhan's exit-all: the desk waits for Dhan to sell and never sells alongside", async () => {
  const s = await setup();
  try {
    await holding(s);
    const result = await s.desk.command({ action: "live-exit-all" }, s.context([paper("p1", "open", 0.2)]));
    assert.equal(result.ok, true);
    assert.equal(s.desk.status().on, false);
    for (let i = 0; i < 3; i += 1) {
      s.later(1_000);
      await s.tick([paper("p1", "open", 0.2)]);
    }
    assert.equal(s.desk.status().positions[0].state, "selling");
    // Dhan sells it.
    s.dhan.held.set(CALL.securityId, 0);
    s.later(1_100);
    await s.tick([paper("p1", "open", 0.2)]);
    assert.equal(s.desk.status().positions[0].state, "closed");
    assert.equal(s.dhan.placed((r) => r.side === "SELL" && r.type !== "STOP_LOSS").length, 0);
  } finally {
    await s.cleanup();
  }
});

test("a mismatch with Dhan's positions twice in a row switches live off", async () => {
  const s = await setup();
  try {
    await holding(s);
    s.dhan.held.set(CALL.securityId, 130); // Someone bought another lot by hand.
    s.later(61_000);
    await s.tick([paper("p1", "open", 0.2)]);
    assert.equal(s.desk.status().on, true, "once could be a fill on its way");
    s.later(61_000);
    await s.tick([paper("p1", "open", 0.2)]);
    assert.equal(s.desk.status().on, false);
    assert.match(s.desk.alert() ?? "", /Dhan 130, engine 65/);
  } finally {
    await s.cleanup();
  }
});
