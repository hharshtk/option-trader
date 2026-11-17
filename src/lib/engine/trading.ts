// Trading types shared by the engine and the web: the settings, what the engine reports about
// its trading (`GET /v1/trading`, the `trading` telemetry topic) and the commands the web sends
// (`POST /v1/trading`). Plain TypeScript, so both sides can load it.

import type { Charges } from "../trading/charges.ts";

/** Which signal from the Pulse signal lab the strategy follows. */
export type SignalId = "breadth" | "lead" | "momentum" | "agree";
export const SIGNALS: readonly { id: SignalId; name: string }[] = [
  { id: "breadth", name: "Breadth thrust" },
  { id: "lead", name: "Basket leads index" },
  { id: "momentum", name: "15-minute momentum" },
  { id: "agree", name: "Two or more agree" },
];

/** How the decision API takes part. */
export type DecisionMode = "off" | "shadow" | "gate";

export interface TradingConfig {
  /** New entries are taken only while armed. Exits always run. */
  armed: boolean;
  /** Paper fills are simulated. Live orders are not built yet. */
  mode: "paper";
  /** Keep NIFTY options around the money subscribed in Full mode, so every session records them. */
  recordOptions: boolean;
  /** Strikes kept subscribed on each side of the money. */
  windowStrikes: number;
  strategy: {
    signal: SignalId;
    /** Both: calls on a long signal, puts on a short one. */
    side: "both" | "calls" | "puts";
    /** 0 is at the money; +1 is one strike out of the money, −1 one strike in. */
    strikeOffset: number;
    lots: number;
    /** A position is sold this many minutes after it was bought, if nothing else closed it. */
    holdMinutes: number;
    /** Sell when the premium falls this far below the entry, in percent. 0 turns it off. */
    stopLossPct: number;
    /** Sell when the premium rises this far above the entry, in percent. 0 turns it off. */
    targetPct: number;
    /** Sell when the signal fires the other way. */
    exitOnOpposite: boolean;
    /** Skip an expiry closer than this many days. 0 trades the nearest expiry on expiry day too. */
    minDaysToExpiry: number;
  };
  risk: {
    /** IST, HH:MM. No entries before or after; everything is sold at `squareOffAt`. */
    entryFrom: string;
    entryUntil: string;
    squareOffAt: string;
    maxTradesPerDay: number;
    /** Rupees after charges. At this loss the day's trading stops and open positions are sold. */
    maxDailyLoss: number;
    maxConsecutiveLosses: number;
    /** Most premium one trade may put at risk, in rupees (premium × quantity). */
    maxPremiumPerTrade: number;
    /** Skip contracts cheaper than this: ticks and spreads are too large a share of the price. */
    minPremium: number;
    /** Skip when the bid-ask spread is wider than this share of the price, in percent. */
    maxSpreadPct: number;
    /** Minutes to wait after closing a trade before the next entry. */
    cooldownMinutes: number;
    /** No entry on a quote older than this, in seconds. */
    maxQuoteAgeSeconds: number;
  };
  fills: {
    /** Rupees per unit paid beyond the book's bid or ask. */
    slippage: number;
    /** Rupees per unit paid when filling against a last price or a candle close (no book). */
    looseSlippage: number;
    /** Milliseconds between sending an order and its fill. */
    latencyMs: number;
  };
  decision: {
    mode: DecisionMode;
    model: string;
    /** Take a trade only when the model's probability that it should be taken is at least this. */
    minProbability: number;
    /** Veto a long in a falling regime and a short in a rising one. */
    vetoAgainstRegime: boolean;
    timeoutMs: number;
    /** What to do with an entry when the model doesn't answer in time: skip it, or take it. */
    onError: "skip" | "allow";
  };
}

