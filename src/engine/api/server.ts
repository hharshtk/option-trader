// The control API: plain node:http on 127.0.0.1. Every request needs the ENGINE_TOKEN bearer
// token. The browser never talks to it directly; a Next route handler checks the session
// cookie, adds the token, and streams the response through.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  PROTOCOL_VERSION,
  type EngineStatus,
  type LogLevel,
  type TelemetryHello,
  type TelemetryTopic,
} from "../../lib/engine/protocol.ts";
import type { LogHub } from "../telemetry/logger.ts";
import type { Logger } from "../telemetry/logger.ts";
import type { TelemetryHub } from "../telemetry/hub.ts";
import { openSse, type SseClient } from "./sse.ts";

const TOPICS: readonly TelemetryTopic[] = ["status", "log", "metrics", "feed", "bars", "gaps"];
const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface ControlServerOptions {
  host: string;
  port: number;
  token: string;
  status: () => EngineStatus;
  telemetry: TelemetryHub;
  logs: LogHub;
  log: Logger;
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
    if (!authorized(request)) return json(response, 401, { error: "Unauthorized" });
    if (request.method !== "GET") return json(response, 405, { error: "Method not allowed" });

    try {
      switch (url.pathname) {
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
        default:
          return json(response, 404, { error: `No route ${url.pathname}` });
      }
    } catch (error) {
      log.error("request failed", { path: url.pathname, error: String(error) });
      if (!response.headersSent) json(response, 500, { error: "Internal error" });
    }
  });

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
