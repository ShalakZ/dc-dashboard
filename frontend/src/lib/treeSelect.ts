import type { TreeNode } from "./tree";

/**
 * The rows the person has picked in the Assets Tree to move, and the row a Shift-click ranges from. Called "picked" everywhere:
 * "selected" already means the asset open in the URL (`.node.is-selected`).
 *
 * Every transition below is pure: it never changes its input and returns the SAME object when nothing changes, so a store or a
 * `setState` built on it skips the render.
 */
export interface PickState {
  readonly ids: ReadonlySet<number>;
  readonly anchor: number | null;
}

export const EMPTY_PICK: PickState = { ids: new Set(), anchor: null };

function sameIds(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** A plain click on a row (without a modifier) that should pick it: that row alone, and the new anchor. */
export function pick(state: PickState, id: number): PickState {
  if (state.anchor === id && state.ids.size === 1 && state.ids.has(id)) return state;
  return { ids: new Set([id]), anchor: id };
}

/**
 * Ctrl/Cmd-click: add the row, or take it off if it is picked. The row becomes the anchor either way (the last Ctrl-clicked row is the
 * anchor even when that click un-picked it, as in a file manager).
 */
export function toggle(state: PickState, id: number): PickState {
  const ids = new Set(state.ids);
  if (!ids.delete(id)) ids.add(id);
  return { ids, anchor: id };
}

/**
 * Shift-click: replace the picks with the rows from the anchor to `id`, both included. `order` is the ids of the rows on screen in tree
 * order (`visibleOrder`), so rows hidden by a fold or a filter are never in the range. The anchor stays, so the next Shift-click ranges
 * from the same row. Without an anchor in `order` it acts like `toggle`. An `id` that is not in `order` (a stale event) changes nothing.
 */
export function pickRange(state: PickState, order: readonly number[], id: number): PickState {
  const to = order.indexOf(id);
  if (to < 0) return state;
  const from = state.anchor === null ? -1 : order.indexOf(state.anchor);
  if (from < 0) return toggle(state, id);
  const ids = new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1));
  return sameIds(ids, state.ids) ? state : { ids, anchor: state.anchor };
}

/**
 * Nothing picked. `anchor` keeps a row for the next Shift-click: a plain click opens an asset and clears the picks, and a Shift-click
 * then ranges from the row that was opened. Without it the anchor goes too.
 */
export function clear(state: PickState, anchor: number | null = null): PickState {
  if (state.ids.size === 0 && state.anchor === anchor) return state;
  return anchor === null ? EMPTY_PICK : { ids: new Set(), anchor };
}

/** Forget the picks (and the anchor) that are no longer in `existing`: an asset that was deleted or moved out of the list. */
export function prune(state: PickState, existing: ReadonlySet<number>): PickState {
  let dropped = false;
  const ids = new Set<number>();
  for (const id of state.ids) {
    if (existing.has(id)) ids.add(id);
    else dropped = true;
  }
  const anchor = state.anchor !== null && existing.has(state.anchor) ? state.anchor : null;
  if (!dropped && anchor === state.anchor) return state;
  return { ids: dropped ? ids : state.ids, anchor };
}

/**
 * Take `ids` off the picks (the rows that a move has just carried away) and leave the other picks, and the anchor unless it is one of them.
 * Returns the SAME state when none of `ids` is picked and none is the anchor.
 */
export function unpick(state: PickState, ids: Iterable<number>): PickState {
  const gone = new Set(ids);
  const kept = new Set<number>();
  for (const id of state.ids) if (!gone.has(id)) kept.add(id);
  const anchor = state.anchor !== null && gone.has(state.anchor) ? null : state.anchor;
  if (kept.size === state.ids.size && anchor === state.anchor) return state;
  return kept.size === 0 && anchor === null ? EMPTY_PICK : { ids: kept, anchor };
}

/**
 * The ids of the rows on screen, in the order they are drawn (a parent, then its children). Mirrors the tree's own rendering: each level
 * is narrowed by the filter (`visible`, null = no filter) and a folded branch shows no children, except that a filter ignores folds
 * ("a filter shows its matches even under a folded branch"). A range that differs from the rows the person sees picks the wrong rows.
 */
export function visibleOrder(nodes: readonly TreeNode[], collapsed: ReadonlySet<number>, visible: ReadonlySet<number> | null): number[] {
  const out: number[] = [];
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      if (visible !== null && !visible.has(node.id)) continue;
      out.push(node.id);
      if (visible !== null || !collapsed.has(node.id)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * The picks as an external store for `useSyncExternalStore`: a row reads its own flag with `useSyncExternalStore(store.subscribe, () => store.has(id))`
 * and re-renders only when that flag flips. `getSnapshot` returns the same `PickState` object until a transition really changes something;
 * each transition replaces the state once and tells the subscribers once.
 */
export interface PickStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PickState;
  has(id: number): boolean;
  pick(id: number): void;
  toggle(id: number): void;
  pickRange(order: readonly number[], id: number): void;
  clear(anchor?: number | null): void;
  prune(existing: ReadonlySet<number>): void;
  unpick(ids: Iterable<number>): void;
}

export function createPickStore(initial: PickState = EMPTY_PICK): PickStore {
  let state = initial;
  const listeners = new Set<() => void>();
  const apply = (next: PickState) => {
    if (next === state) return;
    state = next;
    // A copy, and a check before each call: a listener may unsubscribe itself or another while being told.
    for (const listener of [...listeners]) if (listeners.has(listener)) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    has: (id) => state.ids.has(id),
    pick: (id) => apply(pick(state, id)),
    toggle: (id) => apply(toggle(state, id)),
    pickRange: (order, id) => apply(pickRange(state, order, id)),
    clear: (anchor = null) => apply(clear(state, anchor)),
    prune: (existing) => apply(prune(state, existing)),
    unpick: (ids) => apply(unpick(state, ids)),
  };
}
