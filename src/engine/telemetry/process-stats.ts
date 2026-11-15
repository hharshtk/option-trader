import { monitorEventLoopDelay } from "node:perf_hooks";
import type { ProcessStats } from "../../lib/engine/protocol.ts";

/** Samples memory, CPU and event-loop delay. Call `sample()` at a steady interval. */
const RESOLUTION_MS = 10;

export function createProcessSampler() {
  const loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  loop.enable();
  let lastCpu = process.cpuUsage();
  let lastAt = performance.now();

  return {
    sample(): ProcessStats {
      const cpu = process.cpuUsage();
      const at = performance.now();
      const usedMicros = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
      const elapsedMs = at - lastAt;
      lastCpu = cpu;
      lastAt = at;
      const memory = process.memoryUsage();
      // The histogram reports nanoseconds and includes its own sampling interval (an idle loop
      // reads ~10 ms at a 10 ms resolution), so subtract it. Reset so each sample covers its
      // own interval.
      const delayP99Ms = loop.count > 0 ? Math.max(0, loop.percentile(99) / 1e6 - RESOLUTION_MS) : 0;
      loop.reset();
      return {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        cpuPercent: elapsedMs > 0 ? Math.round((usedMicros / 1000 / elapsedMs) * 1000) / 10 : 0,
        eventLoopDelayP99Ms: Math.round(delayP99Ms * 10) / 10,
      };
    },
    stop() {
      loop.disable();
    },
  };
}
