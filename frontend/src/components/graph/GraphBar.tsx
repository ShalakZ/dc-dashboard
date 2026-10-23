import { useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { countNumber } from "../../lib/graph";
import type { ActionState, GraphCounts } from "../../lib/graphView";
import { Icon, type IconName } from "../Icon";
import { BarMenu, type BarMenuItem } from "./BarMenu";
import { FindButton } from "./FindButton";

const ok: ActionState = { enabled: true };

/** One count of the graph, drawn as decoration: the sentence beside it (`.graph-summary`) is what is announced. */
function Chip({ icon, num, word, tone }: { icon: IconName; num: string; word: string; tone?: "warn" }) {
  return (
    <span className={tone ? `gbar-chip gbar-chip-${tone}` : "gbar-chip"} title={`${num} ${word}`} aria-hidden="true">
      <Icon name={icon} />
      <span className="gbar-chip-num">{num}</span>
      <span className="gbar-chip-word">{word}</span>
    </span>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Whether the bar's own copy of a control is not drawn (its stylesheet has taken it out for lack of room): the CSS decides, the menu asks. */
const notDrawn = (el: HTMLElement | null) => el !== null && getComputedStyle(el).display === "none";

/**
 * The bar above the Discovery canvas, left to right: chips (what the graph holds), View controls (Collapse all, Expand all, each with a chevron
 * menu for the selection and the branch, the Unmapped only switch, Tidy layout), Canvas controls (Find, Snap to grid) and Page controls
 * (Refresh, the shortcuts bubble the page hands in, and an overflow menu). It is 36px tall in every state and its width tiers are CSS
 * container queries (discovery-tidy.css): the wide chips (a credentials chip, or a four-digit count: the row has `gbar-chips-wide`) shrink to icon and
 * number first, then the controls lose their words ONE AT A TIME (Snap to grid, Find, Tidy layout, Unmapped only, then Collapse all and Expand all
 * together; each word has its own `gbar-lbl-*` class, and the word stays in the accessibility tree, visually hidden, with the control's `title`), then
 * the normal chips shrink too, and below that Unmapped only, Tidy layout and Snap to grid leave the bar and are offered in the overflow menu.
 *
 * The one announcer of the area is the summary sentence (visually hidden, `aria-live`); the chips are decoration. A button with nothing to do
 * keeps its place and says so (`aria-disabled` and a click guard, never `disabled`: it may hold the focus the click gave it).
 */
export function GraphBar({
  summary, counts, collapsible, expandable, tidying, unmappedOnly, onUnmappedOnly, onCollapseAll, onExpandAll, onTidy,
  expandSelection, collapseSelection, expandBranch, collapseBranch,
  onExpandSelection, onCollapseSelection, onExpandBranch, onCollapseBranch,
  snap, onSnap, find, onRefresh, refreshRef, clear, notSeen, shortcuts, onFindKey,
}: {
  summary: string;
  counts: GraphCounts;
  collapsible: boolean;
  expandable: boolean;
  tidying: boolean;
  unmappedOnly: boolean;
  onUnmappedOnly: (on: boolean) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onTidy: () => void;
  expandSelection: ActionState;
  collapseSelection: ActionState;
  expandBranch: ActionState;
  collapseBranch: ActionState;
  onExpandSelection: () => void;
  onCollapseSelection: () => void;
  onExpandBranch: () => void;
  onCollapseBranch: () => void;
  snap: boolean;
  onSnap: (on: boolean) => void;
  /** The Find button: the card itself stays in the canvas (`CanvasTools`), and the page owns whether it is open. */
  find: { open: boolean; cardId: string; onToggle: () => void; buttonRef: Ref<HTMLButtonElement> };
  onRefresh: () => void;
  /** Where the page's focus goes after a source is removed from the graph. */
  refreshRef?: Ref<HTMLButtonElement>;
  /** Present only for a role that may clear unmapped sources. */
  clear?: { count: number; onClear: () => void };
  /**
   * (w33) The sources the newest scan of their range did not find. The filter (Turn on Not seen lately) only changes the view, so every role that can open the page gets it in the
   * overflow menu; Remove not seen is offered only with `onRemove` (a role that may remove sources) and sits after Clear unmapped. `count` = how many are marked, `removable` = how many
   * of those Remove not seen would take (nothing mapped), `filtered` = the canvas shows only the marked ones. Nothing is offered while `count` is 0, except to turn a filter that is on off.
   * While `filtered` the chips row draws one more chip, `Only not seen lately (2)` (`not seen (2)`, then icon and number, as the bar narrows), so the state is visible without opening the menu.
   */
  notSeen?: { count: number; filtered: boolean; onFilter: (on: boolean) => void; removable?: number; onRemove?: () => void };
  /** The shortcuts bubble's trigger, drawn among the page controls. */
  shortcuts: ReactNode;
  /** Ctrl or Cmd + K pressed on the bar (not inside the Find card or a menu): the page opens Find. */
  onFindKey: () => void;
}) {
  const switchRef = useRef<HTMLLabelElement>(null);
  const tidyRef = useRef<HTMLButtonElement>(null);
  const snapRef = useRef<HTMLButtonElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || (event.key ?? "").toLowerCase() !== "k") return;
    if (event.target instanceof Element && event.target.closest(".graph-find, .graph-menu")) return; // those keep their own Ctrl+K
    event.preventDefault(); // the top bar's quick find listens on the document
    event.stopPropagation();
    onFindKey();
  };

  // (w33) The filter item is there while a source is marked not seen (or a filter that is on, so the item never vanishes under a person who just used it).
  const hasFilterItem = notSeen !== undefined && (notSeen.count > 0 || notSeen.filtered);

  // Read when the menu opens, not on every render: a narrow control is listed only if the bar's copy of it is not drawn right then.
  const overflowItems = (): BarMenuItem[] => {
    const items: BarMenuItem[] = [];
    if (notDrawn(switchRef.current)) items.push({ label: `Turn ${unmappedOnly ? "off" : "on"} Unmapped only`, state: ok, onSelect: () => onUnmappedOnly(!unmappedOnly) });
    if (notDrawn(tidyRef.current)) items.push({ label: "Tidy layout", state: { enabled: !tidying }, onSelect: () => { if (!tidying) onTidy(); } });
    if (notDrawn(snapRef.current)) items.push({ label: `Turn ${snap ? "off" : "on"} Snap to grid`, state: ok, onSelect: () => onSnap(!snap) });
    if (clear) {
      items.push({
        label: `Clear unmapped (${clear.count})`,
        state: clear.count === 0 ? { enabled: false, reason: "Nothing to clear" } : ok,
        onSelect: clear.onClear,
      });
    }
    // (w33) After Clear unmapped (and after the narrow controls), never before an existing item. The filter is worded like Unmapped only (Turn on / Turn off): the menu has one kind of item.
    if (notSeen && hasFilterItem) {
      items.push({ label: `Turn ${notSeen.filtered ? "off" : "on"} Not seen lately`, state: ok, onSelect: () => notSeen.onFilter(!notSeen.filtered) });
    }
    if (notSeen && notSeen.onRemove && notSeen.count > 0) {
      const removable = notSeen.removable ?? 0;
      items.push({
        label: `Remove not seen (${removable})...`,
        state: removable === 0 ? { enabled: false, reason: "Nothing to remove" } : ok,
        onSelect: notSeen.onRemove,
      });
    }
    return items;
  };

  // (w36) Thousands separators, as in the summary sentence (a large source adds its 15,000 points): each chip's title is a piece of that sentence.
  const pointsNum = unmappedOnly ? `${countNumber(counts.unmapped)} of ${countNumber(counts.points)}` : countNumber(counts.points);
  // The chips come in two families for the stylesheet's width tiers: "wide" when the credentials chip is drawn or a count has four digits (those need the
  // room, so their words go early); everything else keeps its words until the bar is nearly out of room. Read from the counts, never from the "N of M"
  // text, so turning Unmapped only on or off never moves the tier.
  const wide = counts.needing > 0 || counts.sources >= 1000 || counts.points >= 1000 || counts.mapped >= 1000;

  return (
    <div className="graph-bar" onKeyDown={onKeyDown}>
      {/* The one announcer of this area: React leaves the text alone when the numbers do not change, so it speaks only when they do. */}
      <p className="graph-summary" aria-live="polite" aria-atomic="true" title={summary}>{summary}</p>
      <div className={`gbar-chips${wide ? " gbar-chips-wide" : ""}${notSeen?.filtered ? " gbar-chips-filtered" : ""}`}>
        <Chip icon="sources" num={countNumber(counts.sources)} word={plural(counts.sources, "source", "sources")} />
        <Chip icon="readings" num={pointsNum} word={plural(counts.points, "point", "points")} />
        <Chip icon="link" num={countNumber(counts.mapped)} word="mapped" />
        {counts.needing > 0 && <Chip icon="alert" tone="warn" num={countNumber(counts.needing)} word={plural(counts.needing, "needs credentials", "need credentials")} />}
        {/* (w33) While the Not seen lately filter is on: the count above stays the whole graph's, so say why fewer cards are drawn. Three forms by the bar's width (discovery-tidy.css): `Only not seen lately (2)`,
            `not seen (2)`, and icon and number; the whole sentence is in the title. One run of text on one line, so the words read in order. */}
        {notSeen?.filtered && (
          <span className="gbar-chip gbar-chip-filter" title={`Only not seen lately (${notSeen.count})`} aria-hidden="true">
            <Icon name="filter" />
            <span className="gbar-chip-text"><span className="gbar-chip-fword">Only </span><span className="gbar-chip-mword">not seen</span><span className="gbar-chip-fword"> lately</span><span className="gbar-chip-mword"> (</span><span className="gbar-chip-num">{notSeen.count}</span><span className="gbar-chip-mword">)</span></span>
          </span>
        )}
      </div>
      <span className="gbar-divider" aria-hidden="true" />
      <div className="gbar-group" role="group" aria-label="View controls">
        <button
          type="button"
          aria-disabled={!collapsible || undefined}
          title={collapsible ? "Collapse all" : "Nothing is open"}
          onClick={() => { if (collapsible) onCollapseAll(); }}
        ><Icon name="collapse" /><span className="gbar-lbl gbar-lbl-fold">Collapse all</span></button>
        <BarMenu
          name="More ways to collapse"
          menuLabel="Collapse options"
          icon="caret"
          className="graph-bar-more"
          items={[
            { label: "Collapse selection", state: collapseSelection, onSelect: onCollapseSelection },
            { label: "Collapse this branch", state: collapseBranch, onSelect: onCollapseBranch },
          ]}
        />
        <button
          type="button"
          aria-disabled={!expandable || undefined}
          title={expandable ? "Expand all" : "Everything is open"}
          onClick={() => { if (expandable) onExpandAll(); }}
        ><Icon name="expandAll" /><span className="gbar-lbl gbar-lbl-fold">Expand all</span></button>
        <BarMenu
          name="More ways to expand"
          menuLabel="Expand options"
          icon="caret"
          className="graph-bar-more"
          items={[
            { label: "Expand selection", state: expandSelection, onSelect: onExpandSelection },
            { label: "Expand this branch", state: expandBranch, onSelect: onExpandBranch },
          ]}
        />
        {/* Always drawn, so the bar never changes width when the filter is turned on; the same words as the Points page's checkbox. */}
        <label ref={switchRef} className="check graph-bar-switch gbar-narrow" title="Unmapped only">
          <input type="checkbox" role="switch" checked={unmappedOnly} onChange={(event) => onUnmappedOnly(event.target.checked)} />
          <Icon name="filter" />
          <span className="gbar-lbl gbar-lbl-unmapped">Unmapped only</span>
        </label>
        <button
          type="button"
          ref={tidyRef}
          className="gbar-narrow"
          aria-disabled={tidying || undefined}
          title="Tidy layout"
          onClick={() => { if (!tidying) onTidy(); }}
        ><Icon name="tidy" /><span className="gbar-lbl gbar-lbl-tidy">Tidy layout</span></button>
      </div>
      <span className="gbar-divider" aria-hidden="true" />
      <div className="gbar-group" role="group" aria-label="Canvas controls">
        <FindButton open={find.open} cardId={find.cardId} onToggle={find.onToggle} buttonRef={find.buttonRef} />
        <button
          type="button"
          ref={snapRef}
          className="gbar-narrow"
          aria-pressed={snap}
          title="Snap to grid"
          onClick={() => onSnap(!snap)}
        ><Icon name="grid" /><span className="gbar-lbl gbar-lbl-snap">Snap to grid</span></button>
      </div>
      <span className="gbar-divider" aria-hidden="true" />
      <div className="gbar-group" role="group" aria-label="Page controls">
        <button type="button" ref={refreshRef} className="icon-btn" aria-label="Refresh" title="Refresh" onClick={onRefresh}><Icon name="refresh" /></button>
        {shortcuts}
        {/* A role that may not clear unmapped and has no marked source has nothing in the menu while every control is drawn: its button shows only in the narrowest tier. */}
        <BarMenu
          name="More Discovery actions"
          menuLabel="Discovery actions"
          icon="more"
          className={clear || hasFilterItem ? "icon-btn gbar-overflow" : "icon-btn gbar-overflow gbar-overflow-narrow"}
          items={overflowItems}
        />
      </div>
    </div>
  );
}
