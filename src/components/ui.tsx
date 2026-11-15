import type { ReactNode } from "react";
import type { DhanErrorDescription } from "@/lib/dhan";
import { istTime, signedInr, signedPercent } from "@/lib/format";

export const buttonClass =
  "inline-flex h-7 items-center gap-1.5 rounded-sm border border-line-strong bg-raised px-2.5 text-body hover:bg-line-strong disabled:opacity-60";

export const linkClass =
  "inline-flex items-center gap-1 rounded-sm text-label text-muted hover:text-fg";

export function PageHeader({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 sm:px-4">
      <h1 className="text-body font-semibold">{title}</h1>
      {meta && <div className="text-label text-muted">{meta}</div>}
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  );
}

export function Panel({
  title,
  meta,
  action,
  flush = false,
  className = "",
  children,
}: {
  title?: string;
  meta?: ReactNode;
  action?: ReactNode;
  flush?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`min-w-0 rounded-sm border border-line bg-panel ${className}`}>
      {(title || meta || action) && (
        <header className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
          {title && (
            <h2 className="text-label font-medium tracking-wider text-muted uppercase">{title}</h2>
          )}
          {meta && <div className="text-label text-muted">{meta}</div>}
          {action && <div className="ml-auto flex items-center gap-3">{action}</div>}
        </header>
      )}
      <div className={flush ? undefined : "p-3"}>{children}</div>
    </section>
  );
}

export function Field({
  label,
  value,
  size = "md",
}: {
  label: string;
  value: ReactNode;
  size?: "md" | "lg";
}) {
  return (
    <div className="min-w-0">
      <dt className="text-label text-muted">{label}</dt>
      <dd
        className={`mt-0.5 font-medium tabular-nums ${size === "lg" ? "text-lg leading-6" : "text-body"}`}
      >
        {value}
      </dd>
    </div>
  );
}

export function StatRow({
  label,
  value,
  emphasis = false,
}: {
  label: ReactNode;
  value: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="flex min-h-7 items-baseline justify-between gap-4 py-0.5">
      <dt className="text-muted">{label}</dt>
      <dd
        className={`text-right tabular-nums ${emphasis ? "text-base font-semibold" : "font-medium"}`}
      >
        {value}
      </dd>
    </div>
  );
}

export function Pnl({ value, percent }: { value: number; percent?: number }) {
  const rounded = Math.round(value * 100) / 100;
  const tone = rounded > 0 ? "text-up" : rounded < 0 ? "text-down" : "";

  return (
    <span className={`tabular-nums ${tone}`}>
      {signedInr.format(rounded)}
      {percent !== undefined && (
        <span className="ml-1 text-label">({signedPercent.format(percent)})</span>
      )}
    </span>
  );
}

export function StatusDot({ tone }: { tone: "up" | "down" | "warn" | "muted" }) {
  const color = {
    up: "bg-up",
    down: "bg-down",
    warn: "bg-warn",
    muted: "bg-muted",
  }[tone];
  return <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-full ${color}`} />;
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm border border-line-strong px-1 text-[0.625rem] leading-4 font-medium tracking-wide text-muted uppercase">
      {children}
    </span>
  );
}

export function AsOf({ at }: { at: string }) {
  return (
    <span className="tabular-nums">
      as of <time dateTime={at}>{istTime.format(new Date(at))}</time> IST
    </span>
  );
}

export function InlineError({ error }: { error: DhanErrorDescription }) {
  return (
    <div className="space-y-1">
      <p className="text-down">
        {error.message}
        {error.code && <span className="ml-1 font-mono text-label">({error.code})</span>}
      </p>
      {error.hint && <p className="text-muted">{error.hint}</p>}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="text-muted">{children}</p>;
}

const SKELETON_WIDTHS = ["w-11/12", "w-3/4", "w-5/6", "w-2/3", "w-4/5", "w-1/2"];

export function PanelSkeleton({
  title,
  rows = 4,
  className,
}: {
  title?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <Panel title={title} className={className}>
      <div aria-hidden className="space-y-2.5 py-0.5">
        {Array.from({ length: rows }, (_, row) => (
          <div
            key={`row-${row}`}
            className={`h-3 rounded-sm bg-raised motion-safe:animate-pulse ${SKELETON_WIDTHS[row % SKELETON_WIDTHS.length]}`}
          />
        ))}
      </div>
    </Panel>
  );
}

export function WorkspaceSkeleton({ title, panels = 2 }: { title: string; panels?: number }) {
  return (
    <>
      <PageHeader title={title} meta="Loading from Dhan…" />
      <div className="space-y-2 p-2 sm:p-3">
        {Array.from({ length: panels }, (_, panel) => (
          <PanelSkeleton key={`panel-${panel}`} rows={panel === 0 ? 3 : 6} />
        ))}
      </div>
    </>
  );
}

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

type Column = string | { label: string; align?: keyof typeof ALIGN; className?: string };

export function DataTable({
  caption,
  columns,
  minWidth = "",
  head,
  children,
}: {
  caption: string;
  columns?: Column[];
  minWidth?: string;
  head?: ReactNode;
  children: ReactNode;
}) {
  return (
    // Focusable so keyboard users can scroll the table sideways on narrow screens.
    <div tabIndex={0} className="overflow-x-auto focus-visible:-outline-offset-2">
      <table className={`w-full border-collapse text-body ${minWidth}`}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          {head ?? (
            <tr className="border-b border-line text-label tracking-wider text-muted uppercase">
              {columns?.map((column, index) => {
                const { label, align, className = "" } =
                  typeof column === "string" ? { label: column } : column;
                const alignment = ALIGN[align ?? (index === 0 ? "left" : "right")];
                return (
                  <th
                    key={label}
                    scope="col"
                    className={`h-8 px-3 font-medium whitespace-nowrap ${alignment} ${className}`}
                  >
                    {label}
                  </th>
                );
              })}
            </tr>
          )}
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-line/70 [&>tr:hover]:bg-raised/50 [&>tr:last-child]:border-0">
          {children}
        </tbody>
      </table>
    </div>
  );
}

export function Td({
  numeric = false,
  className = "",
  children,
}: {
  numeric?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <td
      className={`h-8 px-3 whitespace-nowrap ${numeric ? "text-right tabular-nums" : ""} ${className}`}
    >
      {children}
    </td>
  );
}
