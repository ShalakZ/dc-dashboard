import { useEffect, useState, type FormEvent } from "react";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { InfoTip } from "../components/InfoTip";
import { PageHeader } from "../components/PageHeader";
import { FormSkeleton, Skeleton, SkeletonRegion, TableSkeleton, TilesSkeleton } from "../components/Skeleton";
import { useRowsPerDay, useSaveStorageSettings, useSetStorageDefault, useStorage, useStorageSettings } from "../api/queries";
import type { RowsPerDayRange, StorageSettings, StorageStats } from "../api/types";
import { storageLoss } from "../lib/impact";
import { FIELD_HELP, TILE_HELP } from "../lib/storageHelp";

/** A size as text, one decimal: GiB from 1 GiB up, MiB below it (a small database would read 0.0 GiB). */
export function sizeText(bytes: number): string {
  const mib = bytes / 1024 ** 2;
  return mib < 1023.95 ? `${mib.toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(1)} GiB`; // 1023.95 MiB would round to 1024.0 MiB
}
export const FIELDS: [keyof StorageSettings, string][] = [
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
  return daysUntilFull === null ? "not growing" : `${Math.round(daysUntilFull).toLocaleString("en-US")} days`;
}

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;  // the server's limit (core/storage.py MAX_RANGE_DAYS)

/** Why a rows-per-day range cannot be asked for, or null. Days are `YYYY-MM-DD` UTC days; `lastDay` comes from the server (never this
 * browser's clock). The order is the server's, so its 422 and this agree. */
export function checkRange(start: string, end: string, lastDay: string): string | null {
  if (start > end) return "The first day must not be after the last day.";
  if (end > lastDay) return "Choose days up to today (UTC).";
  if ((Date.parse(end) - Date.parse(start)) / DAY_MS + 1 > MAX_RANGE_DAYS) return `At most ${MAX_RANGE_DAYS} days at a time.`;
  return null;
}

function Tile({ title, tip, big, note }: { title: string; tip: string; big: string; note?: string }) {
  return (
    <div className="tile">
      <div className="muted"><span>{title}</span><InfoTip>{tip}</InfoTip></div>
      <div className="big">{big}</div>
      {note && <small className="muted">{note}</small>}
    </div>
  );
}

const rowCount = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"} in total`;

/** The daily row counts: the last 7 days from the storage reply until the person picks another range of days. */
function RowsPerDay({ initial }: { initial: StorageStats["rows_per_day"] }) {
  const firstShown = initial[0]?.day ?? "";
  const lastShown = initial[initial.length - 1]?.day ?? "";
  const [start, setStart] = useState(firstShown);
  const [end, setEnd] = useState(lastShown);
  const [chosen, setChosen] = useState<{ start: string; end: string } | null>(null);  // the range asked for; null = the initial 7 days
  const [problem, setProblem] = useState<string | null>(null);
  const [seen, setSeen] = useState<RowsPerDayRange | null>(null);  // the last answer: its bounds are the server's
  const query = useRowsPerDay(chosen?.start ?? null, chosen?.end ?? null);
  useEffect(() => { if (query.data) setSeen(query.data); }, [query.data]);
  const lastDay = seen?.last_day ?? lastShown;

  const change = (nextStart: string, nextEnd: string) => {
    setStart(nextStart);
    setEnd(nextEnd);
    if (!nextStart || !nextEnd) { setProblem(null); return; }  // a cleared input: nothing to ask or to complain about
    const why = checkRange(nextStart, nextEnd, lastDay);
    setProblem(why);
    if (why === null) setChosen(nextStart === firstShown && nextEnd === lastShown ? null : { start: nextStart, end: nextEnd });
  };
  const reset = () => { setStart(firstShown); setEnd(lastShown); setChosen(null); setProblem(null); };

  let body;
  if (chosen === null) {
    body = <DayTable days={initial} total={initial.reduce((sum, d) => sum + d.rows, 0)} />;
  } else if (query.isError) {
    body = <p className="error" role="alert">{query.error.message}</p>;
  } else if (query.isPending) {
    body = <TableSkeleton columns={2} rows={7} label="Loading rows per day" />;
  } else if (query.data.first_day === null) {
    body = <p className="muted">No readings stored yet.</p>;
  } else {
    body = <DayTable days={query.data.days} total={query.data.total_rows} />;
  }
  return (
    <div className="rows-day">
      <h2 className="section-title">Rows per day</h2>
      <div className="rows-range">
        <label>
          Rows from day
          <input type="date" value={start} min={seen?.first_day ?? undefined} max={lastDay} onChange={(e) => change(e.target.value, end)} />
        </label>
        <label>
          Rows to day
          <input type="date" value={end} min={seen?.first_day ?? undefined} max={lastDay} onChange={(e) => change(start, e.target.value)} />
        </label>
        <button type="button" className="quiet" onClick={reset}>Last 7 days</button>
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      <p className="muted">Days are UTC days, midnight to midnight UTC, not days in the site's time zone.</p>
      {body}
    </div>
  );
}

