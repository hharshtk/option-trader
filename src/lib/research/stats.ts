// The statistics a study reports, kept small and honest. Pure and deterministic: resampling uses a
// fixed seed, so the same firings always give the same ranges.
//
// Firings on the same day move together (the market had one mood that day), so treating them as
// independent overstates confidence. Ranges here resample whole days instead.

import { wilson } from "../insight/pulse.ts";
import type { Verdict } from "./types.ts";

export { wilson };

/** Resamples for each 95% range. */
export const RESAMPLES = 2_000;
const SEED = 20_261_117;
/** Below either, a study says "Too few firings" rather than guess. */
export const MIN_FIRINGS = 30;
export const MIN_DAYS = 20;

/** A small, fast, seeded generator (mulberry32): the same seed gives the same sequence everywhere. */
export function seeded(seed = SEED) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * 95% range of the mean points a firing, resampling whole days with replacement. `days` holds each
 * day's summed points and firing count. Null when there are fewer than two days.
 */
export function dayRange(days: readonly { points: number; firings: number }[], resamples = RESAMPLES): [number, number] | null {
  if (days.length < 2) return null;
  const random = seeded();
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r += 1) {
    let points = 0;
    let firings = 0;
    for (let i = 0; i < days.length; i += 1) {
      const day = days[Math.floor(random() * days.length)];
      points += day.points;
      firings += day.firings;
    }
    means[r] = firings ? points / firings : 0;
  }
  means.sort();
  return [means[Math.floor(resamples * 0.025)], means[Math.ceil(resamples * 0.975) - 1]];
}

export interface Measured {
  firings: number;
  days: number;
  hits: number;
  hitRate: number | null;
  hitRange: [number, number] | null;
  mean: number | null;
  range: [number, number] | null;
  netOption: number | null;
  netFutures: number | null;
}

/** Points per firing, grouped by day, measured against the two costs. */
export function measure(firings: readonly { day: string; points: number }[], optionCost: number, futuresCost: number): Measured {
  const byDay = new Map<string, { points: number; firings: number }>();
  let hits = 0;
  let total = 0;
  for (const f of firings) {
    const day = byDay.get(f.day) ?? { points: 0, firings: 0 };
    day.points += f.points;
    day.firings += 1;
    byDay.set(f.day, day);
    if (f.points > 0) hits += 1;
    total += f.points;
  }
  const n = firings.length;
  const mean = n ? total / n : null;
  return {
    firings: n,
    days: byDay.size,
    hits,
    hitRate: n ? hits / n : null,
    hitRange: n ? wilson(hits, n) : null,
    mean,
    range: dayRange([...byDay.values()]),
    netOption: mean === null ? null : mean - optionCost,
    netFutures: mean === null ? null : mean - futuresCost,
  };
}

/**
 * The verdict, in the Pulse page's words. "Edge after costs" also needs the later part of the
 * period (`holdout`, the last 30% of days) to agree in sign, so an edge that died isn't called one.
 */
export function verdictOf(m: Measured, optionCost: number, holdout: Measured | null): Verdict {
  if (m.firings < MIN_FIRINGS || m.days < MIN_DAYS || m.mean === null || m.range === null) return "Too few firings";
  const [lo, hi] = m.range;
  if (hi < 0) return "Reliably wrong";
  if (lo - optionCost > 0 && (holdout?.mean ?? 0) - optionCost > 0) return "Edge after costs";
  if (m.mean - optionCost > 0) return "Ahead, could be luck";
  if (lo > 0) return "Predicts, costs eat it";
  return "No edge after costs";
}
