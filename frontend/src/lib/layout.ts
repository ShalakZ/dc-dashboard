import type { DistributiveOmit, TextStyle, Widget, WidgetConfig, WidgetType } from "../api/types";

export const GRID_COLS = 12;

export interface GridItem { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }

/** A widget being edited: no id yet for new ones, so it is keyed by a client-side `key` (String(id) for saved widgets). */
export type DraftWidget = DistributiveOmit<Widget, "id"> & { key: string };

const SIZE: Record<WidgetType, { w: number; h: number }> = {
  timeseries: { w: 6, h: 5 }, bar: { w: 6, h: 5 }, stat: { w: 3, h: 2 }, gauge: { w: 3, h: 3 }, table: { w: 6, h: 4 }, text: { w: 6, h: 2 },
};
const MIN: Record<WidgetType, { minW: number; minH: number }> = {
  timeseries: { minW: 3, minH: 3 }, bar: { minW: 3, minH: 3 }, stat: { minW: 2, minH: 2 }, gauge: { minW: 2, minH: 2 }, table: { minW: 3, minH: 3 },
  text: { minW: 2, minH: 1 },
};
/** A divider is a rule across the whole row, one grid row high. */
const DIVIDER_SIZE = { w: 12, h: 1 };

/** The columns (end exclusive) the read-only grid really draws for a widget: it never spills past the last column. */
export function columnsOf({ x, w }: { x: number; w: number }): { start: number; end: number } {
  const start = Math.min(Math.max(x, 0), GRID_COLS - 1);
  return { start, end: start + Math.max(1, Math.min(w, GRID_COLS - start)) };
}

/** Saved rows are normalised once to the rectangle the grid draws (x/w inside the 12 columns, h at least 1, y at least 0); valid rows are unchanged. */
export function toDrafts(widgets: Widget[]): DraftWidget[] {
  return widgets.map((widget): DraftWidget => {
    const { start, end } = columnsOf(widget);
    const { id, ...rest } = widget; // the rest of a union keeps the union (type and config stay together)
    return { ...rest, key: String(id), x: start, y: Math.max(0, widget.y), w: end - start, h: Math.max(1, widget.h) };
  });
}

/** A stat that compares with last month draws seven rows (the window, last month's same days, the change and a note line), so it starts 3 wide and 3 high (w24). */
const COMPARE_STAT_SIZE = { w: 3, h: 3 };
const isCompareStat = (type: WidgetType, config: Partial<WidgetConfig> | undefined): boolean =>
  type === "stat" && config?.compare === "same_days_last_month";

/**
 * What a card may shrink to. A comparing stat may not go below 3 x 3 - but never above the size it already has: a 3 x 2 one saved before this rule is not
 * pushed to a size nobody gave it (the grid would record that as an edit).
 */
function minOf(d: DraftWidget): { minW: number; minH: number } {
  const min = MIN[d.type];
  if (d.type === "text" || !isCompareStat(d.type, d.config)) return min;
  return { minW: Math.max(min.minW, Math.min(COMPARE_STAT_SIZE.w, d.w)), minH: Math.max(min.minH, Math.min(COMPARE_STAT_SIZE.h, d.h)) };
}

export function toGrid(drafts: DraftWidget[]): GridItem[] {
  return drafts.map((d) => ({ i: d.key, x: d.x, y: d.y, w: d.w, h: d.h, ...minOf(d) }));
}

/**
 * Copy the grid's positions back into the drafts (matched by key). `grid` is readonly because react-grid-layout hands
 * `onLayoutChange` a readonly array. Returns the same array when nothing moved, so a no-op layout event is not an edit.
 */
export function applyGrid(drafts: DraftWidget[], grid: readonly GridItem[]): DraftWidget[] {
  const byKey = new Map(grid.map((g) => [g.i, g]));
  let changed = false;
  const next = drafts.map((d) => {
    const g = byKey.get(d.key);
    if (!g || (g.x === d.x && g.y === d.y && g.w === d.w && g.h === d.h)) return d;
    changed = true;
    return { ...d, x: g.x, y: g.y, w: g.w, h: g.h };
  });
  return changed ? next : drafts;
}

/**
 * The size a new widget starts with. `style` only matters for a text widget: a divider is a full-width rule. `config` only matters for a stat: one that
 * compares with last month starts 3 x 3.
 */
export function defaultSize(type: WidgetType, style?: TextStyle, config?: Partial<WidgetConfig>): { w: number; h: number } {
  if (isCompareStat(type, config)) return { ...COMPARE_STAT_SIZE };
  return { ...(type === "text" && style === "divider" ? DIVIDER_SIZE : SIZE[type]) };
}

/** A new widget starts a fresh row at column 0 below everything; the editor then closes it up into any free space (compactVertical). */
export function nextPosition(drafts: DraftWidget[], _size: { w: number; h: number }): { x: number; y: number } {
  return { x: 0, y: drafts.reduce((bottom, d) => Math.max(bottom, d.y + d.h), 0) };
}

/**
 * Close the layout upwards (gravity), in reading order (y, then x, then position in `items`): each item moves up while the row above
 * is free, then moves down while it collides. For layouts without overlaps this is the result of react-grid-layout's
 * `verticalCompactor`, so the editor's live preview and the committed state agree; for overlapping (old saved) layouts the library
 * pushes later items ahead of itself and ours does not, and OURS is used everywhere. Collisions use the columns the read-only grid
 * draws (`columnsOf`) and a height of at least 1. Returns `items` itself when nothing moved.
 */
export function compactVertical<T extends { x: number; y: number; w: number; h: number }>(items: readonly T[]): T[] {
  const order = items.map((_, index) => index).sort((a, b) => items[a].y - items[b].y || items[a].x - items[b].x || a - b);
  const placed: { start: number; end: number; top: number; bottom: number }[] = [];
  const out = [...items];
  let moved = false;
  for (const index of order) {
    const item = items[index];
    const { start, end } = columnsOf(item);
    const height = Math.max(1, item.h);
    const hits = (y: number) => placed.some((p) => p.start < end && start < p.end && p.top < y + height && y < p.bottom);
    let y = Math.max(0, item.y);
    while (y > 0 && !hits(y - 1)) y -= 1;
    while (hits(y)) y += 1;
    placed.push({ start, end, top: y, bottom: y + height });
    if (y !== item.y) {
      out[index] = { ...item, y };
      moved = true;
    }
  }
  return moved ? out : (items as T[]);
}

let counter = 0;
/** crypto.randomUUID needs a secure context and this app is served over plain HTTP on the LAN, so use a counter. */
export function newKey(): string {
  counter += 1;
  return `new-${counter}`;
}
