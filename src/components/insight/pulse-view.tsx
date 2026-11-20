"use client";

// NIFTY Pulse: a live read of the market built from the engine's journal. The engine decodes the
// day's raw Dhan frames (refreshed every 5 seconds); computePulse() turns that into attribution,
// evidence, a shadow decision and a scorecard for each candidate signal. Nothing here trades.

import type { IChartApi, IPriceLine, ISeriesApi, ISeriesMarkersPluginApi, UTCTimestamp } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useJournalSession } from "@/components/engine/session-view";
import { useEngineTelemetry } from "@/components/engine/use-engine-telemetry";
import { OptionReplay } from "@/components/insight/option-replay";
import { OrderBook } from "@/components/insight/order-book";
import { PredictionBoard } from "@/components/insight/prediction-board";
import { formatAge } from "@/components/shell/freshness";
import { EmptyState, Field, Panel } from "@/components/ui";
import { INDEX_CONSTITUENTS } from "@/lib/index-constituents";
import {
  computePulse,
  HORIZON,
  HORIZONS,
  RECENT_MINUTES,
  wilson,
  type Contribution,
  type Pulse,
  type PulsePoint,
  type SignalEvent,
  type SignalReport,
  type SignalStats,
} from "@/lib/insight/pulse";
import { impliedMove } from "@/lib/insight/derivatives";
import { istTime, price, signedPercent } from "@/lib/format";

const IST_OFFSET_SECONDS = 5.5 * 3600;
const CONSTITUENTS = INDEX_CONSTITUENTS.NIFTY.map((c) => ({ key: `NSE_EQ:${c.securityId}`, symbol: c.symbol, sector: c.sector, prior: c.mcapShare }));

const STATUS_TOPIC = ["status"] as const;

function istToday() {
  return new Date(Date.now() + IST_OFFSET_SECONDS * 1000).toISOString().slice(0, 10);
}

export function PulseView() {
  const [today] = useState(istToday);
  // While the engine replays a recorded day, the pulse follows the replay as if it were live:
  // that day, as far as the replay has reached, timed on the replay's clock.
  const telemetry = useEngineTelemetry(STATUS_TOPIC);
  const replay = telemetry.status?.replay ?? null;
  const known = telemetry.status !== null || telemetry.link === "offline" || telemetry.link === "unconfigured";
  const date = known ? (replay?.date ?? today) : null;
  const load = useJournalSession(date, true);
  const pulse = useMemo(() => (load.state === "ready" ? computePulse(load.data, CONSTITUENTS) : null), [load]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="grid gap-2 p-2 sm:p-3">
      {load.state === "loading" && (
        <Panel>
          <EmptyState>Reading today&apos;s journal from the engine…</EmptyState>
        </Panel>
      )}
      {load.state === "error" && (
        <Panel>
          <p className="text-down">{load.message}</p>
          <p className="mt-1 text-muted">The pulse needs today&apos;s journal ({date}). It exists once the engine has run today.</p>
        </Panel>
      )}
      {load.state === "ready" && !pulse && (
        <Panel>
          <EmptyState>No NIFTY ticks in today&apos;s session yet. The pulse starts after 09:16 IST.</EmptyState>
        </Panel>
      )}
      {pulse && (
        <PulseBody pulse={pulse} age={Math.max(0, (replay?.at ?? now) - pulse.asOf)} replay={replay?.date ?? null} replayAt={replay?.at ?? null} />
      )}
    </div>
  );
}

