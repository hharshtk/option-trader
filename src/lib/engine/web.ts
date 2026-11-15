import "server-only";

// How the web reaches the engine's control API. With ENGINE_URL set, the engine owns Dhan: the
// web forwards feed streams and actions to it and never opens Dhan sockets itself. Without it,
// the web runs its own feed hub, as before the engine existed.

export interface EngineConfig {
  url: string;
  token: string;
}

export function engineConfig(): EngineConfig | null {
  const url = process.env.ENGINE_URL?.trim().replace(/\/+$/, "");
  const token = process.env.ENGINE_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

export class EngineOfflineError extends Error {
  name = "EngineOfflineError";
}

/** Calls the engine with its token. Throws EngineOfflineError when it can't be reached. */
export async function engineFetch(
  config: EngineConfig,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<Response> {
  try {
    return await fetch(`${config.url}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(init.body !== undefined && { "Content-Type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal ?? AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (cause) {
    throw new EngineOfflineError("Engine offline. Start it with `npm run engine`.", { cause });
  }
}

/**
 * Streams an engine GET response (JSON or server-sent events) back to the browser. Closing the
 * tab aborts the upstream request through request.signal, so the engine releases what the tab
 * held. EventSource's Last-Event-ID is passed on so streams resume.
 */
export async function forwardToEngine(config: EngineConfig, path: string, request: Request): Promise<Response> {
  const lastEventId = request.headers.get("last-event-id");
  let upstream: Response;
  try {
    upstream = await engineFetch(config, `${path}${new URL(request.url).search}`, {
      signal: request.signal,
      headers: lastEventId ? { "Last-Event-ID": lastEventId } : undefined,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": contentType,
      // no-transform keeps compression middleware from buffering the stream.
      "Cache-Control": "no-cache, no-transform",
      ...(contentType.startsWith("text/event-stream") && { "X-Accel-Buffering": "no" }),
    },
  });
}
