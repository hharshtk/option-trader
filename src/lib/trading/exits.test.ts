import assert from "node:assert/strict";
import { test } from "node:test";
import { roundTripCharges, sellPriceForNet } from "./charges.ts";
import { exitLevels, exitPercents } from "./exits.ts";

const net = (buy: number, sell: number, quantity: number) => (sell - buy) * quantity - roundTripCharges(buy * quantity, sell * quantity).total;

test("sellPriceForNet is the price at which a round trip nets the amount after charges", () => {
  for (const amount of [-300, 0, 88.76, 250, 1_000]) {
    assert.ok(Math.abs(net(22.85, sellPriceForNet(22.85, 65, amount), 65) - amount) < 1e-6);
  }
});

test("rupee exits: the fill after slippage nets at least the target and loses at most the stop", () => {
  const settings = { exitIn: "rupees" as const, stopLossPct: 20, targetPct: 30, targetNet: 250, stopNet: 200 };
  const { stopPrice, targetPrice, stopClamped } = exitLevels(settings, 100.15, 65, 0.05, 0.05);
  assert.equal(stopClamped, false);
  const targetFill = targetPrice! - 0.05;
  const stopFill = stopPrice! - 0.05;
  assert.ok(net(100.15, targetFill, 65) >= 250 && net(100.15, targetFill - 0.05, 65) < 250, "the lowest tick that nets the target");
  assert.ok(net(100.15, stopFill, 65) >= -200 && net(100.15, stopFill - 0.05, 65) < -200, "the lowest tick that loses no more than the stop");
  // Ticks: whole multiples of 0.05.
  for (const p of [stopPrice!, targetPrice!]) assert.ok(Math.abs(p * 20 - Math.round(p * 20)) < 1e-6);
});

test("a rupee stop smaller than the charges sits one tick below the entry", () => {
  const levels = exitLevels({ exitIn: "rupees", stopLossPct: 0, targetPct: 0, stopNet: 20, targetNet: 0 }, 100, 65, 0.05, 0.05);
  assert.deepEqual(levels, { stopPrice: 99.95, targetPrice: null, stopClamped: true });
});

test("percent exits are unchanged, and exitPercents reports rupee ones as a share of the premium", () => {
  assert.deepEqual(exitLevels({ stopLossPct: 20, targetPct: 30 }, 100, 65, 0.05, 0.05), { stopPrice: 80, targetPrice: 130, stopClamped: false });
  const pct = exitPercents({ exitIn: "rupees", stopLossPct: 0, targetPct: 0, stopNet: 200, targetNet: 250 }, 100, 65, 0.05, 0.05);
  assert.ok(pct.targetPct! > 3.8 && pct.targetPct! < 5, String(pct.targetPct));
  assert.ok(pct.stopPct! > 2 && pct.stopPct! < 3.5, String(pct.stopPct));
});
