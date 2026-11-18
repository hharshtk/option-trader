// The Decision API over a study's firings: for each firing of the study's own signal and holding
// time, ask the model what the trader would have asked at that minute, then compare the firings
// it approved with the ones it turned down. Uses the trader's own context, questions and gate rule
// (decision.ts), with two research-only changes:
//
// - No look-ahead: the context is built from the day as it stood when the firing's minute closed.
// - Nothing that names the day: the model is dated after every day in the history and may search
//   the web, so the contract, its expiry and every exact NIFTY level are replaced by changes. Live
//   trading keeps sending its full context; the report says research's differs.
//
// Answers are stored as they arrive, so a pass that stops (the free quota, a cancel) resumes where
// it left off, and running it again asks nothing it has asked before.

import { createHash } from "node:crypto";
import { computePulse } from "../../lib/insight/pulse.ts";
import { sessionInputs } from "../../lib/strategies/signals.ts";
import { buildDays, isFrame, NIFTY_CONSTITUENTS, NIFTY_KEY, sessionUntil, VIX_KEY, DailyCloses, type DayFrame } from "../../lib/research/day-frames.ts";
import { monthsBetween } from "../../lib/research/candle-history.ts";
import type { StudyInputs } from "../../lib/research/run-study.ts";
import { measure } from "../../lib/research/stats.ts";
import type { DetailEvent, GateAnswerRow, GateGroup, GateSummary, StudyManifest } from "../../lib/research/types.ts";
import { optionCostPoints } from "../../lib/research/costs.ts";
import { buildDecisionState, judge, QUESTIONS_HASH, type DecisionAnswer, type DecisionProvider } from "../trading/decision.ts";
import { readSignal } from "../trading/strategy.ts";
import { DEFAULT_TRADING_CONFIG, type TradingConfig } from "../../lib/engine/trading.ts";

const MINUTE_MS = 60_000;

/** Days from `date` to NIFTY's weekly expiry, a Tuesday (holidays that move it aren't known here). */
export function daysToWeeklyExpiry(date: string): number {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (2 - weekday + 7) % 7;
}

/** Numbers that look like a NIFTY level (1,000 and up), which could identify the day. */
const LEVEL = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{4,}(?:\.\d+)?\b/g;

/**
 * The trader's context with everything that could name the day taken out: the contract and its
 * expiry, NIFTY's level, its closes (as points from the latest), and levels in the evidence lines.
 */
