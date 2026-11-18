// NIFTY Pulse: turns a journal session (the engine's decoded day, see session-summary.ts) into a
// read of the market: what NIFTY is doing, which stocks and sectors moved it, a shadow decision,
// and how a few candidate signals have done so far today.
//
// Pure and deterministic: the same session in gives the same pulse out, so it can run in the
// browser today and in the engine on live, replay and backtest later. Nothing here looks ahead:
// each minute's signal uses only closes up to that minute; outcomes are scored afterwards.

import type { JournalSession, SessionInstrument } from "../engine/protocol.ts";
import { derivativesSnapshot, derivativesView, type DerivativesSnapshot } from "./derivatives.ts";

export interface PulseConstituent {
  key: string;
  symbol: string;
  sector: string;
  /** Prior weight, any scale (Dhan's market-cap share). Normalised here. */
  prior: number;
}

export interface Contribution {
  key: string;
  symbol: string;
  sector: string;
  weight: number;
  /** Return from the previous close. */
  change: number;
  /** NIFTY points this stock added since the previous close. */
  points: number;
  /** NIFTY points added over the last RECENT_MINUTES. */
  recentPoints: number;
  aboveVwap: boolean | null;
  /** (buy − sell) / (buy + sell) pending quantity, −1..1. */
  book: number | null;
}

export interface Evidence {
  label: string;
  detail: string;
  vote: -1 | 0 | 1;
}

export interface SignalEvent {
  at: number;
  vote: -1 | 1;
  /** NIFTY points over the horizon after the firing (not signed by the vote). */
  outcome: number;
}

/** A signal's record at one horizon: non-overlapping firings whose outcome is complete. */
export interface SignalStats {
  horizon: number;
  fired: number;
  hits: number;
  longs: number;
  longHits: number;
  shorts: number;
  shortHits: number;
  /** NIFTY points gained following every firing, before costs. */
  gross: number;
  events: SignalEvent[];
}

export interface SignalReport {
  id: string;
  name: string;
  rule: string;
  /** "combined" fires when the others agree. */
  kind: "single" | "combined";
  /** What a single signal reads: NIFTY and its stocks, or its futures and options. */
  group: "price" | "derivatives" | null;
  /** The number a single signal compares with `threshold`: it votes when the size reaches it. Null for combined signals. */
  threshold: number | null;
  /** The current reading and its vote. */
  value: number | null;
  display: string;
  vote: -1 | 0 | 1;
  stats: SignalStats[];
}

/** What NIFTY did over each horizon today, in non-overlapping windows: the bar a signal must clear. */
export interface Baseline {
  horizon: number;
  windows: number;
  upShare: number;
  /** Median size of a move, in points, either way. */
  medianMove: number;
}

export interface PulsePoint {
  at: number;
  /** NIFTY open, high, low, close in this minute. */
  bar: [number, number, number, number] | null;
  nifty: number | null;
  /** What the 50 stocks with the learned weights imply NIFTY should be. */
  basket: number | null;
  advancers: number;
  decliners: number;
  /** Each single signal's vote and reading at the end of this minute, in `signals` order. */
  votes: (-1 | 0 | 1)[];
  readings: string[];
  /** Each single signal's number at the end of this minute, in `signals` order. */
  values: (number | null)[];
  /** Each combined signal's vote, in `signals` order. */
  combined: (-1 | 0 | 1)[];
  /** Long minus short among the single signals. */
  composite: number;
}

