import type { Asset, Widget, WidgetConfig } from "../api/types";

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

/** Does this widget draw the dashboard's focus asset (or its children) instead of assets of its own? Only such a widget sends the focus to the server. */
export function isFollowing(config: Pick<WidgetConfig, "scope">): boolean {
  return config.scope === "focus" || config.scope === "children";
}

/** Does any data widget of the dashboard follow the focus? When none does, choosing a focus changes nothing on the page, so nothing may offer to narrow it (W2). */
export const anyWidgetFollows = (widgets: readonly Widget[]): boolean => widgets.some((widget) => widget.type !== "text" && isFollowing(widget.config));

/** What a following card says when the site has no assets to look at (a site with nothing in it). */
export const NO_ASSETS_TEXT = "This site has no assets yet.";

/**
 * What a card says instead of a figure when the server answers `state: "choose"` (R5): the site has other than one top-level asset and the dashboard has
 * no focus. `count` is the answer's `top_level`; `allowed` is whether the viewer can choose a focus (it needs the Assets Tree).
 */
export function chooseText(count: number | null, allowed: boolean): string {
  if (count === 0) return NO_ASSETS_TEXT;
  if (count === null) return allowed ? "Choose a focus to see this figure." : "This figure needs a focus asset, and your role cannot choose one.";
  const assets = `${count} top-level ${count === 1 ? "asset" : "assets"}`;
  return allowed
    ? `This site has ${assets}: choose a focus to see this figure.`
    : `This site has ${assets}, so this figure needs a focus asset, and your role cannot choose one.`;
}

/** The sentence of a "children" card whose focus asset has no children; `path` is the answer's `focus.asset.path`. */
export const leafText = (path: string): string => `${path} has no children.`;

/** The footer note of a "children" card that shows only the first of many (R6); with no focus asset it is the site's top-level assets. */
export const childrenNote = (shown: number, count: number, assetName: string | null): string =>
  assetName === null ? `${shown} of ${count} top-level assets shown` : `${shown} of ${count} children of ${assetName} shown`;

/** The footer note of a card that keeps its own assets while the dashboard has a focus (R11). */
export const ownAssetsNote = (focusName: string): string => `Its own assets, not ${focusName}`;
