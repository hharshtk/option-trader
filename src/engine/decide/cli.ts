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
  console.log(`Without the cost check (a trade only when NIFTY's typical move is ${v.costCheckFactor}× the break-even move); the page shows both.\n`);
  const cell = (r: { trades: number; perTrade: number | null; net: number } | undefined) =>
    r && r.trades > 0 ? `${count(r.trades).padStart(5)} × ${rupees(r.perTrade).padStart(6)} = ${rupees(r.net).padStart(8)}` : "    no trades           ";
  for (const hold of v.holds) {
    console.log(`Hold ${hold} min${" ".repeat(26)}fixed stop and target         volatility exits`);
    for (const rule of v.rules) {
      const row = (exits: "fixed" | "volatility") => v.rows.find((r) => r.hold === hold && r.rule === rule.id && !r.checked && r.exits === exits);
      console.log(`  ${(rule.candidate ? "* " : "") + rule.name}`.padEnd(36) + `${cell(row("fixed"))}    ${cell(row("volatility"))}`);
    }
  }
}

function gitVersion() {
  try {
    return execFileSync("git", ["describe", "--always", "--dirty"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
