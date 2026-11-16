"use client";

// The Session tab: a trading day read back from the engine's journal. Everything here is computed
// by the engine from the raw frames on disk, so it shows what the recording holds, not what a
// page happened to receive. Today's view refreshes every 5 seconds while the tab is visible.

import type { HistogramData, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatAge } from "@/components/shell/freshness";
import { DataTable, EmptyState, Field, Panel, StatRow, Td } from "@/components/ui";
import type { EngineStatus, JournalSession, SessionInstrument } from "@/lib/engine/protocol";
import { compactNumber, istTime, price, quantity, signedPercent } from "@/lib/format";

const REFRESH_MS = 5_000;
const IST_OFFSET_SECONDS = 5.5 * 3600;

export type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: JournalSession };

export function SessionView({ status }: { status: EngineStatus | null }) {
  const today = status?.journal?.date ?? null;
  const days = useMemo(() => status?.journalDays.map((d) => d.date) ?? [], [status?.journalDays]);
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked ?? today ?? days[0] ?? null;
  const live = date !== null && date === today;
  const load = useJournalSession(date, live);

  return (
    <div className="grid gap-2 p-2 sm:p-3">
      <Panel
        title="Session from the journal"
        meta={
          load.state === "ready"
            ? `${quantity.format(load.data.file.records)} records · ${bytes(load.data.file.bytes)} read · built in ${load.data.readMs} ms${live ? " · refreshes every 5 s" : ""}`
            : undefined
        }
        action={
          <>
            <label className="sr-only" htmlFor="session-date">
              Day
            </label>
            <select
              id="session-date"
              value={date ?? ""}
              onChange={(e) => setPicked(e.target.value)}
              className="h-7 rounded-sm border border-line-strong bg-canvas px-2 text-body focus-visible:border-accent"
            >
              {days.length === 0 && <option value="">No recorded days</option>}
              {days.map((day) => (
                <option key={day} value={day}>
                  {day}
                  {day === today ? " (today)" : ""}
                </option>
              ))}
            </select>
          </>
        }
      >
        <p className="text-muted">
          Read back from <span className="font-mono">data/engine/journal/{date ?? "…"}.bin</span>: every raw Dhan frame decoded by the
          same parser the live feed uses. Changes are from the previous close (the last price recorded before 09:00 IST).
        </p>
      </Panel>

      {load.state === "loading" && (
        <Panel>
          <EmptyState>Reading the journal…</EmptyState>
        </Panel>
      )}
      {load.state === "error" && (
        <Panel>
          <p className="text-down">{load.message}</p>
        </Panel>
      )}
      {load.state === "ready" && <SessionBody data={load.data} live={live} now={status?.now ?? load.data.builtAt} />}
    </div>
  );
}

export function useJournalSession(date: string | null, live: boolean): Load {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function fetchOnce() {
      try {
        const response = await fetch(`/api/engine/v1/journal/session?date=${date}`, { signal: controller.signal, cache: "no-store" });
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) setLoad({ state: "error", message: body?.error ?? `The engine answered ${response.status}` });
        else setLoad({ state: "ready", data: body as JournalSession });
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) setLoad({ state: "error", message: (error as Error).message });
      }
      if (!cancelled && live) {
        timer = setTimeout(function next() {
          if (document.hidden) timer = setTimeout(next, REFRESH_MS);
          else void fetchOnce();
        }, REFRESH_MS);
      }
    }

    setLoad((current) => (current.state === "ready" && current.data.date === date ? current : { state: "loading" }));
    void fetchOnce();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [date, live]);

  return load;
}

