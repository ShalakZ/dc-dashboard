import { readStored, writeStored } from "./sidebarState";

const KEY = "dcdash.assetTreeWidth";

export const TREE_MIN = 220;
export const TREE_STEP = 16; // an arrow key
export const TREE_STEP_BIG = 48; // with Shift
export const PANE_MIN = 560; // what the asset pane keeps, whatever the column takes

/**
 * The widest the tree column may be, in the `available` width right of the sidebar (the column's flex container): half of it, but not so
 * much that the pane keeps less than PANE_MIN, and never below the minimum. The CSS guard on `.tree-col` says the same
 * (`max(220px, min(50%, calc(100% - 560px)))`).
 */
export function treeMax(available: number): number {
  return Math.max(TREE_MIN, Math.min(Math.floor(available / 2), available - PANE_MIN));
}

/** A whole number of pixels between the minimum and the maximum for this `available` width; null when `px` is not a finite number. */
export function clampTreeWidth(px: number, available: number): number | null {
  if (!Number.isFinite(px)) return null;
  return Math.min(treeMax(available), Math.max(TREE_MIN, Math.round(px)));
}

/**
 * The width the user left last time, as it was saved: whole digits that are a safe integer, anything else (also empty text) is ignored and
 * the CSS default applies. Not clamped here: the choice is clamped when it is shown, so a smaller window does not lose it.
 */
export function readTreeWidth(): number | null {
  const raw = readStored(KEY);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const px = Number(raw);
  return Number.isSafeInteger(px) ? px : null;
}

export function saveTreeWidth(px: number): void {
  if (Number.isFinite(px)) writeStored(KEY, String(Math.round(px)));
}

/** Forget the user's width, so the default applies again. */
export function clearTreeWidth(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* not remembered, never an error */ }
}
