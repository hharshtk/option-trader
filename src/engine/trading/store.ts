// Trading's database: Parquet files in the app's file store (S3 when configured), written and
// queried with DuckDB. One file per run per table, so a save rewrites only that run's files:
//
//   trading/<namespace>/runs/<run>.parquet       one row: the run and its totals
//   trading/<namespace>/trades/<run>.parquet     closed round trips, with every charge
//   trading/<namespace>/orders/<run>.parquet     orders and their fills
//   trading/<namespace>/intents/<run>.parquet    what the strategy proposed and what became of it
//   trading/<namespace>/decisions/<run>.parquet  every decision API answer
//
// A table across runs is a glob: `trading/<namespace>/trades/*.parquet`. The namespace keeps two
// engines that share a bucket (production and development) from overwriting each other.

import type { Columns, ParquetStore, Row } from "../../lib/db/parquet-store.ts";
import type {
  BookTotals,
  DecisionRecord,
  Intent,
  Order,
  RunInfo,
  RunRow,
  Trade,
  TradeRow,
  TradingConfig,
  TradingHistory,
} from "../../lib/engine/trading.ts";
import { paise } from "../../lib/trading/charges.ts";

const RUNS: Columns = {
  run_id: "VARCHAR",
  namespace: "VARCHAR",
  source: "VARCHAR",
  mode: "VARCHAR",
  date: "VARCHAR",
  started_at: "DOUBLE",
  ended_at: "DOUBLE",
  status: "VARCHAR",
  signal: "VARCHAR",
  decision_mode: "VARCHAR",
  trades: "INTEGER",
  wins: "INTEGER",
  gross: "DOUBLE",
  charges: "DOUBLE",
  net: "DOUBLE",
  max_drawdown: "DOUBLE",
  shadow_trades: "INTEGER",
  shadow_net: "DOUBLE",
  decisions: "INTEGER",
  vetoes: "INTEGER",
  engine_version: "VARCHAR",
  config: "VARCHAR",
};

const TRADES: Columns = {
  run_id: "VARCHAR",
  date: "VARCHAR",
  source: "VARCHAR",
  id: "VARCHAR",
  book: "VARCHAR",
  signal: "VARCHAR",
  direction: "INTEGER",
  contract: "VARCHAR",
  security_id: "VARCHAR",
  strike: "DOUBLE",
  option_type: "VARCHAR",
  expiry: "VARCHAR",
  lots: "INTEGER",
  quantity: "INTEGER",
  opened_at: "DOUBLE",
  closed_at: "DOUBLE",
  entry_price: "DOUBLE",
  exit_price: "DOUBLE",
  entry_source: "VARCHAR",
  exit_source: "VARCHAR",
  exit_reason: "VARCHAR",
  spot_entry: "DOUBLE",
  spot_exit: "DOUBLE",
  gross: "DOUBLE",
  brokerage: "DOUBLE",
  exchange: "DOUBLE",
  ipft: "DOUBLE",
  sebi: "DOUBLE",
  stt: "DOUBLE",
  stamp: "DOUBLE",
  gst: "DOUBLE",
  charges: "DOUBLE",
  net: "DOUBLE",
  decision_probability: "DOUBLE",
  decision_approved: "BOOLEAN",
  decision_regime: "VARCHAR",
};

const ORDERS: Columns = {
  run_id: "VARCHAR",
  date: "VARCHAR",
  id: "VARCHAR",
  book: "VARCHAR",
  position_id: "VARCHAR",
  side: "VARCHAR",
  reason: "VARCHAR",
  contract: "VARCHAR",
  security_id: "VARCHAR",
  quantity: "INTEGER",
  status: "VARCHAR",
  created_at: "DOUBLE",
  filled_at: "DOUBLE",
  price: "DOUBLE",
  price_source: "VARCHAR",
  ltp: "DOUBLE",
  bid: "DOUBLE",
  ask: "DOUBLE",
  value: "DOUBLE",
  charges: "DOUBLE",
  note: "VARCHAR",
};

