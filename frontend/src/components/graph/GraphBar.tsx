import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ActionState } from "../../lib/graphView";
import type { Box } from "../../lib/placePanel";
import { Icon } from "../Icon";
import { GraphContextMenu } from "./GraphContextMenu";

interface Item {
  label: string;
  state: ActionState;
  onSelect: () => void;
}

/**
 * The small chevron beside Collapse all / Expand all: a menu button with two items (the selection, the branch). A chevron with nothing to offer
 * keeps its place and says why: `aria-disabled` (never native `disabled`, it may hold the focus the click gave it), a click guard, the reason as its
 * title and as a hidden description that is always in the DOM (so a chevron that becomes blocked adds no node and moves nothing).
 *
 * The menu closes itself on any press outside it, and the click that follows a press on the chevron would open it again: the press is noted first
 * (capture phase, before the menu's own listener), so the second press on the chevron closes the menu and only closes it (as `useCanvasMenu` does).
 */
function MoreWays({ name, menuLabel, items }: { name: string; menuLabel: string; items: [Item, Item] }) {
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ id: number; box: Box } | null>(null);
  const sequence = useRef(0);
  const reasonId = useId();
  const standing = useRef(false); // whether the menu is open as the next press will find it
  standing.current = menu !== null;
  const pressed = useRef(false); // the last press landed on the chevron while its menu stood
  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const note = (event: Event) => {
      pressed.current = event.type === "pointerdown" && standing.current && event.target instanceof Node && !!button.current?.contains(event.target);
    };
    document.addEventListener("pointerdown", note, true);
    document.addEventListener("keydown", note, true); // a key press forgets the press: a button pressed and left with no click must not swallow the next open
    return () => {
      document.removeEventListener("pointerdown", note, true);
      document.removeEventListener("keydown", note, true);
    };
  }, []);

  const blocked = items.every((item) => !item.state.enabled);
  const reason = items.find((item) => item.state.reason)?.state.reason;

  const onClick = () => {
    if (pressed.current) {
      pressed.current = false; // the second half of the press that already closed the menu
      return;
    }
    if (blocked) return;
    if (menu) return close();
    const at = button.current?.getBoundingClientRect();
    if (at) setMenu({ id: ++sequence.current, box: { top: at.top, left: at.left, right: at.right, bottom: at.bottom } });
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="graph-bar-more"
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-disabled={blocked || undefined}
        aria-describedby={reasonId}
        title={blocked ? reason : undefined}
        onClick={onClick}
      ><Icon name="caret" /></button>
      <span id={reasonId} className="sr-only">{blocked ? reason : ""}</span>
      {menu && (
        <GraphContextMenu
          key={menu.id}
          at={{ box: menu.box }}
          label={menuLabel}
          returnFocus={() => button.current}
          onClose={close}
          items={items.map((item) => ({ label: item.label, disabled: !item.state.enabled, reason: item.state.reason, onSelect: item.onSelect }))}
        />
      )}
    </>
  );
}

/**
 * The bar above the Discovery canvas: what the graph holds (the one polite announcer of the area), Collapse all, Expand all and Tidy layout, a
 * chevron menu beside each of the first two for the selection and the branch, and the Unmapped only switch at the end. A button with nothing to do
 * keeps its place and says so (`aria-disabled` and a click guard, never `disabled`: it may hold the focus the click gave it).
 */
export function GraphBar({
  summary, collapsible, expandable, tidying, unmappedOnly, onUnmappedOnly, onCollapseAll, onExpandAll, onTidy,
  expandSelection, collapseSelection, expandBranch, collapseBranch,
  onExpandSelection, onCollapseSelection, onExpandBranch, onCollapseBranch,
}: {
  summary: string;
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
}) {
  return (
    <div className="graph-bar">
      {/* The one announcer of this area: React leaves the text alone when the numbers do not change, so it speaks only when they do. */}
      <p className="graph-summary" aria-live="polite" aria-atomic="true" title={summary}>{summary}</p>
      <button
        type="button"
        aria-disabled={!collapsible || undefined}
        title={collapsible ? undefined : "Nothing is open"}
        onClick={() => { if (collapsible) onCollapseAll(); }}
      >Collapse all</button>
      <MoreWays
        name="More ways to collapse"
        menuLabel="Collapse options"
        items={[
          { label: "Collapse selection", state: collapseSelection, onSelect: onCollapseSelection },
          { label: "Collapse this branch", state: collapseBranch, onSelect: onCollapseBranch },
        ]}
      />
      <button
        type="button"
        aria-disabled={!expandable || undefined}
        title={expandable ? undefined : "Everything is open"}
        onClick={() => { if (expandable) onExpandAll(); }}
      >Expand all</button>
      <MoreWays
        name="More ways to expand"
        menuLabel="Expand options"
        items={[
          { label: "Expand selection", state: expandSelection, onSelect: onExpandSelection },
          { label: "Expand this branch", state: expandBranch, onSelect: onExpandBranch },
        ]}
      />
      <button type="button" aria-disabled={tidying || undefined} onClick={() => { if (!tidying) onTidy(); }}>Tidy layout</button>
      {/* Always drawn, with its words fixed, so the bar never changes width; the same words as the Points page's checkbox. */}
      <label className="check graph-bar-switch">
        <input type="checkbox" role="switch" checked={unmappedOnly} onChange={(event) => onUnmappedOnly(event.target.checked)} />
        Unmapped only
      </label>
    </div>
  );
}
