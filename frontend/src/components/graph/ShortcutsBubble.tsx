import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "../../hooks/usePopover";
import { placeTip, type TipPlacement } from "../../lib/placeTip";
import { Icon } from "../Icon";

const NAME = "Keyboard shortcuts and controls";
const EDGE = 8; // kept free below the bubble (placeTip's own margin)

const Key = ({ children }: { children: ReactNode }) => <kbd className="gkeys-key">{children}</kbd>;

interface Group { title: string; rows: { what: string; keys: ReactNode }[] }

// The words of the bubble. Every shortcut named here is real (useCanvasKeys, useGraphNav, the page's Ctrl+Z, the highlight and the value card).
const GROUPS: Group[] = [
  { title: "Move and select", rows: [
    { what: "Move a node", keys: <>Drag it</> },
    { what: "Move a node alone", keys: <><Key>Alt</Key> or <Key>Option</Key> + drag</> },
    { what: "Select several nodes", keys: <><Key>Shift</Key> + drag</> },
    { what: "Add one to the selection", keys: <><Key>Ctrl</Key> or <Key>Cmd</Key> + click</> },
  ] },
  { title: "Camera", rows: [
    { what: "Zoom", keys: <>Scroll to zoom</> },
    { what: "Pan", keys: <>Drag the canvas</> },
    { what: "See everything", keys: <>The Fit view button</> },
  ] },
  { title: "Find", rows: [
    { what: "Find a node", keys: <><Key>Ctrl</Key> or <Key>Cmd</Key> + <Key>K</Key></> },
  ] },
  { title: "Menus", rows: [
    { what: "Open a node's menu", keys: <>Right-click</> },
    { what: "From the keyboard", keys: <><Key>Shift</Key> + <Key>F10</Key> or the <Key>Menu</Key> key</> },
  ] },
  { title: "Mapping", rows: [
    { what: "Map a group", keys: <>Drag it onto an asset</> },
    { what: "Make assets from groups", keys: <>Create assets</> },
    { what: "Add one by hand", keys: <>New asset</> },
  ] },
  { title: "Navigation", rows: [
    { what: "Move between nodes", keys: <>Arrow keys</> },
    { what: "Open or close a node", keys: <><Key>Enter</Key></> },
    { what: "Select a node", keys: <><Key>Space</Key></> },
    { what: "Clear the selection", keys: <><Key>Escape</Key></> },
    { what: "Undo the last mapping change (for 10 seconds)", keys: <><Key>Ctrl</Key> or <Key>Cmd</Key> + <Key>Z</Key></> },
    { what: "Open this list", keys: <><Key>?</Key></> },
    { what: "Light a node's path", keys: <>Hover a node</> },
    { what: "See a value", keys: <>Hovering a mapped point shows its last value</> },
  ] },
];

/**
 * The shortcuts and controls of the Discovery canvas, behind one icon button in the bar. The bubble is a portal on the body (`position:
 * fixed`, under the button, clamped to the window), a non-modal dialog with the focus inside it while it is open; the page behind stays usable.
 *
 * `openRef.current.open()` opens it for the `?` key. The element that had the focus before it opened (the canvas, for `?`) is the place the focus
 * goes back to when the bubble is closed with Escape or Tab; when that element is gone it is the button. A press outside, a scroll and a resize close it
 * (`usePopover`), and a focus that lands elsewhere too, without a focus move of their own. Escape is handled here, in the capture phase
 * on the window, so only the bubble sees that press (the page's own Escape, a dialog under it, never do) and the focus goes to the opener rather
 * than to the button.
 */
export function ShortcutsBubble({ openRef }: { openRef: RefObject<{ open(): void } | null> }) {
  const pop = usePopover({ hover: false, closeOnScroll: true });
  const { show, dismiss, trigger, panel } = pop;
  const bubbleId = useId();
  const opener = useRef<HTMLElement | null>(null);
  const [place, setPlace] = useState<(TipPlacement & { maxHeight: number }) | null>(null);

  const open = useCallback(() => {
    const box = panel.current;
    if (box) { // already open: only bring the focus back into it, and keep the first opener
      box.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    show(true);
  }, [show, panel]);
  useImperativeHandle(openRef, () => ({ open }), [open]);

  /** Closes it and puts the focus on the opener (the button when the opener is gone). */
  const closeAndGiveBack = useCallback(() => {
    dismiss();
    const to = opener.current?.isConnected ? opener.current : trigger.current;
    opener.current = null;
    to?.focus({ preventScroll: true });
  }, [dismiss, trigger]);

  // Measured before the first paint, so the bubble is never seen at a guessed place; it renders at 0,0 for that one pass.
  useLayoutEffect(() => {
    const at = trigger.current;
    const box = panel.current;
    if (!pop.open || !at || !box) {
      setPlace(null);
      return;
    }
    const { width, height } = box.getBoundingClientRect();
    const placed = placeTip(at.getBoundingClientRect(), { width, height }, { width: window.innerWidth, height: window.innerHeight });
    setPlace({ ...placed, maxHeight: Math.max(120, Math.min(window.innerHeight - 80, window.innerHeight - placed.top - EDGE)) });
    box.focus({ preventScroll: true });
  }, [pop.open, trigger, panel]);

  // Escape: window + capture runs before usePopover's own listener on the document, which would send the focus to the button.
  useEffect(() => {
    if (!pop.open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      closeAndGiveBack();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pop.open, closeAndGiveBack]);

  // The bubble has nothing to Tab to: the key would take the focus out of the document, so it closes the bubble and the focus goes to the opener.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    closeAndGiveBack();
  };

  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="icon-btn gkeys-btn"
        aria-label={NAME}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? bubbleId : undefined}
        aria-keyshortcuts="?"
        onClick={() => (pop.open ? dismiss() : open())}
      >
        <Icon name="keyboard" />
      </button>
      {pop.open && createPortal(
        <div
          ref={panel}
          id={bubbleId}
          role="dialog"
          aria-label={NAME}
          tabIndex={-1}
          className="gkeys"
          style={place ? { top: place.top, left: place.left, maxHeight: place.maxHeight } : { top: 0, left: 0 }}
          onKeyDown={onKeyDown}
          onClick={(event) => event.stopPropagation()} // React events cross a portal: a click here must not reach a handler of the bar it was opened from
        >
          <div className="gkeys-grid">
            {GROUPS.map((group) => (
              <section key={group.title} className="gkeys-group">
                <h3 className="gkeys-title">{group.title}</h3>
                <dl className="gkeys-list">
                  {group.rows.map((row) => (
                    <div key={row.what} className="gkeys-row">
                      <dt className="gkeys-what">{row.what}</dt>
                      <dd className="gkeys-keys">{row.keys}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
