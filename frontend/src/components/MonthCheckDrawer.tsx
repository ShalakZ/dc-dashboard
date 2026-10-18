import { useId, useState, type ReactNode } from "react";
import type { MonthCheck } from "../api/types";
import { monthLabel } from "../lib/billing";
import {
  GROUP_ORDER, groupIntro, groupTitle, headline, headlineReason, itemLines, laterLine, lookedAtLine, moreLine, stateNote, unmeteredIntro, unmeteredLines,
  type CheckGroupKey, type CheckItems, type MonthCheckStatus,
} from "../lib/monthCheck";
import { Drawer } from "./Drawer";
import { Skeleton, SkeletonRegion } from "./Skeleton";

/** Lines of a list shown before `Show all N`. */
const SHOWN = 5;

const num = (n: number) => n.toLocaleString("en-US");

/** What the meters that started after everything that was looked at are: information, never part of the number. */
const laterIntro = (total: number) =>
  total === 1
    ? "1 meter gave its first reading after what was looked at. Until then its asset counts what the assets under it add up to. It is not part of the number at the top."
    : `${num(total)} meters gave their first reading after what was looked at. Until then each asset counts what the assets under it add up to. They are not part of the number at the top.`;

/**
 * A list that shows its first five rows; the rest wait behind `Show all N` / `Show fewer`. The button is one element whose words change, so the
 * focus stays on it. `more` is the server's own cap line ("and 167 more"): it counts what the server did not send, so it is only true under a
 * list that shows everything the server sent, and it waits for `Show all` when the list is longer than five.
 */
