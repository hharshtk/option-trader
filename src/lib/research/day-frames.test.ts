import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { computePulse } from "../insight/pulse.ts";
import { buildDays, CLOSING_AUCTION_FROM, DailyCloses, isFrame, NIFTY_CONSTITUENTS, NIFTY_KEY, sessionRules, sessionUntil, type CandleColumns, type DayFrame } from "./day-frames.ts";
import { dayVotes } from "./study.ts";

// 16 and 17 November 2026: Dhan's 1-minute candles, the official closes, and the votes the engine's
// signal code gave on the journal those days (built from the production journal, see the note).
interface Fixture {
  keys: string[];
  days: Record<string, { candles: Record<string, (number[] | null)[]>; votes: number[][]; journalReference: Record<string, number | null> }>;
  daily: { key: string; date: string; close: number }[];
}
const fixture = JSON.parse(gunzipSync(readFileSync(path.join(import.meta.dirname, "fixtures/parity-2026-11-16-17.json.gz"))).toString()) as Fixture;

/** The fixture's candles as one month's columns. */
function columns(dates: string[]): CandleColumns {
  const out = { keys: fixture.keys, k: [] as number[], t: [] as number[], open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[] };
  for (const date of dates) {
    const open = Date.parse(`${date}T09:15:00+05:30`);
    for (const [key, bars] of Object.entries(fixture.days[date].candles)) {
      bars.forEach((bar, minute) => {
        if (!bar) return;
        const [o, h, l, c] = bar.length === 4 ? bar : [bar[0], bar[0], bar[0], bar[0]];
        out.k.push(fixture.keys.indexOf(key));
        out.t.push(open + minute * 60_000);
        out.open.push(o);
        out.high.push(h);
        out.low.push(l);
        out.close.push(c);
      });
    }
  }
  return out;
}

const breadthKeys = NIFTY_CONSTITUENTS.map((c) => c.key);
const frames = buildDays(columns(["2026-11-16", "2026-11-17"]), new DailyCloses(fixture.daily), { from: "2026-11-01", to: "2026-11-30", breadthKeys }).filter(isFrame);

test("official closes are the journal's previous closes", () => {
  for (const frame of frames) {
    for (const instrument of frame.session.instruments) {
      assert.equal(instrument.reference, fixture.days[frame.date].journalReference[instrument.key], `${frame.date} ${instrument.key}`);
    }
  }
});

test("parity: votes from candles match the journal's on at least 99% of minutes in the trading window", () => {
  assert.equal(frames.length, 2);
  for (const frame of frames) {
    const votes = dayVotes(frame)!;
    const journal = fixture.days[frame.date].votes;
    // 09:24 to 14:43, the bars whose firings the trader can take.
    for (const [index, signal] of (["breadth", "lead", "momentum", "agree"] as const).entries()) {
      let same = 0;
      let total = 0;
      for (let t = 9; t <= 328; t += 1) {
        total += 1;
        if (votes[signal]![t] === journal[t][index]) same += 1;
      }
      assert.ok(same / total >= 0.99, `${frame.date} ${signal}: ${same} of ${total} minutes match`);
    }
  }
});

test("no look-ahead: a vote read from the whole day equals the vote the engine read at that minute's close", () => {
  const frame = frames[0];
  const full = computePulse(frame.session, NIFTY_CONSTITUENTS)!;
  for (const t of [20, 75, 150, 300]) {
    // The day as the engine saw it when minute t closed.
    const cut = sessionUntil(frame.session, t);
    assert.equal(cut.minutes.length, t + 1);
    const then = computePulse(cut, NIFTY_CONSTITUENTS)!;
    assert.deepEqual(then.series[t].votes, full.series[t].votes, `minute ${t}`);
    assert.equal(then.series[t].composite, full.series[t].composite, `minute ${t}`);
  }
});

test("session rules change on the day the closing auction began", () => {
  assert.deepEqual(sessionRules("2026-07-31"), { auction: false, continuousMinutes: 375 });
  assert.deepEqual(sessionRules(CLOSING_AUCTION_FROM), { auction: true, continuousMinutes: 360 });
  assert.equal(frames[0].rules.auction, true);
});

test("the previous close is the last official close before the day", () => {
  const closes = new DailyCloses([
    { key: "A", date: "2026-11-13", close: 10 },
    { key: "A", date: "2026-11-16", close: 11 },
    { key: "A", date: "2026-11-12", close: 9 },
  ]);
  assert.equal(closes.before("A", "2026-11-16"), 10);
  assert.equal(closes.before("A", "2026-11-17"), 11);
  assert.equal(closes.before("A", "2026-11-12"), null);
  assert.equal(closes.before("B", "2026-11-17"), null);
  assert.equal(closes.lastDate, "2026-11-16");
});

test("short sessions and days without a previous close are left out, with the reason", () => {
  const muhurat = { keys: [NIFTY_KEY], k: [] as number[], t: [] as number[], open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[] };
  for (let m = 0; m < 70; m += 1) {
    muhurat.k.push(0);
    muhurat.t.push(Date.parse("2026-11-08T09:15:00+05:30") + m * 60_000);
    for (const field of ["open", "high", "low", "close"] as const) muhurat[field].push(25_000);
  }
  const [day] = buildDays(muhurat, new DailyCloses([{ key: NIFTY_KEY, date: "2026-11-06", close: 25_000 }]), { from: "2026-11-01", to: "2026-11-30", breadthKeys });
  assert.ok(!isFrame(day) && /Short session: 70/.test(day.reason));

  const [first] = buildDays(columns(["2026-11-16"]), new DailyCloses([]), { from: "2026-11-01", to: "2026-11-30", breadthKeys });
  assert.ok(!isFrame(first) && /No official close/.test(first.reason));
});

test("closes carry forward through minutes without a trade", () => {
  const frame = frames[0] as DayFrame;
  const line = frame.session.instruments.find((i) => i.key !== NIFTY_KEY)!.closes;
  assert.ok(line.every((c, m) => m === 0 || c !== null || line[m - 1] === null));
  assert.equal(frame.nifty.length, 375);
});
