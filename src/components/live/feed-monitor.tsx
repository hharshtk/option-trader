"use client";

import { memo, useEffect, useState, type ReactNode } from "react";
import { formatAge, useNow } from "@/components/shell/freshness";
import { buttonClass, DataTable, EmptyState, Field, PageHeader, Panel, StatusDot, Tag, Td } from "@/components/ui";
import { price, quantity, signedPercent, signedPrice } from "@/lib/format";
import type { FeedState } from "@/lib/live/feed/dhan-feed";
import type { FeedEvent, FeedHealth, MonitorSnapshot } from "@/lib/live/feed/monitor";
import type { Packet } from "@/lib/live/feed/packets";

const MONITOR_URL = "/api/market/feed";
const MAX_EVENTS = 1_000;
const VISIBLE_EVENTS = 300;

type Names = Record<string, string>;
type Link = "connecting" | "open" | "retrying" | "closed";
type Filter = "all" | "market" | "connection";

const eventTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});

const PACKET_LABELS: Record<string, string> = {
  ticker: "Ticker",
  quote: "Quote",
  prevClose: "Prev close",
  oi: "OI",
  disconnect: "Disconnect",
  unknown: "Unparsed",
};

const MARKET_PACKETS = new Set<Packet["kind"]>(["ticker", "quote", "prevClose", "oi"]);

function parse<T>(event: Event): T {
  return JSON.parse((event as MessageEvent<string>).data) as T;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function FeedMonitor({ names }: { names: Names }) {
  const [link, setLink] = useState<Link>("connecting");
  const [health, setHealth] = useState<FeedHealth | null>(null);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [frozen, setFrozen] = useState<FeedEvent[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    const source = new EventSource(MONITOR_URL);
    source.addEventListener("open", () => setLink("open"));
    source.addEventListener("snapshot", (event) => {
      const snapshot = parse<MonitorSnapshot>(event);
      setHealth(snapshot.health);
      setEvents(snapshot.events.slice(-MAX_EVENTS));
    });
    source.addEventListener("health", (event) => setHealth(parse<FeedHealth>(event)));
    source.addEventListener("events", (event) => {
      const batch = parse<FeedEvent[]>(event);
      setEvents((previous) => [...previous, ...batch].slice(-MAX_EVENTS));
    });
    source.addEventListener("error", () => {
      setLink(source.readyState === EventSource.CLOSED ? "closed" : "retrying");
    });
    return () => source.close();
  }, []);

  const lastFrozenId = frozen?.at(-1)?.id ?? 0;
  const newWhilePaused = frozen ? events.filter((event) => event.id > lastFrozenId).length : 0;

  return (
    <>
      <PageHeader title="Live Feed" meta={<MonitorLink link={link} />} />
      <div className="space-y-2 p-2 sm:p-3">
        <ConnectionPanel health={health} />
        <InstrumentsPanel health={health} names={names} />
        <Panel
          title="Events"
          meta={
            frozen
              ? `Paused · ${quantity.format(newWhilePaused)} new`
              : "Newest first · decoded packets, subscriptions and connection changes"
          }
          action={
            <>
              <FilterControl value={filter} onChange={setFilter} />
              <button
                type="button"
                className={buttonClass}
                aria-pressed={frozen !== null}
                onClick={() => setFrozen(frozen ? null : events)}
              >
                {frozen ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  setEvents([]);
                  if (frozen) setFrozen([]);
                }}
              >
                Clear
              </button>
            </>
          }
          flush
        >
          <EventLog events={frozen ?? events} filter={filter} names={names} />
        </Panel>
      </div>
    </>
  );
}

function MonitorLink({ link }: { link: Link }) {
  const label = {
    connecting: "Connecting to the server…",
    open: "One Dhan socket, shared by every tab",
    retrying: "Lost the server; retrying…",
    closed: "Monitor stopped. Reload the page to retry.",
  }[link];
  return <span className={link === "open" ? undefined : "text-warn"}>{label}</span>;
}

function stateView(state: FeedState, now: number | null): { tone: "up" | "down" | "warn" | "muted"; label: string } {
  switch (state.state) {
    case "idle":
      return { tone: "muted", label: "Idle" };
    case "connecting":
      return { tone: "warn", label: state.attempt > 1 ? `Connecting (try ${state.attempt})` : "Connecting" };
    case "live":
      return { tone: "up", label: "Connected" };
    case "reconnecting": {
      const seconds = now === null ? null : Math.max(0, Math.ceil((state.retryAt - now) / 1000));
      return { tone: "warn", label: seconds === null ? "Reconnecting" : `Reconnecting in ${seconds}s` };
    }
    case "stopped":
      return { tone: "down", label: "Stopped" };
  }
}

