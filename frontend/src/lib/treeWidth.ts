import { readStored, writeStored } from "./sidebarState";

const KEY = "dcdash.assetTreeWidth";

export const TREE_MIN = 220;
export const TREE_STEP = 16; // an arrow key
export const TREE_STEP_BIG = 48; // with Shift

/** The widest the tree column may be: half the window, but never below the minimum. The CSS guard on `.tree-col` says the same (`max(220px, 50vw)`). */
export function treeMax(viewport: number): number {
  return Math.max(TREE_MIN, Math.floor(viewport * 0.5));
}

/** A whole number of pixels between the minimum and the maximum for this window; null when `px` is not a finite number. */
export function clampTreeWidth(px: number, viewport: number): number | null {
  if (!Number.isFinite(px)) return null;
  return Math.min(treeMax(viewport), Math.max(TREE_MIN, Math.round(px)));
}

/** The width the user left last time, clamped to this window. Anything but whole digits (also empty text) is ignored: the CSS default applies. */
export function readTreeWidth(viewport: number): number | null {
  const raw = readStored(KEY);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return clampTreeWidth(Number(raw), viewport);
}

export function saveTreeWidth(px: number): void {
  if (Number.isFinite(px)) writeStored(KEY, String(Math.round(px)));
}

/** Forget the user's width, so the default applies again. */
export function clearTreeWidth(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* not remembered, never an error */ }
}
