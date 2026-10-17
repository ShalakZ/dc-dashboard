import type { GraphModel } from "../api/types";
import {
  NO_VIEW, descendantNodeIds, drawnCount, groupVisible, groupsOf, nodeId, sourceVisible, visiblePoints, type Group, type GraphView, type OpenState,
} from "./graph";

/**
 * The most NEW nodes one Expand all may draw. Fifty sources of forty groups are two thousand nodes before a single point, and React Flow
 * and the person both stop being able to use a canvas like that.
 */
export const EXPAND_NODE_BUDGET = 600;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface GraphCounts {
  sources: number;
  /** The points the graph draws, not the sources' `point_count`. */
  points: number;
  mapped: number;
  /** Sources that need credentials. */
  needing: number;
  /** The points the "Unmapped only" filter leaves: `points - mapped`. */
  unmapped: number;
}

/**
 * The figures behind the line above the canvas and the bar's chips. They are the whole graph's whatever the view: the "Unmapped only" filter
 * changes the words that are said about them (`graphSummary`), not the figures, so a person can always see how much is mapped and how much the
 * filter hides. The view is accepted so a caller passes the same arguments as to `graphSummary`.
 */
export function graphCounts(model: GraphModel, _view: GraphView = NO_VIEW): GraphCounts {
  let points = 0;
  let mapped = 0;
  let needing = 0;
  for (const source of model.sources) {
    if (source.needs_credentials) needing++;
    for (const p of [...source.ungrouped, ...source.clusters.flatMap((c) => c.points)]) {
      points++;
      if (p.asset_id !== null) mapped++;
    }
  }
  return { sources: model.sources.length, points, mapped, needing, unmapped: points - mapped };
}

/**
 * "3 sources, 120 points, 6 mapped, 1 needs credentials": the line above the canvas. Counts the points the graph draws, not `point_count`.
 * While the "Unmapped only" filter is on it leads with how many points that leaves ("Showing 42 of 120 points, 3 sources, 6 mapped"): the
 * figures stay the whole graph's, so a person can always see how much is mapped and how much the filter hides.
 */
export function graphSummary(model: GraphModel, view: GraphView = NO_VIEW): string {
  const { sources, points, mapped, needing, unmapped } = graphCounts(model, view);
  const [sourceText, pointText] = [plural(sources, "source", "sources"), plural(points, "point", "points")];
  const parts = view.unmappedOnly
    ? [`Showing ${unmapped} of ${pointText}`, sourceText, `${mapped} mapped`]
    : [sourceText, pointText, `${mapped} mapped`];
  if (needing > 0) parts.push(`${needing} ${needing === 1 ? "needs" : "need"} credentials`);
  return parts.join(", ");
}

/** Collapse all: nothing open (a new state each time, so it can be set as it is). */
export function collapseAll(): OpenState {
  return { sources: new Set(), clusters: new Set() };
}

/**
 * Whether Collapse all would change anything on the canvas: a source of the graph is open (a group is only drawn while its source is). A source
 * the "Unmapped only" filter hides is not on the canvas, so it does not count.
 */
export function canCollapse(model: GraphModel, open: OpenState, view: GraphView = NO_VIEW): boolean {
  return model.sources.some((s) => sourceVisible(s, view) && open.sources.has(s.id));
}

/**
 * Whether anything is closed: a source, or a group of a source. The node budget is NOT looked at: a click that cannot open everything still
 * has an answer to give (`expandNote`), a button that silently does nothing does not. What the filter hides is not on the canvas, so it is not closed.
 */
export function canExpand(model: GraphModel, open: OpenState, view: GraphView = NO_VIEW): boolean {
  return model.sources.some((s) => sourceVisible(s, view)
    && (!open.sources.has(s.id) || groupsOf(s).some((g) => groupVisible(g, view) && !open.clusters.has(nodeId.cluster(s.id, g.key)))));
}

export interface ExpandResult {
  /** What is open after Expand all: everything that was, plus what fitted. New sets; the ones passed in are never changed. */
  open: OpenState;
  openedSources: number;
  openedGroups: number;
  /** Sources and groups (of open sources) that are still closed because opening them would not fit the budget. */
  keptSources: number;
  keptGroups: number;
}

/**
 * What opening a group draws: the points on its page, and the `more` node when the page leaves some out. With no paging in the view this is
 * the group's visible points, which is what it always was.
 */
function groupCost(group: Group, clusterId: string, view: GraphView): number {
  const drawn = drawnCount(group, clusterId, view);
  return drawn + (drawn < visiblePoints(group, view).length ? 1 : 0);
}

