"use client";

// What each signal means, in plain words, for the Strategies page: an ⓘ button beside each signal
// opens a dialog with a tab per signal. Each tab says what the signal watches, when it votes, the
// idea behind it, why it stays silent, a right and a wrong example from a recorded day, and live:
// its reading now, how it has done today and its latest firings, as the engine reports them.
//
// The rules here are written out by hand: keep them in step with `definitions` in
// src/lib/insight/pulse.ts.

import type { ReactNode } from "react";
import { Dialog } from "@/components/dialog";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/tabs";
import { SIGNALS, type SignalId, type SignalReading, type SignalReadingLine } from "@/lib/engine/trading";
import { clock } from "./shared";

const MINUTE_MS = 60_000;
/** One lot (65) of an at-the-money option moves about ₹0.50 per NIFTY point: ₹32.50 a point. */
const RUPEES_PER_POINT = 32.5;
/** Charges and the spread on one lot, round trip, at a ₹100–150 premium. */
const COST_PER_TRADE = 130;

interface Example {
  /** IST, when the minute closed and the signal was read. */
  time: string;
  vote: 1 | -1;
  reading: string;
  from: number;
  to: number;
  note?: string;
}

interface Guide {
  group: "Price" | "Futures and options" | "Combined";
  /** The line it must cross, short, for the table. */
  line: string;
  watches: string;
  votes: string;
  idea: string;
  silent: string[];
  right: Example;
  wrong: Example;
}