function PulseBody({ pulse, age, replay, replayAt }: { pulse: Pulse; age: number; replay: string | null; replayAt: number | null }) {
  const { nifty, verdict } = pulse;
  const tone = verdict.stance === "bullish" ? "text-up" : verdict.stance === "bearish" ? "text-down" : "text-warn";
  const stale = age > 15_000;
  const lab = useLabState();
  const focused = pulse.signals.find((s) => s.id === lab.focus);
  const focus = useMemo<LabFocus | null>(
    () =>
      focused
        ? { id: focused.id, name: focused.name, kind: focused.kind, horizon: lab.horizon, cost: lab.cost, events: statsAt(focused, lab.horizon).events }
        : null,
    [focused, lab.horizon, lab.cost],
  );

  return (
    <>
      <Panel
        title="NIFTY pulse"
        meta={
          <span>
            <span className={stale || replay ? "text-warn" : "text-up"}>●</span>{" "}
            {replay ? `Replay of ${replay}${stale ? ", not moving" : ""}` : stale ? "Not updating" : "Live"} · last tick {formatAge(age)} ago ·
            refreshes every 5 s · minute {pulse.minute + 1} of the session
          </span>
        }
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-2xl font-semibold tabular-nums">{price.format(nifty.ltp)}</span>
              <span className={`text-lg tabular-nums ${nifty.points >= 0 ? "text-up" : "text-down"}`}>
                {signedPts(nifty.points)} ({signedPercent.format(nifty.change)})
              </span>
              {nifty.recentPoints !== null && (
                <span className="text-label text-muted tabular-nums">
                  {signedPts(nifty.recentPoints)} in {RECENT_MINUTES} min
                </span>
              )}
            </div>
            <p className={`mt-3 text-lg leading-6 font-semibold ${tone}`}>{verdict.headline}</p>
            <p className="mt-1 text-body">{verdict.action}</p>
            <p className="mt-3 text-label text-muted">
              Evidence score {pulse.score > 0 ? "+" : ""}
              {pulse.score}: ±3 or beyond takes a side. Shadow mode: the engine records what it would do and places no orders.
            </p>
            {nifty.high !== null && nifty.low !== null && (
              <DayRange low={nifty.low} high={nifty.high} ltp={nifty.ltp} open={nifty.open} reference={nifty.reference} lowAt={nifty.lowAt} highAt={nifty.highAt} />
            )}
          </div>
          <ul className="grid content-start gap-1.5" aria-label="Evidence">
            {pulse.evidence.map((e) => (
              <li key={e.label} className="flex items-baseline gap-2">
                <Vote vote={e.vote} />
                <span className="min-w-0">
                  <span className="font-medium">{e.label}</span> <span className="text-muted">{e.detail}</span>
                </span>
              </li>
            ))}
            {pulse.signals.filter((s) => s.kind === "single").map((s) => (
              <li key={s.id} className="flex items-baseline gap-2">
                <Vote vote={s.vote} />
                <span className="min-w-0">
                  <span className="font-medium">{s.name}</span> <span className="text-muted">{s.display}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Panel>

      {pulse.derivatives && <FuturesOptions pulse={pulse} />}
      <OrderBook />
      <PulseChart pulse={pulse} focus={focus} />
      <SignalLab pulse={pulse} lab={lab} />
      <PredictionBoard />
      <OptionReplay pulse={pulse} focus={focus} horizon={lab.horizon} onSelect={lab.setFocus} replayAt={replayAt} />
      <HowItWorks pulse={pulse} />

      <div className="grid gap-2 lg:grid-cols-2">
        <Movers pulse={pulse} />
        <Sectors pulse={pulse} />
      </div>
    </>
  );
}

// --- Futures and options ----------------------------------------------------------------------------

const lotsFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0, signDisplay: "exceptZero" });
const POSITIONING: Record<string, string> = {
  "long build-up": "long build-up: price up, positions added",
  "short build-up": "short build-up: price down, positions added",
  "short covering": "short covering: price up, positions closed",
  "long unwinding": "long unwinding: price down, positions closed",
};

/** What NIFTY's near-month future and nearest option expiry say now, in plain words. Shown when the day has them (from 18 November 2026). */
function FuturesOptions({ pulse }: { pulse: Pulse }) {
  const f = pulse.derivatives?.future ?? null;
  const o = pulse.derivatives?.options ?? null;
  const c = pulse.derivatives?.chain ?? null;
  const v = pulse.volatility;
  const pct = (value: number | null, digits = 2) => (value === null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`);
  const side = (flow: number | null) => (flow === null ? "—" : `${flow >= 0 ? "buyers" : "sellers"} ${Math.round(((1 + Math.abs(flow)) / 2) * 100)}%`);
  const priced = o ? impliedMove(o.straddle, o.minutesToExpiry, RECENT_MINUTES) : null;
  const actual = v.minuteMove === null ? null : v.minuteMove * Math.sqrt(RECENT_MINUTES);
  const rows: [string, ReactNode][] = [];
  if (f) {
    rows.push(
      [f.name, <>{price.format(f.price)}, {f.basis === null ? "" : `${signedPts(f.basis)} pts over NIFTY`}{f.basisChange15 === null ? "" : ` (${signedPts(f.basisChange15)} in 15 min)`}{f.vsVwap === null ? "" : `, ${signedPts(f.vsVwap)} from its VWAP`}</>],
      ["Open interest", <>{pct(f.oiChange15Pct)} in 15 min, {pct(f.oiChangeDayPct)} today{f.positioning15 ? ` · ${POSITIONING[f.positioning15]}` : ""}</>],
      ["Who is trading", <>{side(f.flow5)} of the last 5 min, {side(f.flow15)} of 15 min{f.netLots15 === null ? "" : ` (${lotsFormat.format(f.netLots15)} lots net)`}</>],
    );
    if (f.book20Imbalance !== null) {
      const lean = (value: number | null) => (value === null ? "—" : `${value >= 0 ? "bids" : "asks"} ${Math.round(((1 + Math.abs(value)) / 2) * 100)}%`);
      rows.push(["Order book, 20 levels", <>{lean(f.book20Imbalance)} of the quantity waiting, {lean(f.book20OrdersImbalance)} of the orders{f.spread === null ? "" : ` · spread ${f.spread.toFixed(2)} pts`}</>]);
    }
  }
  if (o) {
    rows.push(
      [`Options, ${o.expiry.slice(5)} expiry`, <>put/call open interest near the money {o.pcr?.toFixed(2) ?? "—"} (open {o.pcrAtOpen?.toFixed(2) ?? "—"}, 15 min ago {o.pcr15?.toFixed(2) ?? "—"})</>],
      ["Lots written near the money", <>today calls {o.callOiChangeDayLots === null ? "—" : lotsFormat.format(o.callOiChangeDayLots)}, puts {o.putOiChangeDayLots === null ? "—" : lotsFormat.format(o.putOiChangeDayLots)} · last 15 min calls {o.callOiChange15Lots === null ? "—" : lotsFormat.format(o.callOiChange15Lots)}, puts {o.putOiChange15Lots === null ? "—" : lotsFormat.format(o.putOiChange15Lots)}</>],
      ["Biggest strikes", <>calls at {o.callWall ? `${price.format(o.callWall.strike)} (${signedPts(o.callWall.points)} pts)` : "—"}, puts at {o.putWall ? `${price.format(o.putWall.strike)} (${signedPts(o.putWall.points)} pts)` : "—"}{o.maxPain === null ? "" : ` · max pain ${price.format(o.maxPain)}`}</>],
    );
  }
  if (c) {
    const points = (n: number | null, digits = 2) => (n === null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`);
    rows.push(
      [
        `Option chain, ${c.expiry.slice(5)} expiry`,
        <>
          volatility {c.ivPct === null ? "—" : `${c.ivPct.toFixed(1)}%`} ({points(c.ivChange15)} in 15 min, {points(c.ivChangeSinceFirst)} today)
          {c.nextIvPct === null ? "" : ` · ${c.nextExpiry?.slice(5)} expiry ${c.nextIvPct.toFixed(1)}%`} · puts 1% out cost {points(c.skewPct, 1)} points of volatility more than calls 1% out
          {c.ageMinutes > 2 ? ` · snapshot ${c.ageMinutes} min old` : ""}
        </>,
      ],
      [
        "Every strike",
        <>
          put/call open interest {c.pcr?.toFixed(2) ?? "—"} · today calls {c.callOiChangeDayLots === null ? "—" : lotsFormat.format(c.callOiChangeDayLots)}, puts{" "}
          {c.putOiChangeDayLots === null ? "—" : lotsFormat.format(c.putOiChangeDayLots)} lots · most calls at {c.callWall ? `${price.format(c.callWall.strike)} (${signedPts(c.callWall.points)} pts)` : "—"}, puts at{" "}
          {c.putWall ? `${price.format(c.putWall.strike)} (${signedPts(c.putWall.points)} pts)` : "—"}
        </>,
      ],
    );
  }
  rows.push([
    `Typical ${RECENT_MINUTES}-min move`,
    <>
      {priced === null ? "" : `options price ±${priced.toFixed(0)} pts`}
      {priced !== null && actual !== null ? ", " : ""}
      {actual === null ? "" : `NIFTY has been moving ±${actual.toFixed(0)}`} · India VIX {v.vix?.toFixed(2) ?? "—"} ({pct(v.vixChangePct)})
      {o?.ivChangeSinceOpenPct == null ? "" : `, option volatility ${pct(o.ivChangeSinceOpenPct, 1)} since the open`}
    </>,
  ]);
  return (
    <Panel title="Futures and options" meta="NIFTY's near-month future and nearest expiry, as recorded today; also sent to the decision API">
      <dl className="grid gap-x-4 gap-y-1 text-body sm:grid-cols-[auto_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

// --- Day range ---------------------------------------------------------------------------------

function DayRange(props: { low: number; high: number; ltp: number; open: number | null; reference: number; lowAt: number | null; highAt: number | null }) {
  const { low, high, ltp, open, reference } = props;
  const min = Math.min(low, reference);
  const max = Math.max(high, reference);
  const at = (v: number) => `${((v - min) / (max - min || 1)) * 100}%`;
  return (
    <div className="mt-4">
      <div className="relative h-8">
        <div className="absolute top-3 h-1.5 rounded-full bg-line-strong" style={{ left: at(low), right: `calc(100% - ${at(high)})` }} />
        <Tick at={at(reference)} label="prev close" />
        {open !== null && <Tick at={at(open)} label="open" />}
        <span
          className="absolute top-[9px] size-3.5 -translate-x-1/2 rounded-full border-2 border-panel bg-accent"
          style={{ left: at(ltp) }}
          title={`Now ${price.format(ltp)}`}
        />
      </div>
      <div className="flex justify-between text-label text-muted tabular-nums">
        <span>
          Low {price.format(low)}
          {props.lowAt && ` at ${hhmm(props.lowAt)}`}
        </span>
        <span>
          High {price.format(high)}
          {props.highAt && ` at ${hhmm(props.highAt)}`}
        </span>
      </div>
    </div>
  );
}

function Tick({ at, label }: { at: string; label: string }) {
  return (
    <span className="absolute top-0 -translate-x-1/2 text-center" style={{ left: at }}>
      <span className="block h-[22px] w-px bg-muted mx-auto" />
      <span className="sr-only">{label}</span>
      <span className="absolute top-[-2px] left-1.5 text-[10px] whitespace-nowrap text-muted">{label}</span>
    </span>
  );
}

// --- Chart -------------------------------------------------------------------------------------

type ChartType = "line" | "candles";
const TIMEFRAMES = [1, 3, 5, 15] as const;
const PREFS_KEY = "pulse.chart";

interface ChartPrefs {
  type: ChartType;
  timeframe: number;
  basket: boolean;
}

function readPrefs(): ChartPrefs {
  const fallback: ChartPrefs = { type: "candles", timeframe: 1, basket: true };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<ChartPrefs> | null;
    return {
      type: saved?.type === "line" ? "line" : saved?.type === "candles" ? "candles" : fallback.type,
      timeframe: TIMEFRAMES.includes(saved?.timeframe as 1) ? saved!.timeframe! : fallback.timeframe,
      basket: typeof saved?.basket === "boolean" ? saved.basket : fallback.basket,
    };
  } catch {
    return fallback;
  }
}

/** Minutes grouped into bars of `size` minutes from 09:15; state (basket, breadth, votes) as at each bar's end. */
interface Bucket extends Omit<PulsePoint, "bar"> {
  bar: [number, number, number, number] | null;
  minutes: number;
}

function bucketize(series: PulsePoint[], size: number): Bucket[] {
  const out: Bucket[] = [];
  for (let i = 0; i < series.length; i += size) {
    const chunk = series.slice(i, i + size);
    const bars = chunk.flatMap((m) => (m.bar ? [m.bar] : []));
    const last = chunk[chunk.length - 1];
    out.push({
      ...last,
      at: chunk[0].at,
      bar: bars.length ? [bars[0][0], Math.max(...bars.map((b) => b[1])), Math.min(...bars.map((b) => b[2])), bars[bars.length - 1][3]] : null,
      minutes: chunk.length,
    });
  }
  return out;
}

/** `#rrggbb` (or `#rgb`) as rgba; the chart library parses colours itself and may not know newer CSS forms. */
function withAlpha(color: string, alpha: number) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const chartTime = (at: number) => (at / 1000 + IST_OFFSET_SECONDS) as UTCTimestamp;

interface ChartRefs {
  api: IChartApi;
  line: ISeriesApi<"Line">;
  candles: ISeriesApi<"Candlestick">;
  basket: ISeriesApi<"Line">;
  breadth: ISeriesApi<"Baseline">;
  votes: ISeriesApi<"Histogram">;
  lineMarkers: ISeriesMarkersPluginApi<UTCTimestamp>;
  candleMarkers: ISeriesMarkersPluginApi<UTCTimestamp>;
  priceLines: { series: ISeriesApi<"Line"> | ISeriesApi<"Candlestick">; line: IPriceLine; key: string }[];
  colors: Record<"up" | "down" | "upSoft" | "downSoft" | "hit" | "miss" | "muted" | "fg", string>;
  fitted: number | null;
}

function PulseChart({ pulse, focus }: { pulse: Pulse; focus: LabFocus | null }) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<ChartRefs | null>(null);
  const [ready, setReady] = useState(false);
  const [prefs, setPrefsState] = useState<ChartPrefs>(readPrefs);
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  const [tip, setTip] = useState<TipPlace | null>(null);
  /** Where each firing arrow is drawn: its bar's time and the price it hangs from. */
  const anchors = useRef(new Map<string, { time: UTCTimestamp; price: number; below: boolean }>());
  const setPrefs = (change: Partial<ChartPrefs>) =>
    setPrefsState((current) => {
      const next = { ...current, ...change };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // Storage is a convenience; the chart works without it.
      }
      return next;
    });

  const buckets = useMemo(() => bucketize(pulse.series, prefs.timeframe), [pulse.series, prefs.timeframe]);
  const singles = pulse.signals.filter((s) => s.kind === "single");

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let disposed = false;
    void import("lightweight-charts").then((charts) => {
      if (disposed) return;
      const theme = getComputedStyle(document.documentElement);
      const color = (name: string) => theme.getPropertyValue(name).trim();
      const soft = (name: string) => withAlpha(color(name), 0.45);
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
          mode: charts.CrosshairMode.Normal,
          vertLine: { color: color("--color-line-strong"), labelBackgroundColor: color("--color-raised") },
          horzLine: { color: color("--color-line-strong"), labelBackgroundColor: color("--color-raised") },
        },
      });
      const format = { type: "custom" as const, formatter: (v: number) => price.format(v) };
      const up = color("--color-up");
      const down = color("--color-down");
      const basket = api.addSeries(charts.LineSeries, {
        color: color("--color-muted"),
        lineWidth: 2,
        lineStyle: charts.LineStyle.Dashed,
        priceFormat: format,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      const line = api.addSeries(charts.LineSeries, { color: color("--color-accent"), lineWidth: 2, priceFormat: format });
      const candles = api.addSeries(charts.CandlestickSeries, {
        upColor: up,
        downColor: down,
        wickUpColor: up,
        wickDownColor: down,
        borderVisible: false,
        priceFormat: format,
      });
      const breadth = api.addSeries(
        charts.BaselineSeries,
        {
          baseValue: { type: "price", price: 0 },
          topLineColor: up,
          bottomLineColor: down,
          topFillColor1: soft("--color-up"),
          topFillColor2: withAlpha(up, 0),
          bottomFillColor1: withAlpha(down, 0),
          bottomFillColor2: soft("--color-down"),
          lineWidth: 2,
          priceFormat: { type: "custom", formatter: (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(0)}` },
          priceLineVisible: false,
        },
        1,
      );
      const votes = api.addSeries(
        charts.HistogramSeries,
        { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "custom", formatter: (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(0)}` } },
        2,
      );
      const panes = api.panes();
      panes[0].setStretchFactor(5);
      panes[1]?.setStretchFactor(1.6);
      panes[2]?.setStretchFactor(1.2);
      // Pin the card to the arrow itself, not the pointer, so it sits beside what it explains.
      const placeTip = (id: string, point: { x: number; y: number } | undefined): TipPlace | null => {
        const anchor = anchors.current.get(id);
        const series = chart.current?.candles.options().visible ? chart.current.candles : chart.current?.line;
        const x = anchor ? api.timeScale().timeToCoordinate(anchor.time) : null;
        const y = anchor && series ? series.priceToCoordinate(anchor.price) : null;
        const ax = x ?? point?.x;
        // The arrow hangs about 14 px below a long bar's low or above a short bar's high.
        const ay = y !== null && anchor ? y + (anchor.below ? 14 : -14) : point?.y;
        if (!Number.isFinite(ax) || !Number.isFinite(ay)) return null;
        return { id, x: ax!, y: ay!, width: element.clientWidth, height: element.clientHeight };
      };
      api.subscribeCrosshairMove((param) => {
        setHoverAt(typeof param.time === "number" ? param.time : null);
        // The chart reports the marker under the pointer by the id each firing marker carries.
        const id = typeof param.hoveredObjectId === "string" && param.hoveredObjectId.startsWith("firing:") ? param.hoveredObjectId : null;
        setTip(id ? placeTip(id, param.point) : null);
      });
      chart.current = {
        api,
        line,
        candles,
        basket,
        breadth,
        votes,
        lineMarkers: charts.createSeriesMarkers(line, []) as ISeriesMarkersPluginApi<UTCTimestamp>,
        candleMarkers: charts.createSeriesMarkers(candles, []) as ISeriesMarkersPluginApi<UTCTimestamp>,
        priceLines: [],
        colors: {
          up,
          down,
          upSoft: soft("--color-up"),
          downSoft: soft("--color-down"),
          hit: color("--color-accent"),
          miss: color("--color-muted"),
          muted: color("--color-muted"),
          fg: color("--color-fg"),
        },
        fitted: null,
      };
      setReady(true);
    });
    return () => {
      disposed = true;
      chart.current?.api.remove();
      chart.current = null;
    };
  }, []);

  // Data, chart type, timeframe and markers. Runs on new data or a changed control, not on hover.
  useEffect(() => {
    const c = chart.current;
    if (!c || !ready) return;
    const candlesOn = prefs.type === "candles";
    c.candles.applyOptions({ visible: candlesOn });
    c.line.applyOptions({ visible: !candlesOn });
    c.basket.applyOptions({ visible: prefs.basket });

    c.candles.setData(buckets.flatMap((b) => (b.bar ? [{ time: chartTime(b.at), open: b.bar[0], high: b.bar[1], low: b.bar[2], close: b.bar[3] }] : [])));
    c.line.setData(buckets.flatMap((b) => (b.nifty !== null ? [{ time: chartTime(b.at), value: b.nifty }] : [])));
    c.basket.setData(buckets.flatMap((b) => (b.basket !== null ? [{ time: chartTime(b.at), value: b.basket }] : [])));
    c.breadth.setData(buckets.map((b) => ({ time: chartTime(b.at), value: b.advancers - b.decliners })));
    c.votes.setData(
      buckets.map((b) => ({
        time: chartTime(b.at),
        value: b.composite,
        color: b.composite >= 2 ? c.colors.up : b.composite === 1 ? c.colors.upSoft : b.composite <= -2 ? c.colors.down : c.colors.downSoft,
      })),
    );

    // Previous close and today's open, on whichever price series is showing.
    for (const p of c.priceLines) p.series.removePriceLine(p.line);
    c.priceLines = [];
    const target = candlesOn ? c.candles : c.line;
    const levels: [string, number | null, string][] = [
      ["prev close", pulse.nifty.reference, c.colors.muted],
      ["open", pulse.nifty.open, c.colors.fg],
    ];
    for (const [title, value, lineColor] of levels) {
      if (value === null) continue;
      const line = target.createPriceLine({ price: value, color: lineColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title });
      c.priceLines.push({ series: target, line, key: title });
    }

    // Firings of the chosen signal, on the bar that holds their minute.
    const open = pulse.series[0]?.at ?? 0;
    anchors.current.clear();
    const byTime = new Map(buckets.map((b) => [b.at, b]));
    const markers = (focus?.events ?? []).map((e) => {
      const minute = Math.round((e.at - open) / 60_000);
      const bucketAt = open + Math.floor(minute / prefs.timeframe) * prefs.timeframe * 60_000;
      const hit = e.outcome !== 0 && Math.sign(e.outcome) === e.vote;
      const bar = byTime.get(bucketAt);
      const level = candlesOn && bar?.bar ? (e.vote > 0 ? bar.bar[2] : bar.bar[1]) : (bar?.nifty ?? bar?.bar?.[3] ?? null);
      if (level !== null) anchors.current.set(firingId(e), { time: chartTime(bucketAt), price: level, below: e.vote > 0 });
      return {
        id: firingId(e),
        time: chartTime(bucketAt),
        position: e.vote > 0 ? ("belowBar" as const) : ("aboveBar" as const),
        shape: e.vote > 0 ? ("arrowUp" as const) : ("arrowDown" as const),
        color: hit ? c.colors.hit : c.colors.miss,
        size: 1,
      };
    });
    c.lineMarkers.setMarkers(candlesOn ? [] : markers);
    c.candleMarkers.setMarkers(candlesOn ? markers : []);

    if (c.fitted !== prefs.timeframe) {
      c.api.timeScale().fitContent();
      c.fitted = prefs.timeframe;
    }
  }, [ready, buckets, prefs, focus, pulse.nifty.reference, pulse.nifty.open, pulse.series]);

  const shown = (hoverAt !== null ? buckets.find((b) => chartTime(b.at) === hoverAt) : null) ?? buckets[buckets.length - 1];
  const firings = useMemo(() => describeFirings(pulse, focus), [pulse, focus]);
  const tipFiring = tip ? firings.get(tip.id) : undefined;
  // Firings inside the hovered bar, for the legend: easier than landing on a small arrow.
  const barFirings =
    shown && hoverAt !== null ? [...firings.values()].filter((f) => f.at >= shown.at && f.at < shown.at + shown.minutes * 60_000) : [];

  return (
    <Panel
      title="NIFTY chart"
      meta={`${prefs.timeframe}-minute ${prefs.type === "candles" ? "candles" : "closes"} from the journal`}
      action={
        <>
          <Toggle value={prefs.type} onChange={(type) => setPrefs({ type })} options={[["candles", "Candles"], ["line", "Line"]]} />
          <Toggle
            value={String(prefs.timeframe)}
            onChange={(v) => setPrefs({ timeframe: Number(v) })}
            options={TIMEFRAMES.map((t) => [String(t), `${t}m`] as [string, string])}
          />
          <label className="inline-flex items-center gap-1.5 text-label text-muted">
            <input type="checkbox" checked={prefs.basket} onChange={(e) => setPrefs({ basket: e.target.checked })} className="accent-[var(--color-accent)]" />
            Basket
          </label>
        </>
      }
      flush
    >
      {shown && <ChartLegend bucket={shown} pulse={pulse} singles={singles} hovering={hoverAt !== null} timeframe={prefs.timeframe} firings={barFirings} />}
      <div className="relative h-[34rem]">
        <div ref={container} className="absolute inset-0" />
        {tip && tipFiring && <FiringTip firing={tipFiring} place={tip} />}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-label text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="font-medium text-fg">Top:</span> NIFTY
          {prefs.basket && (
            <>
              , <Swatch dashed /> basket (50 stocks × learned weights)
            </>
          )}
          , dashed levels: previous close and open
        </span>
        <span>
          <span className="font-medium text-fg">Middle:</span> breadth, stocks up minus down
        </span>
        <span>
          <span className="font-medium text-fg">Bottom:</span> signal votes, long minus short (−{singles.length} to +{singles.length}); faint bars are a single vote
        </span>
        {focus && (
          <span>
            <span className="font-medium text-fg">Arrows:</span> {focus.name} firings, <span className="text-accent">blue</span> right / grey wrong after{" "}
            {focus.horizon} min
          </span>
        )}
      </div>
    </Panel>
  );
}

