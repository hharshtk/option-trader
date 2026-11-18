// NIFTY Pulse: turns a journal session (the engine's decoded day, see session-summary.ts) into a
// read of the market: what NIFTY is doing, which stocks and sectors moved it, a shadow decision,
// and how a few candidate signals have done so far today.
//
// Pure and deterministic: the same session in gives the same pulse out, so it can run in the
// browser today and in the engine on live, replay and backtest later. Nothing here looks ahead:
// each minute's signal uses only closes up to that minute; outcomes are scored afterwards.

import type { JournalSession, SessionInstrument } from "../engine/protocol.ts";
import { AGREE, agreeOf, DEFAULT_SIGNAL_PARAMS, sessionInputs, SINGLE_SIGNALS, voteOf } from "../strategies/signals.ts";

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
  signals: SignalReport[];
  baselines: Baseline[];
  /** Per minute, for the chart. */
  series: PulsePoint[];
  horizon: number;
}

export const RECENT_MINUTES = 15;
export const HORIZON = 5;
export const HORIZONS = [1, 3, 5, 10, 15] as const;
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
  const last = session.minutes[now];
  const vwapKnown = contributions.filter((c) => c.aboveVwap !== null);
  const vwapWeight = vwapKnown.reduce((a, c) => a + c.weight, 0);
  const weightAboveVwap = vwapWeight > 0 ? vwapKnown.reduce((a, c) => a + (c.aboveVwap ? c.weight : 0), 0) / vwapWeight : null;
  const bookKnown = contributions.filter((c) => c.book !== null);
  const bookWeight = bookKnown.reduce((a, c) => a + c.weight, 0);
  const book = bookWeight > 0 ? bookKnown.reduce((a, c) => a + c.weight * c.book!, 0) / bookWeight : null;

  // --- Signals ------------------------------------------------------------------------------------
  // Defined once in the strategy store's signals (src/lib/strategies/signals.ts), read here with
  // their default numbers: the trader and research read the same definitions.
  const inputs = sessionInputs(session, constituents, benchmark)!;
  const P = DEFAULT_SIGNAL_PARAMS;
  const definitions = SINGLE_SIGNALS.map((s) => ({
    id: s.id,
    name: s.name,
    rule: s.rule(P),
    read: (t: number) => s.read(inputs, t, P),
    threshold: s.threshold(P),
    format: (v: number) => s.format(v, P),
  }));

  const singleVote = (t: number) => definitions.map((d) => voteOf(d.read(t), d.threshold));
  const agreeVote = (t: number): -1 | 0 | 1 => agreeOf(singleVote(t), P);
  const score = (vote: (t: number) => -1 | 0 | 1) => HORIZONS.map((h) => scoreSignal(vote, h));

  // Only minutes whose outcome is complete count, and after each firing the next horizon is
  // skipped so the samples don't overlap.
  function scoreSignal(vote: (t: number) => -1 | 0 | 1, horizon: number): SignalStats {
    const events: SignalEvent[] = [];
    for (let t = 0; t + horizon < now; ) {
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
    const value = d.read(now);
    return {
      id: d.id,
      name: d.name,
      rule: d.rule,
      kind: "single",
      value,
      display: value === null ? "—" : d.format(value),
      vote: voteOf(value, d.threshold),
      stats: score((t) => singleVote(t)[i]),
    };
  });
  const agreeNow = agreeVote(now);
  signals.push({
    id: AGREE.id,
    name: AGREE.name,
    rule: AGREE.rule(P),
    kind: "combined",
    value: singleVote(now).reduce<number>((a, v) => a + v, 0),
    display: agreeNow === 0 ? "no agreement" : `${agreeNow > 0 ? "long" : "short"}: ${signals.filter((x) => x.vote === agreeNow).map((x) => x.name).join(", ")}`,
    vote: agreeNow,
    stats: score(agreeVote),
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
  evidence.push({
    label: "Breadth",
    detail: `${last.advancers} up, ${last.decliners} down`,
    vote: last.advancers - last.decliners >= 10 ? 1 : last.decliners - last.advancers >= 10 ? -1 : 0,
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

  // --- Series for the chart -----------------------------------------------------------------------
  const series = session.minutes.map((m, t) => {
    const basket = stocks.every((x) => x.s.closes[t] == null) ? null : ref * (1 + stocks.reduce((a, x, i) => a + weights[i] * ret(x.s, t), 0));
    const votes = singleVote(t);
    const readings = definitions.map((d) => {
      const v = d.read(t);
      return v === null ? "—" : d.format(v);
    });
    return {
      at: m.at,
      bar: m.bar,
      nifty: idx[t],
      basket: basket === null ? null : Math.round(basket * 100) / 100,
      advancers: m.advancers,
      decliners: m.decliners,
      votes,
      readings,
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
      advancers: last.advancers,
      decliners: last.decliners,
      weightAboveVwap,
      countAboveVwap: vwapKnown.filter((c) => c.aboveVwap).length,
      book,
    },
    evidence,
    score: total,
    verdict,
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
