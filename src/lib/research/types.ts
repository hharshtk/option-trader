// What the Research Center's engine side and web side share: a study's settings and how they are
// checked, the stored records, and the runner's status and commands. See docs/research-center.md.

import { DEFAULT_TRADING_CONFIG, mergeTradingConfig, SIGNALS, type DecisionProviderId, type SignalId, type SignalParams } from "../engine/trading.ts";
import type { HistoryCoverage } from "./candle-history.ts";

export { SIGNALS, type SignalId };

/** Holding times every study measures, in minutes, besides the strategy's own. */
export const HORIZONS = [1, 3, 5, 10, 15] as const;
/** A study without a strategy (the first studies) measures every signal. */
export const STUDY_SIGNALS: readonly SignalId[] = ["breadth", "lead", "momentum", "agree"];

export interface StudySpec {
  /** The question asked before seeing results: this signal at this holding time. */
  primary: { signal: SignalId; horizon: number };
  /** Every signal and horizon measured; all but the primary pair are exploratory. */
  signals: SignalId[];
  horizons: number[];
  /** The strategy store's version being tested, when the study tests one. */
  strategy?: { id: string; version: number; name: string };
  /** The signals' numbers: the strategy's, or the defaults. Missing in studies made before strategies. */
  signalParams?: SignalParams;
  /** First and last day, "YYYY-MM-DD" IST, inclusive. */
  from: string;
  to: string;
  /** Firings count only in this window, "HH:MM" IST: the trader's entry window by default. */
  window: { from: string; until: string };
  /** The stocks breadth counts. */
  breadth: "nifty50";
  costs: {
    /** One option lot, round trip: Dhan's charges at this premium plus slippage each way, in NIFTY points at this delta. */
    option: { lot: number; premium: number; slippage: number; delta: number };
    /** One futures lot, round trip: Dhan's charges at the period's median NIFTY plus this spread, in points. */
    futures: { lot: number; spread: number };
  };
}

export const DEFAULT_WINDOW = { from: "09:25", until: "14:45" };
export const DEFAULT_COSTS: StudySpec["costs"] = {
  option: { lot: 65, premium: 100, slippage: 0.5, delta: 0.5 },
  futures: { lot: 65, spread: 1 },
};

