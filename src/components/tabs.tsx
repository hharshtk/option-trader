"use client";

import {
  createContext,
  use,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

interface TabsContextValue {
  value: string;
  select: (value: string) => void;
  baseId: string;
  hiddenUntilFound: boolean;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs() {
  const context = use(TabsContext);
  if (!context) throw new Error("Tabs parts must be rendered inside <Tabs>.");
  return context;
}

/**
 * Uncontrolled tabs. `hiddenUntilFound` keeps inactive panels searchable with
 * find-in-page, and selects a panel when the browser reveals a match in it.
 */
export function Tabs({
  defaultValue,
  onValueChange,
  hiddenUntilFound = false,
  className,
  children,
}: {
  defaultValue: string;
  onValueChange?: (value: string) => void;
  hiddenUntilFound?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [value, setValue] = useState(defaultValue);
  const baseId = useId();

  const select = (next: string) => {
    if (next === value) return;
    setValue(next);
    onValueChange?.(next);
  };

  return (
    <TabsContext value={{ value, select, baseId, hiddenUntilFound }}>
      <div className={className}>{children}</div>
    </TabsContext>
  );
}

const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

export function TabsList({
  className,
  children,
  "aria-label": ariaLabel,
}: {
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!NAV_KEYS.has(event.key)) return;
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([aria-disabled="true"])'),
    );
    const current = tabs.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;
    event.preventDefault();
    const last = tabs.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowRight"
            ? (current + 1) % tabs.length
            : (current - 1 + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  }

  return (
    <div role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown} className={className}>
      {children}
    </div>
  );
}

export function TabsTab({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const { value: selectedValue, select, baseId } = useTabs();
  const selected = selectedValue === value;

  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      data-selected={selected ? "" : undefined}
      onClick={() => select(value)}
      className={className}
    >
      {children}
    </button>
  );
}

export function TabsPanel({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const { value: selectedValue, select, baseId, hiddenUntilFound } = useTabs();
  const selected = selectedValue === value;
  const ref = useRef<HTMLDivElement>(null);

  // React only renders `hidden` as a boolean, so upgrade it after commit.
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel || selected || !hiddenUntilFound) return;
    panel.setAttribute("hidden", "until-found");
    const reveal = () => select(value);
    panel.addEventListener("beforematch", reveal);
    return () => panel.removeEventListener("beforematch", reveal);
  }, [selected, hiddenUntilFound, select, value]);

  return (
    <div
      ref={ref}
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      tabIndex={0}
      hidden={!selected}
      className={className}
    >
      {children}
    </div>
  );
}
