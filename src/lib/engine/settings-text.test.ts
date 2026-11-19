import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSettings } from "./settings-text.ts";
import { DEFAULT_TRADING_CONFIG } from "./trading.ts";

const value = (groups: ReturnType<typeof describeSettings>, label: string) => groups.flatMap((g) => g.rows).find(([l]) => l === label)?.[1];

test("lists the settings in force as short label and value pairs", () => {
  const groups = describeSettings({ config: DEFAULT_TRADING_CONFIG, moveHistory: { days: 20, from: "2026-10-19", to: "2026-11-17" } });
  assert.deepEqual(groups.map((g) => g.title), ["Entries", "Exits · Standard", "Limits", "AI check", "Fills"]);
  assert.equal(value(groups, "Entries"), "off");
  assert.equal(value(groups, "Signal"), "Two or more agree");
  assert.equal(value(groups, "Option"), "ATM, 1 lot (65)");
  assert.equal(value(groups, "Window"), "09:25–14:45");
  assert.equal(value(groups, "Stop / target"), "1× / 2× typical move");
  assert.equal(value(groups, "Move from"), "last 20 days, same time");
  assert.equal(value(groups, "Daily loss"), "₹3,000");
  assert.equal(value(groups, "Mode"), "can turn down, ≥ 0.55, trend veto");
  // Every value is short: stats, not sentences.
  for (const [label, text] of groups.flatMap((g) => g.rows)) assert.ok(text.length <= 60, `${label}: ${text}`);
});

test("follows what is set: a rule, scalping, fixed exits, the AI off", () => {
  const config = structuredClone(DEFAULT_TRADING_CONFIG);
  Object.assign(config.strategy, { rule: "trend", costCheck: true, exitIn: "rupees", targetNet: 400, stopNet: 250, strikeOffset: 1 });
  config.decision.mode = "off";
  config.armed = true;
  const groups = describeSettings({ config, moveHistory: null });
  assert.equal(value(groups, "Entries"), "on");
  assert.equal(value(groups, "Rule"), "Trend day");
  assert.equal(value(groups, "Signal"), undefined);
  assert.equal(value(groups, "Option"), "1 OTM, 1 lot (65)");
  assert.equal(value(groups, "Cost check"), "on (3×)");
  assert.equal(value(groups, "Take / cut"), "₹400 / ₹250 after charges");
  assert.equal(value(groups, "Mode"), "off");
  config.strategy.exitIn = "percent";
  config.strategy.exitsFrom = "fixed";
  assert.equal(value(describeSettings({ config, moveHistory: null }), "Stop / target"), "20% / 30%");
});