/** Examples are from 18 November 2026, the first day with futures and options recorded, at a 10-minute hold. */
export const GUIDE: Record<SignalId, Guide> = {
  breadth: {
    group: "Price",
    line: "6 stocks in 5 min",
    watches: "NIFTY's 50 stocks: how many are up on the day and how many are down. It compares that count with 5 minutes ago.",
    votes: "Count rising NIFTY stocks minus falling stocks. A rise of 6 or more in that count over 5 minutes signals a call. A fall of 6 or more signals a put.",
    idea: "A sudden swing in how many stocks are rising means buying (or selling) is spreading across the market, not stuck in one or two heavyweights. The hope is that NIFTY follows the crowd.",
    silent: ["The net count changed by less than 6. Most minutes are like this.", "The first 5 minutes of the day: nothing to compare with yet."],
    right: { time: "09:37", vote: -1, reading: "−6 stocks in 5 min", from: 25284.45, to: 25228.75 },
    wrong: { time: "12:17", vote: 1, reading: "+6 stocks in 5 min", from: 25264.7, to: 25230.9 },
  },
  lead: {
    group: "Price",
    line: "0.04% in 5 min",
    watches: "The average stock (every stock counted equally) against NIFTY over the last 5 minutes.",
    votes: "When the average stock beat NIFTY by 0.04% (4 basis points) or more, it votes ▲ long. When it lagged by that much, ▼ short.",
    idea: "NIFTY is weighted towards a few giants. If ordinary stocks are already moving and the giants haven't caught up, the index may follow.",
    silent: ["Stocks and NIFTY moved about the same.", "The first 5 minutes of the day."],
    right: { time: "09:47", vote: 1, reading: "+4.7 bps vs NIFTY", from: 25228.75, to: 25271.75 },
    wrong: { time: "09:21", vote: 1, reading: "+4.5 bps vs NIFTY", from: 25345.2, to: 25314.1 },
  },
  momentum: {
    group: "Price",
    line: "0.12% in 15 min",
    watches: "How far NIFTY moved over the last 15 minutes.",
    votes: "When NIFTY rose 0.12% or more (about 30 points) in 15 minutes, it votes ▲ long. When it fell that much, ▼ short.",
    idea: "A market already moving tends to keep moving for a while. It is the simplest signal there is, and the one everything else is compared with.",
    silent: ["NIFTY moved less than 0.12% in 15 minutes.", "Before 09:30: there aren't 15 minutes of the day yet."],
    right: { time: "09:31", vote: -1, reading: "−0.20% in 15 min", from: 25314.1, to: 25271.7 },
    wrong: { time: "12:04", vote: -1, reading: "−0.14% in 15 min", from: 25224.1, to: 25236.25, note: "This is the reading behind your 12:04 put." },
  },
  flow: {
    group: "Futures and options",
    line: "70% one side, 5 min",
    watches: "Who is trading NIFTY's near-month future: buyers who pay the asking price, or sellers who accept the bid. Each trade is sorted by its price against the order book just before it.",
    votes: "When buyers made 70% or more of what traded in the last 5 minutes, it votes ▲ long. When sellers did, ▼ short. Not when trading was thin.",
    idea: "Someone who pays the asking price is in a hurry. When most of the volume is people in a hurry on one side, the price usually has to move their way.",
    silent: ["Neither side reached 70%.", "Thin trading: under 30% of the day's usual volume in those 5 minutes. The reading then ends in “thin”.", "Days before 18 November 2026: no futures were recorded."],
    right: { time: "09:30", vote: -1, reading: "sellers 71% in 5 min", from: 25293.95, to: 25266.5 },
    wrong: { time: "12:21", vote: 1, reading: "buyers 74% in 5 min", from: 25238.45, to: 25215.3 },
  },
  buildup: {
    group: "Futures and options",
    line: "0.12% move + OI 0.2%",
    watches: "NIFTY's near-month future over 15 minutes: how far its price moved, and whether open interest (the number of open positions) grew.",
    votes: "When the future moved 0.12% or more and open interest rose 0.2% or more, it follows the move: ▲ long if up, ▼ short if down.",
    idea: "A move with growing positions means new money is betting on it (long or short build-up). A move with shrinking positions is people closing old bets (short covering, long unwinding), which tends to fade.",
    silent: ["The price moved less than 0.12%.", "Open interest didn't grow by 0.2%: the move came from people closing positions.", "Days before 18 November 2026."],
    right: { time: "09:32", vote: -1, reading: "−0.14%, OI +0.26%", from: 25332.85, to: 25250.45 },
    wrong: { time: "13:09", vote: -1, reading: "−0.16%, OI +0.37%", from: 25152.2, to: 25194 },
  },
  writers: {
    group: "Futures and options",
    line: "3% of OI, 15 min",
    watches: "Options within 10 strikes of NIFTY's price on the nearest expiry: how many new puts and calls were written (sold) in the last 15 minutes.",
    votes: "When put open interest grew faster than call open interest by 3% or more of the total, it votes ▲ long. When calls grew faster, ▼ short.",
    idea: "Option sellers are often large and well informed, and they sell where they think NIFTY won't go. Many new puts suggest they see a floor; many new calls, a ceiling.",
    silent: ["Puts and calls grew at about the same rate.", "Before 09:30.", "Days before 18 November 2026."],
    right: { time: "09:33", vote: -1, reading: "puts +147.5k, calls +217.0k lots", from: 25325.75, to: 25237.45, note: "Calls grew by 69,500 lots more than puts." },
    wrong: { time: "12:29", vote: 1, reading: "puts +71.5k, calls −23.2k lots", from: 25224.7, to: 25193.65 },
  },
  book20: {
    group: "Futures and options",
    line: "20% lean, 20 levels",
    watches: "The orders waiting in NIFTY's near-month future: the 20 best bids and the 20 best asks, from Dhan's 20-level depth feed. It compares how much is waiting to buy with how much is waiting to sell.",
    votes: "When the bids outweigh the asks by 20% or more of the two together (60% bids or more), it votes ▲ long. When the asks outweigh the bids that much, ▼ short.",
    idea: "A heavy side of the book is buyers (or sellers) lining up. The hope is that price drifts towards the side with less in the way. On 18 November it nudged the next minute by under a point, far less than a trade costs: watch it, don't expect it to pay.",
    silent: ["The book was roughly balanced. About three minutes in four are like this.", "Days before 18 November 2026, and any day without a depth file."],
    right: { time: "14:12", vote: 1, reading: "bids 68% of 20 levels", from: 25232.5, to: 25260.75 },
    wrong: { time: "09:48", vote: -1, reading: "asks 75% of 20 levels", from: 25237.65, to: 25305.6 },
  },
  agree: {
    group: "Combined",
    line: "2 of 3 price signals",
    watches: "The three price signals: Breadth thrust, Basket leads index and 15-minute momentum.",
    votes: "When at least two of them point the same way (counting one against as cancelling one for), it votes that way.",
    idea: "Two different reasons agreeing should be more reliable than one. It also fires less often, so there are fewer trades and fewer charges.",
    silent: ["Fewer than two price signals voted the same way, or they disagreed."],
    right: { time: "09:37", vote: -1, reading: "Breadth thrust −6, 15-minute momentum −0.25%", from: 25284.45, to: 25228.75 },
    wrong: { time: "09:23", vote: 1, reading: "Breadth thrust +12, Basket leads index +4.0 bps", from: 25370.75, to: 25325.75 },
  },
  confirmed: {
    group: "Combined",
    line: "price + futures/options",
    watches: "Six signals: the three price signals and three futures and options signals (order flow, OI build-up, option writers; not Order book lean).",
    votes: "When the price signals that fired all point one way, at least one futures or options signal agrees and none disagrees, it votes that way.",
    idea: "A price move is only a hint. When the people trading futures and options are betting the same way, the move has money behind it.",
    silent: ["No price signal fired, or they disagreed.", "No futures or options signal agreed, or one disagreed.", "Days before 18 November 2026."],
    right: { time: "09:30", vote: -1, reading: "Breadth thrust −16, futures sellers 71%", from: 25293.95, to: 25266.5 },
    wrong: { time: "13:09", vote: -1, reading: "15-minute momentum −0.14%, futures sellers 83%, OI build-up", from: 25152.2, to: 25194 },
  },
  ofi: {
    group: "Combined",
    line: "breadth + OFI agree",
    watches:
      "Breadth thrust, and the five best bids and asks of NIFTY's near-month future over the last minute: whether the buyers' queues grew against the sellers' (the order-flow imbalance, OFI). It is read 1.5 seconds after each minute closes.",
    votes: "When Breadth thrust fires and the OFI points the same way, it votes breadth's way.",
    idea: "Breadth says the stocks are moving together; the OFI says whether the futures book leans the same way right now. On 18 to 23 November, with a 15-minute hold, breadth alone made ₹273 a vote after charges and breadth checked by the OFI ₹384, counting the votes it skipped as ₹0. Two of those days gave nearly all of it, and they were seen while writing it, so it is graded only from 25 November.",
    silent: [
      "Breadth thrust didn't fire.",
      "The OFI pointed the other way, or was flat.",
      "Under 45 seconds of usable futures book in the last minute: a side not updated for over 2 seconds, a restart or a reconnect starts it over. About a third of breadth's votes are like this.",
      "Days before 18 November 2026, and any day without a depth file.",
    ],
    right: { time: "10:15", vote: -1, reading: "breadth −9, OFI −30.0", from: 25285.25, to: 25247.05 },
    wrong: { time: "09:44", vote: -1, reading: "breadth −11, OFI −14.0", from: 25244.7, to: 25291.55 },
  },
};

