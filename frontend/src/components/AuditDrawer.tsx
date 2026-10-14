import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { AuditEntry } from "../api/types";
import { copyText } from "../lib/diagnostics";
import { describeAudit } from "../lib/auditText";
import { relativeTime } from "../lib/relativeTime";
import { formatSiteDateTime } from "../lib/siteTime";
import { KindTile, UserLabel } from "./AuditCells";
import { Drawer } from "./Drawer";
import { Skeleton, SkeletonRegion } from "./Skeleton";
import { useToast } from "./Toasts";

export type AuditDrawerStatus = "loading" | "ready" | "error";

/** What the drawer is waiting for while the entry is fetched: the five lines it will have, and the block of JSON under them. */
function EntrySkeleton() {
  return (
    <SkeletonRegion label="Loading the entry">
      <dl className="kv" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i}><dt><Skeleton width="9ch" /></dt><dd><Skeleton width={i % 2 === 0 ? "26ch" : "16ch"} /></dd></div>
        ))}
      </dl>
      <Skeleton variant="block" height={120} />
    </SkeletonRegion>
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
      </dl>
      {/* The field copyText copies from when the clipboard API is missing: inside the panel (so inside the focus trap), out of sight and out of the Tab order. */}
      <textarea ref={area} className="copy-field" readOnly tabIndex={-1} aria-hidden="true" value={number} />
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
      {/* The stored JSON, ids and all: the friendly text above never shows one. */}
      <pre className="entry-json">{JSON.stringify(entry.detail, null, 2)}</pre>
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
        <EntrySkeleton />
      )}
    </Drawer>
  );
}
