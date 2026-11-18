// Where studies live: objects in the app's file store (S3), one folder per table and one file per
// study, each written once and never edited.
//
//   research/<namespace>/events/<id>.parquet     every firing
//   research/<namespace>/daily/<id>.parquet      per day, signal and horizon
//   research/<namespace>/summary/<id>.parquet    per signal, horizon and slice
//   research/<namespace>/manifests/<id>.json     what the study was: spec, data, code, results hash
//   research/<namespace>/studies/<id>.parquet    the catalog row, written last
//   research/<namespace>/checks/<id>/<time>.json each rerun and whether it matched
//   research/<namespace>/decisions/<id>/<time>.parquet  Decision API answers for its firings, per batch
//   research/<namespace>/gates/<id>/<time>.json  each Decision API pass: approved against turned down
//
// The catalog row goes last, so a study is listed only once all its files exist. A glob over a
// folder reads that table across every study: comparing studies is one query.

import type { Columns, ParquetStore, Row } from "../db/parquet-store.ts";
import type { FileStore } from "../storage.ts";
import type { DailyRow, EventRow, GateAnswerRow, GateSummary, StudyCheck, StudyDetail, StudyManifest, StudyRow, SummaryRow } from "./types.ts";
import type { DetailDay, DetailEvent, DetailSummary } from "./types.ts";

const EVENT_COLUMNS: Columns = { study: "VARCHAR", signal: "VARCHAR", horizon: "INTEGER", day: "VARCHAR", at: "DOUBLE", vote: "INTEGER", entry: "DOUBLE", exit: "DOUBLE", points: "DOUBLE", vix: "DOUBLE" };
const DAILY_COLUMNS: Columns = { study: "VARCHAR", signal: "VARCHAR", horizon: "INTEGER", day: "VARCHAR", firings: "INTEGER", points: "DOUBLE" };
const SUMMARY_COLUMNS: Columns = {
  study: "VARCHAR",
  signal: "VARCHAR",
  horizon: "INTEGER",
  slice_kind: "VARCHAR",
  slice: "VARCHAR",
  firings: "INTEGER",
  days: "INTEGER",
  hits: "INTEGER",
  hit_rate: "DOUBLE",
  hit_lo: "DOUBLE",
  hit_hi: "DOUBLE",
  mean: "DOUBLE",
  lo: "DOUBLE",
  hi: "DOUBLE",
  net_option: "DOUBLE",
  net_futures: "DOUBLE",
  baseline: "DOUBLE",
  verdict: "VARCHAR",
};
const STUDY_COLUMNS: Columns = {
  id: "VARCHAR",
  question: "VARCHAR",
  signal: "VARCHAR",
  horizon: "INTEGER",
  from: "VARCHAR",
  to: "VARCHAR",
  days: "INTEGER",
  firings: "INTEGER",
  hit_rate: "DOUBLE",
  mean: "DOUBLE",
  lo: "DOUBLE",
  hi: "DOUBLE",
  net_option: "DOUBLE",
  cost_option: "DOUBLE",
  cost_futures: "DOUBLE",
  verdict: "VARCHAR",
  started_at: "DOUBLE",
  ms: "DOUBLE",
  results_hash: "VARCHAR",
  version: "VARCHAR",
  strategy_id: "VARCHAR",
  strategy_version: "INTEGER",
  strategy_name: "VARCHAR",
};

const ANSWER_COLUMNS: Columns = {
  key: "VARCHAR",
  at: "DOUBLE",
  day: "VARCHAR",
  vote: "INTEGER",
  points: "DOUBLE",
  probability: "DOUBLE",
  regime: "VARCHAR",
  quality: "DOUBLE",
  model: "VARCHAR",
  error: "VARCHAR",
};

const ID = /^[a-z0-9-]{8,80}$/;

export interface StudyFiles {
  events: EventRow[];
  daily: DailyRow[];
  summary: SummaryRow[];
  manifest: StudyManifest;
  row: StudyRow;
}

