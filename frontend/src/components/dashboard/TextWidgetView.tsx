import type { ReactNode } from "react";
import type { TextConfig } from "../../api/types";
import { WidgetFrame } from "./WidgetFrame";

interface Props {
  title: string;
  config: TextConfig;
  /** The editor's Edit and Delete buttons. Given = edit mode: the card has the data cards' header (the drag handle) and its title. */
  actions?: ReactNode;
  dragHandle?: boolean;
}

/**
 * A text widget: a heading, a paragraph or a divider. It holds no data, so no hook of the data path is used here and nothing is
 * fetched or registered for the live values. The text is a React text child: never HTML, markdown or a link.
 * View mode draws the content alone (no title bar; the title only names the card for a screen reader and the editor's buttons);
 * edit mode draws it inside the same WidgetFrame as a data card, so the grip, the title, Edit and Delete are the cards' own.
 */
export function TextWidgetView({ title, config, actions, dragHandle }: Props) {
  const { style, text } = config;
  if (!actions) {
    // A heading is its own outline entry (an h2 like a card title) and a divider is a separator: neither is a named region.
    if (style === "heading") return <div className="widget-frame widget-text" data-style="heading"><h2 className="widget-text-heading">{text}</h2></div>;
    if (style === "paragraph") {
      return <section className="widget-frame widget-text" data-style="paragraph" aria-label={title}><p className="widget-text-paragraph">{text}</p></section>;
    }
    return <div className="widget-text" data-style="divider"><hr className="widget-text-rule" /></div>;
  }
  // The header's title is the card's h2, so the heading text is a styled div here: never a second h2 in one card.
  return (
    <WidgetFrame title={title} actions={actions} dragHandle={dragHandle} loading={false} error={null} missing={0}>
      <div className="widget-text-body" data-style={style}>
        {style === "heading" && <div className="widget-text-heading">{text}</div>}
        {style === "paragraph" && <p className="widget-text-paragraph">{text}</p>}
        {style === "divider" && <hr className="widget-text-rule" />}
      </div>
    </WidgetFrame>
  );
}
