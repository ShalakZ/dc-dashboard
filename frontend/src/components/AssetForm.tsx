import { useState, type FormEvent } from "react";
import type { Asset, AssetIn } from "../api/types";
import { assetOptions } from "./dashboard/AssetPicker";

export function AssetForm({ assets, initial, excludeIds, onSubmit, onCancel }: {
  assets: Asset[]; initial?: Partial<AssetIn>; excludeIds: Set<number>;
  onSubmit: (body: AssetIn) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [parent, setParent] = useState(initial?.parent_id == null ? "" : String(initial.parent_id));
  const [kind, setKind] = useState(initial?.kind ?? "generic");
  const [sortOrder, setSortOrder] = useState(String(initial?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await onSubmit({ name, parent_id: parent === "" ? null : Number(parent), kind, sort_order: Number(sortOrder) || 0 });
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
      <label>Kind<input value={kind} onChange={(e) => setKind(e.target.value)} /></label>
      <label>Sort order<input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button type="submit">Save</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
