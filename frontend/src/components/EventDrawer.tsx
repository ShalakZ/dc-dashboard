import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { EventDetail, SystemEvent } from "../api/types";
import { copyText } from "../lib/diagnostics";
import { describeEvent, formatShortTime, kindName, LEVEL_WORDS, sourceLabel } from "../lib/eventText";
import { relativeTime } from "../lib/relativeTime";
import { formatSiteDateTime } from "../lib/siteTime";
import { Drawer } from "./Drawer";
import { Skeleton, SkeletonRegion } from "./Skeleton";
import { useToast } from "./Toasts";

export type EventDrawerStatus = "loading" | "ready" | "error";

/** What the drawer waits for while the event is read: the lines it will have, and the block of JSON under them. */
function EventSkeleton() {
  return (
    <SkeletonRegion label="Loading the event">
      <dl className="kv" aria-hidden="true">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i}><dt><Skeleton width="9ch" /></dt><dd><Skeleton width={i % 2 === 0 ? "26ch" : "16ch"} /></dd></div>
        ))}
      </dl>
      <Skeleton variant="block" height={120} />
    </SkeletonRegion>
  );
}

/**
 * The stored JSON of an event, collapsed, and built only while it is open. The caller keys it by the event, so stepping to another event closes it again.
 */
function StoredJson({ detail }: { detail: unknown }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen((was) => !was)}>
        {open ? "Hide the stored JSON" : "Show the stored JSON"}
      </button>
      {open && <pre id={bodyId} className="entry-json">{JSON.stringify(detail, null, 2)}</pre>}
    </>
  );
}

/** A check or a test someone started from the audit log: the only events that have a "started by" (the server looks the audit entry up for these two). */
const STARTED_JOBS: ReadonlySet<string> = new Set(["test_source", "check_connection"]);
function canBeStarted(event: SystemEvent): boolean {
  if (event.kind === "check.finished") return true;
  const job = event.detail && typeof event.detail === "object" ? (event.detail as Record<string, unknown>).kind : null;
  return event.kind === "job.finished" && typeof job === "string" && STARTED_JOBS.has(job);
}

const ENDED_BY = { recovered: "the source answered again", polling_stopped: "the source stopped being read" } as const;

/** The block of text Copy puts on the clipboard: enough to paste into a message and be understood. */
function copyBlock(event: SystemEvent, timezone: string, text: ReturnType<typeof describeEvent>): string {
  const source = sourceLabel(event);
  const lines = [
    `Event #${event.id} - ${LEVEL_WORDS[event.level] ?? event.level}`,
    `${formatSiteDateTime(event.ts, timezone)} ${timezone}`,
    ...(source ? [`Source: ${source}`] : []),
    `Kind: ${event.kind}${event.code ? ` / ${event.code}` : ""}`,
    text.headline,
    ...(text.count ? [[text.count, text.span].filter(Boolean).join(", ")] : []),
    event.message,
  ];
  return lines.filter((line) => line !== "").join("\n");
}

