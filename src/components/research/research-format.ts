// Words and numbers for the Research page, so every part says things the same way. The page talks
// in rupees and trades for one lot, not index points: results are for people without a finance
// background (docs/research-center.md, "Making it easy to use").

import { DEFAULT_COSTS, type StudySpec, type Verdict } from "@/lib/research/types";

/**
 * Rupees one option lot makes or loses when NIFTY moves one point: lot × delta, the study's
 * option settings (65 × 0.5 by default). Every rupee figure on the page is points × this.
 */
export const rupeesPerPoint = (costs: StudySpec["costs"] = DEFAULT_COSTS) => costs.option.lot * costs.option.delta;

/** Rupees the Indian way, without a sign: ₹130, ₹45,300, ₹1.9 lakh, ₹2.3 crore. */
export function rupees(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const v = Math.abs(value);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(1)} crore`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} lakh`;
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}

/** Rupees with a sign: +₹130, −₹1.9 lakh. */
export function signedRupees(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value) < 0 ? "−" : "+"}${rupees(value)}`;
}

/** "Likely between −₹48 and +₹38" for a 95% range. */
export function likely(lo: number | null, hi: number | null): string {
  return lo === null || hi === null ? "—" : `${signedRupees(lo)} to ${signedRupees(hi)}`;
}

/**
 * How sure the answer is, in a sentence, from the 95% range before costs and the cost of a trade
 * (any unit, the same for all three).
 */
export function certainty(lo: number | null, hi: number | null, cost: number): string {
  if (lo === null || hi === null) return "";
  if (hi - cost < 0) return "A clear result: even the most hopeful reading of the data loses money after costs.";
  if (lo - cost > 0) return "A clear result: even the most cautious reading of the data makes money after costs.";
  return "Not a clear result: with a bit more or less luck it could have gone either way.";
}

/** Colours for the plain verdicts, by how the verdict reads. */
export const VERDICT_TONE: Record<Verdict, string> = {
  "Edge after costs": "text-up border-up/50",
  "Ahead, could be luck": "text-warn border-warn/50",
  "Predicts, costs eat it": "text-warn border-warn/50",
  "No edge after costs": "text-down border-down/50",
  "Reliably wrong": "text-down border-down/50",
  "Too few firings": "text-muted border-line-strong",
};

/** Signed points with a real minus sign: +0.5, −1.2. */
export function pts(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "—";
  const rounded = Number(value.toFixed(digits));
  return `${rounded >= 0 ? "+" : "−"}${Math.abs(rounded).toFixed(digits)}`;
}

export function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`;
}

export const count = (value: number) => value.toLocaleString("en-IN");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-17" → "17 Nov 2026". */
export function dayLabel(date: string | null): string {
  if (!date) return "—";
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "2026-03" → "Mar 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

const IST_MS = 5.5 * 3_600_000;
export const istDate = (t: number) => new Date(t + IST_MS).toISOString().slice(0, 10);
export const istClock = (t: number) => new Date(t + IST_MS).toISOString().slice(11, 16);

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** How long ago, roughly: "just now", "5 min ago", "3 h ago", or the day. */
export function ago(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return dayLabel(istDate(t));
}
