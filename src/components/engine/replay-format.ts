import type { ReplayStatus } from "@/lib/engine/protocol";
import { istTime } from "@/lib/format";

const istDay = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" });

/** "16 Nov 2026" for an IST date string. */
export function replayDay(date: string) {
  return istDay.format(new Date(`${date}T12:00:00+05:30`));
}

/** One line for the header tooltip and the Engine page banner. */
export function replaySummary(replay: ReplayStatus) {
  const state = replay.state === "playing" ? `playing at ×${replay.speed}` : replay.state;
  return `Replaying ${replayDay(replay.date)}, ${istTime.format(new Date(replay.at))} IST, ${state}`;
}
