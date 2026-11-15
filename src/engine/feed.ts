// The live Dhan feed inside the engine: the same hub the web used to run, now the only thing
// holding Dhan sockets. Reports its health, metrics and a `feed` telemetry snapshot every tick,
// so the Engine page shows sockets, instruments and tick flow.

import { getDhanCredentials, getTokenStore } from "../lib/dhan/config.ts";
import { createFeedHub, type FeedHub } from "../lib/live/feed/feed-hub.ts";
import type { FeedHealth } from "../lib/live/feed/monitor.ts";
import type { Health } from "./telemetry/health.ts";
import type { TelemetryHub } from "./telemetry/hub.ts";
import type { Logger } from "./telemetry/logger.ts";
import type { Metrics } from "./telemetry/metrics.ts";

export interface EngineFeed {
  hub: FeedHub;
  /** Updates health, metrics and telemetry. Call once a second. */
  tick(): void;
  shutdown(): void;
}

export function startFeed({
  log,
  health,
  metrics,
  telemetry,
  captureDir,
}: {
  log: Logger;
  health: Health;
  metrics: Metrics;
  telemetry: TelemetryHub;
  /** Records raw frames here when set (FEED_CAPTURE=1), until the E2 journal replaces it. */
  captureDir?: string;
}): EngineFeed {
  const store = getTokenStore();
  const hub = createFeedHub({
    readCredentials: getDhanCredentials,
    currentToken: () => store.current(),
    captureDir,
    print: (message) => log.info(message),
  });
  const seenFrames = new Map<number, number>();

  function report(snapshot: FeedHealth) {
    const stopped = snapshot.connections.find((c) => c.feed.state === "stopped");
    const reconnecting = snapshot.connections.find((c) => c.feed.state === "reconnecting");
    if (stopped && stopped.feed.state === "stopped") {
      health.set("feed", "failing", `${stopped.name}: ${stopped.feed.reason}`);
    } else if (reconnecting && reconnecting.feed.state === "reconnecting") {
      health.set("feed", "degraded", `${reconnecting.name}: reconnecting (${reconnecting.feed.reason})`);
    } else {
      health.set("feed", "ok");
    }

    metrics.gauge("feed.connections", snapshot.connections.length);
    metrics.gauge("feed.live_connections", snapshot.connections.filter((c) => c.feed.state === "live").length);
    metrics.gauge("feed.instruments", snapshot.instruments.length);
    metrics.gauge("feed.quote_streams", snapshot.quoteStreams);
    for (const connection of snapshot.connections) {
      const previous = seenFrames.get(connection.id) ?? 0;
      // A closed and reopened connection starts counting again.
      const added = connection.frames >= previous ? connection.frames - previous : connection.frames;
      if (added > 0) metrics.increment("feed.frames", added);
      seenFrames.set(connection.id, connection.frames);
    }
  }

  return {
    hub,
    tick() {
      const snapshot = hub.health();
      report(snapshot);
      telemetry.publish("feed", snapshot);
    },
    shutdown() {
      hub.shutdown();
    },
  };
}
