import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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

test("parses both of Dhan's date formats as IST", () => {
  assert.equal(parseDhanDate("2026-12-16 00:00:00.0"), Date.parse("2026-12-16T00:00:00+05:30"));
  assert.equal(parseDhanDate("16/11/2026 10:00"), Date.parse("2026-11-16T10:00:00+05:30"));
  assert.equal(parseDhanDate("2026-12-16"), Date.parse("2026-12-16T23:59:00+05:30"));
  assert.equal(parseDhanDate("soon"), null);
});
