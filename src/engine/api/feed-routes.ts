// Feed routes: the same quote stream, Live Feed stream and Live Feed actions the web served
// from its own hub before the engine owned Dhan. The web forwards to these when ENGINE_URL is
// set, so browser code doesn't change.

import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FeedHub } from "../../lib/live/feed/feed-hub.ts";
import { parseInstrumentKey, type Instrument } from "../../lib/live/feed/packets.ts";

const MAX_INSTRUMENTS = 200;
const MAX_BODY_BYTES = 16 * 1024;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** Handles a feed route. Returns false when the path isn't one. */
export async function handleFeedRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  hub: FeedHub,
): Promise<boolean> {
  const method = request.method ?? "GET";
  const path = url.pathname;

  if (path === "/v1/quotes" && method === "GET") {
    const instruments = [...new Set((url.searchParams.get("i") ?? "").split(","))]
      .map(parseInstrumentKey)
      .filter((instrument): instrument is Instrument => instrument !== null)
      .slice(0, MAX_INSTRUMENTS);
    pipe(response, (signal) => hub.stream(instruments, signal));
    return true;
  }

  if (path === "/v1/feed" && method === "GET") {
    pipe(response, (signal) => hub.monitor(signal));
    return true;
  }

  if (method !== "POST") return false;

  if (path === "/v1/feed/pin") {
    const body = await readJson(request);
    const { key, connection, name, connectionName } = (body ?? {}) as Record<string, unknown>;
    if (typeof key !== "string" || !(connection === "new" || Number.isInteger(connection))) {
      json(response, 400, { ok: false, message: "Pick an instrument and a connection." });
      return true;
    }
    json(
      response,
      200,
      hub.pin({
        key,
        connection: connection as number | "new",
        name: typeof name === "string" ? name : undefined,
        connectionName: typeof connectionName === "string" ? connectionName : undefined,
      }),
    );
    return true;
  }

  if (path === "/v1/feed/unpin") {
    const { key } = ((await readJson(request)) ?? {}) as Record<string, unknown>;
    if (typeof key !== "string") json(response, 400, { ok: false, message: "Unknown instrument." });
    else json(response, 200, hub.unpin(key));
    return true;
  }

  const close = /^\/v1\/feed\/connections\/(\d+)\/close$/.exec(path);
  if (close) {
    json(response, 200, hub.closeConnection(Number(close[1])));
    return true;
  }

  return false;
}

/** Streams a hub SSE stream to the response; closing either side stops it. */
function pipe(response: ServerResponse, open: (signal: AbortSignal) => ReadableStream<Uint8Array>) {
  const controller = new AbortController();
  response.writeHead(200, SSE_HEADERS);
  response.flushHeaders();
  const readable = Readable.fromWeb(open(controller.signal) as import("node:stream/web").ReadableStream<Uint8Array>);
  readable.pipe(response);
  response.on("close", () => {
    controller.abort();
    readable.destroy();
  });
}

function json(response: ServerResponse, code: number, body: unknown) {
  response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

/** The request body as JSON; null when it is too large or not JSON. */
export async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
