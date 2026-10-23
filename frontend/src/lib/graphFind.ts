import type { GraphModel, GraphSource } from "../api/types";
import { NO_VIEW, drawnCount, groupVisible, groupsOf, isOfferable, nodeId, sourceVisible, visiblePoints, type GraphView, type Group, type OpenState } from "./graph";
import { EXPAND_NODE_BUDGET } from "./graphView";
import type { IconName } from "../components/Icon";
import { assetIcon } from "./assetIcons";
import { clusterIcon, metricIcon, pointMetric, protocolIcon } from "./graphIcons";

export type FindKind = "source" | "asset" | "cluster" | "point";
/** `icon` is what the Find list draws before the label: the protocol of a source, the icon of an asset, the group icon, the icon of a point's metric. */
export interface FindEntry { id: string; kind: FindKind; label: string; context: string; text: string; icon: IconName }
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
      context: `source · ${endpoint || source.connector_type}`, text: `${source.name} ${endpoint}`.toLowerCase(), icon: protocolIcon(source.connector_type),
    });
  }
  for (const asset of model.assets) {
    const parent = asset.parent_id === null ? undefined : names.get(asset.parent_id);
    entries.push({
      id: nodeId.asset(asset.id), kind: "asset", label: asset.name,
      context: `${asset.kind} asset${parent === undefined ? "" : ` in ${parent}`}`, text: `${asset.name} ${asset.kind}`.toLowerCase(), icon: assetIcon(asset),
    });
  }
  for (const source of model.sources) {
    let twinNames: Map<number, string> | undefined; // built when the first twin of the source turns up
    for (const group of groupsOf(source)) {
      entries.push({
        id: nodeId.cluster(source.id, group.key), kind: "cluster", label: group.label,
        context: `group in ${source.name}`, text: group.label.toLowerCase(), icon: clusterIcon,
      });
      const context = `point in ${group.label} · ${source.name}`;
      for (const p of group.points) {
        // (w34) A twin (the same tag as a mapped point of its source; the same rule as `isOfferable`) says so first: two options of one name must differ, and the line is cut at its end.
        let twinOf: string | undefined;
        if (p.same_tag_as && p.asset_id === null) {
          twinNames ??= new Map(groupsOf(source).flatMap((g) => g.points.map((q) => [q.id, q.name] as const)));
          twinOf = twinNames.get(p.same_tag_as) ?? "another point";
        }
        entries.push({ id: nodeId.point(p.id), kind: "point", label: p.name, context: twinOf === undefined ? context : `already mapped as ${twinOf} · ${context}`, text: `${p.name} ${p.address}`.toLowerCase(), icon: metricIcon(pointMetric(p)) });
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
  /**
   * W12b: the view to use from now on, present ONLY when the plan has to change it: a group's page extended to reach the point, the closed
   * ancestors of an asset opened, "Unmapped only" turned off because it hides the node. Absent = the page keeps the view it has.
   */
  view?: GraphView;
}

const count = (n: number) => n.toLocaleString("en-US");

/** The folded assets with the folded ancestors of asset node `id` taken out, or null when none of its ancestors is folded (the asset itself may stay folded: it is drawn). */
function unfoldedAncestors(model: GraphModel, id: string, folded: ReadonlySet<number>): Set<number> | null {
  const asset = folded.size > 0 ? model.assets.find((a) => nodeId.asset(a.id) === id) : undefined;
  if (!asset) return null;
  const parentOf = new Map(model.assets.map((a) => [a.id, a.parent_id]));
  const reopened = new Set(folded);
  const seen = new Set([asset.id]);
  for (let at = parentOf.get(asset.id) ?? null; at !== null && parentOf.has(at) && !seen.has(at); at = parentOf.get(at) ?? null) {
    seen.add(at);
    reopened.delete(at);
  }
  return reopened.size === folded.size ? null : reopened;
}

/**
 * What to open so that `entry` is on the canvas, within a budget of NEW nodes (what is already drawn costs nothing; the same rule as Expand
 * all). A source and an asset are always drawn. A group needs its source open; a point needs its source and its group. Opening a CLOSED source
 * draws its groups and the points of the groups that are already in `open.clusters`; opening a group draws all its points.
 *
 * Over budget, the source's already-open groups are closed first (only a closed source holds back groups that would come back with it); if
 * the target's own group is still too much, it stays closed and the plan points at the group instead, with a note that says so. Never changes
 * the `open` it is given.
 *
 * W12b, with a `view`: a point in a paged group extends that group's page to a whole number of pages that reaches it (counted among the points
 * the filter lets through), and the cost is what the group then draws (its points plus the `more` node). A point too far down for the budget
 * shows the group on the page it has, and the note says to use Show 50 more. An asset inside folded assets opens its folded ancestors. A source,
 * group or point the "Unmapped only" filter hides turns the filter off. The new view comes back as `view`, and only when it differs.
 */
export function findPlan(model: GraphModel, open: OpenState, entry: FindEntry, budget: number = EXPAND_NODE_BUDGET, view: GraphView = NO_VIEW): FindPlan {
  const same: FindPlan = { open, targetId: entry.id, note: null };
  if (entry.kind === "asset") {
    const unfolded = unfoldedAncestors(model, entry.id, view.assetsClosed);
    return unfolded ? { ...same, view: { ...view, assetsClosed: unfolded } } : same;
  }
  const filterNote = `Unmapped only is off so ${entry.label} can be shown.`;
  if (entry.kind === "source") {
    const hidden = view.unmappedOnly && model.sources.some((s) => nodeId.source(s.id) === entry.id && !sourceVisible(s, view));
    return hidden ? { ...same, note: filterNote, view: { ...view, unmappedOnly: false } } : same;
  }

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

  // Hidden by the filter: the plan is worked out with the filter off (that is how the node will be drawn), and says so.
  const mappedPoint = isPoint && group.points.some((p) => nodeId.point(p.id) === entry.id && !isOfferable(p)); // the filter hides it: mapped, or the twin of a mapped point (w34)
  const hidden = view.unmappedOnly && (!sourceVisible(source, view) || !groupVisible(group, view) || mappedPoint);
  const now: GraphView = hidden ? { ...view, unmappedOnly: false } : view;

  const groups = groupsOf(source).filter((g) => groupVisible(g, now));
  const idOf = (g: Group) => nodeId.cluster(source.id, g.key);
  const groupId = idOf(group);
  const sourceClosed = !open.sources.has(source.id);
  const openGroups = groups.filter((g) => open.clusters.has(idOf(g)));
  const visible = visiblePoints(group, now);
  const paged = visible.length > now.pageSize;
  // How many points the group must draw for the point to be among them: a whole number of pages that reaches it (0 = no need to page).
  const place = isPoint && paged ? visible.findIndex((p) => nodeId.point(p.id) === entry.id) : -1;
  const needed = place >= 0 ? Math.min(visible.length, Math.ceil((place + 1) / now.pageSize) * now.pageSize) : 0;

  let shown = now.shown; // replaced, never changed in place
  const drawnNow = (g: Group) => drawnCount(g, idOf(g), { ...now, shown });
  const costOf = (g: Group) => drawnNow(g) + (drawnNow(g) < visiblePoints(g, now).length ? 1 : 0);
  // The cost of showing the target, counting only what is not drawn yet: an open group only the points its page still lacks.
  const cost = (heldBack: number, groupOpen: boolean, extent: number) => (sourceClosed ? groups.length + heldBack : 0)
    + (isPoint ? (groupOpen ? Math.max(0, extent - drawnNow(group)) : extent + (extent < visible.length ? 1 : 0)) : 0);
  const extentNeeded = () => Math.max(drawnNow(group), needed);

  const clusters = new Set(open.clusters);
  const notes: string[] = hidden ? [filterNote] : [];
  let heldBack = openGroups.reduce((sum, g) => sum + costOf(g), 0);
  let groupOpen = open.clusters.has(groupId);
  if (cost(heldBack, groupOpen, extentNeeded()) > budget && sourceClosed && openGroups.length > 0) {
    for (const g of openGroups) clusters.delete(idOf(g));
    // A group that closes starts again at one page when it is opened next.
    if (openGroups.some((g) => shown.has(idOf(g)))) {
      const kept = new Map(shown);
      for (const g of openGroups) kept.delete(idOf(g));
      shown = kept;
    }
    heldBack = 0;
    groupOpen = false;
    notes.push(`Opening ${source.name} would draw more than ${count(budget)} nodes, so its open groups were closed.`);
  }

  let targetId = entry.id;
  if (isPoint) {
    if (cost(heldBack, groupOpen, extentNeeded()) <= budget) {
      clusters.add(groupId);
      if (needed > drawnNow(group)) shown = new Map(shown).set(groupId, needed);
    } else {
      targetId = groupId;
      const name = group.ungrouped ? `Ungrouped in ${source.name}` : group.label;
      if (paged) {
        // The point is too far down to draw at once, but the group itself is not: show it on the page it has, and say how to go on.
        if (cost(heldBack, groupOpen, drawnNow(group)) <= budget) clusters.add(groupId);
        notes.push(`${name} has ${count(visible.length)} points; the one you chose is too far down to draw at once. Showing the group: use Show ${now.pageSize} more to go on.`);
      } else {
        notes.push(`${name} has ${count(visible.length)} points, too many to draw at once. Showing the group instead.`);
      }
    }
  }

  const sources = new Set(open.sources);
  sources.add(source.id);
  const changed = sources.size !== open.sources.size || clusters.size !== open.clusters.size || [...clusters].some((id) => !open.clusters.has(id));
  const plan: FindPlan = { open: changed ? { sources, clusters } : open, targetId, note: notes.length > 0 ? notes.join(" ") : null };
  if (hidden || shown !== now.shown) plan.view = { ...now, shown };
  return plan;
}
