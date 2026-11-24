import { parentPort, workerData } from "node:worker_threads";
import type { OfiReplayStatus } from "../../lib/engine/ofi.ts";
import { compareOfiReplay } from "./ofi-comparison.ts";

const { directory, date } = workerData as { directory: string; date: string };
const result: OfiReplayStatus = await compareOfiReplay(directory, date).then(
  (comparison) => ({ state: "ready", comparison }),
  (error: unknown) => ({ state: "failed", message: error instanceof Error ? error.message : String(error) }),
);
parentPort!.postMessage(result);
