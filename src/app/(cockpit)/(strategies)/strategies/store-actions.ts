"use server";

import { isSignedIn } from "@/lib/auth";
import { engineConfig, engineFetch } from "@/lib/engine/web";
import type { StrategyCommand, StrategyCommandResult } from "@/lib/strategies/types";

// Commands for the engine's strategy store: create, save a version, test, paper trade, retire.
// Server Functions are reachable by direct POST, so this checks the session and the command's
// shape; the engine checks every setting with the trading engine's own rules.

const ACTIONS = new Set(["create", "save", "paper", "stop-paper", "test", "retire", "restore"]);

export async function controlStrategies(command: StrategyCommand): Promise<StrategyCommandResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Your session has ended. Sign in again." };
  if (!command || typeof command !== "object" || !ACTIONS.has(command.action)) return { ok: false, message: "That strategy request isn't valid." };

  const engine = engineConfig();
  if (!engine) return { ok: false, message: "Engine not configured: set ENGINE_URL and ENGINE_TOKEN." };
  try {
    const response = await engineFetch(engine, "/v1/strategies", { method: "POST", body: command });
    const result = (await response.json().catch(() => null)) as StrategyCommandResult | null;
    if (result && typeof result.ok === "boolean") return result;
    return { ok: false, message: response.status === 404 ? "This engine has no strategy store yet. Restart it on the new code." : `The engine returned HTTP ${response.status}.` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
