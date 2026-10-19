# w24 plan: the power dashboard, part 3a - month to date against the same days of last month, and a breakdown by kind

Brief: `.waves/w24.md` (rulings R1 to R15 stand unless a Ruling below changes one). Design: DESIGN.md 5.2 and 5.3 (owner: "design is read and LGTM"). Base: `main` 075db5f. Ledger: `.waves/w24/progress.md`.
**Tier L, no migration** (money figures that billing people read). Process: plan review (Opus) before code; Opus review of T1 (mandatory) and of T3 (it adds figure logic); whole-wave Opus review in a real browser; one fix wave; scoped re-review (mandatory in L).
Scratch ports: vis stack `dcdash_e2e_w24_vis` 18235/18589, look stack `dcdash_e2e_w24_look` 18236/18590 (both free by `ss -ltn` at 12:46).

## Facts checked in the code (the brief's line numbers moved after w22/w23; these are today's)
- `core/widgets.py`: `WidgetConfig` `:53` (`extra="forbid"`; `assets` field validator `:65-74` raises "choose at least one asset"), `_check_type_rules` `:127`, `validate_data_config` `:197`, `WidgetResult` `:275` (`as_json` `:291`, `csv_rows` `:322`), `_mode` `:337`, `_fill_billing` `:460-501` (ONE `hourly_energy` over the tree, `cost_by_hour`, per-asset `summarize`; cost 0.0 when a rate is in effect and nothing is priced), `compute_widget` `:504`. `api/widget_data.py:_compute` maps only `validate_data_config`'s ValueError to 422.
- `api/billing.py`: `_figure` `:48`, `_month_total` `:60`, `_split_by_day` `:78`, the per-day loop `:120-138` (a day entry exists only when `day_starts[index] <= now`; `rate_in_effect` is `rate_at(tariffs, tree, asset_id, that day) is not None`). `_active_close` `:182`; snapshot = `BillingClose.figures` (`month`, `timezone`, `currency`, `days` ISO strings, per asset `asset_id` / `days` entries / `total`). No test imports `_figure`, `_month_total` or `_split_by_day` from `api.billing` (grep).
- `core/cost.py`: `rate_at`, `cost_by_hour`, `summarize`, `no_data`, `TariffRow(asset_id, rate_per_kwh, effective_from)`. `core/energy.py`: `EnergyResult.own` (own-metered assets); `hourly_energy` needs whole UTC hours (local midnight of a whole-hour zone is one). `core/timeutil.py`: `month_bounds("YYYY-MM", tz)`, `local_days(start, end, tz)` (23/24/25-hour days, abutting), `resolve_range`.
- `assets.kind` is `NOT NULL default 'generic'` (`core/models.py:124`); `AssetNode` has no kind; `kind_key` `core/asset_kinds.py:69`.
- Stored config = `validate_config(...).model_dump(mode="json")` (`api/dashboards.py:183`); `widgets_fingerprint` hashes it.
- Front end: `lib/dashboardEdit.ts` (`WidgetForm` `:44`, `formToFields` `:196`), `WidgetEditor.tsx` (Bars label `:181`), `WidgetView.tsx` (`useWidgetData(type, config, preset)`, `preset = config.range ?? dashboardRange`), `WidgetBody.tsx`, `widgets/{StatWidget,BarWidget,TimeSeriesWidget}.tsx`, `WidgetDetails.tsx`, `api/types.ts:421` (`WidgetConfig`), `:455-470` (`WidgetData`, `WidgetValue`). The picker is w23's `AssetPicker.tsx` (single mode exists).
- The e2e specs that need readings run the dev seeder INSIDE the scratch stack (`w11.spec.ts` header, `w21.spec.ts`, `w23.spec.ts`), gated on `COMPOSE_PROJECT_NAME` starting `dcdash_e2e_`; the vis stack starts EMPTY.
- Brief correction: the comparison needs `hourly_energy` ONCE from last month's first day to the end of yesterday (about 61 days), not two calls.

