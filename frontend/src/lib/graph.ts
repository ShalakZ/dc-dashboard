import type { Edge, FitViewOptions, Node } from "@xyflow/react";
import type { Asset, GraphModel, GraphPoint, GraphSource, RemoveSourcesResult } from "../api/types";
import { isLive } from "./graphStatus";
import { relativeTime } from "./relativeTime";

/** Key of the pseudo-cluster that holds a source's points that have no cluster of their own. */
export const UNGROUPED = "__ungrouped__";

export const nodeId = {
  source: (id: number) => `src:${id}`,
  cluster: (sourceId: number, key: string) => `cluster:${sourceId}:${key}`,
  point: (id: number) => `point:${id}`,
  asset: (id: number) => `asset:${id}`,
  unidentified: (host: string, port: number) => `unid:${host}:${port}`,
};

export interface OpenState {
  sources: ReadonlySet<number>;
  /** Cluster node ids (`nodeId.cluster`). A cluster is only shown open while its source is. */
  clusters: ReadonlySet<string>;
}

/** Callbacks the page injects into `node.data`; a node renders the matching button only when its callback is present. */
export type NodeActions = {
  onToggle?: (nodeId: string) => void;
  onMap?: (nodeId: string) => void;
  onNewAsset?: (nodeId: string) => void;
  /** Open the details panel of a source: the keyboard path, since React Flow's Enter/Space on a node is not a click. */
  onSelect?: (nodeId: string) => void;
  /** Open the bulk dialog that makes one asset per group of a source (discovery.accept, and only while the source has a group to map). */
  onCreateAssets?: (nodeId: string) => void;
  /** Ask to remove a discovered source that has nothing mapped (discovery.edit). */
  onRemove?: (nodeId: string) => void;
  /** W12a: a mapped point or group, for a role with assets.edit: the small menu button on the node calls this with its own element, and the page opens the node's menu next to it (a menu inside the node would leak its keys into the canvas). */
  onMenu?: (button: HTMLElement) => void;
  /** W12a: the menu items "Unmap…" and "Move to another asset…" (a group: "this group"), given only to a role with assets.edit and only while something on the node is mapped. */
  onUnmap?: (nodeId: string) => void;
  onMove?: (nodeId: string) => void;
};
/** One source that has mappings on an asset, as the asset node's menu lists it (W12a). */
export type MappedSource = { sourceId: number; sourceName: string; count: number };
// These are `type`s, not interfaces: React Flow requires node data to be assignable to Record<string, unknown>.
export type SourceNodeData = NodeActions & {
  source: GraphSource; expanded: boolean;
  /** The muted line saying when a scan last found the source (`seenLine`); the page words it, since the time needs the site's clock. */
  seen?: string;
  /** How many groups "Create assets" would turn into assets: it is in the button's name. */
  groups?: number;
};
export type ClusterNodeData = NodeActions & {
  sourceId: number; key: string; label: string; count: number; mappedCount: number; expanded: boolean; ungrouped: boolean;
};
export type PointNodeData = NodeActions & { sourceId: number; clusterKey: string; point: GraphPoint };
export type AssetNodeData = NodeActions & {
  asset: GraphModel["assets"][number]; depth: number;
  /** W12a: the sources with mappings on this asset (at most five, by name), for a role with assets.edit; each is a menu item that takes them all off. */
  mapped?: MappedSource[];
  onUnmapSource?: (nodeId: string, sourceId: number) => void;
};
export type UnidentifiedNodeData = NodeActions & { host: string; port: number };

const X = { source: 0, cluster: 360, point: 720, asset: 1200 } as const;
/**
 * W7u: 224, not 220. The canvas snaps a drag to an 8 px grid, and every default place has to lie on it (else the first nudge of one node
 * lands it a few pixels from its untouched siblings): X above, SOURCE_H, BLOCK_GAP and ROW are multiples of 8, and so is this.
 */
const ASSET_INDENT = 224;
const ROW = 64;
export const BLOCK_GAP = 40;
/**
 * The room a source node takes: its title, one wrapping row of buttons (Details, Create assets, Remove), the facts line, the last-seen line
 * and the credentials badge. The first group sits this far below its source, and the next source clears the block by the gap, so a taller
 * source node (W7r) never lies over what comes after it. Measured in Chromium at the 220px node: 119px for a one-line name with the buttons on
 * two rows, 153px with a two-line name and the badge, 173px for a three-line name with the badge and a two-line facts line (the most seen), so
 * the first source of a collapsed graph is cleared by SOURCE_H + BLOCK_GAP = 176px.
 */
