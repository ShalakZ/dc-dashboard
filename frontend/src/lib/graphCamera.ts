// The camera's arithmetic for the Discovery canvas: how long a move lasts and how far to pan so a node is seen. Pure; the page does the moving.
import type { Rect } from "./graphGuides";

export const CAMERA_MS = 300;

/** The duration of every camera move: none for a reader who asked for less motion (the camera still moves, at once). */
export function cameraMs(reduced: boolean): number {
  return reduced ? 0 : CAMERA_MS;
}

/** The smallest rectangle that holds all of them, or null for none. A new object, never one of the inputs. */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.x);
    top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

const MARGIN = 40;

/** The room to keep clear around a box, in screen pixels: one number for all four sides, or a number for each side (a side left out is 40). */
export type Margin = number | { top?: number; right?: number; bottom?: number; left?: number };

// One axis: how far the content must slide so the span [start, start + length] (screen pixels) sits inside [before, room - after].
// Zero when it already does; a span longer than the space is aligned at its start margin (it cannot fit, so show its beginning).
function slide(start: number, length: number, room: number, before: number, after: number): number {
  const end = start + length;
  if (length > room - before - after) return before - start;
  if (start < before) return before - start;
  if (end > room - after) return room - after - end;
  return 0;
}

/**
 * Where the viewport's offset must go to bring `box` (graph coordinates) inside the canvas with `margin` pixels to spare, moving as little
 * as possible; null when it is already in. The zoom is never part of it. A box wider or taller than the room is aligned at its left or top margin.
 * The margin may differ by side: the page keeps a node clear of the minimap and the tools panel, which are drawn over the canvas (W12b).
 */
export function keepInView(
  box: Rect,
  view: { x: number; y: number; zoom: number },
  size: { w: number; h: number },
  margin: Margin = MARGIN,
): { x: number; y: number } | null {
  if (size.w <= 0 || size.h <= 0) return null; // the canvas has not been measured: nothing to aim at
  const side = typeof margin === "number" ? { top: margin, right: margin, bottom: margin, left: margin } : margin;
  const dx = slide(box.x * view.zoom + view.x, box.w * view.zoom, size.w, side.left ?? MARGIN, side.right ?? MARGIN);
  const dy = slide(box.y * view.zoom + view.y, box.h * view.zoom, size.h, side.top ?? MARGIN, side.bottom ?? MARGIN);
  if (dx === 0 && dy === 0) return null;
  return { x: view.x + dx, y: view.y + dy };
}

type Box = Pick<DOMRect, "top" | "bottom" | "width" | "height">;

/**
 * The top and bottom margin `keepInView` needs so a node does not land under what the canvas draws over itself: the tools panel (Find, Snap) at the top and the
 * minimap at the bottom, both measured on screen. Each is the usual 40 when its overlay is not drawn (null, or no size: hidden, or a page that cannot measure), and
 * never less. Both sit in a corner, but the whole width is kept clear: it is simpler than asking where the node is, and the walk stays at one height.
 */
export function overlayMargin(canvas: Box, minimap: Box | null, tools: Box | null): { top: number; bottom: number } {
  const drawn = (box: Box | null): box is Box => box !== null && box.width > 0 && box.height > 0;
  return {
    top: drawn(tools) ? Math.max(MARGIN, tools.bottom - canvas.top + 8) : MARGIN,
    bottom: drawn(minimap) ? Math.max(MARGIN, canvas.bottom - minimap.top + 16) : MARGIN,
  };
}
