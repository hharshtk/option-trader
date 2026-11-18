// The decision API as a second opinion on each entry. When the strategy proposes a trade, the
// engine sends the market context as JSON with three typed questions and gets probabilities back,
// from OpenRouter's Decisions API (scripts/decision-demo.ts) or Liquid's
// (scripts/liquid-decision-test.ts): the same questions, the same answers.
//
//   take_trade  noul    the probability that the context supports the trade
//   regime      choice  trend up, trend down, range or chop
//   quality     score   how well supported the move is
//
// Rules, from docs/engine-plan.md: it can turn a trade down or annotate it; it never sizes a
// trade, never creates one, and never delays an exit. No answer in time means no entry, unless
// the settings say otherwise. The request carries market features only, nothing about the account.

import { createHash } from "node:crypto";
import { impliedMove, istWeekday, optionView, tradingMinutesToExpiry } from "../../lib/insight/derivatives.ts";
import { HORIZONS, type Pulse } from "../../lib/insight/pulse.ts";
import { SIGNALS, type DecisionProviderId, type OptionRef, type SignalId, type SignalReading, type TradingConfig } from "../../lib/engine/trading.ts";
import { exitPercents } from "../../lib/trading/exits.ts";

export interface DecisionAnswer {
  /** Probability the trade should be taken, 0 to 1. */
  probability: number;
  regime: string | null;
  regimeProbabilities: Record<string, number> | null;
  /** 0 (fragile) to 1 (broad and well supported). */
  quality: number | null;
  model: string;
  inputTokens: number | null;
  cost: number | null;
}

export interface DecisionProvider {
  /** False when no API key is configured: every ask fails. */
  ready: boolean;
  ask(request: { model: string; state: unknown; timeoutMs: number }): Promise<DecisionAnswer>;
}

const QUALITY_LEVELS = [
  "Fragile: carried by a few stocks, already extended, fading, or against futures and option positioning",
  "Mixed: some support, some evidence against",
  "Broad: most stocks, futures positioning and flow, option writers and recent momentum agree",
];

export const QUESTIONS = {
  take_trade: {
    type: "noul",
    instructions:
      "Should this intraday NIFTY option trade be taken now? `proposal` is a bought option held for a few minutes in the direction given. `trade_math` says how far NIFTY must move the right way to pay for the trade and how far it typically moves over the hold; `trigger_track_record` says how the trigger has done before. Judge only from the market context in the state.",
    criteria: {
      true: "Breadth, futures positioning and flow, option writers and recent price action support the direction over the planned hold, and the expected move is comfortably larger than the break-even move",
      false: "The move looks exhausted, narrow or contradicted by futures or option positioning, or the expected move over the hold is not comfortably larger than the break-even move",
    },
  },
  regime: {
    type: "choice",
    instructions: "Which regime describes NIFTY right now?",
    criteria: {
      trend_up: "Rising with broad participation",
      trend_down: "Falling with broad participation",
      range: "Sideways in a narrow band",
      chop: "Volatile swings with no direction",
    },
  },
  quality: {
    type: "score",
    instructions: "How well supported is the move behind this proposal?",
    criteria: QUALITY_LEVELS,
  },
} as const;

/** Changes when the questions do, so recorded answers to older questions are never reused. */
export const QUESTIONS_HASH = createHash("sha256").update(JSON.stringify(QUESTIONS)).digest("hex").slice(0, 12);

/**
 * The shape of the market context sent. Raise it whenever `buildDecisionState()` sends something
 * different, so a replay never reuses an answer given to another context.
 *   1: Pulse evidence, signals, verdict, breadth, sectors (16 November 2026)
 *   2: trade maths, futures, option positioning, volatility, the trigger's record; evidence lines dropped (18 November 2026)
 */
export const STATE_VERSION = 3;

const round = (value: number | null | undefined, digits = 2) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

const IST_OFFSET_MS = 5.5 * 3_600_000;
const istClock = (time: number) => new Date(time + IST_OFFSET_MS).toISOString().slice(11, 16);

