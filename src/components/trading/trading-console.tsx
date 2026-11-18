"use client";

// The Strategies page: the engine's paper trading. What it is doing now, the open position, the
// day's trades after charges, what the decision API said about each entry, the settings, and the
// runs stored as Parquet. The engine does the trading; this page shows it and sends commands.

import { Fragment, useCallback, useEffect, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { controlTrading } from "@/app/(cockpit)/strategies/actions";
import { buttonClass, DataTable, EmptyState, Field, PageHeader, Panel, Pnl, StatRow, Tag, Td } from "@/components/ui";
import {
  DECISION_PROVIDERS,
  DEFAULT_TRADING_CONFIG,
  holdMinutesFor,
  isScalping,
  SIGNALS,
  type DecisionProviderId,
  type DecisionRecord,
  type DecisionRequest,
  type Intent,
  type Position,
  type RunRow,
  type SignalId,
  type Trade,
  type TradeRow,
  type TradingCommand,
  type TradingCommandResult,
  type TradingConfig,
  type TradingHistory,
  type TradingStatus,
} from "@/lib/engine/trading";
import { inr, istDateTime, price, quantity } from "@/lib/format";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/tabs";
import { breakevenSellPrice } from "@/lib/trading/charges";
import { exitLevels } from "@/lib/trading/exits";
import { clock, EXIT_REASON, fieldClass, NoTrading, useTrading, Vote } from "./shared";
import { ScalpLabPanel } from "./scalp-lab-panel";
import { Arrow, Closeness, GUIDE, InfoButton, Outcome, SignalGuide } from "./signal-guide";

export function TradingConsole() {
  const telemetry = useTrading();
  const trading = telemetry.trading;
  const [result, setResult] = useState<TradingCommandResult | null>(null);
  const [shadowShown, setShowShadow] = useState(false);
  const [pending, startTransition] = useTransition();
  // Stable, so the notice's fade timer isn't restarted by every telemetry update.
  const dismiss = useCallback(() => setResult(null), []);

  const send = (command: TradingCommand) =>
    startTransition(async () => {
      setResult(await controlTrading(command));
    });

  if (!trading) {
    return (
      <>
        <PageHeader title="Strategies" />
        <div className="p-2 sm:p-3">
          <NoTrading telemetry={telemetry} />
        </div>
      </>
    );
  }

  const { config, run } = trading;
  const open = trading.positions.filter((p) => p.book === "paper");
  // Shadow trades get their own panel, never rows among the real ones.
  const showShadow = shadowShown && (trading.trades.some((t) => t.book === "shadow") || trading.positions.some((p) => p.book === "shadow"));
  return (
    <>
      <PageHeader
        title="Strategies"
        meta={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <Tag>Paper</Tag>
            <ScalpingBadge config={config} />
            <span>{trading.source === "replay" ? `Replay of ${run?.date ?? "a recorded day"}` : "Live market"}</span>
            <span className="tabular-nums">{clock(trading.marketTime)} IST</span>
          </span>
        }
      >
        <Watching trading={trading} />
        {trading.halt ? (
          <button type="button" className={buttonClass} disabled={pending} onClick={() => send({ action: "resume" })}>
            Resume trading
          </button>
        ) : (
          run && (
            <button type="button" className={buttonClass} disabled={pending} onClick={() => send({ action: "halt" })} title="Sell what is open and take no more entries today">
              Stop for the day
            </button>
          )
        )}
        {open.length > 0 && (
          <button type="button" className={buttonClass} disabled={pending} onClick={() => send({ action: "flatten" })}>
            {open.length === 1 ? "Sell open position" : `Sell ${open.length} open positions`}
          </button>
        )}
        <button
          type="button"
          className={`${buttonClass} ${config.armed ? "" : "border-accent text-accent"}`}
          disabled={pending}
          onClick={() => send({ action: config.armed ? "disarm" : "arm" })}
        >
          {config.armed ? "Turn entries off" : "Start paper trading"}
        </button>
      </PageHeader>

      <div className="space-y-2 p-2 sm:p-3">
        <Notices trading={trading} result={result} onDismiss={dismiss} />
        <Totals trading={trading} />
        <Now trading={trading} />
        {open.length > 0 && <OpenPositions positions={open} decisions={trading.decisions} />}
        <Trades trades={trading.trades} decisions={trading.decisions} prices={trading.prices ?? {}} showShadow={showShadow} onShowShadow={setShowShadow} />
        {showShadow && <ShadowBook trading={trading} />}
        <ScalpLabPanel lab={trading.scalpLab} />
        <Decisions trading={trading} />
        <Settings key={JSON.stringify({ ...config, armed: null })} config={config} pending={pending} send={send} providers={trading.decisionProviders ?? { openrouter: trading.decisionReady, liquid: false }} />
        <History live={run?.id ?? null} />
      </div>
    </>
  );
}

function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-sm border border-line bg-panel px-3 py-2" title={hint}>
      <div className="text-label text-muted">{label}</div>
      <div className="mt-0.5 text-lg leading-6 font-medium tabular-nums">{children}</div>
    </div>
  );
}

function Totals({ trading }: { trading: TradingStatus }) {
  const { paper, shadow } = trading.totals;
  const score = trading.decisionScore;
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      <Stat label="Net P&L, after charges" hint="Closed paper trades, after brokerage, STT, exchange fees, stamp duty and GST">
        <Pnl value={paper.net} />
      </Stat>
      <Stat label="Open position" hint="What the open position would add if sold now, after charges on both orders">
        {trading.positions.some((p) => p.book === "paper") ? <Pnl value={paper.open} /> : <span className="text-muted">—</span>}
      </Stat>
      <Stat label="Trades">
        {paper.trades}
        <span className="ml-1.5 text-label text-muted">{paper.wins} won</span>
      </Stat>
      <Stat label="Charges paid" hint="Brokerage and statutory charges on every fill, at Dhan's rates">
        {inr.format(paper.charges)}
      </Stat>
      <Stat label="Largest drawdown" hint="The furthest the day's net P&L fell from its high">
        {inr.format(paper.maxDrawdown)}
      </Stat>
      <Stat label="Turned down by the gate" hint="Trades the decision API turned down, followed on the shadow book">
        {score.vetoed}
        {shadow.trades > 0 && (
          <span className="ml-1.5 text-label text-muted">
            would have made <Pnl value={shadow.net} />
          </span>
        )}
      </Stat>
    </div>
  );
}

/**
 * What trading is doing, small, beside the buttons: "Looking for a signal" with a live dot while it
 * waits for the followed signal, otherwise the engine's one-line note.
 */
