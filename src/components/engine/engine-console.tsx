"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatAge, TokenExpiry, useNow } from "@/components/shell/freshness";
import { DataTable, EmptyState, PageHeader, Panel, StatRow, StatusDot, Td } from "@/components/ui";
import type {
  ComponentHealth,
  EngineStatus,
  HealthState,
  HistogramSnapshot,
  LogEntry,
  LogLevel,
  MetricsSnapshot,
} from "@/lib/engine/protocol";
import { istDateTime, istTime, quantity } from "@/lib/format";
import type { FeedHealth } from "@/lib/live/feed/monitor";
import { engineSummary, engineView, VIEW_LABEL, VIEW_TONE } from "./engine-status";
import { SessionView } from "./session-view";
import { useEngineTelemetry } from "./use-engine-telemetry";

const TOPICS = ["status", "metrics", "log", "feed"] as const;
const HEALTH_TONE: Record<HealthState, "up" | "warn" | "down"> = { ok: "up", degraded: "warn", failing: "down" };
const SEGMENT_NAMES: Record<string, string> = { E: "Equity", D: "Derivatives", C: "Currency", M: "Commodity" };
const TABS = ["Overview", "Session", "Logs"] as const;
type Tab = (typeof TABS)[number];

export function EngineConsole() {
  const telemetry = useEngineTelemetry(TOPICS);
  const now = useNow();
  const view = engineView(telemetry, now);
  const [tab, setTab] = useState<Tab>("Overview");
  const { status } = telemetry;

  return (
    <>
      <PageHeader
        title="Engine"
        meta={
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone={VIEW_TONE[view]} />
            {VIEW_LABEL[view]}
            {status && view !== "offline" && <span>· up {formatAge(status.now - status.startedAt)}</span>}
          </span>
        }
      >
        <div role="tablist" aria-label="Engine views" className="flex gap-1">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
              className={`h-7 rounded-sm px-2.5 text-body ${tab === name ? "bg-raised font-medium" : "text-muted hover:text-fg"}`}
            >
              {name}
              {name === "Logs" && telemetry.logs.length > 0 && (
                <span className="ml-1.5 text-label text-muted tabular-nums">{quantity.format(telemetry.logs.length)}</span>
              )}
            </button>
          ))}
        </div>
      </PageHeader>

      {view !== "ok" && view !== "connecting" && (
        <div
          role="status"
          className={`mx-2 mt-2 rounded-sm border px-3 py-2 sm:mx-3 ${
            view === "degraded" ? "border-warn/50 text-warn" : view === "unconfigured" ? "border-line text-muted" : "border-down/50 text-down"
          }`}
        >
          {engineSummary(telemetry, view)}
        </div>
      )}

      {tab === "Overview" && (
        <Overview
          status={view === "offline" ? null : status}
          metrics={telemetry.metrics}
          feed={view === "offline" ? null : telemetry.feed}
          dropped={telemetry.dropped}
        />
      )}
      {tab === "Session" && <SessionView status={view === "offline" ? null : status} />}
      {tab === "Logs" && <Logs entries={telemetry.logs} />}
    </>
  );
}

