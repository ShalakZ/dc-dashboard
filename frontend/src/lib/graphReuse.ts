// Keeps the Discovery canvas's unchanged nodes and edges as the SAME objects across a rebuild, so React Flow (which compares by identity) re-renders
// only what really changed. Pure: nothing is remembered between calls, so repeated toggles cannot make anything grow.
import type { Edge, Node } from "@xyflow/react";

/** Same keys and `Object.is` per value; two missing objects are equal, one missing and one present are not. */
function shallowEqual(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) if (!Object.hasOwn(right, key) || !Object.is(left[key], right[key])) return false;
  return true;
}

/**
 * Only what the build decides is compared. `selected`, `measured`, `dragging`, `width` and `height` belong to React Flow (it writes them after the
 * build), so a selected, measured node is "unchanged" when the build gave it the same type, place, class, label, flags and data.
 */
function sameNode(a: Node, b: Node): boolean {
  return (
    a.type === b.type &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.className === b.className &&
    a.ariaLabel === b.ariaLabel &&
    a.draggable === b.draggable &&
    a.selectable === b.selectable &&
    a.focusable === b.focusable &&
    shallowEqual(a.data, b.data)
  );
}

function sameEdge(a: Edge, b: Edge): boolean {
  return (
    a.source === b.source &&
    a.target === b.target &&
    a.sourceHandle === b.sourceHandle &&
    a.targetHandle === b.targetHandle &&
    a.label === b.label &&
    a.animated === b.animated &&
    a.className === b.className &&
    a.type === b.type &&
    shallowEqual(a.style, b.style)
  );
}

/** True when `result` is `previous` element for element: the caller can then hand the previous array back and React skips the update. */
function unchanged<T>(previous: readonly T[], result: readonly T[]): boolean {
  return previous.length === result.length && result.every((item, i) => item === previous[i]);
}

/**
 * The nodes of a rebuild, with every unchanged one the OLD object. A changed one is the new object plus what React Flow knows and a rebuild lacks: its
 * measured size (a node without one stays hidden until it is measured again) and its selection (an expand, a collapse or a refresh keeps the selected
 * nodes that are still there selected). Returns `previous` itself when nothing at all changed.
 */
export function reuseNodes(previous: readonly Node[], next: readonly Node[]): Node[] {
  const known = new Map<string, Node>();
  for (const n of previous) known.set(n.id, n);
  const result = next.map((n) => {
    const was = known.get(n.id);
    if (!was) return n;
    if (sameNode(was, n)) return was;
    if (!was.measured && !was.selected) return n;
    return { ...n, ...(was.measured ? { measured: was.measured } : {}), ...(was.selected ? { selected: true } : {}) };
  });
  return unchanged(previous, result) ? (previous as Node[]) : result;
}

/** The edges of a rebuild, with every unchanged one the OLD object. Returns `previous` itself when nothing at all changed. */
export function reuseEdges(previous: readonly Edge[], next: readonly Edge[]): Edge[] {
  const known = new Map<string, Edge>();
  for (const e of previous) known.set(e.id, e);
  const result = next.map((e) => {
    const was = known.get(e.id);
    return was && sameEdge(was, e) ? was : e;
  });
  return unchanged(previous, result) ? (previous as Edge[]) : result;
}