export const SOURCE_H = 136;
const DASHED = { strokeDasharray: "6 4" };
/**
 * A mapped link that flows: mostly solid with a small gap, so it still reads as a solid asset link. 8 + 2 is 10, the same period as the
 * discovered edges' "6 4" and as the library's `dashdraw` animation (it moves the dashes 10 px per loop), so both loop without a jump.
 * Without this the library's own `.animated path { stroke-dasharray: 5 }` would turn the solid links dashed.
 */
const LIVE_SOLID = { strokeDasharray: "8 2" };
/**
 * More animated edges than this and none are: every animated dash is repainted each frame, over a remote desktop that is screen traffic
 * (measured: 300 animated edges kept 14% of a core busy while idle, 100 about 7%).
 */
export const LIVE_EDGE_LIMIT = 100;

export interface Group { key: string; label: string; ungrouped: boolean; points: GraphPoint[] }

export function groupsOf(source: GraphSource): Group[] {
  const groups: Group[] = source.clusters.map((c) => ({ key: c.key, label: c.key, ungrouped: false, points: c.points }));
  if (source.ungrouped.length > 0) groups.push({ key: UNGROUPED, label: "Ungrouped", ungrouped: true, points: source.ungrouped });
  return groups;
}

/** Number of mapped points per existing asset. Points mapped to an asset that is not in the model are ignored. */
function countMapped(points: Iterable<GraphPoint>, assetIds: ReadonlySet<number>, into = new Map<number, number>()) {
  for (const p of points) {
    if (p.asset_id !== null && assetIds.has(p.asset_id)) into.set(p.asset_id, (into.get(p.asset_id) ?? 0) + 1);
  }
  return into;
}

export type XY = { x: number; y: number };

export interface BuildOptions {
  /** This session's places, from drags: they win over the saved layout. */
  moved?: ReadonlyMap<string, XY>;
  /** Leave the shared layout out (Tidy layout, until the graph has been read again). The places in `moved` still count. */
  ignoreSaved?: boolean;
  /**
   * Let the edges of live sources flow (`isLive`: enabled and online): their source to group edges and the solid links leaving their nodes get
   * `animated`. Never the group to point edges (hundreds of them, and they add little alive signal) nor the asset to sub-asset edges, and none at
   * all past `LIVE_EDGE_LIMIT`. The page passes false under reduced motion.
   */
  animate?: boolean;
}

/** The server refuses a layout id longer than this, and with it the whole request. */
export const MAX_LAYOUT_ID = 512;
/** The most nodes one layout request may carry (`LayoutIn.nodes`). */
export const LAYOUT_BATCH = 2000;

const NO_SHIFT: XY = { x: 0, y: 0 };

/**
 * The places a node can have of its own: the saved layout with this session's places over it, as a copy. A drag takes this snapshot at its
 * start, so the shift it works out never reads the live map while that is being updated.
 */
export function ownPlaces(model: GraphModel, options: BuildOptions = {}): Map<string, XY> {
  const places = new Map<string, XY>();
  if (!options.ignoreSaved) for (const [id, p] of Object.entries(model.layout)) places.set(id, { x: p.x, y: p.y });
  if (options.moved) for (const [id, p] of options.moved) places.set(id, { x: p.x, y: p.y });
  return places;
}

/**
 * The discovery graph as React Flow nodes and edges. Pure. A node stands at the place it has of its own (this session's `moved`, else the saved
 * layout), else at its default (a column layout: discovered nodes on the left, assets on the right) moved by however far its PARENT now stands
 * from the parent's default (source -> group -> point, asset -> sub-asset), so a child that was never placed opens beside its parent wherever
 * that is. A child's default offset from its parent does not depend on the other blocks, so it stays put when other sources open or close.
 * Sources and clusters only show their children while open.
 */
