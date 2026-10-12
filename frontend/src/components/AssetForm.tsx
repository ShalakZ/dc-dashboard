import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { Asset, AssetIn } from "../api/types";
import { ASSET_ICONS, assetIcon, assetIconLabel, iconLabelFor } from "../lib/assetIcons";
import { kindIcon } from "../lib/kindIcon";
import { DEFAULT_KIND, kindKey, kindOptions, resolveKind } from "../lib/kinds";
import { assetOptions } from "./dashboard/AssetPicker";
import { Icon } from "./Icon";
import { useModalBusy } from "./Modal";

export function AssetForm({ assets, initial, excludeIds, onSubmit, onCancel }: {
  assets: Asset[]; initial?: Partial<AssetIn>; excludeIds: Set<number>;
  onSubmit: (body: AssetIn) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [parent, setParent] = useState(initial?.parent_id == null ? "" : String(initial.parent_id));
  const options = useMemo(() => kindOptions(assets, initial?.kind), [assets, initial?.kind]);
  // The stored text, untouched; a blank or missing kind starts on the default (in the spelling already in use, if any).
  const [kind, setKind] = useState(initial?.kind?.trim() ? initial.kind : resolveKind(DEFAULT_KIND, options));
  const [other, setOther] = useState(false); // "Other…" picked
  const [typed, setTyped] = useState("");
  const [icon, setIcon] = useState<string | null>(initial?.icon ?? null); // a catalogue id, null for Automatic; a stored id the catalogue lacks stays as it is until the user picks
  const [picking, setPicking] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const [labelId, captionId, gridId] = [useId(), useId(), useId()];
  const [sortOrder, setSortOrder] = useState(String(initial?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useModalBusy(submitting); // Escape must not close the dialog on a save that is still running
  // The kind the asset will have, as the preview must show it (the select keeps its last value while "Other…" is picked).
  const resolvedKind = other ? resolveKind(typed, options) : kind;
  const chosenLabel = icon === null ? null : assetIconLabel(icon);
  const automatic = kindIcon(resolvedKind);
  const caption = icon === null ? `Automatic (${iconLabelFor(automatic)})` : chosenLabel ?? `Unknown icon "${icon}"`;

  useEffect(() => {
    if (!picking) return;
    const inputs = grid.current!;
    (inputs.querySelector<HTMLInputElement>("input:checked") ?? inputs.querySelector<HTMLInputElement>("input"))?.focus();
  }, [picking]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    const stored = other ? resolveKind(typed, options) : kind;
    if (stored === "") return setError("type the new kind");
    setSubmitting(true);
    try {
      const body: AssetIn = { name, parent_id: parent === "" ? null : Number(parent), kind: stored, sort_order: Number(sortOrder) || 0 };
      if (icon !== (initial?.icon ?? null)) body.icon = icon; // only a change: a stored id the server later drops must not turn every edit into a 422
      await onSubmit(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Parent
        <select value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">(none)</option>
          {assetOptions(assets, excludeIds).map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
        </select>
      </label>
      <label>Kind
        <select value={other ? "" : kind} onChange={(e) => { setOther(e.target.value === ""); if (e.target.value !== "") setKind(e.target.value); }}>
          {options.map((k) => <option key={kindKey(k)} value={k}>{k}</option>)}
          <option value="">Other…</option>
        </select>
      </label>
      {other && <label>New kind<input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>}
      <div role="group" aria-labelledby={labelId} aria-describedby={captionId} className="icon-field">
        <span id={labelId} className="icon-field-label">Icon</span>
        <div className="icon-field-row">
          <span className="page-tile icon-preview" aria-hidden="true"><Icon name={assetIcon({ kind: resolvedKind, icon })} /></span>
          <span id={captionId} className="icon-caption">{caption}</span>
          <button type="button" aria-expanded={picking} aria-controls={gridId} onClick={() => setPicking((open) => !open)}>Change icon</button>
        </div>
        {/* Kept mounted and hidden, so aria-controls resolves; Enter would otherwise save the form while the user is only choosing. */}
        <div id={gridId} ref={grid} role="radiogroup" aria-label="Icon choices" className="icon-grid" hidden={!picking} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}>
          <label className="icon-cell check" title="Automatic">
            <input type="radio" name="asset-icon" checked={icon === null} onChange={() => setIcon(null)} />
            <Icon name={automatic} /><span className="sr-only">Automatic</span>
          </label>
          {ASSET_ICONS.map((entry) => (
            <label key={entry.id} className="icon-cell check" title={entry.label}>
              <input type="radio" name="asset-icon" value={entry.id} checked={icon === entry.id} onChange={() => setIcon(entry.id)} />
              <Icon name={entry.icon} /><span className="sr-only">{entry.label}</span>
            </label>
          ))}
        </div>
      </div>
      <label>Sort order<input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button type="button" onClick={onCancel} disabled={submitting}>Cancel</button><button type="submit" className="primary" disabled={submitting}>Save</button></div>
    </form>
  );
}
