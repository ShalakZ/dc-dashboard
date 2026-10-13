import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { auditPosition, useAudit, useAuditEntry, useAuditOptions, useSite } from "../api/queries";
import { ApiError } from "../api/client";
import type { AuditEntry } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { KindTile, UserLabel } from "../components/AuditCells";
import { AuditDrawer, type AuditDrawerStatus } from "../components/AuditDrawer";
import { AuditFilterBar } from "../components/AuditFilterBar";
import { AuditPager } from "../components/AuditPager";
import { EmptyNote } from "../components/EmptyNote";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { ActionsSpace, TableSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { apiQuery, isFiltered, readUrl, writeUrl, type AuditFilters, type AuditUrlState } from "../lib/auditFilters";
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
        />
      )}
    </div>
  );
}
