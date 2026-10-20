import type { DisplayLimits, DisplayRow, DisplaysList, PlaylistItemRow, PlaylistRow } from "../../api/types";

/** Shared by the Displays tests: the answer of `GET /api/displays` and its parts, with the defaults the server lists. */
export const LIMITS: DisplayLimits = { displays: 50, playlists: 30, items: 20, min_seconds: 10, max_seconds: 3600 };

export const playlistItem = (id: number, over: Partial<PlaylistItemRow> = {}): PlaylistItemRow => ({
  id, position: id, seconds: 60, dashboard_id: 3, dashboard_name: "Hall A", focus_asset_id: null, focus_name: null, skipped: null, ...over,
});

export const playlist = (id: number, name: string, items: PlaylistItemRow[] = [], over: Partial<PlaylistRow> = {}): PlaylistRow => ({
  id, name, item_count: items.length, skipped_count: items.filter((i) => i.skipped !== null).length, display_count: 0, items, ...over,
});

export const screenRow = (id: number, name: string, playlistId: number, playlistName: string, over: Partial<DisplayRow> = {}): DisplayRow => ({
  id, name, playlist_id: playlistId, playlist_name: playlistName, status: "active", created_at: "2026-10-20T08:00:00+00:00",
  last_seen_at: null, last_client: null, revoked_at: null, ...over,
});

export const displaysList = (over: Partial<DisplaysList> = {}): DisplaysList => ({ displays: [], playlists: [], limits: LIMITS, ...over });

/** The dashboards a playlist item can name (`GET /api/dashboards`). */
export const DASHBOARDS = [
  { id: 3, name: "Hall A", range: "24h", widget_count: 2, updated_at: "2026-10-08T06:00:00+00:00" },
  { id: 4, name: "Hall B", range: "7d", widget_count: 1, updated_at: "2026-10-07T10:30:00+00:00" },
  { id: 5, name: "Ops", range: "24h", widget_count: 3, updated_at: "2026-10-06T10:30:00+00:00" },
];