export interface Pulse {
  asOf: number;
  minute: number;
  nifty: {
    ltp: number;
    reference: number;
    open: number | null;
    high: number | null;
    low: number | null;
    highAt: number | null;
    lowAt: number | null;
    points: number;
    change: number;
    /** 0 at the day's low, 1 at its high. */
    rangePosition: number | null;
    recentPoints: number | null;
  };
  weights: {
    source: "fitted" | "prior";
    minutesUsed: number;
    /** Out-of-sample error of the fitted weights, in NIFTY points (RMS). */
    trackingPoints: number | null;
    /** The same error with the prior weights, for comparison. */
    priorTrackingPoints: number | null;
  };
  contributions: Contribution[];
  /** NIFTY points the basket explains vs what NIFTY did. */
  explainedPoints: number;
  sectors: { sector: string; points: number; recentPoints: number; count: number }[];
  concentration: { top: Contribution[]; topPoints: number; restPoints: number };
  breadth: { advancers: number; decliners: number; weightAboveVwap: number | null; countAboveVwap: number; book: number | null };
  evidence: Evidence[];
  score: number;
  verdict: { stance: "bullish" | "bearish" | "mixed"; headline: string; action: string };
  /** NIFTY's futures and options at this minute; null for days recorded without them. */
  derivatives: DerivativesSnapshot | null;
  volatility: {
    /** India VIX and its change from the previous close, in percent. */
    vix: number | null;
    vixChangePct: number | null;
    /** NIFTY's average 1-minute move, either way, over the last 30 minutes, in points. */
    minuteMove: number | null;
  };
  signals: SignalReport[];
  baselines: Baseline[];
  /** Per minute, for the chart. */
  series: PulsePoint[];
  horizon: number;
}

export const RECENT_MINUTES = 15;
export const HORIZON = 5;
export const HORIZONS = [1, 3, 5, 10, 15] as const;
/**
 * Minutes after 09:15 at which NSE's closing auction starts (15:15). From then stock prices stop and
 * the index holds still until the auction price lands near 15:28 (docs/research.md), so no signal
 * reads that stretch and no outcome is measured across it.
 */
export const AUCTION_MINUTE = 360;
const VIX_KEY = "IDX_I:21";
/** The single signals "Two or more agree" counts. */
export const PRICE_SIGNALS = ["breadth", "lead", "momentum"] as const;
const MIN_FIT_MINUTES = 45;
const HOLDOUT_MINUTES = 30;
const RIDGE = 1e-5;

