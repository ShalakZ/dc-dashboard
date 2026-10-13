import { useAuth } from "../auth/AuthProvider";
import { roleLabel } from "./navItems";

/**
 * Shown when an admin changed this person's role, or what the role allows, while the page was open. The page keeps the access it loaded
 * with (so nothing under an open editor moves); a reload picks up the new one, instead of the user meeting 403 errors one request at a time.
 */
export function RoleChangedNotice() {
  const { accessChange } = useAuth();
  if (!accessChange) return null;
  const text = accessChange.from === accessChange.to
    ? "Your access changed. Reload to see what you can use now."
    : `Your role changed from ${roleLabel(accessChange.from)} to ${roleLabel(accessChange.to)}. Reload the page to continue.`;
  return (
    <div role="status" className="banner banner-warn warning">
      <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
      <span>{text}</span>
      <button type="button" className="b-act" onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}
