# Phase 3 — Dashboards and Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One energy engine on the hourly rollup feeds a Billing screen (cost per asset per day and month, CSV), tariffs and a site currency, a cost tile on the asset page, and shared dashboards of five widget types (time series, bar, stat, gauge, table) over metrics, energy and cost, with a drag-and-resize editor and per-widget CSV export.

**Architecture:** `core/energy.py` is rewritten to read `readings_1h` in one batched query and compute hourly kWh in pure Python (counter deltas with in-hour reset recovery; power-only estimates), rolled up the asset tree; `core/cost.py` prices those hours with the tariff in effect; `api/data.py` is moved onto the engine. New API modules serve site info, tariffs, billing, dashboards and widget data (JSON and CSV). The UI adds Dashboards, Billing and Tariffs pages; `react-grid-layout` and the ECharts widgets load only on the dashboard pages.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2 async + asyncpg, Alembic, TimescaleDB, pytest-asyncio (existing); React 19, TanStack Query 5, react-router 7, ECharts via echarts-for-react, Vitest 3, Playwright (existing); `react-grid-layout` 2.x (new).

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` — section 10 (10.1–10.9), section 6 (Tiers, Energy, Time), section 4 (tables), section 8 (roles), section 9 (asset page). Section numbers below refer to it.

**Prerequisite:** branch `phase-3-dashboards-billing` (from `main` at `855cbf8`; the spec commit is already on it). Alembic head before this plan is `0003`.

## Global Constraints

- Read-only toward sources and devices (section 2). This phase only reads and writes the database; `api` never contacts a source, and tariff/dashboard changes must NOT fire `CONFIG_CHANNEL` (that makes the collector reload).
- Nothing Windows-specific (section 2).
- Roles are enforced in the API (section 8): admin = tariffs and currency; operator = read tariffs, create/edit/delete dashboards; viewer = read dashboards, billing, widget data, CSV, `/api/site`.
- Site timezone must have a whole-hour UTC offset in both January and July (section 6 Time); Settings refuses any other zone; billing and widget-data answer 409 if the stored zone breaks the rule.
- Range presets are exactly `1h`, `6h`, `24h`, `7d`, `30d` (rolling, ending now) and `today`, `yesterday`, `this_month`, `last_month` (calendar, site timezone). No custom ranges (10.1).
- Limits (10.4, 10.5): 24 widgets per dashboard, 50 dashboards, 20 assets per widget, dashboard name and widget title at most 100 characters, dashboard name unique.
- Tariff: `rate_per_kwh` non-negative with at most 6 decimals, `effective_from` a site-local date, at most one row per (asset or site default, effective_from). Currency: three uppercase letters, one for the whole site, may be unset (null).
- Widgets cannot use the `custom` metric (10.5). Aggregations: `avg|min|max|last` for source `metric`; `sum` for `energy` and `cost`.
- CSV (10.6): UTF-8 with a byte-order mark; timestamps in the site timezone, ISO 8601 with offset; any cell starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with an apostrophe.
- Audited actions (10.7): `tariff.created`, `tariff.updated`, `tariff.deleted`, `billing.currency_changed`, `dashboard.created`, `dashboard.updated`, `dashboard.deleted` via `dcdash.core.audit.audit(db, user_id, action, detail)`. Reads and exports are not audited.
- Development is test-first (section 13). UI is minimal and functional (section 2).
- Commit messages end with the two trailer lines the session provides (`Co-Authored-By: ...` and `Claude-Session: ...`). Every task commits and pushes to `origin phase-3-dashboards-billing`.
- Backend tests: `cd backend && uv run pytest <path> -v` (testcontainers starts TimescaleDB; Docker must be running). Frontend tests: `cd frontend && npm test -- <path>`, `npm run typecheck`.
- **Data safety:** never run `scripts/e2e.sh` and never run `docker compose down -v` on the default compose project — it deletes the owner's `dcdash_dbdata` volume. End-to-end runs use only the isolated project: `docker compose -p dcdash_e2e --profile dev down -v --remove-orphans`, `... up -d --build`, `(cd frontend && npm run e2e)`, `... down -v` (the normal stack must be stopped first with `docker compose --profile dev stop`; verify `docker volume ls` still lists `dcdash_dbdata` afterwards). Rebuilding or restarting the normal stack applies migration 0004 to `dcdash_dbdata`: do it only with the owner's explicit go-ahead (Task 11, Step 7).
- Executor note: implementation subagents run on model `sonnet`, reviewers on `opus`; never Fable.

## Review Focus

Failure modes the spec implies that a person using this will hit; each has a test in the task named:

1. **Resets and outages must never produce negative or inflated kWh.** A counter that resets inside an hour, exactly between two hours, or rolls over; a power-only meter with a 20-minute outage; a meter with no readings in the range (counts 0, does not fall back to its children). (Task 2.)
2. **Daylight-saving days and month edges.** A 23-hour and a 25-hour local day, and a month boundary, must split hours exactly: day totals add up to the month total; no hour is dropped or counted twice. (Tasks 2 and 4.)
3. **Missing or changing rates must never show as zero.** No tariff at all → cost null; a rate that starts mid-month → earlier days null/partial, later days priced; a child override beats the site default only from its own effective date; a parent with no meter sums its children's costs. (Tasks 3 and 4.)
4. **Two operators editing one dashboard, and bad widget configs.** The second save gets 409 and nothing is lost or duplicated; 21 assets, a stat with two assets, a gauge on energy, a `custom` metric and a range that is not a preset are all rejected with a readable 422. (Task 5.)
5. **Hostile or stale content in exports and saved widgets.** An asset named `=HYPERLINK("http://x","y")` must not become a formula in any CSV; a saved widget that references a since-deleted asset returns the remaining assets plus `missing`, never a 500. (Task 6; the UI side in Task 9.)

---

## File Structure

Backend (`backend/`):

| File | Action | Responsibility |
|---|---|---|
| `migrations/versions/0004_billing_dashboards.py` | create | Tables `tariffs`, `dashboards`, `widgets`; `settings.billing` row; both rollup refresh windows widened to 7 days |
| `dcdash/core/models.py` | modify | `Tariff`, `Dashboard`, `Widget` models |
| `dcdash/core/tree.py` | create | `AssetTree`: parent/child lookups and display paths, loaded once per request |
| `dcdash/core/timeutil.py` | create | Whole-hour zone check, `day_start`, `month_start`, range presets, month bounds, local-day edges |
| `dcdash/core/energy.py` | rewrite | Pure hourly counter/power maths, `hourly_energy()` batched engine with roll-up |
| `dcdash/core/cost.py` | create | `load_tariffs`, `rate_at`, `cost_by_hour`, `summarize` |
| `dcdash/core/csvout.py` | create | `safe_cell`, `write_csv` (BOM, injection guard) |
| `dcdash/core/widgets.py` | create | Widget config schemas/validation (Pydantic) and the widget data queries |
| `dcdash/core/settings_store.py` | modify | `BILLING_KEY`, `get_currency` |
| `dcdash/api/data.py` | modify | Summary and `asset_energy` use the engine; `cost_today` added; raw energy SQL removed |
| `dcdash/api/settings.py` | modify | `GET/PUT /api/settings/billing`; timezone whole-hour validation |
| `dcdash/api/site.py` | create | `GET /api/site` |
| `dcdash/api/tariffs.py` | create | Tariff CRUD |
| `dcdash/api/billing.py` | create | `GET /api/billing/costs` and `.csv` |
| `dcdash/api/dashboards.py` | create | Dashboard CRUD with optimistic concurrency |
| `dcdash/api/widget_data.py` | create | `POST /api/widget-data` and `/csv` |
| `dcdash/api/main.py` | modify | Register the new routers |
| `tests/conftest.py`, `tests/test_schema.py`, `tests/test_schema_tiers.py` | modify | New tables truncated/expected; head is `0004` |

Frontend (`frontend/src/`):

| File | Action | Responsibility |
|---|---|---|
| `api/types.ts`, `api/queries.ts` | modify | Types and hooks listed under Interface Contracts |
| `lib/ranges.ts` | create | `RANGE_PRESETS`, labels, `isRolling` |
| `lib/siteTime.ts` | create | Format a timestamp or day in the site timezone |
| `lib/layout.ts` | create | Pure widget ⇄ grid-item conversion and defaults |
| `lib/download.ts` | create | `downloadCsv(path, body?)` via fetch + blob |
| `components/dashboard/*` | create | `WidgetFrame`, `widgets/{TimeSeries,Bar,Stat,Gauge,Table}Widget.tsx`, `WidgetEditor`, `AssetPicker`, `DashboardGrid` |
| `pages/DashboardsPage.tsx`, `DashboardPage.tsx`, `BillingPage.tsx`, `TariffsPage.tsx` | create | The four new screens |
| `pages/AssetPage.tsx`, `components/CostTile.tsx`, `components/Layout.tsx`, `main.tsx` | modify/create | Cost tile, nav, routes |
| `e2e/phase3.spec.ts`, `e2e/playwright.config.ts` | create/modify | New `phase3` project depending on `discovery` |

Files added while the task sections were written (not in the tables above):

- Backend: `dcdash/core/series.py` (Task 6: series querying extracted from `api/data.py`); `Meter`, `assemble`, `load_meters` in `dcdash/core/energy.py` and the test helper `settle_rollups` in `tests/helpers.py` (Task 2); `tests/billing_helpers.py` (Task 4); many `tests/test_*.py` named in the tasks.
- Frontend: `src/App.tsx` (routes, moved out of `main.tsx` in Task 7), `src/lib/scanText.ts` (Task 0), `src/hooks/useDialogFocus.ts` (Task 9), `src/test/reactGridLayout.smoke.test.tsx` (Task 7).
- `frontend/e2e/global-setup.ts` (Task 11: error text no longer points at `scripts/e2e.sh`), `README.md`, `docs/superpowers/backlog.md` (Task 11).

## Execution grouping

One fresh subagent per row (model `sonnet`), one Opus review after each row. After row G (end of Task 6) an Opus backend checkpoint review runs before any frontend work starts; after row L the whole-phase review and merge (final section). Each task section is long (several hundred to ~1800 lines of exact test and implementation code): an executor reads only its own task plus this header.

| Agent | Task |
|---|---|
| A | 0 |
| B | 1 |
| C | 2 |
| D | 3 |
| E | 4 |
| F | 5 |
| G | 6 |
| H | 7 |
| I | 8 |
| J | 9 |
| K | 10 |
| L | 11 |

---

## Interface Contracts

These are the names and shapes every task must use. A task that needs one repeats the relevant part in its own **Interfaces** block. All datetimes crossing a module boundary are timezone-aware; hourly bucket keys are UTC. "Site zone" = `await current_timezone(db)` (existing, `dcdash/api/settings.py`).

### Amendments agreed while the tasks were written (these override the contract text above)

1. `core/timeutil.py` functions return datetimes in **UTC** (`tzinfo=timezone.utc`), never in the site zone: arithmetic on two datetimes sharing a `ZoneInfo` is wall-clock and mis-measures a 23/25-hour DST day. Callers needing a local date or wall time use `dt.astimezone(ZoneInfo(site_zone))`. Extra export: `day_bounds(now, tz_name) -> tuple[datetime, datetime]` = [local midnight of now's day, next local midnight).
2. `core/csvout.safe_cell` prefixes an apostrophe only to **`str`** cells that start with `=`, `+`, `-`, `@`, tab or CR; ints, floats, bools and None are never prefixed (a negative reading stays a number).
3. `tariffs.rate_per_kwh` is `numeric(13,6)` (so 1000000 fits). Postgres rounds a 7th decimal silently, so `api/tariffs.py` itself rejects more than 6 decimals and rates above 1000000.
4. `lib/layout.applyGrid(drafts, grid: readonly GridItem[])` (react-grid-layout 2 passes a readonly array) and returns the same `drafts` array when nothing moved.
5. Routes live in `frontend/src/App.tsx`; `main.tsx` only mounts providers. Task 10 moves `main.tsx` to `createBrowserRouter([{ path: "*", element: <App /> }])` + `<RouterProvider>` because `useBlocker` needs a data router.
6. Clock seams for tests (monkeypatched module functions): `dcdash.api.data._now` (created in Task 2), `dcdash.api.billing._now` (Task 4), `dcdash.api.widget_data._now` (Task 6).
7. A power-only own meter (no `energy_kwh` mapping) with no readings at all in the requested range yields an entry for every whole UTC hour of the range, `HourEnergy(0.0, True)` — an estimated zero (Task 2 fix round 1, so the spec section 6 label rule holds); a silent *counter* meter still yields `{}` and `total({})` is `Energy(0.0, False)`. Consequences for later tasks: with a rate such a power-only meter prices to cost 0.0 (estimated, never partial); energy/cost series for a power-only meter silent for the whole range draw estimated zeros, not gaps; a power-only meter with rows on only some days still shows its silent days as unlabelled zeros.
8. The reset rule of spec section 6 over-counts if, after a reset inside one hour, the counter climbs past its old last value within that same hour (example 2, 3, 0, 50 → 98 instead of about 51). Accepted: for kWh meters with large totals this cannot happen.
9. Widgets cannot use the `custom` metric (spec 10.5, added 2026-10-08); `WidgetConfig.metric` is typed `Metric | null` in TypeScript, the editor excludes `custom`, the API rejects it.

### Backend modules

`dcdash/core/tree.py`
```python
@dataclass(frozen=True)
class AssetNode: id: int; parent_id: int | None; name: str; sort_order: int
class AssetTree:
    nodes: dict[int, AssetNode]
    @classmethod
    async def load(cls, db: AsyncSession) -> "AssetTree"
    def children(self, asset_id: int) -> list[int]          # ordered by sort_order, name, id
    def ancestors_or_self(self, asset_id: int) -> list[int] # self first, then parents upward
    def path(self, asset_id: int) -> str                    # "Site / MV2 / LV Panel 1"
    def preorder(self) -> list[int]                         # parents before children, siblings ordered as children()
```

`dcdash/core/timeutil.py`
```python
RANGE_PRESETS: tuple[str, ...]   # the nine presets, in the order listed in Global Constraints
ROLLING: frozenset[str]          # {"1h","6h","24h","7d","30d"}
def validate_whole_hour_zone(tz_name: str) -> None            # ValueError("...") if unknown or offset in Jan or Jul is not a whole hour
def day_start(now: datetime, tz_name: str) -> datetime        # local midnight, aware (moved from api/data.py; data.py re-imports it)
def month_start(now: datetime, tz_name: str) -> datetime
def month_bounds(month: str, tz_name: str) -> tuple[datetime, datetime]   # "YYYY-MM" -> [first local midnight, first local midnight of next month)
def resolve_range(preset: str, now: datetime, tz_name: str) -> tuple[datetime, datetime]  # [start, end): rolling = (now-N, now); today = (local midnight, now); this_month = (month start, now); yesterday / last_month = the full finished period
def local_days(start: datetime, end: datetime, tz_name: str) -> list[tuple[date, datetime, datetime]]  # local days overlapping [start,end) with clipped edges; handles 23/25-hour days
```

`dcdash/core/energy.py` (the existing `Energy(kwh: float, estimated: bool)` dataclass stays)
```python
@dataclass(frozen=True)
class HourRow: bucket: datetime; min_value: float; max_value: float; sum_value: float; n: int; last_value: float
@dataclass(frozen=True)
class HourEnergy: kwh: float; estimated: bool
@dataclass(frozen=True)
class EnergyResult:
    hours: dict[int, dict[datetime, HourEnergy] | None]   # one key per asset in the tree; None = no energy_kwh or active_power_kw mapping anywhere in its subtree
    own: frozenset[int]                                    # assets whose figure comes from their own mapping (not from summing children)
def counter_hours(rows: Sequence[HourRow], baseline_last: float | None) -> dict[datetime, float]
    # rows ascending by bucket. Hour kWh = last - prev_last; reset rule (spec 6): if min_value < prev_last: max(0, max_value - prev_last) + (last_value - min_value);
    # no baseline (first ever bucket): last_value - min_value. Gaps: the delta goes to the hour in which the next row arrives.
def power_hours(rows: Sequence[HourRow], interval_seconds: int) -> dict[datetime, float]
    # kWh of an hour = (sum_value / n) * min(1.0, n * interval_seconds / 3600)
async def hourly_energy(db: AsyncSession, tree: AssetTree, start: datetime, end: datetime) -> EnergyResult
    # start/end on whole UTC hours. Own meter wins (energy_kwh, else active_power_kw -> estimated=True); otherwise the sum of children
    # (None children skipped; None if all are None). Mapping scale multiplies the kWh. A mapped meter with no rows gives {} (zero), not None.
    # The baseline for each counter is the last bucket before `start`. Bad-quality readings are already excluded by the rollup views.
def total(hours: dict[datetime, HourEnergy] | None) -> Energy | None
```

`dcdash/core/cost.py`
```python
@dataclass(frozen=True)
class TariffRow: asset_id: int | None; rate_per_kwh: float; effective_from: date
@dataclass(frozen=True)
class HourCost: kwh: float; cost: float | None; estimated: bool; unpriced: bool
    # cost is None when no rate applied in that hour; unpriced is True when kwh > 0 and cost is None
@dataclass(frozen=True)
class Cost: kwh: float; cost: float | None; estimated: bool; partial: bool
async def load_tariffs(db: AsyncSession) -> list[TariffRow]
def rate_at(tariffs: Sequence[TariffRow], tree: AssetTree, asset_id: int, local_day: date) -> float | None
    # nearest ancestor-or-self with a row whose effective_from <= local_day, its latest such row; else the site default (asset_id None); else None
def cost_by_hour(energy: EnergyResult, tariffs: Sequence[TariffRow], tree: AssetTree, tz_name: str) -> dict[int, dict[datetime, HourCost] | None]
    # assets in energy.own: kwh * rate_at(that hour's local date). Other assets: the sum of their children's HourCost
    # (cost None only if every child is None; unpriced if any child is unpriced). None where energy is None.
def summarize(hours: Iterable[HourCost]) -> Cost   # kwh = sum; cost = sum of non-None costs (None if there are none); estimated = any; partial = any unpriced
```

`dcdash/core/csvout.py`
```python
def safe_cell(value: object) -> str
def write_csv(header: Sequence[str], rows: Iterable[Sequence[object]]) -> bytes   # BOM + CRLF rows, every cell through safe_cell
```

`dcdash/core/widgets.py`
```python
WIDGET_TYPES = ("timeseries", "bar", "stat", "gauge", "table")
class WidgetConfig(BaseModel):  # extra="forbid"
    assets: list[int]                     # unique, 1..20
    source: Literal["metric", "energy", "cost"]
    metric: Metric | None = None          # required iff source == "metric"; never Metric.custom
    aggregation: Literal["avg", "min", "max", "last", "sum"]
    range: str | None = None              # a preset, or None = inherit the dashboard's
    bars: Literal["asset", "time"] = "asset"
    min: float = 0.0                      # gauge only
    max: float | None = None              # gauge only, required for gauge, > min
def validate_config(widget_type: str, config: dict) -> WidgetConfig   # raises ValueError with a readable message per rule
async def widget_data(db, widget_type: str, config: WidgetConfig, preset: str, now: datetime) -> dict   # shape below
```

### HTTP API (JSON unless noted; timestamps ISO 8601 with offset)

- `GET /api/site` (viewer) → `{"timezone": "Asia/Qatar", "currency": "QAR" | null}`
- `GET /api/settings/billing`, `PUT /api/settings/billing` body `{"currency": "QAR" | null}` (admin) → `{"currency": ...}`; invalid code → 422; changed → audit `billing.currency_changed`. `PUT /api/settings/general` refuses a non-whole-hour zone with 422.
- `GET /api/tariffs` (operator) → `[{"id", "asset_id": int|null, "asset_name": str|null, "rate_per_kwh": float, "effective_from": "YYYY-MM-DD", "created_by": int|null, "created_at"}]`, site default first, then by asset name, then `effective_from` descending.
  `POST /api/tariffs` (admin) body `{"asset_id": int|null, "rate_per_kwh": float, "effective_from": "YYYY-MM-DD"}` → 201 tariff; 404 unknown asset; 409 duplicate `(asset_id, effective_from)`; 422 negative rate, more than 6 decimals, rate above 1000000.
  `PATCH /api/tariffs/{id}` (admin) `{"rate_per_kwh"?, "effective_from"?}` → tariff (asset cannot change); `DELETE /api/tariffs/{id}` (admin) → 204.
- `GET /api/billing/costs?month=YYYY-MM` (viewer; default current month; 422 bad month) →
  ```json
  {"month": "2026-10", "timezone": "...", "currency": "QAR" | null,
   "days": ["2026-10-01", "..."],
   "assets": [{"asset_id": 5, "parent_id": 2 | null, "name": "LV Panel 1", "path": "Site / MV2 / LV Panel 1",
               "rate_per_kwh": 0.12 | null,
               "days": [{"kwh": 12.3, "cost": 1.48 | null, "estimated": false, "partial": false} | null],
               "total": {"kwh": 380.1, "cost": 45.6 | null, "estimated": false, "partial": false} | null}]}
  ```
  `assets` in tree preorder, every asset included; `days` has one entry per element of the top-level `days`; an entry (and `total`) is `null` when the asset has no energy figure, and for local days after today. `rate_per_kwh` = rate in effect on the last day of the month (or today, for the current month).
  `GET /api/billing/costs.csv?month=` → `text/csv`, header `asset,date,kwh,cost,currency,estimated,partial`, one row per asset per day that has an entry (`asset` = full path; empty cost cell when null).
- `GET /api/assets/{id}/summary` gains `"cost_today": {"cost": float|null, "estimated": bool, "partial": bool} | null` and `"currency": str|null` (existing keys unchanged; `energy_today` is now computed by the engine).
- Dashboards (shape `D` below): `GET /api/dashboards` (viewer) → `[{"id","name","range","widget_count","updated_at"}]` by name; `POST /api/dashboards` (operator) `{"name","range"?="24h"}` → 201 `D`; `GET /api/dashboards/{id}` → `D`; `PUT /api/dashboards/{id}` (operator) body `{"name","range","updated_at","widgets":[{"type","title","config","x","y","w","h"}]}` → `D` (widgets replaced wholesale with new ids; 409 if `updated_at` differs from the stored one or the name is taken; 422 for invalid widgets, including a 25th widget); `DELETE` (operator) → 204.
  `D` = `{"id","name","range","updated_at","widgets":[{"id","type","title","config","x","y","w","h"}]}`; `config` is the `WidgetConfig` JSON above.
- `POST /api/widget-data` (viewer) body `{"type","config","range"}` where `range` is the effective preset (the client resolves inheritance) →
  ```json
  {"type": "bar", "mode": "series" | "values", "source": "metric", "metric": "active_power_kw" | null,
   "unit": "kW" | "kWh" | "QAR" | null, "range": {"preset": "24h", "start": "...", "end": "..."},
   "tier": "raw" | "1m" | "1h" | null, "bucket": "hour" | "day" | null,
   "series": [{"asset_id": 5, "name": "LV Panel 1", "points": [{"ts": "...", "value": 1.0 | null, "min": 0.9 | null, "max": 1.1 | null}], "estimated": false, "partial": false}],
   "values": [{"asset_id": 5, "name": "LV Panel 1", "value": 1.0 | null, "estimated": false, "partial": false, "point_id": 7 | null}],
   "missing": [99]}
  ```
  `timeseries` and `bar` with `bars: "time"` use `mode: "series"` (`values: []`); `bar` with `bars: "asset"`, `stat`, `gauge`, `table` use `mode: "values"` (`series: []`). Metric series: `value` = average, `min`/`max` set; energy/cost series: `min`/`max` null, `bucket` hour for ranges up to 48 hours else day, `tier` null. `point_id` is the asset's mapping point for the metric (for live updates) and null for energy/cost. `missing` lists configured asset ids that no longer exist (they are skipped). 409 on a non-whole-hour site zone; 422 on an invalid config.
  `POST /api/widget-data/csv` same body → `text/csv` attachment, header `asset,source,unit,timestamp,value,estimated,partial` (`asset` = full path; `source` = metric name, `energy` or `cost`; `timestamp` = bucket start, or the range start in values mode).

### Frontend

Types in `api/types.ts`: `RangePreset` (union of the nine), `Site`, `Tariff`, `BillingCosts` (+ `BillingAssetRow`, `CostFigure`), `WidgetType`, `WidgetSource`, `WidgetConfig`, `Widget`, `Dashboard`, `DashboardListItem`, `WidgetData`.
Hooks in `api/queries.ts`: `useSite()`, `useBillingSettings()`, `usePutBillingSettings()`, `useTariffs()`, `useCreateTariff()`, `useUpdateTariff()`, `useDeleteTariff()`, `useBillingCosts(month)`, `useDashboards()`, `useDashboard(id)`, `useCreateDashboard()`, `useSaveDashboard()`, `useDeleteDashboard()`, `useWidgetData(type, config, preset)` (refetch every 30 s, `placeholderData: keepPreviousData`).
Routes: `/dashboards`, `/dashboards/:id`, `/billing`, `/tariffs` (admin via `RequireRole`). Nav: Dashboards and Billing for every role, Tariffs for admin.
The dashboard page calls `useStream` once with the union of the live widgets' `point_id`s and passes the values to widgets through a React context (`LiveValuesContext`), so there is one `EventSource` per dashboard.

---

### Task 0: Backlog section A hardening

Six small defects from the Phase 2 reviews, each fixed test-first, in four sub-commits. Phase 3 touches these areas (review dialog, scan summary, sources, storage page), so they are cleared before new work starts. Findings that drove the design (verified in the code):

- `POST /api/discovery/accept` takes `custom_unit` as a bare `str | None` and stores it untouched; `ReviewRow.customUnit` is already sent but there is no input for it, and a row switched to `custom` from a non-custom suggestion loses the point's `unit_hint`.
- `core/discovery.py::expand_targets` echoes the whole target in `not a valid host name: …` (bare host) and `not a valid network: …` (CIDR); only `://` targets are checked for credentials.
- `api/sources.py::_save` turns every `IntegrityError` into the same 409 text, and `GET /api/sources` hides discovered sources that have no mapped point.
- `ScanProgress`/`ScansPage` show `progress.claimed` (every service a connector identified, including ones that then rejected the credentials) and the raw outcome string.
- `test_storage_stats_shape_and_rows_per_day` anchors rows to `now - 1 day`; `core/storage.py` reads `datetime.now(timezone.utc)` twice (both are `.now`).
- `test_collector_jobs.py`: the leftover-task assertion filters on `"jobs"` in the coroutine repr (never true); `test_a_wake_while_all_workers_are_busy_is_not_lost` passes without `wake.set()` because a worker that finishes a job `continue`s straight into a new claim.

**Files:**
- Modify: `backend/dcdash/core/discovery.py` (`expand_targets`, ~line 128)
- Modify: `backend/dcdash/api/sources.py` (`_save`, `list_sources`, `create_source`, `update_source`)
- Modify: `backend/dcdash/api/discovery.py` (`AcceptPoint`, ~line 22)
- Modify: `frontend/src/lib/drop.ts`, `frontend/src/components/graph/ReviewDialog.tsx`
- Create: `frontend/src/lib/scanText.ts`
- Modify: `frontend/src/components/ScanProgress.tsx`, `frontend/src/pages/ScansPage.tsx`
- Test: `backend/tests/test_discovery_logic.py`, `backend/tests/test_api_scans.py`, `backend/tests/test_api_sources.py`, `backend/tests/test_api_storage.py`, `backend/tests/test_collector_jobs.py`, `backend/tests/test_api_discovery.py`
- Test: `frontend/src/lib/drop.test.ts`, `frontend/src/components/graph/ReviewDialog.test.tsx`, `frontend/src/pages/DiscoveryPage.test.tsx`, `frontend/src/lib/scanText.test.ts` (new), `frontend/src/pages/ScansPage.test.tsx`

**Interfaces:**
- Consumes (existing, unchanged): `expand_targets(targets, ports, max_hosts) -> Expansion` raising `TargetError`; `Metric` (`dcdash.core.metrics`); `GraphPoint.unit_hint`, `Suggestion.custom_unit`, `ScanCounters`, `Finding` (`frontend/src/api/types.ts`); `useAction`, `renderWithProviders`, `mockFetch`.
- Produces:
  - `AcceptPoint.custom_unit` (`str | None`, stripped, at most 20 characters): required for `metric == custom` (422 `a custom metric needs a unit`), set to `None` for every other metric.
  - 409 text from `POST/PATCH /api/sources` when the name belongs to a hidden discovered source: `the name "<name>" is already used by a discovered source that is hidden from this list until one of its points is mapped; choose another name`. Any other clash keeps `a source with this name already exists`.
  - `frontend/src/lib/drop.ts`: `MAX_UNIT_LENGTH = 20`; `ReviewRow.unitHint: string | null`; `withMetric(row: ReviewRow, metric: Metric): ReviewRow`; `missingUnits(rows: readonly ReviewRow[]): number[]`.
  - `frontend/src/lib/scanText.ts`: `outcomeLabel(outcome: string): string`, `claimedCount(progress: ScanCounters): number`.

#### Part A: credentials in a bare target are never echoed

- [ ] **A1. Write the failing tests.** Append to `backend/tests/test_discovery_logic.py` (after the last test in the file):

```python
@pytest.mark.parametrize(
    "target",
    ["admin:hunter2@10.0.0.1", "admin:hunter2@plc.local", "hunter2@10.0.0.1", "admin:hunter2@10.0.0.0/24", "@10.0.0.1"],
)
def test_bare_targets_with_credentials_are_rejected_without_echoing_them(target):
    with pytest.raises(TargetError, match="targets must not contain credentials") as caught:
        expand_targets([target], [502], 10)
    message = str(caught.value)
    assert "hunter2" not in message and "admin" not in message and "@" not in message


def test_a_credentials_target_is_rejected_even_after_valid_ones():
    with pytest.raises(TargetError, match="credentials") as caught:
        expand_targets(["10.0.0.1", "plc.local", "admin:hunter2@10.0.0.2"], [502], 10)
    assert "hunter2" not in str(caught.value)
```

Append to `backend/tests/test_api_scans.py` directly after `test_url_targets_with_credentials_are_rejected_without_echoing_them`:

```python
@pytest.mark.parametrize("target", ["admin:hunter2@10.0.0.1", "admin:hunter2@plc.local", "admin:hunter2@10.0.0.0/24"])
async def test_bare_targets_with_credentials_are_rejected_without_echoing_them(client, db, target):
    await login_as(client, db, "admin")
    response = await client.post("/api/scopes", json={"name": "x", "targets": [target], "ports": [502]})
    assert response.status_code == 422
    assert "credentials" in response.json()["detail"]
    assert "hunter2" not in response.text and "admin:" not in response.text
    assert await db.fetchval("SELECT count(*) FROM scan_scopes") == 0
    scope = await create_scope(client)
    patched = await client.patch(f"/api/scopes/{scope['id']}", json={"targets": [target]})
    assert patched.status_code == 422 and "hunter2" not in patched.text and "admin:" not in patched.text
    assert (await client.get("/api/scopes")).json()[0]["targets"] == ["127.0.0.1/30"]
```

- [ ] **A2. Run and see them fail.**
`cd backend && uv run pytest tests/test_discovery_logic.py tests/test_api_scans.py -k "bare_targets or credentials_target" -v`
Expected: FAIL. The unit tests raise `TargetError` with `not a valid host name: admin:hunter2@10.0.0.1` / `not a valid network: …`, so `match="targets must not contain credentials"` does not match; the API tests fail on `"credentials" in detail`.

- [ ] **A3. Implement.** In `backend/dcdash/core/discovery.py`, `expand_targets`, add one branch between the URL branch and the CIDR branch (no other change in the function):

```python
        if "://" in target:
            host, port = _url_host_port(target)
            add(host)
            extra.append((host, port))
        elif "@" in target:
            # Before any branch below builds a message from the target: "not a valid host name: user:password@…"
            # would echo the password back in the 422 body.
            raise TargetError("targets must not contain credentials")
        elif "/" in target:
            for host in _cidr_hosts(target, max_hosts):
                add(host)
        else:
            add(_single_host(target))
```

- [ ] **A4. Run and see them pass.**
`cd backend && uv run pytest tests/test_discovery_logic.py tests/test_api_scans.py -v`
Expected: all PASS (the older URL-credential tests still pass: their targets contain `://` and hit the first branch).

#### Part B: a name clash with a hidden discovered source says so

- [ ] **B1. Write the failing tests.** In `backend/tests/test_api_sources.py` change the helper import to `from helpers import listening, login_as, make_asset, make_mapping, make_point, make_source`, then append:

```python
async def hidden_discovered(db, name: str) -> int:
    """A discovered source with no mapped point: GET /api/sources does not list it."""
    source = await make_source(db, name, "opcua", {"endpoint": "opc.tcp://10.0.0.5:4840/"}, enabled=False)
    await db.execute("UPDATE sources SET origin = 'discovered' WHERE id = $1", source)
    return source


async def test_a_name_clash_with_a_hidden_discovered_source_says_so(client, db):
    await login_as(client, db)
    await hidden_discovered(db, "plc-1")
    assert (await client.get("/api/sources")).json() == []  # the admin cannot see it
    response = await client.post("/api/sources", json={**SIM, "name": "plc-1"})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "discovered source" in detail and "hidden" in detail and "plc-1" in detail
    assert await db.fetchval("SELECT count(*) FROM sources") == 1


async def test_renaming_onto_a_hidden_discovered_source_gets_the_same_message(client, db):
    await login_as(client, db)
    await hidden_discovered(db, "plc-1")
    mine = await create_sim(client)
    response = await client.patch(f"/api/sources/{mine['id']}", json={"name": "plc-1"})
    assert response.status_code == 409
    assert "discovered source" in response.json()["detail"] and "hidden" in response.json()["detail"]
    assert (await client.get("/api/sources")).json()[0]["name"] == "sim"  # the failed rename changed nothing


async def test_a_clash_with_a_listed_source_keeps_the_generic_message(client, db):
    await login_as(client, db)
    await create_sim(client)
    response = await client.post("/api/sources", json=SIM)
    assert response.status_code == 409
    assert response.json()["detail"] == "a source with this name already exists"


async def test_a_clash_with_a_discovered_source_that_is_listed_is_generic_too(client, db):
    await login_as(client, db)
    source = await hidden_discovered(db, "plc-1")
    point = await make_point(db, source, "a1")
    await make_mapping(db, point, await make_asset(db, "Panel"))  # mapped: now it is listed
    assert [s["name"] for s in (await client.get("/api/sources")).json()] == ["plc-1"]
    response = await client.post("/api/sources", json={**SIM, "name": "plc-1"})
    assert response.status_code == 409
    assert response.json()["detail"] == "a source with this name already exists"
```

- [ ] **B2. Run and see them fail.**
`cd backend && uv run pytest tests/test_api_sources.py -k "clash or renaming_onto" -v`
Expected: the first two FAIL (`"discovered source" in detail` is False: the detail is the generic text); the last two PASS already (they pin that the generic message is kept).

- [ ] **B3. Implement** in `backend/dcdash/api/sources.py`.

Replace the `_save` function with:

```python
def _has_mapped_point():
    """True for a source with at least one mapped point: only those discovered sources appear in the sources list."""
    return exists(select(Point.id).join(Mapping, Mapping.point_id == Point.id).where(Point.source_id == Source.id))


async def _name_clash_message(db: AsyncSession, name: str | None) -> str:
    # A discovered source nobody has mapped yet is hidden from GET /api/sources, so without this the admin is told a
    # name is taken by something they cannot see.
    if name is not None:
        hidden = await db.scalar(
            select(Source.id).where(Source.name == name, Source.origin == "discovered", ~_has_mapped_point()).limit(1)
        )
        if hidden is not None:
            return (
                f'the name "{name}" is already used by a discovered source that is hidden from this list '
                "until one of its points is mapped; choose another name"
            )
    return "a source with this name already exists"


async def _save(db: AsyncSession, name: str | None = None) -> None:
    """Flush and commit; `name` is the name this request tried to set, used to explain a unique-name clash."""
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()  # the failed flush leaves the session unusable until it is rolled back
        raise HTTPException(409, await _name_clash_message(db, name)) from None
    await notify(db, CONFIG_CHANNEL)
    await db.commit()
```

Replace the body of `list_sources` after the comment with the shared helper:

```python
@router.get("/sources", response_model=list[SourceOut], dependencies=[Operator])
async def list_sources(db: AsyncSession = Depends(get_db)) -> list[Source]:
    # Discovered sources stay out of the list until at least one of their points is mapped.
    query = select(Source).where(or_(Source.origin == "manual", _has_mapped_point())).order_by(Source.name)
    return list((await db.scalars(query)).all())
```

In `create_source` change `await _save(db)` to `await _save(db, body.name)`; in `update_source` change `await _save(db)` to `await _save(db, body.name)` (it is `None` when the PATCH does not rename, which gives the generic text).

- [ ] **B4. Run and see them pass.**
`cd backend && uv run pytest tests/test_api_sources.py tests/test_api_discovery.py -v`
Expected: all PASS.

- [ ] **B5. Commit (credentials echo and name clash).**

```bash
git add backend/dcdash/core/discovery.py backend/dcdash/api/sources.py backend/tests/test_discovery_logic.py backend/tests/test_api_scans.py backend/tests/test_api_sources.py
git commit -m "$(cat <<'EOF'
fix: never echo credentials from a bare scan target; explain a clash with a hidden discovered source

expand_targets rejects any "@" in a non-URL target before a message can be built from it (host and CIDR forms).
POST/PATCH /api/sources says when the clashing name belongs to a discovered source that GET /api/sources hides.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

#### Part C: the storage-stats test no longer depends on the time of day

- [ ] **C1. Rewrite the test.** In `backend/tests/test_api_storage.py` replace the imports and `test_storage_stats_shape_and_rows_per_day` (leave the other two tests untouched):

```python
from datetime import datetime, time, timedelta, timezone

import pytest

from tests.helpers import insert_readings, login_as, make_point, make_source
```

```python
@pytest.mark.parametrize(
    "clock", [time(0, 5), time(12, 0), time(23, 55)], ids=["just-after-midnight", "midday", "just-before-midnight"]
)
async def test_storage_stats_shape_and_rows_per_day(client, db, monkeypatch, clock):
    # The endpoint reads the clock itself (`datetime.now(timezone.utc)` twice), so the clock is pinned and the readings
    # sit at fixed offsets from that day's UTC midnight. The old version anchored rows to "now - 1 day" and failed
    # whenever the suite ran after 22:00 UTC, because the 2 h block of "yesterday" rows spilled into today.
    midnight = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    frozen = datetime.combine(midnight.date(), clock, tzinfo=timezone.utc)

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen if tz is None else frozen.astimezone(tz)

    monkeypatch.setattr("dcdash.core.storage.datetime", FrozenDatetime)
    sid = await make_source(db)
    pid = await make_point(db, sid, "LVP01_kW")
    await insert_readings(db, pid, midnight - timedelta(hours=23), 60, [1.0] * 120)  # 120 rows yesterday, 01:00-03:00
    await insert_readings(db, pid, midnight, 60, [1.0] * 30)                        # 30 rows today, 00:00-00:30
    await login_as(client, db)
    r = await client.get("/api/storage")
    assert r.status_code == 200
    body = r.json()
    assert body["database_bytes"] > 0 and body["readings_bytes_total"] > 0
    assert len(body["rows_per_day"]) == 7
    assert body["rows_per_day"][-1]["rows"] == 30 and body["rows_per_day"][-2]["rows"] == 120
    assert body["rows_per_day"][-1]["day"] == midnight.date().isoformat()
    assert body["disk_capacity_bytes"] == 100 * 1024**3
    assert body["warn"] is False and body["days_until_full"] is not None
    assert body["settings"]["warn_threshold_pct"] == 80
```

- [ ] **C2. Run it.** `cd backend && uv run pytest tests/test_api_storage.py -v`
Expected: PASS, three parametrized cases plus the other two tests, whatever the wall-clock time.

- [ ] **C3. Prove the assertions are real (mutation check, then restore).** Temporarily change `midnight - timedelta(hours=23)` to `midnight - timedelta(hours=1)` (the yesterday block now runs 23:00 to 01:00, which is what the old test did after 22:00). Run `cd backend && uv run pytest tests/test_api_storage.py -k rows_per_day -v`.
Expected: FAIL in all three cases on `rows_per_day[-1]["rows"] == 30` (it is 90: 60 rows spilled into today) and `[-2]` (60 instead of 120). Restore `hours=23` and re-run: PASS.

#### Part D: the two vacuous collector-job tests become real

All edits are in `backend/tests/test_collector_jobs.py` (`jobs_module` is already imported at the top of the file).

- [ ] **D1. Replace the leftover-task assertion.** In `test_stopping_ends_idle_workers_cleanly`, replace the whole test with:

```python
async def test_stopping_ends_idle_workers_cleanly(db):
    wake, stop = asyncio.Event(), asyncio.Event()
    before = set(asyncio.all_tasks())  # the loop is shared by the whole session: only tasks created below count
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        task = asyncio.create_task(run_job_loop(db, factory(), wake, stop, poll_seconds=30))
        await asyncio.sleep(0.1)
        stop.set()
        await asyncio.wait_for(task, timeout=2)  # well before the 30 s poll
    assert task.done() and task.exception() is None
    leaked = [t for t in asyncio.all_tasks() if t not in before and not t.done()]
    assert not leaked, [getattr(t.get_coro(), "__qualname__", repr(t)) for t in leaked]
```

- [ ] **D2. Replace the "wake while busy" test.** Replace `test_a_wake_while_all_workers_are_busy_is_not_lost` (its `wake.set()` made no difference: the finishing worker claims again before it ever looks at `wake`) with these two tests. Place the second one right after `test_idle_workers_poll_when_no_wake_arrives`:

```python
async def test_a_job_queued_while_every_worker_is_busy_is_claimed_as_soon_as_one_frees_up(db):
    """No NOTIFY and a 30 s poll: the worker that finishes looks for more work before it goes to sleep."""
    from dcdash.connectors.base import ConnectionCheck

    release = asyncio.Event()

    class BlockingConnector:
        async def test(self) -> ConnectionCheck:
            await release.wait()
            return ConnectionCheck(True, "ok", 1.0, "ok")

        async def close(self) -> None:
            return None

    source = await make_source(db)
    first = await add_job(db, "test_source", source)
    wake, stop = asyncio.Event(), asyncio.Event()
    task = asyncio.create_task(run_job_loop(db, lambda *_: BlockingConnector(), wake, stop, workers=1, poll_seconds=30))
    try:
        await wait_for(status_check(db, first), "running")
        second = await add_job(db, "test_source", source)  # queued behind the only worker; nothing wakes anyone
        await asyncio.sleep(0.1)
        assert await status_of(db, second) == "pending"
        release.set()
        await wait_for(status_check(db, second), "done", timeout=3)
    finally:
        release.set()
        await stop_loop(task, stop)
```

```python
async def test_a_wake_that_arrived_before_the_wait_started_ends_it_at_once_and_is_consumed():
    """A NOTIFY can land between a worker's empty claim and the start of its wait: it must not be lost or left set."""
    wake = asyncio.Event()
    wake.set()
    await asyncio.wait_for(jobs_module._wait_for_work(wake, None, 30), timeout=1)
    assert not wake.is_set()
```

- [ ] **D3. Run the file.** `cd backend && uv run pytest tests/test_collector_jobs.py -v`
Expected: all PASS.

- [ ] **D4. Prove each new assertion fails against a deliberately broken variant.** Apply each variant to `backend/dcdash/collector/jobs.py`, run the named test, expect the stated failure, then restore with `git checkout -- backend/dcdash/collector/jobs.py` before the next one.
  1. Leftover tasks: in `_wait_for_work`, replace the whole body of the `finally:` block (the `for future in waiting: future.cancel()` loop and the `await asyncio.gather(...)` line) with `pass`. Run `cd backend && uv run pytest tests/test_collector_jobs.py::test_stopping_ends_idle_workers_cleanly -v`. Expected: FAIL with `leaked` listing `['Event.wait']` (the abandoned `wake.wait()` task). The old filter (`"jobs" in repr(t.get_coro())`) would have passed here, because the repr is `<coroutine object Event.wait …>`.
  2. Claim before sleeping: in `run_job_loop.worker`, delete the `continue` line (the worker then sleeps in `_wait_for_work` after every job). Run `cd backend && uv run pytest tests/test_collector_jobs.py::test_a_job_queued_while_every_worker_is_busy_is_claimed_as_soon_as_one_frees_up -v`. Expected: FAIL with `timed out: last value 'pending', expected 'done'` (the old test passed on this variant because its `wake.set()` woke the worker).
  3. Wake consumed and not lost: in `_wait_for_work`, move `wake.clear()` to the first line of the function. Run `cd backend && uv run pytest tests/test_collector_jobs.py::test_a_wake_that_arrived_before_the_wait_started_ends_it_at_once_and_is_consumed -v`. Expected: FAIL with `TimeoutError` (the wait now sleeps the full 30 s). Then restore and instead delete the final `wake.clear()` line; the same test must FAIL on `assert not wake.is_set()`.
  After the last restore: `git diff --stat backend/dcdash/collector/jobs.py` must print nothing.

- [ ] **D5. Commit (test-only changes).**

```bash
git add backend/tests/test_api_storage.py backend/tests/test_collector_jobs.py
git commit -m "$(cat <<'EOF'
test: deterministic storage-stats days; real assertions in the collector job tests

test_storage_stats_shape_and_rows_per_day pins the endpoint's clock and anchors its rows to UTC midnight (it failed
after 22:00). The leftover-task check diffs asyncio.all_tasks() instead of matching "jobs" in a coroutine repr. The
busy-worker test no longer calls wake.set() (it never needed it); a direct test pins the already-set wake.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

#### Part E: custom-unit input in the review dialog

- [ ] **E1. Backend tests (failing first).** Append to `backend/tests/test_api_discovery.py`:

```python
async def test_accept_stores_a_trimmed_custom_unit_and_drops_a_stray_one(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Site")
    response = await client.post("/api/discovery/accept", json=body(source, asset, [
        pt(ids["LVP01_kW"], "custom", custom_unit="  degC "),
        pt(ids["LVP01_V"], "voltage_v", custom_unit="stray"),
    ]))
    assert response.status_code == 201, response.text
    rows = await db.fetch("SELECT metric, custom_unit FROM mappings ORDER BY metric")
    assert [(r["metric"], r["custom_unit"]) for r in rows] == [("custom", "degC"), ("voltage_v", None)]


@pytest.mark.parametrize("extra", [{}, {"custom_unit": None}, {"custom_unit": ""}, {"custom_unit": "   "}])
async def test_accept_rejects_a_custom_metric_without_a_unit(client, db, extra):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Site")
    response = await client.post(
        "/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"], "custom", **extra)])
    )
    assert response.status_code == 422
    assert "needs a unit" in response.text
    assert await db.fetchval("SELECT count(*) FROM mappings") == 0


async def test_accept_limits_the_custom_unit_to_twenty_characters(client, db):
    await login_as(client, db, "admin")
    source, ids = await seed_source(db)
    asset = await make_asset(db, "Site")
    too_long = await client.post(
        "/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"], "custom", custom_unit="x" * 21)])
    )
    assert too_long.status_code == 422
    fits = await client.post(
        "/api/discovery/accept", json=body(source, asset, [pt(ids["LVP01_kW"], "custom", custom_unit="x" * 20)])
    )
    assert fits.status_code == 201
```

- [ ] **E2. Run and see them fail.** `cd backend && uv run pytest tests/test_api_discovery.py -k "custom" -v`
Expected: FAIL. `…trimmed_custom_unit…` stores `"  degC "` and `"stray"`; the no-unit cases return 201; the 21-character unit returns 201.

- [ ] **E3. Implement.** In `backend/dcdash/api/discovery.py` add the constant after the `Operator = …` line and replace `AcceptPoint` (`Annotated`, `StringConstraints` and `model_validator` are already imported there). `MappingIn` in `api/mappings.py` is deliberately NOT changed: `test_api_mappings.py` posts `custom` without a unit.

```python
MAX_UNIT_LENGTH = 20  # keep in step with MAX_UNIT_LENGTH in frontend/src/lib/drop.ts
```

```python
class AcceptPoint(BaseModel):
    point_id: int
    metric: Metric
    scale: float = Field(default=1.0, gt=0)
    interval_seconds: int | None = Field(default=None, ge=1)
    custom_unit: Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_UNIT_LENGTH)] | None = None

    @model_validator(mode="after")
    def _unit_belongs_to_custom(self) -> "AcceptPoint":
        if self.metric is Metric.CUSTOM:
            if not self.custom_unit:
                raise ValueError("a custom metric needs a unit")
        else:
            self.custom_unit = None  # a unit means something only for custom; never store a stray one
        return self
```

- [ ] **E4. Run and see them pass.** `cd backend && uv run pytest tests/test_api_discovery.py tests/test_api_mappings.py -v`
Expected: all PASS.

- [ ] **E5. Frontend pure-logic tests (failing first).** In `frontend/src/lib/drop.test.ts` change line 1 to
`import { MAX_UNIT_LENGTH, acceptBody, assetChoices, dropPayload, metricConflicts, missingUnits, pickDropTarget, reviewRows, takenMetrics, withMetric, type ReviewRow } from "./drop";`
and append:

```ts
describe("custom units", () => {
  const custom = (over: Partial<ReviewRow> = {}): ReviewRow => ({
    pointId: 1, name: "T", checked: true, metric: "custom", scale: 1, intervalSeconds: 5, customUnit: "degC", unitHint: "degC", note: null, ...over,
  });
  const kwPoint = (hint: string | null) =>
    point(1, "P kW", { unit_hint: hint, suggestion: { metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null } });

  it("a row remembers its point's unit hint; a custom suggestion without a unit falls back to it", () => {
    const hinted = point(2, "T c", { unit_hint: "bar", suggestion: { metric: "custom", scale: 1, interval_seconds: 5, custom_unit: null } });
    expect(reviewRows([hinted], new Set())[0]).toMatchObject({ metric: "custom", unitHint: "bar", customUnit: "bar" });
    expect(reviewRows([kwPoint("kW")], new Set())[0]).toMatchObject({ unitHint: "kW", customUnit: null });
  });
  it("withMetric(custom) prefills the unit from the hint; an edited unit survives; any other metric drops it and the note", () => {
    const fromKw = reviewRows([kwPoint("kW")], new Set())[0];
    expect(withMetric(fromKw, "custom")).toMatchObject({ metric: "custom", customUnit: "kW", note: null });
    expect(withMetric(custom({ customUnit: "MWh" }), "custom").customUnit).toBe("MWh");
    expect(withMetric(withMetric(fromKw, "custom"), "voltage_v")).toMatchObject({ metric: "voltage_v", customUnit: null });
    expect(withMetric(reviewRows([kwPoint(null)], new Set())[0], "custom").customUnit).toBeNull();
    expect(withMetric(custom({ note: "This asset already has voltage_v." }), "frequency_hz").note).toBeNull();
  });
  it("missingUnits lists checked custom rows whose unit is empty or only spaces", () => {
    const rows = [
      custom({ pointId: 1, customUnit: null }), custom({ pointId: 2, customUnit: "   " }), custom({ pointId: 3, customUnit: "bar" }),
      custom({ pointId: 4, customUnit: "", checked: false }), custom({ pointId: 5, metric: "voltage_v", customUnit: null }),
    ];
    expect(missingUnits(rows)).toEqual([1, 2]);
  });
  it("acceptBody trims the unit and sends null for a non-custom metric", () => {
    const rows = [custom({ pointId: 1, customUnit: "  degC " }), custom({ pointId: 2, metric: "voltage_v", customUnit: "stale" })];
    expect(acceptBody(1, { kind: "existing", assetId: 2 }, rows).points.map((p) => p.custom_unit)).toEqual(["degC", null]);
  });
  it("the unit limit matches the server's", () => {
    expect(MAX_UNIT_LENGTH).toBe(20);
  });
});
```

- [ ] **E6. Run and see them fail.** `cd frontend && npm test -- src/lib/drop.test.ts`
Expected: FAIL in the new `custom units` block (`withMetric is not a function`, `missingUnits is not a function`, `unitHint` undefined); the older tests still pass.

- [ ] **E7. Implement `frontend/src/lib/drop.ts`.**
  (a) Add directly above `export interface ReviewRow`:

```ts
/** The longest custom unit the server accepts (`MAX_UNIT_LENGTH` in api/discovery.py). */
export const MAX_UNIT_LENGTH = 20;
```
  (b) In `ReviewRow` add the field after `customUnit`:

```ts
  customUnit: string | null;
  /** The point's own unit text, used to prefill the unit when the row is switched to `custom` */
  unitHint: string | null;
```
  (c) In `reviewRows`, replace the returned object with:

```ts
    return {
      pointId: p.id, name: p.name, checked: note === null, metric, scale,
      intervalSeconds: interval_seconds, customUnit: metric === "custom" ? (custom_unit ?? p.unit_hint) : null,
      unitHint: p.unit_hint, note,
    };
```
  (d) Add after `metricConflicts`:

```ts
/** The row after its metric changes: the old note no longer applies, and a unit only means something for `custom` (prefilled from the point's hint). */
export function withMetric(row: ReviewRow, metric: Metric): ReviewRow {
  return { ...row, metric, note: null, customUnit: metric === "custom" ? (row.customUnit ?? row.unitHint) : null };
}

/** Ids of checked custom rows whose unit is empty or only spaces: the server refuses them, so the dialog does too. */
export function missingUnits(rows: readonly ReviewRow[]): number[] {
  return rows.filter((r) => r.checked && r.metric === "custom" && (r.customUnit ?? "").trim() === "").map((r) => r.pointId);
}
```
  (e) In `acceptBody` replace the `custom_unit: r.customUnit` property with `custom_unit: r.metric === "custom" ? ((r.customUnit ?? "").trim() || null) : null`.

- [ ] **E8. Run.** `cd frontend && npm test -- src/lib/drop.test.ts`
Expected: PASS.

- [ ] **E9. Dialog tests (failing first).** In `frontend/src/components/graph/ReviewDialog.test.tsx`:
  (a) In `graph()`, give point 2 a hint: replace `point(2, "LVP01 kWh", { suggestion: suggest("energy_kwh", { scale: 0.001, interval_seconds: 60 }) }),` with
  `point(2, "LVP01 kWh", { unit_hint: "kWh", suggestion: suggest("energy_kwh", { scale: 0.001, interval_seconds: 60 }) }),`
  (b) In the existing test `several custom rows are fine together; …`, add one line right after the `selectOptions(screen.getByLabelText("Metric for T b"), "voltage_v")` line:
  `expect(screen.queryByLabelText("Unit for T b")).not.toBeInTheDocument(); // only custom rows have a unit field`
  (c) Add these tests inside the top-level `describe("ReviewDialog", …)`, after that existing test:

```tsx
  it("a custom row has a unit field prefilled from its suggestion; other rows have none", async () => {
    await open(existing(11), undefined, "TEMPS");
    expect(screen.getByLabelText("Unit for T a")).toHaveValue("degC");
    expect(screen.getByLabelText("Unit for T b")).toHaveValue("degC");
    cleanup();
    await open(existing(11));
    expect(screen.queryByLabelText(/^Unit for/)).not.toBeInTheDocument();
  });

  it("switching a row to custom prefills the unit from the point's hint; the edited unit is posted trimmed", async () => {
    const { calls, onClose } = await open(existing(11));
    await userEvent.selectOptions(screen.getByLabelText("Metric for LVP01 kWh"), "custom");
    const unit = screen.getByLabelText("Unit for LVP01 kWh");
    expect(unit).toHaveValue("kWh");
    await userEvent.clear(unit);
    await userEvent.type(unit, "  MWh ");
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts(calls)[0].body).toMatchObject({
      points: [
        { point_id: 1, metric: "active_power_kw", custom_unit: null },
        { point_id: 2, metric: "custom", custom_unit: "MWh" },
        { point_id: 3, metric: "voltage_v", custom_unit: null },
      ],
    });
  });

  it("a checked custom row without a unit keeps the button disabled and names the row; a unit or unchecking clears it", async () => {
    await open(existing(11));
    await userEvent.selectOptions(screen.getByLabelText("Metric for LVP01 kW"), "custom"); // this point has no unit hint
    const unit = screen.getByLabelText("Unit for LVP01 kW");
    expect(unit).toHaveValue("");
    expect(create()).toBeDisabled();
    expect(screen.getByText(/Enter a unit for each custom metric/)).toHaveTextContent("LVP01 kW");
    await userEvent.type(unit, "   ");
    expect(create()).toBeDisabled(); // spaces are not a unit
    await userEvent.type(unit, "bar");
    expect(create()).toBeEnabled();
    await userEvent.clear(unit);
    expect(create()).toBeDisabled();
    await userEvent.click(box("LVP01 kW")); // an unchecked row needs no unit
    expect(create()).toBeEnabled();
    expect(screen.queryByText(/Enter a unit/)).not.toBeInTheDocument();
  });
```
  (d) In `frontend/src/pages/DiscoveryPage.test.tsx`, test `creating the mappings closes the dialog and shows the refreshed graph` (~line 440): its LVP01 points use the file's default `custom` suggestion with no unit, which the dialog now (correctly) refuses. Give them a hint so the dialog prefills a unit. Replace the `const model = () => { const m = graph(); if (mapped) …` block with:

```tsx
    const model = () => {
      const m = graph();
      // These points map as `custom`; the dialog needs a unit for them and prefills it from the point's hint.
      m.sources[0].clusters[0].points = m.sources[0].clusters[0].points.map((p) => ({ ...p, unit_hint: "degC" }));
      if (mapped) m.sources[0].clusters[0].points = m.sources[0].clusters[0].points.map((p) => ({ ...p, asset_id: 11, mapping_id: p.id + 100, mapped_metric: "voltage_v" as const }));
      return m;
    };
```
  Say in the commit message that this adapts a fixture to the new rule and does not weaken the test (it still asserts the POST body, closing, and the refreshed graph).

- [ ] **E10. Run and see them fail.** `cd frontend && npm test -- src/components/graph/ReviewDialog.test.tsx src/pages/DiscoveryPage.test.tsx`
Expected: FAIL. The three new dialog tests fail (`Unable to find a label with the text of: Unit for …`); `creating the mappings…` still passes at this point (nothing blocks yet).

- [ ] **E11. Implement `frontend/src/components/graph/ReviewDialog.tsx`.**
  (a) Import: in the `../../lib/drop` import add `MAX_UNIT_LENGTH`, `missingUnits` and `withMetric` (keep the others).
  (b) After `const conflicting = new Set(conflictIds);` add:

```tsx
  const unitlessIds = new Set(missingUnits(rows));
```
  (c) Extend the `reason` chain: after the `else if (unusable.length > 0) { … }` block add

```tsx
  else if (unitlessIds.size > 0) {
    reason = `Enter a unit for each custom metric: ${rows.filter((r) => unitlessIds.has(r.pointId)).map((r) => r.name).join(", ")}.`;
  }
```
  (d) Header: replace `<th>Metric</th><th>Scale</th>` with `<th>Metric</th><th>Unit</th><th>Scale</th>`.
  (e) Metric select `onChange`: replace its body (the `const metric …; patchRow(…)` lines and the comment) with

```tsx
                      onChange={(e) => {
                        const metric = e.target.value as Metric;
                        // withMetric drops the old note and the unit unless the metric is custom (prefilled from the point's hint).
                        setRows((current) => current.map((row) => (row.pointId === r.pointId ? withMetric(row, metric) : row)));
                      }}
```
  (f) Insert a new cell between the metric `<td>` and the scale `<td>`:

```tsx
                  <td>
                    {r.metric === "custom" && (
                      <input
                        aria-label={`Unit for ${r.name}`} maxLength={MAX_UNIT_LENGTH} value={r.customUnit ?? ""}
                        aria-invalid={r.checked && unitlessIds.has(r.pointId) ? true : undefined}
                        onChange={(e) => patchRow(r.pointId, { customUnit: e.target.value })}
                      />
                    )}
                  </td>
```
  (g) Run `grep -rn "customUnit:" frontend/src --include=*.ts --include=*.tsx` to find any other literal `ReviewRow` object (only `drop.ts` and tests that spread real rows are expected; add `unitHint: null` to any other literal).

- [ ] **E12. Run.** `cd frontend && npm test -- src/lib/drop.test.ts src/components/graph/ReviewDialog.test.tsx src/pages/DiscoveryPage.test.tsx && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **E13. Commit (custom unit).**

```bash
git add backend/dcdash/api/discovery.py backend/tests/test_api_discovery.py frontend/src/lib/drop.ts frontend/src/lib/drop.test.ts frontend/src/components/graph/ReviewDialog.tsx frontend/src/components/graph/ReviewDialog.test.tsx frontend/src/pages/DiscoveryPage.test.tsx
git commit -m "$(cat <<'EOF'
feat: custom-unit input in the review dialog; accept requires a unit for custom

A row switched to custom gets a Unit field prefilled from the point's unit hint; a checked custom row without a unit
blocks Create mappings. POST /api/discovery/accept (AcceptPoint only) trims the unit, caps it at 20 characters,
requires it for custom and drops it for every other metric. DiscoveryPage.test: the "creating the mappings" fixture
gets a unit hint because its default custom points would now (correctly) be refused; assertions are unchanged.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

#### Part F: scan summary wording and empty states

The claimed count is fixed in ONE place, the frontend helper (it also corrects old stored scans); `_apply_browse` in `collector/scan.py` is not touched, or the count would be subtracted twice. The confirmation text `N hosts × M ports (P probes)` in `ScansPage.tsx` is not touched (`e2e/discovery.spec.ts` asserts it). Outcome labels stay lowercase because the e2e uses the case-sensitive `toContainText("claimed")`.

- [ ] **F1. Helper tests (failing first).** Create `frontend/src/lib/scanText.test.ts`:

```ts
import { claimedCount, outcomeLabel } from "./scanText";

describe("outcomeLabel", () => {
  it("writes outcomes as words; claimed stays as it is (the end-to-end test looks for it)", () => {
    expect(outcomeLabel("claimed")).toBe("claimed");
    expect(outcomeLabel("needs_credentials")).toBe("needs credentials");
    expect(outcomeLabel("unclaimed")).toBe("unidentified");
  });
  it("shows an outcome it does not know with its underscores turned into spaces", () => {
    expect(outcomeLabel("some_new_outcome")).toBe("some new outcome");
  });
});

describe("claimedCount", () => {
  it("leaves out the sources that rejected the credentials", () => {
    expect(claimedCount({ claimed: 5, needs_credentials: 2 })).toBe(3);
  });
  it("treats a missing counter as zero and never goes negative", () => {
    expect(claimedCount({})).toBe(0);
    expect(claimedCount({ claimed: 1 })).toBe(1);
    expect(claimedCount({ claimed: 1, needs_credentials: 3 })).toBe(0);
  });
});
```

- [ ] **F2. Page tests (failing first).** In `frontend/src/pages/ScansPage.test.tsx`:
  (a) Existing test `asks for confirmation with the host and port counts…`: change `expect(within(row).getByText("needs_credentials")).toBeInTheDocument();` to `expect(within(row).getByText("needs credentials")).toBeInTheDocument();` (the outcome now reads as words; the test's intent is unchanged).
  (b) Add inside `describe("ScansPage", …)`, before the nested `describe("confirmation panel …")`:

```tsx
  it("counts only sources that were read as claimed, in the progress line and in the history", async () => {
    mockFetch({ ...base("operator"), "GET /api/scans/7": { body: done } }); // claimed 2, of which 1 needs credentials
    open();
    const history = await screen.findByRole("row", { name: /^lab done/ });
    expect(within(history).getByText("1 / 120")).toBeInTheDocument();
    await userEvent.click(within(history).getByRole("button", { name: "Details" }));
    expect(await screen.findByText("1 claimed")).toBeInTheDocument();
    expect(screen.queryByText("2 claimed")).not.toBeInTheDocument();
  });

  it("writes the finding outcomes as words, never as needs_credentials", async () => {
    const findings = [
      ...done.findings,
      { host: "simulator", port: 8080, source_id: null, connector_type: null, outcome: "unclaimed", detail: "" },
    ];
    mockFetch({ ...base("operator"), "GET /api/scans/7": { body: { ...done, findings } } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    const locked = await screen.findByRole("row", { name: /^simulator 9000 / });
    expect(within(locked).getByText("needs credentials")).toBeInTheDocument();
    expect(within(await screen.findByRole("row", { name: /^simulator 4840 / })).getByText("claimed")).toBeInTheDocument();
    expect(within(await screen.findByRole("row", { name: /^simulator 8080 / })).getByText("unidentified")).toBeInTheDocument();
    expect(screen.queryByText(/needs_credentials|unclaimed/)).not.toBeInTheDocument();
  });

  it("labels the sweep counter as ports checked, not probed", async () => {
    const sweeping = { ...done, status: "running", stage: "sweep", findings: [], progress: { hosts: 1, pairs: 3, checked: 2, open: 1 } };
    mockFetch({ ...base("operator"), "GET /api/scans/7": { body: sweeping } });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(await screen.findByText("2/3 ports checked")).toBeInTheDocument();
    expect(screen.queryByText(/probed/)).not.toBeInTheDocument();
  });

  it("says so when there are no scopes and no scans yet, instead of showing empty tables", async () => {
    mockFetch({ ...base("admin"), "GET /api/scopes": { body: [] }, "GET /api/scans": { body: [] } });
    open();
    expect(await screen.findByText(/No scopes yet/)).toHaveTextContent("New scope");
    expect(await screen.findByText("No scans yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("does not tell an operator with no scopes to use a button they do not have", async () => {
    mockFetch({ ...base("operator"), "GET /api/scopes": { body: [] }, "GET /api/scans": { body: [] } });
    open();
    expect(await screen.findByText("No scopes have been defined yet.")).toBeInTheDocument();
    expect(screen.queryByText(/New scope/)).not.toBeInTheDocument();
  });
```

- [ ] **F3. Run and see them fail.** `cd frontend && npm test -- src/lib/scanText.test.ts src/pages/ScansPage.test.tsx`
Expected: FAIL. `scanText` does not exist yet (module not found); in the page tests the history shows `2 / 120`, the progress line `2 claimed`, the outcome `needs_credentials`, `2/3 probed`, and the empty tables have no text.

- [ ] **F4. Implement.**
  (a) Create `frontend/src/lib/scanText.ts`:

```ts
import type { ScanCounters } from "../api/types";

/** Outcomes as the operator reads them. `claimed` stays as is: the end-to-end test looks for that word. */
const OUTCOME_WORDS: Record<string, string> = {
  claimed: "claimed",
  needs_credentials: "needs credentials",
  unclaimed: "unidentified",
};

export function outcomeLabel(outcome: string): string {
  return OUTCOME_WORDS[outcome] ?? outcome.replace(/_/g, " ");
}

/**
 * Sources the scan identified and could read. `progress.claimed` counts every service a connector claimed, including
 * those that then rejected the credentials (`progress.needs_credentials`), so those are taken out.
 */
export function claimedCount(progress: ScanCounters): number {
  return Math.max(0, (progress.claimed ?? 0) - (progress.needs_credentials ?? 0));
}
```
  (b) `frontend/src/components/ScanProgress.tsx`: add `import { claimedCount, outcomeLabel } from "../lib/scanText";` after the `useScan` import; replace `<span>{progress.checked ?? 0}/{progress.pairs ?? 0} probed</span>` with `<span>{progress.checked ?? 0}/{progress.pairs ?? 0} ports checked</span>`; replace `<span>{progress.claimed ?? 0} claimed</span>` with `<span>{claimedCount(progress)} claimed</span>`; replace `<td>{f.outcome}</td>` with `<td>{outcomeLabel(f.outcome)}</td>`.
  (c) `frontend/src/pages/ScansPage.tsx`: add `import { claimedCount } from "../lib/scanText";` after the `ScopeForm` import. Replace the scopes `<table>…</table>` (the one directly after the `{pending && (…)}` block) with:

```tsx
      {scopes.length === 0 ? (
        <p className="muted">
          {isAdmin ? "No scopes yet. Use New scope to define what to scan." : "No scopes have been defined yet."}
        </p>
      ) : (
        <table>
          <thead><tr><th>Name</th><th>Targets</th><th>Ports</th>{isAdmin && <th></th>}</tr></thead>
          <tbody>
            {scopes.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td><td>{s.targets.join(", ")}</td><td>{s.ports.join(", ")}</td>
                {isAdmin && (
                  <td className="row">
                    <button onClick={() => requestPreview(s)} disabled={busy}>Scan</button>
                    <button onClick={() => edit(s)}>Edit</button>
                    <button onClick={() => remove(s)} disabled={busy}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
```
  and replace the history block `{!scansLoading && !scansError && ( <table>…</table> )}` with:

```tsx
      {!scansLoading && !scansError && scans.length === 0 && <p className="muted">No scans yet.</p>}
      {!scansLoading && !scansError && scans.length > 0 && (
        <table>
          <thead><tr><th>Scope</th><th>Status</th><th>Started</th><th>Claimed / points</th><th></th></tr></thead>
          <tbody>
            {scans.map((scan) => (
              <tr key={scan.id}>
                <td>{scan.scope_name}</td>
                <td>{scan.status}</td>
                <td>{new Date(scan.created_at).toLocaleString()}</td>
                <td>{claimedCount(scan.progress)} / {scan.progress.points ?? 0}</td>
                <td><button onClick={() => setActiveScan(scan.id)}>Details</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
```

- [ ] **F5. Run.** `cd frontend && npm test -- src/lib/scanText.test.ts src/pages/ScansPage.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **F6. Commit (scan wording).**

```bash
git add frontend/src/lib/scanText.ts frontend/src/lib/scanText.test.ts frontend/src/components/ScanProgress.tsx frontend/src/pages/ScansPage.tsx frontend/src/pages/ScansPage.test.tsx
git commit -m "$(cat <<'EOF'
fix: scan summary wording, claimed count and empty states

The claimed count leaves out sources that need credentials (one helper, used by the progress line and the history).
Finding outcomes read as words (needs credentials, unidentified); the sweep counter says "ports checked" instead of
"probed"; empty scope and scan lists say so. The "N hosts x M ports (P probes)" confirmation text is unchanged.
ScansPage.test: the outcome cell now reads "needs credentials".

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

#### Task 0 final verification (shared fixtures and e2e-visible text changed)

- [ ] **G1. Full unit suites.**
`cd backend && uv run pytest` — Expected: all PASS.
`cd frontend && npm test && npm run typecheck` — Expected: all PASS, no type errors.

- [ ] **G2. Isolated end-to-end run** (the review dialog, the scan table and the confirmation text are asserted by `e2e/discovery.spec.ts`). NEVER run `scripts/e2e.sh` or `docker compose down -v` on the default project: it deletes the owner's `dcdash_dbdata` volume. Stop the normal stack first with `docker compose --profile dev stop` (never with `-v`; it keeps the volume; both stacks use ports 80 and 443), then:

```bash
docker compose -p dcdash_e2e --profile dev down -v --remove-orphans
docker compose -p dcdash_e2e --profile dev up -d --build
(cd frontend && npm run e2e)
docker compose -p dcdash_e2e --profile dev down -v
docker volume ls
```

Expected: `journey` and `discovery` projects PASS (`1 hosts × 3 ports (3 probes)`, `claimed` / `existing source` finding cells, the LVP01..LVP10 mapping flow); the final `docker volume ls` still lists `dcdash_dbdata`. If it does not, stop and report; do not recreate it. Leave the normal stack stopped (`stop` keeps its containers and the volume) and say in your report that the owner restarts it: the isolated run re-tagged the shared images, so the owner rebuilds with `docker compose --profile dev up -d --build` when they are ready. Do not start or rebuild it yourself.

- [ ] **G3. Commit any fix the verification forced.** If G1 or G2 required a change, stage exactly those files and commit with the real subject below; if nothing changed there is nothing to commit and the task is done.

```bash
git add <the exact files changed>
git commit -m "$(cat <<'EOF'
fix: <what the full-suite or end-to-end run exposed>

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

---

### Task 1: Schema, models and fixtures for tariffs, dashboards, widgets

The database layer for Phase 3: three tables, the `billing` settings row, both rollup refresh windows widened to 7 days, the ORM models, and the test plumbing (truncation, expected tables, head revision) that later tasks rely on. No API in this task.

**Files:**
- Create: `backend/migrations/versions/0004_billing_dashboards.py`
- Modify: `backend/dcdash/core/models.py` (imports; append `Tariff`, `Dashboard`, `Widget` after `GraphLayout`, before `AuditLog`)
- Modify: `backend/tests/conftest.py` (`TABLES`, the `db` fixture's settings re-insert)
- Modify: `backend/tests/helpers.py` (new `refresh_policies`)
- Modify: `backend/tests/test_schema.py` (`EXPECTED_TABLES`)
- Modify: `backend/tests/test_schema_tiers.py` (head from `ScriptDirectory`; new round-trip test)
- Create: `backend/tests/test_schema_billing.py`

**Interfaces:**
- Consumes (existing): migration `0003` as head; the `autocommit_block` pattern of `0002_storage_tiers.py`; `make_asset`, `make_source` from `tests/helpers.py`; `get_sessionmaker` (`dcdash.core.db`); `Base`, `TZ` (`dcdash.core.models`).
- Produces:
  - Alembic revision `"0004"` (`down_revision = "0003"`), new head.
  - Tables: `tariffs(id, asset_id NULL FK assets ON DELETE CASCADE, rate_per_kwh numeric(13,6) CHECK 0..1000000, effective_from date, created_by FK users ON DELETE SET NULL, created_at timestamptz default now(), UNIQUE NULLS NOT DISTINCT (asset_id, effective_from))`; `dashboards(id, name UNIQUE, range text default '24h' CHECK in the nine presets, created_by FK users SET NULL, created_at, updated_at timestamptz default now())`; `widgets(id, dashboard_id FK CASCADE, type CHECK in timeseries|bar|stat|gauge|table, title text, config jsonb, x,y >= 0, w,h >= 1)`.
  - `settings` row `billing` = `{"currency": null}`.
  - Refresh policies: `readings_1m` start_offset 7 days (end_offset 1 minute, every 1 minute); `readings_1h` start_offset 7 days (end_offset 1 hour, every 10 minutes).
  - ORM (`dcdash.core.models`): `Tariff(id, asset_id: int | None, rate_per_kwh: Decimal, effective_from: date, created_by: int | None, created_at: datetime)`, `Dashboard(id, name: str, range: str, created_by: int | None, created_at, updated_at: datetime)`, `Widget(id, dashboard_id: int, type: str, title: str, config: dict[str, Any], x, y, w, h: int)`.
  - Test helper `refresh_policies(db) -> dict[str, tuple[timedelta, timedelta, timedelta]]` in `tests/helpers.py`: view name to `(start_offset, end_offset, schedule_interval)`.
  - `db` fixture truncates the three new tables and re-inserts the `billing` row next to the `storage` row.

- [ ] **Step 1: Write the failing tests.**

(a) `backend/tests/helpers.py`: append (`timedelta` is already imported at the top of the file):

```python
_REFRESH_POLICIES = """
    SELECT ca.view_name,
           (j.config->>'start_offset')::interval AS start_offset,
           (j.config->>'end_offset')::interval AS end_offset,
           j.schedule_interval
    FROM timescaledb_information.jobs j
    JOIN timescaledb_information.continuous_aggregates ca
      ON j.hypertable_name IN (ca.view_name, ca.materialization_hypertable_name)
    WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
"""


async def refresh_policies(db) -> dict[str, tuple[timedelta, timedelta, timedelta]]:
    """Each continuous aggregate's refresh policy: view name -> (start_offset, end_offset, schedule_interval).

    The offsets are cast to `interval` in SQL, so the test does not depend on how the config JSON spells them.
    """
    return {
        r["view_name"]: (r["start_offset"], r["end_offset"], r["schedule_interval"])
        for r in await db.fetch(_REFRESH_POLICIES)
    }
```

(b) `backend/tests/test_schema.py`: extend `EXPECTED_TABLES` with `"tariffs", "dashboards", "widgets"` (a new last line inside the set: `"tariffs", "dashboards", "widgets",`).

(c) `backend/tests/test_schema_tiers.py`: replace the import block and the last test, and add the round-trip test. New imports at the top:

```python
from datetime import datetime, timedelta, timezone

from tests.helpers import insert_readings, make_point, make_source, refresh_policies
```

Add above `_alembic`:

```python
def _head() -> str:
    """The newest Alembic revision on disk, so adding a migration does not break this file."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    from tests.conftest import BACKEND

    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "migrations"))  # the ini's path is relative to the cwd
    return ScriptDirectory.from_config(config).get_current_head()
```

Replace the final two lines of `test_downgrade_with_compressed_chunks_then_upgrade` (the `== "0003"` assertion and the count assertion) with:

```python
    assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()
    assert await db.fetchval("SELECT count(*) FROM timescaledb_information.continuous_aggregates") == 2
    assert (await refresh_policies(db))["readings_1m"][0] == timedelta(days=7)  # 0002 was re-run, then 0004 widened it
```

Append:

```python
async def test_downgrade_to_0003_restores_the_old_windows_and_drops_the_billing_schema(db):
    try:
        _alembic("downgrade", "0003")
        assert await db.fetchval("SELECT version_num FROM alembic_version") == "0003"
        left = await db.fetch(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
            ["tariffs", "dashboards", "widgets"],
        )
        assert left == []
        assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'billing'") == 0
        policies = await refresh_policies(db)
        assert policies["readings_1m"] == (timedelta(hours=3), timedelta(minutes=1), timedelta(minutes=1))
        assert policies["readings_1h"] == (timedelta(days=2), timedelta(hours=1), timedelta(minutes=10))
    finally:
        _alembic("upgrade", "head")
    assert await db.fetchval("SELECT version_num FROM alembic_version") == _head()
    assert await db.fetchval("SELECT value FROM settings WHERE key = 'billing'") == {"currency": None}
    assert (await refresh_policies(db))["readings_1h"][0] == timedelta(days=7)
```

(d) Create `backend/tests/test_schema_billing.py`:

```python
from datetime import date, datetime, timedelta
from decimal import Decimal

import asyncpg
import pytest
from sqlalchemy import select

from dcdash.core.db import get_sessionmaker
from dcdash.core.models import Dashboard, Tariff, Widget
from tests.helpers import make_asset, refresh_policies

PRESETS = ["1h", "6h", "24h", "7d", "30d", "today", "yesterday", "this_month", "last_month"]
WIDGET_TYPES = ["timeseries", "bar", "stat", "gauge", "table"]
DAY = date(2026, 10, 1)


async def add_tariff(db, asset_id, day=DAY, rate="0.12") -> int:
    return await db.fetchval(
        "INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES ($1, $2, $3) RETURNING id",
        asset_id, Decimal(rate), day,
    )


async def add_dashboard(db, name="Ops", range_=None) -> int:
    if range_ is None:
        return await db.fetchval("INSERT INTO dashboards (name) VALUES ($1) RETURNING id", name)
    return await db.fetchval("INSERT INTO dashboards (name, range) VALUES ($1, $2) RETURNING id", name, range_)


async def add_widget(db, dashboard_id, type_="stat", x=0, y=0, w=3, h=2) -> int:
    return await db.fetchval(
        "INSERT INTO widgets (dashboard_id, type, title, config, x, y, w, h) VALUES ($1, $2, 'T', $3, $4, $5, $6, $7) RETURNING id",
        dashboard_id, type_, {"assets": [1], "source": "metric"}, x, y, w, h,
    )


# ---- tariffs ----

async def test_a_negative_rate_is_rejected_and_zero_is_allowed(db):
    asset = await make_asset(db, "Panel")
    with pytest.raises(asyncpg.CheckViolationError):
        await add_tariff(db, asset, rate="-0.01")
    await add_tariff(db, asset, rate="0")


async def test_the_rate_ceiling_is_one_million_inclusive(db):
    asset = await make_asset(db, "Panel")
    await add_tariff(db, asset, DAY, "1000000")  # the contract rejects only rates ABOVE 1000000
    with pytest.raises(asyncpg.CheckViolationError):
        await add_tariff(db, asset, date(2026, 10, 2), "1000000.000001")


async def test_one_rate_per_asset_and_day(db):
    a, b = await make_asset(db, "A"), await make_asset(db, "B")
    await add_tariff(db, a, DAY)
    with pytest.raises(asyncpg.UniqueViolationError):
        await add_tariff(db, a, DAY, "0.50")
    await add_tariff(db, a, date(2026, 10, 2))  # same asset, another day
    await add_tariff(db, b, DAY)                # same day, another asset


async def test_two_site_defaults_for_the_same_day_are_rejected(db):
    await add_tariff(db, None, DAY)
    with pytest.raises(asyncpg.UniqueViolationError):  # NULLS NOT DISTINCT: NULL asset counts as one
        await add_tariff(db, None, DAY, "0.50")
    await add_tariff(db, None, date(2026, 10, 2))


async def test_the_site_default_and_an_override_coexist_on_one_date(db):
    asset = await make_asset(db, "Panel")
    await add_tariff(db, None, DAY)
    await add_tariff(db, asset, DAY, "0.20")
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 2


async def test_deleting_an_asset_deletes_its_tariffs_but_not_the_site_default(db):
    asset, other = await make_asset(db, "Panel"), await make_asset(db, "Other")
    site_default = await add_tariff(db, None, DAY)
    await add_tariff(db, asset, DAY)  # goes with the asset
    kept = await add_tariff(db, other, DAY)
    await db.execute("DELETE FROM assets WHERE id = $1", asset)
    assert sorted(r["id"] for r in await db.fetch("SELECT id FROM tariffs")) == sorted([site_default, kept])


async def test_deleting_a_user_keeps_their_tariffs_and_dashboards(db):
    user = await db.fetchval("INSERT INTO users (username, password_hash, role) VALUES ('u', 'x', 'admin') RETURNING id")
    tariff = await add_tariff(db, None, DAY)
    dashboard = await add_dashboard(db)
    await db.execute("UPDATE tariffs SET created_by = $1 WHERE id = $2", user, tariff)
    await db.execute("UPDATE dashboards SET created_by = $1 WHERE id = $2", user, dashboard)
    await db.execute("DELETE FROM users WHERE id = $1", user)
    assert await db.fetchval("SELECT created_by FROM tariffs WHERE id = $1", tariff) is None
    assert await db.fetchval("SELECT created_by FROM dashboards WHERE id = $1", dashboard) is None


# ---- dashboards and widgets ----

async def test_a_dashboard_defaults_to_24h_and_its_name_is_unique(db):
    dashboard = await add_dashboard(db, "Ops")
    row = await db.fetchrow("SELECT range, created_at, updated_at FROM dashboards WHERE id = $1", dashboard)
    assert row["range"] == "24h" and row["created_at"].tzinfo is not None and row["updated_at"].tzinfo is not None
    with pytest.raises(asyncpg.UniqueViolationError):
        await add_dashboard(db, "Ops")


@pytest.mark.parametrize("preset", PRESETS)
async def test_every_range_preset_is_accepted(db, preset):
    await add_dashboard(db, f"d-{preset}", preset)


@pytest.mark.parametrize("bad", ["2d", "", "Today", "custom", "12h"])
async def test_a_range_that_is_not_a_preset_is_rejected(db, bad):
    with pytest.raises(asyncpg.CheckViolationError):
        await add_dashboard(db, "x", bad)


@pytest.mark.parametrize("type_", WIDGET_TYPES)
async def test_every_widget_type_is_accepted(db, type_):
    await add_widget(db, await add_dashboard(db), type_)


@pytest.mark.parametrize("bad", ["pie", "", "Stat", "line"])
async def test_a_widget_type_outside_the_five_is_rejected(db, bad):
    dashboard = await add_dashboard(db)
    with pytest.raises(asyncpg.CheckViolationError):
        await add_widget(db, dashboard, bad)


@pytest.mark.parametrize("geometry", [{"x": -1}, {"y": -1}, {"w": 0}, {"h": 0}])
async def test_widget_geometry_must_be_on_the_grid(db, geometry):
    dashboard = await add_dashboard(db)
    with pytest.raises(asyncpg.CheckViolationError):
        await add_widget(db, dashboard, **geometry)


async def test_a_widget_needs_an_existing_dashboard(db):
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await add_widget(db, 999)


async def test_deleting_a_dashboard_deletes_its_widgets_only(db):
    first, second = await add_dashboard(db, "First"), await add_dashboard(db, "Second")
    await add_widget(db, first)
    await add_widget(db, first, "bar")
    kept = await add_widget(db, second)
    await db.execute("DELETE FROM dashboards WHERE id = $1", first)
    assert [r["id"] for r in await db.fetch("SELECT id FROM widgets")] == [kept]


# ---- refresh windows ----

async def test_both_refresh_policies_look_back_seven_days_and_keep_their_other_settings(db):
    policies = await refresh_policies(db)
    assert set(policies) == {"readings_1m", "readings_1h"}
    # (start_offset, end_offset, schedule_interval): only the start offset changed from 0002 (3 hours / 2 days)
    assert policies["readings_1m"] == (timedelta(days=7), timedelta(minutes=1), timedelta(minutes=1))
    assert policies["readings_1h"] == (timedelta(days=7), timedelta(hours=1), timedelta(minutes=10))


# ---- ORM ----

async def test_orm_round_trip_applies_defaults(db):
    async with get_sessionmaker()() as session:
        dashboard = Dashboard(name="Ops")
        session.add(dashboard)
        await session.flush()
        session.add(Widget(dashboard_id=dashboard.id, type="stat", title="Power", config={"assets": [1], "source": "metric"}, x=0, y=0, w=3, h=2))
        session.add(Tariff(asset_id=None, rate_per_kwh=Decimal("0.125"), effective_from=date(2026, 10, 1)))
        await session.commit()
    async with get_sessionmaker()() as session:
        dashboard = (await session.execute(select(Dashboard))).scalar_one()
        widget = (await session.execute(select(Widget))).scalar_one()
        tariff = (await session.execute(select(Tariff))).scalar_one()
    assert dashboard.range == "24h" and dashboard.created_at.tzinfo is not None and dashboard.updated_at.tzinfo is not None
    assert widget.dashboard_id == dashboard.id and widget.title == "Power" and widget.config == {"assets": [1], "source": "metric"}
    assert (widget.x, widget.y, widget.w, widget.h) == (0, 0, 3, 2)
    assert tariff.asset_id is None and tariff.rate_per_kwh == Decimal("0.125") and tariff.effective_from == date(2026, 10, 1)
    assert isinstance(tariff.created_at, datetime) and tariff.created_at.tzinfo is not None and tariff.created_by is None
```

- [ ] **Step 2: Run and see them fail.**
`cd backend && uv run pytest tests/test_schema_billing.py tests/test_schema.py tests/test_schema_tiers.py -v`
Expected: FAIL. `test_schema_billing.py` fails at import (`cannot import name 'Dashboard' from 'dcdash.core.models'`); `test_schema_has_all_tables` fails because `tariffs`, `dashboards` and `widgets` do not exist; the tiers tests fail on the missing tables/head.

- [ ] **Step 3: Write the migration.** Create `backend/migrations/versions/0004_billing_dashboards.py`. The policy functions are plain SQL calls and, unlike `CREATE MATERIALIZED VIEW` in 0002, run inside the migration transaction, so the whole migration stays atomic (no `autocommit_block`).

```python
"""billing and dashboards: tariffs, dashboards, widgets, settings.billing, 7-day rollup refresh windows

Revision ID: 0004
Revises: 0003
"""
from alembic import op

revision = "0004"
down_revision = "0003"


def _refresh_policy(view: str, start: str, end: str, every: str) -> list[str]:
    """Replace a continuous aggregate's refresh policy; only the start offset differs between up and down."""
    return [
        f"SELECT remove_continuous_aggregate_policy('{view}', if_exists => true)",
        f"""
        SELECT add_continuous_aggregate_policy('{view}',
            start_offset => INTERVAL '{start}', end_offset => INTERVAL '{end}',
            schedule_interval => INTERVAL '{every}')
        """,
    ]


# 0002 created these with start offsets of 3 hours (readings_1m) and 2 days (readings_1h). Both are widened to 7 days
# so readings the collector writes late after an outage still reach the rollups (spec section 6); readings_1h is
# built on readings_1m, so widening only one would not help.
WIDEN = [
    *_refresh_policy("readings_1m", "7 days", "1 minute", "1 minute"),
    *_refresh_policy("readings_1h", "7 days", "1 hour", "10 minutes"),
]
RESTORE = [
    *_refresh_policy("readings_1m", "3 hours", "1 minute", "1 minute"),
    *_refresh_policy("readings_1h", "2 days", "1 hour", "10 minutes"),
]

UP = [
    # numeric(13,6), not (12,6): the contract allows a rate of exactly 1000000, which (12,6) cannot hold.
    # More than 6 decimals is refused by the API; Postgres would round a 7th decimal silently.
    """
    CREATE TABLE tariffs (
        id SERIAL PRIMARY KEY,
        asset_id INTEGER REFERENCES assets(id) ON DELETE CASCADE,
        rate_per_kwh NUMERIC(13, 6) NOT NULL CHECK (rate_per_kwh >= 0 AND rate_per_kwh <= 1000000),
        effective_from DATE NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT tariffs_asset_effective_key UNIQUE NULLS NOT DISTINCT (asset_id, effective_from)
    )
    """,
    """
    CREATE TABLE dashboards (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        range TEXT NOT NULL DEFAULT '24h'
            CHECK (range IN ('1h', '6h', '24h', '7d', '30d', 'today', 'yesterday', 'this_month', 'last_month')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE widgets (
        id SERIAL PRIMARY KEY,
        dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('timeseries', 'bar', 'stat', 'gauge', 'table')),
        title TEXT NOT NULL DEFAULT '',
        config JSONB NOT NULL,
        x INTEGER NOT NULL CHECK (x >= 0),
        y INTEGER NOT NULL CHECK (y >= 0),
        w INTEGER NOT NULL CHECK (w >= 1),
        h INTEGER NOT NULL CHECK (h >= 1)
    )
    """,
    "CREATE INDEX widgets_dashboard_idx ON widgets (dashboard_id)",
    """INSERT INTO settings (key, value) VALUES ('billing', '{"currency": null}'::jsonb) ON CONFLICT (key) DO NOTHING""",
    *WIDEN,
]

DOWN = [
    *RESTORE,
    "DROP TABLE widgets",
    "DROP TABLE dashboards",
    "DROP TABLE tariffs",
    "DELETE FROM settings WHERE key = 'billing'",
]


def upgrade() -> None:
    for statement in UP:
        op.execute(statement)


def downgrade() -> None:
    for statement in DOWN:
        op.execute(statement)
```

If TimescaleDB refuses a policy call inside the transaction (`cannot run inside a transaction block`), do not change anything else: move only the `WIDEN` / `RESTORE` statements into `with op.get_context().autocommit_block():` after the transactional ones, exactly as `0002_storage_tiers.py` does for its non-transactional list.

- [ ] **Step 4: Add the ORM models.** In `backend/dcdash/core/models.py` change the imports to

```python
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Numeric, func
```

and insert before `class AuditLog`:

```python
class Tariff(Base):
    __tablename__ = "tariffs"
    id: Mapped[int] = mapped_column(primary_key=True)
    asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id", ondelete="CASCADE"))  # None = the site default
    rate_per_kwh: Mapped[Decimal] = mapped_column(Numeric(13, 6))
    effective_from: Mapped[date]
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())


class Dashboard(Base):
    __tablename__ = "dashboards"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]
    range: Mapped[str] = mapped_column(default="24h", server_default="24h")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TZ, server_default=func.now())


class Widget(Base):
    __tablename__ = "widgets"
    id: Mapped[int] = mapped_column(primary_key=True)
    dashboard_id: Mapped[int] = mapped_column(ForeignKey("dashboards.id", ondelete="CASCADE"))
    type: Mapped[str]
    title: Mapped[str] = mapped_column(default="", server_default="")
    config: Mapped[dict[str, Any]] = mapped_column(JSONB)
    x: Mapped[int]
    y: Mapped[int]
    w: Mapped[int]
    h: Mapped[int]
```

- [ ] **Step 5: Update the shared fixture.** In `backend/tests/conftest.py` replace the `TABLES` constant with

```python
TABLES = (
    "audit_log, widgets, dashboards, tariffs, scan_findings, scans, scan_scopes, graph_layout, jobs, point_latest, "
    "readings, mappings, points, assets, sources, sessions, users, settings"
)
```

and in the `db` fixture, directly after the existing `storage` insert (before `return pool`), add:

```python
    await pool.execute(
        """INSERT INTO settings (key, value) VALUES ('billing', '{"currency": null}'::jsonb)
           ON CONFLICT (key) DO NOTHING"""
    )
```

(The fixture truncates `settings`, which would otherwise drop the row the migration seeded.)

- [ ] **Step 6: Run and see them pass.**
`cd backend && uv run pytest tests/test_schema_billing.py tests/test_schema.py tests/test_schema_tiers.py -v`
Expected: all PASS, including `test_downgrade_with_compressed_chunks_then_upgrade` (downgrade 0004 to 0001 and back to head) and `test_downgrade_to_0003_restores_the_old_windows_and_drops_the_billing_schema`. If `refresh_policies` returns an empty dict (the jobs view names the policy's hypertable differently), print `SELECT job_id, proc_name, hypertable_name, config FROM timescaledb_information.jobs` once and adjust only the `ON` clause of `_REFRESH_POLICIES` in `tests/helpers.py`; the assertions stay as written.

- [ ] **Step 7: Prove the policy and constraint tests can fail (mutation check, then restore).** Temporarily change the `readings_1h` WIDEN line to `"2 days"`; run `cd backend && uv run pytest tests/test_schema_billing.py::test_both_refresh_policies_look_back_seven_days_and_keep_their_other_settings -v` on a fresh test database (the fixture migrates at session start). Expected: FAIL (`readings_1h` start offset is 2 days). Restore `"7 days"`. Likewise change `CHECK (w >= 1)` to `CHECK (w >= 0)`: `test_widget_geometry_must_be_on_the_grid[geometry2]` must FAIL (`DID NOT RAISE`); restore.

- [ ] **Step 8: Full backend suite.** `cd backend && uv run pytest`
Expected: all PASS (the `db` fixture, `TABLES` and the head are shared by every test file; nothing else should have moved).

- [ ] **Step 9: Commit.**

```bash
git add backend/migrations/versions/0004_billing_dashboards.py backend/dcdash/core/models.py backend/tests/conftest.py backend/tests/helpers.py backend/tests/test_schema.py backend/tests/test_schema_tiers.py backend/tests/test_schema_billing.py
git commit -m "$(cat <<'EOF'
feat: schema for tariffs, dashboards and widgets; 7-day rollup refresh windows

Migration 0004: tariffs (site default = NULL asset, NULLS NOT DISTINCT unique), dashboards, widgets, the settings.billing
row, and both continuous-aggregate refresh policies widened to a 7-day start_offset (other settings unchanged).
rate_per_kwh is numeric(13,6): numeric(12,6) cannot hold the allowed maximum of 1000000. ORM models Tariff, Dashboard,
Widget. Test plumbing: new tables truncated per test and the billing row re-inserted, EXPECTED_TABLES extended, and
test_schema_tiers reads the head from Alembic's ScriptDirectory instead of hard-coding it.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

### Task 2: The energy engine on the hourly rollup

One engine, `core/energy.py`, reads `readings_1h` in a single batched query, computes hourly kWh in pure Python (counter deltas with in-hour reset recovery, power-only estimates) and rolls it up a new `AssetTree`. `core/timeutil.py` holds the site-timezone helpers. `api/data.py` is moved onto the engine and its raw energy SQL is deleted. Spec section 6 (Tiers, Energy, Time) is the authority; Review Focus 1 and the energy half of Review Focus 2 are tested here.

**Files:**
- Create: `backend/dcdash/core/tree.py`
- Create: `backend/dcdash/core/timeutil.py`
- Rewrite: `backend/dcdash/core/energy.py` (the `Energy` dataclass stays; `Sample`, `from_counter`, `from_power`, `consumption` are removed)
- Modify: `backend/dcdash/api/data.py` (four edits: `_COUNTER_KWH`, `_POWER_KWH`, `_own_energy`, `asset_energy` and the `day_start` definition leave it; `day_start` stays importable from it; `summary` uses the engine)
- Modify: `backend/tests/helpers.py` (append `settle_rollups`)
- Modify: `backend/tests/test_api_data.py` (four numbers change, two tests and a fixed-clock helper are added, `add_readings` settles the rollups)
- Delete: `backend/tests/test_energy.py` (it tested the removed pure functions)
- Create: `backend/tests/test_tree.py`, `backend/tests/test_timeutil.py`, `backend/tests/test_energy_hours.py`, `backend/tests/test_energy_engine.py`

**Interfaces:**
- Consumes (existing, verified): `current_timezone(db)` in `dcdash/api/settings.py`; `Asset`, `Mapping`, `PointLatest` in `dcdash/core/models.py`; `Metric`, `unit_for` in `dcdash/core/metrics.py`; `get_sessionmaker()`, `get_engine()` in `dcdash/core/db.py`; test helpers `make_source`, `make_point`, `make_asset`, `make_mapping`, `insert_readings(db, point_id, start, step_seconds, values)`, `login_as` in `backend/tests/helpers.py`; the `db` fixture (an asyncpg pool; it truncates the tables and refreshes both rollups empty) and the `client` fixture in `backend/tests/conftest.py`. The rollup columns are exactly `point_id, bucket, min_value, max_value, sum_value, n, last_value` (migration `0002_storage_tiers.py`); both views are real-time, so hours not yet materialized are still visible; there is no first-value column. `n` comes back from asyncpg as `Decimal` (it is `sum(count)`), so the engine converts it with `int()`. A unique index `mappings_asset_metric` allows at most one `energy_kwh` and one `active_power_kw` mapping per asset.
- Produces, exactly as the Interface Contracts:
  - `dcdash/core/tree.py`: `AssetNode(id, parent_id, name, sort_order)`; `AssetTree` with `nodes`, `async load(db)`, `children(asset_id)`, `ancestors_or_self(asset_id)`, `path(asset_id)`, `preorder()`. Also `AssetTree(nodes)` builds a tree from an iterable of `AssetNode` or a `dict[int, AssetNode]` (pure tests in later tasks can use it). `children()` of an unknown id is `[]`; `path()` and `ancestors_or_self()` of an unknown id raise `KeyError`.
  - `dcdash/core/timeutil.py`: `RANGE_PRESETS`, `ROLLING`, `validate_whole_hour_zone`, `day_start`, `month_start`, `month_bounds`, `resolve_range`, `local_days`. Extra: `day_bounds(now, tz_name) -> tuple[datetime, datetime]` = `[local midnight of now's day, next local midnight)`. Every datetime returned is UTC (see the CONTRACT ISSUE line).
  - `dcdash/core/energy.py`: `Energy`, `HourRow`, `HourEnergy`, `EnergyResult`, `counter_hours`, `power_hours`, `hourly_energy`, `total`. Extra, pure and reusable: `Meter(point_id, scale, interval_seconds, counter)`, `assemble(tree, meters, rows, baselines) -> EnergyResult` (the roll-up without a database), `async load_meters(db, tree) -> dict[int, Meter]`.
  - `GET /api/assets/{id}/summary`: same keys and shapes as before; `energy_today` now comes from the engine. `summary()` reads the clock through the module function `_now()` (production: `datetime.now(timezone.utc)`; tests monkeypatch `dcdash.api.data._now`) and ends with `start, end = day_bounds(_now(), await current_timezone(db))`, `result = await hourly_energy(db, await AssetTree.load(db), start, end)` and `energy = total(result.hours.get(asset_id))`; Task 4 adds `cost_today` from the same `result`.
  - `backend/tests/helpers.py::settle_rollups(db)`: materializes both rollups now, so a test never depends on where the policy jobs left the real-time watermark. Use it after inserting readings in any test that reads `readings_1h`.

**Decisions (check against the spec):**
- A counter beats power on one asset. A mapped counter that recorded nothing is `{}` (zero); it never falls back to power or to children.
- `hourly_energy` includes a bucket whose start is in `[start, end)`; `start` must be a whole UTC hour, `end` may be any instant; both must be timezone-aware (`ValueError`).
- A counter's baseline is the last bucket before `start`, however old: one `LATERAL ... ORDER BY bucket DESC LIMIT 1` per point inside the same statement as the range rows. Two statements per call (mappings, rollup rows), whatever the number of assets.
- `estimated` is per hour; a parent's hour is estimated if any child contributing to it is; `total()` is estimated if any hour is.
- `summary` uses the site's local day. A fractional-offset zone stored before phase 3 shifts the edges to the next rollup bucket instead of failing the page (billing and widget data answer 409 in later tasks).
- Known limit of the spec's reset rule, not changed here: if the counter climbs past the old `previous_last` within the same hour after a reset, `max - previous_last` over-counts (previous_last 2, readings 3, 0, 50 gives 98, true figure about 51). Only meters near zero can hit it.
- Removed `test_energy.py` cases live on as `test_energy_hours.py` (last-minus-previous, reset, gap, power outage, `total`, no figure is `None`) and `test_energy_engine.py::test_a_counter_beats_active_power_on_the_same_asset`.
- Review Focus 1: the reset, gap, rollover, outage and silent-meter tests in `test_energy_hours.py` (pure) and `test_energy_engine.py` (rollup). Review Focus 2, this task's share: the 23/25-hour day, month, rolling-range, preset and zone tests in `test_timeutil.py` and `test_a_dst_month_splits_into_local_days_that_add_up_to_the_month` on real rollup rows; Task 4 adds the billing side.

- [ ] **Step 1: Confirm who uses what you are about to remove**

Run: `cd backend && grep -rn "day_start\|asset_energy\|_own_energy\|_COUNTER_KWH\|_POWER_KWH\|from_counter\|from_power\|consumption(\|core.energy" --include=*.py dcdash tests`
Expected: hits only in `dcdash/api/data.py`, `dcdash/core/energy.py`, `tests/test_api_data.py` and `tests/test_energy.py`. If any other file appears, move it onto the engine in this task and say so in the commit message.

- [ ] **Step 2: Write the failing tests for `AssetTree` and `timeutil`**

`backend/tests/test_tree.py`:

```python
"""Pure tests of AssetTree: no database."""
import pytest

from dcdash.core.tree import AssetNode, AssetTree

# Site(1) -> MV2(2) -> LV Panel 1(3), LV Panel 2(4);  Site -> Generator(5, sort_order -1)
NODES = [
    AssetNode(1, None, "Site", 0),
    AssetNode(2, 1, "MV2", 0),
    AssetNode(3, 2, "LV Panel 2", 0),
    AssetNode(4, 2, "LV Panel 1", 0),
    AssetNode(5, 1, "Generator", -1),
]


def test_children_are_ordered_by_sort_order_then_name_then_id():
    tree = AssetTree(NODES)
    assert tree.children(1) == [5, 2]  # sort_order -1 first
    assert tree.children(2) == [4, 3]  # same sort_order: "LV Panel 1" before "LV Panel 2"
    assert tree.children(3) == [] and tree.children(99) == []
    twins = AssetTree([AssetNode(1, None, "Root", 0), AssetNode(9, 1, "Same", 0), AssetNode(4, 1, "Same", 0)])
    assert twins.children(1) == [4, 9]  # same sort_order and name: by id


def test_ancestors_run_from_the_asset_up_to_the_root_and_paths_from_the_root_down():
    tree = AssetTree(NODES)
    assert tree.ancestors_or_self(4) == [4, 2, 1]
    assert tree.ancestors_or_self(1) == [1]
    assert tree.path(4) == "Site / MV2 / LV Panel 1"
    assert tree.path(1) == "Site"


def test_preorder_lists_parents_before_children_and_siblings_in_children_order():
    assert AssetTree(NODES).preorder() == [1, 5, 2, 4, 3]


def test_the_tree_can_be_built_from_a_dict_and_exposes_its_nodes():
    tree = AssetTree({node.id: node for node in NODES})
    assert set(tree.nodes) == {1, 2, 3, 4, 5} and tree.nodes[2].name == "MV2"


def test_a_node_whose_parent_is_missing_is_a_root():
    tree = AssetTree([AssetNode(2, 77, "Orphan", 0), AssetNode(3, 2, "Child", 0)])
    assert tree.preorder() == [2, 3]
    assert tree.path(3) == "Orphan / Child"


def test_an_unknown_asset_is_a_key_error_for_paths():
    tree = AssetTree(NODES)
    with pytest.raises(KeyError):
        tree.path(99)
    with pytest.raises(KeyError):
        tree.ancestors_or_self(99)


def test_a_parent_cycle_does_not_hang_and_keeps_every_asset_addressable():
    tree = AssetTree([AssetNode(1, 2, "A", 0), AssetNode(2, 1, "B", 0)])
    assert sorted(tree.preorder()) == [1, 2]
    assert tree.ancestors_or_self(1) == [1, 2]
    assert tree.path(1) == "B / A"
```

`backend/tests/test_timeutil.py`:

```python
"""Pure tests of the time helpers: no database.

Review Focus 2 (spec section 6, Time): daylight-saving days and month edges must split hours exactly, so day
totals add up to the month total and no hour is dropped or counted twice.
"""
from calendar import monthrange
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from dcdash.core.timeutil import (
    RANGE_PRESETS,
    ROLLING,
    day_bounds,
    day_start,
    local_days,
    month_bounds,
    month_start,
    resolve_range,
    validate_whole_hour_zone,
)

UTC = timezone.utc
HOUR = timedelta(hours=1)


def utc(year, month, day, hour=0, minute=0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


# ---- validate_whole_hour_zone ---------------------------------------------------------------


@pytest.mark.parametrize("zone", ["Asia/Qatar", "Europe/Berlin", "America/New_York", "UTC", "Asia/Dubai"])
def test_whole_hour_zones_are_accepted(zone):
    validate_whole_hour_zone(zone)  # does not raise


@pytest.mark.parametrize(
    "zone",
    [
        "Asia/Kolkata",  # +05:30 all year
        "Asia/Kathmandu",  # +05:45
        "America/St_Johns",  # -03:30 / -02:30
        "Australia/Lord_Howe",  # +11:00 in January but +10:30 in July: a half-hour DST shift
    ],
)
def test_zones_with_a_fractional_offset_in_january_or_july_are_refused(zone):
    with pytest.raises(ValueError, match="whole number of hours"):
        validate_whole_hour_zone(zone)


@pytest.mark.parametrize("zone", ["Not/AZone", "", "../etc/passwd", "America"])
def test_an_unknown_or_malformed_zone_is_refused(zone):
    with pytest.raises(ValueError, match="unknown timezone"):
        validate_whole_hour_zone(zone)


# ---- day_start, day_bounds, month_start ------------------------------------------------------


def test_day_start_is_local_midnight_as_an_aware_datetime():
    now = utc(2026, 10, 6, 22, 30)  # 01:30 on the 7th in Qatar
    assert day_start(now, "Asia/Qatar") == utc(2026, 10, 6, 21)
    assert day_start(now, "UTC") == utc(2026, 10, 6)
    assert day_start(now, "Asia/Qatar").tzinfo is timezone.utc  # UTC, so subtracting two of them is elapsed time


def test_naive_datetimes_are_refused():
    with pytest.raises(ValueError, match="timezone"):
        day_start(datetime(2026, 10, 6, 12), "UTC")
    with pytest.raises(ValueError, match="timezone"):
        resolve_range("24h", datetime(2026, 10, 6, 12), "UTC")


@pytest.mark.parametrize(
    "zone, day, hours",
    [
        ("Europe/Berlin", date(2026, 3, 29), 23),  # clocks go forward
        ("Europe/Berlin", date(2026, 10, 25), 25),  # clocks go back
        ("Europe/Berlin", date(2026, 6, 10), 24),
        ("America/New_York", date(2026, 3, 8), 23),
        ("America/New_York", date(2026, 11, 1), 25),
        ("Asia/Qatar", date(2026, 3, 29), 24),  # no daylight saving
    ],
)
def test_a_local_day_is_23_24_or_25_hours_long(zone, day, hours):
    # Review Focus 2.
    noon = datetime(day.year, day.month, day.day, 12, tzinfo=ZoneInfo(zone))
    start, end = day_bounds(noon, zone)
    assert (end - start) == hours * HOUR
    assert start == day_start(noon, zone)
    assert start.astimezone(ZoneInfo(zone)).time().isoformat() == "00:00:00"
    assert end.astimezone(ZoneInfo(zone)).time().isoformat() == "00:00:00"


def test_berlin_day_edges_in_utc():
    # Review Focus 2. Midnight is 00:00 CET (23:00Z) before the change and 00:00 CEST (22:00Z) after it.
    assert day_bounds(utc(2026, 3, 29, 12), "Europe/Berlin") == (utc(2026, 3, 28, 23), utc(2026, 3, 29, 22))
    assert day_bounds(utc(2026, 10, 25, 12), "Europe/Berlin") == (utc(2026, 10, 24, 22), utc(2026, 10, 25, 23))


def test_month_start_follows_the_site_timezone():
    # 00:30 on 1 April in Berlin is still 31 March in UTC.
    now = utc(2026, 3, 31, 22, 30)
    assert month_start(now, "Europe/Berlin") == utc(2026, 3, 31, 22)
    assert month_start(now, "UTC") == utc(2026, 3, 1)


# ---- month_bounds ---------------------------------------------------------------------------


def test_month_bounds_in_a_zone_with_daylight_saving():
    # Review Focus 2.
    start, end = month_bounds("2026-03", "Europe/Berlin")
    assert (start, end) == (utc(2026, 2, 28, 23), utc(2026, 3, 31, 22))
    assert (end - start) == (31 * 24 - 1) * HOUR  # one hour short: the clocks went forward
    start, end = month_bounds("2026-10", "Europe/Berlin")
    assert (start, end) == (utc(2026, 9, 30, 22), utc(2026, 10, 31, 23))
    assert (end - start) == (31 * 24 + 1) * HOUR


def test_month_bounds_wrap_the_year_and_use_the_zone():
    assert month_bounds("2026-12", "UTC") == (utc(2026, 12, 1), utc(2027, 1, 1))
    assert month_bounds("2026-02", "Asia/Qatar") == (utc(2026, 1, 31, 21), utc(2026, 2, 28, 21))


@pytest.mark.parametrize(
    "bad", ["", "2026", "2026-1", "2026-13", "2026-00", "26-01", "2026-10-01", "abcd-ef", "1969-12", "2101-01"]
)
def test_a_bad_month_is_refused(bad):
    with pytest.raises(ValueError, match="YYYY-MM"):
        month_bounds(bad, "UTC")


# ---- resolve_range ---------------------------------------------------------------------------

# 15:30 on Thursday 8 October 2026 in Qatar (UTC+3, no daylight saving)
NOW = utc(2026, 10, 8, 12, 30)


def test_the_presets_are_the_nine_in_order_and_five_are_rolling():
    assert RANGE_PRESETS == ("1h", "6h", "24h", "7d", "30d", "today", "yesterday", "this_month", "last_month")
    assert ROLLING == frozenset({"1h", "6h", "24h", "7d", "30d"})


@pytest.mark.parametrize(
    "preset, start, end",
    [
        ("1h", utc(2026, 10, 8, 11, 30), NOW),
        ("6h", utc(2026, 10, 8, 6, 30), NOW),
        ("24h", utc(2026, 10, 7, 12, 30), NOW),
        ("7d", utc(2026, 10, 1, 12, 30), NOW),
        ("30d", utc(2026, 9, 8, 12, 30), NOW),
        ("today", utc(2026, 10, 7, 21), NOW),
        ("yesterday", utc(2026, 10, 6, 21), utc(2026, 10, 7, 21)),
        ("this_month", utc(2026, 9, 30, 21), NOW),
        ("last_month", utc(2026, 8, 31, 21), utc(2026, 9, 30, 21)),
    ],
)
def test_every_preset_resolves_in_the_site_timezone(preset, start, end):
    assert resolve_range(preset, NOW, "Asia/Qatar") == (start, end)


def test_every_preset_is_a_non_empty_range_that_ends_by_now():
    for preset in RANGE_PRESETS:
        start, end = resolve_range(preset, NOW, "Europe/Berlin")
        assert start < end <= NOW, preset


def test_a_rolling_range_is_elapsed_time_across_a_clock_change():
    # Review Focus 2. 13:00 CET on the day the clocks went back; 24 h earlier is 12:00Z the day before
    # (14:00 CEST). Wall-clock arithmetic would give 13:00 the day before, an hour out.
    start, end = resolve_range("24h", utc(2026, 10, 25, 12), "Europe/Berlin")
    assert (start, end) == (utc(2026, 10, 24, 12), utc(2026, 10, 25, 12))


def test_yesterday_is_the_whole_finished_local_day_even_when_it_has_25_hours():
    # Review Focus 2.
    start, end = resolve_range("yesterday", utc(2026, 10, 26, 10), "Europe/Berlin")
    assert (start, end) == (utc(2026, 10, 24, 22), utc(2026, 10, 25, 23))


def test_calendar_presets_at_the_edges_of_a_year_and_of_midnight():
    assert resolve_range("last_month", utc(2026, 1, 15), "UTC") == (utc(2025, 12, 1), utc(2026, 1, 1))
    assert resolve_range("this_month", utc(2026, 1, 1, 0, 1), "UTC") == (utc(2026, 1, 1), utc(2026, 1, 1, 0, 1))
    start, end = resolve_range("today", utc(2026, 3, 29, 12), "Europe/Berlin")
    assert start == utc(2026, 3, 28, 23) and end == utc(2026, 3, 29, 12)


def test_an_unknown_preset_is_refused_with_the_list():
    with pytest.raises(ValueError, match="range must be one of 1h, 6h, 24h"):
        resolve_range("90d", NOW, "UTC")


# ---- local_days -------------------------------------------------------------------------------


def hours_between(start: datetime, end: datetime) -> list[datetime]:
    out = []
    current = start.astimezone(UTC)
    while current < end:
        out.append(current)
        current += HOUR
    return out


@pytest.mark.parametrize(
    "month, zone, odd_day, odd_hours",
    [
        ("2026-03", "Europe/Berlin", date(2026, 3, 29), 23),
        ("2026-10", "Europe/Berlin", date(2026, 10, 25), 25),
        ("2026-03", "America/New_York", date(2026, 3, 8), 23),
        ("2026-11", "America/New_York", date(2026, 11, 1), 25),
    ],
)
def test_a_month_splits_into_local_days_without_dropping_or_doubling_an_hour(month, zone, odd_day, odd_hours):
    # Review Focus 2.
    start, end = month_bounds(month, zone)
    days = local_days(start, end, zone)

    year, number = (int(part) for part in month.split("-"))
    assert [d for d, _, _ in days] == [date(year, number, n) for n in range(1, monthrange(year, number)[1] + 1)]
    lengths = {day: (to - frm) // HOUR for day, frm, to in days}
    assert lengths[odd_day] == odd_hours
    assert {n for day, n in lengths.items() if day != odd_day} == {24}
    # the days abut exactly and together cover the month exactly
    assert days[0][1] == start and days[-1][2] == end
    assert all(a[2] == b[1] for a, b in zip(days, days[1:]))
    assert sum(lengths.values()) == (end - start) // HOUR
    # every UTC hour of the month falls in exactly one local day: the one the zone's own calendar gives
    by_calendar = Counter(instant.astimezone(ZoneInfo(zone)).date() for instant in hours_between(start, end))
    assert dict(by_calendar) == lengths


def test_local_days_clip_the_first_and_last_day_to_the_range():
    days = local_days(utc(2026, 6, 10, 10), utc(2026, 6, 12, 5), "UTC")
    assert [(d, f, t) for d, f, t in days] == [
        (date(2026, 6, 10), utc(2026, 6, 10, 10), utc(2026, 6, 11)),
        (date(2026, 6, 11), utc(2026, 6, 11), utc(2026, 6, 12)),
        (date(2026, 6, 12), utc(2026, 6, 12), utc(2026, 6, 12, 5)),
    ]


def test_a_range_ending_exactly_at_midnight_has_no_extra_empty_day():
    days = local_days(utc(2026, 6, 10), utc(2026, 6, 12), "UTC")
    assert [d for d, _, _ in days] == [date(2026, 6, 10), date(2026, 6, 11)]


def test_an_empty_or_backwards_range_has_no_days():
    assert local_days(utc(2026, 6, 10, 5), utc(2026, 6, 10, 5), "UTC") == []
    assert local_days(utc(2026, 6, 10, 5), utc(2026, 6, 9), "UTC") == []


def test_local_days_use_the_zone_not_utc():
    # 22:30Z on the 6th is 01:30 on the 7th in Qatar: the first local day is the 7th, clipped at the start.
    days = local_days(utc(2026, 10, 6, 22, 30), utc(2026, 10, 7, 21), "Asia/Qatar")
    assert days == [(date(2026, 10, 7), utc(2026, 10, 6, 22, 30), utc(2026, 10, 7, 21))]
```

Run: `cd backend && uv run pytest tests/test_tree.py tests/test_timeutil.py -v`
Expected: collection errors, `ModuleNotFoundError: No module named 'dcdash.core.tree'` and `... 'dcdash.core.timeutil'`.

- [ ] **Step 3: Implement `tree.py` and `timeutil.py`**

`backend/dcdash/core/tree.py`:

```python
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import Asset


@dataclass(frozen=True)
class AssetNode:
    id: int
    parent_id: int | None
    name: str
    sort_order: int


def _order(node: AssetNode) -> tuple[int, str, int]:
    return (node.sort_order, node.name, node.id)


class AssetTree:
    """The asset hierarchy, loaded once per request so that every lookup afterwards is in memory."""

    def __init__(self, nodes: Iterable[AssetNode] | dict[int, AssetNode]) -> None:
        items = nodes.values() if isinstance(nodes, dict) else nodes
        self.nodes: dict[int, AssetNode] = {node.id: node for node in items}
        by_parent: dict[int, list[AssetNode]] = {}
        for node in self.nodes.values():
            if node.parent_id in self.nodes:
                by_parent.setdefault(node.parent_id, []).append(node)
        self._children = {
            parent: [node.id for node in sorted(kids, key=_order)] for parent, kids in by_parent.items()
        }
        # A node whose parent is missing is treated as a root rather than dropped.
        self._roots = [
            node.id for node in sorted(self.nodes.values(), key=_order) if node.parent_id not in self.nodes
        ]

    @classmethod
    async def load(cls, db: AsyncSession) -> "AssetTree":
        assets = await db.scalars(select(Asset))
        return cls(AssetNode(a.id, a.parent_id, a.name, a.sort_order) for a in assets)

    def children(self, asset_id: int) -> list[int]:
        """Direct children ordered by sort_order, name, id; empty for a leaf or an unknown id."""
        return list(self._children.get(asset_id, ()))

    def ancestors_or_self(self, asset_id: int) -> list[int]:
        """The asset first, then its parent, grandparent and so on up to the root. KeyError if unknown."""
        node = self.nodes[asset_id]
        chain = [node.id]
        while node.parent_id in self.nodes and node.parent_id not in chain:  # `not in chain` stops a cycle
            node = self.nodes[node.parent_id]
            chain.append(node.id)
        return chain

    def path(self, asset_id: int) -> str:
        """Names from the root down, e.g. "Site / MV2 / LV Panel 1". KeyError if unknown."""
        return " / ".join(self.nodes[i].name for i in reversed(self.ancestors_or_self(asset_id)))

    def preorder(self) -> list[int]:
        """Every asset once, parents before their children, siblings in children() order."""
        order: list[int] = []
        seen: set[int] = set()
        stack = list(reversed(self._roots))
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            order.append(current)
            stack.extend(reversed(self._children.get(current, ())))
        # Only a parent cycle (the API refuses to create one) leaves anything unvisited; keep it addressable.
        order.extend(i for i in sorted(self.nodes) if i not in seen)
        return order
```

`backend/dcdash/core/timeutil.py`:

```python
"""Site-timezone helpers: where a day or a month begins, and the range presets.

Every datetime returned here is in UTC. Two datetimes that share a ZoneInfo subtract by wall clock, which is
23 hours off across a daylight-saving change; in UTC, subtraction is elapsed time. Display with
`.astimezone(ZoneInfo(site_zone))` and take a local date with `.astimezone(...).date()`.
"""
import re
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

RANGE_PRESETS: tuple[str, ...] = (
    "1h", "6h", "24h", "7d", "30d", "today", "yesterday", "this_month", "last_month",
)
_ROLLING_HOURS = {"1h": 1, "6h": 6, "24h": 24, "7d": 7 * 24, "30d": 30 * 24}
ROLLING: frozenset[str] = frozenset(_ROLLING_HOURS)
_MONTH = re.compile(r"([0-9]{4})-(0[1-9]|1[0-2])")


def _zone(tz_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name)
    except (KeyError, ValueError, OSError):  # unknown key, malformed key, or a directory such as "America"
        raise ValueError(f"unknown timezone: {tz_name}") from None


def _aware(value: datetime, name: str) -> datetime:
    if value.tzinfo is None:
        raise ValueError(f"{name} must include a timezone offset")
    return value


def _midnight(day: date, zone: ZoneInfo) -> datetime:
    """The instant local `day` begins, in UTC. Where the zone skips midnight that day, the first instant
    after the gap; where it repeats midnight, the first occurrence."""
    return datetime.combine(day, time.min, tzinfo=zone).astimezone(timezone.utc)


def _shift_month(first: date, months: int) -> date:
    index = first.year * 12 + first.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def validate_whole_hour_zone(tz_name: str) -> None:
    """Raise ValueError unless the zone exists and its UTC offset is a whole number of hours in January and July.

    A whole-hour offset puts local midnight on an hourly rollup bucket edge all year.
    """
    zone = _zone(tz_name)
    for probe in (datetime(2026, 1, 15, 12, tzinfo=timezone.utc), datetime(2026, 7, 15, 12, tzinfo=timezone.utc)):
        offset = probe.astimezone(zone).utcoffset()
        if offset is None or offset.total_seconds() % 3600:
            raise ValueError(
                f"timezone {tz_name} has a UTC offset ({offset}) that is not a whole number of hours"
            )


def day_start(now: datetime, tz_name: str) -> datetime:
    """The instant (UTC) of midnight at the start of `now`'s day in the given timezone."""
    zone = _zone(tz_name)
    return _midnight(_aware(now, "now").astimezone(zone).date(), zone)


def day_bounds(now: datetime, tz_name: str) -> tuple[datetime, datetime]:
    """[local midnight of `now`'s day, the next local midnight): 23, 24 or 25 hours long."""
    zone = _zone(tz_name)
    day = _aware(now, "now").astimezone(zone).date()
    return _midnight(day, zone), _midnight(day + timedelta(days=1), zone)


def month_start(now: datetime, tz_name: str) -> datetime:
    """Midnight at the start of `now`'s month in the given timezone."""
    zone = _zone(tz_name)
    return _midnight(_aware(now, "now").astimezone(zone).date().replace(day=1), zone)


def month_bounds(month: str, tz_name: str) -> tuple[datetime, datetime]:
    """"YYYY-MM" -> [first local midnight of the month, first local midnight of the next month)."""
    match = _MONTH.fullmatch(month)
    if match is None or not 1970 <= int(match[1]) <= 2100:
        raise ValueError("month must look like YYYY-MM")
    zone = _zone(tz_name)
    first = date(int(match[1]), int(match[2]), 1)
    return _midnight(first, zone), _midnight(_shift_month(first, 1), zone)


def resolve_range(preset: str, now: datetime, tz_name: str) -> tuple[datetime, datetime]:
    """[start, end) for a range preset. Rolling presets end now; calendar ones follow the site timezone."""
    zone = _zone(tz_name)
    now = _aware(now, "now")
    if preset in _ROLLING_HOURS:
        # Subtract in UTC: timedelta arithmetic on a zoned datetime moves the wall clock, not elapsed time.
        end = now.astimezone(timezone.utc)
        return end - timedelta(hours=_ROLLING_HOURS[preset]), end
    today = now.astimezone(zone).date()
    first = today.replace(day=1)
    if preset == "today":
        return _midnight(today, zone), now.astimezone(timezone.utc)
    if preset == "yesterday":
        return _midnight(today - timedelta(days=1), zone), _midnight(today, zone)
    if preset == "this_month":
        return _midnight(first, zone), now.astimezone(timezone.utc)
    if preset == "last_month":
        return _midnight(_shift_month(first, -1), zone), _midnight(first, zone)
    raise ValueError(f"range must be one of {', '.join(RANGE_PRESETS)}")


def local_days(start: datetime, end: datetime, tz_name: str) -> list[tuple[date, datetime, datetime]]:
    """The local days overlapping [start, end) as (date, from, to), with the first and last clipped to the range.

    A day is 23, 24 or 25 hours long where the zone changes its clock; consecutive entries abut exactly.
    """
    zone = _zone(tz_name)
    start, end = _aware(start, "start"), _aware(end, "end")
    days: list[tuple[date, datetime, datetime]] = []
    day = start.astimezone(zone).date()
    while True:
        day_from, day_to = _midnight(day, zone), _midnight(day + timedelta(days=1), zone)
        if day_from >= end:
            return days
        lo, hi = max(start, day_from), min(end, day_to)
        if lo < hi:
            days.append((day, lo.astimezone(timezone.utc), hi.astimezone(timezone.utc)))
        day += timedelta(days=1)
```

Run: `cd backend && uv run pytest tests/test_tree.py tests/test_timeutil.py -v`
Expected: all PASS (no database is touched; a second or two).

- [ ] **Step 4: Write the failing energy tests**

Append to `backend/tests/helpers.py` (after `insert_readings`):

```python


async def settle_rollups(db) -> None:
    """Materialize both rollups now, so a test never depends on where the policy jobs left the real-time watermark."""
    await db.execute("CALL refresh_continuous_aggregate('readings_1m', NULL, NULL)")
    await db.execute("CALL refresh_continuous_aggregate('readings_1h', NULL, NULL)")
```

(`db` is the asyncpg pool; `pool.execute` autocommits, which `refresh_continuous_aggregate` requires. `conftest.py` does the same after its TRUNCATE.)

`backend/tests/test_energy_hours.py` (pure, no database; Review Focus 1):

```python
"""Pure tests of the hourly energy maths and the roll-up: no database.

Review Focus 1 (spec section 6): resets and outages must never produce negative or inflated kWh.
"""
from datetime import datetime, timedelta, timezone
from itertools import product

import pytest

from dcdash.core.energy import (
    Energy,
    HourEnergy,
    HourRow,
    Meter,
    assemble,
    counter_hours,
    power_hours,
    total,
)
from dcdash.core.tree import AssetNode, AssetTree

T0 = datetime(2026, 6, 10, 0, 0, tzinfo=timezone.utc)


def hour(n: int) -> datetime:
    return T0 + timedelta(hours=n)


def counter_row(n: int, low: float, high: float, last: float) -> HourRow:
    """A counter's rollup row for hour `n` (the sum and count are not read by the counter maths)."""
    return HourRow(hour(n), low, high, 0.0, 1, last)


def power_row(n: int, kw: float, samples: int) -> HourRow:
    """Hour `n` of a point that held `kw` for `samples` samples."""
    return HourRow(hour(n), kw, kw, kw * samples, samples, kw)


# ---- counter_hours -------------------------------------------------------------------------


def test_an_hour_counts_its_last_value_minus_the_previous_last_value():
    rows = [counter_row(0, 101, 104, 104), counter_row(1, 105, 110, 110)]
    assert counter_hours(rows, 100.0) == {hour(0): 4.0, hour(1): 6.0}


def test_the_first_bucket_without_a_baseline_counts_last_minus_min():
    assert counter_hours([counter_row(0, 100, 130, 130)], None) == {hour(0): 30.0}


def test_no_rows_give_no_hours():
    assert counter_hours([], 100.0) == {}


def test_a_reset_inside_an_hour_is_recovered_exactly():
    # Review Focus 1. Previous bucket ended at 100; this hour went 110 -> 5 (reset) -> 8.
    # 100 -> 110 counts (+10), the step across the reset adds nothing, 5 -> 8 counts (+3).
    assert counter_hours([counter_row(0, 5, 110, 8)], 100.0) == {hour(0): 13.0}


def test_a_reset_exactly_between_two_hours_counts_only_the_rise_after_it():
    # Review Focus 1. The counter was at 500, reset, and read 3 .. 9 in the next hour: only 9 - 3 counts.
    # Subtracting the previous last value would give -491.
    result = counter_hours([counter_row(0, 3, 9, 9)], 500.0)
    assert result == {hour(0): 6.0}
    assert result[hour(0)] >= 0


def test_a_reset_that_never_climbs_back_to_the_old_value_is_not_negative():
    # Review Focus 1. 500 -> reset -> 3, 4: last (4) is far below the previous last (500).
    assert counter_hours([counter_row(0, 3, 4, 4)], 500.0) == {hour(0): 1.0}


def test_a_register_rollover_is_recovered_like_any_reset():
    # Review Focus 1. A 5-digit register: 99 990 .. 99 999, wraps to 0, and counts on to 6.
    assert counter_hours([counter_row(0, 2, 99_999, 6)], 99_990.0) == {hour(0): 9.0 + 4.0}


def test_a_reset_in_each_of_two_consecutive_hours():
    rows = [counter_row(0, 5, 110, 8), counter_row(1, 2, 8, 6)]
    # hour 0: 13 as above. hour 1: min 2 < previous last 8, so max(0, 8 - 8) + (6 - 2) = 4.
    assert counter_hours(rows, 100.0) == {hour(0): 13.0, hour(1): 4.0}


def test_a_gap_in_the_data_lands_in_the_hour_the_next_value_arrives():
    # Review Focus 1. Nothing was recorded in hours 1 to 4; the 46 kWh counted meanwhile belongs to hour 5.
    rows = [counter_row(0, 101, 104, 104), counter_row(5, 140, 150, 150)]
    result = counter_hours(rows, 100.0)
    assert result == {hour(0): 4.0, hour(5): 46.0}
    assert set(result) == {hour(0), hour(5)}


def test_counter_hours_are_never_negative():
    # Review Focus 1. Every consistent row (min <= last <= max) against every baseline.
    values = (0.0, 3.0, 9.0, 50.0, 500.0)
    for baseline, low, high, last in product((None, *values), values, values, values):
        if not low <= last <= high:
            continue
        (kwh,) = counter_hours([counter_row(0, low, high, last)], baseline).values()
        assert kwh >= 0, (baseline, low, high, last)


# ---- power_hours ---------------------------------------------------------------------------


def test_a_full_hour_of_samples_is_the_average_power():
    # 360 samples at a 10 s interval cover the hour: 12 kW for 1 h.
    assert power_hours([power_row(0, 12.0, 360)], 10) == {hour(0): pytest.approx(12.0)}


def test_an_outage_counts_only_the_time_the_samples_cover():
    # Review Focus 1. 12 kW sampled every 10 s for 40 minutes (n = 240), then 20 minutes of nothing.
    # Averaging over the whole hour would give 12 kWh; the samples cover 2400 s, so 8 kWh.
    assert power_hours([power_row(0, 12.0, 240)], 10) == {hour(0): pytest.approx(8.0)}


def test_sampling_faster_than_the_interval_cannot_exceed_one_hour():
    # Review Focus 1. 720 samples at a 10 s interval would be 2 h of coverage; it is capped at 1 h.
    assert power_hours([power_row(0, 12.0, 720)], 10) == {hour(0): pytest.approx(12.0)}


def test_the_average_is_the_rollup_sum_over_its_count():
    row = HourRow(hour(0), 0.0, 20.0, 3600.0, 360, 4.0)  # mean 10 kW
    assert power_hours([row], 10) == {hour(0): pytest.approx(10.0)}


def test_a_row_without_samples_adds_nothing():
    assert power_hours([HourRow(hour(0), 0.0, 0.0, 0.0, 0, 0.0)], 10) == {}


# ---- total ---------------------------------------------------------------------------------


def test_total_of_no_figure_is_none_and_of_no_hours_is_zero():
    assert total(None) is None
    assert total({}) == Energy(0.0, False)


def test_total_sums_the_hours_and_is_estimated_if_any_hour_is():
    hours = {hour(0): HourEnergy(2.0, False), hour(1): HourEnergy(3.0, True)}
    assert total(hours) == Energy(5.0, True)
    assert total({hour(0): HourEnergy(2.0, False)}) == Energy(2.0, False)


# ---- assemble (the roll-up) ----------------------------------------------------------------

# Site(1) -> MV2(2) -> LV1(3), LV2(4);  Site -> Spare(5)
TREE = AssetTree(
    [
        AssetNode(1, None, "Site", 0),
        AssetNode(2, 1, "MV2", 0),
        AssetNode(3, 2, "LV1", 0),
        AssetNode(4, 2, "LV2", 1),
        AssetNode(5, 1, "Spare", 1),
    ]
)
COUNTER_30 = Meter(point_id=30, scale=1.0, interval_seconds=60, counter=True)
POWER_40 = Meter(point_id=40, scale=1.0, interval_seconds=10, counter=False)


def test_every_asset_in_the_tree_gets_a_key_and_unmapped_ones_are_none():
    result = assemble(TREE, {}, {}, {})
    assert list(result.hours) == [1, 2, 3, 4, 5]
    assert all(value is None for value in result.hours.values())
    assert result.own == frozenset()


def test_a_parent_without_a_meter_sums_its_children_and_skips_those_without_a_figure():
    meters = {3: COUNTER_30, 4: POWER_40}
    rows = {30: [counter_row(0, 100, 110, 110)], 40: [power_row(0, 6.0, 60)]}  # LV2: 6 kW for 10 min = 1 kWh
    result = assemble(TREE, meters, rows, {30: 100.0})
    assert result.hours[3] == {hour(0): HourEnergy(10.0, False)}
    assert result.hours[4] == {hour(0): HourEnergy(1.0, True)}
    assert result.hours[2] == {hour(0): HourEnergy(11.0, True)}
    assert result.hours[5] is None  # Spare has nothing mapped
    assert result.hours[1] == result.hours[2]  # Site = MV2; Spare is skipped, not counted as zero
    assert result.own == frozenset({3, 4})


def test_an_own_meter_wins_over_the_children():
    meters = {2: Meter(20, 1.0, 60, True), 3: COUNTER_30}
    rows = {20: [counter_row(0, 1000, 1020, 1020)], 30: [counter_row(0, 100, 107, 107)]}
    result = assemble(TREE, meters, rows, {20: 1000.0, 30: 100.0})
    assert result.hours[2] == {hour(0): HourEnergy(20.0, False)}
    assert result.own == frozenset({2, 3})


def test_a_silent_meter_counts_zero_and_does_not_fall_back_to_its_children():
    # Review Focus 1. MV2 has its own meter that recorded nothing; LV1 below it did record.
    meters = {2: Meter(20, 1.0, 60, True), 3: COUNTER_30}
    rows = {30: [counter_row(0, 100, 107, 107)]}
    result = assemble(TREE, meters, rows, {30: 100.0})
    assert result.hours[2] == {}  # zero, not None and not LV1's 7 kWh
    assert total(result.hours[2]) == Energy(0.0, False)
    assert result.hours[1] == {}  # Site sums MV2 only (Spare has no figure)
    assert result.hours[3] == {hour(0): HourEnergy(7.0, False)}


def test_the_scale_multiplies_the_kwh_after_the_counter_maths():
    # A counter in Wh with scale 0.001. The reset hour counts 10 000 + 3 000 Wh = 13 kWh.
    meters = {3: Meter(30, 0.001, 60, True)}
    result = assemble(TREE, meters, {30: [counter_row(0, 5000, 110_000, 8000)]}, {30: 100_000.0})
    assert result.hours[3] == {hour(0): HourEnergy(pytest.approx(13.0), False)}


def test_a_power_estimate_is_scaled_and_flagged_estimated():
    meters = {4: Meter(40, 0.001, 10, False)}  # watts to kW
    result = assemble(TREE, meters, {40: [power_row(0, 12_000.0, 360)]}, {})
    assert result.hours[4] == {hour(0): HourEnergy(pytest.approx(12.0), True)}


def test_hours_are_summed_per_bucket_and_flagged_per_bucket():
    meters = {3: COUNTER_30, 4: POWER_40}
    rows = {
        30: [counter_row(0, 100, 110, 110)],  # hour 0 only
        40: [power_row(1, 6.0, 360)],  # hour 1 only, estimated
    }
    result = assemble(TREE, meters, rows, {30: 100.0})
    assert result.hours[2] == {hour(0): HourEnergy(10.0, False), hour(1): HourEnergy(6.0, True)}
    assert total(result.hours[2]) == Energy(16.0, True)
```

`backend/tests/test_energy_engine.py` (database; Review Focus 1 and 2 against the real rollup views, plus the one-query size check):

```python
"""The energy engine and the asset tree against the real database and the real rollup views."""
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import event

from dcdash.core.db import get_engine, get_sessionmaker
from dcdash.core.energy import Energy, HourEnergy, hourly_energy, total
from dcdash.core.timeutil import local_days, month_bounds
from dcdash.core.tree import AssetTree
from helpers import insert_readings, make_asset, make_mapping, make_point, make_source, settle_rollups

T0 = datetime(2026, 6, 10, 0, 0, tzinfo=timezone.utc)
HOUR = timedelta(hours=1)
MINUTE = timedelta(minutes=1)


async def meter(db, source, name, parent_id=None, metric="energy_kwh", interval=60, scale=1.0):
    """An asset with one mapped point. Returns (asset_id, point_id)."""
    asset = await make_asset(db, name, parent_id)
    point = await make_point(db, source, f"{name}_{metric}")
    await make_mapping(db, point, asset, metric, interval, scale)
    return asset, point


async def energy(start=T0, end=T0 + 3 * HOUR):
    async with get_sessionmaker()() as session:
        return await hourly_energy(session, await AssetTree.load(session), start, end)


# ---- the tree --------------------------------------------------------------------------------


async def test_the_tree_loads_ordered_with_paths(db):
    site = await make_asset(db, "Site")
    mv2 = await make_asset(db, "MV2", site)
    panel_b = await make_asset(db, "Panel B", mv2)
    panel_a = await make_asset(db, "Panel A", mv2)
    pinned = await make_asset(db, "Zed", mv2)
    await db.execute("UPDATE assets SET sort_order = -1 WHERE id = $1", pinned)

    async with get_sessionmaker()() as session:
        tree = await AssetTree.load(session)

    assert tree.children(mv2) == [pinned, panel_a, panel_b]  # sort_order first, then name
    assert tree.preorder() == [site, mv2, pinned, panel_a, panel_b]
    assert tree.path(panel_a) == "Site / MV2 / Panel A"
    assert tree.ancestors_or_self(panel_a) == [panel_a, mv2, site]


# ---- counters --------------------------------------------------------------------------------


async def test_consumption_across_the_start_of_the_range_uses_the_last_earlier_bucket(db):
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel")
    await insert_readings(db, point, T0 - 3 * HOUR + 20 * MINUTE, 1, [80.0])  # the baseline, three hours earlier
    await insert_readings(db, point, T0 + 10 * MINUTE, 40 * 60, [100.0, 104.0])  # 00:10 and 00:50
    await insert_readings(db, point, T0 + 70 * MINUTE, 1, [110.0])  # 01:10
    await settle_rollups(db)

    result = await energy(T0, T0 + 3 * HOUR)

    # 80 -> 104 accumulated in hour 0 (it includes the stretch before the range began), then 104 -> 110
    assert result.hours[asset] == {T0: HourEnergy(24.0, False), T0 + HOUR: HourEnergy(6.0, False)}
    assert result.own == frozenset({asset})
    # a later range takes its baseline from the bucket just before it
    assert (await energy(T0 + HOUR, T0 + 3 * HOUR)).hours[asset] == {T0 + HOUR: HourEnergy(6.0, False)}


async def test_a_counter_reset_inside_an_hour_is_recovered(db):
    # Review Focus 1, against the real rollup.
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel")
    await insert_readings(db, point, T0 - HOUR + 30 * MINUTE, 1, [100.0])
    await insert_readings(db, point, T0 + 5 * MINUTE, 900, [110.0, 5.0, 8.0])  # 00:05, 00:20, 00:35
    await settle_rollups(db)
    assert (await energy()).hours[asset] == {T0: HourEnergy(13.0, False)}


async def test_a_counter_reset_exactly_between_two_hours_is_not_negative(db):
    # Review Focus 1, against the real rollup.
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel")
    await insert_readings(db, point, T0 - HOUR + 50 * MINUTE, 1, [500.0])
    await insert_readings(db, point, T0 + 5 * MINUTE, 25 * 60, [3.0, 9.0])  # 00:05 and 00:30
    await settle_rollups(db)
    assert (await energy()).hours[asset] == {T0: HourEnergy(6.0, False)}


async def test_the_scale_applies_after_the_maths_and_bad_quality_readings_are_ignored(db):
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel", scale=0.001)  # the counter reads Wh
    await insert_readings(db, point, T0 - HOUR + 30 * MINUTE, 1, [100_000.0])
    await insert_readings(db, point, T0 + 5 * MINUTE, 900, [110_000.0, 5_000.0, 8_000.0])
    await db.execute(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, 99999999, 1)", point, T0 + 10 * MINUTE
    )
    await settle_rollups(db)
    assert (await energy()).hours[asset] == {T0: HourEnergy(pytest.approx(13.0), False)}


async def test_a_counter_beats_active_power_on_the_same_asset(db):
    source = await make_source(db)
    asset = await make_asset(db, "Panel")
    counter, power = await make_point(db, source, "kWh"), await make_point(db, source, "kW")
    await make_mapping(db, counter, asset, "energy_kwh", 60)
    await make_mapping(db, power, asset, "active_power_kw", 10)
    await insert_readings(db, counter, T0 - HOUR + 30 * MINUTE, 1, [100.0])
    await insert_readings(db, counter, T0 + 10 * MINUTE, 1, [105.0])
    await insert_readings(db, power, T0, 10, [12.0] * 360)  # a full hour at 12 kW would be 12 kWh
    await settle_rollups(db)
    assert (await energy()).hours[asset] == {T0: HourEnergy(5.0, False)}


# ---- power-only meters ------------------------------------------------------------------------


async def test_a_power_only_meter_with_a_20_minute_outage_counts_the_covered_time(db):
    # Review Focus 1. 12 kW every 10 s for 40 minutes, then nothing until the end of the hour.
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel", metric="active_power_kw", interval=10)
    await insert_readings(db, point, T0, 10, [12.0] * 240)
    await settle_rollups(db)

    hours = (await energy()).hours[asset]

    assert list(hours) == [T0]
    assert hours[T0].kwh == pytest.approx(8.0) and hours[T0].estimated is True


# ---- roll-up ----------------------------------------------------------------------------------


async def test_a_silent_meter_counts_zero_and_does_not_fall_back_to_its_children(db):
    # Review Focus 1, against the real rollup. MV2 is metered but recorded nothing; its child did.
    source = await make_source(db)
    mv2, _ = await meter(db, source, "MV2")
    child, point = await meter(db, source, "LV Panel 1", mv2)
    await insert_readings(db, point, T0 - HOUR + 30 * MINUTE, 1, [100.0])
    await insert_readings(db, point, T0 + 10 * MINUTE, 1, [107.0])
    await settle_rollups(db)

    result = await energy()

    assert result.hours[mv2] == {}
    assert total(result.hours[mv2]) == Energy(0.0, False)
    assert result.hours[child] == {T0: HourEnergy(7.0, False)}


async def test_a_parent_sums_its_children_and_an_unmapped_asset_has_no_figure(db):
    source = await make_source(db)
    site = await make_asset(db, "Site")
    mv2 = await make_asset(db, "MV2", site)
    spare = await make_asset(db, "Spare", site)
    lv1, counter = await meter(db, source, "LV Panel 1", mv2)
    lv2, power = await meter(db, source, "LV Panel 2", mv2, metric="active_power_kw", interval=10)
    await insert_readings(db, counter, T0 - HOUR + 30 * MINUTE, 1, [100.0])
    await insert_readings(db, counter, T0 + 10 * MINUTE, 1, [107.0])
    await insert_readings(db, power, T0, 10, [6.0] * 60)  # 6 kW for 10 minutes = 1 kWh
    await settle_rollups(db)

    result = await energy()

    assert result.hours[mv2] == {T0: HourEnergy(pytest.approx(8.0), True)}
    assert result.hours[site] == result.hours[mv2]  # Spare has no figure and is skipped, not counted as zero
    assert result.hours[spare] is None
    assert total(result.hours[spare]) is None
    assert result.own == frozenset({lv1, lv2})


async def test_assets_with_nothing_mapped_have_no_figure(db):
    asset = await make_asset(db, "Empty")
    result = await energy()
    assert result.hours == {asset: None} and result.own == frozenset()


async def test_the_range_must_be_timezone_aware(db):
    with pytest.raises(ValueError, match="timezone"):
        await energy(datetime(2026, 6, 10), T0 + HOUR)


# ---- daylight saving (Review Focus 2) and size ------------------------------------------------


async def test_a_dst_month_splits_into_local_days_that_add_up_to_the_month(db):
    # Review Focus 2. March 2026 in Berlin has a 23-hour day (the 29th). One reading an hour, +1 kWh each.
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel")
    start, end = month_bounds("2026-03", "Europe/Berlin")
    hours = (end - start) // HOUR
    assert hours == 743
    await insert_readings(db, point, start - HOUR, 3600, [float(i) for i in range(hours + 1)])
    await settle_rollups(db)

    month = (await energy(start, end)).hours[asset]

    assert len(month) == hours and total(month) == Energy(float(hours), False)
    per_day = {
        day: sum(h.kwh for bucket, h in month.items() if frm <= bucket < to)
        for day, frm, to in local_days(start, end, "Europe/Berlin")
    }
    assert per_day[date(2026, 3, 29)] == 23.0
    assert {kwh for day, kwh in per_day.items() if day.day != 29} == {24.0}
    assert sum(per_day.values()) == total(month).kwh  # no hour dropped or counted twice


async def test_sixty_meters_over_a_month_are_read_in_one_batched_query(db):
    source = await make_source(db)
    site = await make_asset(db, "Site")
    start, hours = T0, 31 * 24
    for number in range(60):
        _, point = await meter(db, source, f"Panel {number:02d}", site)
        # one reading an hour from the hour before the range, rising 2 kWh every hour
        await insert_readings(db, point, start - HOUR, 3600, [2.0 * i for i in range(hours + 1)])
    await settle_rollups(db)

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    async with get_sessionmaker()() as session:
        tree = await AssetTree.load(session)
        sync_engine = get_engine().sync_engine
        event.listen(sync_engine, "before_cursor_execute", record)
        try:
            result = await hourly_energy(session, tree, start, start + hours * HOUR)
        finally:
            event.remove(sync_engine, "before_cursor_execute", record)

    assert sum("readings_1h" in statement for statement in statements) == 1  # all 60 points in one statement
    assert len(statements) <= 2  # that one and the mappings; nothing per asset
    assert total(result.hours[site]) == Energy(pytest.approx(60 * 2.0 * hours), False)
    assert all(len(result.hours[a]) == hours for a in tree.nodes if a != site)
```

Run: `cd backend && uv run pytest tests/test_energy_hours.py tests/test_energy_engine.py -v`
Expected: collection errors, `ImportError: cannot import name 'HourEnergy' from 'dcdash.core.energy'`.

- [ ] **Step 5: Rewrite `energy.py`, delete the old unit tests**

Replace the whole of `backend/dcdash/core/energy.py` with:

```python
"""The energy engine: hourly kWh per asset from the hourly rollup, rolled up the asset tree.

Every energy figure (asset page, billing, dashboards) comes from here. The maths is pure Python on
`readings_1h` rows so it can be tested without a database; `hourly_energy` is the only function that
touches one, and it reads the rollup with a single batched query.
"""
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.metrics import Metric
from dcdash.core.models import Mapping
from dcdash.core.tree import AssetTree


@dataclass(frozen=True)
class Energy:
    kwh: float
    estimated: bool


@dataclass(frozen=True)
class HourRow:
    """One `readings_1h` row: the good samples of one point in one UTC hour."""

    bucket: datetime
    min_value: float
    max_value: float
    sum_value: float
    n: int
    last_value: float


@dataclass(frozen=True)
class HourEnergy:
    kwh: float
    estimated: bool


@dataclass(frozen=True)
class EnergyResult:
    # One key per asset in the tree. None = no energy_kwh or active_power_kw mapping anywhere in its subtree.
    hours: dict[int, dict[datetime, HourEnergy] | None]
    # Assets whose figure comes from their own mapping (not from summing their children).
    own: frozenset[int]


@dataclass(frozen=True)
class Meter:
    """How one asset's own energy is measured: a kWh counter, or (no counter) an active-power estimate."""

    point_id: int
    scale: float
    interval_seconds: int
    counter: bool


def counter_hours(rows: Sequence[HourRow], baseline_last: float | None) -> dict[datetime, float]:
    """kWh per hour from a cumulative counter. `rows` ascend by bucket; `baseline_last` is the last value
    of the bucket before the first row (None if there is none).

    An hour counts its last value minus the previous bucket's last value, so a gap in the data lands in the
    hour in which the next value arrives. A decrease is a reset or rollover: if the hour's minimum is below
    the previous last value the hour counts max(0, max - previous_last) + (last - min), so the step across
    the reset adds nothing and the result is never negative. With no earlier bucket it counts last - min.
    """
    hours: dict[datetime, float] = {}
    previous = baseline_last
    for row in rows:
        if previous is None:
            kwh = row.last_value - row.min_value
        elif row.min_value < previous:
            kwh = max(0.0, row.max_value - previous) + (row.last_value - row.min_value)
        else:
            kwh = row.last_value - previous
        hours[row.bucket] = kwh
        previous = row.last_value
    return hours


def power_hours(rows: Sequence[HourRow], interval_seconds: int) -> dict[datetime, float]:
    """Estimated kWh per hour from active power in kW: the hour's average power times the time its samples
    cover (n x the polling interval, at most one hour), so an outage adds nothing."""
    hours: dict[datetime, float] = {}
    for row in rows:
        if row.n <= 0:
            continue
        coverage = min(1.0, row.n * interval_seconds / 3600)
        hours[row.bucket] = (row.sum_value / row.n) * coverage
    return hours


def _own_hours(meter: Meter, rows: Sequence[HourRow], baseline_last: float | None) -> dict[datetime, HourEnergy]:
    if meter.counter:
        raw = counter_hours(rows, baseline_last)
    else:
        raw = power_hours(rows, meter.interval_seconds)
    # The scale converts the source's unit to kWh, so it multiplies the result of the maths, not the readings.
    return {bucket: HourEnergy(kwh * meter.scale, not meter.counter) for bucket, kwh in raw.items()}


def _sum_hours(parts: Sequence[dict[datetime, HourEnergy]]) -> dict[datetime, HourEnergy]:
    merged: dict[datetime, HourEnergy] = {}
    for part in parts:
        for bucket, hour in part.items():
            seen = merged.get(bucket)
            merged[bucket] = hour if seen is None else HourEnergy(seen.kwh + hour.kwh, seen.estimated or hour.estimated)
    return dict(sorted(merged.items()))


def assemble(
    tree: AssetTree,
    meters: dict[int, Meter],
    rows: dict[int, list[HourRow]],
    baselines: dict[int, float],
) -> EnergyResult:
    """Roll hourly energy up the tree. `meters` maps asset id -> its own Meter; `rows` and `baselines` are keyed
    by point id. An asset with a Meter uses it even if it was silent (an empty dict, zero), never its children;
    otherwise it sums its children, skipping those with no figure; if none has one it has no figure (None)."""
    hours: dict[int, dict[datetime, HourEnergy] | None] = {}
    own: set[int] = set()
    for asset_id in reversed(tree.preorder()):  # children before parents
        meter = meters.get(asset_id)
        if meter is not None:
            own.add(asset_id)
            hours[asset_id] = _own_hours(meter, rows.get(meter.point_id, ()), baselines.get(meter.point_id))
            continue
        parts = [part for child in tree.children(asset_id) if (part := hours.get(child)) is not None]
        hours[asset_id] = _sum_hours(parts) if parts else None
    return EnergyResult({asset_id: hours[asset_id] for asset_id in tree.preorder()}, frozenset(own))


def total(hours: dict[datetime, HourEnergy] | None) -> Energy | None:
    """The sum of an asset's hours; None when the asset has no figure at all."""
    if hours is None:
        return None
    return Energy(sum((h.kwh for h in hours.values()), 0.0), any(h.estimated for h in hours.values()))


# One statement for every metered point: the rows of [start, end), plus the last bucket before `start` of each
# counter point (its baseline). Bad-quality readings are already excluded by the rollup views, which are
# real-time, so the hours not yet materialized are included.
_ROWS = text(
    """
    SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, FALSE AS baseline
    FROM readings_1h
    WHERE point_id = ANY(:ids) AND bucket >= :start AND bucket < :end
    UNION ALL
    SELECT b.point_id, b.bucket, b.min_value, b.max_value, b.sum_value, b.n, b.last_value, TRUE
    FROM unnest(CAST(:counter_ids AS integer[])) AS c(point_id)
    CROSS JOIN LATERAL (
        SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value
        FROM readings_1h
        WHERE point_id = c.point_id AND bucket < :start
        ORDER BY bucket DESC
        LIMIT 1
    ) b
    ORDER BY point_id, bucket
    """
)


async def load_meters(db: AsyncSession, tree: AssetTree) -> dict[int, Meter]:
    """Each asset's own meter: its energy_kwh counter, else its active_power_kw. (A unique index allows at most
    one mapping per asset and metric.)"""
    wanted = (Metric.ENERGY_KWH.value, Metric.ACTIVE_POWER_KW.value)
    rows = await db.execute(
        select(Mapping.asset_id, Mapping.point_id, Mapping.metric, Mapping.scale, Mapping.interval_seconds)
        .where(Mapping.metric.in_(wanted))
        .order_by(Mapping.id)
    )
    meters: dict[int, Meter] = {}
    for asset_id, point_id, metric, scale, interval in rows:
        counter = metric == Metric.ENERGY_KWH.value
        if asset_id in tree.nodes and (asset_id not in meters or counter):
            meters[asset_id] = Meter(point_id, scale, interval, counter)
    return meters


async def hourly_energy(db: AsyncSession, tree: AssetTree, start: datetime, end: datetime) -> EnergyResult:
    """Hourly energy for every asset in `tree`, for the UTC hours that begin in [start, end).

    `start` must be a whole UTC hour (and `end` too, to cut a period exactly); both must be timezone-aware.
    Two statements run however many assets there are: the meters, and the rollup rows.
    """
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("start and end must include a timezone offset")
    meters = await load_meters(db, tree)
    rows: dict[int, list[HourRow]] = defaultdict(list)
    baselines: dict[int, float] = {}
    if meters:
        params = {
            "ids": sorted({m.point_id for m in meters.values()}),
            "counter_ids": sorted({m.point_id for m in meters.values() if m.counter}),
            "start": start,
            "end": end,
        }
        for row in await db.execute(_ROWS, params):
            if row.baseline:
                baselines[row.point_id] = row.last_value
            else:
                # sum(n) in the rollup is numeric, which asyncpg returns as Decimal.
                rows[row.point_id].append(
                    HourRow(row.bucket, row.min_value, row.max_value, row.sum_value, int(row.n), row.last_value)
                )
    return assemble(tree, meters, rows, baselines)
```

Delete the tests of the removed functions: `git rm backend/tests/test_energy.py`. (`api/data.py` still imports only `Energy` from this module at this point, so the app keeps importing until Step 7.)

Run: `cd backend && uv run pytest tests/test_tree.py tests/test_timeutil.py tests/test_energy_hours.py tests/test_energy_engine.py -v` (Docker running)
Expected: all PASS, including `test_sixty_meters_over_a_month_are_read_in_one_batched_query`.

If `test_energy_engine.py` fails with a Timescale error, or the baseline lookup (`CROSS JOIN LATERAL ... ORDER BY bucket DESC LIMIT 1` over the real-time view) turns out slow, keep the tests and replace only the second `SELECT` of `_ROWS` with the `DISTINCT ON` form, which returns the same rows: `SELECT point_id, bucket, min_value, max_value, sum_value, n, last_value, TRUE FROM (SELECT DISTINCT ON (point_id) point_id, bucket, min_value, max_value, sum_value, n, last_value FROM readings_1h WHERE point_id = ANY(:counter_ids) AND bucket < :start ORDER BY point_id, bucket DESC) b`. Say which form you kept in the commit message.

- [ ] **Step 6: Update `test_api_data.py` where spec section 6 changed the number**

Four assertions change because the engine now reads the hourly rollup, not raw samples; every other test in the file keeps its data and its assertion. In `backend/tests/test_api_data.py`:

1. Import `settle_rollups` too: `from helpers import login_as, make_asset, make_mapping, make_point, make_source, settle_rollups`.
2. `add_readings` settles the rollups after inserting:

```python
async def add_readings(db, point_id, start, values, step=10 * MINUTE, quality=0):
    await db.executemany(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)",
        [(point_id, start + i * step, value, quality) for i, value in enumerate(values)],
    )
    await settle_rollups(db)  # energy reads the hourly rollup; do not depend on where its watermark is
```

3. After `today()`, add a fixed clock for the summary. It patches the name `datetime` inside `dcdash.api.data`, so `summary` sees `NOW`; no production seam is needed:

```python
NOW = datetime(2026, 6, 10, 12, 0, tzinfo=timezone.utc)


class FrozenDatetime(datetime):
    """`datetime` whose now() is NOW; patched over dcdash.api.data.datetime so the summary's clock is fixed."""

    @classmethod
    def now(cls, tz=None):
        return NOW if tz is None else NOW.astimezone(tz)


async def freeze_clock(db, monkeypatch, zone):
    """The summary sees NOW (15:00 on 10 June in Qatar, 12:00 in UTC) and `zone` as the site timezone."""
    monkeypatch.setattr("dcdash.api.data.datetime", FrozenDatetime)
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('general', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"timezone": zone},
    )
```

4. Replace `test_energy_today_from_counter_handles_reset` (13.0 becomes 3.0: with no earlier bucket the hour counts `last - min = 8 - 5`; the raw-sample query saw the 100 to 110 step, the rollup cannot) and add the next test, which keeps the old figure by giving the hour an earlier bucket (fixed clock, fixed timestamps):

```python
async def test_energy_today_from_counter_handles_reset(client, db):
    await login_as(client, db, "viewer")
    asset, _, kwh = await panel(db)
    await add_readings(db, kwh, today(), [100.0, 110.0, 5.0, 8.0])
    # Spec section 6: with no bucket before today the first hour counts last - min = 8 - 5. The old query, which
    # saw the raw samples, counted 13; the hourly rollup cannot see the 100 -> 110 step inside the hour.
    assert await energy_today(client, asset) == {"kwh": pytest.approx(3.0), "estimated": False}


async def test_energy_today_counter_reset_inside_the_hour_with_an_earlier_bucket(client, db, monkeypatch):
    await freeze_clock(db, monkeypatch, "UTC")
    await login_as(client, db, "viewer")
    asset, _, kwh = await panel(db)
    midnight = datetime(2026, 6, 10, tzinfo=timezone.utc)
    await add_readings(db, kwh, midnight - 10 * MINUTE, [100.0])  # 23:50 on the 9th, the baseline bucket
    await add_readings(db, kwh, midnight, [100.0, 110.0, 5.0, 8.0])
    # min 5 < previous last 100, so the hour counts max(0, 110 - 100) + (8 - 5) = 13: the old figure, now exact
    assert await energy_today(client, asset) == {"kwh": pytest.approx(13.0), "estimated": False}
```

5. Replace `test_power_estimate_does_not_reach_before_midnight` (10/6 becomes 10/3: an hour is average power times `n x interval`, here 2 samples x 600 s):

```python
async def test_power_estimate_does_not_reach_before_midnight(client, db):
    await login_as(client, db, "viewer")
    source = await make_source(db)
    asset = await make_asset(db, "LV Panel 1")
    kw = await make_point(db, source, "LVP01_kW")
    await make_mapping(db, kw, asset, "active_power_kw", interval=600)  # each sample covers 10 minutes
    await add_readings(db, kw, today() - 10 * MINUTE, [10.0])  # 23:50 yesterday
    await add_readings(db, kw, today() + 10 * MINUTE, [10.0, 10.0])  # 00:10 and 00:20
    # The 23:50 sample belongs to yesterday's hour and does not count. Spec section 6: today's hour is its
    # average power times the time its samples cover, n x interval = 2 x 600 s = 20 minutes: 10 kW x 1/3 h.
    # (The old trapezoid between the two samples gave 10/6.)
    assert (await energy_today(client, asset))["kwh"] == pytest.approx(10 / 3)
```

6. Replace `test_energy_today_is_estimated_from_power_when_there_is_no_counter` (the expected 6.0 stays; the samples now arrive at the mapping's own 5 second interval, because the estimate counts each sample as one interval of coverage, not the spacing between samples):

```python
async def test_energy_today_is_estimated_from_power_when_there_is_no_counter(client, db):
    await login_as(client, db, "viewer")
    asset, kw, _ = await panel(db, energy=False)
    # 12 kW held for 30 minutes, sampled at the mapping's own 5 second interval (360 samples cover 1800 s)
    await add_readings(db, kw, today(), [12.0] * 360, step=timedelta(seconds=5))
    assert await energy_today(client, asset) == {"kwh": pytest.approx(6.0), "estimated": True}
```

7. In `test_parent_energy_is_the_sum_of_its_children`, replace only the `kw2` readings line with the following (expected 8.0 stays, same reason):

```python
    await add_readings(db, kw2, today(), [6.0] * 120, step=timedelta(seconds=5))  # 6 kW for 10 min = 1 kWh
```

8. Add, before `test_series_buckets_and_scales`, the site-timezone test with the fixed clock:

```python
async def test_energy_today_is_the_site_timezone_day(client, db, monkeypatch):
    await freeze_clock(db, monkeypatch, "Asia/Qatar")  # the site day began at 21:00Z on the 9th
    await login_as(client, db, "viewer")
    asset, _, kwh = await panel(db)
    await add_readings(db, kwh, datetime(2026, 6, 9, 19, 30, tzinfo=timezone.utc), [100.0])  # 22:30 Qatar, the baseline
    await add_readings(db, kwh, datetime(2026, 6, 9, 21, 20, tzinfo=timezone.utc), [104.0, 106.0], step=30 * MINUTE)
    await add_readings(db, kwh, datetime(2026, 6, 10, 9, 10, tzinfo=timezone.utc), [110.0])
    # 100 -> 106 in the first hour of the Qatar day, 106 -> 110 later. A UTC day would start at 00:00Z and give 4.
    assert await energy_today(client, asset) == {"kwh": pytest.approx(10.0), "estimated": False}
```

Run: `cd backend && uv run pytest tests/test_api_data.py -v`
Expected (against the old `data.py`): exactly four FAIL: `test_energy_today_from_counter_handles_reset` (got 13.0), `test_power_estimate_does_not_reach_before_midnight` (got 10/6), `test_energy_today_is_estimated_from_power_when_there_is_no_counter` (about 5.98), `test_parent_energy_is_the_sum_of_its_children` (about 7.99). Everything else passes, including the two new tests, which are regression guards that give the same figure under both implementations (13.0 and 10.0).

- [ ] **Step 7: Move `api/data.py` onto the engine**

Four edits in `backend/dcdash/api/data.py`; edit, do not replace the file (Task 4 edits it next, and `series`, `pick_tier`, `_GOOD` and `_SERIES_*` must stay as they are):

1. Imports: delete `from zoneinfo import ZoneInfo`; replace `from dcdash.core.energy import Energy` with the engine import; add the `timeutil` and `tree` imports (alphabetical, after `models`). The header then reads:

```python
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.settings import current_timezone
from dcdash.core.energy import hourly_energy, total
from dcdash.core.metrics import Metric, unit_for
from dcdash.core.models import Asset, Mapping, PointLatest
from dcdash.core.timeutil import day_bounds, day_start  # noqa: F401  (day_start: existing importers use this path)
from dcdash.core.tree import AssetTree
```

2. Delete the raw energy SQL: every line from `# Counter consumption: sum of increases between consecutive good samples; a` up to, but not including, `_SERIES_RAW = text(` (that is `_COUNTER_KWH` and `_POWER_KWH` with their comments).
3. Delete `day_start`, `_own_energy` and `asset_energy`: every line from `def day_start(now: datetime, tz_name: str) -> datetime:` up to, but not including `@router.get("/assets/{asset_id}/summary")`. (`day_start` now comes from the import in edit 1, so `from dcdash.api.data import day_start` still works.)
4. In `summary`, replace the two lines
   `    start = day_start(datetime.now(timezone.utc), await current_timezone(db))`
   `    energy = await asset_energy(db, asset_id, start, start + timedelta(days=1))`
   with:

```python
    # Today = the site's local day. Settings refuses a zone whose day edges are not whole UTC hours; one stored
    # before that rule shifts these edges to the next rollup bucket instead of failing the page.
    start, end = day_bounds(_now(), await current_timezone(db))
    result = await hourly_energy(db, await AssetTree.load(db), start, end)
    energy = total(result.hours.get(asset_id))
```

(Do not run the tests yet: edit 4 calls `_now()`, which edit 5 defines.)

5. Add the clock seam directly below the `router = APIRouter(...)` line near the top of `backend/dcdash/api/data.py` (Task 4's tests, and the cost tile, patch this name):

```python
def _now() -> datetime:
    """The clock `summary()` reads; tests monkeypatch `dcdash.api.data._now`."""
    return datetime.now(timezone.utc)
```

Run: `cd backend && uv run pytest tests/test_api_data.py tests/test_api_data_tiers.py -v`
Expected: all PASS (the `FrozenDatetime` patch over `dcdash.api.data.datetime` used by this task's tests still works, because `_now` looks `datetime` up in that module).

- [ ] **Step 8: Check nothing is left behind, then run the whole backend suite**

Run: `cd backend && grep -rn "asset_energy\|_own_energy\|_COUNTER_KWH\|_POWER_KWH\|from_counter\|from_power\|consumption(" --include=*.py dcdash tests`
Expected: no output.

Run: `cd backend && grep -rn "day_start" --include=*.py dcdash tests`
Expected: the definition in `core/timeutil.py`, the re-export in `api/data.py`, and uses in `tests/test_api_data.py` and `tests/test_timeutil.py`.

Run: `cd backend && uv run pytest -q`
Expected: PASS (Docker running; a few minutes). If a test elsewhere pins an energy number that changed under spec section 6, fix only that number and name it in the commit message.

- [ ] **Step 9: Commit and push**

```bash
git add backend/dcdash/core/tree.py backend/dcdash/core/timeutil.py backend/dcdash/core/energy.py \
  backend/dcdash/api/data.py backend/tests/helpers.py backend/tests/test_api_data.py \
  backend/tests/test_tree.py backend/tests/test_timeutil.py backend/tests/test_energy_hours.py \
  backend/tests/test_energy_engine.py
git status --short   # backend/tests/test_energy.py must show as deleted
git commit -F - <<'MSG'
feat: one energy engine on the hourly rollup; asset summary uses it

core/energy.py now reads readings_1h in one batched query and computes hourly kWh
in pure Python (spec section 6): counter deltas against the previous bucket with
the in-hour reset rule, power-only estimates of average power x n x interval,
rolled up the new AssetTree (own meter wins, else the sum of children; a silent
meter is zero, an unmapped subtree has no figure). core/timeutil.py holds the
site-zone helpers (whole-hour check, day/month bounds, range presets, local days
with 23/25-hour DST days). api/data.py's raw energy SQL is deleted and day_start
moves to timeutil, still importable from api/data.

Changed assertions in tests/test_api_data.py, each because spec section 6 changed
the number:
- test_energy_today_from_counter_handles_reset: 13.0 -> 3.0. With no bucket before
  the period the first hour counts last - min (8 - 5); the hourly rollup cannot see
  the 100 -> 110 step inside the hour. The new
  test_energy_today_counter_reset_inside_the_hour_with_an_earlier_bucket keeps the
  old 13.0 by adding the earlier bucket (max(0, 110 - 100) + (8 - 5)).
- test_power_estimate_does_not_reach_before_midnight: 10/6 -> 10/3. An hour is its
  average power x n x mapping interval (2 x 600 s = 20 min), not a trapezoid between
  two samples; the 23:50 sample still does not count.
- test_energy_today_is_estimated_from_power_when_there_is_no_counter and
  test_parent_energy_is_the_sum_of_its_children: expected 6.0 and 8.0 unchanged, but
  the samples are now written at the mapping's own 5 s interval (360 and 120 samples),
  because coverage is n x interval, not the spacing of the samples.
- add_readings settles both rollups so the tests do not depend on the policy-job
  watermark.
New: a site-timezone day test and a reset-with-baseline test, both with a fixed clock
(FrozenDatetime patched over dcdash.api.data.datetime; the production seam is dcdash.api.data._now).
Removed tests/test_energy.py: it tested from_counter/from_power/consumption, which
spec section 6 replaces; the cases are covered by test_energy_hours.py and
test_energy_engine.py.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
MSG
git push origin phase-3-dashboards-billing
```

### Task 3: Tariffs, currency, site info and the cost engine

Prices the engine's hourly kWh with the tariff in effect (`core/cost.py`, pure), adds the site currency and `GET /api/site`, admin tariff CRUD with audit, and makes Settings refuse a timezone whose UTC offset is not a whole hour. Review Focus 3 (missing or changing rates never show as zero) is tested here at function level and again at API level in Task 4.

**Files:**
- Create: `backend/dcdash/core/cost.py`
- Create: `backend/dcdash/api/site.py`
- Create: `backend/dcdash/api/tariffs.py`
- Modify: `backend/dcdash/core/settings_store.py` (whole file given in Step 6; 35 lines today)
- Modify: `backend/dcdash/api/settings.py` (whole file given in Step 6; 69 lines today)
- Modify: `backend/dcdash/api/main.py` (the `from dcdash.api import (...)` block, lines 10-12, and the router tuple, lines 82-86)
- Test (create): `backend/tests/test_cost.py`, `backend/tests/test_api_site.py`, `backend/tests/test_api_tariffs.py`
- Test (append): `backend/tests/test_settings_store.py`, `backend/tests/test_api_settings.py`

**Interfaces:**
- Consumes (Task 1): `Tariff` in `dcdash/core/models.py` with columns `id`, `asset_id` (nullable FK to `assets.id`, `ON DELETE CASCADE`), `rate_per_kwh` (NUMERIC), `effective_from` (DATE), `created_by` (nullable FK to `users.id`), `created_at` (server default now); table `tariffs`. The `db` fixture truncates `tariffs` (Task 1 added it to `conftest.TABLES`).
- Consumes (Task 2): `AssetNode`, `AssetTree` (`AssetTree(nodes)` from an iterable or dict of nodes, `children(asset_id)`, `ancestors_or_self(asset_id)`) from `dcdash/core/tree.py`; `EnergyResult`, `HourEnergy` from `dcdash/core/energy.py`; `validate_whole_hour_zone(tz_name)` (raises `ValueError`) from `dcdash/core/timeutil.py`.
- Consumes (existing): `audit(db, user_id, action, detail)` (`core/audit.py`), `require_role`, `get_db` (`api/deps.py`), `current_timezone(db)` (`api/settings.py`), `get_setting`, `set_setting` (`core/settings_store.py`).
- Produces `core/cost.py` (exactly the contract): `TariffRow`, `HourCost`, `Cost`, `load_tariffs(db)`, `rate_at(tariffs, tree, asset_id, local_day)`, `cost_by_hour(energy, tariffs, tree, tz_name)`, `summarize(hours)`.
- Produces `core/settings_store.py`: `BILLING_KEY = "billing"`, `is_currency_code(value) -> bool`, `get_currency(db) -> str | None`.
- Produces HTTP: `GET/PUT /api/settings/billing` (admin); `GET /api/site` (viewer); `GET /api/tariffs` (operator), `POST/PATCH/DELETE /api/tariffs[/{id}]` (admin); `PUT /api/settings/general` now 422 for a zone without whole-hour offsets in January and July. Audit actions `billing.currency_changed` (detail `{"from", "to"}`), `tariff.created|updated|deleted` (detail `{tariff_id, asset_id, rate_per_kwh, effective_from}`). No `notify(CONFIG_CHANNEL)` anywhere.

- [ ] **Step 1: Check the prerequisites (read-only, no edits)**

```bash
git log --oneline -6
grep -n "class Tariff" -A 12 backend/dcdash/core/models.py
grep -n "rate_per_kwh\|UniqueConstraint\|unique\|tariffs" backend/migrations/versions/0004_billing_dashboards.py
grep -n "def validate_whole_hour_zone" backend/dcdash/core/timeutil.py
grep -n "class EnergyResult\|class HourEnergy\|async def hourly_energy" backend/dcdash/core/energy.py
grep -n "def children\|def ancestors_or_self" backend/dcdash/core/tree.py
grep -rnE "Kolkata|Kathmandu|St_Johns|Adelaide|Tehran|Lord_Howe|Darwin|Yangon" backend/tests frontend/src frontend/e2e scripts compose.yaml deploy
```

Pass/fail criteria. If a criterion fails, STOP and report `BLOCKED: <which criterion>` to the controller; do not edit Task 1's migration or models yourself (a change there would not reach a database that already ran `0004`).
- `Tariff` exists with the columns above, and `rate_per_kwh` is `Numeric(13, 6)` or wider (or an unconstrained `Numeric`). The contract allows a rate of exactly `1000000`, which needs 7 integer digits plus 6 decimals; at `Numeric(12, 6)` the boundary test below would get a 500 instead of 201.
- `AssetTree.children` and `ancestors_or_self`, `validate_whole_hour_zone`, `EnergyResult`, `HourEnergy` exist (Task 2).
- The last grep prints nothing. (When this plan was written it printed nothing: the only zones used anywhere in tests, e2e and scripts are `UTC`, `Asia/Qatar`, `Asia/Dubai` and `Europe/Amsterdam`, so no existing expectation changes with the new 422. A hit means that test or script PUTs a half-hour zone and must be changed to a whole-hour zone, with the reason in the commit message.)
- Informational: Task 1 declares `UNIQUE NULLS NOT DISTINCT (asset_id, effective_from)` and `rate_per_kwh numeric(13,6) CHECK (0..1000000)`. The database rounds a 7th decimal silently, so `tariffs.py` enforces "at most 6 decimals" and the 422 rules itself, and it checks duplicates first with `IS NOT DISTINCT FROM` for a clean 409; the `IntegrityError` handler is only a backstop for races.

- [ ] **Step 2: Write the failing cost-engine tests**

`backend/tests/test_cost.py` (pure unit tests except the last one: the tree is the real in-memory `AssetTree`, built from nodes as Task 2 allows, so no database is involved):

```python
from datetime import date, datetime, timezone

import pytest

from dcdash.core.cost import Cost, HourCost, TariffRow, cost_by_hour, load_tariffs, rate_at, summarize
from dcdash.core.db import get_sessionmaker
from dcdash.core.energy import EnergyResult, HourEnergy
from dcdash.core.tree import AssetNode, AssetTree
from helpers import make_asset

UTC = timezone.utc
ROOT, MV2, PANEL1, PANEL2 = 1, 2, 3, 4
ASSETS = (ROOT, MV2, PANEL1, PANEL2)


# Root(1) -> MV2(2) -> LV Panel 1(3), LV Panel 2(4)
TREE = AssetTree([
    AssetNode(ROOT, None, "Site", 0),
    AssetNode(MV2, ROOT, "MV2", 0),
    AssetNode(PANEL1, MV2, "LV Panel 1", 0),
    AssetNode(PANEL2, MV2, "LV Panel 2", 0),
])


def hour(day: int, h: int) -> datetime:
    return datetime(2026, 10, day, h, tzinfo=UTC)


def metered(*pairs, estimated: bool = False) -> dict[datetime, HourEnergy]:
    return {bucket: HourEnergy(kwh, estimated) for bucket, kwh in pairs}


def engine(meters: dict[int, dict[datetime, HourEnergy]]) -> EnergyResult:
    """What hourly_energy returns when only the assets in `meters` have their own meter:
    their parents sum them, assets with nothing underneath are None."""
    figures: dict[int, dict[datetime, HourEnergy] | None] = {asset: None for asset in ASSETS}
    figures.update(meters)
    children = [figures[a] for a in (PANEL1, PANEL2) if figures[a] is not None]
    summed: dict[datetime, HourEnergy] = {}
    for child in children:
        for bucket, h in child.items():
            before = summed.get(bucket)
            summed[bucket] = HourEnergy(
                (before.kwh if before else 0.0) + h.kwh, bool(before and before.estimated) or h.estimated
            )
    if children and MV2 not in meters:
        figures[MV2] = figures[ROOT] = summed
    return EnergyResult(hours=figures, own=frozenset(meters))


def test_rate_at_takes_the_latest_row_on_or_before_the_day():
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1)), TariffRow(None, 0.12, date(2026, 6, 1))]
    for rows in (tariffs, list(reversed(tariffs))):  # input order must not matter
        assert rate_at(rows, TREE, PANEL1, date(2025, 12, 31)) is None
        assert rate_at(rows, TREE, PANEL1, date(2026, 1, 1)) == 0.10
        assert rate_at(rows, TREE, PANEL1, date(2026, 5, 31)) == 0.10
        assert rate_at(rows, TREE, PANEL1, date(2026, 6, 1)) == 0.12
    assert rate_at([], TREE, PANEL1, date(2026, 6, 1)) is None


def test_a_child_override_beats_the_site_default_only_from_its_own_date():  # Review Focus 3
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1)), TariffRow(PANEL1, 0.20, date(2026, 10, 3))]
    assert rate_at(tariffs, TREE, PANEL1, date(2026, 10, 2)) == 0.10  # earlier days keep the inherited rate
    assert rate_at(tariffs, TREE, PANEL1, date(2026, 10, 3)) == 0.20
    assert rate_at(tariffs, TREE, PANEL2, date(2026, 10, 3)) == 0.10  # a sibling is untouched
    assert rate_at(tariffs, TREE, MV2, date(2026, 10, 3)) == 0.10  # and so is the parent


def test_the_nearest_ancestor_with_a_row_in_effect_wins():  # Review Focus 3
    tariffs = [
        TariffRow(None, 0.10, date(2026, 1, 1)),
        TariffRow(MV2, 0.15, date(2026, 9, 1)),
        TariffRow(PANEL1, 0.20, date(2026, 10, 3)),
        TariffRow(ROOT, 0.99, date(2026, 12, 1)),  # not in effect yet: skipped, never used early
    ]
    assert rate_at(tariffs, TREE, PANEL1, date(2026, 10, 2)) == 0.15  # its own row has not started; MV2's applies
    assert rate_at(tariffs, TREE, PANEL1, date(2026, 10, 3)) == 0.20
    assert rate_at(tariffs, TREE, PANEL2, date(2026, 10, 3)) == 0.15
    assert rate_at(tariffs, TREE, MV2, date(2026, 8, 31)) == 0.10  # before MV2's own row: the site default
    assert rate_at(tariffs, TREE, ROOT, date(2026, 10, 3)) == 0.10
    assert rate_at(tariffs, TREE, ROOT, date(2026, 12, 1)) == 0.99


def test_no_tariff_means_cost_none_never_zero():  # Review Focus 3
    energy = engine({PANEL1: metered((hour(2, 10), 4.0), (hour(2, 11), 6.0))})
    costs = cost_by_hour(energy, [], TREE, "UTC")
    leaf = costs[PANEL1]
    assert [h.cost for h in leaf.values()] == [None, None]
    assert all(h.unpriced for h in leaf.values())
    assert all(h.cost is None for h in costs[MV2].values())
    assert summarize(leaf.values()) == Cost(kwh=10.0, cost=None, estimated=False, partial=True)


def test_a_rate_that_starts_mid_period_leaves_the_earlier_hours_unpriced():  # Review Focus 3
    tariffs = [TariffRow(None, 0.5, date(2026, 10, 3))]
    before = datetime(2026, 10, 2, 20, tzinfo=UTC)  # Asia/Qatar is UTC+3: 23:00 on the 2nd
    midnight = datetime(2026, 10, 2, 21, tzinfo=UTC)  # 00:00 on the 3rd
    energy = engine({PANEL1: metered((before, 2.0), (midnight, 4.0), (hour(3, 9), 6.0))})
    leaf = cost_by_hour(energy, tariffs, TREE, "Asia/Qatar")[PANEL1]
    assert leaf[before] == HourCost(kwh=2.0, cost=None, estimated=False, unpriced=True)
    assert leaf[midnight] == HourCost(kwh=4.0, cost=2.0, estimated=False, unpriced=False)
    assert leaf[hour(3, 9)] == HourCost(kwh=6.0, cost=3.0, estimated=False, unpriced=False)
    assert summarize(leaf.values()) == Cost(kwh=12.0, cost=5.0, estimated=False, partial=True)


def test_a_child_override_prices_from_its_date_and_earlier_hours_keep_the_inherited_rate():  # Review Focus 3
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1)), TariffRow(PANEL1, 0.20, date(2026, 10, 3))]
    energy = engine({PANEL1: metered((hour(2, 23), 10.0), (hour(3, 0), 10.0))})
    leaf = cost_by_hour(energy, tariffs, TREE, "UTC")[PANEL1]
    assert leaf[hour(2, 23)].cost == pytest.approx(1.0)
    assert leaf[hour(3, 0)].cost == pytest.approx(2.0)


def test_a_parent_without_a_meter_sums_its_children_including_a_child_override():  # Review Focus 3
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1)), TariffRow(PANEL2, 0.50, date(2026, 10, 1))]
    energy = engine({
        PANEL1: metered((hour(3, 9), 10.0)),
        PANEL2: metered((hour(3, 9), 2.0), estimated=True),
    })
    costs = cost_by_hour(energy, tariffs, TREE, "UTC")
    for parent in (MV2, ROOT):
        figure = costs[parent][hour(3, 9)]
        assert figure.kwh == pytest.approx(12.0)
        assert figure.cost == pytest.approx(10 * 0.10 + 2 * 0.50)
        assert figure.estimated is True and figure.unpriced is False


def test_a_parent_is_partial_when_one_child_has_no_rate():  # Review Focus 3
    tariffs = [TariffRow(PANEL2, 0.50, date(2026, 10, 1))]  # no default: LV Panel 1 has no rate at all
    energy = engine({PANEL1: metered((hour(3, 9), 10.0)), PANEL2: metered((hour(3, 9), 2.0))})
    costs = cost_by_hour(energy, tariffs, TREE, "UTC")
    figure = costs[MV2][hour(3, 9)]
    assert figure.cost == pytest.approx(1.0) and figure.unpriced is True
    assert summarize(costs[MV2].values()) == Cost(kwh=12.0, cost=pytest.approx(1.0), estimated=False, partial=True)


def test_an_hour_with_no_consumption_and_no_rate_is_not_partial():  # Review Focus 3
    energy = engine({PANEL1: metered((hour(3, 9), 0.0))})
    leaf = cost_by_hour(energy, [], TREE, "UTC")[PANEL1]
    assert leaf[hour(3, 9)] == HourCost(kwh=0.0, cost=None, estimated=False, unpriced=False)
    assert summarize(leaf.values()) == Cost(kwh=0.0, cost=None, estimated=False, partial=False)


def test_zero_kwh_with_a_rate_costs_zero_not_none():  # Review Focus 3
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1))]
    leaf = cost_by_hour(engine({PANEL1: metered((hour(3, 9), 0.0))}), tariffs, TREE, "UTC")[PANEL1]
    assert leaf[hour(3, 9)].cost == 0.0 and leaf[hour(3, 9)].cost is not None
    assert summarize(leaf.values()) == Cost(kwh=0.0, cost=0.0, estimated=False, partial=False)


def test_assets_without_an_energy_figure_stay_none():
    costs = cost_by_hour(engine({}), [TariffRow(None, 0.10, date(2026, 1, 1))], TREE, "UTC")
    assert costs == {ROOT: None, MV2: None, PANEL1: None, PANEL2: None}


def test_a_parent_skips_children_that_have_no_figure():
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1))]
    costs = cost_by_hour(engine({PANEL1: metered((hour(3, 9), 5.0))}), tariffs, TREE, "UTC")
    assert costs[PANEL2] is None
    assert costs[MV2][hour(3, 9)].cost == pytest.approx(0.5)


def test_a_meter_with_no_readings_is_an_empty_figure_not_none():
    costs = cost_by_hour(engine({PANEL1: {}}), [TariffRow(None, 0.10, date(2026, 1, 1))], TREE, "UTC")
    assert costs[PANEL1] == {} and costs[MV2] == {}
    assert summarize(costs[PANEL1].values()) == Cost(kwh=0.0, cost=None, estimated=False, partial=False)


def test_a_parent_with_its_own_meter_is_priced_from_that_meter_not_its_children():
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1))]
    energy = EnergyResult(
        hours={
            ROOT: metered((hour(3, 9), 7.0)),  # no meter of its own: the engine gives it MV2's hours
            MV2: metered((hour(3, 9), 7.0)),
            PANEL1: metered((hour(3, 9), 3.0)),
            PANEL2: None,
        },
        own=frozenset({MV2, PANEL1}),
    )
    costs = cost_by_hour(energy, tariffs, TREE, "UTC")
    assert costs[MV2][hour(3, 9)].kwh == 7.0
    assert costs[MV2][hour(3, 9)].cost == pytest.approx(0.7)  # MV2's meter, not PANEL1's 3 kWh
    assert costs[ROOT][hour(3, 9)].cost == pytest.approx(0.7)  # the root sums its only child, MV2


def test_estimated_hours_make_the_figure_estimated():
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1))]
    energy = engine({PANEL1: metered((hour(3, 9), 4.0), estimated=True)})
    leaf = cost_by_hour(energy, tariffs, TREE, "UTC")[PANEL1]
    assert summarize(leaf.values()) == Cost(kwh=4.0, cost=pytest.approx(0.4), estimated=True, partial=False)


def test_summarize_adds_priced_hours_and_flags_estimates_and_gaps():
    figure = summarize([
        HourCost(1.0, 0.5, False, False),
        HourCost(2.0, None, True, True),
        HourCost(0.0, None, False, False),
    ])
    assert figure == Cost(kwh=3.0, cost=0.5, estimated=True, partial=True)


def test_summarize_of_nothing_is_a_dash_not_zero():
    assert summarize([]) == Cost(kwh=0.0, cost=None, estimated=False, partial=False)


async def test_load_tariffs_returns_every_row_as_plain_values(db):
    asset = await make_asset(db, "LV Panel 1")
    await db.execute(
        "INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) "
        "VALUES (NULL, 0.125, DATE '2026-01-01'), ($1, 0.2, DATE '2026-10-03')",
        asset,
    )
    async with get_sessionmaker()() as session:
        rows = await load_tariffs(session)
    assert sorted(rows, key=lambda r: r.effective_from) == [
        TariffRow(None, 0.125, date(2026, 1, 1)),
        TariffRow(asset, 0.2, date(2026, 10, 3)),
    ]
```

- [ ] **Step 3: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_cost.py -v`
Expected: collection error `ModuleNotFoundError: No module named 'dcdash.core.cost'`.

- [ ] **Step 4: Implement the cost engine**

`backend/dcdash/core/cost.py`:

```python
"""Prices the energy engine's hourly kWh with the tariff in effect (spec 10.2).

Everything here is pure except `load_tariffs`. A figure with no rate is None, never zero:
`HourCost.unpriced` marks an hour that consumed energy but had no rate, and `summarize` turns
those into `partial`. An hour with no consumption never makes a figure partial.
"""
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.energy import EnergyResult, HourEnergy
from dcdash.core.models import Tariff
from dcdash.core.tree import AssetTree


@dataclass(frozen=True)
class TariffRow:
    asset_id: int | None  # None = the site default
    rate_per_kwh: float
    effective_from: date


@dataclass(frozen=True)
class HourCost:
    kwh: float
    cost: float | None  # None when no rate applied in that hour
    estimated: bool
    unpriced: bool  # kwh > 0 and cost is None


@dataclass(frozen=True)
class Cost:
    kwh: float
    cost: float | None  # None when no hour of the period has a rate
    estimated: bool
    partial: bool  # some hour with consumption had no rate


async def load_tariffs(db: AsyncSession) -> list[TariffRow]:
    rows = await db.scalars(select(Tariff).order_by(Tariff.id))
    return [TariffRow(t.asset_id, float(t.rate_per_kwh), t.effective_from) for t in rows]


def rate_at(tariffs: Sequence[TariffRow], tree: AssetTree, asset_id: int, local_day: date) -> float | None:
    """The nearest ancestor-or-self with a row in effect on `local_day` (its latest such row), else the
    site default's, else None. A row that has not started yet is ignored, so an override takes over only
    from its own effective date and earlier days keep the inherited rate."""
    latest: dict[int | None, TariffRow] = {}
    for row in tariffs:
        if row.effective_from <= local_day:
            known = latest.get(row.asset_id)
            if known is None or row.effective_from > known.effective_from:
                latest[row.asset_id] = row
    for owner in tree.ancestors_or_self(asset_id):
        if owner in latest:
            return latest[owner].rate_per_kwh
    site = latest.get(None)
    return None if site is None else site.rate_per_kwh


def _price(hour: HourEnergy, rate: float | None) -> HourCost:
    if rate is None:
        return HourCost(hour.kwh, None, hour.estimated, unpriced=hour.kwh > 0)
    return HourCost(hour.kwh, hour.kwh * rate, hour.estimated, unpriced=False)


def _add(a: float | None, b: float | None) -> float | None:
    if a is None:
        return b
    return a if b is None else a + b


def _sum_children(parts: Iterable[dict[datetime, HourCost] | None]) -> dict[datetime, HourCost]:
    merged: dict[datetime, HourCost] = {}
    for part in parts:
        if part is None:
            continue
        for bucket, hour in part.items():
            known = merged.get(bucket)
            merged[bucket] = hour if known is None else HourCost(
                kwh=known.kwh + hour.kwh,
                cost=_add(known.cost, hour.cost),
                estimated=known.estimated or hour.estimated,
                unpriced=known.unpriced or hour.unpriced,
            )
    return merged


def cost_by_hour(
    energy: EnergyResult, tariffs: Sequence[TariffRow], tree: AssetTree, tz_name: str
) -> dict[int, dict[datetime, HourCost] | None]:
    """Assets with their own meter: kwh * the rate on that hour's local date. Other assets: the sum of
    their children's hours (cost None only where every child's is None; unpriced if any child's is).
    None wherever the engine has no figure."""
    zone = ZoneInfo(tz_name)
    rates: dict[tuple[int, date], float | None] = {}
    done: dict[int, dict[datetime, HourCost] | None] = {}

    def rate(asset_id: int, bucket: datetime) -> float | None:
        key = (asset_id, bucket.astimezone(zone).date())
        if key not in rates:
            rates[key] = rate_at(tariffs, tree, asset_id, key[1])
        return rates[key]

    def priced(asset_id: int) -> dict[datetime, HourCost] | None:
        if asset_id not in done:
            hours = energy.hours.get(asset_id)
            if hours is None:
                done[asset_id] = None
            elif asset_id in energy.own:
                done[asset_id] = {bucket: _price(hour, rate(asset_id, bucket)) for bucket, hour in hours.items()}
            else:
                done[asset_id] = _sum_children(priced(child) for child in tree.children(asset_id))
        return done[asset_id]

    return {asset_id: priced(asset_id) for asset_id in energy.hours}


def summarize(hours: Iterable[HourCost]) -> Cost:
    """kwh = sum; cost = sum of the priced hours (None if there are none); estimated = any hour; partial =
    any hour that consumed energy without a rate."""
    kwh, cost, estimated, partial = 0.0, None, False, False
    for hour in hours:
        kwh += hour.kwh
        cost = _add(cost, hour.cost)
        estimated = estimated or hour.estimated
        partial = partial or hour.unpriced
    return Cost(kwh, cost, estimated, partial)
```

- [ ] **Step 5: Run the cost tests, then write the failing settings, site and currency tests**

Run: `cd backend && uv run pytest tests/test_cost.py -v`
Expected: PASS (18 tests).

Append to `backend/tests/test_settings_store.py` (and change its line `from dcdash.core.settings_store import get_setting, set_setting` to `from dcdash.core.settings_store import BILLING_KEY, get_currency, get_setting, set_setting`):

```python
async def test_get_currency_is_none_until_set_and_round_trips(db):
    async with get_sessionmaker()() as session:
        assert await get_currency(session) is None
        await set_setting(session, BILLING_KEY, {"currency": "QAR"})
        await session.commit()
        assert await get_currency(session) == "QAR"
        await set_setting(session, BILLING_KEY, {"currency": None})
        await session.commit()
        assert await get_currency(session) is None


async def test_get_currency_ignores_a_value_that_is_not_a_valid_code(db):
    async with get_sessionmaker()() as session:
        for junk in ("qar", "", "QARR", 5):
            await set_setting(session, BILLING_KEY, {"currency": junk})
            await session.commit()
            assert await get_currency(session) is None
```

Append to `backend/tests/test_api_settings.py` (it already imports `pytest`, `login_as`):

```python
async def test_billing_settings_are_admin_only(client, db):
    assert (await client.get("/api/settings/billing")).status_code == 401
    assert (await client.put("/api/settings/billing", json={"currency": "QAR"})).status_code == 401
    for role in ("viewer", "operator"):
        await login_as(client, db, role)
        assert (await client.get("/api/settings/billing")).status_code == 403
        assert (await client.put("/api/settings/billing", json={"currency": "QAR"})).status_code == 403
    await login_as(client, db)
    assert (await client.get("/api/settings/billing")).json() == {"currency": None}
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'billing.currency_changed'") == 0


async def test_currency_round_trips_and_can_be_cleared(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/billing", json={"currency": "QAR"})).json() == {"currency": "QAR"}
    assert (await client.get("/api/settings/billing")).json() == {"currency": "QAR"}
    assert (await client.put("/api/settings/billing", json={"currency": None})).json() == {"currency": None}
    assert (await client.get("/api/settings/billing")).json() == {"currency": None}


@pytest.mark.parametrize("bad", ["qar", "QA", "QARR", "Q1R", "", " QAR", "QAR\n", "ÄÖÜ", 123])
async def test_bad_currency_codes_are_rejected(client, db, bad):
    await login_as(client, db)
    assert (await client.put("/api/settings/billing", json={"currency": "USD"})).status_code == 200
    assert (await client.put("/api/settings/billing", json={"currency": bad})).status_code == 422
    assert (await client.put("/api/settings/billing", json={})).status_code == 422  # the key is required
    assert (await client.get("/api/settings/billing")).json() == {"currency": "USD"}


async def test_currency_changes_are_audited_once_per_actual_change(client, db):
    await login_as(client, db)
    admin_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    for code in ("QAR", "QAR", "USD", None, None):
        assert (await client.put("/api/settings/billing", json={"currency": code})).status_code == 200
    rows = await db.fetch(
        "SELECT user_id, detail FROM audit_log WHERE action = 'billing.currency_changed' ORDER BY id"
    )
    assert [r["detail"] for r in rows] == [
        {"from": None, "to": "QAR"}, {"from": "QAR", "to": "USD"}, {"from": "USD", "to": None},
    ]
    assert all(r["user_id"] == admin_id for r in rows)


@pytest.mark.parametrize("zone", ["Asia/Kolkata", "Asia/Kathmandu", "Australia/Lord_Howe", "America/St_Johns"])
async def test_put_refuses_a_zone_without_whole_hour_offsets(client, db, zone):
    await login_as(client, db)
    response = await client.put("/api/settings/general", json={"timezone": zone})
    assert response.status_code == 422 and "timezone" in response.text
    assert (await client.get("/api/settings/general")).json() == {"timezone": "UTC"}
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'general'") == 0


@pytest.mark.parametrize("zone", ["UTC", "Asia/Qatar", "Europe/Berlin"])
async def test_put_accepts_zones_with_whole_hour_offsets(client, db, zone):
    await login_as(client, db)
    response = await client.put("/api/settings/general", json={"timezone": zone})
    assert response.status_code == 200 and response.json() == {"timezone": zone}


async def test_get_still_answers_for_a_stored_zone_that_breaks_the_whole_hour_rule(client, db):
    """Billing answers 409 for such a zone, but Settings must still load so the admin can fix it."""
    await login_as(client, db)
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('general', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"timezone": "Asia/Kolkata"},
    )
    response = await client.get("/api/settings/general")
    assert response.status_code == 200 and response.json() == {"timezone": "Asia/Kolkata"}
    assert (await client.put("/api/settings/general", json={"timezone": "Asia/Qatar"})).status_code == 200
```

`backend/tests/test_api_site.py`:

```python
from helpers import login_as


async def test_site_needs_a_login_and_is_open_to_every_role(client, db):
    assert (await client.get("/api/site")).status_code == 401
    for role in ("viewer", "operator", "admin"):
        await login_as(client, db, role)
        response = await client.get("/api/site")
        assert response.status_code == 200, role
        assert response.json() == {"timezone": "UTC", "currency": None}


async def test_site_reports_the_stored_zone_and_currency(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/general", json={"timezone": "Asia/Qatar"})).status_code == 200
    assert (await client.put("/api/settings/billing", json={"currency": "QAR"})).status_code == 200
    await login_as(client, db, "viewer")
    assert (await client.get("/api/site")).json() == {"timezone": "Asia/Qatar", "currency": "QAR"}


async def test_site_still_answers_for_a_stored_zone_that_breaks_the_whole_hour_rule(client, db):
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('general', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"timezone": "Asia/Kolkata"},
    )
    await login_as(client, db, "viewer")
    assert (await client.get("/api/site")).json() == {"timezone": "Asia/Kolkata", "currency": None}
```

Run: `cd backend && uv run pytest tests/test_settings_store.py tests/test_api_settings.py tests/test_api_site.py -v`
Expected: FAIL: `ImportError: cannot import name 'BILLING_KEY'` for the store tests; `404` on `/api/settings/billing` and `/api/site`; the half-hour-zone PUTs return 200 instead of 422.

- [ ] **Step 6: Implement settings, currency and site**

`backend/dcdash/core/settings_store.py` (whole file):

```python
"""Runtime settings in the `settings` table (key TEXT PRIMARY KEY, value JSONB).

Shared by /api/settings/general, /api/settings/storage and /api/settings/billing.
Callers own the transaction: set_setting only flushes.
"""
import json
import re
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

GENERAL_KEY = "general"
BILLING_KEY = "billing"

_CURRENCY = re.compile(r"[A-Z]{3}")


def is_currency_code(value: object) -> bool:
    """Exactly three uppercase ASCII letters (fullmatch, so a trailing newline fails too)."""
    return isinstance(value, str) and _CURRENCY.fullmatch(value) is not None


async def get_setting(db: AsyncSession, key: str, default: dict[str, Any]) -> dict[str, Any]:
    """Return the JSON object stored under `key`, or a copy of `default` when absent."""
    row = await db.execute(text("SELECT value FROM settings WHERE key = :key"), {"key": key})
    value = row.scalar_one_or_none()
    if value is None:
        return dict(default)
    # asyncpg hands JSONB back as a str unless a codec is registered; SQLAlchemy's text() path
    # does not register one, so decode defensively.
    return dict(json.loads(value) if isinstance(value, str) else value)


async def set_setting(db: AsyncSession, key: str, value: dict[str, Any]) -> None:
    """Upsert `value` under `key`. Does not commit."""
    await db.execute(
        text(
            "INSERT INTO settings (key, value) VALUES (:key, CAST(:value AS jsonb)) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
        ),
        {"key": key, "value": json.dumps(value)},
    )


async def get_currency(db: AsyncSession) -> str | None:
    """The site currency, or None when unset (or when the stored value is not a valid code)."""
    value = (await get_setting(db, BILLING_KEY, {})).get("currency")
    return value if is_currency_code(value) else None
```

`backend/dcdash/api/settings.py` (whole file). The whole-hour rule is checked only on the PUT body (`GeneralSettingsIn`), never when reading what is stored, because `GET` builds `GeneralSettings` from the stored row and a stored half-hour zone must not turn Settings into a 500:

```python
"""General and billing runtime settings. /api/settings/storage lives in api/storage.py using the same store."""
import logging
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.audit import audit
from dcdash.core.config import get_settings
from dcdash.core.models import User
from dcdash.core.settings_store import (
    BILLING_KEY, GENERAL_KEY, get_currency, get_setting, is_currency_code, set_setting,
)
from dcdash.core.timeutil import validate_whole_hour_zone

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["settings"], dependencies=[Depends(require_role("admin"))])


class GeneralSettings(BaseModel):
    timezone: str

    @field_validator("timezone")
    @classmethod
    def _known(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError(f"unknown timezone: {value}") from None
        return value


class GeneralSettingsIn(GeneralSettings):
    """The PUT body: also refuses a zone whose UTC offset in January or July is not a whole hour."""

    @field_validator("timezone")
    @classmethod
    def _whole_hour(cls, value: str) -> str:
        validate_whole_hour_zone(value)  # ValueError -> 422 with its message
        return value


class BillingSettings(BaseModel):
    currency: str | None  # the key is required; null clears the currency

    @field_validator("currency")
    @classmethod
    def _code(cls, value: str | None) -> str | None:
        if value is not None and not is_currency_code(value):
            raise ValueError("currency must be three uppercase letters such as QAR, or null")
        return value


def _default() -> dict[str, str]:
    return {"timezone": get_settings().timezone}


async def _general(db: AsyncSession) -> dict[str, str]:
    """The stored general settings, with a timezone that no longer resolves replaced by the env default."""
    row = dict(await get_setting(db, GENERAL_KEY, _default()))
    try:
        ZoneInfo(str(row["timezone"]))
    except (ZoneInfoNotFoundError, ValueError):
        log.warning("stored timezone %r is unknown; falling back to %s", row["timezone"], _default()["timezone"])
        row["timezone"] = _default()["timezone"]
    return row


async def current_timezone(db: AsyncSession) -> str:
    """The timezone to use for day boundaries: DB value, else the env seed."""
    return str((await _general(db))["timezone"])


async def seed_general(db: AsyncSession) -> None:
    """Write the env timezone once, so the Settings page shows what the API uses."""
    row = await get_setting(db, GENERAL_KEY, {})
    if "timezone" not in row:
        await set_setting(db, GENERAL_KEY, _default())
        await db.commit()


@router.get("/settings/general", response_model=GeneralSettings)
async def get_general(db: AsyncSession = Depends(get_db)) -> GeneralSettings:
    return GeneralSettings(**await _general(db))


@router.put("/settings/general", response_model=GeneralSettings)
async def put_general(body: GeneralSettingsIn, db: AsyncSession = Depends(get_db)) -> GeneralSettingsIn:
    await set_setting(db, GENERAL_KEY, body.model_dump())
    await db.commit()
    return body


@router.get("/settings/billing", response_model=BillingSettings)
async def get_billing(db: AsyncSession = Depends(get_db)) -> BillingSettings:
    return BillingSettings(currency=await get_currency(db))


@router.put("/settings/billing", response_model=BillingSettings)
async def put_billing(
    body: BillingSettings,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> BillingSettings:
    before = await get_currency(db)
    await set_setting(db, BILLING_KEY, {"currency": body.currency})
    if body.currency != before:
        await audit(db, admin.id, "billing.currency_changed", {"from": before, "to": body.currency})
    await db.commit()
    return body
```

`backend/dcdash/api/site.py`:

```python
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.settings import current_timezone
from dcdash.core.settings_store import get_currency

router = APIRouter(prefix="/api", tags=["site"], dependencies=[Depends(require_role("viewer"))])


class Site(BaseModel):
    timezone: str
    currency: str | None


@router.get("/site", response_model=Site)
async def get_site(db: AsyncSession = Depends(get_db)) -> Site:
    """The site timezone and currency; any signed-in user. Does not judge the stored zone."""
    return Site(timezone=await current_timezone(db), currency=await get_currency(db))
```

Register the `site` router now (the `tariffs` router in Step 9). In `backend/dcdash/api/main.py` replace the import block

```python
from dcdash.api import (
    assets, audit, auth, data, discovery, jobs, mappings, scans, settings, sources, storage, stream, users,
)
```

with

```python
from dcdash.api import (
    assets, audit, auth, data, discovery, jobs, mappings, scans, settings, site, sources, storage, stream,
    users,
)
```

and the last line of the router tuple `scans.router, discovery.router, audit.router,` with `scans.router, discovery.router, audit.router, site.router,`.

- [ ] **Step 7: Run to verify the settings, currency and site tests pass**

Run: `cd backend && uv run pytest tests/test_cost.py tests/test_settings_store.py tests/test_api_settings.py tests/test_api_site.py -v`
Expected: PASS.

- [ ] **Step 8: Write the failing tariff API tests**

`backend/tests/test_api_tariffs.py`:

```python
import asyncio

import pytest

from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset

SITE_DEFAULT = {"asset_id": None, "rate_per_kwh": 0.12, "effective_from": "2026-10-01"}


async def create(client, **overrides):
    response = await client.post("/api/tariffs", json={**SITE_DEFAULT, **overrides})
    assert response.status_code == 201, response.text
    return response.json()


async def tariff_audit(db):
    return await db.fetch("SELECT user_id, action, detail FROM audit_log WHERE action LIKE 'tariff.%' ORDER BY id")


async def test_roles_admin_writes_operator_reads_viewer_nothing(client, db):
    await db.execute("INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES (NULL, 0.12, DATE '2026-10-01')")
    tariff_id = await db.fetchval("SELECT id FROM tariffs")
    writes = (
        ("post", "/api/tariffs", {**SITE_DEFAULT, "effective_from": "2026-11-01"}),
        ("patch", f"/api/tariffs/{tariff_id}", {"rate_per_kwh": 0.2}),
        ("delete", f"/api/tariffs/{tariff_id}", None),
    )

    async def send(method, url, body):
        return await getattr(client, method)(url, **({"json": body} if body is not None else {}))

    assert (await client.get("/api/tariffs")).status_code == 401
    for call in writes:
        assert (await send(*call)).status_code == 401, call[:2]

    for role, expected_get in (("viewer", 403), ("operator", 200)):
        await login_as(client, db, role)
        assert (await client.get("/api/tariffs")).status_code == expected_get, role
        for call in writes:
            assert (await send(*call)).status_code == 403, (role, call[:2])
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 1
    assert float(await db.fetchval("SELECT rate_per_kwh FROM tariffs")) == 0.12
    assert await tariff_audit(db) == []

    await login_as(client, db, "admin")
    assert (await client.get("/api/tariffs")).status_code == 200
    assert [(await send(*call)).status_code for call in writes] == [201, 200, 204]


async def test_create_returns_the_tariff_with_the_asset_name(client, db):
    await login_as(client, db)
    panel = await make_asset(db, "LV Panel 1")
    tariff = await create(client, asset_id=panel, rate_per_kwh=0.2, effective_from="2026-10-03")
    assert tariff["asset_id"] == panel and tariff["asset_name"] == "LV Panel 1"
    assert tariff["rate_per_kwh"] == 0.2 and tariff["effective_from"] == "2026-10-03"
    default = await create(client)
    assert default["asset_id"] is None and default["asset_name"] is None


async def test_list_orders_site_default_first_then_asset_name_then_newest_first(client, db):
    await login_as(client, db)
    b = await make_asset(db, "B Panel")
    a = await make_asset(db, "A Panel")
    await create(client, effective_from="2026-01-01", rate_per_kwh=0.10)
    await create(client, effective_from="2026-07-01", rate_per_kwh=0.11)
    await create(client, asset_id=b, effective_from="2026-03-01", rate_per_kwh=0.2)
    await create(client, asset_id=a, effective_from="2026-02-01", rate_per_kwh=0.3)
    await create(client, asset_id=a, effective_from="2026-09-01", rate_per_kwh=0.35)
    rows = (await client.get("/api/tariffs")).json()
    assert [(r["asset_name"], r["effective_from"]) for r in rows] == [
        (None, "2026-07-01"), (None, "2026-01-01"),
        ("A Panel", "2026-09-01"), ("A Panel", "2026-02-01"), ("B Panel", "2026-03-01"),
    ]
    assert set(rows[0]) == {"id", "asset_id", "asset_name", "rate_per_kwh", "effective_from", "created_by", "created_at"}
    assert rows[0]["rate_per_kwh"] == 0.11
    assert rows[0]["created_by"] == await db.fetchval("SELECT id FROM users WHERE username = 'admin'")


@pytest.mark.parametrize(
    "rate,word",
    [
        (-0.01, "negative"), (-1, "negative"), (0.1234567, "6 decimals"), (1e-7, "6 decimals"),
        (0.0000005, "6 decimals"), (1000000.01, "1000000"), (1000001, "1000000"), (1e30, "1000000"),
        ("0.12", "number"), (True, "number"), (None, "number"),
    ],
)
async def test_bad_rates_are_rejected_with_a_readable_reason(client, db, rate, word):
    await login_as(client, db)
    response = await client.post("/api/tariffs", json={**SITE_DEFAULT, "rate_per_kwh": rate})
    assert response.status_code == 422
    assert word in response.text
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 0


async def test_a_rate_of_nan_is_rejected(client, db):
    await login_as(client, db)
    response = await client.post(
        "/api/tariffs",
        content=b'{"asset_id": null, "rate_per_kwh": NaN, "effective_from": "2026-10-01"}',
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422


@pytest.mark.parametrize("rate", [0, 0.000001, 0.1, 999999.999999, 1000000])
async def test_boundary_rates_are_accepted(client, db, rate):
    await login_as(client, db)
    assert (await create(client, rate_per_kwh=rate))["rate_per_kwh"] == rate


@pytest.mark.parametrize("effective_from", ["2026-13-01", "2026-02-30", "yesterday", "", None])
async def test_bad_dates_are_rejected(client, db, effective_from):
    await login_as(client, db)
    response = await client.post("/api/tariffs", json={**SITE_DEFAULT, "effective_from": effective_from})
    assert response.status_code == 422
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 0


async def test_the_body_must_be_complete_and_free_of_unknown_keys(client, db):
    await login_as(client, db)
    for body in (
        {"rate_per_kwh": 0.12, "effective_from": "2026-10-01"},  # asset_id missing: null must be explicit
        {"asset_id": None, "effective_from": "2026-10-01"},
        {"asset_id": None, "rate_per_kwh": 0.12},
        {**SITE_DEFAULT, "currency": "QAR"},
    ):
        assert (await client.post("/api/tariffs", json=body)).status_code == 422, body


async def test_an_unknown_asset_is_404(client, db):
    await login_as(client, db)
    assert (await client.post("/api/tariffs", json={**SITE_DEFAULT, "asset_id": 999})).status_code == 404
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 0


async def test_one_rate_per_asset_or_site_default_and_date(client, db):
    await login_as(client, db)
    panel = await make_asset(db, "LV Panel 1")
    other = await make_asset(db, "LV Panel 2")
    await create(client)
    await create(client, asset_id=panel)
    assert (await client.post("/api/tariffs", json=SITE_DEFAULT)).status_code == 409  # two site defaults on one date
    assert (await client.post("/api/tariffs", json={**SITE_DEFAULT, "asset_id": panel})).status_code == 409
    await create(client, effective_from="2026-11-01")  # another date is fine
    await create(client, asset_id=other)  # so is another asset on the same date
    assert await db.fetchval("SELECT count(*) FROM tariffs") == 4


async def test_patch_changes_rate_and_date_but_never_the_asset(client, db):
    await login_as(client, db)
    panel = await make_asset(db, "LV Panel 1")
    tariff = await create(client, asset_id=panel)
    url = f"/api/tariffs/{tariff['id']}"
    patched = await client.patch(url, json={"rate_per_kwh": 0.2, "effective_from": "2026-10-15"})
    assert patched.status_code == 200
    assert patched.json() == {**tariff, "rate_per_kwh": 0.2, "effective_from": "2026-10-15"}
    assert (await client.patch(url, json={"rate_per_kwh": 0.25})).json()["effective_from"] == "2026-10-15"
    for body in (
        {"asset_id": None}, {"asset_id": panel}, {"rate_per_kwh": None}, {"effective_from": None},
        {"rate_per_kwh": -1}, {"rate_per_kwh": 0.1234567}, {"effective_from": "nope"},
    ):
        assert (await client.patch(url, json=body)).status_code == 422, body
    assert (await client.patch("/api/tariffs/999", json={"rate_per_kwh": 0.2})).status_code == 404
    stored = await db.fetchrow("SELECT asset_id, rate_per_kwh FROM tariffs")
    assert stored["asset_id"] == panel and float(stored["rate_per_kwh"]) == 0.25


async def test_patch_onto_an_existing_date_is_409_but_keeping_its_own_date_is_fine(client, db):
    await login_as(client, db)
    await create(client)
    later = await create(client, effective_from="2026-11-01")
    url = f"/api/tariffs/{later['id']}"
    assert (await client.patch(url, json={"effective_from": "2026-10-01"})).status_code == 409
    assert (await client.patch(url, json={"effective_from": "2026-11-01", "rate_per_kwh": 0.3})).status_code == 200


async def test_delete_removes_the_tariff(client, db):
    await login_as(client, db)
    tariff = await create(client)
    assert (await client.delete(f"/api/tariffs/{tariff['id']}")).status_code == 204
    assert (await client.delete(f"/api/tariffs/{tariff['id']}")).status_code == 404
    assert (await client.get("/api/tariffs")).json() == []


async def test_changes_are_audited_with_the_tariff_details(client, db):
    await login_as(client, db)
    admin_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    panel = await make_asset(db, "LV Panel 1")
    tariff = await create(client, asset_id=panel, rate_per_kwh=0.12, effective_from="2026-10-01")
    url = f"/api/tariffs/{tariff['id']}"
    await client.patch(url, json={"rate_per_kwh": 0.2, "effective_from": "2026-10-05"})
    await client.patch(url, json={})  # nothing changed: not audited
    await client.delete(url)
    rows = await tariff_audit(db)
    assert [r["action"] for r in rows] == ["tariff.created", "tariff.updated", "tariff.deleted"]
    assert all(r["user_id"] == admin_id for r in rows)
    assert rows[0]["detail"] == {
        "tariff_id": tariff["id"], "asset_id": panel, "rate_per_kwh": 0.12, "effective_from": "2026-10-01",
    }
    assert rows[1]["detail"] == {
        "tariff_id": tariff["id"], "asset_id": panel, "rate_per_kwh": 0.2, "effective_from": "2026-10-05",
    }
    assert rows[2]["detail"] == rows[1]["detail"]


async def test_failed_requests_leave_no_audit_row(client, db):
    await login_as(client, db)
    await create(client)
    await client.post("/api/tariffs", json=SITE_DEFAULT)  # 409
    await client.post("/api/tariffs", json={**SITE_DEFAULT, "asset_id": 999})  # 404
    await client.post("/api/tariffs", json={**SITE_DEFAULT, "rate_per_kwh": -1})  # 422
    await client.delete("/api/tariffs/999")  # 404
    assert [r["action"] for r in await tariff_audit(db)] == ["tariff.created"]


async def test_tariff_changes_do_not_wake_the_collector(client, db, database_url):
    await login_as(client, db)
    async with listening(database_url, CONFIG_CHANNEL) as received:
        tariff = await create(client)
        await client.patch(f"/api/tariffs/{tariff['id']}", json={"rate_per_kwh": 0.2})
        await client.delete(f"/api/tariffs/{tariff['id']}")
        # Notifications arrive in commit order, so if the API had sent one it would come before this sentinel.
        await db.execute("SELECT pg_notify($1, 'sentinel')", CONFIG_CHANNEL)
        assert await asyncio.wait_for(received.get(), timeout=5) == "sentinel"
        assert received.empty()


async def test_deleting_an_asset_deletes_its_tariffs(client, db):
    await login_as(client, db)
    panel = await make_asset(db, "LV Panel 1")
    await create(client)
    await create(client, asset_id=panel)
    assert (await client.delete(f"/api/assets/{panel}")).status_code == 204
    assert [r["asset_id"] for r in (await client.get("/api/tariffs")).json()] == [None]
```

Run: `cd backend && uv run pytest tests/test_api_tariffs.py -v`
Expected: FAIL: every request answers 404 (router not registered, module `dcdash.api.tariffs` missing).

- [ ] **Step 9: Implement the tariff API and register it**

`backend/dcdash/api/tariffs.py`. Rates are validated as exact decimals: a JSON float goes through `repr`, so `0.1234567` stays seven decimals and is refused. Duplicates are checked explicitly with `IS NOT DISTINCT FROM` (a unique index alone lets two site defaults, `asset_id` NULL, share a date); the `IntegrityError` handler is a backstop for races:

```python
"""Tariffs (spec 10.2): admins write, operators read. A tariff change only touches the database; it
sends no CONFIG_CHANNEL notification because the collector does not use tariffs."""
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.audit import audit
from dcdash.core.models import Asset, Tariff, User

router = APIRouter(prefix="/api", tags=["tariffs"])

MAX_RATE = Decimal(1_000_000)
RATE_STEP = Decimal("0.000001")
DUPLICATE = "a rate for this asset (or the site default) already starts on that date"


def parse_rate(value: object) -> Decimal:
    """A JSON number as an exact Decimal. Floats go through repr(), the shortest text that round-trips,
    so 0.1234567 is seen as seven decimals and refused."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("rate_per_kwh must be a number")
    number = Decimal(repr(value))
    if not number.is_finite():
        raise ValueError("rate_per_kwh must be a finite number")
    if number < 0:
        raise ValueError("rate_per_kwh must not be negative")
    if number > MAX_RATE:
        raise ValueError("rate_per_kwh must be at most 1000000")
    if number != number.quantize(RATE_STEP):
        raise ValueError("rate_per_kwh can have at most 6 decimals")
    return number


class TariffIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: int | None  # required; null = the site default
    rate_per_kwh: Decimal
    effective_from: date

    @field_validator("rate_per_kwh", mode="before")
    @classmethod
    def _rate(cls, value: object) -> Decimal:
        return parse_rate(value)


class TariffPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")  # the asset cannot change
    rate_per_kwh: Decimal | None = None
    effective_from: date | None = None

    @field_validator("rate_per_kwh", mode="before")
    @classmethod
    def _rate(cls, value: object) -> Decimal | None:
        return None if value is None else parse_rate(value)

    @model_validator(mode="after")
    def _no_nulls(self) -> "TariffPatch":
        for name in self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class TariffOut(BaseModel):
    id: int
    asset_id: int | None
    asset_name: str | None
    rate_per_kwh: float
    effective_from: date
    created_by: int | None
    created_at: datetime


def _out(tariff: Tariff, asset_name: str | None) -> TariffOut:
    return TariffOut(
        id=tariff.id,
        asset_id=tariff.asset_id,
        asset_name=asset_name,
        rate_per_kwh=float(tariff.rate_per_kwh),
        effective_from=tariff.effective_from,
        created_by=tariff.created_by,
        created_at=tariff.created_at,
    )


def _detail(tariff: Tariff) -> dict[str, Any]:
    return {
        "tariff_id": tariff.id,
        "asset_id": tariff.asset_id,
        "rate_per_kwh": float(tariff.rate_per_kwh),
        "effective_from": tariff.effective_from.isoformat(),
    }


async def _get(db: AsyncSession, tariff_id: int) -> Tariff:
    tariff = await db.get(Tariff, tariff_id)
    if tariff is None:
        raise HTTPException(404, "tariff not found")
    return tariff


async def _asset_name(db: AsyncSession, asset_id: int | None) -> str | None:
    return None if asset_id is None else await db.scalar(select(Asset.name).where(Asset.id == asset_id))


async def _taken(db: AsyncSession, asset_id: int | None, effective_from: date, ignore_id: int | None = None) -> bool:
    query = select(Tariff.id).where(
        Tariff.asset_id.is_not_distinct_from(asset_id), Tariff.effective_from == effective_from
    )
    if ignore_id is not None:
        query = query.where(Tariff.id != ignore_id)
    return await db.scalar(query.limit(1)) is not None


async def _flush(db: AsyncSession) -> None:
    try:
        await db.flush()
    except IntegrityError:  # a race with another admin; _taken catches the ordinary case
        await db.rollback()
        raise HTTPException(409, DUPLICATE) from None


@router.get("/tariffs", response_model=list[TariffOut], dependencies=[Depends(require_role("operator"))])
async def list_tariffs(db: AsyncSession = Depends(get_db)) -> list[TariffOut]:
    rows = await db.execute(
        select(Tariff, Asset.name)
        .outerjoin(Asset, Asset.id == Tariff.asset_id)
        .order_by(Tariff.asset_id.is_(None).desc(), Asset.name, Tariff.asset_id, Tariff.effective_from.desc())
    )
    return [_out(tariff, name) for tariff, name in rows]


@router.post("/tariffs", response_model=TariffOut, status_code=201)
async def create_tariff(
    body: TariffIn,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> TariffOut:
    asset_name = None
    if body.asset_id is not None:
        asset = await db.get(Asset, body.asset_id)
        if asset is None:
            raise HTTPException(404, "asset not found")
        asset_name = asset.name
    if await _taken(db, body.asset_id, body.effective_from):
        raise HTTPException(409, DUPLICATE)
    tariff = Tariff(
        asset_id=body.asset_id,
        rate_per_kwh=body.rate_per_kwh,
        effective_from=body.effective_from,
        created_by=admin.id,
    )
    db.add(tariff)
    await _flush(db)
    await audit(db, admin.id, "tariff.created", _detail(tariff))
    await db.commit()
    await db.refresh(tariff)
    return _out(tariff, asset_name)


@router.patch("/tariffs/{tariff_id}", response_model=TariffOut)
async def update_tariff(
    tariff_id: int,
    body: TariffPatch,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> TariffOut:
    tariff = await _get(db, tariff_id)
    changes = body.model_dump(exclude_unset=True)
    if "effective_from" in changes and await _taken(db, tariff.asset_id, changes["effective_from"], tariff.id):
        raise HTTPException(409, DUPLICATE)
    if changes:
        for field, value in changes.items():
            setattr(tariff, field, value)
        await _flush(db)
        await audit(db, admin.id, "tariff.updated", _detail(tariff))
        await db.commit()
    return _out(tariff, await _asset_name(db, tariff.asset_id))


@router.delete("/tariffs/{tariff_id}", status_code=204)
async def delete_tariff(
    tariff_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_role("admin")),
) -> None:
    tariff = await _get(db, tariff_id)
    detail = _detail(tariff)
    await db.delete(tariff)
    await audit(db, admin.id, "tariff.deleted", detail)
    await db.commit()
```

Register it in `backend/dcdash/api/main.py` (add `tariffs` to the import block and `tariffs.router` to the tuple). The finished block and tuple read:

```python
from dcdash.api import (
    assets, audit, auth, data, discovery, jobs, mappings, scans, settings, site, sources, storage, stream,
    tariffs, users,
)
```

```python
    for router in (
        auth.router, jobs.router, sources.router, assets.router,
        mappings.router, data.router, stream.router, users.router, settings.router, storage.router,
        scans.router, discovery.router, audit.router, site.router, tariffs.router,
    ):
```

- [ ] **Step 10: Run to verify everything passes**

Run: `cd backend && uv run pytest tests/test_cost.py tests/test_settings_store.py tests/test_api_settings.py tests/test_api_site.py tests/test_api_tariffs.py tests/test_api_assets.py -v` then `cd backend && uv run pytest -q`.
Expected: PASS, whole suite green. If `test_boundary_rates_are_accepted[1000000]` returns 500, the Task 1 column is too narrow (Step 1 criterion): report `BLOCKED`.

- [ ] **Step 11: Commit and push**

```bash
git add backend/dcdash/core/cost.py backend/dcdash/core/settings_store.py backend/dcdash/api/settings.py \
  backend/dcdash/api/site.py backend/dcdash/api/tariffs.py backend/dcdash/api/main.py \
  backend/tests/test_cost.py backend/tests/test_api_site.py backend/tests/test_api_tariffs.py \
  backend/tests/test_settings_store.py backend/tests/test_api_settings.py
git commit -m "feat: tariffs, site currency, GET /api/site and the cost engine

Settings now refuses a timezone without whole-hour UTC offsets (PUT only; GET still loads a stored one).
No existing assertion changed.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa"
git push origin phase-3-dashboards-billing
```

---
### Task 4: Billing API, CSV and the asset cost tile data

One CSV writer that cannot emit a formula, `GET /api/billing/costs` (+ `.csv`) for one month in the site timezone, and `cost_today` + `currency` on the asset summary. Review Focus 2 (daylight-saving days and month edges) and Review Focus 3 (missing rates never show as zero) are tested here through the API, using the engine of Task 2 and the pricing of Task 3.

**Files:**
- Create: `backend/dcdash/core/csvout.py`
- Create: `backend/dcdash/api/billing.py`
- Modify: `backend/dcdash/api/data.py` (two imports and the last block of `summary()`, as Task 2 left it)
- Modify: `backend/dcdash/api/main.py` (import and include `billing`)
- Test (create): `backend/tests/billing_helpers.py`, `backend/tests/test_csvout.py`, `backend/tests/test_api_billing.py`, `backend/tests/test_api_summary_cost.py`

**Interfaces:**
- Consumes (Task 2): `AssetTree.load(db)`, `.nodes[id]` (`AssetNode.parent_id`, `.name`), `.path(id)`, `.preorder()`; `hourly_energy(db, tree, start, end) -> EnergyResult`, `total(hours)`; `month_bounds(month, tz_name)`, `local_days(start, end, tz_name)`, `day_bounds(now, tz_name)`, `validate_whole_hour_zone(tz_name)` (every datetime they return is UTC; `local_days` yields `(local date, from, to)`); `settle_rollups(db)` in `tests/helpers.py`; `_now()` in `api/data.py` (the seam tests patch). `summary()` already computes `result = await hourly_energy(...)` over the site's whole local day (`day_bounds`) and `energy_today` from it.
- Consumes (Task 3): `Cost`, `HourCost`, `load_tariffs`, `rate_at`, `cost_by_hour`, `summarize` from `core/cost.py`; `get_currency` from `core/settings_store.py`; `current_timezone` from `api/settings.py`; table `tariffs`.
- Produces `core/csvout.py`: `safe_cell(value: object) -> str`, `write_csv(header: Sequence[str], rows: Iterable[Sequence[object]]) -> bytes`.
- Produces `api/billing.py`: `GET /api/billing/costs?month=YYYY-MM` and `GET /api/billing/costs.csv?month=YYYY-MM` (viewer), JSON and CSV shapes exactly as in the Interface Contracts; `_now() -> datetime` (the clock, patched in tests); `month_costs(db, month) -> dict`.
- Produces `api/data.py`: `GET /api/assets/{id}/summary` gains `"cost_today": {"cost": float | None, "estimated": bool, "partial": bool} | None` and `"currency": str | None` (existing keys unchanged).
- `safe_cell` rule, decided here for Task 6's widget CSV too: only text (`str`) is prefixed with an apostrophe when it starts with `=`, `+`, `-`, `@`, tab or CR. Typed numbers are never prefixed, so a negative reactive power of `-5.5` stays a number in the spreadsheet; the string `"-5"` is text and is prefixed.

- [ ] **Step 1: Check the prerequisites and read the current `summary()` (read-only, no edits)**

```bash
git log --oneline -8
grep -n "def month_bounds\|def local_days\|def validate_whole_hour_zone\|def day_start" backend/dcdash/core/timeutil.py
grep -n "def path\|def preorder\|async def load" backend/dcdash/core/tree.py
grep -n "async def hourly_energy\|^def total" backend/dcdash/core/energy.py
grep -n "^def \|^async def \|^class " backend/dcdash/core/cost.py
sed -n '/^async def summary/,/^@router.get("\/assets\/{asset_id}\/series")/p' backend/dcdash/api/data.py
```

Expected: all of those exist (Tasks 2 and 3 are done), and the end of `summary()` reads `start, end = day_bounds(_now(), await current_timezone(db))`, `result = await hourly_energy(db, await AssetTree.load(db), start, end)`, `energy = total(result.hours.get(asset_id))`, then the `return {...}`. Step 7 edits exactly those lines. If they read differently, keep Task 2's range and apply the same idea: one `hourly_energy` call whose `EnergyResult`, `AssetTree` and zone name also feed the cost.

- [ ] **Step 2: Write the failing CSV tests**

`backend/tests/test_csvout.py`:

```python
import csv
import io
from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from dcdash.core.csvout import safe_cell, write_csv

BOM = b"\xef\xbb\xbf"


@pytest.mark.parametrize("prefix", ["=", "+", "-", "@", "\t", "\r"])  # Review Focus 5
def test_text_starting_with_a_formula_character_gets_an_apostrophe(prefix):
    assert safe_cell(f"{prefix}1+1") == f"'{prefix}1+1"


def test_the_hyperlink_example_from_the_spec_is_neutralised():  # Review Focus 5
    assert safe_cell('=HYPERLINK("http://x","y")') == '\'=HYPERLINK("http://x","y")'


def test_plain_text_is_unchanged():
    assert safe_cell("LV Panel 1") == "LV Panel 1"
    assert safe_cell("1+1=2") == "1+1=2"  # only a leading character matters
    assert safe_cell("a-b@c") == "a-b@c"
    assert safe_cell("") == ""
    assert safe_cell("'already") == "'already"


def test_numbers_none_and_booleans_render_sanely():
    assert safe_cell(None) == ""
    assert safe_cell(True) == "true" and safe_cell(False) == "false"
    assert safe_cell(7) == "7" and safe_cell(-7) == "-7"
    assert safe_cell(12.5) == "12.5" and safe_cell(24.0) == "24" and safe_cell(0.0) == "0"
    assert safe_cell(0.1 + 0.2) == "0.3"  # no float noise
    assert safe_cell(0.0000004) == "0" and safe_cell(-0.0) == "0"
    assert safe_cell(Decimal("0.120000")) == "0.12"
    assert safe_cell(float("nan")) == "" and safe_cell(float("inf")) == ""


def test_a_negative_number_is_a_number_but_the_text_minus_five_is_text():
    assert safe_cell(-5.5) == "-5.5"
    assert safe_cell("-5") == "'-5"


def test_datetimes_and_dates_are_iso_8601_with_the_offset_they_carry():
    assert safe_cell(datetime(2026, 3, 1, 3, 0, tzinfo=ZoneInfo("Asia/Qatar"))) == "2026-03-01T03:00:00+03:00"
    assert safe_cell(date(2026, 3, 1)) == "2026-03-01"


def test_write_csv_has_a_bom_crlf_rows_and_quotes_only_where_needed():
    data = write_csv(["asset", "kwh", "cost"], [["LV Panel 1", 12.5, None], ["A, B", 1, True]])
    assert data == BOM + b'asset,kwh,cost\r\nLV Panel 1,12.5,\r\n"A, B",1,true\r\n'


def test_write_csv_with_no_rows_is_just_the_header():
    assert write_csv(["a", "b"], []) == BOM + b"a,b\r\n"


def test_every_cell_including_the_header_goes_through_safe_cell():  # Review Focus 5
    data = write_csv(["=bad", "ok"], [['=HYPERLINK("http://x","y")', "+1"], ["-2", "@sum"]])
    rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig"), newline="")))
    assert rows == [["'=bad", "ok"], ["'=HYPERLINK(\"http://x\",\"y\")", "'+1"], ["'-2", "'@sum"]]


def test_cells_with_quotes_commas_and_line_breaks_survive_a_round_trip():
    original = 'say "hi",\nthen leave'
    data = write_csv(["note"], [[original]])
    assert list(csv.reader(io.StringIO(data.decode("utf-8-sig"), newline=""))) == [["note"], [original]]
```

- [ ] **Step 3: Run to verify failure, implement, run to verify pass**

Run: `cd backend && uv run pytest tests/test_csvout.py -v`
Expected: collection error `ModuleNotFoundError: No module named 'dcdash.core.csvout'`.

`backend/dcdash/core/csvout.py`:

```python
"""CSV output that Excel opens cleanly and that cannot run as a formula (spec 10.6)."""
import csv
import io
import math
from collections.abc import Iterable, Sequence
from datetime import date, datetime
from decimal import Decimal

FORMULA_STARTS = ("=", "+", "-", "@", "\t", "\r")


def _number(value: int | float | Decimal) -> str:
    if isinstance(value, int):
        return str(value)
    number = float(value)
    if not math.isfinite(number):
        return ""
    text = f"{round(number, 6):.6f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def safe_cell(value: object) -> str:
    """One CSV cell as text.

    Text starting with = + - @ tab or CR gets a leading apostrophe, so a spreadsheet shows it instead of
    running it (asset names are typed by users). Typed numbers are never prefixed: -5.5 is a number, not
    text, and cannot carry a formula (the string "-5" is text and is prefixed). Numbers keep at most 6
    decimals; None, NaN and infinity are empty; booleans are true/false; datetimes and dates are ISO 8601
    (callers pass datetimes already converted to the site zone, so the offset is the site's).
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float, Decimal)):
        return _number(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    text = str(value)
    return "'" + text if text.startswith(FORMULA_STARTS) else text


def write_csv(header: Sequence[str], rows: Iterable[Sequence[object]]) -> bytes:
    """UTF-8 with a byte-order mark (so Excel opens it cleanly) and CRLF row ends; every cell, header
    included, goes through safe_cell."""
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow([safe_cell(cell) for cell in header])
    for row in rows:
        writer.writerow([safe_cell(cell) for cell in row])
    return buffer.getvalue().encode("utf-8-sig")
```

Run: `cd backend && uv run pytest tests/test_csvout.py -v`
Expected: PASS (15 tests).

- [ ] **Step 4: Write the shared billing test helpers and the failing billing tests**

`backend/tests/billing_helpers.py` (fixed timestamps only; imported by `test_api_billing.py` and `test_api_summary_cost.py`):

```python
"""Set-up helpers for the billing and asset-summary tests. Everything uses fixed UTC timestamps.
Call helpers.settle_rollups(db) (Task 2) after inserting readings: the engine reads the hourly rollup."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from helpers import insert_readings, make_asset, make_mapping, make_point, make_source


def at(year: int, month: int, day: int, hour: int = 0) -> datetime:
    return datetime(year, month, day, hour, tzinfo=timezone.utc)


async def set_zone(db, tz_name: str) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('general', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"timezone": tz_name},
    )


async def set_currency(db, code: str | None) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('billing', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"currency": code},
    )


async def add_tariff(db, rate: float, effective_from: str, asset_id: int | None = None) -> None:
    await db.execute(
        "INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES ($1, $2, $3)",
        asset_id, Decimal(str(rate)), date.fromisoformat(effective_from),
    )


async def _source(db) -> int:
    return await db.fetchval("SELECT id FROM sources LIMIT 1") or await make_source(db)


async def add_counter(
    db, name: str, first_bucket: datetime, count: int, per_hour: float = 1.0, base: float = 1000.0,
    parent_id: int | None = None,
) -> int:
    """An asset with an energy_kwh counter: one reading half way through each of `count` UTC hours
    starting at `first_bucket`, rising by `per_hour` per hour. The first hour has no baseline, so the
    engine counts 0 for it; every later hour counts `per_hour`."""
    asset = await make_asset(db, name, parent_id)
    point = await make_point(db, await _source(db), f"{name}_kWh")
    await make_mapping(db, point, asset, "energy_kwh", 60)
    values = [base + i * per_hour for i in range(count)]
    await insert_readings(db, point, first_bucket + timedelta(minutes=30), 3600, values)
    return asset


async def add_power(
    db, name: str, hour_starts: list[datetime], kw: float = 6.0, parent_id: int | None = None
) -> int:
    """An asset with only an active_power_kw mapping (600 s interval) and, in each listed UTC hour, six
    readings of `kw` ten minutes apart. The engine estimates `kw` kWh for each such hour."""
    asset = await make_asset(db, name, parent_id)
    point = await make_point(db, await _source(db), f"{name}_kW")
    await make_mapping(db, point, asset, "active_power_kw", 600)
    for hour in hour_starts:
        await insert_readings(db, point, hour + timedelta(minutes=5), 600, [kw] * 6)
    return asset
```

`backend/tests/test_api_billing.py`:

```python
import csv
import io
from datetime import datetime, timezone

import pytest

from billing_helpers import add_counter, add_power, add_tariff, at, set_currency, set_zone
from helpers import login_as, make_asset, settle_rollups

NOW = datetime(2026, 4, 15, 10, 20, tzinfo=timezone.utc)
URLS = ("/api/billing/costs", "/api/billing/costs.csv")


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)


async def get_costs(client, month: str = "2026-03") -> dict:
    response = await client.get("/api/billing/costs", params={"month": month})
    assert response.status_code == 200, response.text
    return response.json()


async def get_csv(client, month: str = "2026-03") -> list[list[str]]:
    response = await client.get("/api/billing/costs.csv", params={"month": month})
    assert response.status_code == 200, response.text
    assert response.content.startswith(b"\xef\xbb\xbf")
    return list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))


def by_name(body: dict) -> dict[str, dict]:
    return {asset["name"]: asset for asset in body["assets"]}


def check(entry, kwh, cost, estimated=False, partial=False):
    """One day or month figure. A missing cost must be None, never 0; 0.0 is a real cost."""
    assert entry is not None
    assert entry["kwh"] == pytest.approx(kwh)
    if cost is None:
        assert entry["cost"] is None
    else:
        assert entry["cost"] == pytest.approx(cost)
    assert (entry["estimated"], entry["partial"]) == (estimated, partial)


async def test_anonymous_is_refused_and_a_viewer_can_read(client, db):
    for url in URLS:
        assert (await client.get(url, params={"month": "2026-03"})).status_code == 401
    await login_as(client, db, "viewer")
    for url in URLS:
        assert (await client.get(url, params={"month": "2026-03"})).status_code == 200


@pytest.mark.parametrize(
    "month", ["2026-13", "2026-00", "26-03", "2026-3", "2026-03-01", "march", "2026-03 ", "2026/03"]
)
async def test_a_bad_month_is_422(client, db, month):
    await login_as(client, db, "viewer")
    for url in URLS:
        assert (await client.get(url, params={"month": month})).status_code == 422, (url, month)


async def test_a_stored_zone_without_whole_hour_offsets_is_409(client, db):
    await set_zone(db, "Asia/Kolkata")
    await login_as(client, db, "viewer")
    for url in URLS:
        response = await client.get(url, params={"month": "2026-03"})
        assert response.status_code == 409 and "Asia/Kolkata" in response.json()["detail"]


async def test_an_empty_site_has_the_days_and_no_assets(client, db):
    await login_as(client, db, "viewer")
    body = await get_costs(client)
    assert body["month"] == "2026-03" and body["timezone"] == "UTC" and body["currency"] is None
    assert len(body["days"]) == 31 and body["days"][0] == "2026-03-01" and body["assets"] == []


async def test_the_default_month_is_the_current_month_in_the_site_zone(client, db, monkeypatch):
    await set_zone(db, "Asia/Qatar")
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 4, 30, 22, 0, tzinfo=timezone.utc))
    await login_as(client, db, "viewer")
    assert (await client.get("/api/billing/costs")).json()["month"] == "2026-05"  # 01:00 on 1 May in Qatar
    csv_response = await client.get("/api/billing/costs.csv")
    assert csv_response.headers["content-disposition"] == 'attachment; filename="billing-2026-05.csv"'


async def test_the_current_month_stops_at_today_and_shows_todays_rate(client, db, monkeypatch):
    await add_power(db, "Panel", [at(2026, 4, 14, 10), at(2026, 4, 15, 9)], kw=10.0)
    await add_tariff(db, 0.10, "2026-04-01")
    await add_tariff(db, 0.30, "2026-04-20")  # still in the future on the 15th
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    panel = by_name(await get_costs(client, "2026-04"))["Panel"]  # NOW is 15 April 10:20 UTC
    assert len(panel["days"]) == 30
    check(panel["days"][13], 10.0, 1.0, estimated=True)  # 14 April
    check(panel["days"][14], 10.0, 1.0, estimated=True)  # today
    assert panel["days"][15:] == [None] * 15  # local days after today
    check(panel["total"], 20.0, 2.0, estimated=True)
    assert panel["rate_per_kwh"] == 0.10  # the rate in effect today, not on the 30th

    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 5, 2, 8, 0, tzinfo=timezone.utc))
    finished = by_name(await get_costs(client, "2026-04"))["Panel"]
    assert all(entry is not None for entry in finished["days"])
    assert finished["rate_per_kwh"] == 0.30  # the rate in effect on the last day of a finished month


async def test_a_month_in_the_future_has_no_figures(client, db):
    await add_power(db, "Panel", [at(2026, 4, 14, 10)])
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    panel = by_name(await get_costs(client, "2026-06"))["Panel"]
    assert panel["days"] == [None] * 30 and panel["total"] is None


async def test_a_25_hour_day_is_attributed_to_its_own_date_and_days_add_up_to_the_month(client, db):  # Review Focus 2
    await set_zone(db, "Europe/Berlin")
    # +1 kWh in every UTC hour from 24 Oct 22:00Z to 27 Oct 22:00Z; the 21:00Z reading is only the baseline.
    # 26 Oct 2025 runs from 25 Oct 22:00Z to 26 Oct 23:00Z: 25 hours.
    await add_counter(db, "Panel", at(2025, 10, 24, 21), 74)
    await add_tariff(db, 0.10, "2025-01-01")
    await add_tariff(db, 0.20, "2025-10-26")  # the new rate starts on the 25-hour day itself
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    body = await get_costs(client, "2025-10")
    panel = by_name(body)["Panel"]
    assert body["timezone"] == "Europe/Berlin"
    assert len(body["days"]) == 31 and body["days"][0] == "2025-10-01" and body["days"][-1] == "2025-10-31"
    assert len(panel["days"]) == 31
    check(panel["days"][24], 24.0, 2.4)  # 25 Oct, old rate
    check(panel["days"][25], 25.0, 5.0)  # 26 Oct: all 25 hours at the new rate
    check(panel["days"][26], 24.0, 4.8)  # 27 Oct
    check(panel["total"], 73.0, 12.2)
    assert sum(day["kwh"] for day in panel["days"]) == pytest.approx(panel["total"]["kwh"])
    assert panel["rate_per_kwh"] == 0.20


async def test_a_23_hour_day_loses_no_hour(client, db):  # Review Focus 2
    await set_zone(db, "Europe/Berlin")
    # 29 Mar 2026 runs from 28 Mar 23:00Z to 29 Mar 22:00Z: 23 hours. Readings from 28 Mar 22:00Z (baseline).
    await add_counter(db, "Panel", at(2026, 3, 28, 22), 48)
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    body = await get_costs(client, "2026-03")
    panel = by_name(body)["Panel"]
    assert len(body["days"]) == 31 and len(panel["days"]) == 31
    assert [day["kwh"] for day in panel["days"][27:30]] == pytest.approx([0.0, 23.0, 24.0])  # 28, 29, 30 Mar
    check(panel["total"], 47.0, None, partial=True)
    assert sum(day["kwh"] for day in panel["days"]) == pytest.approx(panel["total"]["kwh"])


async def test_the_hour_across_a_month_edge_is_counted_once(client, db):  # Review Focus 2
    await set_zone(db, "Europe/Berlin")
    # 1 Nov 00:00 Berlin (CET) is 31 Oct 23:00Z. Buckets 20:00Z..03:00Z; that hour and the four after it are November's.
    await add_counter(db, "Panel", at(2025, 10, 31, 20), 8)
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    october = by_name(await get_costs(client, "2025-10"))["Panel"]
    november = by_name(await get_costs(client, "2025-11"))["Panel"]
    check(october["total"], 2.0, None, partial=True)  # the 21:00Z and 22:00Z hours; 20:00Z is the baseline
    check(november["days"][0], 5.0, None, partial=True)  # 23:00Z, 00:00Z .. 03:00Z
    assert october["total"]["kwh"] + november["total"]["kwh"] == pytest.approx(7.0)


async def build_hierarchy(db, default_rate: float | None) -> None:
    """Site > MV2 > (LV Panel 1: kWh counter, 6 kWh; LV Panel 2: kW only, 18 kWh estimated) on 10 March, Qatar."""
    await set_zone(db, "Asia/Qatar")
    site = await make_asset(db, "Site")
    mv2 = await make_asset(db, "MV2", site)
    await add_counter(db, "LV Panel 1", at(2026, 3, 10, 6), 4, per_hour=2.0, parent_id=mv2)
    panel2 = await add_power(
        db, "LV Panel 2", [at(2026, 3, 10, 7), at(2026, 3, 10, 8), at(2026, 3, 10, 9)], parent_id=mv2
    )
    if default_rate is not None:
        await add_tariff(db, default_rate, "2026-01-01")
    await add_tariff(db, 0.50, "2026-03-10", asset_id=panel2)
    await settle_rollups(db)


async def test_a_parent_without_a_meter_sums_its_children_including_a_child_override(client, db):  # Review Focus 3
    await build_hierarchy(db, default_rate=0.10)
    await login_as(client, db, "viewer")
    body = await get_costs(client)
    assert [a["name"] for a in body["assets"]] == ["Site", "MV2", "LV Panel 1", "LV Panel 2"]  # tree preorder
    assert [a["path"] for a in body["assets"]] == [
        "Site", "Site / MV2", "Site / MV2 / LV Panel 1", "Site / MV2 / LV Panel 2",
    ]
    rows = by_name(body)
    ids = {name: row["asset_id"] for name, row in rows.items()}
    assert [a["parent_id"] for a in body["assets"]] == [None, ids["Site"], ids["MV2"], ids["MV2"]]
    day = 9  # 10 March in Qatar (UTC+3): 07:00-09:00Z is 10:00-12:00 local
    check(rows["LV Panel 1"]["days"][day], 6.0, 0.6)
    check(rows["LV Panel 2"]["days"][day], 18.0, 9.0, estimated=True)
    for parent in ("MV2", "Site"):
        check(rows[parent]["days"][day], 24.0, 9.6, estimated=True)  # 6 x 0.10 + 18 x 0.50
        check(rows[parent]["total"], 24.0, 9.6, estimated=True)
    assert [rows[n]["rate_per_kwh"] for n in ("Site", "MV2", "LV Panel 1", "LV Panel 2")] == [0.10, 0.10, 0.10, 0.50]


async def test_a_parent_is_partial_when_only_one_child_has_a_rate(client, db):  # Review Focus 3
    await build_hierarchy(db, default_rate=None)  # only LV Panel 2 has a rate
    await login_as(client, db, "viewer")
    rows = by_name(await get_costs(client))
    day = 9
    check(rows["LV Panel 1"]["days"][day], 6.0, None, partial=True)
    check(rows["LV Panel 2"]["days"][day], 18.0, 9.0, estimated=True)
    check(rows["MV2"]["days"][day], 24.0, 9.0, estimated=True, partial=True)
    check(rows["MV2"]["total"], 24.0, 9.0, estimated=True, partial=True)
    assert rows["Site"]["rate_per_kwh"] is None and rows["LV Panel 2"]["rate_per_kwh"] == 0.50


async def test_a_rate_that_starts_mid_month_marks_the_earlier_days_partial(client, db):  # Review Focus 3
    await add_power(db, "Panel", [at(2026, 3, 1, 10), at(2026, 3, 2, 10), at(2026, 3, 3, 10)], kw=10.0)
    await add_power(db, "Idle", [at(2026, 3, 1, 12), at(2026, 3, 2, 12)], kw=0.0)
    await add_tariff(db, 0.20, "2026-03-02")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    rows = by_name(await get_costs(client))
    panel, idle = rows["Panel"], rows["Idle"]
    check(panel["days"][0], 10.0, None, estimated=True, partial=True)  # 1 March: before the rate
    check(panel["days"][1], 10.0, 2.0, estimated=True)
    check(panel["days"][2], 10.0, 2.0, estimated=True)
    check(panel["total"], 30.0, 4.0, estimated=True, partial=True)
    check(panel["days"][3], 0.0, None)  # a day with no readings at all: no kWh, no cost, not partial
    assert panel["rate_per_kwh"] == 0.20
    # An hour that used no energy never makes a figure partial; with a rate in effect it costs 0, not "no rate".
    check(idle["days"][0], 0.0, None, estimated=True)
    check(idle["days"][1], 0.0, 0.0, estimated=True)
    check(idle["total"], 0.0, 0.0, estimated=True)


async def test_no_tariff_means_no_cost_anywhere_and_an_empty_csv_cell(client, db):  # Review Focus 3
    await add_power(db, "Panel", [at(2026, 3, 1, 10), at(2026, 3, 2, 10)], kw=10.0)
    await set_currency(db, "QAR")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    body = await get_costs(client)
    panel = by_name(body)["Panel"]
    assert body["currency"] == "QAR" and panel["rate_per_kwh"] is None
    check(panel["days"][0], 10.0, None, estimated=True, partial=True)
    check(panel["days"][1], 10.0, None, estimated=True, partial=True)
    check(panel["total"], 20.0, None, estimated=True, partial=True)
    rows = await get_csv(client)
    assert rows[0] == ["asset", "date", "kwh", "cost", "currency", "estimated", "partial"]
    assert rows[1] == ["Panel", "2026-03-01", "10", "", "QAR", "true", "true"]
    assert len(rows) == 1 + 31 and all(row[3] == "" for row in rows[1:])


async def test_an_asset_without_an_energy_mapping_has_null_entries(client, db):
    await add_power(db, "Panel", [at(2026, 3, 5, 10)])
    await make_asset(db, "Bare")
    await add_tariff(db, 0.10, "2026-03-01")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    bare = by_name(await get_costs(client))["Bare"]
    assert bare["days"] == [None] * 31 and bare["total"] is None
    assert bare["rate_per_kwh"] == 0.10  # the rate in effect is still shown
    assert "Bare" not in {row[0] for row in await get_csv(client)}  # no entry, no CSV row


async def test_csv_has_one_row_per_asset_per_day_up_to_today(client, db):
    await add_power(db, "Panel", [at(2026, 4, 14, 10)], kw=10.0)
    await add_tariff(db, 0.10, "2026-04-01")
    await set_currency(db, "QAR")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    response = await client.get("/api/billing/costs.csv", params={"month": "2026-04"})
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"] == 'attachment; filename="billing-2026-04.csv"'
    assert response.content.startswith(b"\xef\xbb\xbf") and b"\r\n" in response.content
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))
    assert len(rows) == 1 + 15  # 1-15 April; the 16th onwards is in the future
    assert rows[14] == ["Panel", "2026-04-14", "10", "1", "QAR", "true", "false"]
    assert rows[1] == ["Panel", "2026-04-01", "0", "", "QAR", "false", "false"]


async def test_an_asset_named_like_a_formula_is_neutralised_in_the_csv(client, db):  # Review Focus 5
    hostile = '=HYPERLINK("http://x","y")'
    await add_power(db, hostile, [at(2026, 3, 5, 10)])
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    assert by_name(await get_costs(client))[hostile]["path"] == hostile  # JSON keeps the real name
    rows = await get_csv(client)
    assert {row[0] for row in rows[1:]} == {"'" + hostile}
```

Run: `cd backend && uv run pytest tests/test_api_billing.py -v`
Expected: every test ERRORS in the autouse fixture with `ModuleNotFoundError: No module named 'dcdash.api.billing'`.

- [ ] **Step 5: Implement the billing API and register it**

`backend/dcdash/api/billing.py`. `month_bounds` returns local midnights; the engine is given the same instants in UTC (the zone is whole-hour, so they are UTC hour edges). Each priced hour is assigned to the local day whose `[start, end)` holds its bucket, so a 23- or 25-hour day is just a day with fewer or more hours:

```python
"""Billing (spec 10.3): one month of energy cost per asset per day, in the site timezone.

Read-only. The figures come from the energy engine priced by core/cost.py, so they equal what the asset
page and the dashboards show."""
import bisect
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.api.settings import current_timezone
from dcdash.core.cost import Cost, HourCost, cost_by_hour, load_tariffs, rate_at, summarize
from dcdash.core.csvout import write_csv
from dcdash.core.energy import hourly_energy
from dcdash.core.settings_store import get_currency
from dcdash.core.timeutil import local_days, month_bounds, validate_whole_hour_zone
from dcdash.core.tree import AssetTree

router = APIRouter(prefix="/api", tags=["billing"], dependencies=[Depends(require_role("viewer"))])

MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"
CSV_HEADER = ("asset", "date", "kwh", "cost", "currency", "estimated", "partial")


def _now() -> datetime:
    """The clock; tests replace it."""
    return datetime.now(timezone.utc)


def _figure(cost: Cost) -> dict[str, Any]:
    return {"kwh": cost.kwh, "cost": cost.cost, "estimated": cost.estimated, "partial": cost.partial}


def _split_by_day(
    hours: dict[datetime, HourCost], day_starts: list[datetime], end: datetime
) -> list[list[HourCost]]:
    """The hours of each local day. `day_starts` are the ascending, aware start instants of the days and
    `end` is where the last one ends; an hour outside [day_starts[0], end) belongs to no day."""
    per_day: list[list[HourCost]] = [[] for _ in day_starts]
    for bucket, hour in hours.items():
        index = bisect.bisect_right(day_starts, bucket) - 1
        if index >= 0 and bucket < end:
            per_day[index].append(hour)
    return per_day


async def month_costs(db: AsyncSession, month: str | None) -> dict[str, Any]:
    tz_name = await current_timezone(db)
    try:
        validate_whole_hour_zone(tz_name)
    except ValueError as exc:
        raise HTTPException(
            409,
            f"the site timezone {tz_name} cannot be used for billing ({exc}); "
            "choose a zone with whole-hour UTC offsets in Settings",
        ) from None
    zone = ZoneInfo(tz_name)
    now = _now()
    month = month or now.astimezone(zone).strftime("%Y-%m")
    try:
        start, end = month_bounds(month, tz_name)
    except (ValueError, OverflowError):
        raise HTTPException(422, "month must look like 2026-10") from None

    tree = await AssetTree.load(db)
    energy = await hourly_energy(db, tree, start.astimezone(timezone.utc), end.astimezone(timezone.utc))
    tariffs = await load_tariffs(db)
    priced = cost_by_hour(energy, tariffs, tree, tz_name)

    days = local_days(start, end, tz_name)
    day_starts = [first for _, first, _ in days]
    today = now.astimezone(zone).date()
    first_day, last_day = days[0][0], days[-1][0]
    rate_day = today if first_day <= today <= last_day else last_day

    assets = []
    for asset_id in tree.preorder():
        hours = priced.get(asset_id)
        entries: list[dict[str, Any] | None] = [None] * len(days)
        if hours is not None:
            for index, day_hours in enumerate(_split_by_day(hours, day_starts, end)):
                if day_starts[index] <= now:  # local days after today stay null
                    entries[index] = _figure(summarize(day_hours))
        has_figure = any(entry is not None for entry in entries)
        assets.append({
            "asset_id": asset_id,
            "parent_id": tree.nodes[asset_id].parent_id,
            "name": tree.nodes[asset_id].name,
            "path": tree.path(asset_id),
            "rate_per_kwh": rate_at(tariffs, tree, asset_id, rate_day),
            "days": entries,
            "total": _figure(summarize(hours.values())) if hours is not None and has_figure else None,
        })
    return {
        "month": month,
        "timezone": tz_name,
        "currency": await get_currency(db),
        "days": [day.isoformat() for day, _, _ in days],
        "assets": assets,
    }


@router.get("/billing/costs")
async def costs(
    month: str | None = Query(default=None, pattern=MONTH_PATTERN), db: AsyncSession = Depends(get_db)
) -> dict[str, Any]:
    return await month_costs(db, month)


@router.get("/billing/costs.csv")
async def costs_csv(
    month: str | None = Query(default=None, pattern=MONTH_PATTERN), db: AsyncSession = Depends(get_db)
) -> Response:
    body = await month_costs(db, month)
    rows = [
        [asset["path"], day, entry["kwh"], entry["cost"], body["currency"], entry["estimated"], entry["partial"]]
        for asset in body["assets"]
        for day, entry in zip(body["days"], asset["days"])
        if entry is not None
    ]
    return Response(
        write_csv(CSV_HEADER, rows),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="billing-{body["month"]}.csv"'},
    )
```

Register it in `backend/dcdash/api/main.py`: add `billing` to the import block (after `auth`) and `billing.router,` to the router tuple (after `site.router, tariffs.router,`). The finished import block:

```python
from dcdash.api import (
    assets, audit, auth, billing, data, discovery, jobs, mappings, scans, settings, site, sources, storage,
    stream, tariffs, users,
)
```

Run: `cd backend && uv run pytest tests/test_api_billing.py tests/test_csvout.py -v`
Expected: PASS. If a DST test fails on the day split, print `body["days"]` and the per-day `kwh` list first: the likely cause is `local_days` or `month_bounds` (Task 2) disagreeing with the 23/25-hour edges listed in the test comments, not `billing.py`.

- [ ] **Step 6: Write the failing asset-summary tests**

`backend/tests/test_api_summary_cost.py`:

```python
from datetime import datetime, timezone

import pytest

from billing_helpers import add_counter, add_tariff, at, set_currency
from helpers import login_as, make_asset, settle_rollups

NOW = datetime(2026, 3, 10, 10, 20, tzinfo=timezone.utc)  # the site zone is UTC in these tests


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.data._now", lambda: NOW)


async def summary(client, asset_id: int) -> dict:
    response = await client.get(f"/api/assets/{asset_id}/summary")
    assert response.status_code == 200, response.text
    return response.json()


async def todays_panel(db, name: str = "Panel", parent_id: int | None = None) -> int:
    """Counter readings at 07:30, 08:30 and 09:30Z on 10 March (+2 kWh in each of the 08:00 and 09:00 hours):
    4 kWh by the time NOW (10:20Z) comes."""
    return await add_counter(db, name, at(2026, 3, 10, 7), 3, per_hour=2.0, parent_id=parent_id)


async def test_cost_today_prices_the_engines_energy_with_the_rate_in_effect(client, db):
    panel = await todays_panel(db)
    await add_tariff(db, 0.25, "2026-03-01")
    await set_currency(db, "QAR")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    body = await summary(client, panel)
    assert body["energy_today"] == {"kwh": pytest.approx(4.0), "estimated": False}
    assert body["cost_today"] == {"cost": pytest.approx(1.0), "estimated": False, "partial": False}
    assert body["currency"] == "QAR"
    assert {"asset", "metrics", "energy_today", "cost_today", "currency"} <= set(body)  # existing keys stay


async def test_without_a_tariff_the_cost_is_null_and_partial_never_zero(client, db):  # Review Focus 3
    panel = await todays_panel(db)
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    body = await summary(client, panel)
    assert body["cost_today"] == {"cost": None, "estimated": False, "partial": True}
    assert body["currency"] is None


async def test_a_tariff_that_starts_tomorrow_does_not_price_today(client, db):  # Review Focus 3
    panel = await todays_panel(db)
    await add_tariff(db, 0.25, "2026-03-11")
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    assert (await summary(client, panel))["cost_today"] == {"cost": None, "estimated": False, "partial": True}


async def test_a_parent_without_a_meter_sums_its_children_including_an_override(client, db):  # Review Focus 3
    site = await make_asset(db, "Site")
    panel = await todays_panel(db, "LV Panel 1", site)
    await add_tariff(db, 0.25, "2026-03-01")
    await add_tariff(db, 0.50, "2026-03-10", asset_id=panel)
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    body = await summary(client, site)
    assert body["energy_today"] == {"kwh": pytest.approx(4.0), "estimated": False}
    assert body["cost_today"] == {"cost": pytest.approx(2.0), "estimated": False, "partial": False}  # 4 kWh x 0.50


async def test_an_asset_without_energy_has_no_cost_but_still_reports_the_currency(client, db):
    bare = await make_asset(db, "Bare")
    await set_currency(db, "QAR")
    await login_as(client, db, "viewer")
    body = await summary(client, bare)
    assert body["energy_today"] is None and body["cost_today"] is None and body["currency"] == "QAR"
```

Run: `cd backend && uv run pytest tests/test_api_summary_cost.py -v`
Expected: FAIL with `KeyError: 'cost_today'` (the clock seam `_now` already exists from Task 2, so the fixture works).

- [ ] **Step 7: Implement `cost_today` and `currency` in `api/data.py`**

Open `backend/dcdash/api/data.py`. Task 2 made `summary()` read today's figures from the engine over the site's whole local day; the cost uses that same `EnergyResult`, so there is still exactly one `hourly_energy` call per request and the energy and cost figures cannot disagree.

1. Add two imports next to the existing ones:

```python
from dcdash.core.cost import cost_by_hour, load_tariffs, summarize
from dcdash.core.settings_store import get_currency
```

2. Replace the last block of `summary()` (from the `start, end = day_bounds(...)` line to the end of the function), which is currently

```python
    start, end = day_bounds(_now(), await current_timezone(db))
    result = await hourly_energy(db, await AssetTree.load(db), start, end)
    energy = total(result.hours.get(asset_id))
    return {
        "asset": {"id": asset.id, "name": asset.name, "parent_id": asset.parent_id, "kind": asset.kind},
        "metrics": metrics,
        "energy_today": None if energy is None else {"kwh": energy.kwh, "estimated": energy.estimated},
    }
```

with

```python
    tz = await current_timezone(db)
    tree = await AssetTree.load(db)
    start, end = day_bounds(_now(), tz)
    result = await hourly_energy(db, tree, start, end)
    energy = total(result.hours.get(asset_id))
    priced = cost_by_hour(result, await load_tariffs(db), tree, tz).get(asset_id)
    cost = None if priced is None else summarize(priced.values())
    return {
        "asset": {"id": asset.id, "name": asset.name, "parent_id": asset.parent_id, "kind": asset.kind},
        "metrics": metrics,
        "energy_today": None if energy is None else {"kwh": energy.kwh, "estimated": energy.estimated},
        "cost_today": None if cost is None else {
            "cost": cost.cost, "estimated": cost.estimated, "partial": cost.partial,
        },
        "currency": await get_currency(db),
    }
```

Run: `cd backend && uv run pytest tests/test_api_summary_cost.py tests/test_api_data.py tests/test_api_data_tiers.py tests/test_api_settings.py -v`
Expected: PASS (the existing summary tests still pass: only keys were added).

- [ ] **Step 8: Run the whole backend suite**

Run: `cd backend && uv run pytest -q`
Expected: PASS, whole suite green.

- [ ] **Step 9: Commit and push**

```bash
git add backend/dcdash/core/csvout.py backend/dcdash/api/billing.py backend/dcdash/api/data.py \
  backend/dcdash/api/main.py backend/tests/billing_helpers.py backend/tests/test_csvout.py \
  backend/tests/test_api_billing.py backend/tests/test_api_summary_cost.py
git commit -m "feat: billing API and CSV, cost_today on the asset summary

Adds cost_today and currency to GET /api/assets/{id}/summary; no existing assertion changed.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa"
git push origin phase-3-dashboards-billing
```

### Task 5: Dashboards API and widget config validation

Purpose: the pure widget-config rules (`core/widgets.py`) and the dashboards CRUD API with whole-dashboard saves and optimistic concurrency (`api/dashboards.py`). Nothing here reads readings or contacts a source; `widget_data` is Task 6, which appends to `core/widgets.py`.

Decisions this task fixes (tests pin them):
- Limits (51st dashboard, 25th widget, 21 assets) answer **422**. **409** is only for a name clash and a stale `updated_at`.
- `energy` and `cost` sources require `metric` to be null (a non-null metric is a 422, not ignored).
- Saving does **not** check that asset ids exist: a deleted asset must never make a dashboard unsaveable or unreadable. Task 6 reports such ids as `missing`.
- The stored widget `config` is the validated config re-dumped (`model_dump(mode="json")`), so defaults (`bars`, `min`, `max`, `range`) are always present on read.
- Request models (`DashboardSave`, `WidgetIn`) ignore unknown keys, so a client may send back the widgets it loaded (with their `id`); ids are always regenerated. Only `WidgetConfig` forbids extras.
- Widgets are returned ordered by `(y, x, id)`, in `PUT` and `GET` alike.

**Files:**
- Create: `backend/dcdash/core/widgets.py` (about 110 lines)
- Create: `backend/dcdash/api/dashboards.py` (about 230 lines)
- Modify: `backend/dcdash/api/main.py` (import `dashboards` in the `from dcdash.api import (...)` block near line 10; add `dashboards.router` to the `for router in (...)` tuple near line 82)
- Test: `backend/tests/test_widget_config.py` (create; pure, needs no database)
- Test: `backend/tests/test_api_dashboards.py` (create)

**Interfaces:**
- Consumes (Task 1, spec 10.4): ORM models in `dcdash/core/models.py`: `Dashboard(id, name, range, created_by, created_at, updated_at)` and `Widget(id, dashboard_id, type, title, config, x, y, w, h)`; table `dashboards` has a UNIQUE constraint on `name`; `widgets.dashboard_id` references `dashboards(id) ON DELETE CASCADE`; `tests/conftest.py` `TABLES` includes `dashboards, widgets`.
- Consumes (Task 2): `dcdash.core.timeutil.RANGE_PRESETS` = `("1h","6h","24h","7d","30d","today","yesterday","this_month","last_month")`.
- Consumes (existing, verified): `dcdash.core.metrics.Metric` (`StrEnum`, includes `CUSTOM = "custom"`); `dcdash.api.deps.get_db`, `require_role`; `dcdash.core.audit.audit(db, user_id, action, detail)` (adds a row to the session, caller commits); `dcdash.core.pg.CONFIG_CHANNEL`; tests: `helpers.login_as`, `make_asset`, `listening`, fixtures `client`, `db`, `app`, `database_url`.
- Produces `dcdash/core/widgets.py`:
  ```python
  WIDGET_TYPES = ("timeseries", "bar", "stat", "gauge", "table")
  class WidgetConfig(BaseModel):  # extra="forbid"
      assets: list[int]; source: Literal["metric","energy","cost"]; metric: Metric | None = None
      aggregation: Literal["avg","min","max","last","sum"]; range: str | None = None
      bars: Literal["asset","time"] = "asset"; min: float = 0.0; max: float | None = None
  def validate_config(widget_type: str, config: dict) -> WidgetConfig   # ValueError("field: readable reason"), several problems joined by "; "
  ```
- Produces HTTP (all `/api`): `GET /dashboards` (viewer), `POST /dashboards` (operator), `GET /dashboards/{id}` (viewer), `PUT /dashboards/{id}` (operator), `DELETE /dashboards/{id}` (operator), with the shapes of the Interface Contracts. Audit `dashboard.created|updated|deleted` with `{dashboard_id, name, widgets: n}`. No `CONFIG_CHANNEL` notify.

- [ ] **Step 0: Verify the prerequisites exist**

Run, from the repo root:
```bash
cd backend
grep -n "class Dashboard\|class Widget" dcdash/core/models.py
grep -n "RANGE_PRESETS" dcdash/core/timeutil.py
grep -n "UNIQUE\|CASCADE\|dashboards\|widgets" migrations/versions/0004_billing_dashboards.py
grep -n "dashboards" tests/conftest.py
```
Expected: both model classes with the columns listed above; `RANGE_PRESETS` defined; in the migration `name` is UNIQUE and the widgets foreign key says `ON DELETE CASCADE`; `TABLES` in conftest lists `dashboards` and `widgets`. If any of this is missing, STOP and report BLOCKED with the grep output. Do not edit Task 1 or Task 2 files.

- [ ] **Step 1: Write the failing config tests**

`backend/tests/test_widget_config.py`:

```python
import pytest

from dcdash.core.timeutil import RANGE_PRESETS
from dcdash.core.widgets import WIDGET_TYPES, WidgetConfig, validate_config

BASE = {"assets": [1], "source": "metric", "metric": "active_power_kw", "aggregation": "avg"}
GAUGE = {**BASE, "aggregation": "last", "max": 100.0}  # valid for every widget type


def make(**overrides) -> dict:
    return {**BASE, **overrides}


def reject(widget_type: str, config: dict) -> str:
    """Validate a config that must fail and return the message."""
    with pytest.raises(ValueError) as caught:
        validate_config(widget_type, config)
    return str(caught.value)


def test_the_five_widget_types():
    assert WIDGET_TYPES == ("timeseries", "bar", "stat", "gauge", "table")


@pytest.mark.parametrize("widget_type", ["timeseries", "bar", "table"])
@pytest.mark.parametrize(
    "overrides",
    [
        {},
        {"assets": [1, 2, 3], "aggregation": "max"},
        {"source": "energy", "metric": None, "aggregation": "sum"},
        {"source": "cost", "metric": None, "aggregation": "sum", "range": "last_month"},
    ],
)
def test_timeseries_bar_and_table_accept_any_valid_source(widget_type, overrides):
    assert isinstance(validate_config(widget_type, make(**overrides)), WidgetConfig)


def test_defaults_are_filled_in():
    parsed = validate_config("stat", make(aggregation="last"))
    assert (parsed.range, parsed.bars, parsed.min, parsed.max) == (None, "asset", 0.0, None)
    assert parsed.model_dump(mode="json")["metric"] == "active_power_kw"


def test_assets_are_between_one_and_twenty():
    assert validate_config("table", make(assets=list(range(1, 21)))).assets == list(range(1, 21))
    message = reject("table", make(assets=list(range(1, 22))))  # Review Focus 4: 21 assets
    assert message.startswith("assets:") and "20" in message and "21" in message
    assert "at least one" in reject("table", make(assets=[]))


def test_an_asset_can_appear_only_once():
    message = reject("table", make(assets=[4, 5, 4]))
    assert message.startswith("assets:") and "once" in message


def test_asset_ids_must_be_integers():
    assert reject("table", make(assets=["north"])).startswith("assets.0:")


def test_source_metric_requires_a_metric():
    message = reject("stat", make(metric=None))  # Review Focus 4: missing metric for source metric
    assert message.startswith("metric:") and "required" in message
    without_key = {key: value for key, value in BASE.items() if key != "metric"}
    assert reject("stat", without_key).startswith("metric:")


def test_the_custom_metric_is_refused():
    message = reject("stat", make(metric="custom"))  # Review Focus 4: custom metric
    assert message.startswith("metric:") and "custom" in message


def test_an_unknown_metric_is_refused():
    assert reject("stat", make(metric="banana")).startswith("metric:")


@pytest.mark.parametrize("source", ["energy", "cost"])
def test_energy_and_cost_take_no_metric(source):
    assert validate_config("stat", make(source=source, metric=None, aggregation="sum")).metric is None
    message = reject("stat", make(source=source, metric="active_power_kw", aggregation="sum"))
    assert message.startswith("metric:") and source in message


@pytest.mark.parametrize("aggregation", ["avg", "min", "max", "last"])
def test_metric_sources_take_avg_min_max_last(aggregation):
    assert validate_config("table", make(aggregation=aggregation)).aggregation == aggregation


def test_sum_is_not_a_metric_aggregation():
    message = reject("table", make(aggregation="sum"))
    assert message.startswith("aggregation:") and "avg" in message


@pytest.mark.parametrize("source", ["energy", "cost"])
def test_energy_and_cost_take_sum_only(source):
    assert validate_config("table", make(source=source, metric=None, aggregation="sum")).aggregation == "sum"
    for aggregation in ("avg", "min", "max", "last"):
        message = reject("table", make(source=source, metric=None, aggregation=aggregation))
        assert message.startswith("aggregation:") and "sum" in message


def test_an_unknown_aggregation_is_refused():
    assert reject("table", make(aggregation="median")).startswith("aggregation:")


@pytest.mark.parametrize("preset", RANGE_PRESETS)
def test_every_preset_is_a_valid_range(preset):
    assert validate_config("timeseries", make(range=preset)).range == preset


def test_a_null_range_inherits_the_dashboard():
    assert validate_config("timeseries", make(range=None)).range is None
    assert validate_config("timeseries", make()).range is None


@pytest.mark.parametrize("bad", ["last_year", "2h", "", "TODAY", "24H"])
def test_a_range_that_is_not_a_preset_is_refused(bad):
    message = reject("timeseries", make(range=bad))  # Review Focus 4: range 'last_year'
    assert message.startswith("range:") and "last_month" in message


@pytest.mark.parametrize("widget_type", ["stat", "gauge"])
def test_stat_and_gauge_take_exactly_one_asset(widget_type):
    config = {**GAUGE, "assets": [7]}
    assert validate_config(widget_type, config).assets == [7]
    message = reject(widget_type, {**GAUGE, "assets": [7, 8]})  # Review Focus 4: stat with two assets
    assert message.startswith("assets:") and "exactly one" in message and widget_type in message


def test_a_gauge_needs_a_metric_source():
    energy = {"assets": [1], "source": "energy", "aggregation": "sum", "max": 10.0}
    message = reject("gauge", energy)  # Review Focus 4: gauge on energy
    assert message.startswith("source:") and "gauge" in message


@pytest.mark.parametrize("aggregation", ["avg", "min", "max"])
def test_a_gauge_reads_the_last_value(aggregation):
    message = reject("gauge", {**GAUGE, "aggregation": aggregation})
    assert message.startswith("aggregation:") and "last" in message


def test_a_gauge_needs_a_maximum():
    without_max = {key: value for key, value in GAUGE.items() if key != "max"}
    message = reject("gauge", without_max)  # Review Focus 4: gauge without max
    assert message.startswith("max:") and "maximum" in message


@pytest.mark.parametrize("low, high", [(0.0, 0.0), (10.0, 5.0), (-5.0, -5.0)])
def test_a_gauge_maximum_must_exceed_its_minimum(low, high):
    message = reject("gauge", {**GAUGE, "min": low, "max": high})
    assert message.startswith("max:") and "greater than min" in message


def test_a_gauge_may_have_a_negative_minimum():
    parsed = validate_config("gauge", {**GAUGE, "min": -50.0, "max": 50.0})
    assert (parsed.min, parsed.max) == (-50.0, 50.0)


@pytest.mark.parametrize("field", ["min", "max"])
@pytest.mark.parametrize("bad", [float("inf"), float("nan")])
def test_gauge_limits_must_be_finite(field, bad):
    assert reject("gauge", {**GAUGE, field: bad}).startswith(f"{field}:")


@pytest.mark.parametrize("widget_type", ["timeseries", "stat", "gauge", "table"])
def test_bars_time_only_applies_to_bar_widgets(widget_type):
    message = reject(widget_type, {**GAUGE, "bars": "time"})  # Review Focus 4: bars='time' on a stat
    assert message.startswith("bars:") and "bar" in message


def test_bar_widgets_accept_both_bar_modes():
    for bars in ("asset", "time"):
        assert validate_config("bar", make(bars=bars)).bars == bars


@pytest.mark.parametrize("widget_type", WIDGET_TYPES)
def test_the_default_bars_value_is_accepted_everywhere(widget_type):
    assert validate_config(widget_type, {**GAUGE, "bars": "asset"}).bars == "asset"


def test_an_unknown_bars_value_is_refused():
    assert reject("bar", make(bars="week")).startswith("bars:")


def test_unknown_keys_are_refused():
    assert reject("stat", make(aggregation="last", colour="red")).startswith("colour:")


def test_unknown_widget_type():
    message = reject("pie", make())
    assert message.startswith("type:") and "pie" in message and "gauge" in message


def test_several_problems_are_reported_together_in_plain_words():
    message = reject("table", make(assets=[], range="soon"))
    assert "assets:" in message and "range:" in message and "; " in message
    assert "validation error" not in message and "\n" not in message
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_widget_config.py -v`
Expected: collection ERROR `ModuleNotFoundError: No module named 'dcdash.core.widgets'`.

- [ ] **Step 3: Implement the config schema**

`backend/dcdash/core/widgets.py`:

```python
"""Widget configuration: the rules every saved or previewed widget must satisfy (spec 10.5).

`validate_config` is the only entry point for configs that come from a client. Messages are plain
text that names the field ("assets: at most 20 assets per widget (got 21)") so the editor can show them.
"""
import math
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator, model_validator

from dcdash.core.metrics import Metric
from dcdash.core.timeutil import RANGE_PRESETS

WIDGET_TYPES = ("timeseries", "bar", "stat", "gauge", "table")
MAX_ASSETS = 20
METRIC_AGGREGATIONS = ("avg", "min", "max", "last")
SINGLE_ASSET_TYPES = ("stat", "gauge")


def _either(options: tuple[str, ...]) -> str:
    return options[0] if len(options) == 1 else ", ".join(options[:-1]) + " or " + options[-1]


class WidgetConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assets: list[int]
    source: Literal["metric", "energy", "cost"]
    metric: Metric | None = None
    aggregation: Literal["avg", "min", "max", "last", "sum"]
    range: str | None = None
    bars: Literal["asset", "time"] = "asset"
    min: float = 0.0
    max: float | None = None

    @field_validator("assets")
    @classmethod
    def _assets(cls, value: list[int]) -> list[int]:
        if not value:
            raise ValueError("choose at least one asset")
        if len(value) > MAX_ASSETS:
            raise ValueError(f"at most {MAX_ASSETS} assets per widget (got {len(value)})")
        if len(set(value)) != len(value):
            raise ValueError("each asset can appear only once")
        return value

    @field_validator("range")
    @classmethod
    def _range(cls, value: str | None) -> str | None:
        if value is not None and value not in RANGE_PRESETS:
            raise ValueError(
                f"{value!r} is not a range preset; use one of {', '.join(RANGE_PRESETS)}, "
                "or leave it empty to follow the dashboard"
            )
        return value

    @field_validator("min", "max")
    @classmethod
    def _finite(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("must be a finite number")
        return value

    @model_validator(mode="after")
    def _source_rules(self) -> Self:
        if self.source == "metric":
            if self.metric is None:
                raise ValueError("metric: required when the source is 'metric'")
            if self.metric is Metric.CUSTOM:
                raise ValueError("metric: 'custom' cannot be used in a widget; custom metrics stay on the asset page")
            allowed: tuple[str, ...] = METRIC_AGGREGATIONS
        else:
            if self.metric is not None:
                raise ValueError(f"metric: must be empty when the source is '{self.source}'")
            allowed = ("sum",)
        if self.aggregation not in allowed:
            raise ValueError(
                f"aggregation: '{self.aggregation}' is not valid for the source '{self.source}'; use {_either(allowed)}"
            )
        return self


def _readable(error: ValidationError) -> str:
    """Pydantic's multi-line report as 'field: reason; field: reason'."""
    parts = []
    for item in error.errors():
        message = item["msg"].removeprefix("Value error, ")
        field = ".".join(str(part) for part in item["loc"])
        parts.append(f"{field}: {message}" if field else message)
    return "; ".join(parts)


def _check_type_rules(widget_type: str, config: WidgetConfig) -> None:
    """Rules that depend on the widget type, which the config model does not know."""
    if config.bars == "time" and widget_type != "bar":
        raise ValueError(f"bars: 'time' only applies to bar widgets, not to a {widget_type}")
    if widget_type in SINGLE_ASSET_TYPES and len(config.assets) != 1:
        raise ValueError(f"assets: a {widget_type} shows exactly one asset (got {len(config.assets)})")
    if widget_type == "gauge":
        if config.source != "metric":
            raise ValueError(f"source: a gauge needs the source 'metric', not '{config.source}'")
        if config.aggregation != "last":
            raise ValueError(f"aggregation: a gauge reads the 'last' value, not '{config.aggregation}'")
        if config.max is None:
            raise ValueError("max: a gauge needs a maximum value")
        if config.max <= config.min:
            raise ValueError(f"max: must be greater than min (min is {config.min:g}, max is {config.max:g})")


def validate_config(widget_type: str, config: dict[str, Any]) -> WidgetConfig:
    """Parse and check a widget config; raise ValueError with a readable message naming the field."""
    if widget_type not in WIDGET_TYPES:
        raise ValueError(f"type: {widget_type!r} is not a widget type; use one of {', '.join(WIDGET_TYPES)}")
    try:
        parsed = WidgetConfig.model_validate(config)
    except ValidationError as error:
        raise ValueError(_readable(error)) from None
    _check_type_rules(widget_type, parsed)
    return parsed
```

- [ ] **Step 4: Run to verify the config tests pass**

Run: `cd backend && uv run pytest tests/test_widget_config.py -v`
Expected: all PASS.

- [ ] **Step 5: Write the failing API tests**

`backend/tests/test_api_dashboards.py`:

```python
import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from dcdash.core.pg import CONFIG_CHANNEL
from helpers import listening, login_as, make_asset

STAT = {"assets": [1], "source": "metric", "metric": "active_power_kw", "aggregation": "last"}
FIELDS = ("type", "title", "config", "x", "y", "w", "h")


@pytest.fixture
async def other_client(app):
    """A second browser: its own cookie jar, the same app and database."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as other:
        yield other


@pytest.fixture
async def asset_ids(db):
    return [await make_asset(db, name) for name in ("Site", "MV2", "LV Panel 1")]


def widget(title="Power", type="stat", config=None, x=0, y=0, w=4, h=3) -> dict:
    return {"type": type, "title": title, "config": config or dict(STAT), "x": x, "y": y, "w": w, "h": h}


def as_input(saved_widget: dict) -> dict:
    """What a client sends for a widget it loaded: the same fields without the server's id."""
    return {key: saved_widget[key] for key in FIELDS}


def detail_text(response) -> str:
    """The error detail as one string, whether FastAPI made it (a list) or the handler did (text)."""
    detail = response.json()["detail"]
    if isinstance(detail, list):
        return "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in detail)
    return detail


async def send(client, method: str, url: str, payload=None):
    return await getattr(client, method)(url, **({"json": payload} if payload is not None else {}))


async def create(client, name="Ops", **extra) -> dict:
    response = await client.post("/api/dashboards", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()


async def save(client, dashboard: dict, widgets: list[dict], **overrides):
    body = {
        "name": dashboard["name"], "range": dashboard["range"], "updated_at": dashboard["updated_at"],
        "widgets": widgets, **overrides,
    }
    return await client.put(f"/api/dashboards/{dashboard['id']}", json=body)


async def fetch(client, dashboard: dict) -> dict:
    response = await client.get(f"/api/dashboards/{dashboard['id']}")
    assert response.status_code == 200, response.text
    return response.json()


async def test_roles_on_every_endpoint(client, db):
    put_body = {"name": "x", "range": "24h", "updated_at": "2026-10-08T10:00:00+00:00", "widgets": []}
    for method, url, payload in (
        ("get", "/api/dashboards", None), ("post", "/api/dashboards", {"name": "x"}),
        ("get", "/api/dashboards/1", None), ("put", "/api/dashboards/1", put_body),
        ("delete", "/api/dashboards/1", None),
    ):
        assert (await send(client, method, url, payload)).status_code == 401, (method, url)

    await login_as(client, db, "operator")
    dash = await create(client)
    await client.post("/api/logout")

    await login_as(client, db, "viewer")
    assert (await client.get("/api/dashboards")).status_code == 200
    assert (await client.get(f"/api/dashboards/{dash['id']}")).status_code == 200
    for method, url, payload in (
        ("post", "/api/dashboards", {"name": "y"}),
        ("put", f"/api/dashboards/{dash['id']}", {**put_body, "updated_at": dash["updated_at"]}),
        ("delete", f"/api/dashboards/{dash['id']}", None),
    ):
        assert (await send(client, method, url, payload)).status_code == 403, (method, url)
    assert await fetch(client, dash) == dash  # the viewer changed nothing

    await client.post("/api/logout")
    await login_as(client, db, "admin")
    assert (await save(client, dash, [widget()])).status_code == 200
    assert (await client.post("/api/dashboards", json={"name": "by admin"})).status_code == 201


async def test_create_defaults_and_remembers_the_creator(client, db):
    await login_as(client, db, "operator")
    dash = await create(client, "  Overview  ")
    assert dash["name"] == "Overview" and dash["range"] == "24h" and dash["widgets"] == []
    assert dash["updated_at"] and set(dash) == {"id", "name", "range", "updated_at", "widgets"}
    assert await fetch(client, dash) == dash
    operator = await db.fetchval("SELECT id FROM users WHERE username = 'operator'")
    assert await db.fetchval("SELECT created_by FROM dashboards WHERE id = $1", dash["id"]) == operator
    assert (await create(client, "Weekly", range="7d"))["range"] == "7d"
    assert (await create(client, "n" * 100))["name"] == "n" * 100


@pytest.mark.parametrize(
    "body",
    [{}, {"name": ""}, {"name": "   "}, {"name": "x" * 101},
     {"name": "ok", "range": "last_year"}, {"name": "ok", "range": None}],
)
async def test_create_rejects_bad_input(client, db, body):
    await login_as(client, db, "operator")
    assert (await client.post("/api/dashboards", json=body)).status_code == 422
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 0


async def test_duplicate_names_are_409_on_create_and_on_rename(client, db):
    await login_as(client, db, "operator")
    await create(client, "Ops")
    noc = await create(client, "NOC")
    again = await client.post("/api/dashboards", json={"name": "Ops"})
    assert again.status_code == 409 and "already exists" in again.json()["detail"]

    noc = (await save(client, noc, [widget("Keep me")])).json()
    clash = await save(client, noc, [], name="Ops")
    assert clash.status_code == 409 and "already exists" in clash.json()["detail"]
    assert await fetch(client, noc) == noc  # the refused rename replaced nothing
    assert (await save(client, noc, [])).status_code == 200  # saving under its own name is no clash


async def test_the_fifty_first_dashboard_is_422(client, db):
    # Limits answer 422, like the 25th widget; 409 is kept for name clashes and stale saves.
    await login_as(client, db, "operator")
    for number in range(50):
        await create(client, f"Board {number:02d}")
    response = await client.post("/api/dashboards", json={"name": "One too many"})
    assert response.status_code == 422 and "50" in detail_text(response)
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 50


async def test_list_is_ordered_by_name_and_counts_widgets(client, db):
    await login_as(client, db, "operator")
    made = {name: await create(client, name) for name in ("Charlie", "Alpha", "Bravo")}
    saved = (await save(client, made["Bravo"], [widget("A"), widget("B", y=3)])).json()
    listed = (await client.get("/api/dashboards")).json()
    assert [d["name"] for d in listed] == ["Alpha", "Bravo", "Charlie"]
    assert [d["widget_count"] for d in listed] == [0, 2, 0]
    assert set(listed[0]) == {"id", "name", "range", "widget_count", "updated_at"}
    assert listed[1]["updated_at"] == saved["updated_at"] and listed[1]["range"] == "24h"


async def test_unknown_dashboards_are_404(client, db):
    await login_as(client, db, "operator")
    body = {"name": "x", "range": "24h", "updated_at": "2026-10-08T10:00:00+00:00", "widgets": []}
    assert (await client.get("/api/dashboards/999")).status_code == 404
    assert (await client.put("/api/dashboards/999", json=body)).status_code == 404
    assert (await client.delete("/api/dashboards/999")).status_code == 404


async def test_put_replaces_everything_and_returns_a_newer_stamp(client, db, asset_ids):
    await login_as(client, db, "operator")
    dash = await create(client)
    energy = {"assets": asset_ids, "source": "energy", "aggregation": "sum", "range": "this_month", "bars": "time"}
    widgets = [
        widget("Lower", "bar", energy, x=6, y=3, w=6, h=4),
        widget("Upper right", x=4),
        widget("Upper left", x=0),
    ]
    response = await save(client, dash, widgets, name="Renamed", range="7d")
    assert response.status_code == 200, response.text
    saved = response.json()
    assert (saved["name"], saved["range"]) == ("Renamed", "7d")
    assert [w["title"] for w in saved["widgets"]] == ["Upper left", "Upper right", "Lower"]  # by y, then x
    assert saved["widgets"][2]["config"] == {
        "assets": asset_ids, "source": "energy", "metric": None, "aggregation": "sum",
        "range": "this_month", "bars": "time", "min": 0.0, "max": None,
    }
    assert datetime.fromisoformat(saved["updated_at"]) > datetime.fromisoformat(dash["updated_at"])
    assert await fetch(client, dash) == saved

    # A client may send back exactly what it loaded (ids included); the widgets get fresh ids.
    kept = (await save(client, saved, saved["widgets"][:1])).json()
    assert [w["title"] for w in kept["widgets"]] == ["Upper left"]
    assert kept["widgets"][0]["id"] not in {w["id"] for w in saved["widgets"]}
    assert await db.fetchval("SELECT count(*) FROM widgets") == 1


@pytest.mark.parametrize("offset_hours", [0, 3, -5])
async def test_updated_at_is_compared_as_a_moment_not_as_text(client, db, offset_hours):
    await login_as(client, db, "operator")
    dash = await create(client)
    moment = datetime.fromisoformat(dash["updated_at"])
    spelled = moment.astimezone(timezone(timedelta(hours=offset_hours))).isoformat()
    response = await save(client, dash, [], updated_at=spelled)
    assert response.status_code == 200, response.text


async def test_updated_at_is_required_and_must_carry_an_offset(client, db):
    await login_as(client, db, "operator")
    dash = await create(client)
    naive = datetime.fromisoformat(dash["updated_at"]).replace(tzinfo=None).isoformat()
    for stamp in (naive, "not a date", None):
        assert (await save(client, dash, [], updated_at=stamp)).status_code == 422
    body = {"name": "Ops", "range": "24h", "widgets": []}
    assert (await client.put(f"/api/dashboards/{dash['id']}", json=body)).status_code == 422


async def test_a_stale_updated_at_is_409(client, db):
    await login_as(client, db, "operator")
    dash = await create(client)
    assert (await save(client, dash, [widget("one")])).status_code == 200
    stale = await save(client, dash, [widget("two")])  # still holds the stamp from before the first save
    assert stale.status_code == 409
    assert stale.json()["detail"] == "dashboard changed since you loaded it"


async def test_two_operators_the_second_save_gets_409_and_nothing_is_lost(client, other_client, db):
    # Review Focus 4: two operators load the same dashboard, both save.
    await login_as(client, db, "operator", username="alice")
    await login_as(other_client, db, "operator", username="bob")
    dash = await create(client)
    bob_loaded = await fetch(other_client, dash)  # same stamp as Alice's copy

    alice = await save(client, dash, [widget("Alice 1"), widget("Alice 2", y=3)], name="Alice's board")
    assert alice.status_code == 200
    bob = await save(other_client, bob_loaded, [widget("Bob only")], name="Bob's board")
    assert bob.status_code == 409
    assert bob.json()["detail"] == "dashboard changed since you loaded it"

    stored = await fetch(other_client, dash)
    assert stored == alice.json()  # exactly the first save: no merge, no rename from Bob
    assert [w["title"] for w in stored["widgets"]] == ["Alice 1", "Alice 2"]
    assert await db.fetchval("SELECT count(*) FROM widgets") == 2  # nothing lost, nothing duplicated
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'dashboard.updated'") == 1

    # Bob reloads, adds his widget to Alice's work and saves: that goes through.
    merged = await save(other_client, stored, [*map(as_input, stored["widgets"]), widget("Bob 3", y=6)])
    assert merged.status_code == 200
    assert [w["title"] for w in merged.json()["widgets"]] == ["Alice 1", "Alice 2", "Bob 3"]
    assert await db.fetchval("SELECT count(*) FROM widgets") == 3


async def test_simultaneous_saves_with_one_stamp_exactly_one_wins(client, other_client, db):
    # Review Focus 4: the check and the replacement are atomic, so a race cannot let both saves land.
    await login_as(client, db, "operator", username="alice")
    await login_as(other_client, db, "operator", username="bob")
    dash = await create(client)
    loaded = await fetch(other_client, dash)
    responses = await asyncio.gather(
        save(client, dash, [widget(f"A{n}", y=n * 3) for n in range(3)], name="A board"),
        save(other_client, loaded, [widget("B only")], name="B board"),
    )
    assert sorted(r.status_code for r in responses) == [200, 409]
    winner = next(r for r in responses if r.status_code == 200).json()
    assert await fetch(client, dash) == winner
    assert await db.fetchval("SELECT count(*) FROM widgets") == len(winner["widgets"])  # never a mix of both
    assert await db.fetchval("SELECT count(*) FROM dashboards WHERE name = $1", winner["name"]) == 1


BAD_WIDGETS = {
    "21 assets": ("table", {**STAT, "assets": list(range(1, 22)), "aggregation": "avg"}, ["assets", "20"]),
    "stat with two assets": ("stat", {**STAT, "assets": [1, 2]}, ["assets", "exactly one"]),
    "gauge on energy": (
        "gauge", {"assets": [1], "source": "energy", "aggregation": "sum", "max": 10.0}, ["source", "gauge"],
    ),
    "gauge without max": ("gauge", dict(STAT), ["max", "maximum"]),
    "custom metric": ("stat", {**STAT, "metric": "custom"}, ["metric", "custom"]),
    "range that is not a preset": (
        "timeseries", {**STAT, "aggregation": "avg", "range": "last_year"}, ["range", "last_year"],
    ),
    "bars=time on a stat": ("stat", {**STAT, "bars": "time"}, ["bars"]),
    "source metric without a metric": (
        "stat", {key: value for key, value in STAT.items() if key != "metric"}, ["metric", "required"],
    ),
    "duplicate assets": ("table", {**STAT, "assets": [3, 3], "aggregation": "avg"}, ["assets", "once"]),
    "unknown key": ("stat", {**STAT, "colour": "red"}, ["colour"]),
    "unknown widget type": ("pie", dict(STAT), ["type", "pie"]),
}


@pytest.mark.parametrize("case", list(BAD_WIDGETS.values()), ids=list(BAD_WIDGETS))
async def test_bad_widget_configs_are_422_with_a_readable_message(client, db, case):
    # Review Focus 4: each bad config is refused, names the widget and the field, and saves nothing.
    widget_type, config, fragments = case
    await login_as(client, db, "operator")
    stored = (await save(client, await create(client), [widget("Good")])).json()
    response = await save(client, stored, [widget("Fine"), widget("Bad", widget_type, config, y=3)])
    assert response.status_code == 422, response.text
    assert isinstance(response.json()["detail"], str)
    message = detail_text(response)
    assert message.startswith('widget 2 ("Bad"): ')
    for fragment in fragments:
        assert fragment in message, message
    assert await fetch(client, stored) == stored  # same widgets, same stamp
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'dashboard.updated'") == 1


BAD_PLACEMENTS = {
    "negative x": {"x": -1},
    "negative y": {"y": -1},
    "zero width": {"w": 0},
    "zero height": {"h": 0},
    "x + w past the 12th column": {"x": 9, "w": 4},
    "wider than the grid": {"w": 13},
    "title over 100 characters": {"title": "t" * 101},
    "row far off the grid": {"y": 1001},
}


@pytest.mark.parametrize("overrides", list(BAD_PLACEMENTS.values()), ids=list(BAD_PLACEMENTS))
async def test_bad_placement_or_title_is_422_and_saves_nothing(client, db, overrides):
    await login_as(client, db, "operator")
    dash = await create(client)
    response = await save(client, dash, [{**widget(), **overrides}])
    assert response.status_code == 422, response.text
    assert await fetch(client, dash) == dash


async def test_the_edges_of_the_grid_are_accepted_and_past_it_names_the_grid(client, db):
    await login_as(client, db, "operator")
    dash = await create(client)
    edges = [
        widget("t" * 100, x=8, y=0, w=4, h=1),  # ends exactly at column 12
        widget("full width", x=0, y=3, w=12),
        widget("tiny", x=11, y=6, w=1, h=1),
    ]
    saved = await save(client, dash, edges)
    assert saved.status_code == 200
    past = await save(client, saved.json(), [widget(x=9, w=4)])
    assert past.status_code == 422
    assert detail_text(past).startswith('widget 1 ("Power"): ') and "12 columns" in detail_text(past)


async def test_twenty_four_widgets_are_fine_and_the_25th_is_422(client, db):
    await login_as(client, db, "operator")
    dash = await create(client)
    many = [widget(f"W{n}", x=(n % 3) * 4, y=(n // 3) * 3) for n in range(24)]
    ok = await save(client, dash, many)
    assert ok.status_code == 200 and len(ok.json()["widgets"]) == 24
    stored = ok.json()
    over = await save(client, stored, [*many, widget("25th", y=30)])
    assert over.status_code == 422 and "24" in detail_text(over)
    assert await fetch(client, stored) == stored
    assert await db.fetchval("SELECT count(*) FROM widgets") == 24


async def test_deleting_a_referenced_asset_does_not_break_the_dashboard(client, db, asset_ids):
    # Review Focus 5, dashboard-API half: the saved config is stored as given. Task 6 covers widget-data `missing`.
    await login_as(client, db, "operator")
    config = {**STAT, "assets": asset_ids[:2], "aggregation": "avg"}
    saved = (await save(client, await create(client), [widget("Both", "table", config)])).json()
    await db.execute("DELETE FROM assets WHERE id = $1", asset_ids[0])

    loaded = await client.get(f"/api/dashboards/{saved['id']}")
    assert loaded.status_code == 200 and loaded.json() == saved
    assert loaded.json()["widgets"][0]["config"]["assets"] == asset_ids[:2]
    assert (await client.get("/api/dashboards")).status_code == 200

    ghost = widget("Ghost", config={**STAT, "assets": [987654]}, y=3)  # an id that never existed is stored too
    again = await save(client, saved, [as_input(saved["widgets"][0]), ghost])
    assert again.status_code == 200 and again.json()["widgets"][1]["config"]["assets"] == [987654]


async def test_delete_removes_the_dashboard_and_its_widgets_only(client, db):
    await login_as(client, db, "operator")
    doomed = (await save(client, await create(client, "Doomed"), [widget("a"), widget("b", y=3)])).json()
    keeper = (await save(client, await create(client, "Keeper"), [widget("c")])).json()
    assert (await client.delete(f"/api/dashboards/{doomed['id']}")).status_code == 204
    assert (await client.get(f"/api/dashboards/{doomed['id']}")).status_code == 404
    assert await db.fetchval("SELECT count(*) FROM widgets WHERE dashboard_id = $1", doomed["id"]) == 0
    assert await fetch(client, keeper) == keeper
    assert [d["name"] for d in (await client.get("/api/dashboards")).json()] == ["Keeper"]


async def test_create_save_and_delete_are_audited_and_reads_are_not(client, db):
    await login_as(client, db, "operator")
    operator = await db.fetchval("SELECT id FROM users WHERE username = 'operator'")
    dash = await create(client, "Ops")
    saved = (await save(client, dash, [widget("a"), widget("b", y=3)], name="Ops 2")).json()
    await client.get("/api/dashboards")
    await fetch(client, saved)
    await client.post("/api/dashboards", json={"name": "Ops 2"})  # refused (409): no audit row
    await client.delete(f"/api/dashboards/{dash['id']}")
    rows = await db.fetch("SELECT user_id, action, detail FROM audit_log ORDER BY id")
    assert [(r["user_id"], r["action"], r["detail"]) for r in rows] == [
        (operator, "dashboard.created", {"dashboard_id": dash["id"], "name": "Ops", "widgets": 0}),
        (operator, "dashboard.updated", {"dashboard_id": dash["id"], "name": "Ops 2", "widgets": 2}),
        (operator, "dashboard.deleted", {"dashboard_id": dash["id"], "name": "Ops 2", "widgets": 2}),
    ]


async def test_dashboard_changes_do_not_wake_the_collector(client, db, database_url):
    await login_as(client, db, "operator")
    async with listening(database_url, CONFIG_CHANNEL) as received:
        dash = await create(client)
        saved = (await save(client, dash, [widget()])).json()
        await client.delete(f"/api/dashboards/{saved['id']}")
        await db.execute(f"SELECT pg_notify('{CONFIG_CHANNEL}', 'sentinel')")
        # Notifications arrive in order, so if any earlier write had notified, it would come first.
        assert await asyncio.wait_for(received.get(), timeout=5) == "sentinel"
```

- [ ] **Step 6: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_api_dashboards.py -v`
Expected: FAIL. Every test that reaches `/api/dashboards` gets 404 (router missing), for example `assert 404 == 401` in `test_roles_on_every_endpoint` and `assert 404 == 201` in the create helper.

- [ ] **Step 7: Implement the dashboards API**

`backend/dcdash/api/dashboards.py`:

```python
"""Dashboards and their widgets (spec 10.4).

A dashboard is saved as a whole: PUT replaces the name, the range and every widget in one transaction.
Two editors are told apart by `updated_at`: the row is locked, the request's stamp must equal the stored
one, and a later save sees the newer stamp and gets 409. Dashboard changes never notify the collector.
"""
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.audit import audit
from dcdash.core.models import Dashboard, User, Widget
from dcdash.core.timeutil import RANGE_PRESETS
from dcdash.core.widgets import validate_config

router = APIRouter(prefix="/api", tags=["dashboards"])
Viewer = Depends(require_role("viewer"))
Operator = Depends(require_role("operator"))

MAX_WIDGETS = 24
MAX_DASHBOARDS = 50
GRID_COLUMNS = 12
MAX_ROWS = 1000
DEFAULT_RANGE = "24h"
NAME_TAKEN = "a dashboard with this name already exists"
STALE = "dashboard changed since you loaded it"


def _preset(value: str) -> str:
    if value not in RANGE_PRESETS:
        raise ValueError(f"unknown range {value!r}; use one of {', '.join(RANGE_PRESETS)}")
    return value


Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Preset = Annotated[str, AfterValidator(_preset)]


class DashboardIn(BaseModel):
    name: Name
    range: Preset = DEFAULT_RANGE


class WidgetIn(BaseModel):
    type: str
    title: str = Field(max_length=100)
    config: dict[str, Any]
    x: int = Field(ge=0, le=GRID_COLUMNS - 1)
    y: int = Field(ge=0, le=MAX_ROWS)
    w: int = Field(ge=1, le=GRID_COLUMNS)
    h: int = Field(ge=1, le=MAX_ROWS)


class DashboardSave(BaseModel):
    name: Name
    range: Preset
    updated_at: AwareDatetime
    widgets: list[WidgetIn]


class WidgetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    type: str
    title: str
    config: dict[str, Any]
    x: int
    y: int
    w: int
    h: int


class DashboardOut(BaseModel):
    id: int
    name: str
    range: str
    updated_at: datetime
    widgets: list[WidgetOut]


class DashboardListItem(BaseModel):
    id: int
    name: str
    range: str
    widget_count: int
    updated_at: datetime


def dashboard_out(dashboard: Dashboard, widgets: Sequence[Widget]) -> DashboardOut:
    ordered = sorted(widgets, key=lambda w: (w.y, w.x, w.id))
    return DashboardOut(
        id=dashboard.id, name=dashboard.name, range=dashboard.range, updated_at=dashboard.updated_at,
        widgets=[WidgetOut.model_validate(w) for w in ordered],
    )


async def load_dashboard(db: AsyncSession, dashboard_id: int, lock: bool = False) -> Dashboard:
    query = select(Dashboard).where(Dashboard.id == dashboard_id)
    if lock:
        # A second saver waits here, then reads the first one's committed row (populate_existing refreshes the object).
        query = query.with_for_update().execution_options(populate_existing=True)
    dashboard = (await db.scalars(query)).one_or_none()
    if dashboard is None:
        raise HTTPException(404, "dashboard not found")
    return dashboard


async def name_taken(db: AsyncSession, name: str, except_id: int | None = None) -> bool:
    query = select(Dashboard.id).where(Dashboard.name == name)
    if except_id is not None:
        query = query.where(Dashboard.id != except_id)
    return await db.scalar(query.limit(1)) is not None


def checked_configs(widgets: Sequence[WidgetIn]) -> list[dict[str, Any]]:
    """Validate every widget before anything is written; the normalized configs are what gets stored."""
    if len(widgets) > MAX_WIDGETS:
        raise HTTPException(422, f"a dashboard can have at most {MAX_WIDGETS} widgets (got {len(widgets)})")
    configs = []
    for number, widget in enumerate(widgets, start=1):
        label = f'widget {number} ("{widget.title}")'
        if widget.x + widget.w > GRID_COLUMNS:
            raise HTTPException(
                422, f"{label}: x + w is {widget.x + widget.w} but the grid has {GRID_COLUMNS} columns"
            )
        try:
            configs.append(validate_config(widget.type, widget.config).model_dump(mode="json"))
        except ValueError as exc:
            raise HTTPException(422, f"{label}: {exc}") from None
    return configs


@router.get("/dashboards", response_model=list[DashboardListItem], dependencies=[Viewer])
async def list_dashboards(db: AsyncSession = Depends(get_db)) -> list[DashboardListItem]:
    rows = await db.execute(
        select(Dashboard, func.count(Widget.id))
        .outerjoin(Widget, Widget.dashboard_id == Dashboard.id)
        .group_by(Dashboard.id)
        .order_by(Dashboard.name)
    )
    return [
        DashboardListItem(
            id=d.id, name=d.name, range=d.range, widget_count=count, updated_at=d.updated_at
        )
        for d, count in rows.all()
    ]


@router.post("/dashboards", response_model=DashboardOut, status_code=201)
async def create_dashboard(
    body: DashboardIn, user: User = Operator, db: AsyncSession = Depends(get_db)
) -> DashboardOut:
    if (await db.scalar(select(func.count()).select_from(Dashboard)) or 0) >= MAX_DASHBOARDS:
        raise HTTPException(422, f"at most {MAX_DASHBOARDS} dashboards")
    if await name_taken(db, body.name):
        raise HTTPException(409, NAME_TAKEN)
    now = datetime.now(UTC)
    dashboard = Dashboard(name=body.name, range=body.range, created_by=user.id, created_at=now, updated_at=now)
    try:
        db.add(dashboard)
        await db.flush()
        await audit(
            db, user.id, "dashboard.created", {"dashboard_id": dashboard.id, "name": dashboard.name, "widgets": 0}
        )
        await db.commit()
    except IntegrityError:  # two creates with the same name raced; the UNIQUE constraint decided
        await db.rollback()
        raise HTTPException(409, NAME_TAKEN) from None
    return dashboard_out(dashboard, [])


@router.get("/dashboards/{dashboard_id}", response_model=DashboardOut, dependencies=[Viewer])
async def get_dashboard(dashboard_id: int, db: AsyncSession = Depends(get_db)) -> DashboardOut:
    dashboard = await load_dashboard(db, dashboard_id)
    widgets = (await db.scalars(select(Widget).where(Widget.dashboard_id == dashboard.id))).all()
    return dashboard_out(dashboard, widgets)


@router.put("/dashboards/{dashboard_id}", response_model=DashboardOut)
async def save_dashboard(
    dashboard_id: int, body: DashboardSave, user: User = Operator, db: AsyncSession = Depends(get_db)
) -> DashboardOut:
    configs = checked_configs(body.widgets)  # every widget 422 happens before the row is locked or touched
    dashboard = await load_dashboard(db, dashboard_id, lock=True)
    if body.updated_at != dashboard.updated_at:  # datetimes, not strings: "Z", "+00:00" and "+03:00" spellings agree
        raise HTTPException(409, STALE)
    if await name_taken(db, body.name, except_id=dashboard.id):
        raise HTTPException(409, NAME_TAKEN)
    widgets = [
        Widget(dashboard_id=dashboard.id, type=w.type, title=w.title, config=config, x=w.x, y=w.y, w=w.w, h=w.h)
        for w, config in zip(body.widgets, configs, strict=True)
    ]
    try:
        dashboard.name = body.name
        dashboard.range = body.range
        # Strictly newer than the stored stamp even if the clock stepped back, so a stale copy can never match.
        dashboard.updated_at = max(datetime.now(UTC), dashboard.updated_at + timedelta(microseconds=1))
        await db.execute(delete(Widget).where(Widget.dashboard_id == dashboard.id))
        db.add_all(widgets)
        await db.flush()
        await audit(
            db, user.id, "dashboard.updated",
            {"dashboard_id": dashboard.id, "name": dashboard.name, "widgets": len(widgets)},
        )
        await db.commit()
    except IntegrityError:  # a rename raced another rename onto the same name
        await db.rollback()
        raise HTTPException(409, NAME_TAKEN) from None
    return dashboard_out(dashboard, widgets)


@router.delete("/dashboards/{dashboard_id}", status_code=204)
async def delete_dashboard(dashboard_id: int, user: User = Operator, db: AsyncSession = Depends(get_db)) -> None:
    dashboard = await load_dashboard(db, dashboard_id, lock=True)
    count = await db.scalar(select(func.count()).select_from(Widget).where(Widget.dashboard_id == dashboard.id))
    await audit(
        db, user.id, "dashboard.deleted", {"dashboard_id": dashboard.id, "name": dashboard.name, "widgets": count}
    )
    # The widgets go with it (ON DELETE CASCADE); a Core delete avoids loading them through a relationship.
    await db.execute(delete(Dashboard).where(Dashboard.id == dashboard.id))
    await db.commit()
```

Register the router in `backend/dcdash/api/main.py`. Read the file first: Tasks 3 and 4 have already added their own routers, so do not replace whole lines. Make exactly two additions: add `dashboards` to the `from dcdash.api import (...)` names (keep the list alphabetical and wrap lines at about 110 characters), and add `dashboards.router` to the `for router in (...)` tuple. Expected result for the two spots (other names are whatever the file holds now):

```python
from dcdash.api import (
    assets, audit, auth, dashboards, data, discovery, ...  # existing names unchanged
)
...
    for router in (
        auth.router, ..., audit.router, dashboards.router,  # existing routers unchanged
    ):
```

- [ ] **Step 8: Run to verify the tests pass, then neighbours**

Run: `cd backend && uv run pytest tests/test_api_dashboards.py tests/test_widget_config.py -v`
Expected: all PASS.

Run: `cd backend && uv run pytest tests/test_api_assets.py tests/test_api_settings.py tests/test_schema.py tests/test_end_to_end.py -v`
Expected: all PASS (the new router must not disturb existing routes).

If `test_simultaneous_saves_with_one_stamp_exactly_one_wins` ever yields two 200s, the `with_for_update()` in `load_dashboard` is missing or the stamp comparison happens before the lock: fix the code, never the test.

- [ ] **Step 9: Commit**

```bash
git add backend/dcdash/core/widgets.py backend/dcdash/api/dashboards.py backend/dcdash/api/main.py backend/tests/test_widget_config.py backend/tests/test_api_dashboards.py
git commit -m "$(cat <<'EOF'
feat(dashboards): widget config validation and dashboards API with optimistic concurrency

validate_config enforces the spec 10.5 rules with readable, field-named messages. The dashboards API saves a
whole dashboard in one transaction under a row lock; a stale updated_at gets 409 (compared as datetimes),
limits and bad widgets get 422, writes are operator and above, and changes are audited without notifying
the collector.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

### Task 6: Widget data and widget CSV

One function answers every widget (`widget_data`), two endpoints serve it as JSON and CSV, and the tiered metric queries of `GET /api/assets/{id}/series` move into `core/series.py` so both callers share them. The `/series` responses must not change.

**Files:**
- Create: `backend/dcdash/core/series.py` (tier choice, bucketed series, whole-range stats, last-in-range, latest values, mapping lookup)
- Modify: `backend/dcdash/api/data.py` (delete `_SERIES_RAW`, `_SERIES_ROLLUP`, `pick_tier`, and `_GOOD`/`text` if nothing else uses them; `series()` calls `core/series.py`; `pick_tier` stays importable from here)
- Modify: `backend/dcdash/core/widgets.py` (Task 5 created it: extend the import block at the top, then APPEND everything under "Step 4")
- Create: `backend/dcdash/api/widget_data.py`
- Modify: `backend/dcdash/api/main.py` (import and include `widget_data.router`)
- Test: `backend/tests/test_widget_data.py` (new); `backend/tests/test_api_data.py` and `backend/tests/test_api_data_tiers.py` must stay green and UNCHANGED.

**Interfaces:**
- Consumes (earlier tasks; `Read` each definition before relying on it, Step 0 greps for them):
  - `dcdash/core/tree.py`: `AssetTree.load(db)`, `.nodes: dict[int, AssetNode]` (`.name`), `.path(asset_id) -> str`.
  - `dcdash/core/timeutil.py`: `RANGE_PRESETS`, `ROLLING`, `resolve_range(preset, now, tz_name) -> (start, end)`, `local_days(start, end, tz_name) -> [(date, begin, stop)]`, `validate_whole_hour_zone(tz_name)` (raises `ValueError`).
  - `dcdash/core/energy.py`: `hourly_energy(db, tree, start, end) -> EnergyResult`; `EnergyResult.hours[asset_id]` is `dict[datetime(UTC hour), HourEnergy(kwh, estimated)] | None`.
  - `dcdash/core/cost.py`: `load_tariffs(db)`, `cost_by_hour(energy, tariffs, tree, tz_name) -> dict[int, dict[datetime, HourCost(kwh, cost, estimated, unpriced)] | None]`.
  - `dcdash/core/csvout.py`: `write_csv(header, rows) -> bytes` (BOM, CRLF, every cell through `safe_cell`).
  - `dcdash/core/widgets.py` (Task 5): `WIDGET_TYPES`, `WidgetConfig` (`assets, source, metric, aggregation, range, bars, min, max`), `validate_config(widget_type, config: dict) -> WidgetConfig` (raises `ValueError`).
  - `dcdash/core/settings_store.py`: `get_currency(db) -> str | None` (ASSUMPTION: the contracts list the name but not the signature; Step 0 prints it. If it differs, adapt the one call in `_fill_billing`. Equivalent: `(await get_setting(db, "billing", {})).get("currency")`).
  - Existing: `current_timezone(db)` (`dcdash/api/settings.py`), `get_db`, `require_role` (`dcdash/api/deps.py`), `Metric`, `unit_for` (`dcdash/core/metrics.py`), models `Mapping`, `PointLatest`.
- Produces:
  - `core/series.py`: `DEFAULT_BUCKETS = 300`; `pick_tier(width_seconds) -> "raw"|"1m"|"1h"`; `bucket_width(start, end, buckets) -> float`; `series_tier(start, end, buckets=300) -> str`; `find_mapping(db, asset_id, metric, mapping_id=None) -> Mapping | None`; `first_mappings(db, asset_ids, metric) -> dict[int, Mapping]`; `metric_series(db, mapping, start, end, buckets) -> SeriesResult(tier, points: list[SeriesPoint(ts, avg, min, max)])` (scaled); `metric_aggregate(db, mapping, start, end, buckets=300) -> Aggregate(avg, min, max)` (scaled, sample-weighted avg over the whole range); `last_rollup_value(db, mapping, start, end) -> float | None`; `latest_values(db, mappings) -> dict[mapping_id, float | None]` (scaled `point_latest`).
  - `core/widgets.py`: `class SiteZoneError(Exception)`; `async def compute_widget(db, widget_type, config, preset, now) -> WidgetResult`; `WidgetResult.as_json() -> dict` and `.csv_rows() -> list[list]`; `async def widget_data(db, widget_type, config, preset, now) -> dict` (the contract signature; equals `compute_widget(...).as_json()`).
  - `api/widget_data.py`: `POST /api/widget-data` and `POST /api/widget-data/csv` (viewer). The clock is the module function `_now()`; tests monkeypatch `dcdash.api.widget_data._now` (the endpoint reads no other clock).
- Behaviour pinned by this task (tests below):
  - Error order: body model 422 (unknown type, `range` not a preset) → `validate_config` 422 → `SiteZoneError` 409. A deleted asset is never an error: it goes to `missing`.
  - Metric `values` mode: `avg` = `sum(sum_value)/sum(n)` over the whole range from the tier `pick_tier(range_seconds / 300)`; `min`/`max` from the same tier. `last` on `1h|6h|24h|7d|30d|today|this_month` = `point_latest.value * scale`; on `yesterday|last_month` = the last `readings_1h.last_value` in the range times scale. `tier` is null for `last`.
  - `point_id` is the mapping's point for EVERY metric values row (null when the asset has no mapping for the metric, always null for energy and cost). Clients use it for live updates only for `last` on a rolling range.
  - Energy/cost: range start rounded down and end rounded up to whole UTC hours (an end already on the hour is not extended). Series mode: `bucket` is `hour` for a range of at most 48 h (every hour of the rounded range is emitted, `value` null when the asset has no figure for that hour) else `day` (every local day overlapping the range is emitted, `ts` = that day's local midnight; the first and last day cover only the part inside the range). Values mode: `summarize`-style total over the rounded range; energy of a mapped meter with no hours is 0.0, cost with no priced hour is null; an asset with no energy figure at all is null. `partial` is true when some hour with consumption had no rate; `estimated` when any hour is estimated.
  - CSV: header `asset,source,unit,timestamp,value,estimated,partial`; `asset` = `AssetTree.path`; `source` = metric name, `energy` or `cost`; timestamps are the site-zone ISO strings from the JSON; series mode = one row per point per asset (with the point's own flags), values mode = one row per asset with `timestamp` = range start; flags are `true`/`false`; a null value is an empty cell.

- [ ] **Step 0: Verify prerequisites and the baseline**

```bash
cd backend
grep -n "def hourly_energy\|class EnergyResult" dcdash/core/energy.py
grep -n "def cost_by_hour\|def load_tariffs" dcdash/core/cost.py
grep -n "def resolve_range\|def local_days\|def validate_whole_hour_zone\|^ROLLING\|^RANGE_PRESETS" dcdash/core/timeutil.py
grep -n "class AssetTree\|def path" dcdash/core/tree.py
grep -n "def write_csv\|def safe_cell" dcdash/core/csvout.py
grep -n "def validate_config\|class WidgetConfig\|^WIDGET_TYPES" dcdash/core/widgets.py
grep -n "def get_currency" dcdash/core/settings_store.py
grep -n "tariffs" tests/conftest.py
uv run pytest tests/test_api_data.py tests/test_api_data_tiers.py -q
```

Expected: every grep prints at least one line (if one is empty, the earlier task is not merged: stop and report); the data tests pass.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_widget_data.py`:

```python
"""Widget data (Task 6): shapes, tiers, energy and cost sources, CSV, roles and errors.

Rollups are refreshed explicitly over whole days that lie in the past, so these tests never depend on where
the continuous-aggregate watermark sits and never move it ahead of the wall clock.
"""
import csv
import io
from datetime import datetime, timezone

import pytest
from helpers import insert_readings, login_as, make_asset, make_mapping, make_point, make_source

from dcdash.api import widget_data as widget_data_api
from dcdash.core.db import get_sessionmaker
from dcdash.core.tree import AssetTree
from dcdash.core.widgets import SiteZoneError, validate_config, widget_data

UTC = timezone.utc
NOW = datetime(2026, 3, 10, 10, 30, tzinfo=UTC)  # 13:30 on 2026-03-10 in Asia/Qatar (UTC+3, no DST)
KW_START = datetime(2026, 3, 10, 10, 0, tzinfo=UTC)
KWH_START = datetime(2026, 3, 9, 20, 30, tzinfo=UTC)  # 15 hourly counter readings at :30, the last at 10:30 on the 10th
TODAY = ("2026-03-10T00:00:00+03:00", "2026-03-10T13:30:00+03:00")  # preset `today` in Asia/Qatar at NOW
TOP_KEYS = {"type", "mode", "source", "metric", "unit", "range", "tier", "bucket", "series", "values", "missing"}
SERIES_KEYS = {"asset_id", "name", "points", "estimated", "partial"}
POINT_KEYS = {"ts", "value", "min", "max"}
VALUE_KEYS = {"asset_id", "name", "value", "estimated", "partial", "point_id"}
PATHS = ("/api/widget-data", "/api/widget-data/csv")


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(widget_data_api, "_now", lambda: NOW)


@pytest.fixture
async def session(db):
    async with get_sessionmaker()() as s:
        yield s


async def put_setting(db, key, value):
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        key, value,
    )


async def refresh_rollups(db):
    for view in ("readings_1m", "readings_1h"):  # readings_1h is built on readings_1m: refresh in this order
        await db.execute(f"CALL refresh_continuous_aggregate('{view}', '2026-03-07', '2026-03-12')")


async def seed_asset(db, name, parent_id=None, *, prefix, kw=None, kw_scale=1.0, kw_start=KW_START, kw_step=60, per_hour=None):
    """An asset with a kW mapping (readings `kw`, one every kw_step seconds) and/or an energy counter (+per_hour every hour)."""
    source = await db.fetchval("SELECT id FROM sources LIMIT 1") or await make_source(db)
    asset = await make_asset(db, name, parent_id)
    kw_point = kwh_point = None
    if kw is not None:
        kw_point = await make_point(db, source, f"{prefix}_kW")
        await make_mapping(db, kw_point, asset, "active_power_kw", 60, scale=kw_scale)
        await insert_readings(db, kw_point, kw_start, kw_step, kw)
    if per_hour is not None:
        kwh_point = await make_point(db, source, f"{prefix}_kWh")
        await make_mapping(db, kwh_point, asset, "energy_kwh", 60)
        await insert_readings(db, kwh_point, KWH_START, 3600, [100.0 + per_hour * i for i in range(15)])
    return asset, kw_point, kwh_point


async def seed_standard(db, *, tariff=True, currency="QAR"):
    """'LV Panel 1': kW readings 1..10 (scale 2) at 10:00-10:09, a counter rising 10 kWh an hour (140 kWh today)."""
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    if currency:
        await put_setting(db, "billing", {"currency": currency})
    asset, kw_point, _ = await seed_asset(
        db, "LV Panel 1", prefix="LVP01", kw=[float(i) for i in range(1, 11)], kw_scale=2.0, per_hour=10.0
    )
    await db.execute("INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, $2, 51.0, 0)", kw_point, NOW)
    if tariff:
        await db.execute(
            "INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) VALUES (NULL, 0.5, DATE '2026-03-01')"
        )
    await refresh_rollups(db)
    return asset


def config_of(assets, source="metric", aggregation="avg", **extra):
    config = {"assets": assets, "source": source, "aggregation": aggregation, **extra}
    if source == "metric":
        config.setdefault("metric", "active_power_kw")
    return config


def widget_body(widget_type, assets, source="metric", aggregation="avg", range_="today", **extra):
    return {"type": widget_type, "config": config_of(assets, source, aggregation, **extra), "range": range_}


async def run(session, widget_type, assets, source="metric", aggregation="avg", preset="today", **extra):
    config = validate_config(widget_type, config_of(assets, source, aggregation, **extra))
    return await widget_data(session, widget_type, config, preset, NOW)


async def post_csv(client, body):
    response = await client.post("/api/widget-data/csv", json=body)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert response.content.startswith(b"\xef\xbb\xbf")
    return response, list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))


# ---- shapes: every widget type x source, over the endpoint -------------------------------------------------

CASES = [
    ("timeseries", {}, "metric", "avg", "series"),
    ("timeseries", {}, "energy", "sum", "series"),
    ("timeseries", {}, "cost", "sum", "series"),
    ("bar", {"bars": "time"}, "metric", "max", "series"),
    ("bar", {"bars": "time"}, "energy", "sum", "series"),
    ("bar", {"bars": "time"}, "cost", "sum", "series"),
    ("bar", {"bars": "asset"}, "metric", "min", "values"),
    ("bar", {"bars": "asset"}, "energy", "sum", "values"),
    ("bar", {"bars": "asset"}, "cost", "sum", "values"),
    ("stat", {}, "metric", "avg", "values"),
    ("stat", {}, "energy", "sum", "values"),
    ("stat", {}, "cost", "sum", "values"),
    ("gauge", {"min": 0, "max": 200}, "metric", "last", "values"),
    ("table", {}, "metric", "avg", "values"),
    ("table", {}, "energy", "sum", "values"),
    ("table", {}, "cost", "sum", "values"),
]


@pytest.mark.parametrize(
    "widget_type,extra,source,aggregation,mode", CASES,
    ids=[f"{c[0]}{'-' + c[1]['bars'] if 'bars' in c[1] else ''}-{c[2]}" for c in CASES],
)
async def test_response_shape_for_every_type_and_source(client, db, widget_type, extra, source, aggregation, mode):
    asset = await seed_standard(db)
    await login_as(client, db, "viewer")
    response = await client.post("/api/widget-data", json=widget_body(widget_type, [asset], source, aggregation, **extra))
    assert response.status_code == 200, response.text
    data = response.json()
    assert set(data) == TOP_KEYS
    assert (data["type"], data["mode"], data["source"]) == (widget_type, mode, source)
    assert data["metric"] == ("active_power_kw" if source == "metric" else None)
    assert data["unit"] == {"metric": "kW", "energy": "kWh", "cost": "QAR"}[source]
    assert data["range"] == {"preset": "today", "start": TODAY[0], "end": TODAY[1]} and data["missing"] == []
    if mode == "series":
        assert data["values"] == [] and len(data["series"]) == 1
        series = data["series"][0]
        assert set(series) == SERIES_KEYS and series["points"] and set(series["points"][0]) == POINT_KEYS
        assert (data["tier"], data["bucket"]) == (("1m", None) if source == "metric" else (None, "hour"))
    else:
        assert data["series"] == [] and len(data["values"]) == 1 and set(data["values"][0]) == VALUE_KEYS
        assert data["bucket"] is None and data["values"][0]["value"] is not None
        assert (data["values"][0]["point_id"] is not None) == (source == "metric")
        assert data["tier"] == (None if source != "metric" or aggregation == "last" else "1m")


# ---- metric source -----------------------------------------------------------------------------------------

async def test_metric_aggregations_are_scaled_and_use_the_tier_for_the_range(db, session):
    asset = await seed_standard(db)
    for aggregation, expected in (("avg", 11.0), ("min", 2.0), ("max", 20.0)):  # readings 1..10 x scale 2
        data = await run(session, "stat", [asset], aggregation=aggregation, preset="24h")
        assert data["values"][0]["value"] == pytest.approx(expected)
        assert data["tier"] == "1m" and data["unit"] == "kW"


@pytest.mark.parametrize("preset", ["1h", "24h", "30d"])  # raw, 1m and 1h tiers
async def test_avg_is_sample_weighted_not_a_mean_of_bucket_means(db, session, preset):
    # minute 10:00 holds three samples of 10, minute 10:01 one sample of 0: weighted 30/4 = 7.5, mean of means 5
    asset, _, _ = await seed_asset(db, "Weighted", prefix="WGT", kw=[10.0, 10.0, 10.0, 0.0], kw_step=20)
    await refresh_rollups(db)
    data = await run(session, "stat", [asset], preset=preset)
    assert data["values"][0]["value"] == pytest.approx(7.5)


@pytest.mark.parametrize("preset,tier", [("1h", "raw"), ("24h", "1m"), ("7d", "1m"), ("30d", "1h")])
async def test_series_tier_follows_the_range(db, session, preset, tier):
    asset = await seed_standard(db)
    data = await run(session, "timeseries", [asset], preset=preset)
    assert data["tier"] == tier and data["bucket"] is None
    points = data["series"][0]["points"]
    assert points and all(p["min"] <= p["value"] <= p["max"] for p in points)
    if preset == "1h":  # 12-second buckets: one point per reading, scale applied at read time
        assert [p["value"] for p in points] == [2.0 * i for i in range(1, 11)]
    assert (await run(session, "stat", [asset], preset=preset))["tier"] == tier


@pytest.mark.parametrize("preset", ["1h", "24h", "today", "this_month"])
async def test_last_on_a_rolling_range_is_the_latest_reading_with_its_point_id(db, session, preset):
    asset = await seed_standard(db)
    kw_point = await db.fetchval("SELECT point_id FROM mappings WHERE metric = 'active_power_kw'")
    data = await run(session, "gauge", [asset], aggregation="last", preset=preset, min=0, max=200)
    assert data["values"][0]["value"] == pytest.approx(102.0)  # point_latest 51.0 x scale 2
    assert data["values"][0]["point_id"] == kw_point and data["tier"] is None


async def test_last_on_a_finished_range_is_the_last_rollup_value(db, session):
    asset = await seed_standard(db)
    kw_point = await db.fetchval("SELECT point_id FROM mappings WHERE metric = 'active_power_kw'")
    await insert_readings(db, kw_point, datetime(2026, 3, 9, 12, 0, tzinfo=UTC), 60, [7.0, 8.0, 9.0])
    await refresh_rollups(db)
    value = (await run(session, "stat", [asset], aggregation="last", preset="yesterday"))["values"][0]
    assert value["value"] == pytest.approx(18.0)  # 9.0 x scale 2; NOT the latest reading (102.0)
    assert value["point_id"] == kw_point


@pytest.mark.parametrize(
    "preset,start,end",
    [
        ("today", *TODAY),
        ("yesterday", "2026-03-09T00:00:00+03:00", "2026-03-10T00:00:00+03:00"),
        ("this_month", "2026-03-01T00:00:00+03:00", TODAY[1]),
        ("last_month", "2026-02-01T00:00:00+03:00", "2026-03-01T00:00:00+03:00"),
        ("24h", "2026-03-09T13:30:00+03:00", TODAY[1]),
    ],
)
async def test_presets_resolve_in_the_site_zone(db, session, preset, start, end):
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    asset = await make_asset(db, "Bare")  # no mapping: the value is null and has no point to follow
    data = await run(session, "stat", [asset], preset=preset)
    assert data["range"] == {"preset": preset, "start": start, "end": end}
    assert data["values"][0]["value"] is None and data["values"][0]["point_id"] is None


# ---- energy and cost sources -------------------------------------------------------------------------------

async def test_energy_and_cost_totals_over_today(db, session):
    asset = await seed_standard(db)
    energy = await run(session, "stat", [asset], "energy", "sum")
    assert (energy["unit"], energy["metric"], energy["tier"]) == ("kWh", None, None)
    assert energy["values"][0] == {
        "asset_id": asset, "name": "LV Panel 1", "value": pytest.approx(140.0),
        "estimated": False, "partial": False, "point_id": None,
    }
    cost = await run(session, "stat", [asset], "cost", "sum")
    assert cost["unit"] == "QAR" and cost["values"][0]["value"] == pytest.approx(70.0)  # 140 kWh x 0.5
    assert cost["values"][0]["partial"] is False


async def test_a_power_only_meter_is_estimated(db, session):
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    start = datetime(2026, 3, 10, 9, 0, tzinfo=UTC)
    asset, _, _ = await seed_asset(db, "Pump", prefix="PMP", kw=[6.0] * 60, kw_start=start)  # 6 kW for 09:00-09:59
    await refresh_rollups(db)
    value = (await run(session, "stat", [asset], "energy", "sum"))["values"][0]
    assert value["value"] == pytest.approx(6.0) and value["estimated"] is True
    assert (await run(session, "timeseries", [asset], "energy", "sum"))["series"][0]["estimated"] is True


async def test_a_parent_without_a_meter_sums_its_children(db, session):
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    parent, _, _ = await seed_asset(db, "MV2", prefix="MV2")
    first, _, _ = await seed_asset(db, "LV Panel 1", parent, prefix="A", per_hour=10.0)
    second, _, _ = await seed_asset(db, "LV Panel 2", parent, prefix="B", per_hour=5.0)
    await refresh_rollups(db)
    data = await run(session, "table", [parent, first, second], "energy", "sum")
    assert [(v["asset_id"], v["value"]) for v in data["values"]] == [
        (parent, pytest.approx(210.0)), (first, pytest.approx(140.0)), (second, pytest.approx(70.0)),
    ]


async def test_energy_series_is_hourly_up_to_48_hours_then_daily(db, session):
    asset = await seed_standard(db)
    hourly = await run(session, "timeseries", [asset], "energy", "sum", preset="today")
    assert (hourly["bucket"], hourly["tier"]) == ("hour", None)
    points = hourly["series"][0]["points"]
    assert len(points) == 14 and points[0]["ts"] == TODAY[0] and points[-1]["ts"] == "2026-03-10T13:00:00+03:00"
    assert [p["value"] for p in points] == pytest.approx([10.0] * 14)
    assert all(p["min"] is None and p["max"] is None for p in points)

    daily = await run(session, "timeseries", [asset], "energy", "sum", preset="7d")
    days = daily["series"][0]["points"]
    assert daily["bucket"] == "day" and len(days) == 8
    assert days[0]["ts"] == "2026-03-03T00:00:00+03:00" and days[0]["value"] is None  # no data: a gap, not zero
    assert days[-1]["ts"] == "2026-03-10T00:00:00+03:00" and days[-1]["value"] == pytest.approx(140.0)
    assert sum(p["value"] for p in days if p["value"] is not None) == pytest.approx(140.0)

    costs = (await run(session, "timeseries", [asset], "cost", "sum", preset="7d"))["series"][0]
    assert costs["points"][-1]["value"] == pytest.approx(70.0) and costs["partial"] is False


async def test_cost_without_a_tariff_is_null_not_zero(db, session):
    asset = await seed_standard(db, tariff=False, currency=None)
    data = await run(session, "stat", [asset], "cost", "sum")
    value = data["values"][0]
    assert data["unit"] is None  # no currency set
    assert value["value"] is None and value["partial"] is True  # consumption existed but no rate applied: a dash
    series = (await run(session, "timeseries", [asset], "cost", "sum"))["series"][0]
    assert all(p["value"] is None for p in series["points"]) and series["partial"] is True


async def test_a_half_hour_zone_is_refused(db, session):
    await put_setting(db, "general", {"timezone": "Asia/Kolkata"})  # UTC+5:30
    asset = await make_asset(db, "Bare")
    with pytest.raises(SiteZoneError):
        await run(session, "stat", [asset])


@pytest.mark.parametrize("source,aggregation", [("metric", "avg"), ("energy", "sum")])
async def test_deleted_assets_are_skipped_and_listed(db, session, source, aggregation):  # Review Focus 5
    live = await seed_standard(db)
    gone = await make_asset(db, "Gone")
    await db.execute("DELETE FROM assets WHERE id = $1", gone)
    table = await run(session, "table", [gone, live], source, aggregation)
    assert table["missing"] == [gone] and [v["asset_id"] for v in table["values"]] == [live]
    series = await run(session, "timeseries", [gone, live], source, aggregation)
    assert series["missing"] == [gone] and [s["asset_id"] for s in series["series"]] == [live]


# ---- endpoint: roles, errors -------------------------------------------------------------------------------

async def test_viewer_may_read_and_anonymous_may_not(client, db):
    asset = await seed_standard(db)
    for path in PATHS:
        assert (await client.post(path, json=widget_body("stat", [asset]))).status_code == 401
    await login_as(client, db, "viewer")
    for path in PATHS:
        assert (await client.post(path, json=widget_body("stat", [asset]))).status_code == 200


INVALID = [
    ("stat", {"assets": [1, 2], "source": "metric", "metric": "active_power_kw", "aggregation": "avg"}),
    ("gauge", {"assets": [1], "source": "energy", "aggregation": "sum", "min": 0, "max": 10}),
    ("stat", {"assets": [1], "source": "metric", "metric": "custom", "aggregation": "avg"}),
    ("timeseries", {"assets": list(range(1, 22)), "source": "metric", "metric": "active_power_kw", "aggregation": "avg"}),
    ("stat", {"assets": [1], "source": "metric", "metric": "active_power_kw", "aggregation": "avg", "range": "3d"}),
]


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("widget_type,config", INVALID)
async def test_an_invalid_config_is_422_with_a_reason(client, db, path, widget_type, config):
    await login_as(client, db, "viewer")
    response = await client.post(path, json={"type": widget_type, "config": config, "range": "24h"})
    assert response.status_code == 422 and response.json()["detail"]


@pytest.mark.parametrize("body", [
    {"type": "stat", "config": config_of([1]), "range": "3d"},           # range must be a preset
    {"type": "pie", "config": config_of([1]), "range": "24h"},           # unknown widget type
])
async def test_a_bad_request_body_is_422(client, db, body):
    await login_as(client, db, "viewer")
    for path in PATHS:
        assert (await client.post(path, json=body)).status_code == 422


async def test_a_half_hour_zone_stored_directly_is_409(client, db):
    asset = await seed_standard(db)
    await put_setting(db, "general", {"timezone": "Asia/Kolkata"})  # PUT /api/settings/general refuses it; SQL does not
    await login_as(client, db, "viewer")
    for path in PATHS:
        response = await client.post(path, json=widget_body("stat", [asset]))
        assert response.status_code == 409 and response.json()["detail"]


async def test_a_deleted_asset_does_not_break_the_widget_or_its_csv(client, db):  # Review Focus 5
    live = await seed_standard(db)
    gone = await make_asset(db, "Gone")
    await db.execute("DELETE FROM assets WHERE id = $1", gone)
    await login_as(client, db, "viewer")
    body = widget_body("table", [gone, live])
    response = await client.post("/api/widget-data", json=body)
    assert response.status_code == 200
    assert response.json()["missing"] == [gone] and [v["asset_id"] for v in response.json()["values"]] == [live]
    _, rows = await post_csv(client, body)
    assert len(rows) == 2  # header and the surviving asset


# ---- CSV ---------------------------------------------------------------------------------------------------

async def test_csv_values_mode_has_one_row_per_asset_stamped_with_the_range_start(client, db, session):
    asset = await seed_standard(db)
    await login_as(client, db, "viewer")
    response, rows = await post_csv(client, widget_body("stat", [asset]))
    path = (await AssetTree.load(session)).path(asset)
    assert rows[0] == ["asset", "source", "unit", "timestamp", "value", "estimated", "partial"]
    assert len(rows) == 2 and rows[1][:4] == [path, "active_power_kw", "kW", TODAY[0]]
    assert float(rows[1][4]) == pytest.approx(11.0) and rows[1][5:] == ["false", "false"]
    assert response.headers["content-disposition"] == 'attachment; filename="stat-today.csv"'


async def test_csv_series_mode_has_one_row_per_point_in_the_site_zone(client, db):
    asset = await seed_standard(db)
    await login_as(client, db, "viewer")
    response, rows = await post_csv(client, widget_body("timeseries", [asset], "cost", "sum"))
    assert len(rows) == 15  # header and 14 hours
    assert rows[1][1:4] == ["cost", "QAR", TODAY[0]] and rows[-1][3] == "2026-03-10T13:00:00+03:00"
    assert [float(r[4]) for r in rows[1:]] == pytest.approx([5.0] * 14)
    assert {tuple(r[5:]) for r in rows[1:]} == {("false", "false")}
    assert response.headers["content-disposition"] == 'attachment; filename="timeseries-today.csv"'


async def test_csv_leaves_an_unpriced_cost_cell_empty(client, db):
    asset = await seed_standard(db, tariff=False)
    await login_as(client, db, "viewer")
    _, rows = await post_csv(client, widget_body("stat", [asset], "cost", "sum"))
    assert rows[1][2] == "QAR" and rows[1][4] == "" and rows[1][6] == "true"


async def test_csv_neutralises_a_formula_asset_name(client, db, session):  # Review Focus 5
    await put_setting(db, "general", {"timezone": "Asia/Qatar"})
    name = '=HYPERLINK("http://x","y")'
    asset, _, _ = await seed_asset(db, name, prefix="EVIL", kw=[1.0, 2.0])  # a ROOT asset: its path is its name
    await refresh_rollups(db)
    await login_as(client, db, "viewer")
    assert (await AssetTree.load(session)).path(asset) == name
    for body in (widget_body("stat", [asset]), widget_body("timeseries", [asset], range_="1h")):
        _, rows = await post_csv(client, body)
        assert len(rows) > 1
        assert all(row[0] == "'" + name for row in rows[1:])
        assert not any(cell[:1] in ("=", "+", "@", "\t", "\r") for row in rows[1:] for cell in row)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_widget_data.py -v`
Expected: collection ERROR `ImportError: cannot import name 'widget_data' from 'dcdash.api'` (the router module and `SiteZoneError` do not exist yet).

- [ ] **Step 3: Extract the series queries (refactor; existing tests stay green)**

Create `backend/dcdash/core/series.py`. The two SQL blocks `_SERIES_RAW` and `_SERIES_ROLLUP` are the ones currently in `api/data.py`, moved verbatim:

```python
"""Metric reads over the storage tiers (spec section 6), shared by GET /api/assets/{id}/series and widget data.

Every value is scaled at read time with the mapping's scale. Raw readings and both rollups hold unscaled values.
"""
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.metrics import Metric
from dcdash.core.models import Mapping, PointLatest

DEFAULT_BUCKETS = 300  # points a chart aims for; also decides which tier serves a range
_GOOD = "quality = 0 AND value IS NOT NULL"
_SERIES_RAW = text(
    f"""
    SELECT time_bucket(make_interval(secs => :width), ts) AS bucket,
           avg(value) AS avg_value, min(value) AS min_value, max(value) AS max_value
    FROM readings
    WHERE point_id = :point AND ts >= :start AND ts < :end AND {_GOOD}
    GROUP BY bucket ORDER BY bucket
    """
)
# Rollup tiers carry sum/n so the re-bucketed average is weighted by sample
# count, not a mean of per-bucket means. Both views are real-time caggs, so
# the not-yet-materialized tail is included.
_SERIES_ROLLUP = {
    tier: text(
        f"""
        SELECT time_bucket(make_interval(secs => :width), bucket) AS bucket,
               sum(sum_value) / sum(n) AS avg_value, min(min_value) AS min_value, max(max_value) AS max_value
        FROM {view}
        WHERE point_id = :point AND bucket >= :start AND bucket < :end
        GROUP BY 1 ORDER BY 1
        """
    )
    for tier, view in {"1m": "readings_1m", "1h": "readings_1h"}.items()
}
# One figure for the whole range: summing sum_value and n over the tier's buckets keeps the average weighted.
_RANGE_RAW = text(
    f"""
    SELECT sum(value) AS sum_value, count(value) AS n, min(value) AS min_value, max(value) AS max_value
    FROM readings
    WHERE point_id = :point AND ts >= :start AND ts < :end AND {_GOOD}
    """
)
_RANGE_ROLLUP = {
    tier: text(
        f"""
        SELECT sum(sum_value) AS sum_value, sum(n) AS n, min(min_value) AS min_value, max(max_value) AS max_value
        FROM {view}
        WHERE point_id = :point AND bucket >= :start AND bucket < :end
        """
    )
    for tier, view in {"1m": "readings_1m", "1h": "readings_1h"}.items()
}
_LAST_ROLLUP = text(
    """
    SELECT last_value FROM readings_1h
    WHERE point_id = :point AND bucket >= :start AND bucket < :end
    ORDER BY bucket DESC LIMIT 1
    """
)


@dataclass(frozen=True)
class SeriesPoint:
    ts: datetime
    avg: float
    min: float
    max: float


@dataclass(frozen=True)
class SeriesResult:
    tier: str
    points: list[SeriesPoint]


@dataclass(frozen=True)
class Aggregate:
    avg: float | None
    min: float | None
    max: float | None


def pick_tier(width_seconds: float) -> str:
    """Which readings tier serves a chart whose buckets are `width_seconds` wide."""
    if width_seconds < 60:
        return "raw"
    if width_seconds < 3600:
        return "1m"
    return "1h"


def bucket_width(start: datetime, end: datetime, buckets: int) -> float:
    return max((end - start).total_seconds() / buckets, 1.0)


def series_tier(start: datetime, end: datetime, buckets: int = DEFAULT_BUCKETS) -> str:
    return pick_tier(bucket_width(start, end, buckets))


async def find_mapping(
    db: AsyncSession, asset_id: int, metric: Metric, mapping_id: int | None = None
) -> Mapping | None:
    query = select(Mapping).where(Mapping.asset_id == asset_id, Mapping.metric == metric.value)
    if mapping_id is not None:
        query = query.where(Mapping.id == mapping_id)
    return (await db.scalars(query.order_by(Mapping.id))).first()


async def first_mappings(db: AsyncSession, asset_ids: Sequence[int], metric: Metric) -> dict[int, Mapping]:
    """The lowest-id mapping of `metric` for each asset that has one."""
    if not asset_ids:
        return {}
    rows = await db.scalars(
        select(Mapping).where(Mapping.asset_id.in_(list(asset_ids)), Mapping.metric == metric.value).order_by(Mapping.id)
    )
    found: dict[int, Mapping] = {}
    for mapping in rows:
        found.setdefault(mapping.asset_id, mapping)
    return found


async def metric_series(
    db: AsyncSession, mapping: Mapping, start: datetime, end: datetime, buckets: int
) -> SeriesResult:
    width = bucket_width(start, end, buckets)
    tier = pick_tier(width)
    statement = _SERIES_RAW if tier == "raw" else _SERIES_ROLLUP[tier]
    rows = await db.execute(statement, {"width": width, "point": mapping.point_id, "start": start, "end": end})
    return SeriesResult(
        tier,
        [
            SeriesPoint(
                row.bucket, row.avg_value * mapping.scale, row.min_value * mapping.scale, row.max_value * mapping.scale
            )
            for row in rows
        ],
    )


async def metric_aggregate(
    db: AsyncSession, mapping: Mapping, start: datetime, end: datetime, buckets: int = DEFAULT_BUCKETS
) -> Aggregate:
    """avg (sample-weighted), min and max over the whole range, from the tier a chart of this range would use."""
    tier = series_tier(start, end, buckets)
    statement = _RANGE_RAW if tier == "raw" else _RANGE_ROLLUP[tier]
    row = (await db.execute(statement, {"point": mapping.point_id, "start": start, "end": end})).one()
    if not row.n:
        return Aggregate(None, None, None)
    low, high = sorted((float(row.min_value) * mapping.scale, float(row.max_value) * mapping.scale))  # a negative scale swaps them
    return Aggregate(float(row.sum_value) / float(row.n) * mapping.scale, low, high)


async def last_rollup_value(db: AsyncSession, mapping: Mapping, start: datetime, end: datetime) -> float | None:
    """The last hourly rollup value inside a finished range, scaled."""
    value = await db.scalar(_LAST_ROLLUP, {"point": mapping.point_id, "start": start, "end": end})
    return None if value is None else float(value) * mapping.scale


async def latest_values(db: AsyncSession, mappings: Sequence[Mapping]) -> dict[int, float | None]:
    """Scaled `point_latest` value per mapping id (None when the point has never reported or reported no value)."""
    if not mappings:
        return {}
    rows = await db.scalars(select(PointLatest).where(PointLatest.point_id.in_({m.point_id for m in mappings})))
    by_point = {row.point_id: row for row in rows}
    out: dict[int, float | None] = {}
    for mapping in mappings:
        latest = by_point.get(mapping.point_id)
        out[mapping.id] = None if latest is None or latest.value is None else latest.value * mapping.scale
    return out
```

Now edit `backend/dcdash/api/data.py` with targeted edits (Tasks 2 and 4 also edit this file: do NOT replace the whole file). `Read` it first, then:

1. Add to the imports: `from dcdash.core.series import find_mapping, metric_series, pick_tier  # noqa: F401  (pick_tier is re-exported: tests import it from here)`.
2. Delete the block from `_SERIES_RAW = text(` through the closing `}` of `_SERIES_ROLLUP` (including the three comment lines above `_SERIES_ROLLUP`), and delete `def pick_tier(...)` with its docstring. They now live in `core/series.py`.
3. Replace the body of `series()` that starts at `query = select(Mapping).where(Mapping.asset_id == asset_id, ...` and ends with the `return {...}` (the decorator, signature, the `end = end or ...`, tz check and `end <= start` check above it stay exactly as they are) with:

```python
    mapping = await find_mapping(db, asset_id, metric, mapping_id)
    if mapping is None:
        raise HTTPException(404, "this asset has no such metric")
    found = await metric_series(db, mapping, start, end, buckets)
    return {
        "metric": metric.value,
        "unit": unit_for(metric, mapping.custom_unit),
        "tier": found.tier,
        "points": [{"ts": p.ts, "avg": p.avg, "min": p.min, "max": p.max} for p in found.points],
    }
```

4. Run `grep -n "_GOOD\|text(\|\btext\b" dcdash/api/data.py`: delete the `_GOOD` constant and the `text` import only if nothing else in the file still uses them (after Task 2 removed the raw energy SQL, usually neither is used). Keep `select`, `Mapping`, `Asset`, `PointLatest`, `Query` if still used.

Run: `cd backend && uv run pytest tests/test_api_data.py tests/test_api_data_tiers.py -v`
Expected: PASS, unchanged tests (same response keys: `metric`, `unit`, `tier`, `points[ts, avg, min, max]`; `pick_tier` still importable from `dcdash.api.data`).

- [ ] **Step 4: Implement `widget_data` in `core/widgets.py`**

`Read` the file first. Merge these names into its import block at the top (keep Task 5's imports, do not duplicate a name):

```python
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.settings import current_timezone
from dcdash.core.cost import cost_by_hour, load_tariffs
from dcdash.core.energy import hourly_energy
from dcdash.core.metrics import Metric, unit_for
from dcdash.core.series import (
    DEFAULT_BUCKETS, first_mappings, last_rollup_value, latest_values, metric_aggregate, metric_series, series_tier,
)
from dcdash.core.settings_store import get_currency
from dcdash.core.timeutil import ROLLING, local_days, resolve_range, validate_whole_hour_zone
from dcdash.core.tree import AssetTree
```

Then append at the end of the file:

```python
# ---- widget data -------------------------------------------------------------------------------------------

LIVE_LAST = frozenset(ROLLING) | {"today", "this_month"}  # presets that end now: `last` is the latest reading
HOUR = timedelta(hours=1)
HOURLY_UP_TO = timedelta(hours=48)  # energy/cost series are hourly up to this range length, daily beyond


class SiteZoneError(Exception):
    """The stored site timezone breaks the whole-hour rule (spec section 6); the API answers 409."""


@dataclass
class _Point:
    ts: datetime
    value: float | None
    min: float | None = None
    max: float | None = None
    estimated: bool = False
    partial: bool = False


@dataclass
class _Series:
    asset_id: int
    name: str
    path: str
    points: list[_Point]


@dataclass
class _Value:
    asset_id: int
    name: str
    path: str
    value: float | None
    estimated: bool = False
    partial: bool = False
    point_id: int | None = None


@dataclass(frozen=True)
class _Fig:
    value: float | None
    estimated: bool
    partial: bool


@dataclass
class WidgetResult:
    type: str
    mode: str
    source: str
    metric: str | None
    unit: str | None
    preset: str
    start: datetime  # site zone
    end: datetime
    tier: str | None = None
    bucket: str | None = None
    series: list[_Series] = field(default_factory=list)
    values: list[_Value] = field(default_factory=list)
    missing: list[int] = field(default_factory=list)

    def as_json(self) -> dict[str, Any]:
        return {
            "type": self.type, "mode": self.mode, "source": self.source, "metric": self.metric, "unit": self.unit,
            "range": {"preset": self.preset, "start": self.start.isoformat(), "end": self.end.isoformat()},
            "tier": self.tier, "bucket": self.bucket,
            "series": [
                {
                    "asset_id": s.asset_id, "name": s.name,
                    "points": [{"ts": p.ts.isoformat(), "value": p.value, "min": p.min, "max": p.max} for p in s.points],
                    "estimated": any(p.estimated for p in s.points), "partial": any(p.partial for p in s.points),
                }
                for s in self.series
            ],
            "values": [
                {"asset_id": v.asset_id, "name": v.name, "value": v.value, "estimated": v.estimated,
                 "partial": v.partial, "point_id": v.point_id}
                for v in self.values
            ],
            "missing": self.missing,
        }

    def csv_rows(self) -> list[list[object]]:
        """Rows for core/csvout.write_csv: numbers stay numbers, a null value is an empty cell, flags are true/false."""
        source, unit = self.metric or self.source, self.unit or ""

        def row(path: str, ts: datetime, value: float | None, estimated: bool, partial: bool) -> list[object]:
            return [path, source, unit, ts.isoformat(), "" if value is None else value,
                    "true" if estimated else "false", "true" if partial else "false"]

        rows = [row(s.path, p.ts, p.value, p.estimated, p.partial) for s in self.series for p in s.points]
        rows += [row(v.path, self.start, v.value, v.estimated, v.partial) for v in self.values]
        return rows


def _mode(widget_type: str, config: WidgetConfig) -> str:
    return "series" if widget_type == "timeseries" or (widget_type == "bar" and config.bars == "time") else "values"


def _floor_hour(moment: datetime) -> datetime:
    return moment.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def _ceil_hour(moment: datetime) -> datetime:
    floor = _floor_hour(moment)
    return floor if floor == moment else floor + HOUR


def _combine(figs: list[_Fig]) -> _Fig:
    """Sum of the non-null values (null when there are none); estimated/partial if any part is."""
    values = [fig.value for fig in figs if fig.value is not None]
    return _Fig(sum(values) if values else None, any(f.estimated for f in figs), any(f.partial for f in figs))


def _figures(
    source: str, energy_hours: dict | None, cost_hours: dict | None, first: datetime, last: datetime
) -> dict[datetime, _Fig] | None:
    """One figure per UTC hour in [first, last) for an asset, or None when it has no energy figure at all."""
    if source == "energy":
        if energy_hours is None:
            return None
        return {h: _Fig(e.kwh, e.estimated, False) for h, e in energy_hours.items() if first <= h < last}
    if cost_hours is None:
        return None
    return {h: _Fig(c.cost, c.estimated, c.unpriced) for h, c in cost_hours.items() if first <= h < last}


def _hour_points(figs: dict[datetime, _Fig], first: datetime, last: datetime, zone: ZoneInfo) -> list[_Point]:
    points, hour, none = [], first, _Fig(None, False, False)
    while hour < last:
        fig = figs.get(hour, none)
        points.append(_Point(hour.astimezone(zone), fig.value, None, None, fig.estimated, fig.partial))
        hour += HOUR
    return points


def _day_points(
    figs: dict[datetime, _Fig], first: datetime, last: datetime, tz_name: str, zone: ZoneInfo
) -> list[_Point]:
    points = []
    for day, begin, stop in local_days(first, last, tz_name):
        total = _combine([fig for hour, fig in figs.items() if begin <= hour < stop])
        midnight = datetime.combine(day, time.min, tzinfo=zone)  # the bucket is labelled by its local day
        points.append(_Point(midnight, total.value, None, None, total.estimated, total.partial))
    return points


async def _fill_metric(
    db: AsyncSession, result: WidgetResult, tree: AssetTree, config: WidgetConfig,
    asset_ids: list[int], start: datetime, end: datetime, preset: str, zone: ZoneInfo,
) -> None:
    aggregation = config.aggregation
    if aggregation not in ("avg", "min", "max", "last"):
        raise ValueError(f"aggregation {aggregation} does not apply to a metric")
    metric = Metric(config.metric)
    result.metric, result.unit = metric.value, unit_for(metric, None)
    mappings = await first_mappings(db, asset_ids, metric)
    if result.mode == "series":
        result.tier = series_tier(start, end, DEFAULT_BUCKETS)
        for asset_id in asset_ids:
            mapping, points = mappings.get(asset_id), []
            if mapping is not None:
                found = await metric_series(db, mapping, start, end, DEFAULT_BUCKETS)
                points = [_Point(p.ts.astimezone(zone), p.avg, p.min, p.max) for p in found.points]
            result.series.append(_Series(asset_id, tree.nodes[asset_id].name, tree.path(asset_id), points))
        return
    live = aggregation == "last" and preset in LIVE_LAST
    latest = await latest_values(db, list(mappings.values())) if live else {}
    result.tier = None if aggregation == "last" else series_tier(start, end, DEFAULT_BUCKETS)
    for asset_id in asset_ids:
        mapping, value = mappings.get(asset_id), None
        if mapping is not None and aggregation == "last":
            value = latest.get(mapping.id) if live else await last_rollup_value(db, mapping, start, end)
        elif mapping is not None:
            value = getattr(await metric_aggregate(db, mapping, start, end, DEFAULT_BUCKETS), aggregation)
        result.values.append(_Value(
            asset_id, tree.nodes[asset_id].name, tree.path(asset_id), value,
            point_id=None if mapping is None else mapping.point_id,
        ))


async def _fill_billing(
    db: AsyncSession, result: WidgetResult, tree: AssetTree, config: WidgetConfig,
    asset_ids: list[int], start: datetime, end: datetime, tz_name: str, zone: ZoneInfo,
) -> None:
    result.unit = "kWh" if config.source == "energy" else await get_currency(db)
    hourly = end - start <= HOURLY_UP_TO
    if result.mode == "series":
        result.bucket = "hour" if hourly else "day"
    if not asset_ids:
        return
    first, last = _floor_hour(start), _ceil_hour(end)
    energy = await hourly_energy(db, tree, first, last)
    costs = cost_by_hour(energy, await load_tariffs(db), tree, tz_name) if config.source == "cost" else {}
    for asset_id in asset_ids:
        figs = _figures(config.source, energy.hours.get(asset_id), costs.get(asset_id), first, last)
        name, path = tree.nodes[asset_id].name, tree.path(asset_id)
        if result.mode == "series":
            if figs is None:
                points: list[_Point] = []
            elif hourly:
                points = _hour_points(figs, first, last, zone)
            else:
                points = _day_points(figs, first, last, tz_name, zone)
            result.series.append(_Series(asset_id, name, path, points))
        elif figs is None:
            result.values.append(_Value(asset_id, name, path, None))
        else:
            total = _combine(list(figs.values()))
            value = 0.0 if total.value is None and config.source == "energy" else total.value
            result.values.append(_Value(asset_id, name, path, value, total.estimated, total.partial))


async def compute_widget(
    db: AsyncSession, widget_type: str, config: WidgetConfig, preset: str, now: datetime
) -> WidgetResult:
    tz_name = await current_timezone(db)
    try:
        validate_whole_hour_zone(tz_name)
    except ValueError as exc:
        raise SiteZoneError(f"the site timezone {tz_name} cannot be used for energy ranges: {exc}") from None
    zone = ZoneInfo(tz_name)
    start, end = resolve_range(preset, now, tz_name)
    tree = await AssetTree.load(db)
    result = WidgetResult(
        type=widget_type, mode=_mode(widget_type, config), source=config.source, metric=None, unit=None,
        preset=preset, start=start.astimezone(zone), end=end.astimezone(zone),
        missing=[asset_id for asset_id in config.assets if asset_id not in tree.nodes],
    )
    asset_ids = [asset_id for asset_id in config.assets if asset_id in tree.nodes]
    if config.source == "metric":
        await _fill_metric(db, result, tree, config, asset_ids, start, end, preset, zone)
    else:
        await _fill_billing(db, result, tree, config, asset_ids, start, end, tz_name, zone)
    return result


async def widget_data(
    db: AsyncSession, widget_type: str, config: WidgetConfig, preset: str, now: datetime
) -> dict[str, Any]:
    """The figures a widget draws, as the JSON body of POST /api/widget-data. `preset` is the effective range."""
    return (await compute_widget(db, widget_type, config, preset, now)).as_json()
```

- [ ] **Step 5: The endpoints**

`backend/dcdash/api/widget_data.py`:

```python
"""POST /api/widget-data and /api/widget-data/csv (spec 10.6). Reads only; every role may call them."""
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.deps import get_db, require_role
from dcdash.core.csvout import write_csv
from dcdash.core.timeutil import RANGE_PRESETS
from dcdash.core.widgets import WIDGET_TYPES, SiteZoneError, WidgetResult, compute_widget, validate_config

router = APIRouter(prefix="/api", tags=["widget-data"], dependencies=[Depends(require_role("viewer"))])
CSV_HEADER = ("asset", "source", "unit", "timestamp", "value", "estimated", "partial")


def _now() -> datetime:
    """The clock for range presets. Tests replace this function; nothing else in this module reads the clock."""
    return datetime.now(timezone.utc).replace(microsecond=0)


class WidgetDataRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str
    config: dict[str, Any]
    range: str  # the effective preset: the client resolves "inherit the dashboard's"

    @field_validator("type")
    @classmethod
    def _known_type(cls, value: str) -> str:
        if value not in WIDGET_TYPES:
            raise ValueError(f"unknown widget type: {value}")
        return value

    @field_validator("range")
    @classmethod
    def _known_range(cls, value: str) -> str:
        if value not in RANGE_PRESETS:
            raise ValueError(f"range must be one of {', '.join(RANGE_PRESETS)}")
        return value


async def _compute(body: WidgetDataRequest, db: AsyncSession) -> WidgetResult:
    try:
        config = validate_config(body.type, body.config)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    try:
        return await compute_widget(db, body.type, config, body.range, _now())
    except SiteZoneError as exc:
        raise HTTPException(409, str(exc)) from None


@router.post("/widget-data")
async def post_widget_data(body: WidgetDataRequest, db: AsyncSession = Depends(get_db)) -> dict[str, Any]:
    return (await _compute(body, db)).as_json()


@router.post("/widget-data/csv")
async def post_widget_data_csv(body: WidgetDataRequest, db: AsyncSession = Depends(get_db)) -> Response:
    result = await _compute(body, db)
    return Response(
        write_csv(CSV_HEADER, result.csv_rows()),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{body.type}-{body.range}.csv"'},
    )
```

`backend/dcdash/api/main.py`: add `widget_data` to the `from dcdash.api import (...)` list and `widget_data.router` to the tuple of routers passed to `app.include_router` (other tasks add theirs to the same places: add yours without touching theirs).

- [ ] **Step 6: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_widget_data.py -v`
Expected: PASS (about 60 cases).

If `test_csv_neutralises_a_formula_asset_name` fails on `AssetTree.path(asset) == name`, the path of a root asset is not its bare name: report it (do not weaken the test). If `test_cost_without_a_tariff_is_null_not_zero` fails on `partial`, check `cost.summarize`/`HourCost.unpriced` against the contract (`unpriced` is true when kwh > 0 and no rate applied).

Then the whole backend suite: `cd backend && uv run pytest -q`
Expected: PASS (the `/series` tests in `test_api_data.py` and `test_api_data_tiers.py` are unchanged and green).

- [ ] **Step 7: Commit and push**

```bash
git add backend/dcdash/core/series.py backend/dcdash/core/widgets.py backend/dcdash/api/widget_data.py \
  backend/dcdash/api/data.py backend/dcdash/api/main.py backend/tests/test_widget_data.py
git commit -m "feat: widget data and widget CSV endpoints; tiered series queries move to core/series.py

POST /api/widget-data and /api/widget-data/csv serve every widget type over metrics, energy
and cost. GET /api/assets/{id}/series is unchanged and now shares core/series.py. No existing
test assertion changed.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa"
git push origin phase-3-dashboards-billing
```

### Task 7: Frontend foundation

Add `react-grid-layout` 2.x, the Phase 3 types and hooks, the four shared libraries (`ranges`, `siteTime`, `layout`, `download`), the new routes and nav links, and switch the asset-page chart and the audit page to site-timezone times. Pages for Tasks 8-10 are minimal placeholders so the app compiles.

**Files:**
- Modify: `frontend/package.json`, `frontend/package-lock.json` (`npm install react-grid-layout@^2.3.0`)
- Modify: `frontend/src/api/types.ts` (append types; `Summary` gains two fields), `frontend/src/api/queries.ts`, `frontend/src/api/queries.test.tsx`
- Modify: `frontend/src/main.tsx` (the `App` component moves out), `frontend/src/components/Layout.tsx`, `frontend/src/components/Layout.test.tsx`
- Modify: `frontend/src/components/TrendChart.tsx`, `frontend/src/components/TrendChart.test.tsx`, `frontend/src/pages/AuditPage.tsx`, `frontend/src/pages/AuditPage.test.tsx`, `frontend/src/pages/AssetPage.test.tsx` (only the `routes()` helper)
- Create: `frontend/src/App.tsx`, `frontend/src/App.test.tsx`
- Create: `frontend/src/lib/ranges.ts`, `ranges.test.ts`, `siteTime.ts`, `siteTime.test.ts`, `layout.ts`, `layout.test.ts`, `download.ts`, `download.test.ts` (all under `frontend/src/lib/`)
- Create: `frontend/src/test/reactGridLayout.smoke.test.tsx`
- Create (placeholders, replaced later): `frontend/src/pages/DashboardsPage.tsx`, `DashboardPage.tsx`, `BillingPage.tsx`, `TariffsPage.tsx`

**Interfaces:**
- Consumes: the HTTP shapes of `/api/site`, `/api/settings/billing`, `/api/tariffs`, `/api/billing/costs`, `/api/dashboards`, `/api/widget-data` (Interface Contracts); existing `api`, `ApiError`, `useInvalidate`, `keys`, `renderWithProviders`, `mockFetch`, `RequireRole`.
- Produces (used by Tasks 8-10):
  - `types.ts`: `RangePreset`, `Site`, `BillingSettings`, `Tariff`, `TariffIn`, `TariffPatch`, `CostFigure`, `CostToday`, `BillingAssetRow`, `BillingCosts`, `WIDGET_TYPES`, `WidgetType`, `WidgetSource`, `WidgetAggregation`, `WidgetConfig`, `Widget`, `WidgetIn`, `Dashboard`, `DashboardListItem`, `DashboardIn`, `DashboardSave`, `WidgetPoint`, `WidgetSeries`, `WidgetValue`, `WidgetData`; `Summary` gains `cost_today: CostToday | null` and `currency: string | null`.
  - `queries.ts` hooks (mutations follow the existing `usePatchUser` style): `useSite()`; `useBillingSettings()`, `usePutBillingSettings()` (`mutate({ currency })`); `useTariffs()`, `useCreateTariff()` (`mutate(TariffIn)`), `useUpdateTariff()` (`mutate({ id, body: TariffPatch })`), `useDeleteTariff()` (`mutate(id)`); `useBillingCosts(month: string | null)` (idle while `null`); `useDashboards()`, `useDashboard(id)`, `useCreateDashboard()` (`mutate({ name, range? })`, resolves to the created `Dashboard`), `useSaveDashboard()` (`mutate({ id, body: DashboardSave })`, resolves to the saved `Dashboard`, writes it into the `useDashboard(id)` cache), `useDeleteDashboard()` (`mutate(id)`); `useWidgetData(type, config, preset, enabled = true)`. Keys: `keys.site`, `keys.billingSettings`, `keys.tariffs`, `keys.billing`, `keys.billingCosts(month)`, `keys.dashboardList`, `keys.dashboard(id)`, `keys.widgetData`. `usePutGeneralSettings`, `usePutBillingSettings` and the tariff mutations also invalidate `keys.site`/`keys.billing`/`keys.widgetData`/`keys.assets` as appropriate.
  - `lib/ranges.ts`: `RANGE_PRESETS: RangePreset[]`, `RANGE_LABELS: Record<RangePreset, string>`, `isRolling(p)`.
  - `lib/siteTime.ts`: `formatSiteDateTime(iso, timezone)` returns `YYYY-MM-DD HH:mm:ss`; `formatSiteTick(iso, timezone, bucket)` returns `HH:mm` (bucket `null`), `MM-DD HH:mm` (`'hour'`), `MM-DD` (`'day'`); `formatSiteDay('YYYY-MM-DD')` returns `Wed 07 Oct` (no timezone shift); extra: `siteMonth(now: Date, timezone): string` (`YYYY-MM`). Unparseable input or an unknown zone returns the input unchanged.
  - `lib/layout.ts`: `GRID_COLS = 12`, `GridItem`, `DraftWidget`, `toDrafts`, `toGrid`, `applyGrid(drafts, grid: readonly GridItem[])`, `defaultSize`, `nextPosition`, `newKey` (keys of new widgets look like `new-1`; saved widgets use `String(id)`).
  - `lib/download.ts`: `downloadCsv(path, init?)`.
  - Routes `/dashboards`, `/dashboards/:id` (both lazy-loaded), `/billing`, `/tariffs` (admin) in the new `src/App.tsx` (moved out of `main.tsx` so routing can be tested); nav links Dashboards, Billing (all roles), Tariffs (admin).
  - Placeholder pages (named exports): `DashboardsPage` (`<h1>Dashboards</h1>`), `DashboardPage` (`<h1>Dashboard</h1>`), `BillingPage` (`<h1>Billing</h1>`), `TariffsPage` (`<h1>Tariffs</h1>`). Each is one `<section>` with that heading and one muted line. Task 8 replaces `BillingPage.tsx` and `TariffsPage.tsx`; Tasks 9-10 replace `DashboardsPage.tsx` and `DashboardPage.tsx`. The replacements MUST keep the same export names and keep an `<h1>` with the same text (`Dashboards`, `Billing`, `Tariffs`), because `App.test.tsx` finds them by heading.

**Notes for later tasks (react-grid-layout 2.3, read from its published README and typings):**
- v2 API: `import ReactGridLayout, { useContainerWidth } from "react-grid-layout"`; props `width` (required), `layout`, `gridConfig={{ cols, rowHeight, margin, containerPadding }}`, `dragConfig={{ enabled, handle, cancel }}`, `resizeConfig={{ enabled }}`, `compactor` (default vertical), `onLayoutChange(layout: readonly LayoutItem[])`. There is no `isDraggable`/`isResizable`/`cols`/`rowHeight` prop (those are v1; they live in `react-grid-layout/legacy`).
- Width: `const { width, containerRef, mounted } = useContainerWidth()`; attach `containerRef` to a wrapper div and render the grid with `width={width}`. jsdom measures 0, so grid tests mock the hook (see the smoke test).
- CSS: `import "react-grid-layout/css/styles.css"` and `import "react-resizable/css/styles.css"`, in the lazily loaded grid component only (never `main.tsx`/`app.css`).
- `onLayoutChange` may fire once on mount with normalised items and fires after every drag/resize; compare values, not references.

- [ ] **Step 1: Install the grid library**

```bash
cd frontend && npm install react-grid-layout@^2.3.0
grep '"version"' node_modules/react-grid-layout/package.json node_modules/react-resizable/package.json
git diff --stat package.json package-lock.json
```
Expected: `react-grid-layout` version `2.x` (2.3.0 at the time of writing), `react-resizable` `3.x`; `package.json` gains `"react-grid-layout": "^2.3.0"` under `dependencies`; the lock file changes. Do not add any `@types` package (v2 ships its own types).

- [ ] **Step 2: Write the failing tests**

`frontend/src/lib/ranges.test.ts`:

```ts
import type { RangePreset } from "../api/types";
import { isRolling, RANGE_LABELS, RANGE_PRESETS } from "./ranges";

describe("ranges", () => {
  it("lists exactly the nine presets, rolling first", () => {
    expect(RANGE_PRESETS).toEqual(["1h", "6h", "24h", "7d", "30d", "today", "yesterday", "this_month", "last_month"]);
  });

  it("has a distinct label for every preset", () => {
    expect(RANGE_LABELS["1h"]).toBe("Last hour");
    expect(RANGE_LABELS.today).toBe("Today");
    expect(RANGE_LABELS.this_month).toBe("This month");
    expect(RANGE_LABELS.last_month).toBe("Last month");
    for (const preset of RANGE_PRESETS) expect(RANGE_LABELS[preset]).toBeTruthy();
    expect(new Set(Object.values(RANGE_LABELS)).size).toBe(RANGE_PRESETS.length);
  });

  it.each<[RangePreset, boolean]>([
    ["1h", true], ["6h", true], ["24h", true], ["7d", true], ["30d", true],
    ["today", false], ["yesterday", false], ["this_month", false], ["last_month", false],
  ])("isRolling(%s) is %s", (preset, expected) => {
    expect(isRolling(preset)).toBe(expected);
  });
});
```

`frontend/src/lib/siteTime.test.ts`:

```ts
import { formatSiteDateTime, formatSiteDay, formatSiteTick, siteMonth } from "./siteTime";

describe("formatSiteDateTime", () => {
  // Every case names its zone, so the result never depends on the machine running the tests.
  it.each([
    ["2026-10-07T10:00:00Z", "Asia/Qatar", "2026-10-07 13:00:00"],
    ["2026-10-06T21:00:00Z", "Asia/Qatar", "2026-10-07 00:00:00"], // midnight reads 00, never 24
    ["2026-10-07T10:00:00+03:00", "UTC", "2026-10-07 07:00:00"],
    ["2026-03-29T00:30:00Z", "Europe/Amsterdam", "2026-03-29 01:30:00"], // CET
    ["2026-03-29T01:30:00Z", "Europe/Amsterdam", "2026-03-29 03:30:00"], // CEST: 02:xx does not exist that day
    ["2026-10-25T00:30:00Z", "Europe/Amsterdam", "2026-10-25 02:30:00"], // CEST
    ["2026-10-25T01:30:00Z", "Europe/Amsterdam", "2026-10-25 02:30:00"], // CET: 02:30 happens twice on a 25-hour day
  ])("%s in %s reads %s", (iso, zone, expected) => {
    expect(formatSiteDateTime(iso, zone)).toBe(expected);
  });

  it("returns the input unchanged when it cannot format it", () => {
    expect(formatSiteDateTime("not a date", "UTC")).toBe("not a date");
    expect(formatSiteDateTime("2026-10-07T10:00:00Z", "Mars/Olympus")).toBe("2026-10-07T10:00:00Z");
  });
});

describe("formatSiteTick", () => {
  const iso = "2026-10-06T21:00:00Z"; // 2026-10-07 00:00 in Asia/Qatar
  it.each<["hour" | "day" | null, string]>([
    [null, "00:00"],
    ["hour", "10-07 00:00"],
    ["day", "10-07"],
  ])("bucket %s reads %s", (bucket, expected) => {
    expect(formatSiteTick(iso, "Asia/Qatar", bucket)).toBe(expected);
  });
});

describe("formatSiteDay", () => {
  it.each([
    ["2026-10-07", "Wed 07 Oct"],
    ["2026-03-29", "Sun 29 Mar"],
    ["2026-01-01", "Thu 01 Jan"],
    ["2026-02-30", "2026-02-30"], // not a real day: returned unchanged
    ["nope", "nope"],
  ])("%s reads %s", (day, expected) => {
    expect(formatSiteDay(day)).toBe(expected);
  });
});

describe("siteMonth", () => {
  it("names the month on the wall clock of the site zone, not UTC", () => {
    const edge = new Date("2026-10-31T22:30:00Z");
    expect(siteMonth(edge, "UTC")).toBe("2026-10");
    expect(siteMonth(edge, "Asia/Qatar")).toBe("2026-11"); // 01:30 on 1 November there
  });
});
```

`frontend/src/lib/layout.test.ts`:

```ts
import type { Widget, WidgetConfig, WidgetType } from "../api/types";
import { applyGrid, defaultSize, GRID_COLS, newKey, nextPosition, toDrafts, toGrid, type DraftWidget } from "./layout";

const config: WidgetConfig = {
  assets: [1], source: "energy", metric: null, aggregation: "sum", range: null, bars: "asset", min: 0, max: null,
};
const widget = (id: number, over: Partial<Widget> = {}): Widget => ({
  id, type: "stat", title: `w${id}`, config, x: 0, y: 0, w: 3, h: 2, ...over,
});
const draft = (key: string, over: Partial<DraftWidget> = {}): DraftWidget => ({
  key, type: "stat", title: key, config, x: 0, y: 0, w: 3, h: 2, ...over,
});

describe("toDrafts / toGrid", () => {
  it("keys drafts by the saved id and drops the id", () => {
    const drafts = toDrafts([widget(7, { x: 3, y: 2 })]);
    expect(drafts).toEqual([{ key: "7", type: "stat", title: "w7", config, x: 3, y: 2, w: 3, h: 2 }]);
  });

  it("maps drafts to grid items with per-type minimum sizes", () => {
    const grid = toGrid([draft("7", { x: 3, y: 2, w: 4, h: 3 }), draft("8", { type: "timeseries" })]);
    expect(grid).toEqual([
      { i: "7", x: 3, y: 2, w: 4, h: 3, minW: 2, minH: 2 },
      { i: "8", x: 0, y: 0, w: 3, h: 2, minW: 3, minH: 3 },
    ]);
  });

  it.each<WidgetType>(["timeseries", "bar", "stat", "gauge", "table"])("a new %s fits its own minimum and the grid", (type) => {
    const size = defaultSize(type);
    const item = toGrid([draft("k", { type, ...size })])[0];
    expect(size.w).toBeGreaterThanOrEqual(item.minW ?? 0);
    expect(size.h).toBeGreaterThanOrEqual(item.minH ?? 0);
    expect(size.w).toBeLessThanOrEqual(GRID_COLS);
  });
});

describe("applyGrid", () => {
  it("copies x, y, w, h by key and leaves the rest alone", () => {
    const drafts = [draft("1"), draft("2", { x: 3 })];
    const next = applyGrid(drafts, [{ i: "2", x: 6, y: 4, w: 5, h: 3 }, { i: "1", x: 0, y: 0, w: 3, h: 2 }]);
    expect(next).toEqual([draft("1"), draft("2", { x: 6, y: 4, w: 5, h: 3 })]);
    expect(drafts[1].x).toBe(3); // the input is not mutated
  });

  it("ignores grid items without a draft and keeps drafts missing from the grid", () => {
    const drafts = [draft("1"), draft("2")];
    const next = applyGrid(drafts, [{ i: "1", x: 1, y: 1, w: 3, h: 2 }, { i: "ghost", x: 9, y: 9, w: 1, h: 1 }]);
    expect(next.map((d) => [d.key, d.x, d.y])).toEqual([["1", 1, 1], ["2", 0, 0]]);
  });

  it("returns the same array when nothing moved, so a no-op layout event cannot dirty the editor", () => {
    const drafts = [draft("1"), draft("2", { x: 3 })];
    expect(applyGrid(drafts, toGrid(drafts))).toBe(drafts);
  });
});

describe("nextPosition and newKey", () => {
  it("starts an empty grid at the origin and otherwise the first free row below everything", () => {
    expect(nextPosition([], { w: 6, h: 4 })).toEqual({ x: 0, y: 0 });
    const drafts = [draft("1", { y: 0, h: 2 }), draft("2", { x: 6, y: 2, h: 3 }), draft("3", { y: 1, h: 1 })];
    expect(nextPosition(drafts, { w: 6, h: 4 })).toEqual({ x: 0, y: 5 });
  });

  it("hands out distinct keys that cannot collide with saved ids", () => {
    const a = newKey();
    const b = newKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^new-\d+$/);
  });
});
```

`frontend/src/lib/download.test.ts`:

```ts
import { ApiError } from "../api/client";
import { downloadCsv } from "./download";

let clicks: { href: string; download: string }[];

/** jsdom's Blob has no arrayBuffer(), so read the raw bytes with FileReader. */
const bytesOf = (blob: Blob) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

beforeEach(() => {
  clicks = [];
  // jsdom implements neither object URLs nor anchor navigation.
  URL.createObjectURL = vi.fn(() => "blob:csv-1");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download });
  });
});

const csvResponse = (disposition: string | null) =>
  new Response("﻿asset,date\r\n", {
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8", ...(disposition ? { "content-disposition": disposition } : {}) },
  });
const stubFetch = (response: Response) => {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("downloadCsv", () => {
  it("saves the response under the server's filename and keeps the byte-order mark", async () => {
    const fetchMock = stubFetch(csvResponse('attachment; filename="costs-2026-10.csv"'));
    await downloadCsv("/api/billing/costs.csv?month=2026-10");
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/costs.csv?month=2026-10", { method: "GET", credentials: "same-origin", headers: {} });
    expect(clicks).toEqual([{ href: "blob:csv-1", download: "costs-2026-10.csv" }]);
    // Response.text() would strip the BOM Excel needs, so the file must be built from the raw bytes.
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect([...(await bytesOf(blob)).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(document.querySelector("a[download]")).toBeNull(); // the temporary anchor is removed again
  });

  it.each([
    [null, "export.csv"],
    ["attachment", "export.csv"],
    ["attachment; filename=plain.csv", "plain.csv"],
    ["attachment; filename*=UTF-8''kosten%20okt.csv", "kosten okt.csv"],
    ['attachment; filename="../evil.csv"', ".._evil.csv"],
  ])("reads %j as %j", async (disposition, expected) => {
    stubFetch(csvResponse(disposition));
    await downloadCsv("/x.csv");
    expect(clicks[0].download).toBe(expected);
  });

  it("posts a JSON body when asked to", async () => {
    const fetchMock = stubFetch(csvResponse('attachment; filename="w.csv"'));
    await downloadCsv("/api/widget-data/csv", { method: "POST", body: { type: "stat", range: "24h" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/widget-data/csv", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "stat", range: "24h" }),
    });
  });

  it("throws an ApiError carrying the server's detail and saves nothing", async () => {
    stubFetch(new Response(JSON.stringify({ detail: "site timezone must have whole-hour UTC offsets" }), {
      status: 409, headers: { "content-type": "application/json" },
    }));
    const failure = await downloadCsv("/api/billing/costs.csv?month=2026-10").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).message).toBe("site timezone must have whole-hour UTC offsets");
    expect(clicks).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("reports a plain-text error body as its message", async () => {
    stubFetch(new Response("Bad gateway", { status: 502 }));
    await expect(downloadCsv("/x.csv")).rejects.toThrow("Bad gateway");
  });
});
```

`frontend/src/test/reactGridLayout.smoke.test.tsx` (proves the library works under React 19 in jsdom; Task 9's grid tests copy the `vi.mock` pattern):

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import ReactGridLayout, { useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

// jsdom has no layout: the real hook would measure 0 and the ResizeObserver stub in setup.ts never fires.
// Pin the measured width instead.
vi.mock("react-grid-layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-grid-layout")>()),
  useContainerWidth: () => ({ width: 1200, mounted: true, containerRef: { current: null }, measureWidth: () => undefined }),
}));

type Item = { i: string; x: number; y: number; w: number; h: number };
const layout: Item[] = [{ i: "a", x: 0, y: 0, w: 6, h: 2 }, { i: "b", x: 6, y: 0, w: 6, h: 2 }];

function Grid({ items, onLayoutChange }: { items: Item[]; onLayoutChange?: (l: readonly Item[]) => void }) {
  const { width, containerRef, mounted } = useContainerWidth();
  return (
    <div ref={containerRef}>
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={items}
          gridConfig={{ cols: 12, rowHeight: 30, margin: [10, 10], containerPadding: [10, 10] }}
          onLayoutChange={onLayoutChange}
        >
          <div key="a" data-testid="item-a">A</div>
          <div key="b" data-testid="item-b">B</div>
        </ReactGridLayout>
      )}
    </div>
  );
}

describe("react-grid-layout 2 under React 19 in jsdom", () => {
  it("renders two items at the pixel positions of a 12-column, 1200px grid, with resize handles", () => {
    render(<StrictMode><Grid items={layout} /></StrictMode>);
    const a = screen.getByTestId("item-a");
    const b = screen.getByTestId("item-b");
    expect(a).toHaveClass("react-grid-item");
    // column width = (1200 - 10 * 11 - 2 * 10) / 12 = 89.17px; w = 6 spans 6 * 89.17 + 5 * 10 = 585px;
    // x = 6 starts at 6 * (89.17 + 10) + 10 = 605px; h = 2 spans 2 * 30 + 10 = 70px.
    expect(a.style.width).toBe("585px");
    expect(a.style.height).toBe("70px");
    expect(a.style.transform).toBe("translate(10px,10px)");
    expect(b.style.transform).toBe("translate(605px,10px)");
    expect(document.querySelectorAll(".react-resizable-handle")).toHaveLength(2); // resizing is on by default
  });

  it("only ever reports the layout it was given, so mounting cannot look like an edit", () => {
    const seen: Item[][] = [];
    render(<StrictMode><Grid items={layout} onLayoutChange={(l) => seen.push(l.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })))} /></StrictMode>);
    for (const reported of seen) expect(reported).toEqual(layout);
  });

  it("moves an item when the layout prop changes", async () => {
    const { rerender } = render(<StrictMode><Grid items={layout} /></StrictMode>);
    rerender(<StrictMode><Grid items={[layout[0], { i: "b", x: 0, y: 2, w: 6, h: 2 }]} /></StrictMode>);
    // y = 2 starts at (30 + 10) * 2 + 10 = 90px
    await waitFor(() => expect(screen.getByTestId("item-b").style.transform).toBe("translate(10px,90px)"));
  });
});
```

Append to `frontend/src/api/queries.test.tsx`. Replace the import line `import { useAudit, useGraph, usePatchUser, useScan, useUsers } from "./queries";` with

```tsx
import {
  useAudit, useBillingCosts, useCreateTariff, useDashboard, useDashboards, useGraph, usePatchUser, usePutGeneralSettings,
  useSaveDashboard, useScan, useSite, useTariffs, useUsers, useWidgetData,
} from "./queries";
import type { RangePreset } from "./types";
```

and add at the end of the file:

```tsx
// The shared `wrapper` above builds a new QueryClient whenever it re-renders, which would throw away the cache on `rerender`.
function stableWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("phase 3 queries", () => {
  it("reads the site and refetches it after the timezone is saved", async () => {
    let timezone = "UTC";
    const calls = mockFetch({
      "GET /api/site": () => ({ body: { timezone, currency: null } }),
      "PUT /api/settings/general": ({ body }) => { timezone = (body as { timezone: string }).timezone; return { body: { timezone } }; },
    });
    const { result } = renderHook(() => ({ site: useSite(), put: usePutGeneralSettings() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.site.data?.timezone).toBe("UTC"));
    await result.current.put.mutateAsync({ timezone: "Asia/Qatar" });
    await waitFor(() => expect(result.current.site.data?.timezone).toBe("Asia/Qatar"));
    expect(calls.filter((c) => c.path === "/api/site")).toHaveLength(2);
  });

  it("refetches tariffs and billing costs after a tariff is created", async () => {
    const empty = { month: "2026-10", timezone: "UTC", currency: null, days: [], assets: [] };
    const created = { id: 1, asset_id: null, asset_name: null, rate_per_kwh: 0.12, effective_from: "2026-10-01", created_by: 1, created_at: "t" };
    const calls = mockFetch({
      "GET /api/tariffs": { body: [] },
      "GET /api/billing/costs": { body: empty },
      "POST /api/tariffs": { status: 201, body: created },
    });
    const { result } = renderHook(() => ({ tariffs: useTariffs(), costs: useBillingCosts("2026-10"), create: useCreateTariff() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.costs.data?.month).toBe("2026-10"));
    await result.current.create.mutateAsync({ asset_id: null, rate_per_kwh: 0.12, effective_from: "2026-10-01" });
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/api/tariffs")).toHaveLength(2));
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/billing/costs")).toHaveLength(2));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ asset_id: null, rate_per_kwh: 0.12, effective_from: "2026-10-01" });
  });

  it("asks for the billing month it is given and stays idle without one", async () => {
    let url = "";
    const calls = mockFetch({
      "GET /api/billing/costs": (req) => {
        url = req.url;
        return { body: { month: "2026-09", timezone: "UTC", currency: null, days: [], assets: [] } };
      },
    });
    const { result, rerender } = renderHook(({ month }: { month: string | null }) => useBillingCosts(month), {
      wrapper: stableWrapper(), initialProps: { month: null as string | null },
    });
    expect(calls).toHaveLength(0);
    rerender({ month: "2026-09" });
    await waitFor(() => expect(result.current.data?.month).toBe("2026-09"));
    expect(new URL(url, "http://x").searchParams.get("month")).toBe("2026-09");
  });

  it("posts the widget config with the effective range and keeps the old figures while the range changes", async () => {
    const config = {
      assets: [5], source: "metric" as const, metric: "active_power_kw" as const, aggregation: "last" as const,
      range: null, bars: "asset" as const, min: 0, max: null,
    };
    const calls = mockFetch({
      "POST /api/widget-data": ({ body }) => ({
        body: {
          type: "stat", mode: "values", source: "metric", metric: "active_power_kw", unit: "kW",
          range: { preset: (body as { range: string }).range, start: "s", end: "e" },
          tier: null, bucket: null, series: [], values: [], missing: [],
        },
      }),
    });
    const { result, rerender } = renderHook(({ preset }: { preset: RangePreset }) => useWidgetData("stat", config, preset), {
      wrapper: stableWrapper(), initialProps: { preset: "24h" as RangePreset },
    });
    await waitFor(() => expect(result.current.data?.range.preset).toBe("24h"));
    rerender({ preset: "7d" });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.range.preset).toBe("24h");
    await waitFor(() => expect(result.current.data?.range.preset).toBe("7d"));
    expect(calls.map((c) => c.body)).toEqual([{ type: "stat", config, range: "24h" }, { type: "stat", config, range: "7d" }]);
  });

  it("saves a dashboard with one PUT, updates the cached dashboard and refreshes only the list", async () => {
    const stored = { id: 5, name: "Hall A", range: "24h", updated_at: "2026-10-08T10:00:00Z", widgets: [] };
    const saved = { ...stored, name: "Hall B", updated_at: "2026-10-08T10:00:01Z" };
    const calls = mockFetch({
      "GET /api/dashboards/5": { body: stored },
      "GET /api/dashboards": { body: [] },
      "PUT /api/dashboards/5": { body: saved },
    });
    const { result } = renderHook(() => ({ d: useDashboard(5), list: useDashboards(), save: useSaveDashboard() }), { wrapper: stableWrapper() });
    await waitFor(() => expect(result.current.d.data?.name).toBe("Hall A"));
    const body = { name: "Hall B", range: "24h" as const, updated_at: "2026-10-08T10:00:00Z", widgets: [] };
    await result.current.save.mutateAsync({ id: 5, body });
    await waitFor(() => expect(result.current.d.data?.updated_at).toBe("2026-10-08T10:00:01Z"));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual(body);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/dashboards/5")).toHaveLength(1); // no refetch of the detail
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/dashboards")).toHaveLength(2));
  });
});
```

Append to `frontend/src/components/Layout.test.tsx`:

```tsx
describe("Layout phase 3 links", () => {
  it.each(["viewer", "operator", "admin"] as const)("%s sees Dashboards and Billing, and Tariffs only as admin", async (role) => {
    mockFetch(routes(role));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    await screen.findByText(`u (${role})`); // the user has loaded, so role-gated links are decided
    expect(screen.getByRole("link", { name: "Dashboards" })).toHaveAttribute("href", "/dashboards");
    expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute("href", "/billing");
    if (role === "admin") expect(screen.getByRole("link", { name: "Tariffs" })).toHaveAttribute("href", "/tariffs");
    else expect(screen.queryByRole("link", { name: "Tariffs" })).not.toBeInTheDocument();
  });
});
```

`frontend/src/App.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { App } from "./App";
import { mockFetch } from "./test/fetchMock";
import { renderWithProviders } from "./test/render";

// Answers for whatever the Phase 3 pages (placeholders now, real pages later) ask on load.
const routes = (role: string) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },
  "GET /api/tariffs": { body: [] },
  "GET /api/settings/billing": { body: { currency: "QAR" } },
  "GET /api/assets": { body: [] },
  "GET /api/billing/costs": { body: { month: "2026-10", timezone: "Asia/Qatar", currency: "QAR", days: [], assets: [] } },
  "GET /api/dashboards": { body: [] },
});
const visit = (role: string, route: string) => {
  const calls = mockFetch(routes(role));
  renderWithProviders(<App />, { route, path: "*" });
  return calls;
};

describe("App routes", () => {
  it.each(["viewer", "operator"])("keeps Tariffs away from a %s", async (role) => {
    const calls = visit(role, "/tariffs");
    expect(await screen.findByText("Admins only")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/tariffs")).toBe(false);
  });

  it("opens Tariffs for an admin", async () => {
    visit("admin", "/tariffs");
    expect(await screen.findByRole("heading", { name: "Tariffs" })).toBeInTheDocument();
    expect(screen.queryByText("Admins only")).not.toBeInTheDocument();
  });

  it("opens Billing and Dashboards for a viewer", async () => {
    visit("viewer", "/billing");
    expect(await screen.findByRole("heading", { name: "Billing" })).toBeInTheDocument();
  });

  it("opens the lazily loaded Dashboards page for a viewer", async () => {
    visit("viewer", "/dashboards");
    expect(await screen.findByRole("heading", { name: "Dashboards" })).toBeInTheDocument();
  });
});
```

`frontend/src/components/TrendChart.test.tsx` edits:
1. Replace the imports and the `vi.mock` line at the top with:

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { seriesToOption, TrendChart } from "./TrendChart";

// The mock records every option the chart is given; JSON.stringify in the DOM would drop the formatter functions.
const captured = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock("echarts-for-react", () => ({
  default: (props: { option: unknown }) => {
    captured.options.push(props.option);
    return <pre data-testid="chart">{JSON.stringify(props.option)}</pre>;
  },
}));

const siteRoute = { "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } } };
```

2. In each of the three existing `mockFetch({` calls inside `describe("TrendChart")`, add `...siteRoute,` as the first entry.
3. Append:

```tsx
describe("seriesToOption in the site timezone", () => {
  type Opt = {
    useUTC: boolean;
    xAxis: { axisLabel: { formatter: (ms: number) => string } };
    tooltip: { formatter: (params: unknown) => string };
  };
  const midnightQatar = Date.parse("2026-10-06T21:00:00Z"); // 2026-10-07 00:00 in Asia/Qatar, the 6th at 21:00 in UTC

  it("labels ticks with the site's time of day, and with the date on a 7d range", () => {
    const day = seriesToOption(series as never, "24h", undefined, "Asia/Qatar") as unknown as Opt;
    const week = seriesToOption(series as never, "7d", undefined, "Asia/Qatar") as unknown as Opt;
    expect(day.xAxis.axisLabel.formatter(midnightQatar)).toBe("00:00");
    expect(week.xAxis.axisLabel.formatter(midnightQatar)).toBe("10-07 00:00");
    expect(day.useUTC).toBe(true); // tick positions must not depend on the browser's zone
  });

  it("prints the tooltip header in the site zone and a dash for a gap", () => {
    const option = seriesToOption(series as never, "24h", undefined, "Asia/Qatar") as unknown as Opt;
    const html = option.tooltip.formatter([
      { axisValue: midnightQatar, marker: "", seriesName: "avg", value: [midnightQatar, 2] },
      { axisValue: midnightQatar, marker: "", seriesName: "min", value: [midnightQatar, null] },
    ]);
    expect(html).toBe("2026-10-07 00:00:00<br/>avg: 2<br/>min: —");
  });
});

describe("TrendChart site timezone", () => {
  it("draws the axis in the zone GET /api/site reports", async () => {
    mockFetch({
      ...siteRoute,
      "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
      "GET /api/assets/4/series": { body: series },
    });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    await waitFor(() => {
      const option = captured.options.at(-1) as { xAxis: { axisLabel: { formatter: (ms: number) => string } } };
      expect(option.xAxis.axisLabel.formatter(Date.parse("2026-10-06T21:00:00Z"))).toBe("00:00");
    });
  });
});
```

`frontend/src/pages/AuditPage.test.tsx` edits: add `"GET /api/site": { body: { timezone: "Asia/Qatar", currency: null } },` to the `admin` constant, and append inside `describe("AuditPage")`:

```tsx
  it("shows times in the site timezone, not the browser's", async () => {
    mockFetch({ ...admin, "GET /api/audit": { body: { total: 1, items: [entry(1, "scan.finished")] } } });
    renderWithProviders(<AuditPage />, { route: "/audit", path: "/audit" });
    expect(await screen.findByText("2026-10-07 13:00:00")).toBeInTheDocument(); // 10:00Z in Asia/Qatar (UTC+3)
    expect(screen.getByRole("columnheader", { name: "Time (Asia/Qatar)" })).toBeInTheDocument();
  });
```

`frontend/src/pages/AssetPage.test.tsx` edit: in the `routes` helper add `"GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },` after the `GET /api/me` line (the chart now asks for the site). Do not touch `MetricsTable`'s time formatting or its test.

- [ ] **Step 3: Run to verify the failures**

```bash
cd frontend && npm test -- src/lib src/test/reactGridLayout.smoke.test.tsx src/api/queries.test.tsx src/components/Layout.test.tsx src/components/TrendChart.test.tsx src/pages/AuditPage.test.tsx src/App.test.tsx
```
Expected: the four `src/lib` tests, `queries.test.tsx`, `Layout.test.tsx`, `TrendChart.test.tsx`, `AuditPage.test.tsx` and `App.test.tsx` FAIL (modules or exports missing, nav links absent, chart/audit still browser-local). `reactGridLayout.smoke.test.tsx` already PASSES because it tests the library. If it fails, STOP and read the error:
- `Named export ... not found. ... is a CommonJS module`: add `server: { deps: { inline: ["react-grid-layout", "react-resizable", "react-draggable"] } }` inside `test` in `frontend/vite.config.ts` and rerun.
- Any `findDOMNode`/React 19 crash, or a CSS import that does not resolve: report BLOCKED with the full error; do not work around it (Tasks 9-10 depend on this library).
- The library renders but a pixel, class or handle assertion differs (`585px`, `70px`, `translate(605px,10px)`, `react-grid-item`, `.react-resizable-handle`): the expected values were derived by reading the v2 source, not by running it. Read the installed `node_modules/react-grid-layout/dist` source, correct the expected value, and say so in the commit message. Only a crash or a failed import is BLOCKED.

- [ ] **Step 4: Implement**

**4a. `frontend/src/api/types.ts`.** Replace the `Summary` interface with:

```ts
export interface Summary {
  asset: { id: number; name: string; parent_id: number | null; kind: string };
  metrics: SummaryMetric[];
  energy_today: { kwh: number; estimated: boolean } | null;
  cost_today: CostToday | null;
  currency: string | null;
}
```

and append at the end of the file:

```ts
// ---- Phase 3: site info, tariffs, billing, dashboards ----

export type RangePreset = "1h" | "6h" | "24h" | "7d" | "30d" | "today" | "yesterday" | "this_month" | "last_month";

export interface Site { timezone: string; currency: string | null }
export interface BillingSettings { currency: string | null }

export interface Tariff {
  id: number; asset_id: number | null; asset_name: string | null; rate_per_kwh: number;
  effective_from: string; created_by: number | null; created_at: string;
}
export interface TariffIn { asset_id: number | null; rate_per_kwh: number; effective_from: string }
export interface TariffPatch { rate_per_kwh?: number; effective_from?: string }

/** One asset on one day (or the whole month); `cost` is null when no rate applied. */
export interface CostFigure { kwh: number; cost: number | null; estimated: boolean; partial: boolean }
/** `cost_today` of the asset summary: no kWh, the energy tile already has it. */
export interface CostToday { cost: number | null; estimated: boolean; partial: boolean }
export interface BillingAssetRow {
  asset_id: number; parent_id: number | null; name: string; path: string; rate_per_kwh: number | null;
  days: (CostFigure | null)[]; total: CostFigure | null;
}
export interface BillingCosts { month: string; timezone: string; currency: string | null; days: string[]; assets: BillingAssetRow[] }

export const WIDGET_TYPES = ["timeseries", "bar", "stat", "gauge", "table"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export type WidgetSource = "metric" | "energy" | "cost";
export type WidgetAggregation = "avg" | "min" | "max" | "last" | "sum";
export interface WidgetConfig {
  assets: number[]; source: WidgetSource; metric: Metric | null; aggregation: WidgetAggregation;
  range: RangePreset | null; bars: "asset" | "time"; min: number; max: number | null;
}
export interface Widget { id: number; type: WidgetType; title: string; config: WidgetConfig; x: number; y: number; w: number; h: number }
export type WidgetIn = Omit<Widget, "id">;
export interface Dashboard { id: number; name: string; range: RangePreset; updated_at: string; widgets: Widget[] }
export interface DashboardListItem { id: number; name: string; range: RangePreset; widget_count: number; updated_at: string }
export interface DashboardIn { name: string; range?: RangePreset }
export interface DashboardSave { name: string; range: RangePreset; updated_at: string; widgets: WidgetIn[] }

export interface WidgetPoint { ts: string; value: number | null; min: number | null; max: number | null }
export interface WidgetSeries { asset_id: number; name: string; points: WidgetPoint[]; estimated: boolean; partial: boolean }
export interface WidgetValue {
  asset_id: number; name: string; value: number | null; estimated: boolean; partial: boolean; point_id: number | null;
}
export interface WidgetData {
  type: WidgetType; mode: "series" | "values"; source: WidgetSource; metric: Metric | null; unit: string | null;
  range: { preset: RangePreset; start: string; end: string }; tier: SeriesTier | null; bucket: "hour" | "day" | null;
  series: WidgetSeries[]; values: WidgetValue[]; missing: number[];
}
```

**4b. `frontend/src/api/queries.ts`.** Replace the first import line and the type import with:

```ts
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rangeToQuery, type Range } from "../lib/timeRange";
import { api } from "./client";
import type {
  Asset, AuditPage, BillingCosts, BillingSettings, Connector, Dashboard, DashboardIn, DashboardListItem, DashboardSave,
  GeneralSettings, GraphModel, Metric, PointRow, RangePreset, Role, ScanDetail, ScanSummary, Scope, ScopeSuggestions,
  Series, Site, Source, StorageSettings, StorageStats, Summary, Tariff, TariffIn, TariffPatch, UserRow, WidgetConfig,
  WidgetData, WidgetType,
} from "./types";
```

Inside the `keys` object, after the `audit:` line, add:

```ts
  site: ["site"] as const,
  billingSettings: ["settings", "billing"] as const,
  tariffs: ["tariffs"] as const,
  billing: ["billing"] as const,
  billingCosts: (month: string | null) => ["billing", "costs", month] as const,
  dashboardList: ["dashboards", "list"] as const,
  dashboard: (id: number) => ["dashboards", "detail", id] as const,
  widgetData: ["widget-data"] as const,
```

Directly after the `keys` object add:

```ts
/** Everything whose figures move when a rate, the currency or the timezone changes. `assets` covers the asset summaries (cost_today). */
const COST_DEPENDENT = [keys.billing, keys.widgetData, keys.assets] as const;
```

Replace `usePutGeneralSettings` with:

```ts
export function usePutGeneralSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: GeneralSettings) => api.put<GeneralSettings>("/api/settings/general", body),
    onSuccess: () => invalidate(keys.general, keys.site, ...COST_DEPENDENT),
  });
}
```

Append at the end of the file:

```ts
export const useSite = () =>
  useQuery({ queryKey: keys.site, queryFn: () => api.get<Site>("/api/site"), staleTime: 60_000 });

export const useBillingSettings = () =>
  useQuery({ queryKey: keys.billingSettings, queryFn: () => api.get<BillingSettings>("/api/settings/billing") });

export function usePutBillingSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: BillingSettings) => api.put<BillingSettings>("/api/settings/billing", body),
    onSuccess: () => invalidate(keys.billingSettings, keys.site, ...COST_DEPENDENT),
  });
}

export const useTariffs = () => useQuery({ queryKey: keys.tariffs, queryFn: () => api.get<Tariff[]>("/api/tariffs") });

export function useCreateTariff() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: TariffIn) => api.post<Tariff>("/api/tariffs", body),
    onSuccess: () => invalidate(keys.tariffs, ...COST_DEPENDENT),
  });
}

export function useUpdateTariff() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: TariffPatch }) => api.patch<Tariff>(`/api/tariffs/${id}`, body),
    onSuccess: () => invalidate(keys.tariffs, ...COST_DEPENDENT),
  });
}

export function useDeleteTariff() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/tariffs/${id}`),
    onSuccess: () => invalidate(keys.tariffs, ...COST_DEPENDENT),
  });
}

/** One call returns the whole asset tree for the month. Idle while `month` is null (the site timezone has not loaded yet). */
export const useBillingCosts = (month: string | null) =>
  useQuery({
    queryKey: keys.billingCosts(month),
    enabled: month !== null,
    refetchInterval: 60_000,
    queryFn: () => api.get<BillingCosts>(`/api/billing/costs?${new URLSearchParams({ month: month! })}`),
  });

export const useDashboards = () =>
  useQuery({ queryKey: keys.dashboardList, queryFn: () => api.get<DashboardListItem[]>("/api/dashboards") });

export const useDashboard = (id: number) =>
  useQuery({ queryKey: keys.dashboard(id), queryFn: () => api.get<Dashboard>(`/api/dashboards/${id}`) });

export function useCreateDashboard() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardIn) => api.post<Dashboard>("/api/dashboards", body),
    onSuccess: (created) => {
      client.setQueryData(keys.dashboard(created.id), created);
      return client.invalidateQueries({ queryKey: keys.dashboardList });
    },
  });
}

/** The editor's single PUT. The saved dashboard (with its new updated_at) replaces the cached one, so no refetch is needed. */
export function useSaveDashboard() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: DashboardSave }) => api.put<Dashboard>(`/api/dashboards/${id}`, body),
    onSuccess: (saved) => {
      client.setQueryData(keys.dashboard(saved.id), saved);
      return client.invalidateQueries({ queryKey: keys.dashboardList });
    },
  });
}

export function useDeleteDashboard() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/dashboards/${id}`),
    onSuccess: (_data, id) => {
      client.removeQueries({ queryKey: keys.dashboard(id) });
      return client.invalidateQueries({ queryKey: keys.dashboardList });
    },
  });
}

/** `preset` is the effective range (the caller resolves inheritance). Refetches every 30 s and keeps the old figures while a new range loads. */
export const useWidgetData = (type: WidgetType, config: WidgetConfig, preset: RangePreset, enabled = true) =>
  useQuery({
    queryKey: [...keys.widgetData, type, config, preset] as const,
    enabled,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    queryFn: () => api.post<WidgetData>("/api/widget-data", { type, config, range: preset }),
  });
```

**4c. `frontend/src/lib/ranges.ts`:**

```ts
import type { RangePreset } from "../api/types";

export const RANGE_PRESETS: RangePreset[] = ["1h", "6h", "24h", "7d", "30d", "today", "yesterday", "this_month", "last_month"];

export const RANGE_LABELS: Record<RangePreset, string> = {
  "1h": "Last hour", "6h": "Last 6 hours", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days",
  today: "Today", yesterday: "Yesterday", this_month: "This month", last_month: "Last month",
};

const ROLLING = new Set<RangePreset>(["1h", "6h", "24h", "7d", "30d"]);

/** Rolling presets end now; the others are whole calendar days or months in the site timezone. */
export function isRolling(preset: RangePreset): boolean {
  return ROLLING.has(preset);
}
```

**4d. `frontend/src/lib/siteTime.ts`:**

```ts
const formats = new Map<string, Intl.DateTimeFormat>();

function format(timezone: string): Intl.DateTimeFormat {
  let known = formats.get(timezone);
  if (!known) {
    // hourCycle h23, not hour12:false: some engines print midnight as "24" for the latter.
    known = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formats.set(timezone, known);
  }
  return known;
}

interface Fields { year: string; month: string; day: string; hour: string; minute: string; second: string }

/** Wall-clock fields of `date` in `timezone`; null for an invalid date or an unknown zone. Built from parts, never from toLocaleString. */
function fields(date: Date, timezone: string): Fields | null {
  if (Number.isNaN(date.getTime())) return null;
  try {
    const out: Record<string, string> = {};
    for (const part of format(timezone).formatToParts(date)) out[part.type] = part.value;
    return out as unknown as Fields;
  } catch {
    return null;
  }
}

/** `2026-10-07 13:00:00` in the site zone. Returns `iso` unchanged when it cannot be formatted. */
export function formatSiteDateTime(iso: string, timezone: string): string {
  const f = fields(new Date(iso), timezone);
  return f ? `${f.year}-${f.month}-${f.day} ${f.hour}:${f.minute}:${f.second}` : iso;
}

/** Short axis label: `13:00` (no bucket), `10-07 13:00` (hour) or `10-07` (day), in the site zone. */
export function formatSiteTick(iso: string, timezone: string, bucket: "hour" | "day" | null): string {
  const f = fields(new Date(iso), timezone);
  if (!f) return iso;
  if (bucket === "day") return `${f.month}-${f.day}`;
  return bucket === "hour" ? `${f.month}-${f.day} ${f.hour}:${f.minute}` : `${f.hour}:${f.minute}`;
}

/** `YYYY-MM` of `now` on the wall clock of the site zone (UTC when the zone is unknown). */
export function siteMonth(now: Date, timezone: string): string {
  const f = fields(now, timezone) ?? fields(now, "UTC");
  return f ? `${f.year}-${f.month}` : "";
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Wed 07 Oct` for a local day `YYYY-MM-DD`. Pure calendar arithmetic: a day has no timezone, so nothing shifts. */
export function formatSiteDay(day: string): string {
  const m = DAY.exec(day);
  if (!m) return day;
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(year, month - 1, date));
  if (utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== date) return day; // 2026-02-30 and friends
  return `${WEEKDAYS[utc.getUTCDay()]} ${m[3]} ${MONTHS[month - 1]}`;
}
```

**4e. `frontend/src/lib/layout.ts`:**

```ts
import type { Widget, WidgetType } from "../api/types";

export const GRID_COLS = 12;

export interface GridItem { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }

/** A widget being edited: no id yet for new ones, so it is keyed by a client-side `key` (String(id) for saved widgets). */
export type DraftWidget = Omit<Widget, "id"> & { key: string };

const SIZE: Record<WidgetType, { w: number; h: number }> = {
  timeseries: { w: 6, h: 4 }, bar: { w: 6, h: 4 }, stat: { w: 3, h: 2 }, gauge: { w: 3, h: 3 }, table: { w: 6, h: 4 },
};
const MIN: Record<WidgetType, { minW: number; minH: number }> = {
  timeseries: { minW: 3, minH: 3 }, bar: { minW: 3, minH: 3 }, stat: { minW: 2, minH: 2 }, gauge: { minW: 2, minH: 2 }, table: { minW: 3, minH: 3 },
};

export function toDrafts(widgets: Widget[]): DraftWidget[] {
  return widgets.map((w) => ({ key: String(w.id), type: w.type, title: w.title, config: w.config, x: w.x, y: w.y, w: w.w, h: w.h }));
}

export function toGrid(drafts: DraftWidget[]): GridItem[] {
  return drafts.map((d) => ({ i: d.key, x: d.x, y: d.y, w: d.w, h: d.h, ...MIN[d.type] }));
}

/**
 * Copy the grid's positions back into the drafts (matched by key). `grid` is readonly because react-grid-layout hands
 * `onLayoutChange` a readonly array. Returns the same array when nothing moved, so a no-op layout event is not an edit.
 */
export function applyGrid(drafts: DraftWidget[], grid: readonly GridItem[]): DraftWidget[] {
  const byKey = new Map(grid.map((g) => [g.i, g]));
  let changed = false;
  const next = drafts.map((d) => {
    const g = byKey.get(d.key);
    if (!g || (g.x === d.x && g.y === d.y && g.w === d.w && g.h === d.h)) return d;
    changed = true;
    return { ...d, x: g.x, y: g.y, w: g.w, h: g.h };
  });
  return changed ? next : drafts;
}

export function defaultSize(type: WidgetType): { w: number; h: number } {
  return { ...SIZE[type] };
}

/** A new widget starts a fresh row at column 0, whatever its size (the grid then compacts it upwards). */
export function nextPosition(drafts: DraftWidget[], _size: { w: number; h: number }): { x: number; y: number } {
  return { x: 0, y: drafts.reduce((bottom, d) => Math.max(bottom, d.y + d.h), 0) };
}

let counter = 0;
/** crypto.randomUUID needs a secure context and this app is served over plain HTTP on the LAN, so use a counter. */
export function newKey(): string {
  counter += 1;
  return `new-${counter}`;
}
```

**4f. `frontend/src/lib/download.ts`:**

```ts
import { ApiError } from "../api/client";

function filenameOf(disposition: string | null): string {
  if (disposition) {
    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
    if (encoded) {
      try {
        return decodeURIComponent(encoded[1].trim());
      } catch {
        // malformed percent-encoding: fall through to the plain filename
      }
    }
    const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(disposition);
    const name = (plain?.[1] ?? plain?.[2])?.trim();
    if (name) return name.replace(/[\\/]/g, "_");
  }
  return "export.csv";
}

/** Fetch a CSV export (with the session cookie) and hand it to the browser as a file download. Throws ApiError on a non-2xx answer. */
export async function downloadCsv(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<void> {
  const headers: Record<string, string> = {};
  const request: RequestInit = { method: init.method ?? "GET", credentials: "same-origin", headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    request.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, request);
  if (!response.ok) {
    const text = await response.text();
    let detail: unknown = text || null;
    try {
      const data: unknown = text ? JSON.parse(text) : null;
      detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : data;
    } catch {
      // not JSON: the plain text is the detail
    }
    throw new ApiError(response.status, detail);
  }
  // blob(), not text(): text() would drop the byte-order mark that makes Excel read the file as UTF-8.
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filenameOf(response.headers.get("content-disposition"));
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
```

**4g. Placeholder pages** (each is a complete file; a later task replaces it):

`frontend/src/pages/DashboardsPage.tsx`:
```tsx
// Placeholder from Task 7 so the route compiles. Task 9 replaces this file (keep the export name and the h1).
export function DashboardsPage() {
  return (
    <section>
      <h1>Dashboards</h1>
      <p className="muted">Shared dashboards arrive in a later step of this phase.</p>
    </section>
  );
}
```
`frontend/src/pages/DashboardPage.tsx` is the same with `export function DashboardPage()` and `<h1>Dashboard</h1>` (comment: "Task 10 replaces this file"). `frontend/src/pages/BillingPage.tsx`: `export function BillingPage()`, `<h1>Billing</h1>`, comment "Task 8 replaces this file". `frontend/src/pages/TariffsPage.tsx`: `export function TariffsPage()`, `<h1>Tariffs</h1>`, comment "Task 8 replaces this file".

**4h. `frontend/src/App.tsx`** (the routes, moved out of `main.tsx`; the dashboard pages are lazy so the grid library and charts stay out of the main bundle, spec 10.8):

```tsx
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { RequireAuth, RequireRole } from "./auth/RequireAuth";
import { Layout } from "./components/Layout";
import { AssetPage } from "./pages/AssetPage";
import { AssetsPage } from "./pages/AssetsPage";
import { AuditPage } from "./pages/AuditPage";
import { BillingPage } from "./pages/BillingPage";
import { DiscoveryPage } from "./pages/DiscoveryPage";
import { LoginPage } from "./pages/LoginPage";
import { PasswordPage } from "./pages/PasswordPage";
import { ScansPage } from "./pages/ScansPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { SourcePointsPage } from "./pages/SourcePointsPage";
import { SourcesPage } from "./pages/SourcesPage";
import { StoragePage } from "./pages/StoragePage";
import { TariffsPage } from "./pages/TariffsPage";
import { UsersPage } from "./pages/UsersPage";

// These pages pull in react-grid-layout and ECharts, so they load only when visited.
const DashboardsPage = lazy(() => import("./pages/DashboardsPage").then((m) => ({ default: m.DashboardsPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const loading = <p className="muted">loading…</p>;

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route path="/" element={<Navigate to="/assets" replace />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/assets/:id" element={<AssetPage />} />
        <Route path="/dashboards" element={<Suspense fallback={loading}><DashboardsPage /></Suspense>} />
        <Route path="/dashboards/:id" element={<Suspense fallback={loading}><DashboardPage /></Suspense>} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/sources" element={<SourcesPage />} />
        <Route path="/sources/:id/points" element={<SourcePointsPage />} />
        <Route path="/scans" element={<RequireRole min="operator"><ScansPage /></RequireRole>} />
        <Route path="/discovery" element={<RequireRole min="operator"><DiscoveryPage /></RequireRole>} />
        <Route path="/users" element={<RequireRole min="admin"><UsersPage /></RequireRole>} />
        <Route path="/settings" element={<RequireRole min="admin"><SettingsPage /></RequireRole>} />
        <Route path="/tariffs" element={<RequireRole min="admin"><TariffsPage /></RequireRole>} />
        <Route path="/storage" element={<RequireRole min="admin"><StoragePage /></RequireRole>} />
        <Route path="/audit" element={<RequireRole min="admin"><AuditPage /></RequireRole>} />
        <Route path="/password" element={<PasswordPage />} />
      </Route>
    </Routes>
  );
}
```

**4i. `frontend/src/main.tsx`** (replace the whole file):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./app.css";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

**4j. `frontend/src/components/Layout.tsx`** (replace the whole file; Dashboards and Billing for every role, Tariffs for admins):

```tsx
import { NavLink, Outlet, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";

export function Layout() {
  const { user, hasRole, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <nav>
        <strong>DC Dashboard</strong>
        <NavLink to="/assets">Assets</NavLink>
        <NavLink to="/dashboards">Dashboards</NavLink>
        <NavLink to="/billing">Billing</NavLink>
        {hasRole("operator") && <NavLink to="/sources">Sources</NavLink>}
        {hasRole("operator") && <NavLink to="/scans">Scans</NavLink>}
        {hasRole("operator") && <NavLink to="/discovery">Discovery</NavLink>}
        {hasRole("admin") && <NavLink to="/users">Users</NavLink>}
        {hasRole("admin") && <NavLink to="/settings">Settings</NavLink>}
        {hasRole("admin") && <NavLink to="/tariffs">Tariffs</NavLink>}
        {hasRole("admin") && <NavLink to="/storage">Storage</NavLink>}
        {hasRole("admin") && <NavLink to="/audit">Audit</NavLink>}
        <span className="spacer" />
        <span className="muted">{user?.username} ({user?.role})</span>
        <NavLink to="/password">Password</NavLink>
        <button onClick={() => logout().then(() => navigate("/login"))}>Sign out</button>
      </nav>
      <main>
        <Outlet />
      </main>
    </>
  );
}
```

**4k. `frontend/src/components/TrendChart.tsx`:** change the queries import to `import { useSeries, useSite } from "../api/queries";`, add `import { formatSiteDateTime, formatSiteTick } from "../lib/siteTime";`, add the tooltip helper above `seriesToOption`, replace `seriesToOption`'s signature and its `tooltip`/`xAxis` keys, and use the site zone in the component:

```ts
type TooltipItem = { axisValue?: number; marker?: string; seriesName?: string; value?: [string | number, number | null] };

/** Axis tooltip: the header time in the site zone (ECharts would print the browser's), then one row per series as before. */
export function tooltipHtml(raw: unknown, timezone: string): string {
  const items = (Array.isArray(raw) ? raw : [raw]) as TooltipItem[];
  const at = items[0]?.axisValue;
  const header = typeof at === "number" && Number.isFinite(at) ? formatSiteDateTime(new Date(at).toISOString(), timezone) : "";
  const rows = items.map((item) => {
    const v = item.value?.[1];
    return `${item.marker ?? ""}${item.seriesName ?? ""}: ${v == null ? "—" : Number(v.toFixed(3))}`;
  });
  return [header, ...rows].join("<br/>");
}

export function seriesToOption(series: Series, range: Range, query: Query = rangeToQuery(range), timezone = "UTC"): EChartsOption {
  const bucket = range === "7d" ? "hour" : null; // a week needs dates on the ticks, a day does not
  return {
    animation: false,
    useUTC: true, // tick positions on whole UTC hours; labels below are formatted in the site zone, not the browser's
    tooltip: { trigger: "axis", formatter: (raw: unknown) => tooltipHtml(raw, timezone) },
    grid: { left: 60, right: 20, top: 30, bottom: 40 },
    xAxis: {
      type: "time",
      axisLabel: { formatter: (value: number) => formatSiteTick(new Date(value).toISOString(), timezone, bucket) },
    },
    yAxis: { type: "value", name: series.unit, scale: true },
    series: [
      { name: "min", type: "line", data: withGaps(series.points, query, (p) => p.min), lineStyle: { opacity: 0 }, symbol: "none", stack: "band", connectNulls: false },
      { name: "max", type: "line", data: withGaps(series.points, query, (p) => p.max - p.min), lineStyle: { opacity: 0 }, symbol: "none", stack: "band", areaStyle: { color: "#000", opacity: 0.1 }, connectNulls: false },
      { name: "avg", type: "line", data: withGaps(series.points, query, (p) => p.avg), symbol: "none", color: "#000", connectNulls: false },
    ],
  };
}
```
In `TrendChart()` add `const site = useSite();` next to the `useSeries` call (before the `if (metric === null)` early return) and change the chart line to `<ReactECharts option={seriesToOption(data, range, undefined, site.data?.timezone ?? "UTC")} style={{ height: 320 }} notMerge />`.

**4l. `frontend/src/pages/AuditPage.tsx`** (replace the whole file; times come from the site timezone, and nothing renders until the zone is known so UTC never flashes):

```tsx
import { useState } from "react";
import { useAudit, useSite } from "../api/queries";
import { formatSiteDateTime } from "../lib/siteTime";

const PAGE_SIZE = 50;

export function AuditPage() {
  const [offset, setOffset] = useState(0);
  const { data, error, isLoading } = useAudit(PAGE_SIZE, offset);
  const site = useSite();
  const timezone = site.data?.timezone ?? "UTC"; // falls back to UTC if the site cannot be read
  const ready = !site.isPending;

  return (
    <>
      <h1>Audit log</h1>
      {(isLoading || site.isPending) && <p className="muted">loading…</p>}
      {error && <p className="error" role="alert">{error.message}</p>}
      {ready && data && data.items.length === 0 && <p className="muted">No audit entries yet.</p>}
      {ready && data && data.items.length > 0 && (
        <>
          <table>
            <thead><tr><th>Time ({timezone})</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id}>
                  <td>{formatSiteDateTime(e.ts, timezone)}</td>
                  <td>{e.username ?? "—"}</td>
                  <td>{e.action}</td>
                  <td><code>{JSON.stringify(e.detail)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>Previous</button>
            <span className="muted">{`Showing ${offset + 1}–${offset + data.items.length} of ${data.total}`}</span>
            <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + data.items.length >= data.total}>Next</button>
          </div>
        </>
      )}
    </>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd frontend && npm test -- src/lib src/test/reactGridLayout.smoke.test.tsx src/api/queries.test.tsx src/components src/pages/AuditPage.test.tsx src/pages/AssetPage.test.tsx src/App.test.tsx
cd frontend && npm test && npm run typecheck && npm run build
```
Expected: all PASS; no type errors (if `useUTC` were rejected by the typings, build the object as `const option: EChartsOption & { useUTC: boolean } = {...}` and return it); `vite build` succeeds and `frontend/dist/assets` contains separate small chunks for `DashboardsPage` and `DashboardPage`.

- [ ] **Step 6: Commit and push**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/api/types.ts frontend/src/api/queries.ts frontend/src/api/queries.test.tsx frontend/src/lib/ranges.ts frontend/src/lib/ranges.test.ts frontend/src/lib/siteTime.ts frontend/src/lib/siteTime.test.ts frontend/src/lib/layout.ts frontend/src/lib/layout.test.ts frontend/src/lib/download.ts frontend/src/lib/download.test.ts frontend/src/test/reactGridLayout.smoke.test.tsx frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/main.tsx frontend/src/components/Layout.tsx frontend/src/components/Layout.test.tsx frontend/src/components/TrendChart.tsx frontend/src/components/TrendChart.test.tsx frontend/src/pages/AuditPage.tsx frontend/src/pages/AuditPage.test.tsx frontend/src/pages/AssetPage.test.tsx frontend/src/pages/DashboardsPage.tsx frontend/src/pages/DashboardPage.tsx frontend/src/pages/BillingPage.tsx frontend/src/pages/TariffsPage.tsx
git commit -m "$(cat <<'EOF'
feat: frontend foundation for dashboards and billing

react-grid-layout 2 with a React 19 jsdom smoke test, Phase 3 types and hooks,
range/site-time/layout/download libraries, routes (dashboards lazy-loaded, tariffs
admin-only), nav links, placeholder pages, and site-timezone times on the asset
chart and the audit page.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

---

### Task 8: Tariffs page, Billing page and the asset cost tile

Admin Tariffs screen (currency, site default rates, per-asset overrides), the Billing screen (asset tree by day with kWh and cost, month totals, rate in effect, `~`/`*` marks, CSV) and the cost tile on the asset page.

**Files:**
- Create: `frontend/src/lib/billing.ts`, `frontend/src/lib/billing.test.ts`
- Create: `frontend/src/components/Figure.tsx`, `frontend/src/components/CostTile.tsx`, `frontend/src/components/CostTile.test.tsx`
- Replace (Task 7 placeholders): `frontend/src/pages/BillingPage.tsx`, `frontend/src/pages/TariffsPage.tsx`
- Create: `frontend/src/pages/BillingPage.test.tsx`, `frontend/src/pages/TariffsPage.test.tsx`
- Modify: `frontend/src/pages/AssetPage.tsx`, `frontend/src/pages/AssetPage.test.tsx`, `frontend/src/app.css`

**Interfaces:**
- Consumes (Task 7): types `BillingCosts`, `BillingAssetRow`, `CostFigure`, `CostToday`, `Tariff`, `TariffPatch`, `Asset`; hooks `useSite`, `useBillingCosts(month: string | null)`, `useBillingSettings`, `usePutBillingSettings`, `useTariffs`, `useCreateTariff`, `useUpdateTariff`, `useDeleteTariff`, `useAssets`; `siteMonth`, `formatSiteDay`, `downloadCsv`; `App`; `renderWithProviders`, `mockFetch`.
- HTTP (Interface Contracts): `GET /api/billing/costs?month=YYYY-MM` (409 on a non-whole-hour site zone), `GET /api/billing/costs.csv?month=`, `GET|PUT /api/settings/billing`, `GET|POST /api/tariffs`, `PATCH|DELETE /api/tariffs/{id}` (409 duplicate, 422 invalid), `GET /api/assets/{id}/summary` (`cost_today`, `currency`).
- Produces: `lib/billing.ts` (`shiftMonth(month, delta)`, `monthLabel(month)`, `depthsByAsset(assets)`, `fmtKwh`, `fmtCost`, `fmtRate`); `components/Figure.tsx` (`Figure({ text, estimated, partial })` renders `~` before and `*` after the text as `<abbr title>`, plus `ESTIMATED_TIP`, `PARTIAL_TIP`); `components/CostTile.tsx` (`CostTile({ cost: CostToday | null, currency: string | null })`); the real `BillingPage` and `TariffsPage` (same export names and `<h1>` text as the placeholders, so `App.test.tsx` keeps passing).

Review Focus 3 (UI side): a missing rate must never read as zero. `BillingPage.test.tsx` and `CostTile.test.tsx` carry the tests.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/billing.test.ts`:

```ts
import type { BillingAssetRow } from "../api/types";
import { depthsByAsset, fmtCost, fmtKwh, fmtRate, monthLabel, shiftMonth } from "./billing";

describe("shiftMonth", () => {
  it.each([
    ["2026-10", -1, "2026-09"], ["2026-10", 1, "2026-11"], ["2026-10", 0, "2026-10"],
    ["2026-01", -1, "2025-12"], ["2026-12", 1, "2027-01"], ["2026-03", -14, "2025-01"],
  ])("%s moved by %i is %s", (month, delta, expected) => {
    expect(shiftMonth(month, delta)).toBe(expected);
  });
});

describe("monthLabel and number formats", () => {
  it("names the month in words", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2025-12")).toBe("December 2025");
  });

  it("formats kWh to one decimal, cost to two, and a rate without trailing zeros up to six decimals", () => {
    expect(fmtKwh(12.5)).toBe("12.5");
    expect(fmtKwh(0)).toBe("0.0");
    expect(fmtCost(0.9)).toBe("0.90");
    expect(fmtRate(0.12)).toBe("0.12");
    expect(fmtRate(0.1234567)).toBe("0.123457");
    expect(fmtRate(1)).toBe("1");
    expect(fmtRate(0)).toBe("0");
    expect(fmtRate(null)).toBe("—");
  });
});

describe("depthsByAsset", () => {
  const row = (asset_id: number, parent_id: number | null, name: string, path: string): BillingAssetRow => ({
    asset_id, parent_id, name, path, rate_per_kwh: null, days: [], total: null,
  });

  it("derives depth from the parent chain, not from splitting the path on ' / '", () => {
    const depth = depthsByAsset([
      row(1, null, "Site", "Site"),
      row(2, 1, "MV2", "Site / MV2"),
      row(3, 2, "A / B", "Site / MV2 / A / B"), // an asset name that itself contains ' / '
      row(4, 1, "Spare", "Site / Spare"),
    ]);
    expect([...depth]).toEqual([[1, 0], [2, 1], [3, 2], [4, 1]]);
  });
});
```

`frontend/src/components/CostTile.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { CostTile } from "./CostTile";
import { ESTIMATED_TIP, PARTIAL_TIP } from "./Figure";

describe("CostTile", () => {
  it("shows today's cost with the currency", () => {
    render(<CostTile cost={{ cost: 12.34, estimated: false, partial: false }} currency="QAR" />);
    expect(screen.getByText("Cost today")).toBeInTheDocument();
    expect(screen.getByText("12.34")).toBeInTheDocument();
    expect(screen.getByText("QAR")).toBeInTheDocument();
    expect(screen.queryByTitle(ESTIMATED_TIP)).not.toBeInTheDocument();
    expect(screen.queryByTitle(PARTIAL_TIP)).not.toBeInTheDocument();
  });

  it("marks an estimated cost with ~ and a partial one with *, each with a tooltip", () => {
    render(<CostTile cost={{ cost: 0.39, estimated: true, partial: true }} currency="QAR" />);
    expect(screen.getByTitle(ESTIMATED_TIP)).toHaveTextContent("~");
    expect(screen.getByTitle(PARTIAL_TIP)).toHaveTextContent("*");
    expect(screen.getByText("0.39")).toBeInTheDocument();
  });

  it("shows a dash, never zero, when no rate applies (Review Focus 3, UI side)", () => {
    render(<CostTile cost={{ cost: null, estimated: false, partial: false }} currency="QAR" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("no rate set")).toBeInTheDocument();
    expect(screen.queryByText(/0\.00/)).not.toBeInTheDocument();
  });

  it("shows a dash when the asset has no energy figure at all", () => {
    render(<CostTile cost={null} currency="QAR" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("no cost data")).toBeInTheDocument();
  });

  it("says the currency is not set instead of guessing one", () => {
    render(<CostTile cost={{ cost: 3, estimated: false, partial: false }} currency={null} />);
    expect(screen.getByText("3.00")).toBeInTheDocument();
    expect(screen.getByText("currency not set")).toBeInTheDocument();
  });
});
```

`frontend/src/pages/BillingPage.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/client";
import type { BillingCosts, CostFigure } from "../api/types";
import { ESTIMATED_TIP, PARTIAL_TIP } from "../components/Figure";
import { downloadCsv } from "../lib/download";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { BillingPage } from "./BillingPage";

vi.mock("../lib/download", () => ({ downloadCsv: vi.fn() }));

const fig = (kwh: number, cost: number | null, over: Partial<CostFigure> = {}): CostFigure => ({
  kwh, cost, estimated: false, partial: false, ...over,
});
const costs: BillingCosts = {
  month: "2026-10", timezone: "Asia/Qatar", currency: "QAR",
  days: ["2026-10-01", "2026-10-02", "2026-10-03"],
  assets: [
    { asset_id: 1, parent_id: null, name: "Site", path: "Site", rate_per_kwh: 0.12,
      days: [fig(30, 3.6), fig(20, 2.4), null], total: fig(50, 6) },
    { asset_id: 2, parent_id: 1, name: "MV2", path: "Site / MV2", rate_per_kwh: 0.12,
      days: [fig(18, 2.16, { estimated: true }), fig(12, 1.44, { estimated: true }), null], total: fig(30, 3.6, { estimated: true }) },
    { asset_id: 3, parent_id: 2, name: "LV Panel 1", path: "Site / MV2 / LV Panel 1", rate_per_kwh: null,
      days: [fig(5, null), fig(7.5, 0.9, { partial: true }), null], total: fig(12.5, 0.9, { partial: true }) },
    { asset_id: 4, parent_id: 1, name: "Spare", path: "Site / Spare", rate_per_kwh: 0.12, days: [null, null, null], total: null },
  ],
};

let requested: (string | null)[];
const routes = (role: string, reply: { status?: number; body?: unknown }, zone: string): Routes => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/site": { body: { timezone: zone, currency: "QAR" } },
  "GET /api/billing/costs": ({ url }) => {
    requested.push(new URL(url, "http://x").searchParams.get("month"));
    return reply;
  },
});
const open = (role = "viewer", reply: { status?: number; body?: unknown } = { body: costs }, zone = "Asia/Qatar") => {
  mockFetch(routes(role, reply, zone));
  renderWithProviders(<BillingPage />, { route: "/billing", path: "/billing" });
};
/** Text of every non-header cell of an asset's row; a figure cell reads "kWh|cost". */
const cellsOf = (asset: string) => {
  const row = screen.getByRole("rowheader", { name: asset }).closest("tr")!;
  return Array.from(row.querySelectorAll("td")).map((td) =>
    td.children.length ? Array.from(td.children).map((c) => c.textContent).join("|") : td.textContent,
  );
};

beforeEach(() => {
  requested = [];
  // Only Date is faked, so React Query, user-event and waitFor keep their real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  vi.mocked(downloadCsv).mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("BillingPage", () => {
  it("says loading until the month arrives", () => {
    open();
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  it("shows the asset tree by day with kWh over cost, month totals and the rate in effect", async () => {
    open();
    expect(await screen.findByRole("rowheader", { name: "LV Panel 1" })).toBeInTheDocument();
    expect(screen.getByText("October 2026")).toBeInTheDocument();
    expect(requested).toEqual(["2026-10"]);
    expect(screen.getByRole("columnheader", { name: "Rate (QAR/kWh)" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Month total" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "2" })).toHaveAttribute("title", "Fri 02 Oct");
    expect(cellsOf("Site")).toEqual(["0.12", "50.0|6.00", "30.0|3.60", "20.0|2.40", "—"]); // rate, month total, three days
    expect(cellsOf("Spare")).toEqual(["0.12", "—", "—", "—", "—"]); // no energy figure: dashes, not zeros
  });

  it("indents each asset by its depth in the tree", async () => {
    open();
    const padding = async (name: string) => (await screen.findByRole("rowheader", { name })).style.paddingLeft;
    expect([await padding("Site"), await padding("MV2"), await padding("LV Panel 1"), await padding("Spare")])
      .toEqual(["8px", "24px", "40px", "24px"]);
  });

  it("marks estimated figures with ~ and partial costs with *, with tooltips and a legend", async () => {
    open();
    await screen.findByRole("rowheader", { name: "MV2" });
    expect(cellsOf("MV2")).toEqual(["0.12", "~30.0|~3.60", "~18.0|~2.16", "~12.0|~1.44", "—"]);
    expect(cellsOf("LV Panel 1")[1]).toBe("12.5|0.90*");
    expect(screen.getAllByTitle(ESTIMATED_TIP).length).toBeGreaterThan(0);
    expect(screen.getAllByTitle(PARTIAL_TIP).length).toBeGreaterThan(0);
    expect(screen.getByText(/estimated from average power/i)).toBeInTheDocument();
    expect(screen.getByText(/partial: some consumption had no rate/i)).toBeInTheDocument();
  });

  it("shows a dash, never zero, where no rate applies, and points an admin to Tariffs (Review Focus 3, UI side)", async () => {
    open("admin");
    await screen.findByRole("rowheader", { name: "LV Panel 1" });
    const lv = cellsOf("LV Panel 1");
    expect(lv[0]).toBe("—"); // no rate in effect
    expect(lv[2]).toBe("5.0|—"); // the consumption shows, its cost is a dash
    expect(screen.queryByText("0.00")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Set a rate on the Tariffs page/ })).toHaveAttribute("href", "/tariffs");
  });

  it("tells a viewer to ask an administrator instead of linking to Tariffs", async () => {
    open("viewer");
    await screen.findByRole("rowheader", { name: "LV Panel 1" });
    expect(screen.getByText(/ask an administrator/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Tariffs/ })).not.toBeInTheDocument();
  });

  it("defaults to the current month on the site's wall clock, not UTC", async () => {
    vi.setSystemTime(new Date("2026-10-31T22:30:00Z")); // 01:30 on 1 November in Asia/Qatar
    open("viewer", { body: { ...costs, month: "2026-11" } });
    expect(await screen.findByText("November 2026")).toBeInTheDocument();
    expect(requested).toEqual(["2026-11"]);
    expect(screen.getByRole("button", { name: "Next month" })).toBeDisabled(); // nothing lies after the current month
  });

  it("steps to the previous month and back, across a year end", async () => {
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    open("viewer", { body: costs }, "UTC");
    expect(await screen.findByText("January 2026")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByText("December 2025")).toBeInTheDocument();
    await waitFor(() => expect(requested).toEqual(["2026-01", "2025-12"]));
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByText("January 2026")).toBeInTheDocument();
  });

  it("downloads the month on screen as CSV", async () => {
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
    expect(downloadCsv).toHaveBeenCalledWith("/api/billing/costs.csv?month=2026-10");
  });

  it("shows why the export failed", async () => {
    vi.mocked(downloadCsv).mockRejectedValueOnce(new ApiError(409, "site timezone must have whole-hour UTC offsets"));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("site timezone must have whole-hour UTC offsets");
  });

  it("shows the server's explanation when billing is refused", async () => {
    open("viewer", { status: 409, body: { detail: "site timezone must have a whole-hour UTC offset" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("site timezone must have a whole-hour UTC offset");
  });

  it("says so when there are no assets", async () => {
    open("viewer", { body: { ...costs, assets: [] } });
    expect(await screen.findByText("No assets yet.")).toBeInTheDocument();
  });

  it("says so when no asset has energy data in the month", async () => {
    const none = costs.assets.map((a) => ({ ...a, days: a.days.map(() => null), total: null }));
    open("viewer", { body: { ...costs, assets: none } });
    expect(await screen.findByText("No energy data for this month.")).toBeInTheDocument();
  });
});
```

`frontend/src/pages/TariffsPage.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { TariffsPage } from "./TariffsPage";

const assets = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 5, parent_id: 1, name: "LV Panel 1", kind: "panel", sort_order: 0 },
];
const tariff = (id: number, asset_id: number | null, rate: number, from: string) => ({
  id, asset_id, asset_name: asset_id === 5 ? "LV Panel 1" : null, rate_per_kwh: rate,
  effective_from: from, created_by: 1, created_at: "2026-10-01T00:00:00Z",
});
type Row = ReturnType<typeof tariff>;

let rows: Row[];
let currency: string | null;
let overrides: Routes;

const routes = (role: string): Routes => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "a", role } },
  "GET /api/assets": { body: assets },
  "GET /api/settings/billing": () => ({ body: { currency } }),
  "PUT /api/settings/billing": ({ body }) => {
    currency = (body as { currency: string | null }).currency;
    return { body: { currency } };
  },
  "GET /api/tariffs": () => ({ body: rows }),
  "POST /api/tariffs": ({ body }) => {
    const b = body as { asset_id: number | null; rate_per_kwh: number; effective_from: string };
    const created = tariff(10, b.asset_id, b.rate_per_kwh, b.effective_from);
    rows = [...rows, created];
    return { status: 201, body: created };
  },
  "PATCH /api/tariffs/2": ({ body }) => {
    rows = rows.map((r) => (r.id === 2 ? { ...r, ...(body as Partial<Row>) } : r));
    return { body: rows.find((r) => r.id === 2) };
  },
  "DELETE /api/tariffs/3": () => {
    rows = rows.filter((r) => r.id !== 3);
    return { status: 204 };
  },
  ...overrides,
});
const open = () => {
  const calls = mockFetch(routes("admin"));
  renderWithProviders(<TariffsPage />, { route: "/tariffs", path: "/tariffs" });
  return calls;
};
const fillRate = async (form: HTMLElement, from: string, rate: string) => {
  fireEvent.change(within(form).getByLabelText("Effective from"), { target: { value: from } });
  await userEvent.type(within(form).getByLabelText("Rate per kWh"), rate);
};

beforeEach(() => {
  // newest first per scope, as the API returns them: site default rates, then overrides
  rows = [tariff(2, null, 0.15, "2026-10-01"), tariff(1, null, 0.12, "2026-01-01"), tariff(3, 5, 0.09, "2026-10-15")];
  currency = "QAR";
  overrides = {};
});

describe("TariffsPage", () => {
  it("lists the site default rates and the asset overrides, and shows the currency", async () => {
    open();
    const defaults = await screen.findByRole("table", { name: "Site default rates" });
    expect(within(defaults).getAllByRole("row")).toHaveLength(3); // header and two rates
    expect(within(defaults).getByText("0.15")).toBeInTheDocument();
    expect(within(defaults).getByText("2026-01-01")).toBeInTheDocument();
    const perAsset = screen.getByRole("table", { name: "Asset overrides" });
    expect(within(perAsset).getByText("LV Panel 1")).toBeInTheDocument();
    expect(within(perAsset).getByText("0.09")).toBeInTheDocument();
    expect(await screen.findByLabelText("Currency")).toHaveValue("QAR");
    expect(screen.queryByText(/No currency is set/)).not.toBeInTheDocument();
  });

  it("shows empty states when there are no rates and no overrides", async () => {
    rows = [];
    open();
    expect(await screen.findByText(/No site default rate yet/)).toBeInTheDocument();
    expect(screen.getByText(/No overrides/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("asks for a currency when none is set and saves it in capitals", async () => {
    currency = null;
    const calls = open();
    expect(await screen.findByText(/No currency is set/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Currency"), "qar");
    await userEvent.click(within(screen.getByRole("form", { name: "Site currency" })).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("saved")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ currency: "QAR" });
    await waitFor(() => expect(screen.queryByText(/No currency is set/)).not.toBeInTheDocument());
  });

  it("rejects a malformed currency without calling the API, and clears it when the field is emptied", async () => {
    const calls = open();
    const input = await screen.findByLabelText("Currency");
    const save = within(screen.getByRole("form", { name: "Site currency" })).getByRole("button", { name: "Save" });
    await userEvent.clear(input);
    await userEvent.type(input, "ab");
    await userEvent.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent(/three-letter/i);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await userEvent.clear(input);
    await userEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ currency: null }));
  });

  it("adds a site default rate and shows it", async () => {
    const calls = open();
    const form = await screen.findByRole("form", { name: "Add site default rate" });
    await fillRate(form, "2026-11-01", "0.2");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body)
      .toEqual({ asset_id: null, rate_per_kwh: 0.2, effective_from: "2026-11-01" }));
    expect(await within(screen.getByRole("table", { name: "Site default rates" })).findByText("2026-11-01")).toBeInTheDocument();
  });

  it("adds an override for the chosen asset and refuses to submit without one", async () => {
    const calls = open();
    const form = await screen.findByRole("form", { name: "Add asset override" });
    await fillRate(form, "2026-11-01", "0.1");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Choose an asset.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.selectOptions(within(form).getByLabelText("Asset"), "LV Panel 1");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body)
      .toEqual({ asset_id: 5, rate_per_kwh: 0.1, effective_from: "2026-11-01" }));
  });

  it("shows the server's reason when the date already has a rate (409)", async () => {
    overrides = { "POST /api/tariffs": { status: 409, body: { detail: "a rate for this asset and date already exists" } } };
    open();
    const form = await screen.findByRole("form", { name: "Add site default rate" });
    await fillRate(form, "2026-10-01", "0.2");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("a rate for this asset and date already exists");
  });

  it("shows a readable message for a validation error (422)", async () => {
    overrides = {
      "POST /api/tariffs": {
        status: 422,
        body: { detail: [{ loc: ["body", "rate_per_kwh"], msg: "Value error, rate must have at most 6 decimals" }] },
      },
    };
    open();
    const form = await screen.findByRole("form", { name: "Add site default rate" });
    await fillRate(form, "2026-11-01", "0.1234567");
    await userEvent.click(within(form).getByRole("button", { name: "Add rate" }));
    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("rate_per_kwh: rate must have at most 6 decimals");
    expect(alert).not.toHaveTextContent("Value error");
  });

  it("edits a rate and sends only the changed field", async () => {
    const calls = open();
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const rate = within(row).getByLabelText("Rate per kWh");
    await userEvent.clear(rate);
    await userEvent.type(rate, "0.18");
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ rate_per_kwh: 0.18 }));
    expect(await within(row).findByText("0.18")).toBeInTheDocument();
  });

  it("leaves the rate alone when an edit is cancelled", async () => {
    const calls = open();
    const row = (await screen.findByText("2026-10-01")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    await userEvent.type(within(row).getByLabelText("Rate per kWh"), "9");
    await userEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(within(row).getByText("0.15")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("deletes an override only after confirmation", async () => {
    const calls = open();
    const row = (await screen.findByText("2026-10-15")).closest("tr")!;
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("LV Panel 1"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/tariffs/3")).toBe(true));
    expect(await screen.findByText(/No overrides/)).toBeInTheDocument();
  });

  it("shows the error when the tariffs cannot be read", async () => {
    overrides = { "GET /api/tariffs": { status: 403, body: { detail: "insufficient role" } } };
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("insufficient role");
  });

  it("never asks for tariffs or the currency when a non-admin opens the route", async () => {
    const calls = mockFetch(routes("operator"));
    renderWithProviders(<App />, { route: "/tariffs", path: "*" });
    expect(await screen.findByText("Admins only")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/tariffs" || c.path === "/api/settings/billing")).toBe(false);
  });
});
```

`frontend/src/pages/AssetPage.test.tsx` edits (cost tile): replace the `summary` and `routes` helpers with

```tsx
const summary = (energy: unknown, cost: unknown = null) => ({
  asset: { id: 4, name: "Panel 1", parent_id: 1, kind: "panel" },
  metrics: [
    { mapping_id: 1, point_id: 7, metric: "active_power_kw", unit: "kW", value: 10.5, ts: "2026-10-07T10:00:00+00:00", quality: 0 },
    { mapping_id: 2, point_id: 8, metric: "voltage_v", unit: "V", value: null, ts: null, quality: null },
  ],
  energy_today: energy,
  cost_today: cost,
  currency: "QAR",
});
const routes = (energy: unknown, cost: unknown = null) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: "QAR" } },
  "GET /api/assets/4/summary": { body: summary(energy, cost) },
  "GET /api/assets/4/series": { body: { metric: "active_power_kw", unit: "kW", points: [] } },
});
```

add `import { PARTIAL_TIP } from "../components/Figure";` to the imports, and add inside `describe("AssetPage")`:

```tsx
  it("shows today's cost next to the energy tile, with the currency and the partial mark", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: false }, { cost: 0.39, estimated: false, partial: true }));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByText("Cost today")).toBeInTheDocument();
    expect(screen.getByText("0.39")).toBeInTheDocument();
    expect(screen.getByText("QAR")).toBeInTheDocument();
    expect(screen.getByTitle(PARTIAL_TIP)).toBeInTheDocument();
    expect(screen.getByText("Energy today")).toBeInTheDocument();
  });

  it("shows a dash for the cost when no rate is set", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: false }, { cost: null, estimated: false, partial: false }));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByText("no rate set")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify the failures**

```bash
cd frontend && npm test -- src/lib/billing.test.ts src/components/CostTile.test.tsx src/pages/BillingPage.test.tsx src/pages/TariffsPage.test.tsx src/pages/AssetPage.test.tsx
```
Expected: FAIL. `billing.test.ts` and `CostTile.test.tsx` cannot import their modules; the Billing and Tariffs tests find only the Task 7 placeholder headings; the two new AssetPage tests find no "Cost today". The older AssetPage tests still pass.

- [ ] **Step 3: Implement**

`frontend/src/lib/billing.ts`:

```ts
import type { BillingAssetRow } from "../api/types";

/** `2026-01` moved by `delta` months, as plain `YYYY-MM` string maths (no Date, so no timezone can shift it). */
export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number);
  const index = year * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** `October 2026` for `2026-10`. */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(Date.UTC(year, m - 1, 1)));
}

/** Tree depth per asset id. The API lists assets parents-first, so one pass over the parent chain is enough. */
export function depthsByAsset(assets: readonly BillingAssetRow[]): Map<number, number> {
  const depth = new Map<number, number>();
  for (const a of assets) {
    const parent = a.parent_id === null ? undefined : depth.get(a.parent_id);
    depth.set(a.asset_id, parent === undefined ? 0 : parent + 1);
  }
  return depth;
}

export const fmtKwh = (kwh: number) => kwh.toFixed(1);
export const fmtCost = (cost: number) => cost.toFixed(2);
/** A rate with up to six decimals and no trailing zeros; a dash when there is none (never zero). */
export const fmtRate = (rate: number | null) => (rate === null ? "—" : String(Number(rate.toFixed(6))));
```

`frontend/src/components/Figure.tsx`:

```tsx
export const ESTIMATED_TIP = "Estimated from average power; this asset has no energy counter.";
export const PARTIAL_TIP = "Partial: some consumption in this period had no rate, so the cost is incomplete.";

/** A number with its marks: `~` before it when estimated, `*` after it when partial. Each mark explains itself on hover. */
export function Figure({ text, estimated, partial }: { text: string; estimated: boolean; partial: boolean }) {
  return (
    <>
      {estimated && <abbr title={ESTIMATED_TIP}>~</abbr>}
      {text}
      {partial && <abbr title={PARTIAL_TIP}>*</abbr>}
    </>
  );
}
```

`frontend/src/components/CostTile.tsx`:

```tsx
import type { CostToday } from "../api/types";
import { fmtCost } from "../lib/billing";
import { Figure } from "./Figure";

/** Today's cost for the asset page. A dash means "no figure", never zero. */
export function CostTile({ cost, currency }: { cost: CostToday | null; currency: string | null }) {
  return (
    <div className="tile">
      <div className="muted">Cost today</div>
      {cost === null && (
        <>
          <div className="big">—</div>
          <small className="muted">no cost data</small>
        </>
      )}
      {cost !== null && cost.cost === null && (
        <>
          <div className="big">—</div>
          <small className="muted">no rate set</small>
        </>
      )}
      {cost !== null && cost.cost !== null && (
        <>
          <div className="big">
            <Figure text={fmtCost(cost.cost)} estimated={cost.estimated} partial={cost.partial} />
            {currency && <small className="muted"> {currency}</small>}
          </div>
          {!currency && <small className="muted">currency not set</small>}
        </>
      )}
    </div>
  );
}
```

`frontend/src/pages/AssetPage.tsx`: add `import { CostTile } from "../components/CostTile";` and, directly after `<EnergyTile energy={data.energy_today} />`, add `<CostTile cost={data.cost_today ?? null} currency={data.currency ?? null} />`.

`frontend/src/pages/BillingPage.tsx` (replace the placeholder):

```tsx
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useBillingCosts, useSite } from "../api/queries";
import type { BillingCosts, CostFigure } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ESTIMATED_TIP, Figure, PARTIAL_TIP } from "../components/Figure";
import { depthsByAsset, fmtCost, fmtKwh, fmtRate, monthLabel, shiftMonth } from "../lib/billing";
import { downloadCsv } from "../lib/download";
import { formatSiteDay, siteMonth } from "../lib/siteTime";

/** One day (or the month) of one asset: kWh above, cost below. A null figure or a null cost is a dash, never zero. */
function FigureCell({ figure }: { figure: CostFigure | null }) {
  if (figure === null) return <td className="num muted">—</td>;
  return (
    <td className="num">
      <div><Figure text={fmtKwh(figure.kwh)} estimated={figure.estimated} partial={false} /></div>
      <div className="muted">
        {figure.cost === null ? "—" : <Figure text={fmtCost(figure.cost)} estimated={figure.estimated} partial={figure.partial} />}
      </div>
    </td>
  );
}

function BillingTable({ costs, isAdmin }: { costs: BillingCosts; isAdmin: boolean }) {
  const depth = useMemo(() => depthsByAsset(costs.assets), [costs.assets]);
  if (costs.assets.length === 0) return <p className="muted">No assets yet.</p>;
  if (costs.assets.every((a) => a.total === null)) return <p className="muted">No energy data for this month.</p>;
  const missingRate = costs.assets.some((a) => a.total !== null && a.total.kwh > 0 && (a.total.cost === null || a.total.partial));
  return (
    <>
      {missingRate && (isAdmin ? (
        <p role="status">
          Some consumption has no rate, so its cost shows a dash. <Link to="/tariffs">Set a rate on the Tariffs page</Link>.
        </p>
      ) : (
        <p role="status" className="muted">Some consumption has no rate, so its cost shows a dash. Ask an administrator to set one.</p>
      ))}
      <div className="table-scroll">
        <table className="billing">
          <caption className="muted">
            Each cell shows kWh above and cost{costs.currency ? ` in ${costs.currency}` : ""} below.
          </caption>
          <thead>
            <tr>
              <th>Asset</th>
              <th>{costs.currency ? `Rate (${costs.currency}/kWh)` : "Rate (per kWh)"}</th>
              <th>Month total</th>
              {costs.days.map((day) => <th key={day} title={formatSiteDay(day)}>{Number(day.slice(8))}</th>)}
            </tr>
          </thead>
          <tbody>
            {costs.assets.map((a) => (
              <tr key={a.asset_id}>
                <th scope="row" title={a.path} style={{ paddingLeft: 8 + (depth.get(a.asset_id) ?? 0) * 16 }}>{a.name}</th>
                <td className="num">{fmtRate(a.rate_per_kwh)}</td>
                <FigureCell figure={a.total} />
                {a.days.map((d, i) => <FigureCell key={costs.days[i]} figure={d} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        <abbr title={ESTIMATED_TIP}>~</abbr> estimated from average power (no energy counter) ·{" "}
        <abbr title={PARTIAL_TIP}>*</abbr> partial: some consumption had no rate · — no figure or no rate
      </p>
    </>
  );
}

export function BillingPage() {
  const { hasRole } = useAuth();
  const site = useSite();
  const [picked, setPicked] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // "This month" is decided on the site's wall clock: near a month end it differs from the browser's and from UTC.
  const current = site.data ? siteMonth(new Date(), site.data.timezone) : null;
  const month = picked ?? current;
  const costs = useBillingCosts(month);

  const exportCsv = async () => {
    if (month === null) return;
    setExporting(true);
    setExportError(null);
    try {
      await downloadCsv(`/api/billing/costs.csv?month=${month}`);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <section>
      <h1>Billing</h1>
      {site.isError && <p className="error" role="alert">{site.error.message}</p>}
      {month !== null && (
        <div className="row">
          <button type="button" onClick={() => setPicked(shiftMonth(month, -1))}>Previous month</button>
          <strong aria-live="polite">{monthLabel(month)}</strong>
          <button type="button" onClick={() => setPicked(shiftMonth(month, 1))} disabled={current !== null && month >= current}>
            Next month
          </button>
          <button type="button" onClick={exportCsv} disabled={exporting}>Download CSV</button>
        </div>
      )}
      {exportError && <p className="error" role="alert">{exportError}</p>}
      {(site.isPending || (month !== null && costs.isPending)) && <p className="muted">loading…</p>}
      {costs.isError && <p className="error" role="alert">{costs.error.message}</p>}
      {costs.data && <BillingTable costs={costs.data} isAdmin={hasRole("admin")} />}
    </section>
  );
}
```

`frontend/src/pages/TariffsPage.tsx` (replace the placeholder):

```tsx
import { useState, type FormEvent } from "react";
import {
  useAssets, useBillingSettings, useCreateTariff, useDeleteTariff, usePutBillingSettings, useTariffs, useUpdateTariff,
} from "../api/queries";
import type { Asset, Tariff, TariffPatch } from "../api/types";
import { fmtRate } from "../lib/billing";

/** ApiError.message already carries the API's `detail` (a string for 404/409, a joined list for 422); drop pydantic's prefix. */
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : "request failed").replace(/Value error, /g, "");
}

const validRate = (text: string) => text.trim() !== "" && Number.isFinite(Number(text)) && Number(text) >= 0;

function CurrencyForm() {
  const settings = useBillingSettings();
  const put = usePutBillingSettings();
  const [typed, setTyped] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (settings.isPending) return <p className="muted">loading…</p>;
  if (settings.isError) return <p className="error" role="alert">{errorText(settings.error)}</p>;
  const stored = settings.data.currency;
  const shown = typed ?? stored ?? "";
  const save = (e: FormEvent) => {
    e.preventDefault();
    const code = shown.trim().toUpperCase();
    if (code !== "" && !/^[A-Z]{3}$/.test(code)) return setProblem("Use a three-letter currency code, for example QAR.");
    setProblem(null);
    put.mutate({ currency: code === "" ? null : code });
  };
  return (
    <>
      {stored === null && (
        <p role="status">No currency is set, so costs show without a unit. Enter a three-letter code such as QAR.</p>
      )}
      <form aria-label="Site currency" noValidate onSubmit={save}>
        <label>
          Currency
          <input
            value={shown}
            maxLength={3}
            onChange={(e) => {
              setTyped(e.target.value.toUpperCase());
              put.reset();
            }}
          />
        </label>
        <button type="submit" disabled={put.isPending}>Save</button>
        {put.isSuccess && <span className="muted"> saved</span>}
        {problem && <p className="error" role="alert">{problem}</p>}
        {put.isError && <p className="error" role="alert">{errorText(put.error)}</p>}
      </form>
    </>
  );
}

/** `assets === null` adds a site default rate; otherwise an override for an asset picked from the list. */
function AddTariff({ assets }: { assets: Asset[] | null }) {
  const create = useCreateTariff();
  const [assetId, setAssetId] = useState("");
  const [from, setFrom] = useState("");
  const [rate, setRate] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (assets !== null && assetId === "") return setProblem("Choose an asset.");
    if (from === "") return setProblem("Choose the date the rate takes effect.");
    if (!validRate(rate)) return setProblem("Enter a rate of zero or more.");
    setProblem(null);
    create.mutate(
      { asset_id: assets === null ? null : Number(assetId), rate_per_kwh: Number(rate), effective_from: from },
      { onSuccess: () => { setRate(""); setFrom(""); } },
    );
  };
  return (
    <form aria-label={assets === null ? "Add site default rate" : "Add asset override"} noValidate onSubmit={submit}>
      {assets !== null && (
        <label>
          Asset
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">Choose an asset…</option>
            {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}
      <label>
        Effective from
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label>
        Rate per kWh
        <input type="number" min="0" step="any" value={rate} onChange={(e) => setRate(e.target.value)} />
      </label>
      <button type="submit" disabled={create.isPending}>Add rate</button>
      {problem && <p className="error" role="alert">{problem}</p>}
      {create.isError && <p className="error" role="alert">{errorText(create.error)}</p>}
    </form>
  );
}

function TariffRow({ tariff }: { tariff: Tariff }) {
  const update = useUpdateTariff();
  const remove = useDeleteTariff();
  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState(String(tariff.rate_per_kwh));
  const [from, setFrom] = useState(tariff.effective_from);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = update.isPending || remove.isPending;
  const failure = problem ?? (update.isError ? errorText(update.error) : remove.isError ? errorText(remove.error) : null);

  const startEdit = () => {
    setRate(String(tariff.rate_per_kwh));
    setFrom(tariff.effective_from);
    setProblem(null);
    update.reset();
    setEditing(true);
  };
  const save = () => {
    if (!validRate(rate)) return setProblem("Enter a rate of zero or more.");
    const body: TariffPatch = {};
    if (Number(rate) !== tariff.rate_per_kwh) body.rate_per_kwh = Number(rate);
    if (from !== "" && from !== tariff.effective_from) body.effective_from = from;
    if (Object.keys(body).length === 0) return setEditing(false);
    setProblem(null);
    update.mutate({ id: tariff.id, body }, { onSuccess: () => setEditing(false) });
  };
  const del = () => {
    const where = tariff.asset_name ? ` for ${tariff.asset_name}` : "";
    const question = `Delete the rate of ${fmtRate(tariff.rate_per_kwh)} from ${tariff.effective_from}${where}? Costs for those days will change.`;
    if (window.confirm(question)) remove.mutate(tariff.id);
  };

  return (
    <tr>
      {tariff.asset_id !== null && <td>{tariff.asset_name}</td>}
      <td>
        {editing ? <input type="date" aria-label="Effective from" value={from} onChange={(e) => setFrom(e.target.value)} /> : tariff.effective_from}
      </td>
      <td className="num">
        {editing ? (
          <input type="number" min="0" step="any" aria-label="Rate per kWh" value={rate} onChange={(e) => setRate(e.target.value)} />
        ) : fmtRate(tariff.rate_per_kwh)}
      </td>
      <td>
        {editing ? (
          <>
            <button type="button" onClick={save} disabled={busy}>Save</button>{" "}
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" onClick={startEdit} disabled={busy}>Edit</button>{" "}
            <button type="button" onClick={del} disabled={busy}>Delete</button>
          </>
        )}
        {failure && <span className="error" role="alert"> {failure}</span>}
      </td>
    </tr>
  );
}

function TariffTables({ tariffs, assets }: { tariffs: Tariff[]; assets: Asset[] }) {
  const defaults = tariffs.filter((t) => t.asset_id === null);
  const perAsset = tariffs.filter((t) => t.asset_id !== null);
  return (
    <>
      <p className="muted">
        A rate applies from its effective date (a site-local date) until the next one. An asset's override replaces the
        site default from its own effective date. Editing a past rate recalculates history.
      </p>
      <h2>Site default rate</h2>
      {defaults.length === 0 ? (
        <p className="muted">No site default rate yet. Until one is set, assets without their own rate show a dash for cost.</p>
      ) : (
        <table aria-label="Site default rates">
          <thead><tr><th>Effective from</th><th>Rate per kWh</th><th>Actions</th></tr></thead>
          <tbody>{defaults.map((t) => <TariffRow key={t.id} tariff={t} />)}</tbody>
        </table>
      )}
      <AddTariff assets={null} />
      <h2>Asset overrides</h2>
      {perAsset.length === 0 ? (
        <p className="muted">No overrides. Every asset uses the site default rate.</p>
      ) : (
        <table aria-label="Asset overrides">
          <thead><tr><th>Asset</th><th>Effective from</th><th>Rate per kWh</th><th>Actions</th></tr></thead>
          <tbody>{perAsset.map((t) => <TariffRow key={t.id} tariff={t} />)}</tbody>
        </table>
      )}
      <AddTariff assets={assets} />
    </>
  );
}

/** Admin only (the route is wrapped in RequireRole): the site currency, the site default rates and per-asset overrides. */
export function TariffsPage() {
  const tariffs = useTariffs();
  const assets = useAssets();
  return (
    <section>
      <h1>Tariffs</h1>
      <h2>Currency</h2>
      <CurrencyForm />
      {tariffs.isPending && <p className="muted">loading…</p>}
      {tariffs.isError && <p className="error" role="alert">{errorText(tariffs.error)}</p>}
      {tariffs.data && <TariffTables tariffs={tariffs.data} assets={assets.data ?? []} />}
    </section>
  );
}
```

Append to `frontend/src/app.css`:

```css

/* Billing and cost figures */
.table-scroll { overflow-x: auto; }
table.billing th, table.billing td { white-space: nowrap; }
table.billing tbody th[scope="row"] { position: sticky; left: 0; background: #fff; font-weight: normal; }
td.num { text-align: right; }
abbr[title] { text-decoration: none; cursor: help; }
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd frontend && npm test -- src/lib/billing.test.ts src/components/CostTile.test.tsx src/pages/BillingPage.test.tsx src/pages/TariffsPage.test.tsx src/pages/AssetPage.test.tsx src/App.test.tsx
cd frontend && npm test && npm run typecheck
```
Expected: PASS everywhere (the whole suite, including the Task 7 `App.test.tsx`, which now renders the real Billing and Tariffs pages against its mocked routes), no type errors. If a Billing test is flaky around month labels, check the fake clock is set before `open()` and that `afterEach(vi.useRealTimers)` ran.

- [ ] **Step 5: Commit and push**

```bash
git add frontend/src/lib/billing.ts frontend/src/lib/billing.test.ts frontend/src/components/Figure.tsx frontend/src/components/CostTile.tsx frontend/src/components/CostTile.test.tsx frontend/src/pages/BillingPage.tsx frontend/src/pages/BillingPage.test.tsx frontend/src/pages/TariffsPage.tsx frontend/src/pages/TariffsPage.test.tsx frontend/src/pages/AssetPage.tsx frontend/src/pages/AssetPage.test.tsx frontend/src/app.css
git commit -m "$(cat <<'EOF'
feat: tariffs page, billing page and the asset cost tile

Admin Tariffs screen with the site currency, site default rates and per-asset
overrides; Billing screen with the asset tree by day, month totals, rate in
effect, ~ and * marks, a dash (never zero) for a missing rate, and CSV export;
cost tile next to the energy tile on the asset page.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

### Task 9: Dashboards list and the read-only dashboard view with widgets

Dashboards list (create and delete for operators and admins), the read-only dashboard page with the five widget types, per-widget CSV, a `missing`-assets warning chip, a dashboard-level range select (view state only) and one shared live stream. Charts load lazily. The grid and the editor come in Task 10.

**Design notes (decided here, do not revisit):**
- The view lays widgets out with a plain CSS grid (`StaticGrid`), not a static react-grid-layout: no width measurement and no library on the view path, and Task 10's editor uses `noCompactor` with the same row height and gap (`lib/gridMetrics.ts`), so saved `x/y/w/h` render identically in both.
- Live values: `point_id` only arrives inside each widget's fetched `values`, so widgets register their point ids with `LiveValuesProvider` (`register(owner, ids)`); the provider unions them into ONE `useStream`. A widget uses the stream only if it is live-eligible (`isLiveWidget`): stat/gauge, source `metric`, aggregation `last`, effective range rolling or `today`/`this_month`. A stream entry wins even when its value is null (`liveOrFetched`).
- Edit mode is entered from the create dialog with `navigate("/dashboards/ID", { state: { edit: true } })`; Task 10 reads `location.state.edit` (a viewer arriving with it stays in view mode).
- Chip text is `1 asset removed` / `N assets removed` (the "N asset(s) removed" of the spec, with correct plurals).

**Files:**
- Create: `frontend/src/test/dashboardFixtures.ts`
- Create: `frontend/src/lib/widgetFormat.ts`, `frontend/src/lib/widgetFormat.test.ts`
- Create: `frontend/src/lib/live.ts`, `frontend/src/lib/live.test.ts`
- Create: `frontend/src/lib/gridMetrics.ts`, `frontend/src/lib/gridMetrics.test.ts`
- Create: `frontend/src/hooks/useDialogFocus.ts`, `frontend/src/hooks/useDialogFocus.test.tsx`
- Create: `frontend/src/components/dashboard/LiveValuesContext.tsx`
- Create: `frontend/src/components/dashboard/WidgetFrame.tsx`, `WidgetFrame.test.tsx`
- Create: `frontend/src/components/dashboard/widgets/StatWidget.tsx`, `TableWidget.tsx`, `GaugeWidget.tsx`, `BarWidget.tsx`, `TimeSeriesWidget.tsx`, `widgets.test.tsx`
- Create: `frontend/src/components/dashboard/WidgetBody.tsx`, `WidgetView.tsx`, `StaticGrid.tsx`, `DashboardViewer.tsx`, `CreateDashboardDialog.tsx`
- Replace (Task 7 placeholders): `frontend/src/pages/DashboardsPage.tsx`, `frontend/src/pages/DashboardPage.tsx`
- Test: `frontend/src/pages/DashboardsPage.test.tsx`, `frontend/src/pages/DashboardPage.test.tsx`
- Modify: `frontend/src/app.css` (append)

**Interfaces:**

Consumes (Task 7, already merged on this branch; exact):
```ts
// api/types.ts
type RangePreset = "1h" | "6h" | "24h" | "7d" | "30d" | "today" | "yesterday" | "this_month" | "last_month";
type WidgetType = "timeseries" | "bar" | "stat" | "gauge" | "table";  // WIDGET_TYPES is the const tuple
type WidgetSource = "metric" | "energy" | "cost";  type WidgetAggregation = "avg" | "min" | "max" | "last" | "sum";
interface Site { timezone: string; currency: string | null }
interface WidgetConfig { assets: number[]; source: WidgetSource; metric: Metric | null; aggregation: WidgetAggregation;
                         range: RangePreset | null; bars: "asset" | "time"; min: number; max: number | null }
interface Widget { id: number; type: WidgetType; title: string; config: WidgetConfig; x: number; y: number; w: number; h: number }
interface Dashboard { id: number; name: string; range: RangePreset; updated_at: string; widgets: Widget[] }
interface DashboardListItem { id: number; name: string; range: RangePreset; widget_count: number; updated_at: string }
interface WidgetData { type: WidgetType; mode: "series" | "values"; source: WidgetSource; metric: Metric | null; unit: string | null;
  range: { preset: RangePreset; start: string; end: string }; tier: SeriesTier | null; bucket: "hour" | "day" | null;
  series: WidgetSeries[]; values: WidgetValue[]; missing: number[] }   // WidgetSeries { asset_id, name, points: WidgetPoint[], estimated, partial }
                                                                       // WidgetPoint { ts, value|null, min|null, max|null }; WidgetValue { asset_id, name, value|null, estimated, partial, point_id|null }
// api/queries.ts
useSite(): UseQueryResult<Site>;  useDashboards(): UseQueryResult<DashboardListItem[]>;  useDashboard(id: number): UseQueryResult<Dashboard>;
useWidgetData(type, config, preset: RangePreset, enabled = true): UseQueryResult<WidgetData>;   // POST /api/widget-data {type, config, range: preset}; refetches every 30 s, keeps previous data
useCreateDashboard()  // mutateAsync({ name: string; range?: RangePreset }) -> Dashboard (also cached under useDashboard(id))
useDeleteDashboard()  // mutateAsync(id: number) -> void; refreshes the dashboards list
// lib/ranges.ts   RANGE_PRESETS: RangePreset[]; RANGE_LABELS: Record<RangePreset, string>; isRolling(p: RangePreset): boolean
// lib/siteTime.ts formatSiteDateTime(iso, timezone) -> "2026-10-07 13:00:00"; formatSiteTick(iso, timezone, bucket: "hour" | "day" | null) -> "13:00" | "10-07 13:00" | "10-07"
// lib/layout.ts   GRID_COLS = 12
// lib/download.ts downloadCsv(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<void>
```
Existing code used: `useAuth().hasRole`, `useAction()` (`hooks/useAction.ts`), `useStream(wanted: Set<number>)` (`hooks/useStream.ts`), `LiveValue` (`lib/stream.ts`), `renderWithProviders`, `mockFetch` (+ its exported `Routes` type).

Produces (Task 10 consumes these; keep the signatures exactly):
```ts
// hooks/useDialogFocus.ts
export function useDialogFocus(root: RefObject<HTMLElement | null>, onClose: () => void,
  options?: { busy?: boolean; initial?: RefObject<HTMLElement | null> }): void
// components/dashboard/LiveValuesContext.tsx
export const LiveValuesContext: React.Context<{ values: ReadonlyMap<number, LiveValue>; connected: boolean; register: (owner: string, pointIds: readonly number[]) => void }>
export function LiveValuesProvider(props: { children: ReactNode }): JSX.Element
export function useLiveRegistration(owner: string, pointIds: readonly number[]): void
export function useLiveValue(pointId: number | null): LiveValue | undefined
// components/dashboard/WidgetView.tsx
export interface WidgetViewProps { widgetKey: string; type: WidgetType; title: string; config: WidgetConfig; dashboardRange: RangePreset; timezone: string;
  csv?: boolean /* default true */; live?: boolean /* default true */; actions?: ReactNode; dragHandle?: boolean }
export function WidgetView(props: WidgetViewProps): JSX.Element
// components/dashboard/DashboardViewer.tsx
export function DashboardViewer(props: { dashboard: Dashboard; timezone: string; onEdit?: () => void }): JSX.Element   // Edit button only when onEdit is given
// lib/gridMetrics.ts
export const ROW_HEIGHT = 80; export const GRID_GAP = 10;
// lib/widgetFormat.ts: formatValue, figureText, markerHint, removedText, unitSuffix, escapeHtml, uniqueLabels, chartLabels
// pages/DashboardsPage.tsx: export function DashboardsPage(); pages/DashboardPage.tsx: export function DashboardPage()
// test/dashboardFixtures.ts: SITE, authed(role), assetList, config(over), widget(id, type, over), dashboard(over), seriesData(over), valuesData(over), dataFor(type), widgetDataRoute
```

- [ ] **Step 1: Preconditions**

```bash
cd /home/ziad/Projects/DC_Dashboard && git status --short && git branch --show-current   # expect: phase-3-dashboards-billing, clean
ls frontend/src/lib/ranges.ts frontend/src/lib/siteTime.ts frontend/src/lib/layout.ts frontend/src/lib/download.ts frontend/src/pages/DashboardsPage.tsx frontend/src/pages/DashboardPage.tsx
cd frontend && npm run typecheck && npm test
```
Expected: every file exists (Task 7), typecheck and the whole suite are green. If not, stop and report: this task needs Task 7.

- [ ] **Step 2: Shared test fixtures** (no test of its own; every test below uses it)

Create `frontend/src/test/dashboardFixtures.ts`:
```ts
import type { Asset, Dashboard, Role, Widget, WidgetConfig, WidgetData, WidgetType } from "../api/types";

export const SITE = { timezone: "Asia/Qatar", currency: "QAR" };

/** The three requests every page test needs: no setup pending, who is signed in, and the site zone. */
export const authed = (role: Role) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/site": { body: SITE },
});

export const assetList: Asset[] = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 2, parent_id: 1, name: "MV2", kind: "panel", sort_order: 0 },
  { id: 5, parent_id: 2, name: "LV Panel 1", kind: "panel", sort_order: 0 },
  { id: 6, parent_id: 2, name: "LV Panel 2", kind: "panel", sort_order: 1 },
];

export const config = (over: Partial<WidgetConfig> = {}): WidgetConfig => ({
  assets: [5], source: "metric", metric: "active_power_kw", aggregation: "avg", range: null, bars: "asset", min: 0, max: null, ...over,
});
export const widget = (id: number, type: WidgetType, over: Partial<Widget> = {}): Widget => ({
  id, type, title: `Widget ${id}`, config: config(), x: 0, y: 0, w: 4, h: 3, ...over,
});
export const dashboard = (over: Partial<Dashboard> = {}): Dashboard => ({
  id: 3, name: "Hall A", range: "24h", updated_at: "2026-10-08T06:00:00+00:00", widgets: [], ...over,
});

const RANGE = { preset: "24h", start: "2026-10-07T06:00:00+00:00", end: "2026-10-08T06:00:00+00:00" } as const;

/** A metric time series for asset 5 (two one-minute buckets). */
export const seriesData = (over: Partial<WidgetData> = {}): WidgetData => ({
  type: "timeseries", mode: "series", source: "metric", metric: "active_power_kw", unit: "kW",
  range: { ...RANGE }, tier: "1m", bucket: null,
  series: [{
    asset_id: 5, name: "LV Panel 1", estimated: false, partial: false,
    points: [
      { ts: "2026-10-08T00:00:00+00:00", value: 1, min: 0.5, max: 1.5 },
      { ts: "2026-10-08T00:01:00+00:00", value: 2, min: 1, max: 3 },
    ],
  }],
  values: [], missing: [], ...over,
});

/** One value per asset: asset 5 is mapped to point 7 and reads 10.5. */
export const valuesData = (over: Partial<WidgetData> = {}): WidgetData => ({
  type: "stat", mode: "values", source: "metric", metric: "active_power_kw", unit: "kW",
  range: { ...RANGE }, tier: null, bucket: null, series: [],
  values: [{ asset_id: 5, name: "LV Panel 1", value: 10.5, estimated: false, partial: false, point_id: 7 }],
  missing: [], ...over,
});

/** What the API answers for each widget type, so a page with one widget of each type can be mocked in one handler. */
export function dataFor(type: WidgetType): WidgetData {
  switch (type) {
    case "timeseries": return seriesData();
    case "bar": return valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh" });
    case "stat": return valuesData({ type: "stat" });
    case "gauge": return valuesData({ type: "gauge" });
    case "table":
      return valuesData({
        type: "table",
        values: [
          { asset_id: 5, name: "LV Panel 1", value: 10.5, estimated: false, partial: false, point_id: 7 },
          { asset_id: 6, name: "LV Panel 2", value: 4.25, estimated: true, partial: false, point_id: 8 },
        ],
      });
  }
}
export const widgetDataRoute = ({ body }: { url: string; body: unknown }) => ({ body: dataFor((body as { type: WidgetType }).type) });
```

- [ ] **Step 3: Pure helpers, tests first**

Create `frontend/src/lib/widgetFormat.test.ts`:
```ts
import { chartLabels, escapeHtml, figureText, formatValue, markerHint, removedText, uniqueLabels, unitSuffix } from "./widgetFormat";

const none = { estimated: false, partial: false };

describe("figureText", () => {
  it("shows two decimals, ~ in front of an estimated figure and * behind a partial one", () => {
    expect(figureText(12.3, none)).toBe("12.30");
    expect(figureText(12.3, { estimated: true, partial: false })).toBe("~12.30");
    expect(figureText(12.3, { estimated: false, partial: true })).toBe("12.30*");
    expect(figureText(0, { estimated: true, partial: true })).toBe("~0.00*");
  });
  it("shows a dash for a missing figure, never a zero and never a marker", () => {
    expect(figureText(null, { estimated: true, partial: true })).toBe("—");
    expect(figureText(undefined, none)).toBe("—");
    expect(formatValue(null)).toBe("—");
    expect(formatValue(3)).toBe("3.00");
  });
});

describe("markers and labels", () => {
  it("explains the markers that are present", () => {
    expect(markerHint(none)).toBe("");
    expect(markerHint({ estimated: true, partial: false })).toBe("~ estimated");
    expect(markerHint({ estimated: true, partial: true })).toBe("~ estimated, * partial, some hours have no rate");
  });
  it("words the removed-assets chip with correct plurals", () => {
    expect(removedText(1)).toBe("1 asset removed");
    expect(removedText(2)).toBe("2 assets removed");
  });
  it("appends the unit only when there is one", () => {
    expect(unitSuffix("kW")).toBe(" kW");
    expect(unitSuffix(null)).toBe("");
  });
  it("tells apart assets with the same name by id, and marks estimated and partial series", () => {
    const rows = [
      { asset_id: 1, name: "Panel", estimated: false, partial: false },
      { asset_id: 2, name: "Panel", estimated: true, partial: false },
      { asset_id: 3, name: "Main", estimated: false, partial: true },
    ];
    expect(uniqueLabels(rows)).toEqual(["Panel (#1)", "Panel (#2)", "Main"]);
    expect(chartLabels(rows)).toEqual(["Panel (#1)", "Panel (#2) ~", "Main *"]);
  });
  it("escapes HTML, because asset names are typed by users and ECharts renders tooltip text as HTML", () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe("&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
  });
});
```

Create `frontend/src/lib/live.test.ts`:
```ts
import type { RangePreset, WidgetType } from "../api/types";
import { valuesData } from "../test/dashboardFixtures";
import { isLiveWidget, liveOrFetched, pointIdsOf } from "./live";

const last = { source: "metric", aggregation: "last" } as const;

describe("isLiveWidget", () => {
  it.each<[RangePreset, boolean]>([
    ["1h", true], ["6h", true], ["24h", true], ["7d", true], ["30d", true],
    ["today", true], ["this_month", true], ["yesterday", false], ["last_month", false],
  ])("stat showing the latest metric value over %s: live = %s", (preset, expected) => {
    expect(isLiveWidget("stat", last, preset)).toBe(expected);
  });
  it("is live for a gauge too", () => expect(isLiveWidget("gauge", last, "24h")).toBe(true));
  it.each<WidgetType>(["timeseries", "bar", "table"])("is never live for %s", (type) => {
    expect(isLiveWidget(type, last, "24h")).toBe(false);
  });
  it("needs source metric and aggregation last", () => {
    expect(isLiveWidget("stat", { source: "metric", aggregation: "avg" }, "24h")).toBe(false);
    expect(isLiveWidget("stat", { source: "energy", aggregation: "sum" }, "24h")).toBe(false);
  });
});

describe("liveOrFetched", () => {
  const entry = (value: number | null, quality = 0) => ({ ts: "2026-10-08T06:00:00.000Z", value, quality });
  it("keeps the fetched figure until the stream has an entry", () => expect(liveOrFetched(undefined, 10.5)).toBe(10.5));
  it("lets a stream entry win", () => expect(liveOrFetched(entry(11.25), 10.5)).toBe(11.25));
  it("lets a null stream value win too (the reading went bad), and treats bad quality as no value", () => {
    expect(liveOrFetched(entry(null), 10.5)).toBeNull();
    expect(liveOrFetched(entry(7, 1), 10.5)).toBeNull();
  });
});

describe("pointIdsOf", () => {
  it("collects the mapped points of a values response", () => {
    expect(pointIdsOf(undefined)).toEqual([]);
    const data = valuesData({ values: [
      { asset_id: 5, name: "A", value: 1, estimated: false, partial: false, point_id: 7 },
      { asset_id: 6, name: "B", value: 1, estimated: false, partial: false, point_id: null },
    ] });
    expect(pointIdsOf(data)).toEqual([7]);
  });
});
```

Create `frontend/src/lib/gridMetrics.test.ts`:
```ts
import { cellStyle, readingOrder } from "./gridMetrics";

describe("cellStyle", () => {
  it("places a widget on the 12-column grid (1-based lines)", () => {
    expect(cellStyle({ x: 0, y: 0, w: 4, h: 3 })).toEqual({ gridColumn: "1 / span 4", gridRow: "1 / span 3" });
    expect(cellStyle({ x: 3, y: 2, w: 6, h: 2 })).toEqual({ gridColumn: "4 / span 6", gridRow: "3 / span 2" });
  });
  it("never lets a widget spill past the last column", () => {
    expect(cellStyle({ x: 10, y: 0, w: 6, h: 1 })).toEqual({ gridColumn: "11 / span 2", gridRow: "1 / span 1" });
    expect(cellStyle({ x: 20, y: 0, w: 3, h: 1 })).toEqual({ gridColumn: "12 / span 1", gridRow: "1 / span 1" });
  });
});

describe("readingOrder", () => {
  it("sorts top to bottom, then left to right, without touching the input", () => {
    const items = [{ x: 6, y: 0, id: "b" }, { x: 0, y: 3, id: "c" }, { x: 0, y: 0, id: "a" }];
    expect(readingOrder(items).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(items.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });
});
```

- [ ] **Step 4: Run them, expect failure**

```bash
cd frontend && npm test -- src/lib/widgetFormat.test.ts src/lib/live.test.ts src/lib/gridMetrics.test.ts
```
Expected: FAIL for all three files with `Failed to resolve import "./widgetFormat"` (and `./live`, `./gridMetrics`).

- [ ] **Step 5: Implement the helpers**

Create `frontend/src/lib/widgetFormat.ts`:
```ts
export interface Flags { estimated: boolean; partial: boolean }

/** Two decimals, the precision the asset page shows. */
export const formatValue = (value: number | null | undefined): string => (value == null ? "—" : value.toFixed(2));

/** "12.30", with "~" in front when estimated and "*" behind when partial; a dash (no markers) when there is no figure. */
export function figureText(value: number | null | undefined, flags: Flags): string {
  if (value == null) return "—";
  return `${flags.estimated ? "~" : ""}${value.toFixed(2)}${flags.partial ? "*" : ""}`;
}

/** Explains the markers that appear in a figure; empty when there are none. */
export function markerHint(flags: Flags): string {
  const parts: string[] = [];
  if (flags.estimated) parts.push("~ estimated");
  if (flags.partial) parts.push("* partial, some hours have no rate");
  return parts.join(", ");
}

export const removedText = (count: number): string => `${count} asset${count === 1 ? "" : "s"} removed`;
export const unitSuffix = (unit: string | null): string => (unit ? ` ${unit}` : "");

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

interface Labelled { asset_id: number; name: string }

/** Names as shown; a name used by several assets gets "(#id)" so legends and axes stay unambiguous. */
export function uniqueLabels(rows: readonly Labelled[]): string[] {
  const count = new Map<string, number>();
  for (const row of rows) count.set(row.name, (count.get(row.name) ?? 0) + 1);
  return rows.map((row) => ((count.get(row.name) ?? 0) > 1 ? `${row.name} (#${row.asset_id})` : row.name));
}

/** `uniqueLabels` plus a trailing " ~" (estimated) and " *" (partial), for chart legends and axes. */
export function chartLabels(rows: readonly (Labelled & Flags)[]): string[] {
  return uniqueLabels(rows).map((label, i) => `${label}${rows[i].estimated ? " ~" : ""}${rows[i].partial ? " *" : ""}`);
}
```

Create `frontend/src/lib/live.ts`:
```ts
import type { RangePreset, WidgetConfig, WidgetData, WidgetType } from "../api/types";
import { isRolling } from "./ranges";
import type { LiveValue } from "./stream";

const LIVE_TYPES: ReadonlySet<WidgetType> = new Set<WidgetType>(["stat", "gauge"]);

/** A widget follows the stream when it shows the latest metric reading of a range that ends now (spec 10.5). */
export function isLiveWidget(type: WidgetType, config: Pick<WidgetConfig, "source" | "aggregation">, preset: RangePreset): boolean {
  return LIVE_TYPES.has(type) && config.source === "metric" && config.aggregation === "last"
    && (isRolling(preset) || preset === "today" || preset === "this_month");
}

/** The mapping points a values response can be updated from (energy and cost values have none). */
export function pointIdsOf(data: WidgetData | undefined): number[] {
  return (data?.values ?? []).flatMap((v) => (v.point_id === null ? [] : [v.point_id]));
}

/** A stream entry wins over the fetched figure, even a null one (the reading went bad); no entry yet means the fetched figure stands. */
export function liveOrFetched(live: LiveValue | undefined, fetched: number | null): number | null {
  if (!live) return fetched;
  return live.quality === 0 ? live.value : null;
}
```

Create `frontend/src/lib/gridMetrics.ts`:
```ts
import type { CSSProperties } from "react";
import { GRID_COLS } from "./layout";

/** Shared by the read-only CSS grid (Task 9) and the react-grid-layout editor (Task 10) so both lay widgets out identically. */
export const ROW_HEIGHT = 80;
export const GRID_GAP = 10;

export interface Cell { x: number; y: number; w: number; h: number }

/** CSS-grid placement of one widget (1-based lines); a widget never spills past the last column. */
export function cellStyle({ x, y, w, h }: Cell): CSSProperties {
  const column = Math.min(Math.max(x, 0), GRID_COLS - 1);
  const span = Math.max(1, Math.min(w, GRID_COLS - column));
  return { gridColumn: `${column + 1} / span ${span}`, gridRow: `${Math.max(y, 0) + 1} / span ${Math.max(h, 1)}` };
}

/** Row height and gap as inline style; `display: grid` and the 12 columns live in app.css (`.dash-grid`). */
export const gridStyle: CSSProperties = { gridAutoRows: `${ROW_HEIGHT}px`, gap: GRID_GAP };

/** Reading order (also the DOM and tab order): top to bottom, then left to right. */
export function readingOrder<T extends Cell>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x);
}
```

- [ ] **Step 6: Run, expect pass**

```bash
cd frontend && npm test -- src/lib/widgetFormat.test.ts src/lib/live.test.ts src/lib/gridMetrics.test.ts
```
Expected: all tests in the three files pass.

- [ ] **Step 7: `useDialogFocus` (shared by the create dialog here and by Task 10's dialogs), test first**

It repeats `ReviewDialog`'s focus handling (focus moves in, stays in, goes back; Escape closes unless busy) and adds a stack, so that when a second dialog opens on top (Task 10's "unsaved changes" over the widget editor) only the top-most one traps focus and takes Escape; two traps would otherwise fight over focus forever.

Create `frontend/src/hooks/useDialogFocus.test.tsx`:
```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { useDialogFocus } from "./useDialogFocus";

function Dialog({ label, onClose, busy = false }: { label: string; onClose: () => void; busy?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const preferred = useRef<HTMLInputElement>(null);
  useDialogFocus(root, onClose, { busy, initial: preferred });
  return (
    <div ref={root} role="dialog" aria-label={label}>
      <button>{label} first</button>
      <input aria-label={`${label} preferred`} ref={preferred} />
    </div>
  );
}

describe("useDialogFocus", () => {
  it("moves focus to the preferred control and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<Dialog label="a" onClose={onClose} />);
    expect(screen.getByLabelText("a preferred")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while busy", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<Dialog label="a" onClose={onClose} busy />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Dialog label="a" onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pulls focus back inside when it escapes, and gives it back to the opener when the dialog goes away", () => {
    const opener = document.createElement("button");
    const outside = document.createElement("button");
    document.body.append(opener, outside);
    try {
      opener.focus();
      render(<Dialog label="a" onClose={vi.fn()} />);
      outside.focus();
      expect(screen.getByRole("button", { name: "a first" })).toHaveFocus();
      cleanup();
      expect(opener).toHaveFocus();
    } finally {
      opener.remove();
      outside.remove();
    }
  });

  it("lets only the top-most of two open dialogs trap focus and take Escape", async () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      const { rerender } = render(<><Dialog label="a" onClose={closeA} /><Dialog label="b" onClose={closeB} /></>);
      expect(screen.getByLabelText("b preferred")).toHaveFocus();
      outside.focus();
      expect(screen.getByRole("dialog", { name: "b" })).toContainElement(document.activeElement as HTMLElement);
      await userEvent.keyboard("{Escape}");
      expect(closeB).toHaveBeenCalledTimes(1);
      expect(closeA).not.toHaveBeenCalled();
      rerender(<><Dialog label="a" onClose={closeA} /></>);
      await userEvent.keyboard("{Escape}");
      expect(closeA).toHaveBeenCalledTimes(1);
    } finally {
      outside.remove();
    }
  });
});
```
Run: `cd frontend && npm test -- src/hooks/useDialogFocus.test.tsx`. Expected: FAIL (`Failed to resolve import "./useDialogFocus"`).

Create `frontend/src/hooks/useDialogFocus.ts`:
```ts
import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Dialogs currently open, last = top-most. Only the top-most one traps focus and answers Escape. */
const open: HTMLElement[] = [];

/**
 * Accessibility behaviour shared by the dashboard dialogs (it mirrors `ReviewDialog`): focus moves into the dialog
 * (to `options.initial` if given, else the first control), stays inside while it is the top-most dialog, and goes back
 * to what had it when the dialog goes away. Escape calls `onClose`, except while `options.busy`.
 */
export function useDialogFocus(
  root: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { busy?: boolean; initial?: RefObject<HTMLElement | null> } = {},
): void {
  const { busy = false, initial } = options;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = () => element.querySelector<HTMLElement>(FOCUSABLE);
    open.push(element);
    (initial?.current ?? first())?.focus();
    const keepFocus = (event: FocusEvent) => {
      if (open[open.length - 1] !== element) return;
      if (event.target instanceof Node && !element.contains(event.target)) first()?.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      open.splice(open.indexOf(element), 1);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const element = root.current;
      if (element && open[open.length - 1] === element) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
}
```
Run again: expect the four tests to pass.

- [ ] **Step 8: The live-values context** (exercised by the widget and page tests below)

Create `frontend/src/components/dashboard/LiveValuesContext.tsx`:
```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useStream } from "../../hooks/useStream";
import type { LiveValue } from "../../lib/stream";

interface LiveContextValue {
  values: ReadonlyMap<number, LiveValue>;
  connected: boolean;
  /** Replace the points `owner` wants from the stream; an empty list withdraws the owner. */
  register: (owner: string, pointIds: readonly number[]) => void;
}

const NONE: ReadonlyMap<number, LiveValue> = new Map();
/** Without a provider (a widget rendered on its own) nothing is live and registering does nothing. */
export const LiveValuesContext = createContext<LiveContextValue>({ values: NONE, connected: false, register: () => {} });

/** One `useStream` for the whole dashboard: the union of what the live widgets registered. */
export function LiveValuesProvider({ children }: { children: ReactNode }) {
  const [owners, setOwners] = useState<ReadonlyMap<string, readonly number[]>>(() => new Map());
  const register = useCallback((owner: string, pointIds: readonly number[]) => {
    setOwners((current) => {
      const before = current.get(owner) ?? [];
      if (before.length === pointIds.length && before.every((id, i) => id === pointIds[i])) return current;
      const next = new Map(current);
      if (pointIds.length === 0) next.delete(owner);
      else next.set(owner, pointIds);
      return next;
    });
  }, []);
  const wanted = useMemo(() => new Set([...owners.values()].flat()), [owners]);
  const { values, connected } = useStream(wanted);
  const value = useMemo(() => ({ values, connected, register }), [values, connected, register]);
  return <LiveValuesContext.Provider value={value}>{children}</LiveValuesContext.Provider>;
}

/** Ask the dashboard's stream for these points while the caller is mounted. */
export function useLiveRegistration(owner: string, pointIds: readonly number[]): void {
  const { register } = useContext(LiveValuesContext);
  const key = pointIds.join(",");
  useEffect(() => {
    register(owner, key === "" ? [] : key.split(",").map(Number));
    return () => register(owner, []);
  }, [owner, key, register]);
}

/** The latest stream entry for a point; undefined when there is none yet (or no point). */
export function useLiveValue(pointId: number | null): LiveValue | undefined {
  const { values } = useContext(LiveValuesContext);
  return pointId === null ? undefined : values.get(pointId);
}
```

- [ ] **Step 9: `WidgetFrame`, test first**

Create `frontend/src/components/dashboard/WidgetFrame.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { downloadCsv } from "../../lib/download";
import { config } from "../../test/dashboardFixtures";
import { WidgetFrame } from "./WidgetFrame";

vi.mock("../../lib/download", () => ({ downloadCsv: vi.fn() }));

const csv = { type: "stat" as const, config: config({ aggregation: "last" }), range: "7d" as const };
const frame = (props: Partial<React.ComponentProps<typeof WidgetFrame>> = {}) =>
  render(<WidgetFrame title="Hall power" loading={false} error={null} missing={0} {...props}><p>body</p></WidgetFrame>);

beforeEach(() => {
  vi.mocked(downloadCsv).mockReset();
  vi.mocked(downloadCsv).mockResolvedValue(undefined);
});

describe("WidgetFrame", () => {
  it("shows the title and the body", () => {
    frame();
    expect(screen.getByRole("region", { name: "Hall power" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hall power" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.queryByText(/removed/)).not.toBeInTheDocument();
  });

  it("shows a loading note instead of the body while loading", () => {
    frame({ loading: true });
    expect(screen.getByText("loading…")).toBeInTheDocument();
    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });

  it("shows an error as an alert", () => {
    frame({ error: new Error("query failed") });
    expect(screen.getByRole("alert")).toHaveTextContent("query failed");
  });

  it("warns when assets were removed, and still shows the body (Review Focus 5, UI side)", () => {
    const { unmount } = frame({ missing: 1 });
    expect(screen.getByText("1 asset removed")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    unmount();
    frame({ missing: 3 });
    expect(screen.getByText("3 assets removed")).toBeInTheDocument();
  });

  it("downloads the widget's CSV with the exact request body", async () => {
    frame({ csv });
    await userEvent.click(screen.getByRole("button", { name: "Download CSV for Hall power" }));
    expect(downloadCsv).toHaveBeenCalledWith("/api/widget-data/csv", { method: "POST", body: { type: "stat", config: csv.config, range: "7d" } });
  });

  it("reports a failed export without hiding the widget", async () => {
    vi.mocked(downloadCsv).mockRejectedValue(new Error("server said no"));
    frame({ csv });
    await userEvent.click(screen.getByRole("button", { name: "Download CSV for Hall power" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("CSV export failed: server said no");
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("offers no CSV button without a csv source, shows extra actions, and can mark the header as the drag handle", () => {
    frame({ actions: <button>Edit</button>, dragHandle: true });
    expect(screen.queryByRole("button", { name: /CSV/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hall power" }).parentElement).toHaveClass("widget-drag-handle");
  });
});
```
Run: `cd frontend && npm test -- src/components/dashboard/WidgetFrame.test.tsx`. Expected: FAIL (`Failed to resolve import "./WidgetFrame"`).

Create `frontend/src/components/dashboard/WidgetFrame.tsx`:
```tsx
import { useState, type ReactNode } from "react";
import type { RangePreset, WidgetConfig, WidgetType } from "../../api/types";
import { downloadCsv } from "../../lib/download";
import { removedText } from "../../lib/widgetFormat";

export interface CsvSource { type: WidgetType; config: WidgetConfig; range: RangePreset }

interface Props {
  title: string;
  loading: boolean;
  error: Error | null;
  /** How many configured assets no longer exist (`missing.length` of the response). */
  missing: number;
  /** Present = show the CSV button; this is the query the export repeats. */
  csv?: CsvSource;
  /** Extra header buttons (the editor's Edit and Delete). */
  actions?: ReactNode;
  /** Mark the header as the grab area of the editor's grid. */
  dragHandle?: boolean;
  children?: ReactNode;
}

/** The box around every widget: title, CSV button, the "assets removed" warning, and the loading and error states. */
export function WidgetFrame({ title, loading, error, missing, csv, actions, dragHandle = false, children }: Props) {
  const [busy, setBusy] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const exportCsv = async () => {
    if (!csv) return;
    setBusy(true);
    setCsvError(null);
    try {
      await downloadCsv("/api/widget-data/csv", { method: "POST", body: { type: csv.type, config: csv.config, range: csv.range } });
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="widget-frame" aria-label={title}>
      <header className={dragHandle ? "widget-head widget-drag-handle" : "widget-head"}>
        <h3>{title}</h3>
        {missing > 0 && <span className="chip chip-warn" title="Assets this widget used were deleted; it shows the rest.">{removedText(missing)}</span>}
        <span className="spacer" />
        {csv && <button type="button" onClick={exportCsv} disabled={busy} aria-label={`Download CSV for ${title}`}>CSV</button>}
        {actions}
      </header>
      {csvError && <p className="error" role="alert">CSV export failed: {csvError}</p>}
      <div className="widget-body">
        {error && <p className="error" role="alert">{error.message}</p>}
        {loading ? <p className="muted">loading…</p> : children}
      </div>
    </section>
  );
}
```
Run again: expect pass.

- [ ] **Step 10: The five widgets, tests first**

Create `frontend/src/components/dashboard/widgets/widgets.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { formatSiteTick } from "../../../lib/siteTime";
import { seriesData, valuesData, config } from "../../../test/dashboardFixtures";
import { LiveValuesContext } from "../LiveValuesContext";
import { BarWidget, barOption } from "./BarWidget";
import { GaugeWidget, gaugeOption } from "./GaugeWidget";
import { StatWidget } from "./StatWidget";
import { TableWidget } from "./TableWidget";
import { bucketMs, timeSeriesOption, tooltipFormatter, TimeSeriesWidget, withGaps } from "./TimeSeriesWidget";

vi.mock("echarts-for-react", () => ({
  default: (props: { option: { series?: { type?: string }[] } }) => (
    <pre data-testid="chart" data-kind={props.option.series?.[0]?.type}>{JSON.stringify(props.option)}</pre>
  ),
}));

type Row = [string, number | null];
interface Opt {
  series: { id?: string; name: string; type: string; data: Row[]; connectNulls?: boolean }[];
  xAxis: { axisLabel?: { formatter: (value: number) => string }; data?: string[] };
  tooltip: { formatter: (params: unknown) => string };
}
const asOption = (option: unknown) => option as Opt;
const TZ = "Asia/Qatar";
const stream = (value: number | null, quality = 0) => ({
  values: new Map([[7, { ts: "2026-10-08T06:00:00.000Z", value, quality }]]), connected: true, register: () => {},
});

describe("time series", () => {
  const points = [
    { ts: "2026-10-08T00:00:00+00:00", value: 1, min: 0.5, max: 1.5 },
    { ts: "2026-10-08T00:01:00+00:00", value: 2, min: 1, max: 3 },
    { ts: "2026-10-08T00:02:00+00:00", value: 3, min: 2, max: 4 },
    { ts: "2026-10-08T00:10:00+00:00", value: 4, min: 3, max: 5 },
  ];
  const data = seriesData({ series: [{ asset_id: 5, name: "LV Panel 1", points, estimated: false, partial: false }] });

  it("estimates the bucket width from the data, or from the bucket size", () => {
    expect(bucketMs(null, points)).toBe(60_000);
    expect(bucketMs("hour", points)).toBe(3_600_000);
    expect(bucketMs("day", points)).toBe(86_400_000);
    expect(bucketMs(null, points.slice(0, 1))).toBeNull();
  });

  it("breaks the line where buckets are missing and where the value is null", () => {
    const rows = withGaps([...points.slice(0, 2), { ts: "2026-10-08T00:02:00+00:00", value: null, min: null, max: null }, points[3]], 60_000, (p) => p.value);
    expect(rows.map(([, v]) => v)).toEqual([1, 2, null, null, 4]);
    expect(rows[3][0]).toBe("2026-10-08T00:03:00.000Z");
  });

  it("draws an average line per asset with a min/max band, gaps as gaps", () => {
    const option = asOption(timeSeriesOption(data, TZ));
    expect(option.series.map((s) => s.id)).toEqual(["band-min-5", "band-span-5", "avg-5"]);
    const avg = option.series.find((s) => s.id === "avg-5")!;
    expect(avg.name).toBe("LV Panel 1");
    expect(avg.connectNulls).toBe(false);
    expect(avg.data.map(([, v]) => v)).toEqual([1, 2, 3, null, 4]);
    expect(avg.data[3][0]).toBe("2026-10-08T00:03:00.000Z");
    expect(option.series.find((s) => s.id === "band-min-5")!.data.map(([, v]) => v)).toEqual([0.5, 1, 2, null, 3]);
    expect(option.series.find((s) => s.id === "band-span-5")!.data.map(([, v]) => v)).toEqual([1, 2, 2, null, 2]);
  });

  it("draws energy as plain hourly lines (no band) and breaks the line over a missing hour", () => {
    const hourly = seriesData({
      source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
      series: [{ asset_id: 5, name: "LV Panel 1", estimated: true, partial: false, points: [
        { ts: "2026-10-08T00:00:00+00:00", value: 1, min: null, max: null },
        { ts: "2026-10-08T01:00:00+00:00", value: 2, min: null, max: null },
        { ts: "2026-10-08T04:00:00+00:00", value: 3, min: null, max: null },
      ] }],
    });
    const option = asOption(timeSeriesOption(hourly, TZ));
    expect(option.series.map((s) => s.id)).toEqual(["avg-5"]);
    expect(option.series[0].name).toBe("LV Panel 1 ~");
    expect(option.series[0].data.map(([, v]) => v)).toEqual([1, 2, null, 3]);
    expect(option.series[0].data[2][0]).toBe("2026-10-08T02:00:00.000Z");
  });

  it("tells apart two assets with the same name", () => {
    const twin = (id: number) => ({ asset_id: id, name: "Panel", estimated: false, partial: false, points: points.slice(0, 2) });
    const option = asOption(timeSeriesOption(seriesData({ series: [twin(1), twin(2)] }), TZ));
    expect(option.series.filter((s) => s.id?.startsWith("avg-")).map((s) => s.name)).toEqual(["Panel (#1)", "Panel (#2)"]);
  });

  it("formats axis labels in the site zone", () => {
    const option = asOption(timeSeriesOption(data, TZ));
    const ms = Date.parse("2026-10-08T00:01:00Z");
    expect(option.xAxis.axisLabel!.formatter(ms)).toBe(formatSiteTick(new Date(ms).toISOString(), TZ, null));
  });

  it("builds a tooltip that hides the band helpers, shows min/max, and escapes names", () => {
    const html = tooltipFormatter(data, TZ)([
      { seriesId: "band-min-5", seriesName: "LV Panel 1 min", value: ["2026-10-08T00:01:00+00:00", 1], marker: "<i>m</i>" },
      { seriesId: "avg-5", seriesName: "<b>LV</b> Panel 1", value: ["2026-10-08T00:01:00+00:00", 2], marker: "<i>m</i>" },
    ]);
    expect(html).toContain("&lt;b&gt;LV&lt;/b&gt; Panel 1");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("LV Panel 1 min");
    expect(html).toContain("2.00 kW");
    expect(html).toContain("(min 1.00, max 3.00)");
    expect(html).toContain(formatSiteTick("2026-10-08T00:01:00.000Z", TZ, null));
    expect(tooltipFormatter(data, TZ)([])).toBe("");
  });

  it("renders a chart, or says there is nothing to draw", () => {
    const { unmount } = render(<TimeSeriesWidget data={data} timezone={TZ} />);
    expect(screen.getByTestId("chart")).toHaveAttribute("data-kind", "line");
    unmount();
    render(<TimeSeriesWidget data={seriesData({ series: [{ asset_id: 5, name: "A", points: [], estimated: false, partial: false }] })} timezone={TZ} />);
    expect(screen.getByText("No data in this range.")).toBeInTheDocument();
  });
});

describe("bar", () => {
  it("draws one bar per asset, marking estimated and partial ones, with nothing for a missing figure", () => {
    const data = valuesData({ type: "bar", source: "energy", metric: null, unit: "kWh", values: [
      { asset_id: 5, name: "LV Panel 1", value: 10, estimated: false, partial: false, point_id: null },
      { asset_id: 6, name: "LV Panel 2", value: null, estimated: true, partial: false, point_id: null },
    ] });
    const option = asOption(barOption(data, TZ));
    expect(option.xAxis.data).toEqual(["LV Panel 1", "LV Panel 2 ~"]);
    expect(option.series).toHaveLength(1);
    expect(option.series[0].type).toBe("bar");
    expect(option.series[0].data).toEqual([10, null]);
  });

  it("draws one bar per time bucket, grouped by asset", () => {
    const point = (ts: string, value: number) => ({ ts, value, min: null, max: null });
    const data = seriesData({
      type: "bar", source: "energy", metric: null, unit: "kWh", bucket: "hour", tier: null,
      series: [
        { asset_id: 5, name: "A", estimated: false, partial: false, points: [point("2026-10-08T00:00:00+00:00", 1), point("2026-10-08T01:00:00+00:00", 2)] },
        { asset_id: 6, name: "B", estimated: false, partial: false, points: [point("2026-10-08T01:00:00+00:00", 5), point("2026-10-08T02:00:00+00:00", 6)] },
      ],
    });
    const option = asOption(barOption(data, TZ));
    expect(option.xAxis.data).toEqual(["2026-10-08T00:00:00+00:00", "2026-10-08T01:00:00+00:00", "2026-10-08T02:00:00+00:00"].map((ts) => formatSiteTick(ts, TZ, "hour")));
    expect(option.series.map((s) => s.name)).toEqual(["A", "B"]);
    expect(option.series[0].data).toEqual([1, 2, null]);
    expect(option.series[1].data).toEqual([null, 5, 6]);
  });

  it("renders a bar chart", () => {
    render(<BarWidget data={valuesData({ type: "bar" })} timezone={TZ} />);
    expect(screen.getByTestId("chart")).toHaveAttribute("data-kind", "bar");
  });
});

describe("gauge", () => {
  it("uses the configured range, the unit, and a dash for no figure", () => {
    type GaugeOpt = { series: { type: string; min: number; max: number; data: { value: number }[]; detail: { formatter: () => string } }[] };
    const option = gaugeOption({ value: 12.5, min: 0, max: 100, unit: "kW", name: "LV Panel 1" }) as unknown as GaugeOpt;
    expect(option.series[0]).toMatchObject({ type: "gauge", min: 0, max: 100, data: [{ value: 12.5 }] });
    expect(option.series[0].detail.formatter()).toBe("12.50 kW");
    const empty = gaugeOption({ value: null, min: 10, max: 20, unit: "kW", name: "x" }) as unknown as GaugeOpt;
    expect(empty.series[0].data[0].value).toBe(10);
    expect(empty.series[0].detail.formatter()).toBe("—");
  });

  it("renders the fetched value, a live value for a live gauge, and ignores the stream when not live", () => {
    const cfg = config({ aggregation: "last", min: 0, max: 200 });
    const data = valuesData({ type: "gauge" });
    const { unmount } = render(<GaugeWidget data={data} config={cfg} live={false} />);
    expect(screen.getByTestId("chart").textContent).toContain('"value":10.5');
    unmount();
    render(<LiveValuesContext.Provider value={stream(33.5)}><GaugeWidget data={data} config={cfg} live /></LiveValuesContext.Provider>);
    expect(screen.getByTestId("chart").textContent).toContain('"value":33.5');
    expect(screen.getByTestId("chart").textContent).toContain('"max":200');
  });
});

describe("stat", () => {
  it("shows the figure, its unit and the asset", () => {
    render(<StatWidget data={valuesData()} live={false} />);
    expect(screen.getByText("10.50")).toBeInTheDocument();
    expect(screen.getByText("kW")).toBeInTheDocument();
    expect(screen.getByText("LV Panel 1")).toBeInTheDocument();
  });

  it("marks estimated (~) and partial (*) figures and says what the markers mean", () => {
    const row = { asset_id: 5, name: "LV Panel 1", value: 12.3, estimated: true, partial: true, point_id: null };
    render(<StatWidget data={valuesData({ source: "cost", unit: "QAR", values: [row] })} live={false} />);
    expect(screen.getByText("~12.30*")).toBeInTheDocument();
    expect(screen.getByText("QAR")).toBeInTheDocument();
    expect(screen.getByText("~ estimated, * partial, some hours have no rate")).toBeInTheDocument();
  });

  it("shows a dash when there is no figure or no asset", () => {
    const row = { asset_id: 5, name: "LV Panel 1", value: null, estimated: true, partial: false, point_id: null };
    const { unmount } = render(<StatWidget data={valuesData({ values: [row] })} live={false} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    unmount();
    render(<StatWidget data={valuesData({ values: [] })} live={false} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("follows the stream only when live", () => {
    const { unmount } = render(<LiveValuesContext.Provider value={stream(11.25)}><StatWidget data={valuesData()} live /></LiveValuesContext.Provider>);
    expect(screen.getByText("11.25")).toBeInTheDocument();
    unmount();
    render(<LiveValuesContext.Provider value={stream(11.25)}><StatWidget data={valuesData()} live={false} /></LiveValuesContext.Provider>);
    expect(screen.getByText("10.50")).toBeInTheDocument();
  });

  it("shows a dash when the live reading is bad", () => {
    render(<LiveValuesContext.Provider value={stream(7, 1)}><StatWidget data={valuesData()} live /></LiveValuesContext.Provider>);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("table", () => {
  it("lists one row per asset with markers and dashes", () => {
    const data = valuesData({ type: "table", unit: "kWh", source: "energy", metric: null, values: [
      { asset_id: 5, name: "LV Panel 1", value: 10.5, estimated: false, partial: false, point_id: null },
      { asset_id: 6, name: "LV Panel 2", value: 4.25, estimated: true, partial: false, point_id: null },
      { asset_id: 7, name: "LV Panel 3", value: null, estimated: false, partial: false, point_id: null },
    ] });
    render(<TableWidget data={data} />);
    expect(screen.getByRole("columnheader", { name: "Value (kWh)" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /LV Panel 1/ })).toHaveTextContent("10.50");
    expect(screen.getByRole("row", { name: /LV Panel 2/ })).toHaveTextContent("~4.25");
    expect(screen.getByRole("row", { name: /LV Panel 3/ })).toHaveTextContent("—");
    expect(screen.getByText("~ estimated")).toBeInTheDocument();
  });

  it("says so when there are no assets", () => {
    render(<TableWidget data={valuesData({ type: "table", values: [] })} />);
    expect(screen.getByText("No assets.")).toBeInTheDocument();
  });
});
```
Run: `cd frontend && npm test -- src/components/dashboard/widgets/widgets.test.tsx`. Expected: FAIL (`Failed to resolve import "./BarWidget"`).

Create `frontend/src/components/dashboard/widgets/StatWidget.tsx`:
```tsx
import type { WidgetData } from "../../../api/types";
import { liveOrFetched } from "../../../lib/live";
import { figureText, markerHint, unitSuffix } from "../../../lib/widgetFormat";
import { useLiveValue } from "../LiveValuesContext";

/** One big figure for one asset. `live` (see isLiveWidget) lets the dashboard's stream override the fetched figure. */
export function StatWidget({ data, live }: { data: WidgetData; live: boolean }) {
  const row = data.values[0];
  const stream = useLiveValue(live && row ? row.point_id : null);
  if (!row) return <div className="stat"><div className="big">—</div></div>;
  const value = liveOrFetched(stream, row.value);
  const hint = markerHint(row);
  return (
    <div className="stat">
      <div className="big">{figureText(value, row)}<small>{unitSuffix(data.unit)}</small></div>
      <div className="muted">{row.name}</div>
      {hint && <div className="muted"><small>{hint}</small></div>}
    </div>
  );
}
```

Create `frontend/src/components/dashboard/widgets/TableWidget.tsx`:
```tsx
import type { WidgetData } from "../../../api/types";
import { figureText, markerHint, uniqueLabels } from "../../../lib/widgetFormat";

/** One row per asset with the aggregation over the range. */
export function TableWidget({ data }: { data: WidgetData }) {
  if (data.values.length === 0) return <p className="muted">No assets.</p>;
  const labels = uniqueLabels(data.values);
  const hint = markerHint({ estimated: data.values.some((v) => v.estimated), partial: data.values.some((v) => v.partial) });
  return (
    <>
      <table>
        <thead><tr><th>Asset</th><th>{data.unit ? `Value (${data.unit})` : "Value"}</th></tr></thead>
        <tbody>
          {data.values.map((row, i) => (
            <tr key={row.asset_id}><td>{labels[i]}</td><td>{figureText(row.value, row)}</td></tr>
          ))}
        </tbody>
      </table>
      {hint && <p className="muted"><small>{hint}</small></p>}
    </>
  );
}
```

Create `frontend/src/components/dashboard/widgets/GaugeWidget.tsx`:
```tsx
import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import type { WidgetConfig, WidgetData } from "../../../api/types";
import { liveOrFetched } from "../../../lib/live";
import { unitSuffix } from "../../../lib/widgetFormat";
import { useLiveValue } from "../LiveValuesContext";

export function gaugeOption(args: { value: number | null; min: number; max: number; unit: string | null; name: string }): EChartsOption {
  const { value, min, max, unit, name } = args;
  return {
    animation: false,
    series: [{
      type: "gauge", min, max,
      progress: { show: true },
      axisLine: { lineStyle: { width: 10 } },
      detail: { valueAnimation: false, fontSize: 22, offsetCenter: [0, "70%"], formatter: () => (value === null ? "—" : `${value.toFixed(2)}${unitSuffix(unit)}`) },
      data: [{ value: value ?? min, name }],
    }],
  };
}

/** A gauge for one asset; `min`/`max` come from the widget config and `live` lets the stream move the needle. */
export function GaugeWidget({ data, config, live }: { data: WidgetData; config: WidgetConfig; live: boolean }) {
  const row = data.values[0];
  const stream = useLiveValue(live && row ? row.point_id : null);
  const value = row ? liveOrFetched(stream, row.value) : null;
  const max = config.max ?? config.min + 100;
  return <ReactECharts option={gaugeOption({ value, min: config.min, max, unit: data.unit, name: row?.name ?? "" })} style={{ height: "100%", width: "100%", minHeight: 140 }} notMerge />;
}
```

Create `frontend/src/components/dashboard/widgets/BarWidget.tsx`:
```tsx
import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import type { WidgetData } from "../../../api/types";
import { formatSiteTick } from "../../../lib/siteTime";
import { chartLabels } from "../../../lib/widgetFormat";

export function barOption(data: WidgetData, timezone: string): EChartsOption {
  if (data.mode === "values") {
    return {
      animation: false,
      tooltip: { trigger: "axis" },
      grid: { left: 60, right: 20, top: 30, bottom: 40 },
      xAxis: { type: "category", data: chartLabels(data.values) },
      yAxis: { type: "value", name: data.unit ?? undefined },
      series: [{ type: "bar", data: data.values.map((v) => v.value) }],
    };
  }
  // One category per bucket (the union over all assets), one bar series per asset: ECharts groups them side by side.
  const stamps = new Map<number, string>();
  for (const s of data.series) for (const p of s.points) stamps.set(Date.parse(p.ts), p.ts);
  const times = [...stamps.keys()].sort((a, b) => a - b);
  const labels = chartLabels(data.series);
  return {
    animation: false,
    tooltip: { trigger: "axis" },
    legend: { show: data.series.length > 1, bottom: 0, type: "scroll" },
    grid: { left: 60, right: 20, top: 30, bottom: data.series.length > 1 ? 50 : 30 },
    xAxis: { type: "category", data: times.map((t) => formatSiteTick(stamps.get(t)!, timezone, data.bucket)) },
    yAxis: { type: "value", name: data.unit ?? undefined },
    series: data.series.map((s, i) => {
      const values = new Map(s.points.map((p) => [Date.parse(p.ts), p.value]));
      return { name: labels[i], type: "bar" as const, data: times.map((t) => values.get(t) ?? null) };
    }),
  };
}

/** Bars per asset (the aggregation over the range) or per time bucket, grouped by asset. */
export function BarWidget({ data, timezone }: { data: WidgetData; timezone: string }) {
  const empty = data.mode === "values" ? data.values.length === 0 : data.series.every((s) => s.points.length === 0);
  if (empty) return <p className="muted">No data in this range.</p>;
  return <ReactECharts option={barOption(data, timezone)} style={{ height: "100%", width: "100%", minHeight: 140 }} notMerge />;
}
```

Create `frontend/src/components/dashboard/widgets/TimeSeriesWidget.tsx`:
```tsx
import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import type { WidgetData } from "../../../api/types";
import { formatSiteTick } from "../../../lib/siteTime";
import { chartLabels, escapeHtml, formatValue, unitSuffix } from "../../../lib/widgetFormat";

type Point = WidgetData["series"][number]["points"][number];
type Row = [string, number | null];

const PALETTE = ["#1f6feb", "#cf222e", "#1a7f37", "#9a6700", "#8250df", "#bf3989", "#0a7d8c", "#57606a"];

/** Typical spacing between buckets: fixed for hour and day buckets, else the smallest step in the series (null with fewer than two points). */
export function bucketMs(bucket: WidgetData["bucket"], points: readonly Point[]): number | null {
  if (bucket === "hour") return 3_600_000;
  if (bucket === "day") return 86_400_000;
  let smallest: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const step = Date.parse(points[i].ts) - Date.parse(points[i - 1].ts);
    if (step > 0 && (smallest === null || step < smallest)) smallest = step;
  }
  return smallest;
}

/**
 * Chart rows with a `[ts, null]` row wherever two consecutive points are more than 1.5 buckets apart, so the line
 * breaks instead of bridging an outage (the same idea as TrendChart.withGaps). A null value is a gap too.
 */
export function withGaps(points: readonly Point[], width: number | null, pick: (p: Point) => number | null): Row[] {
  const rows: Row[] = [];
  let previous: number | null = null;
  for (const p of points) {
    const t = Date.parse(p.ts);
    if (previous !== null && width !== null && t - previous > width * 1.5) rows.push([new Date(previous + width).toISOString(), null]);
    rows.push([p.ts, pick(p)]);
    previous = t;
  }
  return rows;
}

interface TipItem { seriesId?: string; seriesName?: string; value?: unknown; marker?: string }

/** Axis tooltip: one line per asset (average with its min and max), without the helper series that draw the band. Names are user-typed, so they are escaped. */
export function tooltipFormatter(data: WidgetData, timezone: string) {
  const points = new Map<string, Map<number, Point>>();
  for (const s of data.series) points.set(`avg-${s.asset_id}`, new Map(s.points.map((p) => [Date.parse(p.ts), p])));
  const stamp = (item: TipItem) => (Array.isArray(item.value) ? Date.parse(String(item.value[0])) : NaN);
  return (params: unknown): string => {
    const lines = ((Array.isArray(params) ? params : [params]) as TipItem[]).filter((item) => String(item.seriesId ?? "").startsWith("avg-"));
    if (lines.length === 0) return "";
    const first = stamp(lines[0]);
    const head = Number.isNaN(first) ? "" : `${escapeHtml(formatSiteTick(new Date(first).toISOString(), timezone, data.bucket))}<br/>`;
    return head + lines.map((item) => {
      const value = Array.isArray(item.value) ? (item.value[1] as number | null) : null;
      const point = points.get(String(item.seriesId))?.get(stamp(item));
      const spread = point && point.min !== null && point.max !== null ? ` (min ${formatValue(point.min)}, max ${formatValue(point.max)})` : "";
      return `${item.marker ?? ""} ${escapeHtml(String(item.seriesName ?? ""))}: ${formatValue(value)}${escapeHtml(unitSuffix(data.unit))}${spread}`;
    }).join("<br/>");
  };
}

export function timeSeriesOption(data: WidgetData, timezone: string): EChartsOption {
  const labels = chartLabels(data.series);
  const band = data.source === "metric";
  const series = data.series.flatMap((s, i): object[] => {
    const color = PALETTE[i % PALETTE.length];
    const width = bucketMs(data.bucket, s.points);
    const line = { id: `avg-${s.asset_id}`, name: labels[i], type: "line" as const, color, symbol: "none", connectNulls: false, data: withGaps(s.points, width, (p) => p.value) };
    if (!band) return [line];
    // The band is two stacked invisible-line series: min, then max - min with a filled area.
    const hidden = { type: "line" as const, symbol: "none", lineStyle: { opacity: 0 }, stack: `band-${s.asset_id}`, connectNulls: false };
    return [
      { ...hidden, id: `band-min-${s.asset_id}`, name: `${labels[i]} min`, data: withGaps(s.points, width, (p) => p.min) },
      { ...hidden, id: `band-span-${s.asset_id}`, name: `${labels[i]} range`, areaStyle: { color, opacity: 0.12 }, data: withGaps(s.points, width, (p) => (p.min === null || p.max === null ? null : p.max - p.min)) },
      line,
    ];
  });
  return {
    animation: false,
    tooltip: { trigger: "axis", formatter: tooltipFormatter(data, timezone) },
    legend: { show: data.series.length > 1, bottom: 0, type: "scroll", data: labels },
    grid: { left: 60, right: 20, top: 30, bottom: data.series.length > 1 ? 50 : 30 },
    xAxis: { type: "time", axisLabel: { formatter: (value: number | string) => formatSiteTick(new Date(Number(value)).toISOString(), timezone, data.bucket) } },
    yAxis: { type: "value", name: data.unit ?? undefined, scale: band },
    series,
  } as EChartsOption;
}

/** One line per asset (average, with a min-max band for metrics); gaps are drawn as gaps. */
export function TimeSeriesWidget({ data, timezone }: { data: WidgetData; timezone: string }) {
  if (data.series.every((s) => s.points.length === 0)) return <p className="muted">No data in this range.</p>;
  return <ReactECharts option={timeSeriesOption(data, timezone)} style={{ height: "100%", width: "100%", minHeight: 140 }} notMerge />;
}
```
Run `cd frontend && npm test -- src/components/dashboard/widgets/widgets.test.tsx`. Expected: all pass. If `npm run typecheck` complains about the ECharts option types in `barOption` or `gaugeOption`, fix by adding `as EChartsOption` to that return expression (as `timeSeriesOption` does); do not change the tested values.

- [ ] **Step 11: `WidgetBody`, `WidgetView`, `StaticGrid`, `DashboardViewer`** (covered by the page test in Step 12)

Create `frontend/src/components/dashboard/WidgetBody.tsx`:
```tsx
import { lazy, Suspense } from "react";
import type { WidgetConfig, WidgetData, WidgetType } from "../../api/types";
import { StatWidget } from "./widgets/StatWidget";
import { TableWidget } from "./widgets/TableWidget";

// The chart widgets pull in ECharts: they load only when a dashboard actually shows one.
const TimeSeriesWidget = lazy(() => import("./widgets/TimeSeriesWidget").then((m) => ({ default: m.TimeSeriesWidget })));
const BarWidget = lazy(() => import("./widgets/BarWidget").then((m) => ({ default: m.BarWidget })));
const GaugeWidget = lazy(() => import("./widgets/GaugeWidget").then((m) => ({ default: m.GaugeWidget })));

interface Props { type: WidgetType; data: WidgetData; config: WidgetConfig; timezone: string; live: boolean }

export function WidgetBody({ type, data, config, timezone, live }: Props) {
  if (type === "stat") return <StatWidget data={data} live={live} />;
  if (type === "table") return <TableWidget data={data} />;
  return (
    <Suspense fallback={<p className="muted">loading chart…</p>}>
      {type === "timeseries" && <TimeSeriesWidget data={data} timezone={timezone} />}
      {type === "bar" && <BarWidget data={data} timezone={timezone} />}
      {type === "gauge" && <GaugeWidget data={data} config={config} live={live} />}
    </Suspense>
  );
}
```

Create `frontend/src/components/dashboard/WidgetView.tsx`:
```tsx
import type { ReactNode } from "react";
import { useWidgetData } from "../../api/queries";
import type { RangePreset, WidgetConfig, WidgetType } from "../../api/types";
import { isLiveWidget, pointIdsOf } from "../../lib/live";
import { useLiveRegistration } from "./LiveValuesContext";
import { WidgetBody } from "./WidgetBody";
import { WidgetFrame } from "./WidgetFrame";

export interface WidgetViewProps {
  /** Unique within the page; names this widget in the live registry. */
  widgetKey: string;
  type: WidgetType;
  title: string;
  config: WidgetConfig;
  /** The range a widget without its own `config.range` inherits. */
  dashboardRange: RangePreset;
  timezone: string;
  /** Show the CSV button (default true). */
  csv?: boolean;
  /** Follow the dashboard's live stream when eligible (default true). The editor preview and edit mode turn it off. */
  live?: boolean;
  actions?: ReactNode;
  dragHandle?: boolean;
}

const NO_IDS: number[] = [];

/** Fetch and show one widget: query by the effective range, register for live updates, draw it inside a WidgetFrame. */
export function WidgetView({ widgetKey, type, title, config, dashboardRange, timezone, csv = true, live = true, actions, dragHandle }: WidgetViewProps) {
  const preset = config.range ?? dashboardRange;
  const query = useWidgetData(type, config, preset);
  const following = live && isLiveWidget(type, config, preset);
  useLiveRegistration(widgetKey, following ? pointIdsOf(query.data) : NO_IDS);
  return (
    <WidgetFrame
      title={title}
      loading={query.isLoading}
      error={query.error}
      missing={query.data?.missing.length ?? 0}
      csv={csv ? { type, config, range: preset } : undefined}
      actions={actions}
      dragHandle={dragHandle}
    >
      {query.data && <WidgetBody type={type} data={query.data} config={config} timezone={timezone} live={following} />}
    </WidgetFrame>
  );
}
```

Create `frontend/src/components/dashboard/StaticGrid.tsx`:
```tsx
import type { ReactNode } from "react";
import { cellStyle, gridStyle, readingOrder, type Cell } from "../../lib/gridMetrics";

/** The read-only grid: a CSS grid driven by x, y, w, h (see lib/gridMetrics). Cells are in reading order. */
export function StaticGrid<T extends Cell & { key: string }>({ items, render }: { items: readonly T[]; render: (item: T) => ReactNode }) {
  return (
    <div className="dash-grid" style={gridStyle}>
      {readingOrder(items).map((item) => (
        <div key={item.key} className="dash-cell" style={cellStyle(item)}>{render(item)}</div>
      ))}
    </div>
  );
}
```

Create `frontend/src/components/dashboard/DashboardViewer.tsx`:
```tsx
import { useContext, useId, useState } from "react";
import type { Dashboard, RangePreset } from "../../api/types";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";
import { LiveValuesContext } from "./LiveValuesContext";
import { StaticGrid } from "./StaticGrid";
import { WidgetView } from "./WidgetView";

/** The read-only dashboard: name, range select (this visit only), live indicator, optional Edit button, and the widgets. */
export function DashboardViewer({ dashboard, timezone, onEdit }: { dashboard: Dashboard; timezone: string; onEdit?: () => void }) {
  const rangeId = useId();
  const { connected } = useContext(LiveValuesContext);
  const [picked, setPicked] = useState<RangePreset | null>(null);
  const range = picked ?? dashboard.range;
  const items = dashboard.widgets.map((w) => ({ ...w, key: String(w.id) }));
  return (
    <>
      <div className="row dash-head">
        <h1>{dashboard.name}</h1>
        <span className="spacer" />
        {connected && <span className="muted">live</span>}
        <label htmlFor={rangeId}>Dashboard range</label>
        <select id={rangeId} value={range} onChange={(e) => setPicked(e.target.value as RangePreset)}>
          {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
        </select>
        {onEdit && <button type="button" onClick={onEdit}>Edit</button>}
      </div>
      {picked !== null && picked !== dashboard.range && (
        <p className="muted">Showing {RANGE_LABELS[picked]} for this visit only. Edit the dashboard to change its saved range.</p>
      )}
      {items.length === 0 ? (
        <p className="muted">This dashboard has no widgets yet.</p>
      ) : (
        <StaticGrid
          items={items}
          render={(w) => <WidgetView widgetKey={w.key} type={w.type} title={w.title} config={w.config} dashboardRange={range} timezone={timezone} />}
        />
      )}
    </>
  );
}
```

- [ ] **Step 12: The dashboard page, test first**

Create `frontend/src/pages/DashboardPage.test.tsx`:
```tsx
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role, WidgetType } from "../api/types";
import { downloadCsv } from "../lib/download";
import { authed, config, dashboard, dataFor, valuesData, widget, widgetDataRoute } from "../test/dashboardFixtures";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { DashboardPage } from "./DashboardPage";

vi.mock("echarts-for-react", () => ({
  default: (props: { option: { series?: { type?: string }[] } }) => (
    <pre data-testid="chart" data-kind={props.option.series?.[0]?.type}>{JSON.stringify(props.option)}</pre>
  ),
}));
vi.mock("../lib/download", () => ({ downloadCsv: vi.fn() }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static get open() { return FakeEventSource.instances.filter((s) => !s.closed); }
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.mocked(downloadCsv).mockReset();
  vi.mocked(downloadCsv).mockResolvedValue(undefined);
});

const trend = widget(1, "timeseries", { title: "Power trend", x: 0, y: 0, w: 6, h: 4 });
const energy = widget(2, "bar", { title: "Energy by asset", config: config({ source: "energy", metric: null, aggregation: "sum" }), x: 6, y: 0, w: 6, h: 4 });
const current = widget(3, "stat", { title: "Current power", config: config({ aggregation: "last" }), x: 0, y: 4, w: 3, h: 2 });
const load = widget(4, "gauge", { title: "Load", config: config({ aggregation: "last", min: 0, max: 200 }), x: 3, y: 4, w: 3, h: 3 });
const assets = widget(5, "table", { title: "Assets", config: config({ assets: [5, 6], range: "30d" }), x: 6, y: 4, w: 6, h: 3 });
// Deliberately not in reading order.
const widgets = [assets, current, trend, load, energy];

function open(role: Role = "viewer", over: Routes = {}) {
  const calls = mockFetch({
    ...authed(role),
    "GET /api/dashboards/3": { body: dashboard({ widgets }) },
    "POST /api/widget-data": widgetDataRoute,
    ...over,
  });
  renderWithProviders(<DashboardPage />, { route: "/dashboards/3", path: "/dashboards/:id" });
  return calls;
}
const region = (name: string) => screen.findByRole("region", { name });
const dataRequests = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST" && c.path === "/api/widget-data").map((c) => c.body as { type: string; range: string });

describe("DashboardPage (view)", () => {
  it("renders one widget of each type, in reading order", async () => {
    open();
    await region("Power trend");
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Power trend", "Energy by asset", "Current power", "Load", "Assets"]);
    await waitFor(() => expect(screen.getAllByTestId("chart")).toHaveLength(3));
    expect(screen.getAllByTestId("chart").map((c) => c.getAttribute("data-kind")).sort()).toEqual(["bar", "gauge", "line"]);
    expect(await within(await region("Current power")).findByText("10.50")).toBeInTheDocument();
    const table = within(await region("Assets"));
    expect(await table.findByText("LV Panel 2")).toBeInTheDocument();
    expect(table.getByText("~4.25")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hall A" })).toBeInTheDocument();
  });

  it("changes the range for widgets that inherit it, keeps overrides, and saves nothing", async () => {
    const calls = open();
    await waitFor(() => expect(dataRequests(calls)).toHaveLength(5));
    expect(dataRequests(calls).map((r) => r.range).sort()).toEqual(["24h", "24h", "24h", "24h", "30d"]);
    await userEvent.selectOptions(screen.getByLabelText("Dashboard range"), "7d");
    await waitFor(() => expect(dataRequests(calls).filter((r) => r.range === "7d")).toHaveLength(4));
    expect(dataRequests(calls).filter((r) => r.range === "7d").map((r) => r.type).sort()).toEqual(["bar", "gauge", "stat", "timeseries"]);
    expect(dataRequests(calls).filter((r) => r.type === "table")).toHaveLength(1); // its own 30d override is not refetched
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(screen.getByText(/this visit only/)).toBeInTheDocument();
  });

  it("lets one stream override the live widgets' figures, and nothing else", async () => {
    open();
    const stat = within(await region("Current power"));
    expect(await stat.findByText("10.50")).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.open).toHaveLength(1)); // stat and gauge share ONE EventSource
    expect(FakeEventSource.open[0].url).toBe("/api/stream");
    act(() => FakeEventSource.open[0].emit([[7, 1_760_000_000, 11.25, 0], [8, 1_760_000_000, 99, 0], [99, 1_760_000_000, 1, 0]]));
    expect(stat.getByText("11.25")).toBeInTheDocument();
    expect(stat.queryByText("10.50")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId("chart").some((c) => c.textContent?.includes('"value":11.25'))).toBe(true));
    const table = within(await region("Assets"));
    expect(await table.findByText("10.50")).toBeInTheDocument(); // a table is not live
    expect(table.queryByText("99.00")).not.toBeInTheDocument();
    act(() => FakeEventSource.open[0].emit([[7, 1_760_000_001, 5, 1]]));
    expect(stat.getByText("—")).toBeInTheDocument(); // bad quality: a dash, not the old figure
    expect(FakeEventSource.open).toHaveLength(1);
  });

  it("shows a warning chip for removed assets and still draws the rest (Review Focus 5, UI side)", async () => {
    open("viewer", {
      "POST /api/widget-data": ({ body }) => {
        const type = (body as { type: WidgetType }).type;
        return { body: type === "stat" ? valuesData({ missing: [99] }) : dataFor(type) };
      },
    });
    const stat = within(await region("Current power"));
    expect(await stat.findByText("1 asset removed")).toBeInTheDocument();
    expect(stat.getByText("10.50")).toBeInTheDocument();
    expect(within(await region("Assets")).queryByText(/removed/)).not.toBeInTheDocument();
  });

  it("shows a failing widget's error inside that widget only", async () => {
    open("viewer", {
      "POST /api/widget-data": ({ body }) => {
        const type = (body as { type: WidgetType }).type;
        return type === "table" ? { status: 500, body: { detail: "query failed" } } : { body: dataFor(type) };
      },
    });
    expect(await within(await region("Assets")).findByRole("alert")).toHaveTextContent("query failed");
    const stat = within(await region("Current power"));
    await stat.findByText("10.50");
    expect(stat.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("exports a widget as CSV through the shared download helper", async () => {
    open();
    const stat = within(await region("Current power"));
    await stat.findByText("10.50");
    await userEvent.click(stat.getByRole("button", { name: "Download CSV for Current power" }));
    expect(downloadCsv).toHaveBeenCalledWith("/api/widget-data/csv", { method: "POST", body: { type: "stat", config: current.config, range: "24h" } });
  });

  it("says so when the dashboard has no widgets", async () => {
    open("viewer", { "GET /api/dashboards/3": { body: dashboard({ widgets: [] }) } });
    expect(await screen.findByText("This dashboard has no widgets yet.")).toBeInTheDocument();
  });

  it("shows the API error when the dashboard cannot be loaded", async () => {
    open("viewer", { "GET /api/dashboards/3": { status: 404, body: { detail: "dashboard not found" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("dashboard not found");
  });
});
```
Create `frontend/src/pages/DashboardsPage.test.tsx`:
```tsx
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import type { Role } from "../api/types";
import { formatSiteDateTime } from "../lib/siteTime";
import { authed, dashboard } from "../test/dashboardFixtures";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { DashboardsPage } from "./DashboardsPage";

const items = [
  { id: 3, name: "Hall A", range: "24h", widget_count: 2, updated_at: "2026-10-08T06:00:00+00:00" },
  { id: 4, name: "Hall B", range: "7d", widget_count: 0, updated_at: "2026-10-07T10:30:00+00:00" },
];

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}|${JSON.stringify(location.state)}`}</output>;
}
function open(role: Role, over: Routes = {}) {
  const calls = mockFetch({ ...authed(role), "GET /api/dashboards": { body: items }, ...over });
  renderWithProviders(<><DashboardsPage /><Probe /></>, { route: "/dashboards", path: "*" });
  return calls;
}

describe("DashboardsPage", () => {
  it("lists dashboards by name with widget count and last update in the site zone", async () => {
    open("viewer");
    const first = (await screen.findByRole("link", { name: "Hall A" })).closest("tr")!;
    expect(screen.getByRole("link", { name: "Hall A" })).toHaveAttribute("href", "/dashboards/3");
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["Hall A", "Hall B"]);
    expect(within(first).getByText("2")).toBeInTheDocument();
    expect(within(first).getByText(formatSiteDateTime(items[0].updated_at, "Asia/Qatar"))).toBeInTheDocument();
    const second = screen.getByRole("link", { name: "Hall B" }).closest("tr")!;
    expect(within(second).getByText(formatSiteDateTime(items[1].updated_at, "Asia/Qatar"))).toBeInTheDocument();
  });

  it("gives a viewer no create or delete controls", async () => {
    open("viewer");
    await screen.findByRole("link", { name: "Hall A" });
    expect(screen.queryByRole("button", { name: "New dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
  });

  it("lets an operator create a dashboard and opens it in edit mode", async () => {
    const calls = open("operator", { "POST /api/dashboards": { status: 201, body: dashboard({ id: 9, name: "Hall C", range: "7d" }) } });
    await userEvent.click(await screen.findByRole("button", { name: "New dashboard" }));
    const dialog = screen.getByRole("dialog", { name: "New dashboard" });
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Name"), "Hall C");
    await userEvent.selectOptions(screen.getByLabelText("Range"), "7d");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent('/dashboards/9|{"edit":true}'));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Hall C", range: "7d" });
  });

  it("keeps the dialog open with the server's message when the name is taken, and Escape closes it", async () => {
    open("operator", { "POST /api/dashboards": { status: 409, body: { detail: "a dashboard with this name already exists" } } });
    await userEvent.click(await screen.findByRole("button", { name: "New dashboard" }));
    await userEvent.type(screen.getByLabelText("Name"), "Hall A");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByRole("dialog", { name: "New dashboard" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("deletes after confirmation and refreshes the list; declining deletes nothing", async () => {
    let deleted = false;
    const calls = open("operator", {
      "GET /api/dashboards": () => ({ body: deleted ? [items[1]] : items }),
      "DELETE /api/dashboards/3": () => { deleted = true; return { status: 204 }; },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Hall A" }));
    expect(confirm).toHaveBeenCalledWith('Delete dashboard "Hall A" and its widgets?');
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Delete Hall A" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Hall A" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Hall B" })).toBeInTheDocument();
  });

  it("keeps the Dashboards heading while loading and when the list cannot be loaded", async () => {
    open("viewer", { "GET /api/dashboards": { status: 500, body: { detail: "list failed" } } });
    expect(screen.getByRole("heading", { name: "Dashboards" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("list failed");
    expect(screen.getByRole("heading", { name: "Dashboards" })).toBeInTheDocument();
  });

  it("shows an empty state, with a hint only for those who can create", async () => {
    open("viewer", { "GET /api/dashboards": { body: [] } });
    expect(await screen.findByText("No dashboards yet.")).toBeInTheDocument();
  });

  it("tells an operator how to start", async () => {
    open("operator", { "GET /api/dashboards": { body: [] } });
    expect(await screen.findByText("No dashboards yet. Create one to get started.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New dashboard" })).toBeInTheDocument();
  });
});
```
Run: `cd frontend && npm test -- src/pages/DashboardPage.test.tsx src/pages/DashboardsPage.test.tsx`. Expected: FAIL. The Task 7 placeholder pages render no widgets and no list (assertions such as `findByRole("region", { name: "Power trend" })` and `findByRole("link", { name: "Hall A" })` time out).

Replace `frontend/src/pages/DashboardPage.tsx` entirely:
```tsx
import { Link, useParams } from "react-router";
import { useDashboard, useSite } from "../api/queries";
import { DashboardViewer } from "../components/dashboard/DashboardViewer";
import { LiveValuesProvider } from "../components/dashboard/LiveValuesContext";

export function DashboardPage() {
  const id = Number(useParams().id);
  // Keyed by id so moving from one dashboard to another starts from a clean slate.
  return <DashboardScreen key={id} id={id} />;
}

function DashboardScreen({ id }: { id: number }) {
  const dashboard = useDashboard(id);
  const site = useSite();
  if (dashboard.isLoading || site.isLoading) return <p className="muted">loading…</p>;
  const failure = dashboard.error ?? site.error;
  if (failure || !dashboard.data || !site.data) return <p className="error" role="alert">{failure?.message ?? "not found"}</p>;
  return (
    <>
      <p><Link to="/dashboards">Dashboards</Link> / {dashboard.data.name}</p>
      <LiveValuesProvider>
        <DashboardViewer dashboard={dashboard.data} timezone={site.data.timezone} />
      </LiveValuesProvider>
    </>
  );
}
```

Create `frontend/src/components/dashboard/CreateDashboardDialog.tsx`:
```tsx
import { useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useCreateDashboard } from "../../api/queries";
import type { RangePreset } from "../../api/types";
import { useAction } from "../../hooks/useAction";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";

/** Name and default range; on success the new (empty) dashboard opens in edit mode. */
export function CreateDashboardDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateDashboard();
  const { run, busy, error } = useAction();
  const root = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const rangeId = useId();
  const [name, setName] = useState("");
  const [range, setRange] = useState<RangePreset>("24h");
  useDialogFocus(root, onClose, { busy, initial: nameInput });
  const trimmed = name.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed === "" || busy) return;
    void run(async () => {
      const created = await create.mutateAsync({ name: trimmed, range });
      navigate(`/dashboards/${created.id}`, { state: { edit: true } });
    });
  };

  return (
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-label="New dashboard" className="dialog narrow">
        <h2>New dashboard</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor={nameId}>Name</label>
            <input id={nameId} ref={nameInput} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={rangeId}>Range</label>
            <select id={rangeId} value={range} onChange={(e) => setRange(e.target.value as RangePreset)}>
              {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
            </select>
          </div>
          {trimmed === "" && <p className="muted">Enter a name.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row">
            <button type="submit" disabled={busy || trimmed === ""}>Create</button>
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

Replace `frontend/src/pages/DashboardsPage.tsx` entirely:
```tsx
import { useState } from "react";
import { Link } from "react-router";
import { useDashboards, useDeleteDashboard, useSite } from "../api/queries";
import type { DashboardListItem } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { CreateDashboardDialog } from "../components/dashboard/CreateDashboardDialog";
import { useAction } from "../hooks/useAction";
import { formatSiteDateTime } from "../lib/siteTime";

export function DashboardsPage() {
  const { hasRole } = useAuth();
  const canEdit = hasRole("operator");
  const list = useDashboards();
  const site = useSite();
  const remove = useDeleteDashboard();
  const { run, error: actionError } = useAction();
  const [creating, setCreating] = useState(false);

  const failure = list.error ?? site.error;
  const timezone = site.data?.timezone;

  const confirmDelete = (d: DashboardListItem) => run(async () => {
    if (!window.confirm(`Delete dashboard "${d.name}" and its widgets?`)) return;
    await remove.mutateAsync(d.id);
  });

  // The heading is always there (App.test.tsx finds the page by it); the body waits for the list and the site zone.
  return (
    <>
      <div className="row">
        <h1>Dashboards</h1>
        <span className="spacer" />
        {canEdit && <button type="button" onClick={() => setCreating(true)}>New dashboard</button>}
      </div>
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {failure && <p className="error" role="alert">{failure.message}</p>}
      {!failure && (!list.data || timezone === undefined) && <p className="muted">loading…</p>}
      {list.data && timezone !== undefined && list.data.length === 0 && (
        <p className="muted">No dashboards yet.{canEdit ? " Create one to get started." : ""}</p>
      )}
      {list.data && timezone !== undefined && list.data.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>Widgets</th><th>Updated</th>{canEdit && <th>Actions</th>}</tr></thead>
          <tbody>
            {list.data.map((d) => (
              <tr key={d.id}>
                <td><Link to={`/dashboards/${d.id}`}>{d.name}</Link></td>
                <td>{d.widget_count}</td>
                <td>{formatSiteDateTime(d.updated_at, timezone)}</td>
                {canEdit && <td><button type="button" onClick={() => confirmDelete(d)} aria-label={`Delete ${d.name}`}>Delete</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && <CreateDashboardDialog onClose={() => setCreating(false)} />}
    </>
  );
}
```
Run again: `cd frontend && npm test -- src/pages/DashboardPage.test.tsx src/pages/DashboardsPage.test.tsx`. Expected: all pass. If the `.spacer` inside `.row` has no effect, it is fixed by the CSS in Step 13.

- [ ] **Step 13: Styles**

Append to `frontend/src/app.css` (end of file):
```css

/* Dashboards */
.dash-head { margin-bottom: 8px; }
.dash-head h1 { margin: 0; font-size: 20px; }
.row .spacer, .widget-head .spacer { flex: 1; }
.dash-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); }
.dash-cell { min-width: 0; min-height: 0; }
.widget-frame { height: 100%; display: flex; flex-direction: column; border: 1px solid #000; background: #fff; }
.widget-head { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-bottom: 1px solid #000; }
.widget-head h3 { margin: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.widget-body { flex: 1; min-height: 0; padding: 8px; overflow: auto; }
.widget-body table { margin: 0; }
.chip { display: inline-block; padding: 0 6px; border: 1px solid #000; font-size: 12px; white-space: nowrap; }
.chip-warn { border-color: #b00; color: #b00; }
.stat .big { font-size: 32px; }
.stat .big small { font-size: 14px; margin-left: 4px; }
.dialog.narrow { width: min(440px, 100%); }
@media (max-width: 700px) {
  .dash-grid { display: block; }
  .dash-cell { grid-column: auto !important; grid-row: auto !important; height: 280px; margin-bottom: 10px; }
}
```

- [ ] **Step 14: Verify everything**

```bash
cd frontend && npm run typecheck && npm test && npm run build
```
Expected: typecheck clean, the whole suite green (the new files plus every earlier test), the build succeeds and its output lists the ECharts-based widget files as separate chunks (not in the main chunk). Fix type errors in files you wrote here only.

- [ ] **Step 15: Commit**

```bash
cd /home/ziad/Projects/DC_Dashboard && git add \
  frontend/src/test/dashboardFixtures.ts \
  frontend/src/lib/widgetFormat.ts frontend/src/lib/widgetFormat.test.ts \
  frontend/src/lib/live.ts frontend/src/lib/live.test.ts \
  frontend/src/lib/gridMetrics.ts frontend/src/lib/gridMetrics.test.ts \
  frontend/src/hooks/useDialogFocus.ts frontend/src/hooks/useDialogFocus.test.tsx \
  frontend/src/components/dashboard \
  frontend/src/pages/DashboardsPage.tsx frontend/src/pages/DashboardsPage.test.tsx \
  frontend/src/pages/DashboardPage.tsx frontend/src/pages/DashboardPage.test.tsx \
  frontend/src/app.css
git commit -m "$(cat <<'EOF'
feat(ui): dashboards list and read-only dashboard view with widgets

Dashboards page (list by name, create and delete for operators/admins) and the
read-only dashboard page: dashboard-level range (view state only), a CSS grid
laid out from x/y/w/h, five widgets (time series, bar, stat, gauge, table;
ECharts ones lazy-loaded), per-widget CSV, a chip for removed assets, and one
shared live stream for stat/gauge widgets. Adds useDialogFocus (ReviewDialog's
focus handling, stack-aware) for the create dialog and the Task 10 editor.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

### Task 10: Dashboard editor

Edit mode for operators and admins: a drag-and-resize grid (react-grid-layout), an Add/Edit widget dialog with an asset picker and a live preview, rename and range, one Save that sends the whole dashboard, a 409 flow that never overwrites, and a prompt before unsaved changes are lost.

**Design notes (decided here, do not revisit):**
- `useBlocker` needs a data router, and `main.tsx` (after Task 7) mounts `<BrowserRouter>` around `<App />`: this task first changes `main.tsx` to `createBrowserRouter([{ path: "*", element: <App /> }])` + `<RouterProvider>` (one catch-all route, so the `<Routes>` tree in Task 7's `App.tsx` is untouched; `AuthProvider` wraps the provider because it uses no router hooks). Tests that mount an editor use the new `renderWithDataRouter`; `useBlocker` is called only inside the editor component, never in `DashboardPage`, so Task 9's view-mode tests keep using `renderWithProviders`.
- `App.tsx` already lazy-loads the two dashboard pages; `DashboardPage` in turn lazy-loads the editor (and with it react-grid-layout), so viewers never download the grid library (spec 10.8). Step 10 proves from the build output that the grid and ECharts stay out of the main chunk.
- Compaction is off (`noCompactor`): what the editor shows is exactly what is stored, and the Task 9 CSS grid renders the same cells. Dirty is decided by comparing the would-be save body with the loaded dashboard (`isDirty`), never by "a layout callback fired" (the library reports on mount). The grid reports only finished drags and resizes (`onDragStop`, `onResizeStop`).
- Edit mode is component state in `DashboardPage`; the only external signal is the router state `{ edit: true }` set by Task 9's create dialog. It is honoured only for operators and admins, and cleared (`navigate(..., { replace: true, state: null })`) when edit mode ends. The blocker compares `pathname` only, so that replace is never blocked.
- Save disabled until valid and changed. The widget rules mirror the API contract exactly (stat/gauge one asset; gauge metric + `last` + max > min; energy/cost `sum`; 1..20 assets; title 1..100).
- The grid stylesheets (`react-grid-layout/css/styles.css` and `react-resizable/css/styles.css`, as Task 7 does in its smoke test) are imported only in `DashboardGrid.tsx`, the lazily loaded component; `react-resizable` is installed with the library.

**Files:**
- Modify: `frontend/src/main.tsx` (data router), `frontend/src/test/render.tsx` (add `renderWithDataRouter`), `frontend/src/app.css` (append)
- Create: `frontend/src/lib/dashboardEdit.ts`, `frontend/src/lib/dashboardEdit.test.ts`
- Create: `frontend/src/components/dashboard/AssetPicker.tsx`, `AssetPicker.test.tsx`
- Create: `frontend/src/components/dashboard/WidgetEditor.tsx`, `WidgetEditor.test.tsx`
- Create: `frontend/src/components/dashboard/DashboardGrid.tsx`, `DashboardGrid.test.tsx`
- Create: `frontend/src/components/dashboard/DashboardEditor.tsx`
- Replace: `frontend/src/pages/DashboardPage.tsx`
- Test: `frontend/src/pages/DashboardPage.edit.test.tsx`

**Interfaces:**

Consumes from Task 7 (merged on this branch; exact):
```ts
// lib/layout.ts
export const GRID_COLS = 12;
export interface GridItem { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }
export type DraftWidget = Omit<Widget, "id"> & { key: string };
export function toDrafts(widgets: Widget[]): DraftWidget[];                         // key = String(id)
export function toGrid(drafts: DraftWidget[]): GridItem[];                          // adds minW/minH per type
export function applyGrid(drafts: DraftWidget[], grid: readonly GridItem[]): DraftWidget[];   // returns the SAME array when nothing moved
export function defaultSize(type: WidgetType): { w: number; h: number };
export function nextPosition(drafts: DraftWidget[], size: { w: number; h: number }): { x: number; y: number };   // x 0, y below the lowest widget
export function newKey(): string;                                                    // "new-1", "new-2", ...
// api/types.ts: WIDGET_TYPES (const tuple), WidgetType, WidgetSource, WidgetAggregation, WidgetConfig (metric: Metric | null; the type does not exclude "custom", the editor must),
//               Widget, WidgetIn = Omit<Widget, "id">, Dashboard, DashboardSave = { name; range; updated_at; widgets: WidgetIn[] }, METRICS, Metric, Asset, RangePreset
// api/queries.ts
useSaveDashboard()   // mutateAsync({ id: number; body: DashboardSave }) -> Dashboard; writes the saved dashboard into the useDashboard(id) cache and refreshes the list
useDashboard(id)     // UseQueryResult<Dashboard> (refetch() available)
useAssets()          // UseQueryResult<Asset[]>
useWidgetData(type, config, preset, enabled = true)
// api/client.ts  ApiError { status: number; message: string }  (message = the string `detail`)
// react-grid-layout 2.3: default export ReactGridLayout; useContainerWidth(); noCompactor; props width, layout, gridConfig, dragConfig, resizeConfig, compactor, onDragStop, onResizeStop
```
From Task 5 (the API): a stale save answers 409 with the detail exactly `dashboard changed since you loaded it`; a taken name answers a different 409, `a dashboard with this name already exists`; an invalid widget answers 422 with a string detail `widget N ("title"): field: reason`. Widgets come back ordered by (y, x, id), and the PUT ignores any widget ids it is sent.
Consumes from Task 9: `useDialogFocus`, `WidgetView` (`WidgetViewProps`), `DashboardViewer` (`onEdit?`), `LiveValuesProvider`, `ROW_HEIGHT`, `GRID_GAP`, `test/dashboardFixtures.ts` (`authed`, `assetList`, `config`, `widget`, `dashboard`, `widgetDataRoute`), `RANGE_LABELS`/`RANGE_PRESETS`, `.dialog`/`.dialog-backdrop`/`.dialog.narrow` CSS.

Produces:
```ts
// lib/dashboardEdit.ts (see Step 4 for the full file)
MAX_WIDGETS = 24; MAX_ASSETS = 20; MAX_TEXT = 100
type Aggregation = WidgetAggregation; type WidgetMetric = Exclude<Metric, "custom">
TYPE_LABELS, SOURCE_LABELS, AGGREGATION_LABELS, WIDGET_METRICS
isSingleAsset(type), allowedSources(type), allowedAggregations(type, source)
interface WidgetForm; blankForm(); formFromDraft(draft); withType(form, type); withSource(form, source)
interface FormIssues { title?; assets?; aggregation?; gauge? }; formIssues(form): FormIssues; formToFields(form): { type; title; config }
type WidgetBody = WidgetIn; type SaveBody = DashboardSave
toWidgetBody(draft); saveBody(baseline, edit); canonical(value); isDirty(baseline, edit); newest(a, b); isStaleConflict(error)   // 409 whose message says the dashboard "changed since you loaded it"
// components
AssetPicker(props: { assets: Asset[]; selected: number[]; onChange(ids: number[]): void; single: boolean; max: number }); pickerRows(assets)
WidgetEditor(props: { initial: DraftWidget | null; assets: Asset[]; dashboardRange: RangePreset; timezone: string;
                      onSave(fields: { type; title; config }): void; onClose(): void })
DashboardGrid(props: { drafts: DraftWidget[]; onChange(next: DraftWidget[]): void; renderWidget(draft: DraftWidget): ReactNode })
DashboardEditor(props: { dashboard: Dashboard; timezone: string; onSaved(saved: Dashboard): void; onCancel(): void; onReload(): Promise<void> })
// test/render.tsx
renderWithDataRouter(ui, { route?: string | { pathname: string; state?: unknown }; path?: string }) -> render result + { router }
```

- [ ] **Step 1: Preconditions**

```bash
cd /home/ziad/Projects/DC_Dashboard && git status --short && git branch --show-current   # expect: phase-3-dashboards-billing, clean
ls frontend/node_modules/react-grid-layout/package.json frontend/src/hooks/useDialogFocus.ts frontend/src/components/dashboard/WidgetView.tsx frontend/src/lib/layout.ts
grep -n "must be used within a data router" frontend/node_modules/react-router/dist/development/chunk-*.js | head -2   # the reason for the router change
grep -n "409" backend/dcdash/api/dashboards.py
cd frontend && npm run typecheck && npm test
```
Expected: all files exist (Tasks 7 and 9), the grep prints the data-router message, typecheck and the suite are green.

Confirm the two 409 texts the editor branches on: the output of the `grep` above must show `dashboard changed since you loaded it` (stale save) and `a dashboard with this name already exists` (taken name). `isStaleConflict` (Step 4) offers Reload only for a message containing `changed since you loaded`; any other error, including the name clash, is shown as the server's message. If the backend wording differs, fix the one regular expression in `isStaleConflict` and the strings in this task's tests to the real ones (do not change the backend).

- [ ] **Step 2: Data router, and a test helper for it**

Edit `frontend/src/main.tsx` (after Task 7 it only mounts the providers; the routes live in `App.tsx`, which stays unchanged). If Task 7's lines differ slightly, make the equivalent edit.

Replace the import line
```tsx
import { BrowserRouter } from "react-router";
```
with
```tsx
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
```
and replace the final block
```tsx
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```
with
```tsx
// A data router, because useBlocker (unsaved dashboard edits) only works under one. A single catch-all route keeps
// App's own <Routes> tree (in App.tsx) exactly as it is.
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
```

Replace `frontend/src/test/render.tsx` entirely (`renderWithProviders` is unchanged; `renderWithDataRouter` is new):
```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router";
import { AuthProvider } from "../auth/AuthProvider";

export function renderWithProviders(ui: ReactElement, { route = "/", path = "*" } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <Routes>
            <Route path={path} element={ui} />
            <Route path="/login" element={<p>login page</p>} />
            <Route path="/setup" element={<p>setup page</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Like renderWithProviders, but under a data router (createMemoryRouter) as in production; `useBlocker` needs one.
 * `route` may carry router state ({ pathname, state }). The router is returned so a test can navigate and read the location.
 * /login, /setup, /assets and /dashboards render plain stubs ("login page", "assets page", ...) unless `path` is one of them.
 */
export function renderWithDataRouter(
  ui: ReactElement,
  { route = "/", path = "*" }: { route?: string | { pathname: string; state?: unknown }; path?: string } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const stubs = [["/login", "login page"], ["/setup", "setup page"], ["/assets", "assets page"], ["/dashboards", "dashboards page"]] as const;
  const router = createMemoryRouter(
    [{ path, element: ui }, ...stubs.filter(([stubPath]) => stubPath !== path).map(([stubPath, text]) => ({ path: stubPath, element: <p>{text}</p> }))],
    { initialEntries: [route] },
  );
  const result = render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...result, router };
}
```
Check: `cd frontend && npm run typecheck && npm test` (expected green: every existing test still uses `renderWithProviders`).

- [ ] **Step 3: Editing rules and the save body, tests first**

Create `frontend/src/lib/dashboardEdit.test.ts`:
```ts
import { ApiError } from "../api/client";
import { config, dashboard, widget } from "../test/dashboardFixtures";
import {
  allowedAggregations, allowedSources, blankForm, canonical, formFromDraft, formIssues, formToFields, isDirty, isSingleAsset,
  isStaleConflict, newest, saveBody, toWidgetBody, WIDGET_METRICS, withSource, withType, type FormIssues, type WidgetForm,
} from "./dashboardEdit";
import { toDrafts } from "./layout";

const valid = (over: Partial<WidgetForm> = {}): WidgetForm => ({ ...blankForm(), title: "Hall power", assets: [5], ...over });

describe("what each widget may show", () => {
  it("offers the eight non-custom metrics", () => {
    expect(WIDGET_METRICS).toHaveLength(8);
    expect(WIDGET_METRICS).not.toContain("custom");
  });
  it("restricts sources and aggregations by type and source", () => {
    expect(allowedSources("gauge")).toEqual(["metric"]);
    expect(allowedSources("stat")).toEqual(["metric", "energy", "cost"]);
    expect(allowedAggregations("table", "metric")).toEqual(["avg", "min", "max", "last"]);
    expect(allowedAggregations("gauge", "metric")).toEqual(["last"]);
    expect(allowedAggregations("bar", "energy")).toEqual(["sum"]);
    expect(allowedAggregations("stat", "cost")).toEqual(["sum"]);
    expect(isSingleAsset("stat")).toBe(true);
    expect(isSingleAsset("gauge")).toBe(true);
    expect(isSingleAsset("table")).toBe(false);
  });
});

describe("withType and withSource", () => {
  it("repairs the form when the type changes", () => {
    expect(withType(valid({ assets: [5, 6, 7], source: "energy", aggregation: "sum" }), "gauge"))
      .toMatchObject({ type: "gauge", source: "metric", aggregation: "last", assets: [5] });
    expect(withType(valid({ assets: [5, 6] }), "stat").assets).toEqual([5]);
    expect(withType(valid({ assets: [5, 6] }), "table").assets).toEqual([5, 6]);
    expect(withType(valid({ source: "energy", aggregation: "sum" }), "bar")).toMatchObject({ source: "energy", aggregation: "sum" });
  });
  it("picks a valid aggregation when the source changes", () => {
    expect(withSource(valid({ aggregation: "last" }), "energy")).toMatchObject({ source: "energy", aggregation: "sum" });
    expect(withSource(valid({ source: "cost", aggregation: "sum" }), "metric")).toMatchObject({ source: "metric", aggregation: "avg" });
    expect(withSource(valid({ aggregation: "min" }), "metric").aggregation).toBe("min");
  });
});

describe("formIssues (the API's rules, before the API is asked)", () => {
  it("accepts a complete widget", () => expect(formIssues(valid())).toEqual({}));
  it.each<[string, WidgetForm, FormIssues]>([
    ["a blank form", blankForm(), { title: "Enter a title.", assets: "Choose at least one asset." }],
    ["a title that is too long", valid({ title: "x".repeat(101) }), { title: "The title can be at most 100 characters." }],
    ["21 assets", valid({ assets: Array.from({ length: 21 }, (_, i) => i + 1) }), { assets: "At most 20 assets." }],
    ["a stat with no asset", valid({ type: "stat", assets: [] }), { assets: "Choose an asset." }],
    ["a stat with two assets", valid({ type: "stat", assets: [5, 6] }), { assets: "A stat shows one asset." }],
    ["a gauge with two assets", valid({ type: "gauge", aggregation: "last", gaugeMax: "100", assets: [5, 6] }), { assets: "A gauge shows one asset." }],
    ["a gauge on energy", valid({ type: "gauge", source: "energy", aggregation: "sum", gaugeMax: "100" }), { gauge: "A gauge shows a metric, not energy or cost." }],
    ["a gauge that is not the latest value", valid({ type: "gauge", aggregation: "avg", gaugeMax: "100" }), { gauge: "A gauge shows the latest value." }],
    ["a gauge without a maximum", valid({ type: "gauge", aggregation: "last" }), { gauge: "Enter a number for the gauge minimum and maximum." }],
    ["a gauge whose maximum is not above its minimum", valid({ type: "gauge", aggregation: "last", gaugeMin: "50", gaugeMax: "50" }), { gauge: "The gauge maximum must be greater than the minimum." }],
    ["energy averaged", valid({ source: "energy", aggregation: "avg" }), { aggregation: "Energy and cost are totals; choose total." }],
    ["a metric totalled", valid({ aggregation: "sum" }), { aggregation: "Choose average, minimum, maximum or latest for a metric." }],
  ])("rejects %s", (_name, form, expected) => {
    expect(formIssues(form)).toEqual(expected);
  });
});

describe("formToFields", () => {
  it("builds the config the API expects", () => {
    expect(formToFields(valid({ assets: [5, 6], range: "7d" }))).toEqual({
      type: "timeseries", title: "Hall power",
      config: { assets: [5, 6], source: "metric", metric: "active_power_kw", aggregation: "avg", range: "7d", bars: "asset", min: 0, max: null },
    });
    expect(formToFields(valid({ source: "energy", aggregation: "sum", title: "  kWh  " }))).toEqual({
      type: "timeseries", title: "kWh",
      config: { assets: [5], source: "energy", metric: null, aggregation: "sum", range: null, bars: "asset", min: 0, max: null },
    });
  });
  it("keeps bars only for bar widgets and min/max only for gauges", () => {
    expect(formToFields(valid({ type: "bar", bars: "time" })).config.bars).toBe("time");
    expect(formToFields(valid({ type: "gauge", aggregation: "last", gaugeMin: "10", gaugeMax: "250.5" })).config).toMatchObject({ min: 10, max: 250.5, bars: "asset" });
    expect(formToFields(valid({ type: "table", bars: "time", gaugeMax: "9" })).config).toMatchObject({ bars: "asset", min: 0, max: null });
  });
  it("round-trips a saved widget through the form", () => {
    const saved = widget(1, "gauge", { title: "Load", config: config({ aggregation: "last", min: 5, max: 90, range: "6h" }) });
    expect(formToFields(formFromDraft(saved))).toEqual({ type: "gauge", title: "Load", config: saved.config });
  });
});

describe("save body and unsaved changes", () => {
  const base = dashboard({ widgets: [widget(1, "stat", { title: "Now", config: config({ aggregation: "last" }), x: 0, y: 0, w: 3, h: 2 })] });
  const unchanged = () => ({ name: base.name, range: base.range, drafts: toDrafts(base.widgets) });

  it("builds the exact save body: no keys or ids, the loaded updated_at, a trimmed name", () => {
    expect(saveBody(base, { ...unchanged(), name: "  Hall A2 " })).toEqual({
      name: "Hall A2", range: "24h", updated_at: "2026-10-08T06:00:00+00:00",
      widgets: [{ type: "stat", title: "Now", config: base.widgets[0].config, x: 0, y: 0, w: 3, h: 2 }],
    });
    expect(Object.keys(toWidgetBody(toDrafts(base.widgets)[0])).sort()).toEqual(["config", "h", "title", "type", "w", "x", "y"]);
  });

  it("is not dirty until something changed", () => {
    expect(isDirty(base, unchanged())).toBe(false);
    expect(isDirty(base, { ...unchanged(), name: "Other" })).toBe(true);
    expect(isDirty(base, { ...unchanged(), range: "7d" })).toBe(true);
    const [draft] = unchanged().drafts;
    expect(isDirty(base, { ...unchanged(), drafts: [{ ...draft, x: 4 }] })).toBe(true);
    expect(isDirty(base, { ...unchanged(), drafts: [] })).toBe(true);
  });

  it("ignores key order inside a config and spaces around the name", () => {
    const [draft] = unchanged().drafts;
    const reordered = { ...draft, config: Object.fromEntries(Object.entries(draft.config).reverse()) as typeof draft.config };
    expect(isDirty(base, { ...unchanged(), name: " Hall A ", drafts: [reordered] })).toBe(false);
    expect(canonical({ b: 1, a: { d: 1, c: 2 } })).toBe(canonical({ a: { c: 2, d: 1 }, b: 1 }));
  });

  it("picks the most recently updated copy of a dashboard", () => {
    const old = dashboard({ updated_at: "2026-10-08T06:00:00+00:00" });
    const later = dashboard({ updated_at: "2026-10-08T07:00:00+00:00", name: "later" });
    expect(newest(old, later)).toBe(later);
    expect(newest(later, old)).toBe(later);
    expect(newest(null, old)).toBe(old);
    expect(newest(old, undefined)).toBe(old);
    expect(newest(null, undefined)).toBeUndefined();
  });

  it("tells a lost race (409) from a taken name (409) and from other errors", () => {
    expect(isStaleConflict(new ApiError(409, "dashboard changed since you loaded it"))).toBe(true);
    expect(isStaleConflict(new ApiError(409, "a dashboard with this name already exists"))).toBe(false);
    expect(isStaleConflict(new ApiError(409, "something else"))).toBe(false);
    expect(isStaleConflict(new ApiError(422, "dashboard changed since you loaded it"))).toBe(false);
    expect(isStaleConflict(new Error("x"))).toBe(false);
  });
});
```
Run: `cd frontend && npm test -- src/lib/dashboardEdit.test.ts`. Expected: FAIL (`Failed to resolve import "./dashboardEdit"`).

- [ ] **Step 4: Implement `dashboardEdit.ts`**

Create `frontend/src/lib/dashboardEdit.ts`:
```ts
import { ApiError } from "../api/client";
import {
  METRICS, type Dashboard, type DashboardSave, type Metric, type RangePreset, type WidgetAggregation, type WidgetConfig, type WidgetIn,
  type WidgetSource, type WidgetType,
} from "../api/types";
import { toDrafts, type DraftWidget } from "./layout";

export const MAX_WIDGETS = 24;
export const MAX_ASSETS = 20;
export const MAX_TEXT = 100;

export type Aggregation = WidgetAggregation;
export type WidgetMetric = Exclude<Metric, "custom">;

export const TYPE_LABELS: Record<WidgetType, string> = { timeseries: "Time series", bar: "Bar chart", stat: "Stat", gauge: "Gauge", table: "Table" };
export const SOURCE_LABELS: Record<WidgetSource, string> = { metric: "Metric", energy: "Energy (kWh)", cost: "Cost" };
export const AGGREGATION_LABELS: Record<Aggregation, string> = { avg: "Average", min: "Minimum", max: "Maximum", last: "Latest", sum: "Total" };
/** The API refuses `custom`: an asset can have several custom mappings and a widget names none of them. */
export const WIDGET_METRICS: WidgetMetric[] = METRICS.filter((m): m is WidgetMetric => m !== "custom");

export const isSingleAsset = (type: WidgetType): boolean => type === "stat" || type === "gauge";
export const allowedSources = (type: WidgetType): WidgetSource[] => (type === "gauge" ? ["metric"] : ["metric", "energy", "cost"]);
export function allowedAggregations(type: WidgetType, source: WidgetSource): Aggregation[] {
  if (source !== "metric") return ["sum"];
  return type === "gauge" ? ["last"] : ["avg", "min", "max", "last"];
}

/** What the widget dialog edits. Numbers stay text while typing; `range` "" means "use the dashboard range". */
export interface WidgetForm {
  type: WidgetType;
  title: string;
  source: WidgetSource;
  metric: WidgetMetric;
  aggregation: Aggregation;
  range: RangePreset | "";
  bars: "asset" | "time";
  gaugeMin: string;
  gaugeMax: string;
  assets: number[];
}

export function blankForm(): WidgetForm {
  return {
    type: "timeseries", title: "", source: "metric", metric: "active_power_kw", aggregation: "avg",
    range: "", bars: "asset", gaugeMin: "0", gaugeMax: "", assets: [],
  };
}

export function formFromDraft(draft: Pick<DraftWidget, "type" | "title" | "config">): WidgetForm {
  const c = draft.config;
  return {
    type: draft.type,
    title: draft.title,
    source: c.source,
    metric: c.metric && c.metric !== "custom" ? c.metric : "active_power_kw",
    aggregation: c.aggregation,
    range: c.range ?? "",
    bars: c.bars,
    gaugeMin: String(c.min),
    gaugeMax: c.max === null ? "" : String(c.max),
    assets: [...c.assets],
  };
}

/** Change the type and repair what the new type does not allow: source, aggregation, and the asset count. */
export function withType(form: WidgetForm, type: WidgetType): WidgetForm {
  const next: WidgetForm = { ...form, type };
  if (!allowedSources(type).includes(next.source)) next.source = "metric";
  const aggregations = allowedAggregations(type, next.source);
  if (!aggregations.includes(next.aggregation)) next.aggregation = aggregations[0];
  if (isSingleAsset(type)) next.assets = next.assets.slice(0, 1);
  return next;
}

export function withSource(form: WidgetForm, source: WidgetSource): WidgetForm {
  const next: WidgetForm = { ...form, source };
  const aggregations = allowedAggregations(form.type, source);
  if (!aggregations.includes(next.aggregation)) next.aggregation = aggregations[0];
  return next;
}

export interface FormIssues { title?: string; assets?: string; aggregation?: string; gauge?: string }

const toNumber = (text: string): number => (text.trim() === "" ? NaN : Number(text));

/** Every rule the API enforces on a widget, as a message per field. An empty object means the form can be saved. */
export function formIssues(form: WidgetForm): FormIssues {
  const issues: FormIssues = {};
  const title = form.title.trim();
  if (title === "") issues.title = "Enter a title.";
  else if (title.length > MAX_TEXT) issues.title = `The title can be at most ${MAX_TEXT} characters.`;

  const count = form.assets.length;
  if (count === 0) issues.assets = isSingleAsset(form.type) ? "Choose an asset." : "Choose at least one asset.";
  else if (isSingleAsset(form.type) && count > 1) issues.assets = `A ${form.type} shows one asset.`;
  else if (count > MAX_ASSETS) issues.assets = `At most ${MAX_ASSETS} assets.`;

  if (form.type === "gauge") {
    const min = toNumber(form.gaugeMin);
    const max = toNumber(form.gaugeMax);
    if (form.source !== "metric") issues.gauge = "A gauge shows a metric, not energy or cost.";
    else if (form.aggregation !== "last") issues.gauge = "A gauge shows the latest value.";
    else if (!Number.isFinite(min) || !Number.isFinite(max)) issues.gauge = "Enter a number for the gauge minimum and maximum.";
    else if (max <= min) issues.gauge = "The gauge maximum must be greater than the minimum.";
  } else if (!allowedAggregations(form.type, form.source).includes(form.aggregation)) {
    issues.aggregation = form.source === "metric"
      ? "Choose average, minimum, maximum or latest for a metric."
      : "Energy and cost are totals; choose total.";
  }
  return issues;
}

/** The widget fields to store. Only meaningful when `formIssues` is empty. */
export function formToFields(form: WidgetForm): { type: WidgetType; title: string; config: WidgetConfig } {
  const gauge = form.type === "gauge";
  return {
    type: form.type,
    title: form.title.trim(),
    config: {
      assets: [...form.assets],
      source: form.source,
      metric: form.source === "metric" ? form.metric : null,
      aggregation: form.aggregation,
      range: form.range === "" ? null : form.range,
      bars: form.type === "bar" ? form.bars : "asset",
      min: gauge ? toNumber(form.gaugeMin) : 0,
      max: gauge ? toNumber(form.gaugeMax) : null,
    },
  };
}

export type WidgetBody = WidgetIn;
export type SaveBody = DashboardSave;
export interface EditState { name: string; range: RangePreset; drafts: DraftWidget[] }

/** A draft as the API takes it: no editor `key`, no id. */
export const toWidgetBody = (d: DraftWidget): WidgetBody => ({ type: d.type, title: d.title, config: d.config, x: d.x, y: d.y, w: d.w, h: d.h });

/** The PUT body: the edited state with the `updated_at` that was loaded, so the API can refuse a stale save. */
export function saveBody(baseline: Pick<Dashboard, "updated_at">, edit: EditState): SaveBody {
  return { name: edit.name.trim(), range: edit.range, updated_at: baseline.updated_at, widgets: edit.drafts.map(toWidgetBody) };
}

/** JSON with sorted object keys, so two values that differ only in key order are equal. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v);
}

/** Unsaved changes: the would-be save body differs from what was loaded. */
export function isDirty(baseline: Dashboard, edit: EditState): boolean {
  const loaded = saveBody(baseline, { name: baseline.name, range: baseline.range, drafts: toDrafts(baseline.widgets) });
  return canonical(saveBody(baseline, edit)) !== canonical(loaded);
}

/** The copy with the later `updated_at` (either may be missing). */
export function newest(a: Dashboard | null | undefined, b: Dashboard | null | undefined): Dashboard | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return Date.parse(a.updated_at) >= Date.parse(b.updated_at) ? a : b;
}

/**
 * A 409 whose message says the dashboard changed since it was loaded: someone else saved first, so offer Reload. The API
 * also answers 409 when the name is taken (`a dashboard with this name already exists`); that one is fixed by renaming,
 * and Reload would throw the edits away, so it is shown as the server's message instead.
 */
export function isStaleConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && /changed since you loaded/i.test(error.message);
}
```
Run `cd frontend && npm test -- src/lib/dashboardEdit.test.ts`. Expected: all pass.

- [ ] **Step 5: `AssetPicker`, test first**

Create `frontend/src/components/dashboard/AssetPicker.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { Asset } from "../../api/types";
import { AssetPicker, pickerRows } from "./AssetPicker";

const tree: Asset[] = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 2, parent_id: 1, name: "Room A", kind: "room", sort_order: 0 },
  { id: 3, parent_id: 2, name: "Panel", kind: "panel", sort_order: 0 },
  { id: 4, parent_id: 1, name: "Room B", kind: "room", sort_order: 1 },
  { id: 5, parent_id: 4, name: "Panel", kind: "panel", sort_order: 0 },
  { id: 6, parent_id: null, name: "Main", kind: "meter", sort_order: 1 },
];
const many = (n: number): Asset[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, parent_id: null, name: `Asset ${i + 1}`, kind: "generic", sort_order: i }));

function Harness({ assets, initial = [], single = false, max = 20 }: { assets: Asset[]; initial?: number[]; single?: boolean; max?: number }) {
  const [selected, setSelected] = useState<number[]>(initial);
  return (
    <>
      <AssetPicker assets={assets} selected={selected} onChange={setSelected} single={single} max={max} />
      <output data-testid="selected">{selected.join(",")}</output>
    </>
  );
}

describe("pickerRows", () => {
  it("lists the tree parents first, with depth, the parent path, and a flag for names used twice", () => {
    expect(pickerRows(tree).map((r) => [r.id, r.depth, r.parentPath, r.duplicate])).toEqual([
      [1, 0, "", false], [2, 1, "Site", false], [3, 2, "Site / Room A", true],
      [4, 1, "Site", false], [5, 2, "Site / Room B", true], [6, 0, "", false],
    ]);
  });
});

describe("AssetPicker", () => {
  it("shows the path of assets whose name is used more than once", () => {
    render(<Harness assets={tree} />);
    expect(screen.getByRole("checkbox", { name: "Panel (Site / Room A)" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Panel (Site / Room B)" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Room A" })).toBeInTheDocument();
  });

  it("toggles assets in and out of the selection", async () => {
    render(<Harness assets={tree} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Site" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Room A" }));
    expect(screen.getByTestId("selected")).toHaveTextContent("1,2");
    await userEvent.click(screen.getByRole("checkbox", { name: "Site" }));
    expect(screen.getByTestId("selected")).toHaveTextContent("2");
  });

  it("stops at the cap: the rest are disabled until something is unchecked", async () => {
    render(<Harness assets={many(25)} initial={Array.from({ length: 20 }, (_, i) => i + 1)} />);
    expect(screen.getByText("20 of 20 selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Asset 21" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Asset 1" })).toBeEnabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Asset 1" }));
    expect(screen.getByText("19 of 20 selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Asset 21" })).toBeEnabled();
  });

  it("in single mode shows radios and replaces the choice", async () => {
    render(<Harness assets={tree} single />);
    expect(screen.getAllByRole("radio")).toHaveLength(6);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Main" }));
    expect(screen.getByTestId("selected")).toHaveTextContent("6");
    await userEvent.click(screen.getByRole("radio", { name: "Site" }));
    expect(screen.getByTestId("selected")).toHaveTextContent("1");
    expect(screen.getByRole("radio", { name: "Main" })).not.toBeChecked();
  });

  it("says so when there are no assets", () => {
    render(<Harness assets={[]} />);
    expect(screen.getByText("No assets yet.")).toBeInTheDocument();
  });
});
```
Run: `cd frontend && npm test -- src/components/dashboard/AssetPicker.test.tsx`. Expected: FAIL (`Failed to resolve import "./AssetPicker"`).

Create `frontend/src/components/dashboard/AssetPicker.tsx`:
```tsx
import { useId, useMemo } from "react";
import type { Asset } from "../../api/types";
import { buildTree, type TreeNode } from "../../lib/tree";

export interface PickerRow { id: number; name: string; depth: number; parentPath: string; duplicate: boolean }

/** Tree order (parents first) with each asset's depth and its parent's path; `duplicate` flags names used by more than one asset. */
export function pickerRows(assets: Asset[]): PickerRow[] {
  const rows: PickerRow[] = [];
  const walk = (nodes: TreeNode[], depth: number, parentPath: string) => {
    for (const node of nodes) {
      rows.push({ id: node.id, name: node.name, depth, parentPath, duplicate: false });
      walk(node.children, depth + 1, parentPath === "" ? node.name : `${parentPath} / ${node.name}`);
    }
  };
  walk(buildTree(assets), 0, "");
  const count = new Map<string, number>();
  for (const row of rows) count.set(row.name, (count.get(row.name) ?? 0) + 1);
  return rows.map((row) => ({ ...row, duplicate: (count.get(row.name) ?? 0) > 1 }));
}

interface Props {
  assets: Asset[];
  selected: number[];
  onChange: (ids: number[]) => void;
  /** One asset only (stat, gauge): radios instead of checkboxes. */
  single: boolean;
  /** Most assets a widget may have (checkboxes stop at this). */
  max: number;
}

/** The asset tree as indented checkboxes (radios when single); a name used twice shows its parent path. */
export function AssetPicker({ assets, selected, onChange, single, max }: Props) {
  const group = useId();
  const rows = useMemo(() => pickerRows(assets), [assets]);
  const chosen = new Set(selected);
  const full = !single && selected.length >= max;
  const toggle = (id: number, on: boolean) => onChange(single ? [id] : on ? [...selected, id] : selected.filter((x) => x !== id));
  return (
    <fieldset className="asset-picker">
      <legend>{single ? "Asset" : "Assets"}</legend>
      {rows.length === 0 && <p className="muted">No assets yet.</p>}
      <div className="picker-list">
        {rows.map((row) => (
          <label key={row.id} className="picker-row" style={{ paddingLeft: row.depth * 16 }}>
            <input
              type={single ? "radio" : "checkbox"}
              name={single ? group : undefined}
              checked={chosen.has(row.id)}
              disabled={full && !chosen.has(row.id)}
              onChange={(e) => toggle(row.id, e.target.checked)}
            />
            {row.name}{row.duplicate ? ` (${row.parentPath || "top level"})` : ""}
          </label>
        ))}
      </div>
      {!single && <p className="muted">{selected.length} of {max} selected</p>}
    </fieldset>
  );
}
```
Run again: expect all pass.

- [ ] **Step 6: `WidgetEditor`, test first**

Create `frontend/src/components/dashboard/WidgetEditor.test.tsx`:
```tsx
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toDrafts, type DraftWidget } from "../../lib/layout";
import { assetList, authed, config, widget, widgetDataRoute } from "../../test/dashboardFixtures";
import { mockFetch } from "../../test/fetchMock";
import { renderWithProviders } from "../../test/render";
import { WidgetEditor } from "./WidgetEditor";

vi.mock("echarts-for-react", () => ({ default: (props: { option: unknown }) => <pre data-testid="chart">{JSON.stringify(props.option)}</pre> }));

type Call = { method: string; path: string; body: unknown };
function open(initial: DraftWidget | null = null) {
  const calls = mockFetch({ ...authed("operator"), "POST /api/widget-data": widgetDataRoute });
  const onSave = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(<WidgetEditor initial={initial} assets={assetList} dashboardRange="24h" timezone="Asia/Qatar" onSave={onSave} onClose={onClose} />);
  return { calls, onSave, onClose };
}
const save = () => screen.getByRole("button", { name: "Save widget" });
const previews = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/widget-data");
const optionTexts = (label: string) => within(screen.getByLabelText(label)).getAllByRole("option").map((o) => o.textContent);
const power = { assets: [5], source: "metric", metric: "active_power_kw", aggregation: "avg", range: null, bars: "asset", min: 0, max: null };

describe("WidgetEditor", () => {
  it("starts blank: Save is disabled, the form says what is missing, and nothing is previewed", () => {
    const { calls } = open();
    expect(screen.getByRole("dialog", { name: "Add widget" })).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(screen.getByText("Enter a title.")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one asset.")).toBeInTheDocument();
    expect(screen.getByText("Complete the form to see a preview.")).toBeInTheDocument();
    expect(previews(calls)).toHaveLength(0);
  });

  it("previews with the exact widget-data request once the form is valid, then saves", async () => {
    const { calls, onSave } = open();
    await userEvent.type(screen.getByLabelText("Title"), "Hall power");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    expect(save()).toBeEnabled();
    await screen.findByTestId("chart");
    expect(previews(calls)[0].body).toEqual({ type: "timeseries", range: "24h", config: power });
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({ type: "timeseries", title: "Hall power", config: power });
  });

  it("lets a widget override the dashboard range, and go back to inheriting it", async () => {
    const { calls, onSave } = open();
    await userEvent.type(screen.getByLabelText("Title"), "T");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    expect(within(screen.getByLabelText("Widget range")).getAllByRole("option")[0]).toHaveTextContent("Use dashboard range");
    await userEvent.selectOptions(screen.getByLabelText("Widget range"), "7d");
    await waitFor(() => expect(previews(calls).some((c) => (c.body as { range: string }).range === "7d")).toBe(true));
    await userEvent.click(save());
    expect(onSave.mock.calls[0][0].config.range).toBe("7d");
    await userEvent.selectOptions(screen.getByLabelText("Widget range"), "Use dashboard range");
    await userEvent.click(save());
    expect(onSave.mock.calls[1][0].config.range).toBeNull();
  });

  it("makes a stat single-select", async () => {
    open();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "stat");
    expect(screen.getAllByRole("radio")).toHaveLength(assetList.length);
    await userEvent.click(screen.getByRole("radio", { name: "LV Panel 1" }));
    await userEvent.click(screen.getByRole("radio", { name: "LV Panel 2" }));
    expect(screen.getByRole("radio", { name: "LV Panel 1" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "LV Panel 2" })).toBeChecked();
  });

  it("keeps only the first asset when a multi-asset widget becomes a gauge", async () => {
    open();
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 2" }));
    await userEvent.selectOptions(screen.getByLabelText("Type"), "gauge");
    expect(screen.getByRole("radio", { name: "LV Panel 1" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "LV Panel 2" })).not.toBeChecked();
  });

  it("enforces the gauge rules: a metric, the latest value, and a maximum above the minimum", async () => {
    const { onSave } = open();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "gauge");
    expect(optionTexts("Source")).toEqual(["Metric"]);
    expect(optionTexts("Aggregation")).toEqual(["Latest"]);
    await userEvent.type(screen.getByLabelText("Title"), "Load");
    await userEvent.click(screen.getByRole("radio", { name: "LV Panel 1" }));
    expect(save()).toBeDisabled();
    expect(screen.getByText("Enter a number for the gauge minimum and maximum.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Gauge maximum"), "0");
    expect(screen.getByText("The gauge maximum must be greater than the minimum.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Gauge maximum"));
    await userEvent.type(screen.getByLabelText("Gauge maximum"), "250");
    expect(save()).toBeEnabled();
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({
      type: "gauge", title: "Load",
      config: { assets: [5], source: "metric", metric: "active_power_kw", aggregation: "last", range: null, bars: "asset", min: 0, max: 250 },
    });
  });

  it("offers only a total for energy, and no metric choice", async () => {
    const { calls } = open();
    expect(optionTexts("Metric")).toHaveLength(8);
    await userEvent.selectOptions(screen.getByLabelText("Source"), "energy");
    expect(screen.queryByLabelText("Metric")).not.toBeInTheDocument();
    expect(optionTexts("Aggregation")).toEqual(["Total"]);
    await userEvent.type(screen.getByLabelText("Title"), "kWh");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await waitFor(() => expect(previews(calls)).toHaveLength(1));
    expect(previews(calls)[0].body).toEqual({ type: "timeseries", range: "24h", config: { ...power, source: "energy", metric: null, aggregation: "sum" } });
  });

  it("shows the bars choice for bar widgets only", async () => {
    const { onSave } = open();
    expect(screen.queryByLabelText("Bars")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "bar");
    await userEvent.selectOptions(screen.getByLabelText("Bars"), "time");
    await userEvent.type(screen.getByLabelText("Title"), "B");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(save());
    expect(onSave.mock.calls[0][0].config.bars).toBe("time");
  });

  it("edits an existing widget and drops assets that no longer exist, saying so", async () => {
    const [draft] = toDrafts([widget(1, "table", { title: "Assets", config: config({ assets: [5, 99] }) })]);
    const { onSave } = open(draft);
    expect(screen.getByRole("dialog", { name: "Edit widget" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Assets");
    expect(screen.getByRole("checkbox", { name: "LV Panel 1" })).toBeChecked();
    expect(screen.getByText(/1 removed asset was dropped/)).toBeInTheDocument();
    await userEvent.click(save());
    expect(onSave.mock.calls[0][0]).toEqual({ type: "table", title: "Assets", config: config({ assets: [5] }) });
  });

  it("is a modal dialog: focus starts on the title, stays inside, Escape closes without saving, focus returns to the opener", async () => {
    const opener = document.createElement("button");
    const outside = document.createElement("button");
    document.body.append(opener, outside);
    try {
      opener.focus();
      const { onSave, onClose } = open();
      const dialog = screen.getByRole("dialog", { name: "Add widget" });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(screen.getByLabelText("Title")).toHaveFocus();
      outside.focus();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSave).not.toHaveBeenCalled();
      cleanup();
      expect(opener).toHaveFocus();
    } finally {
      opener.remove();
      outside.remove();
    }
  });
});
```
Run: `cd frontend && npm test -- src/components/dashboard/WidgetEditor.test.tsx`. Expected: FAIL (`Failed to resolve import "./WidgetEditor"`).

Create `frontend/src/components/dashboard/WidgetEditor.tsx`:
```tsx
import { useId, useMemo, useRef, useState } from "react";
import { WIDGET_TYPES, type Asset, type RangePreset, type WidgetConfig, type WidgetSource, type WidgetType } from "../../api/types";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import {
  AGGREGATION_LABELS, allowedAggregations, allowedSources, blankForm, formFromDraft, formIssues, formToFields, isSingleAsset,
  MAX_ASSETS, MAX_TEXT, SOURCE_LABELS, TYPE_LABELS, WIDGET_METRICS, withSource, withType,
  type Aggregation, type WidgetForm, type WidgetMetric,
} from "../../lib/dashboardEdit";
import type { DraftWidget } from "../../lib/layout";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";
import { AssetPicker } from "./AssetPicker";
import { WidgetView } from "./WidgetView";

export interface EditorFields { type: WidgetType; title: string; config: WidgetConfig }

interface Props {
  /** The widget being edited, or null to add a new one. */
  initial: DraftWidget | null;
  assets: Asset[];
  dashboardRange: RangePreset;
  timezone: string;
  onSave: (fields: EditorFields) => void;
  onClose: () => void;
}

/**
 * Add or edit one widget. Nothing leaves the dialog until "Save widget"; Save stays disabled until the form follows the
 * API's rules, and the preview (the real widget, via POST /api/widget-data) appears once it does.
 */
export function WidgetEditor({ initial, assets, dashboardRange, timezone, onSave, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const field = (name: string) => `${id}-${name}`;
  const known = useMemo(() => new Set(assets.map((a) => a.id)), [assets]);
  const [dropped] = useState(() => (initial ? initial.config.assets.filter((a) => !known.has(a)).length : 0));
  const [form, setForm] = useState<WidgetForm>(() => {
    if (!initial) return blankForm();
    const loaded = formFromDraft(initial);
    return { ...loaded, assets: loaded.assets.filter((a) => known.has(a)) };
  });
  useDialogFocus(root, onClose, { initial: titleInput });

  const patch = (changes: Partial<WidgetForm>) => setForm((current) => ({ ...current, ...changes }));
  const messages = Object.values(formIssues(form)).filter((m): m is string => m !== undefined);
  const fields = useMemo(() => formToFields(form), [form]);
  const heading = initial ? "Edit widget" : "Add widget";

  return (
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-label={heading} className="dialog">
        <h2>{heading}</h2>
        <div className="editor-cols">
          <div>
            <div className="field">
              <label htmlFor={field("type")}>Type</label>
              <select id={field("type")} value={form.type} onChange={(e) => setForm((f) => withType(f, e.target.value as WidgetType))}>
                {WIDGET_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={field("title")}>Title</label>
              <input id={field("title")} ref={titleInput} value={form.title} maxLength={MAX_TEXT} onChange={(e) => patch({ title: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={field("source")}>Source</label>
              <select id={field("source")} value={form.source} onChange={(e) => setForm((f) => withSource(f, e.target.value as WidgetSource))}>
                {allowedSources(form.type).map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
              </select>
            </div>
            {form.source === "metric" && (
              <div className="field">
                <label htmlFor={field("metric")}>Metric</label>
                <select id={field("metric")} value={form.metric} onChange={(e) => patch({ metric: e.target.value as WidgetMetric })}>
                  {WIDGET_METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor={field("aggregation")}>Aggregation</label>
              <select id={field("aggregation")} value={form.aggregation} onChange={(e) => patch({ aggregation: e.target.value as Aggregation })}>
                {allowedAggregations(form.type, form.source).map((a) => <option key={a} value={a}>{AGGREGATION_LABELS[a]}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={field("range")}>Widget range</label>
              <select id={field("range")} value={form.range} onChange={(e) => patch({ range: e.target.value as RangePreset | "" })}>
                <option value="">Use dashboard range</option>
                {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
              </select>
            </div>
            {form.type === "bar" && (
              <div className="field">
                <label htmlFor={field("bars")}>Bars</label>
                <select id={field("bars")} value={form.bars} onChange={(e) => patch({ bars: e.target.value as "asset" | "time" })}>
                  <option value="asset">One bar per asset</option>
                  <option value="time">One bar per time bucket</option>
                </select>
              </div>
            )}
            {form.type === "gauge" && (
              <div className="row">
                <div className="field">
                  <label htmlFor={field("gmin")}>Gauge minimum</label>
                  <input id={field("gmin")} type="number" step="any" value={form.gaugeMin} onChange={(e) => patch({ gaugeMin: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor={field("gmax")}>Gauge maximum</label>
                  <input id={field("gmax")} type="number" step="any" value={form.gaugeMax} onChange={(e) => patch({ gaugeMax: e.target.value })} />
                </div>
              </div>
            )}
          </div>
          <div>
            <AssetPicker assets={assets} selected={form.assets} onChange={(ids) => patch({ assets: ids })} single={isSingleAsset(form.type)} max={MAX_ASSETS} />
            {dropped > 0 && <p className="muted">{dropped} removed asset{dropped === 1 ? " was" : "s were"} dropped from this widget.</p>}
            <h3>Preview</h3>
            {messages.length === 0 ? (
              <div className="widget-preview">
                <WidgetView
                  widgetKey="preview" type={fields.type} title={fields.title} config={fields.config}
                  dashboardRange={dashboardRange} timezone={timezone} csv={false} live={false}
                />
              </div>
            ) : (
              <p className="muted">Complete the form to see a preview.</p>
            )}
          </div>
        </div>
        {messages.length > 0 && <ul className="muted issues">{messages.map((m) => <li key={m}>{m}</li>)}</ul>}
        <div className="row">
          <button type="button" onClick={() => onSave(fields)} disabled={messages.length > 0}>Save widget</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
```
Run again: expect all pass.

- [ ] **Step 7: `DashboardGrid`, test first**

Create `frontend/src/components/dashboard/DashboardGrid.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { noCompactor } from "react-grid-layout";
import { GRID_GAP, ROW_HEIGHT } from "../../lib/gridMetrics";
import { GRID_COLS, toDrafts } from "../../lib/layout";
import { widget } from "../../test/dashboardFixtures";
import { DashboardGrid } from "./DashboardGrid";

// jsdom cannot measure or drag. The grid is replaced by a plain box that exposes the props the component wires up,
// and `move-{key}` / `resize-{key}` play a finished drag or resize of that widget.
const grid = vi.hoisted(() => ({ props: null as Record<string, any> | null }));
vi.mock("react-grid-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-grid-layout")>();
  return {
    ...actual,
    default: (props: Record<string, any>) => {
      grid.props = props;
      return (
        <div data-testid="rgl">
          {props.children}
          {props.layout.map((item: { i: string }) => (
            <span key={item.i}>
              <button data-testid={`move-${item.i}`} onClick={() => props.onDragStop(props.layout.map((l: any) => (l.i === item.i ? { ...l, x: 4, y: 7 } : l)))} />
              <button data-testid={`resize-${item.i}`} onClick={() => props.onResizeStop(props.layout.map((l: any) => (l.i === item.i ? { ...l, w: 9, h: 5 } : l)))} />
            </span>
          ))}
        </div>
      );
    },
    useContainerWidth: () => ({ width: 1000, mounted: true, containerRef: { current: null }, measureWidth: () => {} }),
  };
});

const drafts = () => toDrafts([
  widget(1, "stat", { title: "Now", x: 0, y: 0, w: 3, h: 2 }),
  widget(2, "table", { title: "All", x: 3, y: 0, w: 6, h: 3 }),
]);
const show = (onChange = vi.fn()) => {
  const d = drafts();
  render(<DashboardGrid drafts={d} onChange={onChange} renderWidget={(w) => <p>{w.title}</p>} />);
  return { d, onChange };
};

describe("DashboardGrid", () => {
  it("lays the drafts out on the shared 12-column grid, uncompacted, with drag and resize handles", () => {
    const { d } = show();
    expect(screen.getByText("Now")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
    const props = grid.props!;
    expect(props.width).toBe(1000);
    expect(props.gridConfig).toMatchObject({ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: [GRID_GAP, GRID_GAP], containerPadding: [0, 0] });
    expect(props.dragConfig).toMatchObject({ enabled: true, handle: ".widget-drag-handle", cancel: ".widget-actions" });
    expect(props.resizeConfig).toMatchObject({ enabled: true, handles: ["se", "e", "s"] });
    expect(props.compactor).toBe(noCompactor);
    expect(props.layout.map(({ i, x, y, w, h }: Record<string, unknown>) => ({ i, x, y, w, h }))).toEqual(d.map(({ key, x, y, w, h }) => ({ i: key, x, y, w, h })));
  });

  it("changes nothing on its own", () => {
    const { onChange } = show();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports a finished drag as the drafts with the new position, everything else untouched", async () => {
    const { d, onChange } = show();
    await userEvent.click(screen.getByTestId(`move-${d[0].key}`));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual([{ ...d[0], x: 4, y: 7 }, d[1]]);
  });

  it("hands back the very same drafts when a drag ends where it started, so it is not an edit", () => {
    const { d, onChange } = show();
    grid.props!.onDragStop(grid.props!.layout);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe(d);
  });

  it("reports a finished resize the same way", async () => {
    const { d, onChange } = show();
    await userEvent.click(screen.getByTestId(`resize-${d[1].key}`));
    expect(onChange.mock.calls[0][0]).toEqual([d[0], { ...d[1], w: 9, h: 5 }]);
  });
});
```
Run: `cd frontend && npm test -- src/components/dashboard/DashboardGrid.test.tsx`. Expected: FAIL (`Failed to resolve import "./DashboardGrid"`).

Create `frontend/src/components/dashboard/DashboardGrid.tsx`:
```tsx
import ReactGridLayout, { noCompactor, useContainerWidth, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { ReactNode } from "react";
import { GRID_GAP, ROW_HEIGHT } from "../../lib/gridMetrics";
import { applyGrid, GRID_COLS, toGrid, type DraftWidget } from "../../lib/layout";

interface Props {
  drafts: DraftWidget[];
  onChange: (next: DraftWidget[]) => void;
  /** The widget box for one draft; the grid moves and resizes it (grab it by `.widget-drag-handle`). */
  renderWidget: (draft: DraftWidget) => ReactNode;
}

/**
 * The editor's grid: 12 columns, drag by the widget's title bar, resize from the corner and edges. It never compacts,
 * so the saved x/y/w/h are exactly what is on screen, and the read-only CSS grid draws the same cells. Only finished
 * drags and resizes are reported (the library also reports on mount, which would make every dashboard look edited).
 */
export function DashboardGrid({ drafts, onChange, renderWidget }: Props) {
  const { width, containerRef, mounted } = useContainerWidth();
  // applyGrid takes the library's readonly layout as it is, and returns the same drafts when nothing moved.
  const commit = (layout: Layout) => onChange(applyGrid(drafts, layout));
  return (
    <div ref={containerRef} className="dash-grid-edit">
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={toGrid(drafts)}
          gridConfig={{ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: [GRID_GAP, GRID_GAP], containerPadding: [0, 0] }}
          dragConfig={{ enabled: true, handle: ".widget-drag-handle", cancel: ".widget-actions" }}
          resizeConfig={{ enabled: true, handles: ["se", "e", "s"] }}
          compactor={noCompactor}
          onDragStop={commit}
          onResizeStop={commit}
        >
          {drafts.map((draft) => <div key={draft.key}>{renderWidget(draft)}</div>)}
        </ReactGridLayout>
      )}
    </div>
  );
}
```
Run again: expect pass.

- [ ] **Step 8: `DashboardEditor` and the page, tests first**

Create `frontend/src/pages/DashboardPage.edit.test.tsx`:
```tsx
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role } from "../api/types";
import { defaultSize, nextPosition, toDrafts } from "../lib/layout";
import { assetList, authed, config, dashboard, widget, widgetDataRoute } from "../test/dashboardFixtures";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithDataRouter } from "../test/render";
import { DashboardPage } from "./DashboardPage";

vi.mock("echarts-for-react", () => ({ default: (props: { option: unknown }) => <pre data-testid="chart">{JSON.stringify(props.option)}</pre> }));

// Same stand-in for the grid as DashboardGrid.test.tsx: `move-{key}` and `resize-{key}` play a finished drag or resize.
vi.mock("react-grid-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-grid-layout")>();
  return {
    ...actual,
    default: (props: Record<string, any>) => (
      <div data-testid="rgl">
        {props.children}
        {props.layout.map((item: { i: string }) => (
          <span key={item.i}>
            <button data-testid={`move-${item.i}`} onClick={() => props.onDragStop(props.layout.map((l: any) => (l.i === item.i ? { ...l, x: 4, y: 7 } : l)))} />
            <button data-testid={`resize-${item.i}`} onClick={() => props.onResizeStop(props.layout.map((l: any) => (l.i === item.i ? { ...l, w: 9, h: 5 } : l)))} />
          </span>
        ))}
      </div>
    ),
    useContainerWidth: () => ({ width: 1000, mounted: true, containerRef: { current: null }, measureWidth: () => {} }),
  };
});

class FakeEventSource {
  onmessage = null;
  onopen = null;
  onerror = null;
  constructor(public url: string) {}
  close() {}
}
beforeEach(() => vi.stubGlobal("EventSource", FakeEventSource));

type Call = { method: string; path: string; body: unknown };
const now = widget(1, "stat", { title: "Current power", config: config({ aggregation: "last" }), x: 0, y: 0, w: 3, h: 2 });
const base = dashboard({ widgets: [now] });
const putBody = (calls: Call[]) => calls.find((c) => c.method === "PUT")?.body;
const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

function open(role: Role, entry: string | { pathname: string; state?: unknown } = "/dashboards/3", over: Routes = {}) {
  const calls = mockFetch({
    ...authed(role),
    "GET /api/dashboards/3": { body: base },
    "GET /api/assets": { body: assetList },
    "POST /api/widget-data": widgetDataRoute,
    // The server's answer to a save: the sent dashboard with new widget ids and a later updated_at.
    "PUT /api/dashboards/3": ({ body }) => {
      const sent = body as { name: string; range: string; widgets: object[] };
      return { body: { ...base, name: sent.name, range: sent.range, updated_at: "2026-10-08T07:00:00+00:00", widgets: sent.widgets.map((w, i) => ({ id: 100 + i, ...w })) } };
    },
    ...over,
  });
  const view = renderWithDataRouter(<DashboardPage />, { route: entry, path: "/dashboards/:id" });
  return { calls, ...view };
}
const add = () => screen.getByRole("button", { name: "Add widget" });
const saveButton = () => screen.getByRole("button", { name: "Save" });
async function startEditing() {
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByLabelText("Dashboard name");
  await waitFor(() => expect(add()).toBeEnabled()); // the asset list has arrived
}

describe("who can edit", () => {
  it("never shows edit mode to a viewer, even when asked for through the router state", async () => {
    open("viewer", { pathname: "/dashboards/3", state: { edit: true } });
    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Dashboard name")).not.toBeInTheDocument();
  });

  it("lets an operator enter edit mode and cancel back to the view, saving nothing", async () => {
    const { calls } = open("operator");
    await startEditing();
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A");
    expect(screen.getByLabelText("Dashboard range")).toHaveValue("24h");
    expect(saveButton()).toBeDisabled(); // nothing changed yet
    await userEvent.type(screen.getByLabelText("Dashboard name"), " renamed");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Hall A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);
  });

  it("opens straight in edit mode after a dashboard was just created, and forgets the router state when it leaves", async () => {
    const { router } = open("operator", { pathname: "/dashboards/3", state: { edit: true } });
    await screen.findByLabelText("Dashboard name");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(router.state.location.state).toBeNull());
  });
});

describe("editing", () => {
  it("adds a widget, saves the exact body, and returns to the view with the server's dashboard", async () => {
    const { calls } = open("operator");
    await startEditing();
    await userEvent.click(add());
    await userEvent.type(screen.getByLabelText("Title"), "Hall power");
    await userEvent.click(screen.getByRole("checkbox", { name: "LV Panel 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save widget" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Hall power" })).toBeInTheDocument();
    await userEvent.click(saveButton());
    const size = defaultSize("timeseries");
    expect(putBody(calls)).toEqual({
      name: "Hall A", range: "24h", updated_at: "2026-10-08T06:00:00+00:00",
      widgets: [
        { type: "stat", title: "Current power", config: now.config, x: 0, y: 0, w: 3, h: 2 },
        {
          type: "timeseries", title: "Hall power",
          config: { assets: [5], source: "metric", metric: "active_power_kw", aggregation: "avg", range: null, bars: "asset", min: 0, max: null },
          ...nextPosition(toDrafts(base.widgets), size), ...size,
        },
      ],
    });
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Hall power" })).toBeInTheDocument();
  });

  it("edits a widget in place", async () => {
    const { calls } = open("operator");
    await startEditing();
    await userEvent.click(screen.getByRole("button", { name: "Edit Current power" }));
    expect(screen.getByRole("dialog", { name: "Edit widget" })).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Now");
    await userEvent.click(screen.getByRole("button", { name: "Save widget" }));
    await userEvent.click(saveButton());
    expect((putBody(calls) as { widgets: unknown[] }).widgets).toEqual([{ type: "stat", title: "Now", config: now.config, x: 0, y: 0, w: 3, h: 2 }]);
  });

  it("deletes a widget from the draft and saves the empty list", async () => {
    const { calls } = open("operator");
    await startEditing();
    await userEvent.click(screen.getByRole("button", { name: "Delete Current power" }));
    expect(screen.queryByRole("region", { name: "Current power" })).not.toBeInTheDocument();
    expect(screen.getByText("No widgets yet. Use Add widget.")).toBeInTheDocument();
    await userEvent.click(saveButton());
    expect((putBody(calls) as { widgets: unknown[] }).widgets).toEqual([]);
  });

  it("saves a new name and range", async () => {
    const { calls } = open("operator");
    await startEditing();
    const name = screen.getByLabelText("Dashboard name");
    await userEvent.clear(name);
    await userEvent.type(name, "  Hall A2 ");
    await userEvent.selectOptions(screen.getByLabelText("Dashboard range"), "7d");
    await userEvent.click(saveButton());
    expect(putBody(calls)).toMatchObject({ name: "Hall A2", range: "7d", updated_at: "2026-10-08T06:00:00+00:00" });
    expect(await screen.findByRole("heading", { name: "Hall A2" })).toBeInTheDocument(); // the server's copy, although GET still answers the old one
    expect(screen.getByLabelText("Dashboard range")).toHaveValue("7d");
  });

  it("saves the position and size a drag and a resize produced", async () => {
    const { calls } = open("operator");
    await startEditing();
    await userEvent.click(await screen.findByTestId(/^move-/));
    await userEvent.click(screen.getByTestId(/^resize-/));
    await userEvent.click(saveButton());
    expect((putBody(calls) as { widgets: unknown[] }).widgets).toEqual([{ type: "stat", title: "Current power", config: now.config, x: 4, y: 7, w: 9, h: 5 }]);
  });

  it("will not add a 25th widget", async () => {
    const full = dashboard({ widgets: Array.from({ length: 24 }, (_, i) => widget(i + 1, "stat", { title: `W${i + 1}`, x: 0, y: i * 2, w: 3, h: 2 })) });
    open("operator", "/dashboards/3", { "GET /api/dashboards/3": { body: full } });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByLabelText("Dashboard name");
    await waitFor(() => expect(screen.getByText("A dashboard can have at most 24 widgets.")).toBeInTheDocument());
    expect(add()).toBeDisabled();
  });
});

describe("saving that fails", () => {
  it("never overwrites a dashboard someone else saved: it says so and offers Reload (Review Focus 4, UI side)", async () => {
    let reads = 0;
    const newer = dashboard({ name: "Hall A (Sam)", updated_at: "2026-10-08T06:30:00+00:00", widgets: [now] });
    const { calls } = open("operator", "/dashboards/3", {
      "GET /api/dashboards/3": () => ({ body: reads++ === 0 ? base : newer }),
      "PUT /api/dashboards/3": { status: 409, body: { detail: "dashboard changed since you loaded it" } },
    });
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), " mine");
    await userEvent.click(saveButton());
    expect(await screen.findByText("This dashboard was changed by someone else")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(puts(calls)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A (Sam)"));
    expect(screen.queryByText("This dashboard was changed by someone else")).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled(); // reloaded: nothing to save, and nothing was sent behind the user's back
    expect(puts(calls)).toHaveLength(1);
  });

  it("shows the server's message, not the reload banner, when the name is taken", async () => {
    open("operator", "/dashboards/3", { "PUT /api/dashboards/3": { status: 409, body: { detail: "a dashboard with this name already exists" } } });
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), "2");
    await userEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A2");
  });

  it("keeps the edits and shows the message when the API refuses the dashboard", async () => {
    open("operator", "/dashboards/3", { "PUT /api/dashboards/3": { status: 422, body: { detail: 'widget 1 ("Current power"): assets: at most 20 assets' } } });
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), "x");
    await userEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent('widget 1 ("Current power"): assets: at most 20 assets');
    expect(saveButton()).toBeEnabled();
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall Ax");
  });
});

describe("leaving with unsaved changes", () => {
  it("asks before in-app navigation: Keep editing stays with the edits, Leave discards them", async () => {
    const { router } = open("operator");
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), " edited");
    await act(async () => { await router.navigate("/assets"); });
    const prompt = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    expect(router.state.location.pathname).toBe("/dashboards/3");
    await userEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Dashboard name")).toHaveValue("Hall A edited");
    await act(async () => { await router.navigate("/assets"); });
    await userEvent.click(await screen.findByRole("button", { name: "Leave and discard changes" }));
    expect(await screen.findByText("assets page")).toBeInTheDocument();
  });

  it("treats Escape in the prompt as Keep editing", async () => {
    const { router } = open("operator");
    await startEditing();
    await userEvent.type(screen.getByLabelText("Dashboard name"), "x");
    await act(async () => { await router.navigate("/assets"); });
    await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/dashboards/3");
  });

  it("lets a clean editor leave without asking", async () => {
    const { router } = open("operator");
    await startEditing();
    await act(async () => { await router.navigate("/assets"); });
    expect(await screen.findByText("assets page")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("warns on page close only while there are unsaved changes", async () => {
    open("operator");
    await startEditing();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await userEvent.type(screen.getByLabelText("Dashboard name"), "x");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});
```
Run: `cd frontend && npm test -- src/pages/DashboardPage.edit.test.tsx`. Expected: FAIL. Task 9's page has no Edit button, so every test that calls `startEditing` times out on `findByRole("button", { name: "Edit" })`; the viewer test passes only because nothing edits.

Create `frontend/src/components/dashboard/DashboardEditor.tsx`:
```tsx
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useBlocker, type BlockerFunction } from "react-router";
import { useAssets, useSaveDashboard } from "../../api/queries";
import type { Dashboard, RangePreset } from "../../api/types";
import { useAction } from "../../hooks/useAction";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { isDirty, isStaleConflict, MAX_TEXT, MAX_WIDGETS, saveBody } from "../../lib/dashboardEdit";
import { defaultSize, newKey, nextPosition, toDrafts, type DraftWidget } from "../../lib/layout";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";
import { DashboardGrid } from "./DashboardGrid";
import { WidgetEditor, type EditorFields } from "./WidgetEditor";
import { WidgetView } from "./WidgetView";

interface Props {
  /** The dashboard as loaded when editing started; its `updated_at` is what Save sends. Later changes to this prop are ignored. */
  dashboard: Dashboard;
  timezone: string;
  onSaved: (saved: Dashboard) => void;
  onCancel: () => void;
  /** Refetch the dashboard and restart the editor from it (discarding the drafts). */
  onReload: () => Promise<void>;
}

/** Edit mode: name, range, the draggable grid, Add/Edit/Delete widget, Save and Cancel, with a prompt before unsaved changes are lost. */
export function DashboardEditor({ dashboard, timezone, onSaved, onCancel, onReload }: Props) {
  const [baseline] = useState(dashboard);
  const assets = useAssets();
  const save = useSaveDashboard();
  const { run, busy, error } = useAction();
  const nameId = useId();
  const rangeId = useId();
  const [name, setName] = useState(baseline.name);
  const [range, setRange] = useState<RangePreset>(baseline.range);
  const [drafts, setDrafts] = useState<DraftWidget[]>(() => toDrafts(baseline.widgets));
  const [dialog, setDialog] = useState<{ draft: DraftWidget | null } | null>(null);
  /** True when a save lost a race with someone else's save (the API's "changed since you loaded it" 409). */
  const [conflict, setConflict] = useState(false);

  const edit = { name, range, drafts };
  const dirty = isDirty(baseline, edit);
  useBeforeUnload(dirty);

  const problem = name.trim() === "" ? "Enter a dashboard name." : null;
  const full = drafts.length >= MAX_WIDGETS;
  const canSave = problem === null && dirty && !busy && !conflict;
  const ready = assets.data !== undefined;

  const submit = () => run(async () => {
    try {
      onSaved(await save.mutateAsync({ id: baseline.id, body: saveBody(baseline, edit) }));
    } catch (e) {
      if (isStaleConflict(e)) {
        setConflict(true);
        return;
      }
      throw e;
    }
  });
  const reload = () => run(() => onReload());

  const accept = (fields: EditorFields) => {
    const target = dialog?.draft ?? null;
    setDrafts((current) => {
      if (target) return current.map((d) => (d.key === target.key ? { ...d, ...fields } : d));
      const size = defaultSize(fields.type);
      return [...current, { key: newKey(), ...fields, ...size, ...nextPosition(current, size) }];
    });
    setDialog(null);
  };

  const renderWidget = (d: DraftWidget) => (
    <WidgetView
      widgetKey={d.key} type={d.type} title={d.title} config={d.config} dashboardRange={range} timezone={timezone}
      csv={false} live={false} dragHandle
      actions={
        <span className="widget-actions">
          <button type="button" disabled={!ready} onClick={() => setDialog({ draft: d })} aria-label={`Edit ${d.title}`}>Edit</button>
          <button type="button" onClick={() => setDrafts((current) => current.filter((x) => x.key !== d.key))} aria-label={`Delete ${d.title}`}>Delete</button>
        </span>
      }
    />
  );

  return (
    <>
      <UnsavedGuard when={dirty} />
      <div className="row dash-head">
        <label htmlFor={nameId}>Dashboard name</label>
        <input id={nameId} value={name} maxLength={MAX_TEXT} onChange={(e) => setName(e.target.value)} />
        <label htmlFor={rangeId}>Dashboard range</label>
        <select id={rangeId} value={range} onChange={(e) => setRange(e.target.value as RangePreset)}>
          {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
        </select>
        <span className="spacer" />
        {dirty && <span className="muted">Not saved yet</span>}
        <button type="button" onClick={() => setDialog({ draft: null })} disabled={!ready || full}>Add widget</button>
        <button type="button" onClick={submit} disabled={!canSave}>Save</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      {problem && <p className="muted">{problem}</p>}
      {full && <p className="muted">A dashboard can have at most {MAX_WIDGETS} widgets.</p>}
      {assets.error && <p className="error" role="alert">Could not load the assets: {assets.error.message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {conflict && (
        <div className="panel" role="alert">
          <p>This dashboard was changed by someone else</p>
          <p className="muted">Reload shows their version and discards your edits here. Nothing was saved.</p>
          <div className="row"><button type="button" onClick={reload} disabled={busy}>Reload</button></div>
        </div>
      )}
      <p className="muted">Drag a widget by its title bar and resize it from the corner or the edges. Nothing is saved until you press Save.</p>
      {drafts.length === 0 ? <p className="muted">No widgets yet. Use Add widget.</p> : <DashboardGrid drafts={drafts} onChange={setDrafts} renderWidget={renderWidget} />}
      {dialog && assets.data && (
        <WidgetEditor
          initial={dialog.draft} assets={assets.data} dashboardRange={range} timezone={timezone}
          onSave={accept} onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

/** Ask the browser to confirm closing or reloading the page while there is something unsaved. */
function useBeforeUnload(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}

/** Blocks in-app navigation to another page (not a same-page replace) while `when`, and asks. */
function UnsavedGuard({ when }: { when: boolean }) {
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname,
    [when],
  );
  const blocker = useBlocker(shouldBlock);
  if (blocker.state !== "blocked") return null;
  return <LeaveDialog onStay={() => blocker.reset()} onLeave={() => blocker.proceed()} />;
}

function LeaveDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useDialogFocus(root, onStay);
  return (
    <div className="dialog-backdrop">
      <div ref={root} role="alertdialog" aria-modal="true" aria-label="Unsaved changes" className="dialog narrow">
        <h2>Unsaved changes</h2>
        <p>This dashboard has changes that are not saved. If you leave now they are lost.</p>
        <div className="row">
          <button type="button" onClick={onStay}>Keep editing</button>
          <button type="button" onClick={onLeave}>Leave and discard changes</button>
        </div>
      </div>
    </div>
  );
}
```

Replace `frontend/src/pages/DashboardPage.tsx` entirely:
```tsx
import { lazy, Suspense, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useDashboard, useSite } from "../api/queries";
import type { Dashboard } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { DashboardViewer } from "../components/dashboard/DashboardViewer";
import { LiveValuesProvider } from "../components/dashboard/LiveValuesContext";
import { newest } from "../lib/dashboardEdit";

// The editor brings react-grid-layout with it: it loads only when someone starts editing (spec 10.8).
const DashboardEditor = lazy(() => import("../components/dashboard/DashboardEditor").then((m) => ({ default: m.DashboardEditor })));

export function DashboardPage() {
  const id = Number(useParams().id);
  // Keyed by id so moving from one dashboard to another starts from a clean slate.
  return <DashboardScreen key={id} id={id} />;
}

function DashboardScreen({ id }: { id: number }) {
  const { hasRole } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const query = useDashboard(id);
  const site = useSite();
  // Edit mode starts when the create dialog sent us here with { edit: true }; viewers never get it (see canEdit below).
  const [wantsEdit, setWantsEdit] = useState(() => (location.state as { edit?: boolean } | null)?.edit === true);
  // The copy the server returned from our last save (or from Reload); the cache may briefly still hold an older one.
  const [saved, setSaved] = useState<Dashboard | null>(null);
  const [epoch, setEpoch] = useState(0);
  const canEdit = hasRole("operator");
  const dashboard = newest(saved, query.data);

  if (query.isLoading || site.isLoading) return <p className="muted">loading…</p>;
  const failure = query.error ?? site.error;
  if (failure || !dashboard || !site.data) return <p className="error" role="alert">{failure?.message ?? "not found"}</p>;
  const timezone = site.data.timezone;
  const crumbs = <p><Link to="/dashboards">Dashboards</Link> / {dashboard.name}</p>;

  const leaveEdit = () => {
    setWantsEdit(false);
    // Forget the { edit: true } the create dialog left in the history entry, or a refresh would reopen the editor.
    if (location.state) navigate(location.pathname + location.search, { replace: true, state: null });
  };

  if (canEdit && wantsEdit) {
    return (
      <>
        {crumbs}
        <Suspense fallback={<p className="muted">loading editor…</p>}>
          <DashboardEditor
            key={epoch}
            dashboard={dashboard}
            timezone={timezone}
            onSaved={(next) => { setSaved(next); leaveEdit(); }}
            onCancel={leaveEdit}
            onReload={async () => {
              const fresh = await query.refetch();
              if (fresh.error) throw fresh.error;
              setSaved(fresh.data ?? null);
              setEpoch((n) => n + 1);
            }}
          />
        </Suspense>
      </>
    );
  }
  return (
    <>
      {crumbs}
      <LiveValuesProvider>
        <DashboardViewer dashboard={dashboard} timezone={timezone} onEdit={canEdit ? () => setWantsEdit(true) : undefined} />
      </LiveValuesProvider>
    </>
  );
}
```
Run: `cd frontend && npm test -- src/pages/DashboardPage.edit.test.tsx src/pages/DashboardPage.test.tsx`. Expected: all pass (the edit tests, and Task 9's view tests, which still use `renderWithProviders`).

- [ ] **Step 9: Styles**

Append to `frontend/src/app.css` (end of file):
```css

/* Dashboard editor */
.dash-grid-edit { margin-top: 8px; }
.dash-grid-edit .widget-drag-handle { cursor: grab; }
.dash-grid-edit .react-grid-item > .react-resizable-handle { opacity: 1; }
.dash-grid-edit .react-grid-item.react-grid-placeholder { background: #000; }
.widget-actions { display: inline-flex; gap: 4px; }
.widget-actions button { padding: 0 6px; font-size: 12px; }
.editor-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.editor-cols > div { display: grid; gap: 8px; align-content: start; }
.editor-cols h3 { margin: 0; font-size: 14px; }
.widget-preview { height: 260px; }
.asset-picker { max-width: none; }
.picker-list { max-height: 220px; overflow: auto; border: 1px solid #000; padding: 4px; }
.picker-row { display: flex; gap: 6px; align-items: center; }
.issues { margin: 0; padding-left: 18px; }
@media (max-width: 700px) {
  .editor-cols { grid-template-columns: minmax(0, 1fr); }
}
```

- [ ] **Step 10: Verify everything**

```bash
cd frontend && npm run typecheck && npm test && npm run build
# The grid library and ECharts must stay out of the main chunk (spec 10.8). The main chunk is the script index.html loads.
main=$(grep -o 'assets/index-[^"]*\.js' dist/index.html | head -1); echo "main chunk: $main"
grep -c "react-grid-item" "dist/$main"      # expect 0
grep -c "_echarts_instance_" "dist/$main"   # expect 0 (a string literal ECharts keeps through minification)
grep -l "react-grid-item" dist/assets/*.js  # expect: one or more other chunks (the grid, loaded when someone edits)
grep -l "_echarts_instance_" dist/assets/*.js   # expect: other chunks only (the chart widgets and the asset-page chart); if this prints nothing the marker is wrong, not the split
```
Expected: typecheck clean; the whole suite green (the new files, Task 9's view tests, App.test.tsx and every earlier test: the router change touches only `main.tsx`); the build succeeds; both `grep -c` print `0` and both `grep -l` list files that are not the main chunk. If the main chunk contains either string, a static import of the grid or of ECharts slipped in: find it (`grep -rn "react-grid-layout\|echarts" src --include=*.tsx -l`) and make it a `React.lazy` import; only `DashboardGrid.tsx` and the three chart widgets may import those libraries. Fix type errors in files you wrote here only (for example, if the ECharts or react-grid-layout types reject a prop, adjust the prop in your file, never the tested values).

Report anything the end-to-end task (Task 11) must know: edit mode is entered by the "Edit" button (or by the create dialog's router state); drag and resize are pointer-only (react-grid-layout has no keyboard mode), so e2e drives them with the mouse on `.widget-drag-handle` and `.react-resizable-handle`.

- [ ] **Step 11: Commit**

```bash
cd /home/ziad/Projects/DC_Dashboard && git add \
  frontend/src/main.tsx frontend/src/test/render.tsx frontend/src/app.css \
  frontend/src/lib/dashboardEdit.ts frontend/src/lib/dashboardEdit.test.ts \
  frontend/src/components/dashboard/AssetPicker.tsx frontend/src/components/dashboard/AssetPicker.test.tsx \
  frontend/src/components/dashboard/WidgetEditor.tsx frontend/src/components/dashboard/WidgetEditor.test.tsx \
  frontend/src/components/dashboard/DashboardGrid.tsx frontend/src/components/dashboard/DashboardGrid.test.tsx \
  frontend/src/components/dashboard/DashboardEditor.tsx \
  frontend/src/pages/DashboardPage.tsx frontend/src/pages/DashboardPage.edit.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): dashboard editor (drag-and-resize grid, widget editor, safe save)

Edit mode for operators and admins: react-grid-layout grid (12 columns, no
compaction, lazy-loaded), Add/Edit/Delete widget in an accessible dialog with an
asset picker (20-asset cap, single-select for stat/gauge) and a live preview,
rename and range, one PUT with the loaded updated_at. A 409 for a lost race
shows "changed by someone else" with Reload and never overwrites; a taken name
shows the server's message. Unsaved changes prompt via useBlocker and
beforeunload.

main.tsx moves to a data router (createBrowserRouter with one catch-all route
rendering App), because useBlocker does not work under BrowserRouter; test/render.tsx gains
renderWithDataRouter.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

### Task 11: End-to-end journey, README and the done-when check

Proves Phase 3 in a real browser on the state the earlier e2e projects leave behind, documents it for a human, and runs the phase's done-when check (full unit suites, bundle, the ISOLATED end-to-end run, the rebuilt normal stack, `scripts/smoke.py`). The only product code touched is a safety fix to the e2e guard message.

**DATA SAFETY (read before running anything).** The owner's dev data lives in the Docker volume `dcdash_dbdata` (default Compose project `dcdash`). NEVER run `scripts/e2e.sh`, NEVER run `docker compose down -v` (or `down --volumes`) on the default project: either deletes that volume. The end-to-end run uses only `docker compose -p dcdash_e2e ...` (its own `dcdash_e2e_dbdata` volume), with the normal stack stopped first (`docker compose --profile dev stop`, never with `-v`). Never reset the admin password, re-run setup, or recreate a volume to "fix" anything.

**Files:**
- Create: `frontend/e2e/phase3.spec.ts`
- Modify: `frontend/e2e/playwright.config.ts` (new `phase3` project, after line 23)
- Modify: `frontend/e2e/global-setup.ts` (line 11: the "already has users" message pointed at `scripts/e2e.sh`, which deletes the owner's data; it now points at the isolated procedure. The freshness guard itself stays: it is what stops the e2e from writing into the owner's stack)
- Modify: `README.md` (status line, timezone note, UI screens list, new section "Dashboards and billing", Develop commands, End-to-end test section)
- Modify: `docs/superpowers/backlog.md` (section A marked done; sections B and C untouched)
- Conditional: `scripts/smoke.py` only if the new energy engine or API breaks it (none expected: it reads `metrics[].value` and prints `energy_today`, whose key is unchanged)

**Interfaces:**
- Consumes the state of the two earlier projects, exactly (verified in `journey.spec.ts` and `discovery.spec.ts`): admin `admin` / `correct-horse`; assets `Site` (root, kind generic) with children `Panel 01`, `LVP02` ... `LVP10` (each with six mappings incl. `active_power_kw` and `energy_kwh` from the OPC UA simulator), plus top-level `MV2` (HTTP simulator, `active_power_kw` + `energy_kwh`); site timezone `UTC` (`DCDASH_TIMEZONE` default); no tariffs, no currency, no dashboards. The collector has been polling for several minutes. (The brief's "LV Panel 1" does not exist in this database; the spec uses `Panel 01`.)
- Consumes these labels (Tasks 7-10, copied from their code): nav links `Dashboards`, `Billing`, `Tariffs` (admin), `Users`, `Audit`, button `Sign out` (all inside the single `<nav>`; the dashboard page also has a breadcrumb link `Dashboards`, so nav links are always scoped to `getByRole("navigation")`). Tariffs: `<h1>Tariffs</h1>`; form `Site currency` (label `Currency`, button `Save`, text `saved`, notice `No currency is set…`); form `Add site default rate` (labels `Effective from`, `Rate per kWh`, button `Add rate`); table `Site default rates`. Billing: `<h1>Billing</h1>`, month label e.g. `October 2026`, buttons `Previous month` / `Next month` / `Download CSV`, caption `Each cell shows kWh above and cost in USD below.`, header cell `Rate (USD/kWh)`, one `<th scope="row">` (rowheader) per asset, then cells: rate, month total, one per day (`—` when no figure). Asset page: tile `Cost today` (`.tile` > `.big`, text like `0.12 USD`, or `—` + `no rate set`). Users: form with `Username`, `Password`, `Role`, button `Create user`. Dashboards: `<h1>Dashboards</h1>`, button `New dashboard`, dialog `New dashboard` (labels `Name`, `Range`, buttons `Create`, `Cancel`), per-row button `Delete <name>`. Editor: inputs `Dashboard name`, `Dashboard range`, buttons `Add widget`, `Save`, `Cancel`; dialog `Add widget` / `Edit widget` (labels `Type` [values timeseries|bar|stat|gauge|table], `Title`, `Source` [metric|energy|cost], `Metric`, `Aggregation` [avg|min|max|last|sum], `Widget range` [value "" = dashboard range, or a preset], `Bars`; checkboxes/radios named after the asset; text `3 of 20 selected`; button `Save widget`). View: `Dashboard range` select, button `Edit` (operators and admins only), each widget is a `region` named by its title with a button `Download CSV for <title>`, hint `Showing … for this visit only`. Role page for non-admins: `Admins only`. Audit: `<h1>Audit log</h1>`, action cells.
- HTTP used by the spec (Interface Contracts): `GET /api/site`, `GET /api/assets`, `GET /api/assets/{id}/summary` (`energy_today`, `cost_today`), `GET|PUT|DELETE /api/dashboards/{id}`, `POST /api/widget-data`, `GET /api/tariffs`, `POST /api/tariffs`; roles: viewer gets 403 on tariffs (read and write) and on dashboard writes.
- Produces: Playwright project `phase3` (`testMatch: phase3.spec.ts`, `dependencies: ["discovery"]`, 1600x1000 like `discovery`); the README documentation of Phase 3; the phase's done-when evidence (Step 8).

**Design notes (decided here, do not revisit):**
- One test with named `test.step`s, like `discovery.spec.ts` (one browser session, sign-in/out inside it). The list reporter prints the failing step's name, which is what you read first.
- Assertions are about structure and "not a dash", never exact kWh or cost: the database is a few minutes old. Cells for days before the data started legitimately read `0.0` / `—` (a meter with no readings counts 0 and has no priced hours), so only the month total and TODAY's cell are asserted.
- No sleeps. Waiting is Playwright auto-waiting plus `expect.poll` on API state (the collector may not have an hourly bucket for a panel yet).
- Layout persistence is checked without driving the grid with the mouse: the saved `x/y/w/h` from the API must equal what was added (default sizes), and the widgets' on-screen boxes must match them (the view is a CSS grid of 80 px rows with 10 px gaps, `lib/gridMetrics.ts`) both before and after a reload. Drag and resize are pointer-only in react-grid-layout and the flakiest thing a browser test can do; they are covered by `DashboardGrid.test.tsx` and the unit suites of Task 10.
- A viewer and an operator are created by the admin through the Users page. Both are created before the admin signs out (the brief creates the viewer later; the assertions are unchanged).
- Review Focus 3 ("a missing rate never shows as zero") gets an end-to-end check: Billing is opened BEFORE any tariff exists and the cost line must be a dash.
- A failure in Task 7-10 code is a real finding, not an e2e problem: fix it test-first in the owning file's test (`frontend/src/...test.tsx` or `backend/tests/...`), commit it separately as `fix:`, then repeat the whole isolated run from a fresh database. Never loosen an assertion to get green.

- [ ] **Step 1: Preconditions**

```bash
cd /home/ziad/Projects/DC_Dashboard
git branch --show-current          # expect: phase-3-dashboards-billing
git status --short                 # expect: clean (see the note below if the spec file is listed)
git log --oneline main..HEAD       # expect: the commits of Tasks 0-10
ls frontend/src/pages/BillingPage.tsx frontend/src/pages/TariffsPage.tsx frontend/src/pages/DashboardPage.tsx \
   frontend/src/components/dashboard/DashboardEditor.tsx frontend/src/components/CostTile.tsx
ls frontend/node_modules/@playwright/test/package.json   # Playwright installed (first time on a machine: cd frontend && npx playwright install chromium)
```

If any file is missing, stop and report: this task needs Tasks 7 to 10. If `git status --short` lists only `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (the planning session's three-line note "Widgets cannot use the `custom` metric", which the README repeats), leave it for now; Step 9 commits it separately so the working tree ends clean.

- [ ] **Step 2: Add the `phase3` project and make the e2e guard message safe**

Edit `frontend/e2e/playwright.config.ts` (exact):

old_string:
```
      dependencies: ["journey"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
  ],
```
new_string:
```
      dependencies: ["journey"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "phase3",
      testMatch: "phase3.spec.ts",
      dependencies: ["discovery"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
  ],
```

Edit `frontend/e2e/global-setup.ts` (exact). The message must still START with `the stack already` (the `catch` block below it rethrows on that prefix):

old_string:
```
if (!body.needed) throw new Error("the stack already has users; run scripts/e2e.sh for a fresh database");
```
new_string:
````
if (!body.needed) {
          throw new Error(
            "the stack already has users, so this is not a fresh end-to-end database. Do NOT run scripts/e2e.sh or " +
              "`docker compose down -v` on the normal project: they delete the dcdash_dbdata volume. Use the isolated project " +
              "(stop the normal stack with `docker compose --profile dev stop`, then `docker compose -p dcdash_e2e --profile dev " +
              "down -v --remove-orphans` and `... up -d --build`, then `npm run e2e`); see the README, section End-to-end test.",
          );
        }
````

- [ ] **Step 3: Write `frontend/e2e/phase3.spec.ts`**

Create the file with exactly this content:

```ts
import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Locator, type Page } from "@playwright/test";

// Phase 3 on the state the journey and discovery projects leave behind: admin `admin` / `correct-horse`; assets Site
// (root) > Panel 01, LVP02 ... LVP10, plus MV2; the collector has been polling for some minutes. The database is young,
// so every assertion is about structure and "not a dash", never an exact kWh or cost.

const ADMIN = { username: "admin", password: "correct-horse", role: "admin" };
const OPERATOR = { username: "operator1", password: "operator-pass-1", role: "operator" };
const VIEWER = { username: "viewer1", password: "viewer-pass-1", role: "viewer" };
type Account = typeof ADMIN;

const DASHBOARD = "Phase 3 overview";
const STAT = "Panel 01 power";
const BAR = "Energy by panel";
const BAR_ASSETS = ["Panel 01", "LVP02", "LVP03"];
const BOM = [0xef, 0xbb, 0xbf];
const ROW_HEIGHT = 80; // frontend/src/lib/gridMetrics.ts: the read-only dashboard is a CSS grid of 80 px rows with 10 px gaps
const GRID_GAP = 10;

interface ApiWidget {
  type: string; title: string; x: number; y: number; w: number; h: number;
  config: { assets: number[]; source: string; metric: string | null; aggregation: string; range: string | null; bars: string };
}
interface ApiDashboard { id: number; name: string; range: string; updated_at: string; widgets: ApiWidget[] }
interface ApiWidgetData {
  mode: string; source: string; metric: string | null; unit: string | null; missing: number[];
  values: { asset_id: number; name: string; value: number | null; point_id: number | null }[];
}

// ---- locators the UI does not label (Tasks 8-10 define these classes and elements; change them here only) ----
const navLink = (page: Page, name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true });
const region = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });
const statFigure = (page: Page, title: string) => region(page, title).locator(".big");
const barChart = (page: Page, title: string) => region(page, title).locator("canvas").first();
const costTileFigure = (page: Page) => page.locator(".tile").filter({ hasText: "Cost today" }).locator(".big");
const billingRow = (page: Page, asset: string) =>
  page.getByRole("table").getByRole("row").filter({ has: page.getByRole("rowheader", { name: asset, exact: true }) });
// A Billing figure cell has two lines: kWh above, cost below. Cells of a row: 0 rate, 1 month total, 2.. one per day.
const kwhLine = (cell: Locator) => cell.locator("div").first();
const costLine = (cell: Locator) => cell.locator("div").last();
// ---------------------------------------------------------------------------------------------------------------

async function signIn(page: Page, who: Account) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(who.username);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Where you land depends on where the previous sign-out happened, so callers navigate explicitly.
  await expect(page.getByRole("navigation")).toContainText(`${who.username} (${who.role})`);
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
}

async function createUser(page: Page, who: Account) {
  await navLink(page, "Users").click();
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Create user" }) });
  await form.getByLabel("Username").fill(who.username);
  await form.getByLabel("Password").fill(who.password);
  await form.getByLabel("Role").selectOption({ value: who.role });
  await form.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByRole("cell", { name: who.username, exact: true })).toBeVisible();
}

/** Asserts the byte-order mark and the .csv name; returns the lines without the mark. */
async function readCsv(download: Download): Promise<string[]> {
  expect(download.suggestedFilename()).toMatch(/\.csv$/i);
  const bytes = await readFile((await download.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual(BOM);
  return bytes.toString("utf8").replace(/^﻿/, "").split("\r\n").filter((line) => line !== "");
}

/** Every POST /api/widget-data the page sends from now on (the dashboard refetches a widget when its range changes). */
function recordWidgetData(page: Page): { type: string; range: string }[] {
  const seen: { type: string; range: string }[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/widget-data") return;
    try {
      seen.push(JSON.parse(request.postData() ?? "") as { type: string; range: string });
    } catch {
      // not JSON: not ours
    }
  });
  return seen;
}

const pixels = (rows: number) => rows * ROW_HEIGHT + (rows - 1) * GRID_GAP;

/** The widgets' boxes on screen must match the stored x/y/w/h (heights, and the distance between their tops). */
async function expectLayout(page: Page, stat: ApiWidget, bar: ApiWidget) {
  const a = (await region(page, STAT).boundingBox())!;
  const b = (await region(page, BAR).boundingBox())!;
  expect(Math.abs(a.height - pixels(stat.h)), "stat height").toBeLessThanOrEqual(2);
  expect(Math.abs(b.height - pixels(bar.h)), "bar height").toBeLessThanOrEqual(2);
  expect(Math.abs(b.y - a.y - (bar.y - stat.y) * (ROW_HEIGHT + GRID_GAP)), "distance between the tops").toBeLessThanOrEqual(2);
}

test("phase 3 journey: currency and tariff, billing, cost tile, an operator's dashboard, a read-only viewer", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const shot = async (name: string) =>
    testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  const getJson = async <T>(path: string) => (await (await page.request.get(path)).json()) as T;

  await test.step("admin sets the site currency", async () => {
    await signIn(page, ADMIN);
    await navLink(page, "Tariffs").click();
    await expect(page.getByRole("heading", { name: "Tariffs", exact: true })).toBeVisible();
    await expect(page.getByText(/No currency is set/)).toBeVisible();
    const currency = page.getByRole("form", { name: "Site currency" });
    await currency.getByLabel("Currency", { exact: true }).fill("USD");
    await currency.getByRole("button", { name: "Save" }).click();
    await expect(currency.getByText("saved", { exact: true })).toBeVisible();
    await expect(page.getByText(/No currency is set/)).toHaveCount(0);
    expect((await getJson<{ currency: string | null }>("/api/site")).currency).toBe("USD");
  });

  const assets = await getJson<{ id: number; name: string }[]>("/api/assets");
  const idOf = (name: string) => {
    const found = assets.filter((a) => a.name === name);
    expect(found, `asset ${name}`).toHaveLength(1);
    return found[0].id;
  };
  const panel = idOf("Panel 01");

  await test.step("Review Focus 3, end to end: with no rate yet, Billing shows a dash for cost, never zero", async () => {
    await expect.poll(
      async () => (await getJson<{ energy_today: unknown }>(`/api/assets/${panel}/summary`)).energy_today,
      { timeout: 120_000, message: "Panel 01 has no energy figure yet: is the collector polling the OPC UA panels?" },
    ).not.toBeNull();
    await navLink(page, "Billing").click();
    await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();
    const total = billingRow(page, "Panel 01").getByRole("cell").nth(1);
    await expect(kwhLine(total)).toHaveText(/^~?\d+\.\d$/);
    await expect(costLine(total)).toHaveText("—");
  });

  await test.step("admin adds a site default rate effective 2020-01-01", async () => {
    await navLink(page, "Tariffs").click();
    const add = page.getByRole("form", { name: "Add site default rate" });
    await add.getByLabel("Effective from").fill("2020-01-01");
    await add.getByLabel("Rate per kWh").fill("0.12");
    await add.getByRole("button", { name: "Add rate" }).click();
    const defaults = page.getByRole("table", { name: "Site default rates" });
    await expect(defaults.getByRole("row").filter({ hasText: "2020-01-01" })).toContainText("0.12");
  });

  await test.step("Billing: the current month, priced rows, and the month CSV", async () => {
    const site = await getJson<{ timezone: string; currency: string | null }>("/api/site");
    const now = new Date();
    const inSite = (options: Intl.DateTimeFormatOptions, locale = "en-US") =>
      new Intl.DateTimeFormat(locale, { timeZone: site.timezone, ...options }).format(now);
    const dayOfMonth = Number(inSite({ day: "numeric" }));
    const today = inSite({ year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA"); // YYYY-MM-DD

    await navLink(page, "Billing").click();
    await expect(page.getByText(inSite({ month: "long", year: "numeric" }), { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next month" })).toBeDisabled();
    await expect(page.getByText(/cost in USD below/)).toBeVisible();
    await expect(page.getByRole("table").locator("thead th").nth(1)).toHaveText("Rate (USD/kWh)");
    await expect(page.getByText("Some consumption has no rate")).toHaveCount(0);
    // Panel 01 has its own meter; Site has none, so its figures are its children's sum (Review Focus 3).
    for (const name of ["Panel 01", "Site"]) {
      const cells = billingRow(page, name).getByRole("cell");
      await expect(cells.nth(0), `${name} rate`).toHaveText("0.12");
      for (const [label, cell] of [["month total", cells.nth(1)], ["today", cells.nth(2 + dayOfMonth - 1)]] as const) {
        await expect(kwhLine(cell), `${name} ${label} kWh`).toHaveText(/^~?\d+\.\d$/);
        await expect(costLine(cell), `${name} ${label} cost`).toHaveText(/^~?\d+\.\d{2}\*?$/);
      }
    }
    await shot("billing-current-month");

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
    const lines = await readCsv(download);
    expect(lines[0]).toBe("asset,date,kwh,cost,currency,estimated,partial");
    const todays = lines.slice(1).map((line) => line.split(",")).filter((cells) => cells[0] === "Site / Panel 01" && cells[1] === today);
    expect(todays, "today's CSV row for Site / Panel 01").toHaveLength(1);
    expect(todays[0][3], "cost cell").not.toBe("");
    expect(todays[0][4]).toBe("USD");
  });

  await test.step("the asset page has a cost tile", async () => {
    await page.goto(`/assets/${panel}`);
    await expect(page.getByRole("heading", { name: "Panel 01" })).toBeVisible();
    await expect(costTileFigure(page)).toHaveText(/^~?\d+\.\d{2}\*?\s*USD$/);
  });

  await test.step("admin creates an operator and a viewer, then signs out", async () => {
    await createUser(page, OPERATOR);
    await createUser(page, VIEWER);
    await signOut(page);
  });

  let dashboardId = 0;
  let saved: ApiDashboard;
  await test.step("operator builds a dashboard: a stat and a bar widget, saved", async () => {
    await signIn(page, OPERATOR);
    await expect(navLink(page, "Tariffs")).toHaveCount(0);
    await navLink(page, "Dashboards").click();
    await expect(page.getByRole("heading", { name: "Dashboards", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New dashboard" }).click();
    const create = page.getByRole("dialog", { name: "New dashboard" });
    await create.getByLabel("Name", { exact: true }).fill(DASHBOARD);
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboards\/\d+$/);
    dashboardId = Number(new URL(page.url()).pathname.split("/").pop());

    // The new dashboard opens in edit mode.
    await expect(page.getByLabel("Dashboard name")).toHaveValue(DASHBOARD);
    const addWidget = page.getByRole("button", { name: "Add widget" });
    await expect(addWidget).toBeEnabled(); // enabled once the asset list has loaded
    const dialog = page.getByRole("dialog", { name: "Add widget" });

    await addWidget.click();
    await dialog.getByLabel("Type", { exact: true }).selectOption({ value: "stat" });
    await dialog.getByLabel("Title", { exact: true }).fill(STAT);
    await dialog.getByLabel("Metric", { exact: true }).selectOption({ value: "active_power_kw" });
    await dialog.getByLabel("Aggregation", { exact: true }).selectOption({ value: "last" });
    await dialog.getByRole("radio", { name: "Panel 01" }).check();
    await expect(dialog.locator(".widget-preview .big")).toHaveText(/\d+\.\d{2}/); // the preview fetches real data
    await dialog.getByRole("button", { name: "Save widget" }).click();
    await expect(dialog).toBeHidden();

    await addWidget.click();
    await dialog.getByLabel("Type", { exact: true }).selectOption({ value: "bar" });
    await dialog.getByLabel("Title", { exact: true }).fill(BAR);
    await dialog.getByLabel("Source", { exact: true }).selectOption({ value: "energy" });
    await dialog.getByLabel("Widget range", { exact: true }).selectOption({ value: "today" });
    for (const name of BAR_ASSETS) await dialog.getByRole("checkbox", { name }).check();
    await expect(dialog.getByText("3 of 20 selected")).toBeVisible();
    await expect(dialog.locator(".widget-preview canvas").first()).toBeVisible();
    await dialog.getByRole("button", { name: "Save widget" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible(); // back in view mode

    // What was stored.
    saved = await getJson<ApiDashboard>(`/api/dashboards/${dashboardId}`);
    expect(saved.name).toBe(DASHBOARD);
    expect(saved.range).toBe("24h");
    expect(saved.widgets.map((w) => w.type)).toEqual(["stat", "bar"]); // the API orders widgets by y, x, id
    const [stat, bar] = saved.widgets;
    expect(stat).toMatchObject({
      title: STAT, x: 0, y: 0,
      config: { assets: [panel], source: "metric", metric: "active_power_kw", aggregation: "last", range: null },
    });
    expect(bar).toMatchObject({
      title: BAR, x: 0,
      config: { source: "energy", metric: null, aggregation: "sum", range: "today", bars: "asset" },
    });
    expect([...bar.config.assets].sort()).toEqual(BAR_ASSETS.map(idOf).sort());
    expect(bar.y).toBeGreaterThanOrEqual(stat.y + stat.h);

    // What the stored widgets return: the stat has a live point id, the bar has a number per asset.
    const post = async (w: ApiWidget, range: string) =>
      (await (await page.request.post("/api/widget-data", { data: { type: w.type, config: w.config, range } })).json()) as ApiWidgetData;
    const statData = await post(stat, "24h");
    expect(statData).toMatchObject({ mode: "values", source: "metric", metric: "active_power_kw", unit: "kW", missing: [] });
    expect(statData.values).toHaveLength(1);
    expect(statData.values[0].value).not.toBeNull();
    expect(statData.values[0].point_id).not.toBeNull();
    const barData = await post(bar, "today");
    expect(barData).toMatchObject({ mode: "values", source: "energy", unit: "kWh", missing: [] });
    expect(barData.values.map((v) => v.name).sort()).toEqual([...BAR_ASSETS].sort());
    for (const v of barData.values) expect(v.value, v.name).not.toBeNull();

    // What the view shows.
    await expect(statFigure(page, STAT)).toHaveText(/\d+\.\d{2}/);
    await expect(barChart(page, BAR)).toBeVisible();
    await expect(region(page, BAR).getByText("No data in this range.")).toHaveCount(0);
    await expectLayout(page, stat, bar);
  });

  await test.step("after a reload both widgets and their layout are still there", async () => {
    await page.reload();
    await expect(region(page, STAT)).toBeVisible();
    await expect(region(page, BAR)).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible(); // view mode, not the editor
    await expect(page.getByRole("button", { name: "Add widget" })).toHaveCount(0);
    await expect(statFigure(page, STAT)).toHaveText(/\d+\.\d{2}/);
    await expect(barChart(page, BAR)).toBeVisible();
    const [stat, bar] = saved.widgets;
    await expectLayout(page, stat, bar);
    await shot("dashboard-after-reload");
  });

  await test.step("changing the dashboard range refetches the widgets that inherit it", async () => {
    const requests = recordWidgetData(page);
    await page.getByLabel("Dashboard range").selectOption({ value: "7d" });
    await expect.poll(() => requests.filter((r) => r.type === "stat" && r.range === "7d").length).toBeGreaterThan(0);
    expect(requests.filter((r) => r.type === "bar" && r.range !== "today"), "the bar keeps its own range").toEqual([]);
    await expect(page.getByText(/for this visit only/)).toBeVisible();
    await expect(statFigure(page, STAT)).toHaveText(/\d+\.\d{2}/);
    const after = await getJson<ApiDashboard>(`/api/dashboards/${dashboardId}`); // viewing a range saves nothing
    expect(after.range).toBe("24h");
    expect(after.updated_at).toBe(saved.updated_at);
  });

  await test.step("a widget exports its data as CSV", async () => {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: `Download CSV for ${BAR}` }).click(),
    ]);
    const lines = await readCsv(download);
    expect(lines[0]).toBe("asset,source,unit,timestamp,value,estimated,partial");
    for (const name of BAR_ASSETS) {
      expect(lines.find((line) => line.startsWith(`Site / ${name},energy,kWh,`)), `a row for ${name}`).toBeDefined();
    }
  });

  await test.step("a viewer sees the dashboard but cannot change anything", async () => {
    await signOut(page);
    await signIn(page, VIEWER);
    await expect(navLink(page, "Dashboards")).toBeVisible();
    await expect(navLink(page, "Billing")).toBeVisible();
    await expect(navLink(page, "Tariffs")).toHaveCount(0);

    await navLink(page, "Dashboards").click();
    const link = page.getByRole("link", { name: DASHBOARD });
    await expect(link).toBeVisible();
    await expect(page.getByRole("button", { name: "New dashboard" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);

    await link.click();
    await expect(region(page, STAT)).toBeVisible();
    await expect(region(page, BAR)).toBeVisible();
    await expect(statFigure(page, STAT)).toHaveText(/\d+\.\d{2}/);
    await expect(page.getByRole("button", { name: "Download CSV for " + STAT })).toBeVisible(); // exports are allowed
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add widget" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Edit|Delete) / })).toHaveCount(0);
    await shot("dashboard-as-viewer");

    await navLink(page, "Billing").click();
    await expect(billingRow(page, "Panel 01")).toBeVisible();
    await expect(page.getByRole("button", { name: "Download CSV" })).toBeVisible();

    await page.goto("/tariffs");
    await expect(page.getByRole("heading", { name: "Admins only" })).toBeVisible();

    // The API refuses what the UI hides.
    expect((await page.request.get("/api/tariffs")).status()).toBe(403);
    const rate = { asset_id: null, rate_per_kwh: 9, effective_from: "2021-01-01" };
    expect((await page.request.post("/api/tariffs", { data: rate })).status()).toBe(403);
    const edit = { name: DASHBOARD, range: "24h", updated_at: saved.updated_at, widgets: [] };
    expect((await page.request.put(`/api/dashboards/${dashboardId}`, { data: edit })).status()).toBe(403);
    expect((await page.request.delete(`/api/dashboards/${dashboardId}`)).status()).toBe(403);
    expect((await getJson<ApiDashboard>(`/api/dashboards/${dashboardId}`)).widgets).toHaveLength(2);
  });

  await test.step("admin finds the audited actions", async () => {
    await signOut(page);
    await signIn(page, ADMIN);
    await navLink(page, "Audit").click();
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    for (const action of ["tariff.created", "billing.currency_changed", "dashboard.created", "dashboard.updated"]) {
      await expect(page.getByRole("cell", { name: action, exact: true }), action).toHaveCount(1);
    }
  });
});
```

Run (no stack needed; this only collects the tests, so it catches a syntax or config error early):

```bash
cd frontend && npx playwright test -c e2e/playwright.config.ts --list
```
Expected: three projects, ending with `[phase3] › phase3.spec.ts:NN:1 › phase 3 journey: currency and tariff, billing, cost tile, an operator's dashboard, a read-only viewer` and `Total: 3 tests in 3 files`. Any other output (syntax error, unknown project dependency) is fixed now.

(The test cannot fail before it can run: it is exercised by Step 6. Because a failed run costs a full fresh-database cycle, read the file once more against the labels in **Interfaces** before starting Step 6.)

- [ ] **Step 4: README**

Apply these `Edit`s to `/home/ziad/Projects/DC_Dashboard/README.md`, in this order. Each `old_string` is copied from the file and must match byte for byte (the file has `×` and typographic-free ASCII elsewhere); if an `Edit` reports "not found" or "not unique", open the file at that place and adjust the anchor, never rewrite the whole file.

**4a. Status line.**

old_string:
```
Status: Phase 2 (discovery). The web UI is served
```
new_string:
```
Status: Phase 3 (dashboards and billing). The web UI is served
```

old_string:
```
drag and drop (see
"Discovery").
```
new_string:
```
drag and drop (see
"Discovery"). Everyone can read shared dashboards and a cost report per asset; operators build
dashboards and admins set tariffs (see "Dashboards and billing").
```

**4b. Timezone note in "Run it".**

old_string:
```
`Asia/Qatar`) so that "today" starts at local midnight.
```
new_string:
```
`Asia/Qatar`) so that "today" starts at local midnight. The zone must have a whole-hour UTC offset in
both January and July (`Asia/Qatar` and `Europe/London` do, `Asia/Kolkata` does not); see
"Dashboards and billing".
```

**4c. UI screens: Settings, and the three new screens.**

old_string:
```
- **Settings** (admin): site timezone (IANA name). It decides where "today" starts for energy totals.
  `DCDASH_TIMEZONE` in `.env` only seeds this on first start.
```
new_string:
```
- **Settings** (admin): site timezone (IANA name). It decides where a day and a month start for energy
  totals, Billing and dashboard ranges, and it must have a whole-hour UTC offset in both January and
  July (Settings refuses any other zone). `DCDASH_TIMEZONE` in `.env` only seeds this on first start.
```

old_string:
```
- **Audit** (admin): the read-only audit log, newest first, 50 entries per page.
```
new_string:
```
- **Audit** (admin): the read-only audit log, newest first, 50 entries per page.
- **Dashboards** (everyone can read; operators and admins build): shared dashboards of widgets; see
  "Dashboards and billing".
- **Billing** (everyone): cost per asset per day and per month, with a CSV export.
- **Tariffs** (admin): the site currency and the rates that cost is calculated with.
```

**4d. The new section, placed before "## Develop".**

old_string:
```
## Develop
```
new_string:
````
## Dashboards and billing

Roles are enforced by the API; the screens only hide what you cannot use.

| | Viewer | Operator | Admin |
|---|---|---|---|
| Open dashboards and Billing, export CSV | yes | yes | yes |
| Create, edit and delete dashboards | no | yes | yes |
| Read tariffs (through the API; operators have no Tariffs screen) | no | yes | yes |
| Set tariffs and the currency (Tariffs screen) | no | no | yes |

**Dashboards** are shared by everyone. A dashboard holds up to 24 widgets (the site up to 50
dashboards) of five types: time series, bar, stat, gauge and table. A widget shows a metric, energy or
cost for up to 20 assets (a stat or a gauge shows one). A dashboard has one time range and a widget may
override it. The ranges are the rolling `1h`, `6h`, `24h`, `7d`, `30d` and the calendar `today`,
`yesterday`, `this_month`, `last_month` (in the site timezone); there are no custom date ranges, and
changing the range on the page affects that visit only. Stat and gauge widgets that show the latest value
follow the live stream; the other widgets refresh every 30 seconds. **Edit** (operators and admins)
opens the grid editor: drag a widget by its title bar, resize it from the corner or the edges, **Add
widget**, then **Save**, which stores the whole dashboard in one step. If someone else saved first you are
told, nothing is overwritten, and you can reload their version. A widget whose asset was deleted shows
"N asset(s) removed" and draws the rest. Every widget has a CSV button (UTF-8 with a byte-order mark,
times in the site timezone with their offset; text starting with `=`, `+`, `-` or `@` gets a leading
apostrophe so that spreadsheets do not run it as a formula). Custom metrics are not available in widgets;
they stay on the asset page.

**Billing** shows one month at a time (previous and next month; the current month by default) as the
asset tree by day: kWh above, cost below, then the month total and the rate in effect. `~` marks a
figure estimated from power, `*` a partial cost (some energy in the period had no rate), and a dash means
there is no figure or no rate: a missing rate is never shown as zero. The CSV button exports one row per
asset per day (`asset,date,kwh,cost,currency,estimated,partial`). The asset page shows today's cost next
to today's energy.

**Tariffs** (admin) hold the site currency (one three-letter code for the whole site; when it is unset,
costs show without a unit) and the rates, in that currency per kWh. A rate is a number of zero or more
with up to six decimals and an effective date (a date in the site timezone). For an asset on a given day
the rate is the latest one effective on or before that day, taken from the nearest asset up the tree
that has its own rates, otherwise from the site default; an override therefore takes over from its own
date. Editing a past rate recalculates history: cost is for visibility, not invoicing. Tariff, currency
and dashboard changes appear in the Audit log.

**The energy engine.** One engine produces every energy figure (asset page, Billing, dashboards), so
they agree. It reads the hourly rollup (`readings_1h`) and works in whole hours; a day or a month is the
sum of its hours in the site timezone. For an asset with an `energy_kwh` counter an hour's energy is the
hour's last counter value minus the previous hour's, the first hour of a period starts from the last
value before it, and a counter reset or rollover is recovered instead of counted as negative or inflated
energy. An asset with only `active_power_kw` gets average power times the time its samples cover, so an
outage adds nothing; such figures are marked `~` (estimated) wherever they appear. A parent asset uses its
own meter if it has one, otherwise the sum of its children; a meter with no readings counts as 0, and an
asset with no energy or power mapping anywhere beneath it has no figure.

Limits: the site timezone must have a whole-hour UTC offset in both January and July (so that day and
month edges fall on hourly buckets); Settings refuses other zones, and Billing and widget data answer 409
if a stored zone breaks the rule. The rollups refresh over the last 7 days, so readings that arrive later
than that are not included in energy figures. One counter reset per hour is recovered exactly; a second
one inside the same hour may understate that hour. Energy estimated from power is an estimate, not a
measurement. The currency is one per site, there are no time-of-use tariffs, and custom metrics cannot be
used in widgets.

## Develop
````

**4e. Develop commands.**

old_string:
```
npm run typecheck
```
new_string:
```
npm run typecheck
npm run build      # typecheck + production bundle; the grid and the chart widgets are separate, lazily loaded chunks
npm run e2e        # Playwright; needs a fresh stack and an isolated Compose project, see "End-to-end test"
```

**4f. End-to-end test: three specs, a prominent warning, the stop command, the volume check.**

old_string:
```
Two specs run in one `playwright test` run against the dev-profile stack on `http://localhost/`
(`frontend/e2e/playwright.config.ts` runs them in this order):
```
new_string:
```
> **Data safety.** `scripts/e2e.sh` and `docker compose down -v` on the normal project delete the
> `dcdash_dbdata` volume: every reading, user, source, tariff and dashboard you have. Never run them
> where that data matters. Run the end-to-end tests only in the isolated Compose project described
> below, which has its own volume.

Three specs run in one `playwright test` run against the dev-profile stack on `http://localhost/`
(`frontend/e2e/playwright.config.ts` runs them in this order; each project depends on the one before):
```

old_string:
```
  Audit page shows the scope, the scan and ten accepted mappings.
```
new_string:
```
  Audit page shows the scope, the scan and ten accepted mappings.
- `phase3.spec.ts` (after it, at 1600×1000) reuses that state. An admin sets the currency, sees a dash
  (not zero) on Billing while no rate exists, adds a site default rate, and checks the current month on
  Billing (a priced panel row, its month total and today's cell, the month CSV with its header and
  byte-order mark) and the cost tile on an asset page. The admin creates an operator and a viewer; the
  operator builds a dashboard with a stat and a bar widget, saves it, reloads and finds both widgets and
  their layout, changes the dashboard range and downloads a widget's CSV; the viewer sees the dashboard
  with no edit controls, no Tariffs link and `403` from the write API; the admin finds the tariff,
  currency and dashboard entries in the Audit log.
```

old_string:
```
stack first, because both use ports 80 and 443):
```
new_string:
```
stack first with `docker compose --profile dev stop`, never with `-v`, because both use ports 80 and 443):
```

old_string:
```
--profile dev up -d --build`) to be sure it runs your own code.
```
new_string:
```
--profile dev up -d --build`) to be sure it runs your own code, and check with `docker volume ls` that
`dcdash_dbdata` is still listed.
```

Verify the README (each command must print what is stated):

```bash
cd /home/ziad/Projects/DC_Dashboard
grep -c "Dashboards and billing" README.md         # expect 4 (status line, timezone note, UI screens list, the section heading)
grep -n "^## Dashboards and billing\|^## Develop\|^### End-to-end test\|Data safety" README.md   # headings in this order; the warning sits right under "End-to-end test"
grep -c "phase3.spec.ts" README.md                  # expect 1
grep -n "whole-hour\|7 days\|never shown as zero\|custom metrics" README.md | head   # the documented limits are present
git diff --stat -- README.md                        # only README.md changed
```

- [ ] **Step 5: Unit suites and the bundle**

```bash
cd /home/ziad/Projects/DC_Dashboard/backend && uv run pytest 2>&1 | tail -15
cd /home/ziad/Projects/DC_Dashboard/frontend && npm test 2>&1 | tail -15
cd /home/ziad/Projects/DC_Dashboard/frontend && npm run typecheck
cd /home/ziad/Projects/DC_Dashboard/frontend && npm run build 2>&1 | tee /tmp/phase3-build.txt | tail -40
```
Expected: pytest and vitest all PASS (note the "N passed" lines for the report), typecheck clean, the build succeeds. Docker must be running for pytest (testcontainers); the backend suite takes several minutes, so run it with a long timeout or in the background.

Bundle check (the same markers as Task 10 Step 10, so the evidence is comparable):

```bash
cd /home/ziad/Projects/DC_Dashboard/frontend
main=$(grep -o '<script[^>]*src="/assets/[^"]*\.js"' dist/index.html | grep -o 'assets/[^"]*' | head -1)
echo "main chunk: $main  raw $(wc -c < "dist/$main") bytes, gzip $(gzip -c "dist/$main" | wc -c) bytes"
grep -c "react-grid-item" "dist/$main"        # expect 0: the grid library is not in the main chunk
grep -c "_echarts_instance_" "dist/$main"     # expect 0: ECharts is not in the main chunk
echo "chunks holding the grid:";   grep -l "react-grid-item" dist/assets/*.js        # expect one or more files, none of them $main
echo "chunks holding ECharts:";    grep -l "_echarts_instance_" dist/assets/*.js    # expect one or more files, none of them $main
ls -lS dist/assets/*.js | awk '{print $5, $9}' | head -15    # chunk sizes, largest first
```
Expected: both `grep -c` print `0`; both `grep -l` list only other files (the dashboard editor/grid chunk, the three chart widgets, the asset-page chart). Record: the main chunk's name and its raw/gzip size, and the names of the lazy chunks (also visible in `/tmp/phase3-build.txt`, Vite's table). If the main chunk contains either marker, a static import slipped in: find it with `grep -rln "react-grid-layout\|echarts" src --include=*.tsx`, make it a `React.lazy` import in the owning file (only `DashboardGrid.tsx` and the three chart widgets may import those libraries), and re-run. `@xyflow/react` (Discovery) is known to be in the main chunk (backlog section C); it is not part of this check.

- [ ] **Step 6: The isolated end-to-end run**

First note that the owner's volume exists (this step never backs up, reads or changes it; Step 7, which would migrate it, is owner-gated):

```bash
cd /home/ziad/Projects/DC_Dashboard
docker volume ls --format '{{.Name}}' | grep -x dcdash_dbdata || echo "no dcdash_dbdata volume on this machine"   # remember the answer
```

Then stop the normal stack (ports 80 and 443 must be free; `stop` keeps containers and volumes) and run the isolated project:

```bash
docker compose --profile dev stop
docker compose -p dcdash_e2e --profile dev down -v --remove-orphans
docker compose -p dcdash_e2e --profile dev up -d --build
cd frontend && npm run e2e
```
`up --build` takes a few minutes the first time. `npm run e2e` takes roughly 8 to 12 minutes in total (journey about 1 minute, discovery up to 4, phase3 up to 3): run it in the background with a long timeout and read the output when it finishes.

Expected: the list reporter shows `journey`, `discovery` and `phase3` each passing and ends with `3 passed`. The `phase3` run prints its steps; the HTML report (`frontend/playwright-report/`, git-ignored) holds the three screenshots the test attaches (`billing-current-month`, `dashboard-after-reload`, `dashboard-as-viewer`).

If a test fails: DO NOT tear anything down yet.
1. Read the failing step's name in the list output, then `frontend/test-results/*/error-context.md` and the screenshot next to it; `npx playwright show-trace frontend/test-results/<dir>/trace.zip` if needed.
2. `docker compose -p dcdash_e2e --profile dev logs --tail 100 api collector` for server errors; the failed stack is still up and its API can be queried (log in as `admin` / `correct-horse`).
3. Decide: a wrong locator or timing in the spec means fix the spec; a wrong figure, 4xx/5xx or missing control means a bug in Tasks 1-10 (see the last design note: failing unit test first, fix, commit as `fix:`). A used database cannot be reused (the guard in `global-setup.ts` refuses it, on purpose), so after any fix repeat the whole cycle: `docker compose -p dcdash_e2e --profile dev down -v --remove-orphans`, `... up -d --build` (cached, much faster), `(cd frontend && npm run e2e)`.

When all three pass, tear the isolated project down and check the owner's volume:

```bash
cd /home/ziad/Projects/DC_Dashboard
docker compose -p dcdash_e2e --profile dev down -v
docker volume ls
docker volume ls --format '{{.Name}}' | grep -x dcdash_dbdata    # must print dcdash_dbdata if it was listed before this step
```
If `dcdash_dbdata` was listed before and is not now, STOP and report. Do not recreate it.

- [ ] **Step 7: Rebuild the normal stack and check it — OWNER GATE**

**Do not run this step on your own.** It rebuilds the normal stack, whose `api` container applies migration 0004 to the owner's real `dcdash_dbdata` volume, and the owner asked that this volume not be touched. Finish Steps 1-6 and 8-9, write "Step 7 not run: waiting for the owner's go-ahead" in your report, and stop. Only if the owner has said in this session to go ahead: first run `docker compose --profile dev ps` and, if the db service is running, `scripts/backup.sh && ls -l backups | tail -2` (./backups is git-ignored), then do what follows. Until then the done-when table in Step 8 records the Step 7 evidence as "not run (owner gate)".

The isolated run re-tagged the shared `dcdash-backend:local` and `dcdash-web:local` images, so rebuild the normal stack; its `api` container runs `alembic upgrade head`, which applies migration 0004 to the owner's real database for the first time.

```bash
cd /home/ziad/Projects/DC_Dashboard
docker compose --profile dev up -d --build
docker compose --profile dev ps
curl -fsS http://localhost/api/health          # repeat until it prints {"status":"ok"}: the api container migrates first
docker compose --profile dev exec -T api alembic current    # expect: 0004 (head)
scripts/check_web.sh                                         # expect: index, spa fallback, api proxy, stream route: ok
for route in dashboards billing tariffs; do curl -fsS "http://localhost/$route" | grep -q '<div id="root">' && echo "deep link /$route: ok"; done
uv run --project backend python scripts/smoke.py             # expect: browsed N points ... energy today: ... OK
```
If the `api` container does not become healthy, or `alembic current` is not `0004 (head)`, migration 0004 failed on real data: run `docker compose --profile dev logs --tail 80 api`, report the log, and STOP. Do not `down -v`, do not touch the volume.

`scripts/smoke.py` logs in as `admin` / `smoke-test-password` and may add a `smoke-sim` source and a `Smoke Panel` asset to this stack, as it always has. If its login answers 401, this stack's admin password is something else: that is an environment fact, not a bug. Report it; never reset the password or re-run setup. Check the rebuilt stack by hand instead (the health, `alembic current`, `check_web.sh` and deep-link lines above). If smoke.py fails for any other reason, find out whether the cause is the new energy engine or API (for example a 500 from `/api/assets/{id}/summary` is a backend bug: failing backend test first, fix, commit as `fix:`) or smoke.py itself (the only references to Phase 3 behaviour are `metrics[].value` and the print of `summary['energy_today']`, whose key is unchanged). Change `scripts/smoke.py` only for a break caused by an intended Phase 3 change, with the smallest edit, and add it to the Step 9 commit.

- [ ] **Step 8: The done-when check, item by item**

Spec section 14, Phase 3: "An operator can build and save a dashboard, and cost per panel per day and month is visible". Check each part and put the evidence in your report:

| Part of the sentence | Proven by | Evidence to capture |
|---|---|---|
| An operator can build a dashboard | `phase3` step "operator builds a dashboard": a user with role `operator` (created through the Users page) opens New dashboard, adds a stat widget (active power of Panel 01, latest) and a bar widget (energy of three panels, today), each with a preview that fetches real data | the `phase3` step lines of the list reporter; attachment `dashboard-after-reload` |
| and save it | the same step: Save, then `GET /api/dashboards/{id}` returns both widgets with their configs and x/y/w/h; the step "after a reload" finds both widgets and the same layout on screen | the passing step lines |
| cost per panel per day is visible | step "Billing: the current month…": row `Panel 01` (and the parent `Site`, a sum of children) has a priced cost in today's cell, not a dash; the month CSV has today's row with a cost and `USD` | attachment `billing-current-month` |
| cost per panel per month is visible | the same step: the month-total cell of `Panel 01` and `Site` shows kWh and a cost (`^~?\d+\.\d{2}\*?$`) | attachment `billing-current-month` |

Phase 3 goal items beyond the sentence, each with a passing `phase3` step: currency and a site default rate by an admin; a dash (not zero) while no rate exists (Review Focus 3); the cost tile on the asset page; changing the dashboard range refetches the inheriting widgets and saves nothing; widget CSV and month CSV start with a byte-order mark and the stated headers; a viewer sees the dashboard with no Edit, Create or Delete controls, no Tariffs link, and the API answers 403 to tariff reads/writes and dashboard writes; the Audit log has `tariff.created`, `billing.currency_changed`, `dashboard.created`, `dashboard.updated`.

Also record, as one block in the report: the `N passed` lines of `uv run pytest` and `npm test`; typecheck and build clean; the main chunk's name, raw and gzip size, and the lazy chunk names; `3 passed` from the isolated run; `dcdash_dbdata` still listed; `alembic current` = `0004 (head)`; `check_web.sh` and `smoke.py` `OK`.

Review Focus coverage (each number must be named in at least one test file of its owning task):

```bash
cd /home/ziad/Projects/DC_Dashboard
for n in 1 2 3 4 5; do echo "Review Focus $n: $(grep -rl "Review Focus $n" backend/tests frontend/src frontend/e2e | wc -l) file(s)"; done
```
Expected: every line reports 1 or more files (Focus 3 includes `frontend/e2e/phase3.spec.ts`). A 0 is a gap in the owning task: report it, do not paper over it.

- [ ] **Step 9: Commit and push**

```bash
cd /home/ziad/Projects/DC_Dashboard
git add frontend/e2e/phase3.spec.ts frontend/e2e/playwright.config.ts frontend/e2e/global-setup.ts README.md
# only if Step 7 forced a change:  git add scripts/smoke.py
git commit -m "$(cat <<'EOF'
test: phase 3 end-to-end journey; README for dashboards, billing and tariffs

Adds the phase3 Playwright project (after discovery) and phase3.spec.ts: an admin
sets the currency and a site default rate, Billing shows a dash while no rate exists
and priced rows, a month CSV and a cost tile afterwards; an operator builds, saves and
reloads a dashboard with a stat and a bar widget, changes its range and exports a
widget CSV; a viewer is read-only (UI and API); the Audit log has the Phase 3 actions.
README documents Dashboards, Billing, Tariffs, the energy engine and its limits, the
new commands and the e2e procedure, with the data-safety warning kept prominent.
global-setup no longer tells a reader to run scripts/e2e.sh (it deletes dcdash_dbdata);
it points at the isolated -p dcdash_e2e procedure. The freshness guard is unchanged.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
git status --short
```
Expected: the push succeeds. If `git status --short` still lists `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (Step 1 note), commit exactly that file now, separately:

```bash
git add docs/superpowers/specs/2026-10-06-dc-dashboard-design.md
git commit -m "$(cat <<'EOF'
docs: spec note, widgets cannot use the custom metric

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
```

- [ ] **Step 10: Backlog section A is done**

Apply this exact `Edit` to `/home/ziad/Projects/DC_Dashboard/docs/superpowers/backlog.md` (the heading line is the only anchor; every bullet below it, and sections B and C, stay as they are):

old_string:
```
## A. Phase 3 Task 0 (cheap, and Phase 3 touches these areas)
```
new_string:
```
## A. Phase 3 Task 0 (cheap, and Phase 3 touches these areas) — DONE

Done in Phase 3 Task 0 (branch `phase-3-dashboards-billing`, merged with Phase 3). All six items below were fixed test-first; they are kept as the record of what Task 0 covered. Sections B and C are still open.
```

Then:

```bash
cd /home/ziad/Projects/DC_Dashboard
grep -n "^## A\.\|^## B\.\|^## C\." docs/superpowers/backlog.md        # A says DONE; B and C headings unchanged
git add docs/superpowers/backlog.md
git commit -m "$(cat <<'EOF'
docs: backlog section A was done in Phase 3 Task 0

Sections B (real-network readiness) and C (deferred polish) are unchanged.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EPfTGyXKvp35mxPnndrEoa
EOF
)"
git push origin phase-3-dashboards-billing
git status --short                                                      # expect: clean
```
Expected: clean working tree on `phase-3-dashboards-billing`, everything pushed. Report to the orchestrator: the Step 8 evidence block, any `fix:` commits made on the way, and anything surprising in the owner's stack (volume, migration, smoke login).

---

## Phase review and merge (orchestrator; no product code)

After row G (Task 6): **Opus backend checkpoint review** of `git diff main...HEAD -- backend`: the energy engine and cost against spec sections 6 and 10.2 (the Review Focus items 1-3 and 5 each have a named test), the role matrix of every new endpoint (anonymous 401, viewer, operator, admin), no `CONFIG_CHANNEL` notify on tariff/dashboard writes, every new write audited, and the `_now()` seams. Fix findings with one Sonnet fixer per cluster, re-review with Opus, then start the frontend rows.

After row L (Task 11): **Opus whole-branch review** of `git diff main...HEAD`:

| Spec | Implemented by |
|---|---|
| 10.1 site info, presets, whole-hour rule | Tasks 2 (timeutil), 3 (`/api/site`, zone validation), 7 (ranges, siteTime) |
| 10.2 tariffs and cost | Tasks 1 (tables), 3 (cost engine, tariff API) |
| 10.3 billing screen and CSV | Tasks 4, 8 |
| 10.4 dashboards | Tasks 1 (tables), 5 (API), 9-10 (UI) |
| 10.5 widgets | Tasks 5 (validation), 6 (data), 9 (render), 10 (editor) |
| 10.6 widget data and CSV | Tasks 6, 9 |
| 10.7 access and audit | Tasks 3, 5 |
| 10.8 screens, lazy chunks | Tasks 7-10 (bundle check in Tasks 10 and 11) |
| Section 6 energy engine, refresh window, Time rule | Tasks 1, 2, 3 |
| Sections 8 and 9 (roles, cost tile) | Tasks 3-5, 8 |
| Backlog section A | Task 0 |

The reviewer also checks: Global Constraints one by one; `grep -rn "Review Focus [1-5]" backend/tests frontend/src` finds a test for every item; no `down -v`, no `e2e.sh`, and no normal-stack `up` or rebuild was run (`docker compose --profile dev stop` is allowed; Task 11 Step 7 only with the owner's go-ahead); the main bundle chunk does not contain react-grid-layout or ECharts.

Then: one Sonnet fixer per finding cluster, an Opus re-review, `git push`. **Merge only after the owner approves**: `git checkout main && git pull --ff-only && git merge --no-ff phase-3-dashboards-billing -m "Merge phase-3-dashboards-billing: energy engine, tariffs, billing, dashboards and widgets (Phase 3)"` then `git push origin main`. Finally update the project memory (`dc-dashboard-project`: Phase 3 done, next is backlog sections B and C on the SCADA workstation).