## Decisions (each is a Ruling in the ledger)
**D1 Config.** `WidgetConfig` gains `bars: "asset"|"time"|"kind"`, `compare: "none"|"same_days_last_month"` (default none), `kind: str|None`, `root: int|None`, `top: int` (default 10, 3 to 50). A wrap `model_serializer` drops `compare` when `"none"`, `kind` and `root` when `None`, `top` when `10`, so every stored config, the audit digest and the pins at `test_api_dashboards.py:195`, `dashboardEdit.test.ts:134`, `DashboardPage.edit.test.tsx:198` stay exactly as they are. `formToFields` omits the same keys by the same rule.
**D2 Rules (422 text starts with the field).** The "choose at least one asset" check moves from the field validator into `_check_type_rules` (same text, skipped for `bars: "kind"`). `bars: "kind"`: type `bar`, source energy or cost, `assets` empty, `kind` 1 to 100 characters after trimming. `kind`, `root` or a `top` other than 10 with `bars != "kind"`: 422 naming the field. `compare` needs type stat or timeseries, source energy or cost, exactly ONE asset and the config's own `range == "this_month"`; the widget-data API also refuses a compare request whose effective `range` is not `this_month` (422 `range: ...`).
**D3 The windows (R7).** `today` = local date of `now`; `N = today.day - 1`; `D = min(N, length of last month)`; N == 0 gives state `nothing_yet`. This window = this month's local days 1..D; last window = last month's days 1..D; `left_out_days` = this month's days D+1..N. Days come from `local_days(*month_bounds(month, tz))` (DST-safe). ONE `hourly_energy` over [last month 00:00, end of this month's day N), ONE `cost_by_hour` (tariffs always loaded: kWh and cost come together).
**D4 One day calculation (R8).** New pure `core/daycost.py` holds `figure`, `month_total`, `split_by_day` (moved, same code) and `day_entries(hours, days, now, rate_on)` (the per-asset loop of `month_costs`); `api/billing.py` calls it and its output must stay byte-equal (golden: `/api/billing/costs?month=<last>` JSON and CSV saved from the baseline look stack BEFORE T1, diffed after). The comparison sums `month_total(entries[:D])` for each side, so "this month's figure = the sum of Billing's day cells 1..D" holds by construction (a test pins it for kWh and cost).
**D5 Closed last month (R9).** The last side of a month with an active close (`reopened_at IS NULL`) comes from `figures["assets"][asset]["days"][:D]` with the same `month_total`, never recomputed. Asset not in the snapshot: `last_state "not_in_closed"`; snapshot `timezone` differs from today's: `last_state "other_zone"` for every asset; snapshot `currency` differs: the cost side is null (`why_none "currency"`). Reopened or never closed: live.
**D6 Change and percentage (R10), per measure.** `abs` is given when both sides have a number. `percent` is null with `why_none` (first match in this order): `no_previous` (last side missing or all its days have no readings), `no_current`, `missing_days` (either window has a day with no readings: entry None or `no_data`), `partial` (cost only: either side partial), `previous_zero`, `currency`. Else `(this - last) / last * 100`. kWh and cost are never mixed. `~` (estimated) keeps the percentage and travels with the figure.
**D7 Rate note (R10).** The asset's contributing own-metered assets: walk down from the asset and stop at an own-metered node (`EnergyResult.own`). For every tariff row whose owner is the site default or an ancestor-or-self of a contributing meter, with `effective_from` in `(last window's first date, this window's last date]`, it is a change on that date if `rate_at(meter, date) != rate_at(meter, date - 1 day)` for some contributing meter. `rate_change` = the earliest such date, else null.
**D8 The response.** `as_json` gains `compare` and `breakdown` (null when unused): the contract below. For a compare widget `values[0]` (stat) holds the this-window figure and `series` (timeseries) holds this month's days 1..N as DAY points (`bucket "day"`, never hours); `range` is the span of those figures. The last side lives in `compare.assets[i].last_points` (days 1..D, timeseries only).
**D9 Breakdown (R4).** Bars = assets under `root` (descendants, the root itself excluded; `root None` = the whole site) whose `kind_key(kind)` equals `kind_key(config.kind)`; a candidate inside another candidate is dropped (counted in `inside_others`). Figures come from the SAME `_fill_billing` per-asset path (called with all outer candidates). Order: figure descending, no-data last (ties by path). `values` holds the first `top`; the CSV lists every candidate. A root that no longer exists is `missing: [root]` with an empty breakdown. `kinds` = the kinds present under the root (by `kind_key`, shown with the most frequent spelling) with counts, most frequent first. Source energy or cost only.
**D10 Front end.** `WidgetData` gets optional `compare?` / `breakdown?` so old fixtures compile. Editor: a checkbox "Compare with the same days of last month" (sets the widget range to this month and says why; offered for stat and time series with source energy or cost); Bars gains "One bar per asset of a kind" and then shows "Look under" (w23's picker in single mode plus a "Whole site" choice), "One bar for each" (kind, the registry's kinds as suggestions, an InfoTip with the R6 rule) and "Bars to show". The card's "Split by" select lists `breakdown.kinds`; the choice lives in `WidgetView` state for the visit only. Skeletons draw the same rows (reserved slots) when the config says compare or kind.
**D11 CSV.** Header unchanged. A compare stat adds one row for the last window (timestamp = its first day); a compare time series adds last month's day rows; a breakdown lists all candidates. `estimated` / `partial` / `no_data` flags travel as today.
**D12 Seeder (R14).** `--metering feeds|panels` (default `feeds`: layout and readings byte-identical for the same seed) and `--panel-unit kwh|kw` (default `kwh`; only with panels). In `panels` mode each panel gets an energy meter (counter, or power-only for `kw`) carrying the energy of the feeds it carries a current for, and the feeds get no energy or power mapping (ONE measured level).

