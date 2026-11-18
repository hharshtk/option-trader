// What NIFTY's futures and options say, read from the day's journal session (`session.derivatives`,
// built by the engine's session aggregator from the research recorder's Full-mode packets).
//
//   - The near-month future: its premium over the index, open interest (positions open), who is
//     trading (buyers taking the ask against sellers hitting the bid) and the book.
//   - The nearest option expiry: call and put open interest near the money (where option writers
//     stand), the biggest strikes either side, and the at-the-money straddle, which prices the move
//     the market expects.
//   - Option maths for one contract (Black-76 on the forward): its delta and how much time value it
//     loses over a hold, so a proposal can be weighed against the move it needs.
//
// Pure and deterministic like pulse.ts: data in, numbers out, nothing read past minute `t`.

import type { JournalSession, SessionDerivatives, SessionStrike } from "../engine/protocol.ts";

const MINUTE_MS = 60_000;
/** Trading minutes in a session, 09:15 to 15:30. */
export const SESSION_MINUTES = 375;
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** Per-minute readers over the session's derivatives. Every reader looks only at minutes up to `t`. */
export interface DerivativesView {
  data: SessionDerivatives;
  /** Share of the future's traded quantity over the `h` minutes ending at `t` taken by buyers, as −1 (all sellers) to +1 (all buyers). */
  flow(t: number, h: number): { buys: number; sells: number; share: number } | null;
  /** The future's average traded quantity per minute (buyers plus sellers) from the open to `t`. */
  meanVolume(t: number): number | null;
  /** The future's price change over `h` minutes, as a fraction. */
  futureMove(t: number, h: number): number | null;
  /** The future's open interest change over `h` minutes, as a fraction. */
  oiChange(t: number, h: number): number | null;
  /** Near-the-money put open interest change minus call open interest change over `h` minutes, as a share of near-the-money open interest now. */
  writers(t: number, h: number): { calls: number; puts: number; share: number } | null;
  /** The near-month future's 20-level book at minute `t`: (bids − asks) / (bids + asks) by quantity and by orders, and the spread in points. */
  book20(t: number): { imbalance: number; orders: number | null; spread: number | null } | null;
}

export function derivativesView(session: JournalSession): DerivativesView | null {
  const data = session.derivatives;
  if (!data || (!data.future && !data.options && !data.book && !data.chain)) return null;
  const f = data.future;
  const o = data.options;
  // Running totals, so a reading over any window is two lookups.
  const buys: number[] = [0];
  const sells: number[] = [0];
  if (f) {
    for (let i = 0; i < f.buys.length; i += 1) {
      buys.push(buys[i] + f.buys[i]);
      sells.push(sells[i] + f.sells[i]);
    }
  }
  return {
    data,
    flow(t, h) {
      if (!f || t < h - 1 || t >= f.buys.length) return null;
      const b = buys[t + 1] - buys[t + 1 - h];
      const s = sells[t + 1] - sells[t + 1 - h];
      return b + s > 0 ? { buys: b, sells: s, share: (b - s) / (b + s) } : null;
    },
    meanVolume(t) {
      if (!f || t < 0 || t >= f.buys.length) return null;
      return (buys[t + 1] + sells[t + 1]) / (t + 1);
    },
    futureMove(t, h) {
      const a = f?.closes[t];
      const b = f?.closes[t - h];
      return t >= h && a != null && b != null && b > 0 ? a / b - 1 : null;
    },
    oiChange(t, h) {
      const a = f?.oi[t];
      const b = f?.oi[t - h];
      return t >= h && a != null && b != null && b > 0 ? a / b - 1 : null;
    },
    writers(t, h) {
      if (!o || t < h) return null;
      const [c, p, c0, p0] = [o.callOi[t], o.putOi[t], o.callOi[t - h], o.putOi[t - h]];
      if (c == null || p == null || c0 == null || p0 == null || c + p <= 0) return null;
      // Near the money is measured around each minute's own at-the-money strike, so the totals
      // shift a little when NIFTY crosses a strike; over 15 minutes that is small against the flow.
      return { calls: c - c0, puts: p - p0, share: (p - p0 - (c - c0)) / (c + p) };
    },
    book20(t) {
      const b = data.book;
      const bid = b?.bidQty[t];
      const ask = b?.askQty[t];
      if (!b || bid == null || ask == null || bid + ask <= 0) return null;
      const bo = b.bidOrders[t];
      const ao = b.askOrders[t];
      return { imbalance: (bid - ask) / (bid + ask), orders: bo != null && ao != null && bo + ao > 0 ? (bo - ao) / (bo + ao) : null, spread: b.spread[t] };
    },
  };
}

