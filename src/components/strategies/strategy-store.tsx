"use client";

// The strategy store: every strategy in one place. Pick one to see its latest result, test it,
// paper trade it, change its settings (each save is a new version) or look back at its history.
// Strategies live in the engine (S3); this page reads them and sends commands.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { controlStrategies } from "@/app/(cockpit)/(strategies)/strategies/store-actions";
import { useEngineTelemetry } from "@/components/engine/use-engine-telemetry";
import { ago, count, dayLabel, istDate, rupees, rupeesPerPoint, signedRupees, VERDICT_TONE } from "@/components/research/research-format";
import { buttonClass, EmptyState, PageHeader } from "@/components/ui";
import { PLAIN_VERDICT } from "@/lib/research/types";
import { newDefinition, signalLabel, type StrategiesStatus, type StrategyCommand, type StrategyDefinition, type StrategyDetail, type StrategyEvent, type StrategyStatus, type StrategySummary, type StrategyVersion } from "@/lib/strategies/types";
import { StrategyEditor } from "./strategy-editor";

const BASE = "/api/engine/v1/strategies";
const TOPICS = ["status", "strategies", "research"] as const;

const STATUS: Record<StrategyStatus, { label: string; tone: string }> = {
  idea: { label: "Not tested yet", tone: "text-muted border-line-strong" },
  tested: { label: "Tested", tone: "text-fg border-line-strong" },
  paper: { label: "Paper trading", tone: "text-accent border-accent/60" },
  retired: { label: "Retired", tone: "text-muted border-line" },
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

/** "Loses money · −₹131 a trade" from a test, for one lot. */
function resultLine(test: StrategyEvent | null): string | null {
  if (!test?.verdict) return null;
  return `${PLAIN_VERDICT[test.verdict].label} · ${signedRupees(test.net === null ? null : test.net * rupeesPerPoint())} a trade`;
}

export function StrategyStore() {
  const telemetry = useEngineTelemetry(TOPICS);
  const [fetched, setFetched] = useState<{ status: StrategiesStatus | null; error: string | null }>({ status: null, error: null });
  const status = telemetry.strategies ?? fetched.status;
  const [details, setDetails] = useState<Record<string, StrategyDetail>>({});
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const params = useSearchParams();
  const chosen = params.get("id");

  useEffect(() => {
    void getJson<StrategiesStatus>(BASE).then(
      (next) => setFetched({ status: next, error: null }),
      (error: Error) => setFetched({ status: null, error: /No route/.test(error.message) ? "The engine is running code from before the strategy store. Restart it on the new code to use this page." : error.message }),
    );
  }, []);

  const list = status?.strategies ?? [];
  const visible = list.filter((s) => showRetired || s.status !== "retired");
  const retired = list.length - list.filter((s) => s.status !== "retired").length;
  const selected = list.find((s) => s.id === chosen) ?? list.find((s) => s.status === "paper") ?? list[0] ?? null;

  // The selected strategy's versions and history, read again whenever it changes.
  const detailKey = selected ? `${selected.id}#${selected.updatedAt}` : null;
  useEffect(() => {
    if (!selected || !detailKey || details[detailKey]) return;
    void getJson<StrategyDetail>(`${BASE}/one?id=${encodeURIComponent(selected.id)}`).then(
      (detail) => setDetails((held) => ({ ...held, [detailKey]: detail })),
      () => {},
    );
  }, [selected, detailKey, details]);
  const detail = detailKey ? (details[detailKey] ?? Object.entries(details).find(([key]) => key.startsWith(`${selected!.id}#`))?.[1] ?? null) : null;

  const select = useCallback((id: string) => {
    setCreating(false);
    setResult(null);
    window.history.pushState(null, "", `?id=${encodeURIComponent(id)}`);
  }, []);

  const run = useCallback(
    (command: StrategyCommand, then?: (result: Awaited<ReturnType<typeof controlStrategies>>) => void) => {
      startTransition(async () => {
        const outcome = await controlStrategies(command);
        setResult({ ok: outcome.ok, message: outcome.message });
        if (outcome.ok && outcome.job && command.action === "test") setTests((held) => ({ ...held, [command.id]: outcome.job! }));
        then?.(outcome);
      });
    },
    [],
  );

  const blocked = telemetry.link === "unconfigured" ? (telemetry.error ?? "The engine isn't configured.") : !status && fetched.error ? fetched.error : null;
  if (blocked) {
    return (
      <>
        <PageHeader title="Strategies" />
        <div className="p-3 sm:p-4">
          <EmptyState>{blocked}</EmptyState>
        </div>
      </>
    );
  }

  const testJob = selected ? telemetry.research?.jobs.find((j) => j.id === tests[selected.id] && (j.state === "queued" || j.state === "running")) ?? null : null;

  return (
    <>
      <PageHeader title="Strategies" meta="Every strategy in one place: change its settings, test it on past data, then paper trade it.">
        <button
          type="button"
          className={`${buttonClass} border-accent/60 bg-accent/15`}
          onClick={() => {
            setCreating(true);
            setResult(null);
          }}
          disabled={!status}
        >
          + New strategy
        </button>
      </PageHeader>

      <div className="grid min-w-0 gap-3 p-3 sm:p-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-1.5" aria-label="Strategies">
          {status === null && <p className="px-1 text-label text-muted">Loading…</p>}
          {status?.error && <p className="px-1 text-label text-down">{status.error}</p>}
          {visible.map((strategy) => (
            <StrategyCard key={strategy.id} strategy={strategy} selected={!creating && strategy.id === selected?.id} onSelect={() => select(strategy.id)} />
          ))}
          {retired > 0 && (
            <button type="button" className="px-1 text-left text-label text-muted hover:text-fg" onClick={() => setShowRetired(!showRetired)}>
              {showRetired ? "Hide retired" : `Show retired (${retired})`}
            </button>
          )}
        </aside>

        <main className="min-w-0" aria-live="polite">
          {result && (
            <div role="status" className={`mb-3 flex items-start gap-3 rounded-sm border px-3 py-2 text-body ${result.ok ? "border-line-strong" : "border-down/50 text-down"}`}>
              <span className="min-w-0 flex-1">{result.message}</span>
              <button type="button" className="text-label text-muted hover:text-fg" onClick={() => setResult(null)}>
                Dismiss
              </button>
            </div>
          )}
          {creating ? (
            <section className="rounded-sm border border-line bg-panel p-4">
              <h2 className="mb-3 text-lg leading-6 font-semibold">New strategy</h2>
              <StrategyEditor
                initial={newDefinition()}
                mode="new"
                nextVersion={1}
                busy={pending}
                providers={telemetry.trading?.decisionProviders ?? null}
                onCancel={() => setCreating(false)}
                onSave={(definition) => run({ action: "create", definition }, (outcome) => outcome.ok && outcome.id && select(outcome.id))}
              />
            </section>
          ) : selected ? (
            <StrategyView
              key={selected.id}
              strategy={selected}
              detail={detail}
              busy={pending}
              testing={testJob ? (testJob.state === "queued" ? "Waiting to start…" : (testJob.progress?.label ?? "Starting…")) : null}
              providers={telemetry.trading?.decisionProviders ?? null}
              run={run}
              onCopied={select}
            />
          ) : (
            status && <EmptyState>No strategies yet. Press &ldquo;New strategy&rdquo; to make one.</EmptyState>
          )}
        </main>
      </div>
    </>
  );
}

function StrategyCard({ strategy, selected, onSelect }: { strategy: StrategySummary; selected: boolean; onSelect: () => void }) {
  const state = STATUS[strategy.status];
  const line = resultLine(strategy.lastTest);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`w-full rounded-sm border px-2.5 py-2 text-left ${selected ? "border-accent/60 bg-raised" : "border-line bg-panel hover:bg-raised"}`}
    >
      <span className="block text-body font-medium">{strategy.latest.name}</span>
      <span className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className={`rounded-sm border px-1.5 text-label ${state.tone}`}>{state.label}</span>
        <span className="text-label text-muted">version {strategy.latest.version}</span>
      </span>
      {line && <span className="mt-1 block text-label text-muted">{line}</span>}
    </button>
  );
}

