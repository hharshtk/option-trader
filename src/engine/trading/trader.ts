// The trading engine: signal → proposal → decision → risk → order → fill → P&L after charges.
// It trades on paper. Everything it sees comes from the engine's feed, live from Dhan or a
// recorded day replayed through it, so a replayed day trades the way the live day would.
//
//   every frame      update quotes; fill orders that are due; check stops, targets and the clock
//   every minute     read the signals at the close (Pulse), sell on an opposite signal, and if the
//                    followed signal fired, propose an entry
//   a proposal       quiet checks (armed, window, limits) → contract → fresh quote → premium and
//                    spread limits → the decision API → a buy order on the paper book, or on the
//                    shadow book when the decision gate turned it down
//   a position       sold on its stop, its target, its hold time, an opposite signal, the
//                    square-off time, a halt or a manual flatten
//
// A "run" is one market day traded from one source. A live day has one run, which a restarted
// engine continues from its log; each replay start or seek begins a new run. State lives in
// memory, every change is appended to the run's log on disk (run-log.ts), and the run's tables are
// saved as Parquet (store.ts).

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { INDEX } from "../../lib/dhan/instruments.ts";
import type { JournalSession } from "../../lib/engine/protocol.ts";
import {
  DEFAULT_TRADING_CONFIG,
  mergeTradingConfig,
  type Book,
  type BookTotals,
  type ContractsStatus,
  type DecisionRecord,
  type DecisionRequest,
  type DecisionScore,
  type ExitReason,
  type Intent,
  type OptionRef,
  type Order,
  type Position,
  type RunInfo,
  type SignalReading,
  type Trade,
  type TradingCommandResult,
  type TradingConfig,
  type TradingEvent,
  type TradingHistory,
  type TradingStatus,
  type TradingUpdate,
} from "../../lib/engine/trading.ts";
import { computePulse, type Pulse } from "../../lib/insight/pulse.ts";
import type { FeedHub } from "../../lib/live/feed/feed-hub.ts";
import { parseFrame, parseInstrumentKey, type Instrument } from "../../lib/live/feed/packets.ts";
import { addCharges, NO_CHARGES, orderCharges, roundTripCharges } from "../../lib/trading/charges.ts";
import type { SessionCalendar } from "../market/session-calendar.ts";
import type { Health } from "../telemetry/health.ts";
import type { Logger } from "../telemetry/logger.ts";
import { daysBetween, pickContract, pickExpiry, windowContracts, type ContractBook } from "./contracts.ts";
import { buildDecisionState, decisionKey, judge, QUESTIONS, type DecisionAnswer, type DecisionProvider } from "./decision.ts";
import { createMarketView, type MarketQuote } from "./market.ts";
import { fillOrder } from "./paper-broker.ts";
import { openRunLog, readRunLog, type RunLog, type RunRecord } from "./run-log.ts";
import type { TradingStore } from "./store.ts";
import { NIFTY_CONSTITUENTS, readSignal } from "./strategy.ts";

const NIFTY_KEY = `IDX_I:${INDEX.NIFTY.securityId}`;
const SEGMENT = "NSE_FNO";
const MINUTE_MS = 60_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
/** Signals are read this long after a minute closes, once its last ticks are in. */
const EVALUATION_DELAY_MS = 1_500;
/** A live run starts this long before the open, to load contracts and subscribe options. */
const PREPARE_LEAD_MS = 20 * MINUTE_MS;
const RUN_END_GRACE_MS = MINUTE_MS;
/** An entry that can't fill within this is dropped; the moment has passed. */
const ENTRY_FILL_TIMEOUT_MS = 15_000;
/** An exit that has waited this long for a fresh quote fills against the last one. */
const EXIT_FILL_TIMEOUT_MS = MINUTE_MS;
/** A candle close older than this is no price to trade on. */
const CANDLE_STALE_MS = 3 * MINUTE_MS;
const SAVE_EVERY_MS = 60_000;
const SAVE_AFTER_TRADE_MS = 3_000;
const CONTRACT_RETRY_MS = 5 * MINUTE_MS;
const PUBLISH_EVERY_MS = 5_000;
const LIST_CAP = 200;

/** A 1-minute candle: start of the minute, open, high, low, close. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface ReplayPosition {
  date: string;
  /** Recorded time reached. */
  at: number;
  /** Increases on every start and seek. */
  jumps: number;
  speed: number;
  ended: boolean;
}

export interface TraderOptions {
  /** Keeps this engine's records apart from another engine's in the same bucket. */
  namespace: string;
  /** Local folder for settings, run logs and recorded decision answers. */
  directory: string;
  version: string;
  calendar: SessionCalendar;
  log: Logger;
  health: Pick<Health, "set">;
  /** Wall clock, ms. */
  now: () => number;
  store: TradingStore;
  /** The feed now running, live or replay; null while it restarts. */
  hub: () => Pick<FeedHub, "acquire" | "release"> | null;
  /** Where the replay is; null when the feed is live. */
  replay: () => ReplayPosition | null;
  /** Pauses a fast replay until the returned function is called, so slow work costs no market time. */
  hold: () => () => void;
  /** The day so far, decoded from the journal: what the Pulse page reads. */
  session: (date: string) => Promise<JournalSession | null>;
  decisions: DecisionProvider;
  loadContracts: (marketDate: string, live: boolean) => Promise<{ book: ContractBook | null; problem: string | null }>;
  /** 1-minute candles for a contract on a day, for replays of days recorded without options. */
  loadCandles: (contract: OptionRef, date: string) => Promise<Candle[]>;
  /** Sends the status to the web: the lists only when they changed since the last call. */
  publish: (update: TradingUpdate) => void;
}

export interface Trader {
  /** Loads the saved settings. */
  start(): Promise<void>;
  /** Every frame the feed delivers, with its time on the market's clock. Never throws. */
  onFrame(frame: ArrayBuffer | ArrayBufferView, at: number): void;
  /** Call once a second. */
  tick(): void;
  status(): TradingStatus;
  command(body: unknown): Promise<TradingCommandResult>;
  history(run: string | null): Promise<TradingHistory>;
  /** What was sent to the decision API for one of the current run's decisions, or null when there is no such decision. */
  decisionRequest(id: string): DecisionRequest | null;
  /** Saves and closes the current run. Open positions stay open for a restart to pick up. */
  stop(): Promise<void>;
  /** Resolves when no evaluation, save or run change is in flight. For tests. */
  idle(): Promise<void>;
}

interface ActiveRun {
  info: RunInfo;
  session: { open: number; close: number };
  log: RunLog;
  /** Replay position counter this run belongs to. */
  jumps: number;
  ready: boolean;
  book: ContractBook | null;
  expiry: string | null;
  contractsProblem: string | null;
  contractsCheckedAt: number;
  intents: Intent[];
  decisions: DecisionRecord[];
  /** The context sent with each decision, by decision id. */
  states: Map<string, unknown>;
  orders: Order[];
  positions: Position[];
  trades: Trade[];
  events: TradingEvent[];
  halt: { reason: string; at: number } | null;
  signal: SignalReading | null;
  lastEvaluated: number;
  evaluating: boolean;
  queuedMinute: number | null;
  ids: number;
  subscribed: Map<string, Instrument>;
  subscribedOn: object | null;
  atmStrike: number | null;
  /** Contracts priced from candles, each with the index of its next candle to play. */
  candleFeeds: Map<string, { candles: Candle[]; next: number }>;
  /** Answers recorded for this market day, by proposal. */
  answers: Map<string, { answer: DecisionAnswer; latencyMs: number }>;
  lastExitAt: number | null;
  pendingSave: number;
  saveDueAt: number;
  savedAt: number | null;
  saveError: string | null;
  staleWarned: Set<string>;
}

