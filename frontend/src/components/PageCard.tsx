import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { InfoTip } from "./InfoTip";

/**
 * A titled card of a page: a head (a 32px icon tile, the h2, an optional one-line purpose under it and an optional tip at the right end),
 * the body (the children, straight in the card so a form can fill it) and an optional footer pinned to the card's bottom, so cards side by side
 * in a `.page-grid` keep their buttons level. The footer is for content that is not a form: a Save button belongs inside its own `<form>`.
 * The h2 is the structure: no aria-labelledby (it would be a second match for a field's label), `headingId` goes on the h2 for a form that
 * names itself by it. The head also carries `sect-head` and the purpose `sect-purpose`, the class names Tariffs' tests and e2e steps read.
 */
export function PageCard({ icon, title, purpose, tip, footer, headingId, className, children }: {
  icon: IconName;
  title: string;
  purpose?: ReactNode;
  tip?: ReactNode;
  footer?: ReactNode; // API for the next page: no page passes it today (every Save is inside its own form)
  headingId?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={className ? `page-card ${className}` : "page-card"}>
      <div className="page-card-head sect-head">
        <Icon name={icon} />
        <h2 id={headingId}>{title}</h2>
        {purpose ? <p className="sect-purpose muted">{purpose}</p> : null}
        {tip ? <span className="page-card-tip"><InfoTip>{tip}</InfoTip></span> : null}
      </div>
      {children}
      {footer ? <div className="page-card-foot">{footer}</div> : null}
    </section>
  );
}
