import type { MoveGroup } from "../api/types";
import type { TreeNode } from "./tree";

/**
 * Where on a row the pointer is: the top quarter puts the dragged assets in front of the row, the middle half inside it (as its last
 * child), the bottom quarter behind it. "first" replaces "after" on an expanded row that shows children: behind such a row would open a
 * gap below its last child, so its bottom quarter means the first child.
 */
export type DropZone = "before" | "inside" | "after" | "first";

/** A place for moved assets: under `parent_id` (null = the top level), in front of `before_id` (null = last). Exactly the API's pair. */
export interface DropTarget {
  readonly parent_id: number | null;
  readonly before_id: number | null;
}

/** The area below the last row: the top level, last. */
export const ROOT_DROP: DropTarget = Object.freeze({ parent_id: null, before_id: null });

/**
 * The zone of a row at pointer height `y` (`top` and `height` are the row's rectangle, all in the same coordinates). The edges are 25% and
 * 75%: 25% itself is already "inside", 75% already "after". A pointer beyond the row counts as the nearest edge. A row with no height, or
 * a pointer that is not a number, is "inside": the one zone that does not reorder anything.
 */
export function dropZone(top: number, height: number, y: number, expandedWithKids: boolean): DropZone {
  if (!(height > 0) || !Number.isFinite(y)) return "inside";
  const offset = y - top;
  if (offset < height * 0.25) return "before";
  if (offset < height * 0.75) return "inside";
  return expandedWithKids ? "first" : "after";
}

/**
 * The whole tree, unfiltered, with what a drop needs: parents, children in tree order (the order `buildTree` gives, which is the order on
 * screen), names, and the position in a walk of the whole tree (a parent, then its children). Build it once per drag, not per event.
 */
export interface TreeIndex {
  has(id: number): boolean;
  /** null for a root, undefined for an id that is not in the tree. */
  parentOf(id: number): number | null | undefined;
  /** The children of `parent` in tree order; `null` = the top level. Empty for a leaf or an unknown id. */
  childrenOf(parent: number | null): readonly number[];
  nameOf(id: number): string | undefined;
  /** Position in a walk of the whole tree, parents before children; -1 for an id that is not in the tree. */
  rankOf(id: number): number;
}

export function indexTree(nodes: readonly TreeNode[]): TreeIndex {
  const parents = new Map<number, number | null>();
  const children = new Map<number | null, number[]>();
  const names = new Map<number, string>();
  const ranks = new Map<number, number>();
  const walk = (list: readonly TreeNode[], parent: number | null) => {
    children.set(parent, list.map((node) => node.id));
    for (const node of list) {
      parents.set(node.id, parent);
      names.set(node.id, node.name);
      ranks.set(node.id, ranks.size);
      walk(node.children, node.id);
    }
  };
  walk(nodes, null);
  return {
    has: (id) => parents.has(id),
    parentOf: (id) => parents.get(id),
    childrenOf: (parent) => children.get(parent) ?? [],
    nameOf: (id) => names.get(id),
    rankOf: (id) => ranks.get(id) ?? -1,
  };
}

/** The first of `list` from position `from` on that is not in `moved`; null if there is none. */
function firstStaying(list: readonly number[], from: number, moved: ReadonlySet<number>): number | null {
  for (let at = from; at < list.length; at++) if (!moved.has(list[at])) return list[at];
  return null;
}

/**
 * The API's `{ parent_id, before_id }` for dropping on `zone` of row `row`. `before_id` is the first sibling at or after the position that
 * is NOT being moved (null if none), on the whole tree and not only the rows a filter shows: a moved sibling cannot be the anchor of its own
 * move. So A B C D with A and C dropped after B gives D, and the first child of an expanded row dragged onto that row's bottom edge gives
 * the next child. Null if `row` is not in the tree (a stale event).
 */
export function resolveDrop(zone: DropZone, row: number, moved: ReadonlySet<number>, index: TreeIndex): DropTarget | null {
  const parent = index.parentOf(row);
  if (parent === undefined) return null;
  if (zone === "inside") return { parent_id: row, before_id: null };
  if (zone === "first") return { parent_id: row, before_id: firstStaying(index.childrenOf(row), 0, moved) };
  const siblings = index.childrenOf(parent);
  const at = siblings.indexOf(row);
  return { parent_id: parent, before_id: firstStaying(siblings, zone === "before" ? at : at + 1, moved) };
}

/**
 * The ids that actually move: an id with an ancestor in the set travels inside that ancestor and is dropped. In tree order, as the server
 * orders them, not in the order given. Ids that are not in the tree are ignored, and a repeated id counts once.
 */
