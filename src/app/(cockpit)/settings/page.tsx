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
import { getProfile } from "@/lib/dhan";

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
  const profile = await settle(getProfile());
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
