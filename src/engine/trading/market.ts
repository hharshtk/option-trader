// The latest quote per instrument, as trading sees it: last price, the best bid and ask when the
// instrument streams in Full mode, and when each arrived on the market's clock. Fed from the same
// frames the journal records, so a replayed day shows trading exactly what the live day did.
//
// Option contracts with nothing on the feed (a replay of a day recorded before options were
// subscribed) get synthetic quotes built from 1-minute candles instead; those are marked.

import type { Packet } from "../../lib/live/feed/packets.ts";

export interface MarketQuote {
  key: string;
  ltp: number;
  /** Market time of the last price. */
  at: number;
  /** Best bid and ask, when the book is known and sane; else null. */
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  oi: number | null;
  volume: number | null;
  /**
   * Set when the quote comes from a 1-minute candle, not the feed: the open of that candle, so a
   * stop or target crossed inside the minute can be filled at its level.
   */
  candleOpen: number | null;
}

export interface MarketView {
  /** Applies a parsed packet. Returns the quote when the packet changed an instrument's price. */
  apply(packet: Packet, at: number): MarketQuote | null;
  /** Sets a price taken from a candle. */
  applyCandle(key: string, price: number, candleOpen: number, at: number): MarketQuote;
  get(key: string): MarketQuote | undefined;
  /** True when the instrument has a quote that came from the feed. */
  onFeed(key: string): boolean;
  clear(): void;
}

/** The feed sends prices as 32-bit floats (130.9 arrives as 130.89999); rupees have two decimals. */
const paise = (value: number) => Math.round(value * 100) / 100;

/** A book is usable when both sides are there and not crossed. */
function saneBook(bid: number, ask: number) {
  return bid > 0 && ask > 0 && ask >= bid;
}

export function createMarketView(): MarketView {
  const quotes = new Map<string, MarketQuote>();

  function quote(key: string): MarketQuote {
    let found = quotes.get(key);
    if (!found) {
      found = { key, ltp: 0, at: 0, bid: null, ask: null, bidQty: null, askQty: null, oi: null, volume: null, candleOpen: null };
      quotes.set(key, found);
    }
    return found;
  }

  return {
    apply(packet, at) {
      if (packet.kind === "oi") {
        const existing = quotes.get(packet.key);
        if (existing) existing.oi = packet.oi;
        return null;
      }
      if (packet.kind !== "ticker" && packet.kind !== "quote") return null;
      if (!(packet.ltp > 0)) return null;
      const q = quote(packet.key);
      q.ltp = paise(packet.ltp);
      q.at = at;
      q.candleOpen = null;
      if (packet.kind === "quote") {
        q.volume = packet.volume;
        if (packet.oi !== undefined) q.oi = packet.oi;
        const best = packet.depth?.[0];
        if (best && saneBook(best.bid, best.ask)) {
          q.bid = paise(best.bid);
          q.ask = paise(best.ask);
          q.bidQty = best.bidQty;
          q.askQty = best.askQty;
        } else {
          q.bid = q.ask = q.bidQty = q.askQty = null;
        }
      }
      return q;
    },
    applyCandle(key, price, candleOpen, at) {
      const q = quote(key);
      q.ltp = price;
      q.at = at;
      q.bid = q.ask = q.bidQty = q.askQty = null;
      q.candleOpen = candleOpen;
      return q;
    },
    get: (key) => quotes.get(key),
    onFeed(key) {
      const q = quotes.get(key);
      return q !== undefined && q.at > 0 && q.candleOpen === null;
    },
    clear: () => quotes.clear(),
  };
}
