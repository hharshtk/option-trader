"use client";

// The settings of one strategy, in plain words: what it is, when it trades, how it trades, and its
// AI check. Saving makes a new version; the old ones are kept.

import { useState, type ReactNode } from "react";
import { fieldClass } from "@/components/trading/shared";
import { buttonClass } from "@/components/ui";
import { DECISION_PROVIDERS, type DecisionProviderId, type SignalId } from "@/lib/engine/trading";
import { clockAt, isPattern, SIGNAL_PARAM_LIMITS, SIGNALS, withDefaults, type SignalParams } from "@/lib/strategies/signals";
import type { StrategyDefinition } from "@/lib/strategies/types";

/** What each signal looks for, in a sentence. */
const SIGNAL_MEANING: Record<SignalId, string> = {
  breadth: "Many of NIFTY's 50 stocks suddenly turning up, or down, together.",
  lead: "The 50 stocks on average moving ahead of the NIFTY index, which then tends to catch up.",
  momentum: "NIFTY moving strongly one way over a short time.",
  agree: "At least two of the three Pulse signals saying the same thing at once.",
  "day-momentum": "Once a day, late in the afternoon: if NIFTY rose in the first half hour (counting from the previous close), bet up for the rest of the day; if it fell, bet down.",
  "opening-range": "Note NIFTY's high and low in the first minutes of the day, then follow the first move that breaks out of that range. Once a day.",
  "ema-cross": "Trend following: bet up when a quick average of recent prices crosses above a slow one, and down when it crosses below.",
  supertrend: "Trend following: a line that trails NIFTY by a few typical moves; when NIFTY crosses it, the trend has turned.",
  "rsi-reversal": "Counter-trend: after NIFTY has fallen a lot in a short time (RSI low), bet on a bounce once it starts to recover, and the reverse after a big rise.",
  "gap-fade": "Once a day, early: when NIFTY opens well above or below yesterday's close, bet that the gap closes.",
};

const STRIKES = [
  { value: -2, label: "2 strikes in the money (costs more, moves more with NIFTY)" },
  { value: -1, label: "1 strike in the money" },
  { value: 0, label: "At the money (the usual choice)" },
  { value: 1, label: "1 strike out of the money (cheaper, moves less)" },
  { value: 2, label: "2 strikes out of the money" },
];

