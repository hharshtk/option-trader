// The decision API as a second opinion on each entry. When the strategy proposes a trade, the
// engine sends the market context as JSON with three typed questions (OpenRouter's Decisions API,
// see scripts/decision-demo.ts) and gets probabilities back:
//
//   take_trade  noul    the probability that the context supports the trade
//   regime      choice  trend up, trend down, range or chop
//   quality     score   how well supported the move is
//
// Rules, from docs/engine-plan.md: it can turn a trade down or annotate it; it never sizes a
// trade, never creates one, and never delays an exit. No answer in time means no entry, unless
// the settings say otherwise. The request carries market features only, nothing about the account.

import { createHash } from "node:crypto";
import type { Pulse } from "../../lib/insight/pulse.ts";
import type { OptionRef, SignalReading, TradingConfig } from "../../lib/engine/trading.ts";

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
  "Fragile: carried by a few stocks, already extended, or fading",
  "Mixed: some support, some evidence against",
  "Broad: most stocks, the day's structure and recent momentum agree",
];

export const QUESTIONS = {
  take_trade: {
    type: "noul",
    instructions:
      "Should this intraday NIFTY option trade be taken now? `proposal` is a long option position held for a few minutes in the direction given. Judge only from the market context in the state.",
    criteria: {
      true: "The evidence, breadth and recent price action support the proposed direction over the planned hold, with room to cover the costs",
      false: "The move looks exhausted, narrow or contradicted by the evidence, or the expected move is too small to cover the costs",
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

const round = (value: number | null | undefined, digits = 2) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

const IST_OFFSET_MS = 5.5 * 3_600_000;
const istClock = (time: number) => new Date(time + IST_OFFSET_MS).toISOString().slice(11, 16);

/** The market context sent with a proposal. Numbers are rounded: the model needs the picture, not the paise. */
export function buildDecisionState(input: {
  pulse: Pulse;
  reading: SignalReading;
  direction: 1 | -1;
  contract: OptionRef;
  premium: number;
  /** Round-trip charges and slippage as a share of the premium paid, in percent. */
  costPct: number;
  daysToExpiry: number;
  strategy: TradingConfig["strategy"];
  at: number;
  session: { open: number; close: number };
  /** Paper trades closed so far today. */
  today: { trades: number; wins: number; lastResults: number[] };
}) {
  const { pulse, reading, direction, contract, strategy, at, session } = input;
  const recent = pulse.series
    .filter((point) => point.at <= reading.minute && point.nifty !== null)
    .slice(-15)
    .map((point) => round(point.nifty, 1));
  const sectors = [...pulse.sectors].sort((a, b) => b.recentPoints - a.recentPoints);
  return {
    market: "NIFTY 50 index options, NSE India, intraday",
    time_ist: istClock(at),
    minutes_since_open: Math.round((at - session.open) / 60_000),
    minutes_to_close: Math.round((session.close - at) / 60_000),
    proposal: {
      direction: direction > 0 ? "long: buy a call, profits if NIFTY rises" : "short: buy a put, profits if NIFTY falls",
      trigger: reading.readings.filter((r) => r.vote === direction).map((r) => `${r.name}: ${r.reading}`),
      contract: contract.name,
      premium: round(input.premium),
      days_to_expiry: input.daysToExpiry,
      planned_hold_minutes: strategy.holdMinutes,
      stop_loss_pct: strategy.stopLossPct || null,
      target_pct: strategy.targetPct || null,
      costs_pct_of_premium: round(input.costPct),
    },
    nifty: {
      last: round(pulse.nifty.ltp, 1),
      change_pct_from_previous_close: round(pulse.nifty.change * 100),
      points_from_open: pulse.nifty.open === null ? null : round(pulse.nifty.ltp - pulse.nifty.open, 1),
      position_in_day_range: round(pulse.nifty.rangePosition),
      points_last_15_minutes: round(pulse.nifty.recentPoints, 1),
      last_15_one_minute_closes: recent,
    },
    breadth: {
      advancers: pulse.breadth.advancers,
      decliners: pulse.breadth.decliners,
      weight_above_vwap: round(pulse.breadth.weightAboveVwap),
      order_book_imbalance: round(pulse.breadth.book),
    },
    evidence: pulse.evidence.map((e) => ({ label: e.label, detail: e.detail, vote: e.vote })),
    signals: reading.readings.map((r) => ({ name: r.name, reading: r.reading, vote: r.vote })),
    verdict: { stance: pulse.verdict.stance, score: pulse.score, headline: pulse.verdict.headline },
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
export function readAnswers(response: { answers?: Record<string, unknown>; model?: string; usage?: { inputTokens?: number; cost?: number } }): DecisionAnswer {
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
    inputTokens: response.usage?.inputTokens ?? null,
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

/** Identifies a proposal, so a replay reuses the answer recorded for it instead of asking again. */
export function decisionKey(parts: { model: string; minute: number; direction: 1 | -1; signal: string; securityId: string }) {
  return [parts.model, QUESTIONS_HASH, parts.minute, parts.direction, parts.signal, parts.securityId].join("|");
}
