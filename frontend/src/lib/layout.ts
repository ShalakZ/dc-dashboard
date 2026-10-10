import type { Widget, WidgetType } from "../api/types";

export const GRID_COLS = 12;

export interface GridItem { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }

/** A widget being edited: no id yet for new ones, so it is keyed by a client-side `key` (String(id) for saved widgets). */
export type DraftWidget = Omit<Widget, "id"> & { key: string };

const SIZE: Record<WidgetType, { w: number; h: number }> = {
  timeseries: { w: 6, h: 4 }, bar: { w: 6, h: 4 }, stat: { w: 3, h: 2 }, gauge: { w: 3, h: 3 }, table: { w: 6, h: 4 },
};
const MIN: Record<WidgetType, { minW: number; minH: number }> = {
  timeseries: { minW: 3, minH: 3 }, bar: { minW: 3, minH: 3 }, stat: { minW: 2, minH: 2 }, gauge: { minW: 2, minH: 2 }, table: { minW: 3, minH: 3 },
};

/** The columns (end exclusive) the read-only grid really draws for a widget: it never spills past the last column. */
export function columnsOf({ x, w }: { x: number; w: number }): { start: number; end: number } {
  const start = Math.min(Math.max(x, 0), GRID_COLS - 1);
  return { start, end: start + Math.max(1, Math.min(w, GRID_COLS - start)) };
}

/** Saved rows are normalised once to the rectangle the grid draws (x/w inside the 12 columns, h at least 1, y at least 0); valid rows are unchanged. */
export function toDrafts(widgets: Widget[]): DraftWidget[] {
  return widgets.map((w) => {
    const { start, end } = columnsOf(w);
    return { key: String(w.id), type: w.type, title: w.title, config: w.config, x: start, y: Math.max(0, w.y), w: end - start, h: Math.max(1, w.h) };
  });
}

export function toGrid(drafts: DraftWidget[]): GridItem[] {
  return drafts.map((d) => ({ i: d.key, x: d.x, y: d.y, w: d.w, h: d.h, ...MIN[d.type] }));
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

export function defaultSize(type: WidgetType): { w: number; h: number } {
  return { ...SIZE[type] };
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
