// Switches the engine's feed between Dhan (live) and a recorded day (replay). In a replay the
// feed's sockets connect to a player that streams a journal file in Dhan's wire format, so the
// hub, quote streams and every page work exactly as live, on recorded prices.
//
// Guard rails, because a session not recorded on the day is lost for good:
//   - Replay is refused from 30 minutes before any segment's session (pre-open included) until it
//     closes, and a running replay switches back to live on its own at that point.
//   - A replay records nothing to the journal. The real journal gets `replay-start`, `replay-stop`
//     and a `gap` (reason "replay") covering the time the live feed was off.

import type { JournalSession, ReplayCommandResult, ReplayStatus } from "../lib/engine/protocol.ts";
import { REPLAY_MAX_SPEED, REPLAY_MIN_SPEED } from "../lib/engine/protocol.ts";
import type { FeedHub } from "../lib/live/feed/feed-hub.ts";
import { startFeed, type EngineFeed } from "./feed.ts";
import type { Journal } from "./journal/writer.ts";
import type { SessionCalendar } from "./market/session-calendar.ts";
import type { Universe } from "./market/universe.ts";
import { createReplayPlayer, type ReplayPlayer } from "./replay/player.ts";
import { loadRecording, RecordingError, type Recording } from "./replay/recording.ts";
import { createReplaySession, type ReplaySession } from "./replay/replay-session.ts";
import { createRetimer } from "./replay/retime.ts";
import type { Health } from "./telemetry/health.ts";
import type { TelemetryHub } from "./telemetry/hub.ts";
import type { Logger } from "./telemetry/logger.ts";
import type { Metrics } from "./telemetry/metrics.ts";

/** How long before a session (its pre-open, if it has one) replay is switched off. */
export const REPLAY_LEAD_MS = 30 * 60_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
/** The player never connects anywhere; the feed still asks for credentials before it "connects". */
const REPLAY_CREDENTIALS = { clientId: "replay", accessToken: "replay" };
const NO_JOURNAL: Pick<Journal, "frame" | "control"> = { frame() {}, control() {} };

const ok = (message: string): ReplayCommandResult => ({ ok: true, message });
const fail = (message: string): ReplayCommandResult => ({ ok: false, message });

/** HH:MM:SS in IST. */
export function istClock(time: number) {
  return new Date(time + IST_OFFSET_MS).toISOString().slice(11, 19);
}

/** "HH:MM" or "HH:MM:SS" IST on an IST date, as ms since the epoch; null when malformed. */
export function istTimeOn(date: string, text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match || !day) return null;
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), hours, minutes, seconds) - IST_OFFSET_MS;
}

/**
 * Whether replay may run at `now`. `blocked` says why not; `liveAt` is when a replay started now
 * would be switched back to live (30 minutes before the next session).
 */
export function replayWindow(calendar: SessionCalendar, now: number): { blocked: string | null; liveAt: number | null } {
  let blocked: string | null = null;
  let liveAt: number | null = null;
  for (const segment of calendar.segments()) {
    const phase = calendar.phaseAt(segment, now);
    if (phase !== "closed") {
      blocked ??= `${segment} is ${phase === "open" ? "open" : "in pre-open"}`;
      continue;
    }
    const next = calendar.nextSession(segment, now);
    if (!next) continue;
    const start = next.preOpen?.start ?? next.open;
    const off = start - REPLAY_LEAD_MS;
    if (now >= off) blocked ??= `${segment} opens at ${istClock(start).slice(0, 5)} IST`;
    else liveAt = liveAt === null ? off : Math.min(liveAt, off);
  }
  return { blocked, liveAt };
}

/** Where a replay starts by default: the day's pre-open (09:00 IST) if recorded, else the first frame. */
export function defaultReplayStart(calendar: SessionCalendar, recording: Recording) {
  const session = calendar.session("NSE_EQ", recording.date);
  if (!session) return recording.startAt;
  const start = session.preOpen?.start ?? session.open;
  return recording.endAt >= start ? Math.max(start, recording.startAt) : recording.startAt;
}

