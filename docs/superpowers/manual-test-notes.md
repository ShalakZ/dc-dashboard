# Manual test notes (section by section)

Owner-led acceptance pass over the whole DC Dashboard, one section at a time (two sections only when a
section needs the other). For each section: what to test, the expected behaviour, then what the owner
saw. Anything that feels off is logged here as a finding. When every section is done, the findings
become a plan.

Status legend: `todo`, `testing` (in progress), `done` (all items checked, findings logged).

## Section map (suggested order: each section needs the ones above it)

| # | Section | Needs | Status |
|---|---|---|---|
| 1 | Getting in and who can do what: sign-in, sign-out, Password, Users, roles | - | done (all 10 items matched; 2 ideas logged) |
| 2 | Settings: site timezone (it decides where a day and a month start) | 1 | done (all 9 items matched; zone left at Asia/Qatar; 1 ux note from Claude) |
| 3 | First run and Sources: create the admin, add and test sources, secrets, failures | 1 | done (rows 1-12 matched after fixing my script; 2 findings from the owner and Claude) |
| 4 | Assets and mapping: the tree, Browse points, Map, live and historical values, deleting | 3 | done (10 mappings in place; 9 findings S4-1..S4-9) |
| 5 | Tariffs: currency, site default rate, per-asset overrides | 4 | done (all rows matched; 1 ux finding) |
| 6 | Billing: month grid, marks, totals, CSV | 4, 5 | done (tested briefly by the owner, no defects; 1 open decision, S6-1) |
| 7 | Dashboards, part 1, building: create, widget dialog, drag and resize, Save, rename, conflicts (it also builds the dashboard that part 2 views) | 4, 5 | done (5 findings S7-1..S7-5; rows 10-13 confirmed by the owner afterwards) |
| 8 | Dashboards, part 2, using: widgets, ranges, live values, per-widget CSV | 7 | done (all 12 rows passed, no new findings) |
| 9 | Storage: sizes, tiers, retention settings | 4 | done (the rest good; findings S9-1..S9-5, incl. recommended enterprise defaults) |
| 10 | Audit: what is logged and who can see it | 1 and the others | done (log works; 7 findings S10-1..S10-7, plus S2-2 found by the inventory) |
| 11 | Scans and Discovery: find sources on the network, map by drag and drop (moved late: it adds assets and sources on top of the clean data) | 3, 4 | done (owner: works great; rows not reported one by one; 4 ideas S11-1..S11-4) |
| 12 | Operations: backup and restore, upgrade runbook, setup scripts, TLS, offline | - | testing |
| 13 | Cross-cutting: roles on every screen, phone width, keyboard use | all | todo |

(Order changed on 2026-10-09: the original section 5, Scans and Discovery, became 11, and every later
section moved up by one. Finding ids S1-S4 refer to the numbering at the time they were logged.)

## Findings log

Format: `S<section>-<n> [severity] what I did, what I expected, what happened`. Severity: `bug` (wrong
behaviour), `ux` (works but confusing), `idea` (a wish), `question` (I do not understand it).

### Section 1: Getting in and who can do what (done)

- **S1-1 [idea] (owner)** The sign-in block timer should be configurable by an admin in Settings.
  Today it is fixed in code: 5 failed sign-ins for one `host:username` inside a sliding 5-minute window
  block that pair until the window empties (`LoginLimiter(max_failures=5, window_seconds=300)` in
  `backend/dcdash/api/security.py`). The counter lives in memory, so restarting the `api` container
  clears it. To design later: an admin sets the number of failures and the block time in Settings (stored
  in the `settings` table, applied without a restart), and whether an admin can clear a block from the UI.
- **S1-2 [idea] (owner)** An admin should be able to delete accounts; today the Users page can only
  deactivate. To design later: what happens to the audit entries that name the user (keep the name, or
  anonymise), refuse deleting yourself and the last active admin, remove the user's sessions, ask for
  confirmation like the asset and source deletes do, and write an audit entry (`user.deleted`).

### Section 11: Scans and Discovery (done; the owner likes it a lot)