function Overview({
  status,
  metrics,
  feed,
  dropped,
}: {
  status: EngineStatus | null;
  metrics: MetricsSnapshot | null;
  feed: FeedHealth | null;
  dropped: number;
}) {
  if (!status) {
    return (
      <div className="p-2 sm:p-3">
        <Panel>
          <EmptyState>No live status. Start the engine on the server with npm run engine; this page connects within 2 seconds.</EmptyState>
        </Panel>
      </div>
    );
  }

  return (
    <div className="grid gap-2 p-2 sm:p-3 lg:grid-cols-2">
      <HealthPanel components={status.components} />

      <FeedPanel
        feed={feed}
        now={status.now}
        universe={status.universe}
        marketClosed={marketClosed(status)}
        skipped={metrics?.counters["journal.frames_skipped"] ?? 0}
      />

      <JournalPanel
        status={status}
        latency={metrics?.histograms["journal.write_ms"]}
        marketClosed={marketClosed(status)}
        skipped={metrics?.counters["journal.frames_skipped"] ?? 0}
      />

      <Panel title="Dhan account">
        <dl>
          <StatRow label="Access token" value={status.token.source === "redis" ? "From Redis (Settings page)" : status.token.source === "env" ? "From .env.local" : "None"} />
          {status.token.expiresAt && <StatRow label="Token expires" value={<TokenExpiry expiresAt={status.token.expiresAt} />} />}
          {status.dhan ? (
            <>
              <StatRow
                label="Data API plan"
                value={status.dhan.dataPlan === "Active" ? `Active until ${status.dhan.dataValidity.slice(0, 10)}` : status.dhan.dataPlan}
              />
              <StatRow
                label="Active segments"
                value={status.dhan.activeSegments.map((code) => SEGMENT_NAMES[code] ?? code).join(", ") || "None"}
              />
              <StatRow label="Profile checked" value={<Ago at={status.dhan.checkedAt} now={status.now} />} />
            </>
          ) : (
            <StatRow label="Profile" value="Not checked yet" />
          )}
          <StatRow
            label="Clock vs Dhan"
            value={
              status.clock
                ? `${status.clock.offsetMs >= 0 ? "+" : "−"}${Math.abs(status.clock.offsetMs)} ms ± ${status.clock.uncertaintyMs} ms`
                : "Not measured yet"
            }
          />
        </dl>
      </Panel>

      <Panel title="Market sessions" meta="IST">
        <DataTable caption="Market sessions by segment" columns={["Segment", "Now", "Next session"]}>
          {status.sessions.map((session) => (
            <tr key={session.segment}>
              <Td className="font-mono">{session.segment}</Td>
              <Td numeric>
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone={session.phase === "open" ? "up" : session.phase === "pre-open" ? "warn" : "muted"} />
                  {session.holiday ? `Holiday: ${session.holiday}` : session.phase === "pre-open" ? "Pre-open" : session.phase === "open" ? "Open" : "Closed"}
                </span>
              </Td>
              <Td numeric>
                {session.next
                  ? `${istDateTime.format(new Date(session.next.open))} – ${istTime.format(new Date(session.next.close)).slice(0, 5)}`
                  : "None in the next 30 days"}
              </Td>
            </tr>
          ))}
        </DataTable>
      </Panel>

      <Panel title="Process">
        <dl>
          <StatRow label="Version" value={<span className="font-mono">{status.version}</span>} />
          <StatRow label="Host" value={`${status.host} · pid ${status.pid} · Node ${status.node}`} />
          <StatRow label="Started" value={`${istDateTime.format(new Date(status.startedAt))} IST`} />
          <StatRow label="Memory" value={`${mb(status.process.rssBytes)} RSS · ${mb(status.process.heapUsedBytes)} heap`} />
          <StatRow label="CPU" value={`${status.process.cpuPercent.toFixed(1)}%`} />
          <StatRow
            label="Event-loop delay p99"
            value={<span className={status.process.eventLoopDelayP99Ms > 50 ? "text-warn" : undefined}>{status.process.eventLoopDelayP99Ms.toFixed(1)} ms</span>}
          />
          {dropped > 0 && <StatRow label="Telemetry dropped (this tab)" value={<span className="text-warn">{quantity.format(dropped)}</span>} />}
        </dl>
      </Panel>

      <MetricsPanel metrics={metrics} />
    </div>
  );
}

const FEED_TONE = { idle: "muted", connecting: "warn", live: "up", reconnecting: "warn", stopped: "down" } as const;

/** Every segment is closed: Dhan only repeats last prices, and the journal skips the repeats. */
function marketClosed(status: EngineStatus) {
  return status.sessions.length > 0 && status.sessions.every((session) => session.phase === "closed");
}

function FeedPanel({
  feed,
  now,
  universe,
  marketClosed,
  skipped,
}: {
  feed: FeedHealth | null;
  now: number;
  universe: EngineStatus["universe"];
  marketClosed: boolean;
  skipped: number;
}) {
  if (!feed) {
    return (
      <Panel title="Dhan feed">
        <EmptyState>The feed reports within a second of the engine starting.</EmptyState>
      </Panel>
    );
  }
  const pinned = feed.instruments.filter((i) => i.pinned).length;
  return (
    <Panel
      title="Dhan feed"
      meta={`${feed.connections.length} of 5 sockets · ${quantity.format(feed.instruments.length)} instruments · ${feed.quoteStreams} tab${feed.quoteStreams === 1 ? "" : "s"}${pinned ? ` · ${pinned} pinned` : ""}${feed.capture ? " · recording" : ""}`}
      flush
    >
      {universe && (
        <p className="border-b border-line px-3 py-1.5 text-label text-muted">
          Always on: {universe.name}, {quantity.format(universe.instruments)} instruments
          {universe.byMode && ` (${Object.entries(universe.byMode).map(([mode, count]) => `${count} ${mode}`).join(", ")})`}
          {universe.problems.length > 0 && <span className="text-warn"> · {universe.problems.length} unresolved</span>}
        </p>
      )}
      {marketClosed && (
        <p role="status" className="flex items-start gap-1.5 border-b border-line px-3 py-1.5 text-label text-muted">
          <span className="mt-1.5">
            <StatusDot tone="muted" />
          </span>
          <span>
            Market closed. Dhan keeps sending the last price, so frames still arrive, but nothing is changing. The journal
            skips the repeats{skipped > 0 && ` (${quantity.format(skipped)} this run)`}.
          </span>
        </p>
      )}
      <DataTable
        caption="Dhan feed connections"
        columns={["Socket", { label: "State", align: "left" }, "Instruments", "Frames", "Last tick"]}
      >
        {feed.connections.map((c) => (
          <tr key={c.id}>
            <Td>{c.name}</Td>
            <Td className="whitespace-normal">
              <span className="inline-flex items-start gap-1.5">
                <span className="mt-1.5">
                  <StatusDot tone={FEED_TONE[c.feed.state]} />
                </span>
                <span>
                  {c.feed.state}
                  {(c.feed.state === "stopped" || c.feed.state === "reconnecting") && (
                    <span className="text-muted"> · {c.feed.reason}</span>
                  )}
                </span>
              </span>
            </Td>
            <Td numeric>{quantity.format(c.instruments)}</Td>
            <Td numeric>{quantity.format(c.frames)}</Td>
            <Td numeric>{c.lastTickAt ? `${formatAge(Math.max(0, now - c.lastTickAt))} ago` : "—"}</Td>
          </tr>
        ))}
      </DataTable>
    </Panel>
  );
}