export function buildGraph(model: GraphModel, open: OpenState, options: BuildOptions = {}): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const assetIds = new Set<number>(model.assets.map((a) => a.id));

  const ownPlace = (id: string): XY | undefined => {
    const session = options.moved?.get(id);
    if (session) return session;
    return !options.ignoreSaved && Object.hasOwn(model.layout, id) ? model.layout[id] : undefined;
  };
  /** Adds a node and returns how far it stands from its own default, which is what its children follow. */
  const add = (id: string, type: string, x: number, y: number, data: Record<string, unknown>, parentShift: XY = NO_SHIFT): XY => {
    const own = ownPlace(id);
    const position = own ? { x: own.x, y: own.y } : { x: x + parentShift.x, y: y + parentShift.y };
    // No `draggable` of its own: React Flow lets a node's own `draggable: true` beat the canvas-wide `nodesDraggable`, and the page turns that off while a Tidy runs.
    nodes.push({ id, type, position, data });
    return { x: position.x - x, y: position.y - y };
  };
  /** The edges of live sources that were given `animated`: taken back together if there turn out to be too many. */
  const flowing: Edge[] = [];
  const link = (from: string, to: string, flow: boolean) => {
    const edge: Edge = { id: `e:${from}>${to}`, source: from, target: to, style: DASHED };
    if (flow) { edge.animated = true; flowing.push(edge); }
    edges.push(edge);
  };
  /** One edge per mapped asset; a count label when several points share it. */
  const mappedLinks = (from: string, counts: ReadonlyMap<number, number>, flow: boolean) => {
    for (const [assetId, n] of counts) {
      const target = nodeId.asset(assetId);
      const edge: Edge = { id: `m:${from}>${target}`, source: from, target, ...(n > 1 ? { label: `${n} mapped` } : {}) };
      if (flow) { edge.animated = true; edge.style = LIVE_SOLID; flowing.push(edge); }
      edges.push(edge);
    }
  };

  // Discovered side: sources in order, each in a block that grows with what is open under it.
  let cursor = 0;
  for (const source of model.sources) {
    const sid = nodeId.source(source.id);
    const flow = options.animate === true && isLive(source);
    const sourceOpen = open.sources.has(source.id);
    const sourceShift = add(sid, "source", X.source, cursor, { source, expanded: sourceOpen } satisfies SourceNodeData);
    let rows = 1;
    const groups = groupsOf(source);
    if (sourceOpen) {
      for (const group of groups) {
        const cid = nodeId.cluster(source.id, group.key);
        const clusterOpen = open.clusters.has(cid);
        const counts = countMapped(group.points, assetIds);
        let mappedCount = 0;
        for (const p of group.points) if (p.asset_id !== null) mappedCount++;
        const clusterShift = add(cid, "cluster", X.cluster, cursor + SOURCE_H + (rows - 1) * ROW, {
          sourceId: source.id, key: group.key, label: group.label, count: group.points.length, mappedCount,
          expanded: clusterOpen, ungrouped: group.ungrouped,
        } satisfies ClusterNodeData, sourceShift);
        link(sid, cid, flow);
        rows++;
        if (clusterOpen) {
          for (const p of group.points) {
            const pid = nodeId.point(p.id);
            add(pid, "point", X.point, cursor + SOURCE_H + (rows - 1) * ROW, { sourceId: source.id, clusterKey: group.key, point: p } satisfies PointNodeData, clusterShift);
            link(cid, pid, false); // a group's point edges are dashed but never flow: they are the bulk of a big graph's edges
            if (p.asset_id !== null && assetIds.has(p.asset_id)) mappedLinks(pid, new Map([[p.asset_id, 1]]), flow);
            rows++;
          }
        } else {
          mappedLinks(cid, counts, flow);
        }
      }
    } else {
      mappedLinks(sid, countMapped(groups.flatMap((g) => g.points), assetIds), flow);
    }
    cursor += SOURCE_H + (rows - 1) * ROW + BLOCK_GAP;
  }

  // Unidentified services wait in the source column below the last source.
  model.unidentified.forEach((u, i) => {
    add(nodeId.unidentified(u.host, u.port), "unidentified", X.source, cursor + i * ROW, { host: u.host, port: u.port } satisfies UnidentifiedNodeData);
  });

  // Assets: depth-first from the roots; an orphan, a self-parent or a member of a cycle is treated as a root.
  const childrenOf = new Map<number, Pick<Asset, "id" | "parent_id" | "name" | "kind">[]>();
  const roots: GraphModel["assets"] = [];
  for (const asset of model.assets) {
    if (asset.parent_id !== null && asset.parent_id !== asset.id && assetIds.has(asset.parent_id)) {
      const siblings = childrenOf.get(asset.parent_id);
      if (siblings) siblings.push(asset);
      else childrenOf.set(asset.parent_id, [asset]);
      edges.push({ id: `a:${asset.parent_id}>${asset.id}`, source: nodeId.asset(asset.parent_id), target: nodeId.asset(asset.id) });
    } else {
      roots.push(asset);
    }
  }
  const visited = new Set<number>();
  let index = 0;
  const walk = (root: GraphModel["assets"][number]) => {
    // The stack entry carries how far its parent stands from its default: the node this build descended from, which is already placed.
    // A walk root (a root, an orphan, a self-parent, the first member of a cycle) has none.
    const stack: { asset: GraphModel["assets"][number]; depth: number; parentShift?: XY }[] = [{ asset: root, depth: 0 }];
    while (stack.length > 0) {
      const { asset, depth, parentShift } = stack.pop()!;
      if (visited.has(asset.id)) continue;
      visited.add(asset.id);
      const shift = add(nodeId.asset(asset.id), "asset", X.asset + depth * ASSET_INDENT, index * ROW, { asset, depth } satisfies AssetNodeData, parentShift);
      index++;
      const children = childrenOf.get(asset.id) ?? [];
      for (let i = children.length - 1; i >= 0; i--) stack.push({ asset: children[i], depth: depth + 1, parentShift: shift });
    }
  };
  roots.forEach(walk);
  model.assets.forEach((asset) => { if (!visited.has(asset.id)) walk(asset); }); // pure parent cycles have no root

  // Too many flowing edges and none flow: each goes back to what it would be without `animate` (a solid link loses its 8 2 dashes).
  if (flowing.length > LIVE_EDGE_LIMIT) {
    for (const edge of flowing) {
      delete edge.animated;
      if (edge.id.startsWith("m:")) delete edge.style;
    }
  }
  return { nodes, edges };
}