export type Positioning = "long build-up" | "short build-up" | "short covering" | "long unwinding";

/**
 * The textbook reading of price against open interest: rising price with rising OI is new buyers
 * (long build-up), falling price with rising OI new sellers (short build-up), rising price with
 * falling OI sellers closing (short covering), falling price with falling OI buyers closing (long
 * unwinding). Null when either barely moved.
 */
export function positioning(move: number | null, oiChange: number | null, minMove = 0.0003, minOi = 0.0005): Positioning | null {
  if (move === null || oiChange === null || Math.abs(move) < minMove || Math.abs(oiChange) < minOi) return null;
  if (oiChange > 0) return move > 0 ? "long build-up" : "short build-up";
  return move > 0 ? "short covering" : "long unwinding";
}

/** The day's futures and options picture at minute `t`. */
export interface DerivativesSnapshot {
  future: {
    name: string;
    expiry: string;
    lotSize: number;
    price: number;
    /** Future minus NIFTY, in points, and its change over the last 15 minutes. */
    basis: number | null;
    basisChange15: number | null;
    /** Percent. */
    move15Pct: number | null;
    oiChange15Pct: number | null;
    /** Against the previous session's close. */
    oiChangeDayPct: number | null;
    positioning15: Positioning | null;
    /** −1 (all sellers) to +1 (all buyers) of the quantity traded. */
    flow5: number | null;
    flow15: number | null;
    /** Buyers' minus sellers' lots over 15 minutes. */
    netLots15: number | null;
    /** (bids − asks) / (bids + asks) over the best five levels. */
    bookImbalance: number | null;
    /** The same over the best 20 levels (the depth feed), by quantity and by number of orders. */
    book20Imbalance: number | null;
    book20OrdersImbalance: number | null;
    /** Best ask minus best bid, in points, from the 20-level book. */
    spread: number | null;
    vwap: number | null;
    /** Future minus its VWAP, in points. */
    vsVwap: number | null;
  } | null;
  options: {
    expiry: string;
    /** Calendar days to expiry, and trading minutes left until 15:30 on the expiry day (weekends skipped, holidays not). */
    daysToExpiry: number;
    minutesToExpiry: number;
    atm: number;
    straddle: number | null;
    /** NIFTY's forward price from the at-the-money call and put: strike + call − put. */
    forward: number | null;
    /** At-the-money implied volatility now against the open, in percent: +10 means options cost 10% more volatility than at the open. */
    ivChangeSinceOpenPct: number | null;
    /** Put open interest over call open interest, near the money: now, at the open and 15 minutes ago. */
    pcr: number | null;
    pcrAtOpen: number | null;
    pcr15: number | null;
    /** Lots added (or closed, if negative) near the money over 15 minutes and since the previous close. */
    callOiChange15Lots: number | null;
    putOiChange15Lots: number | null;
    callOiChangeDayLots: number | null;
    putOiChangeDayLots: number | null;
    /** The strike with the most call open interest at or above NIFTY, and with the most put open interest at or below it, among the recorded strikes. */
    callWall: { strike: number; lots: number; points: number } | null;
    putWall: { strike: number; lots: number; points: number } | null;
    /** The settlement price at which option buyers would collect least, over the recorded strikes. Means most near expiry. */
    maxPain: number | null;
  } | null;
  /** From the option chain snapshots (every strike within 10% of NIFTY, once a minute). */
  chain: {
    expiry: string;
    nextExpiry: string | null;
    /** Minutes between the snapshot read and `at`. */
    ageMinutes: number;
    /** At-the-money volatility, annualised, percent; worked out from bid-ask middles. */
    ivPct: number | null;
    /** Its change in volatility points over 15 minutes and since the day's first snapshot. */
    ivChange15: number | null;
    ivChangeSinceFirst: number | null;
    /** Put 1% below minus call 1% above, volatility points. */
    skewPct: number | null;
    nextIvPct: number | null;
    straddle: number | null;
    forward: number | null;
    /** Put over call open interest across every strike. */
    pcr: number | null;
    /** Lots added since the previous close across every strike. */
    callOiChangeDayLots: number | null;
    putOiChangeDayLots: number | null;
    callWall: { strike: number; lots: number; points: number } | null;
    putWall: { strike: number; lots: number; points: number } | null;
  } | null;
}