function StrategyView({
  strategy,
  detail,
  busy,
  testing,
  providers,
  run,
  onCopied,
}: {
  strategy: StrategySummary;
  detail: StrategyDetail | null;
  busy: boolean;
  testing: string | null;
  providers: Parameters<typeof StrategyEditor>[0]["providers"];
  run: (command: StrategyCommand, then?: (result: { ok: boolean; id?: string }) => void) => void;
  onCopied: (id: string) => void;
}) {
  const latest = strategy.latest;
  const state = STATUS[strategy.status];
  const test = strategy.lastTest;
  const perPoint = rupeesPerPoint();
  const paperLatest = strategy.paperVersion === latest.version;
  const retired = strategy.status === "retired";
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(first);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-sm border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg leading-6 font-semibold">{latest.name}</h2>
          <span className={`rounded-sm border px-1.5 text-label ${state.tone}`}>
            {state.label}
            {strategy.paperVersion !== null && `, version ${strategy.paperVersion}`}
          </span>
        </div>
        {latest.idea && <p className="mt-1 max-w-3xl text-body text-muted">{latest.idea}</p>}
        <p className="mt-1 text-label text-muted">
          Follows {signalLabel(latest.trade.signal)} · sells after {latest.trade.holdMinutes} minutes · AI check {latest.decision.mode === "off" ? "off" : latest.decision.mode === "gate" ? "on" : "recording only"} · version {latest.version}
          {now !== null && `, saved ${ago(latest.savedAt, now)}`}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass} disabled={busy || testing !== null} onClick={() => run({ action: "test", id: strategy.id, version: latest.version })}>
            {testing ? `Testing… ${testing}` : `Test version ${latest.version} on past data`}
          </button>
          {!retired &&
            (paperLatest ? (
              <button type="button" className={buttonClass} disabled={busy} onClick={() => run({ action: "stop-paper", id: strategy.id })}>
                Stop paper trading
              </button>
            ) : (
              <button type="button" className={buttonClass} disabled={busy} onClick={() => run({ action: "paper", id: strategy.id, version: latest.version })}>
                Paper trade version {latest.version}
              </button>
            ))}
          {strategy.paperVersion !== null && !paperLatest && (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => run({ action: "stop-paper", id: strategy.id })}>
              Stop paper trading
            </button>
          )}
          <button type="button" className={buttonClass} disabled={busy} onClick={() => run({ action: "create", from: { id: strategy.id, version: latest.version } }, (r) => r.ok && r.id && onCopied(r.id))}>
            Make a copy
          </button>
          <button type="button" className="h-7 px-2 text-label text-muted hover:text-fg" disabled={busy} onClick={() => run({ action: retired ? "restore" : "retire", id: strategy.id })}>
            {retired ? "Restore" : "Retire"}
          </button>
          {strategy.paperVersion !== null && (
            <Link href="/paper-trading" className="ml-auto text-label text-accent hover:underline">
              See paper trading →
            </Link>
          )}
        </div>
        {strategy.paperVersion !== null && !paperLatest && (
          <p className="mt-2 text-label text-warn">Paper trading still follows version {strategy.paperVersion}. Version {latest.version} has newer settings: test it, then paper trade it when you&apos;re ready.</p>
        )}
      </section>

      <section className="rounded-sm border border-line bg-panel p-4">
        <h3 className="text-label font-medium tracking-wider text-muted uppercase">Latest test</h3>
        {test?.verdict ? (
          <div className="mt-2 flex flex-col gap-1">
            <p className="text-body">
              <span className={`mr-2 rounded-sm border px-1.5 py-0.5 font-semibold ${VERDICT_TONE[test.verdict]}`}>{PLAIN_VERDICT[test.verdict].label}</span>
              {test.net !== null && test.trades !== null && (
                <>
                  Would have {test.net < 0 ? "lost" : "made"} about <strong>{rupees(test.net * perPoint * test.trades)}</strong> over {count(test.trades)} trades in {test.days ?? "?"} days: {signedRupees(test.net * perPoint)} a trade after
                  costs.
                </>
              )}
            </p>
            <p className="text-label text-muted">
              Version {test.version}
              {test.version !== latest.version && ` (the latest is ${latest.version})`}, tested {dayLabel(istDate(test.at))}. {PLAIN_VERDICT[test.verdict].advice}{" "}
              {test.study && (
                <Link href={`/research?study=${encodeURIComponent(test.study)}`} className="text-accent hover:underline">
                  See the full result →
                </Link>
              )}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-body text-muted">Not tested yet. &ldquo;Test on past data&rdquo; replays it over the past year, with real costs, in about 30 seconds.</p>
        )}
      </section>

      <section className="rounded-sm border border-line bg-panel p-4">
        <h3 className="mb-3 text-label font-medium tracking-wider text-muted uppercase">Settings</h3>
        <StrategyEditor
          key={`${latest.id}-${latest.version}`}
          initial={definitionOf(latest)}
          mode="edit"
          nextVersion={latest.version + 1}
          busy={busy}
          providers={providers}
          onSave={(definition, note) => run({ action: "save", id: strategy.id, definition, note })}
        />
      </section>

      <History detail={detail} strategy={strategy} busy={busy} run={run} now={now} />
    </div>
  );
}

