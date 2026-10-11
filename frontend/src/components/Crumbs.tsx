import { Link } from "react-router";

export interface Crumb { label: string; to?: string } // no `to` = plain text

/**
 * The breadcrumb trail: every crumb but the last with a `to` is a link, the last is the current page (text, aria-current).
 * An empty trail renders nothing. The separator is decoration, so it is hidden from assistive technology.
 */
export function Crumbs({ trail }: { trail: readonly Crumb[] }) {
  if (trail.length === 0) return null;
  const last = trail.length - 1;
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        {trail.map((crumb, i) => (
          <li key={i}>
            {i === last ? <span aria-current="page">{crumb.label}</span> : crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
            {i < last ? <span className="sep" aria-hidden="true">/</span> : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
