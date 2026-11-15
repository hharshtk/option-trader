// One server-sent-events client. The engine never waits for the web: when the socket can't
// keep up, messages queue up to a limit, then the oldest are dropped and the client is told
// how many it lost with a `gap` event.

import type { ServerResponse } from "node:http";

const HEARTBEAT_MS = 15_000;

export interface SseClient {
  send(event: string, data: unknown, id?: number): void;
  close(): void;
  readonly closed: boolean;
}

export function openSse(response: ServerResponse, onClose: () => void, maxQueued = 1_000): SseClient {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();

  let closed = false;
  let waiting = false;
  let dropped = 0;
  const queue: string[] = [];

  function write(chunk: string) {
    if (!response.write(chunk)) waiting = true;
  }

  function flush() {
    waiting = false;
    if (dropped > 0) {
      write(frame("gap", { dropped }));
      dropped = 0;
    }
    while (queue.length > 0 && !waiting) write(queue.shift()!);
  }

  response.on("drain", flush);
  const heartbeat = setInterval(() => {
    if (!waiting) write(": ping\n\n");
  }, HEARTBEAT_MS);

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    response.end();
    onClose();
  }
  response.on("close", close);

  return {
    send(event, data, id) {
      if (closed) return;
      const chunk = frame(event, data, id);
      if (!waiting) return write(chunk);
      queue.push(chunk);
      if (queue.length > maxQueued) {
        queue.shift();
        dropped += 1;
      }
    },
    close,
    get closed() {
      return closed;
    },
  };
}

function frame(event: string, data: unknown, id?: number) {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
