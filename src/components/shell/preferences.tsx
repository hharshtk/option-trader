"use client";

import { useSyncExternalStore, type ReactNode } from "react";

export type SidebarState = "expanded" | "collapsed";

const STORAGE_KEY = "option-trader:sidebar";
const DEFAULT_STATE: SidebarState = "expanded";

const listeners = new Set<() => void>();
let current: SidebarState | null = null;

function parse(saved: string | null): SidebarState {
  return saved === "collapsed" || saved === "expanded" ? saved : DEFAULT_STATE;
}

function read(): SidebarState {
  if (current === null) {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(STORAGE_KEY);
    } catch {}
    current = parse(saved);
  }
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    current = parse(event.newValue);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setSidebarState(next: SidebarState) {
  if (next === read()) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {}
  for (const listener of listeners) listener();
}

export function useSidebarState() {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_STATE);
}

// Runs before hydration so a saved collapsed sidebar is right on first paint.
const SEED_SCRIPT = `(function(){var e=document.currentScript&&document.currentScript.parentElement;try{var s=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});if(e&&(s==="collapsed"||s==="expanded"))e.setAttribute("data-sidebar",s)}catch(n){}})()`;

const noSubscribe = () => () => {};

export function AppPreferences({ children }: { children: ReactNode }) {
  const state = useSidebarState();
  const fromServer = useSyncExternalStore(
    noSubscribe,
    () => false,
    () => true,
  );

  return (
    // The seed script may change data-sidebar before hydration.
    <div data-sidebar={state} style={{ display: "contents" }} suppressHydrationWarning>
      {fromServer ? (
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: SEED_SCRIPT }} />
      ) : null}
      {children}
    </div>
  );
}
