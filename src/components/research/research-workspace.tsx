"use client";

// The Research page: what history there is, a study asked in one sentence, the studies so far,
// and the selected study's report. Studies run in the engine; this page starts them, follows
// their progress on the telemetry stream and reads the results it stored.

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { controlStrategies } from "@/app/(cockpit)/(strategies)/strategies/store-actions";
import { controlResearch } from "@/app/(cockpit)/research/actions";
import { useEngineTelemetry } from "@/components/engine/use-engine-telemetry";
import { fieldClass } from "@/components/trading/shared";
import { buttonClass, EmptyState, PageHeader } from "@/components/ui";
import { CLOSING_AUCTION_FROM } from "@/lib/research/day-frames";
import {
  PLAIN_VERDICT,
  signalName,
  type ResearchCommand,
  type ResearchJob,
  type ResearchStatus,
  type StudyDetail,
  type StudyRow,
} from "@/lib/research/types";
import type { StrategiesStatus, StrategySummary } from "@/lib/strategies/types";
import { ago, count, dayLabel, istDate, rupeesPerPoint, signedRupees, VERDICT_TONE } from "./research-format";
import { StudyReport } from "./study-report";

const BASE = "/api/engine/v1/research";
const TOPICS = ["status", "research", "strategies"] as const;

type Period = "all" | "12m" | "6m" | "auction";
const PERIODS: { id: Period; label: string }[] = [
  { id: "all", label: "all the history" },
  { id: "12m", label: "the last 12 months" },
  { id: "6m", label: "the last 6 months" },
  { id: "auction", label: "the closing-auction era" },
];

function periodRange(period: Period, from: string, to: string): { from: string; to: string } {
  if (period === "auction") return { from: CLOSING_AUCTION_FROM > from ? CLOSING_AUCTION_FROM : from, to };
  if (period === "all") return { from, to };
  const months = period === "12m" ? 12 : 6;
  const [y, m, d] = to.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1 - months, d + 1)).toISOString().slice(0, 10);
  return { from: start > from ? start : from, to };
}

/** Says so plainly when the engine runs code from before research existed. */
const OLD_ENGINE = "The engine is running code from before the Research Center. Restart it on the new code to use this page.";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 404 && /No route \/v1\/research/.test(body.error ?? "")) throw new Error(OLD_ENGINE);
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

interface Notice {
  tone: "ok" | "warn" | "error";
  text: string;
}

