import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { RETURN_KEY, useAuth } from "./AuthProvider";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, setupNeeded, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="muted">loading…</p>;
  if (setupNeeded) return <Navigate to="/setup" replace />;
  if (!user) {
    sessionStorage.setItem(RETURN_KEY, location.pathname + location.search);
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