function Watching({ trading }: { trading: TradingStatus }) {
  const followed = SIGNALS.find((s) => s.id === trading.config.strategy.signal)?.name ?? trading.config.strategy.signal;
  const looking = trading.state === "ready" && !trading.positions.some((p) => p.book === "paper");
  const tone = { ready: "bg-up", waiting: "bg-warn", halted: "bg-down", starting: "bg-muted", disarmed: "bg-muted", closed: "bg-muted" }[trading.state];
  return (
    <span role="status" className="inline-flex max-w-[min(32rem,60vw)] items-center gap-2 text-label text-muted" title={trading.note}>
      <span className="relative inline-flex size-2 shrink-0">
        {looking && <span className={`absolute inline-flex size-full rounded-full ${tone} opacity-60 motion-safe:animate-ping`} />}
        <span className={`relative inline-flex size-2 rounded-full ${tone}`} />
      </span>
      <span className="truncate">{looking ? `Looking for a signal · ${followed}` : trading.note}</span>
    </span>
  );
}

/** Problems and command results, shown only when there is something to say. */
function Notices({ trading, result, onDismiss }: { trading: TradingStatus; result: TradingCommandResult | null; onDismiss: () => void }) {
  const { config } = trading;
  // A successful command's message fades after a few seconds; a failure stays until dismissed.
  useEffect(() => {
    if (!result?.ok) return;
    const timer = setTimeout(onDismiss, 6_000);
    return () => clearTimeout(timer);
  }, [result, onDismiss]);
  const lines: { tone: string; text: ReactNode }[] = [];
  if (result) lines.push({ tone: result.ok ? "text-muted" : "text-down", text: result.message });
  if (trading.contracts.problem) lines.push({ tone: "text-warn", text: trading.contracts.problem });
  if (config.decision.mode !== "off" && !trading.decisionReady) {
    lines.push({
      tone: "text-warn",
      text: `The decision API has no key: set ${DECISION_PROVIDERS.find((p) => p.id === config.decision.provider)?.keyName ?? "its key"} in the engine's .env.local and restart it, or choose the other provider in Settings.`,
    });
  }
  if (trading.storage.error) lines.push({ tone: "text-warn", text: `Tables not saved: ${trading.storage.error}. The engine keeps a local log and retries.` });
  if (lines.length === 0) return null;
  return (
    <div role="status" className="grid gap-0.5 rounded-sm border border-line bg-panel px-3 py-1.5 text-label">
      {lines.map((line, i) => (
        <p key={i} className={line.tone}>
          {line.text}
        </p>
      ))}
    </div>
  );
}