export function createStudyStore(parquet: ParquetStore, files: FileStore, namespace: string) {
  const base = `research/${namespace}`;
  const key = (table: string, id: string, extension = "parquet") => {
    if (!ID.test(id)) throw new Error(`Invalid study id: ${id}`);
    return `${base}/${table}/${id}.${extension}`;
  };
  const asRows = (rows: readonly object[]) => rows as unknown as Row[];

  return {
    base,

    async write(study: StudyFiles) {
      const { id } = study.manifest;
      await parquet.write(key("events", id), EVENT_COLUMNS, asRows(study.events));
      await parquet.write(key("daily", id), DAILY_COLUMNS, asRows(study.daily));
      await parquet.write(key("summary", id), SUMMARY_COLUMNS, asRows(study.summary));
      await files.put(key("manifests", id, "json"), `${JSON.stringify(study.manifest, null, 2)}\n`, "application/json");
      await parquet.write(key("studies", id), STUDY_COLUMNS, asRows([study.row]));
    },

    /** Every stored study, newest first. */
    list(): Promise<StudyRow[]> {
      return parquet.query<StudyRow>((table) => `SELECT * FROM ${table(`${base}/studies/*.parquet`)} ORDER BY started_at DESC`);
    },

    async manifest(id: string): Promise<StudyManifest | null> {
      const bytes = await files.get(key("manifests", id, "json"));
      return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as StudyManifest) : null;
    },

    async exists(id: string): Promise<boolean> {
      return (await files.list(key("studies", id))).length > 0;
    },

    /** One study as the page shows it, or null. */
    async read(id: string): Promise<StudyDetail | null> {
      const manifest = await this.manifest(id);
      if (!manifest) return null;
      const { signal, horizon } = manifest.spec.primary;
      const [summary, daily, events, checks, gate] = await Promise.all([
        // The study id on every row is left out: the page already knows it.
        parquet.query<DetailSummary>((table) => `SELECT * EXCLUDE (study) FROM ${table(key("summary", id))}`),
        parquet.query<DetailDay>((table) => `SELECT day, firings, points FROM ${table(key("daily", id))} WHERE signal = $signal AND horizon = $horizon ORDER BY day`, { signal, horizon }),
        parquet.query<DetailEvent>((table) => `SELECT day, "at", vote, entry, exit, points, vix FROM ${table(key("events", id))} WHERE signal = $signal AND horizon = $horizon ORDER BY "at"`, { signal, horizon }),
        this.checks(id),
        this.gate(id),
      ]);
      return { manifest, summary, daily, events, checks, gate };
    },

    async checks(id: string): Promise<StudyCheck[]> {
      if (!ID.test(id)) throw new Error(`Invalid study id: ${id}`);
      const found = await files.list(`${base}/checks/${id}/`);
      const out: StudyCheck[] = [];
      for (const file of found) {
        const bytes = await files.get(file.key);
        if (bytes) out.push(JSON.parse(new TextDecoder().decode(bytes)) as StudyCheck);
      }
      return out.sort((a, b) => b.at - a.at);
    },

    /**
     * Decision API answers held, `decisions/<id>/<time>.parquet`, one file per batch: for one study,
     * or for every study (answers are keyed by the exact context sent, so studies whose firings
     * coincide can share them).
     */
    async answers(id?: string): Promise<GateAnswerRow[]> {
      if (id !== undefined && !ID.test(id)) throw new Error(`Invalid study id: ${id}`);
      const folder = id === undefined ? `${base}/decisions/` : `${base}/decisions/${id}/`;
      if ((await files.list(folder)).length === 0) return [];
      return parquet.query<GateAnswerRow>((table) => `SELECT * FROM ${table(id === undefined ? `${base}/decisions/*/*.parquet` : `${base}/decisions/${id}/*.parquet`)} ORDER BY "at"`);
    },

    async writeAnswers(id: string, rows: readonly GateAnswerRow[], at: number) {
      if (!ID.test(id)) throw new Error(`Invalid study id: ${id}`);
      if (rows.length) await parquet.write(`${base}/decisions/${id}/${at}.parquet`, ANSWER_COLUMNS, asRows(rows));
    },

    /** The latest gate pass over a study, or null. */
    async gate(id: string): Promise<GateSummary | null> {
      if (!ID.test(id)) throw new Error(`Invalid study id: ${id}`);
      const found = await files.list(`${base}/gates/${id}/`);
      const latest = found.at(-1);
      if (!latest) return null;
      const bytes = await files.get(latest.key);
      return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as GateSummary) : null;
    },

    async writeGate(summary: GateSummary) {
      if (!ID.test(summary.studyId)) throw new Error(`Invalid study id: ${summary.studyId}`);
      await files.put(`${base}/gates/${summary.studyId}/${summary.at}.json`, `${JSON.stringify(summary, null, 2)}\n`, "application/json");
    },

    async writeCheck(check: StudyCheck) {
      if (!ID.test(check.id)) throw new Error(`Invalid study id: ${check.id}`);
      await files.put(`${base}/checks/${check.id}/${check.at}.json`, `${JSON.stringify(check, null, 2)}\n`, "application/json");
    },
  };
}

export type StudyStore = ReturnType<typeof createStudyStore>;
