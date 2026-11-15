// Structured logging. Every line goes to the sinks (terminal, later a file) and to a ring
// buffer and live subscribers, which is how the web shows the engine's log tail.

import type { LogEntry, LogLevel } from "../../lib/engine/protocol.ts";
import { Ring } from "./ring.ts";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A logger for a sub-component, named `parent.child`. */
  child(component: string): Logger;
}

export type LogSink = (entry: LogEntry) => void;

export interface LogHubOptions {
  now: () => number;
  /** Lines kept for clients that connect later. */
  capacity?: number;
  minLevel?: LogLevel;
  sinks?: LogSink[];
  /** Most lines per component per second; the rest are counted and reported. */
  maxPerSecond?: number;
}

export interface LogFilter {
  minLevel?: LogLevel;
  component?: string;
  limit?: number;
}

export interface LogHub {
  logger(component: string): Logger;
  recent(filter?: LogFilter): LogEntry[];
  subscribe(listener: (entry: LogEntry) => void): () => void;
}

export const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogHub(options: LogHubOptions): LogHub {
  const { now, capacity = 2_000, minLevel = "info", sinks = [], maxPerSecond = 50 } = options;
  const ring = new Ring<LogEntry>(capacity);
  const listeners = new Set<(entry: LogEntry) => void>();
  const budgets = new Map<string, { second: number; used: number; dropped: number }>();

  function deliver(entry: LogEntry) {
    ring.push(entry);
    for (const sink of sinks) sink(entry);
    for (const listener of listeners) listener(entry);
  }

  // Errors are never dropped; a noisy component loses only its debug, info and warn lines.
  function admit(entry: LogEntry): boolean {
    const second = Math.floor(entry.at / 1000);
    let budget = budgets.get(entry.component);
    if (!budget) budgets.set(entry.component, (budget = { second, used: 0, dropped: 0 }));
    if (budget.second !== second) {
      if (budget.dropped > 0) {
        deliver({
          at: entry.at,
          level: "warn",
          component: entry.component,
          message: `dropped ${budget.dropped} log lines over the ${maxPerSecond}/s limit`,
        });
      }
      budget.second = second;
      budget.used = 0;
      budget.dropped = 0;
    }
    if (entry.level !== "error" && budget.used >= maxPerSecond) {
      budget.dropped += 1;
      return false;
    }
    budget.used += 1;
    return true;
  }

  function write(component: string, level: LogLevel, message: string, fields?: Record<string, unknown>) {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    const entry: LogEntry = { at: now(), level, component, message };
    if (fields && Object.keys(fields).length > 0) entry.fields = fields;
    if (admit(entry)) deliver(entry);
  }

  function logger(component: string): Logger {
    return {
      debug: (message, fields) => write(component, "debug", message, fields),
      info: (message, fields) => write(component, "info", message, fields),
      warn: (message, fields) => write(component, "warn", message, fields),
      error: (message, fields) => write(component, "error", message, fields),
      child: (name) => logger(`${component}.${name}`),
    };
  }

  return {
    logger,
    recent({ minLevel: level = "debug", component, limit } = {}) {
      const matching = ring
        .toArray()
        .filter(
          (entry) =>
            LEVEL_RANK[entry.level] >= LEVEL_RANK[level] &&
            (!component || entry.component === component || entry.component.startsWith(`${component}.`)),
        );
      return limit === undefined ? matching : matching.slice(-limit);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const COLOR: Record<LogLevel, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };

/** Human-readable terminal sink. Colors only when writing to a terminal. */
export function consoleSink(stream: NodeJS.WriteStream = process.stdout): LogSink {
  const color = stream.isTTY;
  return (entry) => {
    const time = new Date(entry.at).toISOString().slice(11, 23);
    const level = entry.level.toUpperCase().padEnd(5);
    const fields = entry.fields ? ` ${JSON.stringify(entry.fields)}` : "";
    const line = `${time} ${color ? COLOR[entry.level] : ""}${level}${color ? "\x1b[0m" : ""} [${entry.component}] ${entry.message}${fields}`;
    stream.write(`${line}\n`);
  };
}
