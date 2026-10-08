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

export function toDrafts(widgets: Widget[]): DraftWidget[] {
  return widgets.map((w) => ({ key: String(w.id), type: w.type, title: w.title, config: w.config, x: w.x, y: w.y, w: w.w, h: w.h }));
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

/** A new widget starts a fresh row at column 0, whatever its size (the grid then compacts it upwards). */
export function nextPosition(drafts: DraftWidget[], _size: { w: number; h: number }): { x: number; y: number } {
  return { x: 0, y: drafts.reduce((bottom, d) => Math.max(bottom, d.y + d.h), 0) };
}

let counter = 0;
/** crypto.randomUUID needs a secure context and this app is served over plain HTTP on the LAN, so use a counter. */
export function newKey(): string {
  counter += 1;
  return `new-${counter}`;
}
