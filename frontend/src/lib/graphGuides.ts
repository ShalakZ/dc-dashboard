export interface Rect { x: number; y: number; w: number; h: number }
export interface Guide { at: number; from: number; to: number }
export interface Guides { vertical: Guide[]; horizontal: Guide[] }

/** Only this many of the nodes nearest to the dragged one are looked at: 2,000 nodes are no more work per frame than 200. */
export const GUIDE_CAP = 200;
/** How far apart two lines may be, in graph pixels, and still count as one. */
export const GUIDE_TOLERANCE = 1;
/** A guide reaches this far past the two nodes it joins. */
export const GUIDE_PAD = 24;

export interface GuideOptions { cap?: number; tolerance?: number }

/** The `cap` nodes whose centres are nearest to the dragged node's centre; a tie at the edge of the cap keeps the earlier node. */
function nearest(dragged: Rect, others: readonly Rect[], cap: number): readonly Rect[] {
  if (cap <= 0) return [];
  if (others.length <= cap) return others;
  const cx = dragged.x + dragged.w / 2;
  const cy = dragged.y + dragged.h / 2;
  const distance = new Float64Array(others.length);
  for (let i = 0; i < others.length; i++) {
    const o = others[i];
    const dx = o.x + o.w / 2 - cx;
    const dy = o.y + o.h / 2 - cy;
    distance[i] = dx * dx + dy * dy;
  }
  const limit = Float64Array.from(distance).sort()[cap - 1];
  const picked: Rect[] = [];
  for (let i = 0; i < others.length; i++) if (distance[i] < limit) picked.push(others[i]);
  for (let i = 0; i < others.length && picked.length < cap; i++) if (distance[i] === limit) picked.push(others[i]);
  return picked;
}

/**
 * The guides for one axis. `along` is the axis the lines are measured on (x: vertical lines), the other axis is the one a guide runs along. A
 * guide is drawn for each of the dragged node's three lines (start, middle, end) that any of the other nodes' three lines is within the
 * tolerance of, so an edge also lines up with the opposite edge of a neighbour. One guide per line, however many nodes share it.
 */
function guidesOn(dragged: Rect, near: readonly Rect[], along: "x" | "y", tolerance: number): Guide[] {
  const [lo, size, runLo, runSize] = along === "x" ? (["x", "w", "y", "h"] as const) : (["y", "h", "x", "w"] as const);
  const reach = tolerance + 1e-9;
  const guides: Guide[] = [];
  for (const line of [dragged[lo], dragged[lo] + dragged[size] / 2, dragged[lo] + dragged[size]]) {
    if (guides.length > 0 && guides[guides.length - 1].at === line) continue; // a node with no size has one line, not three
    let from = Infinity;
    let to = -Infinity;
    for (const o of near) {
      const start = o[lo];
      const end = start + o[size];
      if (Math.abs(start - line) <= reach || Math.abs(start + o[size] / 2 - line) <= reach || Math.abs(end - line) <= reach) {
        if (o[runLo] < from) from = o[runLo];
        if (o[runLo] + o[runSize] > to) to = o[runLo] + o[runSize];
      }
    }
    if (from <= to) {
      guides.push({ at: line, from: Math.min(from, dragged[runLo]) - GUIDE_PAD, to: Math.max(to, dragged[runLo] + dragged[runSize]) + GUIDE_PAD });
    }
  }
  return guides;
}

/**
 * The alignment guides of a node being dragged: a vertical guide where its left edge, centre or right edge lines up with an edge or centre of
 * another node (within `tolerance` graph pixels), a horizontal one for its top, middle or bottom. Each guide spans the nodes it joins plus 24
 * graph pixels at both ends. Only the `cap` nearest nodes are looked at. Pure and cheap enough for every drag frame; it never moves anything
 * (no magnet: the position the drag reports is the one the followers and the drop are worked out from).
 */
export function alignGuides(dragged: Rect, others: readonly Rect[], options: GuideOptions = {}): Guides {
  const near = nearest(dragged, others, options.cap ?? GUIDE_CAP);
  const tolerance = options.tolerance ?? GUIDE_TOLERANCE;
  return { vertical: guidesOn(dragged, near, "x", tolerance), horizontal: guidesOn(dragged, near, "y", tolerance) };
}