/**
 * The one budgeted walk behind Expand all and Expand selection. `wanted` says which source and group ids are in scope (a node id each); the
 * rest are left as they are. Sources the filter hides, and groups it hides, are not on the canvas and are skipped without being counted.
 */
function openWithin(model: GraphModel, open: OpenState, view: GraphView, budget: number, wanted: (id: string) => boolean): ExpandResult {
  const sources = new Set(open.sources);
  const clusters = new Set(open.clusters);
  let used = 0;
  let [openedSources, openedGroups, keptSources, keptGroups] = [0, 0, 0, 0];
  for (const source of model.sources) {
    if (sources.has(source.id) || !sourceVisible(source, view) || !wanted(nodeId.source(source.id))) continue;
    // A closed source keeps its open groups in `open.clusters`, and opening the source draws all of their points as well: charge them now.
    const groups = groupsOf(source).filter((g) => groupVisible(g, view));
    let cost = groups.length;
    for (const group of groups) {
      const cid = nodeId.cluster(source.id, group.key);
      if (clusters.has(cid)) cost += groupCost(group, cid, view);
    }
    if (used + cost <= budget) { sources.add(source.id); used += cost; openedSources++; } else keptSources++;
  }
  for (const source of model.sources) {
    if (!sources.has(source.id) || !sourceVisible(source, view)) continue;
    for (const group of groupsOf(source)) {
      const cid = nodeId.cluster(source.id, group.key);
      if (clusters.has(cid) || !groupVisible(group, view) || !wanted(cid)) continue;
      const cost = groupCost(group, cid, view);
      if (used + cost <= budget) { clusters.add(cid); used += cost; openedGroups++; } else keptGroups++;
    }
  }
  return { open: { sources, clusters }, openedSources, openedGroups, keptSources, keptGroups };
}

/**
 * Expand all, within a budget of NEW nodes (what is already open costs nothing). Sources open in the model's order while their groups fit,
 * then the groups of every open source in the model's order while their points fit; one that does not fit stays closed and a later, smaller
 * one may still fit. A source with no group costs nothing. Opening a closed source costs its groups plus the points of those of its groups that
 * are already open (it draws them all). Ids already open stay open, known to the model or not.
 *
 * With a `view`, a group costs what it will DRAW: the points of its first page (or the page it was extended to) plus one for the `more` node,
 * counting only the points the filter lets through. Asset subtrees are not touched here (they have their own toggle).
 */
export function expandAll(model: GraphModel, open: OpenState, budget: number = EXPAND_NODE_BUDGET, view: GraphView = NO_VIEW): ExpandResult {
  return openWithin(model, open, view, budget, () => true);
}

/**
 * The toast that says what Expand all left closed ("Opened 3 sources and 12 groups. 4 groups stay closed: opening them would draw more than
 * 600 nodes."), or null when everything that was asked opened and there is nothing to say.
 */
export function expandNote(result: ExpandResult, budget: number = EXPAND_NODE_BUDGET): string | null {
  const kept = result.keptSources + result.keptGroups;
  if (kept === 0) return null;
  const [verb, them] = kept === 1 ? ["stays", "it"] : ["stay", "them"];
  return `Opened ${countList(result.openedSources, result.openedGroups, 0) || "nothing"}. ${countList(result.keptSources, result.keptGroups, 0)} ${verb} closed: opening ${them} would draw more than ${budget} nodes.`;
}

/** "1 source", "2 groups and 3 assets", "1 source, 2 groups and 3 assets": the counts above zero, in the order sources, groups, assets; "" when all are zero. */
function countList(sources: number, groups: number, assets: number): string {
  const parts = [
    sources > 0 ? plural(sources, "source", "sources") : "", groups > 0 ? plural(groups, "group", "groups") : "", assets > 0 ? plural(assets, "asset", "assets") : "",
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? "");
}

/* -------------------------------------------------------------------------------------- W12b: expand and collapse a selection or a branch */

/** What Expand/Collapse selection or branch did (or would do): the new states, and counts of REAL changes only. */
export interface Change {
  /** What is open afterwards. The very object passed in when nothing changed; otherwise a new one (the inputs are never changed). */
  open: OpenState;
  /** The folded assets afterwards, the same way. */
  assetsClosed: ReadonlySet<number>;
  opened: { sources: number; groups: number; assets: number };
  closed: { sources: number; groups: number; assets: number };
  /** Sources and groups that stay closed because opening them would not fit the budget. Assets are free and never held back. */
  kept: { sources: number; groups: number };
}

