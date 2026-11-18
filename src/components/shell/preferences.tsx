"use client";

import { useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";

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

// --- Theme --------------------------------------------------------------------------------------

export type Theme = "dark" | "light";

const THEME_KEY = "option-trader:theme";
const DEFAULT_THEME: Theme = "dark";

const themeListeners = new Set<() => void>();
let currentTheme: Theme | null = null;

function parseTheme(saved: string | null): Theme {
  return saved === "light" || saved === "dark" ? saved : DEFAULT_THEME;
}

function readTheme(): Theme {
  if (currentTheme === null) {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(THEME_KEY);
    } catch {}
    currentTheme = parseTheme(saved);
  }
  return currentTheme;
}

function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_KEY) return;
    currentTheme = parseTheme(event.newValue);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    themeListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setTheme(next: Theme) {
  if (next === readTheme()) return;
  currentTheme = next;
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {}
  for (const listener of themeListeners) listener();
}

export function useTheme() {
  return useSyncExternalStore(subscribeTheme, readTheme, () => DEFAULT_THEME);
}

// Runs in <head>, before first paint, so a saved light theme never flashes dark.
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

const noSubscribe = () => () => {};

export function AppPreferences({ children }: { children: ReactNode }) {
  const state = useSidebarState();
  const theme = useTheme();
  // Keeps <html> in step with the theme, and restores it after React's dev-mode remount clears it.
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
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
