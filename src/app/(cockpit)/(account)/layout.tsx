import type { ReactNode } from "react";
import { SectionTabs } from "@/components/shell/section-tabs";

// Overview, Holdings and Funds: one sidebar entry, a tab each.
const ACCOUNT_TABS = [
  { href: "/", label: "Overview" },
  { href: "/holdings", label: "Holdings" },
  { href: "/funds", label: "Funds" },
] as const;

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SectionTabs label="Account" tabs={ACCOUNT_TABS} />
      {children}
    </>
  );
}
