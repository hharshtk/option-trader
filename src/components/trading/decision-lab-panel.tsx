"use client";

// The decision lab on the Strategies page: every rule played over every recorded day, minute by
// minute, with the trader's prices, exits and Dhan's charges. Research: nothing here trades.
// The engine rebuilds it after each session (npm run decide does the same by hand).

import { useEffect, useState } from "react";
import { DataTable, EmptyState, Panel, Pnl, Td } from "@/components/ui";
import type { DecideView, ScoreRow } from "@/lib/decide/score";

const REFRESH_MS = 60_000;
/** Fewer trades than this and a result says nothing. */
const ENOUGH = 30;
/** Fewer days than this and nothing is proven, whatever the trades say. */
const ENOUGH_DAYS = 20;

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; view: DecideView };

function useDecide(): Load {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function fetchOnce() {
      try {
        const response = await fetch("/api/engine/v1/decide", { cache: "no-store" });
        const body = await response.json();
        if (cancelled) return;
        setLoad(response.ok ? { state: "ready", view: body as DecideView } : { state: "error", message: body?.error ?? `The engine answered ${response.status}` });
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

const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });

/** The bottom line: does any rule beat trading at random, after costs, over enough days? */
function verdict(rows: ScoreRow[], days: number, hold: number): string {
  const random = rows.find((r) => r.rule === "random");
  const bar = random?.perTrade ?? null;
  const best = rows
    .filter((r) => r.rule !== "random" && r.perTrade !== null)
    .sort((a, b) => b.perTrade! - a.perTrade!)[0];
  const lead = bar === null ? "" : `A trade at a random moment ${bar < 0 ? "loses" : "makes"} ₹${Math.abs(Math.round(bar))} at a ${hold}-minute hold. `;
  if (!best) return `${lead}No rule has traded yet.`;
  const each = Math.round(best.perTrade!);
  const tail = days < ENOUGH_DAYS ? ` With ${days} day${days === 1 ? "" : "s"} recorded, that is not evidence yet: a rule must stay ahead for weeks.` : "";
  if (each <= 0) return `${lead}No rule makes money after costs. The best, ${best.name}, ${each < 0 ? `loses ₹${-each}` : "breaks even"} a trade.${tail}`;
  const few = best.trades < ENOUGH ? ` on only ${count(best.trades)} trades` : "";
  return `${lead}The best, ${best.name}, makes ₹${each} a trade${few}.${tail}`;
}

export function DecisionLabPanel() {
  const load = useDecide();
  const [hold, setHold] = useState(10);
  const [checked, setChecked] = useState(false);
  const [exits, setExits] = useState<"fixed" | "volatility">("volatility");
  const view = load.state === "ready" ? load.view : null;
  const priced = view?.days.filter((d) => d.pricedMinutes > 0) ?? [];
  const rows = view?.rows.filter((r) => r.hold === hold && r.checked === checked && r.exits === exits) ?? [];
  const bar = rows.find((r) => r.rule === "random")?.perTrade ?? null;
  const rules = new Map(view?.rules.map((r) => [r.id, r]) ?? []);

  const holds = view ? (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Hold">
      <select value={exits} onChange={(e) => setExits(e.target.value as "fixed" | "volatility")} className="mr-2 h-7 rounded-sm border border-line-strong bg-canvas px-2 text-label" aria-label="Exits">
        <option value="volatility">Exits follow NIFTY&apos;s moves</option>
        <option value="fixed">Fixed stop and target</option>
      </select>
      <label className="mr-2 inline-flex items-center gap-1.5 text-label text-muted">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        Cost check
      </label>
      {view.holds.map((h) => (
        <button
          key={h}
          type="button"
          aria-pressed={h === hold}
          onClick={() => setHold(h)}
          className="rounded-sm px-2 py-1 text-label text-muted hover:bg-raised hover:text-fg aria-pressed:bg-accent/15 aria-pressed:text-accent"
        >
          {h} min
        </button>
      ))}
    </div>
  ) : null;

  return (
    <Panel title="Decision lab" meta={view ? `Every rule over ${priced.length} recorded day${priced.length === 1 ? "" : "s"}, after costs · research, never traded` : undefined} action={holds}>
      {load.state === "loading" && <EmptyState>Reading the decision lab…</EmptyState>}
      {load.state === "error" && <p className="text-body text-down">{load.message}</p>}
      {view && view.days.length === 0 && (
        <EmptyState>No day is built yet. The engine builds each day 10 minutes after the close; `npm run decide` builds the recorded days now.</EmptyState>
      )}
      {view && view.days.length > 0 && (
        <div className="space-y-3">
          <p className="text-body text-muted">
            Each rule is played minute by minute over every recorded day, seeing at each minute&apos;s close only what the engine knew then. A firing buys one lot of the nearest expiry&apos;s at-the-money option at the ask, sold at the bid after the hold, at its stop or target
            {view.assumptions.opposite ? ", on an opposite vote" : ""} or at {view.assumptions.squareOff}, with Dhan&apos;s charges and ₹{view.assumptions.slippage} slippage each way. Entries {view.assumptions.entries}.{" "}
            {exits === "volatility"
              ? `Each trade's stop sits ${view.assumptions.stopMoves}× and its target ${view.assumptions.targetMoves}× NIFTY's typical move over the hold away, in option rupees, worked out at entry from how much NIFTY was moving (candidates keep their own target-to-stop ratio).`
              : `A fixed ${view.assumptions.stopPct}% stop and ${view.assumptions.targetPct}% target (candidates use their own).`}
            A rule is only worth following if it beats <span className="text-fg">No signal</span> and stays above zero, day after day.
          </p>
          {view.build.state === "running" && <p className="text-body text-warn">{view.build.message}…</p>}
          {view.build.state === "failed" && <p className="text-body text-down">The last build failed: {view.build.message}</p>}
          <p className="text-body font-medium">{verdict(rows, priced.length, hold)}</p>
          <p className="text-body text-muted">
            {checked
              ? `With the cost check: a trade only when NIFTY's typical move over the hold is ${view.costCheckFactor}× what it needs to break even.`
              : "Without the cost check. Tick it to see every rule with it."}{" "}
            Rules marked <span className="text-accent">candidate</span> were written on 18 November and use their own exits; only the days after test them.
          </p>

          <DataTable caption={`Decision rules at a ${hold}-minute hold, after costs, ${exits === "volatility" ? "exits following NIFTY's moves" : "fixed exits"}${checked ? ", with the cost check" : ""}`} minWidth="min-w-[52rem]" columns={["Rule", "Trades", "Won", "Net", "A trade", "Vs no signal", "Worst day"]}>
            {rows.map((r) => (
              <tr key={r.rule} className={r.rule === "random" ? "text-muted" : undefined}>
                <Td className="!whitespace-normal py-1.5">
                  <span className="block font-medium">
                    {r.name}
                    {rules.get(r.rule)?.candidate && <span className="ml-2 text-label font-normal text-accent">candidate</span>}
                  </span>
                  <span className="block max-w-md text-label text-muted">{rules.get(r.rule)?.idea}</span>
                  {rules.get(r.rule)?.exits && <span className="block max-w-md text-label text-muted">Own exits: {rules.get(r.rule)?.exits}{exits === "volatility" ? " (as a ratio of target to stop)" : ""}</span>}
                </Td>
                <Td numeric>{count(r.trades)}</Td>
                <Td numeric>{r.trades > 0 ? `${Math.round((r.wins / r.trades) * 100)}%` : "—"}</Td>
                <Td numeric>{r.trades > 0 ? <Pnl value={r.net} /> : "—"}</Td>
                <Td numeric>{r.perTrade === null ? "—" : <Pnl value={r.perTrade} />}</Td>
                <Td numeric>{r.rule === "random" || r.perTrade === null || bar === null ? "" : <Pnl value={r.perTrade - bar} />}</Td>
                <Td numeric>
                  {r.worstDay && r.trades > 0 ? (
                    <span className="inline-flex flex-col items-end leading-tight">
                      <Pnl value={r.worstDay.net} />
                      <span className="text-label text-muted">{day(r.worstDay.date)}</span>
                    </span>
                  ) : (
                    "—"
                  )}
                </Td>
              </tr>
            ))}
          </DataTable>

          <p className="text-label text-muted">
            Days:{" "}
            {view.days.map((d, i) => (
              <span key={d.date}>
                {i > 0 && " · "}
                <span className={d.pricedMinutes > 0 ? "text-fg" : undefined}>{day(d.date)}</span>
                {d.pricedMinutes === 0 ? " (no option quotes, not scored)" : `${d.depth ? ", 20-level book" : ""}${d.chain ? ", option chain" : ""}`}
                {d.pricedMove !== null && d.deliveredMove !== null && (
                  <span className={d.deliveredMove >= d.pricedMove ? "text-up" : "text-down"}>
                    {" "}
                    (options priced {d.pricedMove.toFixed(0)} pts a {view.moveMinutes} min, NIFTY moved {d.deliveredMove.toFixed(0)}: buying {d.deliveredMove >= d.pricedMove ? "paid" : "was dear"})
                  </span>
                )}
              </span>
            ))}
            {view.build.at !== null && view.build.state !== "running" && ` · last built ${new Date(view.build.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`}
          </p>

          <details>
            <summary className="cursor-pointer text-label text-muted">What a rule sees at each minute ({view.fields.length} readings)</summary>
            <dl className="mt-2 grid gap-x-4 gap-y-0.5 text-label sm:grid-cols-[auto_minmax(0,1fr)]">
              {view.fields.map((f) => (
                <div key={f.name} className="contents">
                  <dt className="font-mono text-muted">{f.name}</dt>
                  <dd className="min-w-0">{f.meaning}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      )}
    </Panel>
  );
}
