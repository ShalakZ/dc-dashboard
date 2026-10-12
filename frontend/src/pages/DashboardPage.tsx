import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { ApiError } from "../api/client";
import { keys, useDashboard, useSite } from "../api/queries";
import type { Dashboard } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Crumbs } from "../components/Crumbs";
import { DashboardViewer } from "../components/dashboard/DashboardViewer";
import { LiveValuesProvider } from "../components/dashboard/LiveValuesContext";
import { Pending } from "../components/Pending";
import { newest } from "../lib/dashboardEdit";

// The editor brings react-grid-layout with it: it loads only when someone starts editing (spec 10.8).
const DashboardEditor = lazy(() => import("../components/dashboard/DashboardEditor").then((m) => ({ default: m.DashboardEditor })));

export function DashboardPage() {
  const id = Number(useParams().id);
  // Keyed by id so moving from one dashboard to another starts from a clean slate.
  return <DashboardScreen key={id} id={id} />;
}

function DashboardScreen({ id }: { id: number }) {
  const { hasRole } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const query = useDashboard(id);
  const site = useSite();
  // Edit mode starts when the create dialog sent us here with { edit: true }; viewers never get it (see canEdit below).
  const [wantsEdit, setWantsEdit] = useState(() => (location.state as { edit?: boolean } | null)?.edit === true);
  // The copy the server returned from our last save (or from Reload); the cache may briefly still hold an older one.
  const [saved, setSaved] = useState<Dashboard | null>(null);
  const [epoch, setEpoch] = useState(0);
  const canEdit = hasRole("operator");
  const dashboard = newest(saved, query.data);
  const queryClient = useQueryClient();
  const loadError = query.error;
  // A dashboard that is gone may still be what the sidebar's Dashboards link points at: ask again which one is the default.
  useEffect(() => {
    if (loadError instanceof ApiError && loadError.status === 404) void queryClient.invalidateQueries({ queryKey: keys.defaultDashboard });
  }, [loadError, queryClient]);

  if (query.isLoading || site.isLoading) return <p className="muted">loading…</p>;
  const failure = query.error ?? site.error;
  // Block the page only when there is nothing to show. React Query keeps the last data when a refetch fails and still sets
  // `error`; replacing the screen then would unmount the editor and silently throw away unsaved edits (and a failed Reload
  // would leave a dead end), so a failure with data on screen is a notice above it.
  if (!dashboard || !site.data) return <p className="error" role="alert">{failure?.message ?? "not found"}</p>;
  const timezone = site.data.timezone;
  const notice = failure ? <p className="error" role="alert">Could not refresh this page: {failure.message}</p> : null;
  const crumbs = <Crumbs trail={[{ label: "Dashboards", to: "/dashboards" }, { label: dashboard.name }]} />;

  const leaveEdit = () => {
    setWantsEdit(false);
    // Forget the { edit: true } the create dialog left in the history entry, or a refresh would reopen the editor.
    if (location.state) navigate(location.pathname + location.search, { replace: true, state: null });
  };

  if (canEdit && wantsEdit) {
    return (
      <>
        {notice}
        {crumbs}
        <Suspense fallback={<><Pending /><p className="muted">loading editor…</p></>}>
          <DashboardEditor
            key={epoch}
            dashboard={dashboard}
            timezone={timezone}
            onSaved={(next) => { setSaved(next); leaveEdit(); }}
            onCancel={leaveEdit}
            onReload={async () => {
              const fresh = await query.refetch();
              if (fresh.error) throw fresh.error;
              setSaved(fresh.data ?? null);
              setEpoch((n) => n + 1);
            }}
          />
        </Suspense>
      </>
    );
  }
  return (
    <>
      {notice}
      {crumbs}
      <LiveValuesProvider>
        <DashboardViewer dashboard={dashboard} timezone={timezone} onEdit={canEdit ? () => setWantsEdit(true) : undefined} />
      </LiveValuesProvider>
    </>
  );
}