/**
 * The market context sent with a proposal, grouped by what a trader checks before buying an option:
 * can the trade pay for itself, what NIFTY and its stocks are doing, what futures and option
 * writers are doing, how volatile it is, and how the trigger has done before. Each fact appears
 * once, with its unit in its name. Numbers are rounded: the model needs the picture, not the paise.
 * Sections are null when the day has no data for them (futures and options from 18 November 2026).
 */
export function buildDecisionState(input: {
  pulse: Pulse;
  reading: SignalReading;
  /** The signal the strategy follows. */
  follow: SignalId;
  direction: 1 | -1;
  contract: OptionRef;
  /** What the entry would pay: the ask, or the last price without a book. */
  premium: number;
  /** The contract's best bid and ask, when the book is known. */
  quote: { bid: number | null; ask: number | null };
  /** Round-trip charges and slippage as a share of the premium paid, in percent. */
  costPct: number;
  /** Per-unit slippage on a sale, with and without an order book: rupee exits are raised by it. */
  slippage?: { book: number; loose: number };
  daysToExpiry: number;
  strategy: TradingConfig["strategy"];
  at: number;
  /** The market day, YYYY-MM-DD IST. */
  date: string;
  session: { open: number; close: number };
  /** Paper trades closed so far today. */
  today: { trades: number; wins: number; lastResults: number[] };
}) {
  const { pulse, reading, direction, contract, strategy, at, session, quote, premium } = input;
  const hold = strategy.holdMinutes;
  const recent = pulse.series
    .filter((point) => point.at <= reading.minute && point.nifty !== null)
    .slice(-15)
    .map((point) => round(point.nifty, 1));
  const sectors = [...pulse.sectors].sort((a, b) => b.recentPoints - a.recentPoints);
  const der = pulse.derivatives;
  const fut = der?.future ?? null;
  const opt = der?.options ?? null;
  const chain = der?.chain ?? null;

  // --- Can the trade pay for itself? -----------------------------------------------------------
  const spread = quote.bid !== null && quote.ask !== null && quote.ask >= quote.bid ? quote.ask - quote.bid : null;
  const mid = spread !== null ? (quote.bid! + quote.ask!) / 2 : premium;
  const minutesToExpiry = tradingMinutesToExpiry(at, contract.expiry, input.date, session);
  const forward = opt?.forward ?? pulse.nifty.ltp;
  const greeks = optionView({ premium: mid, forward, strike: contract.strike, type: contract.type, minutesToExpiry, holdMinutes: hold });
  const delta = greeks ? Math.abs(greeks.delta) : null;
  // Charges and slippage, the spread (bought at the ask, sold at the bid) and the time value lost
  // over the hold, in rupees per unit; divided by delta, the NIFTY move that pays for them.
  const costPerUnit = (input.costPct / 100) * premium + (spread ?? 0);
  const breakEven = delta && delta > 0.02 ? (costPerUnit + greeks!.decay) / delta : null;
  const priced = opt ? impliedMove(opt.straddle, opt.minutesToExpiry, hold) : null;
  const actual = pulse.volatility.minuteMove === null ? null : pulse.volatility.minuteMove * Math.sqrt(hold);
  // Rupee exits (scalping) become the share of the premium they come to on this contract.
  const slippage = quote.bid !== null ? input.slippage?.book ?? 0 : input.slippage?.loose ?? 0;
  const exits =
    strategy.exitIn === "rupees"
      ? exitPercents(strategy, premium, strategy.lots * contract.lotSize, contract.tickSize, slippage)
      : { stopPct: strategy.stopLossPct || null, targetPct: strategy.targetPct || null };
  const stopPct = exits.stopPct ?? 0;
  const targetPct = exits.targetPct ?? 0;
  const pointsFor = (pct: number) => (delta && delta > 0.02 && pct > 0 ? ((pct / 100) * premium + greeks!.decay) / delta : null);

  // --- The trigger's record --------------------------------------------------------------------
  const followed = pulse.signals.find((s) => s.id === input.follow);
  const horizon = [...HORIZONS].reverse().find((h) => h <= hold) ?? HORIZONS[0];
  const todayStats = followed?.stats.find((st) => st.horizon === horizon);
  const pastYear = SIGNALS.find((s) => s.id === input.follow)?.pastYear ?? null;
  const baseline = pulse.baselines.find((b) => b.horizon === horizon);

  const share = (flow: number | null) => (flow === null ? null : round((1 + flow) / 2));
  const wall = (w: { strike: number; lots: number; points: number } | null) => (w ? { strike: w.strike, points_away: round(w.points, 1), lots: w.lots } : null);

  return {
    state_version: STATE_VERSION,
    market: "NIFTY 50 index options, NSE India, intraday",
    time: {
      ist: istClock(at),
      weekday: istWeekday(at),
      minutes_since_open: Math.round((at - session.open) / 60_000),
      minutes_to_close: Math.round((session.close - at) / 60_000),
    },
    proposal: {
      direction: direction > 0 ? "long: buy a call, profits if NIFTY rises" : "short: buy a put, profits if NIFTY falls",
      followed_signal: followed?.name ?? input.follow,
      trigger: reading.readings.filter((r) => r.vote === direction).map((r) => `${r.name}: ${r.reading}`),
      contract: contract.name,
      premium: round(premium),
      planned_hold_minutes: hold,
      stop_loss_pct: round(exits.stopPct, 1),
      target_pct: round(exits.targetPct, 1),
      ...(strategy.exitIn === "rupees"
        ? { stop_loss_rupees_after_charges: strategy.stopNet || null, target_rupees_after_charges: strategy.targetNet || null }
        : {}),
    },
    trade_math: {
      days_to_expiry: input.daysToExpiry,
      expiry_day: input.daysToExpiry === 0,
      costs_pct_of_premium: round(input.costPct),
      spread_pct_of_premium: spread === null ? null : round((spread / mid) * 100),
      delta: greeks ? round(greeks.delta) : null,
      implied_volatility_pct: greeks ? round(greeks.ivPct, 1) : null,
      time_decay_over_hold_rupees: greeks ? round(greeks.decay) : null,
      break_even_nifty_points: round(breakEven, 1),
      target_needs_nifty_points: round(pointsFor(targetPct), 1),
      stop_at_nifty_points_against: round(delta && delta > 0.02 && stopPct > 0 ? ((stopPct / 100) * premium - greeks!.decay) / delta : null, 1),
      expected_nifty_move_over_hold_points: {
        priced_by_options: round(priced, 1),
        recent_actual: round(actual, 1),
        typical_today: baseline && baseline.windows >= 5 && baseline.horizon === hold ? round(baseline.medianMove, 1) : null,
      },
    },
    nifty: {
      last: round(pulse.nifty.ltp, 1),
      change_pct_from_previous_close: round(pulse.nifty.change * 100),
      points_from_open: pulse.nifty.open === null ? null : round(pulse.nifty.ltp - pulse.nifty.open, 1),
      day_high: round(pulse.nifty.high, 1),
      day_low: round(pulse.nifty.low, 1),
      position_in_day_range: round(pulse.nifty.rangePosition),
      points_last_15_minutes: round(pulse.nifty.recentPoints, 1),
      last_15_one_minute_closes: recent,
    },
    volatility: {
      india_vix: round(pulse.volatility.vix),
      india_vix_change_pct: pulse.volatility.vixChangePct,
      average_1_minute_move_points: pulse.volatility.minuteMove,
      option_volatility_change_since_open_pct: opt?.ivChangeSinceOpenPct ?? null,
    },
    breadth: {
      stocks: pulse.contributions.length,
      advancers: pulse.breadth.advancers,
      decliners: pulse.breadth.decliners,
      weight_above_vwap: round(pulse.breadth.weightAboveVwap),
      order_book_imbalance: round(pulse.breadth.book),
    },
    futures: fut && {
      contract: fut.name,
      premium_over_index_points: fut.basis,
      premium_change_15m_points: fut.basisChange15,
      price_vs_vwap_points: fut.vsVwap,
      move_15m_pct: fut.move15Pct,
      oi_change_15m_pct: fut.oiChange15Pct,
      oi_change_today_pct: fut.oiChangeDayPct,
      positioning_15m: fut.positioning15,
      buyers_share_of_volume_5m: share(fut.flow5),
      buyers_share_of_volume_15m: share(fut.flow15),
      net_lots_bought_15m: fut.netLots15,
      book_imbalance_5_levels: fut.bookImbalance,
      book_imbalance_20_levels: fut.book20Imbalance,
      orders_imbalance_20_levels: fut.book20OrdersImbalance,
      bid_ask_spread_points: fut.spread,
    },
    options_positioning: opt && {
      expiry: opt.expiry,
      near_the_money: `within 10 strikes of ${opt.atm}`,
      put_call_oi_ratio: opt.pcr,
      put_call_oi_ratio_15m_ago: opt.pcr15,
      put_call_oi_ratio_at_open: opt.pcrAtOpen,
      call_oi_change_15m_lots: opt.callOiChange15Lots,
      put_oi_change_15m_lots: opt.putOiChange15Lots,
      call_oi_change_today_lots: opt.callOiChangeDayLots,
      put_oi_change_today_lots: opt.putOiChangeDayLots,
      largest_call_oi_above: wall(opt.callWall),
      largest_put_oi_below: wall(opt.putWall),
      max_pain_strike: opt.maxPain,
    },
    option_chain: chain && {
      expiry: chain.expiry,
      snapshot_minutes_old: chain.ageMinutes,
      at_the_money_iv_pct: chain.ivPct,
      iv_change_15m_points: chain.ivChange15,
      iv_change_since_first_snapshot_points: chain.ivChangeSinceFirst,
      put_minus_call_iv_1pct_out_points: chain.skewPct,
      next_expiry: chain.nextExpiry,
      next_expiry_iv_pct: chain.nextIvPct,
      put_call_oi_ratio_all_strikes: chain.pcr,
      call_oi_change_today_lots_all_strikes: chain.callOiChangeDayLots,
      put_oi_change_today_lots_all_strikes: chain.putOiChangeDayLots,
      largest_call_oi_above_all_strikes: wall(chain.callWall),
      largest_put_oi_below_all_strikes: wall(chain.putWall),
    },
    signals: reading.readings.map((r) => ({ name: r.name, reading: r.reading, vote: r.vote })),
    trigger_track_record: {
      today: todayStats ? { hold_minutes: horizon, trades: todayStats.fired, right: todayStats.hits, nifty_points: round(todayStats.gross, 1) } : null,
      past_year: pastYear
        ? { span: pastYear.span, hold_minutes: pastYear.holdMinutes, trades: pastYear.trades, right_pct: round(pastYear.winRate * 100, 1), nifty_points_per_trade: pastYear.pointsPerTrade }
        : "none: futures and options have been recorded only since 18 Nov 2026",
    },
    pulse_verdict: { stance: pulse.verdict.stance, score: pulse.score, headline: pulse.verdict.headline },
    sectors_last_15_minutes: {
      strongest: sectors.slice(0, 3).map((s) => ({ sector: s.sector, points: round(s.recentPoints, 1) })),
      weakest: sectors.slice(-3).reverse().map((s) => ({ sector: s.sector, points: round(s.recentPoints, 1) })),
    },
    concentration: {
      top_three: pulse.concentration.top.map((c) => c.symbol),
      top_three_points: round(pulse.concentration.topPoints, 1),
      rest_points: round(pulse.concentration.restPoints, 1),
    },
    strategy_today: {
      trades: input.today.trades,
      wins: input.today.wins,
      last_results: input.today.lastResults.map((net) => (net > 0 ? "win" : "loss")),
    },
  };
}

