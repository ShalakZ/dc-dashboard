import type { Edge, Node } from "@xyflow/react";
import type { Asset, GraphModel, GraphPoint, GraphSource } from "../api/types";

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
};
// These are `type`s, not interfaces: React Flow requires node data to be assignable to Record<string, unknown>.
export type SourceNodeData = NodeActions & { source: GraphSource; expanded: boolean };
export type ClusterNodeData = NodeActions & {
  sourceId: number; key: string; label: string; count: number; mappedCount: number; expanded: boolean; ungrouped: boolean;
};
export type PointNodeData = NodeActions & { sourceId: number; clusterKey: string; point: GraphPoint };
export type AssetNodeData = NodeActions & { asset: GraphModel["assets"][number]; depth: number };
export type UnidentifiedNodeData = NodeActions & { host: string; port: number };

const X = { source: 0, cluster: 360, point: 720, asset: 1200 } as const;
const ASSET_INDENT = 220;
const ROW = 64;
const BLOCK_GAP = 40;
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
        add(cid, "cluster", X.cluster, cursor + rows * ROW, {
          sourceId: source.id, key: group.key, label: group.label, count: group.points.length, mappedCount,
          expanded: clusterOpen, ungrouped: group.ungrouped,
        } satisfies ClusterNodeData);
        link(sid, cid);
        rows++;
        if (clusterOpen) {
          for (const p of group.points) {
            const pid = nodeId.point(p.id);
            add(pid, "point", X.point, cursor + rows * ROW, { sourceId: source.id, clusterKey: group.key, point: p } satisfies PointNodeData);
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
    cursor += rows * ROW + BLOCK_GAP;
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
