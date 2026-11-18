"use client";

// One study, written for someone without a finance background: first the answer (would this have
// made money, how much, what to do), one chart of the money over time, and everything else folded
// under Details. Money is rupees for one lot after costs; see rupeesPerPoint() for how.

import { useState, type ReactNode } from "react";
import { fieldClass } from "@/components/trading/shared";
import { buttonClass, DataTable, Panel, Td } from "@/components/ui";
import { DECISION_PROVIDERS, type DecisionProviderId } from "@/lib/engine/trading";
import { PLAIN_VERDICT, signalName, type DetailSummary, type GateGroup, type GateSummary, type ResearchJob, type ResearchStatus, type SliceKind, type StudyDetail } from "@/lib/research/types";
import { certainty, count, dayLabel, duration, istClock, likely, monthLabel, pct, pts, rupees, rupeesPerPoint, signedRupees, VERDICT_TONE } from "./research-format";
import { journey, type Journey as JourneyNumbers } from "@/lib/research/journey";
import { HorizonChart, MoneyChart, RangeBar } from "./study-charts";

const SLICE_GROUPS: { kind: SliceKind; title: string; hint: string }[] = [
  { kind: "split", title: "Earlier and later days", hint: "Something real should work in both halves, not just one." },
  { kind: "month", title: "Month by month", hint: "Steady strategies earn a little most months; luck shows as one or two big months." },
  { kind: "era", title: "Before and after NSE changed the close", hint: "On 3 August 2026 NSE changed how the trading day ends." },
  { kind: "time", title: "Time of day", hint: "When in the day the trade was made." },
  { kind: "side", title: "Betting up and betting down", hint: "Strategies that only work one way are often just riding the market." },
  { kind: "vix", title: "Calm and nervous markets", hint: "India VIX measures how nervous the market is." },
];

export interface GateControls {
  job: ResearchJob | null;
  decisions: ResearchStatus["decisions"] | null;
  onRun: (provider: DecisionProviderId) => void;
}

/** Input tokens in one trading question, measured on 17 November 2026; Liquid charges $0.042 a million. */
const TOKENS_PER_QUESTION = 1_330;
const LIQUID_USD_PER_TOKEN = 0.042 / 1e6;
/** A paid answer takes about half a second, plus the 0.25 s the pass waits between questions. */
const SECONDS_PER_PAID_QUESTION = 0.8;

/** The AI's probability bands (gate.ts), as "how sure". */
const SURE: Record<string, string> = { "Under 0.40": "under 40%", "0.40–0.55": "40–55%", "0.55–0.70": "55–70%", "0.70 and over": "70% or more" };

/** A summary row with its money in rupees for one lot instead of index points. */
function inRupees(row: DetailSummary, perPoint: number): DetailSummary {
  const r = (v: number | null) => (v === null ? null : v * perPoint);
  return { ...row, mean: r(row.mean), lo: r(row.lo), hi: r(row.hi), net_option: r(row.net_option), net_futures: r(row.net_futures), baseline: r(row.baseline) };
}

