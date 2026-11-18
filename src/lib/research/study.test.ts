import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getParquetStore } from "../db/parquet-store.ts";
import { getFileStore } from "../storage.ts";
import { CANDLE_COLUMNS, DAILY_COLUMNS, historyKey, dailyKey } from "./candle-history.ts";
import { optionCostPoints, futuresCostPoints } from "./costs.ts";
import { NIFTY_CONSTITUENTS, NIFTY_KEY, VIX_KEY, sessionRules, type DayFrame } from "./day-frames.ts";
import { runStudy, storeInputs, studyId } from "./run-study.ts";
import { dayRange, measure, verdictOf } from "./stats.ts";
import { StudyAccumulator, firings, windowBars } from "./study.ts";
import { createStudyStore } from "./study-store.ts";
import { DEFAULT_SIGNAL_PARAMS } from "../strategies/signals.ts";
import { defaultSpec, checkSpec } from "./types.ts";

/** A day where NIFTY follows `path` minute by minute. */
function frame(date: string, path: number[]): DayFrame {
  const open = Date.parse(`${date}T09:15:00+05:30`);
  const nifty = Array.from({ length: 375 }, (_, m) => path[Math.min(m, path.length - 1)]);
  return { date, open, rules: sessionRules(date), session: null as never, nifty, vix: new Array(375).fill(14) };
}

test("the entry window maps to the bars the trader can act on", () => {
  // Read 1.5 s after a minute closes: 09:25–14:45 means bars 09:24 (index 9) to 14:43 (index 328).
  assert.deepEqual(windowBars({ from: "09:25", until: "14:45" }), { first: 9, last: 328 });
  assert.deepEqual(windowBars({ from: "09:15", until: "15:29" }), { first: 0, last: 372 });
});

test("firings skip the holding time after each one and never exit into the closing auction", () => {
  const day = frame("2026-11-16", Array.from({ length: 375 }, (_, m) => 25_000 + m));
  const votes = new Int8Array(375).fill(1);
  const fired = firings(day, votes, 5, { from: "09:25", until: "14:45" });
  assert.equal(fired[0].at, day.open + 9 * 60_000);
  assert.equal(fired[1].at - fired[0].at, 5 * 60_000);
  assert.ok(fired.every((f) => f.points === 5));
  // A window running to the end of the day: exits stop at 15:14 with the auction, 15:29 before it.
  const late = firings(day, votes, 15, { from: "15:00", until: "15:29" });
  assert.ok(late.every((f) => f.at + 15 * 60_000 <= day.open + 359 * 60_000));
  const before = frame("2026-07-31", day.nifty as number[]);
  assert.ok(firings(before, votes, 15, { from: "15:00", until: "15:29" }).length > late.length);
});

test("day-resampled ranges are deterministic, and span zero when whole days disagree", () => {
  const days = Array.from({ length: 40 }, (_, i) => ({ points: (i % 2 ? 1 : -1) * 30, firings: 10 }));
  assert.deepEqual(dayRange(days), dayRange(days));
  const [lo, hi] = dayRange(days)!;
  assert.ok(lo < 0 && hi > 0);
});

test("verdicts", () => {
  const cost = 4;
  const firingsOn = (n: number, value: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ day: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, points: value(i) }));
  const strong = measure(firingsOn(400, (i) => 10 + (i % 3)), cost, 16);
  assert.equal(verdictOf(strong, cost, strong), "Edge after costs");
  const small = measure(firingsOn(400, (i) => 2 + (i % 2)), cost, 16);
  assert.equal(verdictOf(small, cost, small), "Predicts, costs eat it");
  const noise = measure(firingsOn(400, (i) => (i % 2 ? 7 : -7)), cost, 16);
  assert.equal(verdictOf(noise, cost, noise), "No edge after costs");
  const wrong = measure(firingsOn(400, () => -3), cost, 16);
  assert.equal(verdictOf(wrong, cost, wrong), "Reliably wrong");
  assert.equal(verdictOf(measure(firingsOn(10, () => 50), cost, 16), cost, null), "Too few firings");
  // An edge that the later days don't share isn't called one.
  assert.notEqual(verdictOf(strong, cost, measure(firingsOn(100, () => -1), cost, 16)), "Edge after costs");
});

test("a planted edge is found and a random one isn't", () => {
  const spec = defaultSpec("momentum", 5, "2026-01-01", "2026-03-31");
  const make = (planted: boolean) => {
    const study = new StudyAccumulator(spec, "test-study-1");
    let seed = 7;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    for (let d = 0; d < 60; d += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
      const votes = new Int8Array(375).map(() => (random() < 0.2 ? (random() < 0.5 ? 1 : -1) : 0));
      const path = [25_000];
      for (let m = 1; m < 375; m += 1) path.push(path[m - 1] + (random() - 0.5) * 8 + (planted ? votes[Math.max(0, m - 3)] * 3 : 0));
      const all = { breadth: votes, lead: votes, momentum: votes, agree: votes };
      study.add(frame(date, path), all);
    }
    return study.summary(4, 16).find((r) => r.signal === "momentum" && r.horizon === 5 && r.slice_kind === "all")!;
  };
  const planted = make(true);
  const random = make(false);
  assert.ok(planted.lo! > 0, `planted edge range ${planted.lo}..${planted.hi}`);
  assert.ok(random.lo! < 0 && random.hi! > 0, `random range ${random.lo}..${random.hi}`);
});

