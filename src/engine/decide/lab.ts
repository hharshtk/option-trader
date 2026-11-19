// The decision lab: every recorded day as a per-minute table, and every rule scored over all of
// them after costs. Tables are Parquet files in the app's file store (S3 when configured):
//
//   decide/minutes/<date>.parquet   one row a minute: everything a decision sees (lib/decide/state.ts)
//   decide/quotes/<date>.parquet    one row per option per minute: the nearest expiry's bid, ask and last
//   decide/days/<date>.parquet      one row: what the day holds and when it was built
//   decide/trades/<date>.parquet    every rule's trades that day at every hold, after costs
//
// Building a day reads its journal (minutes and quotes, once). Scoring reads the tables back and
// plays every rule over every day, so a new or changed rule is scored on all days at once.

import { readdirSync } from "node:fs";
import type { Columns, ParquetStore, Row } from "../../lib/db/parquet-store.ts";
import { COST_CHECK_FACTOR } from "../../lib/decide/cost.ts";
import { PLAYED, SCORED } from "../../lib/decide/rules.ts";
import { ASSUMPTIONS, exitsText, FIELD_LIST, movement, scorecard, type DecideView, type LabDay } from "../../lib/decide/score.ts";
import { DEFAULT_EXITS, EXIT_MODES, HOLDS, simulateDay, type DayData, type MinuteQuote, type SimTrade } from "../../lib/decide/simulate.ts";
import { FIELD_NAMES, MOVE_MINUTES, type MinuteState } from "../../lib/decide/state.ts";
import type { SessionCalendar } from "../market/session-calendar.ts";
import { loadMoveProfile } from "../trading/move-history.ts";
import { buildDayTable } from "./day-table.ts";

const MINUTES: Columns = { date: "VARCHAR", t: "INTEGER", at: "DOUBLE", ...Object.fromEntries(FIELD_NAMES.map((name) => [name, "DOUBLE" as const])) };
const QUOTES: Columns = { date: "VARCHAR", t: "INTEGER", key: "VARCHAR", strike: "DOUBLE", type: "VARCHAR", bid: "DOUBLE", ask: "DOUBLE", ltp: "DOUBLE", low: "DOUBLE", high: "DOUBLE", lot_size: "INTEGER" };
const DAYS: Columns = {
  date: "VARCHAR",
  minutes: "INTEGER",
  priced_minutes: "INTEGER",
  expiry: "VARCHAR",
  depth: "BOOLEAN",
  chain: "BOOLEAN",
  built_at: "DOUBLE",
  version: "VARCHAR",
  priced_move: "DOUBLE",
  delivered_move: "DOUBLE",
};
const TRADES: Columns = {
  date: "VARCHAR",
  rule: "VARCHAR",
  hold: "INTEGER",
  checked: "BOOLEAN",
  exits: "VARCHAR",
  stop_pct: "DOUBLE",
  target_pct: "DOUBLE",
  direction: "INTEGER",
  key: "VARCHAR",
  strike: "DOUBLE",
  type: "VARCHAR",
  quantity: "INTEGER",
  entry_minute: "INTEGER",
  exit_minute: "INTEGER",
  buy: "DOUBLE",
  sell: "DOUBLE",
  exit: "VARCHAR",
  gross: "DOUBLE",
  charges: "DOUBLE",
  net: "DOUBLE",
  nifty_move: "DOUBLE",
};

export interface DecisionLab {
  /** Journal dates in the directory that had a session, oldest first. */
  recordedDates(): string[];
  /** Dates already built into tables. */
  builtDates(): Promise<string[]>;
  /** Builds the tables of `dates` (default: every recorded date not built yet; `rebuild` builds them all again). */
  build(options?: { dates?: string[]; rebuild?: boolean; log?: (message: string) => void }): Promise<string[]>;
  /** Plays every rule over every built day at every hold, saves the trades and returns the view. */
  score(log?: (message: string) => void): Promise<DecideView>;
  /** The scorecard from the saved trades, without playing the rules again. */
  view(build: DecideView["build"]): Promise<DecideView>;
}

