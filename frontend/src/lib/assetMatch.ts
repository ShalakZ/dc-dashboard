import type { TreeNode } from "./tree";

/** Whether a node's name or kind contains the needle. The needle is already trimmed and lower-cased by the caller. */
export function nameOrKindMatches(node: { name: string; kind: string }, needle: string): boolean {
  return node.name.toLowerCase().includes(needle) || node.kind.toLowerCase().includes(needle);
}

/** The ids to show while filtering: what matches by name or kind, and the ancestors of a match (a match's own children only if they match too). */
export function matchingIds(nodes: TreeNode[], needle: string): Set<number> {
  const out = new Set<number>();
  const walk = (node: TreeNode): boolean => {
    let hit = nameOrKindMatches(node, needle);
    for (const child of node.children) if (walk(child)) hit = true; // every child, no short-circuit: each needs its own verdict
    if (hit) out.add(node.id);
    return hit;
  };
  nodes.forEach(walk);
  return out;
}
