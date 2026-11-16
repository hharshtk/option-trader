"use client";

// "Trade it with options": replays the chosen signal's firings with real NIFTY option prices.
// Contracts come from the scrip file the app downloads daily (/api/insight/options), prices from
// Dhan's 1-minute option candles (/api/insight/option-candles). The arithmetic is in
// lib/insight/option-trades.ts. Paper only: nothing here places an order.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DataTable, EmptyState, Field, Panel, Td } from "@/components/ui";
import { istTime, price, quantity, signedInr } from "@/lib/format";
import type { Pulse } from "@/lib/insight/pulse";
import {
  futuresComparison,
  planTrades,
  simulateTrades,
  type OptionCandles,
  type OptionChoices,
  type OptionTrade,
  type SideChoice,
  type StrikeChoice,
} from "@/lib/insight/option-trades";
import type { LabFocus } from "./pulse-view";

const IST_OFFSET_MS = 5.5 * 3_600_000;
const CANDLE_REFRESH_MS = 60_000;
const IDS_PER_REQUEST = 20;
const SLIPPAGES = [0, 0.5, 1, 2];
const RELATIVE = [
  { value: "rel:0", label: "ATM at each firing" },
  { value: "rel:1", label: "1 strike OTM" },
  { value: "rel:2", label: "2 strikes OTM" },
  { value: "rel:-1", label: "1 strike ITM" },
  { value: "rel:-2", label: "2 strikes ITM" },
];

const rupees = (v: number) => signedInr.format(Math.round(v));
const plainRupees = (v: number) => `₹${quantity.format(Math.round(v))}`;
const hhmm = (at: number) => istTime.format(new Date(at)).slice(0, 5);
const signedPts = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;

type Choices = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: OptionChoices };

export function OptionReplay({
  pulse,
  focus,
  horizon,
  onSelect,
}: {
  pulse: Pulse;
  focus: LabFocus | null;
  /** The Signal lab's hold, so the dropdown can show each signal's firings at it. */
  horizon: number;
  /** Shared with the Signal lab's "Show on chart": picking here also marks the chart. */
  onSelect: (id: string | null) => void;
}) {
  const [expiry, setExpiry] = useState<string | null>(null);
  const [strikeValue, setStrikeValue] = useState("rel:0");
  const [side, setSide] = useState<SideChoice>("both");
  const [lots, setLots] = useState(1);
  const [slippage, setSlippage] = useState(0.5);

  // Strikes covering the day's range with room either side, rounded so a new tick doesn't refetch.
  const low = Math.floor(((pulse.nifty.low ?? pulse.nifty.ltp) - 500) / 500) * 500;
  const high = Math.ceil(((pulse.nifty.high ?? pulse.nifty.ltp) + 500) / 500) * 500;
  const choices = useChoices(low, high, expiry);
  const data = choices.state === "ready" ? choices.data : null;
  const lotSize = data?.lotSize ?? null;
  const qty = lotSize ? lotSize * lots : 0;

  const spotAt = useMemo(() => {
    const byMinute = new Map(pulse.series.map((p) => [p.at, p.nifty]));
    return (at: number) => byMinute.get(at) ?? null;
  }, [pulse.series]);

  const strike: StrikeChoice = strikeValue.startsWith("rel:") ? { kind: "relative", offset: Number(strikeValue.slice(4)) } : { kind: "fixed", strike: Number(strikeValue.slice(4)) };
  const planned = useMemo(
    () => (data && focus ? planTrades(focus.events, spotAt, data.strikes, strike, side) : []),
    // `strike` is rebuilt each render from strikeValue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, focus, spotAt, strikeValue, side],
  );
  const date = new Date((pulse.series[0]?.at ?? pulse.asOf) + IST_OFFSET_MS).toISOString().slice(0, 10);
  const ids = useMemo(() => [...new Set(planned.flatMap((p) => (p.leg ? [p.leg.securityId] : [])))].sort(), [planned]);
  const candles = useCandles(date, ids);

  const trades = useMemo(
    () => (focus ? simulateTrades(planned, candles.data, { horizon: focus.horizon, qty, slippage, spotAt }) : []),
    [planned, candles.data, focus, qty, slippage, spotAt],
  );

  return (
    <Panel
      title="Trade it with options"
      meta={focus ? `${focus.name} firings, held ${focus.horizon} min, priced with Dhan's 1-minute option candles` : "pick a signal to replay"}
    >
      {!focus ? (
        <div className="grid gap-3">
          <SignalPicker pulse={pulse} focus={focus} horizon={horizon} onSelect={onSelect} />
          <EmptyState>Pick a signal to replay its firings with options. Its arrows also appear on the chart.</EmptyState>
        </div>
      ) : choices.state === "loading" ? (
        <EmptyState>Loading NIFTY option contracts…</EmptyState>
      ) : choices.state === "error" ? (
        <p className="text-down">{choices.message}</p>
      ) : (
        <>
          <Controls
            picker={<SignalPicker pulse={pulse} focus={focus} horizon={horizon} onSelect={onSelect} />}
            data={choices.data}
            expiry={choices.data.expiry}
            setExpiry={setExpiry}
            strikeValue={strikeValue}
            setStrikeValue={setStrikeValue}
            side={side}
            setSide={setSide}
            lots={lots}
            setLots={setLots}
            slippage={slippage}
            setSlippage={setSlippage}
            lotSize={lotSize}
          />
          {!choices.data.scrips.current && (
            <p className="mt-2 text-label text-warn">
              Contracts are from the option instruments downloaded for {choices.data.scrips.tradingDate}. Download today&apos;s in Settings if strikes or lot
              sizes look wrong.
            </p>
          )}
          {candles.error && <p className="mt-2 text-label text-down">{candles.error}</p>}
          <Results trades={trades} qty={qty} slippage={slippage} loading={candles.loading} focus={focus} />
        </>
      )}
    </Panel>
  );
}

