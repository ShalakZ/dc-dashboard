import type { AssetKind } from "../api/types";
import { EMPTY_PICK, toggle, type PickState } from "./treeSelect";

// The list tools of the Asset kinds page: which kinds a filter shows and how the checkboxes pick them. The picks themselves are
// `lib/treeSelect.ts`'s `PickState` (ids and an anchor) and its reducers (`toggle`, `clear`, `prune`, `unpick`); this file only adds what a
// checkbox column needs on top of them. Every function is pure: it never changes its input and returns the SAME state when nothing changes,
// so a `setState` built on it skips the render.

/** The four views of the list. Starter is the server's word (`AssetKind.starter`); Yours is every other kind; Unused is a count of 0. */
export type KindFilter = "all" | "starter" | "yours" | "unused";

export const KIND_FILTERS: readonly KindFilter[] = ["all", "starter", "yours", "unused"];

const matches: Record<KindFilter, (kind: AssetKind) => boolean> = {
  all: () => true,
  starter: (kind) => kind.starter,
  yours: (kind) => !kind.starter,
  unused: (kind) => kind.asset_count === 0,
};

/** The kinds a filter shows, in the list's own order. */
export function filterKinds(kinds: readonly AssetKind[], filter: KindFilter): AssetKind[] {
  return kinds.filter(matches[filter]);
}

/** How many kinds each filter would show. Over the whole list, never over the picks: the number on a filter does not move when a row is ticked. */
export function filterCounts(kinds: readonly AssetKind[]): Record<KindFilter, number> {
  const counts: Record<KindFilter, number> = { all: 0, starter: 0, yours: 0, unused: 0 };
  for (const kind of kinds) for (const filter of KIND_FILTERS) if (matches[filter](kind)) counts[filter] += 1;
  return counts;
}

/** The header checkbox ticking everything shown. `order` is the ids of the shown rows. No anchor: no row was the last one clicked. */
export function pickAll(order: readonly number[]): PickState {
  return order.length === 0 ? EMPTY_PICK : { ids: new Set(order), anchor: null };
}

/**
 * "Select all unused": ADD every unused kind of `kinds` (the shown rows) to what is picked. A union, so ticking two used kinds by hand and then
 * pressing it keeps them; the anchor stays. The same state when there is nothing to add.
 */
export function pickUnused(state: PickState, kinds: readonly AssetKind[]): PickState {
  let ids: Set<number> | null = null;
  for (const kind of kinds) {
    if (kind.asset_count !== 0 || state.ids.has(kind.id)) continue;
    ids ??= new Set(state.ids);
    ids.add(kind.id);
  }
  return ids === null ? state : { ids, anchor: state.anchor };
}

/**
 * Shift-click on a row checkbox: ADD the rows from the anchor to `id`, both included, to the picks. `order` is the ids of the shown rows in the
 * order the table draws them, so a row hidden by a filter is never in the range. A checkbox column adds where the Assets Tree (which picks by
 * clicking the row itself, `pickRange`) replaces: a tick is never taken back by a second tick. The anchor stays, so the next Shift-click ranges
 * from the same row. Without an anchor in `order` it acts like `toggle`; an `id` that is not in `order` (a stale event) changes nothing.
 */
export function addRange(state: PickState, order: readonly number[], id: number): PickState {
  const to = order.indexOf(id);
  if (to < 0) return state;
  const from = state.anchor === null ? -1 : order.indexOf(state.anchor);
  if (from < 0) return toggle(state, id);
  let ids: Set<number> | null = null;
  for (const inRange of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
    if (state.ids.has(inRange)) continue;
    ids ??= new Set(state.ids);
    ids.add(inRange);
  }
  return ids === null ? state : { ids, anchor: state.anchor };
}

/**
 * The row to hand the focus to when `id` is about to leave the list: the next shown row, else the previous one, else null (it was the only
 * row). `order` is the ids of the shown rows in table order, read at the moment the row was chosen: by the time it is gone the list has changed.
 */
export function neighbourId(order: readonly number[], id: number): number | null {
  const at = order.indexOf(id);
  if (at < 0) return null;
  return order[at + 1] ?? order[at - 1] ?? null;
}
