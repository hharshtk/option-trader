"use client";

// Every trading setting in force, as short label and value pairs, behind an icon at the top of the
// Strategies page: hover (or focus) it instead of scrolling to Settings.

import { SettingsIcon } from "@/components/icons";
import { tooltipClass } from "@/components/shell/header-controls";
import { Tooltip } from "@/components/tooltip";
import { describeSettings } from "@/lib/engine/settings-text";
import type { TradingStatus } from "@/lib/engine/trading";

export function SettingsSummary({ trading }: { trading: TradingStatus }) {
  const groups = describeSettings(trading);
  return (
    <Tooltip
      side="bottom"
      sideOffset={6}
      className={`${tooltipClass} max-h-[80vh] w-[34rem] max-w-[calc(100vw-2rem)] overflow-y-auto !p-3`}
      content={
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {groups.map((group) => (
            <section key={group.title} className="min-w-0">
              <h3 className="mb-1 text-[0.6875rem] font-semibold tracking-wider text-muted uppercase">{group.title}</h3>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                {group.rows.map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted">{label}</dt>
                    <dd className="min-w-0 font-medium tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      }
    >
      <button type="button" className="flex size-7 items-center justify-center rounded-sm text-muted hover:bg-raised hover:text-fg" aria-label="Settings in force">
        <SettingsIcon className="size-4" />
      </button>
    </Tooltip>
  );
}
