// What running a strategy would have been like, in rupees for one lot: the money it needed, where
// it would have ended, its worst stretch and losing streak, what winners and losers made, and its
// best and worst months and days. Pure: a study's days and trades in, plain numbers out.
//
// "Money needed" is one trade's premium plus the deepest fall from a high along the way: the least
// an account could have started with and never run dry. Changes are measured against it.

import type { DetailDay, DetailEvent } from "./types.ts";

export interface Journey {
  /** One trade's outlay: one lot of the option. */
  premium: number;
  /** The least the account could have started with: premium plus the deepest dip. */
  needed: number;
  total: number;
  ended: number;
  /** Total as a share of the money needed. */
  change: number;
  /** The deepest fall from a high, and from which day to which. */
  dip: { amount: number; from: string; to: string } | null;
  /** The most losing trades in a row, and what they lost. */
  streak: { trades: number; lost: number; from: string; to: string } | null;
  wins: { count: number; average: number | null; best: number | null };
  losses: { count: number; average: number | null; worst: number | null };
  months: { up: number; count: number; best: { month: string; money: number } | null; worst: { month: string; money: number } | null };
  bestDay: { day: string; money: number } | null;
  worstDay: { day: string; money: number } | null;
}

export function journey(days: readonly DetailDay[], trades: readonly DetailEvent[], { perPoint, cost, premium }: { perPoint: number; cost: number; premium: number }): Journey {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : 1));
  const dayMoney = sorted.map((d) => ({ day: d.day, money: d.points * perPoint - d.firings * cost }));

  // Running total from zero; the deepest fall from any high (zero at the start counts as one).
  let running = 0;
  let peak = 0;
  let peakDay = sorted[0]?.day ?? "";
  let dip: Journey["dip"] = null;
  for (const { day, money } of dayMoney) {
    running += money;
    if (running > peak) {
      peak = running;
      peakDay = day;
    } else if (peak - running > (dip?.amount ?? 0)) dip = { amount: peak - running, from: peakDay, to: day };
  }
  const total = running;
  const needed = premium + (dip?.amount ?? 0);

  // Trades, oldest first, each after costs.
  const nets = [...trades].sort((a, b) => a.at - b.at).map((t) => ({ day: t.day, money: t.points * perPoint - cost }));
  let streak: Journey["streak"] = null;
  let run = { trades: 0, lost: 0, from: "" };
  for (const { day, money } of nets) {
    if (money < 0) {
      run = run.trades === 0 ? { trades: 1, lost: -money, from: day } : { ...run, trades: run.trades + 1, lost: run.lost - money };
      if (run.trades > (streak?.trades ?? 0)) streak = { ...run, to: day };
    } else run = { trades: 0, lost: 0, from: "" };
  }
  const winners = nets.filter((t) => t.money > 0).map((t) => t.money);
  const losers = nets.filter((t) => t.money <= 0).map((t) => t.money);
  const average = (values: number[]) => (values.length ? values.reduce((a, v) => a + v, 0) / values.length : null);

  const byMonth = new Map<string, number>();
  for (const { day, money } of dayMoney) byMonth.set(day.slice(0, 7), (byMonth.get(day.slice(0, 7)) ?? 0) + money);
  const months = [...byMonth].map(([month, money]) => ({ month, money }));
  const extreme = <T extends { money: number }>(list: T[], better: (a: number, b: number) => boolean) => list.reduce<T | null>((best, item) => (best === null || better(item.money, best.money) ? item : best), null);

  return {
    premium,
    needed,
    total,
    ended: needed + total,
    change: needed > 0 ? total / needed : 0,
    dip,
    streak,
    wins: { count: winners.length, average: average(winners), best: winners.length ? Math.max(...winners) : null },
    losses: { count: losers.length, average: average(losers), worst: losers.length ? Math.min(...losers) : null },
    months: { up: months.filter((m) => m.money > 0).length, count: months.length, best: extreme(months, (a, b) => a > b), worst: extreme(months, (a, b) => a < b) },
    bestDay: extreme(dayMoney, (a, b) => a > b),
    worstDay: extreme(dayMoney, (a, b) => a < b),
  };
}
