import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getParquetStore } from "../../lib/db/parquet-store.ts";
import { DEFAULT_TRADING_CONFIG, mergeTradingConfig, type TradingConfig } from "../../lib/engine/trading.ts";
import type { StudyRow } from "../../lib/research/types.ts";
import { CATALOG, type CatalogEntry } from "../../lib/strategies/catalog.ts";
import { createStrategyStore } from "../../lib/strategies/store.ts";
import type { StrategiesStatus } from "../../lib/strategies/types.ts";
import { createStrategyService } from "./service.ts";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

/** A trader that only keeps its settings, and a research runner that only records what it was asked. */
function harness(root = mkdtempSync(path.join(tmpdir(), "strategy-service-")), catalog: readonly CatalogEntry[] = []) {
  let config: TradingConfig = structuredClone(DEFAULT_TRADING_CONFIG);
  const studies: unknown[] = [];
  const rows = new Map<string, StudyRow>();
  const published: StrategiesStatus[] = [];
  let clock = 1_000;
  const build = () =>
    createStrategyService({
      namespace: "test",
      store: createStrategyStore(getParquetStore(root), "test"),
      log: quiet,
      now: () => (clock += 1),
      trader: {
        config: () => config,
        async useStrategy(strategyRef, strategy, decision) {
          const merged = mergeTradingConfig(config, { strategyRef, strategy, decision });
          if (!merged.ok) return merged;
          config = merged.config;
          return { ok: true, message: "used" };
        },
        async command(body) {
          const action = (body as { action: string }).action;
          if (action === "arm" || action === "disarm") config = { ...config, armed: action === "arm" };
          return { ok: true, message: action };
        },
      },
      research: {
        async command(body) {
          studies.push(body);
          return { ok: true, message: "queued", job: `job-${studies.length}` };
        },
        studyRow: async (id) => rows.get(id) ?? null,
      },
      publish: (status) => void published.push(status),
      catalog,
    });
  return { build, config: () => config, studies, rows, published, root };
}

test("on an empty store, what the engine trades becomes the first strategy, paper trading", async () => {
  const h = harness();
  const service = h.build();
  await service.start();
  const status = service.status();
  assert.equal(status.error, null);
  assert.equal(status.strategies.length, 1);
  const [first] = status.strategies;
  assert.equal(first.latest.name, "Two or more agree");
  assert.equal(first.status, "paper");
  assert.deepEqual(status.paper, { id: first.id, version: 1 });
  assert.deepEqual(first.latest.trade, DEFAULT_TRADING_CONFIG.strategy);
  assert.deepEqual(h.config().strategyRef, { id: first.id, version: 1, name: "Two or more agree" });

  // A restart reads the store back and doesn't carry over again.
  const again = h.build();
  await again.start();
  assert.equal(again.status().strategies.length, 1);
});

