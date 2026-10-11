import type { ReactNode } from "react";

/**
 * The top of a page: optional crumbs, the page's ONE h1, an optional sub line and an actions slot on the right.
 * The parts are direct children of the header because the CSS grid places them. Crumbs are a `p`, never a `nav` (the sidebar is
 * the only navigation landmark), and a crumb link must not carry the name of a sidebar link.
 */
export function PageHeader({ title, crumbs, sub, actions }: { title: string; crumbs?: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      {crumbs ? <p className="crumbs">{crumbs}</p> : null}
      <h1>{title}</h1>
      {sub ? <p className="sub">{sub}</p> : null}
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}
