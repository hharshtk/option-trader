// The live desk: real orders with Dhan for the one-lot pilot (constitution, amendment of 22 Nov 2026).
//
// The paper book still decides everything; the desk follows it with real money:
//
//   paper entry opens  ──► buy one lot of the same contract: a limit order a little above the ask, IOC
//   the buy fills      ──► a stop-loss order rests at Dhan at the paper stop's distance, so the
//                          position is protected even if the engine dies
//   paper position     ──► cancel Dhan's stop and wait until Dhan confirms, ask Dhan what is held,
//   sold or gone           and sell that (never more) with a limit below the bid; then lower, then at market
//
// One live position at a time. Switched on by hand for one day at a time; it switches itself off on a
// refused order, a mismatch with Dhan's positions, or the day's loss limit, and never back on. When
// switched on it sets Dhan's P&L exit at the daily loss limit with Dhan's kill switch. Every change is
// appended to live/<date>.jsonl, so a restarted engine carries on with the positions and orders it had.

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Columns, ParquetStore, Row } from "../../lib/db/parquet-store.ts";
import {
  FINAL_ORDER_STATES,
  type LiveCommand,
  type LiveEvent,
  type LiveOrder,
  type LivePosition,
  type LiveStatus,
  type LiveTotals,
} from "../../lib/engine/live.ts";
import type { OptionRef, TradingCommandResult } from "../../lib/engine/trading.ts";
import { orderCharges } from "../../lib/trading/charges.ts";
import type { Logger } from "../telemetry/logger.ts";
import { BrokerError, type BrokerOrder, type BrokerPosition, type LiveBroker } from "./dhan-broker.ts";

/** A paper position, as the desk needs it. */
export interface PaperView {
  id: string;
  status: "opening" | "open" | "closing";
  contract: OptionRef;
  /** The paper stop's distance below its entry, as a fraction; null until the paper entry fills or without a stop. */
  stopFraction: number | null;
  /** Why it is being sold, while closing. */
  exitReason: string | null;
}

export interface DeskQuote {
  ltp: number;
  bid: number | null;
  ask: number | null;
  /** Market time of the last price. */
  at: number;
}

export interface DeskContext {
  /** Today, YYYY-MM-DD IST, by the wall clock. */
  date: string;
  runId: string | null;
  /** Today's live run is running with its contracts loaded: its paper positions are what should be held. */
  ready: boolean;
  /** The paper book's positions (not the shadow book's); empty unless ready. */
  positions: PaperView[];
  quote: (feedKey: string) => DeskQuote | undefined;
  marketTime: number;
  /** The daily loss limit, in rupees: Dhan's P&L exit, and the desk's own stop for the day. */
  lossLimit: number;
}

export interface LiveDeskOptions {
  /** Null when this engine may place orders; otherwise why it may not. */
  notAllowed: string | null;
  /** Where live/<date>.jsonl goes: the trading folder. */
  directory: string;
  broker: LiveBroker;
  /** Wall clock, ms. */
  now: () => number;
  log: Logger;
  /** The live day's loss reached the limit: the trader stops for the day, which sells everything. */
  onLossLimit: (reason: string) => void;
  /** Something the page shows changed. */
  onChange?: () => void;
  /** The day's orders as a Parquet table: trading/<namespace>/live-orders/<date>.parquet. */
  table?: { store: ParquetStore; namespace: string };
}

export interface LiveDesk {
  /** Call every second, and right after the paper book opens or starts selling a position. Never throws. */
  update(context: DeskContext): void;
  /** Today's live run ended (the session closed, the feed switched to a replay): sell everything held. */
  runEnded(reason: string): void;
  command(command: LiveCommand, context: DeskContext): Promise<TradingCommandResult>;
  status(): LiveStatus;
  /** For the engine's status, which every page reads: null while live is off and nothing is held. */
  summary(): { on: boolean; date: string; holding: number; net: number; alert: string | null } | null;
  /** The first thing a person must look at, if any. */
  alert(): string | null;
  stop(): Promise<void>;
  /** Resolves when no step is running. For tests. */
  idle(): Promise<void>;
}

// Entry: a limit this far above the ask, at least three ticks, immediate-or-cancel.
const ENTRY_ABOVE_ASK = 0.01;
const ENTRY_MIN_TICKS = 3;
/** An entry Dhan still has open after this is cancelled. IOC resolves at once; this is a backstop. */
const ENTRY_CANCEL_MS = 10_000;
/** How long to wait for the paper stop before placing Dhan's stop at the default distance. */
const STOP_WAIT_MS = 5_000;
/** The stop used when the paper position has none. */
const DEFAULT_STOP = 0.3;
/** A stop-loss order's limit, below its trigger, so it fills in a fast fall. */
const STOP_LIMIT_BELOW = 0.1;
/** Each sale's limit below the bid: first, second, third try. Then at market. */
const EXIT_BELOW_BID = [0.02, 0.05, 0.1];
/** A sale not filled by then is cancelled and sent again lower. */
const EXIT_WAIT_MS = 4_000;
/** A stop that won't cancel by then is reported, and its cancel sent again. */
const STOP_CANCEL_ALERT_MS = 15_000;
/** Order polling: orders being worked, and the stop resting at Dhan. */
const ORDER_POLL_MS = 700;
const STOP_POLL_MS = 3_000;
/** An order whose answer was lost and that Dhan still can't find after this was not placed. */
const LOOKUP_GIVE_UP_MS = 20_000;
/** Dhan's positions can lag a fill: a short count is read again this many times, a second apart, before it is believed. */
const POSITION_READS = 5;
/** After Dhan's exit-all, how long to wait for Dhan to sell before reporting it. */
const EXIT_ALL_WAIT_MS = 30_000;
const RECONCILE_MS = 60_000;
const QUOTE_MAX_AGE_MS = 10_000;
const EVENT_CAP = 300;
/** The close reason of positions Dhan's exit-all is selling: the desk waits for Dhan and never sells alongside. */
const EXIT_ALL = "exit all at Dhan";

