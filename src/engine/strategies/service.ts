// The strategy store in the engine: the one place strategies are created, changed, tested and put
// to paper trading. It keeps every version and event on S3 (src/lib/strategies/store.ts), tells the
// trader which version to trade, starts research tests of any version, and records each test's
// result against its version. The web reaches it through the control API (`/v1/strategies`).
//
// The first time it starts with an empty store it carries over what the engine was trading, so a
// running engine keeps trading the same thing.

import type { TradingCommandResult, TradingConfig } from "../../lib/engine/trading.ts";
import { PLAIN_VERDICT, type ResearchCommandResult, type StudyRow } from "../../lib/research/types.ts";
import type { CatalogEntry } from "../../lib/strategies/catalog.ts";
import { assemble, type StrategyStore } from "../../lib/strategies/store.ts";
import {
  checkDefinition,
  newDefinition,
  signalLabel,
  strategyId,
  type StrategiesStatus,
  type StrategyCommandResult,
  type StrategyDefinition,
  type StrategyDetail,
  type StrategyEvent,
  type StrategyVersion,
} from "../../lib/strategies/types.ts";
import type { Logger } from "../telemetry/logger.ts";

export interface StrategyServiceOptions {
  namespace: string;
  store: StrategyStore;
  log: Logger;
  now: () => number;
  trader: {
    config(): Readonly<TradingConfig>;
    useStrategy(ref: NonNullable<TradingConfig["strategyRef"]>, strategy: TradingConfig["strategy"], decision: TradingConfig["decision"]): Promise<TradingCommandResult>;
    command(body: unknown): Promise<TradingCommandResult>;
  };
  research: {
    command(body: unknown): Promise<ResearchCommandResult>;
    studyRow(id: string): Promise<StudyRow | null>;
  };
  publish: (status: StrategiesStatus) => void;
  /** Strategies to add when missing (src/lib/strategies/catalog.ts), each tested once when added. */
  catalog?: readonly CatalogEntry[];
}

/** A version's settings alone, in the order checkDefinition returns them. */
const definitionOf = (v: StrategyDefinition): StrategyDefinition => ({ name: v.name, idea: v.idea, kind: v.kind, trade: v.trade, decision: v.decision });

