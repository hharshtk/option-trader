"use client";

// The Strategies page's Decision Lab tab: the decision lab in plain terms. Every strategy the
// trader can follow, played on every recorded day the way the trader is set up, in rupees after
// charges, beside random trades. One table and no switches: every hold and exit style is in the
// full lab under Signal research. Research: nothing here trades.

import { ENOUGH_DAYS } from "@/components/insight/prediction-board";
import { DataTable, EmptyState, Panel, Td } from "@/components/ui";
import type { DecideView, ScoreRow } from "@/lib/decide/score";
import type { ExitMode } from "@/lib/decide/simulate";
import { holdMinutesFor, isScalping, type TradingConfig } from "@/lib/engine/trading";
import { useDecide } from "./decision-lab-panel";

const wholeRupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0, signDisplay: "exceptZero" });
const day = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function Rupees({ value }: { value: number }) {
  const rounded = Math.round(value);
  return <span className={`tabular-nums ${rounded > 0 ? "text-up" : rounded < 0 ? "text-down" : ""}`}>{wholeRupees.format(rounded)}</span>;
}

/**
 * The way the lab plays that comes closest to the trader's settings: the nearest hold it plays,
 * the same exit style and the cost check as set. The lab has no rupee stops, so scalping is shown
 * with stops from NIFTY's moves.
 */
export function labWay(config: Pick<TradingConfig, "strategy">, holds: readonly number[], modes: readonly ExitMode[]) {
  const wanted = holdMinutesFor(config);
  const hold = holds.reduce((best, h) => (Math.abs(h - wanted) < Math.abs(best - wanted) ? h : best), holds[0] ?? wanted);
  const style: ExitMode = isScalping(config) ? "volatility" : config.strategy.trailStop ? "trailing" : config.strategy.exitsFrom;
  return { wanted, hold, exits: modes.includes(style) ? style : "volatility", checked: config.strategy.costCheck, scalping: isScalping(config) };
}

export function LabTab({ config, followed }: { config: TradingConfig; followed: string }) {
  const load = useDecide();
  const view = load.state === "ready" ? load.view : null;

  return (
    <Panel title="Decision Lab" meta="Every strategy on every recorded day, after charges · research, nothing here trades">
      {load.state === "loading" && <EmptyState>Reading the decision lab…</EmptyState>}
      {load.state === "error" && <p className="text-body text-down">Decision lab unavailable: {load.message}</p>}
      {view && <Results view={view} config={config} followed={followed} />}
    </Panel>
  );
}

function Results({ view, config, followed }: { view: DecideView; config: TradingConfig; followed: string }) {
  const way = labWay(config, view.holds, view.exitModes ?? ["volatility", "fixed"]);
  const rows = view.rows.filter((r) => r.hold === way.hold && r.exits === way.exits && r.checked === way.checked);
  const rules = new Map(view.rules.map((r) => [r.id, r]));
  const dates = rows[0]?.byDay?.map((d) => d.date) ?? [];
  const random = rows.find((r) => r.rule === "random");
  const others = rows
    .filter((r) => r.rule !== "random")
    .sort((a, b) => Number(b.trades > 0) - Number(a.trades > 0) || b.net - a.net);
  const mine = rows.find((r) => r.rule === followed);

  if (dates.length === 0) {
    return <EmptyState>No day has been played yet. The engine plays each day 10 minutes after the close.</EmptyState>;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-body font-medium">{headline(others, random, dates.length)}</p>
        {mine && <p className="text-body">{followedLine(mine)}</p>}
      </div>
      <p className="text-body text-muted">{howPlayed(way, view)}</p>
      {view.build.state === "running" && <p className="text-body text-warn">{view.build.message}…</p>}
      {view.build.state === "failed" && <p className="text-body text-down">The last update failed: {view.build.message}</p>}

      <DataTable
        caption="Each strategy's result by day, after charges, against random trades"
        minWidth="min-w-[40rem]"
        columns={["Strategy", ...dates.map(day), "Total", "Beat random trades"]}
      >
        {random && <Row row={random} name="Random trades" note="the bar to beat" muted />}
        {others.map((r) => {
          const rule = rules.get(r.rule);
          const since = rule?.candidate && rule.since ? `counts from ${day(rule.since)}` : null;
          return <Row key={r.rule} row={r} name={r.name} note={since} idea={rule?.idea} following={r.rule === followed} />;
        })}
      </DataTable>

      <div className="space-y-1 text-label text-muted">
        <p>
          <span className="font-medium text-fg">Beat random trades:</span> the days a strategy made more than buying the same calls or puts at random minutes did that day. When NIFTY runs one way all day, anything that bought that side looks good; this column takes that luck out.
        </p>
        <p>
          <span className="font-medium text-fg">Not counted:</span> a Decision Lab rule written after that day was seen. It is judged only on the days after.
        </p>
        <p>
          Updated 10 minutes after each session&apos;s close
          {view.build.at !== null && `, last on ${new Date(view.build.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`}
          . Every hold and exit style: Signal research, then Compare Decision Lab rules.
        </p>
      </div>
    </div>
  );
}