const INTENTS: Columns = {
  run_id: "VARCHAR",
  date: "VARCHAR",
  id: "VARCHAR",
  at: "DOUBLE",
  minute: "DOUBLE",
  direction: "INTEGER",
  signal: "VARCHAR",
  reading: "VARCHAR",
  spot: "DOUBLE",
  contract: "VARCHAR",
  security_id: "VARCHAR",
  outcome: "VARCHAR",
  reason: "VARCHAR",
  decision_id: "VARCHAR",
  position_id: "VARCHAR",
};

const DECISIONS: Columns = {
  run_id: "VARCHAR",
  date: "VARCHAR",
  id: "VARCHAR",
  intent_id: "VARCHAR",
  at: "DOUBLE",
  wall: "DOUBLE",
  model: "VARCHAR",
  mode: "VARCHAR",
  probability: "DOUBLE",
  regime: "VARCHAR",
  quality: "DOUBLE",
  approved: "BOOLEAN",
  reason: "VARCHAR",
  latency_ms: "DOUBLE",
  cached: "BOOLEAN",
  error: "VARCHAR",
  input_tokens: "INTEGER",
  cost: "DOUBLE",
  state: "VARCHAR",
};

export interface RunData {
  run: RunInfo;
  status: "running" | "ended";
  config: TradingConfig;
  engineVersion: string;
  totals: Record<"paper" | "shadow", BookTotals>;
  trades: readonly Trade[];
  orders: readonly Order[];
  intents: readonly Intent[];
  decisions: readonly DecisionRecord[];
  /** The context sent with each decision, by decision id. */
  states: ReadonlyMap<string, unknown>;
}

export function tradeRow(run: RunInfo, trade: Trade, decision: DecisionRecord | undefined): TradeRow {
  return {
    run_id: run.id,
    date: run.date,
    source: run.source,
    id: trade.id,
    book: trade.book,
    signal: trade.signal,
    direction: trade.direction,
    contract: trade.contract.name,
    security_id: trade.contract.securityId,
    strike: trade.contract.strike,
    option_type: trade.contract.type,
    expiry: trade.contract.expiry,
    lots: trade.lots,
    quantity: trade.quantity,
    opened_at: trade.openedAt,
    closed_at: trade.closedAt,
    entry_price: trade.entryPrice,
    exit_price: trade.exitPrice,
    entry_source: trade.entrySource,
    exit_source: trade.exitSource,
    exit_reason: trade.exitReason,
    spot_entry: trade.spotAtEntry,
    spot_exit: trade.spotAtExit,
    gross: paise(trade.gross),
    brokerage: paise(trade.charges.brokerage),
    exchange: paise(trade.charges.exchange),
    ipft: paise(trade.charges.ipft),
    sebi: paise(trade.charges.sebi),
    stt: paise(trade.charges.stt),
    stamp: paise(trade.charges.stamp),
    gst: paise(trade.charges.gst),
    charges: paise(trade.charges.total),
    net: paise(trade.net),
    decision_probability: decision?.probability ?? null,
    decision_approved: decision ? decision.approved : null,
    decision_regime: decision?.regime ?? null,
  };
}

export interface TradingStore {
  location: string;
  /** Rewrites the run's files with what it holds now. */
  save(data: RunData): Promise<void>;
  /** Stored runs, newest first, and one run's trades when asked. */
  history(run: string | null): Promise<TradingHistory>;
}

const RUN_ID = /^[\w-]{1,80}$/;

