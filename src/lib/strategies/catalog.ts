// Strategies the store starts with: well-known intraday strategies from public sources, each with
// the settings most often published for it. The engine adds any that are missing when it starts
// (one retired stays retired) and tests each once. Their AI check records the AI's opinion without
// blocking trades. Researched 17 November 2026; see docs/strategies.md for the sources.

import { DEFAULT_TRADING_CONFIG } from "../engine/trading.ts";
import type { SignalId } from "./signals.ts";
import type { StrategyDefinition } from "./types.ts";

export interface CatalogEntry {
  /** Fixed, so the engine can tell whether it was added before. */
  id: string;
  definition: StrategyDefinition;
}

function entry(
  id: string,
  name: string,
  idea: string,
  signal: SignalId,
  trade: Partial<Omit<StrategyDefinition["trade"], "signal" | "params">>,
): CatalogEntry {
  return {
    id,
    definition: {
      name,
      idea,
      kind: "signal-options",
      trade: { ...structuredClone(DEFAULT_TRADING_CONFIG.strategy), signal, side: "both", strikeOffset: 0, lots: 1, minDaysToExpiry: 0, ...trade },
      decision: { ...structuredClone(DEFAULT_TRADING_CONFIG.decision), mode: "shadow" },
    },
  };
}

export const CATALOG: readonly CatalogEntry[] = [
  entry(
    "intraday-momentum",
    "Intraday momentum",
    "If NIFTY rose in the first half hour (counting from yesterday's close), it tends to keep rising at the end of the day, and the reverse. One trade a day. The best-evidenced idea here: found in the S&P 500 over 20 years (Gao, Han, Li and Zhou, Journal of Financial Economics, 2018) and in 12 of 16 developed markets since; nobody has published a test on NIFTY. NSE now closes with an auction at 15:15, so this version decides at 14:44 and holds until the engine's 15:10 square-off.",
    "day-momentum",
    { holdMinutes: 25, stopLossPct: 0, targetPct: 0, exitOnOpposite: false },
  ),
  entry(
    "opening-range-breakout",
    "Opening range breakout",
    "Mark NIFTY's high and low in the first 15 minutes; when it breaks out of that range, follow the move. One trade a day. The most popular intraday setup among Indian traders (TradingView NIFTY scripts, QuantInsti's EPAT projects), but no trustworthy published test on NIFTY.",
    "opening-range",
    { holdMinutes: 60, stopLossPct: 25, targetPct: 50, exitOnOpposite: false },
  ),
  entry(
    "ema-crossover",
    "Moving-average crossover (9/21)",
    "Trend following: bet up when the 9-bar average of 5-minute prices crosses above the 21-bar one, and down when it crosses below; sell when it crosses back. A standard retail setup (AlgoTest, m.Stock); no published evidence that it pays on NIFTY after costs.",
    "ema-cross",
    { holdMinutes: 60, stopLossPct: 25, targetPct: 0, exitOnOpposite: true },
  ),
  entry(
    "supertrend",
    "Supertrend (10, 3)",
    "Trend following with Supertrend, 10 bars and 3 times the typical move, on 5-minute bars: bet the way it turns, sell when it turns back. Very popular with Indian intraday traders; the few published tests of it on 5-minute bars (not NIFTY) found it unprofitable for day trading.",
    "supertrend",
    { holdMinutes: 60, stopLossPct: 25, targetPct: 0, exitOnOpposite: true },
  ),
  entry(
    "rsi-reversal",
    "RSI reversal (14, 30/70)",
    "Counter-trend: after a sharp fall pushes RSI (14, on 5-minute bars) below 30, bet on a bounce once it climbs back above 30; after a sharp rise above 70, bet on a drop once it falls back below. The classic 'oversold bounce'; widely taught, little evidence on NIFTY.",
    "rsi-reversal",
    { holdMinutes: 15, stopLossPct: 20, targetPct: 30, exitOnOpposite: false },
  ),
  entry(
    "gap-fade",
    "Gap fade",
    "When NIFTY opens 0.3% to 1% away from yesterday's close, bet that the gap closes, at 09:25. One trade at most a day. Blogs claim small NIFTY gaps fill the same day about 55–62% of the time, but none shows its data; big gaps often keep running, so these are left alone.",
    "gap-fade",
    { holdMinutes: 60, stopLossPct: 30, targetPct: 0, exitOnOpposite: false },
  ),
];