const signedPoints = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
/** Rupees, rounded to tens (fifties from ₹1,000): these are rough figures. */
const rupees = (v: number) => {
  const size = Math.abs(v);
  const rounded = size >= 1000 ? Math.round(size / 50) * 50 : Math.round(size / 10) * 10;
  return `${v < 0 && rounded > 0 ? "−" : ""}₹${rounded.toLocaleString("en-IN")}`;
};

/** How close a single signal's number is to its line: a bar that fills at the line. */
export function Closeness({ value, threshold, compact = false }: { value: number | null | undefined; threshold: number | null | undefined; compact?: boolean }) {
  if (value == null || !threshold) return <span className="text-muted">—</span>;
  const share = Math.min(1, Math.abs(value) / threshold);
  const tone = share >= 1 ? (value > 0 ? "bg-up" : "bg-down") : "bg-muted";
  return (
    <span className="inline-flex items-center gap-1.5" title={`${Math.round((Math.abs(value) / threshold) * 100)}% of the way to its line`}>
      <span className={`relative h-1.5 overflow-hidden rounded-full bg-line-strong ${compact ? "w-12" : "w-24"}`}>
        <span className={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width: `${share * 100}%` }} />
      </span>
      <span className="text-label text-muted tabular-nums">{Math.round(share * 100)}%</span>
    </span>
  );
}

