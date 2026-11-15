import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseEnv } from "node:util";
import { createDhanFeed, type Credentials, type FeedState } from "./dhan-feed.ts";
import { instrumentKey, parseInstrumentKey, type Instrument, type Packet } from "./packets.ts";

const ENV_FILE = new URL("../../.env.local", import.meta.url);
const CAPTURE_DIR = new URL("./captures/", import.meta.url);
const HOST = "127.0.0.1";
const FLUSH_MS = 250;
const HEARTBEAT_MS = 15_000;
const UNSUBSCRIBE_GRACE_MS = 30_000;
const MAX_INSTRUMENTS = 1_000;
const MAX_INSTRUMENTS_PER_CLIENT = 200;

function readEnvFile(): Record<string, string | undefined> {
  return existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
}

const startupEnv = { ...readEnvFile(), ...process.env };
const PORT = Number(startupEnv.FEED_PORT ?? 3010);
const CAPTURE = startupEnv.FEED_CAPTURE === "1";

// Re-read on every connect, so a renewed token only needs a reload, not a restart.
function readCredentials(): Credentials {
  const env = { ...process.env, ...readEnvFile() };
  const clientId = env.DHAN_CLIENT_ID?.trim();
  const accessToken = env.DHAN_ACCESS_TOKEN?.trim();
  if (!clientId || !accessToken) {
    throw new Error("DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN must be set in .env.local");
  }
  return { clientId, accessToken };
}

interface Quote {
  ltp?: number;
  ltt?: number;
  prevClose?: number;
  at: number;
}

interface Client {
  res: ServerResponse;
  keys: Set<string>;
}

const quotes = new Map<string, Quote>();
const dirty = new Set<string>();
const refs = new Map<string, number>();
const pendingUnsubscribe = new Map<string, ReturnType<typeof setTimeout>>();
const clients = new Set<Client>();
const packetCounts: Record<string, number> = {};
const reportedUnknown = new Set<number>();
let feedState: FeedState = { state: "idle" };
let lastTickAt: number | null = null;
let capture: WriteStream | null = null;

function log(message: string) {
  const time = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  console.log(`[feed ${time}] ${message}`);
}

const roundPrice = (value: number) => Math.round(value * 100) / 100;

function handlePacket(packet: Packet, receivedAt: number) {
  packetCounts[packet.kind] = (packetCounts[packet.kind] ?? 0) + 1;

  switch (packet.kind) {
    case "ticker":
    case "quote":
      lastTickAt = receivedAt;
      update(packet.key, { ltp: roundPrice(packet.ltp), ltt: packet.ltt }, receivedAt);
      break;
    case "prevClose":
      update(packet.key, { prevClose: roundPrice(packet.prevClose) }, receivedAt);
      break;
    case "disconnect":
      log(`Dhan sent disconnect code ${packet.reason}`);
      break;
    case "unknown":
      if (!reportedUnknown.has(packet.code)) {
        reportedUnknown.add(packet.code);
        log(`unparsed packet code ${packet.code} (${packet.length} bytes${packet.key ? `, ${packet.key}` : ""})`);
      }
      break;
  }
}

function update(key: string, patch: Omit<Quote, "at">, at: number) {
  if (!refs.has(key) && !pendingUnsubscribe.has(key)) return;
  quotes.set(key, { ...quotes.get(key), ...patch, at });
  dirty.add(key);
}

function captureFrame(frame: ArrayBuffer, receivedAt: number) {
  if (!capture) {
    mkdirSync(CAPTURE_DIR, { recursive: true });
    const day = new Date(receivedAt).toISOString().slice(0, 10);
    capture = createWriteStream(new URL(`${day}.jsonl`, CAPTURE_DIR), { flags: "a" });
  }
  capture.write(`${JSON.stringify({ t: receivedAt, hex: Buffer.from(frame).toString("hex") })}\n`);
}

const feed = createDhanFeed({
  readCredentials,
  onPacket: handlePacket,
  onState(next) {
    feedState = next;
    log(
      next.state === "reconnecting"
        ? `reconnecting (attempt ${next.attempt})`
        : next.state === "stopped"
          ? `stopped: ${next.reason}`
          : next.state,
    );
    for (const client of clients) sendEvent(client.res, "status", statusPayload());
  },
  onFrame: CAPTURE ? captureFrame : undefined,
  log,
});

