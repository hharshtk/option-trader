// What a decision sees at the close of a minute: one flat record of everything the engine knows
// then, from NIFTY and its stocks to the near-month future's 20-level book and the option chain.
// Built from the Pulse computed on the day as it stood at that minute, the same computation the
// live trader runs, so a rule scored on a recorded day sees exactly what it would have seen live.
//
// Flat (one level of named numbers) so it is one row of the per-minute table, and plain to read.
// Pure: a pulse in, a record out.

import { SIGNALS, type SignalId } from "../engine/trading.ts";
import { impliedMove } from "../insight/derivatives.ts";
import type { Pulse } from "../insight/pulse.ts";

/** One value per field. Null when the day doesn't have it (no futures recorded, no chain yet, …). */
export type MinuteState = Record<MinuteField, number | null> & {
  /** Start of the minute, epoch ms. The state is as of its close. */
  at: number;
  /** Minutes since 09:15: 0 is the 09:15 minute. */
  t: number;
};

/** The hold over which `priced_move` and `actual_move` are measured, in minutes. */
export const MOVE_MINUTES = 10;

/** The fields besides the signals', with what they mean. */
const FIXED = {
  // NIFTY
  nifty: "NIFTY's close this minute",
  nifty_change_pct: "Change from the previous close, percent",
  nifty_points_15m: "Points over the last 15 minutes",
  nifty_from_open: "Points from the day's open",
  range_position: "Where NIFTY sits in the day's range: 0 at the low, 1 at the high",
  // Volatility
  vix: "India VIX",
  vix_change_pct: "India VIX change from its previous close, percent",
  minute_move: "NIFTY's average 1-minute move either way over the last 30 minutes, points",
  priced_move: `The move either way over ${MOVE_MINUTES} minutes the at-the-money straddle prices, points`,
  actual_move: `The move either way over ${MOVE_MINUTES} minutes NIFTY has actually been making (minute_move scaled), points`,
  // Breadth
  advancers: "NIFTY stocks up on the day",
  decliners: "NIFTY stocks down on the day",
  weight_above_vwap: "Share of NIFTY's weight trading above its VWAP",
  stocks_book: "Pending buy against sell quantity across NIFTY's stocks, −1 to +1",
  // The near-month future
  fut_price: "Near-month future's price",
  fut_basis: "Future minus NIFTY, points",
  fut_basis_change_15m: "Change in that premium over 15 minutes, points",
  fut_vs_vwap: "Future minus its VWAP, points",
  fut_move_15m_pct: "Future's move over 15 minutes, percent",
  fut_oi_change_15m_pct: "Future's open interest change over 15 minutes, percent",
  fut_oi_change_day_pct: "Future's open interest change since the previous close, percent",
  fut_flow_5m: "Buyers' minus sellers' share of what traded over 5 minutes, −1 to +1",
  fut_flow_15m: "The same over 15 minutes",
  fut_net_lots_15m: "Lots bought at the ask minus sold at the bid over 15 minutes",
  fut_book5: "Bids against asks over the best 5 levels, −1 to +1",
  fut_book20: "Bids against asks over the best 20 levels (depth feed), by quantity, −1 to +1",
  fut_book20_orders: "The same by number of orders",
  fut_spread: "Best ask minus best bid, points (20-level book)",
  // Options in the journal's window (15 strikes each side of the money)
  opt_minutes_to_expiry: "Trading minutes to the nearest expiry",
  opt_atm: "At-the-money strike",
  opt_straddle: "At-the-money call plus put, points",
  opt_forward: "NIFTY's forward from the at-the-money call and put",
  opt_iv_change_since_open_pct: "Option volatility now against the open, percent",
  opt_pcr: "Put over call open interest within 10 strikes",
  opt_pcr_15m: "The same 15 minutes ago",
  opt_call_oi_15m_lots: "Call lots added within 10 strikes over 15 minutes",
  opt_put_oi_15m_lots: "Put lots added within 10 strikes over 15 minutes",
  opt_call_wall: "Strike with the most call open interest above NIFTY (journal's window)",
  opt_put_wall: "Strike with the most put open interest below NIFTY (journal's window)",
  opt_max_pain: "Settlement at which option holders collect least",
  // The option chain (every strike within 10% of NIFTY, once a minute)
  chain_iv: "At-the-money volatility from the chain's bid-ask middles, percent a year",
  chain_iv_change_15m: "Its change over 15 minutes, volatility points",
  chain_iv_change_day: "Its change since the day's first snapshot, volatility points",
  chain_skew: "Put 1% below minus call 1% above, volatility points",
  chain_next_iv: "The next expiry's at-the-money volatility, percent",
  chain_pcr: "Put over call open interest across every strike",
  chain_call_oi_day_lots: "Call lots added since the previous close, every strike",
  chain_put_oi_day_lots: "Put lots added since the previous close, every strike",
  chain_call_wall: "Strike with the most call open interest above NIFTY, every strike",
  chain_put_wall: "Strike with the most put open interest below NIFTY, every strike",
  chain_age: "Minutes since the chain snapshot read",
} as const;

/** Each Pulse signal's vote (−1, 0, +1), and for single signals the number it reads. */
type SignalField = `sig_${SignalId}` | `sig_${SignalId}_value`;
export type MinuteField = keyof typeof FIXED | SignalField;