/** Whether an answer lets the trade through, and why. */
export function judge(answer: DecisionAnswer, direction: 1 | -1, config: TradingConfig["decision"]): { approved: boolean; reason: string } {
  const p = answer.probability;
  if (p < config.minProbability) {
    return { approved: false, reason: `Probability ${p.toFixed(2)} is below ${config.minProbability.toFixed(2)}` };
  }
  if (config.vetoAgainstRegime && ((direction > 0 && answer.regime === "trend_down") || (direction < 0 && answer.regime === "trend_up"))) {
    return { approved: false, reason: `Against the regime (${answer.regime === "trend_up" ? "trend up" : "trend down"})` };
  }
  return { approved: true, reason: `Probability ${p.toFixed(2)}${answer.regime ? `, ${answer.regime.replace("_", " ")}` : ""}` };
}

interface RawAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
}

/** Reads the API's answers. Throws when the question that gates the trade wasn't answered. */
export function readAnswers(response: { answers?: Record<string, unknown>; model?: string; usage?: { inputTokens?: number; input_tokens?: number; cost?: number } }): DecisionAnswer {
  const answers = (response.answers ?? {}) as Record<string, RawAnswer | undefined>;
  const take = answers.take_trade;
  if (!take || take.type !== "noul" || typeof take.noul !== "number" || !(take.noul >= 0 && take.noul <= 1)) {
    throw new Error(take?.type === "refusal" ? "The model declined to answer" : "The model gave no probability");
  }
  const regime = answers.regime;
  const quality = answers.quality;
  return {
    probability: take.noul,
    regime: regime?.type === "choice" && typeof regime.choice === "string" ? regime.choice : null,
    regimeProbabilities: regime?.type === "choice" && regime.probabilities ? regime.probabilities : null,
    // The score is the expected level, from 0 to the number of levels minus one.
    quality: quality?.type === "score" && typeof quality.score === "number" ? Math.min(1, Math.max(0, quality.score / (QUALITY_LEVELS.length - 1))) : null,
    model: response.model ?? "",
    // OpenRouter's SDK says inputTokens, Liquid's API input_tokens.
    inputTokens: response.usage?.inputTokens ?? response.usage?.input_tokens ?? null,
    cost: response.usage?.cost ?? null,
  };
}

