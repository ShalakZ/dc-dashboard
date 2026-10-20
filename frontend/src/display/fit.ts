import { GRID_GAP, ROW_HEIGHT } from "../lib/gridMetrics";
import { compactVertical } from "../lib/layout";

/** The wall's header takes this share of the window height, and the gutter above and below the dashboard this share each (R5). */
export const HEADER_SHARE = 0.045;
export const GUTTER_SHARE = 0.015;
/** The grid is never laid out narrower than this many logical pixels: below it the 12 columns would get too tight for their cards. */
export const MIN_LOGICAL_WIDTH = 1280;
/** The window height the type floors are written for (a 1080-row screen): `unit` is the window's height over this. */
export const REFERENCE_HEIGHT = 1080;

/**
 * The pixel height of the dashboard as `StaticGrid` draws it: the layout closed up vertically (the same `compactVertical`), then
 * `rows * ROW_HEIGHT + (rows - 1) * GRID_GAP` for the lowest edge. A widget with no height still takes one row, as the grid draws it.
 * No widgets, no height.
 */
export function naturalHeight(widgets: readonly { x: number; y: number; w: number; h: number }[]): number {
  const rows = compactVertical(widgets).reduce((lowest, widget) => Math.max(lowest, widget.y + Math.max(1, widget.h)), 0);
  return rows > 0 ? rows * ROW_HEIGHT + (rows - 1) * GRID_GAP : 0;
}

export interface Fit {
  /** s = min(availableHeight / natural, (width - 2 * gutter) / MIN_LOGICAL_WIDTH); with no natural height, the second. */
  scale: number;
  /** (width - 2 * gutter) / scale: the width the grid is laid out at (never under MIN_LOGICAL_WIDTH). */
  logicalWidth: number;
  /** HEADER_SHARE * height, in window pixels. */
  headerHeight: number;
  /** GUTTER_SHARE * height: above and below the dashboard, and at both sides (so a TV that crops its edges a little never cuts a card). */
  gutter: number;
  /** Window pixels from the left edge to the scaled box: one gutter. */
  left: number;
  /** height - headerHeight - 2 * gutter. */
  availableHeight: number;
  /** Window pixels from the top of the window to the top of the scaled box: the header, a gutter and half of the leftover height. */
  top: number;
  /** height / REFERENCE_HEIGHT. */
  unit: number;
}

const NOT_LAID_OUT: Fit = { scale: 1, logicalWidth: 0, headerHeight: 0, gutter: 0, left: 0, availableHeight: 0, top: 0, unit: 1 };

/**
 * One scale for the whole dashboard (R5): the header and two gutters come off the window height, the dashboard is made to fit what is left
 * (and never narrower than MIN_LOGICAL_WIDTH logical pixels), and the height it does not use is shared above and below.
 * Pure arithmetic, no rounding. A window that is not laid out yet (zero, negative or not a number) gives a neutral answer, never NaN or Infinity.
 */
export function fitWall(win: { width: number; height: number }, natural: number): Fit {
  const { width, height } = win;
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return { ...NOT_LAID_OUT };
  const grid = natural > 0 && Number.isFinite(natural) ? natural : 0;
  const headerHeight = HEADER_SHARE * height;
  const gutter = GUTTER_SHARE * height;
  const availableHeight = height - headerHeight - 2 * gutter;
  const usableWidth = Math.max(0, width - 2 * gutter);
  const byWidth = usableWidth / MIN_LOGICAL_WIDTH;
  const scale = grid > 0 ? Math.min(availableHeight / grid, byWidth) : byWidth;
  const leftover = Math.max(0, availableHeight - grid * scale);
  return { scale, logicalWidth: usableWidth / scale, headerHeight, gutter, left: gutter, availableHeight, top: headerHeight + gutter + leftover / 2, unit: height / REFERENCE_HEIGHT };
}
