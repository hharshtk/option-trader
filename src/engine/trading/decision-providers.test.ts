import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TRADING_CONFIG, mergeTradingConfig } from "../../lib/engine/trading.ts";
import { createDecisionProviders, createLiquidDecisions, QUESTIONS } from "./decision.ts";

// Liquid's answer to the trader's questions, as it came back on 17 November 2026 (trimmed).
const LIQUID_ANSWER = {
  model: "d1.2-ultra",
  answers: {
    take_trade: { type: "noul", noul: 0.818 },
    regime: { type: "choice", choice: "trend_down", probabilities: { trend_up: 0.1, trend_down: 0.67, range: 0.06, chop: 0.17 }, confidence: 0.56 },
    quality: { type: "score", score: 1.36, legend: { "0": "Fragile", "1": "Mixed", "2": "Broad" }, probabilities: { "0": 0.09, "1": 0.45, "2": 0.45 } },
  },
  usage: { input_tokens: 1330, output_tokens: 0, cost: 0.00005586 },
};

test("Liquid: sends the trader's questions with the key, and reads the same answers as OpenRouter's", async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(LIQUID_ANSWER), { status: 200 });
  }) as unknown as typeof fetch;
  const liquid = createLiquidDecisions("secret", fetcher);
  assert.equal(liquid.ready, true);
  const answer = await liquid.ask({ model: "d1.2-ultra", state: { time_ist: "10:00" }, timeoutMs: 4_000 });
  assert.equal(sent[0].url, "https://api.liquid.ai/decisions/v1/systemone");
  assert.equal((sent[0].init.headers as Record<string, string>).Authorization, "Bearer secret");
  const body = JSON.parse(String(sent[0].init.body));
  assert.deepEqual(body.questions, JSON.parse(JSON.stringify(QUESTIONS)));
  assert.deepEqual(body.state, { time_ist: "10:00" });
  assert.equal(answer.probability, 0.818);
  assert.equal(answer.regime, "trend_down");
  assert.equal(answer.quality, 0.68);
  assert.equal(answer.inputTokens, 1330, "Liquid's input_tokens");
  assert.equal(answer.model, "d1.2-ultra");
});

test("Liquid: an HTTP error or a missing key is an error, never an answer", async () => {
  const failing = createLiquidDecisions("secret", (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch);
  await assert.rejects(failing.ask({ model: "d1.2-ultra", state: {}, timeoutMs: 1_000 }), /HTTP 429/);
  const missing = createLiquidDecisions(undefined);
  assert.equal(missing.ready, false);
  await assert.rejects(missing.ask({ model: "d1.2-ultra", state: {}, timeoutMs: 1_000 }), /LIQUID_API_KEY/);
});

test("one client per provider, ready when its key is set", () => {
  const providers = createDecisionProviders({ OPENROUTER_API_KEY: "a", LIQUID_API_KEY: "" });
  assert.equal(providers.openrouter.ready, true);
  assert.equal(providers.liquid.ready, false);
});

test("switching provider picks that provider's default model, unless a model is given", () => {
  assert.equal(DEFAULT_TRADING_CONFIG.decision.provider, "openrouter");
  const liquid = mergeTradingConfig(DEFAULT_TRADING_CONFIG, { decision: { provider: "liquid" } });
  assert.ok(liquid.ok && liquid.config.decision.provider === "liquid" && liquid.config.decision.model === "d1.2-ultra");
  const named = mergeTradingConfig(DEFAULT_TRADING_CONFIG, { decision: { provider: "liquid", model: "d1.1" } });
  assert.ok(named.ok && named.config.decision.model === "d1.1");
  assert.equal(mergeTradingConfig(DEFAULT_TRADING_CONFIG, { decision: { provider: "other" } }).ok, false);
  // Settings saved before providers existed load as OpenRouter.
  const old = mergeTradingConfig(DEFAULT_TRADING_CONFIG, { decision: { mode: "gate", model: "perplexity/pplx-decider-v1.3:free" } });
  assert.ok(old.ok && old.config.decision.provider === "openrouter");
});