interface Day {
  date: string;
  on: boolean;
  since: number | null;
  offReason: string | null;
  lossLimit: number | null;
  checks: LiveStatus["checks"];
  positions: LivePosition[];
  events: LiveEvent[];
  /** Paper positions already looked at: only a paper entry seen while it opens is bought. */
  seen: Set<string>;
  /** Contracts the desk traded today: the ones checked against Dhan's positions. */
  touched: Map<string, string>;
  file: WriteStream | null;
  mismatches: number;
  reconciledAt: number;
  otherPositions: string[];
  lossHit: boolean;
  alert: string | null;
}

type DeskRecord =
  | { kind: "on"; at: number; lossLimit: number; checks: LiveStatus["checks"] }
  | { kind: "off"; at: number; reason: string }
  | { kind: "position"; position: LivePosition }
  | { kind: "event"; event: LiveEvent };

const rupees = (value: number) => `${value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedRupees = (value: number) => (value >= 0 ? `+${rupees(value)}` : rupees(value));
const fmt = (value: number | null) => (value === null ? "—" : value.toFixed(2));
const isFinal = (order: LiveOrder) => FINAL_ORDER_STATES.has(order.status);
const roundTo = (value: number) => Math.round(value * 100) / 100;
const tickUp = (value: number, tick: number) => roundTo(Math.ceil(value / tick - 1e-9) * tick);
const tickDown = (value: number, tick: number) => roundTo(Math.floor(value / tick + 1e-9) * tick);

/** Dhan's net quantity in a contract, intraday, on the F&O segment. */
export function heldAtDhan(positions: readonly BrokerPosition[], securityId: string): number {
  return positions
    .filter((p) => p.securityId === securityId && p.productType === "INTRADAY" && (p.exchangeSegment === "NSE_FNO" || p.exchangeSegment === ""))
    .reduce((sum, p) => sum + p.netQty, 0);
}

export function createLiveDesk(options: LiveDeskOptions): LiveDesk {
  const { broker, now, log, notAllowed } = options;
  const folder = path.join(options.directory, "live");

  let day: Day | null = null;
  let loading: Promise<void> | null = null;
  let context: DeskContext | null = null;
  let working: Promise<void> | null = null;
  let again = false;
  let switching = false;
  let tableDue = false;
  let tableWrite: Promise<void> | null = null;
  // Per position, in memory: when the next sale may go out, how often Dhan's count came up short, when a stop's cancel was sent.
  const nextSellAt = new Map<string, number>();
  const shortReads = new Map<string, number>();
  const cancelSentAt = new Map<string, number>();
  const exitAllAt = new Map<string, number>();
  const warnedNoStop = new Set<string>();

  const changed = () => options.onChange?.();

  // --- Records ---------------------------------------------------------------------------------

  function write(d: Day, entry: DeskRecord) {
    d.file?.write(`${JSON.stringify(entry)}\n`);
  }

  function save(d: Day, position: LivePosition) {
    write(d, { kind: "position", position });
    changed();
  }

  function event(d: Day, level: LiveEvent["level"], message: string) {
    const entry: LiveEvent = { at: now(), level, message };
    d.events.push(entry);
    if (d.events.length > EVENT_CAP) d.events.splice(0, d.events.length - EVENT_CAP);
    write(d, { kind: "event", event: entry });
    log[level === "info" ? "info" : level === "warn" ? "warn" : "error"](`live: ${message}`);
    changed();
  }

  function fresh(date: string): Day {
    return {
      date,
      on: false,
      since: null,
      offReason: null,
      lossLimit: null,
      checks: null,
      positions: [],
      events: [],
      seen: new Set(),
      touched: new Map(),
      file: null,
      mismatches: 0,
      reconciledAt: 0,
      otherPositions: [],
      lossHit: false,
      alert: null,
    };
  }

  /** Reads today's file back, so a restarted engine carries on where it was. */
  async function openDay(date: string) {
    const previous = day;
    if (previous?.file) await new Promise<void>((resolve) => previous.file!.end(() => resolve()));
    const d = fresh(date);
    const file = path.join(folder, `${date}.jsonl`);
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.error("live: could not read today's file", { error: String(error) });
    }
    const byId = new Map<string, LivePosition>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: DeskRecord;
      try {
        entry = JSON.parse(line) as DeskRecord;
      } catch {
        continue; // A line cut short by a crash.
      }
      if (entry.kind === "on") Object.assign(d, { on: true, since: entry.at, lossLimit: entry.lossLimit, checks: entry.checks, offReason: null });
      else if (entry.kind === "off") Object.assign(d, { on: false, offReason: entry.reason });
      else if (entry.kind === "position") byId.set(entry.position.id, entry.position);
      else if (entry.kind === "event") d.events.push(entry.event);
    }
    d.events = d.events.slice(-EVENT_CAP);
    d.positions = [...byId.values()];
    for (const position of d.positions) {
      d.seen.add(position.id);
      d.touched.set(position.contract.securityId, position.contract.name);
      // A request in flight when the engine stopped: Dhan may or may not have it.
      for (const order of position.orders) {
        if (order.status === "SENDING") order.status = "UNKNOWN";
        order.checkAt = 0;
      }
    }
    mkdirSync(folder, { recursive: true });
    d.file = createWriteStream(file, { flags: "a" });
    d.file.on("error", (error) => log.error("live: could not write today's file", { error: error.message }));
    day = d;
    const held = d.positions.filter((p) => p.state !== "closed").length;
    if (text) event(d, "info", `Engine restarted: live is ${d.on ? "on" : "off"}${held ? `, ${held} real position${held === 1 ? "" : "s"} carried on` : ""}`);
    changed();
  }

  // --- Numbers ---------------------------------------------------------------------------------

  function recount(position: LivePosition) {
    let bought = 0;
    let boughtValue = 0;
    let sold = 0;
    let soldValue = 0;
    let charges = 0;
    for (const order of position.orders) {
      if (order.filledQty <= 0) continue;
      const fill = order.averagePrice ?? order.price ?? 0;
      const value = fill * order.filledQty;
      charges += orderCharges(order.side, value).total;
      if (order.side === "BUY") {
        bought += order.filledQty;
        boughtValue += value;
      } else {
        sold += order.filledQty;
        soldValue += value;
      }
    }
    position.bought = bought;
    position.buyAverage = bought > 0 ? roundTo(boughtValue / bought) : null;
    position.sold = sold;
    position.sellAverage = sold > 0 ? roundTo(soldValue / sold) : null;
    position.gross = position.buyAverage !== null && sold > 0 ? soldValue - position.buyAverage * sold : 0;
    position.charges = charges;
    position.net = position.gross - charges;
    const held = bought - sold;
    position.openGross = held > 0 && position.mark !== null && position.buyAverage !== null ? (position.mark - position.buyAverage) * held : 0;
  }

  function totals(d: Day | null): LiveTotals {
    const result: LiveTotals = { trades: 0, wins: 0, gross: 0, charges: 0, net: 0, open: 0 };
    for (const position of d?.positions ?? []) {
      if (position.bought <= 0) continue;
      result.trades += 1;
      if (position.state === "closed" && position.net > 0) result.wins += 1;
      result.gross += position.gross;
      result.charges += position.charges;
      result.net += position.net;
      result.open += position.openGross;
    }
    return result;
  }

  // --- Orders ----------------------------------------------------------------------------------

  function newOrder(position: LivePosition, role: LiveOrder["role"], spec: Pick<LiveOrder, "side" | "type" | "validity" | "quantity" | "price" | "trigger">, quote: DeskQuote | undefined): LiveOrder {
    const t = now();
    const n = position.orders.filter((o) => o.role === role).length + 1;
    return {
      // Unique across restarts and days: the time in base 36, the paper position, the role and try.
      correlationId: `ot-${t.toString(36)}-${position.id}-${role[0]}${n}`.slice(0, 30),
      orderId: null,
      role,
      ...spec,
      status: "NEW",
      filledQty: 0,
      averagePrice: null,
      message: null,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      ltp: quote?.ltp ?? null,
      createdAt: t,
      updatedAt: t,
      cancelRequested: false,
      checkAt: t,
    };
  }

  function apply(order: LiveOrder, answer: BrokerOrder) {
    if (answer.orderId) order.orderId = answer.orderId;
    order.status = answer.status;
    order.filledQty = answer.status === "TRADED" && answer.filledQty <= 0 ? order.quantity : answer.filledQty;
    order.averagePrice = answer.averagePrice ?? order.averagePrice;
    order.message = answer.message ?? order.message;
    order.updatedAt = now();
  }

  const roleName = (order: LiveOrder) => (order.role === "entry" ? "Buy" : order.role === "stop" ? "Stop" : "Sale");

  async function place(d: Day, position: LivePosition, order: LiveOrder) {
    order.status = "SENDING";
    order.updatedAt = now();
    save(d, position);
    try {
      const answer = await broker.place({
        correlationId: order.correlationId,
        side: order.side,
        type: order.type,
        validity: order.validity,
        securityId: position.contract.securityId,
        quantity: order.quantity,
        price: order.price,
        trigger: order.trigger,
      });
      order.orderId = answer.orderId;
      if (FINAL_ORDER_STATES.has(answer.status)) {
        // A final state is believed only with its details: what filled, at what price, or Dhan's reason.
        try {
          apply(order, await broker.order(answer.orderId));
        } catch {
          order.status = "TRANSIT"; // Read on the next poll.
        }
      } else order.status = answer.status;
      order.checkAt = now() + 250;
    } catch (error) {
      const failure = error instanceof BrokerError ? error : new BrokerError(error instanceof Error ? error.message : String(error), { unknown: true, fatal: false });
      order.message = failure.message;
      if (failure.unknown) {
        order.status = "UNKNOWN";
        order.checkAt = now() + 1_000;
      } else order.status = "NOT_PLACED";
      event(d, "warn", `${roleName(order)} order for ${position.contract.name} ${failure.unknown ? "got no answer; looking it up by its id" : "was refused"}: ${failure.message}`);
      if (failure.fatal) turnOff(d, `Dhan can't take orders: ${failure.message}`);
    }
    order.updatedAt = now();
    recount(position);
    save(d, position);
    if (order.status === "REJECTED") event(d, "warn", `${roleName(order)} order for ${position.contract.name} rejected by Dhan: ${order.message ?? "no reason given"}`);
  }

  /** An order whose answer was lost: Dhan finds it by correlation id, or it was never placed. */
  async function lookup(d: Day, position: LivePosition, order: LiveOrder) {
    try {
      const found = await broker.orderByCorrelation(order.correlationId);
      if (found) {
        apply(order, found);
        event(d, "info", `${roleName(order)} order for ${position.contract.name} found at Dhan: ${order.status.toLowerCase()}`);
      } else if (now() - order.createdAt > LOOKUP_GIVE_UP_MS) {
        order.status = "NOT_PLACED";
        order.message = "Dhan has no record of it";
        event(d, "warn", `${roleName(order)} order for ${position.contract.name}: Dhan has no record of it, so it wasn't placed`);
      }
    } catch {
      // No answer again: try once more shortly.
    }
    order.checkAt = now() + 2_000;
    recount(position);
    save(d, position);
  }

  async function refresh(d: Day, position: LivePosition, order: LiveOrder) {
    const before = `${order.status}/${order.filledQty}/${order.averagePrice}`;
    try {
      apply(order, await broker.order(order.orderId!));
    } catch (error) {
      log.debug("live: order status read failed", { error: String(error) });
    }
    order.checkAt = now() + (order.role === "stop" && !order.cancelRequested ? STOP_POLL_MS : ORDER_POLL_MS);
    if (`${order.status}/${order.filledQty}/${order.averagePrice}` !== before) {
      recount(position);
      save(d, position);
      if (order.status === "REJECTED") event(d, "warn", `${roleName(order)} order for ${position.contract.name} rejected by Dhan: ${order.message ?? "no reason given"}`);
    }
  }

  /** One step for one order: send it, find it, cancel it, or read its state. */
  async function drive(d: Day, position: LivePosition, order: LiveOrder, cancel: boolean) {
    if (order.status === "NEW") return place(d, position, order);
    if (order.status === "SENDING" || isFinal(order)) return;
    if (order.status === "UNKNOWN") {
      if (now() >= order.checkAt) await lookup(d, position, order);
      return;
    }
    if (cancel && !order.cancelRequested && order.orderId) {
      order.cancelRequested = true;
      cancelSentAt.set(order.correlationId, now());
      try {
        await broker.cancel(order.orderId);
      } catch (error) {
        // It may have filled or been cancelled already; its state says which.
        log.debug("live: cancel failed", { error: String(error) });
      }
      order.checkAt = now() + 300;
      save(d, position);
      return;
    }
    if (now() >= order.checkAt) await refresh(d, position, order);
  }

  // --- Positions -------------------------------------------------------------------------------

  function open(d: Day, paper: PaperView, ctx: DeskContext) {
    const holding = d.positions.find((p) => p.state !== "closed");
    if (holding) {
      event(d, "info", `Not bought for real: the pilot holds one position at a time (${holding.contract.name} is still held)`);
      return;
    }
    const quote = ctx.quote(paper.contract.feedKey);
    if (!quote || ctx.marketTime - quote.at > QUOTE_MAX_AGE_MS) {
      event(d, "warn", `Not bought for real: no fresh quote for ${paper.contract.name}`);
      return;
    }
    const ask = quote.ask ?? quote.ltp;
    const tick = paper.contract.tickSize > 0 ? paper.contract.tickSize : 0.05;
    const limit = tickUp(ask + Math.max(ENTRY_MIN_TICKS * tick, ask * ENTRY_ABOVE_ASK), tick);
    const position: LivePosition = {
      id: paper.id,
      runId: ctx.runId ?? "",
      contract: paper.contract,
      quantity: paper.contract.lotSize,
      state: "buying",
      closeReason: null,
      stopFraction: paper.stopFraction,
      orders: [],
      openedAt: null,
      closedAt: null,
      bought: 0,
      buyAverage: null,
      sold: 0,
      sellAverage: null,
      gross: 0,
      charges: 0,
      net: 0,
      mark: quote.bid ?? quote.ltp,
      openGross: 0,
      note: null,
      alert: null,
    };
    position.orders.push(newOrder(position, "entry", { side: "BUY", type: "LIMIT", validity: "IOC", quantity: position.quantity, price: limit, trigger: null }, quote));
    d.positions.push(position);
    d.touched.set(paper.contract.securityId, paper.contract.name);
    save(d, position);
    event(d, "info", `Buying ${position.quantity} ${paper.contract.name} for real: limit ${fmt(limit)}, immediate or cancel (ask ${fmt(quote.ask)}, last ${fmt(quote.ltp)})`);
  }

  function requestClose(d: Day, position: LivePosition, reason: string) {
    if (position.state === "closed" || position.closeReason !== null) return;
    position.closeReason = reason;
    save(d, position);
    if (position.state !== "buying" || position.orders[0]?.filledQty > 0) event(d, "info", `Selling ${position.contract.name} for real: ${reason}`);
  }

  function close(d: Day, position: LivePosition, note: string) {
    position.state = "closed";
    position.closedAt = now();
    position.note = note;
    recount(position);
    save(d, position);
    if (position.bought > 0) {
      event(d, position.net < 0 ? "warn" : "info", `${position.contract.name} closed for real: ${note}. Bought ${position.bought} at ${fmt(position.buyAverage)}, sold ${position.sold} at ${fmt(position.sellAverage)}: ${signedRupees(position.net)} after ${rupees(position.charges)} charges`);
    } else event(d, "info", `${position.contract.name}: ${note}`);
    tableDue = true;
  }

  async function step(d: Day, position: LivePosition) {
    const entry = position.orders[0];
    if (position.state === "buying") {
      if (!isFinal(entry)) {
        await drive(d, position, entry, position.closeReason !== null || now() - entry.createdAt > ENTRY_CANCEL_MS);
        if (!isFinal(entry)) return;
      }
      recount(position);
      if (position.bought > 0) {
        position.state = position.closeReason ? "selling" : "open";
        position.openedAt = now();
        save(d, position);
        event(d, "info", `Bought ${position.bought} ${position.contract.name} for real at ${fmt(position.buyAverage)}`);
      } else {
        const refused = entry.status === "REJECTED" || entry.status === "NOT_PLACED";
        close(d, position, `Not bought: ${entry.message ?? (entry.status === "CANCELLED" ? "nothing traded at the limit" : entry.status.toLowerCase())}`);
        if (refused) turnOff(d, `Dhan refused the buy of ${position.contract.name}: ${entry.message ?? entry.status.toLowerCase()}`);
        return;
      }
    }
    if (position.state === "open") {
      if (position.closeReason === null) return guard(d, position);
      position.state = "selling";
      save(d, position);
    }
    if (position.state === "selling") await sell(d, position);
  }

  /** While open: put Dhan's stop in place, and notice when it sells the position. */
  async function guard(d: Day, position: LivePosition) {
    const held = position.bought - position.sold;
    if (held <= 0) return close(d, position, "Sold");
    const stop = position.orders.find((o) => o.role === "stop");
    if (!stop) {
      if (position.stopFraction === null && now() - (position.openedAt ?? 0) < STOP_WAIT_MS) return;
      const fraction = Math.min(0.9, Math.max(0.01, position.stopFraction ?? DEFAULT_STOP));
      const tick = position.contract.tickSize > 0 ? position.contract.tickSize : 0.05;
      const trigger = tickDown(position.buyAverage! * (1 - fraction), tick);
      const limit = tickDown(trigger * (1 - STOP_LIMIT_BELOW), tick);
      const order = newOrder(position, "stop", { side: "SELL", type: "STOP_LOSS", validity: "DAY", quantity: held, price: limit, trigger }, context?.quote(position.contract.feedKey));
      position.orders.push(order);
      if (limit < tick) {
        order.status = "NOT_PLACED";
        order.message = "Too cheap for a stop order";
        save(d, position);
        return;
      }
      event(d, "info", `Stop at Dhan for ${position.contract.name}: sells ${held} if it trades at ${fmt(trigger)} or lower (limit ${fmt(limit)}), ${(fraction * 100).toFixed(1)}% below the buy${position.stopFraction === null ? " (the paper position has no stop)" : ""}`);
      return place(d, position, order);
    }
    await drive(d, position, stop, false);
    if (position.bought - position.sold <= 0) return close(d, position, "Sold by the stop at Dhan");
    if (isFinal(stop) && stop.status !== "TRADED" && !warnedNoStop.has(position.id)) {
      warnedNoStop.add(position.id);
      event(d, "warn", `No stop rests at Dhan for ${position.contract.name} (${stop.status.toLowerCase()}${stop.message ? `: ${stop.message}` : ""}). The engine's own stop still applies while it runs`);
    }
  }

  /** Selling: Dhan's stop out of the way first, then sell what Dhan says is held, never more. */
  async function sell(d: Day, position: LivePosition) {
    const stop = position.orders.find((o) => o.role === "stop");
    if (stop && !isFinal(stop)) {
      await drive(d, position, stop, true);
      if (!isFinal(stop)) {
        const sentAt = cancelSentAt.get(stop.correlationId);
        if (stop.cancelRequested && sentAt !== undefined && now() - sentAt > STOP_CANCEL_ALERT_MS) {
          position.alert = `Dhan's stop order for ${position.contract.name} won't cancel, so the engine isn't selling (that could sell twice). Check it in the Dhan app.`;
          stop.cancelRequested = false; // Send the cancel again.
          save(d, position);
        }
        return;
      }
      recount(position);
    }
    const held = position.bought - position.sold;
    if (held <= 0) return close(d, position, stop?.status === "TRADED" ? "Sold by the stop at Dhan" : `Sold (${position.closeReason})`);

    const last = position.orders.findLast((o) => o.role === "exit");
    if (last && !isFinal(last)) {
      await drive(d, position, last, now() - last.createdAt > EXIT_WAIT_MS);
      if (isFinal(last)) {
        recount(position);
        if (position.bought - position.sold <= 0) return close(d, position, `Sold (${position.closeReason})`);
      }
      return;
    }

    // Nothing in flight. What does Dhan say is held?
    if (now() < (nextSellAt.get(position.id) ?? 0)) return;
    let atDhan: number;
    try {
      atDhan = heldAtDhan(await broker.positions(), position.contract.securityId);
    } catch (error) {
      nextSellAt.set(position.id, now() + 2_000);
      log.warn("live: could not read Dhan's positions", { error: String(error) });
      return;
    }
    if (position.closeReason === EXIT_ALL) {
      // Dhan is selling it: wait for that, never sell alongside.
      if (atDhan <= 0) return close(d, position, "Sold by Dhan's exit-all; see the Dhan app for the price");
      nextSellAt.set(position.id, now() + 1_000);
      if (now() - (exitAllAt.get(position.id) ?? now()) > EXIT_ALL_WAIT_MS && !position.alert) {
        position.alert = `Dhan's exit-all hasn't sold ${position.contract.name} yet: check the Dhan app.`;
        save(d, position);
      }
      return;
    }
    if (atDhan < held) {
      const reads = (shortReads.get(position.id) ?? 0) + 1;
      shortReads.set(position.id, reads);
      if (reads < POSITION_READS) {
        nextSellAt.set(position.id, now() + 1_000);
        return;
      }
      if (atDhan <= 0) {
        position.alert = `Dhan shows nothing held in ${position.contract.name}, but the engine's orders leave ${held} unsold. Nothing was sold, so as not to sell what isn't held: check the Dhan app.`;
        turnOff(d, `Dhan's positions don't match the engine's orders in ${position.contract.name}`);
        return close(d, position, "Dhan shows no position: nothing sold");
      }
    }
    shortReads.delete(position.id);

    const quantity = Math.min(held, atDhan);
    const tries = position.orders.filter((o) => o.role === "exit").length;
    const quote = context?.quote(position.contract.feedKey);
    const tick = position.contract.tickSize > 0 ? position.contract.tickSize : 0.05;
    const market = tries >= EXIT_BELOW_BID.length || !quote;
    const limit = market ? null : Math.max(tick, tickDown((quote.bid ?? quote.ltp) * (1 - EXIT_BELOW_BID[tries]), tick));
    const order = newOrder(position, "exit", { side: "SELL", type: market ? "MARKET" : "LIMIT", validity: "DAY", quantity, price: limit, trigger: null }, quote);
    position.orders.push(order);
    event(d, "info", `Selling ${quantity} ${position.contract.name} for real (${position.closeReason}): ${market ? "at market" : `limit ${fmt(limit)} (bid ${fmt(quote!.bid)}, last ${fmt(quote!.ltp)})`}`);
    await place(d, position, order);
    if (order.status === "NOT_PLACED" || order.status === "REJECTED") {
      nextSellAt.set(position.id, now() + (tries >= 5 ? 15_000 : 2_000));
      if (tries >= 4 && !position.alert) {
        position.alert = `Dhan refused ${tries + 1} sales of ${position.contract.name} (${order.message ?? order.status.toLowerCase()}). Sell it in the Dhan app.`;
        save(d, position);
      }
    }
  }

  // --- Checks against Dhan ---------------------------------------------------------------------

  /** Once a minute: do Dhan's positions in the contracts traded today match the desk's orders? */
  async function reconcile(d: Day) {
    d.reconciledAt = now();
    const busy = d.positions.some((p) => p.state !== "closed" && p.orders.some((o) => !isFinal(o) && o.role !== "stop"));
    if (busy) {
      d.reconciledAt = now() - RECONCILE_MS + 5_000; // Orders in flight: look again shortly.
      return;
    }
    let list: BrokerPosition[];
    try {
      list = await broker.positions();
    } catch (error) {
      log.warn("live: could not read Dhan's positions to check them", { error: String(error) });
      return;
    }
    const expected = new Map<string, number>();
    for (const p of d.positions) {
      if (p.state === "closed") continue;
      expected.set(p.contract.securityId, (expected.get(p.contract.securityId) ?? 0) + p.bought - p.sold);
    }
    const differences: string[] = [];
    for (const [securityId, name] of d.touched) {
      const atDhan = heldAtDhan(list, securityId);
      const ours = expected.get(securityId) ?? 0;
      if (atDhan !== ours) differences.push(`${name}: Dhan ${atDhan}, engine ${ours}`);
    }
    const others = list.filter((p) => p.netQty !== 0 && !d.touched.has(p.securityId)).map((p) => `${p.tradingSymbol} ${p.netQty > 0 ? "+" : ""}${p.netQty} (${p.productType})`);
    if (others.join() !== d.otherPositions.join()) {
      d.otherPositions = others;
      changed();
    }
    if (differences.length === 0) {
      d.mismatches = 0;
      return;
    }
    d.mismatches += 1;
    // Twice in a row, a minute apart: not a fill still on its way.
    if (d.mismatches >= 2) {
      const text = `Dhan's positions don't match the engine's: ${differences.join("; ")}`;
      if (d.alert !== text) {
        d.alert = text;
        event(d, "error", `${text}. Check the Dhan app`);
      }
      turnOff(d, text);
    }
  }

  function turnOff(d: Day, reason: string) {
    if (!d.on) return;
    d.on = false;
    d.offReason = reason;
    write(d, { kind: "off", at: now(), reason });
    event(d, "warn", `Live trading off: ${reason}. Real positions held are still sold with their paper positions`);
  }

  function checkLoss(d: Day, ctx: DeskContext) {
    if (!d.on || d.lossHit) return;
    const t = totals(d);
    if (t.net + t.open > -ctx.lossLimit) return;
    d.lossHit = true;
    const reason = `Live daily loss limit: ${rupees(t.net + t.open)} against a limit of ${rupees(-ctx.lossLimit)}`;
    turnOff(d, reason);
    options.onLossLimit(reason);
  }

  // --- The loop --------------------------------------------------------------------------------

  async function work() {
    const d = day;
    if (!d) return;
    for (const position of d.positions) {
      if (position.state === "closed") continue;
      try {
        await step(d, position);
      } catch (error) {
        event(d, "error", `${position.contract.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const holding = d.positions.some((p) => p.state !== "closed");
    if ((d.on || holding || d.touched.size > 0) && notAllowed === null && now() - d.reconciledAt >= RECONCILE_MS) await reconcile(d);
    if (tableDue && !tableWrite) {
      tableDue = false;
      tableWrite = writeTable(d).finally(() => {
        tableWrite = null;
      });
    }
  }

  function kick() {
    if (working) {
      again = true;
      return;
    }
    working = (async () => {
      try {
        do {
          again = false;
          await work();
        } while (again);
      } catch (error) {
        log.error("live: step failed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
      } finally {
        working = null;
      }
    })();
  }

  // --- The day's orders as a table -------------------------------------------------------------

  const ORDERS: Columns = {
    date: "VARCHAR",
    run_id: "VARCHAR",
    position_id: "VARCHAR",
    contract: "VARCHAR",
    security_id: "VARCHAR",
    role: "VARCHAR",
    side: "VARCHAR",
    order_type: "VARCHAR",
    validity: "VARCHAR",
    quantity: "INTEGER",
    price: "DOUBLE",
    trigger_price: "DOUBLE",
    status: "VARCHAR",
    filled_qty: "INTEGER",
    average_price: "DOUBLE",
    message: "VARCHAR",
    bid: "DOUBLE",
    ask: "DOUBLE",
    ltp: "DOUBLE",
    correlation_id: "VARCHAR",
    order_id: "VARCHAR",
    created_at: "DOUBLE",
    updated_at: "DOUBLE",
    close_reason: "VARCHAR",
    position_net: "DOUBLE",
  };

  async function writeTable(d: Day) {
    if (!options.table) return;
    const rows: Row[] = d.positions.flatMap((p) =>
      p.orders.map((o) => ({
        date: d.date,
        run_id: p.runId,
        position_id: p.id,
        contract: p.contract.name,
        security_id: p.contract.securityId,
        role: o.role,
        side: o.side,
        order_type: o.type,
        validity: o.validity,
        quantity: o.quantity,
        price: o.price,
        trigger_price: o.trigger,
        status: o.status,
        filled_qty: o.filledQty,
        average_price: o.averagePrice,
        message: o.message,
        bid: o.bid,
        ask: o.ask,
        ltp: o.ltp,
        correlation_id: o.correlationId,
        order_id: o.orderId,
        created_at: o.createdAt,
        updated_at: o.updatedAt,
        close_reason: p.closeReason,
        position_net: p.net,
      })),
    );
    if (rows.length === 0) return;
    try {
      await options.table.store.write(`trading/${options.table.namespace}/live-orders/${d.date}.parquet`, ORDERS, rows);
    } catch (error) {
      log.warn("live: could not save the orders table; the local file has them", { error: String(error) });
    }
  }

  // --- The desk --------------------------------------------------------------------------------

  function status(): LiveStatus {
    const d = day;
    return {
      allowed: notAllowed === null,
      notAllowed,
      on: d?.on ?? false,
      date: d?.date ?? null,
      since: d?.since ?? null,
      offReason: d?.offReason ?? null,
      lossLimit: d?.lossLimit ?? null,
      checks: d?.checks ?? null,
      positions: d ? [...d.positions].reverse() : [],
      totals: totals(d),
      events: d ? d.events.slice(-100).reverse() : [],
      alert: alert(),
      otherPositions: d?.otherPositions ?? [],
    };
  }

  function alert(): string | null {
    const d = day;
    if (!d) return null;
    return d.positions.findLast((p) => p.alert !== null)?.alert ?? d.alert;
  }

  /** "Trade live today": the checks, then Dhan's kill switch and P&L exit, then live is on. */
  async function switchOn(d: Day | null, date: string, ctx: DeskContext): Promise<TradingCommandResult> {
    if (notAllowed) return { ok: false, message: notAllowed };
    if (!d) return { ok: false, message: "The live desk is still opening today's records. Try again in a moment." };
    if (date !== ctx.date) return { ok: false, message: `That was for ${date}, but today is ${ctx.date}. Reload the page.` };
    if (!ctx.ready) return { ok: false, message: "Live can be switched on once today's live run has started (20 minutes before the open) and loaded its contracts." };
    if (d.on) return { ok: true, message: "Live trading is already on today." };
    if (switching) return { ok: false, message: "Live trading is already being switched on." };
    switching = true;
    try {
      let killSwitch: string;
      try {
        killSwitch = (await broker.killSwitch()).toUpperCase();
      } catch (error) {
        return { ok: false, message: `Live stays off: Dhan's kill switch couldn't be read (${error instanceof Error ? error.message : String(error)}).` };
      }
      if (killSwitch === "ACTIVATE" || killSwitch === "ACTIVE") return { ok: false, message: "Live stays off: Dhan's kill switch is on, so the account can't trade today." };
      let pnlExit: string;
      try {
        pnlExit = await broker.setLossExit(ctx.lossLimit);
      } catch (error) {
        return { ok: false, message: `Live stays off: Dhan's P&L exit couldn't be set (${error instanceof Error ? error.message : String(error)}).` };
      }
      const [balance, ip] = await Promise.all([broker.balance().catch(() => null), broker.whitelistedIp().catch(() => null)]);
      Object.assign(d, { on: true, since: now(), offReason: null, lossLimit: ctx.lossLimit, checks: { pnlExit, balance, ip }, lossHit: false, mismatches: 0, alert: null });
      write(d, { kind: "on", at: now(), lossLimit: ctx.lossLimit, checks: d.checks });
      event(
        d,
        "info",
        `Live trading on for ${ctx.date}: each paper entry also buys one lot at Dhan, one position at a time. Dhan's P&L exit set at a loss of ${rupees(ctx.lossLimit)} with the kill switch (${pnlExit})${balance !== null ? `; ${rupees(balance)} available` : ""}`,
      );
      if (!ip) event(d, "warn", "Dhan shows no whitelisted IP for this account: orders will be refused until this server's IP is whitelisted in Dhan Web");
      kick();
      return { ok: true, message: `Live trading is on for today. Dhan's P&L exit is set at a loss of ${rupees(ctx.lossLimit)}.${ip ? "" : " Dhan shows no whitelisted IP yet: orders will be refused until it does."}` };
    } finally {
      switching = false;
    }
  }

  return {
    update(ctx) {
      context = ctx;
      try {
        if (!day || day.date !== ctx.date) {
          loading ??= openDay(ctx.date)
            .catch((error: unknown) => log.error("live: could not open the day", { error: String(error) }))
            .finally(() => {
              loading = null;
              kick();
            });
          return;
        }
        if (loading) return;
        const d = day;
        for (const position of d.positions) {
          if (position.state === "closed") continue;
          const quote = ctx.quote(position.contract.feedKey);
          if (quote) {
            position.mark = quote.bid ?? quote.ltp;
            recount(position);
          }
        }
        if (ctx.ready) {
          const paper = new Map(ctx.positions.map((p) => [p.id, p]));
          for (const p of ctx.positions) {
            if (d.seen.has(p.id)) continue;
            d.seen.add(p.id);
            if (p.status === "opening" && d.on && notAllowed === null) open(d, p, ctx);
          }
          for (const position of d.positions) {
            if (position.state === "closed" || position.closeReason !== null) continue;
            const p = paper.get(position.id);
            if (!p) requestClose(d, position, "its paper position is gone");
            else if (p.status === "closing") requestClose(d, position, p.exitReason ?? "sold on paper");
            else if (p.stopFraction !== null) position.stopFraction = p.stopFraction;
          }
        }
        checkLoss(d, ctx);
        kick();
      } catch (error) {
        log.error("live: update failed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
      }
    },

    runEnded(reason) {
      const d = day;
      if (!d) return;
      for (const position of d.positions) requestClose(d, position, `the live run ended: ${reason}`);
      kick();
    },

    async command(command, ctx) {
      context = ctx;
      if (loading) await loading;
      const d = day && day.date === ctx.date ? day : null;
      switch (command.action) {
        case "live-on": {
          const result = await switchOn(d, command.date, ctx);
          // A refusal otherwise reaches only the page that asked; kept here, Dhan's answer can be read later.
          if (!result.ok) {
            if (d) event(d, "warn", `Not switched on: ${result.message}`);
            else log.warn(`live: not switched on: ${result.message}`);
          }
          return result;
        }
        case "live-off": {
          if (!d?.on) return { ok: true, message: "Live trading is already off." };
          turnOff(d, "Switched off by you");
          return { ok: true, message: "Live trading is off. Real positions held are still sold with their paper positions." };
        }
        case "live-exit-all": {
          if (notAllowed) return { ok: false, message: notAllowed };
          let answer: string;
          try {
            answer = await broker.exitAll();
          } catch (error) {
            return { ok: false, message: `Dhan's exit-all failed (${error instanceof Error ? error.message : String(error)}). Sell in the Dhan app.` };
          }
          if (d) {
            event(d, "warn", `Exit all at Dhan, by you: ${answer}`);
            turnOff(d, "Exit all at Dhan, by you");
            for (const position of d.positions) {
              if (position.state === "closed") continue;
              // Dhan sells and cancels: the desk only follows, so nothing is sold twice.
              position.closeReason = EXIT_ALL;
              exitAllAt.set(position.id, now());
              save(d, position);
            }
            kick();
          }
          return { ok: true, message: `Dhan: ${answer}. Every position in the account is being sold and open orders cancelled; live trading is off.` };
        }
        default:
          return { ok: false, message: "Unknown live command." };
      }
    },

    status,

    summary() {
      const d = day;
      if (!d) return null;
      const holding = d.positions.filter((p) => p.state !== "closed").length;
      const a = alert();
      if (!d.on && holding === 0 && !a) return null;
      const t = totals(d);
      return { on: d.on, date: d.date, holding, net: t.net + t.open, alert: a };
    },

    alert,

    async stop() {
      await working;
      await tableWrite;
      if (day && tableDue) await writeTable(day);
      const file = day?.file;
      if (file) await new Promise<void>((resolve) => file.end(() => resolve()));
      if (day) day.file = null;
    },

    async idle() {
      for (let i = 0; i < 100; i += 1) {
        if (!working && !loading && !tableWrite) return;
        await Promise.all([working, loading, tableWrite]);
      }
    },
  };
}
