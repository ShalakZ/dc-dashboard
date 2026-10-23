import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { Icon, type IconName } from "../components/Icon";
import { InfoTip } from "../components/InfoTip";
import { Modal, useModalBusy } from "../components/Modal";
import { PageCard } from "../components/PageCard";
import { PageHeader } from "../components/PageHeader";
import { READ_ONLY_TEXT, ReadOnlyNote } from "../components/ReadOnlyNote";
import { SaveButton } from "../components/SaveButton";
import { CTL_H, PageCardSkeleton, ParagraphSkeleton, Skeleton, SkeletonRegion, TableSkeleton, TilesSkeleton } from "../components/Skeleton";
import { eventsLoss, useEventsSettings, useRowsPerDay, useSaveEventsSettings, useSaveStorageSettings, useSaveWatchdogSettings, useSetStorageDefault, useSite, useStorage, useStorageSettings, useWatchdogSettings } from "../api/queries";
import type { EventsSettings, RowsPerDayRange, StorageSettings, StorageStats, WatchdogSettings, WatchdogValues } from "../api/types";
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

/** The note under the day table; the loading frame draws the same words as grey pills too. */
export const UTC_NOTE = "Days are UTC days, midnight to midnight UTC, not days in the site's time zone.";
/** The retention card's first paragraph; the loading frame draws the same words as grey pills, so it breaks into the same lines. */
export const DISK_NOTE = "Free disk space is not visible from the API container; capacity is a setting below. Set it to the size of the volume holding the database.";
/** W18: what removing assets or sources does to the stored readings (nothing: no foreign key; retention drops the raw and 1-minute ones, the hourly summaries stay). Static, so the skeleton draws it too. */
export const READINGS_NOTE = "Removing assets or sources does not remove their readings. They leave when retention drops them (see the limits below), except the hourly summaries, which stay. Shorten the retention to free space sooner; saving a shorter retention asks first.";
/** What Set as default says when it worked. It is also the longest line the retention card's message slot has to hold, so the slot reserves its height (data-reserve). */
const DEFAULT_SET_NOTE = "This site's default is updated. It is not in use yet: press Save to use these values.";
/** The last sentence of the summary under the buttons; a role that cannot change the settings has no Resets and does not read it. */
const RESETS_SENTENCE = " The two Resets only fill in the form; nothing changes until you press Save.";
// What the summary paragraph under the buttons says, with typical numbers: while loading only the length of each word is used.
const SUMMARY_SAMPLE = "This site's default: raw 30 days, compress after 7 days, 1-minute rollups 365 days, capacity 500 GB, warn at 85 %. "
  + "Factory: raw 30 days, compress after 7 days, 1-minute rollups 365 days, capacity 500 GB, warn at 85 %." + RESETS_SENTENCE;

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

function Tile({ icon, title, tip, big, note }: { icon: IconName; title: string; tip: string; big: string; note?: string }) {
  return (
    <div className="tile">
      <div className="muted"><span className="tile-label"><Icon name={icon} /><span>{title}</span></span><InfoTip>{tip}</InfoTip></div>
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
    <PageCard className="rows-day" icon="calendar" title="Rows per day">
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
      {body}
      {/* Under the table, not above it: how many lines the sentence takes depends on the card's width and the font, and above the table that would move the table and the skeleton's twin off each other */}
      <p className="muted">{UTC_NOTE}</p>
    </PageCard>
  );
}

/** A day's bar as a whole percent of the busiest day shown: nothing for a day with no rows, at least 1 % for any other (a sliver still reads as "some"). */
const share = (rows: number, peak: number) => (rows > 0 ? Math.max(1, Math.round((rows / peak) * 100)) : 0);

