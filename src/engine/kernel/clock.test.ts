import assert from "node:assert/strict";
import test from "node:test";
import { createLiveClock, createVirtualClock } from "./clock.ts";

test("virtual clock fires due timers in time order, then insertion order", () => {
  const clock = createVirtualClock(1_000);
  const fired: string[] = [];
  clock.at(3_000, () => fired.push("c"));
  clock.at(2_000, () => fired.push("a"));
  clock.at(2_000, () => fired.push("b"));
  clock.at(9_000, () => fired.push("late"));

  clock.advanceTo(5_000);
  assert.deepEqual(fired, ["a", "b", "c"]);
  assert.equal(clock.now(), 5_000);
  assert.equal(clock.pending, 1);
});

test("virtual clock reports each timer's own time while it fires", () => {
  const clock = createVirtualClock(0);
  const seen: number[] = [];
  clock.at(10, () => seen.push(clock.now()));
  clock.at(20, () => seen.push(clock.now()));
  clock.advanceTo(100);
  assert.deepEqual(seen, [10, 20]);
});

test("a timer scheduled while firing runs in the same advance when due", () => {
  const clock = createVirtualClock(0);
  const fired: number[] = [];
  clock.at(10, () => {
    fired.push(clock.now());
    clock.at(15, () => fired.push(clock.now()));
    clock.at(500, () => fired.push(clock.now()));
  });
  clock.advanceTo(100);
  assert.deepEqual(fired, [10, 15]);
  assert.equal(clock.pending, 1);
});

test("cancelled timers don't fire, and past times fire on the next advance", () => {
  const clock = createVirtualClock(1_000);
  const fired: string[] = [];
  const cancel = clock.at(2_000, () => fired.push("cancelled"));
  clock.at(500, () => fired.push(`past at ${clock.now()}`));
  cancel();
  clock.advanceTo(3_000);
  assert.deepEqual(fired, ["past at 1000"]);
});

test("virtual clock refuses to go back", () => {
  const clock = createVirtualClock(1_000);
  assert.throws(() => clock.advanceTo(999), /can't go back/);
});

test("live clock fires asynchronously, and cancel stops it", async () => {
  const clock = createLiveClock();
  const fired: string[] = [];
  clock.at(clock.now() - 1, () => fired.push("due"));
  const cancel = clock.at(clock.now() + 20, () => fired.push("cancelled"));
  assert.deepEqual(fired, []);
  cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(fired, ["due"]);
});
