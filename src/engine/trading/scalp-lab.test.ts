import assert from "node:assert/strict";
import { test } from "node:test";
import type { Packet } from "../../lib/live/feed/packets.ts";
import { roundTripCharges } from "../../lib/trading/charges.ts";
import type { ChainRow } from "./contracts.ts";
import { createMarketView } from "./market.ts";
import { createScalpLab, SCALP_HOLDS } from "./scalp-lab.ts";

const OPEN = Date.UTC(2026, 10, 18, 3, 45);
const FUT = "NSE_FNO:61471";
const CALL = "NSE_FNO:64470";
const PUT = "NSE_FNO:64471";
const chain: ChainRow[] = [
  {
    strike: 25450,
    CE: { securityId: "64470", feedKey: CALL, name: "NIFTY 23 NOV 25450 CALL", strike: 25450, type: "CE", expiry: "2026-11-23", lotSize: 65, tickSize: 0.05 },
    PE: { securityId: "64471", feedKey: PUT, name: "NIFTY 23 NOV 25450 PUT", strike: 25450, type: "PE", expiry: "2026-11-23", lotSize: 65, tickSize: 0.05 },
  },
];

function quote(key: string, ltp: number, bid: number, ask: number, volume: number, buyQty = 1000, sellQty = 1000): Packet {
  const level = { bid, bidQty: 75, bidOrders: 1, ask, askQty: 75, askOrders: 1 };
  return { kind: "quote", code: 8, key, ltp, ltq: 75, ltt: 0, atp: ltp, volume, totalBuyQty: buyQty, totalSellQty: sellQty, oi: 0, depth: [level, level, level, level, level], open: ltp, close: 0, high: ltp, low: ltp };
}
const ticker = (key: string, ltp: number): Packet => ({ kind: "ticker", code: 2, key, ltp, ltt: 0 });

function setup() {
  const market = createMarketView();
  const lab = createScalpLab();
  lab.reset({ session: { open: OPEN, close: OPEN + 375 * 60_000 }, future: () => ({ key: FUT, name: "NIFTY NOV FUT" }), chain: () => chain, spotKey: "IDX_I:13", quote: (key) => market.get(key) });
  const feed = (packet: Packet, at: number) => {
    lab.onPacket(packet, at);
    market.apply(packet, at);
    lab.advance(at);
  };
  return { lab, feed };
}

test("a burst of buying in the future fires a long, scored on the call after charges", () => {
  const { lab, feed } = setup();
  const start = OPEN + 5 * 60_000 + 500;
  let volume = 1_000;
  let price = 25_500;
  // Two quiet minutes, then the future climbs 6 points in 10 seconds with every trade at the ask.
  for (let s = 0; s < 140; s += 1) {
    const at = start + s * 1_000;
    if (s >= 120 && s < 130) {
      price += 0.6;
      volume += 750;
      feed(quote(FUT, price + 0.05, price - 0.05, price + 0.05, volume), at);
    } else feed(quote(FUT, price, price - 0.05, price + 0.05, volume), at);
    feed(ticker("IDX_I:13", 25_450), at);
    // The call is 100.00/100.10 until the burst, then 104.00/104.10.
    const call = s < 131 ? [100.05, 100, 100.1] : [104.05, 104, 104.1];
    feed(quote(CALL, call[0], call[1], call[2], 0), at + 100);
    feed(quote(PUT, 90, 89.95, 90.05, 0), at + 100);
  }
  // Keep the books fresh until the longest hold has been scored.
  for (let s = 140; s < 140 + SCALP_HOLDS.at(-1)! + 5; s += 1) {
    const at = start + s * 1_000;
    feed(quote(FUT, price, price - 0.05, price + 0.05, volume), at);
    feed(quote(CALL, 104.05, 104, 104.1, 0), at + 100);
    feed(quote(PUT, 90, 89.95, 90.05, 0), at + 100);
  }
  const status = lab.status();
  assert.equal(status.state, "running");
  const burst = status.recent.filter((f) => f.trigger === "burst");
  assert.equal(burst.length, 1, "one firing, then the cooldown");
  const [firing] = burst;
  assert.equal(firing.direction, 1);
  assert.equal(firing.contract, "NIFTY 23 NOV 25450 CALL");
  assert.equal(firing.entry, 100.15);
  const expected = (104 - 0.05 - 100.15) * 65 - roundTripCharges(100.15 * 65, 103.95 * 65).total;
  for (const result of firing.results) assert.ok(result !== null && Math.abs(result - expected) < 0.01, String(result));
  const cells = status.triggers.find((t) => t.id === "burst")!.cells;
  assert.deepEqual(cells.map((c) => [c.trades, c.wins]), SCALP_HOLDS.map(() => [1, 1]));
  // The baseline fires on its own clock, whatever the market does.
  assert.ok(status.triggers.find((t) => t.id === "baseline")!.cells[0].trades >= 1);
});

test("with no future it waits and fires nothing", () => {
  const market = createMarketView();
  const lab = createScalpLab();
  lab.reset({ session: { open: OPEN, close: OPEN + 375 * 60_000 }, future: () => null, chain: () => chain, spotKey: "IDX_I:13", quote: (key) => market.get(key) });
  for (let s = 0; s < 400; s += 1) {
    lab.onPacket(quote(FUT, 25_500 + s, 25_499, 25_501, s * 100), OPEN + 120_000 + s * 1_000);
    lab.advance(OPEN + 120_000 + s * 1_000);
  }
  const status = lab.status();
  assert.equal(status.state, "waiting");
  assert.equal(status.recent.length, 0);
});