export function createStrategyService(options: StrategyServiceOptions) {
  const { namespace, store, log, now, trader, research } = options;
  let versions: StrategyVersion[] = [];
  let events: StrategyEvent[] = [];
  let details: StrategyDetail[] = [];
  let error: string | null = null;
  // One change at a time, so two quick clicks can't make the same version number twice.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  function rebuild() {
    details = assemble(versions, events);
    options.publish(status());
  }

  function status(): StrategiesStatus {
    const paper = details.find((d) => d.summary.paperVersion !== null);
    return { namespace, strategies: details.map((d) => d.summary), paper: paper ? { id: paper.summary.id, version: paper.summary.paperVersion! } : null, error };
  }

  async function addVersion(id: string, version: number, definition: StrategyDefinition, note: string) {
    const saved: StrategyVersion = { ...definition, id, version, savedAt: now(), note };
    await store.writeVersion(saved);
    versions.push(saved);
    return saved;
  }

  async function addEvent(event: Omit<StrategyEvent, "at" | "study" | "verdict" | "net" | "trades" | "days"> & Partial<StrategyEvent>) {
    const written = await store.writeEvent({ study: null, verdict: null, net: null, trades: null, days: null, at: now(), ...event });
    events.push(written);
    return written;
  }

  const find = (id: unknown) => details.find((d) => d.summary.id === id) ?? null;
  const versionOf = (detail: StrategyDetail, version: unknown) => (version === undefined ? detail.versions[0] : detail.versions.find((v) => v.version === version) ?? null);

  /** Makes the trader follow a version (and arms it), or leaves it be. */
  async function trade(version: StrategyVersion) {
    const used = await trader.useStrategy({ id: version.id, version: version.version, name: version.name }, version.trade, version.decision);
    if (!used.ok) return used;
    return trader.command({ action: "arm" });
  }

  /** The trader must trade the version the store says paper trading follows. */
  async function syncTrader() {
    const paper = details.find((d) => d.summary.paperVersion !== null);
    if (!paper) return;
    const version = paper.versions.find((v) => v.version === paper.summary.paperVersion)!;
    const ref = trader.config().strategyRef;
    if (ref?.id === version.id && ref.version === version.version) return;
    const used = await trader.useStrategy({ id: version.id, version: version.version, name: version.name }, version.trade, version.decision);
    log[used.ok ? "info" : "warn"](`paper trading follows ${version.name} v${version.version}: ${used.message}`);
  }

  /** The settings the engine traded before the store existed become its first strategy. */
  async function carryOver() {
    const config = trader.config();
    const name = signalLabel(config.strategy.signal);
    const definition: StrategyDefinition = {
      name,
      idea: `Follows the ${name} signal from the Pulse page: buys a call when it says up and a put when it says down.`,
      kind: "signal-options",
      trade: structuredClone(config.strategy),
      decision: structuredClone(config.decision),
    };
    const id = strategyId(name);
    await addVersion(id, 1, definition, "Carried over from the engine's settings");
    await addEvent({ strategy: id, kind: "created", version: 1, note: "Carried over from the engine's settings" });
    await addEvent({ strategy: id, kind: "paper-on", version: 1, note: "What the engine was paper trading" });
    log.info(`strategy store started with ${name}, carried over from the engine's settings`);
  }

  /** Adds the catalog's strategies that were never added (a retired one is still there, so stays retired). */
  async function seedCatalog(): Promise<string[]> {
    const added: string[] = [];
    for (const { id, definition } of options.catalog ?? []) {
      if (versions.some((v) => v.id === id)) continue;
      const checked = checkDefinition(definition, newDefinition());
      if (!checked.ok) {
        log.warn(`catalog strategy ${id} isn't valid: ${checked.message}`);
        continue;
      }
      await addVersion(id, 1, checked.definition, "Preloaded from the strategy catalog");
      await addEvent({ strategy: id, kind: "created", version: 1, note: "Preloaded from the strategy catalog" });
      added.push(id);
    }
    if (added.length) log.info(`added ${added.length} strategies from the catalog: ${added.join(", ")}`);
    return added;
  }

  async function command(body: unknown): Promise<StrategyCommandResult> {
    const input = (body ?? {}) as Record<string, unknown>;
    switch (input.action) {
      case "create": {
        const from = input.from as { id?: unknown; version?: unknown } | undefined;
        const source = from ? find(from.id) : null;
        if (from && !source) return { ok: false, message: "No such strategy to copy." };
        const base = source ? versionOf(source, from!.version) : null;
        if (from && !base) return { ok: false, message: "No such version to copy." };
        const start: StrategyDefinition = base ? { name: `${base.name} (copy)`, idea: base.idea, kind: base.kind, trade: base.trade, decision: base.decision } : newDefinition();
        const checked = checkDefinition(input.definition, start);
        if (!checked.ok) return checked;
        const id = strategyId(checked.definition.name);
        const note = base ? `Copied from ${base.name}, version ${base.version}` : "Created";
        await addVersion(id, 1, checked.definition, note);
        await addEvent({ strategy: id, kind: "created", version: 1, note });
        rebuild();
        return { ok: true, message: `Created ${checked.definition.name}.`, id, version: 1 };
      }
      case "save": {
        const detail = find(input.id);
        if (!detail) return { ok: false, message: "No such strategy." };
        const latest = detail.versions[0];
        const checked = checkDefinition(input.definition, latest);
        if (!checked.ok) return checked;
        if (JSON.stringify(checked.definition) === JSON.stringify(definitionOf(latest))) return { ok: true, message: "Nothing changed.", id: latest.id, version: latest.version };
        const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : "";
        const saved = await addVersion(latest.id, latest.version + 1, checked.definition, note);
        await addEvent({ strategy: latest.id, kind: "saved", version: saved.version, note });
        rebuild();
        const paper = detail.summary.paperVersion !== null ? ` Paper trading still follows version ${detail.summary.paperVersion}; switch it when you're ready.` : "";
        return { ok: true, message: `Saved as version ${saved.version}.${paper}`, id: saved.id, version: saved.version };
      }
      case "paper": {
        const detail = find(input.id);
        if (!detail) return { ok: false, message: "No such strategy." };
        if (detail.summary.status === "retired") return { ok: false, message: "Restore this strategy before paper trading it." };
        const version = versionOf(detail, input.version);
        if (!version) return { ok: false, message: "No such version." };
        // One strategy at a time: whatever paper trading followed stops.
        for (const other of details) {
          if (other.summary.paperVersion !== null && (other.summary.id !== version.id || other.summary.paperVersion !== version.version)) {
            await addEvent({ strategy: other.summary.id, kind: "paper-off", version: other.summary.paperVersion, note: `Replaced by ${version.name}, version ${version.version}` });
          }
        }
        if (detail.summary.paperVersion !== version.version) await addEvent({ strategy: version.id, kind: "paper-on", version: version.version, note: "" });
        rebuild();
        const traded = await trade(version);
        return { ok: traded.ok, message: traded.ok ? `Paper trading ${version.name}, version ${version.version}. It takes trades from the next signal.` : traded.message, id: version.id, version: version.version };
      }
      case "stop-paper": {
        const detail = find(input.id);
        if (!detail || detail.summary.paperVersion === null) return { ok: false, message: "That strategy isn't being paper traded." };
        await addEvent({ strategy: detail.summary.id, kind: "paper-off", version: detail.summary.paperVersion, note: "" });
        rebuild();
        await trader.command({ action: "disarm" });
        return { ok: true, message: "Paper trading stopped: no new trades. An open position keeps its exits." };
      }
      case "test": {
        const detail = find(input.id);
        if (!detail) return { ok: false, message: "No such strategy." };
        const version = versionOf(detail, input.version);
        if (!version) return { ok: false, message: "No such version." };
        const { risk } = trader.config();
        const spec = {
          primary: { signal: version.trade.signal, horizon: version.trade.holdMinutes },
          strategy: { id: version.id, version: version.version, name: version.name },
          signalParams: version.trade.params,
          // The engine's own entry window, so the test trades when paper trading would.
          window: { from: risk.entryFrom, until: risk.entryUntil },
          ...(typeof input.from === "string" && { from: input.from }),
          ...(typeof input.to === "string" && { to: input.to }),
        };
        const queued = await research.command({ action: "study", spec });
        return { ...queued, message: queued.ok ? `Testing ${version.name}, version ${version.version}: about 30 seconds.` : queued.message, id: version.id, version: version.version };
      }
      case "retire":
      case "restore": {
        const detail = find(input.id);
        if (!detail) return { ok: false, message: "No such strategy." };
        const retire = input.action === "retire";
        if (retire === (detail.summary.status === "retired")) return { ok: true, message: retire ? "Already retired." : "Not retired." };
        const wasPaper = detail.summary.paperVersion !== null;
        await addEvent({ strategy: detail.summary.id, kind: retire ? "retired" : "restored", version: detail.versions[0].version, note: "" });
        rebuild();
        if (retire && wasPaper) await trader.command({ action: "disarm" });
        return { ok: true, message: retire ? `Retired${wasPaper ? "; paper trading stopped" : ""}. Its history is kept.` : "Restored." };
      }
      default:
        return { ok: false, message: "Unknown strategy command." };
    }
  }

  /** A finished study of a stored version becomes a "tested" event on that strategy. */
  async function recordStudy(studyId: string) {
    const row = await research.studyRow(studyId);
    if (!row?.strategy_id || row.strategy_version === null) return;
    if (events.some((e) => e.kind === "tested" && e.study === studyId)) return;
    if (!versions.some((v) => v.id === row.strategy_id)) return;
    await addEvent({
      strategy: row.strategy_id,
      kind: "tested",
      version: row.strategy_version,
      note: PLAIN_VERDICT[row.verdict].label,
      study: row.id,
      verdict: row.verdict,
      net: row.net_option,
      trades: row.firings,
      days: row.days,
    });
    rebuild();
  }

  return {
    async start() {
      await serial(async () => {
        try {
          const all = await store.readAll();
          versions = all.versions;
          events = all.events;
          if (versions.length === 0) await carryOver();
          const added = await seedCatalog();
          error = null;
          rebuild();
          await syncTrader();
          // Each new catalog strategy is tested once, one after another in research's queue.
          for (const id of added) await command({ action: "test", id, version: 1 });
        } catch (failure) {
          error = `Could not read the strategy store: ${failure instanceof Error ? failure.message.split("\n")[0] : String(failure)}`;
          log.warn(error);
          rebuild();
        }
      });
    },
    status,
    detail: (id: string): StrategyDetail | null => find(id),
    command: (body: unknown) => serial(() => command(body)),
    onStudy: (studyId: string) => {
      void serial(() => recordStudy(studyId)).catch((failure: unknown) => log.warn("could not record a strategy test", { error: String(failure) }));
    },
  };
}

export type StrategyService = ReturnType<typeof createStrategyService>;
