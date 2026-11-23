// Trading types shared by the engine and the web: the settings, what the engine reports about
// its trading (`GET /v1/trading`, the `trading` telemetry topic) and the commands the web sends
// (`POST /v1/trading`). Plain TypeScript, so both sides can load it.

import type { Charges } from "../trading/charges.ts";
import type { LiveCommand, LiveStatus } from "./live.ts";

/** Which signal from the Pulse signal lab the strategy follows. */
export type SignalId = "breadth" | "lead" | "momentum" | "flow" | "buildup" | "writers" | "book20" | "agree" | "confirmed";

/** How a signal did over a year of minute history, before costs: the base rate the decision API is told. */
export interface SignalRecord {
  /** Over what, and when it was measured. */
  span: string;
  holdMinutes: number;
  trades: number;
  /** Share of trades NIFTY then moved the signal's way. */
  winRate: number;
  /** Average NIFTY points a trade, before costs. */
  pointsPerTrade: number;
}

export const SIGNALS: readonly { id: SignalId; name: string; kind: "single" | "combined"; pastYear: SignalRecord | null }[] = [
  // From the first research study (17 November 2026, branch research-and-strategy-store): 257 days,
  // 3 Nov 2025 to 17 Nov 2026, entries 09:25 to 14:45, 10-minute hold. An option trade costs about 3.9 points.
  { id: "breadth", name: "Breadth thrust", kind: "single", pastYear: { span: "257 days to 17 Nov 2026", holdMinutes: 10, trades: 2832, winRate: 0.498, pointsPerTrade: 0.3 } },
  { id: "lead", name: "Basket leads index", kind: "single", pastYear: { span: "257 days to 17 Nov 2026", holdMinutes: 10, trades: 1755, winRate: 0.501, pointsPerTrade: -0.4 } },
  { id: "momentum", name: "15-minute momentum", kind: "single", pastYear: { span: "257 days to 17 Nov 2026", holdMinutes: 10, trades: 3313, winRate: 0.497, pointsPerTrade: 0.3 } },
  // Futures and options were first recorded on 18 November 2026: no history yet.
  { id: "flow", name: "Futures order flow", kind: "single", pastYear: null },
  { id: "buildup", name: "Futures OI build-up", kind: "single", pastYear: null },
  { id: "writers", name: "Option writers", kind: "single", pastYear: null },
  { id: "book20", name: "Order book lean", kind: "single", pastYear: null },
  { id: "agree", name: "Two or more agree", kind: "combined", pastYear: { span: "257 days to 17 Nov 2026", holdMinutes: 10, trades: 1433, winRate: 0.49, pointsPerTrade: -0.1 } },
  { id: "confirmed", name: "Confirmed by futures and options", kind: "combined", pastYear: null },
];

/**
 * The decision lab's candidate rules the trader can follow instead of a signal (lib/decide/rules.ts
 * defines them; listed here so settings can be checked without loading the rules).
 */
export const FOLLOWABLE_RULES = [
  { id: "trend", name: "Trend day" },
  { id: "cheap-momentum", name: "Momentum when options are cheap" },
  { id: "wall-fade", name: "Fade at the walls" },
  { id: "trend-hold", name: "Trend day, held" },
  { id: "breadth-buildup", name: "Breadth and OI build-up agree" },
  { id: "flow-fade", name: "Fade futures order flow" },
] as const;
export type FollowableRuleId = (typeof FOLLOWABLE_RULES)[number]["id"];

/**
 * Market data beyond prices, the future's trades and NIFTY's stocks that a signal, a rule or the
 * AI check reads: the near-month future's 20-level book (depth feed), the option chain snapshot
 * (every strike within 10% of NIFTY), or the near-the-money option open interest the journal records.
 */
export type DecisionData = "depth" | "chain" | "options";

export const DECISION_DATA: Record<DecisionData, { label: string; title: string }> = {
  depth: { label: "Depth", title: "Reads the future's 20-level order book (the depth feed)" },
  chain: { label: "Chain", title: "Reads the option chain snapshot: every strike within 10% of NIFTY, once a minute" },
  options: { label: "Option OI", title: "Reads open interest on the option strikes near the money that the engine records" },
};