export function StudyReport({ detail, location, onRerun, rerunning, gate }: { detail: StudyDetail; location: string | null; onRerun: () => void; rerunning: boolean; gate: GateControls }) {
  const { manifest, summary, daily, events, checks } = detail;
  const { spec } = manifest;
  const { signal, horizon } = spec.primary;
  const perPoint = rupeesPerPoint(spec.costs);
  const costPoints = manifest.costs.optionPoints;
  const cost = costPoints * perPoint;
  const all = summary.find((r) => r.signal === signal && r.horizon === horizon && r.slice_kind === "all")!;
  const plain = PLAIN_VERDICT[all.verdict];
  const perTrade = all.net_option === null ? null : all.net_option * perPoint;
  const total = perTrade === null ? null : perTrade * all.firings;
  const enough = all.verdict !== "Too few firings" && total !== null;
  const lastCheck = checks[0];
  const run = journey(daily, events, { perPoint, cost, premium: spec.costs.option.premium * spec.costs.option.lot });

  const money = summary.map((r) => inRupees(r, perPoint));
  const slices = money.filter((r) => r.signal === signal && r.horizon === horizon && r.slice_kind !== "all");
  const byHorizon = spec.horizons.map((h) => money.find((r) => r.signal === signal && r.horizon === h && r.slice_kind === "all")).filter((r): r is DetailSummary => !!r);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <section className="rounded-sm border border-line bg-panel p-4">
        <p className="text-label text-muted">
          {spec.strategy ? `${spec.strategy.name}, version ${spec.strategy.version}` : signalName(signal)} · each trade held {horizon} minutes · {dayLabel(manifest.data.first)} – {dayLabel(manifest.data.last)}
        </p>
        <h2 className="mt-1 text-2xl leading-8 font-semibold">
          {!enough ? "Not enough trades to tell" : total! < 0 ? `Would have lost about ${rupees(total)}` : `Would have made about ${rupees(total)}`}
        </h2>
        {enough && (
          <>
            <p className="mt-1 text-body">
              {count(all.firings)} trades over {manifest.data.days} trading days, one lot each: on average each trade {perTrade! < 0 ? "lost" : "made"} {rupees(perTrade)} after costs.
            </p>
            <p className="mt-1 text-body">
              Starting with <strong>{rupees(run.needed)}</strong>, the least it needed, you&apos;d have ended with <strong>{rupees(run.ended)}</strong>:{" "}
              <span className={run.change < 0 ? "text-down" : "text-up"}>
                {run.change < 0 ? "down" : "up"} {Math.abs(run.change * 100).toFixed(0)}%
              </span>
              .
            </p>
          </>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className={`rounded-sm border px-2 py-0.5 text-body font-semibold ${VERDICT_TONE[all.verdict]}`}>{plain.label}</span>
          <span className="text-body font-medium">{plain.advice}</span>
        </div>
        {enough && <p className="mt-2 text-body text-muted">{certainty(all.lo, all.hi, costPoints)}</p>}
        <p className="mt-2 max-w-3xl text-label text-muted">
          An estimate: one lot ({spec.costs.option.lot} units) of a ₹{spec.costs.option.premium} option on every trade, with Dhan&apos;s charges and a little slippage ({rupees(cost)} a trade). The engine&apos;s daily limits would
          have stopped it sooner on bad days.
          {lastCheck?.matched && " Tested twice with the same result."}
        </p>
      </section>

      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-sm border border-line bg-line sm:grid-cols-3">
        <Stat label="Trades" value={count(all.firings)} hint={`about ${(all.firings / Math.max(1, manifest.data.days)).toFixed(1)} a day`} />
        <Stat label="Winning trades" value={pct(all.hit_rate, 0)} hint="tossing a coin would win 50%" />
        <Stat label="Average trade" value={signedRupees(perTrade)} hint={`after ${rupees(cost)} of costs`} />
      </dl>

      {enough && <Journey run={run} />}

      <Panel title="Money over time" meta="one lot, after costs, added up">
        <MoneyChart days={daily} cost={cost} perPoint={perPoint} />
      </Panel>

      <details className="group rounded-sm border border-line bg-panel">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-body text-muted select-none hover:text-fg">
          <span className="transition-transform group-open:rotate-90">▸</span> Details: the numbers behind the answer, and how it was tested
        </summary>
        <div className="flex flex-col gap-3 border-t border-line p-3">
          <Panel title="Would holding longer or shorter help?" meta="The average trade before costs; anything below the dashed line loses money">
            <HorizonChart rows={byHorizon} primary={horizon} cost={cost} />
          </Panel>

          <Panel title="Is it steady?" meta="The same test, split different ways" flush>
            <Stability rows={slices} cost={cost} />
          </Panel>

          <Panel title="Would the AI check have helped?" meta="The Decision API, asked about every trade">
            <GatePanel summary={detail.gate} firings={all.firings} controls={gate} perPoint={perPoint} cost={cost} premium={spec.costs.option.premium} />
          </Panel>

          {spec.signals.length > 1 && (
            <Panel title="Other strategies and holding times" meta="Measured in the same run; treat them as ideas to test, not results" flush>
              <Matrix rows={money} signals={spec.signals} horizons={spec.horizons} primary={spec.primary} />
            </Panel>
          )}

          <Panel title="Every trade" meta="Newest first" flush>
            <Trades events={events} horizon={horizon} perPoint={perPoint} />
          </Panel>

          <Provenance detail={detail} location={location} onRerun={onRerun} rerunning={rerunning} />
        </div>
      </details>
    </div>
  );
}

/** What running it would have been like, in sentences. */
function Journey({ run }: { run: JourneyNumbers }) {
  const items: { label: string; value: string; detail: string; tone?: string }[] = [
    {
      label: "Money needed",
      value: rupees(run.needed),
      detail: `${rupees(run.premium)} for one trade's option, plus ${rupees(run.dip?.amount ?? 0)} to ride out its worst stretch without running out.`,
    },
    {
      label: "Would have ended with",
      value: rupees(run.ended),
      detail: `${run.total < 0 ? "Lost" : "Made"} ${rupees(run.total)}: ${run.change < 0 ? "down" : "up"} ${Math.abs(run.change * 100).toFixed(0)}% on the money needed.`,
      tone: run.total < 0 ? "text-down" : "text-up",
    },
    {
      label: "Worst stretch",
      value: run.dip ? `−${rupees(run.dip.amount)}` : "None",
      detail: run.dip ? `From its high on ${dayLabel(run.dip.from)} to its low on ${dayLabel(run.dip.to)}.` : "It never fell below a previous high.",
    },
    {
      label: "Longest losing streak",
      value: run.streak ? `${run.streak.trades} trades` : "None",
      detail: run.streak ? `Lost ${rupees(run.streak.lost)} in a row, ${dayLabel(run.streak.from)} to ${dayLabel(run.streak.to)}.` : "No losing trades.",
    },
    {
      label: "Winners and losers",
      value: `${signedRupees(run.wins.average)} / ${signedRupees(run.losses.average)}`,
      detail: `A winning trade made ${rupees(run.wins.average)} on average (best ${rupees(run.wins.best)}); a losing one lost ${rupees(run.losses.average)} (worst ${rupees(run.losses.worst)}).`,
    },
    {
      label: "Months",
      value: `${run.months.up} of ${run.months.count} made money`,
      detail:
        run.months.best && run.months.worst
          ? run.months.up === 0
            ? `Every month lost money: the least bad was ${monthLabel(run.months.best.month)} (${signedRupees(run.months.best.money)}), the worst ${monthLabel(run.months.worst.month)} (${signedRupees(run.months.worst.money)}).`
            : `Best ${monthLabel(run.months.best.month)}, ${signedRupees(run.months.best.money)}; worst ${monthLabel(run.months.worst.month)}, ${signedRupees(run.months.worst.money)}.`
          : "",
    },
    {
      label: "Best and worst day",
      value: `${signedRupees(run.bestDay?.money)} / ${signedRupees(run.worstDay?.money)}`,
      detail: run.bestDay && run.worstDay ? `Best ${dayLabel(run.bestDay.day)}; worst ${dayLabel(run.worstDay.day)}.` : "",
    },
  ];
  return (
    <Panel title="What running it would have been like" meta="one lot, after costs">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <div key={item.label} className="min-w-0">
            <dt className="text-label text-muted">{item.label}</dt>
            <dd className={`text-lg leading-6 font-medium ${item.tone ?? ""}`}>{item.value}</dd>
            <dd className="text-label text-muted">{item.detail}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0 bg-panel px-3 py-2">
      <dt className="text-label text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg leading-6 font-medium">{value}</dd>
      <dd className="truncate text-label text-muted" title={hint}>
        {hint}
      </dd>
    </div>
  );
}

function Stability({ rows, cost }: { rows: DetailSummary[]; cost: number }) {
  const values = rows.flatMap((r) => [r.lo, r.hi]).filter((v): v is number => v !== null);
  const scale: [number, number] = [Math.min(-cost, ...values), Math.max(cost * 1.5, ...values)];
  return (
    <DataTable caption="The average trade in each part of the test" columns={["", "Trades", "Won", "Average trade before costs", "Likely between", { label: "Against zero and the cost", align: "left" }]} minWidth="min-w-[44rem]">
      {SLICE_GROUPS.flatMap((group) => {
        const list = rows.filter((r) => r.slice_kind === group.kind);
        if (!list.length) return [];
        return [
          <tr key={group.kind} className="bg-raised/40">
            <td colSpan={6} className="px-3 pt-2 pb-1">
              <span className="text-label font-medium text-fg">{group.title}</span>
              <span className="ml-2 text-label text-muted">{group.hint}</span>
            </td>
          </tr>,
          ...list.map((r) => (
            <tr key={`${group.kind}-${r.slice}`}>
              <Td>{group.kind === "month" ? monthLabel(r.slice) : sliceName(r.slice)}</Td>
              <Td numeric>{count(r.firings)}</Td>
              <Td numeric>{pct(r.hit_rate, 0)}</Td>
              <Td numeric className="font-medium">
                {signedRupees(r.mean)}
              </Td>
              <Td numeric className="text-muted">
                {likely(r.lo, r.hi)}
              </Td>
              <Td>
                <RangeBar mean={r.mean} lo={r.lo} hi={r.hi} scale={scale} cost={cost} />
              </Td>
            </tr>
          )),
        ];
      })}
    </DataTable>
  );
}

/** Slice names as stored, in plainer words where they need it. */
function sliceName(slice: string) {
  return ({ Long: "Betting up", Short: "Betting down", "Before closing auction": "Before 3 Aug 2026", "With closing auction": "From 3 Aug 2026" } as Record<string, string>)[slice] ?? slice;
}

function GatePanel({ summary, firings, controls, perPoint, cost, premium }: { summary: GateSummary | null; firings: number; controls: GateControls; perPoint: number; cost: number; premium: number }) {
  const { job, decisions } = controls;
  const [chosen, setChosen] = useState<DecisionProviderId | null>(null);
  const provider = chosen ?? decisions?.provider ?? "openrouter";
  const info = DECISION_PROVIDERS.find((p) => p.id === provider)!;
  const model = decisions?.providers?.[provider]?.model ?? info.defaultModel;
  const ready = decisions?.providers?.[provider]?.ready ?? false;
  // Only OpenRouter's free models have a daily quota, shared with live trading.
  const freeQuota = provider === "openrouter" && model.endsWith(":free");
  const free = freeQuota ? (decisions?.freeRemaining ?? null) : null;
  const canAsk = free === null ? null : Math.max(0, free - (decisions?.reserve ?? 0));
  const answeredHere = summary && summary.provider === provider && summary.model === model ? summary.answered : 0;
  const toAsk = Math.max(0, firings - answeredHere);
  const complete = summary !== null && summary.answered + summary.failed >= summary.firings;
  const r = (v: number | null) => (v === null ? null : v * perPoint);
  const groups: [string, GateGroup][] = summary
    ? [
        ["Trades it took", summary.approved],
        ["Trades it skipped", summary.turnedDown],
      ]
    : [];
  const traderName = decisions ? (DECISION_PROVIDERS.find((p) => p.id === decisions.provider)?.name ?? null) : null;
  const took = summary?.approved;
  const skipped = summary?.turnedDown;
  const answer =
    !summary || summary.answered === 0 || !took || !skipped || took.mean === null || skipped.mean === null
      ? null
      : took.lo !== null && skipped.hi !== null && took.lo > skipped.hi && (took.net_option ?? 0) > 0
        ? "Yes: the trades it took did clearly better, and made money after costs."
        : took.mean > skipped.mean
          ? "Not clearly: the trades it took did a little better, but not by enough to trust, and not enough to make money."
          : "No: the trades it took did worse than the ones it skipped.";

  return (
    <div className="flex flex-col gap-3 text-body">
      <p className="max-w-3xl text-muted">
        The trader can ask an AI (the Decision API) whether to take each trade. This asks it about each of the {count(firings)} trades and compares the ones it would have taken with the ones it would have skipped.
        It&apos;s worth keeping only if the trades it takes do clearly better <em>and</em> make money.
      </p>

      {summary && (
        <>
          {answer && <p className="text-body font-medium">{answer}</p>}
          <DataTable caption="Trades the AI would have taken and skipped" columns={["", "Trades", "Won", "Average before costs", "Likely between", "After costs"]} minWidth="min-w-[36rem]">
            {groups.map(([label, g]) => (
              <tr key={label}>
                <Td className="font-medium">{label}</Td>
                <Td numeric>{count(g.firings)}</Td>
                <Td numeric>{pct(g.hit_rate, 0)}</Td>
                <Td numeric className="font-medium">
                  {signedRupees(r(g.mean))}
                </Td>
                <Td numeric className="text-muted">
                  {likely(r(g.lo), r(g.hi))}
                </Td>
                <Td numeric>{signedRupees(r(g.net_option))}</Td>
              </tr>
            ))}
          </DataTable>
          <p className="text-label text-muted">
            A trade costs about {rupees(cost)}. {!complete && <span className="text-warn">Partial: {count(summary.answered)} of {count(summary.firings)} trades answered so far. </span>}
            Answers from {DECISION_PROVIDERS.find((p) => p.id === summary.provider)?.name ?? summary.provider} <code>{summary.model}</code>.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-label text-muted tabular-nums">
            {summary.byProbability
              .filter((b) => b.firings > 0)
              .map((b) => (
                <span key={b.band}>
                  AI {SURE[b.band] ?? b.band} sure: {count(b.firings)} trades, {signedRupees(r(b.mean))} each before costs
                </span>
              ))}
          </div>
          {summary.stopped && <p className="text-label text-muted">{summary.stopped}</p>}
        </>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-label text-muted">
          Ask with
          <select className={`${fieldClass} min-w-56`} value={provider} onChange={(e) => setChosen(e.target.value as DecisionProviderId)} disabled={job !== null}>
            {DECISION_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id} disabled={!decisions?.providers?.[p.id]?.ready}>
                {p.name}
                {decisions?.provider === p.id ? " (the trader's)" : ""}
                {decisions?.providers?.[p.id]?.ready === false ? ` (no ${p.keyName})` : ""}
              </option>
            ))}
          </select>
        </label>
        {job ? (
          <span className="h-7 text-label leading-7 text-muted">
            {job.state === "queued" ? "Waiting for the job before it…" : (job.progress?.label ?? "Starting…")}
            {job.progress && job.progress.total > 0 && ` (${count(job.progress.done)} of ${count(job.progress.total)})`}
          </span>
        ) : (
          <button type="button" className={buttonClass} onClick={() => controls.onRun(provider)} disabled={!ready || (canAsk === 0 && toAsk > 0)}>
            {answeredHere === 0 ? "Ask about these trades" : toAsk === 0 ? "Recompute" : "Carry on asking"}
          </button>
        )}
        <span className="h-7 text-label leading-7 text-muted">
          <code>{model}</code>
          {free !== null && decisions?.freeLimit !== null && (
            <>
              {" "}
              · {count(free)} of {count(decisions!.freeLimit!)} free answers left today; {decisions!.reserve} kept for live trading
              {canAsk !== null && ` (${count(canAsk)} for research now)`}
            </>
          )}
          {provider === "liquid" &&
            toAsk > 0 &&
            ` · about $${(toAsk * TOKENS_PER_QUESTION * LIQUID_USD_PER_TOKEN).toFixed(2)} and ${Math.max(1, Math.round((toAsk * SECONDS_PER_PAID_QUESTION) / 60))} min for the ${count(toAsk)} trades left`}
          {freeQuota && decisions?.error && ` · ${decisions.error}`}
        </span>
      </div>
      {free !== null && decisions?.freeLimit !== null && decisions!.freeLimit! <= 50 && (
        <p className="max-w-3xl text-label text-muted">
          OpenRouter&apos;s free allowance is {decisions!.freeLimit} answers a day, so a year of trades takes weeks; each run carries on where the last stopped. Liquid is paid but costs cents for a year.
        </p>
      )}
      {traderName && provider !== decisions?.provider && (
        <p className="max-w-3xl text-label text-warn">
          The trader asks {traderName}; these answers come from {info.name}, a different AI. They say whether {info.name} would be a good check, not whether the trader&apos;s is.
        </p>
      )}
      <p className="max-w-3xl text-label text-muted">
        The AI isn&apos;t told the date, the option contract or NIFTY&apos;s exact level, because it may know what happened on those days. It&apos;s told an assumed ₹{premium} option price.
      </p>
    </div>
  );
}

