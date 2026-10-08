import { useState } from "react";
import { Link } from "react-router";
import { useDashboards, useDeleteDashboard, useSite } from "../api/queries";
import type { DashboardListItem } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { CreateDashboardDialog } from "../components/dashboard/CreateDashboardDialog";
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
      <div className="row">
        <h1>Dashboards</h1>
        <span className="spacer" />
        {canEdit && <button type="button" onClick={() => setCreating(true)}>New dashboard</button>}
      </div>
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {failure && <p className="error" role="alert">{failure.message}</p>}
      {!failure && (!list.data || timezone === undefined) && <p className="muted">loading…</p>}
      {list.data && timezone !== undefined && list.data.length === 0 && (
        <p className="muted">No dashboards yet.{canEdit ? " Create one to get started." : ""}</p>
      )}
      {list.data && timezone !== undefined && list.data.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>Widgets</th><th>Updated</th>{canEdit && <th>Actions</th>}</tr></thead>
          <tbody>
            {list.data.map((d) => (
              <tr key={d.id}>
                <td><Link to={`/dashboards/${d.id}`}>{d.name}</Link></td>
                <td>{d.widget_count}</td>
                <td>{formatSiteDateTime(d.updated_at, timezone)}</td>
                {canEdit && <td><button type="button" onClick={() => confirmDelete(d)} aria-label={`Delete ${d.name}`}>Delete</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && <CreateDashboardDialog onClose={() => setCreating(false)} />}
    </>
  );
}
