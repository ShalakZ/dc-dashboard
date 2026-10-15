import type { GraphModel, GraphPoint, Metric } from "../api/types";
import { UNGROUPED, groupsOf, type MappedSource } from "./graph";
import type { MappingRef } from "./mappingActions";

/** What the Move dialog needs besides a `MappingRef`: the metric, to tell a clash on the target before asking. */
export type MappedRef = MappingRef & { metric: Metric };

/** The most sources an asset node's menu lists ("Unmap everything from <source>…"). */
export const MAX_SOURCE_ITEMS = 5;

const CLUSTER_ID = /^cluster:(\d+):(.+)$/;
const POINT_ID = /^point:(\d+)$/;
const ASSET_ID = /^asset:(\d+)$/;

/** A mapped point as a ref. A point with a mapping id but no asset cannot be named by its place, so it has none. */
function refOf(p: GraphPoint): MappedRef | null {
  if (p.mapping_id === null || p.asset_id === null) return null;
  return { id: p.mapping_id, name: p.name, assetId: p.asset_id, metric: p.mapped_metric ?? "custom" };
}

/** Every point of a source, in the order the graph draws them: the groups, then the Ungrouped bag. */
const pointsOf = (source: GraphModel["sources"][number]): GraphPoint[] => groupsOf(source).flatMap((g) => g.points);

/**
 * The mappings a node stands for, to unmap or move (W12a):
 * - a point node `point:<n>`: that point's mapping;
 * - a group node `cluster:<sourceId>:<key>` (the Ungrouped bag too): every point of the group that is mapped;
 * - an asset node `asset:<n>` with a `sourceId`: every point of that source mapped to that asset, in all its groups and in the Ungrouped bag.
 * Anything else, an unmapped point and an asset without a source have none.
 */
export function mappedRefs(model: GraphModel, id: string, sourceId?: number): MappedRef[] {
  const cluster = CLUSTER_ID.exec(id);
  if (cluster) {
    const source = model.sources.find((s) => s.id === Number(cluster[1]));
    const group = source && groupsOf(source).find((g) => g.key === cluster[2]);
    return (group?.points ?? []).flatMap((p) => refOf(p) ?? []);
  }
  const single = POINT_ID.exec(id);
  if (single) {
    for (const source of model.sources) {
      const hit = pointsOf(source).find((p) => p.id === Number(single[1]));
      if (hit) {
        const ref = refOf(hit);
        return ref ? [ref] : [];
      }
    }
    return [];
  }
  const asset = ASSET_ID.exec(id);
  if (asset && sourceId !== undefined) {
    const source = model.sources.find((s) => s.id === sourceId);
    return (source ? pointsOf(source) : []).filter((p) => p.asset_id === Number(asset[1])).flatMap((p) => refOf(p) ?? []);
  }
  return [];
}

/** Every asset's sources in one pass over the points (an asset node asks once per graph, not once per node): by name, at most MAX_SOURCE_ITEMS each. */
export function mappedSourcesByAsset(model: GraphModel): Map<number, MappedSource[]> {
  const counts = new Map<number, Map<number, number>>(); // asset id -> source id -> mapped points
  for (const source of model.sources) {
    for (const p of pointsOf(source)) {
      if (p.mapping_id === null || p.asset_id === null) continue;
      const bySource = counts.get(p.asset_id) ?? new Map<number, number>();
      bySource.set(source.id, (bySource.get(source.id) ?? 0) + 1);
      counts.set(p.asset_id, bySource);
    }
  }
  const names = new Map(model.sources.map((s) => [s.id, s.name]));
  const index = new Map<number, MappedSource[]>();
  for (const [assetId, bySource] of counts) {
    const list = [...bySource].map(([sourceId, count]) => ({ sourceId, sourceName: names.get(sourceId) ?? "", count }));
    list.sort((a, b) => a.sourceName.localeCompare(b.sourceName) || a.sourceId - b.sourceId);
    index.set(assetId, list.slice(0, MAX_SOURCE_ITEMS));
  }
  return index;
}

/** The sources with mappings on one asset, by name, at most MAX_SOURCE_ITEMS. */
export const mappedSources = (model: GraphModel, assetId: number): MappedSource[] => mappedSourcesByAsset(model).get(assetId) ?? [];

/**
 * What a confirmation or a dialog calls the mappings of a node when it is more than the one point's name: `the group "LVP01"`,
 * `the 6 points of source "Plant OPC"`. A point node has none (the point's own name is the title).
 */
export function mappingsWhat(model: GraphModel, id: string, sourceId?: number): string | undefined {
  const cluster = CLUSTER_ID.exec(id);
  if (cluster) return cluster[2] === UNGROUPED ? "the Ungrouped points" : `the group "${cluster[2]}"`;
  if (ASSET_ID.test(id) && sourceId !== undefined) {
    const name = model.sources.find((s) => s.id === sourceId)?.name ?? "this source";
    const n = mappedRefs(model, id, sourceId).length;
    return n === 1 ? `the point of source "${name}"` : `the ${n} points of source "${name}"`;
  }
  return undefined;
}
