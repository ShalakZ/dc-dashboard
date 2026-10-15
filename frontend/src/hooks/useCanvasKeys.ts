import { useCallback, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

/**
 * The keys of the Discovery canvas, as ONE onKeyDown for its wrapper: Ctrl/Cmd+K opens Find, ContextMenu and Shift+F10 open the actions
 * of what has the focus, Escape tells the page to clear the selection.
 *
 * React's onKeyDown runs at the root container, BELOW the `document` listener of the top bar's quick find, so stopping the event here
 * keeps Ctrl+K from reaching it: on the canvas the key is Find's, anywhere else on the page it stays the quick find's.
 *
 * It acts only when `canvas` contains the target in the DOM (React also delivers the keys of a portal, the context menu, to this
 * handler), never inside the Find card or the menu (they have their own keys) and never behind a modal dialog (the same test as QuickFind).
 * The tools panel's buttons (Find, Snap to grid) are the canvas's like any other element: Ctrl/Cmd+K there opens Find (the Find button advertises
 * it, and Escape in the Find card puts the focus back on that button).
 */
export function useCanvasKeys({ canvas, openFind, openMenuFor, onEscape }: {
  canvas: RefObject<HTMLElement | null>;
  openFind: () => void;
  openMenuFor: (target: HTMLElement | null) => void;
  onEscape: () => void;
}): { onKeyDown: (event: ReactKeyboardEvent) => void } {
  const onKeyDown = useCallback((event: ReactKeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || !canvas.current?.contains(target)) return;
    if (target.closest(".graph-find, .graph-menu")) return;
    if (document.querySelector('[aria-modal="true"]')) return;

    const key = event.key ?? ""; // autofill sends keydown events without a key
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopPropagation();
      openFind();
    } else if (key === "ContextMenu" || (key === "F10" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey)) {
      event.preventDefault();
      openMenuFor(target as HTMLElement);
    } else if (key === "Escape" && !event.defaultPrevented) {
      onEscape();
    }
  }, [canvas, openFind, openMenuFor, onEscape]);
  return { onKeyDown };
}
