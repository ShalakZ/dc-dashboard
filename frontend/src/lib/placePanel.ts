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
 * Where a popup panel goes next to its trigger: to the LEFT of it, its top on the trigger's top, so it never covers the triggers of the
 * rows above and below (a row menu sits in a column of them). When that would run past the bottom of the window its bottom edge goes on the
 * trigger's bottom instead ("up"). With no room at the left it falls back to below the trigger, right edges aligned, or above it when
 * that does not fit there but does fit above. `inset` is the room kept free at the top (the sticky top bar), so a panel never covers it.
 * A panel that fits nowhere is clamped to `inset` and scrolls inside its `maxHeight`.
 */
export function placePanel(
  trigger: Box,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 4,
  inset = EDGE,
): Placement {
  const beside = trigger.left - gap - panel.width;
  if (beside >= EDGE) {
    const down = trigger.top + panel.height <= viewport.height - EDGE;
    const top = Math.max(down ? trigger.top : trigger.bottom - panel.height, inset);
    return { top, left: beside, placement: down ? "down" : "up", maxHeight: viewport.height - top - EDGE };
  }
  const below = trigger.bottom + gap;
  const above = trigger.top - gap - panel.height;
  const up = below + panel.height > viewport.height - EDGE && above >= inset;
  const top = Math.max(up ? above : below, inset);
  const left = Math.max(EDGE, Math.min(trigger.right - panel.width, viewport.width - EDGE - panel.width));
  return { top, left, placement: up ? "up" : "down", maxHeight: viewport.height - top - EDGE };
}