export function toRoots(ids: Iterable<number>, index: TreeIndex): number[] {
  const wanted = new Set<number>();
  for (const id of ids) if (index.has(id)) wanted.add(id);
  const roots: number[] = [];
  for (const id of wanted) {
    let inside = false;
    const seen = new Set<number>([id]); // a guard against a parent chain that loops
    for (let up = index.parentOf(id); up !== null && up !== undefined && !seen.has(up); up = index.parentOf(up)) {
      if (wanted.has(up)) {
        inside = true;
        break;
      }
      seen.add(up);
    }
    if (!inside) roots.push(id);
  }
  return roots.sort((x, y) => index.rankOf(x) - index.rankOf(y));
}

/** Is `id` somewhere below `ancestor`? */
function isBelow(index: TreeIndex, id: number, ancestor: number): boolean {
  const seen = new Set<number>([id]);
  for (let up = index.parentOf(id); up !== null && up !== undefined && !seen.has(up); up = index.parentOf(up)) {
    if (up === ancestor) return true;
    seen.add(up);
  }
  return false;
}

/** The server's name rule (`asset_names._KEY`): trimmed, runs of spaces collapsed, case ignored. A hint only: JS cannot match Postgres `lower()` everywhere. */
const nameKey = (name: string) => name.replace(/\s+/g, " ").trim().toLowerCase();

export type DropVerdict = { ok: true } | { ok: false; reason: string };
const no = (reason: string): DropVerdict => ({ ok: false, reason });

/**
 * Would a drop of `ids` on `target` (already resolved with `resolveDrop`, not the hovered row) be accepted? The reason is a sentence for the
 * invalid mark. Refuses: nothing to move, a place or position that is gone, an asset into itself or below itself, a drop that changes nothing
 * (same parent and the same order of children afterwards, which is the server's "unchanged"), and a name taken in the new place. The
 * name check is a hint: the server's 422 is the final word. Like the server it skips a pick that stays in its parent, so assets that
 * already share a name can still be reordered.
 */
export function dropVerdict({ ids, target, index }: { ids: Iterable<number>; target: DropTarget; index: TreeIndex }): DropVerdict {
  const roots = toRoots(ids, index);
  if (roots.length === 0) return no("Nothing to move.");
  const to = target.parent_id;
  const siblings = index.childrenOf(to);
  if (to !== null && !index.has(to)) return no("That place is no longer there.");
  if (target.before_id !== null && !siblings.includes(target.before_id)) return no("That position is no longer there.");
  const where = to === null ? "The top level" : `"${index.nameOf(to)}"`;

  for (const root of roots) {
    if (root === to) return no(`"${index.nameOf(root)}" cannot be moved into itself.`);
    if (to !== null && isBelow(index, to, root)) return no(`"${index.nameOf(root)}" cannot be moved into "${index.nameOf(to)}", which is inside it.`);
  }

  // The children of the target afterwards: those that stay, with the moved roots (in tree order) in front of the first staying sibling at or after before_id.
  const moving = new Set(roots);
  const staying = siblings.filter((id) => !moving.has(id));
  const anchor = target.before_id === null ? null : firstStaying(siblings, siblings.indexOf(target.before_id), moving);
  const insertAt = anchor === null ? staying.length : staying.indexOf(anchor);
  const after = [...staying.slice(0, insertAt), ...roots, ...staying.slice(insertAt)];

  if (roots.every((root) => index.parentOf(root) === to) && after.length === siblings.length && after.every((id, at) => id === siblings[at])) {
    return no(roots.length === 1 ? `"${index.nameOf(roots[0])}" is already there.` : "These assets are already there.");
  }

  const byName = new Map<string, number>();
  for (const id of after) {
    const key = nameKey(index.nameOf(id) ?? "");
    byName.set(key, (byName.get(key) ?? 0) + 1);
  }
  for (const root of roots) {
    if (index.parentOf(root) === to) continue; // it stays where it is: the server checks no name for it
    if ((byName.get(nameKey(index.nameOf(root) ?? "")) ?? 0) > 1) {
      return no(`${where} would have two assets named "${index.nameOf(root)}".`);
    }
  }
  return { ok: true };
}

/** The group the move API takes (`MoveBody.moves[n]`). Pass the roots from `toRoots`; the server normalises again either way. */
export function moveGroup(ids: Iterable<number>, target: DropTarget): MoveGroup {
  return { ids: [...ids], parent_id: target.parent_id, before_id: target.before_id };
}
