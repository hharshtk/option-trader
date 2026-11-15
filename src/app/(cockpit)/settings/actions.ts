"use server";

import { refresh } from "next/cache";
import { isSignedIn } from "@/lib/auth";
import { downloadOptionScrips, isSourceCurrent } from "@/lib/dhan/option-scrips-store";
import { istDateTime, quantity } from "@/lib/format";

export type DownloadState = { tone: "ok" | "warn" | "error"; message: string } | undefined;

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
