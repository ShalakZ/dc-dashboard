import { Link } from "react-router";
import { Icon, type IconName } from "./Icon";

export interface Crumb { label: string; to?: string; icon?: IconName } // no `to` = plain text; no `icon` = text only

/**
 * The breadcrumb trail: every crumb but the last with a `to` is a link, the last is the current page (text, aria-current).
 * An empty trail renders nothing. The separator is decoration, so it is hidden from assistive technology; it leads every crumb but the
 * first, inside the same item, so a wrapping trail carries it to the new line with its crumb instead of leaving it dangling at a line end.
 * A crumb with an `icon` draws it INSIDE its link (or its current-page span), before the label: the icon is decoration (aria-hidden), so
 * the link's name and text are the label alone, and the CSS keeps the row as tall as a trail without icons.
 */
export function Crumbs({ trail }: { trail: readonly Crumb[] }) {
  if (trail.length === 0) return null;
  const last = trail.length - 1;
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        {trail.map((crumb, i) => {
          const mark = crumb.icon ? <span className="crumb-icon" aria-hidden="true"><Icon name={crumb.icon} /></span> : null;
          const cls = crumb.icon ? "with-icon" : undefined;
          return (
            <li key={i}>
              {i > 0 ? <span className="sep" aria-hidden="true">/</span> : null}
              {i === last ? (
                <span aria-current="page" className={cls}>{mark}{crumb.label}</span>
              ) : crumb.to ? (
                <Link to={crumb.to} className={cls}>{mark}{crumb.label}</Link>
              ) : (
                <span className={cls}>{mark}{crumb.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