function SessionBody({ data, live, now }: { data: JournalSession; live: boolean; now: number }) {
  const benchmark = data.instruments.find((i) => i.key === data.benchmark) ?? null;
  const equities = data.instruments.filter((i) => i.key.startsWith("NSE_EQ:") || i.key.startsWith("BSE_EQ:"));
  const indices = data.instruments.filter((i) => i.key.startsWith("IDX_I:"));
  const traded = equities.filter((i) => i.ltp !== null);
  const advancers = traded.filter((i) => i.reference !== null && i.ltp! > i.reference).length;
  const decliners = traded.filter((i) => i.reference !== null && i.ltp! < i.reference).length;
  const turnover = equities.reduce((sum, i) => sum + (i.vwap ?? 0) * (i.volume ?? 0), 0);
  const sessionMinutes = data.minutes.filter((m) => m.packets > 0);
  const sessionPackets = sessionMinutes.reduce((sum, m) => sum + m.packets, 0);
  const peak = sessionMinutes.reduce<(typeof data.minutes)[number] | null>((best, m) => (!best || m.packets > best.packets ? m : best), null);
  const totalPackets = Object.values(data.file.packets).reduce((a, b) => a + b, 0);
  const started = data.session && now < data.session.open;

  return (
    <>
      <Panel>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-6">
          <Field
            size="lg"
            label={benchmark?.symbol ?? "Benchmark"}
            value={
              benchmark?.ltp != null ? (
                <span>
                  {price.format(benchmark.ltp)} <Change value={benchmark.ltp} from={benchmark.reference} className="text-body" />
                </span>
              ) : (
                <span className="text-muted">{benchmark?.reference != null ? `Prev ${price.format(benchmark.reference)}` : "—"}</span>
              )
            }
          />
          <Field
            size="lg"
            label={`Breadth · ${equities.length} stocks`}
            value={
              traded.length ? (
                <span>
                  <span className="text-up">{advancers}</span> <span className="text-muted">/</span> <span className="text-down">{decliners}</span>
                  <span className="ml-1 text-label text-muted">up / down</span>
                </span>
              ) : (
                <span className="text-muted">No trades yet</span>
              )
            }
          />
          <Field size="lg" label="Turnover (VWAP × volume)" value={turnover > 0 ? `₹${compactNumber.format(turnover)}` : "—"} />
          <Field
            size="lg"
            label="Packets decoded"
            value={
              <span>
                {compactNumber.format(totalPackets)}
                <span className="ml-1 text-label text-muted">in {compactNumber.format(data.file.frames)} frames</span>
              </span>
            }
          />
          <Field
            size="lg"
            label="Feed rate in session"
            value={
              sessionMinutes.length ? (
                <span>
                  {(sessionPackets / (sessionMinutes.length * 60)).toFixed(1)}/s
                  {peak && <span className="ml-1 text-label text-muted">peak {(peak.packets / 60).toFixed(1)}/s at {hhmm(peak.at)}</span>}
                </span>
              ) : (
                <span className="text-muted">—</span>
              )
            }
          />
          <Field
            size="lg"
            label="Gaps"
            value={<span className={data.gaps.length ? "text-warn" : undefined}>{data.gaps.length === 0 ? "None" : data.gaps.length}</span>}
          />
        </dl>
        {live && data.file.lastFrameAt && (
          <p className="mt-3 text-label text-muted">Last frame on disk {formatAge(Math.max(0, now - data.file.lastFrameAt))} ago.</p>
        )}
      </Panel>

      <SessionChart data={data} symbol={benchmark?.symbol ?? data.benchmark} waiting={started ? "The session opens at 09:15 IST; bars appear from the first tick." : null} />

      <div className="grid gap-2 lg:grid-cols-3">
        <Movers title="Top gainers" rows={rank(traded, (i) => changeOf(i), "desc")} />
        <Movers title="Top losers" rows={rank(traded, (i) => changeOf(i), "asc")} />
        <Movers
          title="Most traded (₹)"
          rows={rank(traded, (i) => (i.vwap ?? 0) * (i.volume ?? 0), "desc")}
          value={(i) => `₹${compactNumber.format((i.vwap ?? 0) * (i.volume ?? 0))}`}
        />
      </div>

      <InstrumentTable rows={[...indices, ...equities]} minutes={data.minutes.length} now={now} />

      <FeedPanel data={data} />
    </>
  );
}

// --- Chart -------------------------------------------------------------------------------------

