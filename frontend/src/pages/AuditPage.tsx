import { useState } from "react";
import { useAudit, useSite } from "../api/queries";
import { formatSiteDateTime } from "../lib/siteTime";

const PAGE_SIZE = 50;

export function AuditPage() {
  const [offset, setOffset] = useState(0);
  const { data, error, isLoading } = useAudit(PAGE_SIZE, offset);
  const site = useSite();
  const timezone = site.data?.timezone ?? "UTC"; // falls back to UTC if the site cannot be read
  const ready = !site.isPending;

  return (
    <>
      <h1>Audit log</h1>
      {(isLoading || site.isPending) && <p className="muted">loading…</p>}
      {error && <p className="error" role="alert">{error.message}</p>}
      {ready && data && data.items.length === 0 && <p className="muted">No audit entries yet.</p>}
      {ready && data && data.items.length > 0 && (
        <>
          <table>
            <thead><tr><th>Time ({timezone})</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id}>
                  <td>{formatSiteDateTime(e.ts, timezone)}</td>
                  <td>{e.username ?? "—"}</td>
                  <td>{e.action}</td>
                  <td><code>{JSON.stringify(e.detail)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>Previous</button>
            <span className="muted">{`Showing ${offset + 1}–${offset + data.items.length} of ${data.total}`}</span>
            <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + data.items.length >= data.total}>Next</button>
          </div>
        </>
      )}
    </>
  );
}
