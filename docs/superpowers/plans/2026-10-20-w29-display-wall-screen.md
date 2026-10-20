# w29: display mode, part 2: the rotating wall screen and the device guide

Wave w29, branch `wave/w29` from `main` a425e86 (w22 to w28 merged; dev stack at migration 0015). Brief: `.waves/w29.md` (rulings R1 to R14 there are binding unless this plan says otherwise in "Rulings of the plan"). Ledger: `.waves/w29/progress.md`.

**Tier M** (front-end behaviour change on a page that runs unattended for days; no migration, permission, route, field or budget on the server). Two tier-L exceptions: every diff on the credential path of the browser (T3) gets a mandatory per-task Opus security review, and T7 (optional) runs only on a measurement.

**Ports.** vis `dcdash_e2e_w29_vis` 18248/18602, look `dcdash_e2e_w29_look` 18249/18603 (both free on 2026-10-20 22:06, `ss -ltn`); the look stack's front end for changes not yet built is a vite dev server on 18250 (`VITE_API_TARGET=http://127.0.0.1:18249`).

## Facts checked in the code (a425e86)
- `main.tsx:82-90` branches on `isDisplayPath` before any provider; `installChunkReload()` runs only in `mountApp()`; `display/mainBranch.test.ts:32-37,43-48` pin both. All stylesheets are imported at the top of `main.tsx`, so every widget style exists on the display page.
- `displayLoop.ts`: `startDisplay(link, onState, deps)` returns `stop()`; after the first success a failed poll still emits `offline` (a full-screen sentence): R10 says it must not once a dashboard was drawn. `REVOKED_RECHECK_MS` (300 s) is used twice (`:177`, `:198`). `DisplayState.connected` carries only counts and names.
- `displayApi.ts`: `DisplayItem.dashboard/focus` and `DisplayPlaylist.site/build/status` are `unknown`; `PlaylistReply` has no server time. Server shapes (`api/display.py:423-470`): item `{id, seconds, dashboard {id, name, range, widgets[{id,type,title,config,x,y,w,h}]}|null, focus {id,name,trail}|null, skipped}`; `site {name, timezone}`; `build`; `status {collector_alive, readings_fresh (null = nothing read yet), last_reading_age_seconds}`.
- `POST /api/display/widget-data {item, widget}` (strict ints): 404 `not found` for a skipped item or an unknown widget, 422 for a text widget or an unstorable one, 429 with `Retry-After` (60 s budget, or 1 s for the in-flight cap), the answer is `/api/widget-data`'s (`WidgetData`).
- `WidgetFrame` (csv/details optional; `lib/download` only runs on a click), `WidgetBody` (charts are lazy chunks), `TextWidgetView` (view mode, no `actions`) are reusable. `StaticGrid` = `compactVertical` + `readingOrder` + CSS grid (80 px rows, 10 px gap, 12 columns, `lib/gridMetrics.ts`). `widgets.css:11` has a viewport `@media (max-width: 700px)` that turns the grid into a block: the wall's stylesheet overrides it. Card widths use `@container` (layout size, unaffected by a transform).
- `widgetRefetchMs` and its constants live in `api/queries.ts:716-724` next to the react-query hooks (`queries.test.tsx` pins 30 s / 5 minutes). The wall does NOT use them (A12): it has its own `wallRefetchMs` in `wallRules.ts`, comparisons every 60 s.
- ECharts is mounted by `TimeSeriesWidget` (two `ReactECharts`) and `BarWidget` (three), `TrendChart.tsx` (not used by the wall). `echarts-for-react` forwards its `opts` prop to `echarts.init`; `opts.devicePixelRatio` is honoured.
- The Displays page: `useDisplays` (`api/queries.ts:779`) never refetches.
- Not verifiable here: the real site's TVs; T0 measures the rest.