export const DEFAULT_TRADING_CONFIG: TradingConfig = {
  armed: false,
  mode: "paper",
  recordOptions: true,
  windowStrikes: 6,
  strategy: {
    signal: "agree",
    side: "both",
    strikeOffset: 0,
    lots: 1,
    holdMinutes: 10,
    stopLossPct: 20,
    targetPct: 30,
    exitOnOpposite: true,
    minDaysToExpiry: 0,
  },
  risk: {
    entryFrom: "09:25",
    entryUntil: "14:45",
    squareOffAt: "15:10",
    maxTradesPerDay: 12,
    maxDailyLoss: 3_000,
    maxConsecutiveLosses: 4,
    maxPremiumPerTrade: 25_000,
    minPremium: 5,
    maxSpreadPct: 3,
    cooldownMinutes: 2,
    maxQuoteAgeSeconds: 10,
  },
  fills: { slippage: 0.05, looseSlippage: 0.5, latencyMs: 300 },
  decision: {
    mode: "gate",
    model: "perplexity/pplx-decider-v1.3:free",
    minProbability: 0.55,
    vetoAgainstRegime: true,
    timeoutMs: 4_000,
    onError: "skip",
  },
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Applies `patch` on top of `base`, keeping only known fields with sane values. Returns the new
 * settings, or a message saying what was wrong. Used by the web before sending and by the engine
 * before accepting.
 */
export function mergeTradingConfig(base: TradingConfig, patch: unknown): { ok: true; config: TradingConfig } | { ok: false; message: string } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, message: "Settings must be an object." };
  const next = structuredClone(base);
  const problems: string[] = [];

  const number = (value: unknown, name: string, min: number, max: number, integer = false) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      problems.push(`${name} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}`);
      return undefined;
    }
    return value;
  };
  const oneOf = <T extends string>(value: unknown, name: string, choices: readonly T[]) => {
    if (typeof value !== "string" || !choices.includes(value as T)) {
      problems.push(`${name} must be one of ${choices.join(", ")}`);
      return undefined;
    }
    return value as T;
  };
  const bool = (value: unknown, name: string) => {
    if (typeof value !== "boolean") {
      problems.push(`${name} must be true or false`);
      return undefined;
    }
    return value;
  };
  const time = (value: unknown, name: string) => {
    if (typeof value !== "string" || !HHMM.test(value)) {
      problems.push(`${name} must be a time, HH:MM`);
      return undefined;
    }
    return value;
  };
  /** Sets `target[key]` when the patch has it and it is valid. */
  function apply<T extends object, K extends keyof T & string>(target: T, source: Record<string, unknown>, key: K, read: (value: unknown, name: string) => T[K] | undefined, label: string) {
    if (source[key] === undefined) return;
    const value = read(source[key], label);
    if (value !== undefined) target[key] = value;
  }
  const section = (name: string) => {
    const value = (patch as Record<string, unknown>)[name];
    if (value === undefined) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`${name} must be an object`);
      return null;
    }
    return value as Record<string, unknown>;
  };

  const top = patch as Record<string, unknown>;
  apply(next, top, "armed", bool, "Armed");
  apply(next, top, "recordOptions", bool, "Record options");
  apply(next, top, "windowStrikes", (v, n) => number(v, n, 1, 25, true), "Strikes each side");
  if (top.mode !== undefined && top.mode !== "paper") problems.push("Only paper trading is built; live orders come later");

  const strategy = section("strategy");
  if (strategy) {
    apply(next.strategy, strategy, "signal", (v, n) => oneOf(v, n, SIGNALS.map((s) => s.id)), "Signal");
    apply(next.strategy, strategy, "side", (v, n) => oneOf(v, n, ["both", "calls", "puts"] as const), "Side");
    apply(next.strategy, strategy, "strikeOffset", (v, n) => number(v, n, -5, 5, true), "Strike offset");
    apply(next.strategy, strategy, "lots", (v, n) => number(v, n, 1, 50, true), "Lots");
    apply(next.strategy, strategy, "holdMinutes", (v, n) => number(v, n, 1, 240, true), "Hold");
    apply(next.strategy, strategy, "stopLossPct", (v, n) => number(v, n, 0, 90), "Stop loss");
    apply(next.strategy, strategy, "targetPct", (v, n) => number(v, n, 0, 500), "Target");
    apply(next.strategy, strategy, "exitOnOpposite", bool, "Exit on opposite signal");
    apply(next.strategy, strategy, "minDaysToExpiry", (v, n) => number(v, n, 0, 30, true), "Minimum days to expiry");
  }

  const risk = section("risk");
  if (risk) {
    apply(next.risk, risk, "entryFrom", time, "Entries from");
    apply(next.risk, risk, "entryUntil", time, "Entries until");
    apply(next.risk, risk, "squareOffAt", time, "Square-off time");
    apply(next.risk, risk, "maxTradesPerDay", (v, n) => number(v, n, 1, 200, true), "Trades a day");
    apply(next.risk, risk, "maxDailyLoss", (v, n) => number(v, n, 100, 1_000_000), "Daily loss limit");
    apply(next.risk, risk, "maxConsecutiveLosses", (v, n) => number(v, n, 1, 50, true), "Losses in a row");
    apply(next.risk, risk, "maxPremiumPerTrade", (v, n) => number(v, n, 500, 10_000_000), "Premium per trade");
    apply(next.risk, risk, "minPremium", (v, n) => number(v, n, 0, 1_000), "Minimum premium");
    apply(next.risk, risk, "maxSpreadPct", (v, n) => number(v, n, 0.1, 50), "Spread limit");
    apply(next.risk, risk, "cooldownMinutes", (v, n) => number(v, n, 0, 120), "Cooldown");
    apply(next.risk, risk, "maxQuoteAgeSeconds", (v, n) => number(v, n, 1, 120), "Quote age");
  }

  const fills = section("fills");
  if (fills) {
    apply(next.fills, fills, "slippage", (v, n) => number(v, n, 0, 20), "Slippage");
    apply(next.fills, fills, "looseSlippage", (v, n) => number(v, n, 0, 20), "Slippage without a book");
    apply(next.fills, fills, "latencyMs", (v, n) => number(v, n, 0, 10_000, true), "Latency");
  }

  const decision = section("decision");
  if (decision) {
    apply(next.decision, decision, "mode", (v, n) => oneOf(v, n, ["off", "shadow", "gate"] as const), "Decision mode");
    apply(next.decision, decision, "minProbability", (v, n) => number(v, n, 0, 1), "Decision threshold");
    apply(next.decision, decision, "vetoAgainstRegime", bool, "Veto against the regime");
    apply(next.decision, decision, "timeoutMs", (v, n) => number(v, n, 500, 30_000, true), "Decision timeout");
    apply(next.decision, decision, "onError", (v, n) => oneOf(v, n, ["skip", "allow"] as const), "On a missing answer");
    if (decision.model !== undefined) {
      if (typeof decision.model === "string" && /^[\w.:/-]{3,120}$/.test(decision.model)) next.decision.model = decision.model;
      else problems.push("Decision model must be a model id such as perplexity/pplx-decider-v1.3:free");
    }
  }

  if (next.risk.entryFrom >= next.risk.entryUntil) problems.push("Entries must start before they end");
  if (next.risk.entryUntil > next.risk.squareOffAt) problems.push("Entries must end by the square-off time");
  return problems.length > 0 ? { ok: false, message: `${problems.join(". ")}.` } : { ok: true, config: next };
}

