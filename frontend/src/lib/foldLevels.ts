import type { TreeNode } from "./tree";

/** What the fold needs of a row: who it is and who its parent is. */
export interface FoldItem { id: number; parent_id: number | null }

/** A list of at most this many rows opens as it is; a longer one opens folded to a level. */
export const FOLD_ROW_LIMIT = 60;

export interface FoldModel {
  /** ids with no parent in the list, list order */
  roots: readonly number[];
  /** 0 = root */
  depth: ReadonlyMap<number, number>;
  /** list order; a leaf has no entry */
  children: ReadonlyMap<number, readonly number[]>;
  /** the number of descendants (0 for a leaf) */
  below: ReadonlyMap<number, number>;
  /** ids with at least one child, list order */
  foldable: readonly number[];
  /** the deepest depth (0 for a flat list or an empty list) */
  maxDepth: number;
  /** the number of distinct ids */
  total: number;
}

/**
 * The shape of a list of rows that form a tree. The items may come in any order; a parent that is not in the list makes the item a root;
 * a duplicated id keeps its first item; a cycle (which the API never sends) is ended at its first item in list order, which becomes a root.
 * Every walk uses a loop, so the depth of the tree cannot overflow the stack.
 */
export function foldModel(items: readonly FoldItem[]): FoldModel {
  const order: number[] = []; // distinct ids, list order
  const parentOf = new Map<number, number | null>();
  for (const item of items) {
    if (parentOf.has(item.id)) continue;
    order.push(item.id);
    parentOf.set(item.id, item.parent_id);
  }
  // A parent that is not in the list, or is the item itself, leaves a root.
  for (const id of order) {
    const parent = parentOf.get(id) ?? null;
    if (parent === null || parent === id || !parentOf.has(parent)) parentOf.set(id, null);
  }
  breakCycles(order, parentOf);

  const roots: number[] = [];
  const childLists = new Map<number, number[]>();
  for (const id of order) {
    const parent = parentOf.get(id) ?? null;
    if (parent === null) { roots.push(id); continue; }
    const list = childLists.get(parent);
    if (list) list.push(id); else childLists.set(parent, [id]);
  }

  // Parents before children: the order the depths are known in, and (reversed) the order the descendants are counted in.
  const depth = new Map<number, number>();
  const walk: number[] = [];
  const stack = [...roots].reverse();
  for (const id of roots) depth.set(id, 0);
  let maxDepth = 0;
  while (stack.length > 0) {
    const id = stack.pop()!;
    walk.push(id);
    const next = (depth.get(id) ?? 0) + 1;
    const kids = childLists.get(id);
    if (!kids) continue;
    for (let i = kids.length - 1; i >= 0; i--) {
      depth.set(kids[i], next);
      stack.push(kids[i]);
    }
    if (next > maxDepth) maxDepth = next;
  }
  const below = new Map<number, number>();
  for (const id of order) below.set(id, 0);
  for (let i = walk.length - 1; i >= 0; i--) {
    const id = walk[i];
    const parent = parentOf.get(id) ?? null;
    if (parent !== null) below.set(parent, (below.get(parent) ?? 0) + (below.get(id) ?? 0) + 1);
  }

  return {
    roots,
    depth,
    children: childLists,
    below,
    foldable: order.filter((id) => childLists.has(id)),
    maxDepth,
    total: order.length,
  };
}

/** Walks up from every id; where a walk meets its own path, the member of that cycle that comes first in the list loses its parent. */
function breakCycles(order: readonly number[], parentOf: Map<number, number | null>): void {
  const position = new Map<number, number>();
  order.forEach((id, index) => position.set(id, index));
  const state = new Map<number, 1 | 2>(); // 1 = on the walk in progress, 2 = finished
  for (const start of order) {
    if (state.has(start)) continue;
    const path: number[] = [];
    let current: number | null = start;
    while (current !== null && !state.has(current)) {
      state.set(current, 1);
      path.push(current);
      current = parentOf.get(current) ?? null;
    }
    if (current !== null && state.get(current) === 1) {
      const cycle = path.slice(path.indexOf(current));
      const first = cycle.reduce((a, b) => ((position.get(b) ?? 0) < (position.get(a) ?? 0) ? b : a));
      parentOf.set(first, null);
    }
    for (const id of path) state.set(id, 2);
  }
}

