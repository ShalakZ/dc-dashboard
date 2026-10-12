import { Link, useParams } from "react-router";
import { useAuditEntry, useSite } from "../api/queries";
import { ApiError } from "../api/client";
import { AuditEntryDetail } from "../components/AuditEntryDetail";
import { PageHeader } from "../components/PageHeader";
import { PageHeaderSkeleton, Skeleton, SkeletonRegion } from "../components/Skeleton";
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
  // The way back, once: in the page header's actions when the entry shows, on its own line above the message otherwise.
  const back = (
    <Link to="/audit">
      <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
      Back to the log
    </Link>
  );

  if (id === null || (error instanceof ApiError && error.status === 404)) {
    return <div className="admin-page audit-entry-page"><p className="back-line">{back}</p><p className="error" role="alert">Audit entry not found.</p></div>;
  }
  if (error) return <div className="admin-page audit-entry-page"><p className="back-line">{back}</p><p className="error" role="alert">{error.message}</p></div>;
  if (isLoading || site.isPending || !data) {
    return (
      <div className="admin-page audit-entry-page">
        <SkeletonRegion label="Loading the entry">
          <PageHeaderSkeleton crumbs />
          <dl className="kv" aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i}><dt><Skeleton width="9ch" /></dt><dd><Skeleton width={i % 3 === 0 ? "26ch" : "16ch"} /></dd></div>
            ))}
          </dl>
        </SkeletonRegion>
      </div>
    );
  }
  return (
    <div className="admin-page audit-entry-page">
      <PageHeader title={`Audit entry #${data.id}`} crumbs={[{ label: "Audit log", to: "/audit" }, { label: `Entry #${data.id}` }]} actions={back} />
      <dl className="kv">
        <div><dt>Time ({timezone})</dt><dd>{formatSiteDateTime(data.ts, timezone)}</dd></div>
        <div><dt>User</dt><dd>{data.username ?? "—"}</dd></div>
        <div><dt>Action</dt><dd>{data.action}</dd></div>
      </dl>
      <h2 className="section-title">What happened</h2>
      <AuditEntryDetail entry={data} view="friendly" />
      <h2 className="section-title">Raw</h2>
      <pre>{JSON.stringify(data.detail, null, 2)}</pre>
    </div>
  );
}
