import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { usePopover } from "../hooks/usePopover";
import { placePanel, type Placement } from "../lib/placePanel";
import { Icon } from "./Icon";

export interface RowAction {
  label: string;
  onSelect?: () => void;
  /** Renders a router link instead of a button. */
  to?: string;
  /** A disabled action is a disabled button: skipped by the arrow keys and cannot be activated. */
  disabled?: boolean;
  /** Why a disabled action cannot be used. The Discovery canvas menus (`GraphContextMenu`) show it under the label; `RowActions` itself ignores it. */
  reason?: string;
  tone?: "danger";
}

const ITEMS = '[role="menuitem"]:not(:disabled)';

/** The sticky top bar's height, which an upward menu must not cover (the CSS token, 52px when it cannot be read). */
function barHeight() {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-h"));
  return Number.isFinite(value) ? value : 52;
}

/**
 * The strip at the bottom of the window that the toast stack takes, which a menu must stay clear of (the stack is above the menu in the layers):
 * the window's height minus the top of the stack, and 8px of air. 0 when no toast is showing (the stack is always in the page, empty).
 */
function reservedBottom() {
  const stack = document.querySelector(".toast-stack");
  if (!stack || stack.childElementCount === 0) return 0;
  return Math.max(0, window.innerHeight - stack.getBoundingClientRect().top + 8);
}

/**
 * The three-dot menu of a table row. The panel is a portal on document.body with position: fixed, because `.table-wrap` scrolls
 * (and so clips) its content. Opens on click (pinned), Enter, Space, ArrowDown/ArrowUp and, for a mouse, on hover.
 * Choosing an item closes the menu and puts the focus on the trigger BEFORE `onSelect` runs, so a dialog that onSelect opens
 * records the trigger as the place to give the focus back to. Renders nothing when there are no items.
 */
export function RowActions({ label, items }: { label: string; items: RowAction[] }) {
  const pop = usePopover({ hover: true, closeOnScroll: true });
  const triggerId = useId();
  const panelId = useId();
  const [place, setPlace] = useState<Placement | null>(null);
  const wantFocus = useRef<"first" | "last" | null>(null); // a keyboard opened it: the focus moves in once the panel is there
  const empty = items.length === 0;

  const enabled = () => Array.from(pop.panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
  const focusItem = (which: "first" | "last") => {
    const all = enabled();
    all[which === "first" ? 0 : all.length - 1]?.focus({ preventScroll: true });
  };

  // Measured before the first paint, so the panel is never seen at a guessed place; the panel renders at 0,0 for that one pass.
  useLayoutEffect(() => {
    if (!pop.open) {
      setPlace(null);
      return;
    }
    const at = pop.trigger.current;
    const box = pop.panel.current;
    if (!at || !box) return;
    const { width, height } = box.getBoundingClientRect();
    setPlace(placePanel(at.getBoundingClientRect(), { width, height }, { width: window.innerWidth, height: window.innerHeight }, 4, barHeight(), reservedBottom()));
    if (wantFocus.current) focusItem(wantFocus.current);
    wantFocus.current = null;
  }, [pop.open]);

  useEffect(() => {
    if (empty && pop.open) pop.dismiss();
  }, [empty, pop.open]);

  if (empty) return null;

  const onTriggerClick = (event: MouseEvent) => {
    const result = pop.toggle();
    if (result === "closed" || event.detail !== 0) return; // a mouse click leaves the focus on the trigger; Enter and Space (detail 0) go into the menu
    if (result === "open") wantFocus.current = "first";
    else focusItem("first");
  };
  const onTriggerKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const which = event.key === "ArrowDown" ? "first" : "last";
    if (pop.open) {
      pop.pin();
      focusItem(which);
    } else {
      wantFocus.current = which;
      pop.show(true);
    }
  };
  const onPanelKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = enabled();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => {
      event.preventDefault();
      all[index]?.focus({ preventScroll: true });
    };
    switch (event.key) {
      case "ArrowDown": return go((at + 1) % all.length);
      case "ArrowUp": return go(at <= 0 ? all.length - 1 : at - 1);
      case "Home": return go(0);
      case "End": return go(all.length - 1);
      case "Tab": // not prevented: the focus is on the trigger (the menu is a portal at the end of the page), and the browser moves on from there
        pop.dismiss();
        pop.trigger.current?.focus();
        return;
      case " ": // a link does not activate on Space by itself
        if (event.target instanceof HTMLAnchorElement) {
          event.preventDefault();
          event.target.click();
        }
    }
  };

  const choose = (onSelect?: () => void) => {
    pop.dismiss();
    pop.trigger.current?.focus();
    onSelect?.();
  };

  return (
    <>
      <button
        type="button"
        id={triggerId}
        ref={pop.trigger}
        className="icon-btn row-menu-btn"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={pop.open ? panelId : undefined}
        aria-label={label}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKey}
        {...pop.triggerHover}
      >
        <Icon name="more" />
      </button>
      {pop.open && createPortal(
        <div
          ref={pop.panel}
          id={panelId}
          role="menu"
          aria-labelledby={triggerId}
          className="row-menu-panel"
          style={place ? { top: place.top, left: place.left, maxHeight: place.maxHeight } : { top: 0, left: 0 }}
          onKeyDown={onPanelKey}
          onClick={(event) => event.stopPropagation()} // React events cross a portal: a click in the menu must not reach a handler of the row it sits in
          {...pop.panelHover}
        >
          {items.map((item, index) => {
            const key = `${index}:${item.label}`;
            const className = item.tone === "danger" ? "danger-item" : undefined;
            return item.to && !item.disabled ? (
              <Link key={key} to={item.to} role="menuitem" tabIndex={-1} className={className} onClick={() => choose()}>{item.label}</Link>
            ) : (
              <button key={key} type="button" role="menuitem" tabIndex={-1} className={className} disabled={item.disabled} onClick={() => choose(item.onSelect)}>
                {item.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
