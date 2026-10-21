import { keys } from "../api/queries";
import type { TagListUndoResult } from "../api/types";

/**
 * What a tag list (or its Undo) moves: the sources' counts and points, the assets (their summaries), the graph, the fleet figures, billing and the widgets'
 * figures (a mapping feeds all of them), the tariffs (an asset that went had its rates) and the audit log (both writes are audited). They are read again after
 * a call that worked AND after one that failed: a 409 means the lists on screen are out of date too.
 */
export const TAG_LIST_REFRESHED = [keys.sources, keys.assets, keys.graph, keys.fleet, keys.billing, keys.widgetData, keys.tariffs, keys.auditAll] as const;

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;

/**
 * The sentence for a finished Undo: the server's own (`text`, which already says which points stay and why) or, when an older server sends none, the counts in
 * the same words. Points that hold readings stay as unmapped points; the sentence must say so.
 */
export function undoSentence(result: TagListUndoResult): string {
  const text = result.text?.trim();
  if (text) return text;
  const kept = result.points_kept;
  const tail = kept > 0 ? ` ${plural(kept, "point")} stay${kept === 1 ? "s" : ""} because ${kept === 1 ? "it holds" : "they hold"} readings.` : "";
  return `Removed ${plural(result.mappings, "mapping")}, ${plural(result.assets, "asset")} and ${plural(result.points_removed, "point")}.${tail}`;
}
