import type { BillingAssetRow, BillingCosts } from "../api/types";
import { foldModel, type FoldModel } from "./foldLevels";

/** Where the Billing page remembers which rows are folded (one value for the page, in this browser, for this site address). */
export const BILLING_FOLD_KEY = "dcdash.billingFolded";

/** A row of the table as the page shows it. `below` is always the full number of rows under it (a folded row still counts them). */
export interface RowView {
  asset: BillingAssetRow;
  depth: number;
  below: number;
  /** `leaf` has nothing to fold. With a filter, `open` means a row that has a shown row under it and `leaf` one that has none. */
  mode: "leaf" | "open" | "folded";
  /** With a filter: shown only because a row under it matches. */
  context: boolean;
}

export interface VisibleRows {
  rows: RowView[];
  shown: number;
  total: number;
  /** The rows whose name matches the filter (0 when there is no filter). */
  matches: number;
  filtering: boolean;
}

/** Whether the month has a table to draw: at least one asset, and at least one with energy data. The two empty answers are exactly its negation. */
export function billingHasRows(costs: BillingCosts): boolean {
  return costs.assets.length > 0 && costs.assets.some((a) => a.total !== null);
}

/** The fold model of the billing rows, which are keyed by `asset_id`. */
export function billingModel(assets: readonly BillingAssetRow[]): FoldModel {
  return foldModel(assets.map((a) => ({ id: a.asset_id, parent_id: a.parent_id })));
}

/**
 * The rows to draw. Without a filter (text that is empty once trimmed): every row that has no folded ancestor.
 * With a filter: the rows whose NAME contains it (case-insensitive, never the path) and every ancestor of one; the fold is ignored, not changed,
 * and a match's other descendants are not shown. Depth first from the roots in list order, with a stack, so a deep tree cannot overflow the stack.
 */
export function visibleRows(assets: readonly BillingAssetRow[], model: FoldModel, folded: ReadonlySet<number>, filter: string): VisibleRows {
  const rowById = new Map<number, BillingAssetRow>();
  for (const asset of assets) if (!rowById.has(asset.asset_id)) rowById.set(asset.asset_id, asset);
  const needle = filter.trim().toLowerCase();
  return needle === "" ? plainRows(rowById, model, folded) : filteredRows(rowById, model, needle);
}

function plainRows(rowById: ReadonlyMap<number, BillingAssetRow>, model: FoldModel, folded: ReadonlySet<number>): VisibleRows {
  const rows: RowView[] = [];
  const stack = [...model.roots].reverse();
  while (stack.length > 0) {
    const id = stack.pop()!;
    const asset = rowById.get(id);
    if (!asset) continue;
    const kids = model.children.get(id) ?? [];
    const isFolded = kids.length > 0 && folded.has(id);
    rows.push({
      asset,
      depth: model.depth.get(id) ?? 0,
      below: model.below.get(id) ?? 0,
      mode: kids.length === 0 ? "leaf" : isFolded ? "folded" : "open",
      context: false,
    });
    if (!isFolded) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return { rows, shown: rows.length, total: model.total, matches: 0, filtering: false };
}

function filteredRows(rowById: ReadonlyMap<number, BillingAssetRow>, model: FoldModel, needle: string): VisibleRows {
  const matching = new Set<number>();
  for (const [id, asset] of rowById) if (asset.name.toLowerCase().includes(needle)) matching.add(id);
  if (matching.size === 0) return { rows: [], shown: 0, total: model.total, matches: 0, filtering: true };

  // The whole tree in tree order; read backwards, every row is met after the rows under it, so a row is kept when it matches or a kept row hangs under it.
  const order: number[] = [];
  const stack = [...model.roots].reverse();
  while (stack.length > 0) {
    const id = stack.pop()!;
    order.push(id);
    const kids = model.children.get(id);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  const keep = new Set<number>();
  const hasKeptChild = new Set<number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if ((model.children.get(id) ?? []).some((child) => keep.has(child))) hasKeptChild.add(id);
    if (matching.has(id) || hasKeptChild.has(id)) keep.add(id);
  }

  const rows: RowView[] = [];
  for (const id of order) {
    const asset = rowById.get(id);
    if (!keep.has(id) || !asset) continue;
    rows.push({
      asset,
      depth: model.depth.get(id) ?? 0,
      below: model.below.get(id) ?? 0,
      mode: hasKeptChild.has(id) ? "open" : "leaf",
      context: !matching.has(id),
    });
  }
  return { rows, shown: rows.length, total: model.total, matches: matching.size, filtering: true };
}

const rowsWord = (count: number) => (count === 1 ? "row" : "rows");

/** `Collapse Hall 1, 59 rows below` / `Expand Hall 1, 1 row below`: the name of a twisty. */
export function twistyLabel(name: string, open: boolean, below: number): string {
  return `${open ? "Collapse" : "Expand"} ${name}, ${below} ${rowsWord(below)} below`;
}

/** The line beside the controls: how many rows are on screen, or how many match. */
export function rowsLine(v: { shown: number; total: number; matches: number; filtering: boolean }): string {
  if (v.filtering) return v.matches === 0 ? "No rows match" : `${v.matches} of ${v.total} ${rowsWord(v.total)} match`;
  if (v.shown < v.total) return `Showing ${v.shown} of ${v.total} rows`;
  if (v.total === 0) return "No rows";
  return v.total === 1 ? "1 row" : `All ${v.total} rows shown`;
}

/** What the table says when a filter matches nothing. */
export function noMatchText(filter: string): string {
  return `No assets match "${filter.trim()}".`;
}
