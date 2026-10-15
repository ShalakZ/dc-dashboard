import { ApiError } from "../api/client";
import type { AssetImpact } from "../api/types";
import { assetLoss } from "./impact";
import { namesLine } from "./kindsBulk";
import { sentence } from "./sentence";
import type { TreeNode } from "./tree";
import { toRoots, type TreeIndex } from "./treeMove";
import { visibleOrder } from "./treeSelect";

/**
 * The plan and the sentences of deleting several assets from the Assets Tree at once. Pure, so a table can pin every wording and every rule
 * (which assets are sent, where the page goes, which row takes the focus). The request loop that uses them is `api/assetsBulk.ts`.
 */

/** The most top-level assets one delete takes (a picked branch counts once): the loop is one request each. */
export const MAX_ROOTS = 100;

/** The error toast for a pick of more than `MAX_ROOTS` top-level assets; `roots` is how many the person picked. */
export const capMessage = (roots: number) => `Up to ${MAX_ROOTS} assets can be deleted at once (you picked ${roots} top-level ones). Pick fewer.`;

export interface PlanItem { id: number; name: string }
/** A pick that sits inside another pick: it is not sent, it goes with `rootName`. */
export interface InsideItem { id: number; name: string; rootName: string }
export interface DeletePlan {
  /** Every pick that is in the tree, in tree order. */
  picked: PlanItem[];
  /** The picks that are sent, in tree order: those with no picked asset above them. */
  roots: PlanItem[];
  /** The other picks, in tree order, each with the picked root above it. */
  inside: InsideItem[];
}

/**
 * What a delete of `ids` would send. Deleting a parent deletes its children, so only the top-level picks are sent (an id below a deleted
 * parent would answer 404), and the picks inside them are told apart so the dialog can say so. Ids that are not in the tree are ignored and a
 * repeated id counts once. `nameOf` gives the name as the person sees it.
 */
export function planDelete(ids: Iterable<number>, index: TreeIndex, nameOf: (id: number) => string): DeletePlan {
  const wanted = new Set<number>();
  for (const id of ids) if (index.has(id)) wanted.add(id);
  const item = (id: number): PlanItem => ({ id, name: nameOf(id) });
  const picked = [...wanted].sort((x, y) => index.rankOf(x) - index.rankOf(y)).map(item);
  const roots = toRoots(wanted, index);
  const rootSet = new Set(roots);
  const rootAbove = (id: number): number => {
    const seen = new Set<number>([id]); // a guard against a parent chain that loops
    for (let up = index.parentOf(id); up !== null && up !== undefined && !seen.has(up); up = index.parentOf(up)) {
      if (rootSet.has(up)) return up;
      seen.add(up);
    }
    return id;
  };
  return {
    picked,
    roots: roots.map(item),
    inside: picked.filter((p) => !rootSet.has(p.id)).map((p) => ({ ...p, rootName: nameOf(rootAbove(p.id)) })),
  };
}

/** What all the roots take with them: the counts added up (each root's subtree counted once, since only roots are asked). */
export function sumImpacts(impacts: readonly AssetImpact[]): AssetImpact {
  return impacts.reduce((sum, i) => ({ assets: sum.assets + i.assets, mappings: sum.mappings + i.mappings, tariffs: sum.tariffs + i.tariffs }), { assets: 0, mappings: 0, tariffs: 0 });
}

export const deleteTitle = (pickedCount: number) => `Delete ${pickedCount} ${pickedCount === 1 ? "asset" : "assets"}?`;

/**
 * Only the picks themselves go and nothing is attached to them: no sub-asset nobody picked (the sum counts every asset in the roots'
 * subtrees, the picks are those the person chose), no mapping, no tariff.
 */
export function isPlainDelete(plan: DeletePlan, sum: AssetImpact): boolean {
  const unpicked = Math.max(0, sum.assets - plan.picked.length);
  return unpicked === 0 && sum.mappings === 0 && sum.tariffs === 0;
}

const SHOWN_NOTES = 3;

/** One sentence per pick inside another pick (the first three), then the rest counted; nothing when no pick is inside another. */
function insideNotes(inside: readonly InsideItem[]): string {
  if (inside.length === 0) return "";
  const stems = inside.slice(0, SHOWN_NOTES).map((i) => `${i.name} is inside ${i.rootName}, which is also picked, so it goes with it`);
  const rest = inside.length - stems.length;
  if (rest === 0) return stems.map((s) => `${s}.`).join(" ");
  const more = rest === 1 ? "and 1 more is inside another picked asset, so it goes with it." : `and ${rest} more are inside other picked assets, so they go with them.`;
  return [...stems.slice(0, -1).map((s) => `${s}.`), `${stems[stems.length - 1]}, ${more}`].join(" ");
}

/**
 * The dialog's message: the picked names (the first eight), a note for each pick inside another, what else goes with them (the existing
 * billing warning, verbatim) when the delete is not plain, and that it cannot be undone. `null` = the numbers are still loading: no message.
 */
export function deleteMessage(plan: DeletePlan, sum: AssetImpact | null): string {
  if (sum === null) return "";
  return [`${namesLine(plan.picked.map((p) => p.name))}.`, insideNotes(plan.inside), isPlainDelete(plan, sum) ? "" : assetLoss(sum), "This can't be undone."]
    .filter((part) => part !== "")
    .join(" ");
}

