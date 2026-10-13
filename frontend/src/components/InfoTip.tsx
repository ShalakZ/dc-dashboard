import { useId, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "../hooks/usePopover";
import { placeTip, type TipPlacement } from "../lib/placeTip";
import { Icon } from "./Icon";

/**
 * A `?` button with an explanation bubble: click pins it, a mouse hovering opens it, Escape and a press outside close it.
 * The name is generic on purpose (a field's own words would give Playwright's substring `getByLabel` two matches). Put it NEXT TO a
 * label, never inside one. The bubble is in the page only while open, as a portal on document.body with position: fixed (like the
 * row menu's panel), because a tip often sits in a box that scrolls (the Roles grid): inside it the bubble was clipped at the box's
 * edge and made the box scroll sideways. A scroll or a resize closes it, since a fixed bubble would be left behind.
 */
export function InfoTip({ children, label = "What does this mean?" }: { children: ReactNode; label?: string }) {
  const pop = usePopover({ hover: true, closeOnScroll: true });
  const bubbleId = useId();
  const [place, setPlace] = useState<TipPlacement | null>(null);

  // Measured before the first paint, so the bubble is never seen at a guessed place; it renders at 0,0 for that one pass.
  useLayoutEffect(() => {
    if (!pop.open) {
      setPlace(null);
      return;
    }
    const at = pop.trigger.current;
    const box = pop.panel.current;
    if (!at || !box) return;
    const { width, height } = box.getBoundingClientRect();
    setPlace(placeTip(at.getBoundingClientRect(), { width, height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [pop.open]);

  return (
    <span className="tip">
      <button
        type="button"
        ref={pop.trigger}
        className="icon-btn tip-btn"
        aria-label={label}
        aria-expanded={pop.open}
        aria-controls={pop.open ? bubbleId : undefined}
        onClick={() => pop.toggle()}
        {...pop.triggerHover}
      >
        <Icon name="help" />
      </button>
      {pop.open && createPortal(
        <div
          ref={pop.panel}
          id={bubbleId}
          role="note"
          className="tip-bubble"
          style={place ? { top: place.top, left: place.left } : { top: 0, left: 0 }}
          onClick={(event) => event.stopPropagation()} // React events cross a portal: a click on the bubble must not reach a handler of the row or label it sits in
          {...pop.panelHover}
        >
          {children}
        </div>,
        document.body,
      )}
    </span>
  );
}
