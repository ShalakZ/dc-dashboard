import { useState, type FormEvent } from "react";
import { METRICS, type Asset, type MappingIn, type Metric } from "../api/types";

export type MappingBody = Omit<MappingIn, "point_id">;

export function MappingForm({ assets, initial, onSubmit, onCancel }: {
  assets: Asset[]; initial?: Partial<MappingBody>; onSubmit: (body: MappingBody) => Promise<void>; onCancel: () => void;
}) {
  const [assetId, setAssetId] = useState(initial?.asset_id ? String(initial.asset_id) : "");
  const [metric, setMetric] = useState<Metric>(initial?.metric ?? "active_power_kw");
  const [interval, setInterval_] = useState(initial?.interval_seconds ? String(initial.interval_seconds) : "");
  const [scale, setScale] = useState(String(initial?.scale ?? 1));
  const [unit, setUnit] = useState(initial?.custom_unit ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (assetId === "") return setError("choose an asset");
    try {
      await onSubmit({
        asset_id: Number(assetId), metric, scale: Number(scale) || 1,
        interval_seconds: interval.trim() === "" ? null : Number(interval),
        custom_unit: metric === "custom" && unit.trim() !== "" ? unit.trim() : null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <form onSubmit={submit}>
      <label>Asset
        <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
          <option value="">(choose)</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label>Metric
        <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
          {METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label>Interval (s, blank = default)<input type="number" min="1" step="1" value={interval} onChange={(e) => setInterval_(e.target.value)} /></label>
      <label>Scale<input type="number" step="any" min="0" value={scale} onChange={(e) => setScale(e.target.value)} /></label>
      <label>Custom unit<input value={unit} disabled={metric !== "custom"} onChange={(e) => setUnit(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button type="submit">Save</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
