"use client";

// The Strategies page's Strategy tab: every strategy the trader can follow (the Pulse signals and
// the Decision Lab rules), what each does, how its predictions have graded, and a button to follow
// it. Following saves at once; the engine uses it from the next trade.

import { ENOUGH_DAYS, usePredictions } from "@/components/insight/prediction-board";
import { buttonClass, DataTable, Panel, Pnl, Td } from "@/components/ui";
import { DEFAULT_TRADING_CONFIG, FOLLOWABLE_RULES, RULE_DATA, SIGNAL_DATA, SIGNALS, type DecisionData, type TradingConfig } from "@/lib/engine/trading";
import type { EngineStatus } from "@/lib/engine/protocol";
import type { PredictionRow } from "@/lib/decide/predict";
import { ruleById } from "@/lib/decide/rules";
import { DataTags } from "./shared";
import { GUIDE } from "./signal-guide";
import { OfiComparison } from "./ofi-comparison";

type Strategy = TradingConfig["strategy"];

interface Choice {
  /** The signal or rule id, as the trader's settings hold it. */
  id: string;
  /** The scoreboard's id for it: a rule's own, or `signal:<id>`. */
  predictor: string;
  name: string;
  idea: string;
  uses?: readonly DecisionData[];
}

const SIGNAL_CHOICES: Choice[] = SIGNALS.map((s) => ({ id: s.id, predictor: `signal:${s.id}`, name: s.name, idea: GUIDE[s.id]?.votes ?? "", uses: SIGNAL_DATA[s.id] }));
const RULE_CHOICES: Choice[] = FOLLOWABLE_RULES.map((r) => ({ id: r.id, predictor: r.id, name: r.name, idea: ruleById(r.id)?.idea ?? "", uses: RULE_DATA[r.id] }));

/**
 * The settings for following a signal or a Decision Lab rule. A rule brings its own stop, target,
 * trailing stop, opposite-vote exit and hold, in percent, as the lab plays it; a trailing stop or
 * hold the previous rule set is undone when the new one doesn't have it.
 */
export function followStrategy(current: Strategy, id: string): Strategy {
  const signal = SIGNALS.find((s) => s.id === id);
  const rule = FOLLOWABLE_RULES.find((r) => r.id === id);
  const exits = rule && ruleById(rule.id)?.exits;
  const previous = current.rule ? ruleById(current.rule)?.exits : undefined;
  return {
    ...current,
    signal: signal?.id ?? current.signal,
    rule: rule?.id ?? null,
    trailStop: exits?.trail ?? (previous?.trail ? false : current.trailStop),
    holdMinutes: exits?.holdMinutes ?? (previous?.holdMinutes !== undefined ? DEFAULT_TRADING_CONFIG.strategy.holdMinutes : current.holdMinutes),
    ...(exits
      ? {
          exitIn: "percent" as const,
          stopLossPct: exits.stopPct ?? current.stopLossPct,
          targetPct: exits.targetPct ?? current.targetPct,
          exitOnOpposite: exits.opposite ?? current.exitOnOpposite,
        }
      : {}),
  };
}

export function StrategyPicker({ engine, strategy, pending, onFollow }: { engine: EngineStatus | null; strategy: Strategy; pending: boolean; onFollow: (next: Strategy) => void }) {
  const load = usePredictions();
  const view = load.state === "ready" ? load.view : null;
  const rows = new Map(view?.rows.map((r) => [r.id, r]));
  const following = strategy.rule ?? strategy.signal;
  const graded =
    load.state === "loading" ? "Reading the prediction record…"
    : load.state === "error" ? `Prediction record unavailable: ${load.message}`
    : view && `Record: every minute it calls on recorded days, one at-the-money lot held ${view.horizon} min, after charges, against a coin flip at the same minutes. ${view.days.length} day${view.days.length === 1 ? "" : "s"} graded; ${ENOUGH_DAYS} are needed before anything counts as proven.`;

  const table = (caption: string, choices: Choice[]) => (
    <DataTable
      caption={caption}
      minWidth="min-w-[56rem]"
      columns={["Strategy", { label: "What it does", align: "left" }, "Beats a coin flip by", { label: "Days ahead", align: "left" }, ""]}
    >
      {choices.map((choice) => {
        const followed = choice.id === following;
        return (
          <tr key={choice.id} className={followed ? "bg-accent/5" : undefined}>
            <Td className="py-1.5">
              <span className="inline-flex items-center gap-1.5 font-medium">
                {choice.name}
                <DataTags uses={choice.uses} />
              </span>
            </Td>
            <Td className="!whitespace-normal py-1.5 text-muted">{choice.idea}</Td>
            <Record row={rows.get(choice.predictor)} ready={view !== null} />
            <Td className="text-right">
              {followed ? (
                <span className="text-label font-medium text-accent">Following</span>
              ) : (
                <button type="button" className={buttonClass} disabled={pending} onClick={() => onFollow(followStrategy(strategy, choice.id))}>
                  Follow
                </button>
              )}
            </Td>
          </tr>
        );
      })}
    </DataTable>
  );

  return (
    <div className="space-y-2">
      <OfiComparison engine={engine} />
      <Panel title="Signals" meta="Pulse signals: a long vote buys a call, a short vote a put" flush>
        {table("Signals the trader can follow", SIGNAL_CHOICES)}
      </Panel>
      <Panel title="Decision Lab rules" meta="Fewer trades, each with its own stop, target and hold" flush>
        {table("Decision Lab rules the trader can follow", RULE_CHOICES)}
      </Panel>
      <p className="px-1 text-label text-muted">
        Following another strategy takes effect from the next trade; open positions keep their exits. {graded}
      </p>
    </div>
  );
}

/** Rupees a call ahead of (or behind) a coin flip, and on how many tested days. */
function Record({ row, ready }: { row?: PredictionRow; ready: boolean }) {
  if (!ready) return <><Td numeric><span className="text-muted">—</span></Td><Td><span className="text-muted">—</span></Td></>;
  if (!row || row.calls === 0) return <><Td numeric><span className="text-muted">not graded yet</span></Td><Td><span className="text-muted">—</span></Td></>;
  if (row.vsCoin === null) {
    return (
      <>
        <Td numeric><span className="text-muted" title="No option prices on its days yet, so only direction is graded">right {Math.round((row.right / row.calls) * 100)}% of {row.calls}</span></Td>
        <Td><span className="text-muted">—</span></Td>
      </>
    );
  }
  return (
    <>
      <Td numeric><span title={`${row.calls} calls; ${row.paid} of ${row.priced} priced calls made money after charges`}><Pnl value={row.vsCoin} /> a call</span></Td>
      <Td>
        {row.daysAhead} of {row.daysCalled}
        {row.since && <span className="ml-1.5 text-label text-muted">since {new Date(`${row.since}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short" })}</span>}
      </Td>
    </>
  );
}