function JournalPanel({
  status,
  latency,
  marketClosed,
  skipped,
}: {
  status: EngineStatus;
  latency?: HistogramSnapshot;
  marketClosed: boolean;
  skipped: number;
}) {
  const journal = status.journal;
  return (
    <Panel title="Journal" meta="raw frames, the source of truth">
      {journal?.date ? (
        <dl>
          <StatRow label="Today's file" value={<span className="font-mono">{journal.date}.bin</span>} />
          <StatRow label="Size" value={bytes(journal.bytes)} />
          <StatRow
            label="This run"
            value={`${quantity.format(journal.frames)} frames · ${quantity.format(journal.controls)} events · ${quantity.format(journal.gaps)} gap${journal.gaps === 1 ? "" : "s"}`}
          />
          <StatRow
            label="Repeats skipped"
            value={
              <span className="inline-flex items-center gap-1.5">
                <StatusDot tone={marketClosed ? "muted" : "up"} />
                {marketClosed
                  ? "Market closed: skipping unchanged frames"
                  : status.sessions.some((session) => session.phase === "closed")
                    ? "Closed segments only (pre-open): other frames all written"
                    : "Market open: writing every frame"}
                {skipped > 0 && <span className="text-muted"> · {quantity.format(skipped)} this run</span>}
              </span>
            }
          />
          <StatRow label="Last write" value={journal.lastWriteAt ? <Ago at={journal.lastWriteAt} now={status.now} /> : "—"} />
          {latency && latency.count > 0 && <StatRow label="Write latency p99" value={`${latency.p99} ms`} />}
          {(journal.backlogBytes > 0 || journal.error) && (
            <StatRow
              label="Disk"
              value={<span className="text-warn">{journal.error ?? `${bytes(journal.backlogBytes)} waiting`}</span>}
            />
          )}
          <StatRow
            label="Recorded days"
            value={
              status.journalDays.length === 0
                ? "None"
                : `${status.journalDays.length} · ${bytes(status.journalDays.reduce((sum, day) => sum + day.bytes, 0))} total`
            }
          />
          {status.journalDays.slice(0, 5).map((day) => (
            <StatRow key={day.date} label={<span className="pl-3 font-mono">{day.date}</span>} value={bytes(day.bytes)} />
          ))}
        </dl>
      ) : (
        <EmptyState>Nothing written yet. The journal opens with the engine&apos;s first record.</EmptyState>
      )}
    </Panel>
  );
}

function HealthPanel({ components }: { components: ComponentHealth[] }) {
  const sorted = [...components].sort((a, b) => a.component.localeCompare(b.component));
  return (
    <Panel title="Health" flush>
      <DataTable caption="Component health" columns={["Component", { label: "State", align: "left" }, { label: "Since", align: "right" }]}>
        {sorted.map((c) => (
          <tr key={c.component}>
            <Td className="font-mono">{c.component}</Td>
            <Td className="whitespace-normal">
              <span className="inline-flex items-start gap-1.5">
                <span className="mt-1.5">
                  <StatusDot tone={HEALTH_TONE[c.state]} />
                </span>
                <span>
                  {c.state}
                  {c.reason && <span className="text-muted"> · {c.reason}</span>}
                </span>
              </span>
            </Td>
            <Td numeric>{istTime.format(new Date(c.since))}</Td>
          </tr>
        ))}
      </DataTable>
    </Panel>
  );
}