/** What each signal reads of DECISION_DATA (lib/insight/pulse.ts); a signal not listed reads none of it. */
export const SIGNAL_DATA: Partial<Record<SignalId, readonly DecisionData[]>> = {
  writers: ["options"],
  book20: ["depth"],
  // Needs a futures or options signal to agree, Option writers among them.
  confirmed: ["options"],
};

/** The same for the followable rules (lib/decide/rules.ts). Fade at the walls falls back to the recorded strikes without a chain. */
export const RULE_DATA: Partial<Record<FollowableRuleId, readonly DecisionData[]>> = {
  "wall-fade": ["chain"],
};

/** The AI check's request carries both the 20-level book and the option chain (engine/trading/decision.ts). */
export const AI_CHECK_DATA: readonly DecisionData[] = ["depth", "chain"];

/** How the decision API takes part. */
export type DecisionMode = "off" | "shadow" | "gate";

/** Who answers the decision API's questions. Both take the same typed questions and give the same answers. */
export type DecisionProviderId = "openrouter" | "liquid";
export const DECISION_PROVIDERS: readonly { id: DecisionProviderId; name: string; defaultModel: string; keyName: string; price: string }[] = [
  { id: "openrouter", name: "OpenRouter", defaultModel: "perplexity/pplx-decider-v1.3:free", keyName: "OPENROUTER_API_KEY", price: "free models: 50 answers a day, 1,000 with $10 of credit" },
  { id: "liquid", name: "Liquid", defaultModel: "d1.2-ultra", keyName: "LIQUID_API_KEY", price: "$0.042 per million input tokens, about $0.00006 an answer" },
];

export interface TradingConfig {
  /** New entries are taken only while armed. Exits always run. */
  armed: boolean;
  /**
   * Always "paper": this book's fills are simulated. Real orders are a separate switch, for one day
   * at a time on the Strategies page (the live pilot, live.ts), never a saved setting.
   */
  mode: "paper";
  /** Keep NIFTY options around the money subscribed in Full mode, so every session records them. */
  recordOptions: boolean;
  /** Strikes kept subscribed on each side of the money. */
  windowStrikes: number;
  strategy: {
    signal: SignalId;
    /**
     * A decision lab rule to follow instead of `signal`: entries come from the same function the
     * lab scores. Null follows the signal.
     */
    rule: FollowableRuleId | null;
    /** Every entry must pass the cost check (lib/decide/cost.ts), as the lab scores it. */
    costCheck: boolean;
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
    /**
     * With percent exits: the stop follows the option's best price up, staying as far below it as
     * it started below the entry, and there is no target, so a winner runs until it falls back.
     */
    trailStop: boolean;
    /**
     * How the stop and target are set: a share of the premium (`stopLossPct`, `targetPct`), or
     * rupees made or lost after charges on both orders (`stopNet`, `targetNet`), the scalping way.
     */
    exitIn: "percent" | "rupees";
    /**
     * Where a percent stop and target come from: each trade's own, worked out from how much NIFTY
     * is moving (`volatility`, lib/trading/exits.ts), or the fixed `stopLossPct` and `targetPct`.
     * The fixed ones also stand in when the market's movement isn't known yet.
     */
    exitsFrom: "volatility" | "fixed";
    /** With volatility exits: the stop and target as multiples of NIFTY's typical move over the hold. */
    stopMoves: number;
    targetMoves: number;
    /** Sell when the trade would lose this many rupees after charges. 0 turns it off. */
    stopNet: number;
    /** Sell when the trade would make this many rupees after charges. 0 turns it off. */
    targetNet: number;
    /** Scalping's own hold, used instead of `holdMinutes` while `exitIn` is rupees. */
    scalpHoldMinutes: number;
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
    /** Positions held at the same time on the paper book. 1 waits for each trade to close before the next. */
    maxOpenPositions: number;
    /** Rupees after charges. At this loss the day's trading stops and open positions are sold. */
    maxDailyLoss: number;
    maxConsecutiveLosses: number;
    /** Most premium one trade may put at risk, in rupees (premium × quantity). */
    maxPremiumPerTrade: number;
    /** Skip contracts cheaper than this: ticks and spreads are too large a share of the price. */
    minPremium: number;
    /** Skip when the bid-ask spread is wider than this share of the price, in percent. */
    maxSpreadPct: number;
    /** Minutes to wait after a buy or a sell before the next entry. */
    cooldownMinutes: number;
    /** Scalping's own wait, used instead of `cooldownMinutes` while `exitIn` is rupees. */
    scalpCooldownMinutes: number;
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
    provider: DecisionProviderId;
    /** The provider's model id. */
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
    rule: null,
    costCheck: false,
    side: "both",
    strikeOffset: 0,
    lots: 1,
    holdMinutes: 10,
    stopLossPct: 20,
    targetPct: 30,
    trailStop: false,
    exitIn: "percent",
    exitsFrom: "volatility",
    stopMoves: 1,
    targetMoves: 2,
    stopNet: 250,
    targetNet: 250,
    scalpHoldMinutes: 3,
    exitOnOpposite: true,
    minDaysToExpiry: 0,
  },
  risk: {
    entryFrom: "09:25",
    entryUntil: "14:45",
    squareOffAt: "15:10",
    maxTradesPerDay: 12,
    maxOpenPositions: 1,
    maxDailyLoss: 3_000,
    maxConsecutiveLosses: 4,
    maxPremiumPerTrade: 25_000,
    minPremium: 5,
    maxSpreadPct: 3,
    cooldownMinutes: 2,
    scalpCooldownMinutes: 0,
    maxQuoteAgeSeconds: 10,
  },
  fills: { slippage: 0.05, looseSlippage: 0.5, latencyMs: 300 },
  decision: {
    mode: "gate",
    provider: "openrouter",
    model: "perplexity/pplx-decider-v1.3:free",
    minProbability: 0.55,
    vetoAgainstRegime: true,
    timeoutMs: 4_000,
    onError: "skip",
  },
};

