// The strategy: follow one of the Pulse signal lab's signals with NIFTY options. A long firing
// buys a call, a short firing buys a put. The signal is read at the close of each minute from the
// same computation the Pulse page shows (src/lib/insight/pulse.ts), so what the page marks as a
// firing is what the engine trades.
//
// Pure: a pulse in, a reading out. Exits (stop, target, hold time, opposite signal, square-off)
// and everything about orders live in trader.ts.

import type { Pulse, PulseConstituent } from "../../lib/insight/pulse.ts";
import { SIGNALS, type SignalId, type SignalReading } from "../../lib/engine/trading.ts";
import { INDEX_CONSTITUENTS } from "../../lib/index-constituents.ts";

/** NIFTY's stocks as Pulse takes them, with Dhan's market-cap shares as the prior weights. */
export const NIFTY_CONSTITUENTS: readonly PulseConstituent[] = INDEX_CONSTITUENTS.NIFTY.map((c) => ({
  key: `NSE_EQ:${c.securityId}`,
  symbol: c.symbol,
  sector: c.sector,
  prior: c.mcapShare,
}));

/** Pulse lists its single signals in this order; "agree" is their combination. */
const SINGLE: readonly SignalId[] = ["breadth", "lead", "momentum"];

/**
 * What the signals said at the close of the minute starting at `minute`, and the vote of the one
 * the strategy follows. Null when the pulse has no such minute.
 */
export function readSignal(pulse: Pulse, minute: number, follow: SignalId): SignalReading | null {
  const point = pulse.series.find((p) => p.at === minute);
  if (!point) return null;
  const readings: SignalReading["readings"] = SINGLE.map((id, index) => ({
    id,
    name: SIGNALS.find((s) => s.id === id)!.name,
    reading: point.readings[index] ?? "—",
    vote: point.votes[index] ?? 0,
  }));
  const agree: -1 | 0 | 1 = point.composite >= 2 ? 1 : point.composite <= -2 ? -1 : 0;
  const longs = readings.filter((r) => r.vote > 0).length;
  const shorts = readings.filter((r) => r.vote < 0).length;
  readings.push({
    id: "agree",
    name: SIGNALS.find((s) => s.id === "agree")!.name,
    reading: agree === 0 ? `${longs} long, ${shorts} short` : `${agree > 0 ? longs : shorts} of ${SINGLE.length} ${agree > 0 ? "long" : "short"}`,
    vote: agree,
  });
  return {
    minute,
    nifty: point.nifty,
    readings,
    vote: readings.find((r) => r.id === follow)?.vote ?? 0,
    stance: pulse.verdict.stance,
    score: pulse.score,
  };
}
