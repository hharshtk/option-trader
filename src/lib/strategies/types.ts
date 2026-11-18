// The strategy store's types, shared by the engine and the web. A strategy is a named, versioned
// set of settings for a kind of strategy whose logic is code: which signal starts a trade and with
// what numbers, how it trades, and its AI check. The engine paper-trades one version at a time and
// research tests any version. See docs/strategies.md.

import { DEFAULT_TRADING_CONFIG, mergeTradingConfig, SIGNALS, type TradingConfig } from "../engine/trading.ts";
import type { Verdict } from "../research/types.ts";

/** The kinds of strategy there is code for. More come with new logic (opening range, intraday momentum, …). */
export type StrategyKind = "signal-options";

export const STRATEGY_KINDS: readonly { id: StrategyKind; name: string; summary: string }[] = [
  {
    id: "signal-options",
    name: "Follow a signal with options",
    summary: "When the signal says up it buys a call, when it says down a put. It sells after a set time, at a stop-loss or target, or when the signal turns the other way.",
  },
];

/** Everything a strategy decides, as one version. */
export interface StrategyDefinition {
  name: string;
  /** The idea in a sentence or two, in plain words: why it should work. */
  idea: string;
  kind: StrategyKind;
  /** The signal it follows with its numbers, and how it trades: the engine's trade settings. */
  trade: TradingConfig["strategy"];
  /** Its AI check (the Decision API): off, recorded only, or allowed to turn trades down. */
  decision: TradingConfig["decision"];
}

export interface StrategyVersion extends StrategyDefinition {
  id: string;
  version: number;
  savedAt: number;
  /** What changed, in the person's words. */
  note: string;
}

export type StrategyStatus = "idea" | "tested" | "paper" | "retired";

export type StrategyEventKind = "created" | "saved" | "tested" | "paper-on" | "paper-off" | "retired" | "restored";

/** Something that happened to a strategy. Its history is these, oldest first. */
export interface StrategyEvent {
  strategy: string;
  at: number;
  kind: StrategyEventKind;
  version: number;
  note: string;
  /** For a test: the study, its verdict, index points a trade after costs, trades, days. */
  study: string | null;
  verdict: Verdict | null;
  net: number | null;
  trades: number | null;
  days: number | null;
}

/** A strategy as the store's list shows it. */
export interface StrategySummary {
  id: string;
  latest: StrategyVersion;
  status: StrategyStatus;
  /** The version paper trading follows, when it does. */
  paperVersion: number | null;
  /** The newest test of any version. */
  lastTest: StrategyEvent | null;
  versions: number;
  createdAt: number;
  updatedAt: number;
}

export interface StrategyDetail {
  summary: StrategySummary;
  /** Newest first. */
  versions: StrategyVersion[];
  /** Newest first. */
  events: StrategyEvent[];
}

export interface StrategiesStatus {
  namespace: string;
  strategies: StrategySummary[];
  /** What paper trading follows now. */
  paper: { id: string; version: number } | null;
  error: string | null;
}

export type StrategyCommand =
  | { action: "create"; definition?: Partial<StrategyDefinition>; from?: { id: string; version?: number } }
  | { action: "save"; id: string; definition: Partial<StrategyDefinition>; note?: string }
  | { action: "paper"; id: string; version?: number }
  | { action: "stop-paper"; id: string }
  | { action: "test"; id: string; version?: number; from?: string; to?: string }
  | { action: "retire"; id: string }
  | { action: "restore"; id: string };

export interface StrategyCommandResult {
  ok: boolean;
  message: string;
  id?: string;
  version?: number;
  /** For a test: the research job that runs it. */
  job?: string;
}

/** A new strategy's starting point: the engine's defaults, following "Two or more agree". */
export function newDefinition(): StrategyDefinition {
  return {
    name: "New strategy",
    idea: "",
    kind: "signal-options",
    trade: structuredClone(DEFAULT_TRADING_CONFIG.strategy),
    decision: structuredClone(DEFAULT_TRADING_CONFIG.decision),
  };
}

/**
 * Checks a definition, filling what's missing from `base`. The trade and AI-check settings are
 * checked by the same rules as the engine's settings (mergeTradingConfig), so a strategy that
 * passes here is one the engine can trade.
 */
export function checkDefinition(input: unknown, base: StrategyDefinition): { ok: true; definition: StrategyDefinition } | { ok: false; message: string } {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) return { ok: false, message: "A strategy needs settings." };
  const given = (input ?? {}) as Partial<StrategyDefinition>;
  const name = given.name === undefined ? base.name : given.name;
  const idea = given.idea === undefined ? base.idea : given.idea;
  if (typeof name !== "string" || name.trim().length < 2 || name.length > 80) return { ok: false, message: "A strategy needs a name of 2 to 80 characters." };
  if (typeof idea !== "string" || idea.length > 1_000) return { ok: false, message: "The idea can be up to 1,000 characters." };
  const kind = given.kind ?? base.kind;
  if (!STRATEGY_KINDS.some((k) => k.id === kind)) return { ok: false, message: "Unknown kind of strategy." };
  const merged = mergeTradingConfig({ ...DEFAULT_TRADING_CONFIG, strategy: base.trade, decision: base.decision }, { strategy: given.trade ?? {}, decision: given.decision ?? {} });
  if (!merged.ok) return { ok: false, message: merged.message };
  return { ok: true, definition: { name: name.trim(), idea: idea.trim(), kind, trade: merged.config.strategy, decision: merged.config.decision } };
}

export const signalLabel = (id: string) => SIGNALS.find((s) => s.id === id)?.name ?? id;

/** A store id from a name: lowercase words and a short random tail, `two-or-more-agree-k3x9`. */
export function strategyId(name: string, random: () => number = Math.random): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "strategy";
  const tail = Array.from({ length: 4 }, () => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(random() * 32)]).join("");
  return `${slug}-${tail}`;
}

/** Where a strategy stands, from its history: retired, paper trading, tested, or still an idea. */
export function statusOf(events: readonly StrategyEvent[]): { status: StrategyStatus; paperVersion: number | null } {
  let retired = false;
  let paperVersion: number | null = null;
  let tested = false;
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (e.kind === "retired") retired = true;
    if (e.kind === "restored") retired = false;
    if (e.kind === "paper-on") paperVersion = e.version;
    if (e.kind === "paper-off" || e.kind === "retired") paperVersion = null;
    if (e.kind === "tested") tested = true;
  }
  return { status: retired ? "retired" : paperVersion !== null ? "paper" : tested ? "tested" : "idea", paperVersion };
}
