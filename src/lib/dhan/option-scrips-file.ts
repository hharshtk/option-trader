import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { filterOptionScrips, SCRIP_MASTER_URL, type OptionScripSummary } from "./option-scrips";

// Downloads Dhan's instrument master from its CDN (a public file, so it uses neither the access
// token nor the API rate limits), keeps the options, and saves them under data/instruments/.

export const OPTION_SCRIPS_DIR = path.join(process.cwd(), "data", "instruments");
export const OPTION_SCRIPS_CSV = path.join(OPTION_SCRIPS_DIR, "options-scrip-master.csv");
const META_FILE = path.join(OPTION_SCRIPS_DIR, "options-scrip-master.json");

const TIMEOUT_MS = 120_000;

export interface OptionScripsMeta extends OptionScripSummary {
  downloadedAt: string;
  /** The IST trading date the file was filtered for. */
  tradingDate: string;
  source: string;
  /** When Dhan last regenerated its file (HTTP Last-Modified), if it said. */
  sourceUpdatedAt: string | null;
  bytes: number;
}

const istDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });

export function todayIst(now = Date.now()) {
  return istDate.format(now);
}

// A second click while a download runs gets the same result instead of a second download.
const store = globalThis as typeof globalThis & { __optionScripsDownload?: Promise<OptionScripsMeta> };

export function downloadOptionScrips(): Promise<OptionScripsMeta> {
  store.__optionScripsDownload ??= download().finally(() => {
    store.__optionScripsDownload = undefined;
  });
  return store.__optionScripsDownload;
}

async function download(): Promise<OptionScripsMeta> {
  let response: Response;
  try {
    response = await fetch(SCRIP_MASTER_URL, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    const reason =
      cause instanceof Error && cause.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000}s` : "network error";
    throw new Error(`Could not download Dhan's instrument file (${reason})`, { cause });
  }
  if (!response.ok) throw new Error(`Dhan's instrument file returned HTTP ${response.status}`);

  const tradingDate = todayIst();
  const { csv, summary } = filterOptionScrips(await response.text(), tradingDate);
  if (summary.optionRows === 0) throw new Error("Dhan's instrument file had no unexpired options; kept the previous file");

  const lastModified = response.headers.get("last-modified");
  const meta: OptionScripsMeta = {
    downloadedAt: new Date().toISOString(),
    tradingDate,
    source: SCRIP_MASTER_URL,
    sourceUpdatedAt: lastModified ? new Date(lastModified).toISOString() : null,
    bytes: Buffer.byteLength(csv),
    ...summary,
  };

  await mkdir(OPTION_SCRIPS_DIR, { recursive: true });
  // Write then rename, so a reader never sees a half-written file.
  await writeFile(`${OPTION_SCRIPS_CSV}.tmp`, csv);
  await rename(`${OPTION_SCRIPS_CSV}.tmp`, OPTION_SCRIPS_CSV);
  await writeFile(`${META_FILE}.tmp`, `${JSON.stringify(meta, null, 2)}\n`);
  await rename(`${META_FILE}.tmp`, META_FILE);
  return meta;
}

/** The last download's summary, or null if there hasn't been one. */
export async function readOptionScripsMeta(): Promise<OptionScripsMeta | null> {
  try {
    return JSON.parse(await readFile(META_FILE, "utf8")) as OptionScripsMeta;
  } catch {
    return null;
  }
}
