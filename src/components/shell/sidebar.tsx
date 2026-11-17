"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import {
  ActivityIcon,
  EngineIcon,
  LiveFeedIcon,
  MarketWatchIcon,
  OptionsChainIcon,
  OrdersIcon,
  OverviewIcon,
  PositionsIcon,
  PulseIcon,
  SettingsIcon,
  SidebarIcon,
  StrategiesIcon,
  type IconProps,
} from "@/components/icons";
import { Tooltip } from "@/components/tooltip";
import { tooltipClass } from "./header-controls";
import { setSidebarState, useSidebarState } from "./preferences";

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<IconProps>;
  built: boolean;
  /** Other pages shown as tabs under this entry, which keep it highlighted. */
  also?: string[];
}

const NAV: NavItem[][] = [
  [
    { href: "/", label: "Overview", icon: OverviewIcon, built: true, also: ["/holdings", "/funds"] },
    { href: "/market-watch", label: "Market Watch", icon: MarketWatchIcon, built: true },
    { href: "/options-chain", label: "Options Chain", icon: OptionsChainIcon, built: true },
    { href: "/pulse", label: "Pulse", icon: PulseIcon, built: true },
    { href: "/strategies", label: "Strategies", icon: StrategiesIcon, built: true },
  ],
  [
    { href: "/orders", label: "Orders", icon: OrdersIcon, built: true },
    { href: "/positions", label: "Positions", icon: PositionsIcon, built: true },
  ],
  [
    { href: "/activity", label: "Activity", icon: ActivityIcon, built: true },
    { href: "/engine", label: "Engine", icon: EngineIcon, built: true },
    { href: "/live-feed", label: "Live Feed", icon: LiveFeedIcon, built: true },
    { href: "/settings", label: "Settings", icon: SettingsIcon, built: true, also: ["/instruments"] },
  ],
];

export function Sidebar() {
  const pathname = usePathname();
  const collapsed = useSidebarState() === "collapsed";

  return (
    <nav
      id="sidebar"
      aria-label="Sections"
      className="flex w-12 shrink-0 flex-col border-r border-line bg-panel md:w-52 md:sidebar-collapsed:w-12"
    >
      <div className="flex-1 overflow-x-hidden overflow-y-auto py-2">
        {NAV.map((group, index) => (
          <ul
            key={group[0].href}
            className={index > 0 ? "mt-2 border-t border-line pt-2" : undefined}
          >
            {group.map((item) => (
              <li key={item.href}>
                <NavLink item={item} active={pathname === item.href || (item.also?.includes(pathname) ?? false)} showTooltip={collapsed} />
              </li>
            ))}
          </ul>
        ))}
      </div>
      <button
        type="button"
        aria-controls="sidebar"
        aria-expanded={!collapsed}
        onClick={() => setSidebarState(collapsed ? "expanded" : "collapsed")}
        className="mx-1.5 mb-2 hidden h-8 items-center gap-2.5 rounded-sm px-2 text-muted hover:bg-raised hover:text-fg md:flex"
      >
        <SidebarIcon className="shrink-0" />
        <span className="truncate md:sidebar-collapsed:sr-only">
          {collapsed ? "Expand sidebar" : "Collapse sidebar"}
        </span>
      </button>
    </nav>
  );
}

function NavLink({
  item,
  active,
  showTooltip,
}: {
  item: NavItem;
  active: boolean;
  showTooltip: boolean;
}) {
  const Icon = item.icon;

  return (
    <Tooltip
      disabled={!showTooltip}
      type="label"
      side="right"
      sideOffset={10}
      className={tooltipClass}
      content={item.built ? item.label : `${item.label} (not built)`}
    >
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className="group relative mx-1.5 flex h-8 items-center gap-2.5 rounded-sm px-2 text-muted hover:bg-raised hover:text-fg aria-[current=page]:bg-raised aria-[current=page]:text-fg"
      >
        <span
          aria-hidden
          className="absolute inset-y-1.5 -left-1.5 w-0.5 rounded-r-sm bg-accent opacity-0 group-aria-[current=page]:opacity-100"
        />
        <Icon className={`shrink-0 ${item.built ? "" : "opacity-60"}`} />
        <span className="truncate max-md:sr-only md:sidebar-collapsed:sr-only">{item.label}</span>
        {!item.built && (
          <span className="ml-auto shrink-0 text-[0.625rem] leading-4 tracking-wide text-muted uppercase max-md:sr-only md:sidebar-collapsed:sr-only">
            Not built
          </span>
        )}
        <PendingBar />
      </Link>
    </Tooltip>
  );
}

function PendingBar() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`absolute inset-x-2 bottom-0.5 h-px bg-accent transition-opacity ${
        pending ? "opacity-100 motion-safe:animate-pulse" : "opacity-0"
      }`}
    />
  );
}