/** A firing's result: NIFTY's move over the hold, signed, and whether it went the signal's way. */
export function Outcome({ vote, outcome }: { vote: 1 | -1; outcome: number | null }) {
  if (outcome === null) return <span className="text-muted">hold running</span>;
  const right = outcome !== 0 && Math.sign(outcome) === vote;
  return (
    <span className={right ? "text-up" : "text-down"}>
      {signedPoints(outcome)} pts, {right ? "right" : "wrong"}
    </span>
  );
}

export function Arrow({ vote }: { vote: 1 | -1 | 0 }) {
  if (vote === 0) return <span className="text-muted">—</span>;
  return <span className={vote > 0 ? "text-up" : "text-down"}>{vote > 0 ? "▲" : "▼"}</span>;
}

export function InfoButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-accent focus-visible:text-accent">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5.5M12 7.6v.1" />
      </svg>
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-1">
      <h3 className="text-label font-medium tracking-wider text-muted uppercase">{title}</h3>
      <div className="text-body leading-relaxed">{children}</div>
    </section>
  );
}

function ExampleCard({ example, kind }: { example: Example; kind: "right" | "wrong" }) {
  const move = example.to - example.from;
  const gained = move * example.vote;
  return (
    <div className={`rounded-sm border px-3 py-2 ${kind === "right" ? "border-up/40" : "border-down/40"}`}>
      <p className="text-label text-muted">{kind === "right" ? "When it was right" : "When it was wrong"}</p>
      <p className="mt-1">
        <span className="tabular-nums">{example.time}</span> <Arrow vote={example.vote} /> {example.vote > 0 ? "long" : "short"} on <span className="font-medium">{example.reading}</span>
      </p>
      <p className="mt-0.5 text-muted tabular-nums">
        NIFTY {example.from.toLocaleString("en-IN")} → {example.to.toLocaleString("en-IN")} in 10 min ({signedPoints(move)} pts)
      </p>
      <p className={`mt-0.5 ${gained > 0 ? "text-up" : "text-down"}`}>
        {gained > 0 ? "Made" : "Lost"} about {rupees(Math.abs(gained) * RUPEES_PER_POINT)} on one lot, before costs
      </p>
      {example.note && <p className="mt-0.5 text-label text-muted">{example.note}</p>}
    </div>
  );
}

