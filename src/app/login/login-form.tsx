"use client";

import { useActionState } from "react";
import { login } from "./actions";

const inputClass =
  "mt-1 h-8 w-full rounded-sm border border-line-strong bg-canvas px-2.5 text-body focus-visible:border-accent";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, undefined);

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="username" className="block text-label text-muted">
          Username
        </label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          defaultValue={state?.username}
          required
          autoFocus
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-label text-muted">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </div>
      <p aria-live="polite" className="text-down empty:hidden">
        {state?.error}
      </p>
      <button
        type="submit"
        disabled={pending}
        className="h-8 w-full rounded-sm bg-accent font-medium text-canvas hover:bg-accent/90 disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
