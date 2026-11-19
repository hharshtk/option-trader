// How far NIFTY typically moves over a hold, measured from what it actually did on recent days.
//
// The first estimate (today's average 1-minute move times the square root of the hold) overshot
// badly early in the day: at 09:31 on 18 November 2026 it said 111 points over 55 minutes, and
// NIFTY moved 40. Two reasons: the opening's swings don't last, and minute-to-minute moves partly
// cancel out, so scaling one minute up to an hour overstates it. Measuring the hold itself, at the
// same time of day, on recent days, handles both.
//
//   typical move   the average size of NIFTY's move over the hold, starting within SMOOTH minutes
//                  of the same time of day, over the last DAYS trading days
//   today          how busy today is against those days at the same time (each day's average
//                  1-minute move over the last 30 minutes), counted half (its square root) and
//                  kept within BUSY_LIMITS: a wild or quiet morning only partly carries on
//
// Pure: closes in, points out. The engine loads the closes (move-history.ts).

/** Trading days a profile looks back over, and the fewest it needs. */
export const DAYS = 20;
export const MIN_DAYS = 5;
/** Start minutes within this many of the asked one count, so one odd minute doesn't decide. */
const SMOOTH = 5;
/** Minutes since 09:15 from which the closing auction freezes the index: no move is measured across it. */
const AUCTION_MINUTE = 360;
/** How far today's busyness can scale the history. */
const BUSY_LIMITS = [0.67, 1.5] as const;
/** A day needs this many minutes to count. */
const FULL_DAY = 300;

export interface MoveProfile {
  /** The days used, oldest first. */
  dates: string[];
  /** NIFTY's close at each minute since 09:15, per day (null where missing). */
  closes: (number | null)[][];
}

/** Keeps the last DAYS full days from closes by date (minute index → close). Null when fewer than MIN_DAYS. */
export function buildProfile(byDate: ReadonlyMap<string, readonly (number | null | undefined)[]>): MoveProfile | null {
  const days = [...byDate]
    .filter(([, closes]) => closes.filter((c) => c != null).length >= FULL_DAY)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-DAYS);
  if (days.length < MIN_DAYS) return null;
  return { dates: days.map(([date]) => date), closes: days.map(([, closes]) => Array.from({ length: AUCTION_MINUTE }, (_, t) => closes[t] ?? null)) };
}

/** The average size of NIFTY's move over `hold` minutes starting near minute `t`, in points; null when nothing measures it. */
export function typicalMove(profile: MoveProfile, t: number, hold: number): number | null {
  const last = AUCTION_MINUTE - 1 - hold;
  if (last < 0) return null;
  let sum = 0;
  let n = 0;
  for (const closes of profile.closes) {
    for (let s = Math.max(0, t - SMOOTH); s <= Math.min(last, t + SMOOTH); s += 1) {
      const a = closes[s];
      const b = closes[s + hold];
      if (a == null || b == null) continue;
      sum += Math.abs(b - a);
      n += 1;
    }
  }
  return n ? sum / n : null;
}

/** The days' average 1-minute move over the 30 minutes ending at minute `t` (Pulse's measure), in points. */
export function usualMinuteMove(profile: MoveProfile, t: number): number | null {
  let sum = 0;
  let n = 0;
  for (const closes of profile.closes) {
    for (let s = Math.max(1, t - 29); s <= Math.min(t, AUCTION_MINUTE - 1); s += 1) {
      const a = closes[s - 1];
      const b = closes[s];
      if (a == null || b == null) continue;
      sum += Math.abs(b - a);
      n += 1;
    }
  }
  return n ? sum / n : null;
}

export interface ExpectedMove {
  /** NIFTY's typical move over the hold expected now, in points. */
  move: number;
  /** The typical move on the recent days, before today's adjustment. */
  history: number;
  /** How busy today is against those days at this time (1: as usual), and the scale it gave. */
  busy: number | null;
  scale: number;
  days: number;
}

/**
 * The move to expect over `hold` minutes from minute `t` (minutes since 09:15), given today's
 * average 1-minute move `minuteMove`. Null without a profile or a measurement at that time.
 */
export function expectedMove(profile: MoveProfile | null, t: number, hold: number, minuteMove: number | null): ExpectedMove | null {
  if (!profile) return null;
  // A hold that runs into the auction is measured up to it.
  const span = Math.max(1, Math.min(hold, AUCTION_MINUTE - 1 - t));
  const history = typicalMove(profile, t, span);
  if (history === null || !(history > 0)) return null;
  const usual = usualMinuteMove(profile, t);
  const busy = minuteMove !== null && usual !== null && usual > 0 ? minuteMove / usual : null;
  const scale = busy === null ? 1 : Math.min(BUSY_LIMITS[1], Math.max(BUSY_LIMITS[0], Math.sqrt(busy)));
  return { move: round(history * scale), history: round(history), busy: busy === null ? null : round(busy), scale: round(scale), days: profile.dates.length };
}

const round = (value: number) => Math.round(value * 100) / 100;