## API contract (the backend produces it, the front end reads it; keys are exact)
```
data.compare = null | {
  mode: "same_days_last_month",
  state: "ok" | "nothing_yet",
  elapsed_days: N, days: D,
  this_window: {from: "2026-10-01", to: "2026-10-17"} | null,   // local dates, inclusive
  last_window: {from: "2026-09-01", to: "2026-09-17"} | null,
  left_out_days: ["2026-10-29", ...],                           // this month's days D+1..N, usually []
  last_month: {month: "2026-09", closed: false},
  currency: "USD",
  assets: [{
    asset_id, name,
    this: Side | null, last: Side | null,                      // null: no figure at all on that side
    last_state: "ok" | "no_readings" | "not_in_closed" | "other_zone",
    kwh: Change, cost: Change,
    rate_change: {date: "2026-10-05"} | null,
    last_points: [WidgetPoint]                                  // timeseries only, else []
  }]
}
Side   = {kwh: number, cost: number|null, estimated: bool, partial: bool, no_data_days: int}
Change = {abs: number|null, percent: number|null,
          why_none: null | "no_previous"|"no_current"|"missing_days"|"partial"|"previous_zero"|"currency"}
data.breakdown = null | {
  kind: "Rack", root: {id, name} | null,
  count: 117,                 // bars after the nested rule
  shown: 10,
  more: {count: 107, with_value: 107, value: 1234.5|null, estimated: bool, partial: bool},
  no_data: 0, inside_others: 0,
  kinds: [{kind: "Rack", count: 117}, ...]
}
```
Existing keys never change meaning (additive; `TOP_KEYS` in `test_widget_data.py:25` gains the two).

## Existing tests that will change (A1 grep done; numbers included)
- `backend/tests/test_widget_data.py:25` `TOP_KEYS` (+`compare`, `breakdown`) and every place that compares the key set; the CSV header (`:31,:840,:853`) stays.
- `backend/tests/test_widget_config.py:51` (`parsed.bars` default), `:176-192` (bars messages), any test that expects an empty-assets error together with another error in one message.
- `backend/tests/test_api_dashboards.py:195-198` (stored config must stay equal; a new test covers a compare and a kind widget), `:296` (bars=time on a stat).
- `backend/tests/test_seed_pilot_hall.py:270-278`, `:358` (442 points: the default layout stays equal; new tests for `panels`).
- Billing tests (`test_api_billing*.py`, `test_billing_close.py`, `test_month_check*.py`): unchanged; the golden diff proves it.
- Front end: `lib/dashboardEdit.test.ts:134-141` and `pages/DashboardPage.edit.test.tsx:198-205` (`formToFields` pins: keys stay out), `components/dashboard/WidgetEditor.test.tsx:133,135,365` (`getByLabelText("Bars")` is an exact match, so "Bars to show" is safe; the hidden-labels list at `:365` gains the new labels), `api/queries.test.tsx`, `src/test/dashboardFixtures.ts`, `lib/layout.test.ts` (`bars: "asset"` literals), `widgets/charts.test.tsx`, `timeSeries.ssr.test.ts`, `values.test.tsx` (output for non-compare data must not change).
- e2e: `frontend/e2e/phase3.spec.ts` and `w13Showcase.ts` mention `bars: "asset"` (stored configs; unchanged). No e2e spec looks up a label "Bars" (grep); the new spec uses `exact: true`. New label texts audited against `getByLabel(`/`getByRole(` substrings: "Compare with the same days of last month", "Look under", "One bar for each", "Bars to show", "Split by", "Whole site".
- Docs tests: `backend/tests/test_docs_links.py:21` (CHANGELOG under 80,000 bytes; it is 76,055: the w24 entry stays under 900), `test_readme_ops.py` (docs needles).

