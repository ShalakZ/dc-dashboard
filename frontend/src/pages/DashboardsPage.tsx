import { useState } from "react";
import { Link } from "react-router";
import { useDashboards, useDefaultDashboard, useDeleteDashboard, usePutDefaultDashboard, useSite } from "../api/queries";
import type { DashboardListItem } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { CreateDashboardDialog } from "../components/dashboard/CreateDashboardDialog";
import { PageHeader } from "../components/PageHeader";
import { RowActions } from "../components/RowActions";
import { TableSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { TrashButton } from "../components/TrashButton";
import { useAction } from "../hooks/useAction";
import { useConfirm } from "../hooks/useConfirm";
import { formatSiteDateTime } from "../lib/siteTime";

export function DashboardsPage() {
  const { can } = useAuth();
  const canEdit = can("dashboards.edit"); // New dashboard and the trash
  const canDefault = can("dashboards.default"); // the Make default menu
  const hasActions = canEdit || canDefault;
  const list = useDashboards();
  const site = useSite();
  const remove = useDeleteDashboard();
  const defaultId = useDefaultDashboard().data?.dashboard_id ?? null;
  const setDefault = usePutDefaultDashboard();
  const { run, error: actionError } = useAction();
  const [ask, confirmDialog] = useConfirm();
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  const failure = list.error ?? site.error;
  const timezone = site.data?.timezone;

  const confirmDelete = (d: DashboardListItem) => run(async () => {
    const warning = d.id === defaultId ? " It is the default dashboard: nobody will land on it any more." : "";
    if (!(await ask({ title: `Delete dashboard "${d.name}"?`, message: `Its widgets go with it.${warning}` }))) return;
    await remove.mutateAsync(d.id);
    toast.success(`Dashboard "${d.name}" deleted`);
  });

  // The menu closes when an item is chosen and the badge moves only after the list is read again: the toast says what just happened.
  const makeDefault = (d: DashboardListItem) => run(async () => {
    await setDefault.mutateAsync({ dashboard_id: d.id });
    toast.success(`"${d.name}" is now the default dashboard`);
  });
  const clearDefault = () => run(async () => {
    await setDefault.mutateAsync({ dashboard_id: null });
    toast.success("Default dashboard cleared");
  });

  // The heading is always there (App.test.tsx finds the page by it); the body waits for the list and the site zone.
  return (
    <>
      <PageHeader
        title="Dashboards"
        actions={canEdit ? <button type="button" className="primary" onClick={() => setCreating(true)}>New dashboard</button> : undefined}
      />
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {confirmDialog}
      {failure && <p className="error" role="alert">{failure.message}</p>}
      {!failure && (!list.data || timezone === undefined) && <TableSkeleton columns={hasActions ? 4 : 3} rows={4} label="Loading dashboards" />}
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
            <thead><tr><th>Name</th><th className="num">Widgets</th><th>Updated</th>{hasActions && <th className="act">Actions</th>}</tr></thead>
            <tbody>
              {list.data.map((d) => (
                <tr key={d.id}>
                  <td className="name">
                    <div className="name-row">
                      <Link to={`/dashboards/${d.id}`} title={d.name}>{d.name}</Link>
                      {d.id === defaultId && <span className="badge">Default</span>}
                    </div>
                  </td>
                  <td className="num">{d.widget_count}</td>
                  <td className="when">{formatSiteDateTime(d.updated_at, timezone)}</td>
                  {hasActions && (
                    <td className="act">
                      <div className="act-row">
                        {canDefault && (
                          <RowActions
                            label={`Actions for ${d.name}`}
                            items={[d.id === defaultId
                              ? { label: "Clear default", onSelect: clearDefault }
                              : { label: "Make default", onSelect: () => makeDefault(d) }]}
                          />
                        )}
                        {canEdit && <TrashButton label={`Delete ${d.name}`} onClick={() => confirmDelete(d)} />}
                      </div>
                    </td>
                  )}
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