export function createDecisionLab({
  store,
  directory,
  calendar,
  version,
  now,
}: {
  store: ParquetStore;
  /** The journal directory. */
  directory: string;
  calendar: SessionCalendar;
  version: string;
  now: () => number;
}): DecisionLab {
  async function writeDay(day: LabDay & { version: string }) {
    await store.write(`decide/days/${day.date}.parquet`, DAYS, [
      {
        date: day.date,
        minutes: day.minutes,
        priced_minutes: day.pricedMinutes,
        expiry: day.expiry,
        depth: day.depth,
        chain: day.chain,
        built_at: day.builtAt,
        version: day.version,
        priced_move: day.pricedMove,
        delivered_move: day.deliveredMove,
      },
    ]);
  }

  async function days(): Promise<(LabDay & { version: string })[]> {
    const rows = await store.query<{
      date: string;
      minutes: number;
      priced_minutes: number;
      expiry: string | null;
      depth: boolean;
      chain: boolean;
      built_at: number;
      version: string;
      priced_move?: number | null;
      delivered_move?: number | null;
    }>((table) => `SELECT * FROM ${table("decide/days/*.parquet")} ORDER BY date`);
    return rows.map((r) => ({
      date: r.date,
      minutes: r.minutes,
      pricedMinutes: r.priced_minutes,
      expiry: r.expiry,
      depth: r.depth,
      chain: r.chain,
      builtAt: r.built_at,
      version: r.version,
      pricedMove: r.priced_move ?? null,
      deliveredMove: r.delivered_move ?? null,
    }));
  }

  async function readDay(date: string): Promise<DayData> {
    const minutes = await store.query<Record<string, number | null> & { t: number; at: number }>((table) => `SELECT * EXCLUDE (date) FROM ${table(`decide/minutes/${date}.parquet`)} ORDER BY t`);
    const quotes = await store.query<{ t: number; key: string; strike: number; type: "CE" | "PE"; bid: number | null; ask: number | null; ltp: number | null; low?: number | null; high?: number | null; lot_size: number }>(
      (table) => `SELECT * EXCLUDE (date) FROM ${table(`decide/quotes/${date}.parquet`)} ORDER BY t`,
    );
    const day: DayData = { date, states: [], quotes: [] };
    for (const m of minutes) day.states[m.t] = m as unknown as MinuteState;
    for (const q of quotes) (day.quotes[q.t] ??= []).push({ key: q.key, strike: q.strike, type: q.type, bid: q.bid, ask: q.ask, ltp: q.ltp, low: q.low, high: q.high, lotSize: q.lot_size });
    return day;
  }

  async function view(build: DecideView["build"]): Promise<DecideView> {
    const labDays = await days();
    const trades = await store.query<Record<string, unknown>>((table) => `SELECT * FROM ${table("decide/trades/*.parquet")}`);
    return makeView(labDays, trades.map(toTrade), build);
  }

  return {
    recordedDates() {
      return readdirSync(directory)
        .map((name) => /^(\d{4}-\d{2}-\d{2})\.bin$/.exec(name)?.[1])
        .filter((date): date is string => !!date && calendar.session("NSE_EQ", date) !== null)
        .sort();
    },
    async builtDates() {
      return (await days()).map((d) => d.date);
    },
    async build({ dates, rebuild = false, log = () => {} } = {}) {
      const built = new Set(rebuild ? [] : await this.builtDates());
      const wanted = (dates ?? this.recordedDates()).filter((d) => !built.has(d));
      const done: string[] = [];
      for (const date of wanted) {
        const started = performance.now();
        const table = await buildDayTable(directory, date, calendar);
        if (!table) {
          log(`${date}: no session, skipped`);
          continue;
        }
        const minutes: Row[] = table.states.map((s) => ({ date, ...s }));
        const quotes: Row[] = table.quotes.flatMap(({ t, quotes: list }) =>
          list.map((q: MinuteQuote) => ({ date, t, key: q.key, strike: q.strike, type: q.type, bid: q.bid, ask: q.ask, ltp: q.ltp, low: q.low ?? null, high: q.high ?? null, lot_size: q.lotSize })),
        );
        await store.write(`decide/minutes/${date}.parquet`, MINUTES, minutes);
        await store.write(`decide/quotes/${date}.parquet`, QUOTES, quotes);
        await writeDay({
          date,
          minutes: table.states.length,
          pricedMinutes: table.quotes.length,
          expiry: table.expiry,
          depth: table.sides.depth,
          chain: table.sides.chain,
          builtAt: now(),
          version,
          pricedMove: null,
          deliveredMove: null,
        });
        log(`${date}: ${table.states.length} minutes, ${table.quotes.length} with option quotes${table.sides.depth ? ", depth" : ""}${table.sides.chain ? ", chain" : ""} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
        done.push(date);
      }
      return done;
    },
    async score(log = () => {}) {
      const labDays = await days();
      const all: SimTrade[] = [];
      for (const labDay of labDays) {
        const { date } = labDay;
        const day = await readDay(date);
        // Volatility exits measure the typical move from the days before, as the trader does.
        day.profile = await loadMoveProfile(store, date).catch(() => null);
        const trades: SimTrade[] = [];
        for (const hold of HOLDS) {
          for (const costCheck of [false, true]) {
            for (const from of EXIT_MODES) {
              for (const rule of PLAYED) trades.push(...simulateDay(rule, day, { ...DEFAULT_EXITS, holdMinutes: hold, from }, { costCheck }).trades);
            }
          }
        }
        // What options priced against what NIFTY delivered that day.
        const moves = movement(day.states);
        Object.assign(labDay, { pricedMove: moves?.priced ?? null, deliveredMove: moves?.delivered ?? null });
        await writeDay(labDay);
        await store.write(`decide/trades/${date}.parquet`, TRADES, trades.map(fromTrade));
        const paid = moves ? `; options priced ${moves.priced.toFixed(1)} points a ${MOVE_MINUTES} min, NIFTY moved ${moves.delivered.toFixed(1)}` : "";
        log(`${date}: ${trades.length} trades across ${SCORED.length} rules, ${HOLDS.length} holds, cost check off and on, fixed and volatility exits${paid}`);
        all.push(...trades);
      }
      return makeView(labDays, all, { state: "idle", at: now(), message: null });
    },
    view,
  };
}

function makeView(labDays: (LabDay & { version?: string })[], trades: SimTrade[], build: DecideView["build"]): DecideView {
  const priced = labDays.filter((d) => d.pricedMinutes > 0).map((d) => d.date);
  return {
    days: labDays.map((d) => ({
      date: d.date,
      minutes: d.minutes,
      pricedMinutes: d.pricedMinutes,
      expiry: d.expiry,
      depth: d.depth,
      chain: d.chain,
      builtAt: d.builtAt,
      pricedMove: d.pricedMove,
      deliveredMove: d.deliveredMove,
    })),
    holds: HOLDS,
    rows: scorecard(trades, priced),
    rules: SCORED.map((r) => ({ id: r.id, name: r.name, idea: r.idea, candidate: r.candidate === true, exits: exitsText(r) })),
    costCheckFactor: COST_CHECK_FACTOR,
    moveMinutes: MOVE_MINUTES,
    assumptions: ASSUMPTIONS,
    fields: FIELD_LIST,
    build,
  };
}

function fromTrade(t: SimTrade): Row {
  return {
    date: t.date,
    rule: t.rule,
    hold: t.hold,
    checked: t.checked,
    exits: t.exits,
    stop_pct: t.stopPct,
    target_pct: t.targetPct,
    direction: t.direction,
    key: t.key,
    strike: t.strike,
    type: t.type,
    quantity: t.quantity,
    entry_minute: t.entryMinute,
    exit_minute: t.exitMinute,
    buy: t.buy,
    sell: t.sell,
    exit: t.exit,
    gross: t.gross,
    charges: t.charges,
    net: t.net,
    nifty_move: t.niftyMove,
  };
}

function toTrade(r: Record<string, unknown>): SimTrade {
  return {
    date: String(r.date),
    rule: String(r.rule),
    hold: Number(r.hold),
    checked: r.checked === true,
    exits: r.exits === "volatility" ? "volatility" : "fixed",
    stopPct: Number(r.stop_pct ?? 0),
    targetPct: Number(r.target_pct ?? 0),
    direction: Number(r.direction) > 0 ? 1 : -1,
    key: String(r.key),
    strike: Number(r.strike),
    type: r.type === "PE" ? "PE" : "CE",
    quantity: Number(r.quantity),
    entryMinute: Number(r.entry_minute),
    exitMinute: Number(r.exit_minute),
    buy: Number(r.buy),
    sell: Number(r.sell),
    exit: String(r.exit) as SimTrade["exit"],
    gross: Number(r.gross),
    charges: Number(r.charges),
    net: Number(r.net),
    niftyMove: r.nifty_move === null || r.nifty_move === undefined ? null : Number(r.nifty_move),
  };
}