/** "Delete anyway" is for a delete that takes more than the picks; while the numbers load (and when it is plain) the button reads Delete, so it does not change width when they land. */
export const deleteConfirmLabel = (plan: DeletePlan, sum: AssetImpact | null): "Delete" | "Delete anyway" =>
  sum === null || isPlainDelete(plan, sum) ? "Delete" : "Delete anyway";

/** The root that stopped the loop: `now` is the newer counts when the server refused because more would go than was shown. */
export interface RemoveFailure { id: number; name: string; reason: string; now?: AssetImpact }
export interface RemoveResult {
  /** The roots this call deleted, in order. */
  deleted: number[];
  /** The roots the server said were gone already (a 404: somebody else deleted them). They are not failures. */
  gone: number[];
  /** The first root that could not be deleted, which stopped the loop; null when none did. */
  failed: RemoveFailure | null;
  /** The roots after the failed one: nothing was sent for them. Empty unless `failed` is set. */
  notTried: number[];
  /** How many assets went, as the dialog counted them (the sum of what was shown for the deleted roots). */
  assets: number;
}

/** Why one delete failed, as a sentence a toast can put after a name. */
export function failureReason(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "More was added under it since the numbers were shown.";
    if (error.status === 401) return "Your session has ended. Sign in again.";
    return sentence(error.message);
  }
  return sentence(error instanceof Error ? error.message : String(error));
}

const assetsCount = (n: number) => `${n} ${n === 1 ? "asset" : "assets"}`;
const wasWere = (n: number) => `${n} ${n === 1 ? "was" : "were"}`;

/**
 * The toast that closes a delete. All done: `Deleted 3 assets` (the counts the dialog showed, so branches count), then how many were already
 * gone. Every root already gone: an info toast. A failure: an error that says what went, names the root that stopped the loop with the
 * reason, and how many were not tried; with nothing deleted it never says "Deleted 0 assets".
 */
export function bulkRemoveToast(result: RemoveResult, nameOf: (id: number) => string): { tone: "success" | "info" | "error"; text: string } {
  const { deleted, gone, failed, notTried } = result;
  if (failed === null) {
    if (deleted.length === 0) return { tone: "info", text: "Those assets were already deleted." };
    const head = `Deleted ${assetsCount(result.assets)}`;
    return { tone: "success", text: gone.length === 0 ? head : `${head}. ${wasWere(gone.length)} already gone.` };
  }
  const parts: string[] = [];
  if (deleted.length > 0) parts.push(`Deleted ${assetsCount(result.assets)}${gone.length > 0 ? `, ${wasWere(gone.length)} already gone` : ""}.`);
  else if (gone.length > 0) parts.push(`${wasWere(gone.length)} already gone.`);
  parts.push(`"${failed.name || nameOf(failed.id)}" could not be deleted: ${sentence(failed.reason)}`);
  if (notTried.length > 0) parts.push(`${wasWere(notTried.length)} not tried.`);
  return { tone: "error", text: parts.join(" ") };
}

/** Is `id` somewhere below `ancestor`? */
function isBelow(index: TreeIndex, id: number, ancestor: number): boolean {
  const seen = new Set<number>([id]);
  for (let up = index.parentOf(id); up !== null && up !== undefined && !seen.has(up); up = index.parentOf(up)) {
    if (up === ancestor) return true;
    seen.add(up);
  }
  return false;
}

/**
 * Where the page goes once the open asset is deleted: the parent of the deleted root that is the open asset or lies above it (`/assets/<id>`),
 * or the list (`/assets`) when that root is on the top level; null when the open asset is not affected (or nothing is open). `removed` is the
 * roots that were deleted or found gone; the topmost one wins if more than one is above the open asset.
 */
export function leaveTo({ openId, removed, index }: { openId: number | null; removed: readonly number[]; index: TreeIndex }): string | null {
  if (openId === null) return null;
  const hits = removed.filter((id) => id === openId || isBelow(index, openId, id));
  if (hits.length === 0) return null;
  const top = hits.reduce((best, id) => (index.rankOf(id) < index.rankOf(best) ? id : best));
  const parent = index.parentOf(top);
  return parent === null || parent === undefined ? "/assets" : `/assets/${parent}`;
}

/**
 * The row to focus when the picked rows are gone: the first row left on screen after the first picked row, else the last one left before it,
 * else null. A picked row takes its whole branch with it. "On screen" is `visibleOrder` (a folded branch and a row a filter hides are not
 * candidates); with no picked row on screen there is nothing to anchor on, so null.
 */
export function focusAfterDelete({ nodes, collapsed, visible, pickedIds }: {
  nodes: readonly TreeNode[];
  collapsed: ReadonlySet<number>;
  visible: ReadonlySet<number> | null;
  pickedIds: Iterable<number>;
}): number | null {
  const picked = new Set(pickedIds);
  const gone = new Set<number>();
  const mark = (list: readonly TreeNode[], parentGone: boolean) => {
    for (const node of list) {
      const isGone = parentGone || picked.has(node.id);
      if (isGone) gone.add(node.id);
      mark(node.children, isGone);
    }
  };
  mark(nodes, false);
  const order = visibleOrder(nodes, collapsed, visible);
  const first = order.findIndex((id) => gone.has(id));
  if (first < 0) return null;
  for (let at = first + 1; at < order.length; at += 1) if (!gone.has(order[at])) return order[at];
  for (let at = first - 1; at >= 0; at -= 1) if (!gone.has(order[at])) return order[at];
  return null;
}