export function defaultSpec(signal: SignalId, horizon: number, from: string, to: string): StudySpec {
  return {
    primary: { signal, horizon },
    signals: [...STUDY_SIGNALS],
    horizons: [...HORIZONS],
    from,
    to,
    window: { ...DEFAULT_WINDOW },
    breadth: "nifty50",
    costs: structuredClone(DEFAULT_COSTS),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Checks a requested spec, filling what's missing from the defaults. */
export function checkSpec(input: unknown, fallback: StudySpec): { ok: true; spec: StudySpec } | { ok: false; message: string } {
  if (input !== undefined && (typeof input !== "object" || input === null)) return { ok: false, message: "A study needs settings." };
  const given = (input ?? {}) as Partial<StudySpec>;
  const spec: StudySpec = {
    ...fallback,
    ...given,
    primary: { ...fallback.primary, ...given.primary },
    window: { ...fallback.window, ...given.window },
    costs: {
      option: { ...fallback.costs.option, ...given.costs?.option },
      futures: { ...fallback.costs.futures, ...given.costs?.futures },
    },
    // A strategy's test measures its own signal; the holding times always include its own.
    signals: given.strategy ? [given.primary?.signal ?? fallback.primary.signal] : [...STUDY_SIGNALS],
    horizons: [...new Set([...HORIZONS, given.primary?.horizon ?? fallback.primary.horizon])].sort((a, b) => a - b),
    breadth: "nifty50",
  };
  if (!SIGNALS.some((s) => s.id === spec.primary.signal)) return { ok: false, message: "Unknown signal." };
  // A study of a bare signal measures the Pulse four, and its own signal if it's another.
  if (!given.strategy && !spec.signals.includes(spec.primary.signal)) spec.signals.push(spec.primary.signal);
  if (!Number.isInteger(spec.primary.horizon) || spec.primary.horizon < 1 || spec.primary.horizon > 240) return { ok: false, message: "Holding time must be 1 to 240 minutes." };
  // The signal numbers are checked by the engine's own rules, so a study can't test what can't trade.
  const params = mergeTradingConfig(DEFAULT_TRADING_CONFIG, { strategy: { params: given.signalParams ?? {} } });
  if (!params.ok) return { ok: false, message: params.message };
  spec.signalParams = params.config.strategy.params;
  if (given.strategy !== undefined) {
    const s = given.strategy as { id?: unknown; version?: unknown; name?: unknown };
    if (typeof s?.id !== "string" || !/^[a-z0-9-]{3,80}$/.test(s.id) || typeof s.version !== "number" || typeof s.name !== "string") return { ok: false, message: "The strategy to test isn't valid." };
    spec.strategy = { id: s.id, version: s.version, name: s.name.slice(0, 120) };
  }
  if (!DATE.test(spec.from) || !DATE.test(spec.to) || spec.from > spec.to) return { ok: false, message: "The period needs a first and last day, first before last." };
  if (!CLOCK.test(spec.window.from) || !CLOCK.test(spec.window.until) || spec.window.from >= spec.window.until) return { ok: false, message: "The entry window needs a start before its end." };
  if (spec.window.from < "09:15" || spec.window.until > "15:29") return { ok: false, message: "The entry window must be inside 09:15–15:29." };
  const { option, futures } = spec.costs;
  const positive = [option.lot, option.premium, option.delta, futures.lot].every((v) => typeof v === "number" && v > 0);
  const nonNegative = [option.slippage, futures.spread].every((v) => typeof v === "number" && v >= 0);
  if (!positive || !nonNegative || option.delta > 1) return { ok: false, message: "Costs need positive numbers, and a delta up to 1." };
  return { ok: true, spec };
}

/** The question a spec asks, in words. */
export function studyQuestion(spec: Pick<StudySpec, "primary" | "strategy">): string {
  if (spec.strategy) return `Would ${spec.strategy.name} (version ${spec.strategy.version}) have made money?`;
  return `Does ${signalName(spec.primary.signal)} predict NIFTY over ${spec.primary.horizon} minute${spec.primary.horizon === 1 ? "" : "s"}?`;
}

export const signalName = (id: SignalId) => SIGNALS.find((s) => s.id === id)?.name ?? id;

export type Verdict =
  | "Too few firings"
  | "Edge after costs"
  | "Predicts, costs eat it"
  | "Ahead, could be luck"
  | "No edge after costs"
  | "Reliably wrong";

/** Each verdict in plain words, for anyone without a finance background: what it means, and what to do. */
export const PLAIN_VERDICT: Record<Verdict, { label: string; advice: string }> = {
  "Edge after costs": { label: "Makes money", advice: "Worth paper trading on the live market next." },
  "Ahead, could be luck": { label: "Made a little, could be luck", advice: "Not enough to trust yet: test it on more days before trading it." },
  "Predicts, costs eat it": { label: "Right direction, but costs eat the profit", advice: "Don't trade it as it is: the moves it catches are smaller than what a trade costs." },
  "No edge after costs": { label: "Loses money", advice: "Don't trade this." },
  "Reliably wrong": { label: "Loses money", advice: "Don't trade this: the market tends to move against it." },
  "Too few firings": { label: "Not enough trades to tell", advice: "Try a longer period." },
};

/** Which slice of the firings a summary row covers. */
export type SliceKind = "all" | "month" | "era" | "time" | "vix" | "side" | "split";

/** One signal at one horizon over one slice: a row of `summary/<id>.parquet`. */
export interface SummaryRow {
  study: string;
  signal: SignalId;
  horizon: number;
  slice_kind: SliceKind;
  slice: string;
  firings: number;
  days: number;
  hits: number;
  hit_rate: number | null;
  hit_lo: number | null;
  hit_hi: number | null;
  /** Mean NIFTY points a firing, signed by the vote, before costs. */
  mean: number | null;
  /** 95% range of `mean`, resampling whole days. */
  lo: number | null;
  hi: number | null;
  net_option: number | null;
  net_futures: number | null;
  /** NIFTY's average move over the horizon from every minute in the window: the drift to beat. */
  baseline: number | null;
  verdict: Verdict;
}

/** One firing: a row of `events/<id>.parquet`. */
export interface EventRow {
  study: string;
  signal: SignalId;
  horizon: number;
  day: string;
  /** Start of the firing minute, epoch ms. The firing is read at that minute's close. */
  at: number;
  vote: number;
  entry: number;
  exit: number;
  points: number;
  vix: number | null;
}

/** One day, one signal, one horizon: a row of `daily/<id>.parquet`. */
export interface DailyRow {
  study: string;
  signal: SignalId;
  horizon: number;
  day: string;
  firings: number;
  points: number;
}

/** A study in the catalog: a row of `studies/<id>.parquet`. */
export interface StudyRow {
  id: string;
  question: string;
  signal: SignalId;
  horizon: number;
  from: string;
  to: string;
  days: number;
  firings: number;
  hit_rate: number | null;
  mean: number | null;
  lo: number | null;
  hi: number | null;
  net_option: number | null;
  cost_option: number;
  cost_futures: number;
  verdict: Verdict;
  started_at: number;
  ms: number;
  results_hash: string;
  version: string;
  /** The strategy store's version tested; null for studies of a bare signal. */
  strategy_id: string | null;
  strategy_version: number | null;
  strategy_name: string | null;
}

/** Everything needed to know what a study was and to run it again: `manifests/<id>.json`. */
export interface StudyManifest {
  schema: 1;
  id: string;
  question: string;
  spec: StudySpec;
  data: {
    sources: { key: string; etag: string; bytes: number }[];
    days: number;
    first: string | null;
    last: string | null;
    dropped: { date: string; reason: string }[];
    breadthStocks: string[];
    constituentsAsOf: string;
  };
  code: {
    /** `git describe --always --dirty` of the engine that ran it. */
    version: string;
    /** sha256 of the signal code (pulse.ts). */
    signals: string;
    /** sha256 of the study code. */
    study: string;
  };
  costs: { optionPoints: number; futuresPoints: number; medianNifty: number };
  run: { startedAt: number; ms: number; namespace: string; node: string };
  results: { hash: string; verdict: Verdict; firings: number };
}

/** A rerun of a study, checked against the stored results: `checks/<id>/<time>.json`. */
export interface StudyCheck {
  id: string;
  at: number;
  version: string;
  /** The rerun's results hash equals the stored one. */
  matched: boolean;
  hash: string;
  /** The data files and code were the same as the study's: a mismatch then means non-determinism. */
  sameInputs: boolean;
}

export type DetailSummary = Omit<SummaryRow, "study">;
export type DetailDay = Pick<DailyRow, "day" | "firings" | "points">;
export type DetailEvent = Omit<EventRow, "study" | "signal" | "horizon">;

/** One group of firings in a gate pass: the ones the Decision API approved, or turned down. */
export interface GateGroup {
  firings: number;
  hit_rate: number | null;
  mean: number | null;
  lo: number | null;
  hi: number | null;
  net_option: number | null;
}

/**
 * What the Decision API said about a study's primary firings, asked as the trader asks it but with
 * a context that can't reveal the day: `gates/<id>/<time>.json`, one per pass.
 */
export interface GateSummary {
  studyId: string;
  at: number;
  version: string;
  provider: DecisionProviderId;
  model: string;
  questionsHash: string;
  /** The trader's gate rule when the pass ran. */
  rule: { minProbability: number; vetoAgainstRegime: boolean };
  /** The primary pair's firings, and how many have an answer so far. */
  firings: number;
  answered: number;
  /** Answers the model refused or failed to give. */
  failed: number;
  approved: GateGroup;
  turnedDown: GateGroup;
  /** Firings by the model's probability, in bands. */
  byProbability: ({ band: string } & GateGroup)[];
  /** Why the pass stopped before the end, when it did. */
  stopped: string | null;
}

/** One answer of a gate pass: a row of `decisions/<id>/<time>.parquet`. */
export interface GateAnswerRow {
  /** sha256 of the model, the questions and the context sent: the cache key. */
  key: string;
  at: number;
  day: string;
  vote: number;
  points: number;
  probability: number | null;
  regime: string | null;
  quality: number | null;
  model: string;
  error: string | null;
}

/** One study as the page reads it. */
export interface StudyDetail {
  manifest: StudyManifest;
  /** Every signal, horizon and slice. */
  summary: DetailSummary[];
  /** The primary pair's days that had firings. */
  daily: DetailDay[];
  /** The primary pair's firings. */
  events: DetailEvent[];
  checks: StudyCheck[];
  /** The latest Decision API pass over the primary firings, if any. */
  gate: GateSummary | null;
}

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ResearchJob {
  id: string;
  kind: "study" | "rerun" | "gate" | "history";
  title: string;
  state: JobState;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  progress: { done: number; total: number; label: string } | null;
  /** What happened, in words: the verdict, why it failed, what was downloaded. */
  message: string | null;
  /** The study this job made, found or checked. */
  studyId: string | null;
  /** For a rerun: whether it reproduced the stored results. */
  matched: boolean | null;
}

export interface ResearchStatus {
  namespace: string;
  /** Where studies are stored, "s3://bucket/prefix/" or a folder: for the page's query examples. */
  location: string;
  jobs: ResearchJob[];
  coverage: HistoryCoverage | null;
  coverageError: string | null;
  /** What the engine trades now: the one-click study. */
  defaults: { signal: SignalId; horizon: number };
  /** The Decision API the trader uses, the providers with a key, and how many free answers OpenRouter has left today. */
  decisions: {
    provider: DecisionProviderId;
    model: string;
    /** Each provider: whether its key is set, and the model research asks it with. */
    providers: Record<DecisionProviderId, { ready: boolean; model: string }>;
    /** Free-model answers left in today's quota (UTC day), when known. */
    freeRemaining: number | null;
    freeLimit: number | null;
    /** Kept back for live trading: research stops at this many left. */
    reserve: number;
    error: string | null;
  };
}

export type ResearchCommand =
  | { action: "study"; spec?: Partial<StudySpec> }
  | { action: "rerun"; id: string }
  | { action: "gate"; id: string; provider?: DecisionProviderId }
  | { action: "history" }
  | { action: "cancel"; job: string };

export interface ResearchCommandResult {
  ok: boolean;
  message: string;
  job?: string;
}

/** What the worker process sends the runner. */
export type WorkerMessage =
  | { type: "progress"; done: number; total: number; label: string }
  | { type: "done"; message: string; studyId: string | null; matched: boolean | null }
  | { type: "failed"; message: string };

/** What the runner sends the worker. */
export type WorkerJob =
  | { kind: "study"; spec: StudySpec; namespace: string; version: string }
  | { kind: "rerun"; id: string; namespace: string; version: string }
  | { kind: "gate"; id: string; namespace: string; version: string; provider: DecisionProviderId; model: string; rule: GateSummary["rule"]; reserve: number }
  | { kind: "history"; today: string };