export function derivativesSnapshot(view: DerivativesView, t: number, input: { spot: (t: number) => number | null; at: number; date: string; session: { open: number; close: number } }): DerivativesSnapshot {
  const { data } = view;
  const spot = input.spot(t);
  const round = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));

  let future: DerivativesSnapshot["future"] = null;
  const f = data.future;
  const price = f?.closes[t];
  if (f && price != null) {
    const basisAt = (i: number) => {
      const fp = f.closes[i];
      const sp = input.spot(i);
      return i >= 0 && fp != null && sp !== null ? fp - sp : null;
    };
    const basis = basisAt(t);
    const basis15 = basisAt(t - 15);
    const move15 = view.futureMove(t, 15);
    const oi15 = view.oiChange(t, 15);
    const oi = f.oi[t];
    const flow15 = view.flow(t, 15);
    const bid = f.bidQty[t];
    const ask = f.askQty[t];
    const vwap = f.vwap[t];
    future = {
      name: f.name,
      expiry: f.expiry,
      lotSize: f.lotSize,
      price,
      basis: round(basis, 1),
      basisChange15: basis !== null && basis15 !== null ? round(basis - basis15, 1) : null,
      move15Pct: round(move15 === null ? null : move15 * 100, 3),
      oiChange15Pct: round(oi15 === null ? null : oi15 * 100, 3),
      oiChangeDayPct: oi != null && f.oiBefore ? round((oi / f.oiBefore - 1) * 100, 2) : null,
      positioning15: positioning(move15, oi15),
      flow5: round(view.flow(t, 5)?.share),
      flow15: round(flow15?.share),
      netLots15: flow15 ? Math.round((flow15.buys - flow15.sells) / f.lotSize) : null,
      bookImbalance: bid != null && ask != null && bid + ask > 0 ? round((bid - ask) / (bid + ask)) : null,
      book20Imbalance: round(view.book20(t)?.imbalance),
      book20OrdersImbalance: round(view.book20(t)?.orders),
      spread: round(view.book20(t)?.spread),
      vwap,
      vsVwap: vwap != null ? round(price - vwap, 1) : null,
    };
  }

  let options: DerivativesSnapshot["options"] = null;
  const o = data.options;
  const atm = o?.atm[t];
  if (o && atm != null) {
    const minutesAt = (i: number) => tradingMinutesToExpiry(input.session.open + i * MINUTE_MS + MINUTE_MS, o.expiry, input.date, input.session);
    const minutesToExpiry = tradingMinutesToExpiry(input.at, o.expiry, input.date, input.session);
    const ratio = (i: number) => {
      const c = o.callOi[i];
      const p = o.putOi[i];
      return i >= 0 && c != null && p != null && c > 0 ? p / c : null;
    };
    const first = o.callOi.findIndex((c, i) => c !== null && o.putOi[i] !== null);
    const writers = view.writers(t, 15);
    // The ATM straddle prices the move to expiry; volatility is that move as a share of the price, over √time.
    const ivAt = (i: number) => {
      const s = o.straddle[i];
      const level = input.spot(i);
      const m = minutesAt(i);
      return s != null && level !== null && level > 0 && m > 0 ? s / level / Math.sqrt(m) : null;
    };
    const firstStraddle = o.straddle.findIndex((s) => s !== null);
    const ivNow = ivAt(t);
    const ivOpen = firstStraddle >= 0 && firstStraddle <= t ? ivAt(firstStraddle) : null;
    const row = o.strikes.find((s) => s.strike === atm);
    const forward = row ? parityForward(row) : null;
    const band = o.strikes.filter((s) => Math.abs(s.strike - atm) <= o.band * o.step + 1e-9);
    const dayChange = (side: "call" | "put") => {
      let sum = 0;
      for (const s of band) {
        const q = s[side];
        if (!q || q.oi === null || q.oiBefore === null) return null;
        sum += q.oi - q.oiBefore;
      }
      return Math.round(sum / o.lotSize);
    };
    options = {
      expiry: o.expiry,
      daysToExpiry: daysBetween(input.date, o.expiry),
      minutesToExpiry,
      atm,
      straddle: o.straddle[t],
      forward: round(forward, 1),
      ivChangeSinceOpenPct: ivNow !== null && ivOpen !== null && ivOpen > 0 ? round((ivNow / ivOpen - 1) * 100, 1) : null,
      pcr: round(ratio(t)),
      pcrAtOpen: first >= 0 && first <= t ? round(ratio(first)) : null,
      pcr15: round(ratio(t - 15)),
      callOiChange15Lots: writers ? Math.round(writers.calls / o.lotSize) : null,
      putOiChange15Lots: writers ? Math.round(writers.puts / o.lotSize) : null,
      callOiChangeDayLots: dayChange("call"),
      putOiChangeDayLots: dayChange("put"),
      callWall: spot === null ? null : wall(o.strikes, "call", (k) => k >= spot, spot, o.lotSize),
      putWall: spot === null ? null : wall(o.strikes, "put", (k) => k <= spot, spot, o.lotSize),
      maxPain: maxPain(o.strikes),
    };
  }

  let chain: DerivativesSnapshot["chain"] = null;
  const c = data.chain;
  const when = c?.at[t];
  if (c && when != null) {
    const lot = data.options?.lotSize ?? data.future?.lotSize ?? 1;
    const iv = c.ivPct[t];
    const first = c.ivPct.findIndex((v) => v !== null);
    const diff = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : round(a - b));
    const wallAt = (strike: number | null, oi: number | null, level: number | null) =>
      strike === null || oi === null || level === null ? null : { strike, lots: Math.round(oi / lot), points: Math.round((strike - level) * 10) / 10 };
    const level = spot ?? c.spot[t];
    chain = {
      expiry: c.expiry,
      nextExpiry: c.nextExpiry,
      ageMinutes: Math.max(0, Math.round((input.at - when) / MINUTE_MS)),
      ivPct: iv,
      ivChange15: t >= 15 ? diff(iv, c.ivPct[t - 15]) : null,
      ivChangeSinceFirst: first >= 0 && first <= t ? diff(iv, c.ivPct[first]) : null,
      skewPct: c.skewPct[t],
      nextIvPct: c.nextIvPct[t],
      straddle: c.straddle[t],
      forward: c.forward[t],
      pcr: c.callOi[t] ? round(c.putOi[t]! / c.callOi[t]!) : null,
      callOiChangeDayLots: c.callOiChange[t] == null ? null : Math.round(c.callOiChange[t]! / lot),
      putOiChangeDayLots: c.putOiChange[t] == null ? null : Math.round(c.putOiChange[t]! / lot),
      callWall: wallAt(c.callWall[t], c.callWallOi[t], level),
      putWall: wallAt(c.putWall[t], c.putWallOi[t], level),
    };
  }
  return { future, options, chain };
}