test("costs in NIFTY points match Dhan's charges", () => {
  // ₹63 charges + ₹65 slippage on 65 units at ₹100, at delta 0.5.
  assert.ok(Math.abs(optionCostPoints({ lot: 65, premium: 100, slippage: 0.5, delta: 0.5 }) - 3.93) < 0.01);
  assert.ok(Math.abs(futuresCostPoints({ lot: 65, spread: 1 }, 25_400) - 16.1) < 0.1);
});

test("specs are checked and filled from the defaults", () => {
  const fallback = defaultSpec("agree", 10, "2025-11-03", "2026-11-17");
  assert.deepEqual(checkSpec(undefined, fallback), { ok: true, spec: { ...fallback, signalParams: DEFAULT_SIGNAL_PARAMS } });
  assert.equal(checkSpec({ primary: { signal: "agree", horizon: 0 } }, fallback).ok, false);
  assert.equal(checkSpec({ window: { from: "15:00", until: "10:00" } }, fallback).ok, false);
  const changed = checkSpec({ primary: { signal: "lead", horizon: 3 }, signals: ["lead"] } as never, fallback);
  assert.ok(changed.ok && changed.spec.primary.signal === "lead" && changed.spec.signals.length === 4);
  // A strategy's own holding time is measured, whatever it is.
  const held = checkSpec({ primary: { signal: "agree", horizon: 30 } }, fallback);
  assert.ok(held.ok && held.spec.horizons.includes(30) && held.spec.horizons.includes(10));
  // A strategy's test measures only its own signal, with its own numbers, checked by the engine's rules.
  const strategy = checkSpec({ primary: { signal: "momentum", horizon: 20 }, strategy: { id: "momentum-held-abcd", version: 2, name: "Momentum held" }, signalParams: { momentum: { minutes: 20, pct: 0.2 } } } as never, fallback);
  assert.ok(strategy.ok);
  assert.deepEqual(strategy.spec.signals, ["momentum"]);
  assert.equal(strategy.spec.signalParams!.momentum.minutes, 20);
  assert.equal(strategy.spec.signalParams!.breadth.stocks, DEFAULT_SIGNAL_PARAMS.breadth.stocks);
  assert.equal(checkSpec({ signalParams: { momentum: { pct: 50 } } } as never, fallback).ok, false);
});

test("a whole study runs on stored files, is stored, and gives the same id and results twice", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "study-"));
  const parquet = getParquetStore(root);
  const files = getFileStore(root);
  // Twenty-five synthetic days: NIFTY drifts, its stocks wobble around their previous close.
  const keys = [NIFTY_KEY, VIX_KEY, ...NIFTY_CONSTITUENTS.map((c) => c.key)];
  const rows: Record<string, number | string>[] = [];
  const daily: Record<string, number | string>[] = [];
  let seed = 11;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  for (let d = 0; d < 26; d += 1) {
    const date = new Date(Date.UTC(2026, 9, 1 + d)).toISOString().slice(0, 10);
    const open = Date.parse(`${date}T09:15:00+05:30`);
    for (const [i, key] of keys.entries()) {
      let price = key === NIFTY_KEY ? 25_000 : key === VIX_KEY ? 14 : 100 + i;
      daily.push({ key, date, open: price, high: price, low: price, close: price, volume: 0 });
      for (let m = 0; m < 375; m += 1) {
        price *= 1 + (random() - 0.5) * 0.002;
        rows.push({ key, t: open + m * 60_000, open: price, high: price, low: price, close: price, volume: 0 });
      }
    }
  }
  await parquet.write(historyKey("2026-10"), CANDLE_COLUMNS, rows);
  await parquet.write(dailyKey("2026"), DAILY_COLUMNS, daily);

  const spec = defaultSpec("agree", 10, "2026-10-01", "2026-10-31");
  const context = { inputs: storeInputs(parquet, files), namespace: "test", version: "test", code: { signals: "s", study: "t" }, now: () => 1 };
  const first = await runStudy(spec, context);
  const second = await runStudy(spec, context);
  assert.equal(first.manifest.id, second.manifest.id);
  assert.equal(first.manifest.results.hash, second.manifest.results.hash);
  assert.equal(first.manifest.data.days, 25, "the first day has no previous close");
  assert.deepEqual(first.manifest.data.dropped, [{ date: "2026-10-01", reason: "No official close for the day before" }]);
  assert.equal(first.manifest.id, studyId(spec, first.manifest.data.sources, context.code));

  const store = createStudyStore(parquet, files, "test");
  assert.equal(await store.exists(first.manifest.id), false);
  await store.write(first);
  assert.equal(await store.exists(first.manifest.id), true);
  const [listed] = await store.list();
  assert.equal(listed.id, first.manifest.id);
  const detail = (await store.read(first.manifest.id))!;
  assert.equal(detail.summary.length, first.summary.length);
  assert.equal(detail.events.length, first.events.filter((e) => e.signal === "agree" && e.horizon === 10).length);
  await store.writeCheck({ id: first.manifest.id, at: 5, version: "test", matched: true, hash: first.manifest.results.hash, sameInputs: true });
  assert.equal((await store.checks(first.manifest.id))[0].matched, true);

  // Changing a data file changes the id: the study is pinned to its inputs.
  await parquet.write(historyKey("2026-10"), CANDLE_COLUMNS, rows.slice(0, rows.length - 1));
  assert.notEqual((await runStudy(spec, context)).manifest.id, first.manifest.id);
});
