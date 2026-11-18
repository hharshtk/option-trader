import assert from "node:assert/strict";
import { test } from "node:test";
import { readChain } from "./chain.ts";
import { black76, SESSION_MINUTES } from "./derivatives.ts";

const MINUTES = 3 * SESSION_MINUTES; // three sessions to expiry
const YEAR = 252 * SESSION_MINUTES;

/** A chain priced by Black-76 at `vol` (a function of strike), quoted 0.10 either side of fair. */
function chain(forward: number, vol: (strike: number) => number, oi: (strike: number) => [number, number, number, number]) {
  const oc: Record<string, unknown> = {};
  for (let strike = forward - 500; strike <= forward + 500; strike += 50) {
    const deviation = vol(strike) * Math.sqrt(MINUTES / YEAR);
    const [ceOi, ceBefore, peOi, peBefore] = oi(strike);
    const side = (type: "CE" | "PE", o: number, before: number) => {
      const fair = black76(forward, strike, deviation, type);
      return { last_price: fair + 3, top_bid_price: fair - 0.1, top_ask_price: fair + 0.1, oi: o, previous_oi: before, implied_volatility: 99 };
    };
    oc[`${strike.toFixed(6)}`] = { ce: side("CE", ceOi, ceBefore), pe: side("PE", peOi, peBefore) };
  }
  return oc;
}

test("works out volatility from the middles on the parity forward, not Dhan's figure or the last trade", () => {
  const r = readChain({ lastPrice: 25_010, oc: chain(25_000, () => 0.14, () => [100, 100, 100, 100]) }, MINUTES)!;
  assert.equal(r.atm, 25_000);
  assert.ok(Math.abs(r.forward! - 25_000) < 0.01, `forward ${r.forward}`);
  assert.ok(Math.abs(r.ivPct! - 14) < 0.05, `iv ${r.ivPct}`);
  assert.ok(Math.abs(r.skewPct!) < 0.05, `flat smile, skew ${r.skewPct}`);
  const deviation = 0.14 * Math.sqrt(MINUTES / YEAR);
  assert.ok(Math.abs(r.straddle! - 2 * black76(25_000, 25_000, deviation, "CE")) < 0.01);
});

test("reads a put skew, open interest totals, changes and walls", () => {
  // Volatility rising as strikes fall: puts below cost more than calls above.
  const smile = (strike: number) => 0.14 + (25_000 - strike) * 0.00004;
  const oi = (strike: number): [number, number, number, number] => [strike === 25_400 ? 900 : 100, 50, strike === 24_700 ? 800 : 100, 100];
  const r = readChain({ lastPrice: 25_000, oc: chain(25_000, smile, oi) }, MINUTES)!;
  assert.ok(r.skewPct! > 1.5 && r.skewPct! < 2.5, `skew ${r.skewPct}`);
  assert.equal(r.callWall?.strike, 25_400);
  assert.equal(r.callWall?.oi, 900);
  assert.equal(r.putWall?.strike, 24_700);
  // 21 strikes: calls 20 × 100 + 900, puts 20 × 100 + 800.
  assert.equal(r.callOi, 2_900);
  assert.equal(r.putOi, 2_800);
  assert.equal(r.callOiChange, 2_900 - 21 * 50);
  assert.equal(r.putOiChange, 700);
});

test("falls back to the last trade without a book, and gives nothing for an empty chain", () => {
  const oc = chain(25_000, () => 0.14, () => [1, 1, 1, 1]);
  for (const row of Object.values(oc) as { ce: Record<string, number>; pe: Record<string, number> }[]) {
    for (const side of [row.ce, row.pe]) {
      side.last_price = side.top_bid_price + 0.1;
      side.top_bid_price = 0;
      side.top_ask_price = 0;
    }
  }
  const r = readChain({ lastPrice: 25_000, oc }, MINUTES)!;
  assert.ok(Math.abs(r.ivPct! - 14) < 0.05);
  assert.equal(readChain({ lastPrice: 25_000, oc: {} }, MINUTES), null);
  assert.equal(readChain({ lastPrice: 25_000, oc }, 0)?.ivPct, null, "no time left: no volatility");
});