function wall(strikes: SessionStrike[], side: "call" | "put", keep: (strike: number) => boolean, spot: number, lotSize: number) {
  let best: SessionStrike | null = null;
  for (const s of strikes) {
    if (!keep(s.strike) || s[side]?.oi == null) continue;
    if (!best || s[side]!.oi! > best[side]!.oi!) best = s;
  }
  return best ? { strike: best.strike, lots: Math.round(best[side]!.oi! / lotSize), points: Math.round((best.strike - spot) * 10) / 10 } : null;
}

/** The settlement at which calls and puts together would be worth least to their holders. */
export function maxPain(strikes: readonly SessionStrike[]): number | null {
  const known = strikes.filter((s) => s.call?.oi != null && s.put?.oi != null);
  if (known.length < 3) return null;
  let best: number | null = null;
  let least = Infinity;
  for (const settle of known) {
    let paid = 0;
    for (const s of known) paid += s.call!.oi! * Math.max(0, settle.strike - s.strike) + s.put!.oi! * Math.max(0, s.strike - settle.strike);
    if (paid < least) [least, best] = [paid, settle.strike];
  }
  return best;
}

/** Put-call parity on one strike: forward = strike + call − put. Mid prices when the book is known. */
export function parityForward(row: SessionStrike): number | null {
  const mid = (q: SessionStrike["call"]) => (q && q.bid !== null && q.ask !== null && q.ask >= q.bid ? (q.bid + q.ask) / 2 : (q?.ltp ?? null));
  const c = mid(row.call);
  const p = mid(row.put);
  return c === null || p === null ? null : row.strike + c - p;
}