function Matrix({ rows, signals, horizons, primary }: { rows: DetailSummary[]; signals: string[]; horizons: number[]; primary: { signal: string; horizon: number } }) {
  return (
    <>
      <DataTable caption="The average trade after costs for every strategy and holding time" columns={["Strategy", ...horizons.map((h) => `Held ${h} min`)]} minWidth="min-w-[40rem]">
        {signals.map((signal) => (
          <tr key={signal}>
            <Td>{signalName(signal as never)}</Td>
            {horizons.map((h) => {
              const r = rows.find((x) => x.signal === signal && x.horizon === h && x.slice_kind === "all");
              const isPrimary = signal === primary.signal && h === primary.horizon;
              const net = r?.net_option ?? null;
              return (
                <Td key={h} numeric className={isPrimary ? "bg-raised ring-1 ring-accent/50 ring-inset" : ""}>
                  <span className={`font-medium ${net === null ? "" : net >= 0 ? "text-up" : "text-down"}`} title={r ? `${count(r.firings)} trades, ${pct(r.hit_rate, 0)} won, ${PLAIN_VERDICT[r.verdict].label.toLowerCase()}` : undefined}>
                    {signedRupees(net)}
                  </span>
                </Td>
              );
            })}
          </tr>
        ))}
      </DataTable>
      <p className="border-t border-line px-3 py-2 text-label text-muted">
        The average trade after costs. The highlighted one is the question asked; with {signals.length * horizons.length} tried at once, one can look good by luck alone.
      </p>
    </>
  );
}