/** A version's settings alone. */
const definitionOf = (v: StrategyVersion): StrategyDefinition => ({ name: v.name, idea: v.idea, kind: v.kind, trade: v.trade, decision: v.decision });

const EVENT_WORDS: Record<StrategyEvent["kind"], string> = {
  created: "Created",
  saved: "Saved",
  tested: "Tested",
  "paper-on": "Paper trading started",
  "paper-off": "Paper trading stopped",
  retired: "Retired",
  restored: "Restored",
};

function History({ detail, strategy, busy, run, now }: { detail: StrategyDetail | null; strategy: StrategySummary; busy: boolean; run: (command: StrategyCommand) => void; now: number | null }) {
  if (!detail) return null;
  const testsOf = (version: number) => detail.events.filter((e) => e.kind === "tested" && e.version === version);
  return (
    <details className="group rounded-sm border border-line bg-panel">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-body text-muted select-none hover:text-fg">
        <span className="transition-transform group-open:rotate-90">▸</span> History: {detail.versions.length} version{detail.versions.length === 1 ? "" : "s"}, {detail.events.length} events
      </summary>
      <div className="grid gap-4 border-t border-line p-4 lg:grid-cols-2">
        <div>
          <h4 className="mb-2 text-label font-medium tracking-wider text-muted uppercase">Versions</h4>
          <ul className="flex flex-col gap-2">
            {detail.versions.map((v) => {
              const tested = testsOf(v.version)[0];
              return (
                <li key={v.version} className="rounded-sm border border-line px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">Version {v.version}</span>
                    <span className="text-label text-muted">{now === null ? "" : ago(v.savedAt, now)}</span>
                    {strategy.paperVersion === v.version && <span className="text-label text-accent">paper trading</span>}
                  </div>
                  {v.note && <p className="text-label text-muted">{v.note}</p>}
                  <p className="text-label text-muted">
                    {signalLabel(v.trade.signal)}, sells after {v.trade.holdMinutes} min, stop {v.trade.stopLossPct || "none"}
                    {v.trade.stopLossPct ? "%" : ""}, target {v.trade.targetPct || "none"}
                    {v.trade.targetPct ? "%" : ""}, AI check {v.decision.mode === "off" ? "off" : "on"}
                  </p>
                  <p className="text-label">{tested ? resultLine(tested) : <span className="text-muted">Not tested</span>}</p>
                  <div className="mt-1 flex gap-3 text-label">
                    <button type="button" className="text-accent hover:underline disabled:opacity-60" disabled={busy} onClick={() => run({ action: "test", id: strategy.id, version: v.version })}>
                      Test
                    </button>
                    {strategy.status !== "retired" && strategy.paperVersion !== v.version && (
                      <button type="button" className="text-accent hover:underline disabled:opacity-60" disabled={busy} onClick={() => run({ action: "paper", id: strategy.id, version: v.version })}>
                        Paper trade this version
                      </button>
                    )}
                    <button type="button" className="text-accent hover:underline disabled:opacity-60" disabled={busy} onClick={() => run({ action: "create", from: { id: strategy.id, version: v.version } })}>
                      Copy
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <h4 className="mb-2 text-label font-medium tracking-wider text-muted uppercase">What happened</h4>
          <ol className="flex flex-col gap-1.5 text-label">
            {detail.events.map((e) => (
              <li key={`${e.at}-${e.kind}`} className="flex gap-2">
                <span className="w-24 shrink-0 text-muted">{now === null ? "" : ago(e.at, now)}</span>
                <span>
                  {EVENT_WORDS[e.kind]}, version {e.version}
                  {e.kind === "tested" && e.verdict && `: ${resultLine(e)}`}
                  {e.note && e.kind !== "tested" && <span className="text-muted"> · {e.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </details>
  );
}
