# W7a: Assets workspace and app shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every page the full browser width and a navy top bar (brand, quick find, live status, site time, profile menu with a sign-out confirm), and turn Assets into one workspace: a resizable, foldable tree on the left of every `/assets` route, the asset's page (or a fleet summary) on the right, and clickable breadcrumbs.

**Architecture:** `Layout` becomes `navbar` + `frame` (sidebar + main); nothing caps `main`'s width any more. `/assets` is a layout route (tree column + dialogs + `<Outlet>`) with an index child (fleet summary) and `:id` (the existing `AssetPage`, selected = the URL). Two small read endpoints feed the new UI (`GET /api/status` for the bar's chip, any signed-in user; `GET /api/fleet/summary` for the summary page). Everything else is front end. All new CSS stays inside `@layer w6`; shell rules in `app.css`, assets rules in `styles/pages-assets.css`.

**Tech Stack:** FastAPI + SQLAlchemy async + asyncpg (pytest with a Timescale test container), React 19, react-router 7, TanStack Query 5, plain CSS, Vitest + Testing Library, Playwright (controller only).

**Resume (any fresh session):** continue executing this plan; read `git log --oneline` on `w7a-assets-workspace` and the checkboxes below (a ticked step is done and committed); the controller steps (Opus reviews, scratch-stack rebuilds, e2e) are in Tasks 2, 4b, 10 and 11.

**Spec:** the owner's feedback roadmap `docs/superpowers/plans/2026-10-11-w7-owner-feedback-roadmap.md` (items O-1 to O-5, O-12 to O-15, decisions 8 to 10) is the requirement; the visual source for the bar and the profile panel is `.superpowers/sdd/2026-10-11-w7-owner-feedback/mockups/top-c.html` (read its header comment for the contrast table and its CSS lines 157 to 232 and 388 to 410). The look rules of W6 stand (`docs/superpowers/specs/2026-10-11-w6-ui-overhaul-design.md`, `ui-design-rules` in memory). **Not in W7a** (own waves): O-16 theme colours and dark mode (migration 0006), O-6/O-7/O-8/O-9/O-10/O-11, the figures strip of mockup B, the widgets restyle.

## Decisions taken here (defaults the owner may overrule; none blocks the build)

1. **Profile panel is a disclosure** (button with `aria-expanded` + `aria-controls`, a panel of one link and one button), not an ARIA `menu`: O-16 will add radio groups to it later and a menu role cannot hold them. Esc closes and returns focus; outside click and Tab-out close; ArrowDown/ArrowUp move between its items.
2. **Status chip data is a new viewer-readable `GET /api/status`** (the existing collector status is operator-only). States: `Live` (collector alive and at least one mapped point is fresh by the SAME per-mapping rule as the asset pages, 3 polling intervals or 60 s, so a meter polled every 300 s is not called stale), `Stale` (alive, every mapped point stale), `Collector offline`, `No readings yet` (no mapped point of an enabled source read yet). Shape plus words carry the state, never colour alone.
3. **Quick find** searches asset names/paths and the pages the user's role may open; Ctrl+K / Cmd+K focuses it. No recent-items list, no server search (the asset list is already cached).
4. **"Needs attention"** lists assets with a mapped point of an ENABLED source whose newest reading is bad (quality not 0 or no value) or stale (same rule as the live-power roll-up). A mapped point never read yet, and points of disabled sources, are not listed. (Open question for the owner: mappings have no creation time, so a new mapping and a broken one look the same; a third problem "No reading yet" for never-read points of enabled sources would surface a wrong register on a new mapping. Default: not listed, as the roadmap says "stale or bad".)
5. **Fleet live power** = the same roll-up rule as an asset page, applied to every top-level asset: an asset's own power meter, else its topmost metered descendants; only good, fresh readings are summed; null (never 0) when none reports.
6. Roadmap O-13's line "minimized sidebar: the avatar alone opens it" is dropped on purpose: with option C the profile lives in the top bar, is always visible and never minimizes. Old `/assets?selected=N` links are not redirected (nothing links to them). O-12 stays "Administer". Sidebar foot keeps only the minimize toggle; Password and Sign out live in the profile panel.
7. **Sign-off: GIVEN.** The owner answered "lgtm" on 2026-10-11 to decisions 1 to 6, the Opus review's changes, and the proposal to build in a fresh session; the open question about a third "No reading yet" problem was not singled out, so the default stands (never-read points are NOT listed; it is parked in backlog section R). Both gates (owner sign-off, Opus plan review) are met: implementers may start at Task 1. (The owner said "start W7a"; these are the choices made for them, each one small to reverse.)
8. Process: lighter process. One Opus plan review (runs the risky parts), implementer + targeted tests per task, a per-task Opus review ONLY for Task 2 (it refactors cost-today arithmetic that every asset page shows), full suites and the whole Playwright suite once at the end, one whole-branch Opus review that LOOKS at every page in a browser at 1920, 1440 and 1024 px.

## Global Constraints

