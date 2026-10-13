import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { AppShellSkeleton } from "../components/AppShellSkeleton";
import { Pending } from "../components/Pending";
import { ServerUnreachable } from "../components/ServerUnreachable";
import { TopProgress } from "../components/TopProgress";
import { RETURN_KEY, useAuth } from "./AuthProvider";
import { meets, type Need } from "./need";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, setupNeeded, signedOutOnPurpose, loading, unreachable } = useAuth();
  const location = useLocation();
  let body: ReactNode = children;
  // A <Navigate> renders nothing and changes the route in an effect, so the frame in between would be an empty page: the skeleton stays in it
  // (without Pending, which would start the bar for a page that is about to go).
  if (loading) {
    body = <><Pending /><AppShellSkeleton /></>;
  } else if (unreachable) {
    // No answer is not "signed out": nothing is redirected and nothing is remembered, so the page asked for opens as soon as the server answers.
    body = <ServerUnreachable />;
  } else if (setupNeeded) {
    body = <><AppShellSkeleton /><Navigate to="/setup" replace /></>;
  } else if (!user) {
    // An explicit sign-out leaves nothing behind (the next sign-in lands on /); a lost session remembers where it was.
    if (!signedOutOnPurpose) sessionStorage.setItem(RETURN_KEY, location.pathname + location.search);
    body = <><AppShellSkeleton /><Navigate to="/login" replace /></>;
  }
  // The one loading bar lives here, above whatever is shown, so the same element carries on from the sign-in check into the shell.
  return <><TopProgress />{body}</>;
}

/**
 * Client-side guard for routes that need permissions, so a direct visit shows a short notice, not an API error. `need` is one permission,
 * or an array that means ALL OF them. It sits inside RequireAuth, so by the time it renders the user is known: no flash of the page.
 */
export function RequirePermission({ need, children }: { need: Need; children: ReactNode }) {
  const { can } = useAuth();
  if (!meets(need, can)) {
    return (
      <section>
        <h1>No access</h1>
        <p className="muted">Your role does not include this page.</p>
      </section>
    );
  }
  return <>{children}</>;
}
