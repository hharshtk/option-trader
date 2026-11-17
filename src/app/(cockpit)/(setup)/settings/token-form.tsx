"use client";

import { useActionState } from "react";
import { buttonClass } from "@/components/ui";
import { saveDhanTokenAction } from "./actions";

const TONE = { ok: "text-up", warn: "text-warn", error: "text-down" } as const;

export function TokenForm() {
  const [state, formAction, pending] = useActionState(saveDhanTokenAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <label htmlFor="dhan-token" className="text-label text-muted">
        New access token
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="dhan-token"
          name="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="Paste the token from web.dhan.co"
          className="h-7 min-w-0 flex-1 rounded-sm border border-line-strong bg-canvas px-2 font-mono text-body focus-visible:border-accent"
        />
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? "Saving…" : "Save token"}
        </button>
      </div>
      <p aria-live="polite" className={`empty:hidden ${TONE[state?.tone ?? "ok"]}`}>
        {pending ? null : state?.message}
      </p>
    </form>
  );
}
