import type { ReactNode } from "react";
import { SectionTabs } from "@/components/shell/section-tabs";

// Settings and Instruments: one sidebar entry, a tab each.
const SETUP_TABS = [
  { href: "/settings", label: "Settings" },
  { href: "/instruments", label: "Instruments" },
] as const;

export default function SetupLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SectionTabs label="Settings" tabs={SETUP_TABS} />
      {children}
    </>
  );
}
