import type { GraphModel } from "../api/types";
import { groupsOf, nodeId, type OpenState } from "./graph";

/**
 * The most NEW nodes one Expand all may draw. Fifty sources of forty groups are two thousand nodes before a single point, and React Flow
 * and the person both stop being able to use a canvas like that.
 */
export const EXPAND_NODE_BUDGET = 600;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 sources, 120 points, 6 mapped, 1 needs credentials": the line above the canvas. Counts the points the graph draws, not `point_count`. */
export function graphSummary(model: GraphModel): string {
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
  const parts = [plural(model.sources.length, "source", "sources"), plural(points, "point", "points"), `${mapped} mapped`];
  if (needing > 0) parts.push(`${needing} ${needing === 1 ? "needs" : "need"} credentials`);
  return parts.join(", ");
}

/** Collapse all: nothing open (a new state each time, so it can be set as it is). */
export function collapseAll(): OpenState {
  return { sources: new Set(), clusters: new Set() };
}

/** Whether Collapse all would change anything on the canvas: a source of the graph is open (a group is only drawn while its source is). */
export function canCollapse(model: GraphModel, open: OpenState): boolean {
  return model.sources.some((s) => open.sources.has(s.id));
}

/**
 * Whether anything is closed: a source, or a group of a source. The node budget is NOT looked at: a click that cannot open everything still
 * has an answer to give (`expandNote`), a button that silently does nothing does not.
 */
export function canExpand(model: GraphModel, open: OpenState): boolean {
  return model.sources.some((s) => !open.sources.has(s.id) || groupsOf(s).some((g) => !open.clusters.has(nodeId.cluster(s.id, g.key))));
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
 * Expand all, within a budget of NEW nodes (what is already open costs nothing). Sources open in the model's order while their groups fit,
 * then the groups of every open source in the model's order while their points fit; one that does not fit stays closed and a later, smaller
 * one may still fit. A source with no group costs nothing. Ids already open stay open, known to the model or not.
 */
export function expandAll(model: GraphModel, open: OpenState, budget: number = EXPAND_NODE_BUDGET): ExpandResult {
  const sources = new Set(open.sources);
  const clusters = new Set(open.clusters);
  let used = 0;
  let [openedSources, openedGroups, keptSources, keptGroups] = [0, 0, 0, 0];
  for (const source of model.sources) {
    if (sources.has(source.id)) continue;
    const cost = groupsOf(source).length;
    if (used + cost <= budget) { sources.add(source.id); used += cost; openedSources++; } else keptSources++;
  }
  for (const source of model.sources) {
    if (!sources.has(source.id)) continue;
    for (const group of groupsOf(source)) {
      const cid = nodeId.cluster(source.id, group.key);
      if (clusters.has(cid)) continue;
      if (used + group.points.length <= budget) { clusters.add(cid); used += group.points.length; openedGroups++; } else keptGroups++;
    }
  }
  return { open: { sources, clusters }, openedSources, openedGroups, keptSources, keptGroups };
}

/**
 * The toast that says what Expand all left closed ("Opened 3 sources and 12 groups. 4 groups stay closed: opening them would draw more than
 * 600 nodes."), or null when everything that was asked opened and there is nothing to say.
 */
export function expandNote(result: ExpandResult, budget: number = EXPAND_NODE_BUDGET): string | null {
  const kept = result.keptSources + result.keptGroups;
  if (kept === 0) return null;
  const list = (sourceCount: number, groupCount: number) => [
    sourceCount > 0 ? plural(sourceCount, "source", "sources") : "", groupCount > 0 ? plural(groupCount, "group", "groups") : "",
  ].filter(Boolean).join(" and ");
  const [verb, them] = kept === 1 ? ["stays", "it"] : ["stay", "them"];
  return `Opened ${list(result.openedSources, result.openedGroups) || "nothing"}. ${list(result.keptSources, result.keptGroups)} ${verb} closed: opening ${them} would draw more than ${budget} nodes.`;
}
