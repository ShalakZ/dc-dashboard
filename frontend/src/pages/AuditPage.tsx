import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { auditPosition, useAudit, useAuditOptions, useSite } from "../api/queries";
import type { AuditEntry } from "../api/types";
import { AuditEntryDetail } from "../components/AuditEntryDetail";
import { AuditFilterBar } from "../components/AuditFilterBar";
import { AuditPager } from "../components/AuditPager";
import { PageHeader } from "../components/PageHeader";
import { apiQuery, isFiltered, readUrl, writeUrl, type AuditFilters, type AuditUrlState } from "../lib/auditFilters";
import { describeAudit } from "../lib/auditText";
import { downloadCsv } from "../lib/download";
import { formatSiteDateTime, siteDay } from "../lib/siteTime";

const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** The time of an entry, linked to its page; the link's name says which entry it opens. */
function TimeLink({ id, ts, timezone }: { id: number; ts: string; timezone: string }) {
  const time = formatSiteDateTime(ts, timezone);
  return <Link to={`/audit/${id}`} aria-label={`Entry #${id}, ${time}`}>{time}</Link>;
}

/** One friendly row: the sentence and the link to the thing, with the full account one click away (drawn only when opened). */
function FriendlyRow({ entry, timezone }: { entry: AuditEntry; timezone: string }) {
  const [open, setOpen] = useState(false);
  const { summary, link } = describeAudit(entry);
  return (
    <tr>
      <td className="cell-time"><TimeLink id={entry.id} ts={entry.ts} timezone={timezone} /></td>
      <td className="cell-user" title={entry.username ?? undefined}>{entry.username ?? "—"}</td>
      <td>
        <div className="what">{summary}</div>
        {link && <div className="sub"><Link to={link.to}>{link.label}</Link></div>}
        <details className="audit-more" onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>Details</summary>
          {open && <AuditEntryDetail entry={entry} view="friendly" />}
        </details>
      </td>
    </tr>
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
  const today = siteDay(new Date(), timezone);
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

  // The two "nothing to show" messages keep their exact words; the icon only fills the empty space around them.
  const emptyIcon = (
    <div className="empty-icon">
      <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>
    </div>
  );

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
      {(isLoading || site.isPending) && <p className="muted">loading…</p>}
      {error && <p className="error" role="alert">{error.message}</p>}
      {fresh && fresh.total === 0 && (
        <div className="empty">
          {emptyIcon}
          <p>{isFiltered(filters) ? "No entries match these filters." : "No audit entries yet."}</p>
        </div>
      )}
      {fresh && fresh.total > 0 && rows.length === 0 && <p className="muted">This page is past the end of the log.</p>}
      {isPlaceholderData && rows.length === 0 && <p className="muted">Updating…</p>}
      {rows.length > 0 && (
        <>
          <div className="row seg" role="group" aria-label="View">
            <button type="button" aria-pressed={!raw} onClick={() => go({ ...state, view: "friendly" })}>Friendly</button>
            <button type="button" aria-pressed={raw} onClick={() => go({ ...state, view: "raw" })}>Raw</button>
            {isPlaceholderData && <span className="muted">Updating…</span>}
          </div>
          <div className="table-wrap">
            <table className="audit-table" aria-busy={isPlaceholderData}>
              <thead>
                <tr>
                  <th>Time ({timezone})</th><th>User</th>
                  {raw ? <><th>Action</th><th>Detail</th></> : <th>What happened</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) =>
                  raw ? (
                    <tr key={e.id}>
                      <td className="cell-time"><TimeLink id={e.id} ts={e.ts} timezone={timezone} /></td>
                      <td className="cell-user" title={e.username ?? undefined}>{e.username ?? "—"}</td>
                      <td className="cell-action">{e.action}</td>
                      <td><code>{JSON.stringify(e.detail)}</code></td>
                    </tr>
                  ) : (
                    <FriendlyRow key={e.id} entry={e} timezone={timezone} />
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