export function ResearchWorkspace() {
  const telemetry = useEngineTelemetry(TOPICS);
  const [fetched, setFetched] = useState<ResearchStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const research = telemetry.research ?? fetched;
  const [studies, setStudies] = useState<{ list: StudyRow[] | null; error: string | null }>({ list: null, error: null });
  const [details, setDetails] = useState<Record<string, { detail: StudyDetail | null; error: string | null }>>({});
  const [mine, setMine] = useState<string[]>([]);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const opened = useRef<string | null>(null);
  const params = useSearchParams();
  const chosen = params.get("study");
  const [now, setNow] = useState<number | null>(null);
  const [fetchedStrategies, setFetchedStrategies] = useState<StrategiesStatus | null>(null);
  const jobs = research?.jobs;

  // The status once (the stream may not have sent one yet), and a clock for "5 min ago".
  useEffect(() => {
    void getJson<ResearchStatus>(BASE).then(setFetched, (error: Error) => setStatusError(error.message));
    void getJson<StrategiesStatus>("/api/engine/v1/strategies").then(setFetchedStrategies, () => {});
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  // The stored studies: read at first, and again whenever a study job finishes.
  const finishedStudies = (jobs ?? []).filter((j) => j.kind === "study" && j.state === "done").map((j) => j.id).join(",");
  useEffect(() => {
    void getJson<{ studies: StudyRow[] }>(`${BASE}/studies`).then(
      ({ studies: list }) => setStudies({ list, error: null }),
      (error: Error) => setStudies((held) => ({ list: held.list, error: error.message })),
    );
  }, [finishedStudies]);

  const select = useCallback((id: string) => {
    window.history.pushState(null, "", `?study=${encodeURIComponent(id)}`);
  }, []);

  // The newest job this tab started that has finished: its outcome is shown, and its study opened.
  const outcome = (jobs ?? []).find((j) => mine.includes(j.id) && (j.state === "done" || j.state === "failed")) ?? null;
  useEffect(() => {
    if (!outcome?.studyId || opened.current === outcome.id) return;
    opened.current = outcome.id;
    select(outcome.studyId);
  }, [outcome, select]);
  const notice: Notice | null = commandError
    ? { tone: "error", text: commandError }
    : outcome && outcome.id !== dismissed
      ? { tone: outcome.state === "failed" ? "error" : outcome.matched === false ? "warn" : "ok", text: outcome.message ?? "" }
      : null;

  // The selected study, read again after each finished rerun of it (its checks change).
  const selectedId = chosen ?? studies.list?.[0]?.id ?? null;
  const reruns = (jobs ?? []).filter((j) => j.studyId === selectedId && j.state === "done").length;
  const detailKey = selectedId ? `${selectedId}#${reruns}` : null;
  useEffect(() => {
    if (!detailKey || details[detailKey]) return;
    const id = detailKey.split("#")[0];
    void getJson<StudyDetail>(`${BASE}/study?id=${encodeURIComponent(id)}`).then(
      (detail) => setDetails((held) => ({ ...held, [detailKey]: { detail, error: null } })),
      (error: Error) => setDetails((held) => ({ ...held, [detailKey]: { detail: null, error: error.message } })),
    );
  }, [detailKey, details]);
  // While a fresher copy loads, the one already held stays on screen.
  const held = detailKey ? (details[detailKey] ?? Object.entries(details).find(([key, value]) => key.startsWith(`${selectedId}#`) && value.detail)?.[1]) : undefined;
  const detail = held?.detail ?? undefined;
  const detailError = held?.error ?? null;

  const run = useCallback((command: ResearchCommand) => {
    startTransition(async () => {
      const result = await controlResearch(command);
      if (result.ok && result.job) setMine((list) => [result.job!, ...list]);
      setCommandError(result.ok ? null : result.message);
    });
  }, []);

  // Tests go through the strategy store, so each result is recorded against its strategy's version.
  const test = useCallback((id: string, version: number, from: string, to: string) => {
    startTransition(async () => {
      const result = await controlStrategies({ action: "test", id, version, from, to });
      if (result.ok && result.job) setMine((list) => [result.job!, ...list]);
      setCommandError(result.ok ? null : result.message);
    });
  }, []);
  const strategies = (telemetry.strategies ?? fetchedStrategies)?.strategies.filter((s) => s.status !== "retired") ?? null;
  const paperStrategy = strategies?.find((s) => s.status === "paper") ?? null;

  const active = (jobs ?? []).filter((j) => j.state === "queued" || j.state === "running");
  const history = active.find((j) => j.kind === "history");
  const studyJobs = active.filter((j) => j.kind !== "history");
  const rerunning = active.some((j) => j.kind === "rerun" && j.studyId === selectedId);

  const blocked =
    telemetry.link === "unconfigured" || (telemetry.link === "offline" && !research)
      ? `${telemetry.error ?? "The engine can't be reached."} Studies run in the engine, so this page needs it running.`
      : !research && statusError === OLD_ENGINE
        ? OLD_ENGINE
        : null;
  if (blocked) {
    return (
      <>
        <PageHeader title="Research" />
        <div className="p-3 sm:p-4">
          <EmptyState>{blocked}</EmptyState>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Research" meta={<Coverage research={research} />}>
        {history ? (
          <JobLine job={history} onCancel={() => run({ action: "cancel", job: history.id })} />
        ) : (
          <button type="button" className={buttonClass} disabled={!research || pending} onClick={() => run({ action: "history" })} title="Download the newest minute bars and official daily closes from Dhan">
            Update history
          </button>
        )}
      </PageHeader>

      <div className="flex flex-col gap-3 p-3 sm:p-4">
        <Composer research={research} strategies={strategies} busy={pending} onTest={test} />

        {notice && (
          <div
            role="status"
            className={`flex items-start gap-3 rounded-sm border px-3 py-2 text-body ${
              notice.tone === "error" ? "border-down/50 text-down" : notice.tone === "warn" ? "border-warn/50 text-warn" : "border-line-strong"
            }`}
          >
            <span className="min-w-0 flex-1">{notice.text}</span>
            <button
              type="button"
              className="text-label text-muted hover:text-fg"
              onClick={() => {
                setCommandError(null);
                setDismissed(outcome?.id ?? null);
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="grid min-w-0 gap-3 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="flex min-w-0 flex-col gap-2" aria-label="Studies">
            <h2 className="px-1 text-label font-medium tracking-wider text-muted uppercase">Studies</h2>
            {studyJobs.map((job) => (
              <div key={job.id} className="rounded-sm border border-accent/40 bg-panel p-2.5">
                <div className="text-body font-medium">{job.title}</div>
                <JobLine job={job} onCancel={() => run({ action: "cancel", job: job.id })} />
              </div>
            ))}
            {studies.error && <p className="px-1 text-label text-down">Couldn&apos;t read the stored studies: {studies.error}</p>}
            {studies.list === null && !studies.error && <p className="px-1 text-label text-muted">Loading…</p>}
            {studies.list?.length === 0 && studyJobs.length === 0 && <p className="px-1 text-label text-muted">None yet.</p>}
            <ul className="flex flex-col gap-1">
              {studies.list?.map((study) => (
                <li key={study.id}>
                  <StudyItem study={study} selected={study.id === selectedId} now={now} onSelect={() => select(study.id)} />
                </li>
              ))}
            </ul>
          </aside>

          <main className="min-w-0" aria-live="polite">
            {!selectedId && studies.list?.length === 0 ? (
              <FirstStudy
                research={research}
                strategy={paperStrategy}
                busy={pending || studyJobs.length > 0}
                onRun={() => {
                  const minute = research?.coverage?.minute;
                  if (paperStrategy && minute) test(paperStrategy.id, paperStrategy.latest.version, istDate(minute.from), istDate(minute.to));
                }}
              />
            ) : detail ? (
              <StudyReport
                detail={detail}
                location={research?.location ?? null}
                onRerun={() => run({ action: "rerun", id: detail.manifest.id })}
                rerunning={rerunning}
                gate={{
                  job: active.find((j) => j.kind === "gate" && j.studyId === detail.manifest.id) ?? null,
                  decisions: research?.decisions ?? null,
                  onRun: (provider) => run({ action: "gate", id: detail.manifest.id, provider }),
                }}
              />
            ) : detailError ? (
              <EmptyState>Couldn&apos;t open this study: {detailError}</EmptyState>
            ) : selectedId ? (
              <p className="p-3 text-label text-muted">Opening the study…</p>
            ) : null}
          </main>
        </div>
      </div>
    </>
  );
}

function Coverage({ research }: { research: ResearchStatus | null }) {
  if (!research) return <span>Connecting to the engine…</span>;
  if (research.coverageError) return <span className="text-warn">{research.coverageError}</span>;
  const minute = research.coverage?.minute;
  if (!minute) return <span>Reading the history…</span>;
  return (
    <span title={`Every minute of NIFTY, its 50 stocks and a few more, and each day's closing prices (to ${dayLabel(research.coverage?.dailyTo ?? null)})`}>
      Market data from {dayLabel(istDate(minute.from))} to {dayLabel(istDate(minute.to))}
    </span>
  );
}

function JobLine({ job, onCancel }: { job: ResearchJob; onCancel: () => void }) {
  const progress = job.progress;
  const share = progress && progress.total > 0 ? progress.done / progress.total : 0;
  return (
    <div className="mt-1 flex min-w-0 items-center gap-2 text-label text-muted">
      <div className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(4, share * 100)}%` }} />
      </div>
      <span className="min-w-0 truncate">{job.state === "queued" ? "Waiting for the job before it" : (progress?.label ?? "Starting")}</span>
      <button type="button" onClick={onCancel} className="ml-auto shrink-0 hover:text-fg">
        Cancel
      </button>
    </div>
  );
}

function StudyItem({ study, selected, now, onSelect }: { study: StudyRow; selected: boolean; now: number | null; onSelect: () => void }) {
  // Studies run with the default lot and delta (the page offers no other), so their rupees compare.
  const perTrade = study.net_option === null ? null : study.net_option * rupeesPerPoint();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`w-full rounded-sm border px-2.5 py-2 text-left ${selected ? "border-accent/60 bg-raised" : "border-line bg-panel hover:bg-raised"}`}
    >
      <span className="block text-body font-medium">
        {study.strategy_name ? `${study.strategy_name}, v${study.strategy_version}` : `${signalName(study.signal)}, held ${study.horizon} min`}
      </span>
      <span className={`mt-1 inline-block rounded-sm border px-1.5 text-label ${VERDICT_TONE[study.verdict]}`}>{PLAIN_VERDICT[study.verdict].label}</span>
      <span className="mt-1 block text-label text-muted tabular-nums">
        {signedRupees(perTrade)} a trade · {count(study.firings)} trades
      </span>
      <span className="block text-label text-muted">
        {study.days} days to {dayLabel(study.to)} · {now === null ? "" : ago(study.started_at, now)}
      </span>
    </button>
  );
}

function Composer({ research, strategies, busy, onTest }: { research: ResearchStatus | null; strategies: StrategySummary[] | null; busy: boolean; onTest: (id: string, version: number, from: string, to: string) => void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("all");
  const strategy = strategies?.find((s) => s.id === chosen) ?? strategies?.find((s) => s.status === "paper") ?? strategies?.[0] ?? null;
  const minute = research?.coverage?.minute;
  const span = useMemo(() => (minute ? periodRange(period, istDate(minute.from), istDate(minute.to)) : null), [minute, period]);

  return (
    <section className="rounded-sm border border-line bg-panel p-3" aria-label="Test a strategy">
      <form
        className="flex flex-wrap items-center gap-x-2 gap-y-2 text-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (strategy && span) onTest(strategy.id, strategy.latest.version, span.from, span.to);
        }}
      >
        <span>Would</span>
        <select aria-label="Strategy" className={`${fieldClass} max-w-72`} value={strategy?.id ?? ""} onChange={(e) => setChosen(e.target.value)} disabled={!strategies?.length}>
          {strategies?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.latest.name} (version {s.latest.version})
            </option>
          ))}
        </select>
        <span>have made money over</span>
        <select aria-label="Period" className={fieldClass} value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
          {PERIODS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <span>?</span>
        <button type="submit" className={`${buttonClass} ml-auto border-accent/60 bg-accent/15`} disabled={busy || !span || !strategy}>
          Test it
        </button>
      </form>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted">
        {strategy && <span>{strategy.status === "paper" ? "This is what the engine is paper trading now." : `Follows ${signalName(strategy.latest.trade.signal)}, sells after ${strategy.latest.trade.holdMinutes} minutes.`}</span>}
        {span && (
          <span>
            {dayLabel(span.from)} – {dayLabel(span.to)}
          </span>
        )}
        <span>Takes about 30 seconds.</span>
        <Link href={strategy ? `/strategies?id=${encodeURIComponent(strategy.id)}` : "/strategies"} className="text-accent hover:underline">
          Change its settings in Strategies →
        </Link>
      </div>
      {strategies?.length === 0 && <p className="mt-2 text-label text-muted">No strategies yet: make one in Strategies first.</p>}
    </section>
  );
}

function FirstStudy({ research, strategy, busy, onRun }: { research: ResearchStatus | null; strategy: StrategySummary | null; busy: boolean; onRun: () => void }) {
  return (
    <section className="rounded-sm border border-line bg-panel p-6">
      <h2 className="text-lg leading-6 font-semibold">Would what the engine trades have made money?</h2>
      <p className="mt-2 max-w-2xl text-body text-muted">
        This replays the strategy the engine is paper trading now{strategy ? ` (${strategy.latest.name})` : ""} over every day of past market data, with real costs, and tells you what it would have made or lost. It
        takes about 30 seconds.
      </p>
      <button type="button" className={`${buttonClass} mt-4 border-accent/60 bg-accent/15`} disabled={busy || !research?.coverage?.minute || !strategy} onClick={onRun}>
        Test it
      </button>
    </section>
  );
}