- Hard bans (any one is a failure): no cream or off-white page background; no italic accent words; no numbered "01/02/03" labels; no monospace labels; no pill buttons (radius 4 to 8 px); no gradient blobs, glassmorphism, emoji icons, shadow on every card. Icons are inline SVG, 24-unit viewBox, 1.7 stroke, `aria-hidden="true"`.
- No raw colour in a component rule, only `var(--…)`; new colour tokens go in the ONE `:root` block of `app.css` (tokens named in Task 4b). Every new rule is inside `@layer w6`; the frozen widget/editor-grid block at the end of `app.css` is not touched. Page CSS only in `src/styles/pages-assets.css` (assets pages) or `app.css` (shell); no new CSS file. No global element resets. `--accent` never appears in a rule whose selector contains `.side` or `.navbar`; both set `--ring: var(--side-accent)`.
- Playwright matches heading, link and label names (`getByLabel` also reads `aria-label`) by case-insensitive SUBSTRING, and the specs call `getByLabel` with "Name", "Asset", "Parent asset", "Metric", "Source", "Search", "User", "Role", "Type", "Title", "Kind", "Url", "Ports", "Currency", "Connector" and more. So: no new heading whose name contains "Assets", "Dashboards", "Sources", "Metrics" or "Trend"; no new `aria-label` or `<label>` containing any of those words (the quick find's label is exactly `Quick find`, its groups are "Tree matches" and "Page matches", the separator is "Resize the tree column", and the listbox is unmounted while closed). The page keeps exactly one `h1`. Group captions inside popups are not headings. Task 10 greps every `getByLabel(` value against the new labels.
- Landmarks: `nav[aria-label="Main"]` (the sidebar) and `nav[aria-label="Breadcrumb"]` (the crumbs; replaces the W6 rule "crumbs are a p, never a nav"). Any e2e or unit lookup of a sidebar link or of the user block must be scoped (`navLink()` and `userBlock()` in `e2e/shell.ts`, Task 10).
- Every `localStorage` read/write in try/catch (use `readStored`/`writeStored` from `lib/sidebarState.ts`); a stored value is validated on read (garbage means the default); jsdom has no `matchMedia` (guard with `typeof window.matchMedia === "function"`).
- No new dependency, no migration, no change to a write endpoint. Backend: only the two GET routes of Tasks 1 and 2 and the pure helpers they need.
- Implementers run only: `cd frontend && npx vitest run <files>`, `npm run typecheck`, `npm run build` (Tasks 4b and 8a), the e2e type-check below (Task 10), `cd backend && uv run pytest <files>` (Tasks 1 and 2), git. NEVER `docker`, `scripts/*`, `npx playwright test`/`npm run e2e` (the controller runs them), and never anything on the Compose project `dcdash` or the volume `dcdash_dbdata`. No full backend suite per task.
- e2e type-check: `cd frontend && npx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --skipLibCheck e2e/*.ts 2>&1 | grep -v -E "TS2307|TS2580|TS7006"` must print nothing.
- **Tests:** this wave changes behaviour on purpose, so edits to the tests it breaks are expected; keep each edit minimal, say which assertions changed and why in the commit body, and never weaken an assertion that does not follow from a decision above.
- One commit per task, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; `git add` only the files the task names; do not push. Style: match the surrounding code (short comments only where the reason is not obvious). Branch: `w7a-assets-workspace`.

## Review Focus (inputs the spec implies but the happy path does not exercise)

1. A 46-character asset name, and a path 8 levels deep: tree row (ellipsis), crumbs (wrap, no page-wide horizontal scroll), asset title (wraps), quick-find option (ellipsis). *Tests: Task 3 (crumbs), Task 5 (option text), visual review.*
2. `localStorage` blocked, or holding garbage for the width / fold / sidebar keys: the page works with defaults and never throws. *Tests: Tasks 6, 7.*
3. `/assets/abc`, `/assets/0`, `/assets/99999999999` (out of range), `/assets/999999` (unknown): an in-pane "not found" with NO request for a non-integer id; the tree stays usable. *Test: Task 8b.*
4. Deleting the asset whose page is open (and its children): lands on `/assets`, not on a dead URL. *Test: Task 8a.*
5. A viewer: no Add/Edit/Delete, no admin or operator pages in the quick find, no `+` in the tree. A site with zero assets: summary empty state, quick find still lists pages. *Tests: Tasks 5, 8a, 9.*
6. A collector that is down while readings are fresh, and the reverse: the chip says what is wrong in words. *Test: Task 4a (`statusView`).*
7. Sign out: Cancel and Esc must not sign out; a double click on the confirm sends ONE request; a failed request shows its error and keeps the session. *Test: Task 4a.*
8. Collapse all with the selected asset inside a folded branch: selecting another asset (tree, crumb, quick find, URL) unfolds its ancestors; Collapse all does not re-open them. *Test: Task 6.*

## File map

| File | Responsibility |
|---|---|
| `backend/dcdash/api/health.py` | + `GET /api/status` (Task 1) |
| `backend/dcdash/core/fleet.py` (new) | pure: `fleet_power`, `attention` (Task 2) |
| `backend/dcdash/core/tree.py` | + `AssetTree.roots()` (Task 2) |
| `backend/dcdash/api/data.py` | `_energy_cost_today` shared by `summary()` and the new `GET /api/fleet/summary` (Task 2) |
| `frontend/src/components/Crumbs.tsx` (new), `PageHeader.tsx` | breadcrumb trail (Task 3) |
| `frontend/src/components/Icon.tsx` (new, 4a), `navItems.ts` (new, 4b) | the sidebar's icons and link groups, shared with the quick find |
| `frontend/src/components/StatusChip.tsx`, `SiteClock.tsx`, `ProfileMenu.tsx`, `SignOutDialog.tsx` (new, 4a); `Layout.tsx` (4b) | the bar parts, then the shell |
| `frontend/src/components/QuickFind.tsx`, `lib/quickFind.ts` (new) | Task 5 |
| `frontend/src/lib/liveStatus.ts`, `lib/siteTime.ts` | status wording; `formatSiteHourMinute` (Task 4a) |
| `frontend/src/lib/treeFold.ts`, `lib/treeWidth.ts` (new), `lib/tree.ts`, `components/AssetTree.tsx` | Tasks 6, 7 |
| `frontend/src/pages/AssetsPage.tsx`, `AssetPage.tsx`, `AssetsSummary.tsx` (new), `App.tsx` | Tasks 8a, 8b, 9 |
| `frontend/src/app.css`, `styles/pages-assets.css`, `app.css.test.ts` | CSS and its guard |
| `frontend/e2e/shell.ts` (new), specs, `w7a.spec.ts` (new) | Task 10 |

---

## Part A: shell and the two endpoints

### Task 1: `GET /api/status` (any signed-in user)

**Files:** Modify `backend/dcdash/api/health.py`; Create `backend/tests/test_api_status.py`. Read first: `health.py`, `core/widgets.py` (`is_stale`, `STALE_AFTER_INTERVALS`, `STALE_MINIMUM`), `tests/test_api_collector_status.py` (its `beat_at` helper), `tests/helpers.py` (`login_as`, `make_source`, `make_point`, `make_asset`, `make_mapping`).

**Interfaces — Produces:** `GET /api/status` → `{"collector_alive": bool, "readings_fresh": bool | null, "last_reading_age_seconds": float | null}`. 401 signed out, 200 for viewer, operator, admin. Ages come from the database clock, never negative.
- `readings_fresh` uses the SAME freshness rule as every asset page, not a fixed cutoff (a meter polled every 300 s is healthy 900 s after its last reading): `null` when no mapped point of an ENABLED source has ever been read; otherwise `true` when at least one such point is not stale, i.e. its `point_latest.ts >= now() - greatest(3 × mapping.interval_seconds, 60 s)`; `false` when every one is stale. Import `STALE_AFTER_INTERVALS` and `STALE_MINIMUM` from `core/widgets.py` and pass them to the SQL as parameters so the two rules cannot drift.
- `last_reading_age_seconds`: `now() - max(point_latest.ts)` over all points (any quality), for the chip's detail text; null when there is none.

- [ ] **Step 1: tests first.** In `tests/test_api_status.py`: (a) 401 without a session, 200 for a viewer; (b) an empty site: `{"collector_alive": False, "readings_fresh": None, "last_reading_age_seconds": None}`; (c) a beat 3 s ago and a mapped point (interval 5) read 5 s ago: alive True, fresh True, age between 4 and 12; (d) the heartbeat threshold is `STALE_AFTER_SECONDS` = 30 (heartbeat.py): a beat 29 s old is alive, 31 s old is not; (e) a `point_latest` stamped one hour in the future: age exactly 0.0; (f) two points, the newest age wins; (g) the freshness rule: an interval-300 mapping read 200 s ago is fresh, read 901 s ago is not (threshold 900); an interval-5 mapping read 50 s ago is fresh, 61 s ago is not (the 60 s floor); one stale and one fresh mapped point give `true` (any); a fresh point of a DISABLED source does not count (result `null` if it is the only one read); a read point with no mapping does not count; a mapped point never read gives `null`; (h) the operator route `/api/collector/status` still answers exactly as before. Insert rows through the `db` asyncpg connection like `beat_at` does (`INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, now() - make_interval(secs => $2), 1.0, 0)` after `make_source`/`make_point`/`make_asset`/`make_mapping`).
- [ ] **Step 2: run, expect FAIL** `cd backend && uv run pytest tests/test_api_status.py -q`.
- [ ] **Step 3: implement.** Factor the heartbeat query out of `collector_status` and add the route:

```python
class LiveStatus(BaseModel):
    collector_alive: bool
    readings_fresh: bool | None  # None = no mapped point of an enabled source has been read yet
    last_reading_age_seconds: float | None  # now() - the newest point_latest.ts by the database's clock; None = no reading on record


async def _heartbeat_age(db: AsyncSession) -> float | None:
    age = await db.scalar(
        text("SELECT extract(epoch FROM now() - (value->>'at')::timestamptz) FROM settings WHERE key = :key"),
        {"key": HEARTBEAT_KEY},
    )
    return None if age is None else max(0.0, float(age))  # a beat stamped ahead of this clock is "just now"


# Same rule as core.widgets.is_stale, evaluated by the database's clock; the two constants are passed in, never repeated here.
_FRESH = text(
    """
    SELECT count(*) AS read_points,
           coalesce(bool_or(l.ts >= now() - greatest(m.interval_seconds * :k * interval '1 second',
                                                     :floor * interval '1 second')), false) AS fresh
    FROM mappings m
    JOIN points p ON p.id = m.point_id
    JOIN sources s ON s.id = p.source_id AND s.enabled
    JOIN point_latest l ON l.point_id = m.point_id
    """
)


@router.get("/status", response_model=LiveStatus, dependencies=[Depends(require_role("viewer"))])
async def live_status(db: AsyncSession = Depends(get_db)) -> LiveStatus:
    """What the top bar's chip shows. Freshness only, no names or values, so every signed-in user may read it."""
    beat = await _heartbeat_age(db)
    newest = await db.scalar(text("SELECT extract(epoch FROM now() - max(ts)) FROM point_latest"))
    row = (await db.execute(_FRESH, {"k": STALE_AFTER_INTERVALS, "floor": STALE_MINIMUM.total_seconds()})).one()
    return LiveStatus(
        collector_alive=beat is not None and beat <= STALE_AFTER_SECONDS,
        readings_fresh=None if row.read_points == 0 else bool(row.fresh),
        last_reading_age_seconds=None if newest is None else max(0.0, float(newest)),
    )
```
(If asyncpg cannot infer the parameter types of `:k` and `:floor`, cast them: `CAST(:k AS integer)`, `CAST(:floor AS double precision)`.) `collector_status` becomes `age = await _heartbeat_age(db)` plus its two existing returns. Update the module docstring ("also holds the collector status routes").
- [ ] **Step 4: run to GREEN** `uv run pytest tests/test_api_status.py tests/test_api_collector_status.py tests/test_audit_coverage.py tests/test_credential_gate.py -q` (`test_credential_gate.py` calls EVERY GET route and needs a 2xx: it is the route-inventory net).
- [ ] **Step 5: commit** `feat(api): GET /api/status for the top bar's live chip`.

### Task 2: `GET /api/fleet/summary` and the shared "today" helper (Opus review of this task)

**Files:** Create `backend/dcdash/core/fleet.py`, `backend/tests/test_core_fleet.py`, `backend/tests/test_api_fleet.py`; Modify `backend/dcdash/core/tree.py` (`roots()`), `backend/dcdash/api/data.py`. Read first: `api/data.py` (all), `core/rollup.py`, `core/cost.py`, `core/energy.py` (`total`, `hourly_energy`), `core/widgets.py` `is_stale`, `tests/test_api_summary_cost.py` (fixtures `todays_panel`, frozen clock), `tests/billing_helpers.py`.

**Interfaces — Produces:**

```
GET /api/fleet/summary   (viewer)
{
  "power": {"kw": float | null, "counted": int, "of": int},
  "energy_today": {"kwh": float, "estimated": bool, "no_data": bool} | null,
  "cost_today": {"cost": float | null, "estimated": bool, "partial": bool, "no_data": bool} | null,
  "currency": str | null,
  "attention": {"total": int, "items": [{"asset_id": int, "name": str, "path": str,
                "problem": "bad" | "stale", "points": int, "last_ts": iso8601}]}   // items: at most 25
}
```
`AssetTree.roots() -> list[int]` (a copy of the existing `_roots`). `core/fleet.py`: `PowerReading(value_kw, ts, quality, interval_seconds)`, `fleet_power(tree, meters, now) -> tuple[float | None, int, int]` (`meters`: asset id to `PowerReading`), `MappedReading(asset_id, interval_seconds, ts, value, quality)`, `attention(readings, now) -> list[AttentionRow]` with `AttentionRow(asset_id, problem, points, last_ts)`, `ATTENTION_LIMIT = 25`.

**Rules (the risky logic):**
- **Today's figures for a set of assets** (one function, used by both routes, so the asset page and the fleet page can never disagree): extract from `summary()`:

```python
async def _energy_cost_today(db, tree, now, tz, asset_ids: list[int]):
    start, end = day_bounds(now, tz)
    result = await hourly_energy(db, tree, start, end)
    tariffs = await load_tariffs(db)
    priced = cost_by_hour(result, tariffs, tree, tz)
    energies = [e for a in asset_ids if (e := total(result.hours.get(a))) is not None]
    energy = Energy(sum(e.kwh for e in energies), any(e.estimated for e in energies)) if energies else None
    parts = [p for a in asset_ids if (p := priced.get(a)) is not None]
    hours = [h for p in parts for h in p.values()]
    today = now.astimezone(ZoneInfo(tz)).date()
    rate_in_effect = any(rate_at(tariffs, tree, a, today) is not None for a in asset_ids if priced.get(a) is not None)   # only assets with a figure: a bare root with a rate must not turn the fleet cost into a priced zero
    cost = summarize(hours, rate_in_effect=rate_in_effect) if parts else None
    return energy, cost, bool(parts) and no_data(hours)   # the last: not one hour of today was recorded
```
  `summary()` calls it with `[asset_id]` and must answer byte-for-byte as before (the whole of `test_api_summary_cost.py`, `test_api_data.py`, `test_api_billing.py` is the regression net). The fleet route calls it with `tree.roots()`: roots are disjoint subtrees, each root's hours already include its descendants, so summing roots never double counts.
- **Fleet power:** `metered` = the first part of `_power_rollup` (one `active_power_kw` mapping per asset with its `PointLatest`), extracted into `_metered_power(db)` and shared. Sources per root: `[root]` if the root is metered, else `power_sources(tree, metered.keys(), root)`. A source counts only when its reading is good (`quality == 0` and a value) AND fresh (`not is_stale(ts, now, interval)`); `kw` = sum of `value * scale` of the counted, `None` when none counted (never 0); `of` = number of sources.
- **Attention:** every mapping of an ENABLED source (`Mapping` join `Point` join `Source`, outer join `PointLatest`); `ts is None` skips (never read); `quality != 0 or value is None` is "bad"; else `is_stale` is "stale"; else fine. Per asset: problem "bad" if any of its mappings is bad, else "stale"; `points` = how many mappings have a problem; `last_ts` = the newest `ts` among them. Sorted bad before stale, then oldest `last_ts` first, then asset id. `total` counts all, `items` is cut at 25. Names and paths come from the tree (`tree.nodes[id].name`, `tree.path(id)`).

- [ ] **Step 1: tests first (RED).** `test_core_fleet.py` (pure, no DB): `fleet_power` with an unmetered root over two metered children (sum), a root with its own meter plus metered children (only the root's meter), two roots, a stale meter excluded (`counted < of`), a bad-quality meter excluded, none reporting gives `(None, 0, n)`, no meters gives `(None, 0, 0)`; `attention` bad beats stale per asset, never-read skipped, ordering, `points` count, the limit is applied by the caller (the function returns all). `test_api_fleet.py` (frozen clock `monkeypatch.setattr("dcdash.api.data._now", lambda: NOW)` as in `test_api_summary_cost.py`; stamp every `point_latest.ts` relative to `NOW` (`NOW - timedelta(...)`), NEVER with the database's `now()`, or the "stale" cases cannot go red for the right reason): 401 / viewer 200; an empty site (`power` `{kw: None, counted: 0, of: 0}`, energy and cost null, attention `{total: 0, items: []}`); two roots with counters (+4 kWh each today): `energy_today.kwh == 8.0`, with a 0.25 tariff `cost_today.cost == 2.0`, without a tariff `cost == None` and `partial True` (as the asset route does), a tariff starting tomorrow does not price today; one root silent and one with data: `no_data False`; every root silent: `no_data True`; a bare root (no meter anywhere below it) WITH a rate next to a silent counter root WITHOUT one: `cost_today.cost` is `None`, not a priced 0.0 (the asset page of the metered root says "no rate set" too); power: two live meters under an unmetered site, one stale; attention end to end: a bad reading, a stale one, a disabled source's stale point (excluded), an unmapped point (excluded), 30 problem assets give `total 30` and 25 items; currency appears.
- [ ] **Step 2: run, expect FAIL** `uv run pytest tests/test_core_fleet.py tests/test_api_fleet.py -q`.
- [ ] **Step 3: implement** `core/fleet.py`, `AssetTree.roots()`, `_energy_cost_today` (import `Energy` from `dcdash.core.energy`: `data.py` imports only `hourly_energy, total` today; type it `db: AsyncSession, tree: AssetTree, now: datetime, tz: str, asset_ids: list[int]`), `_metered_power` (and `_power_rollup` using it), the route (same router, so same role and `_now`).
- [ ] **Step 4: run to GREEN, targeted** `uv run pytest tests/test_core_fleet.py tests/test_api_fleet.py tests/test_api_summary_cost.py tests/test_api_data.py tests/test_api_billing.py tests/test_cost.py tests/test_credential_gate.py tests/test_audit_coverage.py -q`. (These are the files that exercise the refactored code and the route inventory; no full suite.)
- [ ] **Step 5: commit** `feat(api): GET /api/fleet/summary; one today-figures helper for the asset and fleet routes`. **Controller: dispatch the Opus per-task review now** (cost arithmetic: is `summary()` unchanged, is the fleet sum right, is the attention rule what the plan says). **Then, before Task 4b starts, rebuild the scratch visual stack from the branch** (`.superpowers/sdd/2026-10-11-w6-ui-overhaul/vis-rebuild.sh`) so that `/api/status` and `/api/fleet/summary` exist on port 18180; rebuild again if the review changes the backend. Without this the chip and the summary page 404 and every LOOK step proves nothing.

### Task 3: breadcrumb trail (`Crumbs`) and its callers (O-4 outside Assets)

**Files:** Create `frontend/src/components/Crumbs.tsx`, `Crumbs.test.tsx`; Modify `components/PageHeader.tsx`, `PageHeader.test.tsx`, `pages/SourcePointsPage.tsx`, `pages/AuditEntryPage.tsx`, `pages/DashboardPage.tsx`, `styles/pages-admin.css` (lines 81 to 83: `.audit-entry-page .crumbs a` is an inline-flex icon rule written for the old link; update or delete it), `src/app.css` (and the tests that name their crumbs: `SourcePointsPage.test.tsx`, `AuditEntryPage.test.tsx`, `DashboardPage.test.tsx`, `DashboardPage.edit.test.tsx`, `AssetPage.test.tsx`). Read first: all of those.

**Interfaces — Produces:**

```tsx
export interface Crumb { label: string; to?: string }            // no `to` = plain text
export function Crumbs({ trail }: { trail: readonly Crumb[] }): JSX.Element | null
// <nav class="crumbs" aria-label="Breadcrumb"><ol><li>…</li></ol></nav>; every crumb but the last with a `to` is a <Link>;
// the last is <span aria-current="page">; a "/" separator span (aria-hidden) sits between crumbs; empty trail renders nothing.
PageHeader props: crumbs?: readonly Crumb[]        // was ReactNode; renders <Crumbs>, still the FIRST child of header.page-head
```

- [ ] **Step 1: tests first.** `Crumbs.test.tsx`: landmark named "Breadcrumb"; links for all but the last; the last is not a link and has `aria-current="page"`; a crumb without `to` is text; empty trail renders nothing; a 60-character label is in the DOM whole (the CSS wrap is not testable here); separators are `aria-hidden`. `PageHeader.test.tsx`: the first part is `nav.crumbs` (was `p.crumbs`), the parts list becomes `["nav.crumbs","h1","p.sub","div.actions"]`, and the W6 assertion "never a nav" is replaced by "one nav labelled Breadcrumb".
- [ ] **Step 2: implement** `Crumbs` and the PageHeader change; callers: `SourcePointsPage` → `[{label:"Sources", to:"/sources"}, {label: sourceName}]`; `AuditEntryPage` → `[{label:"Audit log", to:"/audit"}, {label:`Entry #${data.id}`}]` but KEEP a link named "Back to the log" (e2e `w3c.spec` clicks it): the not-found and error branches keep their `back-line` link, the loaded state puts it in the header's `actions`; `DashboardPage` → replace its two `<p><Link>Dashboards</Link> / name</p>` with `<Crumbs trail={[{label:"Dashboards", to:"/dashboards"}, {label: dashboard.name}]} />`; `AssetPage` → `[{label:"Assets", to:"/assets"}, {label: data.asset.name}]` for now (Task 8b builds the ancestor trail). Replace the "plain text crumb" comment in `AssetPage`.
- [ ] **Step 3: CSS** (`app.css`, in the layer, tokens only; copy the look of mockup lines 157 to 161; REPLACE the existing `.page-head .crumbs` and `.page-head .crumbs a { color: var(--text-2) }` rules (app.css ~235 to 236: that selector has higher specificity than `.crumbs a` and would keep the links grey), do not add a second set): `.crumbs ol` flex, wrap, gap 4px, no list style; `.crumbs a` colour `--accent`; `[aria-current="page"]` `--text` weight 600; separator `--text-2`; `.crumbs li { min-width: 0; overflow-wrap: anywhere }`. The dashboard page's own crumb paragraph styles go away if unused (grep).
- [ ] **Step 4: GREEN** `npx vitest run src/components/Crumbs.test.tsx src/components/PageHeader.test.tsx src/pages/SourcePointsPage.test.tsx src/pages/AuditEntryPage.test.tsx src/pages/DashboardPage.test.tsx src/pages/DashboardPage.edit.test.tsx src/pages/AssetPage.test.tsx src/app.css.test.ts && npm run typecheck`.
- [ ] **Step 5: commit** `feat(ui): breadcrumb trail with links (O-4)`.

### Task 4a: bar parts, built and tested on their own: status wording, site clock, profile panel, sign-out confirm

**Files:** Create `components/Icon.tsx`, `components/StatusChip.tsx`, `components/SiteClock.tsx`, `components/ProfileMenu.tsx`, `components/SignOutDialog.tsx`, `lib/liveStatus.ts`, and a `.test` next to each logic-bearing one; Modify `lib/siteTime.ts` (+test), `api/types.ts`, `api/queries.ts` (+test), `components/Layout.tsx` (ONLY to import `Icon`/`IconName` from `./Icon` instead of defining them; no markup change in this task). Read first: `Layout.tsx` (the ICONS table moves), `ConfirmDeleteDialog.tsx` + `hooks/useDialogFocus.ts` (the focus conventions), `auth/AuthProvider.tsx` (`logout`), `test/fetchMock.ts`, mockup `top-c.html` (markup of `.live`, `.site-time`, `.profile`).

**Interfaces — Produces:**

```ts
// api/types.ts
export interface LiveStatus { collector_alive: boolean; readings_fresh: boolean | null; last_reading_age_seconds: number | null }
// api/queries.ts   keys.status = ["status"]
export const useStatus = () => useQuery({ queryKey: keys.status, queryFn: () => api.get<LiveStatus>("/api/status"), refetchInterval: 10_000 });
// lib/liveStatus.ts
export function agoText(seconds: number): string;     // "0 s" for <0/NaN; "4 s" (<60); "3 min" (<3600); "2 h" (<86400); "5 d"; floor each
export interface StatusView { state: "live" | "stale" | "offline" | "waiting"; word: string; detail: string | null }
export function statusView(s: LiveStatus | undefined): StatusView | null;
//   undefined → null; !collector_alive → {offline,"Collector offline",null}; readings_fresh null → {waiting,"No readings yet",null};
//   readings_fresh false → {stale,"Stale","last reading 5 min ago"}; true → {live,"Live","last reading 4 s ago"}
//   (the server decides freshness per mapping, so a meter polled every 300 s is never called stale at 200 s)
// lib/siteTime.ts
export function formatSiteHourMinute(date: Date, timezone: string): string | null;   // "19:42"; null for an invalid date or unknown zone
// components/Icon.tsx: export type IconName; export function Icon({ name }: { name: IconName })  (the ICONS table moves here from Layout, plus "caret" and "search")
// components/StatusChip.tsx: export function StatusChip(): JSX.Element | null       (uses useStatus + statusView)
// components/SiteClock.tsx:  export function SiteClock(): JSX.Element | null         (uses useSite)
// components/ProfileMenu.tsx: export function ProfileMenu(): JSX.Element            (uses useAuth; also exports nothing else; ROLE_LABEL stays exported from Layout.tsx and ProfileMenu imports it)
```

**Behaviour.** `StatusChip`: a `span.live[data-state]` holding `<b role="status">{word}</b>` (the only live region: it announces a change of state, not every refresh) and `<span.detail> · {detail}</span>`; nothing while `statusView` is null. `SiteClock`: `useSite()` timezone; a `time[datetime]` with `HH:MM` and a `span.zone` with the zone name, a visually hidden "Site time" prefix, ticks every 10 s with `setInterval` cleaned up; renders nothing until the zone is known. `ProfileMenu` (class `who` on the trigger ONLY, so the e2e lookup `.navbar .who` matches one element; the panel's head uses `prof-head`): trigger `button` = avatar + name + role word + caret, `aria-expanded`, `aria-controls="profile-panel"`; panel `#profile-panel` (hidden when closed, NOT `role="menu"`) with a head (avatar, name, role), `Link to="/password"` named "Password" (icon `password`), `button` named "Sign out" (icon `signOut`). Esc closes and focuses the trigger; a `pointerdown` outside closes; focus leaving the whole widget closes; ArrowDown on the trigger opens and focuses the first item, ArrowDown/ArrowUp move between items (wrapping); choosing Password closes it. "Sign out" closes the panel, focuses the trigger, THEN opens `SignOutDialog` (so Cancel and Esc return focus to the trigger). `SignOutDialog` (modelled on `ConfirmDeleteDialog`, uses `useDialogFocus` and `useAction`; rendered with `createPortal(…, document.body)`, so it is outside the banner landmark, outside the navbar's stacking context (a sticky `z-index: 45` ancestor would make its `z-index: 1000` count as 45) and outside the navbar's light `--ring`; the profile panel is closed (`hidden`) while it is open): `role="dialog" aria-modal`, title "Sign out of DC Dashboard?", text "You will need to sign in again.", buttons `Cancel` (initial focus) and `Sign out` (the primary, NOT red). Confirm runs `logout()` once (disabled while busy) then `navigate("/login")`; a rejection shows its message in `role="alert"` and the dialog stays; Esc and Cancel never call `logout`. No CSS in this task (4b styles every class named here).

- [ ] **Step 1: tests first (RED).** `liveStatus.test.ts` (every row of the table above; `readings_fresh: false` with age 200 reads "Stale" and `true` with age 200 reads "Live" (the cutoff is the server's); `agoText` for 59.9 → "59 s", 60 → "1 min", 3599, 3600, 86400, NaN, negative); `siteTime.test.ts` (`formatSiteHourMinute` for Asia/Qatar, midnight is "00:05" not "24:05", an unknown zone is null); `queries.test.tsx` (`useStatus` asks `/api/status`); the profile trigger has no `aria-label` or `aria-labelledby` (its name comes from its text, and must not contain "name", "user" or "asset"); `StatusChip.test.tsx` (each state's words and `data-state`; nothing while loading and NO `role="alert"` when the request fails; exactly one `role="status"`); `SiteClock.test.tsx` (fake timers: advances after 10 s; nothing without a zone); `ProfileMenu.test.tsx` including the `SignOutDialog` cases (Review Focus 7: open/close by click, Esc, outside click, Tab-out, arrow keys; Password link; Sign out opens the dialog and sends NO request; Cancel/Esc keep the session and return focus to the trigger; confirm sends exactly one `POST /api/logout` even on a double click; a failing request shows the error and the dialog stays).
- [ ] **Step 2: run, expect FAIL** (the files above). **Step 3: implement** (types/queries/lib → Icon → StatusChip, SiteClock, SignOutDialog, ProfileMenu).
- [ ] **Step 4: GREEN** `npx vitest run src/lib/liveStatus.test.ts src/lib/siteTime.test.ts src/api/queries.test.tsx src/components/StatusChip.test.tsx src/components/SiteClock.test.tsx src/components/ProfileMenu.test.tsx src/components/Layout.test.tsx && npm run typecheck` (`Layout.test` must still pass untouched: the Layout markup is unchanged here).
- [ ] **Step 5: commit** `feat(ui): status chip, site clock and profile panel components (O-13, O-14)`.

### Task 4b: the shell: navy top bar, full width, new CSS (O-5, O-14)

**Files:** Create `components/navItems.ts`; Modify `components/Layout.tsx`, `components/Layout.test.tsx`, `App.test.tsx` and any other test that mounts `Layout` or `App` (`grep -ln "Layout\|<App" src --include=*.test.tsx`), `src/app.css`, `src/app.css.test.ts`. Read first: `Layout.tsx`, `Layout.test.tsx`, `app.css` lines 1 to 130, mockup `top-c.html` (header comment, CSS 157 to 232 and 388 to 410, the `navbar` markup). Consumes Task 4a's `StatusChip`, `SiteClock`, `ProfileMenu`, `Icon`.

**Interfaces — Produces:** `components/navItems.ts`: `export interface NavItem { to: string; label: string; icon: IconName }`, `export interface NavGroup { id: string; title: string; min?: Role; items: NavItem[] }`, `export const GROUPS: NavGroup[]` (content and role gating moved unchanged from `Layout.tsx`). `Layout.tsx` still exports `ROLE_LABEL`.

**Markup (new `Layout`):**

```
<a.skip-link/>
<div.shell data-sidebar ref>                       // flex column; min-height 100vh
  <header.navbar>                                  // sticky top 0, z-index 45, height var(--bar-h)
    <div.brand> mark + <span.lbl>DC Dashboard</span> </div>      // width var(--side-w) so it sits over the sidebar; minimized: mark only
    <div.bar-in>
      <QuickFind/>   (Task 5; omitted until then)
      <span.grow/>
      <StatusChip/> <span.vr/> <SiteClock/> <span.vr/> <ProfileMenu/>
    </div>
  </header>
  <div.frame>                                      // flex row; flex 1
    <div.side id="sidebar"> <nav aria-label="Main"> nav-groups; side-foot with ONLY the toggle </nav> <div.side-tip/> </div>
    <main id="main" tabIndex=-1> notices + <Outlet/> </main>   // NO .wide class, no WIDE regex
  </div>
</div>
```
The tooltip hook (`useSideTip`) stays for the nav rows and the toggle only.

**CSS (`app.css`, in the layer):** new literal tokens in the one `:root` block (values from the mockup, all contrast-checked in its header): `--bar-h: 52px; --top-bg: #283354; --top-find-bg: #313d63; --top-find-border: #4a5682; --top-find-text: #ffffff; --top-find-ph: #b8c2dc; --top-live: #6fdc9a; --top-stale: #ffc46b;`. Rules: `.shell { display: flex; flex-direction: column; min-height: 100vh }`, `.frame { flex: 1; min-height: 0; display: flex }`, `.navbar` as in the mockup (sticky, z-index 45, `--ring: var(--side-accent)`), `.side { top: var(--bar-h); height: calc(100vh - var(--bar-h)) }`, `.tree-col { top: var(--bar-h); height: calc(100vh - var(--bar-h)) }`, `.assets-layout { min-height: calc(100vh - var(--bar-h)) }`, `.shell:has(.graph-page) { height: 100vh }` with `.frame` flexing so Discovery is still exactly one window tall including the bar, `main { flex: 1; min-width: 0; padding: 0 var(--gutter) 48px }` with NO `max-width`, delete `main.wide`, `.who`/`.avatar` rules rewritten for the bar (light-on-navy trigger; DELETE the old sidebar-foot `.who` styling and the leftover `.shell[data-sidebar="minimized"] .who { justify-content: center; … }` rule, or it hits the new trigger), `html { scroll-padding-top: var(--bar-h) }` inside the layer (a Tab-scrolled focused element must not hide under the sticky bar; a scroll offset, not a reset), `.prof-menu, .qf-pop { --ring: var(--accent) }` (selectors WITHOUT `.navbar`, so the guard "no `.navbar` rule uses `var(--accent…)`" holds; these white surfaces sit inside the bar and would inherit its light ring, 2.10:1 on white, below the 3:1 of WCAG 1.4.11; do NOT copy the mockup's `.navbar :focus-visible { outline-color … }` rule), the profile panel (`.prof-menu` look from the mockup, white panel, 240px, z-index 90), the chip (`.live`, shape + words; `data-state` live = filled dot `--top-live`, stale/waiting = hollow ring `--top-stale`, offline = diamond), `.site-time`, `.vr`. In `@media (max-width: 1179.98px)`: hide `.live .detail`, `.site-time .zone`, `.who-role`. Keep the minimized-sidebar rules for `.brand` (the mark centred, label clipped with the clip pattern, never `display: none`).

- [ ] **Step 1: tests first (RED).** `Layout.test.tsx`: the old Password-link and Sign-out-button assertions move to the new places (both inside the profile panel after opening it; the minimized rail test no longer expects them in the rail); the foot holds only the toggle; `main` has no `wide` class on `/billing`; a `banner` landmark holds the brand and the profile; exactly one `nav` named "Main". **Every test that mounts `Layout` or `App` now also triggers `GET /api/status`, `/api/site` and `/api/assets`:** `mockFetch` answers an unmocked request with a recorded 500, which can break exact call-list assertions, so give those tests default handlers for the three (add a shared `shellRoutes` constant to `test/fetchMock.ts`). `app.css.test.ts`: replace "lets the wide pages use the whole window" by "no rule for `main` sets a `max-width`"; update the Discovery one-window-tall test to the new structure; add: `--ring` is `var(--accent)` in the rules for `.prof-menu` and `.qf-pop`; `.navbar` z-index is between `.side`'s 40 and `.side-tip`'s 50; `.side` and `.tree-col` are offset by `var(--bar-h)`; no `.navbar` rule uses `var(--accent…)`; the contrast table gains the bar's pairs (`--top-find-text` on `--top-find-bg`, `--top-find-ph` on `--top-find-bg` at 4.5:1; `--top-live` and `--top-stale` on `--top-find-bg` and `--side-text-strong` on `--top-bg` as non-text at 3:1).
- [ ] **Step 2: run, expect FAIL.** **Step 3: implement** (navItems → Layout → CSS).
- [ ] **Step 4: GREEN** `npx vitest run src/components/Layout.test.tsx src/app.css.test.ts src/App.test.tsx src/pages/TariffsPage.test.tsx src/pages/DiscoveryPage.test.tsx && npm run typecheck && npm run build` (`TariffsPage.test.tsx` mounts `<App/>`). Then LOOK against the controller's scratch stack, which MUST already run this branch's backend (the controller rebuilds it after Task 2): `VITE_API_TARGET=http://127.0.0.1:18180 npm run dev -- --port 5190 --strictPort`, view `/assets`, `/billing`, `/users`, `/discovery` at 1440 wide and at 1024 (screenshots into the scratchpad, deleted afterwards); the sidebar, bar and profile panel must look like mockup C and the chip must show a real state, not be missing.
- [ ] **Step 5: commit** `feat(ui): navy top bar, full-width pages (O-5, O-14)`.

### Task 5: quick find (O-14)

**Files:** Create `lib/quickFind.ts`, `lib/quickFind.test.ts`, `components/QuickFind.tsx`, `QuickFind.test.tsx`; Modify `components/Layout.tsx` (mount it in `.bar-in`), `src/app.css`. Read first: mockup CSS 164 to 178 and its `qf-pop` markup, `lib/tree.ts`, `api/queries.ts` `useAssets`, `components/navItems.ts`.

**Interfaces — Produces:**

```ts
export interface FindHit { kind: "asset" | "page"; key: string; label: string; detail: string | null; to: string }
export function findHits(
  query: string, assets: readonly Asset[], pages: readonly { label: string; to: string }[],
  limit?: { assets: number; pages: number },            // default {8, 5}
): FindHit[];                                           // assets first, then pages
```
Rules: trim, lowercase; an empty query gives `[]`. An asset matches when its name or its path ("Site / MV2 / Room-1", built from `parent_id`, cycle-safe) contains the query; order: name starts with, name contains, path contains; ties by path then id; `detail` = the parent path (null for a top-level asset); `to = /assets/${id}`; `key = asset:${id}`. A page matches on its label (starts with before contains); `key = page:${to}`. The component's `pages` are `GROUPS` items filtered by `hasRole(group.min)` (a viewer never sees Users, Sources, …).

**Component (ARIA 1.2 combobox, no extra dependency):** `div[role="search"]` > `label.sr-only` "Quick find" + `input[type="search"]` `role="combobox"` `aria-expanded` `aria-controls="quick-find-list"` `aria-autocomplete="list"` `aria-activedescendant`, placeholder "Find an asset or page", `kbd` "Ctrl K" (aria-hidden); popup `ul#quick-find-list[role="listbox"]` of two `li[role="group"][aria-label="Tree matches"|"Page matches"]` (visual captions "Assets" / "Pages" are `aria-hidden` spans, NOT headings; the labels must not contain "asset", see Global Constraints) holding `li[role="option"][id][aria-selected]` (icon, label, detail); `onMouseDown` on an option preventDefault (keeps focus) and `onClick` navigates. Keys: ArrowDown/ArrowUp move the active option (wrapping), Enter opens the active one (nothing when none is active); Esc calls `preventDefault()` (Chromium clears a search field natively on Esc, which would make the first Esc close AND clear) and closes, a second Esc clears; Ctrl+K / Cmd+K anywhere focuses and selects the input (`preventDefault`) but does NOTHING while `[aria-modal="true"]` is in the document (behind a dialog it would steal focus from the form being typed in). Blur closes the popup, and so does a `pointerdown` outside `.qf`; the options' `onMouseDown` `preventDefault` keeps a click on an option from blurring the input first. `aria-controls` is set, and `aria-expanded` is true, only while the listbox is mounted; the "No match" status line sits outside the listbox. Opening one: `navigate(to)`, clear the query, close the popup, focus `#main`. The listbox is NOT in the DOM while the popup is closed. No popup while the query is empty; a short "No match" line (`role="status"`) when it has text but no hits. CSS from the mockup (`.qf`, `.qf-pop`), tokens only, popup z-index above the bar's content, the input on the navy bar using the `--top-find-*` tokens, long labels ellipsised.

- [ ] **Step 1: tests first.** `quickFind.test.ts`: ranking order, the path match, detail text, the cap of 8 and 5, empty and whitespace-only queries, case-insensitivity, a parent cycle does not hang, a 46-character name stays whole. `QuickFind.test.tsx` (Review Focus 5): a viewer gets no Users/Settings/Sources hit; type "mv2", ArrowDown ×2, Enter navigates to the second hit's `to` and clears the box; Esc closes, Esc again clears; Ctrl+K focuses the input; `aria-activedescendant` follows the active option; mouse click navigates; zero assets still lists pages; "No match" shows for gibberish; Tab away removes the listbox; a `pointerdown` outside closes it; Ctrl+K is ignored while a dialog is open; no `role="alert"` when the assets request fails (e2e `w7a.spec` adds: type, then Esc: the text stays and the popup is closed).
- [ ] **Step 2: implement**, mount in `Layout` before `.grow`.
- [ ] **Step 3: GREEN** `npx vitest run src/lib/quickFind.test.ts src/components/QuickFind.test.tsx src/components/Layout.test.tsx src/App.test.tsx src/pages/TariffsPage.test.tsx src/app.css.test.ts && npm run typecheck`; LOOK at the open popup at 1440.
- [ ] **Step 4: commit** `feat(ui): quick find in the top bar (O-14)`.

---

## Part B: the Assets workspace

### Task 6: fold state, Collapse all / Expand all, reveal the selected asset (O-15)

**Files:** Create `lib/treeFold.ts`, `lib/treeFold.test.ts`, `components/AssetTree.test.tsx` (the tree has no test of its own today); Modify `lib/tree.ts` (+test: `ancestorIds`), `components/AssetTree.tsx`, `pages/AssetsPage.test.tsx` if a tree assertion moves, `app.css` (where `.tree-head` lives). Read first: `AssetTree.tsx`, `lib/sidebarState.ts`, `lib/tree.ts`, the tree part of `AssetsPage.test.tsx`.

**Interfaces — Produces:**

```ts
// lib/treeFold.ts   storage key "dcdash.assetTreeFolded" (JSON array of asset ids)
export function readFolded(): Set<number>;                         // tolerant: not JSON, not an array, non-integers, more than 5000 entries → ignored/empty
export function saveFolded(ids: Iterable<number>): void;
export function foldableIds(nodes: readonly TreeNode[]): number[]; // ids of nodes that have at least one child
// lib/tree.ts
export function ancestorIds(nodes: readonly TreeNode[], id: number): number[];   // parents from the root down to the direct parent; [] for a root or an unknown id
// AssetTree: the same props as today (Task 8a removes onSelect).
```
Behaviour: `collapsed` starts from `readFolded()`; every change saves (ids pruned to `foldableIds(nodes)` once `nodes` is non-empty, so a folded node whose children are gone does not stay folded when it later gains a child; while the list is still loading nothing is pruned). Two `icon-btn`s in `.tree-head`, before the column toggle, hidden when the column is minimized: **"Collapse all"** (folds every foldable id) and **"Expand all"** (clears), `title` = name, both `disabled` while a filter is active or when nothing is foldable. Reveal: `const chain = ancestorIds(nodes, selectedId)`; an effect keyed on `[selectedId, chain.join(",")]` (NOT on `nodes` and NOT on `collapsed`: `nodes` gets a new identity on every create, rename or delete anywhere, which would re-open the path after "Collapse all") removes `chain` from `collapsed`. A new selection, or a reparent of the selected asset, still unfolds the way to it. Icons: two chevrons pointing toward each other (collapse) and away from each other (expand), `svg.i`.

- [ ] **Step 1: tests first** (Review Focus 2 and 8): `treeFold.test.ts` (garbage, `localStorage` throwing, round trip); `AssetTree` tests: Collapse all hides every nested list and the twisties show `aria-expanded="false"`; Expand all shows all; a reload (unmount, mount) keeps the fold; both buttons disabled while the filter has text and enabled again when it is cleared; collapse all, then render with a different `selectedId` that sits in a folded branch: its ancestors are open and the others stay folded; collapse all with the selected asset inside does not re-open it by itself, and neither does a re-render with a NEW, structurally equal `nodes` array plus one unrelated extra node (the ancestors stay folded); a node that gains its first child still starts open; storage full or throwing never raises.
- [ ] **Step 2: implement.** **Step 3: GREEN** `npx vitest run src/lib/treeFold.test.ts src/lib/tree.test.ts src/components/AssetTree.test.tsx src/pages/AssetsPage.test.tsx src/app.css.test.ts && npm run typecheck`.
- [ ] **Step 4: commit** `feat(ui): collapse all / expand all for the asset tree, remembered, reveals the selection (O-15)`.

### Task 7: resizable tree column (O-1)

**Files:** Create `lib/treeWidth.ts`, `lib/treeWidth.test.ts`; Modify `components/AssetTree.tsx`, `components/AssetTree.test.tsx`, `styles/pages-assets.css` (+ `app.css` for `.tree-col`), `app.css.test.ts`.

**Interfaces — Produces:**

```ts
// lib/treeWidth.ts   key "dcdash.assetTreeWidth"
export const TREE_MIN = 220;
export const TREE_STEP = 16;            // arrow key; Shift = 48
export function treeMax(viewport: number): number;                 // max(TREE_MIN, floor(viewport * 0.5))
export function clampTreeWidth(px: number, viewport: number): number | null;   // null for NaN/Infinity; else rounded and clamped to [TREE_MIN, treeMax]
export function readTreeWidth(viewport: number): number | null;    // stored value clamped; garbage → null (the CSS default applies)
export function saveTreeWidth(px: number): void;
```
Behaviour: `section.tree-col` gets the inline custom property `--tree-user-w: {n}px` only when a width is set; CSS: `.tree-col { --w: var(--tree-user-w, var(--tree-w)) }` and `max-width: max(220px, 50vw)` as a guard for a window that shrank after saving (the minimized state keeps its own `--w`, handled by the existing rule, and shows no handle). A handle `div.tree-resize[role="separator"][aria-orientation="vertical"]` `tabIndex=0`, `aria-label="Resize the tree column"`, `aria-valuemin/max/now` (now = the current width in px), inside the section on its right edge (6px wide, `cursor: col-resize`, visible hover/focus state using `--ring`). Pointer: `pointerdown` captures the pointer, `pointermove` sets the width from `clientX` relative to the column's left edge (clamped), `pointerup`/`pointercancel` release and SAVE; while dragging the section has class `is-resizing`, styled by `.shell.ready .tree-col.is-resizing { transition: none; user-select: none }` (this exact selector: the existing `.shell.ready .tree-col` transition rule has specificity (0,3,0) and a shorter selector would lose, making the column animate behind the pointer). `.tree-resize:focus-visible { outline-offset: -2px }` (the column is `overflow: hidden` and would clip an outside ring). Keyboard: Left/Right ± step (Shift ± 48), Home = min, End = max, each saves; double click resets to the default (removes the stored value and the inline property). A window resize re-clamps the displayed width.

- [ ] **Step 1: tests first** (Review Focus 2): `treeWidth.test.ts` (clamp, NaN, 10 → 220, 99999 → half the viewport, `localStorage` throwing, non-numeric stored text, a stored 400 on a 600 px viewport clamps to 300); component tests: the handle's attributes, ArrowRight/Left/Shift/Home/End change `aria-valuenow` and the saved value, a drag with synthetic pointer events (`setPointerCapture` stubbed) changes the width and saves on release, the stored width is applied on mount, double click resets, the handle is absent when the column is minimized. `app.css.test.ts`: `.tree-col`'s `--w` falls back to `--tree-w`; the rule `.shell.ready .tree-col.is-resizing` has `transition: none` (assert that exact selector); `.tree-resize:focus-visible` has a negative `outline-offset`.
- [ ] **Step 2: implement.** **Step 3: GREEN** `npx vitest run src/lib/treeWidth.test.ts src/components/AssetTree.test.tsx src/pages/AssetsPage.test.tsx src/app.css.test.ts && npm run typecheck`; LOOK: drag the handle at 1440 and see a 46-character name become readable.
- [ ] **Step 4: commit** `feat(ui): resizable asset tree column with a minimum width (O-1)`.

### Task 8a: one workspace for `/assets` and `/assets/:id` (O-3, closes F-1)

**Files:** Modify `App.tsx` (+`App.test.tsx`), `pages/AssetsPage.tsx`, `pages/AssetsPage.test.tsx`, `pages/AssetPage.tsx` (only the header actions), `components/AssetTree.tsx` (drop `onSelect`: the node link navigates), `api/queries.ts` (`keys.fleet`), `styles/pages-assets.css`. Read first: `AssetsPage.tsx`, `AssetPage.tsx`, `AssetsPage.test.tsx` (619 lines: dialog, delete, busy-lock and cache-invalidation behaviour that stays valid and MUST be kept), `test/fakeEventSource.ts`, `test/CacheProbes.tsx` (`cacheProbes.tsx`), `App.tsx`.

**Interfaces — Produces:**

```tsx
// App.tsx
<Route path="/assets" element={<AssetsPage />}>
  <Route index element={<AssetsHome />} />          // the old "Select an asset in the tree." state; Task 9 swaps in the summary
  <Route path=":id" element={<AssetPage />} />
</Route>
// pages/AssetsPage.tsx: the LAYOUT route. Renders <div.assets-layout><AssetTree …/><div.assets-detail><actionError/><Outlet context/></div></div> + the dialogs.
export interface AssetsContext {
  admin: boolean; locked: boolean;
  openAdd: (parentId: number | null) => void;       // the Add asset dialog; null = top level
  openEdit: () => void;                              // edits the asset in the URL
  remove: () => void;                                // the existing confirm + 409 impact flow, then navigate("/assets")
}
export function useAssetsContext(): AssetsContext | null;     // useOutletContext; null when a page renders outside the workspace (tests)
```
Rules: the selected id is `useMatch("/assets/:id")?.params.id` parsed by `parseAssetId` (Task 8b adds the strict regex; until then `Number()` of a digit-only string is enough). The tree's node `Link` navigates natively (`/assets/{id}`); delete `onSelect` and the `?selected=` handling. Add under the selected asset keeps today's meaning (`openAdd(selectedId)`); the tree's header `+` is top level. **Delete order:** keep today's order, `navigate("/assets")` BEFORE `finish()` (invalidating `["assets"]` refetches every active query under it, including the deleted asset's summary while its page is still mounted, which would flash a 404). After create/update/delete invalidate what `finish` invalidates today plus `keys.fleet` (add the key to `queries.ts` here as `["fleet-summary"]` so the invalidation compiles; Task 9 adds the hook). `AssetPage` gets its header `actions` from `useAssetsContext()`: the live chip, plus for an admin `Edit`, `Delete` (class `danger-quiet`) and the primary `Add asset`; the old Kind/Parent/Children block and the "Selected: … (open page)" paragraph, with their `.detail-meta`/`.detail-open` CSS, are deleted. The index child shows the page header "Assets" (the single `h1`), the admin's primary `Add asset` (top level), the `.empty` card when there are no assets, otherwise the line "Select an asset in the tree.".

- [ ] **Step 1: tests first.** Rewrite `AssetsPage.test.tsx`'s render helper as `renderWorkspace(route, { extra?: ReactElement })`: it mounts `<Routes><Route path="/assets" element={<AssetsPage/>}><Route index element={<AssetsHome/>}/><Route path=":id" element={<AssetPage/>}/></Route></Routes>` with the REAL index and asset page, and renders `extra` (for example `<CacheProbes/>`) outside `<Routes>`. The real `AssetPage` needs `new EventSource` (jsdom has none): stub it with `src/test/fakeEventSource.ts` (reset in `beforeEach`) and mock `GET /api/site` and `GET /api/assets/{id}/series` as well as the summary. **Keep every existing case**, moved to the new routes: the Add asset cases (opens with no parent, Esc returns focus to Add, the header's only button is Add, the empty list: now driven through the index route's header) at today's lines ~88, 114, 574, 612; both cache-invalidation `it.each` cases (billing, widget data and tariffs refetch after a delete) with `keys.fleet` added to the probes (fleet refetched once more after a delete); the busy-lock and delete-with-impact cases. Replace only the "Selected:" cases by: clicking a tree node navigates and the asset's tiles/Trend/Metrics appear in the pane with no extra click; the tree stays mounted and keeps its filter text and fold when you move between two assets; selecting highlights the node (`aria-current`); deleting the open asset lands on `/assets` (Review Focus 4); a viewer sees no Edit/Delete/Add and no `+`. `App.test.tsx`: `/assets` and `/assets/1` both render the tree.
- [ ] **Step 2: implement.** **Step 3: GREEN** `npx vitest run src/pages/AssetsPage.test.tsx src/pages/AssetPage.test.tsx src/components/AssetTree.test.tsx src/App.test.tsx src/app.css.test.ts && npm run typecheck && npm run build`; LOOK at `/assets/{id}` at 1440 and 1920: the tree left, tiles right, no 1200 px stop.
- [ ] **Step 4: commit** `feat(ui): one Assets workspace: the tree beside every asset page, no two-step select (O-3, F-1)`.

### Task 8b: the asset page's crumb trail, sub line and id handling (O-4 for assets)

**Files:** Modify `pages/AssetPage.tsx`, `pages/AssetPage.test.tsx`, `lib/tree.ts` (+test: `assetTrail`, `parseAssetId`), `pages/AssetsPage.tsx` (use `parseAssetId`), `styles/pages-assets.css`, `docs/superpowers/backlog.md` (one line, see below). Read first: `AssetPage.tsx`, `AssetPage.test.tsx` (367 lines; its `routes()` at ~35 does not mock `GET /api/assets`).

**Interfaces — Produces:**

```ts
// lib/tree.ts
export function assetTrail(assets: readonly Asset[], id: number): Asset[];   // root first, ending with the asset itself; [] for an unknown id; cycle-safe
export function parseAssetId(raw: string | undefined): number | null;        // /^[1-9]\d{0,9}$/ and <= 2147483647, else null (never Number() of arbitrary text)
```
Rules: `AssetPage` calls `parseAssetId`; null renders `<p class="error" role="alert">Asset not found.</p>` and makes NO request (Review Focus 3); a 404 from the API shows its message in the pane. The header `crumbs` = `{label: "Assets", to: "/assets"}` followed by `assetTrail` mapped to `{label: name, to: "/assets/" + id}` with the last one text; **when `assetTrail` is empty** (the cached list has not caught up, for example right after a create) the crumbs are `[{Assets, /assets}, {label: data.asset.name}]`, so the page never loses the asset itself. `sub` = `{kind} · {n} sub-asset(s)` from `useAssets()` (the parent is the previous crumb). Delete `.assets-detail .page-head > .actions { grid-row: 1 }` in `pages-assets.css` (line ~8, written for a header with no crumbs or sub line). Backlog (Task 10 writes it in section R): `GET /api/assets/99999999999/summary` answers 500 (`DBAPIError … value out of int32 range`); validate the id (422/404).

- [ ] **Step 1: tests first.** `assetTrail` and `parseAssetId` unit tests (`"12abc"`, `"0"`, `"-1"`, `"007"`, `"2147483648"`, `"99999999999"`, `""`, `undefined` are null; `"1"` and `"2147483647"` parse). `AssetPage.test.tsx`: add `GET /api/assets` to `routes()`; crumbs `Assets / MV2 / Room-1` with links for all but the last, clicking a crumb navigates; the fallback crumbs when the list lacks the asset; the sub line; `/assets/abc`, `/assets/0` and `/assets/99999999999` make no summary request and show "Asset not found."; a 404 shows its message; the plain-text-crumb assertions of the old page are gone.
- [ ] **Step 2: implement.** **Step 3: GREEN** `npx vitest run src/lib/tree.test.ts src/pages/AssetPage.test.tsx src/pages/AssetsPage.test.tsx src/app.css.test.ts && npm run typecheck`; LOOK at an asset 3 levels deep with a 46-character name at 1440.
- [ ] **Step 4: commit** `feat(ui): breadcrumb trail on the asset page, strict id handling (O-4)`.

### Task 9: fleet summary on `/assets` (O-2)

**Files:** Create `pages/AssetsSummary.tsx`, `pages/AssetsSummary.test.tsx`; Modify `api/types.ts`, `api/queries.ts` (+`queries.test.tsx`), `App.tsx` (index element), `styles/pages-assets.css`, `app.css.test.ts` if a guard needs it. Read first: `EnergyTile.tsx`, `CostTile.tsx`, `MetricsTable.tsx` (`fmt`), `lib/kinds.ts` (`kindKey`), `lib/siteTime.ts`, `lib/rollup.ts` (the wording style), `pages/SourcesPage.tsx` (table + chip classes), `app.css` (`.tiles`, `.chip-*`, `.empty`).

**Interfaces — Produces / Consumes:**

```ts
// api/types.ts  (mirrors Task 2)
export interface AttentionItem { asset_id: number; name: string; path: string; problem: "bad" | "stale"; points: number; last_ts: string }
export interface FleetSummary {
  power: { kw: number | null; counted: number; of: number };
  energy_today: { kwh: number; estimated: boolean; no_data: boolean } | null;
  cost_today: CostToday | null; currency: string | null;
  attention: { total: number; items: AttentionItem[] };
}
// api/queries.ts   keys.fleet = ["fleet-summary"] (added in Task 8a)
export const useFleetSummary = () => useQuery({ queryKey: keys.fleet, queryFn: () => api.get<FleetSummary>("/api/fleet/summary"), refetchInterval: 15_000 });
// COST_DEPENDENT gains keys.fleet (a rate, currency or timezone change moves the fleet figures too)
```
Page (replaces `AssetsHome` as the index child): `PageHeader title="Assets"` with the admin's primary `Add asset` (top level, from `useAssetsContext()`); `.tiles` with four tiles: **Assets** (`useAssets().length`), **Live power** (`{fmt(kw)} kW` and a small line "Sum of N meters" / "Sum of N of M meters; the others are not reporting" / "None of the M meters is reporting" / "No power meters mapped", the same wording family as `rollupNote`, `—` when kw is null), `EnergyTile`, `CostTile`; then **By kind** (an `h2.section-title` named "By kind": the assets' kinds grouped by `kindKey`, the most used spelling shown, a count each, most first, as `ul.kind-list`; NOT a link list) and **Needs attention** (`h2.section-title`; a `div.table-wrap > table` with columns Asset (a `Link` to `/assets/{id}`), Where (the path without the asset's own name), Problem (`chip chip-bad` "Bad reading" / `chip chip-stale` "No recent reading", plus "· N points" when more than one), Last reading (`formatSiteDateTime` in the site zone); when `total > items.length` a line "and N more"; when `total` is 0 a `chip chip-ok` "Nothing needs attention"). Zero assets: the `.empty` card "No assets yet." (admin: with the Add asset button already in the header) and none of the sections. Loading and error as the other pages (`loading…`, `role="alert"`). Heading names must not contain "Assets", "Metrics" or "Trend" (they do not: "By kind", "Needs attention").

- [ ] **Step 1: tests first** (Review Focus 5). **First give the existing tests a fleet answer:** add `GET /api/fleet/summary` (an empty-site body) to `authed()` in `AssetsPage.test.tsx` and to `routes` in `App.test.tsx`, because `mockFetch` answers an unmocked request with a 500 and the new page would add a second `role="alert"` to the cases that use `findByRole("alert")` (~lines 342 and 353). With zero assets the `.empty` card renders before any fleet error. Then: tiles with fixture figures (power with a note, all four wordings; kw null shows a dash); energy and cost reuse the tile components (a `no_data` day is muted as on the asset page); the kind grouping (case and spacing variants merge, most used spelling wins, counts); the attention table rows, links, chips, "· 3 points", "and 5 more", the empty chip; zero assets; the page has exactly one `h1`; the fleet request is made once (the asset list comes from the cached assets query).
- [ ] **Step 2: implement**; styles in `pages-assets.css` (`.kind-list` a wrapped row of `li` with name and count, hairline separated; the tiles are the existing `.tiles`; table in `.table-wrap`). **Step 3: GREEN** `npx vitest run src/pages/AssetsSummary.test.tsx src/api/queries.test.tsx src/pages/AssetsPage.test.tsx src/App.test.tsx src/app.css.test.ts && npm run typecheck && npm run build`; LOOK at `/assets` with attention rows (the controller's scratch stack has stale and bad readings: stop the simulator source to make some).
- [ ] **Step 4: commit** `feat(ui): fleet summary on the Assets landing page (O-2)`.

---

## Part C: end-to-end, review, merge

### Task 10: e2e specs and documents

**Files:** Create `frontend/e2e/shell.ts`, `frontend/e2e/w7a.spec.ts`; Modify `journey.spec.ts`, `discovery.spec.ts`, `w3a.spec.ts`, `w3b.spec.ts`, `w3c.spec.ts`, `w3d.spec.ts`, `phase3.spec.ts`, `headers.spec.ts`, `docs/superpowers/backlog.md` (close F-1, add "section R: W7a leftovers" including the 500 on an out-of-range asset id and the open question of a "No reading yet" problem in the attention list), the README if it names the sidebar's Password/Sign out or "Select … open page" (`grep -n "Sign out\|open page" README.md docs/*.md`). Read first: every spec's helper block (`navLink`, `signIn`, `signOut`, `userBlock`), `e2e/roles.ts`.

**Interfaces — Produces (`e2e/shell.ts`):**

```ts
export const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" });
export const navLink = (page: Page, name: string) => mainNav(page).getByRole("link", { name, exact: true });
export const treeLink = (page: Page, name: string) => page.getByRole("region", { name: "Asset tree" }).getByRole("link", { name, exact: true });   // the tree's node link; on /assets/:id the same name is also a crumb link
export const userBlock = (page: Page) => page.locator(".navbar .who");              // the profile trigger in the top bar (NOT "header .who": PageHeader renders a header too)
export async function signOut(page: Page): Promise<void>;   // open the profile panel, click "Sign out", confirm in the dialog, wait for the "Sign in" heading
```
- [ ] **Step 0 (label audit):** `grep -rhn "getByLabel(" frontend/e2e/*.ts` and check every value, case-insensitively as a substring, against the `aria-label`s and `<label>`s this wave added (Quick find, Tree matches, Page matches, Resize the tree column, Collapse all, Expand all, Breadcrumb, Main, the profile trigger's name) on every page that spec visits; rename the new label, never the spec's value. Record the result in the commit body.
- [ ] **Step 1:** the lines to change, from the plan review: `.who` lookups through `getByRole("navigation")` at `phase3:54`, `w3a:35`, `w3b:91`, `w3c:41`, `w3d:54`, `headers:94` (they find nothing once the user block is in the banner); the local `navLink` helpers at `phase3:33` and `w3d:43` (they also match the Breadcrumb nav: on a dashboard page the crumb and the sidebar both have a "Dashboards" link); sign-out at `phase3:60`, `w3c:168`, `w3d:60`; `journey:63` (`getByRole("list")`) and `journey:64` ("(open page)"). In `shell.ts`, `signOut()` clicks `page.getByRole("dialog", { name: /^Sign out/ }).getByRole("button", { name: "Sign out", exact: true })` after the panel's own "Sign out" button. So: replace every unscoped `getByRole("navigation")`, every `.who` lookup, every `getByRole("button", { name: "Sign out" })` and every sidebar `getByRole("link", { name: "Assets"|"Sources"|"Scans"|"Discovery"|"Audit"|"Dashboards" … })` with `navLink` and every tree-node link lookup by an asset name with `treeLink` (the crumb links now share both kinds of name: `w3a.spec` lines 57, 69, 80 (`W3a-Room`, `W3a-Panel-A`, `W3a-Panel-B`), `journey.spec` lines 43 and 63 (`MV2`), and any other `getByRole("link", { name: <asset name> })`); `journey.spec.ts` step 6 becomes: click the tree's MV2 link, expect the URL `/assets/\d+`, the heading MV2 and "Metrics" with no second click. Run the e2e type-check.
- [ ] **Step 2: `w7a.spec.ts`** (one worker, uses the seeded stack as the other specs do): selecting a node shows the asset without a second click and the tree stays; the crumb "Assets" returns to the summary; resize by keyboard (focus the separator, ArrowRight ×3) and the width survives a reload; Collapse all then Expand all; Collapse all survives a reload; quick find: Ctrl+K, type, Enter lands on the asset; profile panel: Sign out → Cancel stays signed in → Sign out → confirm lands on the sign-in page; `/billing` and `/users` at 1920 wide use more than 1500 px for `main`'s content box (no 1200 cap); the status chip reads "Live" while the simulator runs (check it with `page.locator(".navbar .live b")`: `discovery:164` and `journey:71` use `getByText("live", { exact: true })` for the stream chip and survive only because the case differs); the summary page shows four tiles and "Needs attention".
- [ ] **Step 3:** run the e2e type-check and `npx vitest run src/App.test.tsx`; commit `test(e2e): W7a shell helpers and workspace spec`. The controller runs the whole Playwright suite in Task 11.

### Task 11: whole-branch verification, review, merge (controller)

- [ ] Full frontend suite (`cd frontend && npx vitest run`), `npm run typecheck`, `npm run build`; full backend suite once (`cd backend && uv run pytest -q`, 9 to 14 minutes).
- [ ] Rebuild the scratch visual stack from the branch (`.superpowers/sdd/2026-10-11-w6-ui-overhaul/vis-rebuild.sh`; seeded, project `dcdash_e2e_w6_vis`, web 18180), then the whole Playwright suite in the e2e project (`scripts/e2e.sh`; the normal stack is stopped first, never `-v`; backup first per the standing rule).
- [ ] ONE whole-branch Opus review (effort High, prompt in a file) that LOOKS at every page in a browser at 1920, 1440 and 1024 (Assets summary, an asset page with a 46-character name and a deep path, Dashboards list and a dashboard, Billing, Sources and a source's points, Scans, Discovery (exactly one window tall under the bar), Users, Settings, Tariffs, Storage, Audit and an entry, Password, Login), keyboard-only through the bar (Ctrl+K, profile panel, sign-out confirm, tree resize/fold), reads the diff for the Review Focus list, and reports Critical/Important/Minor. Fix, re-review only the fix diff (medium).
- [ ] Merge `--no-ff` into `main`, push, back up the dev stack's database, rebuild the normal stack from `main`, update memory (`dc-dashboard-project`), tick every box in this file.

## Self-review (spec coverage)

O-1 Task 7 · O-2 Tasks 2 and 9 · O-3 Task 8a · O-4 Tasks 3 and 8b (crumbs on Asset, Points, Audit entry, Dashboard; the Scans page has no crumb today) · O-5 Task 4b · O-12 unchanged by decision 6 · O-13 Task 4a (the panel) and 4b (placement) · O-14 Tasks 4a, 4b and 5 (option C; the figures strip stays out by default) · O-15 Task 6 · F-1 Task 8a. Not covered on purpose: O-16 (own wave, migration), O-6 to O-11. Names used across tasks: `useAssetsContext`/`AssetsContext` (8a, 9), `keys.fleet` (8a, 9), `assetTrail`/`parseAssetId` (8b), `Crumb`/`Crumbs` (3, 8b), `statusView`/`agoText` (4a), `GROUPS`/`NavItem` (4b, 5), `readFolded`/`foldableIds`/`ancestorIds` (6), `readTreeWidth`/`clampTreeWidth`/`TREE_MIN` (7), `navLink`/`treeLink`/`userBlock`/`signOut` (10).

## Opus review status

- [x] Plan: ONE Opus plan review, 2026-10-11 (read-only worktree; it ran the Task 2 refactor against the summary, data, billing and cost tests, a scratch fleet route over 7 scenarios, the route-inventory tests and the session code). Result: 0 Blockers, 10 Majors, 16 Minors, written to `.superpowers/sdd/2026-10-11-w7a/plan-review.md` and folded into this file: status chip freshness is the server's per-mapping rule (`readings_fresh`), Task 8 split into 8a/8b, the white popups in the navy bar get `--ring: var(--accent)` and the sign-out dialog is portalled, the resize-drag and Collapse-all fixes, quick-find blur/Esc/Ctrl+K rules, the lost-coverage and mock fixes for the `AssetsPage` test port, the e2e line list, and the minor CSS and fleet-cost corrections. Sessions do not slide on activity (`expires_at` is written once at login), so the 10 s status poll is safe.
- [x] Owner sign-off of decisions 1 to 6: "lgtm", 2026-10-11.
- [ ] Task 2 code review (Opus, medium).
- [ ] Whole branch (Opus, high, with a browser): Task 11.
