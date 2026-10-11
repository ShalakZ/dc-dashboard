import { useState } from "react";
import { Link } from "react-router";
import { useDashboards, useDeleteDashboard, useSite } from "../api/queries";
import type { DashboardListItem } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { CreateDashboardDialog } from "../components/dashboard/CreateDashboardDialog";
import { PageHeader } from "../components/PageHeader";
import { useAction } from "../hooks/useAction";
import { formatSiteDateTime } from "../lib/siteTime";

export function DashboardsPage() {
  const { hasRole } = useAuth();
  const canEdit = hasRole("operator");
  const list = useDashboards();
  const site = useSite();
  const remove = useDeleteDashboard();
  const { run, error: actionError } = useAction();
  const [creating, setCreating] = useState(false);

  const failure = list.error ?? site.error;
  const timezone = site.data?.timezone;

  const confirmDelete = (d: DashboardListItem) => run(async () => {
    if (!window.confirm(`Delete dashboard "${d.name}" and its widgets?`)) return;
    await remove.mutateAsync(d.id);
  });

  // The heading is always there (App.test.tsx finds the page by it); the body waits for the list and the site zone.
  return (
    <>
      <PageHeader
        title="Dashboards"
        actions={canEdit ? <button type="button" className="primary" onClick={() => setCreating(true)}>New dashboard</button> : undefined}
      />
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {failure && <p className="error" role="alert">{failure.message}</p>}
      {!failure && (!list.data || timezone === undefined) && <p className="muted">loading…</p>}
      {list.data && timezone !== undefined && list.data.length === 0 && (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true">
            <svg className="i" viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="9" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="5" rx="1.5" /><rect x="13.5" y="11" width="7.5" height="10" rx="1.5" /><rect x="3" y="15" width="7.5" height="6" rx="1.5" /></svg>
          </span>
          <p>No dashboards yet.{canEdit ? " Create one to get started." : ""}</p>
        </div>
      )}
      {list.data && timezone !== undefined && list.data.length > 0 && (
        <div className="table-wrap">
          <table className="dashboards-table">
            <thead><tr><th>Name</th><th className="num">Widgets</th><th>Updated</th>{canEdit && <th className="act">Actions</th>}</tr></thead>
            <tbody>
              {list.data.map((d) => (
                <tr key={d.id}>
                  <td className="name"><Link to={`/dashboards/${d.id}`} title={d.name}>{d.name}</Link></td>
                  <td className="num">{d.widget_count}</td>
                  <td className="when">{formatSiteDateTime(d.updated_at, timezone)}</td>
                  {canEdit && <td className="act"><button type="button" className="danger-quiet" onClick={() => confirmDelete(d)} aria-label={`Delete ${d.name}`}>Delete</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateDashboardDialog onClose={() => setCreating(false)} />}
    </>
  );
}
