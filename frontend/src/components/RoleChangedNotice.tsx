import { useAuth } from "../auth/AuthProvider";

/**
 * Shown when an admin changed this person's role while the page was open. The page keeps the role it loaded with (so nothing
 * under an open editor moves); a reload picks up the new one, instead of the user meeting 403 errors one request at a time.
 */
export function RoleChangedNotice() {
  const { roleChange } = useAuth();
  if (!roleChange) return null;
  return (
    <p role="status" className="warning">
      {`Your role changed from ${roleChange.from} to ${roleChange.to}. Reload the page to continue.`}{" "}
      <button type="button" onClick={() => window.location.reload()}>Reload</button>
    </p>
  );
}
