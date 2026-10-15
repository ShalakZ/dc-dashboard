// Which nodes and edges to light when one (or a few) nodes are hovered, focused or selected on the Discovery canvas. Pure.
// An edge points from the source of the data to what is built on it: source -> group -> point -> asset -> sub-asset.

/** The most ids (hovered, focused or selected nodes) whose paths are lit at once, and the most nodes the lit paths may add up to. */
export const FOCUS_CAP = 20;
export const FOCUS_MAX_NODES = 400;

export interface EdgeIndex {
  /** id -> the ends of the edges that leave it. */
  readonly out: ReadonlyMap<string, readonly string[]>;
  /** id -> the starts of the edges that arrive at it. */
  readonly into: ReadonlyMap<string, readonly string[]>;
}

/** Two adjacency maps, built once per set of edges. */
export function edgeIndex(edges: readonly { source: string; target: string }[]): EdgeIndex {
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const { source, target } of edges) {
    const forward = out.get(source);
    if (forward) forward.push(target);
    else out.set(source, [target]);
    const back = into.get(target);
    if (back) back.push(source);
    else into.set(target, [source]);
  }
  return { out, into };
}

// Every node reachable from `id` by following the edges one way. Visited nodes are never queued again, so a cycle ends.
function reach(next: ReadonlyMap<string, readonly string[]>, id: string, found: Set<string>): void {
  const queue = [id];
  for (let i = 0; i < queue.length; i += 1) {
    for (const n of next.get(queue[i]) ?? []) {
      if (found.has(n)) continue;
      found.add(n);
      queue.push(n);
    }
  }
}

/** The node, everything it is built from (ancestors, through the edges backwards) and everything built on it (descendants, forwards). Never its siblings. */
export function pathOf(index: EdgeIndex, id: string): Set<string> {
  const found = new Set<string>([id]);
  reach(index.into, id, found);
  reach(index.out, id, found);
  return found;
}

/**
 * The union of the paths of `ids`, or null when there is nothing to show: no ids, more than `cap` of them, a union over `maxNodes` (a source with
 * thousands of drawn points would light everything and cost thousands of objects) or a union that is no bigger than the ids themselves (no edge to follow).
 */
export function focusSet(
  index: EdgeIndex,
  ids: readonly string[],
  { cap = FOCUS_CAP, maxNodes = FOCUS_MAX_NODES }: { cap?: number; maxNodes?: number } = {},
): Set<string> | null {
  const distinct = new Set(ids);
  if (distinct.size === 0 || distinct.size > cap) return null;
  const union = new Set<string>();
  for (const id of distinct) {
    for (const n of pathOf(index, id)) union.add(n);
    if (union.size > maxNodes) return null;
  }
  return union.size > distinct.size ? union : null;
}

/** The edges that run between two lit nodes. */
export function pathEdgeIds(edges: readonly { id: string; source: string; target: string }[], set: ReadonlySet<string>): Set<string> {
  const lit = new Set<string>();
  for (const edge of edges) if (set.has(edge.source) && set.has(edge.target)) lit.add(edge.id);
  return lit;
}

/**
 * What to light from: the hovered node, else the keyboard-focused one, else the selection. A selection lights only when it holds two or more nodes
 * (a box or a Ctrl selection is a deliberate "show me these"): a click, a right-click or a drag selects ONE node, and dimming the rest of the canvas
 * for it reads as "everything else is disabled" until the next click on the pane.
 */
export function focusIds(state: { hover: string | null; focused: string | null; selected: readonly string[] }): string[] {
  if (state.hover) return [state.hover];
  if (state.focused) return [state.focused];
  return state.selected.length >= 2 ? [...state.selected] : [];
}
