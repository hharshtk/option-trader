"use client";

import { memo, useEffect, useMemo, useRef, useState, useTransition, type FormEvent, type ReactNode, type RefObject } from "react";
import { addFeedInstrument, closeFeedConnection, removeFeedInstrument } from "@/app/(cockpit)/live-feed/actions";
import { formatAge, useNow } from "@/components/shell/freshness";
import { tooltipClass } from "@/components/shell/header-controls";
import { Tooltip } from "@/components/tooltip";
import { ChevronDownIcon, PlusIcon } from "@/components/icons";
import { buttonClass, DataTable, EmptyState, PageHeader, Panel, StatusDot, Td } from "@/components/ui";
import { price, quantity, signedPercent, signedPrice } from "@/lib/format";
import type { FeedState } from "@/lib/live/feed/dhan-feed";
import {
  MAIN_CONNECTION,
  MAX_CONNECTIONS,
  MAX_INSTRUMENTS_PER_CONNECTION,
  type FeedActionResult,
  type FeedConnection,
  type FeedEvent,
  type FeedHealth,
  type FeedInstrument,
  type MonitorSnapshot,
} from "@/lib/live/feed/monitor";
import type { Packet } from "@/lib/live/feed/packets";

export interface CatalogEntry {
  key: string;
  name: string;
  detail: string;
}

const MONITOR_URL = "/api/market/feed";
const MAX_EVENTS = 1_000;
const VISIBLE_EVENTS = 300;
const KEY_PATTERN = /([A-Za-z_]+:\d+)\s*$/;

type Names = Record<string, string>;
type Link = "connecting" | "open" | "retrying" | "closed";
type Filter = "all" | "market" | "connection";

const inputClass =
  "mt-1 h-7 w-full rounded-sm border border-line-strong bg-canvas px-2 text-body focus-visible:border-accent";

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

const plural = (count: number, word: string) => `${quantity.format(count)} ${word}${count === 1 ? "" : "s"}`;

/** A socket counts as open once Dhan accepted it. */
const isOpen = (connection: FeedConnection) => connection.feed.state === "live";

