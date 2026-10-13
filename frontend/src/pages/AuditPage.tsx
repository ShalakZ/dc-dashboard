import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { auditPosition, useAudit, useAuditOptions, useSite } from "../api/queries";
import type { AuditEntry } from "../api/types";
import { AuditEntryDetail } from "../components/AuditEntryDetail";
import { AuditFilterBar } from "../components/AuditFilterBar";
import { AuditPager } from "../components/AuditPager";
import { EmptyNote } from "../components/EmptyNote";
import { Icon, type IconName } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { ActionsSpace, TableSkeleton } from "../components/Skeleton";
import { apiQuery, isFiltered, readUrl, writeUrl, type AuditFilters, type AuditUrlState } from "../lib/auditFilters";
import { auditKind, type AuditKind } from "../lib/auditKind";
import { describeAudit } from "../lib/auditText";
import { downloadCsv } from "../lib/download";
import { relativeTime } from "../lib/relativeTime";
import { formatSiteDateTime, siteDay } from "../lib/siteTime";

const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

// The icon of each kind of event (lib/auditKind.ts); it is decoration, the sentence says the same.
const KIND_ICON: Record<AuditKind, IconName> = {
  signin: "evSignIn", problem: "evProblem", create: "evCreate", change: "evChange", delete: "evDelete", settings: "evSettings", other: "evOther",
};

// Column widths in px, null for the rest: the friendly table gives "What happened" the room (and puts the Details chevron first, where a
// short sentence's empty end does not separate it from its entry), the raw one the detail. They sum to less than the narrowest table; the
// skeleton draws the same columns.
const FRIENDLY_COLS = [36, 200, 160, null] as const;
const RAW_COLS = [200, 160, 220, null] as const;

/** The time of an entry, linked to its page (the link's name says which entry it opens), and under it how long ago, outside the link. */
function TimeCell({ id, ts, timezone, now }: { id: number; ts: string; timezone: string; now: Date }) {
  const time = formatSiteDateTime(ts, timezone);
  const ago = relativeTime(ts, now, timezone);
  return (
    <td className="cell-time">
      <Link to={`/audit/${id}`} aria-label={`Entry #${id}, ${time}`}>{time}</Link>
      {ago && <span className="ago">{ago}</span>}
    </td>
  );
}

/** Who did it: an initial disc (decoration) and the name, in the cell itself so a long name is cut with an ellipsis; no user is a dash. */
function UserCell({ name }: { name: string | null }) {
  const initial = name ? (Array.from(name.trim())[0] ?? "").toUpperCase() : "";
  return (
    <td className="cell-user" title={name ?? undefined}>
      {name ? <><span className="user-disc" aria-hidden="true">{initial}</span>{name}</> : "—"}
    </td>
  );
}

/** One friendly row: the event's icon, the sentence and the link to the thing, with the full account one click away in a row under it (drawn only when opened). */
function FriendlyRow({ entry, timezone, now }: { entry: AuditEntry; timezone: string; now: Date }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const { summary, link } = describeAudit(entry);
  const kind = auditKind(entry.action);
  return (
    <>
      <tr>
        <td className="cell-more">
          <button
            type="button"
            className="icon-btn details-btn"
            aria-label={`Details of entry #${entry.id}`}
            title="Details"
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            onClick={() => setOpen(!open)}
          >
            <Icon name="chevron" />
          </button>
        </td>
        <TimeCell id={entry.id} ts={entry.ts} timezone={timezone} now={now} />
        <UserCell name={entry.username} />
        <td className="cell-what">
          <div className="what-line">
            <span className="ev-tile" data-kind={kind} aria-hidden="true"><Icon name={KIND_ICON[kind]} /></span>
            <div className="what-text">
              <span className="what">{summary}</span>
              {link && <Link className="what-link" to={link.to}>{link.label}</Link>}
            </div>
          </div>
        </td>
      </tr>
      {open && (
        <tr id={detailId} className="detail-row">
          <td colSpan={4}><AuditEntryDetail entry={entry} view="friendly" /></td>
        </tr>
      )}
    </>
  );
}

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => readUrl(params), [params]);
  const { filters, offset, size, view } = state;
  const current = writeUrl(state).toString();

  const site = useSite();
  const timezone = site.data?.timezone ?? "UTC"; // falls back to UTC if the site cannot be read
  const ready = !site.isPending;
  const now = new Date(); // once per render: every row's "how long ago" is counted from the same moment
  const today = siteDay(now, timezone);
  const options = useAuditOptions();
  const { data, error, isLoading, isPlaceholderData } = useAudit(filters, size, offset);

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
        onExport={exportCsv}
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
                    <tr key={e.id}>
                      <TimeCell id={e.id} ts={e.ts} timezone={timezone} now={now} />
                      <UserCell name={e.username} />
                      <td className="cell-action">{e.action}</td>
                      <td className="cell-detail"><code>{JSON.stringify(e.detail)}</code></td>
                    </tr>
                  ) : (
                    <FriendlyRow key={e.id} entry={e} timezone={timezone} now={now} />
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
    </div>
  );
}
