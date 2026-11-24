"use server";

import { isSignedIn } from "@/lib/auth";
import type { OfiReplayStatus } from "@/lib/engine/ofi";
import { REPLAY_MAX_SPEED, REPLAY_MIN_SPEED, type ReplayCommand, type ReplayCommandResult } from "@/lib/engine/protocol";
import { engineConfig, engineFetch } from "@/lib/engine/web";

// Switches the engine's feed between Dhan and a recorded day, and steers the replay. Server
// Functions are reachable by direct POST, so this checks the session and the input shape; the
// engine checks the values again.

const ACTIONS = new Set(["start", "stop", "play", "pause", "speed", "seek"]);
const TIME = /^\d{1,2}:\d{2}(:\d{2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function valid(command: ReplayCommand): boolean {
  if (!command || typeof command !== "object" || !ACTIONS.has(command.action)) return false;
  const speedOk = (speed: unknown) => typeof speed === "number" && speed >= REPLAY_MIN_SPEED && speed <= REPLAY_MAX_SPEED;
  switch (command.action) {
    case "start":
      return (
        (command.date === undefined || (typeof command.date === "string" && DATE.test(command.date))) &&
        (command.from === undefined || (typeof command.from === "string" && TIME.test(command.from))) &&
        (command.speed === undefined || speedOk(command.speed))
      );
    case "speed":
      return speedOk(command.speed);
    case "seek":
      return typeof command.to === "string" && TIME.test(command.to);
    default:
      return true;
  }
}

export async function controlReplay(command: ReplayCommand): Promise<ReplayCommandResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Your session has ended. Sign in again." };
  if (!valid(command)) return { ok: false, message: "That replay request isn't valid." };
  const engine = engineConfig();
  if (!engine) return { ok: false, message: "Engine not configured: set ENGINE_URL and ENGINE_TOKEN." };
  try {
    // Starting reads the whole day's journal, which takes a moment for a full session.
    const response = await engineFetch(engine, "/v1/replay", { method: "POST", body: command, signal: AbortSignal.timeout(30_000) });
    const result = (await response.json().catch(() => null)) as ReplayCommandResult | null;
    return result ?? { ok: false, message: `The engine returned HTTP ${response.status}.` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

export async function startOfiComparison(date: string): Promise<OfiReplayStatus> {
  if (!(await isSignedIn())) return { state: "failed", message: "Your session has ended. Sign in again." };
  if (typeof date !== "string" || !DATE.test(date)) return { state: "failed", message: "Choose a recorded NSE trading day." };
  const engine = engineConfig();
  if (!engine) return { state: "failed", message: "Engine not configured: set ENGINE_URL and ENGINE_TOKEN." };
  try {
    const response = await engineFetch(engine, `/v1/replay/ofi?date=${encodeURIComponent(date)}`, { method: "POST" });
    if (!response.ok) return { state: "failed", message: `The engine returned HTTP ${response.status}.` };
    return await response.json() as OfiReplayStatus;
  } catch (error) {
    return { state: "failed", message: (error as Error).message };
  }
}