test("create, save versions, paper trade one, test one, and record the result", async () => {
  const h = harness();
  const service = h.build();
  await service.start();
  const original = service.status().strategies[0].id;

  const created = await service.command({ action: "create", definition: { name: "Momentum, held 30 min", idea: "Moves that start tend to carry on.", trade: { signal: "momentum", holdMinutes: 30 } } });
  assert.ok(created.ok, created.message);
  const id = created.id!;
  assert.equal(service.detail(id)!.summary.status, "idea");

  const unchanged = await service.command({ action: "save", id, definition: {} });
  assert.equal(unchanged.message, "Nothing changed.");
  const saved = await service.command({ action: "save", id, definition: { trade: { params: { momentum: { minutes: 20, pct: 0.2 } } } }, note: "A longer window" });
  assert.ok(saved.ok && saved.version === 2, saved.message);
  assert.equal(service.detail(id)!.versions[0].note, "A longer window");
  assert.equal(service.detail(id)!.versions[1].trade.params.momentum.minutes, 15, "version 1 is kept as it was");

  assert.equal((await service.command({ action: "save", id, definition: { trade: { holdMinutes: 0 } } })).ok, false);

  // Testing a version asks research for a study of exactly that version.
  const tested = await service.command({ action: "test", id, version: 2 });
  assert.ok(tested.ok && tested.job === "job-1");
  const spec = (h.studies[0] as { spec: Record<string, unknown> }).spec;
  assert.deepEqual(spec.primary, { signal: "momentum", horizon: 30 });
  assert.deepEqual(spec.strategy, { id, version: 2, name: "Momentum, held 30 min" });
  assert.deepEqual((spec.signalParams as { momentum: unknown }).momentum, { minutes: 20, pct: 0.2 });
  assert.deepEqual(spec.window, { from: "09:25", until: "14:45" });

  // When the study finishes, the result lands on the strategy, once.
  h.rows.set("momentum-30m-abc", { id: "momentum-30m-abc", strategy_id: id, strategy_version: 2, verdict: "No edge after costs", net_option: -3.5, firings: 900, days: 250 } as StudyRow);
  service.onStudy("momentum-30m-abc");
  service.onStudy("momentum-30m-abc");
  await service.command({ action: "save", id, definition: {} }); // waits for the queue
  const summary = service.detail(id)!.summary;
  assert.equal(summary.status, "tested");
  assert.equal(summary.lastTest?.study, "momentum-30m-abc");
  assert.equal(summary.lastTest?.note, "Loses money");
  assert.equal(service.detail(id)!.events.filter((e) => e.kind === "tested").length, 1);

  // Paper trading the new strategy stops the old one and sets the trader's strategy.
  const paper = await service.command({ action: "paper", id, version: 2 });
  assert.ok(paper.ok, paper.message);
  assert.equal(service.detail(original)!.summary.status, "idea");
  assert.equal(service.detail(id)!.summary.paperVersion, 2);
  assert.equal(h.config().strategyRef?.id, id);
  assert.equal(h.config().strategy.holdMinutes, 30);
  assert.equal(h.config().strategy.params.momentum.minutes, 20);
  assert.equal(h.config().armed, true);

  // Retiring it stops paper trading; restoring brings it back as tested.
  await service.command({ action: "retire", id });
  assert.equal(service.detail(id)!.summary.status, "retired");
  assert.equal(service.status().paper, null);
  assert.equal(h.config().armed, false);
  assert.equal((await service.command({ action: "paper", id })).ok, false);
  await service.command({ action: "restore", id });
  assert.equal(service.detail(id)!.summary.status, "tested");

  // Copying a version starts a new strategy from it.
  const copy = await service.command({ action: "create", from: { id, version: 2 } });
  assert.ok(copy.ok);
  assert.equal(service.detail(copy.id!)!.summary.latest.name, "Momentum, held 30 min (copy)");
  assert.equal(service.detail(copy.id!)!.summary.latest.trade.params.momentum.minutes, 20);

  // Everything survives a restart, read back from the store.
  const restarted = h.build();
  await restarted.start();
  assert.equal(restarted.status().strategies.length, 3);
  assert.equal(restarted.detail(id)!.summary.status, "tested");
  assert.equal(restarted.detail(id)!.versions.length, 2);
});

test("the catalog's strategies are added once, tested once, and a retired one stays retired", async () => {
  const h = harness(undefined, CATALOG);
  const service = h.build();
  await service.start();
  const ids = service.status().strategies.map((s) => s.id);
  for (const { id } of CATALOG) assert.ok(ids.includes(id), id);
  assert.equal(service.status().strategies.length, CATALOG.length + 1, "plus the carried-over one");
  assert.equal(h.studies.length, CATALOG.length, "each new one is tested");
  const spec = (h.studies[0] as { spec: { primary: unknown; strategy: { id: string } } }).spec;
  assert.equal(spec.strategy.id, CATALOG[0].id);
  for (const { id } of CATALOG) assert.equal(service.detail(id)!.summary.latest.decision.mode, "shadow", "the AI check records without blocking");
  // What trades doesn't change: the carried-over strategy is still the paper one.
  assert.equal(service.status().paper?.id.startsWith("two-or-more-agree"), true);

  await service.command({ action: "retire", id: "gap-fade" });
  const again = h.build();
  await again.start();
  assert.equal(again.status().strategies.length, CATALOG.length + 1, "nothing added twice");
  assert.equal(again.detail("gap-fade")!.summary.status, "retired");
  assert.equal(h.studies.length, CATALOG.length, "nothing tested twice");
});

test("every catalog strategy passes the engine's own checks", async () => {
  const { checkDefinition, newDefinition } = await import("../../lib/strategies/types.ts");
  for (const { id, definition } of CATALOG) assert.ok(checkDefinition(definition, newDefinition()).ok, id);
});
