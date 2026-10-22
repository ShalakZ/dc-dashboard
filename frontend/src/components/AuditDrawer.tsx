import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client";
import { keys, useInvalidate } from "../api/queries";
import type { AuditEntry, AuditOutcome, TagListUndoResult } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { meets } from "../auth/need";
import { copyText } from "../lib/diagnostics";
import { describeAudit, OUTCOME_ACTIONS, outcomeOf } from "../lib/auditText";
import { relativeTime } from "../lib/relativeTime";
import { formatSiteDateTime } from "../lib/siteTime";
import { TAG_LIST_REFRESHED, undoSentence } from "../lib/tagListUndo";
import { upperFirst } from "../lib/upperFirst";
import { KindTile, UserLabel } from "./AuditCells";
import { Drawer } from "./Drawer";
import { PAGE_NEED } from "./navItems";
import { Skeleton, SkeletonRegion } from "./Skeleton";
import { useToast } from "./Toasts";

export type AuditDrawerStatus = "loading" | "ready" | "error";

/**
 * What the drawer is waiting for while the entry is fetched: the lines it will have (five, and a sixth, the Outcome, for an entry that starts a check or a
 * test: when the row it was opened from is known, its action says which), and the block of JSON under them.
 */
function EntrySkeleton({ rows }: { rows: number }) {
  return (
    <SkeletonRegion label="Loading the entry">
      <dl className="kv" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i}><dt><Skeleton width="9ch" /></dt><dd><Skeleton width={i % 2 === 0 ? "26ch" : "16ch"} /></dd></div>
        ))}
      </dl>
      <Skeleton variant="block" height={120} />
    </SkeletonRegion>
  );
}

/** The server takes a tag list back for this long after it was applied (api/tag_lists.py UNDO_HOURS). The server decides; this only keeps a button off an entry that is certainly too old. */
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The raw JSON of an entry, collapsed. It is built only while it is open: the detail of a tag list holds one entry per mapping (thousands of lines), and a drawer
 * that stringified it for every visit would stall. The caller keys it by the entry, so stepping to another entry closes it again.
 */
function RawJson({ detail }: { detail: unknown }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen((was) => !was)}>
        {open ? "Hide the stored JSON" : "Show the stored JSON"}
      </button>
      {/* The stored JSON, ids and all: the friendly text above never shows one. */}
      {open && <pre id={bodyId} className="entry-json">{JSON.stringify(detail, null, 2)}</pre>}
    </>
  );
}

/**
 * "Undo this tag list" for a tags.mapped entry of the last 24 hours, to a person who may accept discovery results (the permission the tag list itself needs;
 * seeing the audit log is not enough). It calls the same route as the Undo of the toast. The server decides whether it still can: its refusals ("already
 * undone", "changed since ...") are shown in place, in a slot that is always there. After it worked the button stays (it only waits), so the focus does not
 * fall to the page. The hooks live in the inner part so that an entry of any other action asks for neither the account nor the query client.
 */
function TagListUndo({ entry, now }: { entry: AuditEntry; now: Date }) {
  const { can } = useAuth();
  const recent = Date.parse(entry.ts) > now.getTime() - UNDO_WINDOW_MS;
  return can("discovery.accept") && recent ? <UndoThisList entryId={entry.id} /> : null;
}