/** A NIFTY option contract, as much as trading needs of it. */
export interface OptionRef {
  securityId: string;
  /** "NSE_FNO:35028": the key the feed streams it under. */
  feedKey: string;
  name: string;
  strike: number;
  type: "CE" | "PE";
  /** YYYY-MM-DD. */
  expiry: string;
  lotSize: number;
  tickSize: number;
}

/** The paper account, or the shadow book that follows trades the decision gate turned down. */
export type Book = "paper" | "shadow";

export type ExitReason = "stop" | "target" | "time" | "opposite" | "square-off" | "manual" | "halt";
export type OrderReason = "entry" | ExitReason;
/** What an order was filled against: the order book, a last traded price, or a 1-minute candle. */
export type PriceSource = "book" | "ltp" | "candle";

export interface Order {
  id: string;
  book: Book;
  positionId: string;
  side: "BUY" | "SELL";
  reason: OrderReason;
  contract: OptionRef;
  quantity: number;
  status: "pending" | "filled" | "cancelled";
  /** Market time it was created, and the earliest it may fill (creation plus latency). */
  at: number;
  fillAfter: number;
  /** The level that triggered a stop or target exit. */
  trigger: number | null;
  filledAt: number | null;
  price: number | null;
  priceSource: PriceSource | null;
  /** The quote it filled against. */
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  /** price × quantity. */
  value: number | null;
  charges: Charges | null;
  /** Why it was cancelled. */
  note: string | null;
}

