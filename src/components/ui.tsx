import type { ReactNode } from "react";
import type { DhanErrorDescription } from "@/lib/dhan";
import { signedInr, signedPercent } from "@/lib/format";

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      {title && (
        <h2 className="mb-4 text-sm font-medium text-zinc-600 dark:text-zinc-400">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="mt-1 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

export function Pnl({ value, percent }: { value: number; percent?: number }) {
  const rounded = Math.round(value * 100) / 100;
  const tone =
    rounded > 0
      ? "text-emerald-700 dark:text-emerald-400"
      : rounded < 0
        ? "text-red-700 dark:text-red-400"
        : undefined;

  return (
    <span className={tone}>
      {signedInr.format(rounded)}
      {percent !== undefined && (
        <span className="ml-1 text-xs">({signedPercent.format(percent)})</span>
      )}
    </span>
  );
}

export function InlineError({ error }: { error: DhanErrorDescription }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="text-red-700 dark:text-red-400">
        {error.message}
        {error.code && <span className="ml-1 font-mono text-xs">({error.code})</span>}
      </p>
      {error.hint && <p className="text-zinc-600 dark:text-zinc-400">{error.hint}</p>}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-600 dark:text-zinc-400">{children}</p>;
}