The owner said it is done very well and works great. The scan, the graph and the mapping dialogs were not
reported row by row. The owner asked how to read the graph (answered in the chat: source, clusters and points
on the left, dashed, are what was discovered; assets on the right, solid, are the owner's tree; a solid edge
from a point to an asset is one mapping; there is no separate "tool" entity between an asset and a source,
the mapping is the link) and thought out loud about taking it further.

- **S11-1 [idea] (owner)** Boxes should snap together: snap to a grid, magnetic alignment to neighbouring
  boxes, and a "tidy up" button, so that arrangements stay neat as they grow.
- **S11-2 [ux] (owner, from needing to ask)** The graph should explain itself: a legend (dashed means
  discovered, solid means yours, a solid edge means mapped) and a short "how to read this" hint.
- **S11-3 [idea] (owner)** Differentiate the node types visually and display them smartly: icons by asset
  kind (site, room, panel, meter) and by protocol (OPC UA, Modbus, HTTP), status colours on sources (online,
  offline, needs credentials) with last seen, counts of mapped and unmapped points per source, highlight of
  orphans (unmapped points), lanes or containers (a room as a box that holds its panels), automatic
  hierarchical layout, saved views, and export of the picture (PNG, SVG, PDF) as architecture documentation.
- **S11-4 [idea] (owner, architecture)** A user should be able to draw the architecture visually. Today the
  asset tree has one relation, "contains" (a room contains a panel). A data centre also needs "feeds" (the
  power path: utility, MV, LV panel, PDU, rack) for a single-line diagram. Decide whether "contains" and
  "feeds" are two relations, and whether Billing's roll-up follows one or the other (it follows "contains"
  today; see S6-1).

### Section 10: Audit (done; the log works, a lot is missing around it)

Audit coverage inventory (Claude, read from the source: every POST/PUT/PATCH/DELETE route, whether its code
calls `audit(`): 14 of 35 data-changing endpoints are audited.
Audited: asset delete; dashboard create, save, delete; discovery accept; scope create, update, delete; scan
start; billing currency; source delete; tariff create, update, delete.
NOT audited, high importance: user create and patch (role changes, deactivate, reactivate, admin password
reset), own password change, sign-in successes, failures and lockouts (security events), storage settings,
site timezone, mapping create, update and delete, asset create and update, source create and update.
Medium: source test, test-all and browse (they open connections toward the SCADA; scan start is audited, these
are not). Low or not needed: discovery layout save (positions), widget data (reads), logout, first-run setup
(arguably high: it creates the first admin). Outside the API entirely: backups, restores, migrations and
container restarts (operational log, not the app's).

- **S10-1 [gap] (owner)** Everything important must be audited, starting with storage updates. Use the
  inventory above as the work list; decide what counts as important (the high-importance list is the
  proposal), and make the audit write part of each route so a new route cannot forget it (a test that fails
  when a data-changing route has no audit call, with an explicit allow-list for the reads).
- **S10-2 [idea] (owner)** Filtering and searching: by user, action, date range, and text inside the detail,
  plus quick filters (for example "only deletions", "only today").
- **S10-3 [idea] (owner)** Export: CSV (and perhaps JSON) of the filtered view, with timestamps in the site
  zone with offset, the same CSV safety rules as the other exports (BOM, formula-injection prefix).
- **S10-4 [idea] (owner)** Navigation: jump to a date, page controls that scale, and entries that link to the
  object they are about (asset, dashboard, tariff, source), with permanent links to one entry.
- **S10-5 [ux] (owner)** The screen itself needs a UI and UX pass.
- **S10-6 [idea] (owner)** Two views of an entry: the raw log (exactly what is stored, the detail as JSON)
  and a friendly one ("admin changed the site currency from QAR to USD", with before and after shown side by
  side). The friendly view needs the old values stored too: today `tariff.updated` keeps only the new values
  (final review finding F6).
- **S10-7 [idea] (Claude, enterprise)** Decide the audit log's own policy: how long entries are kept, that
  nobody can edit or delete them from the app (true today: the screen is read-only, but a database
  administrator can), and optional forwarding to a central log (syslog or a SIEM) for sites that need
  tamper-evidence.

### Section 9: Storage (testing; the owner found the rest good)

Checked by Claude in the database after the owner's change: the stored setting (raw 14 days, compress after
3, 1-minute rollups 730, warn 70) and the live TimescaleDB policies agree (`readings` compression 3 days,
retention 14 days, `readings_1m` retention 730 days), so the screen really drives the database. The warning
works as specified: `used_pct >= warn_threshold_pct` shows an alert in the page (UI only, no outbound
alert). Measured on the dev data: 14,345 raw rows take 2,064 kB (about 147 bytes per row including indexes
at this tiny size), 10 live streams make about 4,560 rows an hour (about 109k a day), chunks are 7 days, so
the real compression ratio cannot be seen until data is older than the compression delay.

