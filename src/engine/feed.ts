// The live Dhan feed inside the engine: the same hub the web used to run, now the only thing
// holding Dhan sockets. Every raw frame and feed event goes to the journal; the always-on
// universe stays subscribed whether or not a page is open. Reports health, metrics and a
// `feed` telemetry snapshot every tick, so the Engine page shows sockets, instruments and flow.

import { getDhanCredentials, getTokenStore } from "../lib/dhan/config.ts";
import { createFeedHub, type FeedHub } from "../lib/live/feed/feed-hub.ts";
import type { FeedEventBody, FeedHealth } from "../lib/live/feed/monitor.ts";
import type { Journal } from "./journal/writer.ts";
import type { Universe } from "./market/universe.ts";
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
  journal,
  universe,
}: {
  log: Logger;
  health: Health;
  metrics: Metrics;
  telemetry: TelemetryHub;
  journal: Journal;
  universe: Universe;
}): EngineFeed {
  const store = getTokenStore();
  // When each connection last stopped delivering, so a reconnect can record the gap.
  const downSince = new Map<number, number>();

  function onEvent(event: FeedEventBody, at: number) {
    if (event.type === "log") return;
    const { type, ...data } = event;
    journal.control(type, data, at, event.connection ?? 0);

    if (event.type !== "state" || event.connection === undefined) return;
    const state = event.state.state;
    if (state === "live") {
      const from = downSince.get(event.connection);
      if (from !== undefined) {
        journal.control("gap", { reason: "reconnect", from, to: at }, at, event.connection);
        log.warn("feed gap recorded", { connection: event.connection, seconds: Math.round((at - from) / 1000) });
        downSince.delete(event.connection);
      }
    } else if ((state === "reconnecting" || state === "stopped") && !downSince.has(event.connection)) {
      downSince.set(event.connection, at);
    }
  }

  const hub = createFeedHub({
    readCredentials: getDhanCredentials,
    currentToken: () => store.current(),
    print: (message) => log.info(message),
    onFrame: (connection, frame, at) => journal.frame(connection, frame, at),
    onEvent,
  });

  if (universe.instruments.length > 0) {
    hub.acquire(universe.instruments);
    log.info(`universe "${universe.name}" subscribed`, { instruments: universe.instruments.length });
  }
  for (const problem of universe.problems) log.warn(`universe: ${problem}`);

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

/** What every journal file starts with: the subscriptions in force, so a replay knows them. */
export function subscriptionSnapshot(hub: FeedHub | null) {
  if (!hub) return [];
  return hub.health().instruments.map((instrument) => ({ key: instrument.key, connection: instrument.connection }));
}

