import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ActionState } from "../../lib/graphView";
import type { Box } from "../../lib/placePanel";
import { Icon, type IconName } from "../Icon";
import { GraphContextMenu } from "./GraphContextMenu";

export interface BarMenuItem {
  label: string;
  state: ActionState;
  onSelect: () => void;
}

/**
 * A menu button of the Discovery bar: the small chevron beside Collapse all / Expand all (a menu for the selection and the branch) and the
 * overflow button at the end of the bar. A button with nothing to offer keeps its place and says why: `aria-disabled` (never native `disabled`,
 * it may hold the focus the click gave it), a click guard, the reason as its title and as a hidden description that is always in the DOM (so a
 * button that becomes blocked adds no node and moves nothing).
 *
 * `items` may be a function: it is asked for the list when the menu opens (the overflow lists a narrow item only if its copy in the bar is not
 * drawn, which only the page can tell at that moment). A function cannot say beforehand whether anything is on offer, so `disabled` is the way
 * to block such a button; an empty list opens no menu. The menu returns the focus to the button BEFORE an item runs, so a dialog an item opens
 * gives the focus back to the button.
 *
 * The menu closes itself on any press outside it, and the click that follows a press on the button would open it again: the press is noted first
 * (capture phase, before the menu's own listener), so the second press on the button closes the menu and only closes it (as `useCanvasMenu` does).
 */
export function BarMenu({ name, menuLabel, items, icon, className, disabled }: {
  name: string;
  menuLabel: string;
  items: BarMenuItem[] | (() => BarMenuItem[]);
  icon: IconName;
  className?: string;
  disabled?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ id: number; box: Box; asked: BarMenuItem[] | null } | null>(null);
  const sequence = useRef(0);
  const reasonId = useId();
  const standing = useRef(false); // whether the menu is open as the next press will find it
  standing.current = menu !== null;
  const pressed = useRef(false); // the last press landed on the button while its menu stood
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

  const known = typeof items === "function" ? null : items;
  const blocked = disabled ?? (known !== null && known.every((item) => !item.state.enabled));
  const reason = known?.find((item) => item.state.reason)?.state.reason;

  const onClick = () => {
    if (pressed.current) {
      pressed.current = false; // the second half of the press that already closed the menu
      return;
    }
    if (blocked) return;
    if (menu) return close();
    const at = button.current?.getBoundingClientRect();
    if (!at) return;
    const asked = typeof items === "function" ? items() : null;
    if (asked && asked.length === 0) return;
    setMenu({ id: ++sequence.current, box: { top: at.top, left: at.left, right: at.right, bottom: at.bottom }, asked });
  };

  const listed = menu?.asked ?? known ?? [];
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-disabled={blocked || undefined}
        aria-describedby={reasonId}
        title={blocked ? reason : undefined}
        onClick={onClick}
      ><Icon name={icon} /></button>
      <span id={reasonId} className="sr-only">{blocked ? reason : ""}</span>
      {menu && (
        <GraphContextMenu
          key={menu.id}
          at={{ box: menu.box }}
          label={menuLabel}
          returnFocus={() => button.current}
          onClose={close}
          items={listed.map((item) => ({ label: item.label, disabled: !item.state.enabled, reason: item.state.reason, onSelect: item.onSelect }))}
        />
      )}
    </>
  );
}
