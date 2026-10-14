import type { BulkDeleteResult } from "../api/queries";

/** The sentences of deleting several asset kinds at once (the dialog's title and message, and the toast that follows). Pure, so a table can pin every wording. */

export const kindsCount = (n: number) => `${n} ${n === 1 ? "kind" : "kinds"}`;
const assetsCount = (n: number) => `${n} ${n === 1 ? "asset" : "assets"}`;
/** `1 asset uses`, `7 assets use`. */
const assetsUse = (n: number) => `${n} ${n === 1 ? "asset uses" : "assets use"}`;

/** Text as a sentence: ends in a full stop (or the ! or ? it already has), so a reason that came without one still reads right before the next sentence. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export const deleteTitle = (total: number) => `Delete ${kindsCount(total)}?`;

/** The names the dialog lists, as the person wrote them: the first `shown`, then how many more (a long selection must not make a tall dialog). */
export function namesLine(names: readonly string[], shown = 8): string {
  if (names.length <= shown) return names.join(", ");
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

/** None of the kinds is in use: the names, and what happens to an asset that carries one of them later. */
export const unusedMessage = (names: readonly string[]) =>
  `${namesLine(names)}. Assets that carry ${names.length === 1 ? "this name" : "these names"} later get an automatic icon.`;

/**
 * Some of the kinds are in use (`used` of the `total`, `assets` assets in all): say how many, and ask where the assets go. One kind alone is named,
 * since the message is then the only place that does (the several-kinds form lists no names).
 */
export function usedMessage({ total, used, assets, name }: { total: number; used: number; assets: number; name: string }): string {
  if (total === 1) return `${assetsUse(assets)} "${name}". Move ${assets === 1 ? "it" : "them"} to another kind, then delete "${name}".`; // the row menu's dialog says the same
  const head = `${used} of these kinds ${used === 1 ? "is" : "are"} used by ${assetsCount(assets)}.`;
  return `${head} Move ${assets === 1 ? "that asset" : "those assets"} to another kind, then delete ${total === 2 ? "both" : `the ${total}`}.`;
}

/** Some are in use and every kind there is has been picked: nowhere to move the assets to. */
export function blockedMessage({ total, assets, name }: { total: number; assets: number; name: string }): string {
  const them = assets === 1 ? "it" : "them";
  if (total === 1) return `${assetsUse(assets)} "${name}". Create another kind to move ${them} to first.`;
  return `Every kind is selected, and ${assetsUse(assets)} ${assets === 1 ? "one" : "some"} of them. Keep at least one kind to move ${them} to.`;
}

/** The kinds that left the registry because of this call: deleted here, or deleted by somebody else before it got to them. The page takes them off its picks. */
export const removedIds = (result: BulkDeleteResult): number[] => [...result.deleted, ...result.gone];

/** Why the first thing that did not go did not: the first refusal, else what stopped the loop. */
export const firstReason = (result: BulkDeleteResult): string => result.failed[0]?.reason ?? result.stoppedBy ?? "";

/**
 * The toast that closes a bulk delete. All gone: a plain confirmation (`Deleted 12 kinds, 7 assets moved to UPS`). Anything refused or left
 * untried: an error that says how many went and names the first kind that did not, with the reason (`Deleted 11 kinds. "Pump" could not be
 * deleted: 1 asset uses it now.`), then why the loop stopped and how many were not tried.
 */
export function bulkToast(result: BulkDeleteResult): { tone: "success" | "error"; text: string } {
  const removed = result.deleted.length + result.gone.length;
  const moved = result.moved ? `, ${assetsCount(result.moved.assets)} moved to ${result.moved.to}` : "";
  const head = removed === 0 ? "No kinds were deleted" : `Deleted ${kindsCount(removed)}`;
  if (result.failed.length === 0 && result.notTried.length === 0) return { tone: "success", text: `${head}${moved}` };
  const parts = [`${head}${moved}.`];
  const [first] = result.failed;
  if (first) {
    const lead = result.failed.length === 1 ? `"${first.name}" could not be deleted` : `${result.failed.length} could not be deleted, the first is "${first.name}"`;
    parts.push(`${lead}: ${sentence(first.reason)}`);
  }
  if (result.stoppedBy !== undefined) {
    const left = result.notTried.length;
    parts.push(`Stopped: ${sentence(result.stoppedBy)}`, `${left} ${left === 1 ? "was" : "were"} not tried.`);
  }
  return { tone: "error", text: parts.join(" ") };
}