// --- Option maths ---------------------------------------------------------------------------------

/** Standard normal cumulative distribution (Abramowitz and Stegun 7.1.26, error under 1e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const tail = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

/**
 * Black-76 on the forward, with `deviation` = σ√T, the standard deviation of log price to expiry.
 * Discounting is left out: over days at Indian rates it moves a NIFTY option by paise.
 */
export function black76(forward: number, strike: number, deviation: number, type: "CE" | "PE"): number {
  if (deviation <= 0) return Math.max(0, type === "CE" ? forward - strike : strike - forward);
  const d1 = (Math.log(forward / strike) + (deviation * deviation) / 2) / deviation;
  const d2 = d1 - deviation;
  return type === "CE" ? forward * normCdf(d1) - strike * normCdf(d2) : strike * normCdf(-d2) - forward * normCdf(-d1);
}

/** The σ√T at which Black-76 gives `price`; null when the price is below its intrinsic value or above what any volatility gives. */
export function impliedDeviation(price: number, forward: number, strike: number, type: "CE" | "PE"): number | null {
  const intrinsic = Math.max(0, type === "CE" ? forward - strike : strike - forward);
  if (!(price > intrinsic) || price >= (type === "CE" ? forward : strike)) return null;
  let lo = 1e-6;
  let hi = 3;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (black76(forward, strike, mid, type) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export interface OptionView {
  /** NIFTY points the premium moves per NIFTY point, signed: positive for calls. */
  delta: number;
  /** Rupees per unit of time value lost over the hold if NIFTY stays where it is. */
  decay: number;
  /** Implied volatility, annualised over 252 trading days of 375 minutes, in percent. */
  ivPct: number;
}

/**
 * Delta and time decay over `holdMinutes` for an option priced at `premium`. Time is counted in
 * trading minutes (weekends and nights left out), the same clock the straddle's expected move uses.
 */
export function optionView(input: { premium: number; forward: number; strike: number; type: "CE" | "PE"; minutesToExpiry: number; holdMinutes: number }): OptionView | null {
  const { premium, forward, strike, type, minutesToExpiry, holdMinutes } = input;
  if (minutesToExpiry <= 0 || forward <= 0) return null;
  const deviation = impliedDeviation(premium, forward, strike, type);
  if (deviation === null) return null;
  const d1 = (Math.log(forward / strike) + (deviation * deviation) / 2) / deviation;
  const left = Math.max(0, minutesToExpiry - holdMinutes);
  const later = black76(forward, strike, deviation * Math.sqrt(left / minutesToExpiry), type);
  return {
    delta: type === "CE" ? normCdf(d1) : normCdf(d1) - 1,
    decay: Math.max(0, black76(forward, strike, deviation, type) - later),
    ivPct: (deviation / Math.sqrt(minutesToExpiry / (252 * SESSION_MINUTES))) * 100,
  };
}

/**
 * The typical size of NIFTY's move over `minutes`, either way, that the at-the-money straddle
 * prices: the straddle is the expected move to expiry, and moves grow with the square root of time.
 */
export function impliedMove(straddle: number | null, minutesToExpiry: number, minutes: number): number | null {
  return straddle === null || minutesToExpiry <= 0 ? null : straddle * Math.sqrt(Math.min(1, minutes / minutesToExpiry));
}

/**
 * Trading minutes from `at` to 15:30 on the expiry day: what is left of today's session plus a
 * full session for each weekday after today up to the expiry. Exchange holidays are not skipped.
 */
export function tradingMinutesToExpiry(at: number, expiry: string, date: string, session: { open: number; close: number }): number {
  const today = Math.max(0, Math.min(SESSION_MINUTES, (session.close - Math.max(at, session.open)) / MINUTE_MS));
  if (expiry < date) return 0;
  let minutes = today;
  for (let day = nextDay(date); day <= expiry; day = nextDay(day)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) minutes += SESSION_MINUTES;
  }
  return minutes;
}

function nextDay(date: string) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** IST weekday name of a market time. */
export function istWeekday(at: number) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(at + IST_OFFSET_MS).getUTCDay()];
}
