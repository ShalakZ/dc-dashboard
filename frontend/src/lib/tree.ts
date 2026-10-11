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

/** The parents of `id` from the root down to its direct parent; empty for a root or an id that is not in the tree. */
export function ancestorIds(nodes: readonly TreeNode[], id: number): number[] {
  const walk = (list: readonly TreeNode[], path: number[]): number[] | null => {
    for (const node of list) {
      if (node.id === id) return path;
      const hit = walk(node.children, [...path, node.id]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(nodes, []) ?? [];
}

/**
 * The asset's trail: its ancestors from the root down, ending with the asset itself; empty for an id that is not in `assets`.
 * It stops at a parent that is missing from the list (as `buildTree` makes such an asset a root) and at a cycle.
 */
export function assetTrail(assets: readonly Asset[], id: number): Asset[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const trail: Asset[] = [];
  const seen = new Set<number>();
  for (let at = byId.get(id); at && !seen.has(at.id); at = at.parent_id === null ? undefined : byId.get(at.parent_id)) {
    seen.add(at.id);
    trail.unshift(at);
  }
  return trail;
}

const INT32_MAX = 2147483647; // the API's asset ids are 32-bit; anything above it is a 500 there

/** The id in an asset URL, or null when it is not a plain positive integer that fits (never `Number()` of arbitrary text: "1e3", "0x10"). */
export function parseAssetId(raw: string | undefined): number | null {
  if (raw === undefined || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= INT32_MAX ? id : null;
}
