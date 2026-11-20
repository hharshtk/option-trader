"use server";

import { isSignedIn } from "@/lib/auth";
import { DEFAULT_TRADING_CONFIG, mergeTradingConfig, type TradingCommand, type TradingCommandResult } from "@/lib/engine/trading";
import { engineConfig, engineFetch } from "@/lib/engine/web";

// Commands for the engine's paper trading: start and stop, sell one position or everything, stop for the day,
// change the settings. Server Functions are reachable by direct POST, so this checks the session
// and the shape of the input; the engine checks the values again.

const SIMPLE = new Set(["arm", "disarm", "flatten", "halt", "resume"]);

export async function controlTrading(command: TradingCommand): Promise<TradingCommandResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Your session has ended. Sign in again." };
  if (!command || typeof command !== "object" || typeof command.action !== "string") {
    return { ok: false, message: "That trading request isn't valid." };
  }
  let body: TradingCommand;
  if (command.action === "config") {
    // Checked against the defaults only for shape and ranges; the engine merges it into its own settings.
    const checked = mergeTradingConfig(DEFAULT_TRADING_CONFIG, command.patch);
    if (!checked.ok) return { ok: false, message: checked.message };
    body = { action: "config", patch: command.patch };
  } else if (command.action === "sell") {
    if (typeof command.positionId !== "string" || !/^p\d{1,9}$/.test(command.positionId)) return { ok: false, message: "That trading request isn't valid." };
    body = { action: "sell", positionId: command.positionId };
  } else if (SIMPLE.has(command.action)) {
    body = { action: command.action };
  } else {
    return { ok: false, message: "That trading request isn't valid." };
  }

  const engine = engineConfig();
  if (!engine) return { ok: false, message: "Engine not configured: set ENGINE_URL and ENGINE_TOKEN." };
  try {
    const response = await engineFetch(engine, "/v1/trading", { method: "POST", body });
    const result = (await response.json().catch(() => null)) as TradingCommandResult | null;
    if (result && typeof result.ok === "boolean") {
      // An engine older than the page: nothing was done, so say why rather than "unknown command".
      if (!result.ok && body.action === "sell" && /unknown trading command/i.test(result.message)) {
        return { ok: false, message: "Nothing was sold: the engine is running older code that can't sell one position. Restart it, or use Sell open positions." };
      }
      return result;
    }
    return { ok: false, message: response.status === 404 ? "This engine has no trading yet. Restart it on the new code." : `The engine returned HTTP ${response.status}.` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
