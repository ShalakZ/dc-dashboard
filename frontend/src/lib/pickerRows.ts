import type { Asset } from "../api/types";
import { buildTree, type TreeNode } from "./tree";

export interface PickerRow { id: number; name: string; depth: number; parentPath: string; duplicate: boolean; label: string }

/**
 * Tree order (parents first) with each asset's depth and its parent's path; `duplicate` flags names used by more than one
 * asset and `label` is what to show: the name, plus the parent path when the name is shared, plus `#id` when two siblings
 * share both. When `assets` is only part of the tree (the ones that have a metric), pass the whole tree as `tree`: the parent
 * path then names the real ancestors even if they are not offered, and the indent counts only the ancestors that are.
 */
export function pickerRows(assets: Asset[], tree: Asset[] = assets): PickerRow[] {
  const offered = new Set(assets.map((a) => a.id));
  const rows: PickerRow[] = [];
  const walk = (nodes: TreeNode[], depth: number, parentPath: string) => {
    for (const node of nodes) {
      const shown = offered.has(node.id);
      if (shown) rows.push({ id: node.id, name: node.name, depth, parentPath, duplicate: false, label: node.name });
      walk(node.children, shown ? depth + 1 : depth, parentPath === "" ? node.name : `${parentPath} / ${node.name}`);
    }
  };
  walk(buildTree(tree), 0, "");
  const count = new Map<string, number>();
  for (const row of rows) count.set(row.name, (count.get(row.name) ?? 0) + 1);
  const named = rows.map((row) => ({ ...row, duplicate: (count.get(row.name) ?? 0) > 1 }));
  const base = named.map((row) => (row.duplicate ? `${row.name} (${row.parentPath || "top level"})` : row.name));
  const uses = new Map<string, number>();
  for (const label of base) uses.set(label, (uses.get(label) ?? 0) + 1);
  return named.map((row, i) => ({ ...row, label: (uses.get(base[i]) ?? 0) > 1 ? `${base[i]} #${row.id}` : base[i] }));
}

/** What names a row: its name, plus its parent path when more than one asset has that name, plus `#id` when that is still not enough. */
export function pickerLabel(row: PickerRow): string {
  return row.label;
}

/** One label per asset id, in tree order, that tells assets apart wherever a bare name would not. */
export function assetLabels(assets: Asset[]): Map<number, string> {
  return new Map(pickerRows(assets).map((row) => [row.id, row.label]));
}

/**
 * The options of a `<select>` of assets: tree order, indented by depth (non-breaking spaces, because a browser strips
 * ordinary leading spaces from an option), each labelled by `assetLabels`' rules. `exclude` leaves ids out (a form that
 * must not offer an asset's own descendants as its parent) while the paths still come from the whole list.
 */
export function assetOptions(assets: Asset[], exclude: ReadonlySet<number> = new Set()): { id: number; text: string }[] {
  const offered = assets.filter((a) => !exclude.has(a.id));
  return pickerRows(offered, assets).map((row) => ({ id: row.id, text: `${"\u00a0\u00a0".repeat(row.depth)}${row.label}` }));
}
