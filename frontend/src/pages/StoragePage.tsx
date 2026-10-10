import { useEffect, useState, type FormEvent } from "react";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { useSaveStorageSettings, useSetStorageDefault, useStorage, useStorageSettings } from "../api/queries";
import type { StorageSettings } from "../api/types";
import { storageLoss } from "../lib/impact";

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

const LABEL = Object.fromEntries(FIELDS) as Record<keyof StorageSettings, string>;
const WHOLE = ["raw_retention_days", "compress_after_days", "rollup_1m_retention_days", "warn_threshold_pct"] as const;

/** The server (core/storage.py StorageSettings) stays the authority; this only saves a round trip. Message order matters: a
 * rollup shorter than raw is reported before the rollup's own range. */
export function validate(s: StorageSettings): string | null {
  for (const [key, label] of FIELDS) if (!Number.isFinite(s[key])) return `${label} must be a number`;
  for (const key of WHOLE) if (!Number.isInteger(s[key])) return `${LABEL[key]} must be a whole number`;
  if (s.raw_retention_days < REFRESH_WINDOW_DAYS + 1) {
    return `raw retention must be at least ${REFRESH_WINDOW_DAYS + 1} days, one more than the ${REFRESH_WINDOW_DAYS}-day rollup refresh window`;
  }
  if (s.raw_retention_days > 3650) return "raw retention cannot be more than 3650 days";
  if (s.compress_after_days < 1 || s.compress_after_days > 365) return "compression delay must be between 1 and 365 days";
  if (s.raw_retention_days < s.compress_after_days + 1) return "raw retention must be at least one day longer than compression delay";
  if (s.rollup_1m_retention_days < s.raw_retention_days) return "1-minute rollup retention must not be shorter than raw retention";
  if (s.rollup_1m_retention_days < 30 || s.rollup_1m_retention_days > 36500) return "1-minute rollup retention must be between 30 and 36500 days";
  if (s.disk_capacity_gb <= 0) return "disk capacity must be positive";
  if (s.disk_capacity_gb > 1_000_000) return "disk capacity cannot be more than 1,000,000 GB";
  if (s.warn_threshold_pct < 50 || s.warn_threshold_pct > 99) return "the warning threshold must be between 50 and 99 percent";
  return null;
}

const summary = (d: StorageSettings) =>
  `raw ${d.raw_retention_days} days, compress after ${d.compress_after_days} days, 1-minute rollups ${d.rollup_1m_retention_days} days, capacity ${d.disk_capacity_gb} GB, warn at ${d.warn_threshold_pct} %`;

// days_until_full is null both when the database is already over capacity and when it is not growing.
export function projection(usedPct: number, daysUntilFull: number | null): string {
  if (usedPct >= 100) return "full";
  return daysUntilFull === null ? "not growing" : `${Math.round(daysUntilFull)} days`;
}

export function StoragePage() {
  const stats = useStorage();
  const settings = useStorageSettings();
  const save = useSaveStorageSettings();
  const makeDefault = useSetStorageDefault();
  const [form, setForm] = useState<StorageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState<{ detail: string; deletesNow: boolean } | null>(null);
  useEffect(() => {
    if (settings.data && !form) {
      const { factory: _factory, site_default: _siteDefault, ...values } = settings.data;
      setForm(values);
    }
  }, [settings.data, form]);
  if (stats.isError) return <p className="error" role="alert">{stats.error.message}</p>;
  if (settings.isError) return <p className="error" role="alert">{settings.error.message}</p>;
  if (stats.isPending || settings.isPending || !form) return <p>loading…</p>;
  const s = stats.data;
  const factory = settings.data.factory;
  const siteDefault = settings.data.site_default ?? null;
  const ratio = s.readings_bytes_uncompressed ? (s.readings_bytes_compressed / s.readings_bytes_uncompressed).toFixed(2) : "–";
  const fill = (values: StorageSettings) => { setForm({ ...values }); setError(null); setNote(null); };  // the Resets only fill the form
  const checked = (): boolean => {
    setNote(null);
    const problem = validate(form);
    setError(problem);
    return problem === null;
  };
  const submit = (confirm: boolean) => {
    if (!checked()) return;
    save.mutate({ values: form, confirm }, {
      onSuccess: () => setNote("Saved."),
      onError: (err) => {
        const loss = storageLoss(err);  // the server asks first when this save deletes readings
        if (loss) setNeedsConfirm(loss); else setError(err.message);
      },
    });
  };
  const rememberAsDefault = () => {
    if (!checked()) return;
    makeDefault.mutate(form, {
      onSuccess: () => setNote("Saved as this site's default. It is not in use yet: press Save to use these values."),
      onError: (err) => setError(err.message),
    });
  };
  return (
    <section>
      <h1>Storage</h1>
      {s.warn && <p role="alert" className="warning">Database uses {s.used_pct}% of the configured capacity.</p>}
      {s.retention_paused && (
        <p role="alert" className="warning">
          Retention is paused (usually because a restore paused it so that older readings survive). Nothing is deleted while it is paused, and the disk is
          not trimmed either. Press Save to start retention again; the save lists what it would delete and asks first.
        </p>
      )}
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
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); submit(false); }}>
        {FIELDS.map(([key, label]) => (
          <label key={key}>
            {label}
            <input type="number" step="any" value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} />
          </label>
        ))}
        {error && <p className="error" role="alert">{error}</p>}
        {note && !error && <p className="muted" role="status">{note}</p>}
        <div className="row">
          <button type="submit" disabled={save.isPending}>Save</button>
          <button type="button" onClick={rememberAsDefault} disabled={makeDefault.isPending}>Set as default</button>
          <button type="button" onClick={() => fill(siteDefault ?? factory)}>Reset to default</button>
          <button type="button" onClick={() => fill(factory)}>Reset to factory settings</button>
        </div>
        <p className="muted">
          {siteDefault
            ? `This site's default: ${summary(siteDefault)}.`
            : "No site default has been set, so Reset to default loads the factory values."}{" "}
          Factory: {summary(factory)}. The two Resets only fill in the form; nothing changes until you press Save.
        </p>
      </form>
      {needsConfirm && (
        <ConfirmDeleteDialog
          title={needsConfirm.deletesNow ? "Delete old readings?" : "Shorten retention?"}
          message={needsConfirm.detail.replace(/ Repeat the request with confirm=true to go ahead\.$/, "")}
          confirmLabel={needsConfirm.deletesNow ? "Save and delete" : "Shorten and save"}
          onConfirm={async () => {
            await save.mutateAsync({ values: form, confirm: true });
            setNeedsConfirm(null);
            setNote("Saved.");
          }}
          onCancel={() => setNeedsConfirm(null)}
        />
      )}
    </section>
  );
}
