import type { Asset } from "../api/types";

export type TreeNode = Asset & { children: TreeNode[] };

function compare(x: Asset, y: Asset): number {
  // Code-point comparison: deterministic across runtimes (localeCompare depends on ICU collation).
  return x.sort_order - y.sort_order || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
}

export function buildTree(assets: Asset[]): TreeNode[] {
  const nodes = new Map<number, TreeNode>();
  for (const asset of assets) nodes.set(asset.id, { ...asset, children: [] });
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id === null ? undefined : nodes.get(node.parent_id);
    (parent ? parent.children : roots).push(node);
  }
  const sortAll = (list: TreeNode[]) => {
    list.sort(compare);
    list.forEach((node) => sortAll(node.children));
  };
  sortAll(roots);
  return roots;
}

export function descendantIds(nodes: TreeNode[], id: number): Set<number> {
  const out = new Set<number>();
  const collect = (node: TreeNode) => {
    out.add(node.id);
    node.children.forEach(collect);
  };
  const find = (list: TreeNode[]): TreeNode | undefined => {
    for (const node of list) {
      if (node.id === id) return node;
      const hit = find(node.children);
      if (hit) return hit;
    }
    return undefined;
  };
  const start = find(nodes);
  if (start) collect(start);
  return out;
}
