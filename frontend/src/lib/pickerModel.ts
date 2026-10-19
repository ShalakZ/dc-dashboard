import type { Asset } from "../api/types";
import { nameOrKindMatches } from "./assetMatch";
import { FOLD_ROW_LIMIT, TREE_DEFAULT_LEVEL, fixedLevelFold, foldModel, type FoldModel } from "./foldLevels";
import { kindKey } from "./kinds";
import { pickerRows } from "./pickerRows";
import { buildTree, type TreeNode } from "./tree";

/*
 * The model of the widget asset picker as pure functions: the SHOWN tree (offered assets plus the ancestors that hold them), the search and
 * kind filter, the fold, what is visible, and the counts behind "Pick all under". No React, no DOM, no input is changed.
 */

export interface PickerNode {
  id: number; name: string; kind: string; kindKey: string;
  /** index of this node in model.nodes, and of its parent (-1 for a top-level row) */
  index: number; parentIndex: number; parentId: number | null;
  /** depth in the SHOWN tree (0 = top level) */
  depth: number;
  /** false = a CONTEXT row (an ancestor of an offered asset that is not offered itself) */
  offered: boolean;
  /** What names an INPUT row: exactly pickerRows(offered, tree)'s label. For a context row: its name. */
  label: string;
  /** What names the row's BUTTONS ("Children of <buttonLabel>", "Pick all under <buttonLabel>"): the label from ONE pickerRows(offeredShown + context, tree) call. */
  buttonLabel: string;
  /** offered descendants in the shown tree (not counting itself) and whether it has any shown child */
  below: number; hasKids: boolean;
  /** the node's subtree is nodes[index + 1 .. end) */
  end: number;
}

/** key = kindKey; name = the most frequent spelling among the OFFERED assets of that key (a tie: the first in tree order); count = offered assets */
export interface KindOption { key: string; name: string; count: number }

export interface PickerModel {
  /** pre-order (parents first), siblings by buildTree's order (sort_order, name) */
  nodes: readonly PickerNode[];
  byId: ReadonlyMap<number, PickerNode>;
  fold: FoldModel;
  /** fixedLevelFold(fold, TREE_DEFAULT_LEVEL): empty for 60 shown rows or fewer */
  defaultFolded: ReadonlySet<number>;
  /** sorted by key, code-point comparison */
  kinds: readonly KindOption[];
  offeredCount: number;
}

// Code-point comparison: deterministic across runtimes (localeCompare depends on ICU collation).
const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * The shown tree is `buildTree(tree)` pruned to the nodes that are offered (their id is in `offered` AND in `tree`) or have an offered
 * descendant, in pre-order. Offered assets that are not in `tree` are ignored (as `pickerRows` ignores them).
 */
export function buildPickerModel(offered: Asset[], tree: Asset[]): PickerModel {
  const inTree = new Set(tree.map((asset) => asset.id));
  const offeredIds = new Set<number>();
  for (const asset of offered) if (inTree.has(asset.id)) offeredIds.add(asset.id);

  const nodes: PickerNode[] = [];
  // Returns the number of offered nodes in the subtree (the node itself included); 0 = nothing to show here, and the node is taken back out.
  const walk = (source: TreeNode, depth: number, parentIndex: number, parentId: number | null): number => {
    const index = nodes.length;
    const isOffered = offeredIds.has(source.id);
    const node: PickerNode = {
      id: source.id, name: source.name, kind: source.kind, kindKey: kindKey(source.kind),
      index, parentIndex, parentId, depth, offered: isOffered,
      label: source.name, buttonLabel: source.name, below: 0, hasKids: false, end: index + 1,
    };
    nodes.push(node);
    let offeredBelow = 0;
    for (const child of source.children) {
      const count = walk(child, depth + 1, index, source.id);
      if (count > 0) {
        node.hasKids = true;
        offeredBelow += count;
      }
    }
    if (!isOffered && offeredBelow === 0) {
      nodes.length = index; // every child was taken back out too, so this node is the last one
      return 0;
    }
    node.below = offeredBelow;
    node.end = nodes.length;
    return offeredBelow + (isOffered ? 1 : 0);
  };
  for (const root of buildTree(tree)) walk(root, 0, -1, null);

  // Input labels: what pickerRows gives the offered assets. Button names: ONE call for everything shown (offered and context), so two
  // same-named rows get different button names even when only one of them is an input.
  const inputLabels = new Map(pickerRows(offered, tree).map((row) => [row.id, row.label]));
  const shownIds = new Set(nodes.map((node) => node.id));
  const buttonLabels = new Map(pickerRows(tree.filter((asset) => shownIds.has(asset.id)), tree).map((row) => [row.id, row.label]));
  const byId = new Map<number, PickerNode>();
  for (const node of nodes) {
    if (node.offered) node.label = inputLabels.get(node.id) ?? node.name;
    node.buttonLabel = buttonLabels.get(node.id) ?? node.name;
    byId.set(node.id, node);
  }

  // Kinds of the OFFERED assets. A blank kind has the key "", which is the select's "All kinds" value, so it is not an option.
  const spellings = new Map<string, Map<string, number>>();
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!node.offered || node.kindKey === "") continue;
    counts.set(node.kindKey, (counts.get(node.kindKey) ?? 0) + 1);
    let forKey = spellings.get(node.kindKey);
    if (!forKey) spellings.set(node.kindKey, (forKey = new Map()));
    forKey.set(node.kind, (forKey.get(node.kind) ?? 0) + 1);
  }
  const kinds: KindOption[] = [];
  for (const [key, forKey] of spellings) {
    let name = "";
    let best = 0;
    for (const [spelling, count] of forKey) {
      if (count > best) { name = spelling; best = count; } // strictly more: on a tie the spelling met first (tree order) stays
    }
    kinds.push({ key, name, count: counts.get(key) ?? 0 });
  }
  kinds.sort((a, b) => compare(a.key, b.key));

  const fold = foldModel(nodes.map((node) => ({ id: node.id, parent_id: node.parentId })));
  return { nodes, byId, fold, defaultFolded: fixedLevelFold(fold, TREE_DEFAULT_LEVEL), kinds, offeredCount: offeredIds.size };
}

