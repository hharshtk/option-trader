// Every trading setting in force, as short label and value pairs grouped by topic: what the settings
// summary at the top of the Strategies page shows. Pure.

import { COST_CHECK_FACTOR } from "../decide/cost.ts";
import { DECISION_PROVIDERS, FOLLOWABLE_RULES, SIGNALS, type TradingStatus } from "./trading.ts";

const LOT = 65;
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export interface SettingsGroup {
  title: string;
  rows: [label: string, value: string][];
}

export function describeSettings(trading: Pick<TradingStatus, "config" | "moveHistory">): SettingsGroup[] {
  const { strategy: s, risk: r, fills: f, decision: d, armed } = trading.config;
  const scalping = s.exitIn === "rupees";
  const rule = s.rule ? FOLLOWABLE_RULES.find((x) => x.id === s.rule)?.name : null;
  const signal = SIGNALS.find((x) => x.id === s.signal)?.name ?? s.signal;
  const strike = s.strikeOffset === 0 ? "ATM" : `${Math.abs(s.strikeOffset)} ${s.strikeOffset > 0 ? "OTM" : "ITM"}`;
  const history = trading.moveHistory;
  const provider = DECISION_PROVIDERS.find((p) => p.id === d.provider)?.name ?? d.provider;
  const off = (n: number, text: string) => (n > 0 ? text : "off");

  const exits: SettingsGroup["rows"] = scalping
    ? [["Take / cut", `${off(s.targetNet, inr(s.targetNet))} / ${off(s.stopNet, inr(s.stopNet))} after charges`]]
    : s.exitsFrom === "volatility"
      ? [
          ["Stop / target", `${s.stopMoves}× / ${s.targetMoves}× typical move`],
          ["Move from", history ? `last ${history.days} days, same time` : "today's 1-min move"],
          ["Fallback", `${s.stopLossPct}% / ${s.targetPct}%`],
        ]
      : [["Stop / target", `${off(s.stopLossPct, `${s.stopLossPct}%`)} / ${off(s.targetPct, `${s.targetPct}%`)}`]];
  if (!scalping && s.trailStop) exits.push(["Trailing stop", "on: follows the best price, no target"]);
  exits.push(
    ["Hold", `${scalping ? s.scalpHoldMinutes : s.holdMinutes} min`],
    ["Opposite signal", s.exitOnOpposite ? "sells" : "ignored"],
    ["Square off", r.squareOffAt],
  );

  return [
    {
      title: "Entries",
      rows: [
        ["Entries", armed ? "on" : "off"],
        rule ? ["Rule", rule] : ["Signal", signal],
        ["Side", s.side === "both" ? "calls and puts" : `${s.side} only`],
        ["Option", `${strike}, ${s.lots} lot${s.lots === 1 ? "" : "s"} (${s.lots * LOT})`],
        ["Expiry", s.minDaysToExpiry > 0 ? `≥ ${s.minDaysToExpiry} days away` : "nearest"],
        ["Window", `${r.entryFrom}–${r.entryUntil}`],
        ["Cost check", s.costCheck ? `on (${COST_CHECK_FACTOR}×)` : "off"],
      ],
    },
    { title: scalping ? "Exits · Scalping" : "Exits · Standard", rows: exits },
    {
      title: "Limits",
      rows: [
        ["Daily loss", inr(r.maxDailyLoss)],
        ["Losses in a row", String(r.maxConsecutiveLosses)],
        ["Trades a day", String(r.maxTradesPerDay)],
        ["Open at once", String(r.maxOpenPositions)],
        ["Wait between", `${scalping ? r.scalpCooldownMinutes : r.cooldownMinutes} min`],
        ["Premium", `${inr(r.minPremium)}–${inr(r.maxPremiumPerTrade)}`],
        ["Max spread", `${r.maxSpreadPct}%`],
        ["Quote age", `≤ ${r.maxQuoteAgeSeconds} s`],
      ],
    },
    {
      title: "AI check",
      rows:
        d.mode === "off"
          ? [["Mode", "off"]]
          : [
              ["Mode", d.mode === "gate" ? `can turn down, ≥ ${d.minProbability}${d.vetoAgainstRegime ? ", trend veto" : ""}` : "record only"],
              ["Model", `${provider} · ${d.model}`],
              ["No answer", `${d.onError === "skip" ? "skip" : "take"} after ${d.timeoutMs / 1000} s`],
            ],
    },
    {
      title: "Fills",
      rows: [
        ["Slippage", `${inr(f.slippage)} (${inr(f.looseSlippage)} no book)`],
        ["Fill delay", `${f.latencyMs} ms`],
        ["Recording", `±${trading.config.windowStrikes} strikes${trading.config.recordOptions ? ", always" : ""}`],
      ],
    },
  ];
}
