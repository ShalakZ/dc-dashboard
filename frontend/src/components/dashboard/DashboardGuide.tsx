import type { Ref } from "react";
import type { DataWidget, Widget } from "../../api/types";
import { isFollowing } from "../../lib/focus";

/** What a dashboard has that the guide could explain. Text widgets have none of it. */
export interface GuideFacts {
  /** A card sets this month so far against the same days of last month. */
  compares: boolean;
  /** A card shows the dashboard's focus asset, or its children. */
  follows: boolean;
  /** A card is a breakdown with one bar for each asset of a kind. */
  breaksDown: boolean;
}

export function guideFacts(widgets: readonly Widget[]): GuideFacts {
  const data = widgets.filter((w): w is DataWidget => w.type !== "text");
  return {
    compares: data.some((w) => w.config.compare !== undefined && w.config.compare !== "none"),
    follows: data.some((w) => isFollowing(w.config)),
    breaksDown: data.some((w) => w.config.bars === "kind"),
  };
}

/** The guide is offered on a dashboard that has at least one of the things it explains. */
export const guideApplies = (facts: GuideFacts): boolean => facts.compares || facts.follows || facts.breaksDown;

const COMPARE_LINE = "Energy and Cost cards set this month so far against the same days of last month.";
const FOCUS_LINE = "Focus picks the asset this dashboard follows; cards that follow it change when you change it.";
// What a click does is BarWidget's DrillBars: an asset that has children narrows the dashboard (only when a card follows the focus), any other opens its page.
const BAR_LINE_NARROW = "Click a bar of a breakdown: an asset with other assets inside it narrows the dashboard to it, and any other opens its page.";
const BAR_LINE_OPEN = "Click a bar of a breakdown to open that asset's page.";
// widgetFormat.markerHint: "~ estimated" and "* partial, some hours have no rate".
const MARKS_LINE = "~ means some of the figure is estimated. * means some hours have no rate, so a cost is incomplete.";
// WidgetFrame: the button "Details for <card>" (the (i)) and "Download CSV for <card>".
const BUTTONS_LINE = "The (i) button on a card (Details) shows how its figures were worked out; the download button saves them as a CSV file.";

/**
 * The lines the guide shows for this dashboard and this role: a line appears only when the dashboard has the thing it explains and the role can use it
 * (Focus and the bars' clicks need the Assets Tree, `allowed`). The last two are true of every card. Two to five lines.
 */
export function guideLines(facts: GuideFacts, allowed: boolean): string[] {
  const lines: string[] = [];
  if (facts.compares) lines.push(COMPARE_LINE);
  if (allowed && facts.follows) lines.push(FOCUS_LINE);
  if (allowed && facts.breaksDown) lines.push(facts.follows ? BAR_LINE_NARROW : BAR_LINE_OPEN);
  lines.push(MARKS_LINE, BUTTONS_LINE);
  return lines;
}

/**
 * The panel above the grid: "How to read this dashboard" with Got it at the right of the same row (w27 P1: the panel has no row of its own for the button), then
 * the lines. The heading takes the focus when someone opens the panel again from the header (`headingRef`, tabIndex -1); the viewer moves the focus away when Got it
 * is pressed, so it never falls to the page. Got it is the panel's only Tab stop, before the lines as it is before the cards.
 */
export function DashboardGuide({ lines, headingRef, onGotIt }: { lines: readonly string[]; headingRef: Ref<HTMLHeadingElement>; onGotIt: () => void }) {
  return (
    <div className="dash-guide">
      <div className="dash-guide-head">
        <h2 ref={headingRef} tabIndex={-1}>How to read this dashboard</h2>
        <button type="button" onClick={onGotIt}>Got it</button>
      </div>
      <ul>
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  );
}