export interface PickerView {
  /** false when the (trimmed) search is empty AND kind is "" */
  filtering: boolean;
  /** null when not filtering: every node shows */
  shown: ReadonlySet<number> | null;
  /** offered nodes passing the search and the kind; null when not filtering (= every offered node) */
  results: ReadonlySet<number> | null;
  /** results.size, or model.offeredCount when not filtering */
  count: number;
  /** ids of shown nodes that have at least one SHOWN child (empty when not filtering) */
  shownKids: ReadonlySet<number>;
  /** empty when not filtering */
  forcedOpen: ReadonlySet<number>;
  /** shown.size, or model.nodes.length when not filtering */
  total: number;
}

/**
 * `kind` is a `kindKey` or "". A node is INSIDE A MATCH when it, or any ancestor in the shown tree, matches the search (with an empty
 * search every node is); a RESULT is an offered node inside a match with the chosen kind. Shown = results and their ancestors. The nodes
 * that must be visible ("needed") are the shown ones that match the search by themselves (with an empty search: the results), and their
 * strict ancestors are `forcedOpen`. One pass forward (the nodes are in pre-order, so a parent is always met first) and one backward.
 */
export function filterPicker(model: PickerModel, query: string, kind: string): PickerView {
  const needle = query.trim().toLowerCase();
  if (needle === "" && kind === "") {
    return { filtering: false, shown: null, results: null, count: model.offeredCount, shownKids: new Set(), forcedOpen: new Set(), total: model.nodes.length };
  }
  const nodes = model.nodes;
  const size = nodes.length;
  const self = new Uint8Array(size); // matches the search by itself
  const inside = new Uint8Array(size); // it, or an ancestor, matches the search
  const result = new Uint8Array(size);
  const results = new Set<number>();
  for (let i = 0; i < size; i++) {
    const node = nodes[i];
    if (needle !== "" && nameOrKindMatches(node, needle)) self[i] = 1;
    inside[i] = needle === "" || self[i] === 1 || (node.parentIndex >= 0 && inside[node.parentIndex] === 1) ? 1 : 0;
    if (node.offered && inside[i] === 1 && (kind === "" || node.kindKey === kind)) {
      result[i] = 1;
      results.add(node.id);
    }
  }

  const shown = new Set<number>();
  const shownKids = new Set<number>();
  const forcedOpen = new Set<number>();
  const underResult = new Uint8Array(size); // a result strictly below
  const underNeeded = new Uint8Array(size); // a needed node strictly below
  for (let i = size - 1; i >= 0; i--) {
    const node = nodes[i];
    const isShown = result[i] === 1 || underResult[i] === 1;
    if (isShown) shown.add(node.id);
    if (underNeeded[i] === 1) forcedOpen.add(node.id);
    const needed = isShown && (needle !== "" ? self[i] === 1 : result[i] === 1);
    if (node.parentIndex < 0) continue;
    if (isShown) {
      underResult[node.parentIndex] = 1;
      shownKids.add(node.parentId as number);
    }
    if (needed || underNeeded[i] === 1) underNeeded[node.parentIndex] = 1;
  }
  return { filtering: true, shown, results, count: results.size, shownKids, forcedOpen, total: shown.size };
}

/** What the person has done to the folds. marks: true = folded by the person, false = opened by the person or by a pick. seedOpen: the branches that held a pick when the picker opened. */
export interface FoldState { marks: ReadonlyMap<number, boolean>; seedOpen: ReadonlySet<number> }

/** Filtering rows from this depth down fold when the filtered list is long: the same rows the tree's default fold folds. */
const FOLD_FROM_DEPTH = TREE_DEFAULT_LEVEL - 1;

/**
 * Not filtering: the person's mark, else the default fold (unless a pick held the branch open at the start). Filtering: a branch that leads
 * to a needed row is open (a hit must be visible); else the person's mark; else a list of more than 60 shown rows folds from the second
 * level down (so a search that matches the top row draws that row and the level under it), and a shorter list is open.
 */
