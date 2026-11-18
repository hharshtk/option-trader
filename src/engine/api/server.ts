// The control API: plain node:http on 127.0.0.1. Every request needs the ENGINE_TOKEN bearer
// token. The browser never talks to it directly; a Next route handler checks the session
// cookie, adds the token, and streams the response through.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  PROTOCOL_VERSION,
  type EngineStatus,
  type JournalSession,
  type LogLevel,
  type ReplayCommandResult,
  type TelemetryHello,
  type TelemetryTopic,
} from "../../lib/engine/protocol.ts";
import type { DecisionRequest, TradingCommandResult, TradingHistory, TradingStatus } from "../../lib/engine/trading.ts";
import type { ResearchCommandResult, ResearchStatus, StudyDetail, StudyRow } from "../../lib/research/types.ts";
import type { StrategiesStatus, StrategyCommandResult, StrategyDetail } from "../../lib/strategies/types.ts";
import type { LogHub } from "../telemetry/logger.ts";
import type { Logger } from "../telemetry/logger.ts";
import type { TelemetryHub } from "../telemetry/hub.ts";
import type { FeedHub } from "../../lib/live/feed/feed-hub.ts";
import { clientAddress, createAuthThrottle, type AuthThrottle } from "./auth-throttle.ts";
import { handleFeedRoute, readJson } from "./feed-routes.ts";
import { openSse, type SseClient } from "./sse.ts";

const TOPICS: readonly TelemetryTopic[] = ["status", "log", "metrics", "feed", "trading", "research", "strategies", "bars", "gaps"];
const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface ControlServerOptions {
  host: string;
  port: number;
  token: string;
  status: () => EngineStatus;
  telemetry: TelemetryHub;
  logs: LogHub;
  log: Logger;
  throttle?: AuthThrottle;
  /** The live feed, once started. Its routes answer 503 until then. */
  feed?: () => FeedHub | null;
  /** A day read back from its journal file; null when there is no file for that day. */
  journalSession?: (date: string | null) => Promise<JournalSession | null>;
  /** Handles a `POST /v1/replay` body: switch the feed to a recorded day and back, and steer it. */
  replay?: (body: unknown) => Promise<ReplayCommandResult>;
  /** Paper trading: its state, its commands (`POST /v1/trading`) and its stored runs. */
  trading?: {
    status(): TradingStatus;
    command(body: unknown): Promise<TradingCommandResult>;
    history(run: string | null): Promise<TradingHistory>;
    decisionRequest(id: string): DecisionRequest | null;
  };
  /** Research: the job queue (`POST /v1/research`), the stored studies and one study. */
  research?: {
    status(): ResearchStatus;
    command(body: unknown): Promise<ResearchCommandResult>;
    studies(): Promise<StudyRow[]>;
    study(id: string): Promise<StudyDetail | null>;
  };
  /** The strategy store: every strategy, one strategy's history, and its commands (`POST /v1/strategies`). */
  strategies?: {
    status(): StrategiesStatus;
    detail(id: string): StrategyDetail | null;
    command(body: unknown): Promise<StrategyCommandResult>;
  };
}

export interface ControlServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  readonly clients: number;
}