/** True when trading the scalping way: stop and target in rupees after charges, with its own hold and wait. */
export function isScalping(config: Pick<TradingConfig, "strategy">): boolean {
  return config.strategy.exitIn === "rupees";
}

/** Minutes a position is held at most, under the style in use. */
export function holdMinutesFor(config: Pick<TradingConfig, "strategy">): number {
  return isScalping(config) ? config.strategy.scalpHoldMinutes : config.strategy.holdMinutes;
}

/** Minutes to wait between trades, under the style in use. */
export function cooldownMinutesFor(config: Pick<TradingConfig, "strategy" | "risk">): number {
  return isScalping(config) ? config.risk.scalpCooldownMinutes : config.risk.cooldownMinutes;
}

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
  if (top.mode !== undefined && top.mode !== "paper") problems.push("The settings are always paper: live trading is switched on for one day at a time on the Strategies page");

  const strategy = section("strategy");
  if (strategy) {
    apply(next.strategy, strategy, "signal", (v, n) => oneOf(v, n, SIGNALS.map((s) => s.id)), "Signal");
    if (strategy.rule === null) next.strategy.rule = null;
    else apply(next.strategy, strategy, "rule", (v, n) => oneOf(v, n, FOLLOWABLE_RULES.map((r) => r.id)), "Rule");
    apply(next.strategy, strategy, "costCheck", bool, "Cost check");
    apply(next.strategy, strategy, "side", (v, n) => oneOf(v, n, ["both", "calls", "puts"] as const), "Side");
    apply(next.strategy, strategy, "strikeOffset", (v, n) => number(v, n, -5, 5, true), "Strike offset");
    apply(next.strategy, strategy, "lots", (v, n) => number(v, n, 1, 50, true), "Lots");
    // Up to a whole session: a rule held until the close (Trend day, held) sets 360.
    apply(next.strategy, strategy, "holdMinutes", (v, n) => number(v, n, 1, 375, true), "Hold");
    apply(next.strategy, strategy, "stopLossPct", (v, n) => number(v, n, 0, 90), "Stop loss");
    apply(next.strategy, strategy, "targetPct", (v, n) => number(v, n, 0, 500), "Target");
    apply(next.strategy, strategy, "trailStop", bool, "Trailing stop");
    apply(next.strategy, strategy, "exitIn", (v, n) => oneOf(v, n, ["percent", "rupees"] as const), "Stop and target in");
    apply(next.strategy, strategy, "exitsFrom", (v, n) => oneOf(v, n, ["volatility", "fixed"] as const), "Stop and target from");
    apply(next.strategy, strategy, "stopMoves", (v, n) => number(v, n, 0.25, 10), "Stop in typical moves");
    apply(next.strategy, strategy, "targetMoves", (v, n) => number(v, n, 0.25, 20), "Target in typical moves");
    apply(next.strategy, strategy, "stopNet", (v, n) => number(v, n, 0, 1_000_000), "Stop loss in rupees");
    apply(next.strategy, strategy, "targetNet", (v, n) => number(v, n, 0, 1_000_000), "Target in rupees");
    apply(next.strategy, strategy, "scalpHoldMinutes", (v, n) => number(v, n, 1, 240, true), "Scalping hold");
    apply(next.strategy, strategy, "exitOnOpposite", bool, "Exit on opposite signal");
    apply(next.strategy, strategy, "minDaysToExpiry", (v, n) => number(v, n, 0, 30, true), "Minimum days to expiry");
  }

  const risk = section("risk");
  if (risk) {
    apply(next.risk, risk, "entryFrom", time, "Entries from");
    apply(next.risk, risk, "entryUntil", time, "Entries until");
    apply(next.risk, risk, "squareOffAt", time, "Square-off time");
    apply(next.risk, risk, "maxTradesPerDay", (v, n) => number(v, n, 1, 200, true), "Trades a day");
    apply(next.risk, risk, "maxOpenPositions", (v, n) => number(v, n, 1, 10, true), "Positions at once");
    apply(next.risk, risk, "maxDailyLoss", (v, n) => number(v, n, 100, 1_000_000), "Daily loss limit");
    apply(next.risk, risk, "maxConsecutiveLosses", (v, n) => number(v, n, 1, 50, true), "Losses in a row");
    apply(next.risk, risk, "maxPremiumPerTrade", (v, n) => number(v, n, 500, 10_000_000), "Premium per trade");
    apply(next.risk, risk, "minPremium", (v, n) => number(v, n, 0, 1_000), "Minimum premium");
    apply(next.risk, risk, "maxSpreadPct", (v, n) => number(v, n, 0.1, 50), "Spread limit");
    apply(next.risk, risk, "cooldownMinutes", (v, n) => number(v, n, 0, 120), "Cooldown");
    apply(next.risk, risk, "scalpCooldownMinutes", (v, n) => number(v, n, 0, 120), "Scalping wait");
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
    const provider = next.decision.provider;
    apply(next.decision, decision, "provider", (v, n) => oneOf(v, n, ["openrouter", "liquid"] as const), "Decision provider");
    // A new provider without a model named alongside it gets that provider's default model.
    if (next.decision.provider !== provider && decision.model === undefined) {
      next.decision.model = DECISION_PROVIDERS.find((p) => p.id === next.decision.provider)!.defaultModel;
    }
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

export type ExitReason = "stop" | "trail" | "target" | "time" | "opposite" | "square-off" | "manual" | "halt";
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
  /**
   * A trailing stop: how far below the best price the stop stays (percent of that price), the best
   * last price since the buy, and whether the stop has moved up from where it started.
   */
  trail?: { pct: number; best: number; raised: boolean } | null;
  /** What the stop and target trigger on: the last traded price (percent), or the bid when known (rupees). */
  exitIn?: "percent" | "rupees";
  /** With volatility exits: the levels worked out for this trade when it was proposed, and from what. */
  plannedExits?: {
    stopPct: number;
    targetPct: number;
    /** NIFTY's typical move over the hold the levels came from, in points. */
    move: number;
    holdMinutes: number;
    /** Measured from recent days at this time of day, or from today's 1-minute move. */
    source?: "history" | "today";
    /** With history: the recent days' typical move, today's busyness scale, and how many days. */
    history?: number;
    scale?: number;
    days?: number;
  } | null;
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
  /** Each signal's reading and vote (singles, then combined), then the chosen signal's vote. */
  readings: SignalReadingLine[];
  vote: -1 | 0 | 1;
  stance: string;
  score: number;
  /** Whether the 20-level book had a reading, and how old the option chain snapshot was, in minutes (null without one). Absent from older engines. */
  inputs?: { depth: boolean; chainAgeMinutes: number | null };
}

