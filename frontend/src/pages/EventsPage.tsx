import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { EVENTS_REFETCH_MS, eventsCsvUrl, useEvent, useEventOptions, useEventPage, useEvents, useEventSummary, useSite } from "../api/queries";
import { ApiError } from "../api/client";
import type { EventSummary, SystemEvent } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { EmptyNote } from "../components/EmptyNote";
import { EventDrawer, EventSteps, type EventDrawerStatus, type StepDirection } from "../components/EventDrawer";
import { EventFilterBar } from "../components/EventFilterBar";
import { Icon, type IconName } from "../components/Icon";
import { InfoTip } from "../components/InfoTip";
import { PageHeader } from "../components/PageHeader";
import { ActionsSpace, Skeleton, TableSkeleton, TilesSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { downloadCsv } from "../lib/download";
import { isFiltered, NO_FILTERS, readUrl, writeUrl, type EventsUrlState } from "../lib/eventFilters";
import { describeEvent, formatShortTime, LEVEL_WORDS, openLine, sourceLabel } from "../lib/eventText";
import { relativeTime } from "../lib/relativeTime";
import { formatSiteDateTime } from "../lib/siteTime";

const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const number = (value: number) => value.toLocaleString("en-US");

const MAX_ID = 2_147_483_647; // the largest id the API holds
const OPEN_LINES = 10; // open problems drawn above the list; the rest are one button away (Open only)

/** The event id of the address, or null for anything the API cannot hold (the drawer then says so without asking). */
function eventId(raw: string): number | null {
  const value = /^\d+$/.test(raw) ? Number(raw) : null;
  return value !== null && value >= 1 && value <= MAX_ID ? value : null;
}

/** What a row sends along when it opens the drawer: the list is where Close goes back to, and `search` is the query it had. */
interface FromList { fromList: true; search: string }
const isFromList = (state: unknown): state is FromList =>
  typeof state === "object" && state !== null && (state as FromList).fromList === true && typeof (state as FromList).search === "string";

/**
 * A click on a row opens its event, except one on a link or a button (those do their own thing) and one that ends a text selection
 * (selecting a sentence to copy it must not throw a drawer over the page).
 */
function rowClick(e: MouseEvent<HTMLElement>, open: () => void) {
  if (e.target instanceof Element && e.target.closest("a, button")) return;
  if (window.getSelection()?.toString()) return;
  open();
}

// Column widths in px, null for the rest; the skeleton draws the same columns, so the table does not change shape when the rows arrive.
const FRIENDLY_COLS = [36, 190, 180, null, 230] as const;
const RAW_COLS = [190, 90, 170, 190, null] as const;

type OpenedFrom = "row" | "pinned";

/** The time of an event, linked to it (a real link, so a middle click opens the deep link in a tab), and under it how long ago. */
function TimeCell({ id, ts, timezone, now, search }: { id: number; ts: string; timezone: string; now: Date; search: string }) {
  const time = formatSiteDateTime(ts, timezone);
  const ago = relativeTime(ts, now, timezone);
  const state: FromList = { fromList: true, search };
  return (
    <td className="cell-time">
      <Link to={{ pathname: `/events/${id}`, search }} state={state} aria-label={`Event #${id}, ${time}`}>{time}</Link>
      {ago && <span className="ago">{ago}</span>}
    </td>
  );
}

/** The source of an event: its name linked to Sources, "deleted source #3" as plain muted text, a dash for an event of no source. */
function SourceCell({ event }: { event: SystemEvent }) {
  const label = sourceLabel(event);
  return (
    <td className="cell-source" title={label ?? undefined}>
      {label === null ? "—" : event.source_name ? <Link to="/sources">{label}</Link> : <span className="muted">{label}</span>}
    </td>
  );
}

const LevelTag = ({ event }: { event: SystemEvent }) => <span className={`ev-tag ev-tag-${event.level}`}>{LEVEL_WORDS[event.level] ?? event.level}</span>;

interface RowProps { event: SystemEvent; timezone: string; now: Date; search: string; isOpen: boolean; open: (id: number, from: OpenedFrom) => void }

/** One friendly row: the severity tag, the sentence (with its plain reason under it), the source and the count of an incident. The full account is in the drawer. */
function FriendlyRow({ event, timezone, now, search, isOpen, open }: RowProps) {
  const text = describeEvent(event);
  return (
    <tr data-event-id={event.id} data-open={isOpen || undefined} onClick={(e) => rowClick(e, () => open(event.id, "row"))}>
      <td className="cell-more">
        <button type="button" className="icon-btn details-btn" aria-label={`Details of event #${event.id}`} title="Details" aria-haspopup="dialog" onClick={() => open(event.id, "row")}>
          <Icon name="chevron" />
        </button>
      </td>
      <TimeCell id={event.id} ts={event.ts} timezone={timezone} now={now} search={search} />
      <SourceCell event={event} />
      <td className="cell-what">
        <div className="what-line">
          <LevelTag event={event} />
          <div className="what-text">
            <span className="what">{text.headline}</span>
            {text.reason && <span className="reason">{text.reason}</span>}
          </div>
        </div>
      </td>
      <td className="cell-count">
        {text.count}
        {text.span && <span className="ago">{text.span}</span>}
      </td>
    </tr>
  );
}

/** One raw row: the time, the level, the source, the kind and code, and the stored message and detail. */
function RawRow({ event, timezone, now, search, isOpen, open }: RowProps) {
  return (
    <tr data-event-id={event.id} data-open={isOpen || undefined} onClick={(e) => rowClick(e, () => open(event.id, "row"))}>
      <TimeCell id={event.id} ts={event.ts} timezone={timezone} now={now} search={search} />
      <td className="cell-level"><LevelTag event={event} /></td>
      <SourceCell event={event} />
      <td className="cell-kind"><code>{event.kind}{event.code ? ` / ${event.code}` : ""}</code></td>
      <td className="cell-detail">
        <span>{event.message}</span>
        <code>{JSON.stringify(event.detail)}</code>
      </td>
    </tr>
  );
}

function Tile({ icon, title, tip, big, small, note, alert }: { icon: IconName; title: string; tip: string; big: string; small?: string; note?: ReactNode; alert?: boolean }) {
  return (
    <div className="tile" data-alert={alert ? "true" : undefined}>
      {/* each tip is named after its tile ("About Kept"), so a list of buttons tells them apart */}
      <div className="muted"><span className="tile-label"><Icon name={icon} /><span>{title}</span></span><InfoTip label={`About ${title}`}>{tip}</InfoTip></div>
      <div className="big">{big}{small && <small>{small}</small>}</div>
      {note ? <small className="muted">{note}</small> : <small className="muted">&nbsp;</small>}
    </div>
  );
}

/** The four tiles on top: what is open now, the warnings and errors of the last day, and how much the journal keeps. */
function Tiles({ summary, timezone }: { summary: EventSummary; timezone: string }) {
  const oldest = summary.oldest ? formatShortTime(summary.oldest, timezone).replace(/ \d\d:\d\d$/, "") : null;
  return (
    <div className="tiles event-tiles">
      <Tile
        icon="events" title="Open problems" alert={summary.open_incidents > 0} big={number(summary.open_incidents)}
        tip="Sources that are offline or reading badly right now. Each counts once, however many times it failed, until it answers again."
      />
      <Tile icon="alert" title="Warnings, last 24 h" big={number(summary.warnings_24h)} tip="Warnings the system wrote in the last 24 hours: a source going offline, a check that failed, bad readings." />
      <Tile icon="evProblem" title="Errors, last 24 h" big={number(summary.errors_24h)} tip="Errors the system wrote in the last 24 hours: jobs that failed and server errors." />
      <Tile
        icon="database" title="Kept" big={number(summary.kept)} small=" events"
        note={<>{summary.retention_days} days{oldest && <>, the oldest from <span className="tile-date">{oldest}</span></>}</>}
        tip="How many events the journal holds. Events older than the limit, and any past the row limit, are removed every hour; an open problem is never removed. The limits are on the Storage page."
      />
    </div>
  );
}

export function EventsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(() => readUrl(params), [params]);
  const { filters, view } = state;

  const site = useSite();
  const timezone = site.data?.timezone ?? "UTC"; // falls back to UTC if the site cannot be read
  const ready = !site.isPending;
  const now = new Date(); // once per render: every row's "how long ago" is counted from the same moment
  const options = useEventOptions();
  const toast = useToast();

  // The open event is part of the address (/events/7?...), so a link opens it and Back closes it. The page stays mounted either way: filters, rows and
  // scroll are exactly where they were. undefined = no drawer, null = an id the API cannot hold.
  const idParam = useParams().id;
  const wanted = idParam === undefined ? undefined : eventId(idParam);

  // The list is read one keyset page at a time and never refetched under the reader. What keeps it calm is a second, quiet read of page one every 10 s,
  // only while the list is the present (no To day) and no drawer is open: rows it already shows are brought up to date in place (an open problem's count
  // and its closing), rows it does not show are counted and offered as one button. A read that fails changes nothing on screen.
  const list = useEvents(filters);
  const calm = filters.to === "" && wanted === undefined;
  const latest = useEventPage(filters, { refetchMs: calm ? EVENTS_REFETCH_MS : false, enabled: calm && list.data !== undefined && !list.isPlaceholderData });
  // The open problems above the list: every open one (of the chosen source), whatever else the list is filtered by. Not drawn when the list IS the open ones.
  const pinnedOn = !filters.open;
  const pinned = useEventPage({ ...NO_FILTERS, source: filters.source, open: true }, { refetchMs: wanted === undefined ? EVENTS_REFETCH_MS : false, enabled: pinnedOn });
  const summary = useEventSummary(); // also with a drawer open: the tiles behind it must be there when it closes, or the page would grow under the reader

  const pages = list.data?.pages ?? [];
  const listed = useMemo(() => pages.flatMap((each) => each.items), [list.data]); // eslint-disable-line react-hooks/exhaustive-deps -- `pages` is made from list.data
  const fresh = ready && !list.isPlaceholderData && list.data !== undefined;
  const listAt = list.dataUpdatedAt;
  const latestOk = fresh && !latest.isPlaceholderData && latest.data !== undefined && latest.dataUpdatedAt > listAt;
  const pinnedOk = pinnedOn && !pinned.isPlaceholderData && pinned.data !== undefined && pinned.dataUpdatedAt > listAt;
  // The rows: the loaded list, each brought up to date by a newer read of the same event (the newer of the two reads wins).
  const rows = useMemo(() => {
    const newer: { at: number; items: SystemEvent[] }[] = [];
    if (latestOk) newer.push({ at: latest.dataUpdatedAt, items: latest.data!.items });
    if (pinnedOk) newer.push({ at: pinned.dataUpdatedAt, items: pinned.data!.items });
    if (newer.length === 0) return listed;
    const byId = new Map<number, SystemEvent>();
    for (const read of newer.sort((a, b) => a.at - b.at)) for (const item of read.items) byId.set(item.id, item);
    return listed.map((item) => byId.get(item.id) ?? item);
  }, [listed, latestOk, latest.dataUpdatedAt, latest.data, pinnedOk, pinned.dataUpdatedAt, pinned.data]);

  const shown = useMemo(() => new Set(listed.map((item) => item.id)), [listed]);
  const arrivals = fresh && calm && !latest.isPlaceholderData && latest.data ? latest.data.items.filter((item) => !shown.has(item.id)) : [];
  const arrivalsMore = arrivals.length > 0 && latest.data!.next !== null && !latest.data!.items.some((item) => shown.has(item.id));
  const refreshFailed = calm && latest.isError;

  // Drawer: a row of the loaded list is shown at once; the event is also read by its id (it carries who started it, and a deep link has no row).
  const onList = typeof wanted === "number" ? rows.find((each) => each.id === wanted) : undefined;
  const single = useEvent(typeof wanted === "number" ? wanted : null);
  const opened = single.data?.id === wanted ? single.data : onList;
  const drawerStatus: EventDrawerStatus = wanted === null || (!opened && single.error) ? "error" : opened && ready ? "ready" : "loading";
  const drawerMessage = wanted === null || (single.error instanceof ApiError && single.error.status === 404) ? "Event not found." : single.error?.message;

  const [exporting, setExporting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [, repaint] = useState(0);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function go(next: EventsUrlState, replace = false) {
    setParams(writeUrl(next), { replace });
  }

  // Where Close puts the focus: the control the drawer was opened from, if it is still there; else the row's own Details button.
  const openedFrom = useRef<OpenedFrom>("row");
  const lastOpen = useRef<number | null>(null);
  useEffect(() => { if (typeof wanted === "number") lastOpen.current = wanted; }, [wanted]);
  const returnFocus = () => {
    const id = lastOpen.current;
    if (id === null) return null;
    const pinnedLink = openedFrom.current === "pinned" ? document.querySelector<HTMLElement>(`.open-now a[data-event-id="${id}"]`) : null;
    const row = `tr[data-event-id="${id}"]`;
    return pinnedLink ?? document.querySelector<HTMLElement>(`${row} .details-btn, ${row} .cell-time a`);
  };

  /** Opens an event over the list: a new history entry, so Back closes it; the query stays what it is. */
  function open(id: number, from: OpenedFrom) {
    openedFrom.current = from;
    const fromList: FromList = { fromList: true, search: location.search };
    navigate({ pathname: `/events/${id}`, search: location.search }, { state: fromList });
  }

  // A second Escape (a key held down) before the first close has landed must not go back twice.
  const closing = useRef(false);
  useEffect(() => { closing.current = false; }, [location.key]);
  /** Back to the list as it was: one step back when the drawer was opened from it, else (a deep link) to the list with the same query. */
  function close() {
    if (closing.current) return;
    closing.current = true;
    if (isFromList(location.state) && location.state.search === location.search) navigate(-1);
    else navigate({ pathname: "/events", search: location.search }, { replace: true });
  }

  function changeFilters(next: typeof filters) {
    setProblem(null);
    go({ filters: next, view });
  }

  async function exportCsv() {
    setProblem(null);
    setExporting(true);
    try {
      await downloadCsv(eventsCsvUrl(filters));
      toast.info("CSV downloaded"); // the whole file came back before the browser saved it; a failure keeps its inline line
    } catch (e) {
      setProblem(messageOf(e, "export failed"));
    } finally {
      setExporting(false);
    }
  }

  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; }); // declared before the effect below: that one reads the rows of this very render

  // Focus that has to land on a row once the list shows it (the button that was pressed is gone by then): the first new row after "Load more" ended the
  // list, or the first row after "N new events". Evaluated after every render until the row is there.
  const pendingFocus = useRef<(() => HTMLElement | null) | null>(null);
  useEffect(() => {
    const want = pendingFocus.current;
    if (!want || list.isFetching) return;
    const target = want();
    if (target) {
      target.focus();
      pendingFocus.current = null;
    }
  });
  const detailsOf = (id: number | undefined) => (id === undefined ? null : document.querySelector<HTMLElement>(`tr[data-event-id="${id}"] .details-btn, tr[data-event-id="${id}"] .cell-time a`));

  async function loadMore() {
    if (list.isFetchingNextPage) return;
    const before = rows.length;
    const result = await list.fetchNextPage();
    if (!mounted.current || result.isError || result.hasNextPage) return; // on failure, or with more to come, the button is still there and keeps the focus
    pendingFocus.current = () => detailsOf(rowsRef.current[before]?.id);
    repaint((n) => n + 1);
  }

  async function showNew() {
    const result = await list.refetch();
    if (!mounted.current || result.isError) return;
    pendingFocus.current = () => detailsOf(rowsRef.current[0]?.id);
    repaint((n) => n + 1);
  }

  // Previous (newer) and Next (older) walk the loaded list; Next past the last row reads the next page first.
  const index = typeof wanted === "number" ? rows.findIndex((each) => each.id === wanted) : -1;
  const OFF_THE_LIST = "open it from the list to step through the events";
  const reasonOf = (direction: StepDirection): string | null => {
    if (wanted === undefined) return null;
    if (index < 0) return OFF_THE_LIST;
    if (direction === "previous") return index > 0 ? null : "this is the newest event loaded";
    return index < rows.length - 1 || list.hasNextPage ? null : "this is the oldest event loaded";
  };
  const [stepNote, setStepNote] = useState<{ id: number; text: string } | null>(null);
  const [stepping, setStepping] = useState(false);
  const steppingRef = useRef(false);
  const here = useRef(location.pathname + location.search);
  useEffect(() => { here.current = location.pathname + location.search; });

  async function step(direction: StepDirection) {
    if (index < 0 || steppingRef.current || typeof wanted !== "number") return;
    setStepNote(null);
    const goTo = (target: SystemEvent) => {
      openedFrom.current = "row";
      lastOpen.current = target.id; // the new address reaches the page a moment after the URL changes: a quick Escape must still find this row
      navigate({ pathname: `/events/${target.id}`, search: location.search }, { replace: true, state: location.state });
    };
    const beside = direction === "previous" ? rows[index - 1] : rows[index + 1];
    if (beside) {
      goTo(beside);
      return;
    }
    if (direction !== "next" || !list.hasNextPage) return;
    const at = location.pathname + location.search;
    steppingRef.current = true;
    setStepping(true);
    try {
      const result = await list.fetchNextPage();
      const first = result.data?.pages.at(-1)?.items[0];
      if (!mounted.current || here.current !== at) return; // the drawer was closed, or moved on, while the page was read
      if (first) goTo(first);
      else setStepNote({ id: wanted, text: "There are no more events to step to." });
    } catch (e) {
      if (mounted.current && here.current === at) setStepNote({ id: wanted, text: `Could not read more events: ${messageOf(e, "the page could not be read")}` });
    } finally {
      steppingRef.current = false;
      if (mounted.current) setStepping(false);
    }
  }

  const total = fresh ? (pages[0]?.total ?? null) : null;
  const capped = fresh && pages[0]?.total_capped === true;
  const totalText = total === null ? null : `${number(total)}${capped ? "+" : ""}`;
  const countText = totalText === null ? null : `${totalText} ${total === 1 && !capped ? "event" : "events"}`;
  const raw = view === "raw";
  const loading = list.isLoading || site.isPending;
  const filtered = isFiltered(filters);
  const openLines = pinned.data && !pinned.isPlaceholderData ? pinned.data.items : null;
  const newText = arrivals.length > 0 ? `${number(arrivals.length)}${arrivalsMore ? "+" : ""} new ${arrivals.length === 1 && !arrivalsMore ? "event" : "events"}` : null;

  return (
    <div className="admin-page events-page">
      <PageHeader
        title="System events"
        sub={<>What the system did by itself: sources going offline and coming back, checks, imports, history fills and errors. Who did what is in the {can("audit.view") ? <Link to="/audit">Audit log</Link> : "Audit log"}.</>}
      />
      {summary.data ? <Tiles summary={summary.data} timezone={timezone} /> : summary.isLoading ? <TilesSkeleton count={4} className="event-tiles" notes={[3]} /> : null}
      {pinnedOn && (
        <div className="open-now">
          <h2>Happening now</h2>
          {openLines ? (
            openLines.length === 0 ? (
              <p className="muted">No problems are open right now.</p>
            ) : (
              <>
                <ul>
                  {openLines.slice(0, OPEN_LINES).map((each) => (
                    <li key={each.id}>
                      <span className="open-text">{openLine(each, timezone)}</span>
                      <Link
                        to={{ pathname: `/events/${each.id}`, search: location.search }}
                        state={{ fromList: true, search: location.search } satisfies FromList}
                        data-event-id={each.id}
                        aria-label={`Open problem details, event #${each.id}`}
                        onClick={() => { openedFrom.current = "pinned"; }}
                      >
                        Details
                      </Link>
                    </li>
                  ))}
                </ul>
                {(openLines.length > OPEN_LINES || pinned.data!.next !== null) && (
                  <button type="button" className="quiet" onClick={() => go({ filters: { ...filters, open: true }, view })}>Show all open problems</button>
                )}
              </>
            )
          ) : pinned.isLoading || pinned.isPlaceholderData ? (
            // As many placeholder lines as the tiles say are open (one when none are or the tiles are not here yet), so the list does not drop when the lines arrive.
            <ul aria-hidden="true">
              {Array.from({ length: Math.min(Math.max(summary.data?.open_incidents ?? 1, 1), OPEN_LINES) }, (_, i) => <li key={i}><Skeleton width="70ch" /></li>)}
            </ul>
          ) : null}
        </div>
      )}
      <EventFilterBar filters={filters} onChange={changeFilters} options={options.data} onExport={() => void exportCsv()} exporting={exporting} error={problem} />
      {loading && (
        <>
          {/* the Friendly/Raw switch needs rows to show; its place is kept (the same row and margin), or the table would sit 44px higher than it lands */}
          <div className="row seg" aria-hidden="true"><ActionsSpace /></div>
          <div className="events-skeleton"><TableSkeleton columns={5} rows={8} widths={raw ? RAW_COLS : FRIENDLY_COLS} label="Loading the system events" /></div>
        </>
      )}
      {list.isError && rows.length === 0 && <p className="error" role="alert">{list.error.message}</p>}
      {fresh && total === 0 && (
        <EmptyNote icon={filtered ? "filter" : "events"}>{filtered ? "No events match these filters." : "No system events yet."}</EmptyNote>
      )}
      {list.isPlaceholderData && rows.length === 0 && <p className="muted">Updating…</p>}
      {rows.length > 0 && !loading && (
        <>
          <div className="row seg">
            <div className="seg-switch" role="group" aria-label="View">
              <button type="button" aria-pressed={!raw} onClick={() => go({ filters, view: "friendly" })}>Friendly</button>
              <button type="button" aria-pressed={raw} onClick={() => go({ filters, view: "raw" })}>Raw</button>
              {list.isPlaceholderData && <span className="muted">Updating…</span>}
            </div>
            {newText && <button type="button" className="new-events" onClick={() => void showNew()}>{newText}</button>}
            <p className="result-count">{countText}{refreshFailed && <span className="refresh-note">{countText ? " · " : ""}could not refresh</span>}</p>
          </div>
          <div className="table-wrap">
            <table className="events-table" aria-busy={list.isPlaceholderData}>
              <colgroup>{(raw ? RAW_COLS : FRIENDLY_COLS).map((w, i) => <col key={i} style={w ? { width: w } : undefined} />)}</colgroup>
              <thead>
                <tr>
                  {!raw && <th><span className="sr-only">Details</span></th>}
                  <th title={`Time (${timezone})`}>Time ({timezone})</th>
                  {raw && <th>Level</th>}
                  <th>Source</th>
                  {raw ? <><th>Kind</th><th>Message</th></> : <><th>What happened</th><th>Count</th></>}
                </tr>
              </thead>
              <tbody>
                {rows.map((each) =>
                  raw ? (
                    <RawRow key={each.id} event={each} timezone={timezone} now={now} search={location.search} isOpen={each.id === wanted} open={open} />
                  ) : (
                    <FriendlyRow key={each.id} event={each} timezone={timezone} now={now} search={location.search} isOpen={each.id === wanted} open={open} />
                  ),
                )}
              </tbody>
            </table>
          </div>
          <div className="row load-row">
            <p className="muted">{`Showing ${number(rows.length)}${totalText ? ` of ${totalText}` : ""}`}</p>
            {list.isError && <p className="error" role="alert">{list.error.message}</p>}
            {list.hasNextPage && (
              <button type="button" aria-disabled={list.isFetchingNextPage || undefined} onClick={() => void loadMore()}>
                {list.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        </>
      )}
      {/* Outside the table: the drawer is a portal, and its React events would otherwise reach the row's click handler. */}
      {wanted !== undefined && (
        <EventDrawer
          event={opened}
          status={drawerStatus}
          message={drawerMessage}
          timezone={timezone}
          now={now}
          onClose={close}
          returnFocus={returnFocus}
          startedByPending={typeof wanted === "number" && single.data?.id !== wanted && !single.error}
          footer={
            <EventSteps
              previous={reasonOf("previous")}
              next={reasonOf("next")}
              busy={stepping}
              error={stepNote && stepNote.id === opened?.id ? stepNote.text : null}
              onStep={(direction) => void step(direction)}
            />
          }
        />
      )}
    </div>
  );
}
