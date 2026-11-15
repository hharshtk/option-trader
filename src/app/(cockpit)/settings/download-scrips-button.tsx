"use client";

import { useActionState } from "react";
import { buttonClass } from "@/components/ui";
import { downloadOptionScripsAction } from "./actions";

export function DownloadScripsButton() {
  const [state, formAction, pending] = useActionState(downloadOptionScripsAction, undefined);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Downloading…" : "Download option instruments"}
      </button>
      <p aria-live="polite" className={`empty:hidden ${state?.ok ? "text-up" : "text-down"}`}>
        {pending ? null : state?.message}
      </p>
    </form>
  );
}