function ConnectionPanel({ health }: { health: FeedHealth | null }) {
  const now = useNow();

  if (!health) {
    return (
      <Panel title="Connection">
        <EmptyState>Waiting for the server…</EmptyState>
      </Panel>
    );
  }

  const { tone, label } = stateView(health.feed, now);
  const since = health.feed.state === "live" ? health.feed.since : null;
  const reason = "reason" in health.feed ? health.feed.reason : null;
  const packets = Object.entries(health.packets);

  return (
    <Panel
      title="Connection"
      meta={now === null ? undefined : `Counting since the server started, ${formatAge(now - health.startedAt)} ago`}
      action={health.capture ? <Tag>Recording frames</Tag> : undefined}
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-6">
        <Field
          label="Dhan socket"
          value={
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={tone} />
              {label}
            </span>
          }
        />
        <Field label="Connected for" value={since && now ? formatAge(now - since) : "—"} />
        <Field
          label="Last tick"
          value={health.lastTickAt && now ? `${formatAge(now - health.lastTickAt)} ago` : "None yet"}
        />
        <Field label="Dhan subscriptions" value={quantity.format(health.dhanSubscriptions)} />
        <Field
          label="Quote streams"
          value={`${quantity.format(health.quoteStreams)} ${health.quoteStreams === 1 ? "tab" : "tabs"}`}
        />
        <Field
          label="Received"
          value={`${quantity.format(health.frames)} frames · ${formatBytes(health.bytes)}`}
        />
      </dl>
      {reason && <p className={`mt-3 ${health.feed.state === "stopped" ? "text-down" : "text-muted"}`}>{reason}</p>}
      {health.feed.state === "idle" && (
        <p className="mt-3 text-muted">
          The socket opens when a page with live prices subscribes, and closes 5 minutes after the
          last one leaves.
        </p>
      )}
      <p className="mt-3 border-t border-line pt-3 text-label text-muted">
        Packets:{" "}
        {packets.length === 0
          ? "none yet"
          : packets
              .map(([kind, count]) => `${PACKET_LABELS[kind] ?? kind} ${quantity.format(count)}`)
              .join(" · ")}
      </p>
    </Panel>
  );
}

function InstrumentsPanel({ health, names }: { health: FeedHealth | null; names: Names }) {
  const now = useNow();
  const instruments = health?.instruments ?? [];

  return (
    <Panel title="Subscribed instruments" meta={health ? quantity.format(instruments.length) : undefined} flush>
      {instruments.length === 0 ? (
        <div className="p-3">
          <EmptyState>
            {health ? "Nothing subscribed. Pages with live prices subscribe while they're open." : "Waiting for the server…"}
          </EmptyState>
        </div>
      ) : (
        <DataTable
          caption="Instruments subscribed on the Dhan feed"
          columns={["Instrument", "LTP", "Prev close", "Day change", "Updated", "Tabs", "Status"]}
          minWidth="min-w-[44rem]"
        >
          {instruments.map(({ key, streams, releasing, quote }) => {
            const change =
              quote?.ltp !== undefined && quote.prevClose ? quote.ltp - quote.prevClose : null;
            const tone = change === null || change === 0 ? "" : change > 0 ? "text-up" : "text-down";
            return (
              <tr key={key}>
                <Td>
                  <span className="font-medium">{names[key] ?? key}</span>
                  {names[key] && <span className="ml-2 font-mono text-label text-muted">{key}</span>}
                </Td>
                <Td numeric>{quote?.ltp === undefined ? "—" : price.format(quote.ltp)}</Td>
                <Td numeric>{quote?.prevClose === undefined ? "—" : price.format(quote.prevClose)}</Td>
                <Td numeric className={tone}>
                  {change === null || !quote?.prevClose
                    ? "—"
                    : `${signedPrice.format(change)} (${signedPercent.format(change / quote.prevClose)})`}
                </Td>
                <Td numeric>{quote && now ? `${formatAge(Math.max(0, now - quote.at))} ago` : "—"}</Td>
                <Td numeric>{quantity.format(streams)}</Td>
                <Td numeric>
                  {releasing ? <span className="text-warn">Releasing</span> : <span className="text-muted">Active</span>}
                </Td>
              </tr>
            );
          })}
        </DataTable>
      )}
    </Panel>
  );
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "market", label: "Market data" },
  { value: "connection", label: "Connection" },
];

