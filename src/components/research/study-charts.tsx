"use client";

// The study report's charts, drawn as plain SVG like the Pulse page's. Values are rupees for one
// lot. Every value they show is also in a table on the page: the tooltips help, they never hold
// the only copy.

import { useId, useState, type PointerEvent, type ReactNode } from "react";
import type { DetailDay, DetailSummary } from "@/lib/research/types";
import { count, dayLabel, likely, pct, rupees, signedRupees } from "./research-format";

/** The app's accent: the one series colour these charts need. */
const SERIES = "#4d8dff";

/** Clean tick values covering [lo, hi]. */
function ticks(lo: number, hi: number, target = 4): number[] {
  const span = hi - lo || 1;
  const raw = span / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** `at` is the point's place across the chart, 0 to 1; the box sits beside it, inside the chart. */
function Tooltip({ at, top, children }: { at: number; top: number; children: ReactNode }) {
  const style = at > 0.5 ? { right: `calc(${((1 - at) * 100).toFixed(2)}% + 10px)` } : { left: `calc(${(at * 100).toFixed(2)}% + 10px)` };
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 w-max max-w-64 rounded-sm border border-line-strong bg-raised px-2 py-1.5 text-label shadow-lg"
      style={{ top, ...style }}
    >
      {children}
    </div>
  );
}

/**
 * The average trade before costs at each holding time, with the range it likely lies in, against
 * the cost of a trade: dots below the dashed line lose money. Rows are already in rupees.
 */
