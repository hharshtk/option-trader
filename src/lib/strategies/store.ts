// Where strategies live: Parquet files in the app's file store (S3), read and written with DuckDB,
// one file per version and one per event, each written once and never edited.
//
//   strategies/<namespace>/versions/<id>/<version>.parquet   one row: the version's settings (JSON)
//   strategies/<namespace>/events/<id>/<time>.parquet        one row: what happened (created, saved,
//                                                             tested, paper trading on and off, …)
//
// A strategy's current state is worked out from its versions and events (statusOf in types.ts),
// so nothing is ever overwritten and its whole history stays readable. One glob reads a table for
// every strategy. The namespace keeps a development engine's strategies apart from production's.

import type { Columns, ParquetStore, Row } from "../db/parquet-store.ts";
import { statusOf, type StrategyDefinition, type StrategyDetail, type StrategyEvent, type StrategySummary, type StrategyVersion } from "./types.ts";

const VERSION_COLUMNS: Columns = { id: "VARCHAR", version: "INTEGER", saved_at: "DOUBLE", note: "VARCHAR", definition: "VARCHAR" };
const EVENT_COLUMNS: Columns = {
  strategy: "VARCHAR",
  at: "DOUBLE",
  kind: "VARCHAR",
  version: "INTEGER",
  note: "VARCHAR",
  study: "VARCHAR",
  verdict: "VARCHAR",
  net: "DOUBLE",
  trades: "INTEGER",
  days: "INTEGER",
};

const ID = /^[a-z0-9-]{3,80}$/;

interface VersionRow {
  id: string;
  version: number;
  saved_at: number;
  note: string;
  definition: string;
}

export function createStrategyStore(parquet: ParquetStore, namespace: string) {
  const base = `strategies/${namespace}`;
  const check = (id: string) => {
    if (!ID.test(id)) throw new Error(`Invalid strategy id: ${id}`);
  };
  let lastEventAt = 0;

  const toVersion = (row: VersionRow): StrategyVersion => ({
    ...(JSON.parse(row.definition) as StrategyDefinition),
    id: row.id,
    version: row.version,
    savedAt: row.saved_at,
    note: row.note,
  });

  return {
    base,
    location: `${parquet.location}${base}`,

    async writeVersion(version: StrategyVersion) {
      check(version.id);
      const { id, version: n, savedAt, note, ...definition } = version;
      await parquet.write(`${base}/versions/${id}/${n}.parquet`, VERSION_COLUMNS, [{ id, version: n, saved_at: savedAt, note, definition: JSON.stringify(definition) }] as Row[]);
    },

    async writeEvent(event: StrategyEvent) {
      check(event.strategy);
      // Events at the same millisecond still get their own file, in order.
      const at = Math.max(event.at, lastEventAt + 1);
      lastEventAt = at;
      await parquet.write(`${base}/events/${event.strategy}/${at}.parquet`, EVENT_COLUMNS, [{ ...event, at }] as unknown as Row[]);
      return { ...event, at };
    },

    /** Every version and event of every strategy. */
    async readAll(): Promise<{ versions: StrategyVersion[]; events: StrategyEvent[] }> {
      const [versions, events] = await Promise.all([
        parquet.query<VersionRow>((table) => `SELECT * FROM ${table(`${base}/versions/*/*.parquet`)}`),
        parquet.query<StrategyEvent>((table) => `SELECT * FROM ${table(`${base}/events/*/*.parquet`)} ORDER BY "at"`),
      ]);
      return { versions: versions.map(toVersion), events };
    },
  };
}

export type StrategyStore = ReturnType<typeof createStrategyStore>;

/** Every strategy's summary and history, from all versions and events. Newest activity first. */
export function assemble(versions: readonly StrategyVersion[], events: readonly StrategyEvent[]): StrategyDetail[] {
  const ids = new Set(versions.map((v) => v.id));
  const out: StrategyDetail[] = [];
  for (const id of ids) {
    const own = versions.filter((v) => v.id === id).sort((a, b) => b.version - a.version);
    const history = events.filter((e) => e.strategy === id).sort((a, b) => b.at - a.at);
    const { status, paperVersion } = statusOf(history);
    const summary: StrategySummary = {
      id,
      latest: own[0],
      status,
      paperVersion,
      lastTest: history.find((e) => e.kind === "tested") ?? null,
      versions: own.length,
      createdAt: own.at(-1)!.savedAt,
      updatedAt: Math.max(own[0].savedAt, history[0]?.at ?? 0),
    };
    out.push({ summary, versions: own, events: history });
  }
  return out.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt);
}
