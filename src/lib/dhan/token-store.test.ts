import assert from "node:assert/strict";
import test from "node:test";
import { createTokenStore, TOKEN_KEY, TOKEN_TTL_SECONDS } from "./token-store.ts";

// A fake Upstash REST endpoint backed by a Map. `fail` makes every call return HTTP 500.
function fakeRedis() {
  const data = new Map<string, string>();
  const calls: unknown[][] = [];
  const state = { fail: false };
  const fetch = (async (_url: string, init?: RequestInit) => {
    const args = JSON.parse(String(init?.body)) as unknown[];
    calls.push(args);
    if (state.fail) return new Response(JSON.stringify({ error: "down" }), { status: 500 });
    const [command, key, value] = args as [string, string, string];
    const result = command === "GET" ? (data.get(key) ?? null) : (data.set(key, value), "OK");
    return new Response(JSON.stringify({ result }));
  }) as typeof globalThis.fetch;
  return { data, calls, state, fetch };
}

function setup(env?: string) {
  const redis = fakeRedis();
  let clock = 0;
  const errors: string[] = [];
  const store = createTokenStore({
    url: "https://redis.example/",
    token: "secret",
    envToken: () => env,
    fetch: redis.fetch,
    now: () => clock,
    onError: (message) => errors.push(message),
  });
  return { store, redis, errors, advance: (ms: number) => (clock += ms) };
}

test("falls back to the env token when Redis is not configured", async () => {
  const store = createTokenStore({ envToken: () => " env-token " });
  assert.equal(store.configured, false);
  assert.equal(await store.refresh(), "env-token");
  assert.equal(store.source(), "env");
  await assert.rejects(store.save("x"), /isn't configured/);
});

test("a token in Redis wins over the env token", async () => {
  const { store, redis } = setup("env-token");
  redis.data.set(TOKEN_KEY, "redis-token");
  assert.equal(store.current(), "env-token");
  assert.equal(await store.refresh(), "redis-token");
  assert.equal(store.source(), "redis");
});

test("save stores the token with a 24-hour expiry and uses it at once", async () => {
  const { store, redis } = setup("env-token");
  await store.save("  new-token ");
  assert.deepEqual(redis.calls.at(-1), ["SET", TOKEN_KEY, "new-token", "EX", TOKEN_TTL_SECONDS]);
  assert.equal(TOKEN_TTL_SECONDS, 86_400);
  assert.equal(store.current(), "new-token");
});

test("reads Redis at most once per cache window", async () => {
  const { store, redis, advance } = setup();
  redis.data.set(TOKEN_KEY, "a");
  await Promise.all([store.refresh(), store.refresh()]);
  await store.refresh();
  assert.equal(redis.calls.length, 1);

  redis.data.set(TOKEN_KEY, "b");
  advance(30_000);
  assert.equal(await store.refresh(), "b");
  assert.equal(redis.calls.length, 2);
});

test("an expired Redis key falls back to the env token", async () => {
  const { store, redis, advance } = setup("env-token");
  redis.data.set(TOKEN_KEY, "redis-token");
  await store.refresh();
  redis.data.delete(TOKEN_KEY);
  advance(30_000);
  assert.equal(await store.refresh(), "env-token");
  assert.equal(store.source(), "env");
});

test("keeps the last token when Redis is down, and reports the outage once", async () => {
  const { store, redis, errors, advance } = setup("env-token");
  redis.data.set(TOKEN_KEY, "redis-token");
  await store.refresh();

  redis.state.fail = true;
  advance(30_000);
  assert.equal(await store.refresh(), "redis-token");
  advance(30_000);
  await store.refresh();
  assert.equal(errors.length, 1);
  await assert.rejects(store.save("x"), /down/);
});

test("the command goes in the body, not the URL", async () => {
  const urls: string[] = [];
  const store = createTokenStore({
    url: "https://redis.example",
    token: "secret",
    fetch: (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ result: "OK" }));
    }) as typeof fetch,
  });
  await store.save("tok");
  assert.deepEqual(urls, ["https://redis.example"]);
});