export interface FeedSwitch {
  /** The running feed, live or replay. */
  current(): EngineFeed | null;
  /** The live feed's hub; null during a replay. */
  liveHub(): FeedHub | null;
  replayStatus(): ReplayStatus | null;
  /** The day being replayed; null when live. */
  replayDate(): string | null;
  /**
   * During a replay of `date`: that day as far as the replay has reached, so session views build
   * up as they do live. Null when live or for any other day.
   */
  replaySession(date: string): Promise<JournalSession> | null;
  /** Why a replay can't start now; null when it can. */
  replayBlocked(): string | null;
  startLive(): void;
  /** Handles a `POST /v1/replay` body. Never throws; bad input comes back as `ok: false`. */
  command(body: unknown): Promise<ReplayCommandResult>;
  /** Call once a second: switches back to live before a session, and reports the feed. */
  tick(): void;
  shutdown(): void;
}

export function createFeedSwitch({
  logger,
  health,
  metrics,
  telemetry,
  journal,
  journalDirectory,
  universe,
  calendar,
  now,
}: {
  /** Loggers by component: `feed` for the live feed, `replay` and `replay.feed` for a replay. */
  logger: (component: string) => Logger;
  health: Health;
  metrics: Metrics;
  telemetry: TelemetryHub;
  journal: Journal;
  journalDirectory: string;
  universe: Universe;
  calendar: SessionCalendar;
  now: () => number;
}): FeedSwitch {
  const feedLog = logger("feed");
  const log = logger("replay");
  let feed: EngineFeed | null = null;
  let replay: { player: ReplayPlayer; session: ReplaySession; date: string; since: number } | null = null;
  let loading = false;
  let jumps = 0;

  function startLive() {
    feed?.shutdown();
    feed = startFeed({ log: feedLog, health, metrics, telemetry, journal, universe, calendar });
  }

  async function startReplay(request: { date?: unknown; from?: unknown; speed?: unknown }): Promise<ReplayCommandResult> {
    if (loading) return fail("A replay is already loading.");
    const { blocked } = replayWindow(calendar, now());
    if (blocked) {
      return fail(`Replay is off from 30 minutes before a session until it closes, so the engine records the market (${blocked}).`);
    }

    const date = request.date === undefined || request.date === "" ? journal.days()[0]?.date : request.date;
    if (typeof date !== "string") return fail("There are no recorded days to replay.");
    const speed = request.speed === undefined ? 1 : request.speed;
    if (typeof speed !== "number" || !(speed >= REPLAY_MIN_SPEED && speed <= REPLAY_MAX_SPEED)) {
      return fail(`Speed must be a number from ${REPLAY_MIN_SPEED} to ${REPLAY_MAX_SPEED}.`);
    }
    if (request.from !== undefined && typeof request.from !== "string") return fail("Start time must be HH:MM or HH:MM:SS IST.");

    let recording: Recording;
    loading = true;
    try {
      recording = await loadRecording(journalDirectory, date);
    } catch (error) {
      return fail(error instanceof RecordingError ? error.message : `Could not read the ${date} journal: ${String(error)}`);
    } finally {
      loading = false;
    }
    if (recording.count === 0) return fail(`The ${date} journal has no frames.`);

    let from = defaultReplayStart(calendar, recording);
    if (request.from) {
      const parsed = istTimeOn(date, request.from);
      if (parsed === null) return fail("Start time must be HH:MM or HH:MM:SS IST.");
      from = parsed;
    }

    const player = createReplayPlayer({
      recording,
      now,
      from,
      speed,
      log: (message) => log.info(message),
      onJump: () => {
        jumps += 1;
      },
    });
    const at = now();
    const since = replay?.since ?? at;
    // Close the old feed's sockets before the old player, so the feed doesn't see them drop.
    feed?.shutdown();
    feed = null;
    if (replay) replay.player.shutdown();
    else journal.control("replay-start", { date, from, speed }, at);
    replay = { player, session: createReplaySession(recording, calendar), date, since };
    feed = startFeed({
      log: log.child("feed"),
      health,
      metrics,
      telemetry,
      journal: NO_JOURNAL,
      universe,
      calendar,
      source: {
        openSocket: player.openSocket,
        readCredentials: () => REPLAY_CREDENTIALS,
        currentToken: () => REPLAY_CREDENTIALS.accessToken,
        // The web sees when each frame originally arrived, not when it was replayed.
        retime: createRetimer(player, now),
      },
    });
    player.play();

    const where = `${date} from ${istClock(player.status().at)} IST at ×${speed}`;
    log.warn(`feed switched to replay of ${where}; nothing is recorded until it goes back to live`);
    return ok(`Replaying ${where}.`);
  }

  function stopReplay(reason: string) {
    if (!replay) return fail("The feed is already live.");
    const { player, date, since } = replay;
    replay = null;
    feed?.shutdown();
    feed = null;
    player.shutdown();
    const at = now();
    journal.control("replay-stop", { date, reason }, at);
    journal.control("gap", { reason: "replay", from: since, to: at }, at);
    startLive();
    log.info(`feed back to live from Dhan (${reason})`);
    return ok("Back to the live Dhan feed.");
  }

  function control(action: string, body: Record<string, unknown>): ReplayCommandResult {
    if (!replay) return fail("No replay is running. Start one first.");
    const { player, date } = replay;
    switch (action) {
      case "play":
        player.play();
        return ok("Playing.");
      case "pause":
        player.pause();
        return ok(`Paused at ${istClock(player.status().at)} IST.`);
      case "speed": {
        const { speed } = body;
        if (typeof speed !== "number" || !(speed >= REPLAY_MIN_SPEED && speed <= REPLAY_MAX_SPEED)) {
          return fail(`Speed must be a number from ${REPLAY_MIN_SPEED} to ${REPLAY_MAX_SPEED}.`);
        }
        player.setSpeed(speed);
        return ok(`Speed ×${speed}.`);
      }
      case "seek": {
        const time = typeof body.to === "string" ? istTimeOn(date, body.to) : null;
        if (time === null) return fail("Time must be HH:MM or HH:MM:SS IST.");
        player.seek(time);
        return ok(`Jumped to ${istClock(player.status().at)} IST.`);
      }
      default:
        return fail(`Unknown action "${action}".`);
    }
  }

  return {
    current: () => feed,
    liveHub: () => (replay ? null : (feed?.hub ?? null)),
    replayStatus() {
      if (!replay) return null;
      return { date: replay.date, ...replay.player.status(), jumps, since: replay.since, liveAt: replayWindow(calendar, now()).liveAt };
    },
    replayBlocked: () => replayWindow(calendar, now()).blocked,
    replayDate: () => replay?.date ?? null,
    replaySession(date) {
      if (!replay || date !== replay.date) return null;
      return replay.session.read(replay.player.status().at);
    },
    startLive,
    async command(body) {
      const request = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const action = request.action;
      if (typeof action !== "string") return fail("Missing action.");
      try {
        if (action === "start") return await startReplay(request);
        if (action === "stop") return stopReplay("requested");
        return control(action, request);
      } catch (error) {
        log.error("replay command failed", { action, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
        return fail(`The replay command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    tick() {
      if (replay) {
        const { blocked } = replayWindow(calendar, now());
        if (blocked) {
          log.warn(`${blocked}: switching the feed back to live to record the session`);
          stopReplay(`${blocked}; the session must be recorded`);
        }
      }
      feed?.tick();
    },
    shutdown() {
      feed?.shutdown();
      feed = null;
      replay?.player.shutdown();
    },
  };
}
