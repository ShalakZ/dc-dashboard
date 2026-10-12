import type { Asset } from "../api/types";

/** `assetKind` and `assetIcon` are the asset's kind text and chosen icon id, set on asset hits only (the popup picks the row's icon from them). */
export interface FindHit {
  kind: "asset" | "page"; key: string; label: string; detail: string | null; to: string; assetKind?: string; assetIcon?: string | null;
}

const SEPARATOR = " / ";
const DEFAULT_LIMIT = { assets: 8, pages: 5 };

/** Code-point comparison, as in lib/tree.ts: the same order on every runtime. */
const compareText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** The names above an asset, the top one first. A parent that is missing, or one already seen (a cycle), ends the walk. */
function namesAbove(asset: Asset, byId: ReadonlyMap<number, Asset>): string[] {
  const names: string[] = [];
  const seen = new Set([asset.id]);
  let parent = asset.parent_id === null ? undefined : byId.get(asset.parent_id);
  while (parent && !seen.has(parent.id)) {
    names.unshift(parent.name);
    seen.add(parent.id);
    parent = parent.parent_id === null ? undefined : byId.get(parent.parent_id);
  }
  return names;
}

/** 0 when `text` starts with the query, 1 when it holds it further in, -1 when it does not. */
const rankText = (text: string, needle: string) => (text.startsWith(needle) ? 0 : text.includes(needle) ? 1 : -1);

/**
 * The quick find's answer: assets first (name starts with the query, name contains it, only the path "Site / MV2 / Room-1" does;
 * ties by path, then id), then pages (label starts with, then contains, in the order given), each kind cut at its limit.
 * The query is trimmed and compared in lower case; an empty one finds nothing.
 */
export function findHits(
  query: string,
  assets: readonly Asset[],
  pages: readonly { label: string; to: string }[],
  limit: { assets: number; pages: number } = DEFAULT_LIMIT,
): FindHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const found: { rank: number; path: string; asset: Asset; above: string[] }[] = [];
  for (const asset of assets) {
    const above = namesAbove(asset, byId);
    const path = [...above, asset.name].join(SEPARATOR);
    const nameRank = rankText(asset.name.toLowerCase(), needle);
    const rank = nameRank >= 0 ? nameRank : path.toLowerCase().includes(needle) ? 2 : -1;
    if (rank >= 0) found.push({ rank, path, asset, above });
  }
  found.sort((x, y) => x.rank - y.rank || compareText(x.path, y.path) || x.asset.id - y.asset.id);

  const assetHits: FindHit[] = found.slice(0, limit.assets).map(({ asset, above }) => ({
    kind: "asset",
    key: `asset:${asset.id}`,
    label: asset.name,
    detail: above.length > 0 ? above.join(SEPARATOR) : null,
    to: `/assets/${asset.id}`,
    assetKind: asset.kind,
    assetIcon: asset.icon ?? null,
  }));

  const pageHits: FindHit[] = pages
    .map((page) => ({ page, rank: rankText(page.label.toLowerCase(), needle) }))
    .filter(({ rank }) => rank >= 0)
    .sort((x, y) => x.rank - y.rank) // stable: the order given breaks a tie
    .slice(0, limit.pages)
    .map(({ page }) => ({ kind: "page", key: `page:${page.to}`, label: page.label, detail: null, to: page.to }));

  return [...assetHits, ...pageHits];
}
