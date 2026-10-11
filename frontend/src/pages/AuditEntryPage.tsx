import { Link, useParams } from "react-router";
import { useAuditEntry, useSite } from "../api/queries";
import { ApiError } from "../api/client";
import { AuditEntryDetail } from "../components/AuditEntryDetail";
import { formatSiteDateTime } from "../lib/siteTime";

const MAX_ID = 2_147_483_647; // the largest id the API holds

/** One audit entry on its own page: the permanent link the log's time cells point to. */
export function AuditEntryPage() {
  const raw = useParams().id ?? "";
  const number = /^\d+$/.test(raw) ? Number(raw) : null;
  const id = number !== null && number >= 1 && number <= MAX_ID ? number : null; // no request for anything else
  const { data, error, isLoading } = useAuditEntry(id);
  const site = useSite();
  const timezone = site.data?.timezone ?? "UTC"; // falls back to UTC if the site cannot be read
  const back = <p><Link to="/audit">Back to the log</Link></p>;

  if (id === null || (error instanceof ApiError && error.status === 404)) {
    return <>{back}<p className="error" role="alert">Audit entry not found.</p></>;
  }
  if (error) return <>{back}<p className="error" role="alert">{error.message}</p></>;
  if (isLoading || site.isPending || !data) return <p className="muted">loading…</p>;
  return (
    <>
      {back}
      <h1>Audit entry #{data.id}</h1>
      <dl>
        <div><dt>Time ({timezone})</dt><dd>{formatSiteDateTime(data.ts, timezone)}</dd></div>
        <div><dt>User</dt><dd>{data.username ?? "—"}</dd></div>
        <div><dt>Action</dt><dd>{data.action}</dd></div>
      </dl>
      <h2>What happened</h2>
      <AuditEntryDetail entry={data} view="friendly" />
      <h2>Raw</h2>
      <pre>{JSON.stringify(data.detail, null, 2)}</pre>
    </>
  );
}
