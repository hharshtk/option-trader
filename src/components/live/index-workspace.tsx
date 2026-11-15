"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Tabs } from "@/components/tabs";
import { IndexChart } from "./index-chart";

interface WorkspaceIndex {
  key: string;
  name: string;
  instrument: string;
}

function createSelection(initial: string) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: string) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

type Selection = ReturnType<typeof createSelection>;

// The tabs stay uncontrolled and only report the selection, which the chart reads.
export function IndexWorkspace({
  indices,
  tiles,
  panels,
}: {
  indices: WorkspaceIndex[];
  tiles: ReactNode;
  panels: ReactNode;
}) {
  const [selection] = useState(() => createSelection(indices[0].key));

  return (
    <Tabs
      defaultValue={indices[0].key}
      onValueChange={(value) => {
        if (value) selection.set(value);
      }}
      hiddenUntilFound
      className="space-y-2 px-2 pt-2 sm:px-3 sm:pt-3"
    >
      {tiles}
      <SelectedIndexChart indices={indices} selection={selection} />
      {panels}
    </Tabs>
  );
}

function SelectedIndexChart({
  indices,
  selection,
}: {
  indices: WorkspaceIndex[];
  selection: Selection;
}) {
  const selected = useSyncExternalStore(selection.subscribe, selection.get, selection.get);
  const current = indices.find(({ key }) => key === selected) ?? indices[0];

  return (
    <IndexChart
      key={current.key}
      index={current.key}
      name={current.name}
      instrument={current.instrument}
    />
  );
}