function UndoThisList({ entryId }: { entryId: number }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const running = useRef(false);
  const [state, setState] = useState<{ phase: "idle" | "busy" | "done"; text: string | null; refused: boolean }>({ phase: "idle", text: null, refused: false });

  async function undo() {
    if (running.current || state.phase === "done") return;
    running.current = true;
    setState({ phase: "busy", text: "Undoing the tag list...", refused: false });
    try {
      const text = undoSentence(await api.post<TagListUndoResult>(`/api/tag-lists/${entryId}/undo`));
      toast.success(text);
      setState({ phase: "done", text, refused: false });
    } catch (error) {
      // The server writes its refusals in lower case ("this tag list was already undone"); shown as a sentence, like the other pages' API messages.
      setState({ phase: "idle", text: upperFirst(error instanceof Error ? error.message : String(error)), refused: true });
    } finally {
      try { await invalidate(...TAG_LIST_REFRESHED); } catch { /* the lists fetch themselves again on their next visit */ }
      running.current = false;
    }
  }

  return (
    <div className="audit-undo">
      <button type="button" aria-disabled={state.phase === "idle" ? undefined : true} onClick={() => void undo()}>Undo this tag list</button>
      <p className="muted">Takes back the mappings, and the assets and points this list created, if none of them has changed since. Possible for 24 hours.</p>
      <div className="audit-undo-slot">
        {state.text !== null && (state.refused ? <p role="alert">{state.text}</p> : <p>{state.text}</p>)}
      </div>
    </div>
  );
}

/** How often the drawer asks the server how a check or test that is still running has gone. */
const OUTCOME_POLL_MS = 5_000;

/** "Open in System events" to the row that holds the end of the job: for someone who can open that page (PAGE_NEED.events: the journal's permission and the sources it names, as the Sources page asks), and for an outcome that has such a row. */
function EventLink({ id }: { id: number }) {
  const { can } = useAuth();
  return meets(PAGE_NEED.events, can) ? <>{" "}<Link className="what-link" to={`/events/${id}`}>Open in System events</Link></> : null;
}

function OutcomeText({ outcome }: { outcome: AuditOutcome }) {
  const id = outcome.event_id;
  return (
    <>
      {outcome.text}
      {id !== null && Number.isSafeInteger(id) && id > 0 && <EventLink id={id} />}
    </>
  );
}

/**
 * The outcome while the job is still running: the entry is read again every 5 seconds until the answer says it has ended (the list the entry came from
 * is a snapshot). Its own part so that an entry that has ended asks for no query client; a request that fails leaves the sentence as it is, with no alert,
 * and the next beat tries again. When it ends the audit lists are read once, so the tag in the row says what the drawer says.
 */
function RunningOutcome({ entry, listed }: { entry: AuditEntry; listed: AuditOutcome }) {
  const client = useQueryClient();
  const live = useQuery({
    queryKey: keys.auditEntry(entry.id),
    queryFn: () => api.get<AuditEntry>(`/api/audit/${entry.id}`),
    // Asked again while the newest answer (or the list's, with none yet) says running; a stopped drawer asks nothing more.
    refetchInterval: (query) => (query.state.data && outcomeOf(query.state.data)?.state !== "running" ? false : OUTCOME_POLL_MS),
  });
  const latest = live.data ? outcomeOf(live.data) : null;
  const ended = latest !== null && latest.state !== "running";
  useEffect(() => {
    // Everything audit but the entries (this one is read already): the list page the row is in, and the one the filters offer.
    if (ended) void client.invalidateQueries({ queryKey: keys.auditAll, predicate: (query) => query.queryKey[1] !== "entry" });
  }, [ended, client]);
  return <OutcomeText outcome={latest ?? listed} />;
}

/** The Outcome row, LAST in the list: only for the entry of a started check or test that carries one; every other entry has no such row. */
function OutcomeRow({ entry }: { entry: AuditEntry }) {
  const outcome = outcomeOf(entry);
  if (!outcome) return null;
  return (
    <div>
      <dt>Outcome</dt>
      <dd>{outcome.state === "running" ? <RunningOutcome entry={entry} listed={outcome} /> : <OutcomeText outcome={outcome} />}</dd>
    </div>
  );
}