function SessionChart({ data, symbol, waiting }: { data: JournalSession; symbol: string; waiting: string | null }) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<{
    api: IChartApi;
    bars: ISeriesApi<"Candlestick">;
    breadth: ISeriesApi<"Histogram">;
    flow: ISeriesApi<"Histogram">;
    up: string;
    down: string;
    fitted: boolean;
  } | null>(null);
  const hasBars = data.minutes.some((m) => m.bar);

  useEffect(() => {
    const element = container.current;
    if (!element || !hasBars) return;
    let disposed = false;
    void import("lightweight-charts").then((charts) => {
      if (disposed) return;
      const theme = getComputedStyle(document.documentElement);
      const color = (name: string) => theme.getPropertyValue(name).trim();
      const api = charts.createChart(element, {
        autoSize: true,
        layout: {
          background: { type: charts.ColorType.Solid, color: color("--color-panel") },
          textColor: color("--color-muted"),
          fontFamily: getComputedStyle(document.body).fontFamily,
          fontSize: 11,
          panes: { separatorColor: color("--color-line-strong") },
        },
        grid: { vertLines: { color: color("--color-line") }, horzLines: { color: color("--color-line") } },
        rightPriceScale: { borderColor: color("--color-line") },
        timeScale: { borderColor: color("--color-line"), timeVisible: true, secondsVisible: false },
        crosshair: {
          vertLine: { color: color("--color-line-strong"), labelBackgroundColor: color("--color-raised") },
          horzLine: { color: color("--color-line-strong"), labelBackgroundColor: color("--color-raised") },
        },
      });
      const up = color("--color-up");
      const down = color("--color-down");
      const bars = api.addSeries(charts.CandlestickSeries, {
        upColor: up,
        downColor: down,
        wickUpColor: up,
        wickDownColor: down,
        borderVisible: false,
        priceFormat: { type: "custom", formatter: (v: number) => price.format(v) },
      });
      const breadth = api.addSeries(charts.HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: true }, 1);
      const flow = api.addSeries(
        charts.HistogramSeries,
        { color: color("--color-accent"), priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: true },
        2,
      );
      const panes = api.panes();
      panes[0].setStretchFactor(3);
      panes[1]?.setStretchFactor(1);
      panes[2]?.setStretchFactor(1);
      chart.current = { api, bars, breadth, flow, up, down, fitted: false };
      setSeries(data);
    });
    return () => {
      disposed = true;
      chart.current?.api.remove();
      chart.current = null;
    };
    // Built once per day shown; data updates go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBars, data.date]);

  function setSeries(d: JournalSession) {
    const c = chart.current;
    if (!c) return;
    const time = (at: number) => (at / 1000 + IST_OFFSET_SECONDS) as UTCTimestamp;
    c.bars.setData(d.minutes.flatMap((m) => (m.bar ? [{ time: time(m.at), open: m.bar[0], high: m.bar[1], low: m.bar[2], close: m.bar[3] }] : [])));
    c.breadth.setData(
      d.minutes.map((m): HistogramData<UTCTimestamp> => {
        const net = m.advancers - m.decliners;
        return { time: time(m.at), value: net, color: net >= 0 ? c.up : c.down };
      }),
    );
    c.flow.setData(d.minutes.map((m) => ({ time: time(m.at), value: m.packets })));
    if (!c.fitted) {
      c.api.timeScale().fitContent();
      c.fitted = true;
    }
  }

  useEffect(() => setSeries(data));

  return (
    <Panel title={`${symbol} · 1-minute bars built from journaled ticks`} meta="below: breadth (stocks up minus down) · packets per minute" flush>
      <div className="relative h-96">
        <div ref={container} className="absolute inset-0" />
        {!hasBars && (
          <div className="absolute inset-0 grid place-items-center px-4 text-center text-muted">
            {waiting ?? (data.session ? "No benchmark ticks were recorded during the session." : "Not a trading day: the file holds only off-session snapshots.")}
          </div>
        )}
      </div>
    </Panel>
  );
}

// --- Movers and table --------------------------------------------------------------------------

function changeOf(i: SessionInstrument) {
  return i.ltp !== null && i.reference ? (i.ltp - i.reference) / i.reference : null;
}

