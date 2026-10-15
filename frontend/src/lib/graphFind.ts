import type { GraphModel, GraphSource } from "../api/types";
import { groupsOf, nodeId, type Group, type OpenState } from "./graph";
import { EXPAND_NODE_BUDGET } from "./graphView";

export type FindKind = "source" | "asset" | "cluster" | "point";
export interface FindEntry { id: string; kind: FindKind; label: string; context: string; text: string }
export interface FindResult { items: FindEntry[]; more: number }

/** How many results the Find box lists at most; `more` says how many were left out. */
export const FIND_LIMIT = 50;

/** Where a source listens, in the words the person knows it by: an OPC UA endpoint, a Modbus host:port, a simulator url; "" when it has none. */
function endpointOf(source: GraphSource): string {
  const text = (key: string) => (typeof source.config[key] === "string" ? (source.config[key] as string) : "");
  const url = text("endpoint") || text("url");
  if (url) return url;
  const host = text("host");
  if (!host) return "";
  const port = source.config.port;
  return typeof port === "number" ? `${host}:${port}` : host;
}

/**
 * The searchable list of everything on the canvas, built once per graph read: sources (by name and endpoint), assets (by name and kind), groups
 * (by key) and points (by name and address). `text` is the lowercased string a query is looked for in; `context` is the muted second line
 * ("point in LVP01 · Plant OPC"). Ids are the canvas node ids, so the page can find the node an entry stands for.
 */
export function buildFindIndex(model: GraphModel): FindEntry[] {
  const entries: FindEntry[] = [];
  const names = new Map<number, string>();
  for (const asset of model.assets) names.set(asset.id, asset.name);
  for (const source of model.sources) {
    const endpoint = endpointOf(source);
    entries.push({
      id: nodeId.source(source.id), kind: "source", label: source.name,
      context: `source · ${endpoint || source.connector_type}`, text: `${source.name} ${endpoint}`.toLowerCase(),
    });
  }
  for (const asset of model.assets) {
    const parent = asset.parent_id === null ? undefined : names.get(asset.parent_id);
    entries.push({
      id: nodeId.asset(asset.id), kind: "asset", label: asset.name,
      context: `${asset.kind} asset${parent === undefined ? "" : ` in ${parent}`}`, text: `${asset.name} ${asset.kind}`.toLowerCase(),
    });
  }
  for (const source of model.sources) {
    for (const group of groupsOf(source)) {
      entries.push({
        id: nodeId.cluster(source.id, group.key), kind: "cluster", label: group.label,
        context: `group in ${source.name}`, text: group.label.toLowerCase(),
      });
      const context = `point in ${group.label} · ${source.name}`;
      for (const p of group.points) {
        entries.push({ id: nodeId.point(p.id), kind: "point", label: p.name, context, text: `${p.name} ${p.address}`.toLowerCase() });
      }
    }
  }
  return entries;
}

const KIND_ORDER: Record<FindKind, number> = { source: 0, asset: 1, cluster: 2, point: 3 };
const isWordChar = /[\p{L}\p{N}]/u;

/** 0 = the label starts with the term, 1 = a word of the label does, 2 = the term is somewhere else in the text (the address, say). */
function rank(label: string, term: string): number {
  const lower = label.toLowerCase();
  let at = lower.indexOf(term);
  if (at === 0) return 0;
  while (at > 0) {
    if (!isWordChar.test(lower[at - 1])) return 1;
    at = lower.indexOf(term, at + 1);
  }
  return 2;
}

/**
 * The entries every whitespace-separated term of `query` is part of (not case sensitive, plain text: no pattern characters), best first: a
 * label that starts with the first term, then one with a word that does, then the rest; within a rank by kind (source, asset, group, point),
 * then in the order of the index. No sort and no `localeCompare`: the entries go into twelve buckets as they are met, so 6,000 points cost one pass.
 */
