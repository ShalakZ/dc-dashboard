import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { useDefaultDashboard } from "./api/queries";
import { useAuth } from "./auth/AuthProvider";
import { RequireAuth, RequirePermission } from "./auth/RequireAuth";
import { Layout } from "./components/Layout";
import { PAGE_NEED, visibleGroups } from "./components/navItems";
import { NoPages } from "./components/NoPages";
import { Pending } from "./components/Pending";
import { PageSkeleton } from "./components/Skeleton";
import { AssetKindsPage } from "./pages/AssetKindsPage";
import { AssetPage } from "./pages/AssetPage";
import { AssetsPage } from "./pages/AssetsPage";
import { AssetsSummary } from "./pages/AssetsSummary";
import { AuditPage } from "./pages/AuditPage";
import { BillingPage } from "./pages/BillingPage";
import { DiagnosticsPage } from "./pages/DiagnosticsPage";
import { DisplaysPage } from "./pages/DisplaysPage";
import { EventsPage } from "./pages/EventsPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { PasswordPage } from "./pages/PasswordPage";
import { ScansPage } from "./pages/ScansPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { SourcePointsPage } from "./pages/SourcePointsPage";
import { SourcesPage } from "./pages/SourcesPage";
import { StoragePage } from "./pages/StoragePage";
import { TariffsPage } from "./pages/TariffsPage";
import { UsersPage } from "./pages/UsersPage";

// These pages pull in react-grid-layout, ECharts and the xyflow graph, so they load only when visited.
const DashboardsPage = lazy(() => import("./pages/DashboardsPage").then((m) => ({ default: m.DashboardsPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const DiscoveryPage = lazy(() => import("./pages/DiscoveryPage").then((m) => ({ default: m.DiscoveryPage })));
const loading = <><Pending /><PageSkeleton label="Loading the page" /></>; // Pending: the loading bar waits for it too (a skeleton alone is no load)

/**
 * `/`: the default dashboard when one is set (and the role may see dashboards), else Assets Tree, else the first page of the sidebar the
 * role may open, else a screen that says the role has no pages yet. Waits for the answer, so Assets Tree is not shown first; an error
 * falls back to the same places. A role that may not see dashboards never asks, and so never waits.
 */
function HomeRedirect() {
  const { can } = useAuth();
  const seesDashboards = can("dashboards.view");
  const { data, isPending } = useDefaultDashboard(seesDashboards); // a query that is not enabled stays pending for good
  if (seesDashboards && isPending) return loading;
  if (seesDashboards && data?.dashboard_id) return <Navigate to={`/dashboards/${data.dashboard_id}`} replace />;
  if (can("assets.view")) return <Navigate to="/assets" replace />;
  const first = visibleGroups(can)[0]?.items[0];
  return first ? <Navigate to={first.to} replace /> : <NoPages />;
}

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/assets" element={<RequirePermission need={PAGE_NEED.assets}><AssetsPage /></RequirePermission>}>
          <Route index element={<AssetsSummary />} />
          {/* Before :id, which would take "kinds" for an asset. */}
          <Route path="kinds" element={<AssetKindsPage />} />
          <Route path=":id" element={<AssetPage />} />
        </Route>
        <Route path="/dashboards" element={<RequirePermission need={PAGE_NEED.dashboards}><Suspense fallback={loading}><DashboardsPage /></Suspense></RequirePermission>} />
        <Route path="/dashboards/:id" element={<RequirePermission need={PAGE_NEED.dashboards}><Suspense fallback={loading}><DashboardPage /></Suspense></RequirePermission>} />
        <Route path="/billing" element={<RequirePermission need={PAGE_NEED.billing}><BillingPage /></RequirePermission>} />
        <Route path="/sources" element={<RequirePermission need={PAGE_NEED.sources}><SourcesPage /></RequirePermission>} />
        <Route path="/sources/:id/points" element={<RequirePermission need={PAGE_NEED.sourcePoints}><SourcePointsPage /></RequirePermission>} />
        <Route path="/scans" element={<RequirePermission need={PAGE_NEED.scans}><ScansPage /></RequirePermission>} />
        <Route path="/discovery" element={<RequirePermission need={PAGE_NEED.discovery}><Suspense fallback={loading}><DiscoveryPage /></Suspense></RequirePermission>} />
        <Route path="/users/:tab?" element={<RequirePermission need={PAGE_NEED.users}><UsersPage /></RequirePermission>} />
        <Route path="/settings" element={<RequirePermission need={PAGE_NEED.settings}><SettingsPage /></RequirePermission>} />
        <Route path="/tariffs" element={<RequirePermission need={PAGE_NEED.tariffs}><TariffsPage /></RequirePermission>} />
        <Route path="/storage" element={<RequirePermission need={PAGE_NEED.storage}><StoragePage /></RequirePermission>} />
        <Route path="/displays" element={<RequirePermission need={PAGE_NEED.displays}><DisplaysPage /></RequirePermission>} />
        <Route path="/audit/:id?" element={<RequirePermission need={PAGE_NEED.audit}><AuditPage /></RequirePermission>} />
        {/* One route for the list and for an event open in its drawer (like /audit/:id?), so opening the drawer does not mount the page again. */}
        <Route path="/events/:id?" element={<RequirePermission need={PAGE_NEED.events}><EventsPage /></RequirePermission>} />
        <Route path="/diagnostics" element={<RequirePermission need={PAGE_NEED.diagnostics}><DiagnosticsPage /></RequirePermission>} />
        <Route path="/password" element={<PasswordPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