export interface Position {
  id: string;
  book: Book;
  intentId: string;
  decisionId: string | null;
  signal: SignalId;
  /** +1 bought a call on a long signal, −1 bought a put on a short one. */
  direction: 1 | -1;
  contract: OptionRef;
  lots: number;
  quantity: number;
  status: "opening" | "open" | "closing";
  openedAt: number;
  entryPrice: number;
  entrySource: PriceSource;
  entryCharges: Charges;
  /** NIFTY when it was bought. */
  spotAtEntry: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  /** Market time the hold runs out. */
  exitBy: number;
  /** Latest price and when, for the running P&L. */
  mark: number;
  markAt: number;
  /** Rupees if sold at the mark now, before and after charges on both orders. */
  unrealisedGross: number;
  unrealisedNet: number;
}

export interface Trade {
  id: string;
  book: Book;
  intentId: string;
  decisionId: string | null;
  signal: SignalId;
  direction: 1 | -1;
  contract: OptionRef;
  lots: number;
  quantity: number;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  entrySource: PriceSource;
  exitSource: PriceSource;
  exitReason: ExitReason;
  spotAtEntry: number | null;
  spotAtExit: number | null;
  gross: number;
  charges: Charges;
  net: number;
}

export type IntentOutcome = "pending" | "taken" | "shadowed" | "rejected";

/** What the strategy proposed when a signal fired, and what became of it. */
export interface Intent {
  id: string;
  /** Market time it was proposed, and the start of the minute whose close fired the signal. */
  at: number;
  minute: number;
  direction: 1 | -1;
  signal: SignalId;
  /** The signal's reading, e.g. "+8 stocks in 5 min". */
  reading: string;
  spot: number | null;
  contract: OptionRef | null;
  outcome: IntentOutcome;
  /** Why it was rejected or shadowed. */
  reason: string | null;
  decisionId: string | null;
  positionId: string | null;
}

export interface DecisionRecord {
  id: string;
  intentId: string;
  /** Market time asked, and the engine's wall clock. */
  at: number;
  wall: number;
  model: string;
  mode: DecisionMode;
  /** The model's probability that the trade should be taken, 0 to 1. */
  probability: number | null;
  regime: string | null;
  regimeProbabilities: Record<string, number> | null;
  /** How well supported the move is, 0 (fragile) to 1 (broad). */
  quality: number | null;
  approved: boolean;
  reason: string;
  latencyMs: number;
  /** Answered from an earlier recording of the same proposal instead of a new call. */
  cached: boolean;
  error: string | null;
  inputTokens: number | null;
  cost: number | null;
}

/** A line in the activity feed. */
export interface TradingEvent {
  at: number;
  wall: number;
  level: "info" | "warn" | "error";
  kind: "run" | "signal" | "intent" | "decision" | "order" | "fill" | "trade" | "risk" | "halt" | "config" | "storage" | "contracts";
  message: string;
}

export interface BookTotals {
  trades: number;
  wins: number;
  gross: number;
  charges: number;
  net: number;
  /** Net P&L of open positions if sold at their marks. */
  open: number;
  /** Largest fall of the day's net P&L from its high, in rupees. */
  maxDrawdown: number;
}

export interface RunInfo {
  id: string;
  /** Where this engine's trading records are kept apart from another engine's. */
  namespace: string;
  mode: "paper";
  source: "live" | "replay";
  /** The market day traded, YYYY-MM-DD IST. */
  date: string;
  /** Wall-clock start, and when it ended (null while running). */
  startedAt: number;
  endedAt: number | null;
  /** True when the run continued from an earlier engine process on the same day. */
  resumed: boolean;
}

export interface ContractsStatus {
  /** IST date of the instrument file the contracts came from; null when none is loaded. */
  fileDate: string | null;
  /** The file is for an earlier day than the market day: new strikes may be missing. */
  stale: boolean;
  expiry: string | null;
  daysToExpiry: number | null;
  lotSize: number | null;
  atmStrike: number | null;
  /** Option contracts kept subscribed on the feed. */
  subscribed: number;
  problem: string | null;
}

export interface SignalReading {
  /** Start of the minute this was read at the close of. */
  minute: number;
  nifty: number | null;
  /** Each single signal's reading and vote, then the chosen signal's vote. */
  readings: { id: SignalId; name: string; reading: string; vote: -1 | 0 | 1 }[];
  vote: -1 | 0 | 1;
  stance: string;
  score: number;
}

