import type { ReactNode } from "react";
import { SectionTabs } from "@/components/shell/section-tabs";

// The strategy store and the paper trading of the strategy it chose: one sidebar entry, a tab each.
const STRATEGY_TABS = [
  { href: "/strategies", label: "Strategies" },
  { href: "/paper-trading", label: "Paper trading" },
] as const;

export default function StrategiesLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SectionTabs label="Strategies" tabs={STRATEGY_TABS} />
      {children}
    </>
  );
}
