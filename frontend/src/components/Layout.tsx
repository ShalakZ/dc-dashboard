import { useCallback, useEffect, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import { NavLink, Outlet } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { initialSidebar, saveSidebar, type SidebarState } from "../lib/sidebarState";
import { CertificateNotice } from "./CertificateNotice";
import { Icon, ICONS } from "./Icon";
import { GROUPS } from "./navItems";
import { ProfileMenu } from "./ProfileMenu";
import { QuickFind } from "./QuickFind";
import { RoleChangedNotice } from "./RoleChangedNotice";
import { SiteClock } from "./SiteClock";
import { StatusChip } from "./StatusChip";

export { ROLE_LABEL } from "./navItems";

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
  const { hasRole } = useAuth();
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
        <header className="navbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24">{ICONS.brand}</svg></span>
            <span className="lbl">DC Dashboard</span>
          </div>
          <div className="bar-in">
            <QuickFind />
            <span className="grow" />
            <StatusChip />
            <span className="vr" aria-hidden="true" />
            <SiteClock />
            <span className="vr" aria-hidden="true" />
            <ProfileMenu />
          </div>
        </header>
        <div className="frame">
          <div className="side" id="sidebar">
            <nav aria-label="Main">
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
          <main id="main" tabIndex={-1}>
            <div className="shell-notices">
              <RoleChangedNotice />
              {hasRole("admin") && <CertificateNotice />}
            </div>
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}
