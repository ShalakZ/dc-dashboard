import type { WidgetData } from "../api/types";
import type { Timers } from "./displayLoop";
import type { DisplayItem, DisplayPlaylist, WidgetReply } from "./displayApi";

/** One card of the pinned item. */
export interface CardState {
  /** "loading": never answered; "ok": an answer is kept (it may be older than the last request); "error": failed and nothing kept;
   *  "unavailable": the server refuses this widget (409 or 422): drawn as "This card cannot be shown.", asked again only every 10 minutes. */
  status: "loading" | "ok" | "error" | "unavailable";
  data: WidgetData | null;
  answeredAt: number | null;      // server-clock ms of the kept answer
  /** Server-clock ms of the first failure after the kept answer; null while all is well. Set by a network error, a timeout, a 5xx, a 401, a 200 without figures.
   *  NOT set by a 404 ("moved"), a 429 ("busy") or a 409/422 ("unavailable"). */
  failingSince: number | null;
  notUpdated: boolean;            // failingSince is 120 s old or more: the card is dimmed and says "Not updated since HH:MM"
}
export type BandKind = "screen" | "collector" | "readings";
export interface WallSnapshot {
  item: DisplayItem | null;                          // the pinned item that is drawn; null = nothing to show
  position: { index: number; of: number } | null;     // 1-based index among the SHOWN items
  phase: "in" | "out";                               // "out" during the first half of a swap's fade
  cards: Readonly<Record<number, CardState>>;         // by widget id of `item`; a text widget has no entry
  timezone: string;                                  // the site's zone ("" when the playlist did not say)
  now: number;                                       // server-clock ms at the last rebuild; advances when the clock MINUTE changes (not every second)
  updatedAt: number | null;                          // the OLDEST answeredAt among the cards of `item` that have one; never after `now`
  band: { kind: BandKind; text: string } | null;      // at most one; the view dims the cards to 55 % while it is set
  emptyText: string | null;                          // set when `item` is null and a playlist was fed: the one sentence of R2
}
export interface WallDeps {
  timers: Timers;                                    // the WALL's own timers (DisplayApp's `wallTimers`), not the loop's
  now?: () => number;                                // local ms, default Date.now
  random?: () => number;                             // default Math.random
  fetchWidget: (item: number, widget: number) => Promise<WidgetReply>;     // displayApi.widgetData
  refreshPlaylist: () => void;                       // the loop's refresh(); the loop ignores it unless it is connected
  reload: () => void;                                // the caller's reload: probes the server first and shares the chunk-reload guard (lib/chunkReload); the controller calls it at a boundary, 10 to 30 s after it first saw the new build
  reduceMotion: () => boolean;                       // read at each swap
  isHidden: () => boolean;                           // document.hidden
}
export interface Wall {
  start(): void; stop(): void;                       // start() after stop() works (StrictMode runs an effect twice)
  feed(reply: DisplayPlaylist, receivedAt: number, serverDate: number | null): void;   // one successful playlist read
  wake(): void;                                      // sleep/wake/visible/online: read now, restart the item's timer, no band 2 for 10 s; does nothing while hidden
  snapshot(): WallSnapshot;                          // the SAME object until something visible changed (useSyncExternalStore)
  subscribe(listener: () => void): () => void;
}
