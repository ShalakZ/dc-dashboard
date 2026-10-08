import { Link, useParams } from "react-router";
import { useDashboard, useSite } from "../api/queries";
import { DashboardViewer } from "../components/dashboard/DashboardViewer";
import { LiveValuesProvider } from "../components/dashboard/LiveValuesContext";

export function DashboardPage() {
  const id = Number(useParams().id);
  // Keyed by id so moving from one dashboard to another starts from a clean slate.
  return <DashboardScreen key={id} id={id} />;
}

function DashboardScreen({ id }: { id: number }) {
  const dashboard = useDashboard(id);
  const site = useSite();
  if (dashboard.isLoading || site.isLoading) return <p className="muted">loading…</p>;
  const failure = dashboard.error ?? site.error;
  if (failure || !dashboard.data || !site.data) return <p className="error" role="alert">{failure?.message ?? "not found"}</p>;
  return (
    <>
      <p><Link to="/dashboards">Dashboards</Link> / {dashboard.data.name}</p>
      <LiveValuesProvider>
        <DashboardViewer dashboard={dashboard.data} timezone={site.data.timezone} />
      </LiveValuesProvider>
    </>
  );
}
