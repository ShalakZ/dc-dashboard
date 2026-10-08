import { useId, useMemo } from "react";
import type { Asset } from "../../api/types";
import { buildTree, type TreeNode } from "../../lib/tree";

export interface PickerRow { id: number; name: string; depth: number; parentPath: string; duplicate: boolean }

/**
 * Tree order (parents first) with each asset's depth and its parent's path; `duplicate` flags names used by more than one
 * asset. When `assets` is only part of the tree (the ones that have a metric), pass the whole tree as `tree`: the parent
 * path then names the real ancestors even if they are not offered, and the indent counts only the ancestors that are.
 */
export function pickerRows(assets: Asset[], tree: Asset[] = assets): PickerRow[] {
  const offered = new Set(assets.map((a) => a.id));
  const rows: PickerRow[] = [];
  const walk = (nodes: TreeNode[], depth: number, parentPath: string) => {
    for (const node of nodes) {
      const shown = offered.has(node.id);
      if (shown) rows.push({ id: node.id, name: node.name, depth, parentPath, duplicate: false });
      walk(node.children, shown ? depth + 1 : depth, parentPath === "" ? node.name : `${parentPath} / ${node.name}`);
    }
  };
  walk(buildTree(tree), 0, "");
  const count = new Map<string, number>();
  for (const row of rows) count.set(row.name, (count.get(row.name) ?? 0) + 1);
  return rows.map((row) => ({ ...row, duplicate: (count.get(row.name) ?? 0) > 1 }));
}

/** What names a row: its name, plus its parent path when more than one asset has that name. */
export function pickerLabel(row: PickerRow): string {
  return row.duplicate ? `${row.name} (${row.parentPath || "top level"})` : row.name;
}

/**
 * One label per asset id, in tree order, that tells assets apart wherever a bare name would not: the parent path for a
 * shared name, and `#id` too when two siblings share a name and so have the same path.
 */
export function assetLabels(assets: Asset[]): Map<number, string> {
  const rows = pickerRows(assets);
  const labels = rows.map(pickerLabel);
  const uses = new Map<string, number>();
  for (const label of labels) uses.set(label, (uses.get(label) ?? 0) + 1);
  return new Map(rows.map((row, i) => [row.id, (uses.get(labels[i]) ?? 0) > 1 ? `${labels[i]} #${row.id}` : labels[i]]));
}

interface Props {
  assets: Asset[];
  selected: number[];
  onChange: (ids: number[]) => void;
  /** One asset only (stat, gauge): radios instead of checkboxes. */
  single: boolean;
  /** Most assets a widget may have (checkboxes stop at this). */
  max: number;
  /** The whole asset tree, when `assets` lists only some of it (see `pickerRows`). */
  tree?: Asset[];
  /** A short note shown in brackets after an asset's name, e.g. "no voltage_v". */
  notes?: ReadonlyMap<number, string>;
  /** What to say when there is nothing to pick (default "No assets yet."). */
  empty?: string;
}

/** The asset tree as indented checkboxes (radios when single); a name used twice shows its parent path. */
export function AssetPicker({ assets, selected, onChange, single, max, tree, notes, empty = "No assets yet." }: Props) {
  const group = useId();
  const rows = useMemo(() => pickerRows(assets, tree ?? assets), [assets, tree]);
  const chosen = new Set(selected);
  const full = !single && selected.length >= max;
  const toggle = (id: number, on: boolean) => onChange(single ? [id] : on ? [...selected, id] : selected.filter((x) => x !== id));
  return (
    <fieldset className="asset-picker">
      <legend>{single ? "Asset" : "Assets"}</legend>
      {rows.length === 0 && <p className="muted">{empty}</p>}
      <div className="picker-list">
        {rows.map((row) => (
          <label key={row.id} className="picker-row" style={{ paddingLeft: row.depth * 16 }}>
            <input
              type={single ? "radio" : "checkbox"}
              name={single ? group : undefined}
              checked={chosen.has(row.id)}
              disabled={full && !chosen.has(row.id)}
              onChange={(e) => toggle(row.id, e.target.checked)}
            />
            {pickerLabel(row)}{notes?.has(row.id) ? ` (${notes.get(row.id)})` : ""}
          </label>
        ))}
      </div>
      {!single && <p className="muted">{selected.length} of {max} selected</p>}
    </fieldset>
  );
}