const FIRST_TRADES = 25;

function Trades({ events, horizon, perPoint }: { events: StudyDetail["events"]; horizon: number; perPoint: number }) {
  const [all, setAll] = useState(false);
  const newest = [...events].reverse();
  const shown = all ? newest : newest.slice(0, FIRST_TRADES);
  if (!events.length) return <p className="p-3 text-label text-muted">No trades.</p>;
  return (
    <>
      <DataTable caption="Every trade of the strategy studied" columns={["Day", "Time", "Bet", "NIFTY then", `${horizon} min later`, "Before costs"]} minWidth="min-w-[36rem]">
        {shown.map((e) => (
          <tr key={e.at}>
            <Td>{dayLabel(e.day)}</Td>
            <Td numeric>{istClock(e.at + 60_000)}</Td>
            <Td>{e.vote > 0 ? <span className="text-up">▲ Up</span> : <span className="text-down">▼ Down</span>}</Td>
            <Td numeric>{e.entry.toFixed(2)}</Td>
            <Td numeric>{e.exit.toFixed(2)}</Td>
            <Td numeric className={e.points > 0 ? "text-up" : e.points < 0 ? "text-down" : ""}>
              {signedRupees(e.points * perPoint)}
            </Td>
          </tr>
        ))}
      </DataTable>
      <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-label text-muted">
        <span>
          Showing {count(shown.length)} of {count(events.length)}.
        </span>
        {events.length > FIRST_TRADES && (
          <button type="button" onClick={() => setAll(!all)} className="ml-auto text-accent hover:underline">
            {all ? "Show fewer" : "Show all"}
          </button>
        )}
      </div>
    </>
  );
}

