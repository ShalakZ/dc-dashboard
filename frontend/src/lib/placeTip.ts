import type { Box } from "./placePanel";

export interface TipPlacement {
  top: number;
  left: number;
  placement: "below" | "above";
}

const EDGE = 8; // kept free at the left, right and bottom of the window

/** The vertical band, in window coordinates, a bubble must stay inside. */
export interface TipBounds {
  top: number;
  bottom: number;
}

/**
 * Where an info bubble goes, in window coordinates (the bubble is `position: fixed`, in a portal, so no scrolling box around its button
 * can clip it or grow a scroll bar for it): under the button with the left edges aligned; when that runs past the right of the window the
 * right edges are aligned instead, and the result is clamped so the bubble never leaves the window; when there is no room below it goes
 * above the button, if it fits there.
 *
 * `bounds` (optional) is a vertical band the bubble must stay inside as well: the visible part of a scrolling box the button is in, so a
 * bubble drawn beside a button at the bottom of that box does not hang over what lies under the box. Below wins when it ends inside the
 * band, then above. When neither does there are two cases. The button is inside the band (the bubble is taller than the room on either
 * side of it): the bubble goes ABOVE the button, next to it, limited only by the window's top, so it may reach over what lies over the band
 * but never covers the button and never ends below the band; when even that does not fit (the button is nearer the window's top than the
 * bubble is tall) it goes below the button, past the band if need be: not covering the button comes before staying in the band.
 * The button is outside the band (scrolled out of its box): the bubble is pinned inside the band at the edge nearest the button, so it
 * stays on screen and clear of what lies under the box: its bottom is the band's bottom edge, and when it is taller than the band its top
 * is the band's top. Without `bounds` nothing here changes.
 */
export function placeTip(
  trigger: Box,
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
  bounds?: TipBounds,
): TipPlacement {
  let left = trigger.left;
  if (left + bubble.width > viewport.width - EDGE) left = trigger.right - bubble.width;
  left = Math.max(EDGE, Math.min(left, viewport.width - EDGE - bubble.width));
  const below = trigger.bottom + gap;
  const above = trigger.top - gap - bubble.height;
  if (!bounds) {
    const flip = below + bubble.height > viewport.height - EDGE && above >= EDGE;
    return { top: flip ? above : below, left, placement: flip ? "above" : "below" };
  }
  const lo = Math.max(EDGE, bounds.top);
  const hi = Math.min(viewport.height - EDGE, bounds.bottom);
  const fits = (top: number) => top >= lo && top + bubble.height <= hi;
  if (fits(below)) return { top: below, left, placement: "below" };
  if (fits(above)) return { top: above, left, placement: "above" };
  if (trigger.bottom > lo && trigger.top < hi) {
    // Above only has to fit the window (it may reach over the band's top edge); it is always clear of the band's bottom edge, because
    // it ends above the trigger. Where even that does not fit, below the trigger: the card never lands on the trigger.
    return above >= EDGE ? { top: above, left, placement: "above" } : { top: below, left, placement: "below" };
  }
  return { top: Math.max(lo, Math.min(below, hi - bubble.height)), left, placement: "below" };
}

/**
 * The part of the window (as a vertical band) that the scrolling and clipping boxes around `from` leave visible: the window, cut down by
 * every ancestor, from its parent up to but not including <body>, whose overflow-y is neither `visible` nor empty (`auto`, `scroll`,
 * `hidden` and `clip` all hide or scroll what lies outside the box, and a bubble that is only `position: fixed` is not clipped by them, so
 * it is the caller who keeps it inside). The walk ends at the first `position: fixed` ancestor (that box itself still counts: it is the
 * modal backdrop): what lies above it is the page behind a dialog, which clips nothing of the dialog. A box that scrolls nothing right now
 * is still counted: the editor's body stops scrolling in a tall window and is then the only box that keeps a card out of the buttons under
 * it. No class name is involved, so the markup around the element can change. The band may come out empty (bottom not below top) when such
 * a box has scrolled out of the window, and in jsdom, which measures nothing: callers decide what a band that small is worth.
 */
export function clipBand(from: Element, windowHeight: number): TipBounds {
  let top = 0;
  let bottom = windowHeight;
  for (let box = from.parentElement; box && box !== document.body; box = box.parentElement) {
    const style = getComputedStyle(box);
    if (style.overflowY !== "" && style.overflowY !== "visible") {
      const rect = box.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
    if (style.position === "fixed") break;
  }
  return { top, bottom };
}
