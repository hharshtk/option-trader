import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replayBars } from "./replay-candles.ts";

// Bar times are IST shown as UTC: 09:15 IST on 16 November 2026 is 09:15 "UTC" here.
const at = (hhmm: string) => Date.UTC(2026, 10, 16, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3))) / 1000;
const minute = (hhmm: string, close: number) => ({ time: at(hhmm), open: close - 1, high: close + 2, low: close - 3, close });
/** A real instant (ms) at an IST clock time on that day. */
const ist = (hhmm: string, seconds = 0) => (at(hhmm) - 5.5 * 3600 + seconds) * 1000;

describe("replayBars", () => {
  const day = [
    minute("09:15", 100),
    minute("09:16", 101),
    minute("09:19", 104),
    minute("09:20", 105),
    minute("09:21", 106),
    { ...minute("09:15", 1), time: at("09:15") - 86_400 }, // the day before
  ];

  it("keeps only minutes that had closed by the replay's position, in 5-minute candles", () => {
    assert.deepEqual(replayBars(day, "2026-11-16", ist("09:21", 30), 5), [
      { time: at("09:15"), open: 99, high: 106, low: 97, close: 104 },
      { time: at("09:20"), open: 104, high: 107, low: 102, close: 105 },
    ]);
  });

  it("has nothing before the first minute closes", () => {
    assert.deepEqual(replayBars(day, "2026-11-16", ist("09:15", 59), 5), []);
    assert.equal(replayBars(day, "2026-11-16", ist("09:16"), 5).length, 1);
  });
});
