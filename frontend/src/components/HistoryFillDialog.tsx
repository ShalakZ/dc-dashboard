import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import { keys, useInvalidate } from "../api/queries";
import type { HistoryFillIn, HistoryFillJobResult, HistoryFillPlan } from "../api/types";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useJob } from "../hooks/useJob";
import { upperFirst } from "../lib/upperFirst";
import { Icon } from "./Icon";
import { InfoTip } from "./InfoTip";

/** How long the dialog keeps asking after a fill was started. A fill reads a Historian at the pace of its settings and can last an hour; the job goes on in the collector whether or not this window is open. */
const FOLLOW_MS = 2 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, "0");
const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string) => `${num(n)} ${n === 1 ? one : `${one}s`}`;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A day (a date input's "2026-09-01") as the moment its local day starts, `after` days later; null for text that is not a date. `setFullYear`, because `new Date(25, 0, 1)` is 1925. */
function localMidnight(day: string, after = 0): Date | null {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!found) return null;
  const moment = new Date(2000, 0, 1);
  moment.setFullYear(Number(found[1]), Number(found[2]) - 1, Number(found[3]) + after);
  moment.setHours(0, 0, 0, 0);
  return moment;
}

/** The day a moment falls on in the browser's zone, as a date input writes it. */
function dayOf(moment: Date): string {
  return `${String(moment.getFullYear()).padStart(4, "0")}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

/** A moment written with the browser's own UTC offset ("2026-09-01T00:00:00+03:00"): the server wants an offset, and a person's days are the days of their zone. */
function withOffset(moment: Date): string {
  const minutes = -moment.getTimezoneOffset();
  const offset = Math.abs(minutes);
  const date = `${String(moment.getFullYear()).padStart(4, "0")}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
  return `${date}T${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}${minutes < 0 ? "-" : "+"}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

/**
 * What the two days mean as a request: from the start of the first day to the end of the last, which is the start of the day after it, or now when that is
 * still ahead (the engine refuses a range that ends in the future). A sentence (not a request) when a day is missing. A range that is too long, too old or
 * empty is not judged here: the server's sentences for them are better than a copy of its limits, which the retention setting moves.
 */
function buildRequest(start: string, end: string, beforeFirst: boolean, now: Date = new Date()): HistoryFillIn | string {
  const first = localMidnight(start);
  const after = localMidnight(end, 1);
  if (first === null) return "Choose the first day of the range.";
  if (after === null) return "Choose the last day of the range.";
  return { start: withOffset(first), end: withOffset(new Date(Math.min(after.getTime(), now.getTime()))), before_first_reading: beforeFirst };
}

/** The plan counts only for the days and the choice it was made for. */
const keyOf = (start: string, end: string, beforeFirst: boolean) => JSON.stringify([start, end, beforeFirst]);

type Busy = "check" | "start";
interface Checked { key: string; body: HistoryFillIn; plan: HistoryFillPlan }
interface Note { text: string; error: boolean }

/**
 * Fill an older range of one source (w31): the source's Historian is asked for readings of days past, and the ones that are missing are stored. Two dates
 * and one choice (the fill starts at each meter's first reading unless it is told otherwise: going before it can change a parent asset's past figures).
 * "Check range" asks the server for the plan and changes nothing; "Start fill" is the only way on and works only on the plan of the days and choice that are
 * on screen NOW, and it sends exactly what was checked. The server queues one fill at a time (a second answers 409 with the running one's sentence) and
 * refuses what it must in words (a range longer than 31 days, older than the raw retention, in the future); the dialog shows those sentences as they are.
 *
 * Once the fill is queued the dialog follows its job (`useJob`) and shows the counts, or the sentence that stopped it, when it ends. Closing the dialog does
 * not stop the fill. The controls wait (natively disabled) while a request or the job runs; the buttons wait with aria-disabled, because one of them
 * holds the focus. One live region, with a room of its own, speaks for the whole dialog. The caller mounts this when the row menu's "Fill older range..." is chosen.
 */
export function HistoryFillDialog({ source, onClose }: { source: { id: number; name: string }; onClose: () => void }) {
  const invalidate = useInvalidate();
  const root = useRef<HTMLDivElement>(null);
  const startInput = useRef<HTMLInputElement>(null);
  const endInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const ids = useId();
  const id = (part: string) => `${ids}-${part}`;

  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [beforeFirst, setBeforeFirst] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const { job, running, timedOut, error: jobError } = useJob(jobId, FOLLOW_MS);

  const finished = job !== null && (job.status === "done" || job.status === "failed");
  const following = running && !jobError; // the fill is queued or running (a job that cannot be read is not followed: the controls must not wait for it for ever)
  const waiting = busy !== null || following;
  const current = checked !== null && checked.key === keyOf(start, end, beforeFirst) ? checked : null;
  const ready = !waiting && current !== null && current.plan.windows.length > 0;
  const today = dayOf(new Date());

  const requestClose = () => { if (!inFlight.current) onClose(); };
  useDialogFocus(root, requestClose, { busy: busy !== null, initial: startInput });

  // The fill can change the readings behind the lists and the figures on the screen: they are read again once, when the job has ended (done or failed:
  // a fill that stopped half way stored what it had read).
  const settled = finished ? jobId : null;
  useEffect(() => {
    if (settled !== null) void invalidate(keys.sources, keys.assets, keys.fleet, keys.billing, keys.widgetData, keys.auditAll);
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps -- once per job that ends, not once per render of `invalidate`

  /** Any change of the days or the choice: what was said about the earlier ones is not about these. */
  function edited(change: () => void) {
    change();
    setNote(null);
    if (!following) setJobId(null);
  }

  async function check() {
    if (inFlight.current || waiting) return;
    const request = buildRequest(start, end, beforeFirst);
    if (typeof request === "string") {
      setNote({ text: request, error: true });
      (start === "" ? startInput : endInput).current?.focus();
      return;
    }
    inFlight.current = true;
    setBusy("check");
    setNote(null);
    setJobId(null);
    const key = keyOf(start, end, beforeFirst);
    try {
      const plan = await api.post<HistoryFillPlan>(`/api/sources/${source.id}/history/fill?dry_run=1`, request);
      setChecked({ key, body: request, plan });
    } catch (e) {
      setChecked(null);
      setNote({ text: upperFirst(messageOf(e)), error: true });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function startFill() {
    if (inFlight.current || !ready || current === null) return;
    inFlight.current = true;
    setBusy("start");
    setNote(null);
    try {
      // No dry_run in the query: its absence is what makes this the real request. The body is the one that was checked, not one built again from the fields.
      const out = await api.post<{ job_id: number }>(`/api/sources/${source.id}/history/fill`, current.body);
      setJobId(out.job_id);
    } catch (e) {
      // A 409 (another fill is running; its sentence says whose) leaves the plan standing, so Start fill can be pressed again when it has ended.
      // A 422 means the server's rules now refuse this range: a new check is the way on.
      if (typeof e === "object" && e !== null && "status" in e && e.status === 422) setChecked(null);
      setNote({ text: upperFirst(messageOf(e)), error: true });
    } finally {
      inFlight.current = false;
      setBusy(null);
      // The request wrote an audit row, and the list's history line may move with the job.
      void invalidate(keys.sources, keys.auditAll);
    }
  }

  const aria = (blocked: boolean) => (blocked ? true : undefined);
  const titleId = id("title");
  const reportId = id("report");

  /** The lines under the plan: what is going on, or how the fill ended. */
  function stateLine() {
    if (busy === "check") return <p className="muted">Checking the range…</p>;
    if (busy === "start") return <p className="muted">Starting the fill…</p>;
    if (note) return <p className={note.error ? "error history-fill-note" : "muted"}>{note.text}</p>;
    if (jobId === null) return null;
    if (jobError) return <p className="error history-fill-note">{`Could not read how the fill is going: ${jobError}`}</p>;
    if (running) {
      return <p className="muted">The fill is running. It asks the source at its own pace, so a large range can take a long time. You can close this window: the fill goes on.</p>;
    }
    if (timedOut) {
      return <p className="muted">This window has stopped following the fill after two hours. It may still be running; the Sources list shows readings as they are stored.</p>;
    }
    const result = (job?.result ?? null) as HistoryFillJobResult | null;
    if (result === null) return <p className="muted">The fill ended without a report.</p>;
    if ("error" in result) return <p className="error history-fill-note">{`The fill stopped: ${result.error}`}</p>;
    return <p className="history-fill-done"><Icon name="check" /><span>{upperFirst(result.text)}</span></p>;
  }

  return createPortal(
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="dialog history-fill">
        <h2 id={titleId}>{`Fill an older range: ${source.name}`}</h2>
        <p className="muted">
          Asks the source for the readings it holds from days that are past, and stores the ones that are missing. One fill runs at a time, over at most 31 days.
        </p>

        <div className="history-fill-dates">
          <div className="field">
            <label htmlFor={id("start")}>Start date</label>
            <input
              ref={startInput} id={id("start")} type="date" value={start} max={end || today} disabled={waiting}
              onChange={(e) => edited(() => setStart(e.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor={id("end")}>End date</label>
            <input
              ref={endInput} id={id("end")} type="date" value={end} min={start || undefined} max={today} disabled={waiting}
              onChange={(e) => edited(() => setEnd(e.target.value))}
            />
          </div>
        </div>

        <div className="history-fill-option">
          <label className="inline">
            <input type="checkbox" checked={beforeFirst} disabled={waiting} onChange={(e) => edited(() => setBeforeFirst(e.target.checked))} />
            Also fill before a meter&apos;s first reading
          </label>
          <InfoTip>
            Normally a fill starts at each meter&apos;s first reading, because a parent asset counts a meter only from that hour on. Going back before it can change
            the past figures of a parent asset. Closed billing months keep their frozen figures.
          </InfoTip>
        </div>

        <div id={reportId} className="history-fill-report" role="status" aria-busy={busy !== null || following ? true : undefined}>
          {current !== null ? (
            <>
              {current.plan.windows.length > 0 && (
                <p className="history-fill-summary">{`About ${plural(current.plan.expected_rows, "row")} in ${plural(current.plan.windows.length, "window")}.`}</p>
              )}
              <p>{current.plan.plan}</p>
            </>
          ) : (
            !note && busy === null && jobId === null && (
              <p className="muted">Choose the first and the last day, then press Check range. A check asks the source nothing and stores nothing.</p>
            )
          )}
          {stateLine()}
        </div>

        <div className="row">
          <button type="button" className="history-fill-close" aria-disabled={aria(busy !== null)} onClick={requestClose}>Close</button>
          <button type="button" className="history-fill-check" aria-disabled={aria(waiting)} onClick={() => void check()}>Check range</button>
          <button type="button" className="primary history-fill-go" aria-disabled={aria(!ready)} aria-describedby={reportId} onClick={() => void startFill()}>
            Start fill
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
