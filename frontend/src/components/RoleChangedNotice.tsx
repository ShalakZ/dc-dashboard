import { useAuth } from "../auth/AuthProvider";

/**
 * Shown when an admin changed this person's role while the page was open. The page keeps the role it loaded with (so nothing
 * under an open editor moves); a reload picks up the new one, instead of the user meeting 403 errors one request at a time.
 */
export function RoleChangedNotice() {
  const { roleChange } = useAuth();
  if (!roleChange) return null;
  return (
    <div role="status" className="banner banner-warn warning">
      <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
      <span>{`Your role changed from ${roleChange.from} to ${roleChange.to}. Reload the page to continue.`}</span>
      <button type="button" className="b-act" onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}