export function createTradingStore(store: ParquetStore, namespace: string): TradingStore {
  const base = `trading/${namespace}`;

  return {
    location: `${store.location}${store.remote ? "" : "/"}${base}/`,

    async save({ run, status, config, engineVersion, totals, trades, orders, intents, decisions, states }) {
      const byId = new Map(decisions.map((d) => [d.id, d]));
      const runRow: Row = {
        run_id: run.id,
        namespace: run.namespace,
        source: run.source,
        mode: run.mode,
        date: run.date,
        started_at: run.startedAt,
        ended_at: run.endedAt,
        status,
        signal: config.strategy.signal,
        decision_mode: config.decision.mode,
        trades: totals.paper.trades,
        wins: totals.paper.wins,
        gross: paise(totals.paper.gross),
        charges: paise(totals.paper.charges),
        net: paise(totals.paper.net),
        max_drawdown: paise(totals.paper.maxDrawdown),
        shadow_trades: totals.shadow.trades,
        shadow_net: paise(totals.shadow.net),
        decisions: decisions.length,
        vetoes: decisions.filter((d) => !d.approved && !d.error).length,
        engine_version: engineVersion,
        config: JSON.stringify(config),
      };
      const meta = { run_id: run.id, date: run.date };
      await Promise.all([
        store.write(`${base}/runs/${run.id}.parquet`, RUNS, [runRow]),
        store.write(`${base}/trades/${run.id}.parquet`, TRADES, trades.map((t) => tradeRow(run, t, t.decisionId ? byId.get(t.decisionId) : undefined) as unknown as Row)),
        store.write(
          `${base}/orders/${run.id}.parquet`,
          ORDERS,
          orders.map((o) => ({
            ...meta,
            id: o.id,
            book: o.book,
            position_id: o.positionId,
            side: o.side,
            reason: o.reason,
            contract: o.contract.name,
            security_id: o.contract.securityId,
            quantity: o.quantity,
            status: o.status,
            created_at: o.at,
            filled_at: o.filledAt,
            price: o.price,
            price_source: o.priceSource,
            ltp: o.ltp,
            bid: o.bid,
            ask: o.ask,
            value: o.value === null ? null : paise(o.value),
            charges: o.charges ? paise(o.charges.total) : null,
            note: o.note,
          })),
        ),
        store.write(
          `${base}/intents/${run.id}.parquet`,
          INTENTS,
          intents.map((i) => ({
            ...meta,
            id: i.id,
            at: i.at,
            minute: i.minute,
            direction: i.direction,
            signal: i.signal,
            reading: i.reading,
            spot: i.spot,
            contract: i.contract?.name ?? null,
            security_id: i.contract?.securityId ?? null,
            outcome: i.outcome,
            reason: i.reason,
            decision_id: i.decisionId,
            position_id: i.positionId,
          })),
        ),
        store.write(
          `${base}/decisions/${run.id}.parquet`,
          DECISIONS,
          decisions.map((d) => ({
            ...meta,
            id: d.id,
            intent_id: d.intentId,
            at: d.at,
            wall: d.wall,
            model: d.model,
            mode: d.mode,
            probability: d.probability,
            regime: d.regime,
            quality: d.quality,
            approved: d.approved,
            reason: d.reason,
            latency_ms: d.latencyMs,
            cached: d.cached,
            error: d.error,
            input_tokens: d.inputTokens,
            cost: d.cost,
            state: states.has(d.id) ? JSON.stringify(states.get(d.id)) : null,
          })),
        ),
      ]);
    },

    async history(run) {
      const columns = Object.keys(RUNS)
        .filter((name) => name !== "config")
        .join(", ");
      const runs = await store.query<RunRow>((table) => `SELECT ${columns} FROM ${table(`${base}/runs/*.parquet`)} ORDER BY started_at DESC LIMIT 200`);
      const wanted = run && RUN_ID.test(run) ? run : null;
      const trades = wanted
        ? await store.query<TradeRow>((table) => `SELECT * FROM ${table(`${base}/trades/${wanted}.parquet`)} ORDER BY closed_at DESC LIMIT 1000`)
        : [];
      return { location: `${store.location}${store.remote ? "" : "/"}${base}/`, runs, run: wanted, trades };
    },
  };
}
