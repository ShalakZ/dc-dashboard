import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./app.css";
import { AuthProvider } from "./auth/AuthProvider";
import { RequireAuth, RequireRole } from "./auth/RequireAuth";
import { Layout } from "./components/Layout";
import { AssetPage } from "./pages/AssetPage";
import { AssetsPage } from "./pages/AssetsPage";
import { LoginPage } from "./pages/LoginPage";
import { PasswordPage } from "./pages/PasswordPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { SourcePointsPage } from "./pages/SourcePointsPage";
import { SourcesPage } from "./pages/SourcesPage";
import { StoragePage } from "./pages/StoragePage";
import { UsersPage } from "./pages/UsersPage";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route path="/" element={<Navigate to="/assets" replace />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/assets/:id" element={<AssetPage />} />
        <Route path="/sources" element={<SourcesPage />} />
        <Route path="/sources/:id/points" element={<SourcePointsPage />} />
        <Route path="/users" element={<RequireRole min="admin"><UsersPage /></RequireRole>} />
        <Route path="/settings" element={<RequireRole min="admin"><SettingsPage /></RequireRole>} />
        <Route path="/storage" element={<RequireRole min="admin"><StoragePage /></RequireRole>} />
        <Route path="/password" element={<PasswordPage />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