function rank(rows: SessionInstrument[], by: (i: SessionInstrument) => number | null, order: "asc" | "desc") {
  return rows
    .map((row) => ({ row, value: by(row) }))
    .filter((r): r is { row: SessionInstrument; value: number } => r.value !== null && (order === "asc" ? r.value < 0 : r.value > 0))
    .sort((a, b) => (order === "asc" ? a.value - b.value : b.value - a.value))
    .slice(0, 5)
    .map((r) => r.row);
}

function Movers({ title, rows, value }: { title: string; rows: SessionInstrument[]; value?: (i: SessionInstrument) => ReactNode }) {
  return (
    <Panel title={title}>
      {rows.length === 0 ? (
        <EmptyState>None yet.</EmptyState>
      ) : (
        <dl>
          {rows.map((i) => (
            <StatRow
              key={i.key}
              label={<span className="text-fg">{i.symbol}</span>}
              value={
                <span>
                  <span className="mr-2 text-muted">{price.format(i.ltp!)}</span>
                  {value ? value(i) : <Change value={i.ltp} from={i.reference} />}
                </span>
              }
            />
          ))}
        </dl>
      )}
    </Panel>
  );
}

type SortKey = "symbol" | "change" | "fromOpen" | "vsVwap" | "volume" | "turnover" | "pressure" | "packets";

const COLUMNS: { key: SortKey | null; label: string; align?: "left" | "right" }[] = [
  { key: "symbol", label: "Symbol", align: "left" },
  { key: null, label: "Today", align: "left" },
  { key: null, label: "LTP" },
  { key: "change", label: "Chg" },
  { key: "fromOpen", label: "From open" },
  { key: "vsVwap", label: "vs VWAP" },
  { key: null, label: "Day range", align: "left" },
  { key: "volume", label: "Volume" },
  { key: "turnover", label: "Turnover" },
  { key: "pressure", label: "Buy / sell qty" },
  { key: "packets", label: "Packets" },
  { key: null, label: "Last tick" },
];

const ratio = (a: number | null, b: number | null) => (a !== null && b ? (a - b) / b : null);

const SORTERS: Record<SortKey, (i: SessionInstrument) => number | string | null> = {
  symbol: (i) => i.symbol,
  change: changeOf,
  fromOpen: (i) => ratio(i.ltp, i.open),
  vsVwap: (i) => ratio(i.ltp, i.vwap),
  volume: (i) => i.volume,
  turnover: (i) => (i.vwap !== null && i.volume !== null ? i.vwap * i.volume : null),
  pressure: (i) => (i.buyQty !== null && i.sellQty !== null && i.buyQty + i.sellQty > 0 ? i.buyQty / (i.buyQty + i.sellQty) : null),
  packets: (i) => i.packets,
};