/** The day rows with a bar behind each number, scaled to the busiest day of the range shown. All zeros draw the empty tracks and no fill. The bar is decoration: the number is the text. */
function DayTable({ days, total }: { days: { day: string; rows: number }[]; total: number }) {
  const peak = Math.max(0, ...days.map((d) => d.rows));
  return (
    <>
      <p className="muted">{rowCount(total)}</p>
      <div className="table-wrap day-table">
        <table>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td className="num">
                  <div className="databar-cell">
                    <span className="databar" aria-hidden="true">
                      {peak > 0 && <span className="databar-fill" style={{ width: `${share(d.rows, peak)}%` }} />}
                    </span>
                    <span className="databar-num">{d.rows.toLocaleString("en-US")}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** w32: the day and the English short month (`24 Jul`) an instant falls on in `timezone`; UTC when the zone is unknown, null when `iso` is not a time. */
export function dayMonth(iso: string, timezone: string): string | null {
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return null;
  for (const zone of [timezone, "UTC"]) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, day: "numeric", month: "short" }).formatToParts(moment);
      const part = (type: string) => parts.find((p) => p.type === type)?.value;
      return `${part("day")} ${part("month")}`;
    } catch { /* a zone the browser does not know: UTC next */ }
  }
  return null;
}

/** What the System events card says about the journal: the rule, then how many events are kept now and the day of the oldest (nothing about it when none is kept). */
export function eventsKeptText(e: EventsSettings, timezone: string): string {
  const oldest = e.oldest ? dayMonth(e.oldest, timezone) : null;
  return `System events are kept ${e.retention_days} days or the newest ${e.max_rows.toLocaleString("en-US")}, whichever is fewer. Kept now: ${e.kept.toLocaleString("en-US")}${oldest ? `, the oldest from ${oldest}` : ""}.`;
}
/** The second line of the card. */
export const AUDIT_KEPT = "The audit log is kept forever.";
/** Typical numbers for the loading frame, whose sentence is drawn as grey word pills (only the length of each word is used), so it breaks into the lines the real one will. */
const EVENTS_SAMPLE: EventsSettings = {
  retention_days: 90, max_rows: 100_000, factory: { retention_days: 90, max_rows: 100_000 },
  bounds: { retention_days: [7, 400], max_rows: [10_000, 1_000_000] }, kept: 3412, oldest: "2026-07-24T08:15:00Z",
};
const EVENTS_DAYS_HELP = "Events older than this many days are deleted, once an hour. A problem that is still open is never deleted.";
const EVENTS_ROWS_HELP = "Only this many of the newest events are kept, even if they are younger than the days allow. It stops a burst of events from filling the database.";

/** `text` as a whole number inside `[low, high]`, or null (blank, a fraction, text, out of range). */
function wholeIn(text: string, [low, high]: [number, number]): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= low && n <= high ? n : null;
}
const inRange = ([low, high]: [number, number], unit: string) => `${unit} must be a whole number from ${low.toLocaleString("en-US")} to ${high.toLocaleString("en-US")}.`;

/**
 * The content of the Change... dialog (inside the Modal, so `useModalBusy` reaches it): the two numbers with the server's bounds, and one slot, always
 * there, for what the save has to say. A save that would shorten what is kept answers 409 with how many events go; the slot then says so and the same
 * button reads Confirm and save, which sends the request again with confirm=true; the focus moves to Cancel when the question arrives, so a repeated Enter cannot
 * confirm it unread. Changing a number takes the question back: the count was for the numbers that were sent. The buttons wait with aria-disabled and a guard, never native `disabled`: the pressed one holds the focus.
 */
