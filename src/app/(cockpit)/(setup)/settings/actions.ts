"use server";

import { refresh } from "next/cache";
import { isSignedIn } from "@/lib/auth";
import { getAccessTokenExpiry, getTokenStore } from "@/lib/dhan/config";
import { TOKEN_TTL_SECONDS } from "@/lib/dhan/token-store";
import { downloadOptionScrips, isSourceCurrent } from "@/lib/dhan/option-scrips-store";
import { istDateTime, quantity } from "@/lib/format";

export type DownloadState = { tone: "ok" | "warn" | "error"; message: string } | undefined;
export type TokenState = DownloadState;

export async function saveDhanTokenAction(_previous: TokenState, formData: FormData): Promise<TokenState> {
  if (!(await isSignedIn())) return { tone: "error", message: "Your session has ended. Sign in again." };
  const token = String(formData.get("token") ?? "").trim();
  if (!token) return { tone: "error", message: "Paste an access token first." };

  // Catches a truncated or wrong paste before it replaces a working token.
  const expiry = getAccessTokenExpiry(token);
  if (!expiry) return { tone: "error", message: "That doesn't look like a Dhan access token." };
  if (expiry.getTime() <= Date.now()) {
    return { tone: "error", message: `That token expired at ${istDateTime.format(expiry)}.` };
  }

  try {
    await getTokenStore().save(token);
  } catch (error) {
    return { tone: "error", message: error instanceof Error ? error.message : "Could not save the token." };
  }
  refresh();
  return {
    tone: "ok",
    message: `Saved to Redis for ${TOKEN_TTL_SECONDS / 3600} hours. Dhan says it expires ${istDateTime.format(expiry)}.`,
  };
}

// Server Functions are reachable by direct POST, so this checks the session itself.
export async function downloadOptionScripsAction(): Promise<DownloadState> {
  if (!(await isSignedIn())) return { tone: "error", message: "Your session has ended. Sign in again." };
  try {
    const meta = await downloadOptionScrips();
    refresh();
    const saved = `Saved ${quantity.format(meta.optionRows)} option contracts`;
    if (!isSourceCurrent(meta) && meta.sourceUpdatedAt) {
      return {
        tone: "warn",
        message: `${saved}, but Dhan's file is from ${istDateTime.format(new Date(meta.sourceUpdatedAt))}. Dhan hasn't published today's file yet; press again later.`,
      };
    }
    return { tone: "ok", message: `${saved}.` };
  } catch (error) {
    return { tone: "error", message: error instanceof Error ? error.message : "Download failed." };
  }
}
