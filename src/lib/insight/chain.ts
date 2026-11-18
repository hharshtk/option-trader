// What one option chain snapshot says (the research recorder's `.chain` file: Dhan's
// `/optionchain` answer, strikes within 10% of the index): volatility worked out here from the
// bid-ask middles, the skew, the straddle, and where open interest stands across every strike.
//
// Volatility is our own, not Dhan's. Dhan's figures for the call and the put of one strike
// disagreed by 2 to 4 points all of 18 November 2026, which put-call parity rules out. Here the
// forward comes from the at-the-money call and put (strike + call − put), and every option is
// priced on that forward with Black-76, so the call and the put of a strike agree by construction.
//
// Pure: a snapshot in, numbers out.

import { impliedDeviation, SESSION_MINUTES } from "./derivatives.ts";

/** Trading minutes in a year: 252 sessions of 375 minutes, the clock volatility is quoted on. */
const YEAR_MINUTES = 252 * SESSION_MINUTES;
/** How far out of the money the skew's put and call are, as a share of the forward. */
export const SKEW_DISTANCE = 0.01;

export interface ChainReading {
  /** The index when the snapshot was taken. */
  spot: number;
  /** The strike nearest the index. */
  atm: number;
  /** strike + call − put at the money, from the bid-ask middles. */
  forward: number | null;
  /** At-the-money volatility, annualised, in percent: the average of the call's and the put's. */
  ivPct: number | null;
  /** The put about 1% below the forward minus the call about 1% above it, in volatility points. Positive: protection costs more than upside. */
  skewPct: number | null;
  /** At-the-money call plus put, from the middles: the move to expiry the market prices, in index points. */
  straddle: number | null;
  /** Open interest summed over every strike in the snapshot. */
  callOi: number;
  putOi: number;
  /** Open interest added since the previous session's close (negative: closed), over every strike. */
  callOiChange: number;
  putOiChange: number;
  /** The strike with the most call open interest at or above the index, and the most put open interest at or below it. */
  callWall: { strike: number; oi: number } | null;
  putWall: { strike: number; oi: number } | null;
}

interface Side {
  last_price?: number;
  top_bid_price?: number;
  top_ask_price?: number;
  oi?: number;
  previous_oi?: number;
}

/** Reads a snapshot taken `minutesToExpiry` trading minutes before expiry. Null when it has no strikes. */
export function readChain(snapshot: { lastPrice: number; oc: Record<string, unknown> }, minutesToExpiry: number): ChainReading | null {
  const spot = snapshot.lastPrice;
  const rows = Object.entries(snapshot.oc)
    .map(([strike, row]) => ({ strike: Number(strike), ce: (row as { ce?: Side })?.ce ?? null, pe: (row as { pe?: Side })?.pe ?? null }))
    .filter((r) => Number.isFinite(r.strike) && r.strike > 0)
    .sort((a, b) => a.strike - b.strike);
  if (rows.length === 0 || !(spot > 0)) return null;

  let atmRow = rows[0];
  for (const r of rows) if (Math.abs(r.strike - spot) < Math.abs(atmRow.strike - spot)) atmRow = r;
  const callMid = mid(atmRow.ce);
  const putMid = mid(atmRow.pe);
  const forward = callMid !== null && putMid !== null ? atmRow.strike + callMid - putMid : null;

  const ivOf = (side: Side | null, strike: number, type: "CE" | "PE") => {
    const price = mid(side);
    if (forward === null || price === null || minutesToExpiry <= 0) return null;
    const deviation = impliedDeviation(price, forward, strike, type);
    return deviation === null ? null : (deviation / Math.sqrt(minutesToExpiry / YEAR_MINUTES)) * 100;
  };
  const callIv = ivOf(atmRow.ce, atmRow.strike, "CE");
  const putIv = ivOf(atmRow.pe, atmRow.strike, "PE");
  const ivs = [callIv, putIv].filter((v): v is number => v !== null);

  let skewPct: number | null = null;
  if (forward !== null) {
    const nearest = (target: number) => rows.reduce((best, r) => (Math.abs(r.strike - target) < Math.abs(best.strike - target) ? r : best), rows[0]);
    const down = nearest(forward * (1 - SKEW_DISTANCE));
    const up = nearest(forward * (1 + SKEW_DISTANCE));
    const p = down.strike < forward ? ivOf(down.pe, down.strike, "PE") : null;
    const c = up.strike > forward ? ivOf(up.ce, up.strike, "CE") : null;
    skewPct = p !== null && c !== null ? p - c : null;
  }

  let callOi = 0;
  let putOi = 0;
  let callOiChange = 0;
  let putOiChange = 0;
  let callWall: ChainReading["callWall"] = null;
  let putWall: ChainReading["putWall"] = null;
  for (const r of rows) {
    const co = num(r.ce?.oi);
    const po = num(r.pe?.oi);
    callOi += co;
    putOi += po;
    if (r.ce?.previous_oi !== undefined) callOiChange += co - num(r.ce.previous_oi);
    if (r.pe?.previous_oi !== undefined) putOiChange += po - num(r.pe.previous_oi);
    if (r.strike >= spot && co > 0 && (!callWall || co > callWall.oi)) callWall = { strike: r.strike, oi: co };
    if (r.strike <= spot && po > 0 && (!putWall || po > putWall.oi)) putWall = { strike: r.strike, oi: po };
  }

  return {
    spot,
    atm: atmRow.strike,
    forward: forward === null ? null : round(forward, 2),
    ivPct: ivs.length ? round(ivs.reduce((a, b) => a + b, 0) / ivs.length, 2) : null,
    skewPct: skewPct === null ? null : round(skewPct, 2),
    straddle: callMid !== null && putMid !== null ? round(callMid + putMid, 2) : null,
    callOi,
    putOi,
    callOiChange,
    putOiChange,
    callWall,
    putWall,
  };
}

/** The bid-ask middle when both sides are quoted and sane, else the last trade; null when neither. */
function mid(side: Side | null): number | null {
  if (!side) return null;
  const bid = num(side.top_bid_price);
  const ask = num(side.top_ask_price);
  if (bid > 0 && ask >= bid) return (bid + ask) / 2;
  const last = num(side.last_price);
  return last > 0 ? last : null;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const round = (value: number, digits: number) => Number(value.toFixed(digits));