export function computePulse(session: JournalSession, constituents: readonly PulseConstituent[], benchmark = session.benchmark): Pulse | null {
  const index = session.instruments.find((i) => i.key === benchmark);
  if (!index || index.ltp === null || index.reference === null || session.minutes.length < 2) return null;
  const T = session.minutes.length;
  const now = T - 1;
  const ref = index.reference;
  const idx = index.closes;

  const byKey = new Map(session.instruments.map((i) => [i.key, i]));
  const stocks = constituents
    .map((c) => ({ c, s: byKey.get(c.key) }))
    .filter((x): x is { c: PulseConstituent; s: SessionInstrument } => !!x.s && x.s.reference !== null && x.s.ltp !== null);
  const priorSum = stocks.reduce((a, x) => a + x.c.prior, 0) || 1;
  const prior = stocks.map((x) => x.c.prior / priorSum);

  // --- Weights: learn NIFTY's effective weights from today's tape --------------------------------
  // NIFTY's return from the previous close is a weighted sum of its stocks' returns. Dhan's shares
  // are full market cap, not free float, so they misweight banks and promoter-held names. A ridge
  // fit pulled towards that prior recovers the effective weights from the minute closes.
  const ret = (s: SessionInstrument, t: number) => (s.closes[t] != null ? s.closes[t]! / s.reference! - 1 : 0);
  const rows = (from: number, to: number) => {
    const out: number[] = [];
    for (let t = from; t < to; t += 1) if (idx[t] != null) out.push(t);
    return out;
  };
  const fit = (ts: number[]) => ridge(ts.map((t) => stocks.map((x) => ret(x.s, t))), ts.map((t) => idx[t]! / ref - 1), prior, RIDGE);
  const rmsPoints = (w: number[], ts: number[]) => {
    if (!ts.length) return null;
    let e = 0;
    for (const t of ts) {
      const p = stocks.reduce((a, x, i) => a + w[i] * ret(x.s, t), 0);
      e += (p - (idx[t]! / ref - 1)) ** 2;
    }
    return Math.sqrt(e / ts.length) * ref;
  };

  const all = rows(0, T);
  let weights = prior;
  let source: Pulse["weights"]["source"] = "prior";
  let trackingPoints: number | null = null;
  let priorTrackingPoints: number | null = null;
  if (all.length >= MIN_FIT_MINUTES + HOLDOUT_MINUTES) {
    const train = rows(0, T - HOLDOUT_MINUTES);
    const test = rows(T - HOLDOUT_MINUTES, T);
    trackingPoints = rmsPoints(fit(train), test);
    priorTrackingPoints = rmsPoints(prior, test);
    weights = fit(all).map((w) => Math.max(0, w));
    source = "fitted";
  }

  // --- Attribution --------------------------------------------------------------------------------
  const back = Math.max(0, now - RECENT_MINUTES);
  const contributions: Contribution[] = stocks.map(({ c, s }, i) => {
    const then = s.closes[back] ?? s.reference!;
    return {
      key: c.key,
      symbol: c.symbol,
      sector: c.sector,
      weight: weights[i],
      change: s.ltp! / s.reference! - 1,
      points: weights[i] * (s.ltp! / s.reference! - 1) * ref,
      recentPoints: weights[i] * ((s.ltp! - then) / s.reference!) * ref,
      aboveVwap: s.vwap ? s.ltp! > s.vwap : null,
      book: s.buyQty !== null && s.sellQty !== null && s.buyQty + s.sellQty > 0 ? (s.buyQty - s.sellQty) / (s.buyQty + s.sellQty) : null,
    };
  });
  contributions.sort((a, b) => b.points - a.points);
  const explainedPoints = contributions.reduce((a, c) => a + c.points, 0);

  const sectorMap = new Map<string, { sector: string; points: number; recentPoints: number; count: number }>();
  for (const c of contributions) {
    const s = sectorMap.get(c.sector) ?? { sector: c.sector, points: 0, recentPoints: 0, count: 0 };
    s.points += c.points;
    s.recentPoints += c.recentPoints;
    s.count += 1;
    sectorMap.set(c.sector, s);
  }
  const sectors = [...sectorMap.values()].sort((a, b) => b.points - a.points);

  const points = index.ltp - ref;
  const byImpact = [...contributions].sort((a, b) => Math.sign(points || 1) * (b.points - a.points));
  const top = byImpact.slice(0, 3);
  const topPoints = top.reduce((a, c) => a + c.points, 0);

  // --- Day structure ------------------------------------------------------------------------------
  let high: number | null = null;
  let low: number | null = null;
  let highAt: number | null = null;
  let lowAt: number | null = null;
  for (const m of session.minutes) {
    if (!m.bar) continue;
    if (high === null || m.bar[1] > high) [high, highAt] = [m.bar[1], m.at];
    if (low === null || m.bar[2] < low) [low, lowAt] = [m.bar[2], m.at];
  }
  const open = session.minutes.find((m) => m.bar)?.bar?.[0] ?? index.open;
  const rangePosition = high !== null && low !== null && high > low ? (index.ltp - low) / (high - low) : null;
  const recentPoints = idx[back] != null ? index.ltp - idx[back]! : null;

  // --- Participation ------------------------------------------------------------------------------
  const vwapKnown = contributions.filter((c) => c.aboveVwap !== null);
  const vwapWeight = vwapKnown.reduce((a, c) => a + c.weight, 0);
  const weightAboveVwap = vwapWeight > 0 ? vwapKnown.reduce((a, c) => a + (c.aboveVwap ? c.weight : 0), 0) / vwapWeight : null;
  const bookKnown = contributions.filter((c) => c.book !== null);
  const bookWeight = bookKnown.reduce((a, c) => a + c.weight, 0);
  const book = bookWeight > 0 ? bookKnown.reduce((a, c) => a + c.weight * c.book!, 0) / bookWeight : null;

  // --- Signals ------------------------------------------------------------------------------------
  // Breadth over the index's own stocks: the journal holds other stocks too (BANKNIFTY's banks
  // since 18 November 2026), and the session's per-minute counts include them.
  const upDown = session.minutes.map((_, t) => {
    let up = 0;
    let down = 0;
    for (const { s } of stocks) {
      const c = s.closes[t];
      if (c == null) continue;
      if (c > s.reference!) up += 1;
      else if (c < s.reference!) down += 1;
    }
    return [up, down] as const;
  });
  const breadthAt = (t: number) => upDown[t][0] - upDown[t][1];
  const view = derivativesView(session);
  const lotSize = view?.data.future?.lotSize ?? view?.data.options?.lotSize ?? 1;
  /** The future traded under 30% of its usual volume over the last 5 minutes: the quietest tenth of 18 November's minutes. */
  const thinFlow = (t: number) => {
    const flow = view?.flow(t, 5);
    const usual = view?.meanVolume(t);
    return !flow || !usual || flow.buys + flow.sells < 0.3 * 5 * usual;
  };
  const ewMove = (t: number, h: number) => {
    let sum = 0;
    let n = 0;
    for (const { s } of stocks) {
      const a = s.closes[t];
      const b = s.closes[t - h];
      if (a != null && b != null) {
        sum += a / b - 1;
        n += 1;
      }
    }
    return n ? sum / n : null;
  };
  const idxMove = (t: number, h: number) => (idx[t] != null && idx[t - h] != null ? idx[t]! / idx[t - h]! - 1 : null);

  const definitions: {
    id: string;
    name: string;
    group: "price" | "derivatives";
    rule: string;
    read: (t: number) => number | null;
    threshold: number;
    format: (v: number, t: number) => string;
  }[] = [
    {
      id: "breadth",
      name: "Breadth thrust",
      group: "price",
      rule: "NIFTY's stocks up minus down changed by 6 or more over 5 minutes: follow it",
      read: (t) => (t >= 5 ? breadthAt(t) - breadthAt(t - 5) : null),
      threshold: 6,
      format: (v) => `${v > 0 ? "+" : ""}${v} stocks in 5 min`,
    },
    {
      id: "lead",
      name: "Basket leads index",
      group: "price",
      rule: "The average stock beat NIFTY by 4 bps or more over 5 minutes: NIFTY follows the average stock",
      read: (t) => {
        if (t < 5) return null;
        const a = ewMove(t, 5);
        const b = idxMove(t, 5);
        return a === null || b === null ? null : (a - b) * 10_000;
      },
      threshold: 4,
      format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} bps vs NIFTY`,
    },
    {
      id: "momentum",
      name: "15-minute momentum",
      group: "price",
      rule: "NIFTY moved 0.12% or more over 15 minutes: follow it",
      read: (t) => (t >= 15 ? idxMove(t, 15) : null),
      threshold: 0.0012,
      format: (v) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(2)}% in 15 min`,
    },
    // Futures and options: the research recorder's Full-mode data, from 18 November 2026.
    // Thresholds were set on 18 November so each fires on about a quarter of minutes, like momentum.
    {
      id: "flow",
      name: "Futures order flow",
      group: "derivatives",
      rule: "Over 5 minutes, buyers taking the ask made 70% or more of what NIFTY's near-month future traded (or sellers hitting the bid did), unless volume was thin (under 30% of the day's average so far): follow them",
      read: (t) => {
        const flow = view?.flow(t, 5);
        if (!flow) return null;
        return thinFlow(t) ? 0 : flow.share;
      },
      threshold: 0.4,
      format: (_, t) => {
        const share = view!.flow(t, 5)!.share;
        return `${share >= 0 ? "buyers" : "sellers"} ${Math.round(((1 + Math.abs(share)) / 2) * 100)}% in 5 min${thinFlow(t) ? ", thin" : ""}`;
      },
    },
    {
      id: "buildup",
      name: "Futures OI build-up",
      group: "derivatives",
      rule: "NIFTY's near-month future moved 0.12% or more over 15 minutes while its open interest rose 0.2% or more, so new positions are behind the move: follow it",
      read: (t) => {
        const move = view?.futureMove(t, 15);
        const oi = view?.oiChange(t, 15);
        return move == null || oi == null ? null : oi >= 0.002 ? move : 0;
      },
      threshold: 0.0012,
      format: (_, t) => {
        const move = view!.futureMove(t, 15)!;
        const oi = view!.oiChange(t, 15)!;
        return `${move >= 0 ? "+" : ""}${(move * 100).toFixed(2)}%, OI ${oi >= 0 ? "+" : ""}${(oi * 100).toFixed(2)}%`;
      },
    },
    {
      id: "writers",
      name: "Option writers",
      group: "derivatives",
      rule: "Over 15 minutes, put open interest near the money grew faster than call open interest by 3% or more of the total, so writers expect a floor: long. Calls faster: short",
      read: (t) => view?.writers(t, 15)?.share ?? null,
      threshold: 0.03,
      format: (_, t) => {
        const w = view!.writers(t, 15)!;
        return `puts ${lots(w.puts / lotSize)}, calls ${lots(w.calls / lotSize)} lots`;
      },
    },
  ];
  // No signal reads the closing auction (see AUCTION_MINUTE).
  const readAt = (d: (typeof definitions)[number], t: number) => (t >= AUCTION_MINUTE ? null : d.read(t));

  const voteOf = (v: number | null, threshold: number): -1 | 0 | 1 => (v === null || Math.abs(v) < threshold ? 0 : v > 0 ? 1 : -1);
  const voteCache = new Map<number, (-1 | 0 | 1)[]>();
  const singleVote = (t: number) => {
    let votes = voteCache.get(t);
    if (!votes) {
      votes = definitions.map((d) => voteOf(readAt(d, t), d.threshold));
      voteCache.set(t, votes);
    }
    return votes;
  };
  const priceIndex = definitions.flatMap((d, i) => (d.group === "price" ? [i] : []));
  const derivativesIndex = definitions.flatMap((d, i) => (d.group === "derivatives" ? [i] : []));
  const agreeVote = (t: number): -1 | 0 | 1 => {
    const votes = singleVote(t);
    const sum = priceIndex.reduce<number>((a, i) => a + votes[i], 0);
    return sum >= 2 ? 1 : sum <= -2 ? -1 : 0;
  };
  /** The price signals that fired all point one way, and the futures and options back them: at least one agrees and none disagrees. */
  const confirmedVote = (t: number): -1 | 0 | 1 => {
    const votes = singleVote(t);
    const price = priceIndex.map((i) => votes[i]).filter((v) => v !== 0);
    if (price.length === 0 || price.some((v) => v !== price[0])) return 0;
    const side = price[0];
    const backing = derivativesIndex.map((i) => votes[i]);
    return backing.includes(side) && !backing.includes(-side as -1 | 1) ? side : 0;
  };
  const combinedVotes = (t: number): (-1 | 0 | 1)[] => [agreeVote(t), confirmedVote(t)];
  const score = (vote: (t: number) => -1 | 0 | 1) => HORIZONS.map((h) => scoreSignal(vote, h));

  // Only minutes whose outcome is complete count, and after each firing the next horizon is
  // skipped so the samples don't overlap.
  function scoreSignal(vote: (t: number) => -1 | 0 | 1, horizon: number): SignalStats {
    const events: SignalEvent[] = [];
    // An outcome needs NIFTY's close `horizon` minutes later, before the closing auction.
    for (let t = 0; t + horizon < Math.min(now, AUCTION_MINUTE); ) {
      const v = vote(t);
      if (v !== 0 && idx[t] != null && idx[t + horizon] != null) {
        events.push({ at: session.minutes[t].at, vote: v, outcome: idx[t + horizon]! - idx[t]! });
        t += horizon;
      } else t += 1;
    }
    const hit = (e: SignalEvent) => e.outcome !== 0 && Math.sign(e.outcome) === e.vote;
    const longs = events.filter((e) => e.vote > 0);
    const shorts = events.filter((e) => e.vote < 0);
    return {
      horizon,
      fired: events.length,
      hits: events.filter(hit).length,
      longs: longs.length,
      longHits: longs.filter(hit).length,
      shorts: shorts.length,
      shortHits: shorts.filter(hit).length,
      gross: events.reduce((a, e) => a + e.vote * e.outcome, 0),
      events,
    };
  }

  const signals: SignalReport[] = definitions.map((d, i) => {
    const value = readAt(d, now);
    return {
      id: d.id,
      name: d.name,
      rule: d.rule,
      kind: "single",
      group: d.group,
      threshold: d.threshold,
      value,
      display: value === null ? "—" : d.format(value, now),
      vote: voteOf(value, d.threshold),
      stats: score((t) => singleVote(t)[i]),
    };
  });
  const [agreeNow, confirmedNow] = combinedVotes(now);
  const priceSignals = signals.filter((x) => x.group === "price");
  signals.push({
    id: "agree",
    name: "Two or more agree",
    rule: "At least two of the three price signals (breadth, basket, momentum) point the same way, net: follow them",
    kind: "combined",
    group: null,
    threshold: null,
    value: priceSignals.reduce<number>((a, x) => a + x.vote, 0),
    display: agreeNow === 0 ? "no agreement" : `${agreeNow > 0 ? "long" : "short"}: ${priceSignals.filter((x) => x.vote === agreeNow).map((x) => x.name).join(", ")}`,
    vote: agreeNow,
    stats: score(agreeVote),
  });
  signals.push({
    id: "confirmed",
    name: "Confirmed by futures and options",
    rule: "A price signal fires (the ones that fire all point one way) and at least one futures or options signal agrees while none disagrees: follow them",
    kind: "combined",
    group: null,
    threshold: null,
    value: confirmedNow,
    display:
      confirmedNow === 0
        ? "not confirmed"
        : `${confirmedNow > 0 ? "long" : "short"}: ${signals.filter((x) => x.kind === "single" && x.vote === confirmedNow).map((x) => x.name).join(", ")}`,
    vote: confirmedNow,
    stats: score(confirmedVote),
  });

  const baselines: Baseline[] = HORIZONS.map((h) => {
    const moves: number[] = [];
    for (let t = 0; t + h < now; t += h) if (idx[t] != null && idx[t + h] != null) moves.push(idx[t + h]! - idx[t]!);
    const sizes = moves.map(Math.abs).sort((a, b) => a - b);
    return {
      horizon: h,
      windows: moves.length,
      upShare: moves.length ? moves.filter((m) => m > 0).length / moves.length : 0,
      medianMove: sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0,
    };
  });

  // --- Evidence and verdict -----------------------------------------------------------------------
  const evidence: Evidence[] = [];
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  if (open !== null) {
    const fromOpen = index.ltp - open;
    evidence.push({
      label: "Since the open",
      detail: `${signed(fromOpen)} pts from ${fmt(open)}`,
      vote: Math.abs(fromOpen) < 15 ? 0 : fromOpen > 0 ? 1 : -1,
    });
  }
  if (rangePosition !== null && high !== null && low !== null) {
    evidence.push({
      label: "Place in the day's range",
      detail: `${pct(rangePosition)} of ${fmt(low)}–${fmt(high)} (${fmt(high - low)} pts)${rangePosition < 0.35 ? `, ${fmt(high - index.ltp)} below the high` : ""}`,
      vote: rangePosition > 0.66 ? 1 : rangePosition < 0.33 ? -1 : 0,
    });
  }
  if (weightAboveVwap !== null) {
    evidence.push({
      label: "Weight above its own VWAP",
      detail: `${pct(weightAboveVwap)} of NIFTY's weight trades above the day's average price`,
      vote: weightAboveVwap > 0.6 ? 1 : weightAboveVwap < 0.4 ? -1 : 0,
    });
  }
  const [advancers, decliners] = upDown[now];
  evidence.push({
    label: "Breadth",
    detail: `${advancers} up, ${decliners} down`,
    vote: advancers - decliners >= 10 ? 1 : decliners - advancers >= 10 ? -1 : 0,
  });
  if (book !== null) {
    evidence.push({
      label: "Pending orders",
      detail: `weighted book imbalance ${book > 0 ? "+" : ""}${book.toFixed(2)} (${book > 0 ? "more buyers waiting" : "more sellers waiting"})`,
      vote: book > 0.15 ? 1 : book < -0.15 ? -1 : 0,
    });
  }
  if (recentPoints !== null) {
    evidence.push({
      label: `Last ${RECENT_MINUTES} minutes`,
      detail: `${signed(recentPoints)} pts`,
      vote: Math.abs(recentPoints) < 10 ? 0 : recentPoints > 0 ? 1 : -1,
    });
  }
  if (Math.abs(points) >= 10 && top.length) {
    const share = topPoints / points;
    evidence.push({
      label: "How broad the move is",
      detail: `${top.map((c) => c.symbol).join(", ")} give ${signed(topPoints)} of NIFTY's ${signed(points)} pts; the other ${contributions.length - top.length} give ${signed(explainedPoints - topPoints)}`,
      // A move carried by three stocks while the rest pull the other way is fragile.
      vote: share > 1 ? (points > 0 ? -1 : 1) : 0,
    });
  }
  const singles = signals.filter((x) => x.kind === "single");
  const total = evidence.reduce((a, e) => a + e.vote, 0) + singles.reduce((a, x) => a + x.vote, 0);
  const verdict = decide(total, points, rangePosition, evidence, singles);

  // --- Volatility -----------------------------------------------------------------------------------
  const vix = byKey.get(VIX_KEY);
  const steps: number[] = [];
  for (let t = Math.max(1, now - 29); t <= now; t += 1) if (idx[t] != null && idx[t - 1] != null) steps.push(Math.abs(idx[t]! - idx[t - 1]!));
  const minuteMove = steps.length >= 10 ? Number((steps.reduce((a, v) => a + v, 0) / steps.length).toFixed(2)) : null;

  // --- Series for the chart -----------------------------------------------------------------------
  const series = session.minutes.map((m, t) => {
    const basket = stocks.every((x) => x.s.closes[t] == null) ? null : ref * (1 + stocks.reduce((a, x, i) => a + weights[i] * ret(x.s, t), 0));
    const votes = singleVote(t);
    const values = definitions.map((d) => readAt(d, t));
    const readings = definitions.map((d, i) => {
      const v = values[i];
      return v === null ? "—" : d.format(v, t);
    });
    return {
      at: m.at,
      bar: m.bar,
      nifty: idx[t],
      basket: basket === null ? null : Math.round(basket * 100) / 100,
      advancers: upDown[t][0],
      decliners: upDown[t][1],
      votes,
      readings,
      values: values.map((v) => (v === null ? null : Number(v.toPrecision(4)))),
      combined: combinedVotes(t),
      composite: votes.reduce<number>((a, v) => a + v, 0),
    };
  });

  return {
    asOf: session.file.lastFrameAt ?? session.builtAt,
    minute: now,
    nifty: {
      ltp: index.ltp,
      reference: ref,
      open,
      high,
      low,
      highAt,
      lowAt,
      points,
      change: points / ref,
      rangePosition,
      recentPoints,
    },
    weights: { source, minutesUsed: all.length, trackingPoints, priorTrackingPoints },
    contributions,
    explainedPoints,
    sectors,
    concentration: { top, topPoints, restPoints: explainedPoints - topPoints },
    breadth: {
      advancers,
      decliners,
      weightAboveVwap,
      countAboveVwap: vwapKnown.filter((c) => c.aboveVwap).length,
      book,
    },
    evidence,
    score: total,
    verdict,
    derivatives: view && session.session ? derivativesSnapshot(view, now, { spot: (t) => idx[t] ?? null, at: session.file.lastFrameAt ?? session.builtAt, date: session.date, session: session.session }) : null,
    volatility: { vix: vix?.ltp ?? null, vixChangePct: vix?.ltp != null && vix.reference ? Number(((vix.ltp / vix.reference - 1) * 100).toFixed(2)) : null, minuteMove },
    signals,
    baselines,
    series,
    horizon: HORIZON,
  };
}

