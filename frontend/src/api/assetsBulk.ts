import { assetDeletePath, assetImpact } from "../lib/impact";
import { failureReason, type RemoveResult } from "../lib/assetsBulk";
import { api, ApiError } from "./client";
import { loadAssetImpact } from "./queries";
import type { Asset, AssetImpact } from "./types";

/** How many impact requests are on their way at once: enough to open the dialog quickly, few enough not to crowd the server with a hundred. */
const IMPACT_POOL = 6;

/**
 * What deleting each root takes with it, one `GET /api/assets/{id}/impact` per root, at most six at a time. The map is keyed by root, in the order
 * asked. A root whose impact answers 404 is `null`: somebody deleted it already. Any other failure rejects the whole call with that error (and no
 * more requests are started): the dialog then says it could not check, and Delete stays off.
 */
export async function loadImpacts(rootIds: readonly number[]): Promise<Map<number, AssetImpact | null>> {
  const found = new Map<number, AssetImpact | null>();
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < rootIds.length) {
      const id = rootIds[next];
      next += 1;
      try {
        found.set(id, await loadAssetImpact(id));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) found.set(id, null);
        else {
          failed = true;
          throw e;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMPACT_POOL, rootIds.length) }, worker));
  return new Map(rootIds.map((id) => [id, found.get(id) ?? null]));
}

/**
 * The asset list as the server has it right now, the same `GET /api/assets` that `useAssets` reads, but straight from the network: it never
 * goes through the query cache (a cached list is the very thing the delete dialog checks against), and it is not under the `["assets"]` key, so
 * a refresh of the page's own list cannot re-ask it.
 */
export const loadAssetList = () => api.get<Asset[]>("/api/assets");

/** One root to delete: `seen` is what its dialog showed, sent back as the `expect_*` counts so a child added meanwhile is refused instead of deleted unseen. */
export interface RemoveItem { id: number; name: string; seen: AssetImpact }

/**
 * Deletes the roots one at a time, in the order given, each with the route a single delete uses: its own transaction, its own audit row and its
 * own stale-count check on the server. A 404 means somebody deleted it already: counted as gone, and the loop goes on. The first other failure
 * stops the loop (deleting is one-way, so after a surprise the person looks again): that root is `failed` and the roots after it are `notTried`.
 * `onRemoved` is told about each root right after it was deleted or found gone, before the next request, never for the failed or untried ones.
 * It resolves with what happened and never rejects for a failed delete.
 */
export async function deleteAssetsOneByOne(items: readonly RemoveItem[], opts: { onRemoved?: (id: number) => void } = {}): Promise<RemoveResult> {
  const result: RemoveResult = { deleted: [], gone: [], failed: null, notTried: [], assets: 0 };
  for (let at = 0; at < items.length; at += 1) {
    const { id, name, seen } = items[at];
    try {
      await api.del(assetDeletePath(id, seen));
      result.deleted.push(id);
      result.assets += seen.assets;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        result.gone.push(id);
      } else {
        const now = assetImpact(e);
        result.failed = { id, name, reason: failureReason(e), ...(now ? { now } : {}) };
        result.notTried = items.slice(at + 1).map((rest) => rest.id);
        break;
      }
    }
    try {
      opts.onRemoved?.(id);
    } catch {
      // A callback that fails (the page is gone) must not lose the report of a delete that already happened, or stop the roots after it.
    }
  }
  return result;
}