const rupees = (value: number) => `${value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedRupees = (value: number) => (value >= 0 ? `+${rupees(value)}` : rupees(value));
const price = (value: number) => value.toFixed(2);
const istClock = (time: number) => new Date(time + IST_OFFSET_MS).toISOString().slice(11, 19);

function emptyTotals(): BookTotals {
  return { trades: 0, wins: 0, gross: 0, charges: 0, net: 0, open: 0, maxDrawdown: 0 };
}

export function createTrader(options: TraderOptions): Trader {
  const { namespace, directory, version, calendar, log, health, now, store, decisions } = options;
  const market = createMarketView();
  const configFile = path.join(directory, "config.json");

  let config: TradingConfig = structuredClone(DEFAULT_TRADING_CONFIG);
  let revision = 0;
  // Starts from the clock so a restarted engine never repeats a value a page already holds.
  let listsRevision = now();
  let publishedRevision = -1;
  let publishedLists = -1;
  let publishedAt = 0;
  let run: ActiveRun | null = null;
  /** The run that last ended, still shown until the next one starts. */
  let ended: ActiveRun | null = null;
  /** A run being started or ended; frames only update quotes meanwhile. */
  let changing: Promise<void> | null = null;
  /** The run that last ended, so the same day isn't started again. */
  let finished: { source: string; date: string; jumps: number } | null = null;
  let marketTime = 0;
  let saving: Promise<void> | null = null;
  let evaluation: Promise<void> | null = null;
  let lastStorage: { savedAt: number | null; error: string | null } = { savedAt: null, error: null };

  const touch = () => {
    revision += 1;
  };

  // --- Records ---------------------------------------------------------------------------------

  function record(active: ActiveRun, entry: RunRecord) {
    active.log.append(entry);
    active.pendingSave += 1;
    listsRevision += 1;
    touch();
  }

  function event(active: ActiveRun, kind: TradingEvent["kind"], message: string, level: TradingEvent["level"] = "info") {
    const entry: TradingEvent = { at: marketTime, wall: now(), level, kind, message };
    active.events.push(entry);
    if (active.events.length > LIST_CAP) active.events.shift();
    active.log.append({ kind: "event", event: entry });
    log[level](message, { run: active.info.id, at: istClock(marketTime) });
    listsRevision += 1;
    touch();
  }

  function upsert<T extends { id: string }>(list: T[], item: T) {
    const index = list.findIndex((existing) => existing.id === item.id);
    if (index === -1) list.push(item);
    else list[index] = item;
  }

  const nextId = (active: ActiveRun, prefix: string) => `${prefix}${++active.ids}`;

  // --- Settings --------------------------------------------------------------------------------

  async function saveConfig() {
    await mkdir(directory, { recursive: true });
    await writeFile(`${configFile}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
    await rename(`${configFile}.tmp`, configFile);
  }

  /** IST HH:MM on the run's day, as market time. */
  function timeOn(active: ActiveRun, hhmm: string) {
    const [hours, minutes] = hhmm.split(":").map(Number);
    return Date.parse(`${active.info.date}T00:00:00Z`) + (hours * 60 + minutes) * MINUTE_MS - IST_OFFSET_MS;
  }

  // --- Totals ----------------------------------------------------------------------------------

  function totalsFor(active: ActiveRun, book: Book): BookTotals {
    const totals = emptyTotals();
    let peak = 0;
    for (const trade of active.trades) {
      if (trade.book !== book) continue;
      totals.trades += 1;
      if (trade.net > 0) totals.wins += 1;
      totals.gross += trade.gross;
      totals.charges += trade.charges.total;
      totals.net += trade.net;
      peak = Math.max(peak, totals.net);
      totals.maxDrawdown = Math.max(totals.maxDrawdown, peak - totals.net);
    }
    for (const position of active.positions) {
      if (position.book === book && position.status !== "opening") totals.open += position.unrealisedNet;
    }
    return totals;
  }

  function decisionScore(active: ActiveRun): DecisionScore {
    const score: DecisionScore = { asked: 0, approved: 0, vetoed: 0, failed: 0, approvedTrades: 0, approvedNet: 0, vetoedTrades: 0, vetoedNet: 0, meanLatencyMs: null };
    const byId = new Map(active.decisions.map((d) => [d.id, d]));
    let latency = 0;
    let timed = 0;
    for (const decision of active.decisions) {
      score.asked += 1;
      if (decision.error) score.failed += 1;
      else if (decision.approved) score.approved += 1;
      else score.vetoed += 1;
      if (!decision.error && !decision.cached) {
        latency += decision.latencyMs;
        timed += 1;
      }
    }
    for (const trade of active.trades) {
      const decision = trade.decisionId ? byId.get(trade.decisionId) : undefined;
      if (!decision || decision.error) continue;
      if (decision.approved) {
        score.approvedTrades += 1;
        score.approvedNet += trade.net;
      } else {
        score.vetoedTrades += 1;
        score.vetoedNet += trade.net;
      }
    }
    score.meanLatencyMs = timed > 0 ? Math.round(latency / timed) : null;
    return score;
  }

  function consecutiveLosses(active: ActiveRun) {
    let losses = 0;
    for (let i = active.trades.length - 1; i >= 0; i -= 1) {
      const trade = active.trades[i];
      if (trade.book !== "paper") continue;
      if (trade.net > 0) break;
      losses += 1;
    }
    return losses;
  }

  // --- Saving ----------------------------------------------------------------------------------

  function save(active: ActiveRun, ended: boolean): Promise<void> {
    const work = (saving ?? Promise.resolve()).then(async () => {
      const pending = active.pendingSave;
      try {
        await store.save({
          run: active.info,
          status: ended ? "ended" : "running",
          config,
          engineVersion: version,
          totals: { paper: totalsFor(active, "paper"), shadow: totalsFor(active, "shadow") },
          trades: active.trades,
          orders: active.orders,
          intents: active.intents,
          decisions: active.decisions,
          states: active.states,
        });
        active.pendingSave = Math.max(0, active.pendingSave - pending);
        active.savedAt = now();
        active.saveError = null;
      } catch (error) {
        active.saveError = error instanceof Error ? error.message.split("\n")[0] : String(error);
        log.warn("could not save the run's tables; the local log has everything and the next save retries", { run: active.info.id, error: active.saveError });
      }
      lastStorage = { savedAt: active.savedAt, error: active.saveError };
      active.saveDueAt = now() + SAVE_EVERY_MS;
      touch();
    });
    saving = work;
    void work.finally(() => {
      if (saving === work) saving = null;
    });
    return work;
  }

  // --- Subscriptions ---------------------------------------------------------------------------

  /** Keeps the option window around the money, and every held contract, subscribed in Full mode. */
  function subscribe(active: ActiveRun) {
    const hub = options.hub();
    if (!hub) return;
    if (active.subscribedOn !== hub) {
      // A new feed (live or replay switched): nothing we subscribed carries over.
      active.subscribed.clear();
      active.subscribedOn = hub;
    }
    const wanted: OptionRef[] = active.positions.map((p) => p.contract);
    const spot = market.get(NIFTY_KEY)?.ltp;
    if (active.book && active.expiry && spot && (config.recordOptions || config.armed)) {
      const chain = active.book.chain(active.expiry);
      wanted.push(...windowContracts(chain, spot, config.windowStrikes));
      active.atmStrike = pickContract(chain, spot, 1, 0)?.strike ?? null;
    }
    const added: Instrument[] = [];
    for (const contract of wanted) {
      if (active.subscribed.has(contract.feedKey)) continue;
      const instrument = parseInstrumentKey(contract.feedKey);
      if (!instrument) continue;
      active.subscribed.set(contract.feedKey, instrument);
      added.push(instrument);
    }
    if (added.length > 0) {
      hub.acquire(added, "full");
      touch();
    }
  }

  function unsubscribe(active: ActiveRun) {
    const hub = options.hub();
    if (hub && active.subscribedOn === hub && active.subscribed.size > 0) hub.release([...active.subscribed.values()]);
    active.subscribed.clear();
  }

  // --- Runs ------------------------------------------------------------------------------------

  async function loadContracts(active: ActiveRun) {
    active.contractsCheckedAt = now();
    try {
      const { book, problem } = await options.loadContracts(active.info.date, active.info.source === "live");
      if (run !== active) return;
      const expiry = book ? pickExpiry(book, active.info.date, config.strategy.minDaysToExpiry) : null;
      const changed = active.book?.fileDate !== book?.fileDate || active.expiry !== expiry || active.contractsProblem !== problem;
      active.book = book;
      active.expiry = expiry;
      active.contractsProblem = problem ?? (book && !expiry ? `No NIFTY expiry at least ${config.strategy.minDaysToExpiry} days away` : null);
      if (changed) {
        if (book && expiry) {
          event(active, "contracts", `Contracts from the ${book.fileDate} instrument file: expiry ${expiry}, lot ${book.chain(expiry)[0]?.CE?.lotSize ?? book.chain(expiry)[0]?.PE?.lotSize ?? "?"}`);
        }
        if (active.contractsProblem) event(active, "contracts", active.contractsProblem, "warn");
      }
    } catch (error) {
      if (run !== active) return;
      active.contractsProblem = `Could not load option contracts: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
      event(active, "contracts", active.contractsProblem, "warn");
    }
    active.ready = true;
    subscribe(active);
    touch();
  }

  async function beginRun(source: "live" | "replay", date: string, session: { open: number; close: number }, jumps: number) {
    const wall = now();
    const stamp = new Date(wall + IST_OFFSET_MS).toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const id = source === "live" ? `live-${date}` : `replay-${date}-${stamp}`;
    const file = path.join(directory, "runs", `${id}.jsonl`);
    // A live day continues from its log when the engine restarted mid-session.
    const previous = source === "live" ? await readRunLog(file).catch(() => null) : null;
    const info: RunInfo = previous?.run
      ? { ...previous.run, endedAt: null, resumed: true }
      : { id, namespace, mode: "paper", source, date, startedAt: wall, endedAt: null, resumed: false };

    const active: ActiveRun = {
      info,
      session,
      log: openRunLog(file, (error) => log.error("run log write failed", { error: error.message })),
      jumps,
      ready: false,
      book: null,
      expiry: null,
      contractsProblem: null,
      contractsCheckedAt: 0,
      intents: previous?.intents ?? [],
      decisions: previous?.decisions ?? [],
      states: previous?.states ?? new Map(),
      orders: previous?.orders ?? [],
      // An entry that hadn't filled is dropped; a position being sold goes back to open and is sold again.
      positions: (previous?.positions ?? []).filter((p) => p.status !== "opening").map((p) => ({ ...p, status: "open" as const })),
      trades: previous?.trades ?? [],
      events: (previous?.events ?? []).slice(-LIST_CAP),
      halt: previous?.halt ?? null,
      signal: null,
      lastEvaluated: 0,
      evaluating: false,
      queuedMinute: null,
      ids: 0,
      subscribed: new Map(),
      subscribedOn: null,
      atmStrike: null,
      candleFeeds: new Map(),
      answers: new Map(),
      lastExitAt: null,
      pendingSave: 0,
      saveDueAt: wall + SAVE_EVERY_MS,
      savedAt: null,
      saveError: null,
      staleWarned: new Set(),
    };
    // Ids continue after the highest one in the log.
    for (const item of [...active.intents, ...active.decisions, ...active.orders, ...active.positions, ...active.trades]) {
      active.ids = Math.max(active.ids, Number(item.id.slice(1)) || 0);
    }
    for (const order of active.orders) {
      if (order.status === "pending") upsert(active.orders, { ...order, status: "cancelled", note: "The engine restarted before it filled" });
    }
    active.lastExitAt = active.trades.filter((t) => t.book === "paper").at(-1)?.closedAt ?? null;
    for (const [key, value] of await readAnswers(date)) active.answers.set(key, value);

    run = active;
    ended = null;
    active.log.append({ kind: "run", run: info });
    event(
      active,
      "run",
      previous?.run
        ? `Continuing ${id}: ${active.trades.length} trades so far, ${active.positions.length} open`
        : `Started ${id}: paper trading ${source === "live" ? "the live market" : `a replay of ${date}`}`,
    );
    await loadContracts(active);
  }

  /** Sells what is open at the last known prices and closes the run. */
  async function endRun(active: ActiveRun, reason: string, flatten: boolean) {
    if (flatten) {
      for (const position of [...active.positions]) {
        if (position.status === "opening") continue;
        const quote = market.get(position.contract.feedKey);
        if (!quote || quote.at === 0) continue;
        const order = exitOrder(active, position, "square-off", null, marketTime);
        applyFill(active, fillOrder(order, quote, marketTime, config.fills));
      }
    }
    active.info = { ...active.info, endedAt: now() };
    active.log.append({ kind: "run", run: active.info });
    event(active, "run", `Ended ${active.info.id}: ${reason}. ${summary(active)}`);
    unsubscribe(active);
    await save(active, flatten);
    await active.log.close();
    if (run === active) run = null;
    ended = active;
    finished = { source: active.info.source, date: active.info.date, jumps: active.jumps };
    touch();
  }

  function summary(active: ActiveRun) {
    const paper = totalsFor(active, "paper");
    return `${paper.trades} trades, ${paper.wins} won, ${signedRupees(paper.net)} after ${rupees(paper.charges)} of charges`;
  }

  // --- Recorded decision answers ---------------------------------------------------------------

  const answersFile = (date: string) => path.join(directory, "decisions", `${date}.jsonl`);

  async function readAnswers(date: string) {
    const found = new Map<string, { answer: DecisionAnswer; latencyMs: number }>();
    try {
      for (const line of (await readFile(answersFile(date), "utf8")).split("\n")) {
        if (!line) continue;
        try {
          const { key, answer, latencyMs } = JSON.parse(line) as { key: string; answer: DecisionAnswer; latencyMs: number };
          found.set(key, { answer, latencyMs });
        } catch {
          // A half-written last line.
        }
      }
    } catch {
      // No answers recorded for this day yet.
    }
    return found;
  }

  async function rememberAnswer(date: string, key: string, answer: DecisionAnswer, latencyMs: number) {
    try {
      await mkdir(path.dirname(answersFile(date)), { recursive: true });
      await appendFile(answersFile(date), `${JSON.stringify({ key, answer, latencyMs })}\n`);
    } catch (error) {
      log.warn("could not record a decision answer for replays", { error: String(error) });
    }
  }

  // --- Orders and fills ------------------------------------------------------------------------

  function refreshMark(position: Position, quote: MarketQuote) {
    // A long option is worth what it can be sold for: the bid when the book is known.
    position.mark = quote.bid ?? quote.ltp;
    position.markAt = quote.at;
    position.unrealisedGross = (position.mark - position.entryPrice) * position.quantity;
    position.unrealisedNet = position.unrealisedGross - position.entryCharges.total - orderCharges("SELL", position.mark * position.quantity).total;
  }

  function exitOrder(active: ActiveRun, position: Position, reason: ExitReason, trigger: number | null, at: number): Order {
    position.status = "closing";
    const order: Order = {
      id: nextId(active, "o"),
      book: position.book,
      positionId: position.id,
      side: "SELL",
      reason,
      contract: position.contract,
      quantity: position.quantity,
      status: "pending",
      at,
      fillAfter: at + config.fills.latencyMs,
      trigger,
      filledAt: null,
      price: null,
      priceSource: null,
      ltp: null,
      bid: null,
      ask: null,
      value: null,
      charges: null,
      note: null,
    };
    active.orders.push(order);
    record(active, { kind: "order", order });
    record(active, { kind: "position", position });
    return order;
  }

  /** Starts selling a position. Against a candle the fill is immediate, at the level that triggered it. */
  function exit(active: ActiveRun, position: Position, reason: ExitReason, trigger: number | null, at: number) {
    if (position.status !== "open") return;
    const order = exitOrder(active, position, reason, trigger, at);
    const quote = market.get(position.contract.feedKey);
    if (quote && quote.candleOpen !== null) applyFill(active, fillOrder(order, quote, at, config.fills));
  }

  function applyFill(active: ActiveRun, order: Order) {
    upsert(active.orders, order);
    record(active, { kind: "order", order });
    const position = active.positions.find((p) => p.id === order.positionId);
    if (!position || order.price === null || order.charges === null || order.filledAt === null) return;
    const against =
      order.priceSource === "book" ? `book ${price(order.bid ?? 0)}/${price(order.ask ?? 0)}` : order.priceSource === "candle" ? "1-minute candle" : `last price ${price(order.ltp ?? 0)}`;
    const tag = position.book === "shadow" ? "Shadow: " : "";

    if (order.side === "BUY") {
      position.status = "open";
      position.openedAt = order.filledAt;
      position.entryPrice = order.price;
      position.entrySource = order.priceSource ?? "ltp";
      position.entryCharges = order.charges;
      position.spotAtEntry = market.get(NIFTY_KEY)?.ltp ?? null;
      position.stopPrice = config.strategy.stopLossPct > 0 ? order.price * (1 - config.strategy.stopLossPct / 100) : null;
      position.targetPrice = config.strategy.targetPct > 0 ? order.price * (1 + config.strategy.targetPct / 100) : null;
      position.exitBy = order.filledAt + config.strategy.holdMinutes * MINUTE_MS;
      position.mark = order.price;
      position.markAt = order.filledAt;
      position.unrealisedGross = 0;
      position.unrealisedNet = -order.charges.total - orderCharges("SELL", order.price * position.quantity).total;
      record(active, { kind: "position", position });
      event(active, "fill", `${tag}Bought ${position.quantity} ${position.contract.name} at ${price(order.price)} (${against}); charges ${rupees(order.charges.total)}`);
      return;
    }

    const charges = addCharges(position.entryCharges, order.charges);
    const gross = (order.price - position.entryPrice) * position.quantity;
    const trade: Trade = {
      id: position.id,
      book: position.book,
      intentId: position.intentId,
      decisionId: position.decisionId,
      signal: position.signal,
      direction: position.direction,
      contract: position.contract,
      lots: position.lots,
      quantity: position.quantity,
      openedAt: position.openedAt,
      closedAt: order.filledAt,
      entryPrice: position.entryPrice,
      exitPrice: order.price,
      entrySource: position.entrySource,
      exitSource: order.priceSource ?? "ltp",
      exitReason: order.reason === "entry" ? "manual" : order.reason,
      spotAtEntry: position.spotAtEntry,
      spotAtExit: market.get(NIFTY_KEY)?.ltp ?? null,
      gross,
      charges,
      net: gross - charges.total,
    };
    active.positions = active.positions.filter((p) => p.id !== position.id);
    active.trades.push(trade);
    record(active, { kind: "trade", trade });
    event(
      active,
      "trade",
      `${tag}Sold ${trade.quantity} ${trade.contract.name} at ${price(trade.exitPrice)} (${trade.exitReason}, ${against}): ${signedRupees(gross)} before charges, ${rupees(charges.total)} charges, ${signedRupees(trade.net)} net`,
      trade.book === "paper" && trade.net < 0 ? "warn" : "info",
    );
    active.saveDueAt = Math.min(active.saveDueAt, now() + SAVE_AFTER_TRADE_MS);
    if (trade.book === "paper") {
      active.lastExitAt = trade.closedAt;
      checkLimits(active);
    }
  }

  /** Stops the day at the loss limit or after too many losses in a row. */
  function checkLimits(active: ActiveRun) {
    if (active.halt) return;
    const paper = totalsFor(active, "paper");
    if (paper.net + paper.open <= -config.risk.maxDailyLoss) {
      halt(active, `Daily loss limit: ${rupees(paper.net + paper.open)} against a limit of ${rupees(-config.risk.maxDailyLoss)}`);
    } else if (consecutiveLosses(active) >= config.risk.maxConsecutiveLosses) {
      halt(active, `${config.risk.maxConsecutiveLosses} losing trades in a row`);
    }
  }

  function halt(active: ActiveRun, reason: string) {
    active.halt = { reason, at: marketTime };
    record(active, { kind: "halt", halt: active.halt });
    event(active, "halt", `Trading stopped for the day: ${reason}`, "warn");
    for (const position of active.positions) exit(active, position, "halt", null, marketTime);
  }

  function processOrders(active: ActiveRun, at: number) {
    for (const order of active.orders) {
      if (order.status !== "pending" || at < order.fillAfter) continue;
      const quote = market.get(order.contract.feedKey);
      const limit = quote && quote.candleOpen !== null ? CANDLE_STALE_MS : config.risk.maxQuoteAgeSeconds * 1000;
      const fresh = quote !== undefined && quote.at > 0 && at - quote.at <= limit;
      if (fresh) {
        applyFill(active, fillOrder(order, quote, at, config.fills));
      } else if (order.reason === "entry") {
        if (at - order.at > ENTRY_FILL_TIMEOUT_MS) cancelEntry(active, order, "No fresh quote to fill against");
      } else if (quote && quote.at > 0 && at - order.at > EXIT_FILL_TIMEOUT_MS) {
        // Better out on an old price than holding a position that should be closed.
        if (!active.staleWarned.has(order.id)) {
          active.staleWarned.add(order.id);
          event(active, "risk", `${order.contract.name} hasn't traded for ${Math.round((at - quote.at) / 1000)} s; selling against its last price`, "warn");
        }
        applyFill(active, fillOrder(order, quote, at, config.fills));
      }
    }
  }

  function cancelEntry(active: ActiveRun, order: Order, note: string) {
    const cancelled: Order = { ...order, status: "cancelled", note };
    upsert(active.orders, cancelled);
    record(active, { kind: "order", order: cancelled });
    active.positions = active.positions.filter((p) => p.id !== order.positionId);
    const intent = active.intents.find((i) => i.positionId === order.positionId);
    if (intent) {
      Object.assign(intent, { outcome: "rejected", reason: note, positionId: null });
      record(active, { kind: "intent", intent });
    }
    event(active, "order", `Entry in ${order.contract.name} dropped: ${note}`, "warn");
  }

  // --- Quotes and the clock --------------------------------------------------------------------

  function onQuote(active: ActiveRun, quote: MarketQuote, at: number) {
    for (const position of active.positions) {
      if (position.contract.feedKey !== quote.key || position.status === "opening") continue;
      refreshMark(position, quote);
      if (position.status !== "open") continue;
      // Stops and targets trigger on the traded price, as a broker's stop order does.
      if (position.stopPrice !== null && quote.ltp <= position.stopPrice) exit(active, position, "stop", position.stopPrice, at);
      else if (position.targetPrice !== null && quote.ltp >= position.targetPrice) exit(active, position, "target", position.targetPrice, at);
    }
  }

  /** Plays the candles that have closed by `at` as ticks: open, low, high, close. */
  function playCandles(active: ActiveRun, at: number) {
    for (const [key, feed] of active.candleFeeds) {
      while (feed.next < feed.candles.length && feed.candles[feed.next].t + MINUTE_MS <= at) {
        const candle = feed.candles[feed.next];
        feed.next += 1;
        const end = candle.t + MINUTE_MS;
        // Low before high: when one minute holds both a stop and a target, assume the stop came first.
        for (const tick of [candle.o, candle.l, candle.h, candle.c]) onQuote(active, market.applyCandle(key, tick, candle.o, end), end);
      }
    }
  }

  function advance(active: ActiveRun, at: number) {
    if (at > marketTime) marketTime = at;
    if (!active.ready) return;
    if (active.candleFeeds.size > 0) playCandles(active, at);

    const squareOff = timeOn(active, config.risk.squareOffAt);
    for (const position of active.positions) {
      if (position.status !== "open") continue;
      if (at >= squareOff) exit(active, position, "square-off", null, at);
      else if (at >= position.exitBy) exit(active, position, "time", null, at);
    }
    processOrders(active, at);

    // The minute that had closed EVALUATION_DELAY_MS ago.
    const closed = Math.floor((at - EVALUATION_DELAY_MS - active.session.open) / MINUTE_MS) - 1;
    if (closed < 0) return;
    const minute = active.session.open + closed * MINUTE_MS;
    if (minute <= active.lastEvaluated || minute >= active.session.close) return;
    if (active.evaluating) active.queuedMinute = minute;
    else startEvaluation(active, minute);
  }

  // --- The minute: signals, exits on an opposite signal, entries -------------------------------

  function startEvaluation(active: ActiveRun, minute: number) {
    active.evaluating = true;
    active.lastEvaluated = minute;
    const release = options.hold();
    const work = evaluate(active, minute)
      .catch((error: unknown) => {
        log.error("signal evaluation failed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
      })
      .finally(() => {
        release();
        active.evaluating = false;
        const queued = active.queuedMinute;
        active.queuedMinute = null;
        if (run === active && queued !== null && queued > active.lastEvaluated) startEvaluation(active, queued);
      });
    evaluation = work;
    void work.finally(() => {
      if (evaluation === work) evaluation = null;
    });
  }

  async function evaluate(active: ActiveRun, minute: number) {
    const session = await options.session(active.info.date);
    if (run !== active) return;
    const pulse = session ? computePulse(session, NIFTY_CONSTITUENTS) : null;
    const reading = pulse ? readSignal(pulse, minute, config.strategy.signal) : null;
    if (!pulse || !reading) return;
    active.signal = reading;
    touch();
    subscribe(active);

    if (config.strategy.exitOnOpposite && reading.vote !== 0) {
      for (const position of active.positions) {
        if (position.direction === -reading.vote) exit(active, position, "opposite", null, marketTime);
      }
    }
    if (reading.vote !== 0) await propose(active, pulse, reading, reading.vote);
  }

  /** Why no entry is even considered now; these happen every minute, so they aren't recorded. */
  function quietBlock(active: ActiveRun, direction: 1 | -1, at: number): string | null {
    if (!config.armed) return "Entries are off";
    if (active.halt) return `Stopped for the day: ${active.halt.reason}`;
    if (config.strategy.side === "calls" && direction < 0) return "Puts are switched off";
    if (config.strategy.side === "puts" && direction > 0) return "Calls are switched off";
    if (at < timeOn(active, config.risk.entryFrom)) return `Entries start at ${config.risk.entryFrom}`;
    if (at >= timeOn(active, config.risk.entryUntil)) return `Entries ended at ${config.risk.entryUntil}`;
    if (active.positions.some((p) => p.book === "paper")) return "A position is open";
    // A proposal the gate turned down isn't made again while its shadow trade is still running.
    if (active.positions.some((p) => p.book === "shadow" && p.direction === direction)) return "This signal was turned down and is being shadowed";
    if (active.trades.filter((t) => t.book === "paper").length >= config.risk.maxTradesPerDay) return `The day's limit of ${config.risk.maxTradesPerDay} trades is reached`;
    if (active.lastExitAt !== null && at < active.lastExitAt + config.risk.cooldownMinutes * MINUTE_MS) return "Cooling down after the last trade";
    return null;
  }

  /** A quote good enough to enter on: fresh from the feed, or in a replay without recorded options, from candles. */
  async function entryQuote(active: ActiveRun, contract: OptionRef): Promise<{ quote: MarketQuote | null; problem: string | null }> {
    const maxAge = config.risk.maxQuoteAgeSeconds * 1000;
    const existing = market.get(contract.feedKey);
    if (existing && existing.at > 0 && existing.candleOpen === null) {
      return marketTime - existing.at <= maxAge ? { quote: existing, problem: null } : { quote: null, problem: `${contract.name} last traded ${Math.round((marketTime - existing.at) / 1000)} s ago` };
    }
    if (active.info.source !== "replay") return { quote: null, problem: `No quote for ${contract.name} on the feed yet` };

    if (!active.candleFeeds.has(contract.feedKey)) {
      let candles: Candle[];
      try {
        candles = await options.loadCandles(contract, active.info.date);
      } catch (error) {
        return { quote: null, problem: `This day was recorded without option prices, and Dhan's candles for ${contract.name} couldn't be loaded: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (run !== active) return { quote: null, problem: "The run ended" };
      // Start from the last minute that had closed by now; earlier candles are history.
      let next = 0;
      while (next < candles.length && candles[next].t + MINUTE_MS <= marketTime) next += 1;
      active.candleFeeds.set(contract.feedKey, { candles, next });
      if (next > 0) market.applyCandle(contract.feedKey, candles[next - 1].c, candles[next - 1].o, candles[next - 1].t + MINUTE_MS);
    }
    const quote = market.get(contract.feedKey);
    if (!quote || quote.candleOpen === null || marketTime - quote.at > CANDLE_STALE_MS) {
      return { quote: null, problem: `${contract.name} had no trades in the last ${CANDLE_STALE_MS / MINUTE_MS} minutes` };
    }
    return { quote, problem: null };
  }

  async function propose(active: ActiveRun, pulse: Pulse, reading: SignalReading, direction: 1 | -1) {
    if (quietBlock(active, direction, marketTime)) return;
    const followed = reading.readings.find((r) => r.id === config.strategy.signal);
    const spot = market.get(NIFTY_KEY);
    const intent: Intent = {
      id: nextId(active, "i"),
      at: marketTime,
      minute: reading.minute,
      direction,
      signal: config.strategy.signal,
      reading: followed?.reading ?? "",
      spot: spot?.ltp ?? reading.nifty,
      contract: null,
      outcome: "pending",
      reason: null,
      decisionId: null,
      positionId: null,
    };
    active.intents.push(intent);
    const settle = (outcome: Intent["outcome"], reason: string | null, level: TradingEvent["level"] = "info") => {
      Object.assign(intent, { outcome, reason });
      record(active, { kind: "intent", intent });
      if (outcome === "rejected") event(active, "intent", `${direction > 0 ? "Long" : "Short"} signal (${intent.reading}) not traded: ${reason}`, level);
    };

    if (!spot || marketTime - spot.at > config.risk.maxQuoteAgeSeconds * 1000) return settle("rejected", "NIFTY's price is stale; the feed may be down", "warn");
    if (!active.book || !active.expiry) return settle("rejected", active.contractsProblem ?? "Option contracts aren't loaded", "warn");
    const contract = pickContract(active.book.chain(active.expiry), spot.ltp, direction, config.strategy.strikeOffset);
    if (!contract) return settle("rejected", `No ${direction > 0 ? "call" : "put"} at that strike for the ${active.expiry} expiry`, "warn");
    intent.contract = contract;

    const { quote, problem } = await entryQuote(active, contract);
    if (run !== active) return;
    if (!quote) return settle("rejected", problem);
    const ask = quote.ask ?? quote.ltp;
    const quantity = config.strategy.lots * contract.lotSize;
    if (ask < config.risk.minPremium) return settle("rejected", `Premium ${price(ask)} is below the minimum of ${price(config.risk.minPremium)}`);
    if (ask * quantity > config.risk.maxPremiumPerTrade) return settle("rejected", `${rupees(ask * quantity)} of premium is above the limit of ${rupees(config.risk.maxPremiumPerTrade)} a trade`);
    if (quote.bid !== null && quote.ask !== null) {
      const spread = ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 100;
      if (spread > config.risk.maxSpreadPct) return settle("rejected", `Spread ${spread.toFixed(1)}% (${price(quote.bid)}/${price(quote.ask)}) is wider than ${config.risk.maxSpreadPct}%`);
    }

    event(active, "intent", `${direction > 0 ? "Long" : "Short"} signal (${intent.reading}): proposing ${config.strategy.lots} lot${config.strategy.lots === 1 ? "" : "s"} of ${contract.name} near ${price(ask)}`);

    let book: Book = "paper";
    let decisionLatency = 0;
    if (config.decision.mode !== "off") {
      const slip = (quote.bid !== null ? config.fills.slippage : config.fills.looseSlippage) * 2 * quantity;
      const costPct = ((roundTripCharges(ask * quantity, ask * quantity).total + slip) / (ask * quantity)) * 100;
      const paper = active.trades.filter((t) => t.book === "paper");
      const state = buildDecisionState({
        pulse,
        reading,
        direction,
        contract,
        premium: ask,
        costPct,
        daysToExpiry: daysBetween(active.info.date, contract.expiry),
        strategy: config.strategy,
        at: marketTime,
        session: active.session,
        today: { trades: paper.length, wins: paper.filter((t) => t.net > 0).length, lastResults: paper.slice(-3).map((t) => t.net) },
      });
      const decision = await decide(active, intent, state, contract);
      if (run !== active) return;
      intent.decisionId = decision.id;
      decisionLatency = decision.latencyMs;
      if (decision.error) {
        if (config.decision.mode === "gate" && config.decision.onError === "skip") return settle("rejected", `No decision: ${decision.error}`, "warn");
      } else if (!decision.approved && config.decision.mode === "gate") {
        book = "shadow";
      }
      // The answer took time: the checks that could have changed are made again.
      const blocked = quietBlock(active, direction, marketTime);
      if (blocked && book === "paper") return settle("rejected", blocked);
      if (book === "shadow" && active.positions.some((p) => p.book === "shadow")) return settle("rejected", `Turned down (${decision.reason}); another shadow trade is still running`);
    }

    const latest = market.get(contract.feedKey) ?? quote;
    const position: Position = {
      id: nextId(active, "p"),
      book,
      intentId: intent.id,
      decisionId: intent.decisionId,
      signal: config.strategy.signal,
      direction,
      contract,
      lots: config.strategy.lots,
      quantity,
      status: "opening",
      openedAt: marketTime,
      entryPrice: 0,
      entrySource: "ltp",
      entryCharges: NO_CHARGES,
      spotAtEntry: spot.ltp,
      stopPrice: null,
      targetPrice: null,
      exitBy: marketTime + config.strategy.holdMinutes * MINUTE_MS,
      mark: latest.ltp,
      markAt: latest.at,
      unrealisedGross: 0,
      unrealisedNet: 0,
    };
    // A fast replay is paused while the model answers; the time it took is added to the fill delay instead.
    const paused = (options.replay()?.speed ?? 1) > 1;
    const order: Order = {
      id: nextId(active, "o"),
      book,
      positionId: position.id,
      side: "BUY",
      reason: "entry",
      contract,
      quantity,
      status: "pending",
      at: marketTime,
      fillAfter: marketTime + config.fills.latencyMs + (paused ? decisionLatency : 0),
      trigger: null,
      filledAt: null,
      price: null,
      priceSource: null,
      ltp: null,
      bid: null,
      ask: null,
      value: null,
      charges: null,
      note: null,
    };
    active.positions.push(position);
    active.orders.push(order);
    intent.positionId = position.id;
    settle(book === "paper" ? "taken" : "shadowed", book === "paper" ? null : active.decisions.find((d) => d.id === intent.decisionId)?.reason ?? null);
    record(active, { kind: "order", order });
    subscribe(active);
    // Against a candle there is no later tick to wait for: fill at the close just seen.
    if (latest.candleOpen !== null) applyFill(active, fillOrder(order, latest, marketTime, config.fills));
  }

  async function decide(active: ActiveRun, intent: Intent, state: unknown, contract: OptionRef): Promise<DecisionRecord> {
    const key = decisionKey({ model: config.decision.model, minute: intent.minute, direction: intent.direction, signal: intent.signal, securityId: contract.securityId });
    const decision: DecisionRecord = {
      id: nextId(active, "d"),
      intentId: intent.id,
      at: marketTime,
      wall: now(),
      model: config.decision.model,
      mode: config.decision.mode,
      probability: null,
      regime: null,
      regimeProbabilities: null,
      quality: null,
      approved: false,
      reason: "",
      latencyMs: 0,
      cached: false,
      error: null,
      inputTokens: null,
      cost: null,
    };
    // A replay answers from what was recorded for this proposal, so the day trades the same again.
    const recorded = active.info.source === "replay" ? active.answers.get(key) : undefined;
    let answer: DecisionAnswer | null = recorded?.answer ?? null;
    if (recorded) {
      decision.cached = true;
      decision.latencyMs = recorded.latencyMs;
    } else {
      const started = performance.now();
      try {
        answer = await decisions.ask({ model: config.decision.model, state, timeoutMs: config.decision.timeoutMs });
        decision.latencyMs = Math.round(performance.now() - started);
        active.answers.set(key, { answer, latencyMs: decision.latencyMs });
        void rememberAnswer(active.info.date, key, answer, decision.latencyMs);
      } catch (error) {
        decision.latencyMs = Math.round(performance.now() - started);
        decision.error = error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : String(error);
      }
    }
    if (answer) {
      const verdict = judge(answer, intent.direction, config.decision);
      Object.assign(decision, {
        probability: answer.probability,
        regime: answer.regime,
        regimeProbabilities: answer.regimeProbabilities,
        quality: answer.quality,
        approved: verdict.approved,
        reason: verdict.reason,
        inputTokens: answer.inputTokens,
        cost: answer.cost,
        model: answer.model || config.decision.model,
      });
    } else {
      decision.reason = decision.error ?? "No answer";
    }
    active.decisions.push(decision);
    active.states.set(decision.id, state);
    record(active, { kind: "decision", decision, state });
    const how = decision.cached ? "recorded answer" : `${decision.latencyMs} ms`;
    if (decision.error) event(active, "decision", `Decision API failed (${how}): ${decision.error}`, "warn");
    else if (decision.approved) event(active, "decision", `Decision: take it. ${decision.reason} (${how})`);
    else event(active, "decision", `Decision: ${config.decision.mode === "gate" ? "turned down" : "would turn down"}. ${decision.reason} (${how})`);
    return decision;
  }

  // --- Status ----------------------------------------------------------------------------------

  function contractsStatus(active: ActiveRun | null): ContractsStatus {
    if (!active) return { fileDate: null, stale: false, expiry: null, daysToExpiry: null, lotSize: null, atmStrike: null, subscribed: 0, problem: null };
    const first = active.book && active.expiry ? active.book.chain(active.expiry).find((row) => row.CE ?? row.PE) : undefined;
    return {
      fileDate: active.book?.fileDate ?? null,
      stale: active.book !== null && active.book.fileDate < active.info.date,
      expiry: active.expiry,
      daysToExpiry: active.expiry ? daysBetween(active.info.date, active.expiry) : null,
      lotSize: first?.CE?.lotSize ?? first?.PE?.lotSize ?? null,
      atmStrike: active.atmStrike,
      subscribed: active.subscribed.size,
      problem: active.contractsProblem,
    };
  }

  function describe(active: ActiveRun | null, source: "live" | "replay"): Pick<TradingStatus, "state" | "note"> {
    if (!active) {
      if (changing) return { state: "starting", note: "Starting…" };
      const before = ended ? `${ended.info.id} ended: ${summary(ended)}. ` : "";
      if (source === "replay") return { state: "closed", note: `${before}Start or seek the replay to trade the day again.` };
      const next = calendar.nextSession(SEGMENT, now());
      return { state: "closed", note: `${before}${next ? `Market closed. Trading starts ${PREPARE_LEAD_MS / MINUTE_MS} minutes before the ${next.date} session opens.` : "Market closed."}` };
    }
    if (!active.ready) return { state: "starting", note: "Loading option contracts…" };
    if (active.halt) return { state: "halted", note: `Stopped for the day: ${active.halt.reason}. Resume to trade again.` };
    if (!config.armed) return { state: "disarmed", note: "Watching the signals. Entries are off until you start trading." };
    if (active.contractsProblem && (!active.book || !active.expiry)) return { state: "waiting", note: active.contractsProblem };
    const open = active.positions.find((p) => p.book === "paper");
    if (open) return { state: "ready", note: `Holding ${open.quantity} ${open.contract.name}.` };
    if (marketTime < active.session.open) return { state: "waiting", note: "Waiting for the market to open." };
    const block = quietBlock(active, 1, marketTime) ?? quietBlock(active, -1, marketTime);
    return { state: block ? "waiting" : "ready", note: block ? `${block}.` : "Waiting for the signal to fire." };
  }

  function status(): TradingStatus {
    // After a run ends its results stay on show until the next run starts.
    const active = run ?? ended;
    const replay = options.replay();
    const source = replay ? "replay" : "live";
    const curve: TradingStatus["curve"] = [];
    let net = 0;
    for (const trade of active?.trades ?? []) {
      if (trade.book !== "paper") continue;
      net += trade.net;
      curve.push({ at: trade.closedAt, net });
    }
    const newest = <T,>(list: readonly T[]) => list.slice(-LIST_CAP).reverse();
    return {
      revision,
      listsRevision,
      config,
      ...describe(run, source),
      halt: run?.halt ?? null,
      source,
      marketTime: marketTime || (replay ? replay.at : now()),
      run: active?.info ?? null,
      contracts: contractsStatus(run),
      signal: run?.signal ?? null,
      positions: active ? active.positions.filter((p) => p.status !== "opening") : [],
      trades: newest(active?.trades ?? []),
      orders: newest(active?.orders ?? []),
      intents: newest(active?.intents ?? []),
      decisions: newest(active?.decisions ?? []),
      events: newest(active?.events ?? []),
      totals: { paper: active ? totalsFor(active, "paper") : emptyTotals(), shadow: active ? totalsFor(active, "shadow") : emptyTotals() },
      decisionScore: active ? decisionScore(active) : { asked: 0, approved: 0, vetoed: 0, failed: 0, approvedTrades: 0, approvedNet: 0, vetoedTrades: 0, vetoedNet: 0, meanLatencyMs: null },
      curve,
      storage: {
        location: store.location,
        savedAt: active?.savedAt ?? lastStorage.savedAt,
        error: active?.saveError ?? lastStorage.error,
        pending: active?.pendingSave ?? 0,
      },
      decisionReady: decisions.ready,
    };
  }

  function reportHealth() {
    const active = run;
    if (active?.saveError) health.set("trading", "degraded", `Tables not saved: ${active.saveError}`);
    else if (active?.halt) health.set("trading", "degraded", `Stopped for the day: ${active.halt.reason}`);
    else if (active && config.armed && active.ready && (!active.book || !active.expiry)) health.set("trading", "degraded", active.contractsProblem ?? "No option contracts");
    else if (config.armed && config.decision.mode !== "off" && !decisions.ready) health.set("trading", "degraded", "The decision API has no key (OPENROUTER_API_KEY)");
    else health.set("trading", "ok");
  }

  // --- The engine's hooks ----------------------------------------------------------------------

  function change(work: () => Promise<void>) {
    const next = (changing ?? Promise.resolve()).then(work).catch((error: unknown) => {
      log.error("trading run change failed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    });
    changing = next;
    void next.finally(() => {
      if (changing === next) changing = null;
      touch();
    });
  }

  function tick() {
    const replay = options.replay();
    const source = replay ? "replay" : "live";
    const mnow = replay ? replay.at : now();
    const date = replay ? replay.date : calendar.istDate(mnow);
    const jumps = replay?.jumps ?? 0;

    if (!changing) {
      const active = run;
      if (active && (active.info.source !== source || active.info.date !== date || active.jumps !== jumps)) {
        // The feed switched, the day turned, or the replay jumped: this run can't go on.
        const why = active.info.source !== source ? `the feed switched to ${source}` : active.jumps !== jumps ? "the replay jumped to another time" : "a new day started";
        market.clear();
        marketTime = 0;
        change(() => endRun(active, why, false));
      } else if (active) {
        advance(active, mnow);
        const over = mnow >= active.session.close + RUN_END_GRACE_MS || (replay?.ended ?? false);
        if (over && !active.evaluating) change(() => endRun(active, replay?.ended && mnow < active.session.close ? "the recording ended" : "the session closed", true));
        else if (active.ready && active.info.source === "live" && (!active.book || !active.expiry || active.book.fileDate < active.info.date) && now() - active.contractsCheckedAt > CONTRACT_RETRY_MS) {
          void loadContracts(active);
        } else if (active.ready) subscribe(active);
        if (active.pendingSave > 0 && now() >= active.saveDueAt && !saving) void save(active, false);
      } else {
        const session = calendar.session(SEGMENT, date);
        const done = finished && finished.source === source && finished.date === date && finished.jumps === jumps;
        const due = session && !done && mnow < session.close && (source === "replay" || mnow >= session.open - PREPARE_LEAD_MS);
        if (session && due) {
          marketTime = mnow;
          // A fast replay waits while the contracts load, so the day isn't minutes in before trading is ready.
          const release = options.hold();
          change(() => beginRun(source, date, { open: session.open, close: session.close }, jumps).finally(release));
        } else marketTime = mnow;
      }
    }

    reportHealth();
    const wall = now();
    if (revision !== publishedRevision || wall - publishedAt >= PUBLISH_EVERY_MS || (run?.positions.length ?? 0) > 0) {
      publishedRevision = revision;
      publishedAt = wall;
      const full = status();
      if (listsRevision === publishedLists) {
        // Marks and the clock move every second; the lists are sent only when they change.
        const { trades: _t, orders: _o, intents: _i, decisions: _d, events: _e, ...light } = full;
        void [_t, _o, _i, _d, _e];
        options.publish(light);
      } else {
        publishedLists = listsRevision;
        options.publish(full);
      }
    }
  }

  function onFrame(frame: ArrayBuffer | ArrayBufferView, at: number) {
    try {
      const active = changing ? null : run;
      for (const packet of parseFrame(frame)) {
        const quote = market.apply(packet, at);
        if (!quote || !active) continue;
        // The feed has this contract after all: its ticks replace the candles.
        if (active.candleFeeds.size > 0) active.candleFeeds.delete(quote.key);
        onQuote(active, quote, at);
      }
      if (active) advance(active, at);
    } catch (error) {
      log.error("trading failed on a frame", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    }
  }

  async function command(body: unknown): Promise<TradingCommandResult> {
    const request = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const active = run;
    switch (request.action) {
      case "arm":
      case "disarm": {
        const armed = request.action === "arm";
        if (config.armed === armed) return { ok: true, message: armed ? "Trading is already on." : "Trading is already off." };
        config = { ...config, armed };
        await saveConfig();
        if (active) {
          event(active, "config", armed ? "Trading switched on: entries will be taken" : "Trading switched off: no new entries; open positions keep their exits");
          subscribe(active);
        }
        touch();
        return { ok: true, message: armed ? "Paper trading is on. Entries are taken when the signal fires." : "Trading is off. Open positions keep their exits." };
      }
      case "flatten": {
        if (!active) return { ok: false, message: "There is no run in progress." };
        const open = active.positions.filter((p) => p.status === "open");
        if (open.length === 0) return { ok: true, message: "Nothing is open." };
        for (const position of open) exit(active, position, "manual", null, marketTime);
        event(active, "risk", `Selling ${open.length} open position${open.length === 1 ? "" : "s"} on your request`);
        return { ok: true, message: `Selling ${open.length} open position${open.length === 1 ? "" : "s"}.` };
      }
      case "halt": {
        if (!active) return { ok: false, message: "There is no run in progress." };
        if (active.halt) return { ok: true, message: "Trading is already stopped for the day." };
        halt(active, "Stopped by you");
        return { ok: true, message: "Trading is stopped for the day. Open positions are being sold." };
      }
      case "resume": {
        if (!active?.halt) return { ok: true, message: "Trading isn't stopped." };
        active.halt = null;
        record(active, { kind: "halt", halt: null });
        event(active, "halt", "Trading resumed");
        return { ok: true, message: "Trading resumed." };
      }
      case "config": {
        const { armed: _armed, ...patch } = (request.patch && typeof request.patch === "object" ? request.patch : {}) as Record<string, unknown>;
        void _armed;
        const merged = mergeTradingConfig(config, patch);
        if (!merged.ok) return { ok: false, message: merged.message };
        const expiryRule = config.strategy.minDaysToExpiry;
        config = merged.config;
        await saveConfig();
        if (active) {
          if (active.book && config.strategy.minDaysToExpiry !== expiryRule) active.expiry = pickExpiry(active.book, active.info.date, config.strategy.minDaysToExpiry);
          event(active, "config", "Settings changed");
          subscribe(active);
        }
        touch();
        return { ok: true, message: "Settings saved. Open positions keep the stop and target they were opened with." };
      }
      default:
        return { ok: false, message: "Unknown trading command." };
    }
  }

  async function settle() {
    for (let i = 0; i < 50; i += 1) {
      if (!changing && !saving && !evaluation) return;
      await Promise.all([changing, saving, evaluation]);
    }
  }

  return {
    async start() {
      try {
        const saved = JSON.parse(await readFile(configFile, "utf8")) as unknown;
        const merged = mergeTradingConfig(DEFAULT_TRADING_CONFIG, saved);
        if (merged.ok) config = merged.config;
        else log.warn(`ignoring saved trading settings: ${merged.message}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("could not read the saved trading settings; using the defaults", { error: String(error) });
      }
      log.info(`trading ready: ${config.armed ? "armed" : "entries off"}, ${config.strategy.signal} signal, decision ${config.decision.mode}, tables in ${store.location}`);
    },
    onFrame,
    tick,
    status,
    command,
    history: (id) => store.history(id),
    decisionRequest(id) {
      const decision = run?.decisions.find((d) => d.id === id);
      if (!run || !decision) return null;
      return { id, model: decision.model, questions: QUESTIONS, state: run.states.get(id) ?? null };
    },
    async stop() {
      await settle();
      const active = run;
      if (!active) return;
      active.info = { ...active.info, endedAt: now() };
      active.log.append({ kind: "run", run: active.info });
      // A live day's positions stay open: an engine restarted in the session carries on with them.
      event(active, "run", `Engine stopping. ${summary(active)}${active.positions.length > 0 ? `; ${active.positions.length} position(s) left open` : ""}`);
      await save(active, false);
      await active.log.close();
      run = null;
    },
    idle: settle,
  };
}
