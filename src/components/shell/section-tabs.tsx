"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

export interface SectionTab {
  href: string;
  label: string;
}

/**
 * Tabs across the top of a section that groups several pages under one sidebar entry. Each tab is
 * its own route, so pages keep their URLs and load their own data.
 */
export function SectionTabs({ label, tabs }: { label: string; tabs: readonly SectionTab[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="flex border-b border-line bg-panel px-1.5 sm:px-2.5">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className="relative flex h-9 items-center px-3 text-label font-medium text-muted hover:text-fg aria-[current=page]:text-fg aria-[current=page]:shadow-[inset_0_-2px_0_var(--color-accent)]"
          >
            {tab.label}
            <PendingBar />
          </Link>
        );
      })}
    </nav>
  );
}

function PendingBar() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`absolute inset-x-2 bottom-0 h-0.5 bg-accent transition-opacity ${pending ? "opacity-60 motion-safe:animate-pulse" : "opacity-0"}`}
    />
  );
}
