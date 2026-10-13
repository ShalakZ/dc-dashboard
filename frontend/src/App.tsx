import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { useDefaultDashboard } from "./api/queries";
import { RequireAuth, RequireRole } from "./auth/RequireAuth";
import { Layout } from "./components/Layout";
import { Pending } from "./components/Pending";
import { PageSkeleton } from "./components/Skeleton";
import { AssetPage } from "./pages/AssetPage";
import { AssetsPage } from "./pages/AssetsPage";
import { AssetsSummary } from "./pages/AssetsSummary";
import { AuditEntryPage } from "./pages/AuditEntryPage";
import { AuditPage } from "./pages/AuditPage";
import { BillingPage } from "./pages/BillingPage";
import { DiagnosticsPage } from "./pages/DiagnosticsPage";
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

/** `/`: the default dashboard when one is set, else Assets Tree. Waits for the answer, so Assets Tree is not shown first; an error falls back to Assets Tree. */
function HomeRedirect() {
  const { data, isPending } = useDefaultDashboard();
  if (isPending) return loading;
  return <Navigate to={data?.dashboard_id ? `/dashboards/${data.dashboard_id}` : "/assets"} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/assets" element={<AssetsPage />}>
          <Route index element={<AssetsSummary />} />
          <Route path=":id" element={<AssetPage />} />
        </Route>
        <Route path="/dashboards" element={<Suspense fallback={loading}><DashboardsPage /></Suspense>} />
        <Route path="/dashboards/:id" element={<Suspense fallback={loading}><DashboardPage /></Suspense>} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/sources" element={<RequireRole min="operator"><SourcesPage /></RequireRole>} />
        <Route path="/sources/:id/points" element={<RequireRole min="admin"><SourcePointsPage /></RequireRole>} />
        <Route path="/scans" element={<RequireRole min="operator"><ScansPage /></RequireRole>} />
        <Route path="/discovery" element={<RequireRole min="operator"><Suspense fallback={loading}><DiscoveryPage /></Suspense></RequireRole>} />
        <Route path="/users" element={<RequireRole min="admin"><UsersPage /></RequireRole>} />
        <Route path="/settings" element={<RequireRole min="admin"><SettingsPage /></RequireRole>} />
        <Route path="/tariffs" element={<RequireRole min="admin"><TariffsPage /></RequireRole>} />
        <Route path="/storage" element={<RequireRole min="admin"><StoragePage /></RequireRole>} />
        <Route path="/audit" element={<RequireRole min="admin"><AuditPage /></RequireRole>} />
        <Route path="/audit/:id" element={<RequireRole min="admin"><AuditEntryPage /></RequireRole>} />
        <Route path="/diagnostics" element={<RequireRole min="admin"><DiagnosticsPage /></RequireRole>} />
        <Route path="/password" element={<PasswordPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