## Rulings of the plan (on top of R1 to R14)
- P1 **Contract first.** The controller (`wallController.ts`) and the view (`WallScreen.tsx`) meet at the types in `display/wallTypes.ts` (below), written before either; the view is tested with hand-made snapshots, the controller with a fake `fetchWidget` and manual timers. This lets T1b and T2b run side by side.
- P2 **`transform: scale(s)`** on ONE box (origin top left) is the first choice for R5 (text stays sharp in Chromium; layout code sees logical sizes); CSS `zoom` is the fallback if T0's screenshots show blur. Charts get `devicePixelRatio = window.devicePixelRatio * s` through a React context `ChartPixelRatioContext` (default `undefined` = the app's charts get no option, unit-tested) read by `TimeSeriesWidget` and `BarWidget`.
- P3 **`displayLoop` stays the owner of the claim and the playlist poll.** It gains: `connected` carries `{reply, receivedAt, serverDate}` and is emitted after EVERY successful read; after a first success a failed read (network, 5xx, not a playlist) emits nothing and retries with the existing backoff (the full-screen `offline` stays only for "never connected"); the returned stop function gains `.refresh()` (read now, single flight, and restart the poll timer; used by the wall for a 404, a wake, and by nothing else); the revoked schedule 5, 15, 60 minutes then stop (a read that answers 200 resets it; "not connected" and "blocked" unchanged). The wall owns widget requests, rotation, bands and the clock.
- P4 **One module per concern** (all in `frontend/src/display/` unless noted): `displayApi.ts` (typed playlist + `widgetData()` + Date header), `wallRules.ts` (pure: constants, shown items, next item, retry waits with jitter, band decisions, clock offset, build-reload decision, revoked schedule), `wallQueue.ts` (2 in flight, priority, retry/backoff), `wallController.ts` (the state machine), `wakeEvents.ts` (heartbeat jump + `visibilitychange` + `pageshow` + `online` -> one callback), `wakeLock.ts`, `fit.ts` (pure), `WallScreen.tsx`, `WallCard.tsx`, `styles/display-wall.css`, `wakeEvents.ts`.
- P5 **Band text** (the words are the brief's): readings "Readings stopped arriving at HH:MM." (no time when the age is null: "Readings stopped arriving."), collector "The data collector stopped." (two polls in a row), screen "This screen has not been updated since HH:MM. Trying again...". Priority: screen over collector over readings (one band at a time). Times in the site's time zone (`site.timezone`; the browser's if it is not a zone the browser knows).
- P6 **Swap** = prefetch, wait, fade: from 8 s before an item's turn (at once when its `seconds` are 8 or less) the NEXT shown item (read from the newest playlist) is requested at low priority; at the turn the swap happens when all its cards answered (a failure counts as answered), or 5 s after the turn; `phase: "out"` for 150 ms, the item changes, `phase: "in"` for 150 ms (both by timers; under `prefers-reduced-motion` no phase at all). One shown item: no swap, except that a changed item (any difference in its dashboard, widgets or focus) goes through the same prefetch-wait-fade at once. A pinned item whose dashboard was deleted or is now skipped goes at the next turn.
- P7 **Request rhythm.** A card of the pinned item is requested when it has no answer, or its answer is older than `wallRefetchMs(config)` (30 s; 60 s for a comparison, A12); a card of the prefetched item the same way (an answer kept from the last showing counts by its age, so a 3-item playlist at 20 s asks every card about once a minute). A request for a widget that is not a data type (`text`) is never made. `document.hidden`: no widget request, no timer but the playlist poll (`displayLoop`) and the heartbeat.
- P8 **Chart sharpness and fit values** are computed in `fit.ts` from the window (`innerWidth`, `innerHeight`) and the dashboard's natural height; the view sets inline `--wall-s` (unitless scale) and `--wall-unit` (`innerHeight / 1080`, unitless); the stylesheet derives every type floor from those two, never from a media query.

## The contract: `display/wallTypes.ts` (types only; T1a creates it, verbatim, together with the typed `displayApi.ts`)
```ts
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
```
(`WidgetReply = { status: number; data: WidgetData | null; retryAfter: number | null; serverDate: number | null }`, defined in `displayApi.ts` by T1a.)

## Amendments from the plan review (2026-10-20, `.waves/w29/plan-review.md`; they override anything above or in the brief that disagrees)
- **A1 (I1, I2) An edit, a delete or a skip of the PINNED item applies at once**, for any number of items, through prefetch-wait-fade: when a feed shows that the pinned item differs from its newest definition (`itemsDiffer`), the target is that item's new definition; if it is gone or skipped, the target is the next shown item, or the empty sentence when none is shown. A widget that answered 404 is not asked again until the next feed; `refreshPlaylist()` after a 404 runs only when the newest playlist still lists that (item, widget), at most once per 10 s. The build change and the "boundary" for one shown item: the item's turn (`pinnedAt + seconds`) still passes with no swap, and the reload happens there (also at once when nothing is pinned). Ruling: R3's "applies at the next boundary" is replaced by "at once" for the pinned item - why: its widget ids change on every save, and a frozen pinned item would 404 for up to an hour; if wrong, one fade more than the owner wanted.
- **A2 (I3) Every wall request has a timeout**: `getPlaylist`, `widgetData` and `claim` pass `signal: AbortSignal.timeout(20_000)` (a tiny helper with a fallback to `AbortController` + `setTimeout`); a timeout is a failure (for the claim: "unreachable", the secret stays in the handle). This is a `displayApi.ts` diff on the credential path: it goes into T3's security review with the whole file's diff since a425e86 (M4).
- **A3 (I4) What band 2 measures.** `bandClock` = the last successful CARD answer when the pinned item has data cards (initial value: the moment the item was pinned), else the last successful playlist or card answer. Band 2 when `now - bandClock >= 120 s` and not held by a wake. `notUpdated` drops the "another card answered" condition: a card is dimmed and tagged when its own failures are 120 s old or more.
- **A4 (I5) Statuses of a widget request:** 200 with figures -> ok; 200 without figures, a network error, a timeout, a 5xx (including 502/503 from the proxy), 401 -> `failed` (backoff 5,10,20,40,60 s with jitter, queue-wide cool-down); a 401 also calls `refreshPlaylist()` (so the revoked sentence comes at once, at most once per 10 s); 404 -> `moved`; 409 and 422 -> `rejected` (the card is "unavailable", asked again after 10 minutes); 429 -> busy: queue-wide wait of `Retry-After` (default 60 s, 1 to 120 s) plus 0 to 30 %, not a failure, no result is reported (the job stays queued).
- **A5 (I6)** The R1 request test (every request goes to `/api/display/*`, `notifyUnauthorized` never called, a whole playlist rendered) moves to T3, where the real controller exists. T2b tests the view with a hand-made fake wall.
- **A6 (I7) Two timer sets.** `DisplayApp` takes `timers` (the loop's, as today) and a new optional `wallTimers` (default `realTimers`) for the wall, so the 23 `c.delays` assertions of `DisplayApp.test.tsx` only see the loop's timers. T3 also updates the two-recheck sequences at `DisplayApp.test.tsx:241-246` and `:448-455` (5, then 15 minutes).
- **A7 (I8) `wake()` does nothing while `isHidden()`** (a throttled heartbeat of a hidden tab must not read anything); the `visibilitychange` to visible does the work. The e2e outage and the soak move the clock with `runFor` (never `fastForward`, which is a wake by design); w28 case 3's `fastForward(61_000)` reaches "revoked" through the wake path, which is fine.
- **A8 (I9) The build reload** waits a jittered 10 to 30 s after the wall first saw the new build (it spreads ten screens), then reloads at the next boundary through `deps.reload`, which T3 implements as: probe `HEAD /` (the probe of `lib/chunkReload.ts`), then reload, with the SAME sessionStorage key and 10 s guard as the chunk reload (T3 exports a shared helper from `lib/chunkReload.ts`, with tests); blocked storage = no automatic reload.
- **A9 (I10) `refresh()` of the loop** does nothing unless the last emitted state is `connected` (or the loop was connected and is now retrying after a failed read), is ignored while a 429 `Retry-After` wait is pending or a read is in flight, and never touches a claim timer or the revoked schedule. T3's security review checks it.
- **A10 (I11) Band 1's time.** When the age is under 60 s (the freshness floor; an unmapped point still polled keeps `max(ts)` near now) or null, the text is the timeless "Readings stopped arriving."; otherwise the stopped time is fixed once when the band opens and kept until it clears.
- **A11 (I12) Marks and notes travel.** The header legend is the app's own `markerHint` of the UNION of the flags of the cards on screen (so "~ estimated", "* partial", "-- no rate" and the missing-hours words appear whenever a card carries them). A card's focus note (`childrenNote`, `ownAssetsNote`, computed as `WidgetView` does) is shown as a chip in the card head, and the focus sentences (`chooseText`, `leafText`, `NO_ASSETS_TEXT`) replace the body as in `WidgetView`. No footer line.
- **A12 (I13) The wall asks comparison cards every 60 s** (30 s for the others): `wallRefetchMs` in `wallRules.ts`. `api/widgetRefetch.ts` is NOT created and `api/queries.ts` is not touched by T1a (the wall does not use `widgetRefetchMs`). R9.2's arithmetic: a card is at most 60 s + the figure cache's 60 s behind, and "Updated" trails the clock by at most about two minutes; this goes into the docs, not "30 s + 60 s".
- **A13 (I14) After the first success the loop's read backoff is 5, 10, 20 s (cap 20 s) with 0 to 30 % jitter** (`DisplayDeps.random`, default `Math.random`; before the first success nothing changes), so a server that returns after 75 to 120 s is reached within 20 s and band 2 never shows over a working server. The final gates include a measured `look-refresh.sh` downtime while a wall runs (the controller's check).
- **A14 (M1 to M11)** `wallTypes.ts` imports as shown above; `snapshot()` identity and a minute-resolution `now` (M2); a clock offset change of 2 s or less is ignored and `updatedAt` is clamped to `now` (M3); the collector band needs `collector_alive` false on reads at least 50 s apart with none true in between (M5); kept answers are pruned on every feed to the widgets of the newest playlist and held only for the pinned and the next item (M6); the outer `DisplayBoundary` stays as it is (a render error outside a card is a bug; its remount restores the wall) - accepted; the per-card boundary is keyed by `answeredAt`, so it resets on the next answer (M8); `installChunkReload()` is called in an effect that returns its remover, and `main.tsx`'s comment plus `mainBranch.test.ts:32`'s title (now untrue) are noted in BN, not edited (M9); docs: `display-screens.md:61`, `:107-111`, `:5`'s `#what-comes-next` link (M10); `formatClock` returns `null` for a zone the browser does not know and nothing is drawn instead of a wrong time (w27's rule); T5 also samples the renderer's process memory (canvas backing stores), not only the JS heap; `naturalHeight` uses `compactVertical`.

## Existing tests that will change (A1 grep, 2026-10-20)
- `src/display/DisplayApp.test.tsx`: `:31` (FIVE_MINUTES), `:82` and `:224` (the connected sentence "... The rotating screen arrives in the next update."), every case that waits for that sentence (the helper at `:82`), `:399` and `:662` (`.display-screen` for the five full-screen states stays), `:511` (Retry-After table for the poll), `:695-697` (two revoked rechecks of 300 s: the second is now 15 minutes). Fixtures with `dashboard: null` items become "skipped" on the wall.
- `src/display/mainBranch.test.ts` stays green (the chunk reload goes into an effect of `DisplayApp`, never into `main.tsx`).
- `src/api/queries.test.tsx` (refetch pin: kept by the re-export); any test of `useDisplays` (grep in T3).
- `src/app.css.test.ts:733` list: add `display-wall.css`.
- `e2e/w28.spec.ts`: header `:17`, `:25`, `connected()` at `:207-209` and its callers (cases 1, 2 `:376,384`, 2b `:458`, 3 `:481` with `fastForward(61_000)` at `:495`, 4 `:523,534` "(1 skipped)"); the sentence is gone, the wall names the dashboard in its `h1` and "N of M". Case 6 is no longer the last case of the last project.
- `e2e/playwright.config.ts` (project `w29`, `dependencies: ["w28"]`); `docs/end-to-end-tests.md:457` (and a w29 paragraph); `docs/display-screens.md:5,58,63,119-123`.
- Substring traps: "Updated" is also the app's dashboard header (`DashboardViewer.tsx:25`); the wall page has no app header, but the e2e specs of w27 run on other pages. "Readings stopped", "Nothing to show" and "of 2" have no hits in `e2e/` today; use `exact`.
- LESSONS B (new stylesheet): `display-wall.css` is one `@layer w6` block, tokens only inside it, no raw colour; every selector names a class; `app.css.test.ts` guards. Front end pack 1 (reserved slots: the bands overlay the bottom 6 %, nothing moves), 2 (the bands and the fade are the only overlays), 5 (timers, reduced motion), 6 (grep `.widget-*`, `.dash-*`, `.bars-split` before overriding), 7 (one live region: the band; the empty sentence keeps `aria-live`), 9 (`exact` in new specs), 10 (no width threshold in script: the scale is math, the type floors are CSS).

## File map
New: `display/{wallTypes,wallRules,wallQueue,wallController,wakeEvents,wakeLock,fit,WallScreen,WallCard}.ts(x)` and their tests, `styles/display-wall.css`, `components/dashboard/widgets/chartPixelRatio.ts`, `e2e/w29.spec.ts`. Changed: `display/{displayApi,displayLoop,DisplayApp}.ts(x)`, `api/queries.ts` (`useDisplays` refetch only), `lib/chunkReload.ts` (the shared reload helper), `TimeSeriesWidget.tsx`, `BarWidget.tsx` (the optional pixel ratio), `app.css.test.ts`, `e2e/w28.spec.ts`, `e2e/playwright.config.ts`, docs. Untouched: `main.tsx`, `takeFragment.ts`, `secretHandle.ts`, `reloadClean.ts`, `reloadOnLink.ts`, `claim` in `displayApi.ts`, everything under `backend/` (except T7).

## Tasks (one commit each; implementers: fresh Sonnet, briefs in `.waves/w29/brief-*.md`)
- [x] **T0 Baseline and measurements** (controller): look stack up and seeded (done at 22:09), four templates, two playlists, three displays, fixtures into `.waves/w29/fixtures/`, p50/p95 of both widget-data routes and the playlist, api CPU with 0/1/10 displays, the browser floor from the built CSS, `status` of the look stack, DISTINCT build ids for the rebuild-while-running check. Numbers into the ledger. Decides T7.
- [x] **T1a Pure logic** (`displayApi.ts` typed + `widgetData()` + Date header, `wallRules.ts`, `wallQueue.ts`, `wallTypes.ts`, no change to `api/queries.ts`): unit tests for every threshold and boundary, the 2-in-flight queue, `Retry-After` plus jitter, backoff 5,10,20,40,60 s with jitter, ten walls returning with spread-out retries.
- [x] **T2a Fit math and the charts' pixel ratio** (`fit.ts`, `chartPixelRatio.ts` + the two chart widgets): `fit` for Power (8 rows), Cost (12), a 2-row dashboard at 1920x1080 and 3840x2160, header share, type-floor variables.
- [x] **T1b The controller** (`wallController.ts`, `wakeEvents.ts`): rotation, prefetch-wait-fade, the queue, 404 rule, clock offset, bands, build reload, wake, hidden; manual timers.
- [x] **T2b The view** (`WallScreen.tsx`, `WallCard.tsx`, `styles/display-wall.css`, `app.css.test.ts`): R1's composition from a snapshot, header and legend, bands, fade, cursor, per-card boundary, text card, "Not updated since"; tested with a hand-made fake wall (the R1 request test is T3's, A5).
- [x] **T3 Into the page** (`DisplayApp.tsx`, `displayLoop.ts`, `displayApi.ts` timeouts, `wakeLock.ts`, `lib/chunkReload.ts` shared helper, `useDisplays` refetch, `DisplayApp.test.tsx`, the R1 request test of a whole playlist): P3, A2, A6, A8, A9, A13. **Opus security review (mandatory).**
- [x] **T4 End to end** (`e2e/w29.spec.ts`, `w28.spec.ts`, `playwright.config.ts`, `docs/end-to-end-tests.md`): the cases of the brief's T4.
- [x] **T5 Soak** (controller, `.waves/w29/soak-*.mjs`): (a) accelerated 24 simulated hours with `page.clock`, `page.route` fixtures; (b) real time 60+ minutes in the background.
- [x] **T6 Docs and close-out**: `docs/display-screens.md` (R11, R12), `docs/end-to-end-tests.md`, CHANGELOG top, backlog BN, roadmap O-59, gallery `.waves/gallery/w29/`.
- [x] **T7 Optional - NOT RUN** (T0: ratio 1.29 warm, 1.39 cold, under 1.5; parked in BN) (only if T0 shows the display widget-data p50 over 1.5 times the user route's): one asset tree through the display path; byte-equality test of both routes; Opus security review; the full backend suite once.

## Gates (once, near the end, in this order, each through `flock /tmp/dcdash-heavy.lock`)
`npm run typecheck`, `npm test` (full frontend), `npm run build`, the e2e type check (RESUME.md line 8), docs tests (`test_docs_links.py`, `test_readme_ops.py`, `test_repo_hygiene.py`), `vis-rebuild.sh` (judged by its summary line), w28 + w29 alone on the look stack. Backend suite only if T7 ran.

## Review focus
1. Reach and the credential: no request to a user route from the display page; the secret unreadable after the first definite answer; ids only. 2. Honesty: bands never on an api restart; "Updated" on the server's clock; marks on every figure. 3. The look at 1920x1080, 3840x2160 DPR 1, 1920x1080 DPR 2: no scroll, header within 4.5 %, type floors, sharp charts. 4. Days: the soak, a rebuild while a wall runs, sleep and wake, ten displays without a 429 storm.

## Execution log
Times are the machine's clock (+0300), 2026-10-20 to 2026-10-21.
- 22:05 start (attempt 1). 22:11 T0 measurements (display route 1.29 times the user route's p50, so T7 did not run). 22:27 the plan review (Critical 0, Important 14, Minor 11) folded in as Amendments A1 to A14.
- 22:31 to 22:55 T2a (fit math, chart pixel ratio), T1a (typed playlist, rules, request queue), T1b (controller, wake events), T2b (view, stylesheet), T6a (device guide) by fresh Sonnet implementers, one commit each.
- 23:15 T3 (the wall in the page; credential path) and 23:17 T4 (end-to-end spec). The Opus security review of the credential path (Critical 0, Important 1, Minor 5): the Important and two Minors fixed, a scoped re-review (0, 0, 3).
- 00:04 the first Playwright run on a build of the fixes: 592 passed, 1 skipped. 00:10 the rebuild-while-running check (a 9 s outage, no notice, the wall reloaded itself 39 s later). 00:35 the soaks (24 simulated hours; 60 real minutes).
- 00:56 the whole-wave review in a browser (Critical 0, Important 4, Minor 5); the fix wave (queue starvation, legend, false retry line, figure sizes, narrow header, playlist freeze); a scoped re-review of its logic (0, 0, 2).
- 01:13 the final unit gates at 94497a1 (305 files, 10,995 tests) and the final Playwright run.
