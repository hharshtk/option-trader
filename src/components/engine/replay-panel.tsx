"use client";

import { useState, useTransition, type FormEvent } from "react";
import { controlReplay } from "@/app/(cockpit)/engine/actions";
import { buttonClass, Panel, StatRow, StatusDot } from "@/components/ui";
import {
  REPLAY_SPEEDS,
  type EngineStatus,
  type ReplayCommand,
  type ReplayCommandResult,
  type ReplayStatus,
} from "@/lib/engine/protocol";
import { istDateTime, istTime, quantity } from "@/lib/format";
import { OfiComparison } from "./ofi-comparison";
import { replayDay } from "./replay-format";

const fieldClass = "h-7 rounded-sm border border-line-strong bg-canvas px-2 text-body focus-visible:border-accent disabled:opacity-60";

/** Feed source: live from Dhan, or a recorded day replayed through a stand-in for Dhan's socket. */
export function ReplayPanel({ status }: { status: EngineStatus }) {
  const [result, setResult] = useState<ReplayCommandResult | null>(null);
  const [pending, startTransition] = useTransition();

  const send = (command: ReplayCommand) =>
    startTransition(async () => {
      setResult(await controlReplay(command));
    });

  // An engine older than the replay feature reports neither field.
  if (status.replay === undefined && status.replayBlocked === undefined) return null;

  return (
    <Panel
      title="Feed source"
      meta={
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={status.replay ? "warn" : "up"} />
          {status.replay ? `Replay of ${replayDay(status.replay.date)}` : "Live from Dhan"}
        </span>
      }
      className="lg:col-span-2"
    >
      {status.replay ? (
        <Replaying replay={status.replay} pending={pending} send={send} />
      ) : (
        <StartForm status={status} pending={pending} send={send} />
      )}
      {result && (
        <p role="status" className={`mt-2 text-label ${result.ok ? "text-muted" : "text-down"}`}>
          {result.message}
        </p>
      )}
    </Panel>
  );
}

function StartForm({
  status,
  pending,
  send,
}: {
  status: EngineStatus;
  pending: boolean;
  send: (command: ReplayCommand) => void;
}) {
  const [date, setDate] = useState("");
  const [from, setFrom] = useState("");
  const [speed, setSpeed] = useState(1);
  const blocked = status.replayBlocked ?? null;
  const days = status.journalDays;
  const comparisonDate = date || days[0]?.date;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send({ action: "start", date: date || undefined, from: from || undefined, speed });
  };

  return (
    <form onSubmit={submit}>
      <p className="text-muted">
        Play a recorded day back as if Dhan were sending it: every page then shows the day&apos;s prices at their recorded pace.
        Nothing is journaled while replaying, and the engine goes back to live 30 minutes before the next session.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-label text-muted">
          Day
          <select value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} disabled={days.length === 0}>
            {days.map((day, index) => (
              <option key={day.date} value={index === 0 ? "" : day.date}>
                {replayDay(day.date)} · {(day.bytes / 1_048_576).toFixed(day.bytes < 10_485_760 ? 1 : 0)} MB
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-muted">
          From (IST)
          <input type="time" step={1} value={from} onChange={(e) => setFrom(e.target.value)} className={`${fieldClass} tabular-nums`} />
        </label>
        <label className="flex flex-col gap-1 text-label text-muted">
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className={fieldClass}>
            {REPLAY_SPEEDS.map((value) => (
              <option key={value} value={value}>
                ×{value}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={buttonClass} disabled={pending || blocked !== null || days.length === 0}>
          {pending ? "Loading…" : "Start replay"}
        </button>
      </div>
      <p className="mt-2 text-label text-muted">
        {blocked
          ? `Not now: ${blocked}. Replay is off from 30 minutes before a session until it closes, so the engine records the market.`
          : "Leave From empty to start at 09:00 on a trading day, or at the first frame on any other day."}
      </p>
      {status.ofiReplay && comparisonDate && <OfiComparison key={comparisonDate} date={comparisonDate} />}
    </form>
  );
}

function Replaying({
  replay,
  pending,
  send,
}: {
  replay: ReplayStatus;
  pending: boolean;
  send: (command: ReplayCommand) => void;
}) {
  const [scrub, setScrub] = useState<number | null>(null);
  const [jump, setJump] = useState("");
  const span = Math.max(1, replay.endAt - replay.startAt);
  const shown = scrub ?? replay.at;

  const commitScrub = () => {
    if (scrub === null) return;
    send({ action: "seek", to: istTime.format(new Date(scrub)) });
    setScrub(null);
  };

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-lg leading-6 font-semibold tabular-nums">{istTime.format(new Date(shown))} IST</span>
        <span className="text-muted">
          {replay.state === "playing" ? `Playing at ×${replay.speed}` : replay.state === "paused" ? "Paused" : "Reached the end"}
        </span>
      </div>

      <label className="mt-2 block">
        <span className="sr-only">Position in the recording</span>
        <input
          type="range"
          min={replay.startAt}
          max={replay.endAt}
          step={1000}
          value={shown}
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={commitScrub}
          onKeyUp={commitScrub}
          className="w-full accent-current"
          aria-valuetext={`${istTime.format(new Date(shown))} IST`}
        />
      </label>
      <div className="flex justify-between text-label text-muted tabular-nums">
        <span>{istTime.format(new Date(replay.startAt))}</span>
        <span>{Math.round(((replay.at - replay.startAt) / span) * 100)}%</span>
        <span>{istTime.format(new Date(replay.endAt))}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={pending}
          onClick={() => send({ action: replay.state === "playing" ? "pause" : "play" })}
        >
          {replay.state === "playing" ? "Pause" : replay.state === "ended" ? "Play from the start" : "Play"}
        </button>
        <div role="group" aria-label="Speed" className="flex gap-1">
          {REPLAY_SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={replay.speed === value}
              disabled={pending}
              onClick={() => send({ action: "speed", speed: value })}
              className={`h-7 rounded-sm px-2 text-body tabular-nums ${replay.speed === value ? "bg-raised font-medium" : "text-muted hover:text-fg"}`}
            >
              ×{value}
            </button>
          ))}
        </div>
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (jump) send({ action: "seek", to: jump });
          }}
        >
          <label className="sr-only" htmlFor="replay-jump">
            Jump to (IST)
          </label>
          <input
            id="replay-jump"
            type="time"
            step={1}
            value={jump}
            onChange={(e) => setJump(e.target.value)}
            className={`${fieldClass} tabular-nums`}
          />
          <button type="submit" className={buttonClass} disabled={pending || !jump}>
            Jump
          </button>
        </form>
        <button type="button" className={`${buttonClass} ml-auto`} disabled={pending} onClick={() => send({ action: "stop" })}>
          Back to live
        </button>
      </div>

      <dl className="mt-3">
        <StatRow label="Frames" value={`${quantity.format(replay.frames)} of ${quantity.format(replay.totalFrames)}`} />
        <StatRow label="Sockets on the replay" value={replay.sockets} />
        <StatRow label="Replaying since" value={`${istDateTime.format(new Date(replay.since))} IST`} />
        <StatRow
          label="Back to live"
          value={replay.liveAt ? `${istDateTime.format(new Date(replay.liveAt))} IST, before the next session` : "When you switch back"}
        />
      </dl>
    </div>
  );
}
