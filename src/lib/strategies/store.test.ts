import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getParquetStore } from "../db/parquet-store.ts";
import { DEFAULT_SIGNAL_PARAMS } from "./signals.ts";
import { assemble, createStrategyStore } from "./store.ts";
import { checkDefinition, newDefinition, statusOf, strategyId, type StrategyEvent } from "./types.ts";

const event = (strategy: string, at: number, kind: StrategyEvent["kind"], version = 1): StrategyEvent => ({ strategy, at, kind, version, note: "", study: null, verdict: null, net: null, trades: null, days: null });

test("a definition is checked by the engine's own rules and filled from its base", () => {
  const base = newDefinition();
  const ok = checkDefinition({ name: "  Momentum, held longer ", trade: { holdMinutes: 30, params: { momentum: { minutes: 20 } } } }, base);
  assert.ok(ok.ok);
  assert.equal(ok.definition.name, "Momentum, held longer");
  assert.equal(ok.definition.trade.holdMinutes, 30);
  assert.equal(ok.definition.trade.params.momentum.minutes, 20);
  assert.equal(ok.definition.trade.params.momentum.pct, DEFAULT_SIGNAL_PARAMS.momentum.pct, "untouched numbers keep their value");
  assert.equal(ok.definition.decision.mode, base.decision.mode);
  assert.equal(checkDefinition({ name: "x" }, base).ok, false);
  assert.equal(checkDefinition({ trade: { holdMinutes: 0 } }, base).ok, false);
  assert.equal(checkDefinition({ trade: { params: { breadth: { stocks: 500 } } } }, base).ok, false);
  assert.equal(checkDefinition({ decision: { provider: "nobody" } }, base).ok, false);
});

test("ids are readable and safe", () => {
  assert.match(strategyId("Two or more agree!"), /^two-or-more-agree-[a-z2-9]{4}$/);
  assert.match(strategyId("???"), /^strategy-[a-z2-9]{4}$/);
});

test("status follows the history: idea, tested, paper trading, retired", () => {
  assert.deepEqual(statusOf([]), { status: "idea", paperVersion: null });
  assert.deepEqual(statusOf([event("a", 1, "created"), event("a", 2, "tested")]), { status: "tested", paperVersion: null });
  assert.deepEqual(statusOf([event("a", 1, "tested"), event("a", 2, "paper-on", 3)]), { status: "paper", paperVersion: 3 });
  assert.deepEqual(statusOf([event("a", 1, "paper-on", 3), event("a", 2, "paper-off", 3)]), { status: "idea", paperVersion: null });
  assert.deepEqual(statusOf([event("a", 1, "paper-on"), event("a", 2, "retired")]), { status: "retired", paperVersion: null });
  assert.deepEqual(statusOf([event("a", 1, "retired"), event("a", 2, "restored")]), { status: "idea", paperVersion: null });
});

test("versions and events are written once each and read back as strategies", async () => {
  const store = createStrategyStore(getParquetStore(mkdtempSync(path.join(tmpdir(), "strategies-"))), "test");
  assert.deepEqual(await store.readAll(), { versions: [], events: [] });
  const definition = newDefinition();
  await store.writeVersion({ ...definition, name: "First", id: "first-aaaa", version: 1, savedAt: 10, note: "" });
  await store.writeVersion({ ...definition, name: "First, tweaked", id: "first-aaaa", version: 2, savedAt: 20, note: "Hold 30 min" });
  await store.writeVersion({ ...definition, name: "Second", id: "second-bbbb", version: 1, savedAt: 15, note: "" });
  await store.writeEvent(event("first-aaaa", 10, "created"));
  // Two events in the same millisecond keep their order.
  await store.writeEvent(event("first-aaaa", 30, "tested", 2));
  await store.writeEvent(event("first-aaaa", 30, "paper-on", 2));

  const { versions, events } = await store.readAll();
  assert.equal(versions.length, 3);
  assert.equal(events.length, 3);
  const [first, second] = assemble(versions, events);
  assert.equal(first.summary.id, "first-aaaa");
  assert.equal(first.summary.latest.version, 2);
  assert.equal(first.summary.latest.name, "First, tweaked");
  assert.equal(first.summary.latest.note, "Hold 30 min");
  assert.equal(first.summary.status, "paper");
  assert.equal(first.summary.paperVersion, 2);
  assert.equal(first.summary.lastTest?.version, 2);
  assert.deepEqual(first.versions.map((v) => v.version), [2, 1]);
  assert.equal(second.summary.status, "idea");
  assert.deepEqual(second.summary.latest.trade, definition.trade, "settings come back exactly as saved");
});
