// Scores the scalp lab's triggers on a recorded day, from its journal:
//
//   npm run scalp:lab -- 2026-11-18
//
// The same code the engine runs live, fed the day's frames in order. The NIFTY future and the
// options come from the journal's own instrument records; the pretend trades use the nearest
// expiry. Prints each trigger's record at each hold, after charges.

import { open } from "node:fs/promises";
import path from "node:path";
import { parseFrame } from "../../lib/live/feed/packets.ts";
import { MAGIC, readRecords } from "../journal/format.ts";
import { createSessionCalendar } from "../market/session-calendar.ts";
import type { ChainRow } from "./contracts.ts";
import { createMarketView } from "./market.ts";
import { createScalpLab } from "./scalp-lab.ts";

const date = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
  console.error("Usage: npm run scalp:lab -- YYYY-MM-DD");
  process.exit(1);
}
const file = path.join(process.env.ENGINE_DATA_DIR ?? "data/engine", "journal", `${date}.bin`);
const session = createSessionCalendar().session("NSE_FNO", date);
if (!session) {
  console.error(`${date} is not a trading day`);
  process.exit(1);
}

interface Described {
  key: string;
  kind: "future" | "option";
  underlying: string;
  name: string;
  expiry: string;
  strike?: number;
  type?: "CE" | "PE";
  lotSize: number;
}
const instruments = new Map<string, Described>();
const market = createMarketView();
const lab = createScalpLab();
let started = false;

/** Sets the lab up once the journal has said which future and options it carries. */
function start() {
  const nifty = [...instruments.values()].filter((i) => i.underlying === "NIFTY" && i.expiry >= date);
  const future = nifty.filter((i) => i.kind === "future").sort((a, b) => a.expiry.localeCompare(b.expiry))[0];
  const options = nifty.filter((i) => i.kind === "option" && i.strike !== undefined && i.type);
  const expiry = options.map((o) => o.expiry).sort()[0];
  if (!future || !expiry) return;
  const rows = new Map<number, ChainRow>();
  for (const o of options) {
    if (o.expiry !== expiry) continue;
    const row = rows.get(o.strike!) ?? { strike: o.strike! };
    const [, securityId] = o.key.split(":");
    row[o.type!] = { securityId, feedKey: o.key, name: o.name, strike: o.strike!, type: o.type!, expiry, lotSize: o.lotSize, tickSize: 0.05 };
    rows.set(o.strike!, row);
  }
  const chain = [...rows.values()].sort((a, b) => a.strike - b.strike);
  lab.reset({
    session: { open: session!.open, close: session!.close },
    future: () => ({ key: future.key, name: future.name }),
    chain: () => chain,
    spotKey: "IDX_I:13",
    quote: (key) => market.get(key),
  });
  started = true;
  console.log(`${date}: ${future.name}, options expiring ${expiry} (${rows.size} strikes)`);
}

const handle = await open(file, "r").catch(() => null);
if (!handle) {
  console.error(`No journal at ${file}`);
  process.exit(1);
}
const CHUNK = 64 << 20;
let position = 0;
let carry = Buffer.alloc(0);
for (;;) {
  const chunk = Buffer.allocUnsafe(CHUNK);
  const { bytesRead } = await handle.read(chunk, 0, CHUNK, position);
  if (bytesRead === 0) break;
  const startAt = position === 0 ? MAGIC.length : 0;
  position += bytesRead;
  const bytes = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
  const end = readRecords(bytes, startAt, (record) => {
    if (record.type === "control") {
      const items = record.control?.kind === "instruments" ? (record.control as { items?: unknown }).items : null;
      if (Array.isArray(items)) {
        for (const item of items as Described[]) if (item && (item.kind === "future" || item.kind === "option")) instruments.set(item.key, item);
        if (!started) start();
      }
      return;
    }
    if (!record.frame) return;
    for (const packet of parseFrame(record.frame)) {
      lab.onPacket(packet, record.recvTs);
      market.apply(packet, record.recvTs);
    }
    lab.advance(record.recvTs);
  });
  carry = Buffer.from(bytes.subarray(end));
}
await handle.close();
if (!started) {
  console.error("The journal has no NIFTY future and options recorded with their details (from 18 November 2026).");
  process.exit(1);
}

const status = lab.status();
const rupees = (v: number) => `${v < 0 ? "−" : "+"}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
console.log(`\nPretend trades in one lot of the at-the-money option, after charges and slippage:\n`);
console.log(`${"".padEnd(22)}${status.holds.map((h) => `${h < 60 ? `${h} s` : `${h / 60} min`} hold`.padStart(36)).join("")}`);
for (const t of status.triggers) {
  const cells = t.cells.map((c) => (c.trades ? `${c.trades} trades, ${Math.round((c.wins / c.trades) * 100)}% won, ${rupees(c.net / c.trades)} each` : "no trades").padStart(36));
  console.log(`${t.name.padEnd(22)}${cells.join("")}`);
}
