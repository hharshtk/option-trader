import { statSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { OfiReplayStatus } from "../../lib/engine/ofi.ts";
import type { SessionCalendar } from "../market/session-calendar.ts";

const failed = (message: string): OfiReplayStatus => ({ state: "failed", message });

/** One recorded-day comparison at a time. The worker keeps the large reads off the engine loop. */
export function createOfiJob({ directory, calendar, now, blocked }: {
  directory: string;
  calendar: SessionCalendar;
  now: () => number;
  blocked: () => string | null;
}) {
  let latest: { date: string; files: string; result: OfiReplayStatus } | null = null;
  let active: Worker | null = null;

  function finish(worker: Worker, result: OfiReplayStatus) {
    if (active !== worker || !latest) return;
    latest.result = result;
    active = null;
  }

  function cancel(message: string) {
    if (!active) return;
    const worker = active;
    finish(worker, failed(message));
    void worker.terminate().catch(() => {});
  }

  return {
    status(date: string | null): OfiReplayStatus {
      return latest && latest.date === date ? latest.result : { state: "idle" };
    },
    start(date: string | null): OfiReplayStatus {
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return failed("Choose a recorded NSE trading day.");
      const session = calendar.session("NSE_EQ", date);
      if (!session || !Number.isFinite(session.open) || calendar.istDate(session.open) !== date) return failed("Choose a recorded NSE trading day.");
      if (session.close > now()) return failed("Choose a session that has closed.");
      if (active && latest) return latest.date === date ? latest.result : failed("Another day is being compared. Try again when it finishes.");

      const main = statSync(path.join(directory, `${date}.bin`), { throwIfNoEntry: false });
      if (!main?.isFile()) return failed(`No journal was recorded for ${date}.`);
      const depth = statSync(path.join(directory, `${date}.depth.bin`), { throwIfNoEntry: false });
      const files = `${main.size}/${main.mtimeMs}/${depth?.size}/${depth?.mtimeMs}`;
      if (latest?.date === date && latest.files === files && latest.result.state === "ready") return latest.result;

      const why = blocked();
      if (why) return failed(`Recorded-day comparisons run outside market recording hours (${why}).`);
      const worker = new Worker(new URL("./ofi-worker.ts", import.meta.url), { workerData: { directory, date } });
      active = worker;
      const result: OfiReplayStatus = { state: "running", date };
      latest = { date, files, result };
      worker.once("message", (message: OfiReplayStatus) => finish(worker, message));
      worker.once("error", (error) => finish(worker, failed(error instanceof Error ? error.message : String(error))));
      worker.once("exit", () => finish(worker, failed("The comparison stopped. Run it again to retry.")));
      return result;
    },
    tick() {
      if (active && blocked()) cancel("The recording window opened. Run the comparison again after the session.");
    },
    shutdown() {
      cancel("The engine stopped. Run the comparison again to retry.");
    },
  };
}