function FilterControl({ value, onChange }: { value: Filter; onChange: (value: Filter) => void }) {
  return (
    <div role="group" aria-label="Show events" className="flex rounded-sm border border-line-strong">
      {FILTERS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="h-6.5 px-2 text-label text-muted not-first:border-l not-first:border-line-strong hover:text-fg aria-pressed:bg-raised aria-pressed:text-fg"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function isMarketData(event: FeedEvent) {
  return event.type === "packet" && MARKET_PACKETS.has(event.packet.kind);
}

const EventLog = memo(function EventLog({
  events,
  filter,
  names,
}: {
  events: FeedEvent[];
  filter: Filter;
  names: Names;
}) {
  const matching =
    filter === "all" ? events : events.filter((event) => isMarketData(event) === (filter === "market"));
  const visible = matching.slice(-VISIBLE_EVENTS).reverse();

  if (visible.length === 0) {
    return (
      <div className="p-3">
        <EmptyState>
          No events yet. On a market day ticks arrive about once a second per instrument; outside
          market hours Dhan sends one snapshot per instrument when it&apos;s subscribed.
        </EmptyState>
      </div>
    );
  }

  return (
    <>
      <div className="max-h-[36rem] overflow-y-auto">
        <DataTable
          caption="Feed events, newest first"
          columns={[
            { label: "Time (IST)", align: "left", className: "w-32" },
            { label: "Event", align: "left", className: "w-36" },
            { label: "Instrument", align: "left", className: "w-48" },
            { label: "Detail", align: "left" },
          ]}
          minWidth="min-w-[44rem]"
        >
          {visible.map((event) => (
            <EventRow key={event.id} event={event} names={names} />
          ))}
        </DataTable>
      </div>
      {matching.length > VISIBLE_EVENTS && (
        <p className="border-t border-line px-3 py-2 text-label text-muted">
          Showing the latest {VISIBLE_EVENTS} of {quantity.format(matching.length)}.
        </p>
      )}
    </>
  );
});

function EventRow({ event, names }: { event: FeedEvent; names: Names }) {
  const { direction, label, instrument, detail, tone } = describeEvent(event, names);
  return (
    <tr>
      <Td className="font-mono text-label text-muted">{eventTime.format(event.at)}</Td>
      <Td>
        <span className={`inline-flex items-center gap-1.5 ${tone ?? ""}`}>
          <span
            aria-label={DIRECTION_LABELS[direction]}
            title={DIRECTION_LABELS[direction]}
            className="w-3 text-center text-muted"
          >
            {DIRECTION_GLYPHS[direction]}
          </span>
          {label}
        </span>
      </Td>
      <Td className="max-w-48 truncate">{instrument}</Td>
      <Td className="max-w-0 truncate font-mono text-label">{detail}</Td>
    </tr>
  );
}

type Direction = "in" | "out" | "info";

const DIRECTION_GLYPHS: Record<Direction, string> = { in: "↓", out: "↑", info: "·" };
const DIRECTION_LABELS: Record<Direction, string> = {
  in: "From Dhan",
  out: "To Dhan",
  info: "Feed status",
};

function instrumentName(key: string | null, names: Names): ReactNode {
  if (!key) return <span className="text-muted">—</span>;
  return names[key] ?? <span className="font-mono text-label">{key}</span>;
}

function describeState(state: FeedState) {
  switch (state.state) {
    case "idle":
      return "Idle, no socket";
    case "connecting":
      return `Opening socket (attempt ${state.attempt})`;
    case "live":
      return "Socket open, subscriptions sent";
    case "reconnecting":
      return `${state.reason}; retry ${state.attempt} at ${eventTime.format(state.retryAt)}`;
    case "stopped":
      return state.reason;
  }
}

function describeEvent(
  event: FeedEvent,
  names: Names,
): { direction: Direction; label: string; instrument: ReactNode; detail: string; tone?: string } {
  switch (event.type) {
    case "packet":
      return describePacket(event.packet, names);
    case "subscribe":
    case "unsubscribe":
      return {
        direction: "out",
        label: event.type === "subscribe" ? "Subscribe" : "Unsubscribe",
        instrument:
          event.keys.length === 1
            ? instrumentName(event.keys[0], names)
            : `${quantity.format(event.keys.length)} instruments`,
        detail: event.keys.map((key) => names[key] ?? key).join(", "),
      };
    case "state":
      return {
        direction: "info",
        label: "State",
        instrument: instrumentName(null, names),
        detail: describeState(event.state),
        tone: event.state.state === "stopped" ? "text-down" : event.state.state === "live" ? "text-up" : undefined,
      };
    case "log":
      return { direction: "info", label: "Note", instrument: instrumentName(null, names), detail: event.message };
  }
}

function describePacket(packet: Packet, names: Names) {
  const base = { direction: "in" as const, label: PACKET_LABELS[packet.kind] ?? packet.kind };
  switch (packet.kind) {
    case "ticker":
      return {
        ...base,
        instrument: instrumentName(packet.key, names),
        detail: `LTP ${price.format(packet.ltp)} · LTT ${packet.ltt}`,
      };
    case "quote":
      return {
        ...base,
        instrument: instrumentName(packet.key, names),
        detail:
          `LTP ${price.format(packet.ltp)} · vol ${quantity.format(packet.volume)} · ` +
          `O ${price.format(packet.open)} H ${price.format(packet.high)} ` +
          `L ${price.format(packet.low)} C ${price.format(packet.close)}`,
      };
    case "prevClose":
      return {
        ...base,
        instrument: instrumentName(packet.key, names),
        detail: `Prev close ${price.format(packet.prevClose)} · prev OI ${quantity.format(packet.prevOi)}`,
      };
    case "oi":
      return { ...base, instrument: instrumentName(packet.key, names), detail: `OI ${quantity.format(packet.oi)}` };
    case "disconnect":
      return {
        ...base,
        instrument: instrumentName(null, names),
        detail: `Disconnect code ${packet.reason}`,
        tone: "text-down",
      };
    case "unknown":
      return {
        ...base,
        instrument: instrumentName(packet.key, names),
        detail: `Response code ${packet.code}, ${packet.length} bytes, not parsed`,
        tone: "text-warn",
      };
  }
}
