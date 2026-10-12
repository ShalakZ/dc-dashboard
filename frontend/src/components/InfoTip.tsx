import { useId, useLayoutEffect, useState, type ReactNode } from "react";
import { usePopover } from "../hooks/usePopover";
import { Icon } from "./Icon";

/**
 * A `?` button with an explanation bubble: click pins it, a mouse hovering opens it, Escape and a press outside close it.
 * The name is generic on purpose (a field's own words would give Playwright's substring `getByLabel` two matches). Put it NEXT TO a
 * label, never inside one. The bubble is in the page only while open.
 */
export function InfoTip({ children, label = "What does this mean?" }: { children: ReactNode; label?: string }) {
  const pop = usePopover({ hover: true });
  const bubbleId = useId();
  const [align, setAlign] = useState<"start" | "end">("start");

  // Left edge on the button's, unless that runs off the window (a tip at the right end of a line): then the right edge on the button's.
  useLayoutEffect(() => {
    if (!pop.open) {
      setAlign("start");
      return;
    }
    const box = pop.panel.current?.getBoundingClientRect();
    if (box && box.right > window.innerWidth - 8) setAlign("end");
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
      {pop.open && (
        <div ref={pop.panel} id={bubbleId} role="note" className="tip-bubble" data-align={align} {...pop.panelHover}>
          {children}
        </div>
      )}
    </span>
  );
}