export function FeedMonitor({ catalog }: { catalog: CatalogEntry[] }) {
  const [link, setLink] = useState<Link>("connecting");
  const [health, setHealth] = useState<FeedHealth | null>(null);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [frozen, setFrozen] = useState<FeedEvent[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [target, setTarget] = useState<string>(String(MAIN_CONNECTION));
  const [adding, setAdding] = useState(false);
  const addInput = useRef<HTMLInputElement>(null);

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

  const names = useMemo(() => {
    const result: Names = Object.fromEntries(catalog.map(({ key, name }) => [key, name]));
    for (const instrument of health?.instruments ?? []) {
      if (instrument.name) result[instrument.key] = instrument.name;
    }
    return result;
  }, [catalog, health?.instruments]);

  const connectionNames = useMemo(
    () => Object.fromEntries((health?.connections ?? []).map(({ id, name }) => [id, name])) as Record<number, string>,
    [health?.connections],
  );

  // The form opens on demand; focusing waits a frame so a just-opened form is in the DOM.
  const openForm = (value: string) => {
    setTarget(value);
    setAdding(true);
    requestAnimationFrame(() => {
      addInput.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      addInput.current?.focus({ preventScroll: true });
    });
  };

  const lastFrozenId = frozen?.at(-1)?.id ?? 0;
  const newWhilePaused = frozen ? events.filter((event) => event.id > lastFrozenId).length : 0;
  const connections = health?.connections ?? [];
  const full = connections.length >= MAX_CONNECTIONS;

  return (
    <>
      <PageHeader title="Live Feed" meta={<FeedStatusButton link={link} health={health} />}>
        <button
          type="button"
          className={buttonClass}
          disabled={!health || full}
          title={full ? `Dhan allows ${MAX_CONNECTIONS} connections per account` : undefined}
          onClick={() => openForm("new")}
        >
          New connection
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!health}
          aria-expanded={adding}
          aria-label="Add an instrument"
          onClick={() => (adding ? setAdding(false) : openForm(target))}
        >
          <PlusIcon className="size-3.5" />
          Add
        </button>
      </PageHeader>
      <div className="space-y-2 p-2 sm:p-3">
        {adding && (
          <AddInstrumentPanel
            catalog={catalog}
            connections={connections}
            target={target}
            onTargetChange={setTarget}
            onClose={() => setAdding(false)}
            inputRef={addInput}
          />
        )}
        {!health && (
          <Panel>
            <EmptyState>Waiting for the server…</EmptyState>
          </Panel>
        )}
        {connections.map((connection) => (
          <ConnectionPanel
            key={connection.id}
            connection={connection}
            instruments={(health?.instruments ?? []).filter((instrument) => instrument.connection === connection.id)}
            names={names}
            onAdd={() => openForm(String(connection.id))}
          />
        ))}
        <Panel
          title="Events"
          meta={
            frozen
              ? `Paused · ${quantity.format(newWhilePaused)} new`
              : "Newest first · what Dhan sent, what we asked for, and connection changes"
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
          <EventLog events={frozen ?? events} filter={filter} names={names} connectionNames={connectionNames} />
        </Panel>
      </div>
    </>
  );
}

function overallTone(health: FeedHealth): "up" | "down" | "warn" | "muted" {
  const states = health.connections.map(({ feed }) => feed.state);
  if (states.includes("stopped")) return "down";
  if (states.includes("reconnecting") || states.includes("connecting")) return "warn";
  return states.includes("live") ? "up" : "muted";
}

/** A compact status chip; hovering or focusing it shows the full overview. */
function FeedStatusButton({ link, health }: { link: Link; health: FeedHealth | null }) {
  const now = useNow();

  if (link !== "open" || !health) {
    const label = {
      connecting: "Connecting to the server…",
      open: "Waiting for the server…",
      retrying: "Lost the server; retrying…",
      closed: "Monitor stopped. Reload the page to retry.",
    }[link];
    return <span className={link === "open" || link === "connecting" ? undefined : "text-warn"}>{label}</span>;
  }

  const open = health.connections.filter(isOpen).length;
  const rows: [string, string][] = [
    ["Dhan WebSockets open", `${open} of ${MAX_CONNECTIONS} allowed`],
    ["Instruments streaming", `${quantity.format(health.instruments.length)} on ${plural(health.connections.length, "connection")}`],
    ["Browser tabs receiving prices", quantity.format(health.quoteStreams)],
    ["Last tick", health.lastTickAt && now ? `${formatAge(now - health.lastTickAt)} ago` : "None yet"],
    ["Server started", now ? `${formatAge(now - health.startedAt)} ago` : "—"],
  ];
  if (health.capture) rows.push(["Raw frames", "Recording to captures/feed"]);

  return (
    <Tooltip
      side="bottom"
      sideOffset={6}
      className={`${tooltipClass} w-80 max-w-[calc(100vw-1rem)] p-3!`}
      content={
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="text-right tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 border-t border-line pt-2 text-muted">
            Prices travel Dhan → WebSockets on this server → your browser tabs. Dhan allows {MAX_CONNECTIONS}{" "}
            WebSockets per account with {quantity.format(MAX_INSTRUMENTS_PER_CONNECTION)} instruments each, and each
            instrument streams on one of them. Main subscribes automatically to whatever open pages show.
          </p>
        </>
      }
    >
      <button
        type="button"
        className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-line-strong px-2 text-label text-fg hover:bg-raised"
      >
        <StatusDot tone={overallTone(health)} />
        {open}/{MAX_CONNECTIONS} sockets · {plural(health.instruments.length, "instrument")}
        {health.lastTickAt && now ? <span className="text-muted">· tick {formatAge(now - health.lastTickAt)} ago</span> : null}
      </button>
    </Tooltip>
  );
}

function AddInstrumentPanel({
  catalog,
  connections,
  target,
  onTargetChange,
  onClose,
  inputRef,
}: {
  catalog: CatalogEntry[];
  connections: FeedConnection[];
  target: string;
  onTargetChange: (value: string) => void;
  onClose: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [instrument, setInstrument] = useState("");
  const [name, setName] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [result, setResult] = useState<FeedActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const full = connections.length >= MAX_CONNECTIONS;
  const known = target === "new" ? !full : connections.some(({ id }) => String(id) === target);
  const selected = known ? target : String(MAIN_CONNECTION);
  const nextConnection = Math.max(MAIN_CONNECTION, ...connections.map(({ id }) => id)) + 1;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const typed = instrument.trim();
    const key = typed.match(KEY_PATTERN)?.[1] ?? typed;
    const entry = catalog.find((item) => item.key === key.toUpperCase());
    startTransition(async () => {
      const outcome = await addFeedInstrument({
        key,
        name: name.trim() || entry?.name,
        connection: selected === "new" ? "new" : Number(selected),
        connectionName: selected === "new" ? connectionName : undefined,
      });
      setResult(outcome);
      if (outcome.ok) {
        setInstrument("");
        setName("");
        setConnectionName("");
        if (selected === "new") onTargetChange(String(MAIN_CONNECTION));
      }
    });
  };

  return (
    <Panel
      title="Add an instrument"
      meta="It stays subscribed until you remove it"
      action={
        <button type="button" className={buttonClass} onClick={onClose}>
          Close
        </button>
      }
    >
      <form
        onSubmit={submit}
        className="grid items-end gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
      >
        <label className="block text-label text-muted">
          Instrument
          <input
            ref={inputRef}
            required
            list="feed-catalog"
            value={instrument}
            onChange={(event) => setInstrument(event.target.value)}
            placeholder="Search NIFTY, RELIANCE… or type NSE_FNO:43854"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </label>
        <label className="block text-label text-muted">
          Label <span className="text-muted/70">(optional)</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Shown instead of the ID"
            maxLength={60}
            className={inputClass}
          />
        </label>
        <label className="block text-label text-muted">
          Connection
          <select value={selected} onChange={(event) => onTargetChange(event.target.value)} className={inputClass}>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} · {quantity.format(connection.instruments)} /{" "}
                {quantity.format(MAX_INSTRUMENTS_PER_CONNECTION)}
              </option>
            ))}
            <option value="new" disabled={full}>
              {full ? `New connection (all ${MAX_CONNECTIONS} in use)` : "+ New connection"}
            </option>
          </select>
        </label>
        <button type="submit" className={`${buttonClass} justify-center`} disabled={pending}>
          {pending ? "Adding…" : selected === "new" ? "Create and add" : "Add"}
        </button>
        {selected === "new" && (
          <label className="block text-label text-muted sm:col-span-2 lg:col-span-1 lg:col-start-3">
            New connection name
            <input
              value={connectionName}
              onChange={(event) => setConnectionName(event.target.value)}
              placeholder={`Connection ${nextConnection}`}
              maxLength={60}
              className={inputClass}
            />
          </label>
        )}
      </form>
      <datalist id="feed-catalog">
        {catalog.map((entry) => (
          <option key={entry.key} value={`${entry.name} · ${entry.key}`}>
            {entry.detail}
          </option>
        ))}
      </datalist>
      {result ? (
        <p role="status" className={`mt-2 ${result.ok ? "text-up" : "text-down"}`}>
          {result.message}
        </p>
      ) : (
        <p className="mt-2 text-label text-muted">
          The list has the six indices and their stocks. For anything else (options, futures, other stocks), type
          its segment and security ID from Dhan&apos;s instrument list, such as NSE_FNO:43854.
        </p>
      )}
    </Panel>
  );
}