export interface SignalReadingLine {
  id: SignalId;
  name: string;
  reading: string;
  vote: -1 | 0 | 1;
  /** The number a single signal compares with its line, and the line: it votes when the number's size reaches the line. Null for combined signals; absent from older engines. */
  value?: number | null;
  threshold?: number | null;
  /** Today so far, at the Signal lab hold nearest the strategy's (not longer): firings whose hold has ended, how many NIFTY then moved the signal's way, and NIFTY points gained following them before costs. */
  today?: { horizon: number; fired: number; right: number; points: number };
  /** Its latest firings today, newest first, at most three. `outcome` is NIFTY's points over the hold after it (null while the hold is still running). `at` is the start of the firing minute. */
  recent?: { at: number; vote: 1 | -1; reading: string; outcome: number | null }[];
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
  /** The recent days volatility exits measure NIFTY's typical move from; null while today's formula stands in. */
  moveHistory?: { days: number; from: string; to: string } | null;
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
  /** Whether the chosen decision provider has a key configured. */
  decisionReady: boolean;
  /** Which providers have a key configured. */
  decisionProviders: Record<DecisionProviderId, boolean>;
  /** The depth and option data this engine's AI check request carries. Absent from older engines, whose request carries neither. */
  aiCheckData?: readonly DecisionData[];
  /**
   * The last traded price of every contract traded in this run, by feed key, so closed trades can
   * show where the option went after it was sold. Contracts stay subscribed for the whole run.
   */
  prices: Record<string, { price: number; at: number }>;
  /** The scalp lab: fast triggers scored after charges, never traded. Absent from an older engine. */
  scalpLab?: ScalpLabStatus;
  /** The live pilot: real orders with Dhan following this paper book. Absent from an older engine. */
  live?: LiveStatus;
}