export function isFolded(model: PickerModel, view: PickerView, state: FoldState, id: number): boolean {
  const mark = state.marks.get(id);
  if (!view.filtering) return mark ?? (model.defaultFolded.has(id) && !state.seedOpen.has(id));
  if (view.forcedOpen.has(id)) return false;
  if (mark !== undefined) return mark;
  return view.total > FOLD_ROW_LIMIT && (model.byId.get(id)?.depth ?? 0) >= FOLD_FROM_DEPTH;
}

export interface VisibleRow {
  node: PickerNode;
  foldable: boolean;
  /** true for a row that is not foldable */
  open: boolean;
  /** its fold button must be disabled: a hit below it has to stay visible */
  locked: boolean;
}

/** The rows to draw, in order: not under a folded row, and (when filtering) shown. */
export function visibleRows(model: PickerModel, view: PickerView, state: FoldState): VisibleRow[] {
  const rows: VisibleRow[] = [];
  let hiddenBelow = Infinity; // while a folded row is above: everything deeper than its depth is hidden
  for (const node of model.nodes) {
    if (node.depth > hiddenBelow) continue;
    hiddenBelow = Infinity;
    if (view.shown && !view.shown.has(node.id)) continue;
    const foldable = view.filtering ? view.shownKids.has(node.id) : node.hasKids;
    const open = !foldable || !isFolded(model, view, state, node.id);
    if (!open) hiddenBelow = node.depth;
    rows.push({ node, foldable, open, locked: view.filtering && foldable && view.forcedOpen.has(node.id) });
  }
  return rows;
}

/** The ids of the STRICT ancestors of the ids that are in the model (the others are ignored). */
export function ancestorsOf(model: PickerModel, ids: Iterable<number>): Set<number> {
  const out = new Set<number>();
  for (const id of ids) {
    let at = model.byId.get(id);
    while (at && at.parentIndex >= 0) {
      const parent = model.nodes[at.parentIndex];
      if (out.has(parent.id)) break; // its own ancestors were added with it
      out.add(parent.id);
      at = parent;
    }
  }
  return out;
}

/** Indexed by PickerNode.index: the results below the node (not counting it), and those of them not in `picked`. */
export interface Below { results: number[]; pending: number[] }

/** One backward pass. A result is `node.offered` when not filtering, else a member of `view.results`. */
export function countsBelow(model: PickerModel, view: PickerView, picked: ReadonlySet<number>): Below {
  const nodes = model.nodes;
  const results = new Array<number>(nodes.length).fill(0);
  const pending = new Array<number>(nodes.length).fill(0);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.parentIndex < 0) continue;
    const isResult = view.results ? view.results.has(node.id) : node.offered;
    results[node.parentIndex] += results[i] + (isResult ? 1 : 0);
    pending[node.parentIndex] += pending[i] + (isResult && !picked.has(node.id) ? 1 : 0);
  }
  return { results, pending };
}

export type PickAll = { kind: "none" } | { kind: "add"; ids: number[] } | { kind: "refuse"; count: number; room: number };

/**
 * What "Pick all under" does: the results strictly below `id` that are not picked yet, in tree order, if they all fit in `max`; else
 * nothing (a refusal that says how many there were and how much room is left).
 */
export function pickAllUnder(model: PickerModel, view: PickerView, id: number, selected: readonly number[], max: number): PickAll {
  const node = model.byId.get(id);
  if (!node) return { kind: "none" };
  const picked = new Set(selected);
  const ids: number[] = [];
  for (let i = node.index + 1; i < node.end; i++) {
    const below = model.nodes[i];
    const isResult = view.results ? view.results.has(below.id) : below.offered;
    if (isResult && !picked.has(below.id)) ids.push(below.id);
  }
  if (ids.length === 0) return { kind: "none" };
  const room = Math.max(0, max - selected.length);
  return ids.length <= room ? { kind: "add", ids } : { kind: "refuse", count: ids.length, room };
}

const ELLIPSIS = String.fromCharCode(0x2026);

/**
 * The text a chip draws for a label of the form "Name (A / B / C / D) #id": the name and the LAST TWO segments of the path (the end is what
 * tells same-named assets apart), the ellipsis standing for the segments left out, and the " #id" kept. A label with two segments or fewer, or
 * not of that form, comes back unchanged. The chip's title and remove button keep the whole label.
 */
export function chipText(label: string, name: string): string {
  if (!label.startsWith(name)) return label;
  const match = /^ \((.*)\)( #\d+)?$/.exec(label.slice(name.length));
  if (!match) return label;
  const segments = match[1].split(" / ");
  if (segments.length <= 2) return label;
  return `${name} (${ELLIPSIS} / ${segments.slice(-2).join(" / ")})${match[2] ?? ""}`;
}

/** Whether two lists of assets are the same for the picker: the same length and, item by item, the same object or the same (id, parent_id, name, kind, sort_order). */
export function sameAssets(a: readonly Asset[], b: readonly Asset[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x.id !== y.id || x.parent_id !== y.parent_id || x.name !== y.name || x.kind !== y.kind || x.sort_order !== y.sort_order) return false;
  }
  return true;
}
