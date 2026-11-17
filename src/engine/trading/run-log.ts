// A run's record on local disk: one JSON line per change (an intent, a decision, an order, a
// position, a closed trade), appended as it happens. It is what survives a crash: a live run that
// restarts on the same day reads it back and carries on with its positions and its day's totals.
// The Parquet tables on S3 are written from the same records (store.ts).

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DecisionRecord, Intent, Order, Position, RunInfo, Trade, TradingEvent } from "../../lib/engine/trading.ts";

export type RunRecord =
  | { kind: "run"; run: RunInfo }
  | { kind: "intent"; intent: Intent }
  | { kind: "decision"; decision: DecisionRecord; /** The context that was sent. */ state?: unknown }
  | { kind: "order"; order: Order }
  | { kind: "position"; position: Position }
  | { kind: "trade"; trade: Trade }
  | { kind: "halt"; halt: { reason: string; at: number } | null }
  | { kind: "event"; event: TradingEvent };

export interface RunLog {
  append(record: RunRecord): void;
  close(): Promise<void>;
}

export function openRunLog(file: string, onError: (error: Error) => void): RunLog {
  mkdirSync(path.dirname(file), { recursive: true });
  let stream: WriteStream | null = createWriteStream(file, { flags: "a" });
  stream.on("error", onError);
  return {
    append(record) {
      stream?.write(`${JSON.stringify(record)}\n`);
    },
    close() {
      return new Promise((resolve) => {
        if (!stream) return resolve();
        stream.end(() => resolve());
        stream = null;
      });
    },
  };
}

/** What a run had reached, rebuilt from its log. */
export interface RunState {
  run: RunInfo | null;
  intents: Intent[];
  decisions: DecisionRecord[];
  /** The context sent with each decision, by decision id. */
  states: Map<string, unknown>;
  orders: Order[];
  /** Positions still open: opened and not yet closed by a trade. */
  positions: Position[];
  trades: Trade[];
  halt: { reason: string; at: number } | null;
  events: TradingEvent[];
}

/** Folds a log's records: the last record for an id wins; a trade closes its position. */
export function foldRunRecords(records: Iterable<RunRecord>): RunState {
  const intents = new Map<string, Intent>();
  const decisions = new Map<string, DecisionRecord>();
  const states = new Map<string, unknown>();
  const orders = new Map<string, Order>();
  const positions = new Map<string, Position>();
  const trades = new Map<string, Trade>();
  const events: TradingEvent[] = [];
  let run: RunInfo | null = null;
  let halt: RunState["halt"] = null;
  for (const record of records) {
    switch (record.kind) {
      case "run":
        run = record.run;
        break;
      case "intent":
        intents.set(record.intent.id, record.intent);
        break;
      case "decision":
        decisions.set(record.decision.id, record.decision);
        if (record.state !== undefined) states.set(record.decision.id, record.state);
        break;
      case "order":
        orders.set(record.order.id, record.order);
        break;
      case "position":
        positions.set(record.position.id, record.position);
        break;
      case "trade":
        trades.set(record.trade.id, record.trade);
        positions.delete(record.trade.id);
        break;
      case "halt":
        halt = record.halt;
        break;
      case "event":
        events.push(record.event);
        break;
    }
  }
  return {
    run,
    intents: [...intents.values()],
    decisions: [...decisions.values()],
    states,
    orders: [...orders.values()],
    positions: [...positions.values()],
    trades: [...trades.values()],
    halt,
    events,
  };
}

/** Reads a run's log. Null when there is none. A last line cut off by a crash is skipped. */
export async function readRunLog(file: string): Promise<RunState | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const records: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as RunRecord);
    } catch {
      // A half-written last line.
    }
  }
  return foldRunRecords(records);
}