function statusPayload() {
  return { ...feedState, lastTickAt };
}

function sendEvent(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function acquire(instruments: Instrument[]) {
  const added: Instrument[] = [];
  for (const instrument of instruments) {
    const key = instrumentKey(instrument);
    clearTimeout(pendingUnsubscribe.get(key));
    pendingUnsubscribe.delete(key);
    const count = refs.get(key) ?? 0;
    if (count === 0 && refs.size >= MAX_INSTRUMENTS) {
      log(`instrument limit (${MAX_INSTRUMENTS}) reached; not subscribing ${key}`);
      continue;
    }
    refs.set(key, count + 1);
    if (count === 0) added.push(instrument);
  }
  if (added.length > 0) feed.subscribe(added);
}

// A short grace period keeps moving between sections from churning Dhan subscriptions.
function release(instruments: Instrument[]) {
  for (const instrument of instruments) {
    const key = instrumentKey(instrument);
    const count = (refs.get(key) ?? 0) - 1;
    if (count > 0) {
      refs.set(key, count);
      continue;
    }
    refs.delete(key);
    pendingUnsubscribe.set(
      key,
      setTimeout(() => {
        pendingUnsubscribe.delete(key);
        if (refs.has(key)) return;
        quotes.delete(key);
        feed.unsubscribe([instrument]);
      }, UNSUBSCRIBE_GRACE_MS),
    );
  }
}

setInterval(() => {
  if (dirty.size === 0) return;
  for (const client of clients) {
    const payload: Record<string, Quote> = {};
    for (const key of dirty) {
      const quote = quotes.get(key);
      if (quote && client.keys.has(key)) payload[key] = quote;
    }
    if (Object.keys(payload).length > 0) sendEvent(client.res, "quotes", payload);
  }
  dirty.clear();
}, FLUSH_MS);

function stream(req: IncomingMessage, res: ServerResponse, url: URL) {
  const instruments = [...new Set((url.searchParams.get("i") ?? "").split(","))]
    .map(parseInstrumentKey)
    .filter((instrument): instrument is Instrument => instrument !== null)
    .slice(0, MAX_INSTRUMENTS_PER_CLIENT);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");

  const client: Client = { res, keys: new Set(instruments.map(instrumentKey)) };
  clients.add(client);
  acquire(instruments);
  sendEvent(res, "status", statusPayload());

  const snapshot: Record<string, Quote> = {};
  for (const key of client.keys) {
    const quote = quotes.get(key);
    if (quote) snapshot[key] = quote;
  }
  if (Object.keys(snapshot).length > 0) sendEvent(res, "quotes", snapshot);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
    release(instruments);
  });
}

function health(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ...statusPayload(),
      clients: clients.size,
      instruments: refs.size,
      dhanSubscriptions: feed.subscriptionCount(),
      packets: packetCounts,
      capture: CAPTURE,
    }),
  );
}

// Browsers attach Origin to cross-site requests and the Next server's fetch doesn't, so this
// keeps web pages from driving the feed. The Host check blocks DNS rebinding.
function isTrusted(req: IncomingMessage) {
  if (req.headers.origin) return false;
  return req.headers.host === `${HOST}:${PORT}` || req.headers.host === `localhost:${PORT}`;
}

const server = createServer((req, res) => {
  if (!isTrusted(req)) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/stream") return stream(req, res, url);
  if (req.method === "GET" && url.pathname === "/health") return health(res);
  if (req.method === "POST" && url.pathname === "/reload") {
    log("reload requested");
    feed.reload();
    res.writeHead(204).end();
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}${CAPTURE ? ", recording raw frames" : ""}`);
  log("connects to Dhan when the first browser tab subscribes");
});

process.on("SIGHUP", () => {
  log("SIGHUP: reloading credentials");
  feed.reload();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal}: disconnecting`);
    feed.shutdown();
    capture?.end();
    server.close();
    process.exit(0);
  });
}
