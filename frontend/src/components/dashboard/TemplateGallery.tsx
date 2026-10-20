import { useEffect, useId, useRef, type ReactNode } from "react";
import type { DashboardTemplate, DashboardTemplates, TemplateId, TemplateWidget } from "../../api/types";
import { TemplatePreview } from "./TemplatePreview";

/** What a card stands for: a server template, or Blank (the client's own card: an empty dashboard that opens in edit mode). */
export type TemplateChoice = TemplateId | "blank";

/** The card every gallery ends with. Its range is what a blank dashboard has always started with. */
export const BLANK_TEMPLATE = {
  id: "blank", title: "Blank", description: "An empty dashboard. Add the widgets yourself.", range: "24h", recommended: false, needs: null, widgets: [] as TemplateWidget[],
} as const;

export const NOTHING_METERED = "Nothing is metered yet, so every template shows no data until a meter is mapped.";
export const LOADING_TEMPLATES = "Loading templates…";
export const TEMPLATES_FAILED = "The templates could not be loaded. A blank dashboard still works.";

type Card = DashboardTemplate | typeof BLANK_TEMPLATE;

function TemplateCard({ card, onPick, register }: { card: Card; onPick: (choice: TemplateChoice) => void; register: (id: string, element: HTMLButtonElement | null) => void }) {
  const titleId = useId();
  const descId = useId();
  const needsId = useId();
  // Named by the title alone and described by the line (and what it needs): the tag is not part of the name, so "Power" stays "Power" with or without it.
  return (
    <li>
      <button
        type="button" className="tpl-card" data-template={card.id} ref={(element) => register(card.id, element)}
        aria-labelledby={titleId} aria-describedby={card.needs ? `${descId} ${needsId}` : descId} onClick={() => onPick(card.id)}
      >
        <TemplatePreview widgets={card.widgets} />
        <span className="tpl-text">
          <span className="tpl-title-row">
            <span className="tpl-title" id={titleId}>{card.title}</span>
            {card.recommended && <span className="tpl-tag">Recommended</span>}
          </span>
          <span className="tpl-desc" id={descId}>{card.description}</span>
          {card.needs && <span className="tpl-needs" id={needsId}>{card.needs}</span>}
        </span>
      </button>
    </li>
  );
}

/**
 * The cards of the New dashboard dialog's first step, and of the empty Dashboards page (w27): a row "Recommended for this site" (only what the server
 * recommends), then "More templates", Blank last and never recommended. A card is a button: Tab goes through them, Enter and Space pick one (`onPick`).
 * While the list loads or has failed, Blank alone is offered with one plain sentence, so the dialog is never a dead end.
 * `focusChoice` is the card that takes the focus when the gallery appears (Back to templates returns to the one that was chosen); without it nothing is
 * focused. `level` is the heading level of the two row titles (2 on the page, 4 inside the dialog under its step title).
 */
export function TemplateGallery({ data, error, onPick, focusChoice = null, level = 2 }: {
  data: DashboardTemplates | undefined; error: Error | null; onPick: (choice: TemplateChoice) => void; focusChoice?: TemplateChoice | null; level?: 2 | 4;
}) {
  const recommendedId = useId();
  const moreId = useId();
  const cards = useRef(new Map<string, HTMLButtonElement>());
  const register = (id: string, element: HTMLButtonElement | null) => {
    if (element) cards.current.set(id, element);
    else cards.current.delete(id);
  };
  useEffect(() => {
    if (focusChoice === null) return;
    (cards.current.get(focusChoice) ?? cards.current.values().next().value)?.focus();
  }, []); // once, when the gallery appears

  const Heading = `h${level}` as "h2" | "h4";
  const templates = data?.templates ?? [];
  const recommended = templates.filter((t) => t.recommended);
  const more: Card[] = [...templates.filter((t) => !t.recommended), BLANK_TEMPLATE];
  const status: ReactNode = data
    ? data.nothing_metered ? <p className="muted tpl-status">{NOTHING_METERED}</p> : null
    : error ? <p className="error tpl-status" role="alert" title={error.message}>{TEMPLATES_FAILED}</p> : <p className="muted tpl-status">{LOADING_TEMPLATES}</p>;
  return (
    <div className="tpl-gallery">
      {status}
      {recommended.length > 0 && (
        <section aria-labelledby={recommendedId}>
          <Heading id={recommendedId} className="tpl-heading">Recommended for this site</Heading>
          <ul className="tpl-cards">{recommended.map((t) => <TemplateCard key={t.id} card={t} onPick={onPick} register={register} />)}</ul>
        </section>
      )}
      <section aria-labelledby={moreId}>
        <Heading id={moreId} className="tpl-heading">More templates</Heading>
        <ul className="tpl-cards">{more.map((t) => <TemplateCard key={t.id} card={t} onPick={onPick} register={register} />)}</ul>
      </section>
    </div>
  );
}