function stateView(state: FeedState, now: number | null): { tone: "up" | "down" | "warn" | "muted"; label: string } {
  switch (state.state) {
    case "idle":
      return { tone: "muted", label: "No socket" };
    case "connecting":
      return { tone: "warn", label: state.attempt > 1 ? `Connecting (try ${state.attempt})` : "Connecting" };
    case "live":
      return { tone: "up", label: "Open" };
    case "reconnecting": {
      const seconds = now === null ? null : Math.max(0, Math.ceil((state.retryAt - now) / 1000));
      return { tone: "warn", label: seconds === null ? "Reconnecting" : `Reconnecting in ${seconds}s` };
    }
    case "stopped":
      return { tone: "down", label: "Stopped" };
  }
}

function ConnectionPanel({
  connection,
  instruments,
  names,
  onAdd,
}: {
  connection: FeedConnection;
  instruments: FeedInstrument[];
  names: Names;
  onAdd: () => void;
}) {
  const now = useNow();
  const [message, setMessage] = useState<FeedActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const { tone, label } = stateView(connection.feed, now);
  const since = connection.feed.state === "live" ? connection.feed.since : null;
  const reason = "reason" in connection.feed ? connection.feed.reason : null;
  const packets = Object.entries(connection.packets);
  const notes = [
    reason && <p key="reason" className={connection.feed.state === "stopped" ? "text-down" : "text-muted"}>{reason}</p>,
    connection.feed.state === "live" && connection.instruments === 0 && (
      <p key="empty" className="text-muted">Nothing subscribed; the socket closes 5 minutes after it empties.</p>
    ),
    message && (
      <p key="message" role="status" className={message.ok ? "text-up" : "text-down"}>
        {message.message}
      </p>
    ),
  ].filter(Boolean);
  const stats = [
    quantity.format(connection.instruments),
    since && now ? `open ${formatAge(now - since)}` : null,
    connection.lastTickAt && now ? `tick ${formatAge(now - connection.lastTickAt)} ago` : "no ticks yet",
    `${quantity.format(connection.frames)} frames · ${formatBytes(connection.bytes)}`,
    ...packets.map(([kind, count]) => `${PACKET_LABELS[kind] ?? kind} ${quantity.format(count)}`),
  ].filter(Boolean);

  const run = (action: () => Promise<FeedActionResult>) =>
    startTransition(async () => {
      setMessage(await action());
    });

  const close = () => {
    const warning =
      `Close ${connection.name}? Its WebSocket disconnects now, and instruments you added to it are unsubscribed.` +
      " Anything an open page still shows moves to Main.";
    if (window.confirm(warning)) run(() => closeFeedConnection(connection.id));
  };

  return (
    <Panel
      className={expanded || notes.length > 0 ? "" : "[&>header]:border-b-0"}
      meta={
        <span
          className="inline-flex flex-wrap items-center gap-x-1.5"
          title={connection.main ? "App pages subscribe here automatically" : "Created on the Live Feed page"}
        >
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`connection-${connection.id}`}
            onClick={() => setExpanded(!expanded)}
            className="-ml-1 mr-1 inline-flex h-6 items-center gap-1 rounded-sm px-1 hover:bg-raised"
          >
            <ChevronDownIcon className={`size-3.5 transition-transform ${expanded ? "" : "-rotate-90"}`} />
            <span className="font-medium tracking-wider text-fg uppercase">
              {connection.main ? "" : `#${connection.id} · `}
              {connection.name}
            </span>
          </button>
          <StatusDot tone={tone} />
          <span className={tone === "up" ? "text-up" : undefined}>{label}</span>
          {stats.map((item) => (
            <span key={item} className="tabular-nums">
              · {item}
            </span>
          ))}
        </span>
      }
      action={
        <>
          <button type="button" className={buttonClass} onClick={onAdd} aria-label={`Add an instrument to ${connection.name}`}>
            <PlusIcon className="size-3.5" />
            Add
          </button>
          {!connection.main && (
            <button type="button" className={buttonClass} onClick={close} disabled={pending}>
              Close connection
            </button>
          )}
        </>
      }
      flush
    >
      {notes.length > 0 && (
        <div className={`space-y-1 p-3 ${expanded ? "border-b border-line" : ""}`}>{notes}</div>
      )}
      {!expanded ? null : instruments.length === 0 ? (
        <div className="p-3">
          <EmptyState>
            {connection.main
              ? "Nothing subscribed. Open a page with live prices, or add an instrument."
              : "No instruments yet. Use Add to put one on this connection."}
          </EmptyState>
        </div>
      ) : (
        <div id={`connection-${connection.id}`}>
          <DataTable
            caption={`Instruments streaming on ${connection.name}`}
            columns={["Instrument", "LTP", "Day change", "Updated", ""]}
            minWidth="min-w-[36rem]"
          >
            {instruments.map((instrument) => (
              <InstrumentRow
                key={instrument.key}
                instrument={instrument}
                names={names}
                now={now}
                pending={pending}
                onRemove={() => run(() => removeFeedInstrument(instrument.key))}
              />
            ))}
          </DataTable>
        </div>
      )}
    </Panel>
  );
}

