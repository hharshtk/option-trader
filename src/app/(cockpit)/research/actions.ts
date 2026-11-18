"use server";

import { isSignedIn } from "@/lib/auth";
import { engineConfig, engineFetch } from "@/lib/engine/web";
import type { ResearchCommand, ResearchCommandResult } from "@/lib/research/types";

// Commands for the engine's research jobs: run a study, rerun one, ask the Decision API about its
// firings, update the history, cancel.
// Server Functions are reachable by direct POST, so this checks the session and the command's
// shape; the engine checks the study's settings.

const ACTIONS = new Set(["study", "rerun", "gate", "history", "cancel"]);

export async function controlResearch(command: ResearchCommand): Promise<ResearchCommandResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Your session has ended. Sign in again." };
  if (!command || typeof command !== "object" || !ACTIONS.has(command.action)) return { ok: false, message: "That research request isn't valid." };

  const engine = engineConfig();
  if (!engine) return { ok: false, message: "Engine not configured: set ENGINE_URL and ENGINE_TOKEN." };
  try {
    const response = await engineFetch(engine, "/v1/research", { method: "POST", body: command });
    const result = (await response.json().catch(() => null)) as ResearchCommandResult | null;
    if (result && typeof result.ok === "boolean") return result;
    return { ok: false, message: response.status === 404 ? "This engine has no research yet. Restart it on the new code." : `The engine returned HTTP ${response.status}.` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