function Live({ line, followed }: { line: SignalReadingLine | undefined; followed: boolean }) {
  if (!line) return <p className="text-muted">No reading yet: signals are read at the close of each minute once the session is open.</p>;
  const guide = GUIDE[line.id];
  const today = line.today;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm bg-raised/60 px-3 py-2">
        <span>
          Now: <span className="font-medium">{line.reading}</span>
        </span>
        <span>
          Vote <Arrow vote={line.vote} /> {line.vote === 0 ? "silent" : line.vote > 0 ? "long" : "short"}
        </span>
        {line.threshold != null && (
          <span className="inline-flex items-center gap-1.5">
            Line {guide.line} <Closeness value={line.value} threshold={line.threshold} />
          </span>
        )}
        {followed && <span className="text-label text-accent">The strategy follows this signal</span>}
      </div>
      {today === undefined ? (
        <p className="text-muted">Restart the engine to see how this signal has done today.</p>
      ) : today.fired === 0 ? (
        <p className="text-muted">It hasn&apos;t fired today yet (counting firings whose {today.horizon}-minute hold has ended).</p>
      ) : (
        <p>
          Today at a {today.horizon}-minute hold: fired <span className="font-medium">{today.fired}</span> times, NIFTY then moved its way <span className="font-medium">{today.right}</span> times,{" "}
          <span className={today.points >= 0 ? "text-up" : "text-down"}>{signedPoints(today.points)} pts</span> in all. On one lot that is about{" "}
          <span className={today.points >= 0 ? "text-up" : "text-down"}>{rupees(today.points * RUPEES_PER_POINT)}</span> before costs, and costs would take about {rupees(today.fired * COST_PER_TRADE)} more.
        </p>
      )}
      {line.recent && line.recent.length > 0 && (
        <table className="w-full text-body">
          <caption className="sr-only">Latest firings today</caption>
          <thead>
            <tr className="border-b border-line text-left text-label tracking-wider text-muted uppercase">
              <th className="h-7 pr-3 font-medium">Read at</th>
              <th className="h-7 pr-3 font-medium">Vote</th>
              <th className="h-7 pr-3 font-medium">Reading</th>
              <th className="h-7 text-right font-medium">NIFTY over {today?.horizon ?? "the"} min</th>
            </tr>
          </thead>
          <tbody>
            {line.recent.map((firing) => (
              <tr key={firing.at} className="border-b border-line/60 last:border-0">
                <td className="h-7 pr-3 tabular-nums">{clock(firing.at + MINUTE_MS).slice(0, 5)}</td>
                <td className="h-7 pr-3">
                  <Arrow vote={firing.vote} />
                </td>
                <td className="h-7 pr-3 text-muted">{firing.reading}</td>
                <td className="h-7 text-right tabular-nums">
                  <Outcome vote={firing.vote} outcome={firing.outcome} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PastYear({ id }: { id: SignalId }) {
  const record = SIGNALS.find((s) => s.id === id)?.pastYear;
  if (!record) return <p>No history yet: futures and options have been recorded only since 18 November 2026. Judge it on the days that follow.</p>;
  const perTrade = record.pointsPerTrade * RUPEES_PER_POINT;
  return (
    <p>
      Over {record.span}, at a {record.holdMinutes}-minute hold, it was right {(record.winRate * 100).toFixed(1)}% of {record.trades.toLocaleString("en-IN")} times: a coin flip. It averaged {rupees(perTrade)} a trade on one lot before costs, against about {rupees(COST_PER_TRADE)} of costs, so it{" "}
      <span className="text-down">lost money after costs</span>.
    </p>
  );
}

function Overview() {
  return (
    <div className="grid gap-4">
      <Section title="Every minute">
        1.5 seconds after each minute ends (12:04:00, 12:05:00, …), the engine rereads the whole day from the recording and asks every signal its question again. Each minute is a fresh check; nothing carries over.
      </Section>
      <Section title="Votes">
        Each signal measures one number. If it crosses the signal&apos;s line, the signal votes <span className="text-up">▲ long</span> (NIFTY should rise: buy a call) or <span className="text-down">▼ short</span> (NIFTY should fall: buy a put). If not, it stays silent (—). Signals are silent most of the time on purpose: each speaks only when something unusual happens, on about a quarter of minutes or less.
      </Section>
      <Section title="Why a signal stays silent">
        <ul className="list-disc space-y-0.5 pl-5">
          <li>It didn&apos;t cross its line. This is the usual reason; the bar in the table shows how close it is.</li>
          <li>Too early: the 5-minute signals start at 09:20, the 15-minute ones at 09:30.</li>
          <li>No data (—): days before 18 November 2026 have no futures or options.</li>
          <li>Only half its condition was met, or trading was thin. Each tab says which.</li>
          <li>From 15:15 the closing auction freezes stock prices, so nothing votes.</li>
        </ul>
      </Section>
      <Section title="A vote is not a trade">
        The engine trades only the signal you follow, and only when entries are on, inside the entry window, with room for a position, after the wait since the last trade, and when the decision API agrees. The Activity page records each proposal and why it was or wasn&apos;t taken.
      </Section>
      <Section title="Right and wrong">
        A firing is right when NIFTY moved its way over the hold. Rupees are for one lot (65) of an at-the-money option, which moves about ₹0.50 per NIFTY point, before costs. Costs (charges and the spread) are about {rupees(COST_PER_TRADE)} a trade, so a signal must be right well over half the time to make money. Over the past year none of the price signals was.
      </Section>
    </div>
  );
}

/** The dialog: an overview tab, then a tab per signal. Opens on `initial`. */
export function SignalGuide({ open, onClose, initial, signal, follow }: { open: boolean; onClose: () => void; initial: SignalId | "overview"; signal: SignalReading | null; follow: SignalId | null }) {
  const tabClass =
    "flex w-full shrink-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body whitespace-nowrap text-muted hover:bg-raised hover:text-fg data-[selected]:bg-raised data-[selected]:font-medium data-[selected]:text-fg sm:whitespace-normal";
  return (
    <Dialog open={open} onClose={onClose} title="What the signals mean">
      <Tabs key={initial} defaultValue={initial} className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[13rem_minmax(0,1fr)] sm:grid-rows-1">
        <TabsList aria-label="Signals" className="flex gap-0.5 overflow-x-auto border-b border-line p-1.5 sm:flex-col sm:overflow-y-auto sm:border-r sm:border-b-0">
          <TabsTab value="overview" className={tabClass}>
            How signals work
          </TabsTab>
          {SIGNALS.map((s) => {
            const vote = signal?.readings.find((r) => r.id === s.id)?.vote ?? 0;
            return (
              <TabsTab key={s.id} value={s.id} className={tabClass}>
                <span className="w-3 text-center">
                  <Arrow vote={vote} />
                </span>
                <span>{s.name}</span>
              </TabsTab>
            );
          })}
        </TabsList>
        <TabsPanel value="overview" className="min-h-0 overflow-y-auto p-4 outline-none">
          <Overview />
        </TabsPanel>
        {SIGNALS.map((s) => {
          const guide = GUIDE[s.id];
          return (
            <TabsPanel key={s.id} value={s.id} className="min-h-0 overflow-y-auto p-4 outline-none">
              <div className="grid gap-4">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <h3 className="text-lg font-semibold">{s.name}</h3>
                  <span className="text-label text-muted">{guide.group}</span>
                </div>
                <Section title="Live">
                  <Live line={signal?.readings.find((r) => r.id === s.id)} followed={s.id === follow} />
                </Section>
                <Section title="What it watches">{guide.watches}</Section>
                <Section title="When it votes">{guide.votes}</Section>
                <Section title="The idea">{guide.idea}</Section>
                <Section title="When it stays silent">
                  <ul className="list-disc space-y-0.5 pl-5">
                    {guide.silent.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                    <li>From 15:15, the closing auction.</li>
                  </ul>
                </Section>
                <Section title="Examples from 18 November 2026">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <ExampleCard example={guide.right} kind="right" />
                    <ExampleCard example={guide.wrong} kind="wrong" />
                  </div>
                </Section>
                <Section title="Over the past year">
                  <PastYear id={s.id} />
                </Section>
              </div>
            </TabsPanel>
          );
        })}
      </Tabs>
    </Dialog>
  );
}
