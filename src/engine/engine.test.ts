import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { clientAddress, createAuthThrottle } from "./api/auth-throttle.ts";
import { parseDhanDate } from "./dhan-watch.ts";
import { acquireLock, EngineLockedError } from "./lock.ts";
import { createHealth } from "./telemetry/health.ts";
import { createTelemetryHub } from "./telemetry/hub.ts";

test("health keeps the worst state and the original start time", () => {
  let clock = 0;
  const changes: string[] = [];
  const health = createHealth(() => clock, (next) => changes.push(`${next.component}:${next.state}`));
  health.set("feed", "ok");
  clock = 10;
  health.set("token", "degraded", "Expires in 90 min");
  clock = 20;
  health.set("token", "degraded", "Expires in 89 min");
  health.set("token", "degraded", "Expires in 89 min");

  assert.equal(health.overall(), "degraded");
  const token = health.list().find((c) => c.component === "token")!;
  assert.equal(token.since, 10, "same state keeps its start time");
  assert.equal(token.reason, "Expires in 89 min");
  assert.deepEqual(changes, ["feed:ok", "token:degraded", "token:degraded"], "unchanged updates are ignored");

  health.set("token", "ok", "ignored");
  assert.equal(health.list().find((c) => c.component === "token")!.reason, undefined);
  assert.equal(health.overall(), "ok");
});

test("telemetry hub numbers messages and keeps a backlog per topic", () => {
  const hub = createTelemetryHub(() => 5);
  const status = new Set(["status"] as const);
  const logs = new Set(["log"] as const);
  const seen: number[] = [];
  hub.subscribe(logs, (m) => seen.push(m.seq));

  hub.publish("status", { overall: "ok" } as never);
  hub.publish("status", { overall: "degraded" } as never);
  hub.publish("log", { at: 5, level: "info", component: "a", message: "x" });

  assert.equal(hub.seq, 3);
  assert.deepEqual(seen, [3]);
  // Status keeps only the latest message.
  assert.deepEqual(hub.backlog(status, 0).map((m) => m.seq), [2]);
  assert.deepEqual(hub.backlog(new Set(["status", "log"] as const), 1).map((m) => m.seq), [2, 3]);
  assert.equal(hub.backlog(logs, 3).length, 0);
});

test("lock refuses a second live engine and replaces a stale lock", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "engine-lock-"));
  const file = path.join(dir, "engine.lock");

  const release = acquireLock(file);
  assert.throws(() => acquireLock(file, process.pid + 1), EngineLockedError);
  release();
  release();

  // A pid that can't exist: the lock is stale and gets replaced.
  writeFileSync(file, "999999999\n");
  const releaseAgain = acquireLock(file);
  assert.equal(readFileSync(file, "utf8").trim(), String(process.pid));
  releaseAgain();
});

test("auth throttle blocks a client after repeated failures, until the window passes", () => {
  let clock = 0;
  const throttle = createAuthThrottle({ now: () => clock, maxFailures: 3, windowMs: 1_000 });
  assert.equal(throttle.fail("a"), false);
  assert.equal(throttle.fail("a"), false);
  assert.equal(throttle.blockedFor("a"), 0);
  assert.equal(throttle.fail("a"), true, "reports the moment it blocks");
  assert.equal(throttle.blockedFor("a"), 1_000);
  assert.equal(throttle.blockedFor("b"), 0, "other clients are unaffected");

  clock = 400;
  assert.equal(throttle.blockedFor("a"), 600);
  clock = 1_000;
  assert.equal(throttle.blockedFor("a"), 0);

  throttle.fail("c");
  throttle.succeed("c");
  throttle.fail("c");
  throttle.fail("c");
  assert.equal(throttle.blockedFor("c"), 0, "a success resets the count");
});

test("client address trusts X-Forwarded-For only from a local peer", () => {
  const request = (peer: string, forwarded?: string) =>
    ({ socket: { remoteAddress: peer }, headers: forwarded ? { "x-forwarded-for": forwarded } : {} }) as unknown as IncomingMessage;
  assert.equal(clientAddress(request("127.0.0.1", "203.0.113.9, 10.0.0.1")), "203.0.113.9");
  assert.equal(clientAddress(request("::ffff:127.0.0.1", "203.0.113.9")), "203.0.113.9");
  assert.equal(clientAddress(request("198.51.100.4", "1.2.3.4")), "198.51.100.4", "a remote peer can't spoof it");
  assert.equal(clientAddress(request("127.0.0.1")), "127.0.0.1");
});

test("parses both of Dhan's date formats as IST", () => {
  assert.equal(parseDhanDate("2026-12-16 00:00:00.0"), Date.parse("2026-12-16T00:00:00+05:30"));
  assert.equal(parseDhanDate("16/11/2026 10:00"), Date.parse("2026-11-16T10:00:00+05:30"));
  assert.equal(parseDhanDate("2026-12-16"), Date.parse("2026-12-16T23:59:00+05:30"));
  assert.equal(parseDhanDate("soon"), null);
});
