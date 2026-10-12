import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import type { Role } from "../api/types";
import { RETURN_KEY, useAuth } from "./AuthProvider";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, setupNeeded, signedOutOnPurpose, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="muted">loading…</p>;
  if (setupNeeded) return <Navigate to="/setup" replace />;
  if (!user) {
    // An explicit sign-out leaves nothing behind (the next sign-in lands on /); a lost session remembers where it was.
    if (!signedOutOnPurpose) sessionStorage.setItem(RETURN_KEY, location.pathname + location.search);
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

/** Client-side guard for role-restricted routes, so a direct visit shows a short notice, not an API error. */
export function RequireRole({ min, children }: { min: Role; children: ReactNode }) {
  const { hasRole } = useAuth();
  if (!hasRole(min)) {
    return (
      <section>
        <h1>{min === "admin" ? "Admins only" : "Operators only"}</h1>
        <p className="muted">Your account does not have access to this page.</p>
      </section>
    );
  }
  return <>{children}</>;
}