/** One entry of the log, opened from its row: what happened, when, who, the stored JSON. Previous and Next go in `footer`. */
function EntryView({ entry, timezone, now }: { entry: AuditEntry; timezone: string; now: Date }) {
  const toast = useToast();
  const { summary, changes, unchanged, link } = useMemo(() => describeAudit(entry), [entry]);
  const area = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const time = formatSiteDateTime(entry.ts, timezone);
  const ago = relativeTime(entry.ts, now, timezone);
  const number = `#${entry.id}`;
  // The live line is empty until the drawer has moved to another entry: the first one is read out as the dialog itself is (the sentence
  // sits in the "What happened" row too, and a screen reader in browse mode would hear it twice). From the first step on it says every entry
  // shown, also a return to the first one.
  const [firstId] = useState(entry.id);
  const [stepped, setStepped] = useState(false);
  if (!stepped && entry.id !== firstId) setStepped(true);

  async function copy() {
    const ok = await copyText(number, area.current);
    // Without the clipboard API (plain http on the LAN) the hidden field is selected and focused to copy from it: focus goes back to the button.
    if (document.activeElement === area.current) button.current?.focus();
    if (ok) toast.info("Entry number copied");
    else toast.error("Could not copy the entry number");
  }

  return (
    <div className="audit-entry">
      {/* Said when the entry changes (Previous, Next), with its number so the step is heard as a step; the dialog itself is announced when it opens. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{stepped ? `Entry ${number}: ${summary}` : ""}</p>
      <dl className="kv">
        <div>
          <dt>What happened</dt>
          <dd>
            <span className="what">{summary}</span>
            {link && <>{" "}<Link className="what-link" to={link.to}>{link.label}</Link></>}
          </dd>
        </div>
        <div><dt>When</dt><dd>{time} <span className="muted">{timezone}{ago ? ` · ${ago}` : ""}</span></dd></div>
        <div><dt>Who</dt><dd><UserLabel name={entry.username} /></dd></div>
        <div><dt>Action</dt><dd><KindTile action={entry.action} /><code>{entry.action}</code></dd></div>
        <div>
          <dt>Entry</dt>
          <dd>
            {number}
            <button ref={button} type="button" className="copy-btn" aria-label="Copy entry number" onClick={() => void copy()}>Copy</button>
          </dd>
        </div>
        {/* Keyed by the entry: stepping to another entry must not carry a polled answer over to it. */}
        <OutcomeRow key={`outcome-${entry.id}`} entry={entry} />
      </dl>
      {/* The field copyText copies from when the clipboard API is missing: inside the panel (so inside the focus trap), out of sight and out of the Tab order. */}
      <textarea ref={area} className="copy-field" readOnly tabIndex={-1} aria-hidden="true" value={number} />
      {/* Keyed by the entry (and apart from RawJson's key: two siblings with one key leave the old one mounted): Previous and Next keep this component, and a finished or refused Undo belongs to the entry it was pressed on. */}
      {entry.action === "tags.mapped" && <TagListUndo key={`undo-${entry.id}`} entry={entry} now={now} />}
      {changes.length > 0 && (
        <>
          <h3 className="section-title">What changed</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
              <tbody>
                {changes.map((change, i) => (
                  <tr key={`${change.field}-${i}`}>
                    <td>{change.field}</td>
                    <td>{change.before}</td>
                    <td>{change.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unchanged > 0 && <p className="muted">{`${unchanged} unchanged ${unchanged === 1 ? "value" : "values"} not shown`}</p>}
        </>
      )}
      <h3 className="section-title">Details</h3>
      <RawJson key={`json-${entry.id}`} detail={entry.detail} />
    </div>
  );
}

export type StepDirection = "previous" | "next";
const STEP_NAME: Record<StepDirection, string> = { previous: "Previous entry", next: "Next entry" };
/** Why both buttons wait while the page beside the one on show is read: a plain sentence, in the name after the colon like the other reasons. */
const READING = "reading another page of the log";

/**
 * Previous (the entry above, newer) and Next (the one below, older) in the drawer's footer. `previous` / `next` are why that button is off
 * (null = it works): the reason goes into its name and title, so a screen reader hears it as well. `busy` is a neighbouring page being read:
 * both buttons wait. `error` is one line about a step that failed.
 *
 * Focus. A button that turns off (native `disabled`) loses focus in a browser: it falls to the body. For the two cases that are off for good
 * (an end of the log, an entry off the page) that is dealt with after the fact: the button that was pressed is remembered, and once the step
 * has landed (a different entry is shown, or it failed) focus goes to the panel instead of the body. A page read can take seconds, so there
 * the buttons are not `disabled` at all but `aria-disabled` with a click guard (and a name that says why): focus never leaves the pressed one,
 * and goes back to it, or to the panel when it is off for good now, unless it went somewhere else meanwhile. Never to the body.
 */
export function EntrySteps({ previous, next, busy, error, entryId, onStep }: {
  previous: string | null;
  next: string | null;
  busy: boolean;
  error: string | null;
  entryId: number | undefined;
  onStep: (direction: StepDirection) => void;
}) {
  const buttons = { previous: useRef<HTMLButtonElement>(null), next: useRef<HTMLButtonElement>(null) };
  const pressed = useRef<{ direction: StepDirection; from: number | undefined } | null>(null);

  useEffect(() => {
    const press = pressed.current;
    if (!press || busy) return;
    if (entryId === press.from && !error) return; // the step has not landed yet (its answer is in, the address has not changed)
    pressed.current = null;
    const button = buttons[press.direction].current;
    const panel = button?.closest<HTMLElement>(".drawer") ?? null;
    const active = document.activeElement;
    // still on the button, dropped to the body by the browser, or on the panel: nothing else has taken it
    if (!button || (active !== button && active !== document.body && active !== panel)) return;
    (button.disabled ? panel : button)?.focus({ preventScroll: true });
  }, [entryId, busy, error, previous, next]); // eslint-disable-line react-hooks/exhaustive-deps -- the refs are stable

  const reasons = { previous, next };
  return (
    <>
      {error && <p className="entry-steps-note error" role="alert">{error}</p>}
      <div className="entry-steps">
        {(["previous", "next"] as const).map((direction) => {
          const reason = reasons[direction] ?? (busy ? READING : null);
          const label = reason ? `${STEP_NAME[direction]}: ${reason}` : STEP_NAME[direction];
          return (
            <button
              key={direction}
              ref={buttons[direction]}
              type="button"
              disabled={reasons[direction] !== null}
              aria-disabled={busy && reasons[direction] === null ? "true" : undefined}
              aria-label={label}
              title={reason ? label : undefined}
              onClick={() => {
                if (busy) return; // inert while a page is read, on either button (the page's step() ignores a second start as well)
                pressed.current = { direction, from: entryId };
                onStep(direction);
              }}
            >
              {direction === "previous" ? "Previous" : "Next"}
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * The right-hand drawer an audit entry opens in. The page decides which entry (a row of the loaded page, or one fetched by its id) and
 * what the drawer waits for; `message` is the line shown when it cannot show the entry. `footer` (Previous and Next) and `returnFocus` go to the Drawer.
 */
export function AuditDrawer({ entry, status, message, timezone, now, onClose, footer, returnFocus }: {
  entry: AuditEntry | undefined;
  status: AuditDrawerStatus;
  message?: string;
  timezone: string;
  now: Date;
  onClose: () => void;
  footer?: ReactNode;
  returnFocus?: () => HTMLElement | null;
}) {
  return (
    <Drawer title="Audit entry" onClose={onClose} footer={footer} returnFocus={returnFocus}>
      {status === "ready" && entry ? (
        <EntryView entry={entry} timezone={timezone} now={now} />
      ) : status === "error" ? (
        <p className="error" role="alert">{message ?? "Could not load the entry."}</p>
      ) : (
        // The opening row's action is known when the entry is (the page has it, and only the account or the site is still loading); a deep link knows nothing yet.
        <EntrySkeleton rows={entry && OUTCOME_ACTIONS.has(entry.action) ? 6 : 5} />
      )}
    </Drawer>
  );
}
