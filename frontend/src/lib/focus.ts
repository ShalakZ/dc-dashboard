import type { Asset } from "../api/types";

/** What the dashboard's `?asset=` parameter says: nothing, an asset id, or something that cannot be one. */
export type FocusParam = { kind: "none" } | { kind: "id"; id: number } | { kind: "invalid" };

/** The largest id the server's 32-bit asset column can hold. */
const MAX_ASSET_ID = 2147483647;

/** Pass `searchParams.get("asset")`: a missing parameter is `null`, a bare `?asset=` is the empty string (invalid). */
export function parseFocusParam(raw: string | null): FocusParam {
  if (raw === null) return { kind: "none" };
  if (!/^[1-9]\d*$/.test(raw)) return { kind: "invalid" };
  const id = Number(raw);
  return id <= MAX_ASSET_ID ? { kind: "id", id } : { kind: "invalid" };
}

/** `search` (with or without the leading question mark) with `asset` set to `id`, or removed for null; every other parameter stays. The result is like `location.search`: empty, or starting with `?`. */
export function withFocus(search: string, id: number | null): string {
  const params = new URLSearchParams(search);
  if (id === null) params.delete("asset");
  else params.set("asset", String(id));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** Shown when a link names an asset that is not there (R4). */
export const FOCUS_GONE_NOTICE = "The asset in this link no longer exists, so the dashboard shows the whole site.";
/** Shown when a link names an asset to a role that cannot open assets (R3); it names nothing. */
export const FOCUS_DENIED_NOTICE = "This link opens the dashboard on one asset. Your role cannot open assets, so it shows the whole site.";

/** The assets with no parent in the list (the server's tree roots), in the tree's order: sort_order, name by code point, id. */
export function topLevel(assets: Asset[]): Asset[] {
  const ids = new Set(assets.map((asset) => asset.id));
  return assets
    .filter((asset) => asset.parent_id === null || !ids.has(asset.parent_id))
    .sort((x, y) => x.sort_order - y.sort_order || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0) || x.id - y.id);
}