export function StrategyEditor({
  initial,
  mode,
  nextVersion,
  busy,
  providers,
  onSave,
  onCancel,
}: {
  initial: StrategyDefinition;
  mode: "new" | "edit";
  nextVersion: number;
  busy: boolean;
  providers: Record<DecisionProviderId, boolean> | null;
  onSave: (definition: StrategyDefinition, note: string) => void;
  onCancel?: () => void;
}) {
  // Versions saved before a signal existed get its default numbers, so every field has a value.
  const [start] = useState<StrategyDefinition>(() => ({ ...structuredClone(initial), trade: { ...structuredClone(initial.trade), params: withDefaults(initial.trade.params) } }));
  const [draft, setDraft] = useState<StrategyDefinition>(() => structuredClone(start));
  const [note, setNote] = useState("");
  const changed = mode === "new" || JSON.stringify(draft) !== JSON.stringify(start);
  const trade = <K extends keyof StrategyDefinition["trade"]>(key: K, value: StrategyDefinition["trade"][K]) => setDraft((d) => ({ ...d, trade: { ...d.trade, [key]: value } }));
  const decision = <K extends keyof StrategyDefinition["decision"]>(key: K, value: StrategyDefinition["decision"][K]) => setDraft((d) => ({ ...d, decision: { ...d.decision, [key]: value } }));
  const param = <S extends keyof SignalParams>(signal: S, field: keyof SignalParams[S], value: number) =>
    setDraft((d) => ({ ...d, trade: { ...d.trade, params: { ...d.trade.params, [signal]: { ...d.trade.params[signal], [field]: value } } } }));
  const p = draft.trade.params;
  const follow = draft.trade.signal;
  const shows = (signal: Exclude<SignalId, "agree">) => follow === signal || follow === "agree";
  const aiOff = draft.decision.mode === "off";

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft, note);
      }}
    >
      <Section title="What it is">
        <label className="flex flex-col gap-1 text-label text-muted">
          Name
          <input type="text" required minLength={2} maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${fieldClass} w-full max-w-md text-body text-fg`} />
        </label>
        <label className="flex flex-col gap-1 text-label text-muted">
          The idea: why should this make money?
          <textarea
            rows={2}
            maxLength={1000}
            value={draft.idea}
            onChange={(e) => setDraft({ ...draft, idea: e.target.value })}
            placeholder="For example: when most stocks turn up together, NIFTY tends to keep rising for a few minutes."
            className="w-full max-w-2xl rounded-sm border border-line-strong bg-canvas px-2 py-1.5 text-body text-fg focus-visible:border-accent"
          />
        </label>
      </Section>

      <Section title="When it trades" hint="The signal that starts a trade, and its numbers.">
        <label className="flex flex-col gap-1 text-label text-muted">
          Signal
          <select value={follow} onChange={(e) => trade("signal", e.target.value as SignalId)} className={`${fieldClass} w-full max-w-md text-body text-fg`}>
            <optgroup label="Pulse signals">
              {SIGNALS.filter((s) => !isPattern(s.id)).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Well-known strategies">
              {SIGNALS.filter((s) => isPattern(s.id)).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          </select>
          <span className="text-label">{SIGNAL_MEANING[follow]}</span>
        </label>
        {shows("breadth") && (
          <Sentence label="Breadth thrust">
            Stocks up minus stocks down changes by at least <Num value={p.breadth.stocks} limits={SIGNAL_PARAM_LIMITS.breadth.stocks} onChange={(v) => param("breadth", "stocks", v)} /> stocks over{" "}
            <Num value={p.breadth.minutes} limits={SIGNAL_PARAM_LIMITS.breadth.minutes} onChange={(v) => param("breadth", "minutes", v)} /> minutes
          </Sentence>
        )}
        {shows("lead") && (
          <Sentence label="Basket leads index">
            The average stock gets ahead of, or behind, NIFTY by at least <Num value={p.lead.bps} step={0.5} limits={SIGNAL_PARAM_LIMITS.lead.bps} onChange={(v) => param("lead", "bps", v)} /> hundredths of a percent
            over <Num value={p.lead.minutes} limits={SIGNAL_PARAM_LIMITS.lead.minutes} onChange={(v) => param("lead", "minutes", v)} /> minutes
          </Sentence>
        )}
        {shows("momentum") && (
          <Sentence label="Momentum">
            NIFTY moves at least <Num value={p.momentum.pct} step={0.01} limits={SIGNAL_PARAM_LIMITS.momentum.pct} onChange={(v) => param("momentum", "pct", v)} />% over{" "}
            <Num value={p.momentum.minutes} limits={SIGNAL_PARAM_LIMITS.momentum.minutes} onChange={(v) => param("momentum", "minutes", v)} /> minutes
          </Sentence>
        )}
        {follow === "agree" && (
          <Sentence label="Agreement">
            Trade when at least <Num value={p.agree.min} limits={SIGNAL_PARAM_LIMITS.agree.min} onChange={(v) => param("agree", "min", v)} /> of the three point the same way
          </Sentence>
        )}
        {follow === "day-momentum" && (
          <>
            <Sentence label="First part of the day">
              NIFTY&apos;s move from the previous close to <ClockNum minutes={p["day-momentum"].firstMinutes} limits={SIGNAL_PARAM_LIMITS["day-momentum"].firstMinutes} onChange={(v) => param("day-momentum", "firstMinutes", v)} />, at least{" "}
              <Num value={p["day-momentum"].minPct} step={0.05} limits={SIGNAL_PARAM_LIMITS["day-momentum"].minPct} onChange={(v) => param("day-momentum", "minPct", v)} />%
            </Sentence>
            <Sentence label="Decide at">
              <ClockNum minutes={p["day-momentum"].at} limits={SIGNAL_PARAM_LIMITS["day-momentum"].at} onChange={(v) => param("day-momentum", "at", v)} /> (must be inside the engine&apos;s trading hours, 09:25–14:45 by default)
            </Sentence>
          </>
        )}
        {follow === "opening-range" && (
          <Sentence label="Opening range">
            The high and low of the first <Num value={p["opening-range"].minutes} limits={SIGNAL_PARAM_LIMITS["opening-range"].minutes} onChange={(v) => param("opening-range", "minutes", v)} /> minutes; a break counts when NIFTY
            closes at least <Num value={p["opening-range"].bufferPct} step={0.05} limits={SIGNAL_PARAM_LIMITS["opening-range"].bufferPct} onChange={(v) => param("opening-range", "bufferPct", v)} />% beyond it
          </Sentence>
        )}
        {follow === "ema-cross" && (
          <Sentence label="Averages">
            A <Num value={p["ema-cross"].fast} limits={SIGNAL_PARAM_LIMITS["ema-cross"].fast} onChange={(v) => param("ema-cross", "fast", v)} />-bar average against a{" "}
            <Num value={p["ema-cross"].slow} limits={SIGNAL_PARAM_LIMITS["ema-cross"].slow} onChange={(v) => param("ema-cross", "slow", v)} />-bar one, on{" "}
            <Num value={p["ema-cross"].barMinutes} limits={SIGNAL_PARAM_LIMITS["ema-cross"].barMinutes} onChange={(v) => param("ema-cross", "barMinutes", v)} />-minute bars
          </Sentence>
        )}
        {follow === "supertrend" && (
          <Sentence label="Supertrend">
            Trailing <Num value={p.supertrend.multiplier} step={0.5} limits={SIGNAL_PARAM_LIMITS.supertrend.multiplier} onChange={(v) => param("supertrend", "multiplier", v)} /> typical moves behind NIFTY, the typical move
            measured over <Num value={p.supertrend.period} limits={SIGNAL_PARAM_LIMITS.supertrend.period} onChange={(v) => param("supertrend", "period", v)} /> bars of{" "}
            <Num value={p.supertrend.barMinutes} limits={SIGNAL_PARAM_LIMITS.supertrend.barMinutes} onChange={(v) => param("supertrend", "barMinutes", v)} /> minutes
          </Sentence>
        )}
        {follow === "rsi-reversal" && (
          <Sentence label="RSI">
            RSI over <Num value={p["rsi-reversal"].period} limits={SIGNAL_PARAM_LIMITS["rsi-reversal"].period} onChange={(v) => param("rsi-reversal", "period", v)} /> bars of{" "}
            <Num value={p["rsi-reversal"].barMinutes} limits={SIGNAL_PARAM_LIMITS["rsi-reversal"].barMinutes} onChange={(v) => param("rsi-reversal", "barMinutes", v)} /> minutes: bet up when it climbs back above{" "}
            <Num value={p["rsi-reversal"].low} limits={SIGNAL_PARAM_LIMITS["rsi-reversal"].low} onChange={(v) => param("rsi-reversal", "low", v)} />, down when it falls back below{" "}
            <Num value={p["rsi-reversal"].high} limits={SIGNAL_PARAM_LIMITS["rsi-reversal"].high} onChange={(v) => param("rsi-reversal", "high", v)} />
          </Sentence>
        )}
        {follow === "gap-fade" && (
          <Sentence label="Gap">
            At <ClockNum minutes={p["gap-fade"].at} limits={SIGNAL_PARAM_LIMITS["gap-fade"].at} onChange={(v) => param("gap-fade", "at", v)} />, bet against an opening gap of at least{" "}
            <Num value={p["gap-fade"].minPct} step={0.05} limits={SIGNAL_PARAM_LIMITS["gap-fade"].minPct} onChange={(v) => param("gap-fade", "minPct", v)} />% and at most{" "}
            <Num value={p["gap-fade"].maxPct} step={0.1} limits={SIGNAL_PARAM_LIMITS["gap-fade"].maxPct} onChange={(v) => param("gap-fade", "maxPct", v)} />%
          </Sentence>
        )}
      </Section>

      <Section title="How it trades" hint="When the signal says up it buys a call; when it says down, a put.">
        <div className="flex flex-wrap gap-x-4 gap-y-3">
          <Choice label="Trades" value={draft.trade.side} onChange={(v) => trade("side", v)} options={[
            { value: "both", label: "Up and down (calls and puts)" },
            { value: "calls", label: "Only up (calls)" },
            { value: "puts", label: "Only down (puts)" },
          ]} />
          <label className="flex flex-col gap-1 text-label text-muted">
            Which option
            <select value={draft.trade.strikeOffset} onChange={(e) => trade("strikeOffset", Number(e.target.value))} className={`${fieldClass} text-body text-fg`}>
              {STRIKES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <Field label="Lots" suffix={`× ${65} units`} value={draft.trade.lots} min={1} max={50} onChange={(v) => trade("lots", v)} />
          <Field label="Sell after" suffix="minutes" value={draft.trade.holdMinutes} min={1} max={240} onChange={(v) => trade("holdMinutes", v)} />
          <Field label="Stop-loss" suffix="% loss (0 = none)" value={draft.trade.stopLossPct} min={0} max={90} onChange={(v) => trade("stopLossPct", v)} />
          <Field label="Target" suffix="% gain (0 = none)" value={draft.trade.targetPct} min={0} max={500} onChange={(v) => trade("targetPct", v)} />
          <Field label="Skip expiries nearer than" suffix="days" value={draft.trade.minDaysToExpiry} min={0} max={30} onChange={(v) => trade("minDaysToExpiry", v)} />
        </div>
        <label className="inline-flex items-center gap-1.5 text-label text-muted">
          <input type="checkbox" checked={draft.trade.exitOnOpposite} onChange={(e) => trade("exitOnOpposite", e.target.checked)} />
          Sell early when the signal turns the other way
        </label>
      </Section>

      <Section title="AI check" hint="Before each trade the engine can ask an AI (the Decision API) whether the market supports it.">
        <div className="flex flex-wrap gap-x-4 gap-y-3">
          <Choice label="Use it" value={draft.decision.mode} onChange={(v) => decision("mode", v)} options={[
            { value: "off", label: "Off" },
            { value: "shadow", label: "Ask and record, never block" },
            { value: "gate", label: "Ask, and skip trades it doesn't like" },
          ]} />
          {!aiOff && (
            <>
              <label className="flex flex-col gap-1 text-label text-muted">
                Provider
                <select
                  value={draft.decision.provider}
                  // A new provider starts on its own default model.
                  onChange={(e) => {
                    const provider = e.target.value as DecisionProviderId;
                    setDraft((d) => ({ ...d, decision: { ...d.decision, provider, model: DECISION_PROVIDERS.find((x) => x.id === provider)!.defaultModel } }));
                  }}
                  className={`${fieldClass} text-body text-fg`}
                >
                  {DECISION_PROVIDERS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                      {providers && !providers[x.id] ? ` (no ${x.keyName})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-label text-muted">
                Model
                <input type="text" value={draft.decision.model} onChange={(e) => decision("model", e.target.value)} className={`${fieldClass} w-64 font-mono text-fg`} spellCheck={false} />
              </label>
              {draft.decision.mode === "gate" && (
                <Field label="Take trades it rates at least" suffix="% likely" value={Math.round(draft.decision.minProbability * 100)} min={0} max={100} onChange={(v) => decision("minProbability", v / 100)} />
              )}
              <Field label="Wait at most" suffix="ms" value={draft.decision.timeoutMs} min={500} max={30_000} step={500} onChange={(v) => decision("timeoutMs", v)} />
              {draft.decision.mode === "gate" && (
                <Choice label="If it doesn't answer in time" value={draft.decision.onError} onChange={(v) => decision("onError", v)} options={[
                  { value: "skip", label: "Skip the trade" },
                  { value: "allow", label: "Take the trade" },
                ]} />
              )}
            </>
          )}
        </div>
        {draft.decision.mode === "gate" && (
          <label className="inline-flex items-center gap-1.5 text-label text-muted">
            <input type="checkbox" checked={draft.decision.vetoAgainstRegime} onChange={(e) => decision("vetoAgainstRegime", e.target.checked)} />
            Also skip trades that go against the trend the AI sees
          </label>
        )}
        {!aiOff && <p className="text-label text-muted">{DECISION_PROVIDERS.find((x) => x.id === draft.decision.provider)!.price}.</p>}
      </Section>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {mode === "edit" && (
          <input
            type="text"
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What changed? (optional)"
            className={`${fieldClass} w-full max-w-sm text-body text-fg`}
          />
        )}
        <button type="submit" className={`${buttonClass} border-accent/60 bg-accent/15`} disabled={busy || !changed}>
          {mode === "new" ? "Create strategy" : `Save as version ${nextVersion}`}
        </button>
        {changed && mode === "edit" && (
          <button type="button" className="h-7 px-2 text-label text-muted hover:text-fg" onClick={() => setDraft(structuredClone(start))}>
            Undo changes
          </button>
        )}
        {onCancel && (
          <button type="button" className="h-7 px-2 text-label text-muted hover:text-fg" onClick={onCancel}>
            Cancel
          </button>
        )}
        {mode === "edit" && !changed && <span className="text-label text-muted">Change anything above to save a new version. Older versions are kept.</span>}
      </div>
    </form>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="mb-1 text-label font-medium tracking-wider text-muted uppercase">
        {title}
        {hint && <span className="ml-2 font-normal tracking-normal normal-case">{hint}</span>}
      </legend>
      {children}
    </fieldset>
  );
}

