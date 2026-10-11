import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { auditPosition, useAudit, useAuditOptions, useSite } from "../api/queries";
import type { AuditEntry } from "../api/types";
import { AuditEntryDetail } from "../components/AuditEntryDetail";
import { AuditFilterBar } from "../components/AuditFilterBar";
import { AuditPager } from "../components/AuditPager";
import { apiQuery, isFiltered, readUrl, writeUrl, type AuditFilters, type AuditUrlState } from "../lib/auditFilters";
import { describeAudit } from "../lib/auditText";
import { downloadCsv } from "../lib/download";
import { formatSiteDateTime, siteDay } from "../lib/siteTime";

const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** One friendly row: the sentence and the link to the thing, with the full account one click away (drawn only when opened). */
function FriendlyRow({ entry, timezone }: { entry: AuditEntry; timezone: string }) {
  const [open, setOpen] = useState(false);
  const { summary, link } = describeAudit(entry);
  return (
    <tr>
      <td><Link to={`/audit/${entry.id}`}>{formatSiteDateTime(entry.ts, timezone)}</Link></td>
      <td>{entry.username ?? "—"}</td>
      <td>
        <div>{summary}</div>
        {link && <div><Link to={link.to}>{link.label}</Link></div>}
        <details onToggle={(e) => setOpen(e.currentTarget.open)}>
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
      if (apiQuery(latest.current.filters) !== asked) return;
      const next = { ...latest.current, offset: answer.offset };
      go(next);
      if (!answer.on_day) setHint({ text: `No entries on ${date}; showing the nearest older ones.`, at: writeUrl(next).toString() });
    } catch (e) {
      if (apiQuery(latest.current.filters) === asked) setProblem(messageOf(e, "could not find that date"));
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
  const raw = view === "raw";

  return (
    <>
      <h1>Audit log</h1>
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
        notice={hint && hint.at === current ? hint.text : null}
      />
      {(isLoading || site.isPending) && <p className="muted">loading…</p>}
      {error && <p className="error" role="alert">{error.message}</p>}
      {ready && data && data.total === 0 && (
        <p className="muted">{isFiltered(filters) ? "No entries match these filters." : "No audit entries yet."}</p>
      )}
      {ready && data && data.total > 0 && rows.length === 0 && (
        <div className="row">
          <span className="muted">This page is past the end of the log.</span>
          <button type="button" onClick={() => go({ ...state, offset: 0 })}>First</button>
        </div>
      )}
      {rows.length > 0 && (
        <>
          <div className="row" role="group" aria-label="View">
            <button type="button" aria-pressed={!raw} onClick={() => go({ ...state, view: "friendly" })}>Friendly</button>
            <button type="button" aria-pressed={raw} onClick={() => go({ ...state, view: "raw" })}>Raw</button>
            {isPlaceholderData && <span className="muted">Updating…</span>}
          </div>
          <table aria-busy={isPlaceholderData}>
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
                    <td><Link to={`/audit/${e.id}`}>{formatSiteDateTime(e.ts, timezone)}</Link></td>
                    <td>{e.username ?? "—"}</td>
                    <td>{e.action}</td>
                    <td><code>{JSON.stringify(e.detail)}</code></td>
                  </tr>
                ) : (
                  <FriendlyRow key={e.id} entry={e} timezone={timezone} />
                ),
              )}
            </tbody>
          </table>
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
    </>
  );
}
