import { readStored, writeStored } from "./sidebarState";
import type { TreeNode } from "./tree";

const KEY = "dcdash.assetTreeFolded";
const MAX = 5000; // more than this is not something this app wrote

/** The ids of the folded branches the user left last time. Anything that is not a list of at most 5000 numbers is ignored; non-integer entries are dropped. */
export function readFolded(): Set<number> {
  const raw = readStored(KEY);
  if (raw === null) return new Set();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return new Set(); }
  if (!Array.isArray(value) || value.length > MAX) return new Set();
  return new Set(value.filter((id): id is number => Number.isInteger(id)));
}

export function saveFolded(ids: Iterable<number>): void {
  writeStored(KEY, JSON.stringify([...new Set(ids)].sort((x, y) => x - y).slice(0, MAX)));
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
