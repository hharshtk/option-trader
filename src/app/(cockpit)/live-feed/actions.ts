"use server";

import { isSignedIn } from "@/lib/auth";
import { engineConfig, engineFetch, type EngineConfig } from "@/lib/engine/web";
import { getFeedHub } from "@/lib/live/feed/hub";
import type { FeedActionResult } from "@/lib/live/feed/monitor";

// Server Functions are reachable by direct POST, so each one checks the session and its input.
// With ENGINE_URL set the engine owns the feed and these forward to it.

const UNAUTHORIZED: FeedActionResult = { ok: false, message: "Your session has ended. Sign in again." };

const optionalText = (value: unknown) => (typeof value === "string" ? value : undefined);

async function viaEngine(engine: EngineConfig, path: string, body?: unknown): Promise<FeedActionResult> {
  try {
    const response = await engineFetch(engine, path, { method: "POST", body: body ?? {} });
    const result = (await response.json().catch(() => null)) as FeedActionResult | null;
    return result ?? { ok: false, message: `The engine returned HTTP ${response.status}.` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

export async function addFeedInstrument(input: {
  key: string;
  name?: string;
  connection: number | "new";
  connectionName?: string;
}): Promise<FeedActionResult> {
  if (!(await isSignedIn())) return UNAUTHORIZED;
  const { key, connection } = input ?? {};
  if (typeof key !== "string" || !(connection === "new" || Number.isInteger(connection))) {
    return { ok: false, message: "Pick an instrument and a connection." };
  }
  const request = {
    key,
    connection,
    name: optionalText(input.name),
    connectionName: optionalText(input.connectionName),
  };
  const engine = engineConfig();
  return engine ? viaEngine(engine, "/v1/feed/pin", request) : getFeedHub().pin(request);
}

export async function removeFeedInstrument(key: string): Promise<FeedActionResult> {
  if (!(await isSignedIn())) return UNAUTHORIZED;
  if (typeof key !== "string") return { ok: false, message: "Unknown instrument." };
  const engine = engineConfig();
  return engine ? viaEngine(engine, "/v1/feed/unpin", { key }) : getFeedHub().unpin(key);
}

export async function closeFeedConnection(id: number): Promise<FeedActionResult> {
  if (!(await isSignedIn())) return UNAUTHORIZED;
  if (!Number.isInteger(id)) return { ok: false, message: "Unknown connection." };
  const engine = engineConfig();
  return engine ? viaEngine(engine, `/v1/feed/connections/${id}/close`) : getFeedHub().closeConnection(id);
}