function InstrumentTable({ rows, minutes, now }: { rows: SessionInstrument[]; minutes: number; now: number }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "change", desc: true });
  const sorted = useMemo(() => {
    const get = SORTERS[sort.key];
    return [...rows].sort((a, b) => {
      // Indices stay on top; missing values sink.
      const ia = a.key.startsWith("IDX_I:") ? 0 : 1;
      const ib = b.key.startsWith("IDX_I:") ? 0 : 1;
      if (ia !== ib) return ia - ib;
      const va = get(a);
      const vb = get(b);
      if (va === null || vb === null) return va === null ? (vb === null ? 0 : 1) : -1;
      const order = typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
      return sort.desc ? -order : order;
    });
  }, [rows, sort]);

  return (
    <Panel title="Instruments" meta={`${rows.length} recorded · click a heading to sort`} flush>
      <DataTable
        caption="Instruments recorded in the journal"
        minWidth="min-w-[72rem]"
        head={
          <tr className="border-b border-line text-label tracking-wider text-muted uppercase">
            {COLUMNS.map((column) => (
              <th
                key={column.label}
                scope="col"
                aria-sort={column.key && sort.key === column.key ? (sort.desc ? "descending" : "ascending") : undefined}
                className={`h-8 px-3 font-medium whitespace-nowrap ${column.align === "left" ? "text-left" : "text-right"}`}
              >
                {column.key ? (
                  <button
                    type="button"
                    className="uppercase hover:text-fg"
                    onClick={() => setSort((s) => ({ key: column.key!, desc: s.key === column.key ? !s.desc : column.key !== "symbol" }))}
                  >
                    {column.label}
                    {sort.key === column.key && <span aria-hidden> {sort.desc ? "↓" : "↑"}</span>}
                  </button>
                ) : (
                  column.label
                )}
              </th>
            ))}
          </tr>
        }
      >
        {sorted.map((i) => {
          const turnover = SORTERS.turnover(i) as number | null;
          return (
            <tr key={i.key}>
              <Td>
                <span className="font-medium" title={i.name ?? i.key}>
                  {i.symbol}
                </span>
                <span className="ml-1.5 text-label text-muted">{i.mode}</span>
              </Td>
              <Td>
                <Spark closes={i.closes} reference={i.reference} minutes={minutes} />
              </Td>
              <Td numeric>{i.ltp !== null ? price.format(i.ltp) : <span className="text-muted">{i.reference !== null ? `prev ${price.format(i.reference)}` : "—"}</span>}</Td>
              <Td numeric>
                <Change value={i.ltp} from={i.reference} />
              </Td>
              <Td numeric>
                <Change value={i.ltp} from={i.open} />
              </Td>
              <Td numeric>
                <Change value={i.ltp} from={i.vwap} />
              </Td>
              <Td>
                <RangeBar low={i.low} high={i.high} ltp={i.ltp} vwap={i.vwap} />
              </Td>
              <Td numeric>{i.volume !== null ? compactNumber.format(i.volume) : <Dash />}</Td>
              <Td numeric>{turnover ? `₹${compactNumber.format(turnover)}` : <Dash />}</Td>
              <Td numeric>
                {i.buyQty !== null && i.sellQty !== null ? (
                  <span>
                    <span className="text-up">{compactNumber.format(i.buyQty)}</span>
                    <span className="text-muted"> / </span>
                    <span className="text-down">{compactNumber.format(i.sellQty)}</span>
                  </span>
                ) : (
                  <Dash />
                )}
              </Td>
              <Td numeric>{quantity.format(i.packets)}</Td>
              <Td numeric className="text-muted">
                {i.lastAt ? <span title={istTime.format(new Date(i.lastAt))}>{formatAge(Math.max(0, now - i.lastAt))} ago</span> : <Dash />}
              </Td>
            </tr>
          );
        })}
      </DataTable>
    </Panel>
  );
}

function Spark({ closes, reference, minutes }: { closes: (number | null)[]; reference: number | null; minutes: number }) {
  const points = closes.flatMap((v, x) => (v === null ? [] : [[x, v] as const]));
  if (points.length < 2) return <span className="inline-block h-5 w-24 text-label text-muted">{points.length ? "" : "—"}</span>;
  const values = points.map(([, v]) => v).concat(reference ?? []);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 96;
  const height = 20;
  const sx = (x: number) => (x / Math.max(1, minutes - 1)) * width;
  const sy = (v: number) => height - 1 - ((v - min) / span) * (height - 2);
  const last = points[points.length - 1][1];
  const tone = reference === null ? "var(--color-accent)" : last >= reference ? "var(--color-up)" : "var(--color-down)";
  return (
    <svg width={width} height={height} className="block" role="img" aria-label={`Price through the session, last ${price.format(last)}`}>
      {reference !== null && (
        <line x1={0} x2={width} y1={sy(reference)} y2={sy(reference)} stroke="var(--color-line-strong)" strokeDasharray="2 2" strokeWidth={1} />
      )}
      <polyline fill="none" stroke={tone} strokeWidth={1.5} strokeLinejoin="round" points={points.map(([x, v]) => `${sx(x).toFixed(1)},${sy(v).toFixed(1)}`).join(" ")} />
    </svg>
  );
}