/** The assets that have a sub-asset, by the rule the canvas walk uses: the parent is in the model and is not the asset itself. */
function assetsWithChildren(model: GraphModel): Set<number> {
  const known = new Set(model.assets.map((a) => a.id));
  const parents = new Set<number>();
  for (const a of model.assets) if (a.parent_id !== null && a.parent_id !== a.id && known.has(a.parent_id)) parents.add(a.parent_id);
  return parents;
}

/**
 * Of `ids`, the nodes that can open or close: a source, a group, an asset with at least one sub-asset. A point, a `more` node, an unidentified
 * service, a leaf asset and an id the model does not hold are dropped. With `branch`, everything under each such node that can open or close
 * comes too (a source: its groups; an asset: every sub-asset at any depth that has sub-assets; cycle safe). Each once, in the order of the
 * model: a source, its groups, the next source ..., then the assets.
 */
export function targetsOf(model: GraphModel, ids: readonly string[], branch: boolean): string[] {
  const picked = new Set(ids);
  const folding = assetsWithChildren(model);
  if (branch) {
    for (const source of model.sources) {
      if (!picked.has(nodeId.source(source.id))) continue;
      for (const group of groupsOf(source)) picked.add(nodeId.cluster(source.id, group.key));
    }
    const chosen = new Set(ids);
    for (const asset of model.assets) {
      const id = nodeId.asset(asset.id);
      if (chosen.has(id) && folding.has(asset.id)) for (const below of descendantNodeIds(model, id)) picked.add(below);
    }
  }
  const found: string[] = [];
  for (const source of model.sources) {
    const sid = nodeId.source(source.id);
    if (picked.has(sid)) found.push(sid);
    for (const group of groupsOf(source)) {
      const cid = nodeId.cluster(source.id, group.key);
      if (picked.has(cid)) found.push(cid);
    }
  }
  for (const asset of model.assets) {
    const id = nodeId.asset(asset.id);
    if (picked.has(id) && folding.has(asset.id)) found.push(id);
  }
  return found;
}

const NOTHING = { sources: 0, groups: 0, assets: 0 };

/**
 * Open the targets (see `targetsOf`) within the Expand all budget: sources first, then the groups of open sources, a group costing what it will
 * draw (`view`), what does not fit counted in `kept`. A target that is open already changes nothing. Assets open for free (they leave
 * `view.assetsClosed`; no budget, never kept).
 */
export function expandTargets(
  model: GraphModel, open: OpenState, view: GraphView, ids: readonly string[], branch: boolean, budget: number = EXPAND_NODE_BUDGET,
): Change {
  const targets = new Set(targetsOf(model, ids, branch));
  const walked = openWithin(model, open, view, budget, (id) => targets.has(id));
  let assetsClosed = view.assetsClosed;
  let assets = 0;
  if (assetsClosed.size > 0) {
    const folded = new Set(assetsClosed);
    for (const asset of model.assets) if (targets.has(nodeId.asset(asset.id)) && folded.delete(asset.id)) assets++;
    if (assets > 0) assetsClosed = folded;
  }
  return {
    open: walked.openedSources + walked.openedGroups > 0 ? walked.open : open, assetsClosed,
    opened: { sources: walked.openedSources, groups: walked.openedGroups, assets }, closed: { ...NOTHING },
    kept: { sources: walked.keptSources, groups: walked.keptGroups },
  };
}

/**
 * Close the targets: a source leaves `open.sources` (its groups stay remembered as open, as a click on the source does; with `branch` they are
 * forgotten too), a group leaves `open.clusters`, an asset is folded. Counts are of real changes among what the filter lets through; a group
 * it hides is still forgotten by a branch, but not counted.
 */
export function collapseTargets(model: GraphModel, open: OpenState, view: GraphView, ids: readonly string[], branch: boolean): Change {
  const targets = new Set(targetsOf(model, ids, branch));
  const sources = new Set(open.sources);
  const clusters = new Set(open.clusters);
  const closed = { ...NOTHING };
  for (const source of model.sources) {
    const onCanvas = sourceVisible(source, view);
    const sourceShut = targets.has(nodeId.source(source.id)) && sources.delete(source.id);
    if (sourceShut && onCanvas) closed.sources++;
    for (const group of groupsOf(source)) {
      const cid = nodeId.cluster(source.id, group.key);
      const groupShut = targets.has(cid) && clusters.delete(cid);
      if (groupShut && onCanvas && groupVisible(group, view)) closed.groups++;
    }
  }
  const folded = new Set(view.assetsClosed);
  for (const asset of model.assets) {
    if (targets.has(nodeId.asset(asset.id)) && !folded.has(asset.id)) { folded.add(asset.id); closed.assets++; }
  }
  return {
    open: sources.size !== open.sources.size || clusters.size !== open.clusters.size ? { sources, clusters } : open,
    assetsClosed: closed.assets > 0 ? folded : view.assetsClosed, opened: { ...NOTHING }, closed, kept: { sources: 0, groups: 0 },
  };
}