export function HorizonChart({ rows, primary, cost }: { rows: DetailSummary[]; primary: number; cost: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 520;
  const H = 210;
  const pad = { top: 14, right: 16, bottom: 30, left: 48 };
  const values = rows.flatMap((r) => [r.lo, r.hi, r.mean]).filter((v): v is number => v !== null);
  const lo = Math.min(0, ...values);
  const hi = Math.max(cost, ...values);
  const span = hi - lo || 1;
  const yMin = lo - span * 0.08;
  const yMax = hi + span * 0.12;
  const y = (v: number) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.top - pad.bottom);
  const band = (W - pad.left - pad.right) / Math.max(1, rows.length);
  const x = (i: number) => pad.left + band * (i + 0.5);
  const active = hover === null ? null : rows[hover];

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Average trade before costs by holding time: ${rows.map((r) => `${r.horizon} min ${signedRupees(r.mean)}`).join(", ")}. A trade costs ${rupees(cost)}.`}>
        {ticks(yMin, yMax).map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[10px] tabular-nums">
              {signedRupees(t)}
            </text>
          </g>
        ))}
        <line x1={pad.left} x2={W - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-line-strong)" strokeWidth={1} />
        {/* A threshold, so dashed: what a trade must make to pay for itself. */}
        <line x1={pad.left} x2={W - pad.right} y1={y(cost)} y2={y(cost)} stroke="var(--color-muted)" strokeWidth={1} strokeDasharray="4 3" />
        <text x={W - pad.right} y={y(cost) - 5} textAnchor="end" className="fill-muted text-[10px]">
          A trade costs {rupees(cost)}
        </text>
        {rows.map((r, i) => {
          const isPrimary = r.horizon === primary;
          return (
            <g key={r.horizon}>
              {isPrimary && <rect x={x(i) - band / 2 + 4} y={pad.top} width={band - 8} height={H - pad.top - pad.bottom} rx={4} fill="var(--color-raised)" />}
              {r.lo !== null && r.hi !== null && (
                <line x1={x(i)} x2={x(i)} y1={y(r.lo)} y2={y(r.hi)} stroke={SERIES} strokeOpacity={0.55} strokeWidth={2} strokeLinecap="round" />
              )}
              {r.mean !== null && <circle cx={x(i)} cy={y(r.mean)} r={4.5} fill={SERIES} stroke="var(--color-panel)" strokeWidth={2} />}
              {isPrimary && r.mean !== null && (
                <text x={x(i) + 9} y={y(r.mean)} dy="0.32em" className="fill-fg text-[11px] font-medium tabular-nums">
                  {signedRupees(r.mean)}
                </text>
              )}
              <text x={x(i)} y={H - pad.bottom + 16} textAnchor="middle" className={`text-[10px] ${isPrimary ? "fill-fg font-medium" : "fill-muted"}`}>
                {r.horizon} min
              </text>
              <rect
                x={x(i) - band / 2}
                y={0}
                width={band}
                height={H}
                fill="transparent"
                tabIndex={0}
                aria-label={`Held ${r.horizon} minutes: ${signedRupees(r.mean)} a trade before costs, likely ${likely(r.lo, r.hi)}, ${count(r.firings)} trades`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="outline-none focus-visible:stroke-accent"
              />
            </g>
          );
        })}
      </svg>
      {active && hover !== null && (
        <Tooltip at={x(hover) / W} top={8}>
          <div className="font-medium tabular-nums">
            {signedRupees(active.mean)} a trade before costs <span className="font-normal text-muted">held {active.horizon} min</span>
          </div>
          <div className="text-muted tabular-nums">Likely {likely(active.lo, active.hi)}</div>
          <div className="text-muted tabular-nums">
            {count(active.firings)} trades · {pct(active.hit_rate, 0)} won
          </div>
          <div className="text-muted tabular-nums">After costs {signedRupees(active.net_option)} a trade</div>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * Money made or lost, added up day by day, for one lot after costs. `cost` is one trade's cost in
 * rupees and `perPoint` turns a day's index points into rupees.
 */
export function MoneyChart({ days, cost, perPoint }: { days: DetailDay[]; cost: number; perPoint: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();
  const W = 520;
  const H = 200;
  const pad = { top: 14, right: 70, bottom: 30, left: 60 };
  if (days.length < 2) return <p className="grid h-40 place-items-center text-label text-muted">Not enough days with trades to draw.</p>;

  const totals: number[] = [];
  const dayMoney: number[] = [];
  let total = 0;
  for (const day of days) {
    const money = day.points * perPoint - day.firings * cost;
    total += money;
    totals.push(total);
    dayMoney.push(money);
  }
  const lo = Math.min(0, ...totals);
  const hi = Math.max(0, ...totals);
  const span = hi - lo || 1;
  const yMin = lo - span * 0.06;
  const yMax = hi + span * 0.06;
  const x = (i: number) => pad.left + (i / (days.length - 1)) * (W - pad.left - pad.right);
  const y = (v: number) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.top - pad.bottom);
  const path = totals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const colour = total >= 0 ? "var(--color-up)" : "var(--color-down)";

  function onMove(event: PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - pad.left) / (W - pad.left - pad.right)) * (days.length - 1));
    setHover(Math.max(0, Math.min(days.length - 1, i)));
  }

  const active = hover === null ? null : days[hover];
  // A month label every third month.
  const monthTicks = days
    .map((d, i) => ({ i, month: d.day.slice(0, 7) }))
    .filter((d, k, list) => k === 0 || d.month !== list[k - 1].month)
    .filter((_, k) => k % 3 === 0);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full touch-none"
        role="img"
        aria-label={`Money after costs, added up over ${days.length} days with trades: ${signedRupees(total)} in the end.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <clipPath id={clipId}>
          <rect x={pad.left} y={0} width={W - pad.left - pad.right} height={H} />
        </clipPath>
        {ticks(yMin, yMax).map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[10px] tabular-nums">
              {signedRupees(t)}
            </text>
          </g>
        ))}
        <line x1={pad.left} x2={W - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-line-strong)" strokeWidth={1} />
        {monthTicks.map(({ i, month }) => (
          <text key={month} x={x(i)} y={H - pad.bottom + 16} textAnchor="middle" className="fill-muted text-[10px]">
            {dayLabel(`${month}-01`).slice(2)}
          </text>
        ))}
        <g clipPath={`url(#${clipId})`}>
          <path d={path} fill="none" stroke={colour} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        </g>
        <text x={W - pad.right + 6} y={y(total)} dy="0.32em" className="fill-fg text-[11px] font-medium tabular-nums">
          {signedRupees(total)}
        </text>
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={H - pad.bottom} stroke="var(--color-muted)" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(totals[hover])} r={4} fill={colour} stroke="var(--color-panel)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {active && hover !== null && (
        <Tooltip at={x(hover) / W} top={8}>
          <div className="font-medium">{dayLabel(active.day)}</div>
          <div className="tabular-nums">
            {signedRupees(totals[hover])} <span className="text-muted">in total so far</span>
          </div>
          <div className="text-muted tabular-nums">
            That day: {active.firings} trade{active.firings === 1 ? "" : "s"}, {signedRupees(dayMoney[hover])}
          </div>
        </Tooltip>
      )}
    </div>
  );
}

/** A slice's average and likely range on a shared scale, with zero and a trade's cost marked. */
export function RangeBar({ mean, lo, hi, scale, cost }: { mean: number | null; lo: number | null; hi: number | null; scale: [number, number]; cost: number }) {
  const W = 160;
  const H = 16;
  const [min, max] = scale;
  const x = (v: number) => 4 + ((Math.max(min, Math.min(max, v)) - min) / (max - min || 1)) * (W - 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-4 w-40" aria-hidden="true">
      <line x1={x(0)} x2={x(0)} y1={1} y2={H - 1} stroke="var(--color-line-strong)" strokeWidth={1} />
      <line x1={x(cost)} x2={x(cost)} y1={1} y2={H - 1} stroke="var(--color-muted)" strokeWidth={1} strokeDasharray="2 2" />
      {lo !== null && hi !== null && <line x1={x(lo)} x2={x(hi)} y1={H / 2} y2={H / 2} stroke={SERIES} strokeOpacity={0.55} strokeWidth={2} strokeLinecap="round" />}
      {mean !== null && <circle cx={x(mean)} cy={H / 2} r={3.5} fill={SERIES} stroke="var(--color-panel)" strokeWidth={1.5} />}
    </svg>
  );
}