export interface DecisionScore {
  asked: number;
  approved: number;
  vetoed: number;
  failed: number;
  /** Trades the model approved and trades it turned down, closed, after charges. */
  approvedTrades: number;
  approvedNet: number;
  vetoedTrades: number;
  vetoedNet: number;
  meanLatencyMs: number | null;
}

export interface TradingStatus {
  /** Increases whenever anything below changes. */
  revision: number;
  /** Changes whenever one of the lists (trades, orders, intents, decisions, events) does. */
  listsRevision: number;
  config: TradingConfig;
  /** One line saying what trading is doing now. */
  state: "starting" | "waiting" | "ready" | "disarmed" | "halted" | "closed";
  note: string;
  halt: { reason: string; at: number } | null;
  source: "live" | "replay";
  /** The market's clock: the wall clock live, recorded time in a replay. */
  marketTime: number;
  run: RunInfo | null;
  contracts: ContractsStatus;
  signal: SignalReading | null;
  positions: Position[];
  /** Newest first, the latest 200. */
  trades: Trade[];
  orders: Order[];
  intents: Intent[];
  decisions: DecisionRecord[];
  events: TradingEvent[];
  totals: Record<Book, BookTotals>;
  decisionScore: DecisionScore;
  /** Net P&L after each closed paper trade, oldest first, for the day's curve. */
  curve: { at: number; net: number }[];
  storage: {
    /** Where the Parquet tables are: an S3 address or a folder. */
    location: string;
    savedAt: number | null;
    error: string | null;
    /** Records written since the last save. */
    pending: number;
  };
  /** Whether the decision API has a key configured. */
  decisionReady: boolean;
}

export type TradingList = "trades" | "orders" | "intents" | "decisions" | "events";

/**
 * What the `trading` telemetry topic carries: the status, with the lists only when they changed
 * since the previous message. A page keeps the lists it has while `listsRevision` stays the same,
 * and reads `GET /v1/trading` for the whole status when it has none or they are out of date.
 */
export type TradingUpdate = Omit<TradingStatus, TradingList> & Partial<Pick<TradingStatus, TradingList>>;

export type TradingCommand =
  | { action: "arm" }
  | { action: "disarm" }
  /** Sell every open position now. */
  | { action: "flatten" }
  /** Stop trading for the day and sell open positions; `resume` lifts it. */
  | { action: "halt" }
  | { action: "resume" }
  | { action: "config"; patch: unknown };

export interface TradingCommandResult {
  ok: boolean;
  message: string;
}

/** One finished or running run, as stored: a row of the `runs` table. */
export interface RunRow {
  run_id: string;
  namespace: string;
  source: string;
  mode: string;
  date: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  signal: string;
  decision_mode: string;
  trades: number;
  wins: number;
  gross: number;
  charges: number;
  net: number;
  max_drawdown: number;
  shadow_trades: number;
  shadow_net: number;
  decisions: number;
  vetoes: number;
  engine_version: string;
}

/** A closed trade as stored: a row of the `trades` table. */
export interface TradeRow {
  run_id: string;
  date: string;
  source: string;
  id: string;
  book: string;
  signal: string;
  direction: number;
  contract: string;
  security_id: string;
  strike: number;
  option_type: string;
  expiry: string;
  lots: number;
  quantity: number;
  opened_at: number;
  closed_at: number;
  entry_price: number;
  exit_price: number;
  entry_source: string;
  exit_source: string;
  exit_reason: string;
  spot_entry: number | null;
  spot_exit: number | null;
  gross: number;
  brokerage: number;
  exchange: number;
  ipft: number;
  sebi: number;
  stt: number;
  stamp: number;
  gst: number;
  charges: number;
  net: number;
  decision_probability: number | null;
  decision_approved: boolean | null;
  decision_regime: string | null;
}

/** `GET /v1/trading/decision?id=`: the request the engine sent the decision API for one proposal of the current run. */
export interface DecisionRequest {
  id: string;
  /** The model that answered (the one asked, when it gave no name). */
  model: string;
  /** The typed questions, as sent. */
  questions: Record<string, unknown>;
  /** The market context, as sent. Null when it wasn't kept. */
  state: unknown;
}

/** `GET /v1/trading/history`: stored runs, newest first; with `?run=`, that run's trades too. */
export interface TradingHistory {
  location: string;
  runs: RunRow[];
  run: string | null;
  trades: TradeRow[];
}
