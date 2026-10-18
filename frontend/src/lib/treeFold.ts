import { readFoldMemory, writeFoldMemory } from "./foldMemory";
import type { TreeNode } from "./tree";

export const TREE_FOLD_KEY = "dcdash.assetTreeFolded";
const KEY = TREE_FOLD_KEY;

/** The ids of the folded branches the user left last time (empty when nothing is remembered). See `readFoldMemory` for what is ignored. */
export function readFolded(): Set<number> {
  return readFoldMemory(KEY) ?? new Set();
}

/** The same, but `null` when nothing is remembered (a first visit, or the empty `[]` that older versions wrote on every visit) and an empty set after an explicit Expand all. */
export const readFoldedOrNull = (): Set<number> | null => readFoldMemory(KEY);

/** Remembers the folded ids: at most 5000, sorted, each once; an empty set is remembered as `none` (see `writeFoldMemory`). */
export function saveFolded(ids: Iterable<number>): void {
  writeFoldMemory(KEY, ids);
}

/** The ids of the nodes that have at least one child: the ones that can be folded. */
export function foldableIds(nodes: readonly TreeNode[]): number[] {
  const out: number[] = [];
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      if (node.children.length > 0) out.push(node.id);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
