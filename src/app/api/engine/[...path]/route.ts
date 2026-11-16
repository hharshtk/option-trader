import { connection } from "next/server";
import { isSignedIn } from "@/lib/auth";
import { engineConfig, forwardToEngine } from "@/lib/engine/web";

// Browser → this route → engine. The browser never holds ENGINE_TOKEN: this checks the session
// cookie, adds the token, and streams the engine's response through.

const ALLOWED = /^v1\/(status|logs|telemetry|journal\/session)$/;

export async function GET(request: Request, ctx: RouteContext<"/api/engine/[...path]">) {
  await connection();
  if (!(await isSignedIn())) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const config = engineConfig();
  if (!config) {
    return Response.json({ error: "Engine not configured: set ENGINE_URL and ENGINE_TOKEN." }, { status: 501 });
  }

  const path = (await ctx.params).path.join("/");
  if (!ALLOWED.test(path)) return Response.json({ error: "Not found" }, { status: 404 });
  return forwardToEngine(config, `/${path}`, request);
}
