// Option replay for the Pulse page: what following a signal's firings with NIFTY options would
// have made or lost. Each firing buys an option at the close of its minute and sells it at the
// close `horizon` minutes later, both from Dhan's 1-minute option candles. Buying only: a long
// firing buys a call, a short firing buys a put.
//
// Pure: contracts, candles and settings in, trades out. Charges use the rates below, which are
// assumptions to check against Dhan's charges page, not figures read from Dhan.

import type { SignalEvent } from "./pulse.ts";

export interface OptionLeg {
  securityId: string;
  name: string;
}

/** What /api/insight/options returns. */
export interface OptionChoices {
  scrips: { tradingDate: string; current: boolean };
  expiries: string[];
  expiry: string;
  lotSize: number | null;
  strikes: { strike: number; CE?: OptionLeg; PE?: OptionLeg }[];
}

/** What /api/insight/option-candles returns: per security id, minute starts (ms), opens, closes, volumes. */
export interface OptionCandles {
  date: string;
  candles: Record<string, { t: number[]; o: number[]; c: number[]; v: number[] }>;
  errors: Record<string, string>;
}

const MIN_RATIO_MOVE = 5;

/** Strike relative to the money at each firing (+1 = one strike out of the money), or one fixed strike. */
export type StrikeChoice = { kind: "relative"; offset: number } | { kind: "fixed"; strike: number };
/** Which firings to trade: both (calls on long, puts on short), or one side only. */
export type SideChoice = "both" | "calls" | "puts";

export interface PlannedTrade {
  event: SignalEvent;
  /** NIFTY when the signal fired. */
  spot: number | null;
  strike: number | null;
  type: "CE" | "PE";
  leg: OptionLeg | null;
}

export interface OptionTrade extends PlannedTrade {
  entry: number | null;
  exit: number | null;
  /** Why it wasn't priced, when entry or exit is missing. */
  skipped: string | null;
  qty: number;
  gross: number;
  charges: number;
  net: number;
  /** Option move per NIFTY point over the trade: roughly its delta. */
  ratio: number | null;
}

export interface ChargeRates {
  /** Rupees per executed order. */
  brokeragePerOrder: number;
  /** Fraction of sell-side premium. */
  stt: number;
  /** Fraction of premium turnover (buy + sell). */
  exchange: number;
  sebi: number;
  /** Fraction of buy-side value. */
  stamp: number;
  gst: number;
}

/** Assumed NSE index option rates. Verify against Dhan's charges page before trusting the totals. */
export const OPTION_RATES: ChargeRates = {
  brokeragePerOrder: 20,
  stt: 0.001,
  exchange: 0.0003503,
  sebi: 0.000001,
  stamp: 0.00003,
  gst: 0.18,
};

/** Assumed NSE index futures rates, for the comparison line. */
export const FUTURES_RATES: ChargeRates = {
  brokeragePerOrder: 20,
  stt: 0.0002,
  exchange: 0.0000173,
  sebi: 0.000001,
  stamp: 0.00002,
  gst: 0.18,
};

/** Charges on one round trip (one buy order, one sell order). */
export function roundTripCharges(buyValue: number, sellValue: number, rates: ChargeRates) {
  const brokerage = 2 * rates.brokeragePerOrder;
  const exchange = (buyValue + sellValue) * rates.exchange;
  const sebi = (buyValue + sellValue) * rates.sebi;
  const stt = sellValue * rates.stt;
  const stamp = buyValue * rates.stamp;
  const gst = (brokerage + exchange + sebi) * rates.gst;
  return brokerage + exchange + sebi + stt + stamp + gst;
}

