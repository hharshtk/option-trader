"use client";

// The prediction scoreboard on the Pulse page: every signal, rule and bar graded on every minute
// of every recorded day, 15 minutes later, in rupees from the recorded option prices after
// charges. Built by the decision lab after each session (lib/decide/predict.ts). Research: nothing
// here trades.

import { useEffect, useState } from "react";
import { DataTable, EmptyState, Panel, Pnl, Td } from "@/components/ui";
import type { PredictionRow, PredictionView } from "@/lib/decide/predict";

const REFRESH_MS = 60_000;
/** Fewer days than this and nothing is proven (the constitution's 20 live sessions). */
const ENOUGH_DAYS = 20;

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; view: PredictionView };

function usePredictions(): Load {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function fetchOnce() {
      try {
        const response = await fetch("/api/engine/v1/predictions", { cache: "no-store" });
        const body = await response.json();
        if (cancelled) return;
        setLoad(response.ok ? { state: "ready", view: body as PredictionView } : { state: "error", message: body?.error ?? `The engine answered ${response.status}` });
      } catch (error) {
        if (!cancelled) setLoad({ state: "error", message: (error as Error).message });
      }
      if (!cancelled) timer = setTimeout(fetchOnce, REFRESH_MS);
    }
    void fetchOnce();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  return load;
}

