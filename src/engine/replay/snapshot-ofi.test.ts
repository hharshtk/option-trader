import assert from "node:assert/strict";
import test from "node:test";
import type { DepthPacket } from "../../lib/live/feed/depth-packets.ts";
import { createSnapshotOfi } from "./snapshot-ofi.ts";

function side(kind: "bid" | "ask", best: number, qty: number): DepthPacket {
  return {
    kind: "depth", side: kind, key: "NSE_FNO:1",
    levels: Array.from({ length: 5 }, (_, i) => ({ price: kind === "bid" ? best - i : best + i, qty, orders: 1 })),
  };
}

const base = [side("bid", 100, 200), side("ask", 101, 120)];

test("OFI normalizes price-aware queue changes over the trailing window", () => {
  const book = createSnapshotOfi();
  for (let at = 1_000; at <= 60_000; at += 1_000) book.observe(at, base);
  assert.deepEqual(book.score(60_000), { value: 0, reason: "flat" });

  // The bid adds 40 and the ask removes the old 120 at each rank.
  book.observe(60_500, [side("bid", 100, 240), side("ask", 102, 180)]);
  const expected = 160 / ((59 * 320 + 420) / 60) * (1 + 1 / 2 + 1 / 3 + 1 / 4 + 1 / 5);
  const reading = book.score(61_000);
  assert.equal(reading.reason, "ok");
  assert.ok(Math.abs(reading.value! - expected) < 1e-12);
});

test("a stale side and a restart clear the window even with a fresh opposite side", () => {
  const book = createSnapshotOfi();
  for (let at = 1_000; at <= 60_000; at += 1_000) book.observe(at, base);
  book.observe(61_500, [side("bid", 100, 240)]);
  assert.deepEqual(book.score(62_001), { value: null, reason: "stale" });

  book.observe(63_000, base);
  assert.deepEqual(book.score(63_500), { value: null, reason: "warmup" });
  for (let at = 64_000; at <= 108_000; at += 1_000) book.observe(at, base);
  assert.equal(book.score(108_000).reason, "flat");
  book.reset();
  assert.deepEqual(book.score(108_001), { value: null, reason: "missing" });
});

test("an asynchronous crossed book breaks the consecutive pair", () => {
  const book = createSnapshotOfi();
  for (let at = 1_000; at <= 59_000; at += 1_000) book.observe(at, base);
  book.observe(59_100, [side("ask", 100, 120)]);
  assert.deepEqual(book.score(59_100), { value: null, reason: "invalid" });
  book.observe(59_200, [side("bid", 99, 200), side("ask", 100, 120)]);
  assert.deepEqual(book.score(60_000), { value: 0, reason: "flat" });
});
