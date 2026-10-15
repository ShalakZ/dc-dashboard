import type { Edge, Node } from "@xyflow/react";
import type { Asset, GraphModel, GraphPoint, GraphSource, RemoveSourcesResult } from "../api/types";
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
};
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
export type AssetNodeData = NodeActions & { asset: GraphModel["assets"][number]; depth: number };
export type UnidentifiedNodeData = NodeActions & { host: string; port: number };

const X = { source: 0, cluster: 360, point: 720, asset: 1200 } as const;
const ASSET_INDENT = 220;
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

interface Group { key: string; label: string; ungrouped: boolean; points: GraphPoint[] }

function groupsOf(source: GraphSource): Group[] {
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

/**
 * The discovery graph as React Flow nodes and edges. Pure: positions come from the saved layout, else from a column
 * layout (discovered nodes on the left, assets on the right). Sources and clusters only show their children while open.
 */
export function buildGraph(model: GraphModel, open: OpenState): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const assetIds = new Set<number>(model.assets.map((a) => a.id));

  const add = (id: string, type: string, x: number, y: number, data: Record<string, unknown>) => {
    const saved = Object.hasOwn(model.layout, id) ? model.layout[id] : undefined;
    nodes.push({ id, type, position: saved ? { x: saved.x, y: saved.y } : { x, y }, data, draggable: true });
  };
  const link = (from: string, to: string, extra: Partial<Edge> = {}) => {
    edges.push({ id: `e:${from}>${to}`, source: from, target: to, style: DASHED, ...extra });
  };
  /** One edge per mapped asset; a count label when several points share it. */
  const mappedLinks = (from: string, counts: ReadonlyMap<number, number>) => {
    for (const [assetId, n] of counts) {
      const target = nodeId.asset(assetId);
      edges.push({ id: `m:${from}>${target}`, source: from, target, ...(n > 1 ? { label: `${n} mapped` } : {}) });
    }
  };

  // Discovered side: sources in order, each in a block that grows with what is open under it.
  let cursor = 0;
  for (const source of model.sources) {
    const sid = nodeId.source(source.id);
    const sourceOpen = open.sources.has(source.id);
    add(sid, "source", X.source, cursor, { source, expanded: sourceOpen } satisfies SourceNodeData);
    let rows = 1;
    const groups = groupsOf(source);
    if (sourceOpen) {
      for (const group of groups) {
        const cid = nodeId.cluster(source.id, group.key);
        const clusterOpen = open.clusters.has(cid);
        const counts = countMapped(group.points, assetIds);
        let mappedCount = 0;
        for (const p of group.points) if (p.asset_id !== null) mappedCount++;
        add(cid, "cluster", X.cluster, cursor + SOURCE_H + (rows - 1) * ROW, {
          sourceId: source.id, key: group.key, label: group.label, count: group.points.length, mappedCount,
          expanded: clusterOpen, ungrouped: group.ungrouped,
        } satisfies ClusterNodeData);
        link(sid, cid);
        rows++;
        if (clusterOpen) {
          for (const p of group.points) {
            const pid = nodeId.point(p.id);
            add(pid, "point", X.point, cursor + SOURCE_H + (rows - 1) * ROW, { sourceId: source.id, clusterKey: group.key, point: p } satisfies PointNodeData);
            link(cid, pid);
            if (p.asset_id !== null && assetIds.has(p.asset_id)) mappedLinks(pid, new Map([[p.asset_id, 1]]));
            rows++;
          }
        } else {
          mappedLinks(cid, counts);
        }
      }
    } else {
      mappedLinks(sid, countMapped(groups.flatMap((g) => g.points), assetIds));
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
    const stack: { asset: GraphModel["assets"][number]; depth: number }[] = [{ asset: root, depth: 0 }];
    while (stack.length > 0) {
      const { asset, depth } = stack.pop()!;
      if (visited.has(asset.id)) continue;
      visited.add(asset.id);
      add(nodeId.asset(asset.id), "asset", X.asset + depth * ASSET_INDENT, index * ROW, { asset, depth } satisfies AssetNodeData);
      index++;
      const children = childrenOf.get(asset.id) ?? [];
      for (let i = children.length - 1; i >= 0; i--) stack.push({ asset: children[i], depth: depth + 1 });
    }
  };
  roots.forEach(walk);
  model.assets.forEach((asset) => { if (!visited.has(asset.id)) walk(asset); }); // pure parent cycles have no root

  return { nodes, edges };
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
