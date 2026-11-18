// The strategy's signal at the close of each minute: the signals are defined once in the strategy
// store (src/lib/strategies/signals.ts), read here with the traded strategy's own numbers. With the
// default numbers they are exactly what the Pulse page marks as firings.
//
// Pure: a pulse and the day's inputs in, a reading out. Exits (stop, target, hold time, opposite
// signal, square-off) and everything about orders live in trader.ts.

import type { Pulse, PulseConstituent } from "../../lib/insight/pulse.ts";
import { SIGNALS, type SignalId, type SignalReading } from "../../lib/engine/trading.ts";
import { INDEX_CONSTITUENTS } from "../../lib/index-constituents.ts";
import { DEFAULT_SIGNAL_PARAMS, isPattern, readAt, readSignalAt, SINGLE_SIGNALS, voteIn, type SignalInputs, type SignalParams, type SingleSignalId } from "../../lib/strategies/signals.ts";

/** NIFTY's stocks as Pulse takes them, with Dhan's market-cap shares as the prior weights. */
export const NIFTY_CONSTITUENTS: readonly PulseConstituent[] = INDEX_CONSTITUENTS.NIFTY.map((c) => ({
  key: `NSE_EQ:${c.securityId}`,
  symbol: c.symbol,
  sector: c.sector,
  prior: c.mcapShare,
}));

/**
 * What the signals said at the close of the minute starting at `minute`, with the strategy's
 * numbers, and the vote of the one it follows. Null when the pulse has no such minute.
 */
export function readSignal(pulse: Pulse, inputs: SignalInputs, minute: number, follow: SignalId, params: SignalParams = DEFAULT_SIGNAL_PARAMS): SignalReading | null {
  const t = pulse.series.findIndex((p) => p.at === minute);
  if (t === -1) return null;
  const point = pulse.series[t];
  const reading = readAt(inputs, t, params);
  const readings: SignalReading["readings"] = SINGLE_SIGNALS.map((signal, index) => ({
    id: signal.id,
    name: signal.name,
    reading: reading.values[index] === null ? "—" : signal.format(reading.values[index]!, params),
    vote: reading.votes[index],
  }));
  const agree = reading.agree;
  const longs = readings.filter((r) => r.vote > 0).length;
  const shorts = readings.filter((r) => r.vote < 0).length;
  readings.push({
    id: "agree",
    name: SIGNALS.find((s) => s.id === "agree")!.name,
    reading: agree === 0 ? `${longs} long, ${shorts} short` : `${agree > 0 ? longs : shorts} of ${SINGLE_SIGNALS.length} ${agree > 0 ? "long" : "short"}`,
    vote: agree,
  });
  // A well-known strategy's rule (opening range, Supertrend, …) is read on its own, after the Pulse signals.
  let vote = isPattern(follow) ? 0 : voteIn(reading, follow as SingleSignalId | "agree");
  if (isPattern(follow)) {
    const own = readSignalAt(inputs, t, follow, params);
    readings.push({ id: follow, name: SIGNALS.find((s) => s.id === follow)!.name, reading: own.text, vote: own.vote });
    vote = own.vote;
  }
  return {
    minute,
    nifty: point.nifty,
    readings,
    vote,
    stance: pulse.verdict.stance,
    score: pulse.score,
  };
}
