import type { AcceptIn, Asset, GraphModel, GraphPoint, GraphSource, Metric } from "../api/types";
import { UNGROUPED } from "./graph";

/** What a drag (or a button) offers to map: the points of one cluster, or one point, and the source they belong to. */
export interface DropPayload {
  source: GraphSource;
  /** Only points that are not mapped yet. */
  points: GraphPoint[];
  label: string;
  kind: "cluster" | "point";
}

const CLUSTER_ID = /^cluster:(\d+):(.+)$/;
const POINT_ID = /^point:(\d+)$/;
const ASSET_ID = /^asset:(\d+)$/;

/**
 * The points a cluster or point node stands for, or null when the node cannot be mapped: not a cluster/point, the
 * Ungrouped bag (its points are mapped one by one), an unknown id, or nothing in it left to map.
 */
export function dropPayload(model: GraphModel, id: string): DropPayload | null {
  const cluster = CLUSTER_ID.exec(id);
  if (cluster) {
    const key = cluster[2];
    if (key === UNGROUPED) return null;
    const source = model.sources.find((s) => s.id === Number(cluster[1]));
    const found = source?.clusters.find((c) => c.key === key);
    if (!source || !found) return null;
    const points = found.points.filter((p) => p.asset_id === null);
    return points.length > 0 ? { source, points, label: found.key, kind: "cluster" } : null;
  }
  const single = POINT_ID.exec(id);
  if (single) {
    const pointId = Number(single[1]);
    for (const source of model.sources) {
      const groups: GraphPoint[][] = [source.ungrouped, ...source.clusters.map((c) => c.points)];
      for (const points of groups) {
        const hit = points.find((p) => p.id === pointId);
        if (hit) return hit.asset_id === null ? { source, points: [hit], label: hit.name, kind: "point" } : null;
      }
    }
  }
  return null;
}

/** The asset a dragged node was dropped on: the first intersecting `asset:{n}` node. */
export function pickDropTarget(intersecting: readonly { id: string; type?: string }[]): number | null {
  for (const node of intersecting) {
    const match = ASSET_ID.exec(node.id);
    if (match) return Number(match[1]);
  }
  return null;
}

/** The metrics already mapped on an asset, `custom` excluded: an asset may have any number of custom mappings. */
export function takenMetrics(model: GraphModel, assetId: number): Set<Metric> {
  const taken = new Set<Metric>();
  for (const source of model.sources) {
    for (const points of [source.ungrouped, ...source.clusters.map((c) => c.points)]) {
      for (const p of points) {
        if (p.asset_id === assetId && p.mapped_metric !== null && p.mapped_metric !== "custom") taken.add(p.mapped_metric);
      }
    }
  }
  return taken;
}

/** The longest custom unit the server accepts (`MAX_UNIT_LENGTH` in api/discovery.py). */
export const MAX_UNIT_LENGTH = 20;

export interface ReviewRow {
  pointId: number;
  name: string;
  checked: boolean;
  metric: Metric;
  scale: number;
  /** null = let the server pick the metric's default interval */
  intervalSeconds: number | null;
  customUnit: string | null;
  /** The point's own unit text, used to prefill the unit when the row is switched to `custom` */
  unitHint: string | null;
  /** Why the row starts unchecked, if it does */
  note: string | null;
}

/** One row per point from its suggestion. A row whose metric the asset already has, or an earlier row already uses, starts unchecked. */
export function reviewRows(points: readonly GraphPoint[], taken: ReadonlySet<Metric>): ReviewRow[] {
  const used = new Set<Metric>();
  return points.map((p) => {
    const { metric, scale, interval_seconds, custom_unit } = p.suggestion;
    let note: string | null = null;
    if (metric !== "custom") {
      if (taken.has(metric)) note = `This asset already has ${metric}.`;
      else if (used.has(metric)) note = `Another point in this list already maps ${metric}.`;
      used.add(metric);
    }
    return {
      pointId: p.id, name: p.name, checked: note === null, metric, scale,
      intervalSeconds: interval_seconds, customUnit: metric === "custom" ? (custom_unit ?? p.unit_hint) : null,
      unitHint: p.unit_hint, note,
    };
  });
}

/** Ids of checked rows that would put the same non-custom metric on the asset twice: the asset has it, or another checked row has it. */
export function metricConflicts(rows: readonly ReviewRow[], taken: ReadonlySet<Metric>): number[] {
  const checked = rows.filter((r) => r.checked && r.metric !== "custom");
  const counts = new Map<Metric, number>();
  for (const r of checked) counts.set(r.metric, (counts.get(r.metric) ?? 0) + 1);
  return checked.filter((r) => taken.has(r.metric) || (counts.get(r.metric) ?? 0) > 1).map((r) => r.pointId);
}

/** The row after its metric changes: the old note no longer applies, and a unit only means something for `custom` (prefilled from the point's hint). */
export function withMetric(row: ReviewRow, metric: Metric): ReviewRow {
  return { ...row, metric, note: null, customUnit: metric === "custom" ? (row.customUnit ?? row.unitHint) : null };
}

/** Ids of checked custom rows whose unit is empty or only spaces: the server refuses them, so the dialog does too. */
export function missingUnits(rows: readonly ReviewRow[]): number[] {
  return rows.filter((r) => r.checked && r.metric === "custom" && (r.customUnit ?? "").trim() === "").map((r) => r.pointId);
}

export type AcceptTarget =
  | { kind: "existing"; assetId: number }
  | { kind: "new"; name: string; parentId: number | null };

/** The body of `POST /api/discovery/accept`: the checked rows only, for an existing asset or a new one. */
export function acceptBody(sourceId: number, target: AcceptTarget, rows: readonly ReviewRow[]): AcceptIn {
  const points = rows
    .filter((r) => r.checked)
    .map((r) => ({
      point_id: r.pointId, metric: r.metric, scale: r.scale, interval_seconds: r.intervalSeconds, custom_unit: r.metric === "custom" ? ((r.customUnit ?? "").trim() || null) : null,
    }));
  return target.kind === "existing"
    ? { source_id: sourceId, asset_id: target.assetId, points }
    : { source_id: sourceId, new_asset: { name: target.name, parent_id: target.parentId }, points };
}

/** Assets in tree order (each followed by its children) with their depth. An orphan, a self-parent or a cycle member counts as a root. */
export function assetChoices(assets: readonly Pick<Asset, "id" | "parent_id" | "name">[]): { id: number; name: string; depth: number }[] {
  const ids = new Set(assets.map((a) => a.id));
  const children = new Map<number, typeof assets[number][]>();
  const roots: typeof assets[number][] = [];
  for (const a of assets) {
    if (a.parent_id !== null && a.parent_id !== a.id && ids.has(a.parent_id)) {
      const siblings = children.get(a.parent_id);
      if (siblings) siblings.push(a);
      else children.set(a.parent_id, [a]);
    } else {
      roots.push(a);
    }
  }
  const out: { id: number; name: string; depth: number }[] = [];
  const seen = new Set<number>();
  const walk = (root: typeof assets[number]) => {
    const stack = [{ asset: root, depth: 0 }];
    while (stack.length > 0) {
      const { asset, depth } = stack.pop()!;
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      out.push({ id: asset.id, name: asset.name, depth });
      const kids = children.get(asset.id) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ asset: kids[i], depth: depth + 1 });
    }
  };
  roots.forEach(walk);
  assets.forEach((a) => { if (!seen.has(a.id)) walk(a); }); // a pure parent cycle has no root
  return out;
}
