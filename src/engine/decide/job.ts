// Runs the decision lab after each session: 10 minutes after NSE's close the engine starts
// `npm run decide` as a child process (it builds the day's table, and any day still missing, then
// scores every rule on every day), so the work never stalls the feed. Also serves the scorecard
// to `GET /v1/decide`, read from the stored tables and kept for a minute.

import { spawn } from "node:child_process";
import path from "node:path";
import type { DecideView } from "../../lib/decide/score.ts";
import type { SessionCalendar } from "../market/session-calendar.ts";
import type { Logger } from "../telemetry/logger.ts";
import type { DecisionLab } from "./lab.ts";

const AFTER_CLOSE_MS = 10 * 60_000;
const VIEW_TTL_MS = 60_000;

export interface DecisionJob {
  /** Call every second: starts the lab once a day after the close. */
  tick(): void;
  view(): Promise<DecideView>;
  shutdown(): void;
}

export function createDecisionJob({
  lab,
  calendar,
  log,
  now,
  root,
  dataDir,
}: {
  lab: DecisionLab;
  calendar: SessionCalendar;
  log: Logger;
  now: () => number;
  /** The repository, where `src/engine/decide/cli.ts` is. */
  root: string;
  /** The engine's data directory, passed on as ENGINE_DATA_DIR. */
  dataDir: string;
}): DecisionJob {
  let build: DecideView["build"] = { state: "idle", at: null, message: null };
  let doneFor: string | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  let cached: { at: number; view: Promise<DecideView> } | null = null;

  function start(date: string) {
    build = { state: "running", at: now(), message: `Building and scoring after the ${date} session` };
    const lines: string[] = [];
    child = spawn(process.execPath, [path.join(root, "src/engine/decide/cli.ts")], {
      cwd: root,
      env: { ...process.env, ENGINE_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) lines.push(line.trim());
      while (lines.length > 40) lines.shift();
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("exit", (code) => {
      child = null;
      cached = null;
      if (code === 0) {
        doneFor = date;
        build = { state: "idle", at: now(), message: `Built and scored after the ${date} session` };
        log.info(`decision lab: built and scored after the ${date} session`);
      } else {
        // Tried once a day: a failure waits for the next session or an engine restart.
        doneFor = date;
        const last = lines.filter((l) => !l.startsWith("  ")).slice(-3).join(" · ");
        build = { state: "failed", at: now(), message: last || `exited with code ${code}` };
        log.warn("decision lab failed", { code, output: lines.slice(-10).join("\n") });
      }
    });
  }

  return {
    tick() {
      if (child) return;
      const at = now();
      const date = calendar.istDate(at);
      if (doneFor === date) return;
      const session = calendar.session("NSE_FNO", date);
      if (!session || at < session.close + AFTER_CLOSE_MS) return;
      start(date);
    },
    view() {
      if (!cached || now() - cached.at > VIEW_TTL_MS) {
        const view = lab.view(build);
        cached = { at: now(), view };
        view.catch(() => (cached = null));
      }
      return cached.view.then((v) => ({ ...v, build }));
    },
    shutdown() {
      child?.kill("SIGTERM");
    },
  };
}
