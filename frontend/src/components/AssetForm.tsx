import { useMemo, useState, type FormEvent } from "react";
import type { Asset, AssetIn } from "../api/types";
import { DEFAULT_KIND, kindKey, kindOptions, resolveKind } from "../lib/kinds";
import { assetOptions } from "./dashboard/AssetPicker";

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
  const [sortOrder, setSortOrder] = useState(String(initial?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const stored = other ? resolveKind(typed, options) : kind;
    if (stored === "") return setError("type the new kind");
    try {
      await onSubmit({ name, parent_id: parent === "" ? null : Number(parent), kind: stored, sort_order: Number(sortOrder) || 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      <label>Sort order<input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button type="submit">Save</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
