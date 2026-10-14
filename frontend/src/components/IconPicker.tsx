import { useEffect, useId, useRef, useState } from "react";
import { ASSET_ICONS } from "../lib/assetIcons";
import { Icon, type IconName } from "./Icon";

/**
 * The icon field of a dialog: the preview tile (the page header's), its caption and Change icon in one row, then the grid of icons.
 * `value` is a catalogue id, or null for Automatic (an id the catalogue lacks leaves no cell checked, so a stored value is never
 * rewritten by merely opening the grid). The form decides what the preview shows and what the caption says (`previewIcon`, `caption`,
 * and a second line, `hint`, that belongs to the same description); the picker owns how the grid behaves. With `automatic` the first
 * cell is Automatic: it draws the icon the kind gives and selects null. Without it there is no such cell (a kind always has an icon).
 */
export function IconPicker({ value, onChange, previewIcon, caption, hint, automatic }: {
  value: string | null;
  onChange: (value: string | null) => void;
  previewIcon: IconName;
  caption: string;
  /** A second, quieter line under the caption, read with it. */
  hint?: string;
  automatic?: { icon: IconName; title: string };
}) {
  const [picking, setPicking] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  // The radios of one picker share a name that no other picker has: two on one page (or one after another that is still unmounting) are two groups.
  const [labelId, captionId, gridId, groupName] = [useId(), useId(), useId(), useId()];

  // A click on the cell that is already checked fires no change, yet it is a choice (the kind dialog stops following its guess on it).
  const again = (id: string | null) => () => { if (value === id) onChange(id); };

  useEffect(() => {
    if (!picking) return;
    const inputs = grid.current!;
    (inputs.querySelector<HTMLInputElement>("input:checked") ?? inputs.querySelector<HTMLInputElement>("input"))?.focus();
  }, [picking]);

  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={captionId} className="icon-field">
      <span id={labelId} className="icon-field-label">Icon</span>
      <div className="icon-field-row">
        <span className="page-tile icon-preview" aria-hidden="true"><Icon name={previewIcon} /></span>
        <span id={captionId} className="icon-caption">{caption}{hint ? <small className="icon-hint">{hint}</small> : null}</span>
        <button type="button" ref={opener} aria-expanded={picking} aria-controls={gridId} onClick={() => setPicking((open) => !open)}>Change icon</button>
      </div>
      {/* Kept mounted and hidden, so aria-controls resolves; Enter would otherwise save the form while the user is only choosing.
          Escape closes the grid only: the dialog and the typed name stay (a second Escape, from outside the grid, closes the dialog). */}
      <div id={gridId} ref={grid} role="radiogroup" aria-label="Icon choices" className="icon-grid" hidden={!picking} onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
        if (e.key === "Escape") { e.stopPropagation(); setPicking(false); opener.current?.focus(); }
      }}>
        {automatic && (
          <label className="icon-cell icon-cell-auto check" title={automatic.title}>
            <input type="radio" name={groupName} checked={value === null} onChange={() => onChange(null)} onClick={again(null)} />
            <Icon name={automatic.icon} /><span className="sr-only">Automatic</span>
          </label>
        )}
        {ASSET_ICONS.map((entry) => (
          <label key={entry.id} className="icon-cell check" title={entry.label}>
            <input type="radio" name={groupName} value={entry.id} checked={value === entry.id} onChange={() => onChange(entry.id)} onClick={again(entry.id)} />
            <Icon name={entry.icon} /><span className="sr-only">{entry.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
