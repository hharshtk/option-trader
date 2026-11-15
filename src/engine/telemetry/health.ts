// Each component reports ok, degraded or failing, with a reason. The web's status dot shows
// the worst of them; the Engine page lists them all.

import { worstHealth, type ComponentHealth, type HealthState } from "../../lib/engine/protocol.ts";

export interface Health {
  set(component: string, state: HealthState, reason?: string): void;
  remove(component: string): void;
  list(): ComponentHealth[];
  overall(): HealthState;
}

export function createHealth(
  now: () => number,
  onChange?: (next: ComponentHealth, previous: ComponentHealth | undefined) => void,
): Health {
  const components = new Map<string, ComponentHealth>();
  return {
    set(component, state, reason) {
      const previous = components.get(component);
      const cleanReason = state === "ok" ? undefined : reason;
      if (previous && previous.state === state && previous.reason === cleanReason) return;
      const next: ComponentHealth = {
        component,
        state,
        // A new reason in the same state keeps the original start time.
        since: previous?.state === state ? previous.since : now(),
        ...(cleanReason && { reason: cleanReason }),
      };
      components.set(component, next);
      onChange?.(next, previous);
    },
    remove(component) {
      components.delete(component);
    },
    list: () => [...components.values()],
    overall: () => worstHealth([...components.values()].map((c) => c.state)),
  };
}
