import type { Edge, Node, NodeMouseHandler } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type FocusEventHandler, type MutableRefObject } from "react";
import { edgeIndex, FOCUS_CAP, focusIds, focusSet, pathEdgeIds } from "../lib/graphFocus";

/** How long the pointer must rest on a node before its path lights, and how long a leave waits before it clears (a new enter cancels the wait). */
export const HOVER_DWELL_MS = 120;
export const HOVER_GRACE_MS = 80;

const NODE = ".react-flow__node";

type Timer = MutableRefObject<ReturnType<typeof setTimeout> | null>;

export interface HighlightHandlers {
  onNodeMouseEnter: NodeMouseHandler;
  onNodeMouseLeave: NodeMouseHandler;
  onFocus: FocusEventHandler;
  onBlur: FocusEventHandler;
}

function stop(timer: Timer): void {
  if (timer.current !== null) clearTimeout(timer.current);
  timer.current = null;
}

// A touch screen emulates mouseenter on a tap and would leave the highlight stuck: hover counts only where the device can hover (true when unknown).
function canHover(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  try {
    return window.matchMedia("(hover: hover)").matches;
  } catch {
    return true;
  }
}

const nodeOf = (target: EventTarget | null): Element | null => (target instanceof Element ? target.closest(NODE) : null);

// The browser's own rule for "the keyboard put the focus here" (a click on a node's button is not it). A browser that cannot answer says no.
function keyboardFocus(target: Element): boolean {
  try {
    return target.matches(":focus-visible");
  } catch {
    return false;
  }
}

const withLit = (className: string | undefined): string => {
  if (!className) return "lit";
  return /(^|\s)lit(\s|$)/.test(className) ? className : `${className} lit`;
};

const NONE: string[] = [];

/**
 * The path highlight of the Discovery canvas. It does not dim anything itself: `active` is the wrapper's `has-focus` class, and only the nodes and
 * edges on the path come back as new objects with the class `lit` (every other object keeps its identity, so a hover re-renders a few nodes, not 2,000).
 * What it lights from: the hovered node, else the node the keyboard focused, else the selection; never while a drag runs.
 */
export function useGraphHighlight({ nodes, edges, selectedIds, dragging }: {
  nodes: Node[];
  edges: Edge[];
  selectedIds: readonly string[];
  dragging: boolean;
}): { shownNodes: Node[]; shownEdges: Edge[]; active: boolean; handlers: HighlightHandlers } {
  const [hover, setHover] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const dwell: Timer = useRef(null);
  const grace: Timer = useRef(null);

  useEffect(() => () => { stop(dwell); stop(grace); }, []);

  // One object for the life of the component: handing the canvas new handlers on every render would re-render it for nothing.
  const handlers = useMemo<HighlightHandlers>(() => ({
    onNodeMouseEnter: (_event, node) => {
      stop(grace); // a new enter cancels the pending clear: sweeping from node to node never flashes the canvas
      if (!canHover()) return;
      stop(dwell);
      const id = node.id;
      dwell.current = setTimeout(() => { dwell.current = null; setHover(id); }, HOVER_DWELL_MS);
    },
    onNodeMouseLeave: () => {
      stop(dwell); // the pointer left before it rested: nothing starts
      stop(grace);
      grace.current = setTimeout(() => { grace.current = null; setHover(null); }, HOVER_GRACE_MS);
    },
    onFocus: (event) => {
      const target = event.target;
      setFocused(target instanceof Element && keyboardFocus(target) ? nodeOf(target)?.getAttribute("data-id") ?? null : null);
    },
    onBlur: (event) => {
      const node = nodeOf(event.target);
      if (node && event.relatedTarget instanceof Element && node.contains(event.relatedTarget)) return; // the focus stays inside the same node
      setFocused(null);
    },
  }), []);

  const index = useMemo(() => edgeIndex(edges), [edges]);
  const ids = dragging ? NONE : focusIds({ hover, focused, selected: selectedIds });
  // A key that changes only when the ids do (the caller's array is new on every render); a selection over the cap lights nothing, so it needs no key.
  const key = ids.length === 0 || ids.length > FOCUS_CAP ? "" : JSON.stringify(ids);
  const set = useMemo(() => (key === "" ? null : focusSet(index, ids)), [index, key]); // eslint-disable-line react-hooks/exhaustive-deps -- `ids` is what `key` says
  const litEdgeIds = useMemo(() => (set ? pathEdgeIds(edges, set) : null), [edges, set]);

  const shownNodes = useMemo(
    () => (set ? nodes.map((n) => (set.has(n.id) ? { ...n, className: withLit(n.className) } : n)) : nodes),
    [nodes, set],
  );
  const shownEdges = useMemo(
    () => (litEdgeIds ? edges.map((e) => (litEdgeIds.has(e.id) ? { ...e, className: withLit(e.className) } : e)) : edges),
    [edges, litEdgeIds],
  );

  return { shownNodes, shownEdges, active: set !== null, handlers };
}
