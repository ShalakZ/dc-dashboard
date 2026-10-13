import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

// Modal's list plus links (a drawer hosts them), minus anything marked tabindex -1: the hidden copy field a drawer may carry is not a Tab stop.
const FOCUSABLE = ['a[href]', "button", 'input:not([type="hidden"])', "select", "textarea", "summary", "[tabindex]"]
  .map((selector) => `${selector}:not([disabled]):not([tabindex="-1"])`)
  .join(", ");

// Focus the drawer lets go: a toast (it sits outside the shell and stays live over the drawer) and another modal dialog above it (that one traps for itself).
const ALLOWED_OUTSIDE = '.toast-stack, [aria-modal="true"]';

// The page behind a drawer is locked by every open drawer together: one counter, the page state saved when the first one opens and put back
// when the last one goes, so a second drawer (or StrictMode's second mount) never unlocks it early.
let holders = 0;
let unlockPage: (() => void) | null = null;

/** No scrolling (the document scrolls: <html> is locked, never <body>) and the shell and skip link inert. Returns the way back. */
function lockPage(): () => void {
  const root = document.documentElement;
  const saved = ["overflow", "scrollbar-gutter"].map((name) => [name, root.style.getPropertyValue(name), root.style.getPropertyPriority(name)] as const);
  // Measured BEFORE the overflow is hidden (hiding it removes the scrollbar, and the page would jump right by its width). The gutter keeps the
  // room, so the page, the toast stack and the loading bar stay where they were; with overlay scrollbars there is nothing to keep.
  const hadScrollbar = window.innerWidth - root.clientWidth > 0;
  root.style.setProperty("overflow", "hidden");
  if (hadScrollbar) root.style.setProperty("scrollbar-gutter", "stable");
  // inert on exactly these two, never on #root: the toast stack is a sibling of the shell inside the root and must stay live over the drawer.
  // An element already inert for another reason is left as it is.
  const made = Array.from(document.querySelectorAll<HTMLElement>(".shell, .skip-link")).filter((el) => !el.hasAttribute("inert"));
  for (const el of made) el.setAttribute("inert", "");
  return () => {
    for (const el of made) el.removeAttribute("inert");
    for (const [name, value, priority] of saved) {
      if (value) root.style.setProperty(name, value, priority);
      else root.style.removeProperty(name);
    }
  };
}

function holdPage(): () => void {
  if (holders === 0) unlockPage = lockPage();
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) {
      unlockPage?.();
      unlockPage = null;
    }
  };
}

/** `returnFocus` decides when the page gave one (null means nothing fits: #main); without one it is the element that had focus on open. */
function giveFocusBack(opener: HTMLElement | null | undefined, returnFocus: (() => HTMLElement | null) | undefined) {
  const target = returnFocus ? returnFocus() : opener;
  if (target && target !== document.body && target.isConnected) target.focus();
  else document.getElementById("main")?.focus({ preventScroll: true }); // the whole page is taller than the window: do not let focus scroll it
}

/**
 * A panel that slides in from the right over a dimmed page, for a record opened from a list. The page behind is dimmed, inert and not
 * scrollable; focus moves onto the panel, stays in it (Tab and Shift+Tab wrap round) and goes back when the drawer goes away. Escape and a
 * click on the backdrop close it; the backdrop only counts when the press AND the release were on it, so a text-selection drag that ends
 * there does not. The title is the dialog's name; `footer` is pinned under the scrolling body at a fixed height (`--drawer-foot-h`).
 *
 * Where focus goes on close: `returnFocus` is asked at that moment (the row the drawer was opened from may have changed since). If it
 * gives an element that is still in the page, that gets focus; if it gives null, or the element is gone, #main does. Without `returnFocus`
 * the element that had focus on open gets it back, unless that is the body (a deep link) or gone: then #main. Controls marked tabindex -1
 * are not Tab stops. The drawer is portalled to document.body, so React events of its content still bubble through its React parents.
 */
export function Drawer({ title, onClose, footer, returnFocus, children }: {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  returnFocus?: () => HTMLElement | null;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const latest = useRef({ onClose, returnFocus });
  useEffect(() => { latest.current = { onClose, returnFocus }; }); // the latest callbacks, without re-running the focus effect
  const press = useRef({ down: false, up: false });

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    // Saved BEFORE the page goes inert (a browser blurs a focused element whose ancestor turns inert).
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = holdPage();
    el.focus({ preventScroll: true }); // the panel starts off screen: a scroll to it would shift the backdrop
    const inAnotherDialog = (node: EventTarget | null) => {
      const dialog = node instanceof Element ? node.closest('[aria-modal="true"]') : null;
      return dialog !== null && dialog !== el;
    };
    const keepFocus = (e: FocusEvent) => {
      if (e.target instanceof Element && !el.contains(e.target) && !e.target.closest(ALLOWED_OUTSIDE)) el.focus({ preventScroll: true });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (inAnotherDialog(e.target)) return; // a delete confirmation above the drawer takes its own Escape
        latest.current.onClose();
        return;
      }
      if (e.key !== "Tab") return;
      if (inAnotherDialog(document.activeElement)) return; // ... and its own Tab (a Modal rendered inside the drawer's content is inside the panel's DOM)
      const controls = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (controls.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const [first, last] = [controls[0], controls[controls.length - 1]];
      const at = document.activeElement;
      // Wrap here instead of letting focus land on the page behind and pulling it back (keepFocus stays as the backstop). Focus on the body
      // (the focused button was disabled or removed) goes in at the first or last control; focus in a toast or another dialog is left to the browser.
      const wrap = at && el.contains(at) ? (e.shiftKey ? at === first || at === el : at === last) : at === document.body || at === null;
      if (wrap) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("focusin", keepFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      document.removeEventListener("keydown", onKey);
      release(); // the page first: focus cannot go back into something that is still inert
      giveFocusBack(opener, latest.current.returnFocus);
    };
  }, []);

  return createPortal(
    <div
      className="drawer-backdrop"
      onMouseDown={(e) => { press.current = { down: e.target === e.currentTarget, up: false }; }}
      onMouseUp={(e) => { press.current.up = e.target === e.currentTarget; }}
      onClick={(e) => {
        const wholeClick = press.current.down && press.current.up && e.target === e.currentTarget;
        press.current = { down: false, up: false };
        if (wholeClick) latest.current.onClose();
      }}
    >
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="drawer">
        <div className="drawer-head">
          <h2 id={titleId} className="drawer-title">{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => latest.current.onClose()}>
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