/** Every field, with what it means. The order is the table's column order. */
export const FIELDS = {
  ...FIXED,
  ...Object.fromEntries(SIGNALS.flatMap((s) => [[`sig_${s.id}`, `${s.name}: vote`], ...(s.kind === "single" ? [[`sig_${s.id}_value`, `${s.name}: reading`]] : [])])),
} as Partial<Record<MinuteField, string>> as Record<MinuteField, string>;

export const FIELD_NAMES = Object.keys(FIELDS) as MinuteField[];

/**
 * The state at the close of the minute starting at `minute`, from a pulse computed on the day as
 * it stood then (the pulse's own latest minute). Null when the pulse has no such minute.
 */
export function minuteState(pulse: Pulse, minute: number): MinuteState | null {
  const t = pulse.series.findIndex((p) => p.at === minute);
  if (t < 0) return null;
  const point = pulse.series[t];
  const d = pulse.derivatives;
  const f = d?.future ?? null;
  const o = d?.options ?? null;
  const c = d?.chain ?? null;
  const v = pulse.volatility;
  const r = (value: number | null | undefined, digits = 4) => (value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));

  const out: Record<string, number | null> = {
    nifty: r(point.nifty ?? pulse.nifty.ltp, 2),
    nifty_change_pct: r(pulse.nifty.change * 100),
    nifty_points_15m: r(pulse.nifty.recentPoints, 2),
    nifty_from_open: pulse.nifty.open === null ? null : r(pulse.nifty.ltp - pulse.nifty.open, 2),
    range_position: r(pulse.nifty.rangePosition),
    vix: r(v.vix),
    vix_change_pct: r(v.vixChangePct),
    minute_move: r(v.minuteMove),
    priced_move: o ? r(impliedMove(o.straddle, o.minutesToExpiry, MOVE_MINUTES), 2) : null,
    actual_move: v.minuteMove === null ? null : r(v.minuteMove * Math.sqrt(MOVE_MINUTES), 2),
    advancers: pulse.breadth.advancers,
    decliners: pulse.breadth.decliners,
    weight_above_vwap: r(pulse.breadth.weightAboveVwap),
    stocks_book: r(pulse.breadth.book),
    fut_price: r(f?.price, 2),
    fut_basis: r(f?.basis, 2),
    fut_basis_change_15m: r(f?.basisChange15, 2),
    fut_vs_vwap: r(f?.vsVwap, 2),
    fut_move_15m_pct: r(f?.move15Pct),
    fut_oi_change_15m_pct: r(f?.oiChange15Pct),
    fut_oi_change_day_pct: r(f?.oiChangeDayPct),
    fut_flow_5m: r(f?.flow5),
    fut_flow_15m: r(f?.flow15),
    fut_net_lots_15m: r(f?.netLots15, 0),
    fut_book5: r(f?.bookImbalance),
    fut_book20: r(f?.book20Imbalance),
    fut_book20_orders: r(f?.book20OrdersImbalance),
    fut_spread: r(f?.spread, 2),
    opt_minutes_to_expiry: r(o?.minutesToExpiry, 1),
    opt_atm: r(o?.atm, 2),
    opt_straddle: r(o?.straddle, 2),
    opt_forward: r(o?.forward, 2),
    opt_iv_change_since_open_pct: r(o?.ivChangeSinceOpenPct),
    opt_pcr: r(o?.pcr),
    opt_pcr_15m: r(o?.pcr15),
    opt_call_oi_15m_lots: r(o?.callOiChange15Lots, 0),
    opt_put_oi_15m_lots: r(o?.putOiChange15Lots, 0),
    opt_call_wall: r(o?.callWall?.strike, 2),
    opt_put_wall: r(o?.putWall?.strike, 2),
    opt_max_pain: r(o?.maxPain, 2),
    chain_iv: r(c?.ivPct),
    chain_iv_change_15m: r(c?.ivChange15),
    chain_iv_change_day: r(c?.ivChangeSinceFirst),
    chain_skew: r(c?.skewPct),
    chain_next_iv: r(c?.nextIvPct),
    chain_pcr: r(c?.pcr),
    chain_call_oi_day_lots: r(c?.callOiChangeDayLots, 0),
    chain_put_oi_day_lots: r(c?.putOiChangeDayLots, 0),
    chain_call_wall: r(c?.callWall?.strike, 2),
    chain_put_wall: r(c?.putWall?.strike, 2),
    chain_age: r(c?.ageMinutes, 0),
  };
  const singles = pulse.signals.filter((s) => s.kind === "single");
  const combined = pulse.signals.filter((s) => s.kind === "combined");
  singles.forEach((s, i) => {
    out[`sig_${s.id}`] = point.votes[i] ?? 0;
    out[`sig_${s.id}_value`] = r(point.values[i] ?? null, 6);
  });
  combined.forEach((s, i) => {
    out[`sig_${s.id}`] = point.combined[i] ?? 0;
  });
  // Every field present, in order, null when missing.
  const state = Object.fromEntries(FIELD_NAMES.map((name) => [name, out[name] ?? null])) as Record<MinuteField, number | null>;
  return { ...state, at: point.at, t };
}
