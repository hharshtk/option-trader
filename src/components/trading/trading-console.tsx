"use client";

// The Strategies page: the engine's paper trading. What it is doing now, the open position, the
// day's trades after charges, what the decision API said about each entry, the settings, and the
// runs stored as Parquet. The engine does the trading; this page shows it and sends commands.

import { Fragment, useEffect, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { controlTrading } from "@/app/(cockpit)/strategies/actions";
import { buttonClass, DataTable, EmptyState, PageHeader, Panel, Pnl, StatRow, Tag, Td } from "@/components/ui";
import {
  DECISION_PROVIDERS,
  DEFAULT_TRADING_CONFIG,
  SIGNALS,
  type DecisionProviderId,
  type DecisionRecord,
  type DecisionRequest,
  type Intent,
  type Position,
  type RunRow,
  type Trade,
  type TradeRow,
  type TradingCommand,
  type TradingCommandResult,
  type TradingConfig,
  type TradingHistory,
  type TradingStatus,
} from "@/lib/engine/trading";
import { inr, istDateTime, price, quantity } from "@/lib/format";
import { BookTag, clock, EXIT_REASON, fieldClass, NoTrading, StateLine, useTrading, Vote } from "./shared";

export function TradingConsole() {
  const telemetry = useTrading();
  const trading = telemetry.trading;
  const [result, setResult] = useState<TradingCommandResult | null>(null);
  const [pending, startTransition] = useTransition();

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
  return (
    <>
      <PageHeader
        title="Strategies"
        meta={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <StateLine trading={trading} />
            <Tag>Paper</Tag>
            <span>{trading.source === "replay" ? `Replay of ${run?.date ?? "a recorded day"}` : "Live market"}</span>
            <span className="tabular-nums">{clock(trading.marketTime)} IST</span>
          </span>
        }
      >
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
        <div role="status" className="rounded-sm border border-line bg-panel px-3 py-2">
          <p>{trading.note}</p>
          {result && <p className={`mt-1 text-label ${result.ok ? "text-muted" : "text-down"}`}>{result.message}</p>}
          {trading.contracts.problem && <p className="mt-1 text-label text-warn">{trading.contracts.problem}</p>}
          {config.decision.mode !== "off" && !trading.decisionReady && (
            <p className="mt-1 text-label text-warn">
              The decision API has no key: set {DECISION_PROVIDERS.find((p) => p.id === config.decision.provider)?.keyName ?? "its key"} in the engine&apos;s .env.local and restart it, or choose the other provider in Settings.
            </p>
          )}
          {trading.storage.error && <p className="mt-1 text-label text-warn">Tables not saved: {trading.storage.error}. The engine keeps a local log and retries.</p>}
        </div>

        <Totals trading={trading} />

        <div className="grid gap-2 lg:grid-cols-2">
          <Now trading={trading} />
          <OpenPositions positions={trading.positions} />
        </div>

        <Trades trades={trading.trades} decisions={trading.decisions} prices={trading.prices ?? {}} />
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

function Now({ trading }: { trading: TradingStatus }) {
  const { signal, contracts, config } = trading;
  const followed = SIGNALS.find((s) => s.id === config.strategy.signal)?.name ?? config.strategy.signal;
  return (
    <Panel title="Signals" meta={signal ? `read at the ${clock(signal.minute + 60_000).slice(0, 5)} close` : undefined} flush>
      {signal ? (
        <DataTable caption="Signal readings" columns={["Signal", { label: "Reading", align: "left" }, "Vote"]}>
          {signal.readings.map((reading) => (
            <tr key={reading.id}>
              <Td>
                {reading.name}
                {reading.id === config.strategy.signal && <span className="ml-1.5 text-label text-accent">followed</span>}
              </Td>
              <Td className="text-muted">{reading.reading}</Td>
              <Td numeric>
                <Vote vote={reading.vote} />
              </Td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <div className="p-3">
          <EmptyState>Signals are read at the close of each minute once the session is open. The strategy follows “{followed}”.</EmptyState>
        </div>
      )}
      <dl className="border-t border-line px-3 py-1.5">
        <StatRow label="NIFTY at that close" value={signal?.nifty ? price.format(signal.nifty) : "—"} />
        <StatRow label="Pulse verdict" value={signal ? `${signal.stance} (${signal.score > 0 ? "+" : ""}${signal.score})` : "—"} />
        <StatRow
          label="Option contracts"
          value={
            contracts.expiry
              ? `${contracts.expiry} expiry${contracts.daysToExpiry === 0 ? " (today)" : ""}, lot ${contracts.lotSize ?? "?"}, ${contracts.subscribed} on the feed`
              : "Not loaded"
          }
        />
        <StatRow
          label="Instrument file"
          value={contracts.fileDate ? <span className={contracts.stale ? "text-warn" : undefined}>{contracts.fileDate}{contracts.stale ? " (older than the market day)" : ""}</span> : "—"}
        />
      </dl>
    </Panel>
  );
}

function OpenPositions({ positions }: { positions: Position[] }) {
  return (
    <Panel title="Open position" flush>
      {positions.length === 0 ? (
        <div className="p-3">
          <EmptyState>Nothing is open.</EmptyState>
        </div>
      ) : (
        positions.map((position) => (
          <dl key={position.id} className="border-b border-line px-3 py-1.5 last:border-0">
            <StatRow
              label={
                <span className="inline-flex items-center gap-1.5">
                  <BookTag book={position.book} />
                  {position.quantity} × {position.contract.name}
                </span>
              }
              value={<Pnl value={position.unrealisedNet} />}
              emphasis
            />
            <StatRow label={`Bought at ${clock(position.openedAt)}`} value={`${price.format(position.entryPrice)} (${position.entrySource === "book" ? "at the ask" : position.entrySource === "candle" ? "candle close" : "last price"})`} />
            <StatRow label={`Now, ${clock(position.markAt)}`} value={price.format(position.mark)} />
            <StatRow label="Stop loss · target" value={`${position.stopPrice ? price.format(position.stopPrice) : "off"} · ${position.targetPrice ? price.format(position.targetPrice) : "off"}`} />
            <StatRow label="Sold by" value={`${clock(position.exitBy)}${position.status === "closing" ? " · selling now" : ""}`} />
            <StatRow label="Before charges" value={<Pnl value={position.unrealisedGross} />} />
          </dl>
        ))
      )}
    </Panel>
  );
}

/** How far the option's price has moved since it was sold: green up, red down. */
function ChangeSinceSale({ change }: { change: number }) {
  const rounded = Math.round(change * 100) / 100;
  const tone = rounded > 0 ? "text-up" : rounded < 0 ? "text-down" : "text-muted";
  return <span className={`ml-1.5 tabular-nums ${tone}`}>({rounded > 0 ? "+" : ""}{rounded})</span>;
}

function Trades({ trades, decisions, prices }: { trades: Trade[]; decisions: DecisionRecord[]; prices: TradingStatus["prices"] }) {
  const [showShadow, setShowShadow] = useState(false);
  const shadowCount = trades.filter((t) => t.book === "shadow").length;
  const shown = showShadow ? trades : trades.filter((t) => t.book === "paper");
  const byId = new Map(decisions.map((d) => [d.id, d]));
  return (
    <Panel
      title="Trades"
      meta={`${trades.length - shadowCount} on paper${shadowCount > 0 ? `, ${shadowCount} shadow` : ""}`}
      action={
        shadowCount > 0 && (
          <label className="inline-flex items-center gap-1.5 text-label text-muted">
            <input type="checkbox" checked={showShadow} onChange={(e) => setShowShadow(e.target.checked)} />
            Show shadow trades
          </label>
        )
      }
      flush
    >
      {shown.length === 0 ? (
        <div className="p-3">
          <EmptyState>{trades.length > 0 ? "No paper trades yet. Tick Show shadow trades to see the ones the decision API turned down." : "No trades yet in this run."}</EmptyState>
        </div>
      ) : (
        <DataTable
          caption="Closed trades, newest first"
          minWidth="min-w-[62rem]"
          columns={["Bought", { label: "Sold", align: "left" }, { label: "Contract", align: "left" }, "Qty", "Entry", "Exit", "Now", { label: "Closed by", align: "left" }, "Before charges", "Charges", "Net", "Decision"]}
        >
          {shown.map((trade) => {
            const decision = trade.decisionId ? byId.get(trade.decisionId) : undefined;
            const now = prices[trade.contract.feedKey];
            return (
              <tr key={`${trade.book}-${trade.id}`} className={trade.book === "shadow" ? "text-muted" : undefined}>
                <Td className="tabular-nums">{clock(trade.openedAt)}</Td>
                <Td className="tabular-nums">{clock(trade.closedAt)}</Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5">
                    <BookTag book={trade.book} />
                    {trade.contract.name}
                  </span>
                </Td>
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
      )}
    </Panel>
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
  const [draft, setDraft] = useState(() => withDefaults(config));
  // Starting and stopping entries is the header button's job, not this form's.
  const dirty = JSON.stringify({ ...draft, armed: null }) !== JSON.stringify({ ...withDefaults(config), armed: null });
  const strategy = <K extends keyof TradingConfig["strategy"]>(key: K, value: TradingConfig["strategy"][K]) => setDraft((d) => ({ ...d, strategy: { ...d.strategy, [key]: value } }));
  const risk = <K extends keyof TradingConfig["risk"]>(key: K, value: TradingConfig["risk"][K]) => setDraft((d) => ({ ...d, risk: { ...d.risk, [key]: value } }));
  const fills = <K extends keyof TradingConfig["fills"]>(key: K, value: TradingConfig["fills"][K]) => setDraft((d) => ({ ...d, fills: { ...d.fills, [key]: value } }));
  const decision = <K extends keyof TradingConfig["decision"]>(key: K, value: TradingConfig["decision"][K]) => setDraft((d) => ({ ...d, decision: { ...d.decision, [key]: value } }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const { strategy: s, risk: r, fills: f, decision: d, recordOptions, windowStrikes } = draft;
    send({ action: "config", patch: { strategy: s, risk: r, fills: f, decision: d, recordOptions, windowStrikes } });
  };

  return (
    <Panel title="Settings" meta="Saved in the engine; they apply from the next entry">
      <form onSubmit={submit} className="space-y-4">
        <Group title="Strategy">
          <SelectField label="Follow signal" value={draft.strategy.signal} onChange={(v) => strategy("signal", v)} options={SIGNALS.map((s) => ({ value: s.id, label: s.name }))} />
          <SelectField
            label="Trade"
            value={draft.strategy.side}
            onChange={(v) => strategy("side", v)}
            options={[
              { value: "both", label: "Calls on long, puts on short" },
              { value: "calls", label: "Calls only" },
              { value: "puts", label: "Puts only" },
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
          <NumberField label="Lots" value={draft.strategy.lots} min={1} onChange={(v) => strategy("lots", v)} />
          <NumberField label="Hold" value={draft.strategy.holdMinutes} min={1} suffix="min" onChange={(v) => strategy("holdMinutes", v)} />
          <NumberField label="Stop loss (0 is off)" value={draft.strategy.stopLossPct} suffix="% of premium" onChange={(v) => strategy("stopLossPct", v)} />
          <NumberField label="Target (0 is off)" value={draft.strategy.targetPct} suffix="% of premium" onChange={(v) => strategy("targetPct", v)} />
          <NumberField label="Skip expiries nearer than" value={draft.strategy.minDaysToExpiry} suffix="days" onChange={(v) => strategy("minDaysToExpiry", v)} />
          <label className="inline-flex h-7 items-center gap-1.5 text-label text-muted">
            <input type="checkbox" checked={draft.strategy.exitOnOpposite} onChange={(e) => strategy("exitOnOpposite", e.target.checked)} />
            Sell on an opposite signal
          </label>
        </Group>

        <Group title="Limits">
          <TimeField label="Entries from" value={draft.risk.entryFrom} onChange={(v) => risk("entryFrom", v)} />
          <TimeField label="Entries until" value={draft.risk.entryUntil} onChange={(v) => risk("entryUntil", v)} />
          <TimeField label="Sell everything at" value={draft.risk.squareOffAt} onChange={(v) => risk("squareOffAt", v)} />
          <NumberField label="Trades a day" value={draft.risk.maxTradesPerDay} min={1} onChange={(v) => risk("maxTradesPerDay", v)} />
          <NumberField label="Positions at once" value={draft.risk.maxOpenPositions} min={1} onChange={(v) => risk("maxOpenPositions", v)} />
          <NumberField label="Stop the day at a loss of" value={draft.risk.maxDailyLoss} step={100} suffix="₹" onChange={(v) => risk("maxDailyLoss", v)} />
          <NumberField label="Or after losses in a row" value={draft.risk.maxConsecutiveLosses} min={1} onChange={(v) => risk("maxConsecutiveLosses", v)} />
          <NumberField label="Most premium a trade" value={draft.risk.maxPremiumPerTrade} step={500} suffix="₹" onChange={(v) => risk("maxPremiumPerTrade", v)} />
          <NumberField label="Least premium" value={draft.risk.minPremium} suffix="₹" onChange={(v) => risk("minPremium", v)} />
          <NumberField label="Widest spread" value={draft.risk.maxSpreadPct} step={0.5} suffix="%" onChange={(v) => risk("maxSpreadPct", v)} />
          <NumberField label="Wait after a trade" value={draft.risk.cooldownMinutes} suffix="min" onChange={(v) => risk("cooldownMinutes", v)} />
          <NumberField label="Oldest quote to trade on" value={draft.risk.maxQuoteAgeSeconds} min={1} suffix="s" onChange={(v) => risk("maxQuoteAgeSeconds", v)} />
        </Group>

        <Group title="Decision API">
          <SelectField
            label="Role"
            value={draft.decision.mode}
            onChange={(v) => decision("mode", v)}
            options={[
              { value: "gate", label: "Gate: can turn a trade down" },
              { value: "shadow", label: "Shadow: asked and recorded only" },
              { value: "off", label: "Off" },
            ]}
          />
          <NumberField label="Take a trade at" value={draft.decision.minProbability} step={0.05} suffix="probability or more" onChange={(v) => decision("minProbability", v)} />
          <SelectField
            label="No answer in time"
            value={draft.decision.onError}
            onChange={(v) => decision("onError", v)}
            options={[
              { value: "skip", label: "Skip the entry" },
              { value: "allow", label: "Take the entry" },
            ]}
          />
          <NumberField label="Wait at most" value={draft.decision.timeoutMs} step={500} min={500} suffix="ms" onChange={(v) => decision("timeoutMs", v)} />
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
          <label className="inline-flex h-7 items-center gap-1.5 text-label text-muted">
            <input type="checkbox" checked={draft.decision.vetoAgainstRegime} onChange={(e) => decision("vetoAgainstRegime", e.target.checked)} />
            Turn down trades against the regime
          </label>
        </Group>

        <Group title="Paper fills and recording">
          <NumberField label="Slippage past the bid or ask" value={draft.fills.slippage} step={0.05} suffix="₹" onChange={(v) => fills("slippage", v)} />
          <NumberField label="Slippage with no order book" value={draft.fills.looseSlippage} step={0.05} suffix="₹" onChange={(v) => fills("looseSlippage", v)} />
          <NumberField label="Order delay" value={draft.fills.latencyMs} step={50} suffix="ms" onChange={(v) => fills("latencyMs", v)} />
          <NumberField label="Option strikes kept on the feed" value={draft.windowStrikes} min={1} suffix="each side" onChange={(v) => setDraft((d) => ({ ...d, windowStrikes: v }))} />
          <label className="inline-flex h-7 items-center gap-1.5 text-label text-muted">
            <input type="checkbox" checked={draft.recordOptions} onChange={(e) => setDraft((d) => ({ ...d, recordOptions: e.target.checked }))} />
            Record these options every session, even with entries off
          </label>
        </Group>

        <div className="flex items-center gap-2">
          <button type="submit" className={buttonClass} disabled={pending || !dirty}>
            Save settings
          </button>
          {dirty && (
            <button type="button" className={buttonClass} disabled={pending} onClick={() => setDraft(config)}>
              Discard changes
            </button>
          )}
          <span className="text-label text-muted">Charges are Dhan&apos;s: ₹20 an order, STT 0.15% on sells, exchange fees, stamp duty and 18% GST.</span>
        </div>
      </form>
    </Panel>
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
          {data.trades.length === 0 ? (
            <p className="px-3 pb-3 text-muted">This run closed no trades.</p>
          ) : (
            <DataTable
              caption={`Trades of ${data.run}`}
              minWidth="min-w-[56rem]"
              columns={["Bought", { label: "Sold", align: "left" }, { label: "Contract", align: "left" }, "Qty", "Entry", "Exit", { label: "Closed by", align: "left" }, "Before charges", "Charges", "Net", "Decision"]}
            >
              {data.trades.map((trade: TradeRow) => (
                <tr key={`${trade.book}-${trade.id}`} className={trade.book === "shadow" ? "text-muted" : undefined}>
                  <Td className="tabular-nums">{clock(trade.opened_at)}</Td>
                  <Td className="tabular-nums">{clock(trade.closed_at)}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5">
                      <BookTag book={trade.book === "shadow" ? "shadow" : "paper"} />
                      {trade.contract}
                    </span>
                  </Td>
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
          )}
        </div>
      )}
    </Panel>
  );
}
