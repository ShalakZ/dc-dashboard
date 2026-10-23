import type { Edge, FitViewOptions, Node } from "@xyflow/react";
import type { Asset, GraphModel, GraphPoint, GraphSource, RemoveSourcesResult, SourceMoveCandidateForNew } from "../api/types";
import { isLive, sourceTitle } from "./graphStatus";
import { hostPortOfEndpoint, twoServersText } from "./moves";
import { relativeTime } from "./relativeTime";

/** Key of the pseudo-cluster that holds a source's points that have no cluster of their own. */
export const UNGROUPED = "__ungrouped__";

export const nodeId = {
  source: (id: number) => `src:${id}`,
  cluster: (sourceId: number, key: string) => `cluster:${sourceId}:${key}`,
  point: (id: number) => `point:${id}`,
  asset: (id: number) => `asset:${id}`,
  unidentified: (host: string, port: number) => `unid:${host}:${port}`,
  /** W12b: the "Show 50 more" control at the end of an open group's points. It has no place of its own (it is never saved to the layout). */
  more: (clusterId: string) => `more:${clusterId}`,
};

/** W12b: an open group draws this many points at first; "Show 50 more" adds this many again. */
export const PAGE_SIZE = 50;
/**
 * W12b: a group that draws more points than this draws the edges from the group to its points SOLID. A dashed edge costs the browser one dash per few
 * pixels of its length, and these edges are as long as the list is tall, so the cost grows with the square of the points: measured, a drag stays at
 * 60 frames per second up to 300 points and falls to 24 at 500 and 8 at 1,000 (and stays at 60 with the dashes off).
 */