function Provenance({ detail, location, onRerun, rerunning }: { detail: StudyDetail; location: string | null; onRerun: () => void; rerunning: boolean }) {
  const { manifest, checks } = detail;
  const { spec, data, code, costs, run } = manifest;
  const perPoint = rupeesPerPoint(spec.costs);
  const base = location ? `${location}research/${run.namespace}` : `research/${run.namespace}`;
  const sql = `SELECT signal, horizon, slice_kind, slice, firings, mean, lo, hi, verdict\nFROM read_parquet('${base}/summary/${manifest.id}.parquet')\nWHERE slice_kind = 'all' ORDER BY mean DESC;`;
  return (
    <details className="group/how rounded-sm border border-line bg-panel">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2 text-label font-medium tracking-wider text-muted uppercase select-none hover:text-fg">
        <span className="transition-transform group-open/how:rotate-90">▸</span> How it was tested
        <span className="ml-auto font-normal tracking-normal normal-case">{manifest.id}</span>
      </summary>
      <div className="grid gap-4 border-t border-line p-3 text-body lg:grid-cols-2">
        <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5">
          <Item label="The test">
            Every minute between {spec.window.from} and {spec.window.until} where {signalName(spec.primary.signal)} said &ldquo;up&rdquo; or &ldquo;down&rdquo; counts as a trade, using the engine&apos;s own code. The result is how far NIFTY moved
            that way over the next {spec.primary.horizon} minutes. One trade at a time.
          </Item>
          <Item label="Data">
            Every minute of NIFTY and its 50 stocks, {data.days} trading days from {dayLabel(data.first)} to {dayLabel(data.last)}.
          </Item>
          <Item label="Days left out">{data.dropped.length ? data.dropped.map((d) => `${dayLabel(d.date)}: ${d.reason}`).join("; ") : "None"}</Item>
          <Item label="Money">
            Rupees are for one lot of {spec.costs.option.lot} units of an option that moves about {spec.costs.option.delta} rupee for each point NIFTY moves, so ₹{perPoint} a point. A trade costs {rupees(costs.optionPoints * perPoint)}: Dhan&apos;s
            charges at a ₹{spec.costs.option.premium} premium plus ₹{spec.costs.option.slippage} slippage each way. Options also lose a little value while held, which isn&apos;t counted, so real results would be slightly worse.
          </Item>
          <Item label="Likely between">The range the average would fall in 95 times out of 100 if the year were replayed with different luck, found by reshuffling whole days 2,000 times.</Item>
          <Item label="In index points">
            Average trade {pts(detail.summary.find((r) => r.signal === spec.primary.signal && r.horizon === spec.primary.horizon && r.slice_kind === "all")?.mean ?? null)} points before costs; a trade costs {pts(costs.optionPoints)} points as an option, {pts(costs.futuresPoints)} as a futures lot.
          </Item>
        </dl>
        <div className="flex min-w-0 flex-col gap-3">
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5">
            <Item label="Study id">
              <code className="break-all">{manifest.id}</code>
            </Item>
            <Item label="Engine">
              {code.version} · Node {run.node} · {run.namespace} · ran in {duration(run.ms)}
            </Item>
            <Item label="Code and data">
              Signal code <code className="text-label">{code.signals.slice(0, 12)}</code>, study code <code className="text-label">{code.study.slice(0, 12)}</code>, {data.sources.length} data files pinned by their ETags
            </Item>
            <Item label="Results hash">
              <code className="break-all text-label">{manifest.results.hash.slice(0, 16)}</code>
            </Item>
            <Item label="Reruns">
              {checks.length === 0
                ? "Not rerun yet."
                : checks.map((c) => (
                    <span key={c.at} className="block">
                      {dayLabel(new Date(c.at + 19_800_000).toISOString().slice(0, 10))}: {c.matched ? "same result" : c.sameInputs ? "a different result from the same inputs" : "a different result: the data or code had changed"}
                    </span>
                  ))}
            </Item>
          </dl>
          <div>
            <button type="button" className={buttonClass} onClick={onRerun} disabled={rerunning}>
              {rerunning ? "Rerun queued…" : "Run it again to check the result"}
            </button>
            <p className="mt-1 text-label text-muted">Runs the same test from the same data and checks it gives exactly the same result. Nothing is overwritten.</p>
          </div>
          <div className="min-w-0">
            <div className="text-label text-muted">Query it with DuckDB</div>
            <pre className="mt-1 overflow-x-auto rounded-sm border border-line bg-canvas p-2 text-[11px] leading-4">{sql}</pre>
          </div>
        </div>
      </div>
    </details>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-label text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
