/** A rectangle in viewport coordinates (what `getBoundingClientRect()` gives). */
export interface Box { top: number; left: number; right: number; bottom: number }

export interface Placement {
  top: number;
  left: number;
  placement: "down" | "up";
  /** The room left below `top`; a panel taller than that scrolls inside itself. */
  maxHeight: number;
}

const EDGE = 8; // kept free at the left, right and bottom of the viewport

/**
 * Where a popup panel goes next to its trigger: the panel's right edge on the trigger's right edge, below it unless it does not fit
 * there but does fit above. `inset` is the room kept free at the top (the sticky top bar), so an upward panel never covers it.
 * A panel that fits neither way stays below, clamped to `inset`, and scrolls inside its `maxHeight`.
 */
export function placePanel(
  trigger: Box,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 4,
  inset = EDGE,
): Placement {
  const below = trigger.bottom + gap;
  const above = trigger.top - gap - panel.height;
  const up = below + panel.height > viewport.height - EDGE && above >= inset;
  const top = Math.max(up ? above : below, inset);
  const left = Math.max(EDGE, Math.min(trigger.right - panel.width, viewport.width - EDGE - panel.width));
  return { top, left, placement: up ? "up" : "down", maxHeight: viewport.height - top - EDGE };
}