export function findMatches(index: readonly FindEntry[], query: string, limit: number = FIND_LIMIT): FindResult {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { items: [], more: 0 };
  const buckets: FindEntry[][] = Array.from({ length: 12 }, () => []);
  let total = 0;
  for (const entry of index) {
    if (!terms.every((term) => entry.text.includes(term))) continue;
    buckets[rank(entry.label, terms[0]) * 4 + KIND_ORDER[entry.kind]].push(entry);
    total++;
  }
  const items: FindEntry[] = [];
  for (const bucket of buckets) {
    for (const entry of bucket) {
      if (items.length >= limit) return { items, more: total - items.length };
      items.push(entry);
    }
  }
  return { items, more: total - items.length };
}

export interface FindPlan {
  /** What is open after the jump. The very object passed in when nothing has to change (so a state setter does not rebuild the canvas). */
  open: OpenState;
  /** The node to centre: the entry's own, or its group when the points are too many to draw. */
  targetId: string;
  /** What to tell the person (a toast), or null. */
  note: string | null;
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * What to open so that `entry` is on the canvas, within a budget of NEW nodes (what is already drawn costs nothing; the same rule as Expand
 * all). A source and an asset are always drawn. A group needs its source open; a point needs its source and its group. Opening a CLOSED source
 * draws its groups and the points of the groups that are already in `open.clusters`; opening a group draws all its points.
 *
 * Over budget, the source's already-open groups are closed first (only a closed source holds back groups that would come back with it); if
 * the target's own group is still too much, it stays closed and the plan points at the group instead, with a note that says so. Never changes
 * the `open` it is given.
 */
export function findPlan(model: GraphModel, open: OpenState, entry: FindEntry, budget: number = EXPAND_NODE_BUDGET): FindPlan {
  const same: FindPlan = { open, targetId: entry.id, note: null };
  if (entry.kind === "source" || entry.kind === "asset") return same;

  let source: GraphSource | undefined;
  let group: Group | undefined;
  let isPoint = false;
  for (const s of model.sources) {
    for (const g of groupsOf(s)) {
      if (entry.kind === "cluster" ? nodeId.cluster(s.id, g.key) === entry.id : g.points.some((p) => nodeId.point(p.id) === entry.id)) {
        [source, group, isPoint] = [s, g, entry.kind === "point"];
        break;
      }
    }
    if (source) break;
  }
  if (!source || !group) return same;

  const groups = groupsOf(source);
  const groupId = nodeId.cluster(source.id, group.key);
  const sourceClosed = !open.sources.has(source.id);
  const openGroups = groups.filter((g) => open.clusters.has(nodeId.cluster(source.id, g.key)));
  // The cost of showing the target, counting only what is not drawn yet.
  const cost = (heldBackPoints: number, groupOpen: boolean) =>
    (sourceClosed ? groups.length + heldBackPoints : 0) + (isPoint && !groupOpen ? group.points.length : 0);

  const clusters = new Set(open.clusters);
  const notes: string[] = [];
  let heldBack = openGroups.reduce((sum, g) => sum + g.points.length, 0);
  let groupOpen = open.clusters.has(groupId);
  if (cost(heldBack, groupOpen) > budget && sourceClosed && openGroups.length > 0) {
    for (const g of openGroups) clusters.delete(nodeId.cluster(source.id, g.key));
    heldBack = 0;
    groupOpen = false;
    notes.push(`Opening ${source.name} would draw more than ${count(budget)} nodes, so its open groups were closed.`);
  }

  let targetId = entry.id;
  if (isPoint) {
    if (cost(heldBack, groupOpen) <= budget) {
      clusters.add(groupId);
    } else {
      targetId = groupId;
      notes.push(`${group.ungrouped ? `Ungrouped in ${source.name}` : group.label} has ${count(group.points.length)} points, too many to draw at once. Showing the group instead.`);
    }
  }

  const sources = new Set(open.sources);
  sources.add(source.id);
  const changed = sources.size !== open.sources.size || clusters.size !== open.clusters.size || [...clusters].some((id) => !open.clusters.has(id));
  return { open: changed ? { sources, clusters } : open, targetId, note: notes.length > 0 ? notes.join(" ") : null };
}