function decide(score: number, points: number, rangePosition: number | null, evidence: Evidence[], signals: SignalReport[]): Pulse["verdict"] {
  const bulls = evidence.filter((e) => e.vote > 0).length + signals.filter((s) => s.vote > 0).length;
  const bears = evidence.filter((e) => e.vote < 0).length + signals.filter((s) => s.vote < 0).length;
  const day = points >= 0 ? "up" : "down";
  if (score >= 3) {
    return {
      stance: "bullish",
      headline: points < 0 ? "Recovering: buyers have taken over a red day" : "Buyers in control",
      action: "Shadow: favour longs on dips towards VWAP; stand aside if breadth turns.",
    };
  }
  if (score <= -3) {
    return {
      stance: "bearish",
      headline:
        points > 0 && (rangePosition ?? 1) < 0.4
          ? "Fading rally: NIFTY is green but sellers control the session"
          : points > 0
            ? "Sellers in control under a green headline"
            : "Sellers in control",
      action: "Shadow: favour shorts on bounces; no fresh longs while most weight trades below VWAP.",
    };
  }
  return {
    stance: "mixed",
    headline: `No edge: NIFTY is ${day} but the evidence is split (${bulls} for, ${bears} against)`,
    action: "Shadow: stand aside. Wait for breadth and price to agree.",
  };
}