/**
 * Every node under `id` in the model, open or not (a drag shifts the saved places of hidden children too): a source -> its groups, the
 * Ungrouped group when it has ungrouped points, and their points; a group -> its points; an asset -> all its sub-assets, at every depth (cycle
 * safe, never the asset itself). A point, an unidentified service and an id the model does not hold have none.
 */
export function descendantNodeIds(model: GraphModel, id: string): string[] {
  const found: string[] = [];
  if (id.startsWith("src:")) {
    const source = model.sources.find((s) => nodeId.source(s.id) === id);
    if (!source) return found;
    for (const group of groupsOf(source)) {
      found.push(nodeId.cluster(source.id, group.key));
      for (const p of group.points) found.push(nodeId.point(p.id));
    }
  } else if (id.startsWith("cluster:")) {
    // A group key may hold colons: match the whole id, built from each group, rather than splitting it.
    for (const source of model.sources) {
      if (!id.startsWith(`cluster:${source.id}:`)) continue;
      const group = groupsOf(source).find((g) => nodeId.cluster(source.id, g.key) === id);
      if (group) return group.points.map((p) => nodeId.point(p.id));
    }
  } else if (id.startsWith("asset:")) {
    const start = model.assets.find((a) => nodeId.asset(a.id) === id);
    if (!start) return found;
    const childrenOf = new Map<number, number[]>();
    for (const a of model.assets) {
      if (a.parent_id === null || a.parent_id === a.id) continue;
      const siblings = childrenOf.get(a.parent_id);
      if (siblings) siblings.push(a.id);
      else childrenOf.set(a.parent_id, [a.id]);
    }
    const seen = new Set<number>([start.id]);
    const stack = [...(childrenOf.get(start.id) ?? [])].reverse();
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      found.push(nodeId.asset(next));
      const below = childrenOf.get(next) ?? [];
      for (let i = below.length - 1; i >= 0; i--) stack.push(below[i]);
    }
  }
  return found;
}

/**
 * The nodes directly under `id`: a source's groups, a group's points, an asset's sub-assets (one level; `descendantNodeIds` is every level). An
 * Alt-drag pins these where they stand when they have no place of their own, so they do not follow the parent on the next rebuild.
 */
export function childNodeIds(model: GraphModel, id: string): string[] {
  if (id.startsWith("src:")) return descendantNodeIds(model, id).filter((d) => d.startsWith("cluster:"));
  if (id.startsWith("cluster:")) return descendantNodeIds(model, id);
  if (!id.startsWith("asset:")) return [];
  const parent = model.assets.find((a) => nodeId.asset(a.id) === id);
  return parent ? model.assets.filter((a) => a.parent_id === parent.id && a.id !== parent.id).map((a) => nodeId.asset(a.id)) : [];
}