/** What the chart holds at the hovered bar, or the latest one. */
function ChartLegend({
  bucket,
  pulse,
  singles,
  hovering,
  timeframe,
  firings,
}: {
  bucket: Bucket;
  pulse: Pulse;
  singles: SignalReport[];
  hovering: boolean;
  timeframe: number;
  firings: Firing[];
}) {
  const close = bucket.bar?.[3] ?? bucket.nifty;
  const change = close !== null ? close - pulse.nifty.reference : null;
  const end = bucket.at + bucket.minutes * 60_000;
  return (
    <div className="grid gap-1.5 border-b border-line px-3 py-2 text-label">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 tabular-nums">
        <span className="font-medium text-fg">
          {hhmm(bucket.at)}
          {timeframe > 1 && `–${hhmm(end)}`}
          <span className="ml-1 font-normal text-muted">{hovering ? "" : "latest"}</span>
        </span>
        {bucket.bar && (
          <span className="text-muted">
            O <span className="text-fg">{price.format(bucket.bar[0])}</span> H <span className="text-fg">{price.format(bucket.bar[1])}</span> L{" "}
            <span className="text-fg">{price.format(bucket.bar[2])}</span> C <span className="text-fg">{price.format(bucket.bar[3])}</span>
          </span>
        )}
        {change !== null && (
          <span className={change >= 0 ? "text-up" : "text-down"}>
            {signedPts(change)} ({signedPercent.format(change / pulse.nifty.reference)}) vs prev close
          </span>
        )}
        {bucket.basket !== null && close !== null && (
          <span className="text-muted">
            Basket <span className="text-fg">{price.format(bucket.basket)}</span> ({signedPts(bucket.basket - close)} vs NIFTY)
          </span>
        )}
        <span className="text-muted">
          Breadth{" "}
          <span className={bucket.advancers >= bucket.decliners ? "text-up" : "text-down"}>
            {bucket.advancers - bucket.decliners > 0 ? "+" : ""}
            {bucket.advancers - bucket.decliners}
          </span>{" "}
          ({bucket.advancers} up, {bucket.decliners} down)
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {singles.map((s, i) => (
          <span key={s.id} className="inline-flex items-baseline gap-1">
            <Vote vote={bucket.votes[i] ?? 0} />
            <span className="text-muted">{s.name}</span>
            <span className="tabular-nums">{bucket.readings[i] ?? "—"}</span>
          </span>
        ))}
        <span className="text-muted">
          Net vote{" "}
          <span className={`tabular-nums ${bucket.composite > 0 ? "text-up" : bucket.composite < 0 ? "text-down" : "text-fg"}`}>
            {bucket.composite > 0 ? "+" : ""}
            {bucket.composite}
          </span>
        </span>
      </div>
      {firings.map((f) => (
        <div key={f.id} className="flex flex-wrap items-baseline gap-x-2">
          <span className={f.vote > 0 ? "text-up" : "text-down"}>{f.vote > 0 ? "▲" : "▼"}</span>
          <span>{firingSummary(f)}</span>
        </div>
      ))}
    </div>
  );
}