export function anonymize(state: ReturnType<typeof buildDecisionState>, type: "CE" | "PE") {
  const { nifty } = state;
  const latest = nifty.last_15_one_minute_closes.at(-1) ?? null;
  return {
    ...state,
    proposal: { ...state.proposal, contract: `NIFTY ${type === "CE" ? "call" : "put"}, at the money, nearest weekly expiry` },
    // Listed field by field, so a level added to the trader's context later can't slip through.
    nifty: {
      change_pct_from_previous_close: nifty.change_pct_from_previous_close,
      points_from_open: nifty.points_from_open,
      position_in_day_range: nifty.position_in_day_range,
      points_last_15_minutes: nifty.points_last_15_minutes,
      last_15_one_minute_closes_in_points_from_now: nifty.last_15_one_minute_closes.map((close) => (close === null || latest === null ? null : Number((close - latest).toFixed(1)))),
    },
    evidence: state.evidence.map((e) => ({
      ...e,
      detail: e.detail
        .replace(/ pts from [\d,.]+$/, " pts from the open")
        .replace(/ of [\d,.]+–[\d,.]+ \(/, " of the day's range (")
        .replace(LEVEL, "(level)"),
    })),
  };
}

export const contextKey = (model: string, state: unknown) => createHash("sha256").update(`${model}\0${QUESTIONS_HASH}\0${JSON.stringify(state)}`).digest("hex");

export interface GatePassOptions {
  manifest: StudyManifest;
  /** The study's primary firings, oldest first. */
  events: readonly DetailEvent[];
  inputs: StudyInputs;
  provider: DecisionProvider;
  model: string;
  rule: GateSummary["rule"];
  /** Answers already held for this study, by context key. */
  cached: ReadonlyMap<string, GateAnswerRow>;
  /** How many more questions may be asked now; checked before each one. */
  allowance: () => Promise<{ count: number; reason: string }>;
  /** Called with each new answer, to store it. */
  record: (row: GateAnswerRow) => Promise<void>;
  onProgress?: (done: number, total: number, label: string) => void;
  /** Wait between questions: free models allow 20 a minute. */
  pauseMs?: number;
  timeoutMs?: number;
}

/** Asks about every firing without an answer yet; returns every answer held and why it stopped early, if it did. */
export async function runGatePass(options: GatePassOptions): Promise<{ answers: GateAnswerRow[]; stopped: string | null }> {
  const { manifest, events, inputs, provider, model, cached, record } = options;
  const { spec } = manifest;
  const strategy: TradingConfig["strategy"] = { ...DEFAULT_TRADING_CONFIG.strategy, signal: spec.primary.signal, holdMinutes: spec.primary.horizon, params: spec.signalParams ?? DEFAULT_TRADING_CONFIG.strategy.params };
  const option = spec.costs.option;
  // Charges and slippage as a share of the premium, as the trader computes it: the study's assumed premium.
  const costPct = ((optionCostPoints(option) * option.delta) / option.premium) * 100;
  const byDay = new Map<string, DetailEvent[]>();
  for (const event of events) byDay.set(event.day, [...(byDay.get(event.day) ?? []), event]);

  const answers: GateAnswerRow[] = [];
  const closes = new DailyCloses(await inputs.dailyCloses());
  const breadthKeys = NIFTY_CONSTITUENTS.map((c) => c.key);
  const months = monthsBetween(spec.from.slice(0, 7), spec.to.slice(0, 7)).filter((month) => [...byDay.keys()].some((day) => day.startsWith(month)));
  let done = 0;
  let stopped: string | null = null;

  for (const month of months) {
    if (stopped) break;
    const columns = await inputs.month(month, [NIFTY_KEY, VIX_KEY, ...breadthKeys]);
    if (!columns) continue;
    const frames = buildDays(columns, closes, { from: spec.from, to: spec.to, breadthKeys }).filter(isFrame);
    for (const frame of frames) {
      const firings = byDay.get(frame.date);
      if (!firings) continue;
      // The strategy's results so far today, as the trader reports them: after an option trade's cost.
      const today = { trades: 0, wins: 0, lastResults: [] as number[] };
      for (const firing of firings) {
        const state = contextFor(frame, firing, { strategy, premium: option.premium, costPct, today });
        if (state) {
          const key = contextKey(model, state);
          let row = cached.get(key);
          if (!row) {
            const allowance = await options.allowance();
            if (allowance.count <= 0) {
              stopped = allowance.reason;
              break;
            }
            row = await ask(provider, model, state, key, firing, options.timeoutMs ?? 20_000);
            await record(row);
            await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? 3_500));
          }
          answers.push(row);
        }
        const net = firing.points - optionCostPoints(option);
        today.trades += 1;
        if (net > 0) today.wins += 1;
        today.lastResults.push(net);
        done += 1;
        options.onProgress?.(done, events.length, `Asking about ${frame.date} · ${answers.length} answers`);
      }
      if (stopped) break;
    }
  }
  return { answers, stopped };
}

