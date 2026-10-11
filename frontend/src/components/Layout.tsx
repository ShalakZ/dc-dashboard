import { useCallback, useEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { Role } from "../api/types";
import { initialSidebar, saveSidebar, type SidebarState } from "../lib/sidebarState";
import { CertificateNotice } from "./CertificateNotice";
import { RoleChangedNotice } from "./RoleChangedNotice";

// Billing's day columns and a dashboard on a wall screen use the whole window; every other page keeps the 1200 px column.
const WIDE = /^\/(billing|dashboards\/[^/]+)\/?$/;

/** The role written out under the user's name. */
export const ROLE_LABEL: Record<Role, string> = { admin: "Administrator", operator: "Operator", viewer: "Viewer" };

// Inline SVG, 24-unit viewBox, drawn with the 1.7 stroke of `svg.i`; always decorative (the label next to it is the name).
const ICONS = {
  brand: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  assets: <><path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" /><path d="m3 12 9 4.5 9-4.5" /><path d="m3 16.5 9 4.5 9-4.5" /></>,
  dashboards: <><rect x="3" y="3" width="7.5" height="9" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="5" rx="1.5" /><rect x="13.5" y="11" width="7.5" height="10" rx="1.5" /><rect x="3" y="15" width="7.5" height="6" rx="1.5" /></>,
  billing: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  sources: <><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" /><path d="M12 17v4" /></>,
  scans: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M11 7v4l2.5 2" /></>,
  discovery: <><circle cx="5" cy="12" r="2.2" /><circle cx="19" cy="5" r="2.2" /><circle cx="19" cy="19" r="2.2" /><path d="M7 11 17 6M7 13l10 5" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></>,
  settings: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  tariffs: <><path d="M3 12V4h8l10 10-8 8L3 12Z" /><circle cx="7.5" cy="8.5" r="1.5" /></>,
  storage: <><ellipse cx="12" cy="5.5" rx="8" ry="2.5" /><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13" /><path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" /></>,
  audit: <><path d="M9 4h10v16H5V8" /><path d="M9 4 5 8h4V4Z" /><path d="M9 13l2 2 4-4" /></>,
  password: <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M15 8l2 2" /></>,
  signOut: <><path d="M14 4h5v16h-5" /><path d="M10 8l-4 4 4 4M6 12h10" /></>,
  collapse: <><path d="M4 4v16" /><path d="m15 7-5 5 5 5" /><path d="M10 12h10" /></>,
} satisfies Record<string, ReactNode>;
type IconName = keyof typeof ICONS;

function Icon({ name }: { name: IconName }) {
  return <svg className="i" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>;
}

interface NavItem { to: string; label: string; icon: IconName }
interface NavGroup { id: string; title: string; min?: Role; items: NavItem[] }

// Role gating is the old bar's, link for link; a group whose links are all gated away is not rendered.
const GROUPS: NavGroup[] = [
  {
    id: "nav-monitor", title: "Monitor",
    items: [
      { to: "/assets", label: "Assets", icon: "assets" },
      { to: "/dashboards", label: "Dashboards", icon: "dashboards" },
      { to: "/billing", label: "Billing", icon: "billing" },
    ],
  },
  {
    id: "nav-operate", title: "Operate", min: "operator",
    items: [
      { to: "/sources", label: "Sources", icon: "sources" },
      { to: "/scans", label: "Scans", icon: "scans" },
      { to: "/discovery", label: "Discovery", icon: "discovery" },
    ],
  },
  {
    id: "nav-administer", title: "Administer", min: "admin",
    items: [
      { to: "/users", label: "Users", icon: "users" },
      { to: "/settings", label: "Settings", icon: "settings" },
      { to: "/tariffs", label: "Tariffs", icon: "tariffs" },
      { to: "/storage", label: "Storage", icon: "storage" },
      { to: "/audit", label: "Audit", icon: "audit" },
    ],
  },
];

interface Tip { text: string; sub?: string; top: number }
/** The pointer crosses the gap between a row and its tip inside this time, so the tip can be hovered (WCAG 1.4.13). */
const TIP_HIDE_MS = 150;

/**
 * The one shared tooltip of the minimized sidebar. It is a fixed-position element placed by the row's rectangle, not a
 * CSS-revealed label, because the rail scrolls (overflow clips an absolutely positioned label).
 */
function useSideTip(active: boolean) {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipRow = useRef<HTMLElement | null>(null); // the row the tip belongs to
  const cancelHide = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const hide = useCallback(() => {
    cancelHide();
    setTip(null);
  }, [cancelHide]);
  const hideSoon = useCallback(() => {
    cancelHide();
    timer.current = setTimeout(() => {
      timer.current = null;
      setTip(null);
    }, TIP_HIDE_MS);
  }, [cancelHide]);

  useEffect(() => { if (!active) hide(); }, [active, hide]); // expanding again drops it
  useEffect(() => cancelHide, [cancelHide]); // and so does leaving the page

  // Escape dismisses it without moving the pointer or the focus. The key is not consumed: a dialog may want it too.
  const open = tip !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, hide]);

  const centre = (row: HTMLElement) => {
    const rect = row.getBoundingClientRect();
    return rect.top + rect.height / 2;
  };
  const show = (row: HTMLElement, text: string, sub?: string) => {
    if (!active || !text) return;
    cancelHide();
    tipRow.current = row;
    setTip({ text, sub, top: centre(row) });
  };
  /** The rail scrolled. A focused row that the browser scrolled into view keeps its tip, which follows it; any other tip goes. */
  const scrolled = () => {
    const row = tipRow.current;
    if (row && row === document.activeElement) setTip((current) => current && { ...current, top: centre(row) });
    else hide();
  };
  /** Pointer and focus handlers for one row whose label is `text`. */
  const bind = (text: string, sub?: string) => ({
    onPointerEnter: (event: PointerEvent<HTMLElement>) => show(event.currentTarget, text, sub),
    onFocus: (event: FocusEvent<HTMLElement>) => show(event.currentTarget, text, sub),
    onPointerLeave: hideSoon,
    onBlur: hide,
  });
  return { tip, bind, scrolled, keep: cancelHide, leave: hideSoon };
}

