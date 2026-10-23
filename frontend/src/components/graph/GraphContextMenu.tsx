import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { placePanel, type Box, type Placement } from "../../lib/placePanel";
import type { RowAction } from "../RowActions";

/**
 * Where the menu opens: at a point (a right-click), next to a box (a `⋯` button in a column of rows: to its LEFT, like `RowActions`), or
 * `below` a box (a button in a horizontal bar: UNDER it, its left edge on the box's for "start", its right edge on the box's for "end").
 */
export type GraphMenuAt = { x: number; y: number } | { box: Box } | { box: Box; below: "start" | "end" };

const ITEMS = '[role="menuitem"]:not([aria-disabled="true"])';
const EDGE = 8; // kept free at the right, left and bottom of the window (placePanel's own margin)

/** The sticky top bar's height, which a menu must not cover (the CSS token, 52px when it cannot be read). */
function barHeight() {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-h"));
  return Number.isFinite(value) ? value : 52;
}

/**
 * Where a context menu goes when it opens at the pointer: its top-left corner AT the pointer, like every native menu. `placePanel` puts a
 * panel to the LEFT of its trigger (right for a column of row buttons), which for a right-click would put the menu away from the cursor.
 * With no room at the right it opens to the left of the pointer, with no room below, above it; a panel that fits nowhere is clamped under
 * `inset` (the top bar) and scrolls inside its `maxHeight`.
 */
export function placeAtPoint(
  point: { x: number; y: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  inset = EDGE,
): Placement {
  const left = point.x + panel.width <= viewport.width - EDGE ? point.x : Math.max(EDGE, point.x - panel.width);
  const down = point.y + panel.height <= viewport.height - EDGE;
  const up = point.y - panel.height >= inset;
  const top = down ? point.y : up ? point.y - panel.height : Math.max(inset, viewport.height - EDGE - panel.height);
  return { top, left, placement: down || !up ? "down" : "up", maxHeight: viewport.height - top - EDGE };
}

/**
 * Where a menu goes when it hangs from a button of a horizontal bar: under the box with a `gap`, left edges aligned for "start" and right
 * edges aligned for "end", so it never covers the bar's neighbouring buttons. With no room below it flips ABOVE the box when the whole panel
 * fits there; one that fits on neither side stays below, clamped under `inset` (the top bar), and scrolls inside its `maxHeight`. The panel
 * is kept `EDGE` from the left and right of the window (the left margin wins in a window narrower than the panel).
 */
export function placeBelowBox(
  box: Box,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "start" | "end",
  gap = 4,
  inset = EDGE,
): Placement {
  const below = box.bottom + gap;
  const above = box.top - gap - panel.height;
  const up = below + panel.height > viewport.height - EDGE && above >= inset;
  const top = Math.max(up ? above : below, inset);
  const wanted = align === "end" ? box.right - panel.width : box.left;
  const left = Math.max(EDGE, Math.min(wanted, viewport.width - EDGE - panel.width));
  return { top, left, placement: up ? "up" : "down", maxHeight: viewport.height - top - EDGE };
}

/**
 * The right-click menu of the Discovery canvas. It has no trigger button, so it re-implements what `RowActions` does for one: a portal on
 * the body, `role="menu"`, the focus moves into the first enabled item on open, ArrowUp/Down wrap, Home/End, Tab closes, Escape closes
 * and is swallowed in the capture phase (the innermost layer only), a press outside, a scroll, a resize or the focus leaving close it.
 * Choosing an item closes the menu and puts the focus on `returnFocus()` BEFORE `onSelect` runs, so a dialog that onSelect opens records
 * that element as the place to give the focus back to.
 *
 * `at` is read once, when the menu mounts: the page keys the menu by its open, so a second open mounts a fresh one. A disabled item is
 * `aria-disabled` (never native disabled) and skipped by the focus (a menu with no enabled item takes the focus itself); its `reason`, when it has one, is a muted second line inside the item and its
 * `title`. Items are buttons; a `to` link is not supported here.
 */
export function GraphContextMenu({ at, items, label, returnFocus, onClose }: {
  at: GraphMenuAt;
  items: RowAction[];
  label: string;
  returnFocus: () => HTMLElement | null;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const closed = useRef(false); // onClose is called once per menu: moving the focus back to the node (which leaves the menu) must not close it a second time
  const empty = items.length === 0;

  const enabled = () => Array.from(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
  const giveBack = () => returnFocus()?.focus({ preventScroll: true });
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  };

  // Measured before the first paint, so the menu is never seen at a guessed place (it renders at 0,0 for that one pass).
  useLayoutEffect(() => {
    const box = panel.current;
    if (!box) return;
    const { width, height } = box.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const size = { width, height };
    setPlace(
      "box" in at
        ? "below" in at
          ? placeBelowBox(at.box, size, viewport, at.below, 4, barHeight())
          : placePanel(at.box, size, viewport, 4, barHeight())
        : placeAtPoint(at, size, viewport, barHeight()),
    );
    // With nothing to choose (every item disabled, as a twin point's menu) the menu is where the focus goes, so Escape works and its name and reasons are read.
    (enabled()[0] ?? box).focus({ preventScroll: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- placed once per mount

  useEffect(() => { if (empty) close(); }, [empty]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (empty) return;
    const inside = (target: EventTarget | null) => target instanceof Node && !!panel.current?.contains(target);
    // Capture phase, like usePopover: the key is the menu's alone (a dialog's own Escape listener on the document must not also fire).
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      close();
      giveBack();
    };
    const onPointerDown = (event: PointerEvent) => { if (!inside(event.target)) close(); };
    const onFocusIn = (event: FocusEvent) => { if (!inside(event.target)) close(); };
    const onScroll = (event: Event) => { if (!inside(event.target)) close(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [empty, onClose]); // eslint-disable-line react-hooks/exhaustive-deps -- returnFocus is read when it is needed

  if (empty) return null;

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
      case "Tab": // not prevented: the focus goes back to the node first, and the browser moves on from there
        close();
        giveBack();
    }
  };

  const choose = (item: RowAction) => {
    if (item.disabled) return;
    close();
    giveBack();
    item.onSelect?.();
  };

  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className="row-menu-panel graph-menu"
      style={place ? { top: place.top, left: place.left, maxHeight: place.maxHeight } : { top: 0, left: 0 }}
      onKeyDown={onPanelKey}
      onClick={(event) => event.stopPropagation()} // React events cross a portal: a click here must not reach a handler of the canvas it was opened from
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
    >
      {items.map((item, index) => (
        <button
          key={`${index}:${item.label}`}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={item.tone === "danger" ? "danger-item" : undefined}
          aria-disabled={item.disabled || undefined}
          title={item.disabled ? item.reason : undefined}
          onClick={() => choose(item)}
        >
          {/* The reason is part of the item (the second line of its text), so it is read with the label. The space keeps the two words apart in the name. */}
          {item.disabled && item.reason ? (
            <span className="graph-menu-text">
              <span>{item.label}</span>{" "}
              <span className="graph-menu-reason">{item.reason}</span>
            </span>
          ) : item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