export const FAN_DASH_LIMIT = 150;

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
  /** (w33) Open the move dialog for a new source that looks like an old one that stopped answering: given only with sources.edit and only while the source has an offer (`moveOfferFor`). */
  onMoveSource?: (nodeId: string) => void;
  /** W12a: a mapped point or group, for a role with assets.edit: the small menu button on the node calls this with its own element, and the page opens the node's menu next to it (a menu inside the node would leak its keys into the canvas). */
  onMenu?: (button: HTMLElement) => void;
  /** W12a: the menu items "Unmap…" and "Move to another asset…" (a group: "this group"), given only to a role with assets.edit and only while something on the node is mapped. */
  onUnmap?: (nodeId: string) => void;
  onMove?: (nodeId: string) => void;
  /** W12a: the "+" on an asset node (assets.edit and assets.view): opens New sub-asset with this asset as the parent. Also the menu item "New sub-asset…". */
  onAdd?: (nodeId: string) => void;
  /** W12a: an unmapped point's New asset… in its right-click menu only (the node draws no button for it: a point has Map… and nothing else). */
  menuNewAsset?: (nodeId: string) => void;
  /** W12a: the asset list the New asset form needs is not read yet: the buttons that open it (a group's New asset…, the "+") say so with aria-disabled. */
  formWait?: boolean;
  /** W12b: the `more` node's button: show the next page of a group's points (the argument is the group's node id). */
  onMore?: (clusterId: string) => void;
  /** W12b: an asset node with sub-assets: hide or show them (given to every role: it only changes the view). */
  onToggleAssets?: (nodeId: string) => void;
};
/** One source that has mappings on an asset, as the asset node's menu lists it (W12a). */
export type MappedSource = { sourceId: number; sourceName: string; count: number };
// These are `type`s, not interfaces: React Flow requires node data to be assignable to Record<string, unknown>.
export type SourceNodeData = NodeActions & {
  source: GraphSource; expanded: boolean;
  /** The muted line saying when a scan last found the source (`seenLine`); the page words it, since the time needs the site's clock. */
  seen?: string;
  /** (w33) The whole sentence for an offer (`looksLikeSentence` with the time the page formatted in the site's zone): the card's tooltip. Absent = the card words it without a time. */
  looks?: string;
  /** How many groups "Create assets" would turn into assets: it is in the button's name. */
  groups?: number;
};
export type ClusterNodeData = NodeActions & {
  sourceId: number; key: string; label: string; count: number; mappedCount: number; expanded: boolean; ungrouped: boolean;
  /** W12b: the points the "Unmapped only" filter lets through, and how many of them an open group draws (the page; `count` stays the total). Absent = `count`. */
  visibleCount?: number; shownCount?: number;
  /** (w34) How many of the group's points can still be offered for mapping (`isOfferable`: not mapped, not the twin of a mapped point). Absent = `count - mappedCount`. */
  offerable?: number;
};
/** (w34) `twinOf` is set on a point that is the same tag as a mapped point of its source: the name of that point (or a stand-in when it is not in the graph). Such a node offers no Map. */
export type PointNodeData = NodeActions & { sourceId: number; clusterKey: string; point: GraphPoint; twinOf?: string };
/** W12b: the "Show 50 more (70 left)" control at the end of a paged group's points. `step` is how many the next press adds (the page, or what is left). */
export type MoreNodeData = NodeActions & { clusterId: string; label: string; left: number; step: number };
export type AssetNodeData = NodeActions & {
  /** W12b: `children` = how many sub-assets it has; `collapsed` = they are hidden; `mappedInside` = points mapped to it or anything under it (a collapsed asset only); `navParent` = the node id of the asset this one was reached from in the walk (null for a walk root). */
  children?: number; collapsed?: boolean; mappedInside?: number; navParent?: string | null;
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
/** The fan-out edges of a group past `FAN_DASH_LIMIT` points: no `strokeDasharray`, so the edge is a solid line (see the limit). */
const SOLID_FAN = {};
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

/**
 * W12b: how the graph is looked at, over and above what is open. Every field has a neutral default (`NO_VIEW`): no filter, nothing paged, no asset
 * folded, so a caller that passes no view gets exactly the graph it always got.
 */
export interface GraphView {
  /** "Unmapped only": mapped points, groups whose points are all mapped and sources with nothing left to map are not drawn, and no mapped edge is. */
  unmappedOnly: boolean;
  /**
   * (w33) "Not seen lately": only the discovered sources the newest done scan of their range did not find are drawn (`isNotSeen`). Optional, so every caller
   * that builds a view by hand keeps working; absent = off. Session only. The page turns it off by itself when no source is marked any more.
   */
  notSeenOnly?: boolean;
  /** Group node id -> how many of its (visible) points the page shows. Absent = `pageSize`. Session only; `pruneShown` drops the entries of closed groups. */
  shown: ReadonlyMap<string, number>;
  /** Asset ids whose sub-assets are hidden. */
  assetsClosed: ReadonlySet<number>;
  /** An open group with more visible points than this draws this many and a `more` node. `Infinity` = never page (the old behaviour). */
  pageSize: number;
}
export const NO_VIEW: GraphView = Object.freeze({ unmappedOnly: false, shown: new Map<string, number>(), assetsClosed: new Set<number>(), pageSize: Infinity });

/**
 * (w34) A point Discovery may offer for mapping: it has no asset and it is not the same tag as a point of its source that has one (`same_tag_as`).
 * Every place that means "an unmapped point that can be offered" (the filter, the bulk and drop lists) asks this; a place that means "is mapped" keeps `asset_id !== null`.
 */
export const isOfferable = (point: GraphPoint): boolean => point.asset_id === null && !point.same_tag_as;

/** The points of a group the view lets through. "Mapped" is `asset_id !== null` (the summary, the group's count); the filter keeps what can still be offered (`isOfferable`). */
export function visiblePoints(group: Group, view: GraphView): GraphPoint[] {
  return view.unmappedOnly ? group.points.filter(isOfferable) : group.points;
}

/** How many points an OPEN group draws: all the visible ones, or the page when there are more than a page. */
export function drawnCount(group: Group, clusterId: string, view: GraphView): number {
  const visible = visiblePoints(group, view).length;
  return visible <= view.pageSize ? visible : Math.min(visible, view.shown.get(clusterId) ?? view.pageSize);
}

/** A group is hidden by the filter when it has points and every one of them is mapped. A group with no points stays (it is not "all mapped"). */
export function groupVisible(group: Group, view: GraphView): boolean {
  return !view.unmappedOnly || group.points.length === 0 || group.points.some(isOfferable);
}

/**
 * A source is hidden by "Unmapped only" when it has at least one point and every point is mapped. A source with no points stays (it may need credentials).
 * (w33) "Not seen lately" hides every source that is not marked not seen; the two filters add up.
 */
export function sourceVisible(source: GraphSource, view: GraphView): boolean {
  if (view.notSeenOnly && !isNotSeen(source)) return false;
  if (!view.unmappedOnly) return true;
  const groups = groupsOf(source);
  const total = groups.reduce((n, g) => n + g.points.length, 0);
  return total === 0 || groups.some((g) => g.points.some(isOfferable));
}

/** The page extents of groups that are still open (a closed group, or one of a closed source, starts again at one page). New map; the one passed in is never changed. */
export function pruneShown(shown: ReadonlyMap<string, number>, open: OpenState): ReadonlyMap<string, number> {
  const kept = new Map<string, number>();
  for (const [id, n] of shown) {
    const sourceId = Number(id.split(":")[1]);
    if (open.clusters.has(id) && open.sources.has(sourceId)) kept.set(id, n);
  }
  return kept.size === shown.size ? shown : kept;
}

/**
 * The `more` node ids a drag takes along: a source's groups' (every group, drawn or not: the caller keeps the ones that are on the canvas) or one
 * group's. They are NOT in `descendantNodeIds`: that list also feeds the places that are saved, and a `more` node never has a place of its own.
 */
export function moreNodeIds(model: GraphModel, id: string): string[] {
  if (id.startsWith("src:")) {
    const source = model.sources.find((s) => nodeId.source(s.id) === id);
    return source ? groupsOf(source).map((g) => nodeId.more(nodeId.cluster(source.id, g.key))) : [];
  }
  if (!id.startsWith("cluster:")) return [];
  for (const source of model.sources) {
    if (id.startsWith(`cluster:${source.id}:`) && groupsOf(source).some((g) => nodeId.cluster(source.id, g.key) === id)) return [nodeId.more(id)];
  }
  return [];
}

/**
 * Number of mapped points per DRAWN asset: `visibleOf` turns the asset a point is mapped to into the asset that stands for it on the canvas (itself,
 * or the closed asset that hides it), and the counts are summed by that target BEFORE any edge is built, so two points under one closed asset make
 * one edge labelled "2 mapped". Points mapped to an asset that is not in the model are ignored.
 */
function countMapped(points: Iterable<GraphPoint>, assetIds: ReadonlySet<number>, visibleOf: (assetId: number) => number, into = new Map<number, number>()) {
  for (const p of points) {
    if (p.asset_id === null || !assetIds.has(p.asset_id)) continue;
    const target = visibleOf(p.asset_id);
    into.set(target, (into.get(target) ?? 0) + 1);
  }
  return into;
}

const countOf = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
  /** W12b: the filter, the pages and the folded assets. Absent = `NO_VIEW`. */
  view?: GraphView;
}

