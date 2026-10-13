import type { ReactNode, Ref } from "react";
import { Crumbs, type Crumb } from "./Crumbs";
import { Icon, type IconName } from "./Icon";

/**
 * The top of a page: an optional breadcrumb trail, the page's ONE h1, an optional sub line and an actions slot on the right.
 * The parts are direct children of the header because the CSS grid places them. The trail is the page's one
 * `nav[aria-label="Breadcrumb"]`; the sidebar is `nav[aria-label="Main"]`. With an `icon` the h1 sits in a `.page-title` next to a tile
 * holding the icon (decoration: the title is still the heading's whole name); without one the h1 is a direct child as before.
 * `headingRef`: a page that moves the keyboard focus to its heading (after a delete took the focused button away) passes a ref; the h1 is then
 * focusable by script only (tabIndex -1), and unchanged without one.
 */
export function PageHeader({ title, crumbs, sub, actions, icon, headingRef }: { title: string; crumbs?: readonly Crumb[]; sub?: ReactNode; actions?: ReactNode; icon?: IconName; headingRef?: Ref<HTMLHeadingElement> }) {
  const heading = <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>{title}</h1>;
  return (
    <header className="page-head">
      {crumbs ? <Crumbs trail={crumbs} /> : null}
      {icon ? (
        <div className="page-title">
          <span className="page-tile"><Icon name={icon} /></span>
          {heading}
        </div>
      ) : (
        heading
      )}
      {sub ? <p className="sub">{sub}</p> : null}
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}