export type ScalpTriggerId = "burst" | "fade" | "lean" | "baseline";

/** One trigger's record at one hold: pretend trades in one lot of the at-the-money option. */
export interface ScalpCell {
  holdSeconds: number;
  trades: number;
  wins: number;
  /** Rupees after charges and slippage, summed. */
  net: number;
}

export interface ScalpFiring {
  id: string;
  trigger: ScalpTriggerId;
  at: number;
  direction: 1 | -1;
  /** What the trigger saw, in words. */
  reading: string;
  contract: string | null;
  /** Ask plus slippage; null until the entry is priced, or when it couldn't be. */
  entry: number | null;
  /** Net rupees at each hold, in `holds` order; null while running or when there was no price. */
  results: (number | null)[];
  /** Why it wasn't scored, when it wasn't. */
  note: string | null;
}

export interface ScalpLabStatus {
  state: "off" | "waiting" | "running";
  /** What it is waiting for, in words. */
  note: string | null;
  future: string | null;
  holds: number[];
  triggers: { id: ScalpTriggerId; name: string; about: string; cells: ScalpCell[] }[];
  /** Newest first. */
  recent: ScalpFiring[];
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
  /**
   * Sell one paper position now. Its own action, not an option on `flatten`: an engine older than
   * it refuses an unknown action, where it would ignore an unknown field and sell everything.
   */
  | { action: "sell"; positionId: string }
  /** Stop trading for the day and sell open positions; `resume` lifts it. */
  | { action: "halt" }
  | { action: "resume" }
  | { action: "config"; patch: unknown }
  | LiveCommand;

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