function InstrumentRow({
  instrument: { key, pinned, quote },
  names,
  now,
  pending,
  onRemove,
}: {
  instrument: FeedInstrument;
  names: Names;
  now: number | null;
  pending: boolean;
  onRemove: () => void;
}) {
  const change = quote?.ltp !== undefined && quote.prevClose ? quote.ltp - quote.prevClose : null;
  const tone = change === null || change === 0 ? "" : change > 0 ? "text-up" : "text-down";

  return (
    <tr>
      <Td>
        <span className="font-medium">{names[key] ?? key}</span>
        {names[key] && <span className="ml-2 font-mono text-label text-muted">{key}</span>}
      </Td>
      <Td numeric>{quote?.ltp === undefined ? "—" : price.format(quote.ltp)}</Td>
      <Td numeric className={tone}>
        {change === null || !quote?.prevClose
          ? "—"
          : `${signedPrice.format(change)} (${signedPercent.format(change / quote.prevClose)})`}
      </Td>
      <Td numeric>{quote && now ? `${formatAge(Math.max(0, now - quote.at))} ago` : "Waiting"}</Td>
      <Td numeric>
        {pinned && (
          <button type="button" className={buttonClass} onClick={onRemove} disabled={pending}>
            Remove
          </button>
        )}
      </Td>
    </tr>
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
  connectionNames,
}: {
  events: FeedEvent[];
  filter: Filter;
  names: Names;
  connectionNames: Record<number, string>;
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
            { label: "Connection", align: "left", className: "w-32" },
            { label: "Event", align: "left", className: "w-36" },
            { label: "Instrument", align: "left", className: "w-48" },
            { label: "Detail", align: "left" },
          ]}
          minWidth="min-w-[52rem]"
        >
          {visible.map((event) => (
            <EventRow key={event.id} event={event} names={names} connectionNames={connectionNames} />
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

function EventRow({
  event,
  names,
  connectionNames,
}: {
  event: FeedEvent;
  names: Names;
  connectionNames: Record<number, string>;
}) {
  const { direction, label, instrument, detail, tone } = describeEvent(event, names);
  return (
    <tr>
      <Td className="font-mono text-label text-muted">{eventTime.format(event.at)}</Td>
      <Td className="max-w-32 truncate text-muted">
        {event.connection === undefined ? "—" : (connectionNames[event.connection] ?? `#${event.connection} (closed)`)}
      </Td>
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
