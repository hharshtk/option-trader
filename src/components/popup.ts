export type Side = "top" | "right" | "bottom" | "left";
export type Align = "start" | "center" | "end";

const VIEWPORT_MARGIN = 8;

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Places an open `popover` element next to its anchor with fixed positioning,
 * flipping to the opposite side when it doesn't fit and keeping it on screen.
 */
export function placePopup(
  anchor: Element,
  popup: HTMLElement,
  side: Side,
  align: Align = "center",
  offset = 0,
) {
  Object.assign(popup.style, { position: "fixed", inset: "auto", left: "0px", top: "0px" });

  const a = anchor.getBoundingClientRect();
  const { width: w, height: h } = popup.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const m = VIEWPORT_MARGIN;

  const fits: Record<Side, boolean> = {
    top: a.top - offset - h >= m,
    bottom: a.bottom + offset + h <= vh - m,
    left: a.left - offset - w >= m,
    right: a.right + offset + w <= vw - m,
  };
  const placed = fits[side] || !fits[OPPOSITE[side]] ? side : OPPOSITE[side];

  let x: number;
  let y: number;
  if (placed === "top" || placed === "bottom") {
    y = placed === "top" ? a.top - offset - h : a.bottom + offset;
    x = align === "start" ? a.left : align === "end" ? a.right - w : a.left + (a.width - w) / 2;
  } else {
    x = placed === "left" ? a.left - offset - w : a.right + offset;
    y = align === "start" ? a.top : align === "end" ? a.bottom - h : a.top + (a.height - h) / 2;
  }

  popup.style.left = `${clamp(x, m, vw - m - w)}px`;
  popup.style.top = `${clamp(y, m, vh - m - h)}px`;
  popup.dataset.side = placed;
}