function EventView({ event, timezone, now, startedByPending }: { event: SystemEvent | EventDetail; timezone: string; now: Date; startedByPending: boolean }) {
  const toast = useToast();
  const text = useMemo(() => describeEvent(event), [event]);
  const area = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const number = `#${event.id}`;
  const ago = relativeTime(event.ts, now, timezone);
  const source = sourceLabel(event);
  const { incident } = event;
  const startedBy = "started_by" in event ? event.started_by : null;
  // The live line is empty until the drawer has moved to another event: the first one is read out as the dialog itself is (its headline sits in the
  // "What happened" row too, and a screen reader in browse mode would hear it twice). From the first step on it says every event shown.
  const [firstId] = useState(event.id);
  const [stepped, setStepped] = useState(false);
  if (!stepped && event.id !== firstId) setStepped(true);

  async function copy() {
    const ok = await copyText(copyBlock(event, timezone, text), area.current);
    // Without the clipboard API (plain http on the LAN) the hidden field is selected and focused to copy from it: focus goes back to the button.
    if (document.activeElement === area.current) button.current?.focus();
    if (ok) toast.info("Event copied");
    else toast.error("Could not copy the event");
  }

  const at = (iso: string) => formatSiteDateTime(iso, timezone);
  return (
    <div className="event-entry">
      {/* Said when the event changes (Previous, Next), with its number so the step is heard as a step; the dialog itself is announced when it opens. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{stepped ? `Event ${number}: ${text.headline}` : ""}</p>
      <dl className="kv">
        <div>
          <dt>What happened</dt>
          <dd>
            <span className="what">{text.headline}</span>
            {text.reason && <span className="reason">{text.reason}</span>}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{source === null ? "—" : event.source_name ? <Link to="/sources">{source}</Link> : <span className="muted">{source}</span>}</dd>
        </div>
        <div><dt>Level</dt><dd><span className={`ev-tag ev-tag-${event.level}`}>{LEVEL_WORDS[event.level] ?? event.level}</span></dd></div>
        <div><dt>Kind</dt><dd>{kindName(event.kind)} <code>{event.kind}</code></dd></div>
        {event.code && <div><dt>Code</dt><dd><code>{event.code}</code></dd></div>}
        {incident ? (
          <>
            <div><dt>Began</dt><dd>{at(incident.first_at)} <span className="muted">{timezone}{relativeTime(incident.first_at, now, timezone) ? ` · ${relativeTime(incident.first_at, now, timezone)}` : ""}</span></dd></div>
            <div><dt>Latest</dt><dd>{at(incident.last_at)}</dd></div>
            <div>
              <dt>Ended</dt>
              <dd>
                {incident.state === "open" || !incident.closed_at ? (
                  "Still open"
                ) : (
                  <>{at(incident.closed_at)} <span className="muted">{incident.closed_by ? ENDED_BY[incident.closed_by] : ""}</span></>
                )}
              </dd>
            </div>
            <div><dt>Count</dt><dd>{text.count}</dd></div>
            <div><dt>Duration</dt><dd>{text.span}</dd></div>
          </>
        ) : (
          <div><dt>When</dt><dd>{at(event.ts)} <span className="muted">{timezone}{ago ? ` · ${ago}` : ""}</span></dd></div>
        )}
        <div><dt>Message</dt><dd>{event.message || "—"}</dd></div>
        {canBeStarted(event) && (
          <div>
            <dt>Started by</dt>
            <dd>
              {startedBy ? (
                <>
                  {startedBy.username ?? "a removed account"}, {formatShortTime(startedBy.ts, timezone)}
                  <Link className="what-link" to={`/audit/${startedBy.audit_id}`}>Open the audit entry</Link>
                </>
              ) : startedByPending ? (
                <Skeleton width="16ch" />
              ) : (
                "—"
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>Event</dt>
          <dd>
            {number}
            <button ref={button} type="button" className="copy-btn" aria-label="Copy event details" onClick={() => void copy()}>Copy</button>
          </dd>
        </div>
      </dl>
      {/* The field copyText copies from when the clipboard API is missing: inside the panel (so inside the focus trap), out of sight and out of the Tab order. */}
      <textarea ref={area} className="copy-field" readOnly tabIndex={-1} aria-hidden="true" value={copyBlock(event, timezone, text)} />
      <h3 className="section-title">Details</h3>
      <StoredJson key={`json-${event.id}`} detail={event.detail} />
    </div>
  );
}

export type StepDirection = "previous" | "next";
const STEP_NAME: Record<StepDirection, string> = { previous: "Previous event", next: "Next event" };
/** Why both buttons wait while more events are read: a plain sentence, in the name after the colon like the other reasons. */
const READING = "reading more events";

/**
 * Previous (the event above, newer) and Next (the one below, older) in the drawer's footer. `previous` / `next` are why that button is off (null = it works):
 * the reason goes into its name and title, so a screen reader hears it as well. `busy` is the next page of the list being read: both wait. `error` is one line
 * about a step that failed. No button is ever natively `disabled`: one that has the focus would drop it to the page, so a button that is off is
 * `aria-disabled` with a click guard (it looks as the Audit drawer's do) and the focus stays where it was.
 */
export function EventSteps({ previous, next, busy, error, onStep }: {
  previous: string | null;
  next: string | null;
  busy: boolean;
  error: string | null;
  onStep: (direction: StepDirection) => void;
}) {
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
              type="button"
              aria-disabled={reason ? "true" : undefined}
              aria-label={label}
              title={reason ? label : undefined}
              onClick={() => { if (!reason) onStep(direction); }}
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
 * The right-hand drawer an event opens in. The page decides which event (a row of the loaded list, or the one read by its id, which also carries
 * `started_by`) and what the drawer waits for; `message` is the line shown when it cannot show the event. `startedByPending`: the single event is
 * still being read, so the "Started by" row (only a check or a test has one) keeps its place with a skeleton. `footer` (Previous and Next) and
 * `returnFocus` go to the Drawer.
 */
export function EventDrawer({ event, status, message, timezone, now, onClose, footer, returnFocus, startedByPending = false }: {
  event: SystemEvent | EventDetail | undefined;
  status: EventDrawerStatus;
  message?: string;
  timezone: string;
  now: Date;
  onClose: () => void;
  footer?: ReactNode;
  returnFocus?: () => HTMLElement | null;
  startedByPending?: boolean;
}) {
  return (
    <Drawer title="System event" onClose={onClose} footer={footer} returnFocus={returnFocus}>
      {status === "ready" && event ? (
        <EventView event={event} timezone={timezone} now={now} startedByPending={startedByPending} />
      ) : status === "error" ? (
        <p className="error" role="alert">{message ?? "Could not load the event."}</p>
      ) : (
        <EventSkeleton />
      )}
    </Drawer>
  );
}