- **S9-1 [idea] (owner)** The Storage form needs a **Reset** button and a **Set as default** button. Reading
  to confirm with the owner: Reset throws away unsaved edits and shows the saved values again; Set as
  default fills in the factory values (raw 30, compress after 7, 1-minute rollups 730, capacity 100 GB,
  warn 80) and saves, or leaves them to Save. The other possible meaning of "set as default" is "make the
  current values the organisation's defaults for later resets". Decide when planning.
- **S9-2 [safety] (Claude)** Shortening a retention period gives no warning and no confirmation, yet the
  next policy run deletes everything older than the new limit, permanently (checked: nothing in
  `StoragePage.tsx` asks). Idea: a confirmation that says what will be deleted (readings older than N days,
  about X rows) before saving.
- **S9-3 [gap] (Claude)** Storage settings changes are not written to the Audit log (no `audit(` call in
  `backend/dcdash/api/storage.py`), although they decide how long data survives. Idea: audit
  `storage.changed` with the old and new values.
- **S9-4 [idea] (owner's enterprise question, answered in the chat; for the planning phase)** Enterprise
  policy items: a default polling policy (the 5 s default for six metrics is the main driver of volume),
  named retention profiles (lean, standard, forensic), outbound alerts for the capacity warning, scheduled
  off-host backups (`scripts/backup.sh` is manual), and a change-control step for retention (confirm, audit,
  perhaps a second approver in strict organisations).

- **S9-5 [decision for the plan] (owner asked what enterprise defaults should be)** Recommended factory
  defaults for a data-centre installation (Claude's judgement from the retention rules of the app and
  typical time-series practice, not a standard; the site's own regulatory and contractual obligations
  override it): raw retention 30 days (14 when the volume is tight), compress after 7 days (leave: chunks
  are 7 days wide, so compressing earlier changes nothing useful), 1-minute rollup retention 365 days
  (today 730), hourly rollup kept forever (unchanged), disk capacity = the real size of the database volume
  (no universal default: ask at install; today a 100 GB placeholder), warn at 70 % (today 80). The values
  the owner typed during testing (14 / 3 / 730 / 100 / 70) are test values, not a proposal. Facts behind it:
  retention drops whole 7-day chunks, so effective raw retention is up to 7 days longer than the setting;
  measured row costs on the dev data are about 147 bytes (raw) and at most about 195 bytes (1-minute
  rollup, inflated by overhead at tiny size); at scale the 1-minute tier is the biggest consumer and it is
  not compressed today (only `readings` has a compression policy). Idea: compress the rollups, and make the
  polling interval the main sizing lever (see S9-4). To do: change `StorageSettings` defaults and the
  seeded value, then re-check the migration seed and the Storage page defaults button (S9-1).

### Section 7: Dashboards, part 1, building (done; rows 10-13 confirmed by the owner afterwards)

The owner built a dashboard with a stat, a gauge, a time series, two bar charts and a table, and said the
widget dialog is fine for now and it feels good overall but can be improved. Rows 10-13 (unsaved-changes
prompt, Save and reload, rename and duplicate name, two-tab conflict) were confirmed later by the owner.

- **S7-1 [bug] (owner)** The default gauge is messy: the asset name is drawn in the middle of the dial and
  overlaps the scale numbers and the needle, also when the widget is enlarged. Cause: `GaugeWidget.tsx`
  positions only the value (`detail`, `offsetCenter [0, "70%"]`); the title (the asset name) keeps the ECharts
  default position, the centre. Fix: put the name below the value or in the widget's own subtitle line,
  scale the text with the widget, and shorten long names with a tooltip.
- **S7-2 [bug] (owner)** A dashboard cannot use a wide screen: it only fills the left part (about 1200 px
  on a 2000 px display). Cause: every page shares `main { max-width: 1200px }` (`frontend/src/app.css:6`),
  while the Discovery graph opts out with `main:has(.graph-page) { max-width: none }`. A wall screen is a
  stated use of the dashboards, so dashboards should opt out the same way (maybe a "fit to screen" choice).
  Billing, with its 31 day columns, would also gain from more width.
- **S7-3 [ux] (owner)** Long asset names do not fit in a default-size widget: legends scroll or cut off
  and bar labels are shortened (`MV2-R2-LV-Panel-02`). Ideas: bigger default sizes per widget type, legends
  that wrap, labels that truncate with a tooltip. S7-2 gives more room.
- **S7-4 [bug] (owner)** Dragging a widget onto an occupied place sends the displaced widget far down
  instead of only making room for the moved one. Cause: the editor uses `noCompactor` on purpose
  (`DashboardGrid.tsx:34`), so that saved positions look the same in the view and in the editor, and
  without compaction a collision just pushes the other widget below. Options: vertical compaction in the
  editor, the view and on Save (editor and view must stay identical), or swapping positions when dropping
  on an occupied place. Also `nextPosition`'s comment still says "the grid then compacts it upwards".
- **S7-5 [ux] (owner)** Deleting a widget does not ask first. Nothing is saved until Save (Cancel or Reload
  undoes it) but there is no undo inside a session. Ideas: confirm like the other deletes, or an "Undo"
  link right after a delete.

### Section 6: Billing (done, tested briefly by the owner)

The owner checked the grid, marks, CSV and the rate changes briefly and found no defects. What the
automated tests and the e2e cover (the grid, the CSV header, shaded and empty cells, cost arithmetic, widget
totals equal to Billing totals) was not walked row by row on the owner's data. Rows worth a glance when
convenient: 4 (asset page equals Billing), 6 and 7 (roll-ups), 10 (CSV).

- **S6-1 [open decision] (owner)** A parent's cost is its own energy times the rate that applies to the
  PARENT (its own override, an ancestor's, else the site default), never the sum of its children's
  costs. With Room 2 on 0.30 and MV2 on 0.12, MV2's cost is not Room 1's cost plus Room 2's cost. The owner
  will confirm with the real administrators which behaviour they want; left as it is for now. If it
  changes, it is one rule in `core/cost.py` (price each leaf, then sum up the tree) plus the spec
  sentence in section 10.2.

### Section 5: Tariffs (done)

Everything in the script matched (currency validation and confirmations, site default rate, overrides,
cost arithmetic, future-dated rate).

- **S5-1 [ux] (owner)** The up and down arrows in a rate box jump a whole unit (0.12 to 1.12), not by
  cents. Cause: both rate inputs use `step="any"` (`frontend/src/pages/TariffsPage.tsx:101` and `:152`),
  which makes the browser step by 1. Fix: `step="0.01"` on both. Typed values with up to six decimals
  stay valid because the forms skip the browser's own validation (`noValidate`) and the server does the
  checking. Worth checking other number boxes for the same habit (mapping Scale, Storage settings).

### Section 4: Assets and mapping (done)

Owner's state at 11:47: assets `MV2` (DC) > `MV2-Room-1` (Room) > `MV2-R1-LV-Panel-01`, `-02`, and
`MV2-Room-2` > `MV2-R2-LV-Panel-01`, `-02` (kind `LV_Panel`, sort orders 1 and 2). Mappings: `MV2-R1-LV-Panel-01`
has `active_power_kw`, `current_a`, `energy_kwh`, `voltage_v` from `sim-opcua` (LVP01), and
`MV2-R2-LV-Panel-01` has `active_power_kw` from `LVP02 kW`. Readings are flowing (newest within seconds
of the check). Unmapping and deleting work (owner). S3-1 reproduced: `sim-modbus` and `sim-http` have no
mapping, so they show `online` with a Last seen about 6 minutes old.

- **S4-1 [ux] (owner)** Adding a child asset means choosing the parent in a dropdown each time, which
  gets harder as the list grows. The owner then found you can already add under a specific asset by
  pressing it. So the need is to make that obvious: for example a `+` next to each branch that preselects
  the parent.
- **S4-2 [idea] (owner)** `Kind` is free text, so the naming convention has to be remembered (`LV_Panel`
  vs `LV panel`). Make it a dropdown or a pick from a list of defined kinds, maybe with the same
  "choose where you are" behaviour as S4-1. Not decided yet.
- **S4-3 [bug] (owner)** Duplicate asset names are allowed, even with the same kind, and there is no
  refusal text. With two `LV_Panel_01` in two rooms, the asset list in the mapping dialog shows both as
  `LV_Panel_01` with no way to tell which room each is in, so a point can be mapped to the wrong one. The
  same bare-name problem was fixed for the Tariffs picker and the dashboard asset picker (labelled by
  path) but not here: the mapping dialog's Asset list and the Assets form's Parent list still show bare
  names. Policy to decide: refuse the same name under the same parent (a real duplicate), allow it
  under different parents, and show the path in every asset list.
- **S4-4 [ux] (owner)** Mapping a point means scrolling all the way down to the mapping form. To tackle
  in the UI polish.
- **S4-5 [idea] (owner)** The points list needs sorting (name, address, type, unit, mapped or not) and
  most likely a filter such as "unmapped only" and a search. Without it, mapping 60 points per source is
  slow and error-prone, and a real SCADA will have far more.

Second round (owner): the duplicate-asset and duplicate-mapping refusal works (a point has one mapping,
an asset has one per metric). Live tiles and tables update; the 1h `energy_kwh` chart is empty; charts
need a refresh to move. Screenshots of the two rooms show `reconnecting…`, Live power `—`, Energy today
13.03 kWh (estimated) and 10.70 kWh (estimated), Cost today `— no rate set`, Trend "No metric to chart",
Metrics "No metrics are mapped to this asset".

- **S4-6 [bug] (owner)** The Trend chart on an asset page is EMPTY for `energy_kwh` on the 1h range.
  Cause: `withGaps` in `frontend/src/components/TrendChart.tsx` inserts a gap whenever two points are
  more than 1.5 buckets apart. A 1h range has 12 s buckets and energy arrives every 60 s, so every point
  is alone, and a lone point is drawn as nothing (`symbol: "none"`). It is the same bug that was fixed in
  the dashboard widgets (isolated points get a dot; gap size from the median step) but this older chart
  was never updated. Any metric sampled slower than about 18 s is affected on the default 1h range.
  Fix: reuse the widgets' rules in `TrendChart`.
- **S4-7 [ux] (owner)** The Trend chart does not move live while the tiles and tables do. The tiles use
  the live stream (every few seconds); the chart refetches every 30 s (`useSeries`,
  `refetchInterval: 30_000`), so it looks frozen. Ideas: append streamed points, refetch faster on short
  ranges, or at least show "updated hh:mm:ss".
- **S4-8 [bug] (from the owner's screenshots)** An asset with no points of its own (a room) shows
  `reconnecting…` next to its title forever. The label is `connected ? "live" : "reconnecting…"`, and
  with nothing to subscribe to no connection is ever opened. It should say nothing, or "no live data".
- **S4-9 [idea] (from the owner's screenshots)** Parent assets show Live power `—`, an empty Trend and
  an empty Metrics table, although Energy today does roll up from the children. Ideas: roll up the
  children's live power, let the Trend show the rolled-up energy for a parent, and explain `(estimated)`
  (part of the figure came from average power x time, not from an energy counter) with a tooltip.

Mappings completed by Claude at the owner's request (direct database insert plus the collector
notification, the same rows `POST /api/mappings` writes; ids 30-32): `MV2-R1-LV-Panel-02` energy from
`sim-http` `LVP01 kWh`, `MV2-R2-LV-Panel-01` energy from `sim-opcua` `LVP02 kWh`, `MV2-R2-LV-Panel-02`
energy from `sim-modbus` `LVP01 kWh` (all 60 s, scale 1). Final state, 10 mappings, readings flowing on
all of them, all three sources online:

| Asset | Power (every 5 s) | Energy (every 60 s) | Also |
|---|---|---|---|
| MV2-R1-LV-Panel-01 | sim-opcua LVP01 kW | sim-opcua LVP01 kWh | voltage and current from sim-opcua LVP01 |
| MV2-R1-LV-Panel-02 | sim-http LVP01 kW | sim-http LVP01 kWh | |
| MV2-R2-LV-Panel-01 | sim-opcua LVP02 kW | sim-opcua LVP02 kWh | |
| MV2-R2-LV-Panel-02 | sim-modbus LVP01 kW | sim-modbus LVP01 kWh | |

### Section 3: First run and Sources (done)

Fresh start (owner chose option A, 2026-10-09 11:05): the dev database was backed up to
`backups/dcdash-20261009-110350.dump` (schema 0004, it held the leftovers described below, the test users
`op1` and `view1` and the Qatar timezone), then wiped (`down -v`) and started clean from `main`
(`e6ca151`). Migrations ran from scratch to `0004 (head)`, no errors. Seeded settings: timezone `UTC`
(from `.env`), currency `null`, storage 30 days raw / 7 days compression / 730 days 1-minute, scan network
`172.20.0.0/24`. All tables empty, first-run page waiting (`needed: true`).

Result (owner): rows 1-12 matched. Row 6 first showed `offline`, `auth_failed: credentials rejected`
because Claude's script left out the Secret: the dev HTTP simulator needs the API key `sim-key`
(`compose.yaml`: `SIM_API_KEY: sim-key`; the `simulator` connector sends the source's Secret as the
`X-API-Key` header). The OPC UA simulator has no password (`SIM_OPCUA_PASSWORD` unset), so it accepts any
login. The owner recreated `sim-http` with the secret: Test OK in 4 ms.

- **S3-3 [docs]** The README never says that the dev simulator's HTTP endpoint needs `sim-key` as the
  source Secret. A first-time user adding the simulator the way the README describes gets
  `auth_failed`.
- **S3-4 [bug] (owner)** The Sources page has no Edit: to change a secret or any setting you must delete
  the source and add it again. The API supports it (`PATCH /api/sources/{id}`, admin) and the Discovery
  side panel (a source's Details) edits credentials, but the Sources page does not. Idea: an Edit on the
  Sources page using the same form as Add.
- **S3-5 [idea] (Claude, for section 11)** The README says user management and source create/edit are not
  audited (only the Phase 3 actions: tariffs, currency, dashboards, asset and source deletes). Consider
  auditing user and source changes. It ties into S1-2 (deleting accounts).

Found by Claude while preparing (not by the owner):

- **S3-1 [ux]** A source with no mapped points is never polled (the collector only reads the mapped
  points of enabled sources, `collector/scheduler.py`), and `Last seen` only advances on a successful
  poll. So the dev source `sim-modbus` (0 mapped points) keeps showing status `online` with a
  `Last seen` that is hours old. The status is just the last known one. Idea: show "not polled (no mapped
  points)" instead of a stale `online`.
- **S3-2 [idea]** The dev database holds leftovers of `scripts/smoke.py`: three assets all named
  `smoke-asset` (ids 2, 3, 4), an asset `Smoke Panel`, and a nonsense mapping (the voltage point
  `LVP08 V`, unit hint V, mapped to `energy_kwh` on a `smoke-asset`). The app accepted that mapping
  without any warning. Idea: warn in the mapping dialog when a point's unit hint does not fit the chosen
  metric (V on an energy metric). The duplicate names are what Billing and the Tariffs picker had to be
  taught to tell apart.

### Section 2: Settings (done)

- **S2-1 [ux] (found by Claude while preparing the section)** The hint under the Timezone field reads
  "Used for "today" in energy totals. Readings are stored in UTC." Since Phase 3 the zone also decides
  where a day and a month start on Billing and on dashboard ranges (`today`, `yesterday`, `this_month`,
  `last_month`), and the times shown on the Audit page, the asset chart and the dashboards. The hint
  understates it (`frontend/src/pages/SettingsPage.tsx`).
- **S2-2 [gap] (found by Claude in section 10; also a correction)** Changing the site timezone is NOT
  written to the Audit log (`PUT /api/settings/general` has no `audit(` call; only the currency is audited).
  In the section 2 script Claude wrongly told the owner that an entry for the settings change would
  appear in Audit. It would not. The timezone decides every day boundary and every displayed time, so it
  must be audited (old and new zone).
