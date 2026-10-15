import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Box } from "../lib/placePanel";

/** What the menu is about: one node, the empty canvas, or the rectangle React Flow draws over a box selection. */
export type MenuTarget = { kind: "node"; id: string } | { kind: "pane" } | { kind: "selection" };
/** Where it opens: at the pointer, or next to an element (a keyboard open). */
export type MenuAt = { x: number; y: number } | { box: Box };

export interface CanvasMenu {
  /** A new number for every open, so the page can key the menu by it and a second open mounts a fresh one. */
  id: number;
  target: MenuTarget;
  at: MenuAt;
  via: "pointer" | "key";
  /** Where the focus goes when the menu closes (looked up when called: the element may have been replaced since). */
  returnFocus: () => HTMLElement | null;
}

/** What a mouse event gives, whether it is React's or the DOM's. */
interface PointerLike {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  currentTarget?: EventTarget | null;
  target?: EventTarget | null;
}

/** A browser also fires `contextmenu` at the focused element after the ContextMenu key or Shift+F10: one that comes this soon after our own keyboard open is that echo. */
export const KEY_ECHO_MS = 400;

const NODE = ".react-flow__node";
const SELECTION = ".react-flow__nodesselection-rect";

const boxOf = (el: Element): Box => {
  const { top, left, right, bottom } = el.getBoundingClientRect();
  return { top, left, right, bottom };
};
const keyOf = (target: MenuTarget) => (target.kind === "node" ? `node:${target.id}` : target.kind);
const escapeId = (id: string) => id.replace(/["\\]/g, "\\$&");

/**
 * The state of the Discovery canvas's context menu: ONE menu, keyed by what it is about, opened by a right-click on a node, on the empty
 * canvas or on a box selection, or from the keyboard (ContextMenu, Shift+F10). It holds no items: the page builds them from the node's own
 * `data` callbacks, so a menu is gated exactly like the buttons on the node.
 *
 * Opening is idempotent for the keyboard (a second open of the same target while its keyboard menu stands is ignored, and so is the
 * browser's own `contextmenu` echo within KEY_ECHO_MS); a pointer open anywhere else replaces the menu. A new `model` closes it: it holds
 * callbacks of nodes that may be gone.
 */
export function useCanvasMenu({ model, canvas }: { model: unknown; canvas: RefObject<HTMLElement | null> }) {
  const [menu, setMenu] = useState<CanvasMenu | null>(null);
  const last = useRef<{ key: string; via: "pointer" | "key"; at: number } | null>(null);
  const sequence = useRef(0);

  const close = useCallback(() => {
    last.current = null;
    setMenu(null);
  }, []);
  useEffect(close, [model, close]);

  const nodeElement = useCallback(
    (id: string) => canvas.current?.querySelector<HTMLElement>(`${NODE}[data-id="${escapeId(id)}"]`) ?? null,
    [canvas],
  );
  const selectionElement = useCallback(() => canvas.current?.querySelector<HTMLElement>(SELECTION) ?? null, [canvas]);

  const show = useCallback((target: MenuTarget, at: MenuAt, via: "pointer" | "key", returnFocus: () => HTMLElement | null) => {
    const key = keyOf(target);
    const before = last.current;
    const now = Date.now();
    if (before && before.key === key && before.via === "key" && (via === "key" || now - before.at < KEY_ECHO_MS)) return;
    last.current = { key, via, at: now };
    setMenu({ id: ++sequence.current, target, at, via, returnFocus });
  }, []);

  const point = (event: PointerLike, anchor: Element | null): MenuAt =>
    event.clientX === 0 && event.clientY === 0 && anchor ? { box: boxOf(anchor) } : { x: event.clientX, y: event.clientY };
  const centre = useCallback((): MenuAt => {
    const box = canvas.current ? boxOf(canvas.current) : { top: 0, left: 0, right: 0, bottom: 0 };
    return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  }, [canvas]);

  const openNode = useCallback((id: string, event: PointerLike) => {
    event.preventDefault();
    const element = nodeElement(id);
    show({ kind: "node", id }, point(event, element), "pointer", () => nodeElement(id));
  }, [nodeElement, show]);

  const openPane = useCallback((event: PointerLike) => {
    event.preventDefault();
    const zero = event.clientX === 0 && event.clientY === 0;
    show({ kind: "pane" }, zero ? centre() : { x: event.clientX, y: event.clientY }, "pointer", () => canvas.current);
  }, [canvas, centre, show]);

  const openSelection = useCallback((event: PointerLike) => {
    event.preventDefault();
    show({ kind: "selection" }, point(event, selectionElement()), "pointer", () => selectionElement() ?? canvas.current);
  }, [canvas, selectionElement, show]);

  const openFromKey = useCallback((target: HTMLElement | null) => {
    const node = target?.closest<HTMLElement>(NODE);
    if (target && node?.dataset.id) {
      const id = node.dataset.id;
      // The element that had the focus (a button inside the node, say) is where the user was: the node itself only when it is gone.
      show({ kind: "node", id }, { box: boxOf(node) }, "key", () => (target.isConnected ? target : nodeElement(id)));
    } else if (target?.closest(SELECTION)) {
      show({ kind: "selection" }, { box: boxOf(target.closest(SELECTION)!) }, "key", () => (target.isConnected ? target : canvas.current));
    } else {
      show({ kind: "pane" }, centre(), "key", () => (target?.isConnected ? target : canvas.current));
    }
  }, [canvas, centre, nodeElement, show]);

  return { menu, openNode, openPane, openSelection, openFromKey, close };
}