/** The decision API through OpenRouter. The SDK loads on the first question. */
export function createOpenRouterDecisions(apiKey: string | undefined): DecisionProvider {
  const key = apiKey?.trim();
  let client: Promise<{ alpha: { decisions: { create(request: unknown, options?: { timeoutMs?: number }): Promise<unknown> } } }> | undefined;
  return {
    ready: Boolean(key),
    async ask({ model, state, timeoutMs }) {
      if (!key) throw new Error("OPENROUTER_API_KEY is not set in .env.local");
      client ??= import("@openrouter/sdk").then(({ OpenRouter }) => new OpenRouter({ apiKey: key }) as never);
      const openrouter = await client;
      const response = await openrouter.alpha.decisions.create({ decisionsRequest: { model, state, questions: QUESTIONS } }, { timeoutMs });
      return readAnswers(response as Parameters<typeof readAnswers>[0]);
    },
  };
}

/** Liquid's decisions API, with plain fetch. Same questions and answers as OpenRouter's. */
export function createLiquidDecisions(apiKey: string | undefined, fetcher: typeof fetch = fetch): DecisionProvider {
  const key = apiKey?.trim();
  return {
    ready: Boolean(key),
    async ask({ model, state, timeoutMs }) {
      if (!key) throw new Error("LIQUID_API_KEY is not set in .env.local");
      const response = await fetcher("https://api.liquid.ai/decisions/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, state, questions: QUESTIONS }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Liquid answered HTTP ${response.status}: ${text.slice(0, 200)}`);
      return readAnswers(JSON.parse(text) as Parameters<typeof readAnswers>[0]);
    },
  };
}

/** One client per provider, from the keys in the environment. */
export function createDecisionProviders(env: Record<string, string | undefined>): Record<DecisionProviderId, DecisionProvider> {
  return { openrouter: createOpenRouterDecisions(env.OPENROUTER_API_KEY), liquid: createLiquidDecisions(env.LIQUID_API_KEY) };
}

/** Identifies a proposal, so a replay reuses the answer recorded for it instead of asking again. */
export function decisionKey(parts: { model: string; minute: number; direction: 1 | -1; signal: string; securityId: string }) {
  return [parts.model, QUESTIONS_HASH, `s${STATE_VERSION}`, parts.minute, parts.direction, parts.signal, parts.securityId].join("|");
}
