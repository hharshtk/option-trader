import assert from "node:assert/strict";
import { test } from "node:test";
import { addCharges, breakevenSellPrice, FUTURES_RATES, OPTION_RATES, orderCharges, paise, roundTripCharges } from "./charges.ts";

// Dhan's brokerage calculator, 16 November 2026: one NIFTY lot (65) bought at 22.85, sold at 25.00.
const QTY = 65;
const BUY = 22.85 * QTY; // ₹1,485.25
const SELL = 25.0 * QTY; // ₹1,625.00

test("a round trip matches Dhan's brokerage calculator to the paisa", () => {
  const charges = roundTripCharges(BUY, SELL);
  assert.equal(paise(BUY), 1485.25);
  assert.equal(paise(SELL), 1625);
  assert.equal(charges.brokerage, 40);
  // Dhan shows exchange charges and IPFT together.
  assert.equal(paise(charges.exchange + charges.ipft), 1.11);
  assert.equal(paise(charges.gst), 7.4);
  assert.equal(paise(charges.sebi), 0);
  // Dhan's line shows STT rounded to the rupee; its total uses the unrounded amount.
  assert.equal(Math.round(charges.stt), 2);
  assert.equal(paise(charges.total), 50.99);
  assert.equal(paise(charges.total - charges.brokerage), 10.99);
  const gross = SELL - BUY;
  assert.equal(paise(gross), 139.75);
  assert.equal(paise(gross - charges.total), 88.76);
});

test("Dhan's breakeven is the buy price plus the round trip's charges per unit", () => {
  // The calculator prices the sell-side charges at the sell price it was given.
  const charges = roundTripCharges(BUY, SELL);
  assert.equal(paise(22.85 + charges.total / QTY), 23.63);
  // Solved exactly, selling at breakeven nets zero.
  const breakeven = breakevenSellPrice(22.85, QTY);
  const atBreakeven = roundTripCharges(BUY, breakeven * QTY);
  assert.ok(Math.abs(breakeven * QTY - BUY - atBreakeven.total) < 1e-9);
  assert.ok(breakeven > 23.6 && breakeven < 23.66);
});

test("a buy pays stamp duty, a sell pays STT, both pay brokerage and GST on fees", () => {
  const buy = orderCharges("BUY", 10_000);
  const sell = orderCharges("SELL", 10_000);
  assert.equal(buy.stt, 0);
  assert.equal(sell.stamp, 0);
  assert.ok(Math.abs(buy.stamp - 0.3) < 1e-12);
  assert.ok(Math.abs(sell.stt - 15) < 1e-12);
  assert.equal(buy.brokerage, 20);
  assert.ok(Math.abs(buy.gst - (20 + 3.503 + 0.05 + 0.01) * 0.18) < 1e-12);
  const sum = addCharges(buy, sell);
  assert.ok(Math.abs(sum.total - roundTripCharges(10_000, 10_000).total) < 1e-12);
  assert.ok(Math.abs(sum.total - (sum.brokerage + sum.exchange + sum.ipft + sum.sebi + sum.stt + sum.stamp + sum.gst)) < 1e-12);
});

test("an order of no value still pays brokerage and its GST", () => {
  assert.ok(Math.abs(roundTripCharges(0, 0).total - 40 * 1.18) < 1e-12);
});

test("futures pay less exchange fee and STT per rupee than options", () => {
  const value = 25_000 * 65;
  const futures = roundTripCharges(value, value, FUTURES_RATES);
  assert.ok(Math.abs(futures.stt - value * 0.0005) < 1e-9);
  assert.ok(futures.exchange < roundTripCharges(value, value, OPTION_RATES).exchange);
});
