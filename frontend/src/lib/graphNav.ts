import type { Node } from "@xyflow/react";
import { nodeId } from "./graph";

/**
 * W12b: the keyboard model of the Discovery canvas, pure. The arrow keys walk the tree the canvas draws: up and down go to the previous or next
 * sibling, left to the parent, right to the first child. Two columns exist and never mix: the discovered one (sources, their groups and points,
 * the "show more" nodes and the unidentified services) and the assets one. The nodes are given in draw order, which is the order of the keys.
 */
export type NavMove = "up" | "down" | "left" | "right";

type Column = "discovered" | "assets";

export interface NavIndex {
  /** Parent id of a drawn node (null for a root). */
  readonly parent: ReadonlyMap<string, string | null>;
  /** Siblings in draw order under one key: the parent id, or a column key for the roots. */
  readonly siblings: ReadonlyMap<string, readonly string[]>;
  /** Where a node sits: the key of its sibling list and its place in it. */
  readonly place: ReadonlyMap<string, { key: string; at: number }>;
  readonly first: string | null;
  readonly firstDiscovered: string | null;
}

const rootKey = (column: Column) => `root:${column}`;

const columnOf = (node: Node): Column => (node.type === "asset" ? "assets" : "discovered");

/** The id of the node a node hangs under, from its data. It may name a node that is not drawn. */
function parentOf(node: Node): string | null {
  const data = (node.data ?? {}) as Record<string, unknown>;
  switch (node.type) {
    case "cluster":
      return typeof data.sourceId === "number" ? nodeId.source(data.sourceId) : null;
    case "point":
      return typeof data.sourceId === "number" && typeof data.clusterKey === "string" ? nodeId.cluster(data.sourceId, data.clusterKey) : null;
    case "more":
      return typeof data.clusterId === "string" ? data.clusterId : null;
    case "asset":
      return typeof data.navParent === "string" ? data.navParent : null;
    default:
      return null;
  }
}

export function navIndex(nodes: readonly Node[]): NavIndex {
  const drawn = new Set<string>();
  for (const node of nodes) drawn.add(node.id);

  const parent = new Map<string, string | null>();
  const siblings = new Map<string, string[]>();
  const place = new Map<string, { key: string; at: number }>();
  const add = (node: Node) => {
    const named = parentOf(node);
    // A parent that is not drawn (or is the node itself) means no parent: the node is a root of its column.
    const up = named !== null && named !== node.id && drawn.has(named) ? named : null;
    const key = up ?? rootKey(columnOf(node));
    let list = siblings.get(key);
    if (!list) siblings.set(key, (list = []));
    parent.set(node.id, up);
    place.set(node.id, { key, at: list.length });
    list.push(node.id);
  };

  // The "show more" node is the last child of its group wherever it was drawn, so it goes in after everything else.
  const seen = new Set<string>();
  const late: Node[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.type === "more") late.push(node);
    else add(node);
  }
  for (const node of late) add(node);

  return {
    parent,
    siblings,
    place,
    first: nodes.length > 0 ? nodes[0].id : null,
    firstDiscovered: siblings.get(rootKey("discovered"))?.[0] ?? null,
  };
}

/** The node an arrow key goes to from `from`, or null to stay where it is. An id that is not drawn gives null. */
export function navTarget(index: NavIndex, from: string, move: NavMove): string | null {
  const at = index.place.get(from);
  if (!at) return null;
  switch (move) {
    case "left":
      return index.parent.get(from) ?? null;
    case "right":
      return index.siblings.get(from)?.[0] ?? null;
    case "up":
      return at.at > 0 ? (index.siblings.get(at.key)?.[at.at - 1] ?? null) : null;
    case "down":
      return index.siblings.get(at.key)?.[at.at + 1] ?? null;
  }
}

/** Where the arrows start when nothing is focused: the first node of the discovered column, else the first node drawn. */
export function navFirst(index: NavIndex): string | null {
  return index.firstDiscovered ?? index.first;
}