// --- Firing details ----------------------------------------------------------------------------

interface Firing {
  id: string;
  at: number;
  name: string;
  vote: -1 | 1;
  /** What the signal read when it fired. */
  why: string;
  horizon: number;
  from: number | null;
  to: number | null;
  outcome: number;
  hit: boolean;
  cost: number;
}

const firingId = (e: SignalEvent) => `firing:${e.at}`;

function describeFirings(pulse: Pulse, focus: LabFocus | null): Map<string, Firing> {
  const out = new Map<string, Firing>();
  if (!focus) return out;
  const singles = pulse.signals.filter((s) => s.kind === "single");
  const open = pulse.series[0]?.at ?? 0;
  const index = singles.findIndex((s) => s.id === focus.id);
  for (const e of focus.events) {
    const minute = Math.round((e.at - open) / 60_000);
    const point = pulse.series[minute];
    let why = "—";
    if (point && index >= 0) why = point.readings[index];
    else if (point) {
      // The combined signal: name the signals that agreed.
      why = singles
        .map((s, i) => (point.votes[i] === e.vote ? `${s.name} ${point.readings[i]}` : null))
        .filter(Boolean)
        .join("; ");
    }
    out.set(firingId(e), {
      id: firingId(e),
      at: e.at,
      name: focus.name,
      vote: e.vote,
      why,
      horizon: focus.horizon,
      from: point?.nifty ?? null,
      to: pulse.series[minute + focus.horizon]?.nifty ?? null,
      outcome: e.outcome,
      hit: e.outcome !== 0 && Math.sign(e.outcome) === e.vote,
      cost: focus.cost,
    });
  }
  return out;
}

