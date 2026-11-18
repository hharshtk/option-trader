"use client";

// The scalp lab on the Strategies page: fast triggers on NIFTY's future, scored as pretend trades
// after charges. Nothing here trades. See docs/trading.md#scalp-lab.

import { DataTable, EmptyState, Panel, Pnl, Td } from "@/components/ui";
import type { ScalpCell, ScalpLabStatus } from "@/lib/engine/trading";
import { clock, Vote } from "./shared";

/** Fewer trades than this and a result says nothing. */
const ENOUGH = 30;

const hold = (seconds: number) => (seconds < 60 ? `${seconds} s` : `${seconds / 60} min`);

function Cell({ cell }: { cell: ScalpCell }) {
  if (cell.trades === 0) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <Pnl value={cell.net / cell.trades} />
      <span className="text-label text-muted">
        {cell.trades} · {Math.round((cell.wins / cell.trades) * 100)}% won
      </span>
    </span>
  );
}

/** The bottom line in one sentence: does anything make money after charges yet? */
function verdict(lab: ScalpLabStatus): string {
  const best = lab.triggers
    .filter((t) => t.id !== "baseline")
    .flatMap((t) => t.cells.map((c) => ({ name: t.name, cell: c })))
    .filter((x) => x.cell.trades > 0)
    .sort((a, b) => b.cell.net / b.cell.trades - a.cell.net / a.cell.trades)[0];
  if (!best) return "No trigger has fired yet.";
  const each = Math.round(best.cell.net / best.cell.trades);
  if (each <= 0) return `No trigger makes money after charges so far. The best, ${best.name} at a ${hold(best.cell.holdSeconds)} hold, loses ₹${Math.abs(each)} a trade.`;
  if (best.cell.trades < ENOUGH) return `${best.name} at a ${hold(best.cell.holdSeconds)} hold is up ₹${each} a trade, but on ${best.cell.trades} trades that is luck until it holds up for weeks.`;
  return `${best.name} at a ${hold(best.cell.holdSeconds)} hold makes ₹${each} a trade after charges over ${best.cell.trades} trades. One day isn't proof: score it on more days (npm run scalp:lab) before trading it.`;
}

export function ScalpLabPanel({ lab }: { lab: ScalpLabStatus | undefined }) {
  if (!lab) return null;
  const meta = `Research: scored, never traded${lab.future ? ` · ${lab.future}` : ""}`;
  return (
    <Panel title="Scalp lab" meta={meta}>
      <div className="space-y-3">
        <p className="text-body text-muted">
          Fast triggers on NIFTY&apos;s future, checked every second. Each firing is a pretend trade in one lot of the at-the-money option: bought at the ask, sold at the bid after each hold, with Dhan&apos;s charges. A trigger is only worth trading if it beats{" "}
          <span className="text-fg">No signal</span> and stays above zero.
        </p>
        {lab.state !== "running" && lab.note && <p className="text-body text-warn">{lab.note}</p>}
        <p className="text-body font-medium">{verdict(lab)}</p>

        <DataTable caption="Scalp triggers: average net rupees a trade at each hold" minWidth="min-w-[44rem]" columns={["Trigger", ...lab.holds.map(hold)]}>
          {lab.triggers.map((t) => (
            <tr key={t.id} className={t.id === "baseline" ? "text-muted" : undefined}>
              <Td className="!whitespace-normal py-1.5">
                <span className="block font-medium">{t.name}</span>
                <span className="block max-w-md text-label text-muted">{t.about}</span>
              </Td>
              {t.cells.map((c) => (
                <Td key={c.holdSeconds} numeric>
                  <Cell cell={c} />
                </Td>
              ))}
            </tr>
          ))}
        </DataTable>

        {lab.recent.length === 0 ? (
          <EmptyState>No firings yet.</EmptyState>
        ) : (
          <details>
            <summary className="cursor-pointer text-label text-muted">Latest firings ({lab.recent.length})</summary>
            <DataTable caption="Latest scalp firings, newest first" minWidth="min-w-[60rem]" columns={["Time", { label: "Trigger", align: "left" }, { label: "What it saw", align: "left" }, { label: "Option", align: "left" }, "Bought at", ...lab.holds.map(hold)]}>
              {lab.recent.map((f) => (
                <tr key={f.id}>
                  <Td numeric>{clock(f.at)}</Td>
                  <Td>
                    <Vote vote={f.direction} /> {lab.triggers.find((t) => t.id === f.trigger)?.name ?? f.trigger}
                  </Td>
                  <Td className="text-muted">{f.reading}</Td>
                  <Td className="text-muted">{f.contract ?? f.note ?? "—"}</Td>
                  <Td numeric>{f.entry?.toFixed(2) ?? "—"}</Td>
                  {f.results.map((r, k) => (
                    <Td key={k} numeric>
                      {r === null ? <span className="text-muted">…</span> : <Pnl value={r} />}
                    </Td>
                  ))}
                </tr>
              ))}
            </DataTable>
          </details>
        )}
      </div>
    </Panel>
  );
}