/**
 * `snapshot + delta` for every id that has a place of its own IN THE SNAPSHOT (`ownPlaces`, taken when the drag began); an id with none is left
 * out, because it follows its parent by the rule of `buildGraph`. The snapshot is never changed, and an id listed twice is shifted once.
 */
export function shiftedPlaces(snapshot: ReadonlyMap<string, XY>, ids: Iterable<string>, delta: XY): Map<string, XY> {
  const shifted = new Map<string, XY>();
  for (const id of ids) {
    const own = snapshot.get(id);
    if (own) shifted.set(id, { x: own.x + delta.x, y: own.y + delta.y });
  }
  return shifted;
}

/** One entry of the body of `PUT /api/discovery/layout`. */
export interface LayoutEntry { node_id: string; x: number; y: number }

/**
 * The places to save, cut into request bodies of at most `size` entries (the route takes 2000), in order. An id over 512 characters is left out:
 * the server would refuse the whole request and every other place with it (the node stays where it was dragged for this session).
 */
export function layoutBatches(entries: Iterable<readonly [string, XY]>, size: number = LAYOUT_BATCH): LayoutEntry[][] {
  const per = size >= 1 ? Math.floor(size) : 1;
  const batches: LayoutEntry[][] = [];
  let current: LayoutEntry[] = [];
  for (const [id, p] of entries) {
    if (id.length > MAX_LAYOUT_ID) continue;
    if (current.length === per) { batches.push(current); current = []; }
    current.push({ node_id: id, x: p.x, y: p.y });
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const OPENING_SOURCES = 3;
/**
 * The part of the graph, in graph pixels, that still opens readable on a 1024x640 canvas at zoom 0.75 (the opening zoom's floor). The height was
 * 560 before the bar (the summary and its buttons: 36px and 8px under it) took 44 screen pixels from the canvas: 44 / 0.75 = 59 graph pixels.
 */
const OPENING_BOX = { w: 900, h: 560 - Math.ceil((36 + 8) / 0.75) } as const;
/** A source node's width on the canvas (`.gnode` is 220px wide). */
const SOURCE_W = 220;

/**
 * How the Discovery canvas opens: on the first few sources, large enough to read, instead of fitting the whole graph. The assets stand in a column
 * far to the right of the sources, so a tall asset column made the fit-all zoom out to React Flow's floor and push the sources, the only
 * nodes with Create assets and Remove, off the edge at a laptop's width (and render their text at 6 px at 1440). The zoom is held between 0.75
 * and 1, so the sources may fill the view and the assets lie outside it; the Controls' fit-view button shows everything (the canvas may zoom out
 * far enough for that).
 * The saved layout is shared, and an admin may have dragged sources far apart: fitting three sources 3000px apart at zoom 0.75 would centre the
 * view on the empty space between them. So the first source is always framed, and each next one only while it still lies within OPENING_BOX of
 * those already framed (a source with no saved position stands where `buildGraph` puts a collapsed one).
 * `undefined` with no source at all: the old fit-all (unidentified services only).
 */
export function initialView(model: GraphModel): FitViewOptions | undefined {
  if (model.sources.length === 0) return undefined;
  const at = (s: GraphSource, index: number) => {
    const saved = Object.hasOwn(model.layout, nodeId.source(s.id)) ? model.layout[nodeId.source(s.id)] : undefined;
    return saved ?? { x: X.source, y: index * (SOURCE_H + BLOCK_GAP) };
  };
  const framed = [model.sources[0]];
  const start = at(model.sources[0], 0);
  let [minX, maxX, minY, maxY] = [start.x, start.x, start.y, start.y];
  for (let i = 1; i < Math.min(OPENING_SOURCES, model.sources.length); i++) {
    const p = at(model.sources[i], i);
    const [nx0, nx1, ny0, ny1] = [Math.min(minX, p.x), Math.max(maxX, p.x), Math.min(minY, p.y), Math.max(maxY, p.y)];
    if (nx1 - nx0 + SOURCE_W > OPENING_BOX.w || ny1 - ny0 + SOURCE_H > OPENING_BOX.h) break;
    [minX, maxX, minY, maxY] = [nx0, nx1, ny0, ny1];
    framed.push(model.sources[i]);
  }
  return { nodes: framed.map((s) => ({ id: nodeId.source(s.id) })), minZoom: 0.75, maxZoom: 1, padding: 0.2 };
}

/** The points of a source, groups and the Ungrouped bag alike. */
const pointsOf = (source: GraphSource): GraphPoint[] => [...source.ungrouped, ...source.clusters.flatMap((c) => c.points)];

/**
 * Whether Remove and Clear unmapped may offer this source: it was found by a scan (never one added by hand) and no point of it is mapped. A point
 * with an asset counts as mapped even if its mapping id were missing. The server decides again on its own data, whatever this says.
 */
export function isRemovable(source: GraphSource): boolean {
  return source.origin === "discovered" && !pointsOf(source).some((p) => p.mapping_id !== null || p.asset_id !== null);
}

/** The muted line of a source node and its panel: when a scan last found it. `now` and the site's time zone are passed in (the "ago" part counts on the site's clock). */
export function seenLine(source: GraphSource, now: Date, timezone: string): string {
  if (source.origin === "manual") return "Added by hand"; // a scan that meets it only reports "existing source": there is no time worth showing
  const scan = source.last_scan;
  if (!scan) return "Not seen in a scan yet";
  const ago = relativeTime(scan.at, now, timezone);
  return ago ? `Seen in scan #${scan.scan_id}, ${ago}` : `Seen in scan #${scan.scan_id}`;
}

const sourcesWord = (n: number) => `${n} ${n === 1 ? "source" : "sources"}`;
const were = (n: number) => (n === 1 ? "was" : "were");

/** Why a source was left alone, for `n` of them: "it has a mapped point now" for one, "2 have a mapped point now" for several. */
const keptReason = (reason: "mapped" | "manual", n: number, alone: boolean): string => {
  if (reason === "mapped") return alone ? "it has a mapped point now" : `${n} ${n === 1 ? "has" : "have"} a mapped point now`;
  return alone ? "it was added by hand" : `${n} ${were(n)} added by hand`;
};

export type RemovalOutcome =
  /** Everything that was asked is removed. */
  | { kind: "done"; text: string }
  /** Some are removed and some were kept or already gone. */
  | { kind: "partial"; text: string }
  /** Nothing is removed because something was kept: the dialog stays open and says so. */
  | { kind: "none"; text: string }
  /** Nothing is removed because every one was already gone: there is nothing left to do. */
  | { kind: "gone"; text: string };

/** What the answer of the remove route means for the person: the words, and which of the four cases it is. */
export function removalOutcome({ removed, skipped }: RemoveSourcesResult): RemovalOutcome {
  const kept = skipped.filter((s) => s.reason !== "gone");
  const gone = skipped.length - kept.length;
  if (skipped.length === 0) return { kind: "done", text: `Removed ${sourcesWord(removed.length)}` };
  const parts: string[] = [];
  if (kept.length > 0) {
    const reasons = (["mapped", "manual"] as const)
      .map((reason) => [reason, kept.filter((s) => s.reason === reason).length] as const)
      .filter(([, n]) => n > 0)
      .map(([reason, n]) => keptReason(reason, n, kept.length === 1));
    parts.push(`${kept.length} ${were(kept.length)} kept: ${reasons.join(", ")}.`);
  }
  if (gone > 0) parts.push(`${gone} ${were(gone)} already gone.`);
  const lead = removed.length > 0 ? `Removed ${sourcesWord(removed.length)}.` : "Nothing was removed.";
  const text = [lead, ...parts].join(" ");
  if (removed.length > 0) return { kind: "partial", text };
  return { kind: kept.length > 0 ? "none" : "gone", text };
}

const NAMED = 5;

/** "A and B", "A, B and C", and past five "A, B, C, D, E and 2 more": the names a Clear unmapped lists. */
function nameList(names: readonly string[]): string {
  if (names.length > NAMED) return `${names.slice(0, NAMED).join(", ")} and ${names.length - NAMED} more`;
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The title and the sentence of the delete dialog for Remove (one source) and Clear unmapped (several). The list is the one the person was shown. */
export function removalDialogText(names: readonly string[]): { title: string; message: string } {
  if (names.length === 1) {
    return {
      title: `Remove "${names[0]}" from Discovery?`,
      message: "It has nothing mapped, so no asset, billing figure or dashboard depends on it. A scan can find it again.",
    };
  }
  return {
    title: `Remove ${names.length} unmapped sources?`,
    message: `${nameList(names)}. Sources with a mapped point are never touched. A scan can find these again.`,
  };
}
