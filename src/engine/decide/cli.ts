// The decision lab from the command line: builds the per-minute tables of recorded days that
// don't have them yet, plays every rule over every day and prints the scorecard.
//
//   npm run decide                       build what's missing, score, print
//   npm run decide -- --date 2026-11-18  build that day (again) only, then score
//   npm run decide -- --rebuild          build every recorded day again
//   npm run decide -- --score            score only
//
// Reads the journal in ENGINE_DATA_DIR (default data/engine); writes to the app's file store.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getParquetStore } from "../../lib/db/parquet-store.ts";
import type { PredictionView } from "../../lib/decide/predict.ts";
import type { DecideView } from "../../lib/decide/score.ts";
import { createSessionCalendar } from "../market/session-calendar.ts";
import { createDecisionLab } from "./lab.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const date = value("date");
if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("--date must be YYYY-MM-DD");
  process.exit(1);
}

const store = getParquetStore();
const lab = createDecisionLab({
  store,
  directory: path.join(path.resolve(ROOT, process.env.ENGINE_DATA_DIR ?? "data/engine"), "journal"),
  calendar: createSessionCalendar(),
  version: gitVersion(),
  now: Date.now,
});
const log = (message: string) => console.log(message);

console.log(`Tables in ${store.location}decide/`);
if (!flag("score")) {
  const built = await lab.build({ dates: date ? [date] : undefined, rebuild: flag("rebuild") || date !== undefined, log });
  if (built.length === 0) console.log("Every recorded day is built already.");
}
const view = await lab.score(log);
print(view);
printPredictions(await lab.predictions({ state: "idle", at: null, message: null }));

function print(v: DecideView) {
  const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const rupees = (n: number | null) => (n === null ? "—" : `${n < 0 ? "−" : ""}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`);
  const days = v.days.map((d) => {
    if (d.pricedMinutes === 0) return `${d.date} (no option quotes)`;
    const moves = d.pricedMove !== null && d.deliveredMove !== null ? `: options priced ${d.pricedMove.toFixed(1)} pts a ${v.moveMinutes} min, NIFTY moved ${d.deliveredMove.toFixed(1)}` : "";
    return `${d.date}${moves}`;
  });
  console.log(`\nDays: ${days.join("; ")}`);
  console.log(`One lot a trade, nearest expiry at the money, after Dhan's charges, spread and ₹${v.assumptions.slippage} slippage each way. Default stop ${v.assumptions.stopPct}%, target ${v.assumptions.targetPct}%; candidates (*) use their own.`);
  console.log(`Volatility exits: each trade's stop ${v.assumptions.stopMoves}× and target ${v.assumptions.targetMoves}× NIFTY's typical move over the hold, in option rupees (candidates keep their own ratio).`);
  console.log(`Trailing: the stop starts ${v.assumptions.stopPct}% below the buy (candidates: their own) and follows the best price up; no target.`);
  console.log(`"vs side": rupees a trade above or below random trades on the same side (calls against calls, puts against puts) on the same days.`);
  console.log(`Candidates count only the days that test them (tested from …). Without the cost check (a trade only when NIFTY's typical move is ${v.costCheckFactor}× the break-even move); the page shows both.\n`);
  const modes = v.exitModes ?? ["fixed", "volatility"];
  const label: Record<string, string> = { fixed: "fixed stop and target", volatility: "volatility exits", trailing: "trailing stop" };
  const cell = (r: (typeof v.rows)[number] | undefined) =>
    r && r.trades > 0 ? `${count(r.trades).padStart(4)} ${rupees(r.net).padStart(8)} vs side ${r.vsSameSide === null ? "    —" : rupees(r.vsSameSide).padStart(5)}` : "   no trades                ";
  const name = (rule: (typeof v.rules)[number]) => `  ${(rule.candidate ? "* " : "") + rule.name}${rule.since ? ` (from ${rule.since.slice(5)})` : ""}`.padEnd(52);
  for (const hold of v.holds) {
    console.log(`Hold ${hold} min`.padEnd(52) + modes.map((m) => label[m].padEnd(32)).join(""));
    for (const rule of v.rules) {
      const row = (exits: string) => v.rows.find((r) => r.hold === hold && r.rule === rule.id && !r.checked && r.exits === exits);
      console.log(name(rule) + modes.map((m) => cell(row(m)).padEnd(32)).join(""));
    }
  }
  // Day by day at the longest hold: each rule's net and the same-side random bar, per day.
  const hold = v.holds.at(-1)!;
  for (const mode of modes) {
    const rows = v.rows.filter((r) => r.hold === hold && !r.checked && r.exits === mode);
    const dates = rows[0]?.byDay.map((d) => d.date) ?? [];
    console.log(`\nDay by day, hold ${hold} min, ${label[mode]}: net (bar); * a day the candidate was written with`.padEnd(52));
    console.log("".padEnd(52) + dates.map((d) => d.slice(5).padEnd(22)).join(""));
    for (const r of rows) {
      const rule = v.rules.find((x) => x.id === r.rule)!;
      const cells = r.byDay.map((d) => (d.trades === 0 ? "—" : `${rupees(d.net)}${d.bar === null || r.rule === "random" ? "" : ` (${rupees(d.bar)})`}${d.tested ? "" : "*"}`).padEnd(22));
      console.log(name(rule) + cells.join(""));
    }
  }
}

/** The prediction scoreboard: every predictor on every minute, graded HORIZON minutes later. */
function printPredictions(p: PredictionView) {
  const rupees = (n: number | null) => (n === null ? "—" : `${n < 0 ? "−" : ""}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`);
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
  const days = p.days.map((d) => `${d.date} (NIFTY ${d.niftyMove === null ? "?" : `${d.niftyMove > 0 ? "+" : ""}${Math.round(d.niftyMove)}`}, ${d.minutes} min)`);
  console.log(`\nPrediction scoreboard: every minute graded ${p.horizon} minutes later. Days: ${days.join("; ")}`);
  console.log(`A lot of the at-the-money option bought at each call and sold ${p.horizon} minutes later, after charges, against a coin flip at the same minutes. Rules count from their tested date.`);
  console.log("".padEnd(44) + "calls  right  priced   paid   a call    coin   vs coin  days ahead");
  for (const r of p.rows) {
    const name = `  ${r.name}${r.since ? ` (from ${r.since.slice(5)})` : ""}`.padEnd(44);
    console.log(
      name +
        `${String(r.calls).padStart(5)}  ${(r.id === "coin" ? "half" : pct(r.right, r.calls)).padStart(5)}  ${String(r.priced).padStart(6)}  ${pct(r.paid, r.priced).padStart(5)}  ${rupees(r.perCall).padStart(7)}  ${rupees(r.coin).padStart(6)}  ${(r.vsCoin === null ? "" : rupees(r.vsCoin)).padStart(7)}  ${r.id === "coin" || !r.daysCalled ? "" : `${r.daysAhead} of ${r.daysCalled}`}`,
    );
  }
}

function gitVersion() {
  try {
    return execFileSync("git", ["describe", "--always", "--dirty"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