/**
 * Ridge regression pulled towards a prior: minimises |Xw − y|² + λ|w − prior|². Solved by Gaussian
 * elimination on the normal equations; 50 stocks make a 50×50 system.
 */
export function ridge(X: number[][], y: number[], prior: number[], lambda: number): number[] {
  const k = prior.length;
  const A = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (let r = 0; r < X.length; r += 1) {
    const x = X[r];
    for (let i = 0; i < k; i += 1) {
      if (x[i] === 0) continue;
      A[i][k] += x[i] * y[r];
      for (let j = 0; j < k; j += 1) A[i][j] += x[i] * x[j];
    }
  }
  for (let i = 0; i < k; i += 1) {
    A[i][i] += lambda;
    A[i][k] += lambda * prior[i];
  }
  for (let c = 0; c < k; c += 1) {
    let p = c;
    for (let r = c + 1; r < k; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const pivot = A[c][c];
    if (pivot === 0) continue;
    for (let r = 0; r < k; r += 1) {
      if (r === c || A[r][c] === 0) continue;
      const f = A[r][c] / pivot;
      for (let j = c; j <= k; j += 1) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row, i) => (row[i] === 0 ? prior[i] : row[k] / row[i]));
}

/** Lots as a short signed figure: +1.2k, −850. */
function lots(v: number) {
  const sign = v >= 0 ? "+" : "−";
  const a = Math.abs(v);
  return `${sign}${a >= 1000 ? `${(a / 1000).toFixed(1)}k` : Math.round(a)}`;
}

function signed(v: number) {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}

function fmt(v: number) {
  return v.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

/** Wilson 95% interval for a hit rate: where the true rate plausibly lies given hits out of n. */
export function wilson(hits: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = hits / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const spread = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, centre - spread), Math.min(1, centre + spread)];
}
