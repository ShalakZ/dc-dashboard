import { useEffect, useState, type FormEvent } from "react";
import { useSaveStorageSettings, useStorage, useStorageSettings } from "../api/queries";
import type { StorageSettings } from "../api/types";

const gib = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GiB`;
const FIELDS: [keyof StorageSettings, string][] = [
  ["raw_retention_days", "Raw retention (days)"],
  ["compress_after_days", "Compress after (days)"],
  ["rollup_1m_retention_days", "1-minute rollup retention (days)"],
  ["disk_capacity_gb", "Disk capacity (GB)"],
  ["warn_threshold_pct", "Warn at (% used)"],
];

/** The rollups refresh over this trailing window; the server (storage.py REFRESH_WINDOW_DAYS) refuses a raw retention shorter than one more day. */
export const REFRESH_WINDOW_DAYS = 7;

export function validate(s: StorageSettings): string | null {
  if (s.raw_retention_days < REFRESH_WINDOW_DAYS + 1) {
    return `raw retention must be at least ${REFRESH_WINDOW_DAYS + 1} days, one more than the ${REFRESH_WINDOW_DAYS}-day rollup refresh window`;
  }
  if (s.raw_retention_days < s.compress_after_days + 1) return "raw retention must be at least one day longer than compression delay";
  if (s.rollup_1m_retention_days < s.raw_retention_days) return "1-minute rollup retention must not be shorter than raw retention";
  if (s.disk_capacity_gb <= 0) return "disk capacity must be positive";
  return null;
}

// days_until_full is null both when the database is already over capacity and when it is not growing.
export function projection(usedPct: number, daysUntilFull: number | null): string {
  if (usedPct >= 100) return "full";
  return daysUntilFull === null ? "not growing" : `${Math.round(daysUntilFull)} days`;
}

export function StoragePage() {
  const stats = useStorage();
  const settings = useStorageSettings();
  const save = useSaveStorageSettings();
  const [form, setForm] = useState<StorageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data && !form) setForm(settings.data);
  }, [settings.data, form]);
  if (stats.isError) return <p className="error" role="alert">{stats.error.message}</p>;
  if (settings.isError) return <p className="error" role="alert">{settings.error.message}</p>;
  if (stats.isPending || !form) return <p>loading…</p>;
  const s = stats.data;
  const ratio = s.readings_bytes_uncompressed ? (s.readings_bytes_compressed / s.readings_bytes_uncompressed).toFixed(2) : "–";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = validate(form);
    setError(problem);
    if (!problem) save.mutate(form, { onError: (err) => setError(err.message) });
  };
  return (
    <section>
      <h1>Storage</h1>
      {s.warn && <p role="alert" className="warning">Database uses {s.used_pct}% of the configured capacity.</p>}
      <dl className="stats">
        <dt>Database size</dt><dd>{gib(s.database_bytes)}</dd>
        <dt>Readings (raw)</dt>
        <dd>{gib(s.readings_bytes_total)} — compressed {gib(s.readings_bytes_compressed)} of {gib(s.readings_bytes_uncompressed)} (ratio {ratio})</dd>
        <dt>Rollups</dt><dd>1 min {gib(s.rollup_1m_bytes)}, 1 h {gib(s.rollup_1h_bytes)}</dd>
        <dt>Growth</dt><dd>{gib(s.growth_bytes_per_day)} / day</dd>
        <dt>Projected full</dt>
        <dd>{projection(s.used_pct, s.days_until_full)} ({s.used_pct}% of {gib(s.disk_capacity_bytes)})</dd>
      </dl>
      <p className="muted">
        Free disk space is not visible from the API container; capacity is a setting below. Set it to the size of the volume holding the database.
      </p>
      <h2>Rows per day</h2>
      <table>
        <tbody>
          {s.rows_per_day.map((d) => (
            <tr key={d.day}><td>{d.day}</td><td>{d.rows.toLocaleString("en-US")}</td></tr>
          ))}
        </tbody>
      </table>
      <h2>Retention and capacity</h2>
      <form onSubmit={submit}>
        {FIELDS.map(([key, label]) => (
          <label key={key}>
            {label}
            <input type="number" step="any" value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} />
          </label>
        ))}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={save.isPending}>Save</button>
        {save.isSuccess && !error && <span className="muted"> saved</span>}
      </form>
    </section>
  );
}
