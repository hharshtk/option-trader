import assert from "node:assert/strict";
import { test } from "node:test";
import { costCheck } from "./cost.ts";

const base = { bid: 170, ask: 170.3, quantity: 65, strike: 25_250, type: "CE" as const, forward: 25_250, minutesToExpiry: 1_300, holdMinutes: 10 };

test("passes when NIFTY's typical move over the hold is three times what the trade needs", () => {
  // About 1.4 a unit in charges, 0.3 spread, 0.1 slippage and a little decay, over a delta near 0.5: about 4 points.
  const busy = costCheck({ ...base, minuteMove: 6 });
  assert.equal(busy.pass, true);
  assert.ok(busy.breakEven! > 3.5 && busy.breakEven! < 5, `break-even ${busy.breakEven}`);
  assert.equal(busy.typical, 19);
  const quiet = costCheck({ ...base, minuteMove: 2 });
  assert.equal(quiet.pass, false);
  assert.match(quiet.reason, /less than 3 times over/);
});

test("a wider spread or more decay raises what the trade needs", () => {
  const tight = costCheck({ ...base, minuteMove: 6 }).breakEven!;
  assert.ok(costCheck({ ...base, ask: 172, minuteMove: 6 }).breakEven! > tight);
  assert.ok(costCheck({ ...base, minutesToExpiry: 60, minuteMove: 6 }).breakEven! > tight, "near expiry the option loses value faster");
  assert.ok(costCheck({ ...base, bid: null, minuteMove: 6 }).breakEven! > tight, "without a book, a rupee stands in for the spread");
});

test("refuses when it can't work the costs out", () => {
  for (const missing of [{ forward: null }, { minutesToExpiry: null }, { minuteMove: null }, { minutesToExpiry: 0 }]) {
    const c = costCheck({ ...base, minuteMove: 6, ...missing });
    assert.equal(c.pass, false);
    assert.match(c.reason, /not enough known/);
  }
  assert.match(costCheck({ ...base, strike: 27_000, ask: 0.1, bid: 0.05, minuteMove: 6 }).reason, /barely moves/);
});
