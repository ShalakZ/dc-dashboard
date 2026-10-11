import { useCallback, useEffect, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { Role } from "../api/types";
import { initialSidebar, saveSidebar, type SidebarState } from "../lib/sidebarState";
import { CertificateNotice } from "./CertificateNotice";
import { Icon, ICONS, type IconName } from "./Icon";
import { RoleChangedNotice } from "./RoleChangedNotice";

// Billing's day columns and a dashboard on a wall screen use the whole window; every other page keeps the 1200 px column.
const WIDE = /^\/(billing|dashboards\/[^/]+)\/?$/;

/** The role written out under the user's name. */
export const ROLE_LABEL: Record<Role, string> = { admin: "Administrator", operator: "Operator", viewer: "Viewer" };

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
