// The live Dhan feed inside the engine: the same hub the web used to run, now the only thing
// holding Dhan sockets. Every raw frame and feed event goes to the journal; the always-on
// universe stays subscribed whether or not a page is open. Reports health, metrics and a
// `feed` telemetry snapshot every tick, so the Engine page shows sockets, instruments and flow.

import { getDhanCredentials, getTokenStore } from "../lib/dhan/config.ts";
import type { Credentials, FeedSocket } from "../lib/live/feed/dhan-feed.ts";
import { createFeedHub, type FeedHub } from "../lib/live/feed/feed-hub.ts";
import type { FeedEventBody, FeedHealth } from "../lib/live/feed/monitor.ts";
import { createClosedMarketFilter } from "./journal/closed-market-filter.ts";
import { retimeHub, type Retimer } from "./replay/retime.ts";
import type { Journal } from "./journal/writer.ts";
import type { SessionCalendar } from "./market/session-calendar.ts";
import { byMode, type Universe } from "./market/universe.ts";
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

/** Where the feed's sockets connect instead of Dhan: a replay. */
export interface FeedSource {
  openSocket: (url: string) => FeedSocket;
  readCredentials: () => Credentials;
  currentToken: () => string | undefined;
  /** Maps the feed's wall-clock stamps to recorded times in everything the engine reports. */
  retime?: Retimer;
}

export function startFeed({
  log,
  health,
  metrics,
  telemetry,
  journal,
  universe,
  calendar,
  source,
  onFrame,
}: {
  log: Logger;
  health: Health;
  metrics: Metrics;
  telemetry: TelemetryHub;
  /** Where frames and feed events are recorded. A replay passes one that records nothing. */
  journal: Pick<Journal, "frame" | "control">;
  universe: Universe;
  calendar: SessionCalendar;
  /** Defaults to Dhan with the configured credentials. */
  source?: FeedSource;
  /**
   * Every frame as it arrives, with its time on the market's clock: the wall clock live, the
   * recorded time in a replay. Trading reads the market from here.
   */
  onFrame?: (frame: ArrayBuffer, at: number) => void;
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

  const quiet = createClosedMarketFilter(calendar);

  const hub = createFeedHub({
    readCredentials: source?.readCredentials ?? getDhanCredentials,
    currentToken: source?.currentToken ?? (() => store.current()),
    openSocket: source?.openSocket,
    print: (message) => log.info(message),
    onFrame: (connection, frame, at) => {
      // Every frame goes to disk during market hours; when closed, only ones that say something new.
      if (quiet.shouldJournal(frame, at)) journal.frame(connection, frame, at);
      else metrics.increment("journal.frames_skipped");
      // Asked in the same turn the frame arrived, the replay knows that frame's recorded time exactly.
      onFrame?.(frame, source?.retime ? source.retime.at(at) : at);
    },
    onEvent,
  });

  // Held like a tab that never closes, each group in its own mode.
  for (const [mode, instruments] of byMode(universe)) {
    hub.acquire(instruments, mode);
    log.info(`universe "${universe.name}": ${instruments.length} instruments in ${mode} mode`);
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

  // What the API and telemetry see. In a replay, the same hub reporting recorded times.
  const reported = source?.retime ? retimeHub(hub, source.retime) : hub;

  return {
    hub: reported,
    tick() {
      const snapshot = reported.health();
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

