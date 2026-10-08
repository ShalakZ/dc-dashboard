import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { RequireAuth, RequireRole } from "./auth/RequireAuth";
import { Layout } from "./components/Layout";
import { AssetPage } from "./pages/AssetPage";
import { AssetsPage } from "./pages/AssetsPage";
import { AuditPage } from "./pages/AuditPage";
import { BillingPage } from "./pages/BillingPage";
import { DiscoveryPage } from "./pages/DiscoveryPage";
import { LoginPage } from "./pages/LoginPage";
import { PasswordPage } from "./pages/PasswordPage";
import { ScansPage } from "./pages/ScansPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { SourcePointsPage } from "./pages/SourcePointsPage";
import { SourcesPage } from "./pages/SourcesPage";
import { StoragePage } from "./pages/StoragePage";
import { TariffsPage } from "./pages/TariffsPage";
import { UsersPage } from "./pages/UsersPage";

// These pages pull in react-grid-layout and ECharts, so they load only when visited.
const DashboardsPage = lazy(() => import("./pages/DashboardsPage").then((m) => ({ default: m.DashboardsPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const loading = <p className="muted">loading…</p>;

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route path="/" element={<Navigate to="/assets" replace />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/assets/:id" element={<AssetPage />} />
        <Route path="/dashboards" element={<Suspense fallback={loading}><DashboardsPage /></Suspense>} />
        <Route path="/dashboards/:id" element={<Suspense fallback={loading}><DashboardPage /></Suspense>} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/sources" element={<SourcesPage />} />
        <Route path="/sources/:id/points" element={<SourcePointsPage />} />
        <Route path="/scans" element={<RequireRole min="operator"><ScansPage /></RequireRole>} />
        <Route path="/discovery" element={<RequireRole min="operator"><DiscoveryPage /></RequireRole>} />
        <Route path="/users" element={<RequireRole min="admin"><UsersPage /></RequireRole>} />
        <Route path="/settings" element={<RequireRole min="admin"><SettingsPage /></RequireRole>} />
        <Route path="/tariffs" element={<RequireRole min="admin"><TariffsPage /></RequireRole>} />
        <Route path="/storage" element={<RequireRole min="admin"><StoragePage /></RequireRole>} />
        <Route path="/audit" element={<RequireRole min="admin"><AuditPage /></RequireRole>} />
        <Route path="/password" element={<PasswordPage />} />
      </Route>
    </Routes>
  );
}
