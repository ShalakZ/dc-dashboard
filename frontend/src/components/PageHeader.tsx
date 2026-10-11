import type { ReactNode } from "react";
import { Crumbs, type Crumb } from "./Crumbs";

/**
 * The top of a page: an optional breadcrumb trail, the page's ONE h1, an optional sub line and an actions slot on the right.
 * The parts are direct children of the header because the CSS grid places them. The trail is the page's one
 * `nav[aria-label="Breadcrumb"]`; the sidebar is `nav[aria-label="Main"]`.
 */
export function PageHeader({ title, crumbs, sub, actions }: { title: string; crumbs?: readonly Crumb[]; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      {crumbs ? <Crumbs trail={crumbs} /> : null}
      <h1>{title}</h1>
      {sub ? <p className="sub">{sub}</p> : null}
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}
