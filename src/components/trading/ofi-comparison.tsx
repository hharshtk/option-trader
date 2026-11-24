"use client";

import { useEffect, useState, useTransition } from "react";
import { startOfiComparison } from "@/app/(cockpit)/engine/actions";
import { replayDay } from "@/components/engine/replay-format";
import { buttonClass, DataTable, Panel, Pnl, Td } from "@/components/ui";
import type { OfiReplayComparison, OfiReplayStatus } from "@/lib/engine/ofi";
import type { EngineStatus } from "@/lib/engine/protocol";
import { fieldClass } from "./shared";

export function OfiComparison({ engine }: { engine: EngineStatus | null }) {
  const [day, setDay] = useState("");
  const replayDate = engine?.replay?.date;
  const days = engine?.journalDays ?? [];
  const date = replayDate ?? (days.find((recording) => recording.date === day)?.date ?? days[0]?.date);

  return (
    <Panel title="Breadth + 5-level OFI" meta="Replay comparison">
      {engine?.ofiReplay && date ? (
        <div className="space-y-2">
          {replayDate ? (
            <p className="text-label text-muted">Replay of {replayDay(replayDate)}</p>
          ) : (
            <label className="flex items-center gap-2 text-label text-muted">
              Recorded day
              <select value={date} className={fieldClass} onChange={(event) => setDay(event.target.value)}>
                {days.map((recording) => <option key={recording.date} value={recording.date}>{replayDay(recording.date)}</option>)}
              </select>
            </label>
          )}
          <RunComparison key={date} date={date} />
        </div>
      ) : (
        <p className="text-muted">
          {!engine ? "Waiting for engine status…" : !engine.ofiReplay ? "Update the engine to run the OFI comparison." : "There are no recorded days to compare."}
        </p>
      )}
    </Panel>
  );
}

function RunComparison({ date }: { date: string }) {
  const [status, setStatus] = useState<OfiReplayStatus>({ state: "idle" });
  const [pending, startTransition] = useTransition();
  const running = status.state === "running";

  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`/api/engine/v1/replay/ofi?date=${encodeURIComponent(date)}`, {
          signal: controller.signal, cache: "no-store",
        });
        if (!response.ok) throw new Error(`The engine returned HTTP ${response.status}.`);
        const next = await response.json() as OfiReplayStatus;
        if (controller.signal.aborted) return;
        if (next.state === "running") timer = setTimeout(poll, 2_000);
        else if (next.state === "idle") setStatus({ state: "failed", message: "The comparison is no longer available. Run it again to retry." });
        else setStatus(next);
      } catch (error) {
        if (!controller.signal.aborted) setStatus({ state: "failed", message: (error as Error).message });
      }
    }
    timer = setTimeout(poll, 2_000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [date, running]);

  function compare() {
    startTransition(async () => {
      try {
        setStatus(await startOfiComparison(date));
      } catch (error) {
        setStatus({ state: "failed", message: (error as Error).message });
      }
    });
  }

  return (
    <div className="space-y-2">
      <button type="button" className={buttonClass} disabled={pending || running} onClick={compare}>
        {pending || running ? "Comparing…" : "Compare 5-level OFI"}
      </button>
      {(pending || running) && <p role="status" className="text-label text-muted">Reading the {replayDay(date)} journals. Full sessions can take a few minutes.</p>}
      {status.state === "failed" && <p role="alert" className="text-label text-down">{status.message}</p>}
      {status.state === "ready" && <ComparisonResult result={status.comparison} />}
    </div>
  );
}

function ComparisonResult({ result }: { result: OfiReplayComparison }) {
  const primary = result.delays.find((delay) => delay.delayMs === result.primaryDelayMs)!;
  const graded = result.opportunities - primary.unpricedExits;
  const { disagreement, abstention, flat } = primary.skipped;

  if (!result.hasOptionQuotes) return <p role="status" className="text-muted">This day has no recorded NIFTY option quotes for the 15-minute comparison.</p>;
  if (!result.opportunities) return <p role="status" className="text-muted">No eligible breadth trades among {result.votes} votes on {replayDay(result.date)}.</p>;

  return (
    <div className="space-y-2">
      <p role="status" className="font-medium">
        {replayDay(result.date)} · 15-minute hold · {result.primaryDelayMs} ms delay{result.exploratory && " · Exploratory"}
      </p>
      <p className="text-label text-muted">
        {result.opportunities} eligible breadth opportunities · {result.covered} with usable OFI ({Math.round(result.covered / result.opportunities * 100)}%)
      </p>
      {!result.hasDepth && <p className="text-label text-muted">No depth journal for this day. The OFI gate abstained on every opportunity.</p>}
      {result.partialRecording && <p className="text-label text-warn">The main journal ends before the close of the grading window.</p>}
      {primary.unpricedExits > 0 && (
        <p className="text-label text-warn">{primary.unpricedExits} exits could not be priced. Totals use the {graded} opportunities with a known result.</p>
      )}
      {primary.missedEntries > 0 && <p className="text-label text-muted">{primary.missedEntries} missed entries count as ₹0.</p>}
      <DataTable caption="After-cost breadth and OFI results" columns={["Policy", "Trades", "Net after costs", "Per opportunity"]}>
        {([["Breadth only", primary.breadth], ["Breadth + OFI", primary.confirmed]] as const).map(([label, stats]) => (
          <tr key={label}>
            <Td>{label}</Td>
            <Td numeric>{stats.trades}</Td>
            <Td numeric><Pnl value={stats.net} /></Td>
            <Td numeric>{graded ? <Pnl value={stats.net / graded} /> : "—"}</Td>
          </tr>
        ))}
      </DataTable>
      {primary.liftPerOpportunity !== null && (
        <p className="text-body font-medium"><Pnl value={primary.liftPerOpportunity} /> per opportunity with OFI</p>
      )}
      <p className="text-label text-muted">
        Breadth net on OFI skips · {disagreement.count} disagreements <Pnl value={disagreement.breadthNet} />
        {" · "}{abstention.count} book abstentions <Pnl value={abstention.breadthNet} />
        {flat.count > 0 && <> · {flat.count} flat <Pnl value={flat.breadthNet} /></>}
      </p>
      <details className="text-body">
        <summary className="cursor-pointer text-muted">Execution delays</summary>
        <DataTable caption="Execution delay sensitivity" columns={["Delay", "Breadth net", "Breadth + OFI net", "Lift per opportunity"]}>
          {result.delays.map((delay) => (
            <tr key={delay.delayMs}>
              <Td>{delay.delayMs} ms{delay.unpricedExits > 0 && ` (${delay.unpricedExits} unpriced exits)`}</Td>
              <Td numeric><Pnl value={delay.breadth.net} /></Td>
              <Td numeric><Pnl value={delay.confirmed.net} /></Td>
              <Td numeric>{delay.liftPerOpportunity === null ? "—" : <Pnl value={delay.liftPerOpportunity} />}</Td>
            </tr>
          ))}
        </DataTable>
      </details>
    </div>
  );
}