function MetricsPanel({ metrics }: { metrics: MetricsSnapshot | null }) {
  if (!metrics) {
    return (
      <Panel title="Metrics">
        <EmptyState>The first metrics arrive within 5 seconds.</EmptyState>
      </Panel>
    );
  }
  const counters = Object.entries(metrics.counters).sort(([a], [b]) => a.localeCompare(b));
  const gauges = Object.entries(metrics.gauges).sort(([a], [b]) => a.localeCompare(b));
  const histograms = Object.entries(metrics.histograms).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Panel title="Metrics" meta={`window ${(metrics.windowMs / 1000).toFixed(0)}s`} flush>
      <DataTable caption="Engine metrics" columns={["Metric", "Kind", "Value"]}>
        {counters.map(([name, value]) => (
          <MetricRow key={`c:${name}`} name={name} kind="counter" value={quantity.format(value)} />
        ))}
        {gauges.map(([name, value]) => (
          <MetricRow key={`g:${name}`} name={name} kind="gauge" value={quantity.format(value)} />
        ))}
        {histograms.map(([name, h]) => (
          <MetricRow
            key={`h:${name}`}
            name={name}
            kind="latency"
            value={h.count === 0 ? "no samples" : `p50 ${h.p50} · p99 ${h.p99} · max ${h.max.toFixed(1)} ms (${quantity.format(h.count)})`}
          />
        ))}
      </DataTable>
    </Panel>
  );
}

function MetricRow({ name, kind, value }: { name: string; kind: string; value: ReactNode }) {
  return (
    <tr>
      <Td className="font-mono">{name}</Td>
      <Td numeric className="text-muted">
        {kind}
      </Td>
      <Td numeric>{value}</Td>
    </tr>
  );
}

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: "text-muted",
  info: "text-fg",
  warn: "text-warn",
  error: "text-down",
};
const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const selectClass = "h-7 rounded-sm border border-line-strong bg-canvas px-2 text-body focus-visible:border-accent";

function Logs({ entries }: { entries: LogEntry[] }) {
  const [level, setLevel] = useState<LogLevel>("debug");
  const [component, setComponent] = useState("");
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const components = useMemo(() => [...new Set(entries.map((e) => e.component))].sort(), [entries]);
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return entries.filter(
      (e) =>
        LEVEL_RANK[e.level] >= LEVEL_RANK[level] &&
        (!component || e.component === component || e.component.startsWith(`${component}.`)) &&
        (!needle || e.message.toLowerCase().includes(needle) || (e.fields && JSON.stringify(e.fields).toLowerCase().includes(needle))),
    );
  }, [entries, level, component, search]);

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [visible, follow]);

  return (
    <div className="p-2 sm:p-3">
      <Panel
        title="Logs"
        meta={`${quantity.format(visible.length)} of ${quantity.format(entries.length)} lines · also in data/engine/logs/`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="log-level">
              Minimum level
            </label>
            <select id="log-level" value={level} onChange={(e) => setLevel(e.target.value as LogLevel)} className={selectClass}>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l === "debug" ? "All levels" : `${l} and above`}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="log-component">
              Component
            </label>
            <select id="log-component" value={component} onChange={(e) => setComponent(e.target.value)} className={selectClass}>
              <option value="">All components</option>
              {components.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="log-search">
              Search
            </label>
            <input
              id="log-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              className={`${selectClass} w-36`}
            />
            <label className="flex items-center gap-1.5 text-label text-muted">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              Follow
            </label>
          </div>
        }
        flush
      >
        <div
          ref={scroller}
          onWheel={(e) => {
            if (e.deltaY < 0) setFollow(false);
          }}
          className="h-[calc(100dvh-11rem)] min-h-64 overflow-y-auto font-mono text-label"
        >
          {visible.length === 0 ? (
            <div className="p-3">
              <EmptyState>{entries.length === 0 ? "No log lines yet." : "No lines match the filters."}</EmptyState>
            </div>
          ) : (
            <ol>
              {visible.map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="flex gap-3 border-b border-line/50 px-3 py-0.5 hover:bg-raised/50">
                  <time className="shrink-0 text-muted tabular-nums" dateTime={new Date(entry.at).toISOString()}>
                    {istTime.format(new Date(entry.at))}
                  </time>
                  <span className={`w-11 shrink-0 uppercase ${LEVEL_STYLE[entry.level]}`}>{entry.level}</span>
                  <span className="w-28 shrink-0 truncate text-muted" title={entry.component}>
                    {entry.component}
                  </span>
                  <span className={`min-w-0 break-words ${LEVEL_STYLE[entry.level]}`}>
                    {entry.message}
                    {entry.fields && <span className="ml-2 text-muted">{JSON.stringify(entry.fields)}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Panel>
    </div>
  );
}

function Ago({ at, now }: { at: number; now: number }) {
  return <span>{formatAge(Math.max(0, now - at))} ago</span>;
}

function mb(value: number) {
  return `${Math.round(value / 1_048_576)} MB`;
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(2)} GB`;
}