export function createControlServer(options: ControlServerOptions): ControlServer {
  const { host, port, token, status, telemetry, logs, log } = options;
  const expected = sha256(token);
  const clients = new Set<SseClient>();
  const throttle = options.throttle ?? createAuthThrottle({ now: Date.now });

  function authorized(request: IncomingMessage) {
    const header = request.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    return timingSafeEqual(sha256(presented), expected);
  }

  function json(response: ServerResponse, code: number, body: unknown) {
    response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  }

  function streamTelemetry(request: IncomingMessage, response: ServerResponse, url: URL) {
    const requested = (url.searchParams.get("topics") ?? "status,log,metrics").split(",");
    const topics = new Set(TOPICS.filter((topic) => requested.includes(topic)));
    // EventSource resends the last id it saw; `since` allows the same without a header.
    const since = Number(request.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0) || 0;

    let unsubscribe = () => {};
    const client = openSse(response, () => {
      unsubscribe();
      clients.delete(client);
    });
    clients.add(client);

    const hello: TelemetryHello = { protocol: PROTOCOL_VERSION, run: telemetry.run, seq: telemetry.seq };
    client.send("hello", hello);
    // A seq above the current one means the engine restarted: start from scratch.
    const after = since > telemetry.seq ? 0 : since;
    for (const message of telemetry.backlog(topics, after)) client.send(message.topic, message, message.seq);
    unsubscribe = telemetry.subscribe(topics, (message) => client.send(message.topic, message, message.seq));
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://engine");
    const client = clientAddress(request);
    const wait = throttle.blockedFor(client);
    if (wait > 0) {
      response.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
      return json(response, 429, { error: "Too many failed attempts" });
    }
    if (!authorized(request)) {
      if (throttle.fail(client)) log.warn("blocking a client after repeated bad tokens", { client });
      else log.info("rejected a request with a bad token", { client, path: url.pathname });
      return json(response, 401, { error: "Unauthorized" });
    }
    throttle.succeed(client);
    if (request.method !== "GET" && request.method !== "POST") return json(response, 405, { error: "Method not allowed" });
    void route(request, response, url);
  });

  async function route(request: IncomingMessage, response: ServerResponse, url: URL) {
    try {
      if (options.feed && (url.pathname === "/v1/quotes" || url.pathname.startsWith("/v1/feed"))) {
        const hub = options.feed();
        if (!hub) return json(response, 503, { ok: false, message: "The engine's feed is starting. Try again in a moment." });
        if (await handleFeedRoute(request, response, url, hub)) return;
      }
      if (url.pathname === "/v1/replay" && request.method === "POST" && options.replay) {
        return json(response, 200, await options.replay(await readJson(request)));
      }
      if (url.pathname === "/v1/trading" && request.method === "POST" && options.trading) {
        return json(response, 200, await options.trading.command(await readJson(request)));
      }
      if (url.pathname === "/v1/research" && request.method === "POST" && options.research) {
        return json(response, 200, await options.research.command(await readJson(request)));
      }
      if (url.pathname === "/v1/strategies" && request.method === "POST" && options.strategies) {
        return json(response, 200, await options.strategies.command(await readJson(request)));
      }
      if (request.method !== "GET") return json(response, 404, { error: `No route ${request.method} ${url.pathname}` });
      switch (url.pathname) {
        case "/v1/trading":
          if (!options.trading) return json(response, 404, { error: "No trading" });
          return json(response, 200, options.trading.status());
        case "/v1/trading/decision": {
          if (!options.trading) return json(response, 404, { error: "No trading" });
          const sent = options.trading.decisionRequest(url.searchParams.get("id") ?? "");
          return sent ? json(response, 200, sent) : json(response, 404, { error: "No such decision in the current run" });
        }
        case "/v1/trading/history": {
          if (!options.trading) return json(response, 404, { error: "No trading" });
          try {
            return json(response, 200, await options.trading.history(url.searchParams.get("run")));
          } catch (error) {
            // The tables are read from the file store, which can be unreachable.
            const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
            log.warn("could not read trading history", { error: message });
            return json(response, 502, { error: `Could not read the stored runs: ${message}` });
          }
        }
        case "/v1/research":
          if (!options.research) return json(response, 404, { error: "No research" });
          return json(response, 200, options.research.status());
        case "/v1/strategies":
          if (!options.strategies) return json(response, 404, { error: "No strategy store" });
          return json(response, 200, options.strategies.status());
        case "/v1/strategies/one": {
          if (!options.strategies) return json(response, 404, { error: "No strategy store" });
          const detail = options.strategies.detail(url.searchParams.get("id") ?? "");
          return detail ? json(response, 200, detail) : json(response, 404, { error: "No such strategy" });
        }
        case "/v1/research/studies":
        case "/v1/research/study": {
          if (!options.research) return json(response, 404, { error: "No research" });
          try {
            if (url.pathname === "/v1/research/studies") return json(response, 200, { studies: await options.research.studies() });
            const id = url.searchParams.get("id") ?? "";
            if (!/^[a-z0-9-]{8,80}$/.test(id)) return json(response, 400, { error: "id must be a study id" });
            const study = await options.research.study(id);
            return study ? json(response, 200, study) : json(response, 404, { error: `No study ${id}` });
          } catch (error) {
            // Studies are read from the file store, which can be unreachable.
            const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
            log.warn("could not read studies", { error: message });
            return json(response, 502, { error: `Could not read the stored studies: ${message}` });
          }
        }
        case "/v1/status":
          return json(response, 200, status());
        case "/v1/logs": {
          const level = url.searchParams.get("level") as LogLevel | null;
          const limit = Number(url.searchParams.get("limit")) || 500;
          return json(response, 200, {
            entries: logs.recent({
              minLevel: level && LEVELS.includes(level) ? level : "debug",
              component: url.searchParams.get("component") ?? undefined,
              limit: Math.min(limit, 2_000),
            }),
          });
        }
        case "/v1/telemetry":
          return streamTelemetry(request, response, url);
        case "/v1/journal/session": {
          if (!options.journalSession) return json(response, 404, { error: "No journal" });
          const date = url.searchParams.get("date");
          if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(response, 400, { error: "date must be YYYY-MM-DD" });
          const session = await options.journalSession(date);
          return session ? json(response, 200, session) : json(response, 404, { error: `No journal for ${date ?? "today"}` });
        }
        default:
          return json(response, 404, { error: `No route ${url.pathname}` });
      }
    } catch (error) {
      log.error("request failed", { path: url.pathname, error: String(error) });
      if (!response.headersSent) json(response, 500, { error: "Internal error" });
    }
  }

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    close() {
      for (const client of clients) client.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    get clients() {
      return clients.size;
    },
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest();
}
