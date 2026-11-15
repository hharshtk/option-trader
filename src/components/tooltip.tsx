"use client";

import {
  cloneElement,
  useEffect,
  useId,
  useState,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type ReactNode,
} from "react";
import { placePopup, type Side } from "./popup";

const OPEN_DELAY_MS = 600;
// Once a tooltip is open, or closed a moment ago, the next one opens at once.
const GROUP_WINDOW_MS = 300;

interface Placement {
  popupId: string;
  side: Side;
  sideOffset: number;
}

interface Controller {
  show: (trigger: HTMLElement, placement: Placement) => void;
  scheduleShow: (trigger: HTMLElement, placement: Placement) => void;
  close: () => void;
}

const group: { active: Controller | null; lastClosedAt: number } = {
  active: null,
  lastClosedAt: 0,
};

function createController(): Controller {
  let popup: HTMLElement | null = null;
  let timer: number | undefined;

  const self: Controller = {
    show(trigger, { popupId, side, sideOffset }) {
      window.clearTimeout(timer);
      popup = document.getElementById(popupId);
      if (!popup) return;
      if (group.active && group.active !== self) group.active.close();
      group.active = self;
      if (!popup.matches(":popover-open")) popup.showPopover();
      placePopup(trigger, popup, side, "center", sideOffset);
      window.addEventListener("scroll", self.close, { capture: true, passive: true });
    },
    scheduleShow(trigger, placement) {
      window.clearTimeout(timer);
      if (group.active !== null || Date.now() - group.lastClosedAt < GROUP_WINDOW_MS) {
        self.show(trigger, placement);
      } else {
        timer = window.setTimeout(() => self.show(trigger, placement), OPEN_DELAY_MS);
      }
    },
    close() {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", self.close, true);
      if (popup?.matches(":popover-open")) {
        popup.hidePopover();
        group.lastClosedAt = Date.now();
      }
      if (group.active === self) group.active = null;
    },
  };
  return self;
}

interface TriggerProps {
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onBlur?: FocusEventHandler<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/**
 * Shows `content` beside its single child on hover (after a delay) and on keyboard focus.
 * `type="label"` names the trigger; the default describes it.
 */
export function Tooltip({
  children,
  content,
  side = "top",
  sideOffset = 0,
  className,
  disabled = false,
  type = "description",
}: {
  children: ReactElement<TriggerProps>;
  content: ReactNode;
  side?: Side;
  sideOffset?: number;
  className?: string;
  disabled?: boolean;
  type?: "label" | "description";
}) {
  const id = useId();
  const [controller] = useState(createController);
  const placement = { popupId: id, side, sideOffset };
  const { props } = children;

  useEffect(() => {
    if (disabled) controller.close();
  }, [disabled, controller]);

  useEffect(() => () => controller.close(), [controller]);

  const trigger = cloneElement(children, {
    [type === "label" ? "aria-labelledby" : "aria-describedby"]: disabled ? undefined : id,
    onPointerEnter: (event) => {
      props.onPointerEnter?.(event);
      if (event.pointerType !== "touch") controller.scheduleShow(event.currentTarget, placement);
    },
    onPointerLeave: (event) => {
      props.onPointerLeave?.(event);
      controller.close();
    },
    onFocus: (event) => {
      props.onFocus?.(event);
      if (event.currentTarget.matches(":focus-visible")) {
        controller.show(event.currentTarget, placement);
      }
    },
    onBlur: (event) => {
      props.onBlur?.(event);
      controller.close();
    },
    onKeyDown: (event) => {
      props.onKeyDown?.(event);
      if (event.key === "Escape") controller.close();
    },
  } satisfies TriggerProps);

  return (
    <>
      {trigger}
      {!disabled && (
        <div id={id} role="tooltip" popover="manual" className={className}>
          {content}
        </div>
      )}
    </>
  );
}