function Sentence({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-body">
      <span className="w-40 shrink-0 text-label text-muted">{label}</span>
      {children}
    </p>
  );
}

/** A time of day kept as minutes after 09:15, shown and entered as a clock time. */
function ClockNum({ minutes, limits, onChange }: { minutes: number; limits: readonly [number, number, boolean]; onChange: (minutes: number) => void }) {
  return (
    <input
      type="time"
      value={clockAt(minutes)}
      onChange={(e) => {
        const [h, m] = e.target.value.split(":").map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) onChange(Math.min(limits[1], Math.max(limits[0], h * 60 + m - (9 * 60 + 15))));
      }}
      className={`${fieldClass} text-fg tabular-nums`}
    />
  );
}

function Num({ value, limits, step = 1, onChange }: { value: number; limits: readonly [number, number, boolean]; step?: number; onChange: (value: number) => void }) {
  return (
    <input
      type="number"
      value={value}
      min={limits[0]}
      max={limits[1]}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`${fieldClass} w-20 text-center text-fg tabular-nums`}
    />
  );
}

function Field({ label, suffix, value, min, max, step = 1, onChange }: { label: string; suffix?: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-label text-muted">
      {label}
      <span className="inline-flex items-center gap-1.5">
        <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} className={`${fieldClass} w-24 text-fg tabular-nums`} />
        {suffix && <span>{suffix}</span>}
      </span>
    </label>
  );
}

function Choice<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (value: T) => void; options: readonly { value: T; label: string }[] }) {
  return (
    <label className="flex flex-col gap-1 text-label text-muted">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={`${fieldClass} text-body text-fg`}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
