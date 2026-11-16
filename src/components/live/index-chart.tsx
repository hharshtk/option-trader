"use client";

import type { CandlestickData, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { useEngineTelemetry } from "@/components/engine/use-engine-telemetry";
import { Panel } from "@/components/ui";
import { istTime, price } from "@/lib/format";
import { useLiveQuote, useStreamStatus } from "./live-quote";

const IST_OFFSET_SECONDS = 5.5 * 3600;
const SESSION_OPEN_MINUTE = 9 * 60 + 15;
const SESSION_CLOSE_MINUTE = 15 * 60 + 30;

type Bar = CandlestickData<UTCTimestamp>;

const STATUS_TOPIC = ["status"] as const;

type ChartState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty" }
  | { status: "ready"; session: string; interval: number; replayFrom: number | null };

const sessionLabel = new Intl.DateTimeFormat("en-IN", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
});

// Ticks only extend the chart during NSE hours on weekdays. Dhan sends a snapshot on
// subscribe, and outside the session that snapshot would otherwise start a fake candle.
function inSession(istSeconds: number) {
  const date = new Date(istSeconds * 1000);
  const weekday = date.getUTCDay();
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return weekday >= 1 && weekday <= 5 && minute >= SESSION_OPEN_MINUTE && minute < SESSION_CLOSE_MINUTE;
}

export function IndexChart({ index, name, instrument }: { index: string; name: string; instrument: string }) {
  const container = useRef<HTMLDivElement>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastBar = useRef<Bar | null>(null);
  const intervalSeconds = useRef(300);
  const [state, setState] = useState<ChartState>({ status: "loading" });
  const quote = useLiveQuote(instrument);
  const live = useStreamStatus()?.feed.state === "live";

  // While the engine replays a recorded day, the chart shows that day up to the replay's
  // position and replayed ticks extend it, as live. It reloads when the replay starts, seeks
  // or ends.
  const telemetry = useEngineTelemetry(STATUS_TOPIC);
  const replay = telemetry.status?.replay ?? null;
  const known = telemetry.status !== null || telemetry.link === "offline" || telemetry.link === "unconfigured";
  const replayKey = !known ? null : replay ? `${replay.date}:${replay.jumps}` : "live";
  const replayAt = useRef<{ date: string; at: number } | null>(null);
  // Declared before the loading effect, so it has the latest position when that runs.
  useEffect(() => {
    replayAt.current = replay && { date: replay.date, at: replay.at };
  });

  useEffect(() => {
    const element = container.current;
    if (!element || replayKey === null) return;
    const controller = new AbortController();
    let chart: IChartApi | undefined;
    const replaying = replayAt.current;
    const query = replaying ? `&date=${replaying.date}&until=${Math.round(replaying.at)}` : "";

    Promise.all([
      import("lightweight-charts"),
      fetch(`/api/market/candles?index=${encodeURIComponent(index)}${query}`, { signal: controller.signal }).then(
        async (response) => ({ ok: response.ok, body: await response.json() }),
      ),
    ])
      .then(([charts, response]) => {
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setState({ status: "error", message: response.body?.error?.message ?? "Couldn't load candles." });
          return;
        }
        const bars = response.body.bars as Bar[];
        // A replay before its first finished candle still gets a chart for its ticks to build.
        if (bars.length === 0 && !replaying) {
          setState({ status: "empty" });
          return;
        }

        const theme = getComputedStyle(document.documentElement);
        const color = (name: string) => theme.getPropertyValue(name).trim();
        chart = charts.createChart(element, {
          autoSize: true,
          layout: {
            background: { type: charts.ColorType.Solid, color: color("--color-panel") },
            textColor: color("--color-muted"),
            fontFamily: getComputedStyle(document.body).fontFamily,
            fontSize: 11,
          },
          grid: {
            vertLines: { color: color("--color-line") },
            horzLines: { color: color("--color-line") },
          },
          rightPriceScale: { borderColor: color("--color-line") },
          timeScale: { borderColor: color("--color-line"), timeVisible: true, secondsVisible: false },
          crosshair: {
            vertLine: { color: color("--color-line-strong"), labelBackgroundColor: color("--color-raised") },
            horzLine: { color: color("--color-line-strong"), labelBackgroundColor: color("--color-raised") },
          },
          localization: { priceFormatter: (value: number) => price.format(value) },
        });
        const candles = chart.addSeries(charts.CandlestickSeries, {
          upColor: color("--color-up"),
          downColor: color("--color-down"),
          wickUpColor: color("--color-up"),
          wickDownColor: color("--color-down"),
          borderVisible: false,
        });
        candles.setData(bars);
        chart.timeScale().fitContent();

        series.current = candles;
        lastBar.current = bars.at(-1) ?? null;
        intervalSeconds.current = response.body.interval * 60;
        setState({ status: "ready", session: response.body.session, interval: response.body.interval, replayFrom: replaying?.at ?? null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      controller.abort();
      chart?.remove();
      series.current = null;
      lastBar.current = null;
    };
  }, [index, replayKey]);

  useEffect(() => {
    const candles = series.current;
    const last = lastBar.current;
    const ltp = quote?.ltp;
    if (!candles || ltp === undefined || !quote) return;

    const istSeconds = quote.at / 1000 + IST_OFFSET_SECONDS;
    if (!inSession(istSeconds)) return;
    const interval = intervalSeconds.current;
    const time = (Math.floor(istSeconds / interval) * interval) as UTCTimestamp;
    if (last && time < last.time) return;

    const bar: Bar =
      last && time === last.time
        ? { ...last, high: Math.max(last.high, ltp), low: Math.min(last.low, ltp), close: ltp }
        : { time, open: ltp, high: ltp, low: ltp, close: ltp };
    candles.update(bar);
    lastBar.current = bar;
  }, [quote]);

  return (
    <Panel
      title={`${name} · ${state.status === "ready" ? state.interval : 5}-minute candles`}
      meta={
        state.status === "ready"
          ? state.replayFrom !== null
            ? `Replay of ${sessionLabel.format(new Date(`${state.session}T00:00:00Z`))} · Dhan's candles to ${istTime.format(state.replayFrom).slice(0, 5)}, replayed ticks after`
            : `${sessionLabel.format(new Date(`${state.session}T00:00:00Z`))} session from Dhan${live ? " · live ticks extend the last candle" : ""}`
          : undefined
      }
      flush
    >
      <div className="relative h-72">
        <div ref={container} className="absolute inset-0" />
        {state.status !== "ready" && (
          <div className="absolute inset-0 grid place-items-center px-4 text-center text-muted">
            {state.status === "loading" && "Loading candles from Dhan…"}
            {state.status === "empty" && "Dhan returned no candles for this index."}
            {state.status === "error" && <span className="text-down">{state.message}</span>}
          </div>
        )}
      </div>
    </Panel>
  );
}
