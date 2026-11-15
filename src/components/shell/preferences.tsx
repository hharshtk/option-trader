"use client";

import { createLocalStorage, createPreference } from "@ui-sdk/core";
import { Preferences } from "@ui-sdk/react/preferences";
import type { ReactNode } from "react";

export const sidebarPreference = createPreference({
  values: ["expanded", "collapsed"],
  defaultValue: "expanded",
  attribute: "data-sidebar",
  storage: createLocalStorage("option-trader:sidebar"),
});

export function AppPreferences({ children }: { children: ReactNode }) {
  return <Preferences preferences={[sidebarPreference]}>{children}</Preferences>;
}
