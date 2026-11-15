"use server";

import { isSignedIn } from "@/lib/auth";
import { getFeedHub } from "@/lib/live/feed/hub";
import type { FeedActionResult } from "@/lib/live/feed/monitor";

// Server Functions are reachable by direct POST, so each one checks the session and its input.

const UNAUTHORIZED: FeedActionResult = { ok: false, message: "Your session has ended. Sign in again." };

const optionalText = (value: unknown) => (typeof value === "string" ? value : undefined);

export async function addFeedInstrument(input: {
  key: string;
  name?: string;
  connection: number | "new";
  connectionName?: string;
}): Promise<FeedActionResult> {
  if (!(await isSignedIn())) return UNAUTHORIZED;
  const { key, connection } = input ?? {};
  if (typeof key !== "string" || !(connection === "new" || Number.isInteger(connection))) {
    return { ok: false, message: "Pick an instrument and a connection." };
  }
  return getFeedHub().pin({
    key,
    connection,
    name: optionalText(input.name),
    connectionName: optionalText(input.connectionName),
  });
}

export async function removeFeedInstrument(key: string): Promise<FeedActionResult> {
  if (!(await isSignedIn())) return UNAUTHORIZED;
  if (typeof key !== "string") return { ok: false, message: "Unknown instrument." };
  return getFeedHub().unpin(key);
}

export async function closeFeedConnection(id: number): Promise<FeedActionResult> {
  if (!(await isSignedIn())) return UNAUTHORIZED;
  if (!Number.isInteger(id)) return { ok: false, message: "Unknown connection." };
  return getFeedHub().closeConnection(id);
}