/**
 * The toast for a `Change`: "Opened 1 source and 3 groups." / "Closed 2 groups.", and on an expand the sentence of Expand all for what did
 * not fit ("2 groups stay closed: opening them would draw more than 600 nodes."). Null when nothing changed and nothing was held back.
 */
export function changeNote(change: Change, verb: "expand" | "collapse", budget: number = EXPAND_NODE_BUDGET): string | null {
  if (verb === "collapse") {
    const text = countList(change.closed.sources, change.closed.groups, change.closed.assets);
    return text ? `Closed ${text}.` : null;
  }
  const text = countList(change.opened.sources, change.opened.groups, change.opened.assets);
  const kept = change.kept.sources + change.kept.groups;
  if (kept === 0) return text ? `Opened ${text}.` : null;
  const [be, them] = kept === 1 ? ["stays", "it"] : ["stay", "them"];
  return `Opened ${text || "nothing"}. ${countList(change.kept.sources, change.kept.groups, 0)} ${be} closed: opening ${them} would draw more than ${budget} nodes.`;
}

/** Whether a menu or bar action can be used now, and when it cannot, why (shown as the item's muted line and its title). */
export interface ActionState { enabled: boolean; reason?: string }

/**
 * Which of Expand/Collapse selection/branch have something to do for the selected nodes. A target counts as closed when its source is not
 * open, its group is not open or its asset is folded; one the filter hides is neither open nor closed. Reasons, in the order they apply:
 * nothing selected; nothing selected can open or close; everything is already open (expand) / closed (collapse).
 *
 * `subject`: "selection" (the default) is for the bar and the selection and pane menus. A node's own menu passes "node" with that node's id: it acts on
 * the node whatever is selected, so its reasons speak of the node's branch ("This branch is already open.") and never of "everything selected".
 */
export function selectionStates(
  model: GraphModel, open: OpenState, view: GraphView, selectedIds: readonly string[], subject: "selection" | "node" = "selection",
): { expandSelection: ActionState; collapseSelection: ActionState; expandBranch: ActionState; collapseBranch: ActionState } {
  const stateOf = new Map<string, "open" | "closed" | "hidden">();
  for (const source of model.sources) {
    const onCanvas = sourceVisible(source, view);
    stateOf.set(nodeId.source(source.id), !onCanvas ? "hidden" : open.sources.has(source.id) ? "open" : "closed");
    for (const group of groupsOf(source)) {
      const cid = nodeId.cluster(source.id, group.key);
      stateOf.set(cid, !onCanvas || !groupVisible(group, view) ? "hidden" : open.clusters.has(cid) ? "open" : "closed");
    }
  }
  for (const asset of model.assets) stateOf.set(nodeId.asset(asset.id), view.assetsClosed.has(asset.id) ? "closed" : "open");

  const judge = (targets: readonly string[], expand: boolean): ActionState => {
    const states = targets.map((id) => stateOf.get(id));
    const own = subject === "node";
    if (!states.some((s) => s === "open" || s === "closed")) return { enabled: false, reason: own ? "Nothing under it opens or closes." : "Nothing selected opens or closes." };
    if (states.includes(expand ? "closed" : "open")) return { enabled: true };
    if (own) return { enabled: false, reason: expand ? "This branch is already open." : "This branch is already closed." };
    return { enabled: false, reason: expand ? "Everything selected is already open." : "Everything selected is already closed." };
  };
  if (selectedIds.length === 0) {
    const reason = "Select a source, group or asset first.";
    return { expandSelection: { enabled: false, reason }, collapseSelection: { enabled: false, reason }, expandBranch: { enabled: false, reason }, collapseBranch: { enabled: false, reason } };
  }
  const [targets, branchTargets] = [targetsOf(model, selectedIds, false), targetsOf(model, selectedIds, true)];
  return {
    expandSelection: judge(targets, true), collapseSelection: judge(targets, false),
    expandBranch: judge(branchTargets, true), collapseBranch: judge(branchTargets, false),
  };
}
