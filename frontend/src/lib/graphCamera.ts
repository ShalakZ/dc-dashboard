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

// One axis: how far the content must slide so the span [start, start + length] (screen pixels) sits inside [margin, room - margin].
// Zero when it already does; a span longer than the space is aligned at its start margin (it cannot fit, so show its beginning).
function slide(start: number, length: number, room: number, margin: number): number {
  const end = start + length;
  if (length > room - 2 * margin) return margin - start;
  if (start < margin) return margin - start;
  if (end > room - margin) return room - margin - end;
  return 0;
}

/**
 * Where the viewport's offset must go to bring `box` (graph coordinates) inside the canvas with `margin` pixels to spare, moving as little
 * as possible; null when it is already in. The zoom is never part of it. A box wider or taller than the room is aligned at its left or top margin.
 */
export function keepInView(
  box: Rect,
  view: { x: number; y: number; zoom: number },
  size: { w: number; h: number },
  margin = 40,
): { x: number; y: number } | null {
  if (size.w <= 0 || size.h <= 0) return null; // the canvas has not been measured: nothing to aim at
  const dx = slide(box.x * view.zoom + view.x, box.w * view.zoom, size.w, margin);
  const dy = slide(box.y * view.zoom + view.y, box.h * view.zoom, size.h, margin);
  if (dx === 0 && dy === 0) return null;
  return { x: view.x + dx, y: view.y + dy };
}