function FoldedList({ rows, more, describedBy }: { rows: ReactNode[]; more: string | null; describedBy: string }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const long = rows.length > SHOWN;
  const open = all || !long;
  return (
    <>
      <ul id={listId} className="month-check-list">{open ? rows : rows.slice(0, SHOWN)}</ul>
      {long && (
        <button type="button" className="quiet month-check-show" aria-expanded={all} aria-controls={listId} aria-describedby={describedBy} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${num(rows.length)}`}
        </button>
      )}
      {open && more !== null && <p className="muted month-check-more">{more}</p>}
    </>
  );
}

/** One finding of a counted group: the asset's path, what it reads (when the caller may see that), and the sentences. */
function Finding({ lines, path, reads }: { path: string; reads: string | null; lines: string[] }) {
  return (
    <li className="month-check-item">
      <strong className="month-check-path">{path}</strong>
      {reads !== null && <span className="muted month-check-reads">{reads}</span>}
      {lines.map((line, i) => <p key={i} className="month-check-line">{line}</p>)}
    </li>
  );
}

/** One counted group: the title with its true total, what the group means, and its findings (the server sends the worst first). Not drawn when empty. */
function GroupBlock({ groupKey, check, timezone }: { groupKey: CheckGroupKey; check: MonthCheck; timezone: string }) {
  const titleId = useId();
  const group = check.groups[groupKey];
  if (group.total <= 0) return null;
  const rows = (group.items as CheckItems[CheckGroupKey][]).map((item) => {
    const { reads, lines } = itemLines(groupKey, item, timezone, check.limits);
    return <Finding key={item.asset_id} path={item.path} reads={reads} lines={lines} />;
  });
  return (
    <div className="month-check-group">
      <h3 id={titleId}>{groupTitle(groupKey)} <span className="month-check-total">{num(group.total)}</span></h3>
      <p className="muted month-check-intro">{groupIntro(groupKey, check)}</p>
      <FoldedList rows={rows} more={moreLine(group, check.limits.cap)} describedBy={titleId} />
    </div>
  );
}

/** What is listed for information and is never part of the number: the assets nothing measures, and the meters that started after what was looked at. */
function InfoBlock({ check, timezone }: { check: MonthCheck; timezone: string }) {
  const { unmetered, later } = check.groups;
  const titleId = useId();
  const unmeteredId = useId();
  const laterId = useId();
  const cap = check.limits.cap;
  return (
    <div className="month-check-group month-check-info">
      <h3 id={titleId}>Not counted</h3>
      <div className="month-check-sub">
        <h4 id={unmeteredId}>Assets nothing measures</h4>
        <p className="muted month-check-intro">{unmeteredIntro(check)}</p>
        {unmetered.total > 0 && (
          <FoldedList
            describedBy={unmeteredId}
            more={moreLine(unmetered, cap)}
            rows={unmetered.items.map((item) => (
              <li key={item.asset_id} className="month-check-item">
                <strong className="month-check-path">{item.path}</strong>
                <p className="muted month-check-line">{unmeteredLines(item)}</p>
              </li>
            ))}
          />
        )}
      </div>
      {later.total > 0 && (
        <div className="month-check-sub">
          <h4 id={laterId}>Meters that started later</h4>
          <p className="muted month-check-intro">{laterIntro(later.total)}</p>
          <FoldedList
            describedBy={laterId}
            more={moreLine(later, cap)}
            rows={later.items.map((item) => (
              <li key={item.asset_id} className="month-check-item">
                <strong className="month-check-path">{item.path}</strong>
                <p className="muted month-check-line">{laterLine(item, timezone)}</p>
              </li>
            ))}
          />
        </div>
      )}
    </div>
  );
}

/** The answer: what it found, what was looked at, then the groups that have findings, then the information block. */
function CheckView({ check, timezone }: { check: MonthCheck; timezone: string }) {
  const reason = headlineReason(check);
  const note = stateNote(check);
  return (
    <div className="month-check-body">
      <p className="month-check-headline">{headline(check)}</p>
      {reason !== null && <p className="muted month-check-reason">{reason}</p>}
      <p className="muted month-check-looked">{lookedAtLine(check, timezone)}</p>
      {note !== null && <p className="muted month-check-state">{note}</p>}
      {GROUP_ORDER.map((key) => <GroupBlock key={key} groupKey={key} check={check} timezone={timezone} />)}
      <InfoBlock check={check} timezone={timezone} />
    </div>
  );
}

/** The same shape as the answer (a headline, a looked-at line, two groups of three lines), so nothing jumps when it arrives. One status region. */
function CheckSkeleton() {
  return (
    <SkeletonRegion label="Loading the month check" className="month-check-body">
      <p className="month-check-headline"><Skeleton width="16ch" /></p>
      <p className="muted month-check-looked"><Skeleton width="48ch" /></p>
      {[0, 1].map((group) => (
        <div key={group} className="month-check-group" aria-hidden="true">
          <h3><Skeleton width="24ch" /></h3>
          <ul className="month-check-list">
            {[0, 1, 2].map((line) => (
              <li key={line} className="month-check-item"><Skeleton width={line === 1 ? "34ch" : "42ch"} /></li>
            ))}
          </ul>
        </div>
      ))}
    </SkeletonRegion>
  );
}

/**
 * The month check, opened from the Check month button: a wide right-hand Drawer that lists what to look at before the month is trusted or closed.
 * It reads once opened, so nothing in it is a live region (the answer is already in the cache from the button's count; a first read shows a skeleton
 * in the shape of the answer). It writes nothing. Escape, the x or a click outside close it, and the focus goes back to `returnFocus` (the button).
 * Times are in `timezone`, the site's. The title is the month's name, not the button's words.
 */
export function MonthCheckDrawer({ month, timezone, status, onClose, returnFocus }: {
  month: string; timezone: string; status: MonthCheckStatus; onClose: () => void; returnFocus?: () => HTMLElement | null;
}) {
  return (
    <Drawer title={`Check ${monthLabel(month)}`} wide onClose={onClose} returnFocus={returnFocus}>
      {status.status === "ready" ? <CheckView check={status.data} timezone={timezone} />
        : status.status === "error" ? <p className="error" role="alert">{status.message}</p>
        : <CheckSkeleton />}
    </Drawer>
  );
}