## File map
Backend: `core/daycost.py` (new), `core/compare.py` (new, pure), `core/breakdown.py` (new, pure), `core/widgets.py`, `api/billing.py`, `api/widget_data.py`, `seed/pilot_hall.py`, `seed/history.py`; tests `test_daycost.py`, `test_compare.py`, `test_breakdown.py`, `test_widget_data_compare.py`, `test_widget_data_breakdown.py`, `test_widget_config.py`, `test_seed_pilot_hall.py`.
Front end: `api/types.ts`, `lib/dashboardEdit.ts`, `lib/compare.ts` (new), `lib/breakdown.ts` (new), `components/dashboard/{WidgetEditor,WidgetView,WidgetBody,WidgetDetails,WidgetFrame}.tsx`, `widgets/{StatWidget,TimeSeriesWidget,BarWidget}.tsx`, `components/Skeleton.tsx`, styles (tokens only inside `@layer w6`; one page class per file), `frontend/e2e/w24.spec.ts` + `playwright.config.ts` (own project) + `docs/end-to-end-tests.md`.
Docs: `docs/dashboards-and-billing.md`, `docs/screens.md`, `docs/developing.md`, `CHANGELOG.md`, `docs/superpowers/backlog.md` (BH), roadmap row O-53, this plan's log.

## Tasks (one commit each, `git add` named files; implementers: Edit tool or anchored sed only)
- [ ] **T0 Baseline.** Look stack on the main tree (running), raw retention 90 days before the seed, site rate; save `GET /api/billing/costs?month=<last>` JSON and the CSV to `.waves/w24/baseline/`; the A1 grep (this plan).
- [ ] **T1 The maths (pure).** `core/daycost.py` (moved) with `api/billing.py` calling it (byte-equal), `core/compare.py` (windows and the day rule, side from entries, side from snapshot, change, rate change), unit tests: the 1st, 2nd, mid-month, last day; 28/29/30/31-day months on both sides (31 Mar vs Feb, 31 May vs Apr, 31 Jan vs Dec); a DST change inside either window (Europe/London); no data, some no-data days, a zero figure; a tariff change inside this month, inside last month and between them; estimated on either side; partial cost; closed last month with the asset in, not in, another currency, another zone; reopened; nested asset. **Opus review (mandatory).**
- [ ] **T2 Backend compare wiring.** Config keys and 422s (D1, D2), serializer, `_fill_compare` plus the closed-month query and the day buckets, `as_json` / `csv_rows`, API refusals, tests in `test_widget_data_compare.py` (equality with Billing's day cells 1..D for kWh and cost, the closed month read from the snapshot after a rate or a move, the 1st, a short previous month) and the changed pins. Measure the request on the seed.
- [ ] **T3 Backend breakdown.** `core/breakdown.py` (pure: nested rule, ordering, top and more, kinds present) plus wiring (the kinds query), CSV, tests, measured time on the pilot hall (117 racks) and on 2,000 assets. **Opus review.**
- [ ] **T4 Seeder.** D12 + tests + `docs/developing.md`.
- [ ] **T5a Front end A.** `types.ts`, `dashboardEdit.ts` (+ tests: keys stay out of `formToFields`), `WidgetEditor.tsx` (compare box, Bars mode with Look under / One bar for each / Bars to show, InfoTip), tests.
- [ ] **T5b Front end B.** `lib/compare.ts`, `lib/breakdown.ts`, StatWidget (compare lines), TimeSeriesWidget (category axis by day of month, two lines named by months, marks, tooltip with both dates), BarWidget (kind mode: top bars, "and N more ... in all", the no-data message, "Split by"), WidgetDetails lines, skeletons with reserved slots, `WidgetView` visit-only kind. Tests.
- [ ] **T6 e2e.** `w24.spec.ts` (own project): seeds the pilot hall inside the scratch stack with raw retention 90 days (restored after), reads expected figures from Billing's API, compare stat and chart, breakdown by Rack with "and N more", Split by Panel shows no data, the closed-month note, light and dark, keyboard.
- [ ] **T7 Docs.** `dashboards-and-billing.md`, `screens.md`, `developing.md` (T4), CHANGELOG (< 900 bytes), backlog BH, roadmap O-53, this log, gallery.
- [ ] **Gates** (once, near the end; heavy jobs under `flock /tmp/dcdash-heavy.lock`): full backend suite (touches `core`), vitest + typecheck + build + e2e type check, `vis-rebuild.sh`. **Whole-wave Opus review** (browser, 1920/1440/1024, light/dark, keyboard). **Fix wave**, gates again, scoped re-review. **Merge order** of RESUME.md.

## Review focus
1. By hand, for two seeded assets: Billing's day cells 1..D (this and last month) in kWh and cost against the card, to the last digit shown. 2. The day rule on the 1st, the 2nd, the 31st after a short month, across a clock change; D equal on both sides. 3. A closed last month reads the snapshot (change a rate or move an asset after the close: the card does not move, and matches Billing). 4. No percentage against zero, missing days or partial cost; `~` wherever an estimate travels (card, chart, Details, CSV). 5. A breakdown never draws a zero for a missing figure, never counts a nested asset twice, "and N more" sum right; stored configs of existing widgets unchanged. 6. Light, dark, four themes; 1920, 1440, 1024; keyboard only on the compare box, the Bars mode, Split by.