function Row({ row, name, note, idea, following = false, muted = false }: { row: ScoreRow; name: string; note?: string | null; idea?: string; following?: boolean; muted?: boolean }) {
  return (
    <tr className={following ? "bg-accent/5" : muted ? "text-muted" : undefined}>
      <Td className="py-1.5">
        <span className="font-medium" title={idea}>{name}</span>
        {following && <span className="ml-2 text-label font-medium text-accent">Following</span>}
        {note && <span className="ml-2 text-label text-muted">{note}</span>}
      </Td>
      {(row.byDay ?? []).map((d) => (
        <Td key={d.date} numeric>
          {!d.tested ? (
            <span className="text-label text-muted" title={`${name} was written after this day was seen, so the day doesn't count for it`}>not counted</span>
          ) : d.trades === 0 ? (
            <span className="text-label text-muted">no trades</span>
          ) : (
            <span title={`${plural(Math.round(d.trades), "trade")}`}><Rupees value={d.net} /></span>
          )}
        </Td>
      ))}
      <Td numeric>
        {row.trades === 0 ? (
          <span className="text-muted">—</span>
        ) : (
          <>
            <Rupees value={row.net} />
            <span className="ml-1.5 text-label text-muted">{plural(Math.round(row.trades), "trade")}</span>
          </>
        )}
      </Td>
      <Td numeric>
        {muted ? "" : row.daysTraded === 0 ? (
          <span className="text-muted">—</span>
        ) : (
          <span className={row.daysAhead === row.daysTraded ? "text-up" : row.daysAhead === 0 ? "text-down" : undefined}>
            {row.daysAhead} of {plural(row.daysTraded, "day")}
          </span>
        )}
      </Td>
    </tr>
  );
}

/** The bottom line: how many made money, what random trades did, and whether that means anything yet. */
function headline(others: ScoreRow[], random: ScoreRow | undefined, days: number): string {
  const traded = others.filter((r) => r.trades > 0);
  const made = traded.filter((r) => r.net > 0).length;
  const bar = random ? `; random trades ${random.net < 0 ? "lost" : "made"} ${wholeRupees.format(Math.abs(Math.round(random.net)))}` : "";
  const proof =
    days < ENOUGH_DAYS
      ? `Too early to trust any of them: a strategy has to keep beating random trades for ${ENOUGH_DAYS} days (${days} so far).`
      : `A strategy that beat random trades on most of its days has earned a closer look.`;
  return `${plural(days, "day")} played. ${made} of ${traded.length} strategies made money after charges${bar}. ${proof}`;
}

function followedLine(row: ScoreRow): string {
  if (row.trades === 0) return `${row.name}, which you follow, hasn't traded on a day that counts yet.`;
  const money = `${row.net < 0 ? "lost" : "made"} ${wholeRupees.format(Math.abs(Math.round(row.net)))}`;
  return `${row.name}, which you follow, ${money} over ${plural(row.days, "day")}, beating random trades on ${row.daysAhead} of ${row.daysTraded}.`;
}

function howPlayed(way: ReturnType<typeof labWay>, view: DecideView): string {
  const hold = way.hold === way.wanted ? `held up to ${way.hold} minutes` : `held up to ${way.hold} minutes (your trader holds ${way.wanted}; this is the closest the lab plays)`;
  const exits =
    way.exits === "trailing" ? "a stop that trails the best price and no target"
    : way.exits === "fixed" ? `a fixed ${view.assumptions.stopPct}% stop and ${view.assumptions.targetPct}% target`
    : `a stop and target set from how much NIFTY is moving${way.scalping ? " (the lab doesn't play your rupee stops)" : ""}`;
  const check = way.checked ? ", and only when NIFTY moves enough to cover the costs" : "";
  return `Played the way your trader is set up: one lot of the at-the-money option, bought and sold at the prices recorded that day, ${hold}, with ${exits}${check}, after Dhan's charges. The Decision Lab rules keep their own stops and targets.`;
}