function DayTable({ days, total }: { days: { day: string; rows: number }[]; total: number }) {
  return (
    <>
      <p className="muted">{rowCount(total)}</p>
      <div className="table-wrap">
        <table>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}><td>{d.day}</td><td className="num">{d.rows.toLocaleString("en-US")}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
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
  if (stats.isPending || settings.isPending || !form) {
    // The page in its order: the five real tiles (three with their note line), the disk note, Rows per day (heading, range fields, the UTC
    // note and the count, then the seven day rows with no header, as the real table has none), then the form, whose own height is a guess
    // (its rows lay out in columns). All lines are placeholders: a region holds no words but its label. Banners are data and are not drawn.
    return (
      <section className="admin-page storage-page">
        <PageHeader title="Storage" sub="How much space the readings take, and how long they are kept." />
        <SkeletonRegion label="Loading storage">
          <TilesSkeleton count={5} plain className="storage-tiles" notes={[1, 2, 4]} />
          <p className="muted" aria-hidden="true"><Skeleton width="90%" /></p>
          <div className="rows-day" aria-hidden="true">
            <h2 className="section-title"><Skeleton width="12ch" /></h2>
            <div className="rows-range">
              {[0, 1].map((i) => (
                <div className="sk-field" key={i}><Skeleton width="12ch" /><Skeleton variant="block" width={150} height={34} /></div>
              ))}
              <Skeleton variant="block" width={96} height={30} />
            </div>
            <p className="muted"><Skeleton width="60%" /></p>
            <p className="muted"><Skeleton width="16ch" /></p>
            <TableSkeleton columns={2} rows={7} headless />
          </div>
          <FormSkeleton rows={4} wide />
        </SkeletonRegion>
      </section>
    );
  }
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
  const warnIcon = <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>;
  return (
    <section className="admin-page storage-page">
      <PageHeader title="Storage" sub="How much space the readings take, and how long they are kept." />
      {s.warn && (
        <div role="alert" className="banner banner-warn">
          {warnIcon}
          <span>Database uses {s.used_pct}% of the configured capacity.</span>
        </div>
      )}
      {s.retention_paused && (
        <div role="alert" className="banner banner-warn">
          {warnIcon}
          <span>
            Retention is paused (usually because a restore paused it so that older readings survive). Nothing is deleted while it is paused, and the disk is
            not trimmed either. Press Save to start retention again; the save lists what it would delete and asks first.
          </span>
        </div>
      )}
      <div className="tiles storage-tiles">
        <Tile title="Database size" tip={TILE_HELP.database} big={sizeText(s.database_bytes)} />
        <Tile
          title="Readings (raw)"
          tip={TILE_HELP.readings}
          big={sizeText(s.readings_bytes_total)}
          note={s.readings_bytes_uncompressed ? `compressed ${sizeText(s.readings_bytes_compressed)} of ${sizeText(s.readings_bytes_uncompressed)}, ratio ${ratio}` : "nothing compressed yet"}
        />
        <Tile title="Rollups" tip={TILE_HELP.rollups} big={sizeText(s.rollup_1m_bytes + s.rollup_1h_bytes)} note={`1 min ${sizeText(s.rollup_1m_bytes)}, 1 h ${sizeText(s.rollup_1h_bytes)}`} />
        <Tile title="Growth per day" tip={TILE_HELP.growth} big={`${sizeText(s.growth_bytes_per_day)} / day`} />
        <Tile title="Projected full" tip={TILE_HELP.projected} big={projection(s.used_pct, s.days_until_full)} note={`${s.used_pct}% of ${sizeText(s.disk_capacity_bytes)}`} />
      </div>
      <p className="muted">
        Free disk space is not visible from the API container; capacity is a setting below. Set it to the size of the volume holding the database.
      </p>
      <RowsPerDay initial={s.rows_per_day} />
      <div className="form-card wide">
        <h2 className="section-title">Retention and capacity</h2>
        <form className="retention-form" onSubmit={(e: FormEvent) => { e.preventDefault(); submit(false); }}>
          {FIELDS.map(([key, label]) => (
            <div className="has-tip" key={key}>
              <label>
                {label}
                <input type="number" step="any" value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} />
              </label>
              <InfoTip>{FIELD_HELP[key]}</InfoTip>
            </div>
          ))}
          {error && <p className="error" role="alert">{error}</p>}
          {note && !error && <p className="muted" role="status">{note}</p>}
          <div className="row">
            <button type="submit" className="primary" disabled={save.isPending}>Save</button>
            <button type="button" onClick={rememberAsDefault} disabled={makeDefault.isPending}>Set as default</button>
            <button type="button" className="quiet" onClick={() => fill(siteDefault ?? factory)}>Reset to default</button>
            <button type="button" className="quiet" onClick={() => fill(factory)}>Reset to factory settings</button>
          </div>
          <p className="muted">
            {siteDefault
              ? `This site's default: ${summary(siteDefault)}.`
              : "No site default has been set, so Reset to default loads the factory values."}{" "}
            Factory: {summary(factory)}. The two Resets only fill in the form; nothing changes until you press Save.
          </p>
        </form>
      </div>
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