export function Layout() {
  const { user, hasRole, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [sidebar, setSidebar] = useState<SidebarState>(initialSidebar);
  const minimized = sidebar === "minimized";
  const { tip, bind, scrolled, keep, leave } = useSideTip(minimized);
  const shellRef = useRef<HTMLDivElement>(null);

  // The width transition starts one frame after the first paint, so a remembered state does not animate in.
  useEffect(() => {
    const frame = requestAnimationFrame(() => shellRef.current?.classList.add("ready"));
    return () => cancelAnimationFrame(frame);
  }, []);

  const toggle = () => {
    const next: SidebarState = minimized ? "expanded" : "minimized";
    setSidebar(next);
    saveSidebar(next); // only a click is remembered; a narrow window's automatic start is not the user's choice
  };
  const toggleLabel = minimized ? "Expand sidebar" : "Minimize sidebar";
  const name = user?.username ?? "";
  const role = user ? ROLE_LABEL[user.role] ?? user.role : "";

  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault(); // a hash in the URL would be one more history entry
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <div className="shell" data-sidebar={sidebar} ref={shellRef}>
        <div className="side" id="sidebar">
          <nav aria-label="Main">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24">{ICONS.brand}</svg></span>
              <span className="lbl">DC Dashboard</span>
            </div>
            <div className="nav-groups" onScroll={scrolled}>
              {GROUPS.filter((group) => !group.min || hasRole(group.min)).map((group) => (
                <div className="nav-group" role="group" aria-labelledby={group.id} key={group.id}>
                  <span className="nav-heading" id={group.id}>{group.title}</span>
                  {group.items.map((item) => (
                    <NavLink to={item.to} className="side-row" key={item.to} {...bind(item.label)}>
                      <Icon name={item.icon} />
                      <span className="lbl">{item.label}</span>
                    </NavLink>
                  ))}
                </div>
              ))}
            </div>
            <div className="side-foot">
              <div className="who" {...bind(name, role)}>
                <span className="avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
                <span className="lbl">
                  <span className="who-name" title={name}>{name}</span>
                  <span className="who-role">{role}</span>
                </span>
              </div>
              <NavLink to="/password" className="side-row" {...bind("Password")}>
                <Icon name="password" />
                <span className="lbl">Password</span>
              </NavLink>
              <button type="button" className="side-row" onClick={() => logout().then(() => navigate("/login"))} {...bind("Sign out")}>
                <Icon name="signOut" />
                <span className="lbl">Sign out</span>
              </button>
              <button type="button" className="side-row side-toggle" onClick={toggle} {...bind(toggleLabel)}>
                <Icon name="collapse" />
                <span className="lbl">{toggleLabel}</span>
              </button>
            </div>
          </nav>
          <div
            className="side-tip"
            id="side-tip"
            role="tooltip"
            aria-hidden="true"
            hidden={!tip}
            style={tip ? { top: tip.top } : undefined}
            onPointerEnter={keep}
            onPointerLeave={leave}
          >
            {tip && (
              <>
                <span className="side-tip-text">{tip.text}</span>
                {tip.sub && <span className="side-tip-sub">{tip.sub}</span>}
              </>
            )}
          </div>
        </div>
        <main id="main" tabIndex={-1} className={WIDE.test(pathname) ? "wide" : undefined}>
          <div className="shell-notices">
            <RoleChangedNotice />
            {hasRole("admin") && <CertificateNotice />}
          </div>
          <Outlet />
        </main>
      </div>
    </>
  );
}
