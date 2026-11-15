import assert from "node:assert/strict";
import test from "node:test";
import { createSessionCalendar } from "./session-calendar.ts";

const calendar = createSessionCalendar();
/** An instant given as IST wall-clock time. */
const ist = (value: string) => Date.parse(`${value}+05:30`);

test("IST date doesn't depend on the server's time zone", () => {
  // 20:00 UTC on the 15th is 01:30 IST on the 16th.
  assert.equal(calendar.istDate(Date.parse("2026-11-15T20:00:00Z")), "2026-11-16");
});

test("weekdays trade 09:15 to 15:30 IST, close exclusive", () => {
  const session = calendar.session("NSE_FNO", "2026-11-16");
  assert.ok(session);
  assert.equal(session.open, ist("2026-11-16T09:15:00"));
  assert.equal(session.close, ist("2026-11-16T15:30:00"));

  assert.equal(calendar.phaseAt("NSE_FNO", ist("2026-11-16T09:14:59")), "closed");
  assert.equal(calendar.phaseAt("NSE_FNO", ist("2026-11-16T09:15:00")), "open");
  assert.equal(calendar.phaseAt("NSE_FNO", ist("2026-11-16T15:29:59")), "open");
  assert.equal(calendar.phaseAt("NSE_FNO", ist("2026-11-16T15:30:00")), "closed");
});

test("cash equity has a pre-open; F&O doesn't", () => {
  assert.equal(calendar.phaseAt("NSE_EQ", ist("2026-11-16T09:05:00")), "pre-open");
  assert.equal(calendar.phaseAt("NSE_FNO", ist("2026-11-16T09:05:00")), "closed");
});

test("weekends and holidays are closed", () => {
  assert.equal(calendar.session("IDX_I", "2026-11-14"), null, "Saturday");
  assert.equal(calendar.session("IDX_I", "2026-11-24"), null);
  assert.equal(calendar.holiday("NSE_FNO", "2026-11-24"), "Prakash Gurpurb Sri Guru Nanak Dev");
  assert.equal(calendar.holiday("NSE_FNO", "2026-01-15")?.startsWith("Municipal"), true);
});

test("a special session without published times counts as closed", () => {
  assert.equal(calendar.session("NSE_FNO", "2026-11-08"), null);
});

test("next session skips weekends and holidays", () => {
  // Friday after the close → Monday.
  assert.equal(calendar.nextSession("NSE_FNO", ist("2026-11-20T16:00:00"))?.date, "2026-11-23");
  // Monday evening, Tuesday 24th is a holiday → Wednesday.
  assert.equal(calendar.nextSession("NSE_FNO", ist("2026-11-23T18:00:00"))?.date, "2026-11-25");
  // During a session, the current one.
  assert.equal(calendar.nextSession("NSE_FNO", ist("2026-11-25T10:00:00"))?.date, "2026-11-25");
});

test("knows which years it has holidays for, and rejects unknown segments", () => {
  assert.equal(calendar.isCovered("2026-12-31"), true);
  assert.equal(calendar.isCovered("2027-01-04"), false);
  assert.throws(() => calendar.session("MCX_COMM", "2026-11-16"), /Unknown segment/);
});
