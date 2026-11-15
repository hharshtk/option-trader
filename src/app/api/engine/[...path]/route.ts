import { connection } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { engineConfig } from "@/lib/engine/web";

// Browser → this route → engine. The browser never holds ENGINE_TOKEN: this checks the session
// cookie, adds the token, and streams the engine's response through. Closing the tab aborts
// the upstream request via request.signal.

const ALLOWED = /^v1\/(status|logs|telemetry)$/;

export async function GET(request: Request, ctx: RouteContext<"/api/engine/[...path]">) {
  await connection();
  if (!(await isSignedIn())) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const config = engineConfig();
  if (!config) {
    return Response.json({ error: "Engine not configured: set ENGINE_URL and ENGINE_TOKEN." }, { status: 501 });
  }

  const path = (await ctx.params).path.join("/");
  if (!ALLOWED.test(path)) return Response.json({ error: "Not found" }, { status: 404 });

  const headers: HeadersInit = { Authorization: `Bearer ${config.token}` };
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}/${path}${new URL(request.url).search}`, {
      headers,
      signal: request.signal,
      cache: "no-store",
    });
  } catch {
    return Response.json({ error: "Engine offline. Start it with `npm run engine`." }, { status: 503 });
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