/** Level L (1 up to `maxDepth`) shows the rows whose depth is below L: level 1 is the roots only. Anything below 1 is level 1. */
function levelFloor(level: number): number {
  return level >= 1 ? Math.trunc(level) : 1;
}

/**
 * The branches that are folded when the list shows level L: every foldable row at depth L - 1 or deeper, so a row
 * opened from there shows ONE more level, never its whole subtree. A level beyond the deepest folds nothing.
 */
export function foldedForLevel(model: FoldModel, level: number): Set<number> {
  const from = levelFloor(level) - 1;
  const out = new Set<number>();
  for (const id of model.foldable) if ((model.depth.get(id) ?? 0) >= from) out.add(id);
  return out;
}

/** The number of rows that show at level L: the rows with a depth below L. */
export function rowsAtLevel(model: FoldModel, level: number): number {
  const below = levelFloor(level);
  let count = 0;
  for (const depth of model.depth.values()) if (depth < below) count += 1;
  return count;
}

/**
 * Which level a fold amounts to: `"all"` when nothing that can fold is folded, the level when it is exactly that level's fold,
 * `null` for any other (custom) fold. Ids that are not foldable rows of the model are ignored.
 */
export function levelOfFold(model: FoldModel, folded: ReadonlySet<number>): number | "all" | null {
  const inside = model.foldable.filter((id) => folded.has(id));
  if (inside.length === 0) return "all";
  // A level's fold is every foldable row from one depth down, and that depth holds a foldable row (it is the way to the deepest row),
  // so the shallowest folded row names the only level it can be; it is that level when no foldable row at or below its depth is left open.
  let top = Infinity;
  for (const id of inside) top = Math.min(top, model.depth.get(id) ?? 0);
  let wanted = 0;
  for (const id of model.foldable) if ((model.depth.get(id) ?? 0) >= top) wanted += 1;
  return wanted === inside.length ? top + 1 : null;
}

/** The fold a long list opens with: the deepest level that keeps at most `limit` rows (never less than level 1); a list of `limit` rows or fewer, or a flat one, opens as it is. */
export function sizeDefaultFold(model: FoldModel, limit: number = FOLD_ROW_LIMIT): Set<number> {
  if (model.total <= limit || model.maxDepth === 0) return new Set();
  const perDepth = new Array<number>(model.maxDepth + 1).fill(0);
  for (const depth of model.depth.values()) perDepth[depth] += 1;
  let level = 1;
  let rows = 0;
  for (let candidate = 1; candidate <= model.maxDepth; candidate++) {
    rows += perDepth[candidate - 1];
    if (rows > limit) break;
    level = candidate;
  }
  return foldedForLevel(model, level);
}

/** The fold a long list opens with when the level is fixed: level `level` (or the deepest, if that is shallower); a list of `limit` rows or fewer opens as it is. */
export function fixedLevelFold(model: FoldModel, level: number, limit: number = FOLD_ROW_LIMIT): Set<number> {
  if (model.total <= limit) return new Set();
  return foldedForLevel(model, Math.min(levelFloor(level), model.maxDepth));
}

/**
 * The rows of a tree in the order it shows them (pre-order), each with the id of the node it hangs under (null for the top level),
 * so the model is the shape on screen. It reads the tree with a stack, not by recursion.
 */
export function flattenTree(nodes: readonly TreeNode[]): FoldItem[] {
  const out: FoldItem[] = [];
  const stack: { node: TreeNode; parent: number | null }[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) stack.push({ node: nodes[i], parent: null });
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    out.push({ id: node.id, parent_id: parent });
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], parent: node.id });
  }
  return out;
}
