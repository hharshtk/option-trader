"use server";

import { refresh } from "next/cache";
import { isSignedIn } from "@/lib/auth";
import { downloadOptionScrips } from "@/lib/dhan/option-scrips-file";
import { quantity } from "@/lib/format";

export type DownloadState = { ok: boolean; message: string } | undefined;

// Server Functions are reachable by direct POST, so this checks the session itself.
export async function downloadOptionScripsAction(): Promise<DownloadState> {
  if (!(await isSignedIn())) return { ok: false, message: "Your session has ended. Sign in again." };
  try {
    const meta = await downloadOptionScrips();
    refresh();
    return { ok: true, message: `Saved ${quantity.format(meta.optionRows)} option contracts.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Download failed." };
  }
}