function useChoices(low: number, high: number, expiry: string | null): Choices {
  const [choices, setChoices] = useState<Choices>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ min: String(low), max: String(high), ...(expiry ? { expiry } : {}) });
    fetch(`/api/insight/options?${query}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) setChoices({ state: "error", message: body?.error?.message ?? `HTTP ${response.status}` });
        else setChoices({ state: "ready", data: body as OptionChoices });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setChoices({ state: "error", message: error.message });
      });
    return () => controller.abort();
  }, [low, high, expiry]);
  return choices;
}

/** Candles for the contracts in play, refreshed every minute so new firings get their exit price. */
function useCandles(date: string, ids: string[]) {
  const [data, setData] = useState<OptionCandles["candles"]>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = ids.join(",");

  useEffect(() => {
    if (!key) return;
    const wanted = key.split(",");
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      const errors: string[] = [];
      for (let i = 0; i < wanted.length; i += IDS_PER_REQUEST) {
        const chunk = wanted.slice(i, i + IDS_PER_REQUEST);
        try {
          const response = await fetch(`/api/insight/option-candles?date=${date}&ids=${chunk.join(",")}`, { signal: controller.signal, cache: "no-store" });
          const body = (await response.json()) as OptionCandles & { error?: { message: string } };
          if (cancelled) return;
          if (!response.ok) errors.push(body.error?.message ?? `HTTP ${response.status}`);
          else {
            setData((current) => ({ ...current, ...body.candles }));
            errors.push(...Object.values(body.errors));
          }
        } catch (e) {
          if (cancelled || controller.signal.aborted) return;
          errors.push((e as Error).message);
        }
      }
      if (cancelled) return;
      setError(errors.length ? `Some option candles didn't load: ${[...new Set(errors)].join("; ")}` : null);
      setLoading(false);
      timer = setTimeout(function next() {
        if (document.hidden) timer = setTimeout(next, CANDLE_REFRESH_MS);
        else void load();
      }, CANDLE_REFRESH_MS);
    }

    void load();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [date, key]);

  return { data, error, loading };
}

// --- Controls ----------------------------------------------------------------------------------