/** The server refuses a layout id longer than this, and with it the whole request. */
export const MAX_LAYOUT_ID = 512;
/** The most nodes one layout request may carry (`LayoutIn.nodes`). */
export const LAYOUT_BATCH = 2000;

const NO_SHIFT: XY = { x: 0, y: 0 };

/** The "Show 50 more" node of a paged group: it follows its group (and the group's source) and is never saved to the layout or read from it. */
const isMoreId = (id: string): boolean => id.startsWith("more:");

/**
 * The places a node can have of its own: the saved layout with this session's places over it, as a copy. A drag takes this snapshot at its
 * start, so the shift it works out never reads the live map while that is being updated. A `more` node never has a place of its own, so none is returned.
 */
export function ownPlaces(model: GraphModel, options: BuildOptions = {}): Map<string, XY> {
  const places = new Map<string, XY>();
  if (!options.ignoreSaved) for (const [id, p] of Object.entries(model.layout)) if (!isMoreId(id)) places.set(id, { x: p.x, y: p.y });
  if (options.moved) for (const [id, p] of options.moved) if (!isMoreId(id)) places.set(id, { x: p.x, y: p.y });
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
  const view = options.view ?? NO_VIEW;
  const filtering = view.unmappedOnly;
  const assetIds = new Set<number>(model.assets.map((a) => a.id));
  const assetNames = new Map<number, string>(model.assets.map((a) => [a.id, a.name]));

  const ownPlace = (id: string): XY | undefined => {
    if (isMoreId(id)) return undefined;
    const session = options.moved?.get(id);
    if (session) return session;
    return !options.ignoreSaved && Object.hasOwn(model.layout, id) ? model.layout[id] : undefined;
  };
  /** Adds a node and returns how far it stands from its own default, which is what its children follow. `extra` = the node's own flags and `ariaLabel`. */
  const add = (id: string, type: string, x: number, y: number, data: Record<string, unknown>, parentShift: XY = NO_SHIFT, extra: Partial<Node> = {}): XY => {
    const own = ownPlace(id);
    const position = own ? { x: own.x, y: own.y } : { x: x + parentShift.x, y: y + parentShift.y };
    // No `draggable` of its own (bar the `more` node's `false`): React Flow lets a node's own `draggable: true` beat the canvas-wide `nodesDraggable`, and the page turns that off while a Tidy runs.
    nodes.push({ id, type, position, data, ...extra });
    return { x: position.x - x, y: position.y - y };
  };
  /** The edges of live sources that were given `animated`: taken back together if there turn out to be too many. */
  const flowing: Edge[] = [];
  const link = (from: string, to: string, flow: boolean, style: Edge["style"] = DASHED) => {
    const edge: Edge = { id: `e:${from}>${to}`, source: from, target: to, style };
    if (flow) { edge.animated = true; flowing.push(edge); }
    edges.push(edge);
  };
  /** One edge per mapped asset (`counts` is keyed by the DRAWN asset, see `countMapped`); a count label when several points share it. */
  const mappedLinks = (from: string, counts: ReadonlyMap<number, number>, flow: boolean) => {
    for (const [assetId, n] of counts) {
      const target = nodeId.asset(assetId);
      const edge: Edge = { id: `m:${from}>${target}`, source: from, target, ...(n > 1 ? { label: `${n} mapped` } : {}) };
      if (flow) { edge.animated = true; edge.style = LIVE_SOLID; flowing.push(edge); }
      edges.push(edge);
    }
  };

  // Assets are PLANNED first (the nodes are added after the discovered side, as they always were), because a mapped edge points at the asset that is
  // drawn: depth-first from the roots; an orphan, a self-parent or a member of a cycle is treated as a root. At a closed asset the walk goes on
  // through its subtree WITHOUT drawing it: every asset in there is marked visited (so none is drawn, or taken for the head of a cycle) and is
  // recorded under the closed asset that hides it. A closed asset inside a closed one is never reached by the walk, so the outermost one stands for all.
  const childrenOf = new Map<number, Pick<Asset, "id" | "parent_id" | "name" | "kind">[]>();
  const roots: GraphModel["assets"] = [];
  const parentLinks: [number, number][] = [];
  for (const asset of model.assets) {
    if (asset.parent_id !== null && asset.parent_id !== asset.id && assetIds.has(asset.parent_id)) {
      const siblings = childrenOf.get(asset.parent_id);
      if (siblings) siblings.push(asset);
      else childrenOf.set(asset.parent_id, [asset]);
      parentLinks.push([asset.parent_id, asset.id]);
    } else {
      roots.push(asset);
    }
  }
  const visited = new Set<number>();
  const representative = new Map<number, number>();
  /** The assets to draw, in the order of the walk; `parent` = the asset the walk came from (null for a walk root: a root, an orphan, a self-parent, the head of a cycle). */
  const plan: { asset: GraphModel["assets"][number]; depth: number; parent: number | null }[] = [];
  const fold = (closedId: number) => {
    const pending = [...(childrenOf.get(closedId) ?? [])];
    while (pending.length > 0) {
      const hidden = pending.pop()!;
      if (visited.has(hidden.id)) continue;
      visited.add(hidden.id);
      representative.set(hidden.id, closedId);
      for (const child of childrenOf.get(hidden.id) ?? []) pending.push(child);
    }
  };
  const walk = (root: GraphModel["assets"][number]) => {
    const stack: { asset: GraphModel["assets"][number]; depth: number; parent: number | null }[] = [{ asset: root, depth: 0, parent: null }];
    while (stack.length > 0) {
      const { asset, depth, parent } = stack.pop()!;
      if (visited.has(asset.id)) continue;
      visited.add(asset.id);
      plan.push({ asset, depth, parent });
      if (view.assetsClosed.has(asset.id)) { fold(asset.id); continue; }
      const children = childrenOf.get(asset.id) ?? [];
      for (let i = children.length - 1; i >= 0; i--) stack.push({ asset: children[i], depth: depth + 1, parent: asset.id });
    }
  };
  roots.forEach(walk);
  model.assets.forEach((asset) => { if (!visited.has(asset.id)) walk(asset); }); // pure parent cycles have no root
  /** The asset a mapping is drawn to: the asset itself, or the closed asset that hides it. */
  const visibleOf = (assetId: number): number => representative.get(assetId) ?? assetId;

  // Discovered side: sources in order, each in a block that grows with what is open under it. A source the filter hides takes no room.
  let cursor = 0;
  for (const source of model.sources) {
    if (!sourceVisible(source, view)) continue;
    const sid = nodeId.source(source.id);
    const flow = options.animate === true && isLive(source);
    const sourceOpen = open.sources.has(source.id);
    const allGroups = groupsOf(source);
    const totalPoints = allGroups.reduce((n, g) => n + g.points.length, 0);
    const sourceShift = add(sid, "source", X.source, cursor, { source, expanded: sourceOpen } satisfies SourceNodeData, NO_SHIFT, {
      ariaLabel: `${source.name}, source, ${countOf(allGroups.length, "group")}, ${countOf(totalPoints, "point")}, ${sourceOpen ? "open" : "closed"}`,
    });
    let rows = 1;
    let twinNames: Map<number, string> | undefined; // built once per source, only when a drawn point is a twin
    if (sourceOpen) {
      for (const group of filtering ? allGroups.filter((g) => groupVisible(g, view)) : allGroups) {
        const cid = nodeId.cluster(source.id, group.key);
        const clusterOpen = open.clusters.has(cid);
        let mappedCount = 0;
        let offerable = 0;
        for (const p of group.points) {
          if (p.asset_id !== null) mappedCount++;
          if (isOfferable(p)) offerable++;
        }
        const visible = visiblePoints(group, view);
        const drawn = drawnCount(group, cid, view);
        // A paged group says so in its name as the node does on screen ("50 of 120 shown"): a screen reader must not take the page for the whole list.
        const pagedNote = clusterOpen && drawn < visible.length ? `, ${drawn} shown` : "";
        const clusterShift = add(cid, "cluster", X.cluster, cursor + SOURCE_H + (rows - 1) * ROW, {
          sourceId: source.id, key: group.key, label: group.label, count: group.points.length, mappedCount,
          expanded: clusterOpen, ungrouped: group.ungrouped, visibleCount: visible.length, shownCount: drawn, offerable,
        } satisfies ClusterNodeData, sourceShift, {
          ariaLabel: `${group.label}, group of ${countOf(group.points.length, "point")}, ${mappedCount} mapped, ${clusterOpen ? "open" : "closed"}${pagedNote}`,
        });
        link(sid, cid, flow);
        rows++;
        if (clusterOpen) {
          const fanStyle = drawn > FAN_DASH_LIMIT ? SOLID_FAN : DASHED;
          for (let i = 0; i < drawn; i++) {
            const p = visible[i];
            const pid = nodeId.point(p.id);
            // (w34) The same tag as a mapped point of this source: the node says whose, in the same words on screen and to a screen reader.
            let twinOf: string | undefined;
            if (p.same_tag_as && p.asset_id === null) { // the same rule as isOfferable: a point with an asset is a mapped point, whatever same_tag_as says
              twinNames ??= new Map(pointsOf(source).map((q) => [q.id, q.name]));
              twinOf = twinNames.get(p.same_tag_as) ?? "another point";
            }
            add(pid, "point", X.point, cursor + SOURCE_H + (rows - 1) * ROW,
              { sourceId: source.id, clusterKey: group.key, point: p, ...(twinOf !== undefined ? { twinOf } : {}) } satisfies PointNodeData, clusterShift, {
              ariaLabel: `${p.name}, point, ${twinOf !== undefined && p.asset_id === null ? `already mapped as ${twinOf}`
                : p.asset_id === null ? "unmapped" : assetNames.has(p.asset_id) ? `mapped to ${assetNames.get(p.asset_id)}` : "mapped"}`,
            });
            link(cid, pid, false, fanStyle); // a group's point edges are dashed (solid past FAN_DASH_LIMIT) but never flow: they are the bulk of a big graph's edges
            if (!filtering && p.asset_id !== null && assetIds.has(p.asset_id)) mappedLinks(pid, new Map([[visibleOf(p.asset_id), 1]]), flow);
            rows++;
          }
          if (drawn < visible.length) {
            // The page ends here: "Show 50 more" stands where the list ends, a row like a point, and the mapped points still to come keep one edge per asset.
            const left = visible.length - drawn;
            add(nodeId.more(cid), "more", X.point, cursor + SOURCE_H + (rows - 1) * ROW, {
              clusterId: cid, label: group.label, left, step: Math.min(view.pageSize, left),
            } satisfies MoreNodeData, clusterShift, { draggable: false, selectable: false, focusable: false });
            rows++;
            if (!filtering) mappedLinks(cid, countMapped(visible.slice(drawn), assetIds, visibleOf), flow);
          }
        } else if (!filtering) {
          mappedLinks(cid, countMapped(group.points, assetIds, visibleOf), flow);
        }
      }
    } else if (!filtering) {
      mappedLinks(sid, countMapped(allGroups.flatMap((g) => g.points), assetIds, visibleOf), flow);
    }
    cursor += SOURCE_H + (rows - 1) * ROW + BLOCK_GAP;
  }

  // Unidentified services wait in the source column below the last source.
  model.unidentified.forEach((u, i) => {
    add(nodeId.unidentified(u.host, u.port), "unidentified", X.source, cursor + i * ROW, { host: u.host, port: u.port } satisfies UnidentifiedNodeData, NO_SHIFT, {
      ariaLabel: `${u.host}:${u.port}, unidentified service`,
    });
  });

  // Assets: the planned walk, one row per DRAWN asset. A closed asset counts the points mapped to it or to anything it hides, over the WHOLE model.
  const mappedAll = new Map<number, number>();
  if (view.assetsClosed.size > 0) for (const source of model.sources) for (const g of groupsOf(source)) countMapped(g.points, assetIds, (id) => id, mappedAll);
  const inside = new Map<number, number>();
  const collapsedAsset = (id: number) => view.assetsClosed.has(id) && (childrenOf.get(id)?.length ?? 0) > 0;
  for (const { asset } of plan) if (collapsedAsset(asset.id)) inside.set(asset.id, mappedAll.get(asset.id) ?? 0);
  for (const [hidden, closedId] of representative) {
    const sum = inside.get(closedId);
    if (sum !== undefined) inside.set(closedId, sum + (mappedAll.get(hidden) ?? 0));
  }
  const shifts = new Map<number, XY>();
  plan.forEach(({ asset, depth, parent }, index) => {
    const kids = childrenOf.get(asset.id)?.length ?? 0;
    const collapsed = collapsedAsset(asset.id);
    const mappedInside = collapsed ? inside.get(asset.id) ?? 0 : 0;
    const parts = [asset.name, "asset"];
    if (kids > 0) parts.push(countOf(kids, "sub-asset"));
    if (mappedInside > 0) parts.push(`${mappedInside} mapped inside`);
    if (kids > 0) parts.push(collapsed ? "closed" : "open");
    const shift = add(nodeId.asset(asset.id), "asset", X.asset + depth * ASSET_INDENT, index * ROW, {
      asset, depth, children: kids, collapsed, ...(mappedInside > 0 ? { mappedInside } : {}), navParent: parent === null ? null : nodeId.asset(parent),
    } satisfies AssetNodeData, parent === null ? undefined : shifts.get(parent), { ariaLabel: parts.join(", ") });
    shifts.set(asset.id, shift);
  });
  // The hierarchy edges join DRAWN assets only: a hidden asset has no node to end an edge on.
  const drawnAssets = new Set(plan.map((p) => p.asset.id));
  for (const [parent, child] of parentLinks) {
    if (drawnAssets.has(parent) && drawnAssets.has(child)) edges.push({ id: `a:${parent}>${child}`, source: nodeId.asset(parent), target: nodeId.asset(child) });
  }

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
 * the server would refuse the whole request and every other place with it (the node stays where it was dragged for this session). So is a `more`
 * node's id: it has no place of its own, it stands wherever its group's last point does.
 */
export function layoutBatches(entries: Iterable<readonly [string, XY]>, size: number = LAYOUT_BATCH): LayoutEntry[][] {
  const per = size >= 1 ? Math.floor(size) : 1;
  const batches: LayoutEntry[][] = [];
  let current: LayoutEntry[] = [];
  for (const [id, p] of entries) {
    if (isMoreId(id) || id.length > MAX_LAYOUT_ID) continue;
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
 * W12b: with the "Unmapped only" filter on, a source it hides has no node to frame: only the sources it leaves count, and a default place is
 * counted by the index among them (the build gives a hidden source no room).
 */
export function initialView(model: GraphModel, view: GraphView = NO_VIEW): FitViewOptions | undefined {
  const sources = model.sources.filter((s) => sourceVisible(s, view));
  if (sources.length === 0) return undefined;
  const at = (s: GraphSource, index: number) => {
    const saved = Object.hasOwn(model.layout, nodeId.source(s.id)) ? model.layout[nodeId.source(s.id)] : undefined;
    return saved ?? { x: X.source, y: index * (SOURCE_H + BLOCK_GAP) };
  };
  const framed = [sources[0]];
  const start = at(sources[0], 0);
  let [minX, maxX, minY, maxY] = [start.x, start.x, start.y, start.y];
  for (let i = 1; i < Math.min(OPENING_SOURCES, sources.length); i++) {
    const p = at(sources[i], i);
    const [nx0, nx1, ny0, ny1] = [Math.min(minX, p.x), Math.max(maxX, p.x), Math.min(minY, p.y), Math.max(maxY, p.y)];
    if (nx1 - nx0 + SOURCE_W > OPENING_BOX.w || ny1 - ny0 + SOURCE_H > OPENING_BOX.h) break;
    [minX, maxX, minY, maxY] = [nx0, nx1, ny0, ny1];
    framed.push(sources[i]);
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

/**
 * (w33) Whether the server marked this source "not seen": the newest done scan of the same range (the same targets and ports) did not find it. Only a discovered
 * source can be marked (a source added by hand is never), so a stray field on a hand-added one is ignored here too.
 */
export function isNotSeen(source: GraphSource): boolean {
  return source.origin === "discovered" && source.not_seen != null;
}

/** (w33) The sources "Remove not seen" may offer: not seen AND nothing mapped (the rule of Remove and Clear unmapped). The server decides again on its own data. */
export function removableNotSeen(sources: readonly GraphSource[]): GraphSource[] {
  return sources.filter((s) => isNotSeen(s) && isRemovable(s));
}

/** (w33) How many sources are marked not seen, mapped or not (the filter "Not seen lately" shows exactly these). */
export function notSeenCount(sources: readonly GraphSource[]): number {
  return sources.filter(isNotSeen).length;
}

/** (w33) What a not-seen source with a mapped point that has stopped answering says in place of its seen line: it cannot be removed here; its mappings are moved or the source deleted on Sources. */
export const MAPPED_NOT_SEEN = "Mapped: move it or delete it on Sources";

/**
 * (w33) True when `MAPPED_NOT_SEEN` applies: the source is not seen AND has something mapped (so Remove not seen cannot take it) AND its status is `offline`. A mapped source that
 * still polls fine (online, or one the sweep missed once) has nothing to move or delete, so it keeps its seen line.
 */
export const isMappedNotSeen = (source: GraphSource): boolean => isNotSeen(source) && !isRemovable(source) && source.status === "offline";

/** (w33) What a card and a panel say when another server than the one the source remembers answers at its address (`identity.different`, any source). */
export const DIFFERENT_SERVER = "A different server answers at this address";

/** (w33) True when the server says another server answers at this source's address. Any source can carry it, one added by hand too. */
export const isDifferentServer = (source: GraphSource): boolean => source.identity?.different === true;

/** (w33) The old source a new, unmapped source looks like (the one the Move... button moves), or null: no candidate, `two`, or an API that does not send the field. */
export const moveOfferFor = (source: GraphSource): SourceMoveCandidateForNew | null =>
  source.move_candidate?.kind === "offer" ? source.move_candidate : null;

/** (w33) True when several old sources could be this one: nothing is offered, the address is edited by hand (`twoServersText`). */
export const twoServers = (source: GraphSource): boolean => source.move_candidate?.kind === "two";

const countNumber = (n: number) => n.toLocaleString("en-US");

const mappingsWord = (n: number) => `${countNumber(n)} ${n === 1 ? "mapping" : "mappings"}`;

/** The default names the scans give (`OPC UA server at 172.20.0.2:4840`, `DCDash simulator at ...`, `Modbus device at ...`), with or without the address: the type, not the device. */
const GENERIC_TITLE = /^(?:OPC UA server|DCDash simulator|Modbus device|OPC UA|Modbus|Simulator)(?: at \S+)?$/i;

/**
 * (w33) The card's line for an offer: `Looks like Meter room 2 (12 mappings)`. It leads with the part that tells the old source apart (its title without the address its name ends
 * with: the helper of the card's own title, given the endpoint the offer carries) and the stylesheet's ellipsis cuts after it; the whole sentence is the tooltip (`looksLikeSentence`).
 * A title that identifies nothing, because it is the same text as the card's own (`cardTitle`) or only the type label of a scan's default name, gives way to where the old source was:
 * `Was at 172.20.0.3:4840 (12 mappings)` (host and port of its endpoint, an IPv6 host in brackets). Without an endpoint the title stays.
 */
export function looksLikeLine(offer: SourceMoveCandidateForNew, cardTitle?: string): string {
  const title = sourceTitle({ name: offer.from_name, config: { endpoint: offer.from_endpoint } });
  const address = hostPortOfEndpoint(offer.from_endpoint);
  const says = title !== cardTitle && !GENERIC_TITLE.test(title);
  return `${says || address === "" ? `Looks like ${title}` : `Was at ${address}`} (${mappingsWord(offer.mappings)})`;
}

/**
 * (w33) The whole sentence of an offer, for the card's tooltip and the panel: `This looks like <old name> (12 mappings on 3 assets), which has not answered since 18 Oct 07:52`.
 * `since` is that time, already written in the site's zone by the caller (it needs the zone: `formatOfflineSince(offer.from_since, timezone)`); null when unknown. Without it
 * the sentence says where the old source stopped answering (the host and port of its endpoint, which carries no user name or password), unless its name already holds the
 * address (the scan's names end with it), when it says nothing more. No assets, no "on 0 assets".
 */
export function looksLikeSentence(offer: SourceMoveCandidateForNew, since: string | null = null): string {
  const assets = offer.assets > 0 ? ` on ${countNumber(offer.assets)} ${offer.assets === 1 ? "asset" : "assets"}` : "";
  const address = hostPortOfEndpoint(offer.from_endpoint);
  const stopped = since ? `, which has not answered since ${since}` : address !== "" && !offer.from_name.includes(address) ? `, which stopped answering at ${address}` : "";
  return `This looks like ${offer.from_name} (${mappingsWord(offer.mappings)}${assets})${stopped}`;
}

/**
 * (w33) The last line of the source card and its tooltip. The card has no room for a seventh line (SOURCE_H), so the one seen line trades places with what matters more,
 * in this order, and the tooltip keeps every sentence:
 * - another server answers at the address: `A different server answers at this address` (tone "warn": the card draws it in the warning ink);
 * - the source looks like an old one that stopped answering: `Looks like <old title> (12 mappings)`, or `Was at <host:port> (12 mappings)` when that title says nothing (`looksLikeLine`);
 *   the Move... button is on the card's button row;
 * - several old sources could be it: `Two servers could be this one; edit the address by hand` (`Several` for more than two);
 * - not seen, something mapped and offline: what to do about it.
 * Every other source shows its seen line as it is. `looks` is the page's whole sentence for an offer (`looksLikeSentence` with the time it formatted in the site's zone); without it
 * the card builds the sentence without a time.
 */
export function seenCard(source: GraphSource, seen: string, looks?: string): { line: string; title: string; tone?: "warn" } {
  const offer = moveOfferFor(source);
  const sentence = offer && (looks ?? looksLikeSentence(offer));
  const joined = (...sentences: (string | false | null)[]) => sentences.filter((s): s is string => !!s).join(". ");
  if (isDifferentServer(source)) return { line: DIFFERENT_SERVER, title: joined(DIFFERENT_SERVER, sentence, seen), tone: "warn" };
  if (offer) return { line: looksLikeLine(offer, sourceTitle(source)), title: joined(sentence, seen) };
  const two = twoServersLine(source);
  if (two) return { line: two, title: joined(two, seen) };
  if (isMappedNotSeen(source)) return { line: MAPPED_NOT_SEEN, title: `${seen}. ${MAPPED_NOT_SEEN}` };
  return { line: seen, title: seen };
}

/** (w33) The sentence for several old sources that could be this one, from the count in the candidate (`Two` for 2, `Several` for more); null for any other source. */
export const twoServersLine = (source: GraphSource): string | null =>
  source.move_candidate?.kind === "two" ? twoServersText(source.move_candidate.count) : null;

/** (w33) The panel's sentence for the seen line: a not-seen source gets the reason after the line itself. */
export function notSeenSentence(source: GraphSource, seen: string): string {
  return isNotSeen(source) ? `${seen}. A later scan of the same range did not find it.` : seen;
}

/**
 * (w33) Who the server said it is: `Server: urn:dcdash:simulator:dev` (its application URI), else `Simulator instance dev` (the simulator's instance id), else `Server: <its name>`; null
 * when nothing is known. Read-only.
 */
export function serverLine(identity: GraphSource["identity"]): string | null {
  if (identity?.application_uri) return `Server: ${identity.application_uri}`;
  if (identity?.instance) return `Simulator instance ${identity.instance}`;
  return identity?.application_name ? `Server: ${identity.application_name}` : null;
}

/** The thumbprint kept to its first 5 and last 2 characters (`3A:5F:...:91`); a short one is shown whole. */
const shortThumbprint = (value: string): string => (value.length > 12 ? `${value.slice(0, 5)}:...:${value.slice(-2)}` : value);

/** (w33) `certificate 3A:5F:...:91` with the whole thumbprint for the tooltip; null without a thumbprint. */
export function certificateLine(identity: GraphSource["identity"]): { text: string; title: string } | null {
  const value = identity?.thumbprint;
  return value ? { text: `certificate ${shortThumbprint(value)}`, title: value } : null;
}

/** (w33) The source a node belongs to: a source node, a group node or a point node; null for an asset, an unidentified service or an unknown point. */
export function sourceIdOfNode(model: GraphModel, id: string): number | null {
  if (id.startsWith("src:") || id.startsWith("cluster:")) {
    const sourceId = Number(id.split(":")[1]);
    return Number.isInteger(sourceId) ? sourceId : null;
  }
  if (id.startsWith("point:")) {
    const pointId = Number(id.slice("point:".length));
    return model.sources.find((s) => pointsOf(s).some((p) => p.id === pointId))?.id ?? null;
  }
  return null;
}

/**
 * The muted line of a source node and its panel: when a scan last found it. `now` and the site's time zone are passed in (the "ago" part counts on the site's clock).
 * (w33) A discovered source the server marked not seen says so first: `Not seen in scan #7 (last seen in #5, 4 days ago)`, the ago part counted from the last time it was seen.
 */
export function seenLine(source: GraphSource, now: Date, timezone: string): string {
  if (source.origin === "manual") return "Added by hand"; // a scan that meets it only reports "existing source": there is no time worth showing
  const missed = source.not_seen;
  if (missed) {
    const since = relativeTime(missed.last_seen_at, now, timezone);
    return `Not seen in scan #${missed.scan_id} (last seen in #${missed.last_seen_scan_id}${since ? `, ${since}` : ""})`;
  }
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

/**
 * The title and the sentence of the delete dialog for Remove (one source) and Clear unmapped (several). The list is the one the person was shown.
 * (w33) `"notSeen"` is Remove not seen: the same dialog with the reason (the latest scan of the same range did not find them) and the promise that mapped and
 * hand-added sources are never removed. Without a kind the words are the old ones.
 */
export function removalDialogText(names: readonly string[], kind?: "notSeen"): { title: string; message: string } {
  if (kind === "notSeen") {
    const never = "Mapped sources and sources added by hand are never removed.";
    if (names.length === 1) {
      return { title: `Remove "${names[0]}", which the latest scan did not find?`, message: `The latest scan of the same range did not find it. ${never} A scan can find it again.` };
    }
    return {
      title: `Remove ${names.length} sources the latest scan did not find?`,
      message: `${nameList(names)}. The latest scan of the same range did not find them. ${never} A scan can find these again.`,
    };
  }
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