const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
const points = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(Math.round(n))}`;

/** The bottom line: does anything beat a coin flip, on the days that test it? */
function verdict(rows: PredictionRow[], days: number, horizon: number): string {
  const coin = rows.find((r) => r.kind === "bar" && r.id === "coin");
  const lead =
    coin?.perCall != null
      ? `Guessing ${coin.perCall < 0 ? "loses" : "makes"} ₹${Math.abs(Math.round(coin.perCall))} a minute: one lot of the at-the-money option, bought and sold ${horizon} minutes later, after charges. `
      : "";
  const best = rows.filter((r) => r.id !== "coin" && r.vsCoin !== null && r.priced > 0).sort((a, b) => b.vsCoin! - a.vsCoin!)[0];
  const tail = days < ENOUGH_DAYS ? ` With ${days} day${days === 1 ? "" : "s"} graded, that is not evidence yet: it must hold for ${ENOUGH_DAYS} sessions.` : "";
  if (!best) return `${lead}Nothing has been graded on a day that tests it yet.${tail}`;
  const ahead = Math.round(best.vsCoin!);
  if (ahead <= 0) return `${lead}Nothing beats a coin flip. The closest, ${best.name}, is ₹${-ahead} a call behind it.${tail}`;
  return `${lead}The best, ${best.name}, is ₹${ahead} a call ahead of a coin flip at the same minutes: right ${pct(best.right, best.calls)} of the time, ahead on ${best.daysAhead} of ${best.daysCalled} day${best.daysCalled === 1 ? "" : "s"}.${tail}`;
}

export function PredictionBoard() {
  const load = usePredictions();
  const view = load.state === "ready" ? load.view : null;
  const priced = view?.days.filter((d) => view.rows.find((r) => r.id === "coin")?.byDay.find((b) => b.date === d.date)?.priced) ?? [];

  return (
    <Panel
      title="Prediction scoreboard"
      meta={view ? `Every minute of ${view.days.length} recorded day${view.days.length === 1 ? "" : "s"}, graded ${view.horizon} minutes later · research, never traded` : undefined}
    >
      {load.state === "loading" && <EmptyState>Reading the scoreboard…</EmptyState>}
      {load.state === "error" && <p className="text-body text-down">{load.message}</p>}
      {view && view.days.length === 0 && <EmptyState>No day is graded yet. The engine grades each day 10 minutes after the close; `npm run decide` grades the recorded days now.</EmptyState>}
      {view && view.days.length > 0 && (
        <div className="space-y-3">
          <p className="text-body font-medium">{verdict(view.rows, priced.length, view.horizon)}</p>
          <p className="text-body text-muted">
            At every minute up to 14:59, each signal and rule either calls NIFTY up or down, or says nothing. A call is <span className="text-fg">right</span> when NIFTY then moved its way over the next {view.horizon} minutes (graded on every recorded day), and it{" "}
            <span className="text-fg">paid</span> when one lot of the at-the-money call (or put) bought then and sold {view.horizon} minutes later made money after Dhan&apos;s charges, spread and slippage (only days with option prices, from 18 November). The fair comparison is a coin flip at the same minutes. Calls in minutes
            next to each other are one idea counted several times, so read the days too. Rules marked &ldquo;tested from&rdquo; count only the days after they were written.
          </p>

          <DataTable
            caption={`Every predictor graded ${view.horizon} minutes later`}
            minWidth="min-w-[56rem]"
            columns={["Predictor", "Calls", "Right way", "With option prices", "Paid", "A lot on each call", "Coin flip, same minutes", "Vs coin flip", "Days ahead"]}
          >
            {view.rows.map((r) => (
              <tr key={r.id} className={r.kind === "bar" ? "text-muted" : undefined}>
                <Td className="!whitespace-normal py-1.5">
                  <span className="block font-medium">
                    {r.name}
                    {r.kind === "rule" && <span className="ml-2 text-label font-normal text-accent">rule{r.since ? ` · tested from ${day(r.since)}` : ""}</span>}
                    {r.kind === "bar" && <span className="ml-2 text-label font-normal">bar</span>}
                  </span>
                  <span className="block max-w-md text-label text-muted">{r.idea}</span>
                </Td>
                <Td numeric>{r.calls}</Td>
                <Td numeric>{r.id === "coin" ? "half" : pct(r.right, r.calls)}</Td>
                <Td numeric>{r.priced}</Td>
                <Td numeric>{pct(r.paid, r.priced)}</Td>
                <Td numeric>{r.perCall === null ? "—" : <Pnl value={r.perCall} />}</Td>
                <Td numeric>{r.coin === null ? "—" : <Pnl value={r.coin} />}</Td>
                <Td numeric>{r.vsCoin === null ? "" : <Pnl value={r.vsCoin} />}</Td>
                <Td numeric>{r.id === "coin" || r.daysCalled === 0 ? "" : `${r.daysAhead} of ${r.daysCalled}`}</Td>
              </tr>
            ))}
          </DataTable>

          <details>
            <summary className="cursor-pointer text-label text-muted">Day by day</summary>
            <p className="mt-2 text-label text-muted">Each cell: how often the calls were right, then rupees a call against a coin flip at the same minutes. Green: ahead of the coin flip. Dimmed: a day the rule was written with, which doesn&apos;t count for it.</p>
            <DataTable
              caption="Each predictor by day"
              minWidth="min-w-[40rem]"
              columns={[
                "Predictor",
                ...view.days.map((d) => ({ label: `${day(d.date)}${d.niftyMove !== null ? ` (${points(d.niftyMove)})` : ""}`, align: "right" as const })),
              ]}
            >
              {view.rows.map((r) => (
                <tr key={r.id} className={r.kind === "bar" ? "text-muted" : undefined}>
                  <Td>{r.name}</Td>
                  {r.byDay.map((d) => (
                    <Td key={d.date} numeric className={d.tested ? undefined : "opacity-50"}>
                      {d.calls === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <span className="inline-flex flex-col items-end leading-tight" title={d.tested ? undefined : `${r.name} was written with this day seen`}>
                          <span>
                            {r.id === "coin" ? `${d.calls} min` : `${pct(d.right, d.calls)} of ${d.calls}`}
                            {!d.tested && " · seen"}
                          </span>
                          {d.perCall !== null && d.coin !== null ? (
                            <span className={`text-label ${r.id === "coin" ? "text-muted" : d.perCall > d.coin ? "text-up" : "text-down"}`}>
                              {r.id === "coin" ? <Pnl value={d.perCall} /> : `₹${Math.round(d.perCall).toLocaleString("en-IN")} vs ₹${Math.round(d.coin).toLocaleString("en-IN")}`}
                            </span>
                          ) : (
                            <span className="text-label text-muted">no option prices</span>
                          )}
                        </span>
                      )}
                    </Td>
                  ))}
                </tr>
              ))}
            </DataTable>
            <p className="mt-2 text-label text-muted">In brackets: NIFTY&apos;s points from the day&apos;s first minute to 15:14. On an up day, every predictor that calls up looks good; the coin flip at the same minutes takes that out.</p>
          </details>

          {view.build.state === "running" && <p className="text-body text-warn">{view.build.message}…</p>}
          {view.build.state === "failed" && <p className="text-body text-down">The last build failed: {view.build.message}</p>}
        </div>
      )}
    </Panel>
  );
}