function Controls(props: {
  picker: ReactNode;
  data: OptionChoices;
  expiry: string;
  setExpiry: (v: string) => void;
  strikeValue: string;
  setStrikeValue: (v: string) => void;
  side: SideChoice;
  setSide: (v: SideChoice) => void;
  lots: number;
  setLots: (v: number) => void;
  slippage: number;
  setSlippage: (v: number) => void;
  lotSize: number | null;
}) {
  const { data, lotSize } = props;
  const select = "h-7 rounded-sm border border-line-strong bg-canvas px-2 text-body";
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
      {props.picker}
      <Labelled label="Expiry">
        <select className={select} value={props.expiry} onChange={(e) => props.setExpiry(e.target.value)}>
          {data.expiries.map((e) => (
            <option key={e} value={e}>
              {e} ({daysTo(e)})
            </option>
          ))}
        </select>
      </Labelled>
      <Labelled label="Strike">
        <select className={select} value={props.strikeValue} onChange={(e) => props.setStrikeValue(e.target.value)}>
          <optgroup label="Follows NIFTY">
            {RELATIVE.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="One strike all day">
            {data.strikes.map((s) => (
              <option key={s.strike} value={`fix:${s.strike}`}>
                {price.format(s.strike)}
              </option>
            ))}
          </optgroup>
        </select>
      </Labelled>
      <Labelled label="Trade">
        <select className={select} value={props.side} onChange={(e) => props.setSide(e.target.value as SideChoice)}>
          <option value="both">Both: buy CE on ▲, PE on ▼</option>
          <option value="calls">Calls only (▲ firings)</option>
          <option value="puts">Puts only (▼ firings)</option>
        </select>
      </Labelled>
      <Labelled label={lotSize ? `Lots (1 lot = ${lotSize})` : "Lots"}>
        <span className="inline-flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={100}
            value={props.lots}
            onChange={(e) => props.setLots(Math.min(100, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
            className={`${select} w-20 tabular-nums`}
          />
          {lotSize && <span className="text-label text-muted tabular-nums">qty {quantity.format(lotSize * props.lots)}</span>}
        </span>
      </Labelled>
      <Labelled label="Slippage per unit, each way">
        <select className={select} value={props.slippage} onChange={(e) => props.setSlippage(Number(e.target.value))}>
          {SLIPPAGES.map((s) => (
            <option key={s} value={s}>
              {s === 0 ? "none" : `₹${s}`}
            </option>
          ))}
        </select>
      </Labelled>
    </div>
  );
}

/** Which Signal lab signal to replay, with how often each fired at the current hold. */
function SignalPicker({ pulse, focus, horizon, onSelect }: { pulse: Pulse; focus: LabFocus | null; horizon: number; onSelect: (id: string | null) => void }) {
  return (
    <Labelled label={`Signal (held ${horizon} min, set in the Signal lab)`}>
      <select
        className="h-7 rounded-sm border border-line-strong bg-canvas px-2 text-body"
        value={focus?.id ?? ""}
        onChange={(e) => onSelect(e.target.value || null)}
      >
        {!focus && <option value="">Choose a signal…</option>}
        {pulse.signals.map((s) => {
          const fired = s.stats.find((x) => x.horizon === horizon)?.fired ?? 0;
          return (
            <option key={s.id} value={s.id}>
              {s.name} · {fired} firing{fired === 1 ? "" : "s"}
            </option>
          );
        })}
      </select>
    </Labelled>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-label text-muted">{label}</span>
      {children}
    </label>
  );
}

function daysTo(expiry: string) {
  const days = Math.round((Date.parse(`${expiry}T10:00:00Z`) - Date.now()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
}

// --- Results -----------------------------------------------------------------------------------

function Results({ trades, qty, slippage, loading, focus }: { trades: OptionTrade[]; qty: number; slippage: number; loading: boolean; focus: LabFocus }) {
  const priced = trades.filter((t) => !t.skipped);
  if (trades.length === 0) {
    return (
      <div className="mt-3">
        <EmptyState>No firings to trade on this side at a {focus.horizon}-minute hold yet.</EmptyState>
      </div>
    );
  }
  const net = priced.reduce((a, t) => a + t.net, 0);
  const gross = priced.reduce((a, t) => a + t.gross, 0);
  const charges = priced.reduce((a, t) => a + t.charges, 0);
  const slip = priced.length * 2 * slippage * qty;
  const wins = priced.filter((t) => t.net > 0).length;
  const capital = Math.max(0, ...priced.map((t) => (t.entry! + slippage) * qty));
  const best = priced.reduce<OptionTrade | null>((b, t) => (!b || t.net > b.net ? t : b), null);
  const worst = priced.reduce<OptionTrade | null>((b, t) => (!b || t.net < b.net ? t : b), null);
  const futures = futuresComparison(priced, qty, 0.5);

  return (
    <div className="mt-3 grid gap-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-sm border border-line p-3 sm:grid-cols-3 xl:grid-cols-6">
        <Field size="lg" label="Net P&L" value={<span className={net >= 0 ? "text-up" : "text-down"}>{rupees(net)}</span>} />
        <Field
          size="lg"
          label="Trades"
          value={
            <span>
              {priced.length}
              {priced.length < trades.length && <span className="ml-1 text-label text-muted">of {trades.length} priced{loading ? ", loading" : ""}</span>}
            </span>
          }
        />
        <Field size="lg" label="Winners after costs" value={priced.length ? `${wins} (${Math.round((wins / priced.length) * 100)}%)` : "—"} />
        <Field
          size="lg"
          label="Before costs"
          value={
            <span>
              <span className={gross + slip >= 0 ? "text-up" : "text-down"}>{rupees(gross + slip)}</span>
            </span>
          }
        />
        <Field size="lg" label="Charges + slippage" value={<span className="text-down">−{plainRupees(charges + slip)}</span>} />
        <Field size="lg" label="Most premium at risk" value={capital ? plainRupees(capital) : "—"} />
      </dl>

      <Equity trades={priced} />

      <ul className="grid gap-1.5" aria-label="What this shows">
        {priced.length > 0 && (
          <li>
            → Following {focus.name} with options {net >= 0 ? "made" : "lost"} <b className={net >= 0 ? "text-up" : "text-down"}>{rupees(net)}</b> on{" "}
            {priced.length} trade{priced.length === 1 ? "" : "s"} of {quantity.format(qty)} units. Before charges and slippage it was{" "}
            {rupees(gross + slip)}; costs took {plainRupees(charges + slip)}, about {plainRupees((charges + slip) / Math.max(1, priced.length))} a trade.
          </li>
        )}
        {futures.count > 0 && (
          <li>
            → The same {futures.count} firings with NIFTY futures ({quantity.format(qty)} units) would have {futures.net >= 0 ? "made" : "lost"}{" "}
            <b className={futures.net >= 0 ? "text-up" : "text-down"}>{rupees(futures.net)}</b>. Options move less than NIFTY (about half for ATM) and lose
            time value every minute, which a long option pays for while it waits.
          </li>
        )}
        {best && worst && priced.length > 1 && (
          <li>
            → Best trade {rupees(best.net)} at {hhmm(best.event.at + 60_000)} ({best.leg?.name}); worst {rupees(worst.net)} at {hhmm(worst.event.at + 60_000)}{" "}
            ({worst.leg?.name}).
          </li>
        )}
      </ul>

      <TradeTable trades={trades} />

      <p className="text-label text-muted">
        Each firing buys at the option&apos;s 1-minute close when the signal fires and sells at the close {focus.horizon} minutes later, paying the slippage
        both ways. Charges assume ₹20 an order, STT 0.1% on the sell premium, NSE fees 0.035%, stamp 0.003% on the buy, SEBI fees and 18% GST: check them
        against Dhan&apos;s charges page. Minutes with no trade in an option use the last close within 3 minutes. Paper only: this places no orders.
      </p>
    </div>
  );
}

function TradeTable({ trades }: { trades: OptionTrade[] }) {
  return (
    <DataTable
      caption="Replayed option trades"
      minWidth="min-w-[64rem]"
      columns={[
        { label: "Time", align: "left" },
        { label: "Signal", align: "left" },
        { label: "Contract", align: "left" },
        "NIFTY move",
        "Buy",
        "Sell",
        "Option move",
        "Per NIFTY pt",
        "Qty",
        "Gross",
        "Charges",
        "Net",
      ]}
    >
      {[...trades].reverse().map((t) => (
        <tr key={`${t.event.at}-${t.type}`}>
          <Td>{hhmm(t.event.at + 60_000)}</Td>
          <Td>
            <span className={t.event.vote > 0 ? "text-up" : "text-down"}>{t.event.vote > 0 ? "▲ long" : "▼ short"}</span>
          </Td>
          <Td>{t.leg ? t.leg.name : <span className="text-muted">{t.strike ? `${t.strike} ${t.type}` : "—"}</span>}</Td>
          <Td numeric>
            <span className={t.event.outcome >= 0 ? "text-up" : "text-down"}>{signedPts(t.event.outcome)}</span>
          </Td>
          {t.skipped ? (
            <td colSpan={8} className="h-8 px-3 text-label text-muted">
              {t.skipped}
            </td>
          ) : (
            <>
              <Td numeric>{price.format(t.entry!)}</Td>
              <Td numeric>{price.format(t.exit!)}</Td>
              <Td numeric>
                <span className={t.exit! - t.entry! >= 0 ? "text-up" : "text-down"}>{signedPts(t.exit! - t.entry!)}</span>
              </Td>
              <Td numeric className="text-muted">
                {t.ratio !== null && Number.isFinite(t.ratio) ? t.ratio.toFixed(2) : "—"}
              </Td>
              <Td numeric>{quantity.format(t.qty)}</Td>
              <Td numeric>{rupees(t.gross)}</Td>
              <Td numeric className="text-muted">
                −{plainRupees(t.charges)}
              </Td>
              <Td numeric>
                <span className={`font-medium ${t.net >= 0 ? "text-up" : "text-down"}`}>{rupees(t.net)}</span>
              </Td>
            </>
          )}
        </tr>
      ))}
    </DataTable>
  );
}

/** Running P&L after costs, trade by trade. */
function Equity({ trades }: { trades: OptionTrade[] }) {
  if (trades.length < 2) return null;
  const points = [0];
  for (const t of trades) points.push(points[points.length - 1] + t.net);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const W = 600;
  const H = 72;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - 4 - ((v - min) / span) * (H - 8);
  const last = points[points.length - 1];
  return (
    <figure className="rounded-sm border border-line p-2">
      <figcaption className="flex justify-between text-label text-muted">
        <span>Running P&amp;L after costs, trade by trade</span>
        <span className="tabular-nums">
          low {rupees(min)} · high {rupees(max)}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-1 block h-[72px] w-full" role="img" aria-label={`Running P&L, ending ${rupees(last)}`}>
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--color-line-strong)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        <polyline
          fill="none"
          stroke={last >= 0 ? "var(--color-up)" : "var(--color-down)"}
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          points={points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
        />
      </svg>
    </figure>
  );
}
