// The strategy: follow one of the Pulse signal lab's signals with NIFTY options. A long firing
// buys a call, a short firing buys a put. The signal is read at the close of each minute from the
// same computation the Pulse page shows (src/lib/insight/pulse.ts), so what the page marks as a
// firing is what the engine trades.
//
// Pure: a pulse in, a reading out. Exits (stop, target, hold time, opposite signal, square-off)
// and everything about orders live in trader.ts.

import type { Pulse, PulseConstituent } from "../../lib/insight/pulse.ts";
import { HORIZONS, PRICE_SIGNALS } from "../../lib/insight/pulse.ts";
import type { SignalId, SignalReading, SignalReadingLine } from "../../lib/engine/trading.ts";
import { INDEX_CONSTITUENTS } from "../../lib/index-constituents.ts";

const MINUTE_MS = 60_000;
/** Latest firings sent with each signal's reading. */
const RECENT = 3;

/** NIFTY's stocks as Pulse takes them, with Dhan's market-cap shares as the prior weights. */
export const NIFTY_CONSTITUENTS: readonly PulseConstituent[] = INDEX_CONSTITUENTS.NIFTY.map((c) => ({
  key: `NSE_EQ:${c.securityId}`,
  symbol: c.symbol,
  sector: c.sector,
  prior: c.mcapShare,
}));

/** Every signal's reading and vote at series index `t`: the singles, then the combined ones, in `signals` order. */
function readingsAt(pulse: Pulse, t: number): Pick<SignalReadingLine, "id" | "name" | "reading" | "vote">[] {
  const point = pulse.series[t];
  // The series holds the single signals' votes and readings, then the combined ones' votes, each in `signals` order.
  const singles = pulse.signals.filter((s) => s.kind === "single");
  const combined = pulse.signals.filter((s) => s.kind === "combined");
  const lines = singles.map((s, i) => ({ id: s.id as SignalId, name: s.name, reading: point.readings[i] ?? "—", vote: point.votes[i] ?? 0 }));
  const single = [...lines];
  combined.forEach((s, i) => {
    const vote = point.combined[i] ?? 0;
    let reading: string;
    if (s.id === "agree") {
      const price = single.filter((r) => (PRICE_SIGNALS as readonly string[]).includes(r.id));
      const longs = price.filter((r) => r.vote > 0).length;
      const shorts = price.filter((r) => r.vote < 0).length;
      reading = vote === 0 ? `${longs} long, ${shorts} short` : `${vote > 0 ? longs : shorts} of ${price.length} ${vote > 0 ? "long" : "short"}`;
    } else {
      reading = vote === 0 ? "not confirmed" : single.filter((r) => r.vote === vote).map((r) => r.name).join(" + ");
    }
    lines.push({ id: s.id as SignalId, name: s.name, reading, vote });
  });
  return lines;
}

/**
 * What the signals said at the close of the minute starting at `minute`, and the vote of the one
 * the strategy follows. Each signal also says how it has done today at the Signal lab hold nearest
 * `holdMinutes`, and its latest firings. Null when the pulse has no such minute.
 */
export function readSignal(pulse: Pulse, minute: number, follow: SignalId, holdMinutes = 10): SignalReading | null {
  const t = pulse.series.findIndex((p) => p.at === minute);
  if (t < 0) return null;
  const point = pulse.series[t];
  const open = pulse.series[0].at;
  const horizon = [...HORIZONS].reverse().find((h) => h <= holdMinutes) ?? HORIZONS[0];
  const singles = pulse.signals.filter((s) => s.kind === "single");
  const now = readingsAt(pulse, t);
  const readings: SignalReadingLine[] = now.map((line, i) => {
    const signal = pulse.signals.find((s) => s.id === line.id)!;
    const index = singles.indexOf(signal);
    const stats = signal.stats.find((st) => st.horizon === horizon);
    const voteAt = (k: number) => (index >= 0 ? pulse.series[k].votes[index] : pulse.series[k].combined[i - singles.length]) ?? 0;
    const recent: NonNullable<SignalReadingLine["recent"]> = [];
    // Scoring skips a hold after each firing; the first firing after the last scored one is still running.
    const events = (stats?.events ?? []).filter((e) => e.at <= minute);
    const last = events.at(-1);
    for (let k = last ? Math.round((last.at - open) / MINUTE_MS) + horizon : 0; k <= t; k += 1) {
      const vote = voteAt(k);
      if (vote !== 0) {
        recent.push({ at: pulse.series[k].at, vote, reading: readingsAt(pulse, k)[i].reading, outcome: null });
        break;
      }
    }
    for (const e of [...events].reverse()) {
      if (recent.length >= RECENT) break;
      const k = Math.round((e.at - open) / MINUTE_MS);
      recent.push({ at: e.at, vote: e.vote, reading: readingsAt(pulse, k)[i].reading, outcome: Math.round(e.outcome * 10) / 10 });
    }
    recent.sort((a, b) => b.at - a.at);
    return {
      ...line,
      value: index >= 0 ? (point.values?.[index] ?? null) : null,
      threshold: signal.threshold ?? null,
      today: stats ? { horizon, fired: stats.fired, right: stats.hits, points: Math.round(stats.gross * 10) / 10 } : undefined,
      recent,
    };
  });
  return {
    minute,
    nifty: point.nifty,
    readings,
    vote: readings.find((r) => r.id === follow)?.vote ?? 0,
    stance: pulse.verdict.stance,
    score: pulse.score,
    inputs: {
      depth: pulse.derivatives?.future?.book20Imbalance != null,
      chainAgeMinutes: pulse.derivatives?.chain?.ageMinutes ?? null,
    },
  };
}
