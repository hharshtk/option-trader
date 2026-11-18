import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { buildDays, DailyCloses, isFrame, NIFTY_CONSTITUENTS, type CandleColumns } from "../../lib/research/day-frames.ts";
import { dayVotes, firings } from "../../lib/research/study.ts";
import { defaultSpec, type DetailEvent, type GateAnswerRow, type StudyManifest } from "../../lib/research/types.ts";
import type { StudyInputs } from "../../lib/research/run-study.ts";
import type { DecisionProvider } from "../trading/decision.ts";
import { anonymize, contextKey, daysToWeeklyExpiry, runGatePass, summarizeGate } from "./gate.ts";
import { createAllowance } from "./quota.ts";

// The parity fixture: 16 and 17 November 2026, candles and official closes.
interface Fixture {
  keys: string[];
  days: Record<string, { candles: Record<string, (number[] | null)[]> }>;
  daily: { key: string; date: string; close: number }[];
}
const fixture = JSON.parse(gunzipSync(readFileSync(path.join(import.meta.dirname, "../../lib/research/fixtures/parity-2026-11-16-17.json.gz"))).toString()) as Fixture;
const DATES = ["2026-11-16", "2026-11-17"];

function columns(): CandleColumns {
  const out = { keys: fixture.keys, k: [] as number[], t: [] as number[], open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[] };
  for (const date of DATES) {
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

const inputs: StudyInputs = { sources: async () => [], dailyCloses: async () => fixture.daily, month: async () => columns() };
const spec = defaultSpec("agree", 10, "2026-11-16", "2026-11-17");
const manifest = { id: "agree-10m-test000000", spec, costs: { optionPoints: 3.9, futuresPoints: 15, medianNifty: 25_300 } } as unknown as StudyManifest;
const frames = buildDays(columns(), new DailyCloses(fixture.daily), { from: spec.from, to: spec.to, breadthKeys: NIFTY_CONSTITUENTS.map((c) => c.key) }).filter(isFrame);
const events: DetailEvent[] = frames.flatMap((frame) => firings(frame, dayVotes(frame)!.agree!, 10, spec.window));

/** Answers long firings yes and short ones no, and records every context it was sent. */
function fakeProvider() {
  const sent: unknown[] = [];
  const provider: DecisionProvider = {
    ready: true,
    async ask({ state }) {
      sent.push(state);
      const long = JSON.stringify(state).includes("long: buy a call");
      return { probability: long ? 0.8 : 0.2, regime: "range", regimeProbabilities: null, quality: 0.5, model: "fake-model", inputTokens: 1, cost: 0 };
    },
  };
  return { provider, sent };
}

test("weekly expiry is the coming Tuesday", () => {
  assert.equal(daysToWeeklyExpiry("2026-11-17"), 0); // a Tuesday
  assert.equal(daysToWeeklyExpiry("2026-11-16"), 1);
  assert.equal(daysToWeeklyExpiry("2026-11-18"), 6);
});

test("the context sent never names the day: no dates, no contract, no NIFTY level", async () => {
  assert.ok(events.length >= 3, `the fixture days have ${events.length} firings`);
  const { provider, sent } = fakeProvider();
  await runGatePass({ manifest, events, inputs, provider, model: "fake-model", rule: { minProbability: 0.55, vetoAgainstRegime: true }, cached: new Map(), allowance: async () => ({ count: 99, reason: "" }), record: async () => {}, pauseMs: 0 });
  assert.equal(sent.length, events.length);
  for (const state of sent) {
    const text = JSON.stringify(state);
    assert.doesNotMatch(text, /2026|NOV|Nov|1[67]-11|-11-/, "no dates");
    assert.doesNotMatch(text, /\b2[45],?\d{3}\b/, "no NIFTY level");
    const s = state as ReturnType<typeof anonymize>;
    assert.match(s.proposal.contract, /^NIFTY (call|put), at the money/);
    assert.equal(s.nifty.last_15_one_minute_closes_in_points_from_now.at(-1), 0);
    assert.ok(s.time_ist >= "09:24" && s.time_ist <= "14:45", s.time_ist);
  }
});

test("a pass stops at the allowance, stores what it asked, and resumes without asking again", async () => {
  const first = fakeProvider();
  const stored: GateAnswerRow[] = [];
  let left = 2;
  const run1 = await runGatePass({
    manifest,
    events,
    inputs,
    provider: first.provider,
    model: "fake-model",
    rule: { minProbability: 0.55, vetoAgainstRegime: true },
    cached: new Map(),
    allowance: async () => ({ count: left--, reason: "quota" }),
    record: async (row) => void stored.push(row),
    pauseMs: 0,
  });
  assert.equal(run1.stopped, "quota");
  assert.equal(first.sent.length, 2);
  assert.equal(stored.length, 2);

  const second = fakeProvider();
  const run2 = await runGatePass({
    manifest,
    events,
    inputs,
    provider: second.provider,
    model: "fake-model",
    rule: { minProbability: 0.55, vetoAgainstRegime: true },
    cached: new Map(stored.map((row) => [row.key, row])),
    allowance: async () => ({ count: 99, reason: "" }),
    record: async (row) => void stored.push(row),
    pauseMs: 0,
  });
  assert.equal(run2.stopped, null);
  assert.equal(second.sent.length, events.length - 2, "the two answered firings aren't asked again");
  assert.equal(run2.answers.length, events.length);
  assert.equal(stored[0].key, contextKey("fake-model", first.sent[0]));
});

test("the summary splits firings by the trader's gate rule", () => {
  const row = (vote: number, points: number, probability: number, regime = "range"): GateAnswerRow => ({ key: `${vote}${points}${probability}`, at: 0, day: "2026-11-16", vote, points, probability, regime, quality: 0.5, model: "m", error: null });
  const answers = [row(1, 10, 0.8), row(1, -4, 0.3), row(-1, 6, 0.9, "trend_up"), row(-1, 2, 0.6), { ...row(1, 1, 0.5), probability: null, error: "timeout" }];
  const summary = summarizeGate(manifest, 5, answers, { provider: "openrouter", model: "m", rule: { minProbability: 0.55, vetoAgainstRegime: true }, version: "v", at: 1, stopped: null });
  assert.equal(summary.answered, 4);
  assert.equal(summary.failed, 1);
  // Approved: the long at 0.8 and the short at 0.6. Turned down: the long at 0.3 (too low) and the short against a rising regime.
  assert.equal(summary.approved.firings, 2);
  assert.equal(summary.approved.mean, 6);
  assert.equal(summary.turnedDown.firings, 2);
  assert.equal(summary.turnedDown.mean, 1);
  assert.equal(summary.byProbability.find((b) => b.band === "0.70 and over")!.firings, 2);
});

test("the allowance keeps the reserve even when OpenRouter's count lags behind", async () => {
  // OpenRouter keeps saying 32 are left while requests go out.
  const allowance = createAllowance({ read: async () => ({ used: 18, limit: 50, remaining: 32 }), reserve: 20 });
  let asked = 0;
  while ((await allowance.next()).count > 0) {
    allowance.counted();
    asked += 1;
  }
  assert.equal(asked, 12);
  // When OpenRouter's count is the lower one, it wins.
  let remaining = 25;
  const fresh = createAllowance({ read: async () => ({ used: 50 - remaining, limit: 50, remaining }), reserve: 20 });
  assert.equal((await fresh.next()).count, 5);
  // Live trading used four meanwhile: OpenRouter now says 21, below the local estimate of 25.
  remaining = 21;
  assert.equal((await fresh.next()).count, 1);
});