function Now({ trading }: { trading: TradingStatus }) {
  const { signal, contracts, config } = trading;
  const follow = config.strategy.signal;
  const followed = SIGNALS.find((s) => s.id === follow)?.name ?? follow;
  const [guide, setGuide] = useState<SignalId | "overview" | null>(null);
  const horizon = signal?.readings.find((r) => r.today)?.today?.horizon;
  return (
    <Panel
      title="Signals"
      meta={signal ? `read at the ${clock(signal.minute + 60_000).slice(0, 5)} close` : undefined}
      action={
        <button type="button" className="text-label text-accent hover:underline" onClick={() => setGuide("overview")}>
          How signals work
        </button>
      }
      flush
    >
      {signal ? (
        <DataTable
          caption="Signal readings"
          minWidth="min-w-[58rem]"
          columns={[
            "Signal",
            { label: "Reading", align: "left" },
            { label: "Votes at", align: "left" },
            { label: "How close", align: "left" },
            { label: horizon ? `Today, ${horizon}-min hold` : "Today", align: "left" },
            { label: "Last fired", align: "left" },
            "Vote",
          ]}
        >
          {signal.readings.map((reading) => {
            const last = reading.recent?.[0];
            const today = reading.today;
            return (
              <tr key={reading.id} className={reading.id === follow ? "bg-accent/5" : undefined}>
                <Td>
                  <span className="inline-flex items-center gap-1.5">
                    <InfoButton label={`What ${reading.name} means`} onClick={() => setGuide(reading.id)} />
                    {reading.name}
                    {reading.id === follow && <span className="text-label text-accent">followed</span>}
                  </span>
                </Td>
                <Td className="text-muted">{reading.reading}</Td>
                <Td className="text-muted">{GUIDE[reading.id]?.line ?? "—"}</Td>
                <Td>{reading.threshold == null ? <span className="text-muted">—</span> : <Closeness value={reading.value} threshold={reading.threshold} compact />}</Td>
                <Td>
                  {!today ? (
                    <span className="text-muted">—</span>
                  ) : today.fired === 0 ? (
                    <span className="text-muted">not fired</span>
                  ) : (
                    <span title={`NIFTY moved its way after ${today.right} of ${today.fired} firings: ${today.points >= 0 ? "+" : ""}${today.points} points before costs`}>
                      {today.right} of {today.fired} right <span className={`text-label ${today.points >= 0 ? "text-up" : "text-down"}`}>{today.points >= 0 ? "+" : ""}{today.points} pts</span>
                    </span>
                  )}
                </Td>
                <Td>
                  {last ? (
                    <span className="inline-flex items-center gap-1.5 tabular-nums">
                      {clock(last.at + 60_000).slice(0, 5)} <Arrow vote={last.vote} /> <span className="text-label"><Outcome vote={last.vote} outcome={last.outcome} /></span>
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
                <Td numeric>
                  <Vote vote={reading.vote} />
                </Td>
              </tr>
            );
          })}
        </DataTable>
      ) : (
        <div className="p-3">
          <EmptyState>Signals are read at the close of each minute once the session is open. The strategy follows “{followed}”.</EmptyState>
        </div>
      )}
      <dl className="grid gap-x-6 gap-y-1 border-t border-line px-3 py-2 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="NIFTY at that close" value={signal?.nifty ? price.format(signal.nifty) : "—"} />
        <Field label="Pulse verdict" value={signal ? `${signal.stance} (${signal.score > 0 ? "+" : ""}${signal.score})` : "—"} />
        <Field
          label="Option contracts"
          value={contracts.expiry ? `${contracts.expiry} expiry${contracts.daysToExpiry === 0 ? " (today)" : ""}, lot ${contracts.lotSize ?? "?"}, ${contracts.subscribed} on the feed` : "Not loaded"}
        />
        <Field
          label="Instrument file"
          value={contracts.fileDate ? <span className={contracts.stale ? "text-warn" : undefined}>{contracts.fileDate}{contracts.stale ? " (older than the market day)" : ""}</span> : "—"}
        />
      </dl>
      <SignalGuide open={guide !== null} onClose={() => setGuide(null)} initial={guide ?? "overview"} signal={signal} follow={follow} />
    </Panel>
  );
}

/** Open positions in the same columns as closed trades, marked to the latest price; shown only while something is open. */
function OpenPositions({ positions, decisions }: { positions: Position[]; decisions: DecisionRecord[] }) {
  return (
    <Panel title="Open positions" meta={`${positions.length} on paper · P&L if sold now, after charges on both orders`} flush>
      <PositionsTable positions={positions} decisions={decisions} caption="Open positions" />
    </Panel>
  );
}

function PositionsTable({ positions, decisions, caption }: { positions: Position[]; decisions: DecisionRecord[]; caption: string }) {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  return (
    <DataTable
      caption={caption}
      minWidth="min-w-[62rem]"
      columns={["Bought", { label: "Sell by", align: "left" }, { label: "Contract", align: "left" }, "Qty", "Entry", "Now", "Stop", "Target", "Before charges", "Charges", "Net", "Decision"]}
    >
      {positions.map((position) => {
        const decision = position.decisionId ? byId.get(position.decisionId) : undefined;
        const move = position.mark - position.entryPrice;
        return (
          <tr key={`${position.book}-${position.id}`}>
            <Td className="tabular-nums">{clock(position.openedAt)}</Td>
            <Td className="tabular-nums">
              {clock(position.exitBy)}
              {position.status === "closing" && <span className="ml-1.5 text-label text-warn">selling</span>}
              {position.status === "opening" && <span className="ml-1.5 text-label text-muted">buying</span>}
            </Td>
            <Td>{position.contract.name}</Td>
            <Td numeric>{quantity.format(position.quantity)}</Td>
            <Td numeric>
              <span title={position.entrySource === "book" ? "Bought at the ask" : position.entrySource === "candle" ? "Bought at a candle close" : "Bought at the last price"}>{position.entryPrice > 0 ? price.format(position.entryPrice) : "—"}</span>
            </Td>
            <Td numeric>
              <span title={`Last price at ${clock(position.markAt)}`}>
                {price.format(position.mark)}
                {position.entryPrice > 0 && <ChangeSinceSale change={move} />}
              </span>
            </Td>
            <Td numeric>{position.stopPrice ? price.format(position.stopPrice) : "off"}</Td>
            <Td numeric>{position.targetPrice ? price.format(position.targetPrice) : "off"}</Td>
            <Td numeric>
              <Pnl value={position.unrealisedGross} />
            </Td>
            <Td numeric>
              <span title="Charges paid on the buy plus those the sell would pay">{inr.format(position.unrealisedGross - position.unrealisedNet)}</span>
            </Td>
            <Td numeric>
              <Pnl value={position.unrealisedNet} />
            </Td>
            <Td numeric>{decision?.probability != null ? decision.probability.toFixed(2) : "—"}</Td>
          </tr>
        );
      })}
    </DataTable>
  );
}

/** How far the option's price has moved since it was sold: green up, red down. */
function ChangeSinceSale({ change }: { change: number }) {
  const rounded = Math.round(change * 100) / 100;
  const tone = rounded > 0 ? "text-up" : rounded < 0 ? "text-down" : "text-muted";
  return <span className={`ml-1.5 tabular-nums ${tone}`}>({rounded > 0 ? "+" : ""}{rounded})</span>;
}

function Trades({
  trades,
  decisions,
  prices,
  showShadow,
  onShowShadow,
}: {
  trades: Trade[];
  decisions: DecisionRecord[];
  prices: TradingStatus["prices"];
  showShadow: boolean;
  onShowShadow: (show: boolean) => void;
}) {
  const paper = trades.filter((t) => t.book === "paper");
  const shadowCount = trades.length - paper.length;
  return (
    <Panel
      title="Trades"
      meta={`${paper.length} on paper`}
      action={
        shadowCount > 0 && (
          <label className="inline-flex items-center gap-1.5 text-label text-muted" title="Opens a separate panel below with the trades the AI turned down">
            <input type="checkbox" checked={showShadow} onChange={(e) => onShowShadow(e.target.checked)} />
            Show {shadowCount} shadow trade{shadowCount === 1 ? "" : "s"}
          </label>
        )
      }
      flush
    >
      {paper.length === 0 ? (
        <div className="p-3">
          <EmptyState>{shadowCount > 0 ? "No paper trades yet. Tick Show shadow trades to see the ones the AI turned down." : "No trades yet in this run."}</EmptyState>
        </div>
      ) : (
        <TradesTable trades={paper} decisions={decisions} prices={prices} caption="Closed trades, newest first" />
      )}
    </Panel>
  );
}

/** Closed trades of one book. */
function TradesTable({ trades, decisions, prices, caption }: { trades: Trade[]; decisions: DecisionRecord[]; prices: TradingStatus["prices"]; caption: string }) {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  return (
    <DataTable
      caption={caption}
      minWidth="min-w-[62rem]"
      columns={["Bought", { label: "Sold", align: "left" }, { label: "Contract", align: "left" }, "Qty", "Entry", "Exit", "Now", { label: "Closed by", align: "left" }, "Before charges", "Charges", "Net", "Decision"]}
    >
      {trades.map((trade) => {
        const decision = trade.decisionId ? byId.get(trade.decisionId) : undefined;
        const now = prices[trade.contract.feedKey];
        return (
          <tr key={`${trade.book}-${trade.id}`}>
            <Td className="tabular-nums">{clock(trade.openedAt)}</Td>
            <Td className="tabular-nums">{clock(trade.closedAt)}</Td>
            <Td>{trade.contract.name}</Td>
            <Td numeric>{quantity.format(trade.quantity)}</Td>
            <Td numeric>{price.format(trade.entryPrice)}</Td>
            <Td numeric>{price.format(trade.exitPrice)}</Td>
            <Td numeric>
              {now ? (
                <span title={`Last traded at ${clock(now.at)}; ${now.price >= trade.exitPrice ? "up" : "down"} ${inr.format(Math.abs(now.price - trade.exitPrice) * trade.quantity)} on this quantity since the sale`}>
                  {price.format(now.price)}
                  <ChangeSinceSale change={now.price - trade.exitPrice} />
                </span>
              ) : (
                "—"
              )}
            </Td>
            <Td>{EXIT_REASON[trade.exitReason]}</Td>
            <Td numeric>
              <Pnl value={trade.gross} />
            </Td>
            <Td numeric>
              <span title={chargeLines(trade)}>{inr.format(trade.charges.total)}</span>
            </Td>
            <Td numeric>
              <Pnl value={trade.net} />
            </Td>
            <Td numeric>{decision?.probability != null ? decision.probability.toFixed(2) : "—"}</Td>
          </tr>
        );
      })}
    </DataTable>
  );
}

/**
 * The shadow book on its own: trades the AI turned down, followed as if taken. Not real money and
 * never counted in the paper totals; kept apart so nobody mistakes them for trades.
 */
function ShadowBook({ trading }: { trading: TradingStatus }) {
  const trades = trading.trades.filter((t) => t.book === "shadow");
  const open = trading.positions.filter((p) => p.book === "shadow");
  const { shadow } = trading.totals;
  return (
    <section className="rounded-sm border border-dashed border-line-strong">
      <Panel
        title="Shadow trades: turned down by the AI, not real"
        meta={
          <span>
            {shadow.trades} closed, {shadow.wins} would have won · would have made <Pnl value={shadow.net} /> after charges
          </span>
        }
        flush
      >
        <p className="px-3 py-2 text-label text-muted">
          The AI turned these down, so nothing was bought. They are followed as if taken, to show whether turning them down helped. They don&apos;t count in your totals.
        </p>
        {open.length > 0 && (
          <>
            <p className="px-3 pt-1 text-label font-medium tracking-wider text-muted uppercase">Still open</p>
            <PositionsTable positions={open} decisions={trading.decisions} caption="Open shadow positions" />
          </>
        )}
        {trades.length > 0 && (
          <>
            {open.length > 0 && <p className="px-3 pt-3 text-label font-medium tracking-wider text-muted uppercase">Closed</p>}
            <TradesTable trades={trades} decisions={trading.decisions} prices={trading.prices ?? {}} caption="Closed shadow trades, newest first" />
          </>
        )}
      </Panel>
    </section>
  );
}

function chargeLines(trade: Trade) {
  const c = trade.charges;
  return [
    `Brokerage ${inr.format(c.brokerage)}`,
    `Exchange and IPFT ${inr.format(c.exchange + c.ipft)}`,
    `STT ${inr.format(c.stt)}`,
    `SEBI ${inr.format(c.sebi)}`,
    `Stamp duty ${inr.format(c.stamp)}`,
    `GST ${inr.format(c.gst)}`,
  ].join("\n");
}

function Decisions({ trading }: { trading: TradingStatus }) {
  const { decisionScore: score, decisions, intents, config } = trading;
  const intentOf = new Map(intents.map((i) => [i.id, i]));
  const mode = config.decision.mode;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel
      title="Decision API"
      meta={mode === "off" ? "Off" : mode === "gate" ? `Gate: takes a trade at ${config.decision.minProbability.toFixed(2)} or more` : "Shadow: answers are recorded, nothing is turned down"}
      flush
    >
      <dl className="grid gap-x-8 px-3 py-1.5 sm:grid-cols-2">
        <StatRow label="Asked" value={`${score.asked}${score.failed > 0 ? ` (${score.failed} failed)` : ""}`} />
        <StatRow label="Average answer time" value={score.meanLatencyMs === null ? "—" : `${score.meanLatencyMs} ms`} />
        <StatRow
          label={`Approved: ${score.approved}, traded ${score.approvedTrades}`}
          value={score.approvedTrades > 0 ? <Pnl value={score.approvedNet} /> : "—"}
        />
        <StatRow
          label={`${mode === "gate" ? "Turned down" : "Would turn down"}: ${score.vetoed}, followed ${score.vetoedTrades}`}
          value={score.vetoedTrades > 0 ? <Pnl value={score.vetoedNet} /> : "—"}
        />
      </dl>
      <p className="border-t border-line px-3 py-1.5 text-label text-muted">
        The gate earns its place when the trades it approves do better after charges than the ones it turns down. One day is too few trades to tell; compare over the stored runs.
      </p>
      {decisions.length > 0 && (
        <DataTable
          caption="Decision API answers, newest first"
          minWidth="min-w-[52rem]"
          columns={["Asked", { label: "Proposal", align: "left" }, "Take it", { label: "Regime", align: "left" }, "Support", { label: "Verdict", align: "left" }, "Time", "Sent"]}
        >
          {decisions.slice(0, 50).map((decision) => {
            const intent = intentOf.get(decision.intentId);
            const shown = open === decision.id;
            return (
              <Fragment key={decision.id}>
                <tr>
                  <Td className="tabular-nums">{clock(decision.at)}</Td>
                  <Td>{intent ? <Proposal intent={intent} /> : "—"}</Td>
                  <Td numeric>{decision.probability === null ? "—" : decision.probability.toFixed(2)}</Td>
                  <Td>{decision.regime?.replace("_", " ") ?? "—"}</Td>
                  <Td numeric>{decision.quality === null ? "—" : `${Math.round(decision.quality * 100)}%`}</Td>
                  <Td className="whitespace-normal">
                    {decision.error ? (
                      <span className="text-warn">Failed: {decision.error}</span>
                    ) : (
                      <span className={decision.approved ? "text-up" : "text-down"}>{decision.approved ? "Take it" : mode === "gate" ? "Turned down" : "Would turn down"}</span>
                    )}
                    {!decision.error && <span className="text-muted"> · {decision.reason}</span>}
                  </Td>
                  <Td numeric className="text-muted">
                    {decision.cached ? "recorded" : `${decision.latencyMs} ms`}
                  </Td>
                  <Td numeric>
                    <button type="button" className="text-label text-accent hover:underline" aria-expanded={shown} onClick={() => setOpen(shown ? null : decision.id)}>
                      {shown ? "Hide" : "Show"}
                    </button>
                  </Td>
                </tr>
                {shown && (
                  <tr>
                    <td colSpan={8} className="border-t border-line bg-raised/40 px-3 py-2">
                      <DecisionSent id={decision.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </DataTable>
      )}
    </Panel>
  );
}

type SentLoad = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: DecisionRequest };

/** The request the engine sent the decision API for one proposal: the market context and the questions. */
function DecisionSent({ id }: { id: string }) {
  const [load, setLoad] = useState<SentLoad>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/engine/v1/trading/decision?id=${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as (DecisionRequest & { error?: string }) | null;
        // An engine started before this endpoint existed answers "No route …".
        const outdated = response.status === 404 && (!body?.error || body.error.startsWith("No route"));
        if (!response.ok || !body) throw new Error(outdated ? "This engine is running older code: restart it to see what was sent." : (body?.error ?? `HTTP ${response.status}`));
        setLoad({ state: "ready", data: body });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ state: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [id]);

  if (load.state === "loading") return <p className="text-muted">Reading what was sent…</p>;
  if (load.state === "error") return <p className="text-down">{load.message}</p>;
  const { model, state, questions } = load.data;
  const block = "max-h-96 overflow-auto rounded border border-line bg-canvas p-2 font-mono text-label leading-relaxed whitespace-pre";
  return (
    <div className="grid gap-3 whitespace-normal lg:grid-cols-[3fr_2fr]">
      <div className="min-w-0">
        <p className="mb-1 text-label text-muted">
          Market context (<span className="font-mono">state</span>) sent to <span className="font-mono">{model}</span>
        </p>
        {state === null ? <p className="text-muted">The context for this answer wasn&apos;t kept.</p> : <pre className={block}>{JSON.stringify(state, null, 2)}</pre>}
      </div>
      <div className="min-w-0">
        <p className="mb-1 text-label text-muted">
          Questions (<span className="font-mono">questions</span>)
        </p>
        <pre className={block}>{JSON.stringify(questions, null, 2)}</pre>
      </div>
    </div>
  );
}

function Proposal({ intent }: { intent: Intent }) {
  return (
    <span>
      <Vote vote={intent.direction} /> <span className="text-muted">{intent.contract?.name ?? ""}</span>
    </span>
  );
}

// --- Settings ----------------------------------------------------------------------------------

function NumberField({ label, value, onChange, step = 1, min = 0, suffix }: { label: string; value: number; onChange: (value: number) => void; step?: number; min?: number; suffix?: string }) {
  return (
    <label className="flex flex-col gap-1 text-label text-muted">
      {label}
      <span className="inline-flex items-center gap-1.5">
        <input type="number" inputMode="decimal" step={step} min={min} value={value} onChange={(e) => onChange(e.target.valueAsNumber)} className={`${fieldClass} w-24 tabular-nums`} />
        {suffix && <span>{suffix}</span>}
      </span>
    </label>
  );
}

function SelectField<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (value: T) => void; options: readonly { value: T; label: string }[] }) {
  return (
    <label className="flex flex-col gap-1 text-label text-muted">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={fieldClass}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-label text-muted">
      {label}
      <input type="time" value={value} onChange={(e) => onChange(e.target.value)} className={`${fieldClass} tabular-nums`} />
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="inline-flex h-7 items-center gap-1.5 text-label text-muted">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** NIFTY's lot and a typical at-the-money premium, for showing what a rupee stop and target mean. */
const EXAMPLE_LOT = 65;
const EXAMPLE_PREMIUM = 100;

/** What the scalping amounts come to on a typical trade: the charges, breakeven, and where it sells. */
function ScalpExample({ strategy, fills }: { strategy: TradingConfig["strategy"]; fills: TradingConfig["fills"] }) {
  const units = Math.max(1, strategy.lots) * EXAMPLE_LOT;
  const slip = fills.slippage;
  const breakeven = breakevenSellPrice(EXAMPLE_PREMIUM, units) + slip;
  const { stopPrice, targetPrice, stopClamped } = exitLevels(strategy, EXAMPLE_PREMIUM, units, 0.05, slip);
  const rows: [string, string][] = [
    ["Charges and slippage, buy and sell", `₹${Math.round((breakeven - EXAMPLE_PREMIUM) * units)}`],
    ["Breaks even when the option reaches", `₹${breakeven.toFixed(2)}`],
    ["Takes profit at", targetPrice === null ? "off" : `₹${targetPrice.toFixed(2)}`],
    ["Cuts the loss at", stopPrice === null ? "off" : `₹${stopPrice.toFixed(2)}`],
  ];
  return (
    <div className="basis-full rounded-sm border border-line bg-raised/40 p-2.5 text-label">
      <p className="text-muted">
        Example: {strategy.lots} lot{strategy.lots === 1 ? "" : "s"} ({units} units) bought at ₹{EXAMPLE_PREMIUM}
      </p>
      <dl className="mt-1.5 grid max-w-md grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </Fragment>
        ))}
      </dl>
      {stopClamped && <p className="mt-1.5 text-warn">Your cut-loss amount is smaller than the charges, so it would sell one tick below what you paid.</p>}
    </div>
  );
}

/** One trading style's tab: what it is, a warning when it is switched off, and its own settings. */
function StylePanel({ name, blurb, active, onUse, children }: { name: string; blurb: string; active: boolean; onUse: () => void; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-body text-muted">{blurb}</p>
      {!active && (
        <div className="flex flex-wrap items-center gap-2 rounded-sm border border-warn/60 bg-warn/10 px-2.5 py-1.5 text-body">
          <span>{name} is off. These settings do nothing until you turn it on.</span>
          <button type="button" className={buttonClass} onClick={onUse}>
            Turn {name.toLowerCase()} on
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">{children}</div>
    </div>
  );
}

/** The trading mode, always in view above the tabs: which style the engine trades with. */
function ModeSwitch({ scalping, onChange }: { scalping: boolean; onChange: (scalping: boolean) => void }) {
  const option = (on: boolean, label: string, hint: string) => {
    const selected = scalping === on;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={() => onChange(on)}
        className={`flex flex-col items-start rounded-sm border px-3 py-1.5 text-left ${selected ? "border-accent bg-accent/10" : "border-line-strong hover:bg-raised"}`}
      >
        <span className={`text-body font-medium ${selected ? "text-accent" : ""}`}>
          {selected ? "● " : "○ "}
          {label}
        </span>
        <span className="text-label text-muted">{hint}</span>
      </button>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-label font-medium tracking-wider text-muted uppercase">Mode</span>
      <div role="radiogroup" aria-label="Trading mode" className="flex flex-wrap gap-2">
        {option(false, "Standard", "Target and stop in % of premium")}
        {option(true, "Scalping", "Quick trades, ₹ after charges")}
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-label font-medium tracking-wider text-muted uppercase">{title}</legend>
      <div className="mt-2 flex flex-wrap items-end gap-x-3 gap-y-2">{children}</div>
    </fieldset>
  );
}

/** An engine older than this page leaves out the settings it doesn't know; the form shows their defaults. */
function withDefaults(config: TradingConfig): TradingConfig {
  const d = DEFAULT_TRADING_CONFIG;
  return {
    ...d,
    ...config,
    strategy: { ...d.strategy, ...config.strategy },
    risk: { ...d.risk, ...config.risk },
    fills: { ...d.fills, ...config.fills },
    decision: { ...d.decision, ...config.decision },
  };
}

/** Remounted (by its key) whenever the engine's settings change, so the form always starts from them. */
const SETTINGS_TABS = [
  { value: "scalping", label: "Scalping" },
  { value: "standard", label: "Standard" },
  { value: "buy", label: "What to buy" },
  { value: "limits", label: "Safety limits" },
  { value: "ai", label: "AI check" },
  { value: "fills", label: "Paper fills" },
] as const;

const SETTINGS_TAB_CLASS =
  "inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-body whitespace-nowrap text-muted hover:bg-raised hover:text-fg data-[selected]:bg-raised data-[selected]:font-medium data-[selected]:text-fg";

/** In the page header while the saved style is Scalping: the badge and its amounts, so the mode is never a surprise. */
function ScalpingBadge({ config }: { config: TradingConfig }) {
  const c = withDefaults(config);
  if (!isScalping(c)) return null;
  const amount = (v: number) => (v > 0 ? `₹${v.toLocaleString("en-IN")}` : "off");
  return (
    <span className="inline-flex items-center gap-1.5" title="Scalping mode: profit and loss are set in rupees after charges. Change it in Settings.">
      <span className="rounded-sm border border-accent bg-accent/10 px-1.5 text-[0.625rem] leading-4 font-semibold tracking-wide text-accent uppercase">Scalping</span>
      <span className="tabular-nums">
        take {amount(c.strategy.targetNet)} · cut {amount(c.strategy.stopNet)} after charges · out in {c.strategy.scalpHoldMinutes} min
      </span>
    </span>
  );
}

/** The open settings tab, kept while the page is open: saving remounts the form, which shouldn't jump tabs. */
let openSettingsTab: string | null = null;

/** One line saying how the engine trades with these settings. */
function settingsSummary(c: TradingConfig): string {
  const signal = SIGNALS.find((x) => x.id === c.strategy.signal)?.name ?? c.strategy.signal;
  const lots = `${c.strategy.lots} lot${c.strategy.lots === 1 ? "" : "s"}`;
  const off = (v: number, text: string) => (v > 0 ? text : null);
  const exits = isScalping(c)
    ? [off(c.strategy.targetNet, `take ₹${c.strategy.targetNet}`), off(c.strategy.stopNet, `cut at ₹${c.strategy.stopNet}`)].filter(Boolean).join(", ") + " after charges"
    : [off(c.strategy.targetPct, `target ${c.strategy.targetPct}%`), off(c.strategy.stopLossPct, `stop ${c.strategy.stopLossPct}%`)].filter(Boolean).join(", ");
  return `${isScalping(c) ? "Scalping" : "Standard"}: ${lots} on "${signal}", ${exits}, out within ${holdMinutesFor(c)} min`;
}

function Settings({
  config,
  pending,
  send,
  providers,
}: {
  config: TradingConfig;
  pending: boolean;
  send: (command: TradingCommand) => void;
  /** Which decision providers have a key in the engine's .env.local. */
  providers: Record<DecisionProviderId, boolean>;
}) {
  const saved = withDefaults(config);
  const [draft, setDraft] = useState(saved);
  // Starting and stopping entries is the header button's job, not this form's.
  const dirty = JSON.stringify({ ...draft, armed: null }) !== JSON.stringify({ ...saved, armed: null });
  const strategy = <K extends keyof TradingConfig["strategy"]>(key: K, value: TradingConfig["strategy"][K]) => setDraft((d) => ({ ...d, strategy: { ...d.strategy, [key]: value } }));
  const risk = <K extends keyof TradingConfig["risk"]>(key: K, value: TradingConfig["risk"][K]) => setDraft((d) => ({ ...d, risk: { ...d.risk, [key]: value } }));
  const fills = <K extends keyof TradingConfig["fills"]>(key: K, value: TradingConfig["fills"][K]) => setDraft((d) => ({ ...d, fills: { ...d.fills, [key]: value } }));
  const decision = <K extends keyof TradingConfig["decision"]>(key: K, value: TradingConfig["decision"][K]) => setDraft((d) => ({ ...d, decision: { ...d.decision, [key]: value } }));
  const scalping = isScalping(draft);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const { strategy: s, risk: r, fills: f, decision: d, recordOptions, windowStrikes } = draft;
    send({ action: "config", patch: { strategy: s, risk: r, fills: f, decision: d, recordOptions, windowStrikes } });
  };

  return (
    <Panel title="Settings" meta="Changes apply from the next trade">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-body">
          <span className="text-muted">Trading now as </span>
          {settingsSummary(saved)}
        </p>

        <ModeSwitch scalping={scalping} onChange={(on) => strategy("exitIn", on ? "rupees" : "percent")} />

        <Tabs defaultValue={openSettingsTab ?? (isScalping(saved) ? "scalping" : "standard")} onValueChange={(tab) => (openSettingsTab = tab)} className="space-y-3">
          <TabsList aria-label="Settings" className="flex gap-1 overflow-x-auto border-b border-line pb-1.5">
            {SETTINGS_TABS.map((tab) => (
              <TabsTab key={tab.value} value={tab.value} className={SETTINGS_TAB_CLASS}>
                {tab.label}
                {(tab.value === "scalping" && scalping) || (tab.value === "standard" && !scalping) ? <span className="size-1.5 rounded-full bg-accent" aria-label="in use" /> : null}
              </TabsTab>
            ))}
          </TabsList>

          <TabsPanel value="scalping" className="outline-none">
            <StylePanel
              name="Scalping"
              blurb="Small, quick trades. You set the rupees to make or lose after all of Dhan's charges, and the engine works out the prices."
              active={scalping}
              onUse={() => strategy("exitIn", "rupees")}
            >
              <NumberField label="Take profit at" value={draft.strategy.targetNet} step={50} suffix="₹ after charges" onChange={(v) => strategy("targetNet", v)} />
              <NumberField label="Cut loss at" value={draft.strategy.stopNet} step={50} suffix="₹ after charges" onChange={(v) => strategy("stopNet", v)} />
              <NumberField label="Sell anyway after" value={draft.strategy.scalpHoldMinutes} min={1} suffix="min" onChange={(v) => strategy("scalpHoldMinutes", v)} />
              <NumberField label="Wait between trades" value={draft.risk.scalpCooldownMinutes} suffix="min" onChange={(v) => risk("scalpCooldownMinutes", v)} />
              <ScalpExample strategy={draft.strategy} fills={draft.fills} />
              <p className="basis-full text-label text-muted">0 turns profit-taking or loss-cutting off. New trades are checked once a minute; exits are checked on every price change.</p>
            </StylePanel>
          </TabsPanel>

          <TabsPanel value="standard" className="outline-none">
            <StylePanel
              name="Standard"
              blurb="Longer trades. The target and stop are a share of the price you paid for the option, before charges."
              active={!scalping}
              onUse={() => strategy("exitIn", "percent")}
            >
              <NumberField label="Take profit at" value={draft.strategy.targetPct} suffix="% up" onChange={(v) => strategy("targetPct", v)} />
              <NumberField label="Cut loss at" value={draft.strategy.stopLossPct} suffix="% down" onChange={(v) => strategy("stopLossPct", v)} />
              <NumberField label="Sell anyway after" value={draft.strategy.holdMinutes} min={1} suffix="min" onChange={(v) => strategy("holdMinutes", v)} />
              <NumberField label="Wait between trades" value={draft.risk.cooldownMinutes} suffix="min" onChange={(v) => risk("cooldownMinutes", v)} />
              <p className="basis-full text-label text-muted">0 turns profit-taking or loss-cutting off.</p>
            </StylePanel>
          </TabsPanel>

          <TabsPanel value="buy" className="space-y-3 outline-none">
            <p className="text-body text-muted">When to buy, and which option. These apply to both styles.</p>
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
              <SelectField label="Buy when this signal fires" value={draft.strategy.signal} onChange={(v) => strategy("signal", v)} options={SIGNALS.map((s) => ({ value: s.id, label: s.name }))} />
              <SelectField
                label="Buy"
                value={draft.strategy.side}
                onChange={(v) => strategy("side", v)}
                options={[
                  { value: "both", label: "A call when it says up, a put when down" },
                  { value: "calls", label: "Calls only (up)" },
                  { value: "puts", label: "Puts only (down)" },
                ]}
              />
              <SelectField
                label="Strike"
                value={String(draft.strategy.strikeOffset)}
                onChange={(v) => strategy("strikeOffset", Number(v))}
                options={[
                  { value: "-2", label: "2 strikes in the money" },
                  { value: "-1", label: "1 strike in the money" },
                  { value: "0", label: "At the money" },
                  { value: "1", label: "1 strike out of the money" },
                  { value: "2", label: "2 strikes out of the money" },
                ]}
              />
              <NumberField label="Lots" value={draft.strategy.lots} min={1} suffix={`× ${EXAMPLE_LOT} units`} onChange={(v) => strategy("lots", v)} />
              <NumberField label="Skip expiries closer than" value={draft.strategy.minDaysToExpiry} suffix="days" onChange={(v) => strategy("minDaysToExpiry", v)} />
              <TimeField label="Buy from" value={draft.risk.entryFrom} onChange={(v) => risk("entryFrom", v)} />
              <TimeField label="Buy until" value={draft.risk.entryUntil} onChange={(v) => risk("entryUntil", v)} />
              <Check label="Sell when the signal turns the other way" checked={draft.strategy.exitOnOpposite} onChange={(v) => strategy("exitOnOpposite", v)} />
            </div>
          </TabsPanel>

          <TabsPanel value="limits" className="space-y-4 outline-none">
            <p className="text-body text-muted">Brakes that stop trading before losses pile up. These apply to both styles.</p>
            <Group title="For the day">
              <NumberField label="Stop for the day at a loss of" value={draft.risk.maxDailyLoss} step={100} suffix="₹ after charges" onChange={(v) => risk("maxDailyLoss", v)} />
              <NumberField label="Or after this many losses in a row" value={draft.risk.maxConsecutiveLosses} min={1} onChange={(v) => risk("maxConsecutiveLosses", v)} />
              <NumberField label="At most this many trades" value={draft.risk.maxTradesPerDay} min={1} onChange={(v) => risk("maxTradesPerDay", v)} />
              <TimeField label="Sell everything at" value={draft.risk.squareOffAt} onChange={(v) => risk("squareOffAt", v)} />
            </Group>
            <Group title="For each trade">
              <NumberField label="Positions open at once" value={draft.risk.maxOpenPositions} min={1} onChange={(v) => risk("maxOpenPositions", v)} />
              <NumberField label="Spend at most" value={draft.risk.maxPremiumPerTrade} step={500} suffix="₹ a trade" onChange={(v) => risk("maxPremiumPerTrade", v)} />
              <NumberField label="Skip options cheaper than" value={draft.risk.minPremium} suffix="₹" onChange={(v) => risk("minPremium", v)} />
              <NumberField label="Skip if buy and sell prices differ by over" value={draft.risk.maxSpreadPct} step={0.5} suffix="%" onChange={(v) => risk("maxSpreadPct", v)} />
            </Group>
          </TabsPanel>

          <TabsPanel value="ai" className="space-y-3 outline-none">
            <p className="text-body text-muted">An AI model looks at the market before each trade and can turn it down.</p>
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
              <SelectField
                label="The AI"
                value={draft.decision.mode}
                onChange={(v) => decision("mode", v)}
                options={[
                  { value: "gate", label: "Can turn a trade down" },
                  { value: "shadow", label: "Is asked, but only recorded" },
                  { value: "off", label: "Is not asked" },
                ]}
              />
              <NumberField label="Trade when it's at least" value={draft.decision.minProbability} step={0.05} suffix="sure (0 to 1)" onChange={(v) => decision("minProbability", v)} />
              <SelectField
                label="If it doesn't answer in time"
                value={draft.decision.onError}
                onChange={(v) => decision("onError", v)}
                options={[
                  { value: "skip", label: "Skip the trade" },
                  { value: "allow", label: "Take the trade" },
                ]}
              />
              <NumberField label="Wait for it at most" value={draft.decision.timeoutMs} step={500} min={500} suffix="ms" onChange={(v) => decision("timeoutMs", v)} />
              <Check label="Turn down trades against the day's trend" checked={draft.decision.vetoAgainstRegime} onChange={(v) => decision("vetoAgainstRegime", v)} />
            </div>
            <Group title="Model">
              <SelectField
                label="Provider"
                value={draft.decision.provider}
                // A new provider starts on its own default model.
                onChange={(v) => setDraft((d) => ({ ...d, decision: { ...d.decision, provider: v, model: DECISION_PROVIDERS.find((p) => p.id === v)!.defaultModel } }))}
                options={DECISION_PROVIDERS.map((p) => ({ value: p.id, label: `${p.name}${providers[p.id] ? "" : ` (no ${p.keyName})`}` }))}
              />
              <label className="flex flex-col gap-1 text-label text-muted">
                Model
                <input type="text" value={draft.decision.model} onChange={(e) => decision("model", e.target.value)} className={`${fieldClass} w-72 font-mono`} spellCheck={false} />
              </label>
              <p className="basis-full text-label text-muted">{DECISION_PROVIDERS.find((p) => p.id === draft.decision.provider)!.price}</p>
            </Group>
          </TabsPanel>

          <TabsPanel value="fills" className="space-y-4 outline-none">
            <p className="text-body text-muted">How paper trades are priced, so results look like real ones. The defaults are fine for most uses.</p>
            <Group title="Pricing">
              <NumberField label="Price worse than the quote by" value={draft.fills.slippage} step={0.05} suffix="₹ a unit" onChange={(v) => fills("slippage", v)} />
              <NumberField label="Or, with only a last price, by" value={draft.fills.looseSlippage} step={0.05} suffix="₹ a unit" onChange={(v) => fills("looseSlippage", v)} />
              <NumberField label="Order takes" value={draft.fills.latencyMs} step={50} suffix="ms to fill" onChange={(v) => fills("latencyMs", v)} />
              <NumberField label="Don't buy on a price older than" value={draft.risk.maxQuoteAgeSeconds} min={1} suffix="s" onChange={(v) => risk("maxQuoteAgeSeconds", v)} />
              <p className="basis-full text-label text-muted">Charges are Dhan&apos;s: ₹20 an order, STT 0.15% on sells, exchange fees, stamp duty and 18% GST.</p>
            </Group>
            <Group title="Recording">
              <NumberField label="Options followed" value={draft.windowStrikes} min={1} suffix="strikes each side of the money" onChange={(v) => setDraft((d) => ({ ...d, windowStrikes: v }))} />
              <Check label="Record them every session, even with trading off" checked={draft.recordOptions} onChange={(v) => setDraft((d) => ({ ...d, recordOptions: v }))} />
            </Group>
          </TabsPanel>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <button type="submit" className={buttonClass} disabled={pending || !dirty}>
            Save settings
          </button>
          {dirty && (
            <>
              <button type="button" className={buttonClass} disabled={pending} onClick={() => setDraft(saved)}>
                Discard changes
              </button>
              <span className="text-label text-warn">Unsaved: {settingsSummary(draft)}</span>
            </>
          )}
        </div>
      </form>
    </Panel>
  );
}

/** Closed trades of one book, as stored in Parquet. */
function StoredTrades({ trades, caption }: { trades: TradeRow[]; caption: string }) {
  return (
    <DataTable
      caption={caption}
      minWidth="min-w-[56rem]"
      columns={["Bought", { label: "Sold", align: "left" }, { label: "Contract", align: "left" }, "Qty", "Entry", "Exit", { label: "Closed by", align: "left" }, "Before charges", "Charges", "Net", "Decision"]}
    >
      {trades.map((trade: TradeRow) => (
        <tr key={`${trade.book}-${trade.id}`}>
          <Td className="tabular-nums">{clock(trade.opened_at)}</Td>
          <Td className="tabular-nums">{clock(trade.closed_at)}</Td>
          <Td>{trade.contract}</Td>
          <Td numeric>{quantity.format(trade.quantity)}</Td>
          <Td numeric>{price.format(trade.entry_price)}</Td>
          <Td numeric>{price.format(trade.exit_price)}</Td>
          <Td>{EXIT_REASON[trade.exit_reason as keyof typeof EXIT_REASON] ?? trade.exit_reason}</Td>
          <Td numeric>
            <Pnl value={trade.gross} />
          </Td>
          <Td numeric>{inr.format(trade.charges)}</Td>
          <Td numeric>
            <Pnl value={trade.net} />
          </Td>
          <Td numeric>{trade.decision_probability === null ? "—" : trade.decision_probability.toFixed(2)}</Td>
        </tr>
      ))}
    </DataTable>
  );
}

// --- Stored runs -------------------------------------------------------------------------------

type HistoryLoad = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: TradingHistory };

function History({ live }: { live: string | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [load, setLoad] = useState<HistoryLoad>({ state: "loading" });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const query = selected ? `?run=${encodeURIComponent(selected)}` : "";
    fetch(`/api/engine/v1/trading/history${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as (TradingHistory & { error?: string }) | null;
        if (!response.ok || !body) throw new Error(body?.error ?? `HTTP ${response.status}`);
        setLoad({ state: "ready", data: body });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ state: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [selected, refresh]);

  const data = load.state === "ready" ? load.data : null;
  return (
    <Panel
      title="Stored runs"
      meta={data ? <span className="font-mono">{data.location}</span> : undefined}
      action={
        <button type="button" className={buttonClass} onClick={() => setRefresh((n) => n + 1)}>
          Reload
        </button>
      }
      flush
    >
      {load.state === "loading" && !data && <p className="p-3 text-muted">Reading the stored runs…</p>}
      {load.state === "error" && <p className="p-3 text-down">{load.message}</p>}
      {data && data.runs.length === 0 && <p className="p-3 text-muted">No runs are stored yet. A run is saved as Parquet a few seconds after each trade and when it ends.</p>}
      {data && data.runs.length > 0 && (
        <DataTable
          caption="Stored trading runs, newest first"
          minWidth="min-w-[56rem]"
          columns={["Run", { label: "Started", align: "left" }, { label: "Signal", align: "left" }, { label: "Decision", align: "left" }, "Trades", "Won", "Charges", "Net", "Drawdown", "Turned down", "Shadow net"]}
        >
          {data.runs.map((run: RunRow) => (
            <tr key={run.run_id} className={run.run_id === selected ? "bg-raised/60" : undefined}>
              <Td>
                <button type="button" className="font-mono underline-offset-2 hover:underline" onClick={() => setSelected(run.run_id === selected ? null : run.run_id)}>
                  {run.run_id}
                </button>
                {run.run_id === live && <span className="ml-1.5 text-label text-accent">running</span>}
              </Td>
              <Td>{istDateTime.format(new Date(run.started_at))}</Td>
              <Td>{SIGNALS.find((s) => s.id === run.signal)?.name ?? run.signal}</Td>
              <Td>{run.decision_mode}</Td>
              <Td numeric>{run.trades}</Td>
              <Td numeric>{run.wins}</Td>
              <Td numeric>{inr.format(run.charges)}</Td>
              <Td numeric>
                <Pnl value={run.net} />
              </Td>
              <Td numeric>{inr.format(run.max_drawdown)}</Td>
              <Td numeric>{run.vetoes}</Td>
              <Td numeric>{run.shadow_trades > 0 ? <Pnl value={run.shadow_net} /> : "—"}</Td>
            </tr>
          ))}
        </DataTable>
      )}
      {data?.run && (
        <div className="border-t border-line">
          <p className="px-3 py-1.5 text-label text-muted">
            Trades of <span className="font-mono">{data.run}</span>, read from Parquet
          </p>
          {(() => {
            const paper = data.trades.filter((t) => t.book !== "shadow");
            const shadow = data.trades.filter((t) => t.book === "shadow");
            return (
              <>
                {paper.length === 0 ? <p className="px-3 pb-3 text-muted">This run closed no paper trades.</p> : <StoredTrades trades={paper} caption={`Trades of ${data.run}`} />}
                {shadow.length > 0 && (
                  <details className="m-2 rounded-sm border border-dashed border-line-strong">
                    <summary className="cursor-pointer px-3 py-1.5 text-label text-muted">
                      {shadow.length} shadow trade{shadow.length === 1 ? "" : "s"}: turned down by the AI, not real · would have made{" "}
                      <Pnl value={shadow.reduce((sum, t) => sum + t.net, 0)} />
                    </summary>
                    <StoredTrades trades={shadow} caption={`Shadow trades of ${data.run}`} />
                  </details>
                )}
              </>
            );
          })()}
        </div>
      )}
    </Panel>
  );
}