function contextFor(
  frame: DayFrame,
  firing: DetailEvent,
  { strategy, premium, costPct, today }: { strategy: TradingConfig["strategy"]; premium: number; costPct: number; today: { trades: number; wins: number; lastResults: number[] } },
) {
  const t = Math.round((firing.at - frame.open) / MINUTE_MS);
  const cut = sessionUntil(frame.session, t);
  const pulse = computePulse(cut, NIFTY_CONSTITUENTS);
  const inputs = sessionInputs(cut, NIFTY_CONSTITUENTS);
  if (!pulse || !inputs) return null;
  const reading = readSignal(pulse, inputs, firing.at, strategy.signal, strategy.params);
  if (!reading || reading.vote !== firing.vote) return null;
  const direction = firing.vote > 0 ? 1 : -1;
  const type = direction > 0 ? "CE" : "PE";
  const state = buildDecisionState({
    pulse,
    reading,
    direction,
    contract: { securityId: "", feedKey: "", name: "", strike: 0, type, expiry: "", lotSize: 0, tickSize: 0.05 },
    premium,
    costPct,
    daysToExpiry: daysToWeeklyExpiry(frame.date),
    strategy,
    // Read when the minute closed, as the trader reads it.
    at: firing.at + MINUTE_MS,
    session: frame.session.session!,
    today: { trades: today.trades, wins: today.wins, lastResults: today.lastResults.slice(-3) },
  });
  return anonymize(state, type);
}

async function ask(provider: DecisionProvider, model: string, state: unknown, key: string, firing: DetailEvent, timeoutMs: number): Promise<GateAnswerRow> {
  const base = { key, at: firing.at, day: firing.day, vote: firing.vote, points: firing.points, model };
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const answer: DecisionAnswer = await provider.ask({ model, state, timeoutMs });
      return { ...base, probability: answer.probability, regime: answer.regime, quality: answer.quality, model: answer.model || model, error: null };
    } catch (error) {
      lastError = error instanceof Error ? error.message.split("\n")[0] : String(error);
      // A refusal won't change on a retry; a rate limit or a timeout might.
      if (/declined/.test(lastError)) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000 * (attempt + 1)));
    }
  }
  return { ...base, probability: null, regime: null, quality: null, error: lastError };
}

const group = (rows: readonly GateAnswerRow[], optionCost: number): GateGroup => {
  const m = measure(
    rows.map((r) => ({ day: r.day, points: r.points })),
    optionCost,
    0,
  );
  const r3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
  return { firings: m.firings, hit_rate: r3(m.hitRate), mean: r3(m.mean), lo: r3(m.range?.[0] ?? null), hi: r3(m.range?.[1] ?? null), net_option: r3(m.netOption) };
};

const BANDS: [string, number, number][] = [
  ["Under 0.40", 0, 0.4],
  ["0.40–0.55", 0.4, 0.55],
  ["0.55–0.70", 0.55, 0.7],
  ["0.70 and over", 0.7, 1.01],
];

/** Approved against turned down, by the trader's rule, over every answer held. */
export function summarizeGate(
  manifest: StudyManifest,
  firings: number,
  answers: readonly GateAnswerRow[],
  { provider, model, rule, version, at, stopped }: { provider: GateSummary["provider"]; model: string; rule: GateSummary["rule"]; version: string; at: number; stopped: string | null },
): GateSummary {
  const answered = answers.filter((a) => a.probability !== null);
  const decide = (a: GateAnswerRow) =>
    judge(
      { probability: a.probability!, regime: a.regime, regimeProbabilities: null, quality: a.quality, model: a.model, inputTokens: null, cost: null },
      a.vote > 0 ? 1 : -1,
      { ...DEFAULT_TRADING_CONFIG.decision, minProbability: rule.minProbability, vetoAgainstRegime: rule.vetoAgainstRegime },
    ).approved;
  const cost = manifest.costs.optionPoints;
  return {
    studyId: manifest.id,
    at,
    version,
    provider,
    model,
    questionsHash: QUESTIONS_HASH,
    rule,
    firings,
    answered: answered.length,
    failed: answers.length - answered.length,
    approved: group(answered.filter(decide), cost),
    turnedDown: group(answered.filter((a) => !decide(a)), cost),
    byProbability: BANDS.map(([band, lo, hi]) => ({ band, ...group(answered.filter((a) => a.probability! >= lo && a.probability! < hi), cost) })),
    stopped,
  };
}
