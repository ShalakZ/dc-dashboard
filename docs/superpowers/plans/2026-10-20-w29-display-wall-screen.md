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
- `widgetRefetchMs` + its constants live in `api/queries.ts:716-724` next to the react-query hooks; `queries.test.tsx` pins the 30 s / 5 minute values.
- ECharts is mounted by `TimeSeriesWidget` (two `ReactECharts`) and `BarWidget` (three), `TrendChart.tsx` (not used by the wall). `echarts-for-react` forwards its `opts` prop to `echarts.init`; `opts.devicePixelRatio` is honoured.
- The Displays page: `useDisplays` (`api/queries.ts:779`) never refetches.
- Not verifiable here: the real site's TVs; T0 measures the rest.

## Rulings of the plan (on top of R1 to R14)
- P1 **Contract first.** The controller (`wallController.ts`) and the view (`WallScreen.tsx`) meet at the types in `display/wallTypes.ts` (below), written before either; the view is tested with hand-made snapshots, the controller with a fake `fetchWidget` and manual timers. This lets T1b and T2b run side by side.
- P2 **`transform: scale(s)`** on ONE box (origin top left) is the first choice for R5 (text stays sharp in Chromium; layout code sees logical sizes); CSS `zoom` is the fallback if T0's screenshots show blur. Charts get `devicePixelRatio = window.devicePixelRatio * s` through a React context `ChartPixelRatioContext` (default `undefined` = the app's charts get no option, unit-tested) read by `TimeSeriesWidget` and `BarWidget`.
- P3 **`displayLoop` stays the owner of the claim and the playlist poll.** It gains: `connected` carries `{reply, receivedAt, serverDate}` and is emitted after EVERY successful read; after a first success a failed read (network, 5xx, not a playlist) emits nothing and retries with the existing backoff (the full-screen `offline` stays only for "never connected"); the returned stop function gains `.refresh()` (read now, single flight, and restart the poll timer; used by the wall for a 404, a wake, and by nothing else); the revoked schedule 5, 15, 60 minutes then stop (a read that answers 200 resets it; "not connected" and "blocked" unchanged). The wall owns widget requests, rotation, bands and the clock.
- P4 **One module per concern** (all in `frontend/src/display/` unless noted): `displayApi.ts` (typed playlist + `widgetData()` + Date header), `wallRules.ts` (pure: constants, shown items, next item, retry waits with jitter, band decisions, clock offset, build-reload decision, revoked schedule), `wallQueue.ts` (2 in flight, priority, retry/backoff), `wallController.ts` (the state machine), `wakeEvents.ts` (heartbeat jump + `visibilitychange` + `pageshow` + `online` -> one callback), `wakeLock.ts`, `fit.ts` (pure), `WallScreen.tsx`, `WallCard.tsx`, `styles/display-wall.css`, `api/widgetRefetch.ts` (the moved constants, re-exported by `api/queries.ts`).
- P5 **Band text** (the words are the brief's): readings "Readings stopped arriving at HH:MM." (no time when the age is null: "Readings stopped arriving."), collector "The data collector stopped." (two polls in a row), screen "This screen has not been updated since HH:MM. Trying again...". Priority: screen over collector over readings (one band at a time). Times in the site's time zone (`site.timezone`; the browser's if it is not a zone the browser knows).
- P6 **Swap** = prefetch, wait, fade: from 8 s before an item's turn (at once when its `seconds` are 8 or less) the NEXT shown item (read from the newest playlist) is requested at low priority; at the turn the swap happens when all its cards answered (a failure counts as answered), or 5 s after the turn; `phase: "out"` for 150 ms, the item changes, `phase: "in"` for 150 ms (both by timers; under `prefers-reduced-motion` no phase at all). One shown item: no swap, except that a changed item (any difference in its dashboard, widgets or focus) goes through the same prefetch-wait-fade at once. A pinned item whose dashboard was deleted or is now skipped goes at the next turn.
- P7 **Request rhythm.** A card of the pinned item is requested when it has no answer, or its answer is older than `widgetRefetchMs(config)` (30 s, 5 minutes for a comparison); a card of the prefetched item the same way (an answer kept from the last showing counts by its age, so a 3-item playlist at 20 s asks every card about once a minute). A request for a widget that is not a data type (`text`) is never made. `document.hidden`: no widget request, no timer but the playlist poll (`displayLoop`) and the heartbeat.
- P8 **Chart sharpness and fit values** are computed in `fit.ts` from the window (`innerWidth`, `innerHeight`) and the dashboard's natural height; the view sets inline `--wall-s` (unitless scale) and `--wall-unit` (`innerHeight / 1080`, unitless); the stylesheet derives every type floor from those two, never from a media query.

## The contract: `display/wallTypes.ts`
```ts
import type { WidgetData } from "../api/types";
import type { DisplayItem } from "./displayApi";

/** One card of the pinned item. `status` "loading" = never answered; "ok" = an answer is kept (it may be older than the last request); "error" = failed and nothing kept. */
export interface CardState {
  status: "loading" | "ok" | "error";
  data: WidgetData | null;
  answeredAt: number | null;      // server-clock ms of the kept answer
  failingSince: number | null;    // server-clock ms of the first failure after the kept answer, null while all is well (a 404 never sets it)
  notUpdated: boolean;            // failing for over 120 s while another card of the item answered: the card says "Not updated since HH:MM"
}
export type BandKind = "screen" | "collector" | "readings";
export interface WallSnapshot {
  item: DisplayItem | null;                          // the pinned item that is drawn; null = nothing to show
  position: { index: number; of: number } | null;     // 1-based index among the SHOWN items
  phase: "in" | "out";                               // "out" during the first half of a swap's fade
  cards: Readonly<Record<number, CardState>>;         // by widget id of `item`; a text widget has no entry
  timezone: string;                                  // the site's zone
  now: number;                                       // server-clock ms, advanced once a second
  updatedAt: number | null;                          // the OLDEST answeredAt among the cards of `item` that have one
  band: { kind: BandKind; text: string } | null;      // at most one; the view dims the cards to 55 % while it is set
  emptyText: string | null;                          // set when `item` is null: the one sentence of R2
  buildChanged: boolean;                             // informational for tests; the controller itself calls deps.reload()
}
export interface WallDeps {
  timers: Timers;                                    // displayLoop's Timers (manual in tests)
  now?: () => number;                                // local ms, default Date.now
  random?: () => number;                             // default Math.random (jitter)
  fetchWidget: (item: number, widget: number) => Promise<WidgetReply>;     // displayApi.widgetData
  refreshPlaylist: () => void;                       // the stop function's .refresh() of displayLoop
  reload: () => void;                                // reloads the page (the build changed); the controller calls it at a boundary, at most once per 10 s
  reduceMotion: () => boolean;                       // read at each swap
  isHidden: () => boolean;                           // document.hidden
}
export interface Wall {
  start(): void; stop(): void;                       // start() after stop() works (StrictMode runs an effect twice)
  feed(reply: DisplayPlaylist, receivedAt: number, serverDate: number | null): void;   // one successful playlist read
  wake(): void;                                      // sleep/wake/visible/online: read now, restart the item's timer, no band 2 for 10 s
  snapshot(): WallSnapshot;
  subscribe(listener: () => void): () => void;
}
```
(`Timers` from `displayLoop.ts`; `WidgetReply = { status: number; data: WidgetData | null; retryAfter: number | null; serverDate: number | null }`, `DisplayPlaylist` from `displayApi.ts`.)

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
New: `display/{wallTypes,wallRules,wallQueue,wallController,wakeEvents,wakeLock,fit,WallScreen,WallCard}.ts(x)` and their tests, `styles/display-wall.css`, `api/widgetRefetch.ts`, `components/dashboard/widgets/chartPixelRatio.ts`, `e2e/w29.spec.ts`. Changed: `display/{displayApi,displayLoop,DisplayApp}.ts(x)`, `api/queries.ts` (re-export, `useDisplays` refetch), `TimeSeriesWidget.tsx`, `BarWidget.tsx` (the optional pixel ratio), `app.css.test.ts`, `e2e/w28.spec.ts`, `e2e/playwright.config.ts`, docs. Untouched: `main.tsx`, `takeFragment.ts`, `secretHandle.ts`, `reloadClean.ts`, `reloadOnLink.ts`, `claim` in `displayApi.ts`, everything under `backend/` (except T7).

## Tasks (one commit each; implementers: fresh Sonnet, briefs in `.waves/w29/brief-*.md`)
- [ ] **T0 Baseline and measurements** (controller): look stack up and seeded (done at 22:09), four templates, two playlists, three displays, fixtures into `.waves/w29/fixtures/`, p50/p95 of both widget-data routes and the playlist, api CPU with 0/1/10 displays, the browser floor from the built CSS, `status` of the look stack, DISTINCT build ids for the rebuild-while-running check. Numbers into the ledger. Decides T7.
- [ ] **T1a Pure logic** (`displayApi.ts` typed + `widgetData()` + Date header, `wallRules.ts`, `wallQueue.ts`, `wallTypes.ts`, `api/widgetRefetch.ts` and the re-export): unit tests for every threshold and boundary, the 2-in-flight queue, `Retry-After` plus jitter, backoff 5,10,20,40,60 s with jitter, ten walls returning with spread-out retries.
- [ ] **T2a Fit, stylesheet, chart pixel ratio** (`fit.ts`, `display-wall.css`, `chartPixelRatio.ts` + the two chart widgets, `app.css.test.ts`): `fit` for Power (8 rows), Cost (12), a 2-row dashboard at 1920x1080 and 3840x2160, header share, type-floor variables.
- [ ] **T1b The controller** (`wallController.ts`, `wakeEvents.ts`): rotation, prefetch-wait-fade, the queue, 404 rule, clock offset, bands, build reload, wake, hidden; manual timers.
- [ ] **T2b The view** (`WallScreen.tsx`, `WallCard.tsx`): R1's composition from a snapshot, header and legend, bands, fade, cursor, per-card boundary, text card, "Not updated since"; the R1 request test with the real controller and a fake `fetch` (every request `/api/display/*`, `notifyUnauthorized` never called).
- [ ] **T3 Into the page** (`DisplayApp.tsx`, `displayLoop.ts`, `wakeLock.ts`, `useDisplays` refetch, `DisplayApp.test.tsx`): P3. **Opus security review (mandatory).**
- [ ] **T4 End to end** (`e2e/w29.spec.ts`, `w28.spec.ts`, `playwright.config.ts`, `docs/end-to-end-tests.md`): the cases of the brief's T4.
- [ ] **T5 Soak** (controller, `.waves/w29/soak-*.mjs`): (a) accelerated 24 simulated hours with `page.clock`, `page.route` fixtures; (b) real time 60+ minutes in the background.
- [ ] **T6 Docs and close-out**: `docs/display-screens.md` (R11, R12), `docs/end-to-end-tests.md`, CHANGELOG top, backlog BN, roadmap O-59, gallery `.waves/gallery/w29/`.
- [ ] **T7 Optional** (only if T0 shows the display widget-data p50 over 1.5 times the user route's): one asset tree through the display path; byte-equality test of both routes; Opus security review; the full backend suite once.

## Gates (once, near the end, in this order, each through `flock /tmp/dcdash-heavy.lock`)
`npm run typecheck`, `npm test` (full frontend), `npm run build`, the e2e type check (RESUME.md line 8), docs tests (`test_docs_links.py`, `test_readme_ops.py`, `test_repo_hygiene.py`), `vis-rebuild.sh` (judged by its summary line), w28 + w29 alone on the look stack. Backend suite only if T7 ran.

## Review focus
1. Reach and the credential: no request to a user route from the display page; the secret unreadable after the first definite answer; ids only. 2. Honesty: bands never on an api restart; "Updated" on the server's clock; marks on every figure. 3. The look at 1920x1080, 3840x2160 DPR 1, 1920x1080 DPR 2: no scroll, header within 4.5 %, type floors, sharp charts. 4. Days: the soak, a rebuild while a wall runs, sleep and wake, ten displays without a 429 storm.

## Execution log
(see `.waves/w29/progress.md`; the controller copies the summary here at close-out)
