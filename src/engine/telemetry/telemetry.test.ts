import assert from "node:assert/strict";
import test from "node:test";
import type { LogEntry } from "../../lib/engine/protocol.ts";
import { createLogHub } from "./logger.ts";
import { createMetrics, Histogram } from "./metrics.ts";
import { Ring } from "./ring.ts";

test("ring keeps the newest items, oldest first", () => {
  const ring = new Ring<number>(3);
  for (const n of [1, 2, 3, 4, 5]) ring.push(n);
  assert.deepEqual(ring.toArray(), [3, 4, 5]);
  assert.equal(ring.size, 3);
});

test("log hub delivers to sinks, subscribers and the backlog, filtered by level", () => {
  let clock = 0;
  const sunk: LogEntry[] = [];
  const live: LogEntry[] = [];
  const hub = createLogHub({ now: () => clock, sinks: [(e) => sunk.push(e)] });
  hub.subscribe((e) => live.push(e));

  const log = hub.logger("feed");
  log.debug("hidden below info");
  log.info("connected", { connection: 1 });
  clock = 5;
  log.child("socket").warn("slow");

  assert.equal(sunk.length, 2);
  assert.equal(live.length, 2);
  assert.deepEqual(hub.recent()[0], { at: 0, level: "info", component: "feed", message: "connected", fields: { connection: 1 } });
  assert.deepEqual(hub.recent({ minLevel: "warn" }).map((e) => e.component), ["feed.socket"]);
  assert.equal(hub.recent({ component: "feed" }).length, 2, "a component filter includes its children");
  assert.equal(hub.recent({ limit: 1 })[0].message, "slow");
});

test("a noisy component is rate-limited, keeps its errors, and reports what it dropped", () => {
  let clock = 0;
  const hub = createLogHub({ now: () => clock, maxPerSecond: 2 });
  const log = hub.logger("noisy");
  for (let i = 0; i < 5; i += 1) log.info(`line ${i}`);
  log.error("still delivered");
  clock = 1_000;
  log.info("next second");

  assert.deepEqual(
    hub.recent().map((e) => e.message),
    ["line 0", "line 1", "still delivered", "dropped 3 log lines over the 2/s limit", "next second"],
  );
});

test("histogram percentiles land in the right bucket and never exceed the max", () => {
  const h = new Histogram();
  for (let i = 0; i < 98; i += 1) h.record(0.3);
  h.record(40);
  h.record(70);
  const s = h.snapshot();
  assert.equal(s.count, 100);
  assert.equal(s.p50, 0.5);
  assert.equal(s.p99, 50);
  assert.equal(s.max, 70);

  const single = new Histogram();
  single.record(3);
  assert.equal(single.snapshot().p99, 3);
});

test("metrics snapshot keeps counters and resets the histogram window", () => {
  let clock = 1_000;
  const metrics = createMetrics(() => clock);
  metrics.increment("frames");
  metrics.increment("frames", 4);
  metrics.gauge("sockets", 2);
  metrics.observe("lag", 1);
  clock = 6_000;

  const first = metrics.snapshot();
  assert.equal(first.windowMs, 5_000);
  assert.equal(first.counters.frames, 5);
  assert.equal(first.gauges.sockets, 2);
  assert.equal(first.histograms.lag.count, 1);

  const second = metrics.snapshot();
  assert.equal(second.counters.frames, 5);
  assert.equal(second.histograms.lag.count, 0);
});
