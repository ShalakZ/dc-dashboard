import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { auditPageOptions, auditPosition, keys, useAudit, useAuditEntry, useAuditOptions, useSite } from "../api/queries";
import { ApiError } from "../api/client";
import type { AuditEntry } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { KindTile, UserLabel } from "../components/AuditCells";
import { AuditDrawer, EntrySteps, type AuditDrawerStatus, type StepDirection } from "../components/AuditDrawer";
import { AuditFilterBar } from "../components/AuditFilterBar";
import { AuditPager } from "../components/AuditPager";
import { EmptyNote } from "../components/EmptyNote";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { ActionsSpace, TableSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { apiQuery, isFiltered, nextOffset, previousOffset, readUrl, writeUrl, type AuditFilters, type AuditUrlState } from "../lib/auditFilters";
import { describeAudit } from "../lib/auditText";
import { downloadCsv } from "../lib/download";
import { relativeTime } from "../lib/relativeTime";
import { formatSiteDateTime, siteDay } from "../lib/siteTime";

const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

const MAX_ID = 2_147_483_647; // the largest id the API holds

/** The entry id of the address, or null for anything the API cannot hold (the drawer then says so without asking). */
function entryId(raw: string): number | null {
  const number = /^\d+$/.test(raw) ? Number(raw) : null;
  return number !== null && number >= 1 && number <= MAX_ID ? number : null;
}

/** What a row sends along when it opens the drawer: the list is where Close goes back to, and `search` is the query it had. */
interface FromList { fromList: true; search: string }
const isFromList = (state: unknown): state is FromList =>
  typeof state === "object" && state !== null && (state as FromList).fromList === true && typeof (state as FromList).search === "string";

/**
 * A click on a row opens its entry, except one on a link or a button (those do their own thing) and one that ends a text selection
 * (selecting a sentence to copy it must not throw a drawer over the page).
 */
function rowClick(e: MouseEvent<HTMLElement>, open: () => void) {
  if (e.target instanceof Element && e.target.closest("a, button")) return;
  if (window.getSelection()?.toString()) return;
  open();
}

/**
 * The entry beside `id` in rows that are listed newest first (the list is ORDER BY id DESC): for "previous" the one with the smallest id
 * above it, for "next" the one with the largest id below it. By id, not by place: a page need not start on a multiple of its size (after
 * "Go to a date") and entries arrive between two requests, so the neighbour is not at a fixed index.
 */
function neighbour(rows: readonly AuditEntry[], id: number, direction: StepDirection): AuditEntry | undefined {
  let best: AuditEntry | undefined;
  for (const row of rows) {
    const beside = direction === "previous" ? row.id > id && (!best || row.id < best.id) : row.id < id && (!best || row.id > best.id);
    if (beside) best = row;
  }
  return best;
}

/** What a press of Previous or Next does: move to a row of the loaded page, read the page beside it first, or nothing (and why). */
type StepPlan = { entry: AuditEntry } | { offset: number } | { reason: string };

const OFF_THE_LIST = "open it from the list to step through the log";
const CHANGED = "New entries arrived since this list loaded. Close this and open the entry again.";

// Column widths in px, null for the rest: the friendly table gives "What happened" the room (and puts the Details chevron first, where a
// short sentence's empty end does not separate it from its entry), the raw one the detail. They sum to less than the narrowest table; the
// skeleton draws the same columns.
const FRIENDLY_COLS = [36, 200, 160, null] as const;
const RAW_COLS = [200, 160, 220, null] as const;

/**
 * The time of an entry, linked to it (the link's name says which entry; a real link, so a middle click opens the deep link in a tab), and
 * under it how long ago, outside the link. A plain click is the drawer: the same list query rides along, and so does where Close goes back to.
 */
function TimeCell({ id, ts, timezone, now, search }: { id: number; ts: string; timezone: string; now: Date; search: string }) {
  const time = formatSiteDateTime(ts, timezone);
  const ago = relativeTime(ts, now, timezone);
  const state: FromList = { fromList: true, search };
  return (
    <td className="cell-time">
      <Link to={{ pathname: `/audit/${id}`, search }} state={state} aria-label={`Entry #${id}, ${time}`}>{time}</Link>
      {ago && <span className="ago">{ago}</span>}
    </td>
  );
}

/** Who did it, in the cell itself so a long name is cut with an ellipsis. */
function UserCell({ name }: { name: string | null }) {
  return (
    <td className="cell-user" title={name ?? undefined}>
      <UserLabel name={name} />
    </td>
  );
}

interface RowProps { entry: AuditEntry; timezone: string; now: Date; search: string; isOpen: boolean; open: (id: number) => void }

/** One friendly row: the event's icon, the sentence and the link to the thing; the full account opens in the drawer (chevron, time or the row). */
function FriendlyRow({ entry, timezone, now, search, isOpen, open }: RowProps) {
  const { summary, link } = describeAudit(entry);
  return (
    <tr data-entry-id={entry.id} data-open={isOpen || undefined} onClick={(e) => rowClick(e, () => open(entry.id))}>
      <td className="cell-more">
        <button
          type="button"
          className="icon-btn details-btn"
          aria-label={`Details of entry #${entry.id}`}
          title="Details"
          aria-haspopup="dialog"
          onClick={() => open(entry.id)}
        >
          <Icon name="chevron" />
        </button>
      </td>
      <TimeCell id={entry.id} ts={entry.ts} timezone={timezone} now={now} search={search} />
      <UserCell name={entry.username} />
      <td className="cell-what">
        <div className="what-line">
          <KindTile action={entry.action} />
          <div className="what-text">
            <span className="what">{summary}</span>
            {link && <>{" "}<Link className="what-link" to={link.to}>{link.label}</Link></>}
          </div>
        </div>
      </td>
    </tr>
  );
}

/** One raw row: the time, the user, the action code and the stored JSON; it opens the drawer from the row or the time link. */
function RawRow({ entry, timezone, now, search, isOpen, open }: RowProps) {
  return (
    <tr data-entry-id={entry.id} data-open={isOpen || undefined} onClick={(e) => rowClick(e, () => open(entry.id))}>
      <TimeCell id={entry.id} ts={entry.ts} timezone={timezone} now={now} search={search} />
      <UserCell name={entry.username} />
      <td className="cell-action">{entry.action}</td>
      <td className="cell-detail"><code>{JSON.stringify(entry.detail)}</code></td>
    </tr>
  );
}

export function AuditPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(() => readUrl(params), [params]);
  const { filters, offset, size, view } = state;
  const current = writeUrl(state).toString();

  const site = useSite();
  const timezone = site.data?.timezone ?? "UTC"; // falls back to UTC if the site cannot be read
  const ready = !site.isPending;
  const now = new Date(); // once per render: every row's "how long ago" is counted from the same moment
  const today = siteDay(now, timezone);
  const options = useAuditOptions();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, error, isLoading, isPlaceholderData } = useAudit(filters, size, offset);

  // The open entry is part of the address (/audit/12?...), so a link opens it and Back closes it. The page stays mounted either way: filters,
  // page and scroll are exactly where they were. undefined = no drawer, null = an id the API cannot hold.
  const idParam = useParams().id;
  const wanted = idParam === undefined ? undefined : entryId(idParam);
  // A row of the loaded page is the whole entry (refs included); one that is not on it (a deep link) is fetched, once the list has answered.
  const onPage = typeof wanted === "number" ? data?.items.find((e) => e.id === wanted) : undefined;
  const answered = !isLoading && !isPlaceholderData;
  const fetched = useAuditEntry(typeof wanted === "number" && !onPage && answered ? wanted : null);
  const opened = onPage ?? (fetched.data?.id === wanted ? fetched.data : undefined);
  const drawerStatus: AuditDrawerStatus = wanted === null || (!opened && fetched.error) ? "error" : opened && ready ? "ready" : "loading";
  const drawerMessage =
    wanted === null || (fetched.error instanceof ApiError && fetched.error.status === 404) ? "Audit entry not found." : fetched.error?.message;

  const [jumping, setJumping] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The "nothing on that day" hint belongs to the address the jump landed on and goes when the page moves on.
  const [hint, setHint] = useState<{ text: string; at: string } | null>(null);
  // "Go" is answered later; the answer is used only if the filters are still the ones it was asked for.
  const latest = useRef(state);
  useEffect(() => { latest.current = state; });
  // A late answer must not rewrite the address of the page the user has moved to since.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Previous and Next. `stepFrom` is the entry a neighbouring page is being read for, `stepNote` the one line about a step that failed (it belongs
  // to the entry it was shown for). `stepping` is the same fact as a ref: two clicks in one tick both see the old render.
  const [stepFrom, setStepFrom] = useState<number | null>(null);
  const [stepNote, setStepNote] = useState<{ id: number; text: string } | null>(null);
  const stepping = useRef(false);
  const here = useRef(location.pathname + location.search); // where the page is now, for an answer that comes late
  useEffect(() => { here.current = location.pathname + location.search; });
  // Reading ends by itself when another entry is shown (the step landed, or the user moved on); it is not cleared on success, where a render
  // with the old entry and free buttons could come between the answer and the new address.
  if (stepFrom !== null && stepFrom !== opened?.id) setStepFrom(null);
  const busy = stepFrom !== null && stepFrom === opened?.id;

  function go(next: AuditUrlState, replace = false) {
    setParams(writeUrl(next), { replace });
  }

  /** Opens an entry over the list: a new history entry, so Back closes it; the query stays what it is. */
  function open(id: number) {
    const from: FromList = { fromList: true, search: location.search };
    navigate({ pathname: `/audit/${id}`, search: location.search }, { state: from });
  }

  // A second Escape (a key held down) before the first close has landed must not go back twice.
  const closing = useRef(false);
  useEffect(() => { closing.current = false; }, [location.key]);
  /** Back to the list as it was: one step back when the drawer was opened from it, else (a deep link) to the list with the same query. */
  function close() {
    if (closing.current) return;
    closing.current = true;
    if (isFromList(location.state) && location.state.search === location.search) navigate(-1);
    else navigate({ pathname: "/audit", search: location.search }, { replace: true });
  }

  // The drawer is gone when this is asked, so the entry that was open is remembered. Its chevron (the time link in the raw view) takes focus;
  // an entry that is not on the page (a deep link) has none, and the drawer falls back to the page.
  const lastOpen = useRef<number | null>(null);
  useEffect(() => { if (typeof wanted === "number") lastOpen.current = wanted; }, [wanted]);
  const returnFocus = () => {
    const row = `tr[data-entry-id="${lastOpen.current}"]`;
    return lastOpen.current === null ? null : document.querySelector<HTMLElement>(`${row} .details-btn, ${row} .cell-time a`);
  };

  function changeFilters(next: AuditFilters) {
    setProblem(null);
    // Typing in the search box replaces the entry instead of adding one per pause.
    const onlySearch = next.q !== filters.q && apiQuery({ ...next, q: "" }) === apiQuery({ ...filters, q: "" });
    go({ ...state, filters: next, offset: 0 }, onlySearch);
  }

  async function jump(date: string) {
    const asked = apiQuery(filters);
    setProblem(null);
    setHint(null);
    setJumping(true);
    try {
      const answer = await auditPosition(filters, date);
      if (!mounted.current || apiQuery(latest.current.filters) !== asked) return;
      const next = { ...latest.current, offset: answer.offset };
      go(next);
      if (!answer.on_day) setHint({ text: `No entries on ${date}; showing the nearest ones.`, at: writeUrl(next).toString() });
    } catch (e) {
      if (mounted.current && apiQuery(latest.current.filters) === asked) setProblem(messageOf(e, "could not find that date"));
    } finally {
      setJumping(false);
    }
  }

  async function exportCsv() {
    setProblem(null);
    setExporting(true);
    try {
      await downloadCsv(`/api/audit.csv?${apiQuery(filters)}`);
      toast.info("CSV downloaded"); // the whole file came back before the browser saved it; a failure keeps its inline line
    } catch (e) {
      setProblem(messageOf(e, "export failed"));
    } finally {
      setExporting(false);
    }
  }

  const rows = ready && data ? data.items : [];
  // While the next query loads the old rows stay (data is a placeholder); its total says nothing about the new query.
  const fresh = ready && !isPlaceholderData ? data : undefined;
  const raw = view === "raw";

  // What Previous and Next would do. A row of the page that is really loaded is the only place to step from: not the placeholder rows of the page
  // being loaded (the neighbour must come from the page that was asked for), and not an entry fetched by its own id, whose place in the log is unknown.
  const planFor = (direction: StepDirection): StepPlan => {
    if (!fresh) return { reason: "the list is still loading" };
    if (!onPage) return { reason: OFF_THE_LIST };
    const beside = neighbour(fresh.items, onPage.id, direction);
    if (beside) return { entry: beside };
    if (direction === "previous") return offset > 0 ? { offset: previousOffset(offset, size) } : { reason: "this is the newest entry" };
    const after = nextOffset(offset, size, fresh.total);
    return after === null ? { reason: "this is the oldest entry" } : { offset: after };
  };
  const plans = wanted === undefined ? null : { previous: planFor("previous"), next: planFor("next") };
  const reasonOf = (direction: StepDirection) => {
    const plan = plans?.[direction];
    return plan && "reason" in plan ? plan.reason : null;
  };

  /**
   * Moves the drawer to the neighbouring entry: a REPLACE that keeps `state` (so Close still knows where it came from) and, inside the page, the
   * query byte for byte. Past the edge of the page the page beside it is read first (the same query key the list uses, so it is in the cache when
   * the list shows it), and the offset and the entry change together in one navigation. Nothing happens before the answer is in.
   */
  async function step(direction: StepDirection) {
    const plan = plans?.[direction];
    if (!plan || "reason" in plan || !onPage || stepping.current) return; // (a button that is off is not clicked: `busy` needs no check here)
    setStepNote(null);
    if ("entry" in plan) {
      lastOpen.current = plan.entry.id; // the new address reaches the page a moment after the URL changes: a quick Escape must still find this row
      navigate({ pathname: `/audit/${plan.entry.id}`, search: location.search }, { replace: true, state: location.state });
      return;
    }
    const from = onPage.id;
    const total = fresh?.total; // of the list as it is now, to tell later whether the log grew meanwhile
    const at = location.pathname + location.search;
    let landed = false;
    stepping.current = true;
    setStepFrom(from);
    try {
      const page = await queryClient.fetchQuery(auditPageOptions(filters, size, plan.offset));
      // The drawer may have been closed, or the address changed, while the page was read: the answer then belongs to nothing.
      if (!mounted.current || here.current !== at) return;
      // New entries arrive on top. Going down that can only move the open entry into the page read, so its neighbour in there is the real one.
      // Going up the page read ends exactly at the entry above the first row of the list, unless entries arrived since the list loaded: then it ends
      // short of it, and the neighbour found would be a few places away (silently skipping entries). The log's total gives it away, unless the page
      // still holds the open entry itself (or one below it), in which case the neighbour is in there anyway.
      const trusted = direction === "next" || page.total === total || page.items.some((row) => row.id <= from);
      const target = trusted ? neighbour(page.items, from, direction) : undefined;
      if (!target) {
        // Say so, and read the list again so the next press steps inside it.
        setStepNote({ id: from, text: CHANGED });
        void queryClient.invalidateQueries({ queryKey: keys.audit(filters, size, offset), exact: true });
        return;
      }
      const search = writeUrl({ ...state, offset: plan.offset }).toString();
      lastOpen.current = target.id;
      navigate({ pathname: `/audit/${target.id}`, search: search && `?${search}` }, { replace: true, state: location.state });
      landed = true;
    } catch (e) {
      if (mounted.current && here.current === at) {
        setStepNote({ id: from, text: `Could not step to the ${direction} entry: ${messageOf(e, "the page could not be read")}` });
      }
    } finally {
      stepping.current = false;
      if (!landed && mounted.current) setStepFrom(null);
    }
  }

  const count = fresh ? `${fresh.total.toLocaleString("en-US")} ${fresh.total === 1 ? "entry" : "entries"}` : null;

  return (
    <div className="admin-page audit-page">
      <PageHeader title="Audit log" sub="Who did what, and when. The newest entries come first." />
      <AuditFilterBar
        filters={filters}
        onChange={changeFilters}
        today={today}
        options={options.data}
        onJump={jump}
        jumping={jumping}
        onExport={can("audit.export") ? exportCsv : undefined}
        exporting={exporting}
        error={problem}
        notice={hint && hint.at === current && data && data.total > 0 ? hint.text : null}
      />
      {(isLoading || site.isPending) && (
        <>
          {/* the Friendly/Raw switch needs rows to show; its place is kept (the same row and margin), or the table would sit 44px higher than it lands */}
          <div className="row seg" aria-hidden="true"><ActionsSpace /></div>
          <TableSkeleton columns={4} rows={8} widths={raw ? RAW_COLS : FRIENDLY_COLS} label="Loading the audit log" />
        </>
      )}
      {error && <p className="error" role="alert">{error.message}</p>}
      {/* The two "nothing to show" messages keep their exact words; the icon only fills the empty space around them. */}
      {fresh && fresh.total === 0 && (
        <EmptyNote icon={isFiltered(filters) ? "filter" : "audit"}>
          {isFiltered(filters) ? "No entries match these filters." : "No audit entries yet."}
        </EmptyNote>
      )}
      {fresh && fresh.total > 0 && rows.length === 0 && <p className="muted">This page is past the end of the log.</p>}
      {isPlaceholderData && rows.length === 0 && <p className="muted">Updating…</p>}
      {rows.length > 0 && (
        <>
          <div className="row seg">
            <div className="seg-switch" role="group" aria-label="View">
              <button type="button" aria-pressed={!raw} onClick={() => go({ ...state, view: "friendly" })}>Friendly</button>
              <button type="button" aria-pressed={raw} onClick={() => go({ ...state, view: "raw" })}>Raw</button>
              {isPlaceholderData && <span className="muted">Updating…</span>}
            </div>
            {count && <p className="result-count">{count}</p>}
          </div>
          <div className="table-wrap">
            <table className="audit-table" aria-busy={isPlaceholderData}>
              <colgroup>{(raw ? RAW_COLS : FRIENDLY_COLS).map((w, i) => <col key={i} style={w ? { width: w } : undefined} />)}</colgroup>
              <thead>
                <tr>
                  {!raw && <th><span className="sr-only">Details</span></th>}
                  <th title={`Time (${timezone})`}>Time ({timezone})</th><th>User</th>
                  {raw ? <><th>Action</th><th>Detail</th></> : <th>What happened</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) =>
                  raw ? (
                    <RawRow key={e.id} entry={e} timezone={timezone} now={now} search={location.search} isOpen={e.id === wanted} open={open} />
                  ) : (
                    <FriendlyRow key={e.id} entry={e} timezone={timezone} now={now} search={location.search} isOpen={e.id === wanted} open={open} />
                  ),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      {ready && data && (
        <AuditPager
          total={data.total}
          offset={offset}
          size={size}
          onOffset={(next) => go({ ...state, offset: next })}
          onSize={(next) => go({ ...state, size: next, offset: 0 })}
        />
      )}
      {/* Outside the table: the drawer is a portal, and its React events would otherwise reach the row's click handler. */}
      {wanted !== undefined && (
        <AuditDrawer
          entry={opened}
          status={drawerStatus}
          message={drawerMessage}
          timezone={timezone}
          now={now}
          onClose={close}
          returnFocus={returnFocus}
          footer={
            <EntrySteps
              previous={reasonOf("previous")}
              next={reasonOf("next")}
              busy={busy}
              error={stepNote && stepNote.id === opened?.id ? stepNote.text : null}
              entryId={opened?.id}
              onStep={(direction) => void step(direction)}
            />
          }
        />
      )}
    </div>
  );
}
