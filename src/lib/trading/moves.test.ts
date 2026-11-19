import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProfile, expectedMove, typicalMove, usualMinuteMove } from "./moves.ts";

/** A day where NIFTY zigzags `size` points a minute (up, down, up…) and drifts `drift` points a minute. */
function day(size: number, drift = 0) {
  return Array.from({ length: 375 }, (_, t) => 25_000 + drift * t + (t % 2 === 0 ? 0 : size));
}

test("needs at least 5 full days, keeps the last 20", () => {
  const few = new Map([["2026-11-16", day(5)], ["2026-11-17", day(5)]]);
  assert.equal(buildProfile(few), null);
  const many = new Map(Array.from({ length: 25 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, "0")}`, day(5)] as const));
  many.set("2026-10-26", day(5).slice(0, 100)); // a half day: left out
  const profile = buildProfile(many)!;
  assert.equal(profile.dates.length, 20);
  assert.equal(profile.dates.at(-1), "2026-10-25");
});

test("measures the hold itself, so back-and-forth minutes don't add up", () => {
  const days = new Map(Array.from({ length: 5 }, (_, i) => [`2026-11-1${i}`, day(10, 1)] as const));
  const profile = buildProfile(days)!;
  // Each minute swings 10 points, but over 10 minutes NIFTY drifts only 10.
  // Minutes alternate +11 and −9 (the swing plus the drift): 10 on average.
  assert.equal(usualMinuteMove(profile, 100), 10);
  assert.equal(typicalMove(profile, 100, 10), 10);
  // The old formula would say 10 × √10 ≈ 32.
});

test("scales the history by how busy today is, counted half and kept within limits", () => {
  const profile = buildProfile(new Map(Array.from({ length: 5 }, (_, i) => [`2026-11-1${i}`, day(4, 2)] as const)))!;
  const usual = usualMinuteMove(profile, 100)!;
  const same = expectedMove(profile, 100, 30, usual)!;
  assert.deepEqual([same.history, same.scale, same.move], [60, 1, 60]);
  // Four times as busy as usual: ×2 by the square root, capped at 1.5.
  assert.equal(expectedMove(profile, 100, 30, usual * 4)!.scale, 1.5);
  assert.equal(expectedMove(profile, 100, 30, usual * 1.21)!.scale, 1.1);
  assert.equal(expectedMove(profile, 100, 30, usual / 100)!.scale, 0.67);
  // Unknown today: the history as it is.
  assert.equal(expectedMove(profile, 100, 30, null)!.scale, 1);
  // A hold running into the 15:15 auction is measured up to it.
  assert.equal(expectedMove(profile, 350, 30, usual)!.history, 18);
  assert.equal(expectedMove(null, 100, 30, usual), null);
});
