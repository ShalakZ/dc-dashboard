import type { Box } from "./placePanel";

export interface TipPlacement {
  top: number;
  left: number;
  placement: "below" | "above";
}

const EDGE = 8; // kept free at the left, right and bottom of the window

/**
 * Where an info bubble goes, in window coordinates (the bubble is `position: fixed`, in a portal, so no scrolling box around its button
 * can clip it or grow a scroll bar for it): under the button with the left edges aligned; when that runs past the right of the window the
 * right edges are aligned instead, and the result is clamped so the bubble never leaves the window; when there is no room below it goes
 * above the button, if it fits there.
 */
export function placeTip(
  trigger: Box,
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
): TipPlacement {
  let left = trigger.left;
  if (left + bubble.width > viewport.width - EDGE) left = trigger.right - bubble.width;
  left = Math.max(EDGE, Math.min(left, viewport.width - EDGE - bubble.width));
  const below = trigger.bottom + gap;
  const above = trigger.top - gap - bubble.height;
  const flip = below + bubble.height > viewport.height - EDGE && above >= EDGE;
  return { top: flip ? above : below, left, placement: flip ? "above" : "below" };
}