function firingSummary(f: Firing) {
  const result = f.vote * f.outcome;
  return `${f.name} said ${f.vote > 0 ? "long" : "short"} at ${hhmm(f.at + 60_000)} (${f.why}); NIFTY ${signedPts(f.outcome)} pts in ${f.horizon} min, ${f.hit ? "right" : "wrong"}, ${signedPts(result - f.cost)} after costs.`;
}

/** The card shown when the pointer is on a firing arrow. */
interface TipPlace {
  id: string;
  /** The arrow's centre, in px from the chart's top left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

const TIP_WIDTH = 272;
const TIP_HEIGHT = 150;
const TIP_GAP = 12;

function FiringTip({ firing: f, place }: { firing: Firing; place: TipPlace }) {
  const result = f.vote * f.outcome;
  const { x, y, width, height } = place;
  // To the right of the arrow, or to its left when that would run off the chart; centred on it vertically.
  const right = x + TIP_GAP + TIP_WIDTH <= width - 8;
  const left = right ? x + TIP_GAP : Math.max(8, x - TIP_GAP - TIP_WIDTH);
  const top = Math.min(Math.max(8, y - TIP_HEIGHT / 2), Math.max(8, height - TIP_HEIGHT - 8));
  if (![left, top].every(Number.isFinite)) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 rounded-sm border border-line-strong bg-raised p-2.5 text-label shadow-lg"
      style={{ left, top, width: TIP_WIDTH }}
    >
      <div className="flex items-baseline gap-1.5">
        <span className={f.vote > 0 ? "text-up" : "text-down"}>{f.vote > 0 ? "▲" : "▼"}</span>
        <span className="font-medium text-fg">
          {f.name}: {f.vote > 0 ? "go long" : "go short"}
        </span>
        <span className="ml-auto text-muted tabular-nums">{hhmm(f.at + 60_000)}</span>
      </div>
      <p className="mt-1 text-muted">Why: {f.why}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
        <dt className="text-muted">NIFTY then</dt>
        <dd className="text-right">{f.from !== null ? price.format(f.from) : "—"}</dd>
        <dt className="text-muted">{f.horizon} min later</dt>
        <dd className="text-right">
          {f.to !== null ? price.format(f.to) : "—"} <span className={f.outcome >= 0 ? "text-up" : "text-down"}>({signedPts(f.outcome)})</span>
        </dd>
        <dt className="text-muted">Result</dt>
        <dd className={`text-right font-medium ${f.hit ? "text-up" : "text-down"}`}>{f.hit ? "Right" : "Wrong"}: {signedPts(result)} pts</dd>
        {f.cost > 0 && (
          <>
            <dt className="text-muted">After {f.cost}-pt cost</dt>
            <dd className={`text-right ${result - f.cost >= 0 ? "text-up" : "text-down"}`}>{signedPts(result - f.cost)} pts</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function Swatch({ className = "", dashed = false }: { className?: string; dashed?: boolean }) {
  return dashed ? (
    <span aria-hidden className="inline-block w-4 border-t-2 border-dashed border-muted" />
  ) : (
    <span aria-hidden className={`inline-block h-0.5 w-4 rounded-full ${className}`} />
  );
}

// --- Attribution -------------------------------------------------------------------------------

function Movers({ pulse }: { pulse: Pulse }) {
  const [window, setWindow] = useState<"day" | "recent">("day");
  const value = (c: Contribution) => (window === "day" ? c.points : c.recentPoints);
  const sorted = [...pulse.contributions].sort((a, b) => value(b) - value(a));
  const rows = [...sorted.slice(0, 7).filter((c) => value(c) > 0), ...sorted.slice(-7).filter((c) => value(c) < 0)];
  const scale = Math.max(1, ...rows.map((c) => Math.abs(value(c))));
  const total = window === "day" ? pulse.nifty.points : (pulse.nifty.recentPoints ?? 0);
  const { top, topPoints, restPoints } = pulse.concentration;

  return (
    <Panel
      title="Who moved NIFTY"
      meta={`in index points · ${window === "day" ? "since the previous close" : `last ${RECENT_MINUTES} minutes`}`}
      action={<Toggle value={window} onChange={setWindow} options={[["day", "Today"], ["recent", `${RECENT_MINUTES} min`]]} />}
    >
      <p className="mb-3 text-body">
        NIFTY {signedPts(total)} pts.
        {window === "day" && Math.abs(pulse.nifty.points) >= 10 && (
          <>
            {" "}
            <span className="font-medium">{top.map((c) => c.symbol).join(", ")}</span> alone add {signedPts(topPoints)}; the other{" "}
            {pulse.contributions.length - top.length} stocks together add {signedPts(restPoints)}.
          </>
        )}
      </p>
      <Bars rows={rows.map((c) => ({ id: c.key, label: c.symbol, value: value(c), hint: `${c.symbol} ${signedPercent.format(c.change)} today · weight ${(c.weight * 100).toFixed(1)}%` }))} scale={scale} />
    </Panel>
  );
}

function Sectors({ pulse }: { pulse: Pulse }) {
  const [window, setWindow] = useState<"day" | "recent">("day");
  const rows = pulse.sectors
    .map((s) => ({ id: s.sector, label: s.sector, value: window === "day" ? s.points : s.recentPoints, hint: `${s.count} stock${s.count === 1 ? "" : "s"}` }))
    .filter((r) => Math.abs(r.value) >= 0.05)
    .sort((a, b) => b.value - a.value);
  const scale = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <Panel
      title="By sector"
      meta="in index points"
      action={<Toggle value={window} onChange={setWindow} options={[["day", "Today"], ["recent", `${RECENT_MINUTES} min`]]} />}
    >
      <Bars rows={rows} scale={scale} labelWidth="w-40" />
    </Panel>
  );
}

function Bars({ rows, scale, labelWidth = "w-24" }: { rows: { id: string; label: string; value: number; hint: string }[]; scale: number; labelWidth?: string }) {
  if (!rows.length) return <EmptyState>Nothing has moved yet.</EmptyState>;
  return (
    <ul className="grid gap-[2px]">
      {rows.map((r) => {
        const width = `${(Math.abs(r.value) / scale) * 50}%`;
        const up = r.value >= 0;
        return (
          <li key={r.id} className="group flex h-6 items-center gap-2 rounded-sm px-1 hover:bg-raised" title={`${r.label}: ${signedPts(r.value)} pts · ${r.hint}`}>
            <span className={`${labelWidth} shrink-0 truncate text-body`}>{r.label}</span>
            <span className="relative h-full flex-1">
              <span className="absolute top-0 bottom-0 left-1/2 w-px bg-line-strong" />
              <span
                className={`absolute top-1.5 bottom-1.5 ${up ? "rounded-r-[4px] bg-up" : "rounded-l-[4px] bg-down"}`}
                style={up ? { left: "50%", width } : { right: "50%", width }}
              />
            </span>
            <span className="w-14 shrink-0 text-right text-body tabular-nums">{signedPts(r.value)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Toggle<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <span className="inline-flex rounded-sm border border-line-strong" role="group">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={`h-6 px-2 text-label ${value === key ? "bg-line-strong text-fg" : "text-muted hover:text-fg"}`}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

// --- Signals -----------------------------------------------------------------------------------

/** Assumed round-trip cost of one NIFTY futures lot, in index points. Editable on the page. */
// One NIFTY futures lot, round trip, at Dhan's charges (src/lib/trading/charges.ts): about ₹975,
// 15 points, since futures STT rose to 0.05% on 1 April 2026; the spread adds about a point.
const COSTS = [0, 4, 8, 12, 16, 20];
const DEFAULT_COST = 16;

export interface LabFocus {
  id: string;
  name: string;
  kind: SignalReport["kind"];
  horizon: number;
  cost: number;
  events: SignalEvent[];
}

function useLabState() {
  const [horizon, setHorizon] = useState<number>(HORIZON);
  const [cost, setCost] = useState(DEFAULT_COST);
  const [focus, setFocus] = useState<string | null>("breadth");
  return { horizon, setHorizon, cost, setCost, focus, setFocus };
}

type LabState = ReturnType<typeof useLabState>;

const net = (stats: SignalStats, cost: number) => stats.gross - cost * stats.fired;
const statsAt = (signal: SignalReport, horizon: number) => signal.stats.find((x) => x.horizon === horizon)!;

function verdictOf(stats: SignalStats, cost: number): { label: string; tone: string; detail: string } {
  const n = stats.fired;
  if (n < 8) return { label: "Too few firings", tone: "text-muted border-line-strong", detail: `Fired ${n} time${n === 1 ? "" : "s"}; at least 8 are needed to say anything.` };
  const [lo, hi] = wilson(stats.hits, n);
  const after = net(stats, cost);
  const ahead = after > 0;
  const range = `Right ${stats.hits} of ${n} (${((stats.hits / n) * 100).toFixed(0)}%), 95% range ${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}%.`;
  const money = `${signedPts(stats.gross)} pts before costs, ${n} × ${cost} pts of costs, ${signedPts(after)} after.`;
  if (lo > 0.5 && ahead) return { label: "Edge so far", tone: "text-up border-up/50", detail: `${range} The range sits above 50%, and it makes money after costs: ${money}` };
  if (lo > 0.5) return { label: "Right often, costs eat it", tone: "text-warn border-warn/50", detail: `${range} Better than a coin flip, but the wins are too small to pay for each trade: ${money}` };
  if (hi < 0.5) return { label: "Reliably wrong", tone: "text-down border-down/50", detail: `${range} The whole range is below 50%: doing the opposite may be the real signal.` };
  if (ahead) return { label: "Ahead, could be luck", tone: "text-warn border-warn/50", detail: `${range} The range includes 50%, so this could be luck, though it is ahead: ${money}` };
  return { label: "No edge after costs", tone: "text-down border-down/50", detail: `${range} The range includes 50%, so it is not proven right or wrong, and following it lost money once costs are paid: ${money}` };
}

function SignalLab({ pulse, lab }: { pulse: Pulse; lab: LabState }) {
  const { horizon, cost } = lab;
  const baseline = pulse.baselines.find((b) => b.horizon === horizon)!;
  const lessons = lessonsOf(pulse, horizon, cost);

  return (
    <Panel
      title="Signal lab: would these have worked today?"
      meta={`each firing follows NIFTY for ${horizon} min; firings never overlap`}
      action={
        <>
          <span className="inline-flex items-center gap-1.5 text-label text-muted">
            Hold
            <Toggle value={String(horizon)} onChange={(v) => lab.setHorizon(Number(v))} options={HORIZONS.map((h) => [String(h), `${h}m`] as [string, string])} />
          </span>
          <label className="inline-flex items-center gap-1.5 text-label text-muted">
            Cost per trade
            <select
              value={cost}
              onChange={(e) => lab.setCost(Number(e.target.value))}
              className="h-6 rounded-sm border border-line-strong bg-canvas px-1.5 text-label text-fg"
            >
              {COSTS.map((c) => (
                <option key={c} value={c}>
                  {c === 0 ? "none (gross)" : `${c} pts`}
                </option>
              ))}
            </select>
          </label>
        </>
      }
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <ul className="grid content-start gap-1.5" aria-label="What today says">
          {lessons.map((lesson, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-accent" aria-hidden>
                →
              </span>
              <span>{lesson}</span>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-3 gap-3 self-start rounded-sm border border-line p-3">
          <Field label={`NIFTY up in ${horizon}m windows`} value={`${(baseline.upShare * 100).toFixed(0)}%`} />
          <Field label="Median move" value={`${baseline.medianMove.toFixed(1)} pts`} />
          <Field
            label="Cost / median move"
            value={<span className={cost >= baseline.medianMove ? "text-down" : cost >= baseline.medianMove / 2 ? "text-warn" : undefined}>{baseline.medianMove ? `${((cost / baseline.medianMove) * 100).toFixed(0)}%` : "—"}</span>}
          />
        </dl>
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        {pulse.signals.map((signal) => (
          <SignalCard key={signal.id} signal={signal} lab={lab} />
        ))}
      </div>

      <p className="mt-3 text-label text-muted">
        Hit rate counts firings where NIFTY then moved the signal&apos;s way. The band is the 95% range for the true rate given so few firings: while it
        straddles 50%, a coin could have done the same. Cost is one NIFTY futures lot round trip (brokerage, STT, exchange fees, stamp duty, GST and the
        spread): about 16 pts at Dhan&apos;s charges since futures STT rose to 0.05% in April 2026. One day proves nothing either way: a signal earns a
        strategy only after weeks of replayed days (engine plan, step E6).
      </p>
    </Panel>
  );
}

function lessonsOf(pulse: Pulse, horizon: number, cost: number): ReactNode[] {
  const out: ReactNode[] = [];
  const baseline = pulse.baselines.find((b) => b.horizon === horizon)!;
  const rows = pulse.signals.map((s) => ({ s, st: statsAt(s, horizon) }));
  const ahead = rows.filter((r) => r.st.fired > 0 && net(r.st, cost) > 0);
  const bestGross = [...rows].sort((a, b) => b.st.gross - a.st.gross)[0];

  if (cost > 0) {
    out.push(
      <>
        Over {horizon} minutes NIFTY&apos;s typical move today was <b>{baseline.medianMove.toFixed(1)} pts</b> and a round trip costs about <b>{cost}</b>.{" "}
        {cost >= baseline.medianMove ? "Being right isn't enough: a signal must catch the bigger moves." : "Costs take a real share of every win."}
      </>,
    );
  }
  if (ahead.length === 0) {
    out.push(
      <>
        No signal is ahead {cost > 0 ? "after costs" : ""} at {horizon} min.{" "}
        {bestGross && bestGross.st.gross > 0 && (
          <>
            Best before costs: {bestGross.s.name}, {signedPts(bestGross.st.gross)} pts over {bestGross.st.fired} trades
            {cost > 0 && <> ({signedPts(bestGross.st.gross / Math.max(1, bestGross.st.fired))} a trade against a {cost}-pt cost)</>}.
          </>
        )}
      </>,
    );
  } else {
    out.push(
      <>
        Ahead {cost > 0 ? "after costs" : ""} at {horizon} min:{" "}
        {ahead.map((r, i) => (
          <span key={r.s.id}>
            {i > 0 && ", "}
            <b>{r.s.name}</b> {signedPts(net(r.st, cost))} pts over {r.st.fired} trades
          </span>
        ))}
        .
      </>,
    );
  }

  // Where each signal does best across holding times.
  const best = pulse.signals
    .map((s) => {
      const top = [...s.stats].filter((st) => st.fired >= 5).sort((a, b) => net(b, cost) - net(a, cost))[0];
      return top ? { s, top } : null;
    })
    .filter((x): x is { s: SignalReport; top: SignalStats } => x !== null && net(x.top, cost) > 0 && x.top.horizon !== horizon);
  if (best.length) {
    out.push(
      <>
        Holding longer or shorter changes the answer:{" "}
        {best.map(({ s, top }, i) => (
          <span key={s.id}>
            {i > 0 && "; "}
            {s.name} is {signedPts(net(top, cost))} at {top.horizon} min
          </span>
        ))}
        . Picking the best holding time after the fact is itself a way to fool yourself.
      </>,
    );
  }

  const proven = rows.filter((r) => r.st.fired >= 8 && wilson(r.st.hits, r.st.fired)[0] > 0.5);
  out.push(
    proven.length ? (
      <>
        {proven.map((r) => r.s.name).join(", ")} beat{proven.length === 1 ? "s" : ""} a coin flip with 95% confidence at {horizon} min. Worth replaying on
        other days to see if it holds.
      </>
    ) : (
      <>Every hit-rate band still includes 50%: today can&apos;t tell any of these from a coin flip. That takes many more days of data.</>
    ),
  );
  return out;
}

function SignalCard({ signal, lab }: { signal: SignalReport; lab: LabState }) {
  const { horizon, cost } = lab;
  const stats = statsAt(signal, horizon);
  const rate = stats.fired ? stats.hits / stats.fired : null;
  const [lo, hi] = wilson(stats.hits, stats.fired);
  const verdict = verdictOf(stats, cost);
  const focused = lab.focus === signal.id;

  return (
    <article className={`min-w-0 rounded-sm border p-3 ${focused ? "border-accent/60" : "border-line"}`}>
      <header className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <h3 className="font-medium">
          {signal.name}
          {signal.kind === "combined" && <span className="ml-1.5 text-label text-muted">combined</span>}
        </h3>
        <span className={`cursor-help rounded-sm border px-1.5 text-label ${verdict.tone}`} title={verdict.detail}>
          {verdict.label}
        </span>
        <button
          type="button"
          aria-pressed={focused}
          onClick={() => lab.setFocus(focused ? null : signal.id)}
          className={`ml-auto h-6 rounded-sm border px-2 text-label ${focused ? "border-accent/60 text-fg" : "border-line-strong text-muted hover:text-fg"}`}
        >
          {focused ? "On the chart" : "Show on chart"}
        </button>
      </header>
      <p className="mt-1 text-label text-muted">{signal.rule}</p>
      <p className="mt-1 text-label">{verdict.detail}</p>
      <p className="mt-1.5 flex items-baseline gap-1.5 text-body">
        <span className="text-label text-muted">Now</span>
        <Vote vote={signal.vote} /> {signal.display}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-label text-muted">Hit rate</span>
            <span className="tabular-nums">
              {rate === null ? "—" : `${(rate * 100).toFixed(0)}%`} <span className="text-label text-muted">({stats.hits}/{stats.fired})</span>
            </span>
          </div>
          <RateBand rate={rate} lo={lo} hi={hi} />
          <p className="mt-1 text-label text-muted tabular-nums">
            95% range {(lo * 100).toFixed(0)}–{(hi * 100).toFixed(0)}%
          </p>
          <p className="mt-2 text-label tabular-nums">
            <span className="text-up">▲</span> long {stats.longHits}/{stats.longs} right
            <span className="mx-1.5 text-muted">·</span>
            <span className="text-down">▼</span> short {stats.shortHits}/{stats.shorts} right
          </p>
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-label text-muted">Points {cost > 0 ? "after costs" : "(gross)"}</span>
            <span className={`tabular-nums ${net(stats, cost) >= 0 ? "text-up" : "text-down"}`}>{signedPts(net(stats, cost))}</span>
          </div>
          <Equity events={stats.events} cost={cost} />
          <p className="mt-1 text-label text-muted tabular-nums">
            gross {signedPts(stats.gross)} · {stats.fired ? `${signedPts(net(stats, cost) / stats.fired)} a trade` : "no trades"}
          </p>
        </div>
      </div>

      <HorizonProfile signal={signal} lab={lab} />

      {stats.events.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="mr-1 text-label text-muted">Last firings</span>
          {stats.events.slice(-14).map((e) => {
            const hit = e.outcome !== 0 && Math.sign(e.outcome) === e.vote;
            return (
              <span
                key={e.at}
                title={`${hhmm(e.at)} ${e.vote > 0 ? "long" : "short"} → NIFTY ${signedPts(e.outcome)} pts in ${horizon} min`}
                className={`grid size-4 place-items-center rounded-[3px] text-[10px] ${hit ? "bg-up/25 text-up" : "bg-down/25 text-down"}`}
              >
                {e.vote > 0 ? "▲" : "▼"}
              </span>
            );
          })}
        </div>
      )}
    </article>
  );
}

/** Hit rate on a 0–100% track, with its 95% range and the 50% coin-flip line. */
function RateBand({ rate, lo, hi }: { rate: number | null; lo: number; hi: number }) {
  return (
    <div className="relative mt-1.5 h-3" role="img" aria-label={rate === null ? "No firings" : `Hit rate ${(rate * 100).toFixed(0)}%, 95% range ${(lo * 100).toFixed(0)} to ${(hi * 100).toFixed(0)}%`}>
      <div className="absolute inset-x-0 top-1 h-1 rounded-full bg-line" />
      {rate !== null && <div className="absolute top-0.5 h-2 rounded-full bg-accent/30" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />}
      <div className="absolute top-[-2px] h-4 w-px bg-muted" style={{ left: "50%" }} title="50%: a coin flip" />
      {rate !== null && <div className="absolute top-0 size-3 -translate-x-1/2 rounded-full border-2 border-panel bg-accent" style={{ left: `${rate * 100}%` }} />}
    </div>
  );
}

/** Cumulative points through the day following every firing: after costs solid, before costs dashed. */
function Equity({ events, cost }: { events: SignalEvent[]; cost: number }) {
  if (events.length < 2) return <div className="mt-1.5 grid h-10 place-items-center text-label text-muted">Not enough firings yet</div>;
  let g = 0;
  let n = 0;
  const gross = [0];
  const netted = [0];
  for (const e of events) {
    g += e.vote * e.outcome;
    n += e.vote * e.outcome - cost;
    gross.push(g);
    netted.push(n);
  }
  const all = [...gross, ...netted];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const W = 200;
  const H = 40;
  const x = (i: number) => (i / (gross.length - 1)) * W;
  const y = (v: number) => H - 2 - ((v - min) / span) * (H - 4);
  const line = (values: number[]) => values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = netted.at(-1)!;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-1.5 block h-10 w-full" role="img" aria-label={`Points through the day, ending ${signedPts(last)} after costs`}>
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--color-line-strong)" strokeDasharray="2 2" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {cost > 0 && <polyline fill="none" stroke="var(--color-muted)" strokeDasharray="3 3" strokeWidth={1.5} vectorEffect="non-scaling-stroke" points={line(gross)} />}
      <polyline
        fill="none"
        stroke={last >= 0 ? "var(--color-up)" : "var(--color-down)"}
        strokeWidth={2}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        points={line(netted)}
      />
    </svg>
  );
}

/** Points after costs at each holding time; click one to switch the whole lab to it. */
function HorizonProfile({ signal, lab }: { signal: SignalReport; lab: LabState }) {
  const values = signal.stats.map((st) => ({ st, value: net(st, lab.cost) }));
  const scale = Math.max(1, ...values.map((v) => Math.abs(v.value)));
  return (
    <div className="mt-3">
      <div className="text-label text-muted">By holding time, points {lab.cost > 0 ? "after costs" : "(gross)"}</div>
      <div className="mt-1 grid grid-cols-5 gap-1">
        {values.map(({ st, value }) => {
          const selected = st.horizon === lab.horizon;
          const height = `${(Math.abs(value) / scale) * 50}%`;
          return (
            <button
              key={st.horizon}
              type="button"
              onClick={() => lab.setHorizon(st.horizon)}
              aria-pressed={selected}
              title={`${st.horizon} min: ${st.hits}/${st.fired} right, ${signedPts(st.gross)} gross, ${signedPts(value)} after costs`}
              className={`rounded-sm px-1 pt-1 pb-0.5 text-center ${selected ? "bg-raised ring-1 ring-accent/50" : "hover:bg-raised"}`}
            >
              <span className="relative block h-8">
                <span className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
                <span
                  className={`absolute left-1/2 w-3 -translate-x-1/2 ${value >= 0 ? "rounded-t-[3px] bg-up" : "rounded-b-[3px] bg-down"}`}
                  style={value >= 0 ? { bottom: "50%", height } : { top: "50%", height }}
                />
              </span>
              <span className="block text-[10px] text-muted tabular-nums">{st.horizon}m</span>
              <span className="block text-[10px] tabular-nums">{st.fired ? signedPts(value) : "—"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Method ------------------------------------------------------------------------------------

function HowItWorks({ pulse }: { pulse: Pulse }) {
  const { weights } = pulse;
  const topWeights = [...pulse.contributions].sort((a, b) => b.weight - a.weight).slice(0, 6);
  return (
    <Panel title="How this is computed">
      <div className="grid gap-4 text-body lg:grid-cols-3">
        <div>
          <h3 className="font-medium">Data</h3>
          <p className="mt-1 text-muted">
            Every frame Dhan sent today, journaled on the server and decoded by the engine: NIFTY about once a second, its 50 stocks in Quote mode (price, VWAP,
            volume, pending buy and sell quantity). Nothing is sampled by this page.
          </p>
        </div>
        <div>
          <h3 className="font-medium">Learned weights</h3>
          <p className="mt-1 text-muted">
            Dhan lists full market-cap shares, but NIFTY weighs stocks by free float. So the weights are fitted to today&apos;s tape:{" "}
            {weights.source === "fitted" ? (
              <>
                on minutes it hadn&apos;t seen, the learned basket tracks NIFTY within <span className="text-fg">{weights.trackingPoints?.toFixed(1)} pts</span>{" "}
                (Dhan&apos;s shares: {weights.priorTrackingPoints?.toFixed(1)} pts). Heaviest: {topWeights.map((c) => `${c.symbol} ${(c.weight * 100).toFixed(1)}%`).join(", ")}.
              </>
            ) : (
              <>this needs 75 minutes of the session; until then Dhan&apos;s shares are used.</>
            )}
          </p>
        </div>
        <div>
          <h3 className="font-medium">Decision</h3>
          <p className="mt-1 text-muted">
            Each line of evidence votes +1, 0 or −1, and so does each signal. Their sum is the score; ±3 takes a side. The rules are fixed and visible, so the
            same day replayed gives the same calls, which is what makes them testable.
          </p>
        </div>
      </div>
    </Panel>
  );
}

// --- Small pieces ------------------------------------------------------------------------------

function Vote({ vote }: { vote: -1 | 0 | 1 }) {
  if (vote > 0) return <span className="w-3 shrink-0 text-up" aria-label="bullish">▲</span>;
  if (vote < 0) return <span className="w-3 shrink-0 text-down" aria-label="bearish">▼</span>;
  return <span className="w-3 shrink-0 text-center text-muted" aria-label="neutral">•</span>;
}

function signedPts(v: number) {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}

function hhmm(at: number) {
  return istTime.format(new Date(at)).slice(0, 5);
}
