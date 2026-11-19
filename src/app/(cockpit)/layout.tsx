import type { ReactNode } from "react";
import { MarketHeader } from "@/components/shell/market-header";
import { Sidebar } from "@/components/shell/sidebar";
import { TradingHaltBanner } from "@/components/shell/trading-halt-banner";

export default function CockpitLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:bg-raised focus:px-3 focus:py-1.5"
      >
        Skip to content
      </a>
      <MarketHeader />
      <TradingHaltBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