/** The contract each firing would buy. Firings on a side not traded are left out. */
export function planTrades(
  events: SignalEvent[],
  spotAt: (at: number) => number | null,
  strikes: OptionChoices["strikes"],
  strike: StrikeChoice,
  side: SideChoice,
): PlannedTrade[] {
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  const out: PlannedTrade[] = [];
  for (const event of events) {
    const type = event.vote > 0 ? "CE" : "PE";
    if ((side === "calls" && type !== "CE") || (side === "puts" && type !== "PE")) continue;
    const spot = spotAt(event.at);
    let row: (typeof sorted)[number] | undefined;
    if (strike.kind === "fixed") row = sorted.find((s) => s.strike === strike.strike);
    else if (spot !== null && sorted.length) {
      let atm = 0;
      for (let i = 1; i < sorted.length; i += 1) if (Math.abs(sorted[i].strike - spot) < Math.abs(sorted[atm].strike - spot)) atm = i;
      // Out of the money is above the spot for a call and below it for a put.
      const index = atm + (type === "CE" ? strike.offset : -strike.offset);
      row = sorted[index];
    }
    out.push({ event, spot, strike: row?.strike ?? null, type, leg: row?.[type] ?? null });
  }
  return out;
}

/** Close of the candle at `at`, or the last one before it within `staleMs` (illiquid minutes have no candle). */
function closeAt(candles: OptionCandles["candles"][string] | undefined, at: number, staleMs = 3 * 60_000): number | null {
  if (!candles) return null;
  let found: number | null = null;
  for (let i = 0; i < candles.t.length; i += 1) {
    if (candles.t[i] > at) break;
    if (at - candles.t[i] <= staleMs) found = candles.c[i];
  }
  return found;
}

export function simulateTrades(
  planned: PlannedTrade[],
  candles: OptionCandles["candles"],
  options: { horizon: number; qty: number; slippage: number; spotAt: (at: number) => number | null },
): OptionTrade[] {
  const { horizon, qty, slippage, spotAt } = options;
  return planned.map((p) => {
    const blank = { entry: null, exit: null, qty, gross: 0, charges: 0, net: 0, ratio: null };
    if (!p.leg) return { ...p, ...blank, skipped: "No contract at that strike in the downloaded instruments" };
    const series = candles[p.leg.securityId];
    if (!series) return { ...p, ...blank, skipped: "Candles not loaded yet" };
    const exitAt = p.event.at + horizon * 60_000;
    // Dhan publishes a minute's candle shortly after it closes; until the exit minute is in, the
    // last close would be an old price, so the trade waits.
    if ((series.t[series.t.length - 1] ?? 0) < exitAt) return { ...p, ...blank, skipped: "Waiting for Dhan's candle at the exit minute" };
    const entry = closeAt(series, p.event.at);
    const exit = closeAt(series, exitAt);
    if (entry === null || exit === null) return { ...p, ...blank, entry, exit, skipped: "No trades in this option around that minute" };
    // Slippage: pay a little more to get in and receive a little less to get out.
    const buy = entry + slippage;
    const sell = Math.max(0, exit - slippage);
    const gross = (sell - buy) * qty;
    const charges = roundTripCharges(buy * qty, sell * qty, OPTION_RATES);
    const niftyThen = spotAt(p.event.at);
    const niftyLater = spotAt(exitAt);
    const move = niftyThen !== null && niftyLater !== null ? niftyLater - niftyThen : null;
    return {
      ...p,
      entry,
      exit,
      skipped: null,
      qty,
      gross,
      charges,
      net: gross - charges,
      // Too small a NIFTY move makes the ratio meaningless.
      ratio: move !== null && Math.abs(move) >= MIN_RATIO_MOVE ? (exit - entry) / move : null,
    };
  });
}

/** The same firings traded with NIFTY futures: points × quantity, less futures charges. */
export function futuresComparison(trades: OptionTrade[], qty: number, slippagePoints: number) {
  let net = 0;
  let gross = 0;
  let count = 0;
  for (const t of trades) {
    if (t.skipped || t.spot === null) continue;
    const points = t.event.vote * t.event.outcome - 2 * slippagePoints;
    const value = t.spot * qty;
    gross += points * qty;
    net += points * qty - roundTripCharges(value, value, FUTURES_RATES);
    count += 1;
  }
  return { gross, net, count };
}
