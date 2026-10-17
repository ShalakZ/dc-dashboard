import { useCallback, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

/** Where a `?` is a character the person is typing. (The Find card and the menus are already left alone above.) */
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * The keys of the Discovery canvas, as ONE onKeyDown for its wrapper: Ctrl/Cmd+K opens Find, ContextMenu and Shift+F10 open the actions
 * of what has the focus, Escape tells the page to clear the selection, and ? opens the shortcuts list (not while a field, a select or an
 * editable element has the focus, where it is a character, and not with Ctrl, Cmd or Alt held, which are other people's keys).
 *
 * React's onKeyDown runs at the root container, BELOW the `document` listener of the top bar's quick find, so stopping the event here
 * keeps Ctrl+K from reaching it: on the canvas the key is Find's, anywhere else on the page it stays the quick find's.
 *
 * It acts only when `canvas` contains the target in the DOM (React also delivers the keys of a portal, the context menu, to this
 * handler), never inside the Find card or the menu (they have their own keys) and never behind a modal dialog (the same test as QuickFind).
 * The Find and Snap buttons live in the bar, outside the canvas element: the bar hears Ctrl/Cmd+K itself (`GraphBar`'s `onFindKey`). What is inside
 * the canvas (a node, a node's buttons, the Controls) is the canvas's like any other element.
 */
export function useCanvasKeys({ canvas, openFind, openMenuFor, onEscape, openKeys }: {
  canvas: RefObject<HTMLElement | null>;
  openFind: () => void;
  openMenuFor: (target: HTMLElement | null) => void;
  onEscape: () => void;
  /** The `?` key: the page opens the shortcuts bubble (which records the element that has the focus as the place to give it back to). */
  openKeys: () => void;
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
    } else if (key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey && !target.closest(TYPING)) {
      event.preventDefault();
      openKeys();
    } else if (key === "Escape" && !event.defaultPrevented) {
      onEscape();
    }
  }, [canvas, openFind, openMenuFor, onEscape, openKeys]);
  return { onKeyDown };
}
