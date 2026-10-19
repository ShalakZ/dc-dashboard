import type { Asset } from "../api/types";
import { topLevel } from "./focus";

/**
 * The assets from the top of the tree down to `focus`, the focus last. An asset whose parent is not in the list counts as a top-level one (as
 * `topLevel` does); an id that is not in the list gives an empty chain. A parent loop (which the tree cannot have) ends the walk instead of hanging it.
 */
export function assetChain(assets: Asset[], focus: number): Asset[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const chain: Asset[] = [];
  const seen = new Set<number>();
  for (let at = byId.get(focus); at && !seen.has(at.id); at = at.parent_id === null ? undefined : byId.get(at.parent_id)) {
    seen.add(at.id);
    chain.push(at);
  }
  return chain.reverse();
}

/**
 * What the dashboard's trail shows after the dashboard's name (R7): the chain from the top-level asset to the focus, root first. A site with ONE
 * top-level asset does not repeat it (R5: no focus already means that asset), so its crumb is left out; a focus that IS that asset leaves nothing.
 * Empty also when the focus is not in the list: the trail is then the plain one.
 */
export function focusTrail(assets: Asset[], focus: number): Asset[] {
  const chain = assetChain(assets, focus);
  if (chain.length === 0) return chain;
  const roots = topLevel(assets);
  return roots.length === 1 && roots[0].id === chain[0].id ? chain.slice(1) : chain;
}