function EventsRetentionForm({ current, onClose }: { current: EventsSettings; onClose: () => void }) {
  const save = useSaveEventsSettings();
  const [days, setDays] = useState(String(current.retention_days));
  const [rows, setRows] = useState(String(current.max_rows));
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<number | null>(null); // events the server said it would delete, once it has said so
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const daysHint = useId();
  const rowsHint = useId();
  const questionId = useId();
  useModalBusy(pending); // Escape must not close the dialog on a request that is still running
  // When the question arrives the focus goes to Cancel, off the button that turns into Confirm and save: a repeated Enter (or a double click) then cannot confirm a
  // shortening that has not been read. Confirming takes a Tab to the button. Cancel is read with the question, since the alert is announced before the focus moves.
  const questioned = asking !== null;
  useEffect(() => {
    if (questioned) cancelButton.current?.focus();
  }, [questioned]);
  const { retention_days: dayBounds, max_rows: rowBounds } = current.bounds;

  const edit = (set: (text: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    setAsking(null);
    setError(null);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    const retention_days = wholeIn(days, dayBounds);
    const max_rows = wholeIn(rows, rowBounds);
    if (retention_days === null || max_rows === null) {
      setAsking(null);
      setError(retention_days === null ? inRange(dayBounds, "Days") : inRange(rowBounds, "Events"));
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await save.mutateAsync({ values: { retention_days, max_rows }, confirm: asking !== null });
      onClose();
    } catch (err) {
      const loss = eventsLoss(err);
      if (loss) setAsking(loss.willDelete);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  const cancel = () => { if (!inFlight.current) onClose(); };

  return (
    <form className="storage-events-dialog" onSubmit={submit} noValidate>
      <p className="muted">System events are kept for this many days or this many events, whichever is fewer. Saving a shorter time asks first.</p>
      <div className="has-tip">
        <label>
          Keep events for (days)
          <input type="number" step={1} min={dayBounds[0]} max={dayBounds[1]} value={days} aria-describedby={daysHint} onChange={edit(setDays)} />
        </label>
        <InfoTip>{EVENTS_DAYS_HELP}</InfoTip>
        <small id={daysHint} className="muted storage-events-hint">From {dayBounds[0].toLocaleString("en-US")} to {dayBounds[1].toLocaleString("en-US")} days. Factory: {current.factory.retention_days.toLocaleString("en-US")}.</small>
      </div>
      <div className="has-tip">
        <label>
          Keep at most (events)
          <input type="number" step={1} min={rowBounds[0]} max={rowBounds[1]} value={rows} aria-describedby={rowsHint} onChange={edit(setRows)} />
        </label>
        <InfoTip>{EVENTS_ROWS_HELP}</InfoTip>
        <small id={rowsHint} className="muted storage-events-hint">From {rowBounds[0].toLocaleString("en-US")} to {rowBounds[1].toLocaleString("en-US")} events. Factory: {current.factory.max_rows.toLocaleString("en-US")}.</small>
      </div>
      {/* Always there and three lines tall (CSS), so the question or the refusal arriving moves neither the fields nor the buttons. One kind of announcer, an alert, for both. */}
      <div className="storage-events-slot">
        {error ? <p className="error" role="alert">{error}</p>
          : asking !== null ? <p id={questionId} role="alert">About {asking.toLocaleString("en-US")} {asking === 1 ? "event" : "events"} will be deleted within the hour. Press Confirm and save to go ahead.</p>
          : null}
      </div>
      <div className="row">
        <button type="button" ref={cancelButton} aria-disabled={pending || undefined} aria-describedby={questioned ? questionId : undefined} onClick={cancel}>Cancel</button>
        <button type="submit" className={asking === null ? "primary" : "danger"} aria-disabled={pending || undefined}>{asking === null ? "Save" : "Confirm and save"}</button>
      </div>
    </form>
  );
}

function EventsRetentionDialog({ current, onClose }: { current: EventsSettings; onClose: () => void }) {
  return (
    <Modal title="Change how long system events are kept" onClose={onClose}>
      <EventsRetentionForm current={current} onClose={onClose} />
    </Modal>
  );
}

/** What the Data watchdog card says: when a meter is stale (the minutes, or three of its own polls, whichever is longer) and when an energy counter is flagged as not rising. */
export function watchdogText(w: WatchdogValues): string {
  const noun = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
  return `Meters are stale after ${noun(w.stale_floor_minutes, "minute")} without a good reading (or 3 polls, whichever is longer); energy counters are flagged after ${noun(w.not_advancing_hours, "hour")} without rising.`;
}
/** Typical numbers for the loading frame, whose sentence is drawn as grey word pills (only the length of each word is used), so it breaks into the lines the real one will. */
const WATCHDOG_SAMPLE: WatchdogSettings = {
  stale_floor_minutes: 5, not_advancing_hours: 6, factory: { stale_floor_minutes: 5, not_advancing_hours: 6 },
  bounds: { stale_floor_minutes: [2, 60], not_advancing_hours: [1, 72] },
};
const WATCHDOG_MINUTES_HELP = "A meter is stale when it has had no good reading for this many minutes, or for three of its own polling intervals, whichever is longer. A shorter time finds a dead meter sooner, and may flag one that is only slow.";
const WATCHDOG_HOURS_HELP = "An energy counter that has not risen for this many hours is flagged. A counter that reads almost no load is left alone, because it may truly stand still. A source whose counters and other points all stand still this long counts as stale.";

/**
 * The content of the Change... dialog of the Data watchdog card (inside the Modal, so `useModalBusy` reaches it): the two numbers with the server's bounds and one
 * slot, always there, for what the save has to say. It is the System events dialog's shape without its question (saving these deletes nothing): the form carries the
 * same `storage-events-dialog` class, so the hint line, the three-line slot and the waiting buttons are the same rules. The buttons wait with aria-disabled and a guard,
 * never native `disabled`: the pressed one holds the focus.
 */
function WatchdogForm({ current, onClose }: { current: WatchdogSettings; onClose: () => void }) {
  const save = useSaveWatchdogSettings();
  const [minutes, setMinutes] = useState(String(current.stale_floor_minutes));
  const [hours, setHours] = useState(String(current.not_advancing_hours));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const minutesHint = useId();
  const hoursHint = useId();
  useModalBusy(pending); // Escape must not close the dialog on a request that is still running
  const { stale_floor_minutes: minuteBounds, not_advancing_hours: hourBounds } = current.bounds;

  const edit = (set: (text: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    setError(null);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    const stale_floor_minutes = wholeIn(minutes, minuteBounds);
    const not_advancing_hours = wholeIn(hours, hourBounds);
    if (stale_floor_minutes === null || not_advancing_hours === null) {
      setError(stale_floor_minutes === null ? inRange(minuteBounds, "Minutes") : inRange(hourBounds, "Hours"));
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await save.mutateAsync({ stale_floor_minutes, not_advancing_hours });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  const cancel = () => { if (!inFlight.current) onClose(); };

  return (
    <form className="storage-events-dialog" onSubmit={submit} noValidate>
      <p className="muted">A meter is stale after this many minutes without a good reading. An energy counter that has not risen for this many hours is flagged.</p>
      <div className="has-tip">
        <label>
          Stale after (minutes)
          <input type="number" step={1} min={minuteBounds[0]} max={minuteBounds[1]} value={minutes} aria-describedby={minutesHint} onChange={edit(setMinutes)} />
        </label>
        <InfoTip>{WATCHDOG_MINUTES_HELP}</InfoTip>
        <small id={minutesHint} className="muted storage-events-hint">From {minuteBounds[0].toLocaleString("en-US")} to {minuteBounds[1].toLocaleString("en-US")} minutes. Factory: {current.factory.stale_floor_minutes.toLocaleString("en-US")}.</small>
      </div>
      <div className="has-tip">
        <label>
          Counter not rising after (hours)
          <input type="number" step={1} min={hourBounds[0]} max={hourBounds[1]} value={hours} aria-describedby={hoursHint} onChange={edit(setHours)} />
        </label>
        <InfoTip>{WATCHDOG_HOURS_HELP}</InfoTip>
        <small id={hoursHint} className="muted storage-events-hint">From {hourBounds[0].toLocaleString("en-US")} to {hourBounds[1].toLocaleString("en-US")} hours. Factory: {current.factory.not_advancing_hours.toLocaleString("en-US")}.</small>
      </div>
      {/* Always there and three lines tall (CSS), so a refusal arriving moves neither the fields nor the buttons. */}
      <div className="storage-events-slot">
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
      <div className="row">
        <button type="button" aria-disabled={pending || undefined} onClick={cancel}>Cancel</button>
        <button type="submit" className="primary" aria-disabled={pending || undefined}>Save</button>
      </div>
    </form>
  );
}

function WatchdogDialog({ current, onClose }: { current: WatchdogSettings; onClose: () => void }) {
  return (
    <Modal title="Change when meters count as stale" onClose={onClose}>
      <WatchdogForm current={current} onClose={onClose} />
    </Modal>
  );
}

export function StoragePage() {
  const canEdit = useAuth().can("storage.edit"); // Save, Set as default and the Resets; without it the form is read-only
  const stats = useStorage();
  const settings = useStorageSettings();
  const events = useEventsSettings(); // w32: how long the system events are kept, and how many are kept now
  const site = useSite(); // the day of the oldest event is a day of the site's clock; asked for here so the card is never drawn in the wrong zone first
  const save = useSaveStorageSettings();
  const makeDefault = useSetStorageDefault();
  const [changingEvents, setChangingEvents] = useState(false);
  const watchdog = useWatchdogSettings(); // w35: when a billing meter counts as stale, and a counter as not rising
  const [changingWatchdog, setChangingWatchdog] = useState(false);
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
  if (stats.isPending || settings.isPending || events.isPending || watchdog.isPending || site.isPending || !form) {
    // The page in its order: the five real tiles (an icon circle and a line each, three with their note line), then the two cards in the page
    // grid as the loaded page draws them (w32: and the System events card under both, spanning the grid). Rows per day: the range fields and the count, then the seven day rows with no header, as the real table
    // has none, then the UTC note under it. Retention and capacity: the disk note, the field grid, the buttons and the summary, whose paragraphs are word pills of
    // the real sentences (the real lines wrap with the width). All lines are placeholders: a region holds no words but its label. Banners are data and are not drawn.
    return (
      <section className="admin-page storage-page">
        <PageHeader title="Storage" sub="How much space the readings take, and how long they are kept." />
        <SkeletonRegion label="Loading storage">
          <TilesSkeleton count={5} className="storage-tiles" notes={[1, 2, 4]} />
          <div className="page-grid">
            <PageCardSkeleton className="rows-day">
              <div className="rows-range">
                {[0, 1].map((i) => (
                  <div className="sk-field" key={i}><Skeleton width="12ch" /><Skeleton variant="block" width={150} height={34} /></div>
                ))}
                <Skeleton variant="block" width={96} height={30} />
              </div>
              <p className="muted"><Skeleton width="16ch" /></p>
              <TableSkeleton columns={2} rows={7} headless />
              <ParagraphSkeleton text={UTC_NOTE} className="muted" />
            </PageCardSkeleton>
            <PageCardSkeleton className="retention-card">
              <ParagraphSkeleton text={DISK_NOTE} className="muted" />
              <ParagraphSkeleton text={READINGS_NOTE} className="muted" />
              <div className="retention-form">
                <div className="retention-fields">
                  {FIELDS.map(([key], i) => (
                    <div className="sk-field" key={key}><Skeleton width={i % 2 ? "18ch" : "22ch"} /><Skeleton variant="block" height={CTL_H} /></div>
                  ))}
                </div>
                <div className="retention-foot">
                  {canEdit ? (
                    <>
                      <div className="retention-status" data-reserve={DEFAULT_SET_NOTE} />
                      <div className="row">
                        {[92, 120, 124, 176].map((width) => <Skeleton key={width} variant="block" width={width} height={34} />)}
                      </div>
                    </>
                  ) : <ParagraphSkeleton text={READ_ONLY_TEXT} className="muted" />}
                  <ParagraphSkeleton text={canEdit ? SUMMARY_SAMPLE : SUMMARY_SAMPLE.replace(RESETS_SENTENCE, "")} className="muted" />
                </div>
              </div>
            </PageCardSkeleton>
            <PageCardSkeleton className="storage-events span-all">
              <ParagraphSkeleton text={eventsKeptText(EVENTS_SAMPLE, "UTC")} />
              <ParagraphSkeleton text={AUDIT_KEPT} className="muted" />
              {canEdit && <div className="row"><Skeleton variant="block" width={104} height={34} /></div>}
            </PageCardSkeleton>
            <PageCardSkeleton className="storage-watchdog span-all">
              <ParagraphSkeleton text={watchdogText(WATCHDOG_SAMPLE)} />
              {canEdit && <div className="row"><Skeleton variant="block" width={104} height={34} /></div>}
            </PageCardSkeleton>
          </div>
        </SkeletonRegion>
      </section>
    );
  }
  const s = stats.data;
  const factory = settings.data.factory;
  const siteDefault = settings.data.site_default ?? null;
  const ratio = s.readings_bytes_uncompressed ? (s.readings_bytes_compressed / s.readings_bytes_uncompressed).toFixed(2) : "–";
  // A change to the form drops the green Saved at once (the values on screen are no longer the saved ones). Not while a save is running:
  // reset() would detach the mutation, and its 409 handler (the confirmation before readings are deleted) would never run.
  const edited = () => { if (!save.isPending) save.reset(); };
  const fill = (values: StorageSettings) => { setForm({ ...values }); setError(null); setNote(null); edited(); };  // the Resets only fill the form
  const checked = (): boolean => {
    setNote(null);
    const problem = validate(form);
    setError(problem);
    return problem === null;
  };
  const submit = (confirm: boolean) => {
    if (!canEdit || !checked()) return;
    save.mutate({ values: form, confirm }, {
      onError: (err) => {
        const loss = storageLoss(err);  // the server asks first when this save deletes readings
        if (loss) setNeedsConfirm(loss); else setError(err.message);
      },
    });
  };
  const rememberAsDefault = () => {
    if (!checked()) return;
    makeDefault.mutate(form, {
      onSuccess: () => setNote(DEFAULT_SET_NOTE),
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
        <Tile icon="storage" title="Database size" tip={TILE_HELP.database} big={sizeText(s.database_bytes)} />
        <Tile
          icon="readings"
          title="Readings (raw)"
          tip={TILE_HELP.readings}
          big={sizeText(s.readings_bytes_total)}
          note={s.readings_bytes_uncompressed ? `compressed ${sizeText(s.readings_bytes_compressed)} of ${sizeText(s.readings_bytes_uncompressed)}, ratio ${ratio}` : "nothing compressed yet"}
        />
        <Tile icon="layers" title="Rollups" tip={TILE_HELP.rollups} big={sizeText(s.rollup_1m_bytes + s.rollup_1h_bytes)} note={`1 min ${sizeText(s.rollup_1m_bytes)}, 1 h ${sizeText(s.rollup_1h_bytes)}`} />
        <Tile icon="trend" title="Growth per day" tip={TILE_HELP.growth} big={`${sizeText(s.growth_bytes_per_day)} / day`} />
        <Tile icon="hourglass" title="Projected full" tip={TILE_HELP.projected} big={projection(s.used_pct, s.days_until_full)} note={`${s.used_pct}% of ${sizeText(s.disk_capacity_bytes)}`} />
      </div>
      <div className="page-grid">
        <RowsPerDay initial={s.rows_per_day} />
        <PageCard className="retention-card" icon="database" title="Retention and capacity">
          <p className="muted">{DISK_NOTE}</p>
          <p className="muted">{READINGS_NOTE}</p>
          <form className="retention-form" onSubmit={(e: FormEvent) => { e.preventDefault(); submit(false); }}>
            <div className="retention-fields">
              {FIELDS.map(([key, label]) => (
                <div className="has-tip" key={key}>
                  <label>
                    {label}
                    <input type="number" step="any" value={form[key]} disabled={!canEdit} onChange={(e) => { setForm({ ...form, [key]: Number(e.target.value) }); edited(); }} />
                  </label>
                  <InfoTip>{FIELD_HELP[key]}</InfoTip>
                </div>
              ))}
            </div>
            <div className="retention-foot">
              {canEdit ? (
                <>
                  {/* Above the buttons, as the messages always were, but a place of its own: it is as tall as the longest message wraps to at this width
                      (the CSS lays a hidden copy of data-reserve under the real one), so a message coming or going moves neither card nor Save. */}
                  <div className="retention-status" data-reserve={DEFAULT_SET_NOTE}>
                    {error && <p className="error" role="alert">{error}</p>}
                    {note && !error && <p className="muted" role="status">{note}</p>}
                  </div>
                  <div className="row">
                    <SaveButton state={save.status} className="primary" />
                    <button type="button" onClick={rememberAsDefault} disabled={makeDefault.isPending}>Set as default</button>
                    <button type="button" className="quiet" onClick={() => fill(siteDefault ?? factory)}>Reset to default</button>
                    <button type="button" className="quiet" onClick={() => fill(factory)}>Reset to factory settings</button>
                  </div>
                </>
              ) : <ReadOnlyNote />}
              <p className="muted">
                {siteDefault
                  ? `This site's default: ${summary(siteDefault)}.`
                  : canEdit ? "No site default has been set, so Reset to default loads the factory values." : "No site default has been set."}{" "}
                Factory: {summary(factory)}.{canEdit && RESETS_SENTENCE}
              </p>
            </div>
          </form>
        </PageCard>
        {/* w32: under both cards, the width of the grid. Its data is awaited with the rest of the page (the loading frame draws it), so nothing arrives later and moves it. */}
        <PageCard className="storage-events span-all" icon="events" title="System events and the audit log">
          {events.isError ? (
            <p className="error" role="alert">How long system events are kept could not be read: {events.error.message}</p>
          ) : (
            <p>{eventsKeptText(events.data, site.data?.timezone ?? "UTC")}</p>
          )}
          <p className="muted">{AUDIT_KEPT}</p>
          {canEdit && events.data && <div className="row"><button type="button" onClick={() => setChangingEvents(true)}>Change...</button></div>}
        </PageCard>
        {/* w35: the same shape, under it. Its data is awaited with the rest of the page too (the loading frame draws it). */}
        <PageCard className="storage-watchdog span-all" icon="diagnostics" title="Data watchdog">
          {watchdog.isError ? (
            <p className="error" role="alert">The data watchdog settings could not be read: {watchdog.error.message}</p>
          ) : (
            <p>{watchdogText(watchdog.data)}</p>
          )}
          {canEdit && watchdog.data && <div className="row"><button type="button" onClick={() => setChangingWatchdog(true)}>Change...</button></div>}
        </PageCard>
      </div>
      {changingEvents && events.data && <EventsRetentionDialog current={events.data} onClose={() => setChangingEvents(false)} />}
      {changingWatchdog && watchdog.data && <WatchdogDialog current={watchdog.data} onClose={() => setChangingWatchdog(false)} />}
      {needsConfirm && (
        <ConfirmDeleteDialog
          title={needsConfirm.deletesNow ? "Delete old readings?" : "Shorten retention?"}
          message={needsConfirm.detail.replace(/ Repeat the request with confirm=true to go ahead\.$/, "")}
          confirmLabel={needsConfirm.deletesNow ? "Save and delete" : "Shorten and save"}
          onConfirm={async () => {
            await save.mutateAsync({ values: form, confirm: true });
            setNeedsConfirm(null);
          }}
          onCancel={() => setNeedsConfirm(null)}
        />
      )}
    </section>
  );
}
