// Which of Dhan's failures stop live trading for the day. No network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DhanApiError } from "../../lib/dhan/errors.ts";
import { brokerError } from "./dhan-broker.ts";

test("an IP Dhan won't take orders from stops live for the day", () => {
  const failure = brokerError(new DhanApiError("Invalid IP", { status: 400, code: "DH-905" }));
  assert.equal(failure.fatal, true);
  assert.equal(failure.unknown, false);
  assert.equal(failure.message, "Invalid IP (DH-905)");
  assert.equal(brokerError(new DhanApiError("Static IP not whitelisted", { status: 400 })).fatal, true);
});

test("a refusal about this one order doesn't stop the day; no answer at all may have gone through", () => {
  assert.equal(brokerError(new DhanApiError("Insufficient funds", { status: 400, code: "DH-906" })).fatal, false);
  const silent = brokerError(new DhanApiError("Could not reach Dhan (timed out after 10s)", { status: 0 }));
  assert.equal(silent.fatal, false);
  assert.equal(silent.unknown, true);
});
