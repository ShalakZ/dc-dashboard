import { useId, useMemo } from "react";
import type { Asset } from "../../api/types";
import { pickerLabel, pickerRows } from "../../lib/pickerRows";

// The helpers live in lib/pickerRows.ts; they stay importable from here for the pages and dialogs that use them.
export { assetLabels, assetOptions, pickerLabel, pickerRows } from "../../lib/pickerRows";
export type { PickerRow } from "../../lib/pickerRows";

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
      {!single && <p className="muted">{selected.length} selected (up to {max})</p>}
    </fieldset>
  );
}
