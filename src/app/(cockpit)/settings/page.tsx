import type { Metadata } from "next";
import { Suspense } from "react";
import { logout } from "@/app/login/actions";
import { TokenExpiry } from "@/components/shell/freshness";
import {
  buttonClass,
  EmptyState,
  InlineError,
  PageHeader,
  Panel,
  StatRow,
  StatusDot,
  WorkspaceSkeleton,
} from "@/components/ui";
import { SESSION_MAX_AGE } from "@/lib/auth";
import { requireSession, settle, tokenExpiryIso } from "@/lib/cockpit";
import { getProfile, INDEX } from "@/lib/dhan";
import {
  isSourceCurrent,
  optionScripsLocation,
  readOptionScripsMeta,
  todayIst,
  type OptionScripsMeta,
} from "@/lib/dhan/option-scrips-store";
import { istDateTime, quantity } from "@/lib/format";
import { DownloadScripsButton } from "./download-scrips-button";

export const metadata: Metadata = { title: "Settings" };

const SEGMENT_NAMES: Record<string, string> = {
  E: "Equity",
  D: "Derivatives",
  C: "Currency",
  M: "Commodity",
};

export default function SettingsPage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton title="Settings" />}>
      <Settings />
    </Suspense>
  );
}

async function Settings() {
  await requireSession();
  const [profile, scrips] = await Promise.all([
    settle(getProfile()),
    readOptionScripsMeta().then(
      (meta) => ({ meta, error: null }),
      (error: unknown) => ({ meta: null, error: error instanceof Error ? error.message : String(error) }),
    ),
  ]);
  const tokenExpiry = profile.ok ? tokenExpiryIso() : null;
  const segments = profile.ok
    ? profile.value.activeSegment
        .split(",")
        .map((code) => code.trim())
        .filter(Boolean)
        .map((code) => SEGMENT_NAMES[code] ?? code)
    : [];

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-2 p-2 sm:p-3 lg:grid-cols-2">
        <Panel title="Broker connection">
          <dl>
            <StatRow label="Broker" value="Dhan, DhanHQ API v2" />
            <StatRow
              label="Status"
              value={
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone={profile.ok ? "up" : "down"} />
                  {profile.ok ? "Connected" : "Not connected"}
                </span>
              }
            />
            {profile.ok && (
              <StatRow
                label="Client ID"
                value={<span className="font-mono">{profile.value.dhanClientId}</span>}
              />
            )}
            {tokenExpiry && (
              <StatRow label="Access token expires" value={<TokenExpiry expiresAt={tokenExpiry} />} />
            )}
          </dl>
          {!profile.ok && (
            <div className="mt-3">
              <InlineError error={profile.error} />
            </div>
          )}
          <p className="mt-3 border-t border-line pt-3 text-muted">
            Self-generated tokens last 24 hours. To renew, generate a new token at web.dhan.co →
            My Profile → Access DhanHQ APIs, put it in DHAN_ACCESS_TOKEN in .env.local, then
            restart the dev server. The token stays on the server and never reaches the browser.
          </p>
        </Panel>

        <Panel title="Dhan account">
          {profile.ok ? (
            <dl>
              <StatRow label="Active segments" value={segments.join(", ") || "None"} />
              <StatRow label="DDPI" value={profile.value.ddpi} />
              <StatRow label="MTF" value={profile.value.mtf} />
              <StatRow
                label="Data API plan"
                value={
                  profile.value.dataPlan === "Active"
                    ? `Active until ${profile.value.dataValidity}`
                    : "Not subscribed"
                }
              />
            </dl>
          ) : (
            <EmptyState>Account details load once the Dhan connection works.</EmptyState>
          )}
        </Panel>

        <OptionInstruments meta={scrips.meta} error={scrips.error} location={optionScripsLocation()} />

        <Panel title="App session">
          <p className="text-muted">
            Sign-ins last {SESSION_MAX_AGE / 86_400} days. Changing USER_PASSWORD in .env.local
            signs out every session.
          </p>
          <form action={logout} className="mt-3">
            <button type="submit" className={buttonClass}>
              Sign out
            </button>
          </form>
        </Panel>
      </div>
    </>
  );
}

const INDEX_EXCHANGE: Record<string, string> = { SENSEX: "BSE", BANKEX: "BSE" };

function OptionInstruments({
  meta,
  error,
  location,
}: {
  meta: OptionScripsMeta | null;
  error: string | null;
  location: string;
}) {
  const current = meta?.tradingDate === todayIst();
  const sourceCurrent = meta ? isSourceCurrent(meta) : true;
  const count = (exchange: string, instrument: string) =>
    quantity.format(meta?.byExchange[exchange]?.[instrument] ?? 0);

  return (
    <Panel title="Option instruments">
      {meta ? (
        <dl>
          <StatRow
            label="Downloaded"
            value={
              <span className="inline-flex items-center gap-1.5">
                <StatusDot tone={current ? "up" : "warn"} />
                {istDateTime.format(new Date(meta.downloadedAt))}
                {!current && <span className="text-warn">· not today</span>}
              </span>
            }
          />
          {meta.sourceUpdatedAt && (
            <StatRow
              label="Dhan file published"
              value={
                <span className="inline-flex items-center gap-1.5">
                  {!sourceCurrent && <StatusDot tone="warn" />}
                  {istDateTime.format(new Date(meta.sourceUpdatedAt))}
                </span>
              }
            />
          )}
          <StatRow
            label="NSE options"
            value={`${count("NSE", "OPTIDX")} index · ${count("NSE", "OPTSTK")} stock`}
          />
          <StatRow
            label="BSE options"
            value={`${count("BSE", "OPTIDX")} index · ${count("BSE", "OPTSTK")} stock`}
          />
          <StatRow label="Underlyings" value={quantity.format(meta.underlyings)} />
          <StatRow
            label="Nearest expiry"
            value={
              <span className="font-mono text-label">
                {Object.keys(INDEX)
                  .map((name) => {
                    const expiry = meta.nearestIndexExpiry[`${INDEX_EXCHANGE[name] ?? "NSE"}:${name}`];
                    return expiry ? `${name} ${expiry.slice(5)}` : null;
                  })
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            }
          />
        </dl>
      ) : (
        <EmptyState>Not downloaded yet.</EmptyState>
      )}
      {error && <p className="mt-3 text-down">Couldn&apos;t read the stored download: {error}</p>}
      {meta && !current && (
        <p className="mt-3 text-warn">
          Downloaded for {meta.tradingDate}. Option lookups refuse an earlier day&apos;s download, so
          download again before trading.
        </p>
      )}
      {meta && current && !sourceCurrent && (
        <p className="mt-3 text-warn">
          This is Dhan&apos;s file from an earlier day: Dhan hadn&apos;t published today&apos;s yet. On a
          trading day, download again once it has.
        </p>
      )}
      <div className="mt-3 border-t border-line pt-3">
        <DownloadScripsButton />
        <p className="mt-2 text-muted">
          Fetches Dhan&apos;s instrument master (about 38 MB), keeps unexpired NSE and BSE index and
          stock options, and stores them as Parquet in{" "}
          <span className="font-mono break-all">{location}</span>. Press it each trading day before the
          open.
        </p>
      </div>
    </Panel>
  );
}