/** Where the last price sits in the day's low–high range; the tick marks VWAP. */
function RangeBar({ low, high, ltp, vwap }: { low: number | null; high: number | null; ltp: number | null; vwap: number | null }) {
  if (low === null || high === null || ltp === null) return <Dash />;
  const span = high - low || 1;
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - low) / span) * 100))}%`;
  return (
    <span className="inline-flex items-center gap-2" title={`Low ${price.format(low)} · high ${price.format(high)}${vwap ? ` · VWAP ${price.format(vwap)}` : ""}`}>
      <span className="text-label text-muted tabular-nums">{price.format(low)}</span>
      <span className="relative inline-block h-1.5 w-20 rounded-full bg-line-strong">
        {vwap !== null && <span className="absolute top-[-3px] h-3 w-px bg-muted" style={{ left: at(vwap) }} />}
        <span className="absolute top-[-1.5px] size-2.5 -translate-x-1/2 rounded-full bg-accent" style={{ left: at(ltp) }} />
      </span>
      <span className="text-label text-muted tabular-nums">{price.format(high)}</span>
    </span>
  );
}

// --- Feed and journal --------------------------------------------------------------------------

function FeedPanel({ data }: { data: JournalSession }) {
  const { file } = data;
  return (
    <div className="grid gap-2 lg:grid-cols-2">
      <Panel title="What the journal holds">
        <dl>
          <StatRow label="Records" value={`${quantity.format(file.records)} (${quantity.format(file.frames)} frames, ${quantity.format(file.controls)} events)`} />
          <StatRow label="Packets by kind" value={entries(file.packets)} />
          <StatRow label="Events by kind" value={entries(file.events)} />
          <StatRow
            label="Frames from – to"
            value={file.firstFrameAt && file.lastFrameAt ? `${istTime.format(new Date(file.firstFrameAt))} – ${istTime.format(new Date(file.lastFrameAt))} IST` : "—"}
          />
          <StatRow label="Session minutes with data" value={`${data.minutes.filter((m) => m.packets > 0).length} of ${data.minutes.length}`} />
          {data.runs.map((run, index) => (
            <StatRow
              key={run.startedAt}
              label={index === 0 ? "Engine runs" : ""}
              value={
                <span>
                  {istTime.format(new Date(run.startedAt))} – {run.stoppedAt ? `${istTime.format(new Date(run.stoppedAt))} (${run.reason})` : "running"}
                  <span className="ml-1.5 font-mono text-label text-muted">{run.version}</span>
                </span>
              }
            />
          ))}
        </dl>
      </Panel>
      <Panel title="Gaps and socket states" flush>
        {data.gaps.length === 0 && data.states.length === 0 ? (
          <div className="p-3">
            <EmptyState>No gaps or state changes recorded.</EmptyState>
          </div>
        ) : (
          <DataTable caption="Gaps and socket state changes" columns={["Time", { label: "Event", align: "left" }, "Socket"]}>
            {[
              ...data.gaps.map((g) => ({ at: g.from, text: <span className="text-warn">gap ({g.reason}) for {formatAge(g.to - g.from)}</span>, connection: g.connection })),
              ...data.states.map((s) => ({ at: s.at, text: <span>{s.state}{s.reason && <span className="text-muted"> · {s.reason}</span>}</span>, connection: s.connection })),
            ]
              .sort((a, b) => b.at - a.at)
              .slice(0, 30)
              .map((row, index) => (
                <tr key={`${row.at}-${index}`}>
                  <Td numeric>{istTime.format(new Date(row.at))}</Td>
                  <Td className="whitespace-normal">{row.text}</Td>
                  <Td numeric>{row.connection || "—"}</Td>
                </tr>
              ))}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}

// --- Small pieces ------------------------------------------------------------------------------

function Change({ value, from, className = "" }: { value: number | null; from: number | null; className?: string }) {
  const change = ratio(value, from);
  if (change === null) return <Dash />;
  const tone = change > 0 ? "text-up" : change < 0 ? "text-down" : "text-muted";
  return <span className={`tabular-nums ${tone} ${className}`}>{signedPercent.format(change)}</span>;
}

function Dash() {
  return <span className="text-muted">—</span>;
}

function entries(record: Record<string, number>) {
  const list = Object.entries(record).sort(([, a], [, b]) => b - a);
  return list.length ? list.map(([kind, count]) => `${kind} ${quantity.format(count)}`).join(" · ") : "—";
}

function hhmm(at: number) {
  return istTime.format(new Date(at)).slice(0, 5);
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(2)} GB`;
}
