import { connection } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { engineConfig, forwardToEngine } from "@/lib/engine/web";
import { getFeedHub } from "@/lib/live/feed/hub";

// no-transform keeps compression middleware from buffering the stream.
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

// The Live Feed page's view of the hub: state, instruments and recent events. Read-only.
// With ENGINE_URL set the engine owns Dhan and this only forwards.
export async function GET(request: Request) {
  await connection();
  if (!(await isSignedIn())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const engine = engineConfig();
  if (engine) return forwardToEngine(engine, "/v1/feed", request);
  return new Response(getFeedHub().monitor(request.signal), { headers: SSE_HEADERS });
}
