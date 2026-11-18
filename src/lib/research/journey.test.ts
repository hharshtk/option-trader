import assert from "node:assert/strict";
import test from "node:test";
import { journey } from "./journey.ts";

// ₹10 a point, ₹5 a trade in costs, ₹100 for one trade's option: easy numbers to follow.
const money = { perPoint: 10, cost: 5, premium: 100 };
const day = (d: string, firings: number, points: number) => ({ day: d, firings, points });
const trade = (d: string, at: number, points: number) => ({ day: d, at, vote: 1, entry: 0, exit: 0, points, vix: null });

test("money needed is one trade's premium plus the deepest dip, and the change is measured against it", () => {
  // Day results after costs: +45, −105, −55, +195  → running 45, −60, −115, 80.
  const days = [day("2026-01-02", 1, 5), day("2026-01-05", 1, -10), day("2026-02-02", 1, -5), day("2026-02-03", 1, 20)];
  const j = journey(days, [], money);
  assert.equal(j.total, 80);
  assert.deepEqual(j.dip, { amount: 160, from: "2026-01-02", to: "2026-02-02" }, "from the high of 45 down to −115");
  assert.equal(j.needed, 260);
  assert.equal(j.ended, 340);
  assert.ok(Math.abs(j.change - 80 / 260) < 1e-9);
  assert.deepEqual(j.months, { up: 1, count: 2, best: { month: "2026-02", money: 140 }, worst: { month: "2026-01", money: -60 } });
  assert.deepEqual(j.bestDay, { day: "2026-02-03", money: 195 });
  assert.deepEqual(j.worstDay, { day: "2026-01-05", money: -105 });
});

test("a strategy that only loses needs its whole loss, and ends with one trade's premium", () => {
  const j = journey([day("2026-01-02", 2, -10), day("2026-01-03", 2, -10)], [], money);
  assert.equal(j.total, -220);
  assert.equal(j.needed, 320);
  assert.equal(j.ended, 100);
  assert.deepEqual(j.dip, { amount: 220, from: "2026-01-02", to: "2026-01-03" });
});

test("losing streaks, and what winners and losers made on average", () => {
  const trades = [trade("a", 1, 2), trade("b", 2, -1), trade("b", 3, -2), trade("c", 4, -3), trade("d", 5, 4), trade("d", 6, -1)];
  // After costs: +15, −15, −25, −35, +35, −15.
  const j = journey([], trades, money);
  assert.deepEqual(j.streak, { trades: 3, lost: 75, from: "b", to: "c" });
  assert.deepEqual(j.wins, { count: 2, average: 25, best: 35 });
  assert.deepEqual(j.losses, { count: 4, average: -22.5, worst: -35 });
});

test("nothing to show without trades", () => {
  const j = journey([], [], money);
  assert.equal(j.needed, 100);
  assert.equal(j.dip, null);
  assert.equal(j.streak, null);
  assert.equal(j.bestDay, null);
});
