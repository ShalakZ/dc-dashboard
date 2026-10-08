# DC Dashboard — Design Spec

Date: 2026-10-06
Status: approved 2026-10-06; section 7 updated 2026-10-07 (phase 2); sections 4, 6, 8, 9, 10 and 14 updated 2026-10-08 (phase 3, awaiting review)

## 1. Purpose

A self-hosted web tool that collects electrical data from data center systems,
organizes it under a hierarchy the admin defines, and shows it as live values,
history charts, and running cost.

It starts with about 10 LV panels exposed by a SCADA system and is meant to
grow into a general data center resource utilization tool, so every part that
touches an external system is a plugin.

The defining experience: the admin presses Scan, the tool finds the reachable
data sources and their signals, shows them as a linked graph, and the admin
drags them into a structure of their own naming. Charts and costs follow from
that structure without further setup.

### Success criteria

1. From a fresh clone, one command starts the whole tool.
2. An admin can add a source, see its points, map them to an asset, and see
   live data within minutes (phase 1).
3. An admin can scan a confirmed network scope, see discovered sources and
   points as a graph with suggested groupings, and arrange them by drag and
   drop (phase 2).
4. An operator can build a dashboard from widgets without writing code, and
   anyone can see what each panel costs per day and month (phase 3).
5. Adding support for a new kind of source means adding one connector module,
   with no change to the rest of the app.

## 2. Constraints and decisions

| Topic | Decision |
|---|---|
| Direction of data | Read-only. The tool never writes to or commands SCADA or field devices. |
| Data access | Expected to be a SCADA vendor API reached through a firewall between the SCADA and IT networks. Vendor and protocol unconfirmed, so common protocols are supported as connectors. |
| Host | Windows workstation with internet and admin rights for development (Docker Desktop on WSL2). A dedicated Linux server is expected later. Nothing may be Windows-specific. |
| Users | A handful of people using browsers on other PCs on the IT network. |
| Accounts | Local accounts with three roles. Active Directory / SSO is out of scope. |
| Billing | Internal cost visibility only: rate × kWh. No invoices, no time-of-use rates. |
| Live data | Per-point polling down to 1 second; values pushed to the browser. |
| Storage | Tiered retention with compression; usage visible to the admin. |
| UI | Minimal and functional. Visual polish is not a goal yet. |

## 3. Architecture

One custom application, four services, started by Docker Compose.

```
 Browsers on IT network
          │
     ┌────▼────┐     ┌──────────┐     ┌─────────────────────┐
     │   web   │────▶│   api    │────▶│  db                 │
     │ (Caddy  │     │ (FastAPI)│     │  Postgres+Timescale │
     │ + React)│     └──────────┘     └──────────▲──────────┘
     └─────────┘                                 │
                                      ┌──────────┴──────────┐
                                      │  collector          │──▶ sources (read-only)
                                      └─────────────────────┘
```

| Service | Responsibility | Talks to |
|---|---|---|
| `web` | Caddy serves the built React app on one port and proxies `/api` to `api`. | `api` |
| `api` | Authentication and roles, configuration CRUD, data queries, live stream, storage statistics. Never contacts a source. | `db` |
| `collector` | The only service that contacts sources. Runs connectors for polling, connection tests, browsing, and (phase 2) scans. | `db`, sources |
| `db` | PostgreSQL with the TimescaleDB extension. Holds configuration, the source graph, and time series. Data lives in a named Docker volume. | — |

A fifth service, `simulator`, runs only under the Compose `dev` profile.

### How `api` and `collector` cooperate

They share only the database.

- **Commands** (test a connection, browse a source, run a scan): `api` inserts
  a row in `jobs` and issues a Postgres `NOTIFY`. `collector` listens, runs the
  job, and writes the result back to the row. The UI polls the job until it
  finishes.
- **Configuration changes** (source added, interval changed, point mapped):
  `api` writes the change and notifies; `collector` reloads its schedule.
- **Live values**: `collector` upserts each point's newest value into
  `point_latest` and notifies; `api` listens and fans the values out to
  browsers over Server-Sent Events.

This keeps a slow or dead source from ever blocking the UI, and means only one
container needs network access toward the SCADA side.

### Technology

| Layer | Choice |
|---|---|
| Backend language | Python 3.12, packaged with `uv` |
| API | FastAPI, Pydantic v2, SQLAlchemy 2 (async) with asyncpg, Alembic migrations |
| Collector | asyncio; `asyncua` for OPC UA, `pymodbus` for Modbus TCP, `httpx` for HTTP |
| Database | PostgreSQL + TimescaleDB (hypertables, compression, continuous aggregates, retention policies) |
| Frontend | React, TypeScript, Vite, TanStack Query, ECharts |
| Later frontend additions | React Flow for the graph (phase 2), react-grid-layout for dashboards (phase 3) |
| Web server | Caddy |
| Tests | pytest, Vitest, Playwright |

MongoDB and a separate time-series database were considered and rejected: the
configuration is relational, and TimescaleDB handles the time series inside
the same Postgres instance, leaving one system to back up and secure.

### Repository layout

```
backend/
  dcdash/
    api/            routes, auth, schemas
    collector/      scheduler, job runner, writer
    connectors/     base.py, simulator.py, opcua.py, modbus.py
    profiles/       Modbus device register maps (YAML)
    core/           models, energy calculation, settings, crypto
  migrations/
  tests/
frontend/
  src/
simulator/
deploy/
  docker-compose.yml
  Caddyfile
scripts/            setup, backup, restore
docs/
```

## 4. Core concepts and data model

| Concept | Meaning |
|---|---|
| Source | A connection to an external system: connector type, address, encrypted credentials, status. |
| Point | One numeric signal a source offers, with the source's own name and address for it. |
| Asset | A node in the admin's hierarchy (Site → MV2 → LV Panel 1). Has a parent, a name, and a kind. |
| Mapping | Links a point to an asset as a specific metric, with a scale factor and a polling interval. |
| Reading | A timestamped value for a point, with a quality flag. |
| Tariff | A rate per kWh for an asset, or for the whole site, from an effective date (phase 3). The currency is one site setting. |
| Dashboard / Widget | A saved grid of charts bound to assets and metrics (phase 3). |

Discovery and browsing produce sources and points. Mapping a point to an asset
gives it meaning and starts its collection. Asset pages, dashboards, and
billing refer only to assets and metrics, so replacing the source behind an
asset does not break anything built on top of it.

### Metrics

A mapping assigns one metric from a fixed list, which is what allows automatic
asset pages and billing:

`active_power_kw`, `energy_kwh`, `voltage_v`, `current_a`, `power_factor`,
`frequency_hz`, `reactive_power_kvar`, `apparent_power_kva`, `custom`.

The scale factor converts the source's unit to the metric's unit (for example
W → kW is 0.001). `custom` carries a free-text unit and appears in charts but
not in energy or cost calculations. Boolean points are stored as 0/1. String
points are not collected.

### Tables

| Table | Key columns |
|---|---|
| `users` | id, username, password_hash (argon2), role, active |
| `sessions` | id, user_id, expires_at |
| `sources` | id, name, connector_type, config (JSON), secret (encrypted), enabled, status, last_seen, last_error |
| `points` | id, source_id, address, name, data_type, unit_hint, discovered_at |
| `assets` | id, parent_id, name, kind, sort_order |
| `mappings` | id, point_id (unique), asset_id, metric, scale, interval_seconds |
| `readings` | point_id, ts, value (double), quality — hypertable |
| `point_latest` | point_id, ts, value, quality |
| `jobs` | id, kind, params, status, result, requested_by, created_at, finished_at |
| `audit_log` | id, user_id, action, detail, ts |
| `settings` | key, value |

Phase 2 adds `scan_scopes`, `scans`, `scan_findings`, `graph_layout`, and
`sources.origin` (section 7.2). Phase 3 adds `tariffs`, `dashboards`, and
`widgets` (sections 10.2 and 10.4) and a `billing` row in `settings`.

## 5. Connectors

A connector is one Python module that registers itself by type name and
implements:

| Operation | Purpose |
|---|---|
| `config_schema` | A Pydantic model describing the connection settings; the UI renders its form from this. |
| `probe(host, port)` | Phase 2, a classmethod (there is no configured instance yet). Returns a claim (suggested config, a label) if something this connector understands is at the address, otherwise nothing. Probes use only requests the connector may already issue. |
| `endpoint_key(config)` | Phase 2, a classmethod. A normalized `(host, port, qualifier)` tuple used to match a discovered endpoint to an existing source. |
| `test()` | Connects and reports OK with latency, authentication failed, timeout, or protocol error. |
| `browse()` | Lists the points the source offers. |
| `read(points)` | Returns current values with timestamps and quality. |

Connectors may only issue requests that retrieve data: OPC UA Browse and Read;
Modbus function codes 1–4 and 43; HTTP GET, plus POST only where an API
requires it to authenticate or to submit a query.

| Connector | Phase | Browsing behavior |
|---|---|---|
| Simulator | 1 | Returns the simulated panels' points. |
| OPC UA | 1 | Walks the address space; points arrive named. |
| Modbus TCP | 1 | Reads device identification and applies a matching YAML profile from `profiles/`. With no match the source is flagged as needing a profile, and the admin can select one. |
| SCADA vendor API | When the vendor is known | Depends on the API. |
| BACnet, SNMP | When something needs them | — |

## 6. Collection and storage

### Polling

- Each mapping has its own interval, minimum 1 second. Defaults: 5 seconds for
  power and electrical values, 60 seconds for energy counters.
- The collector groups a source's points by interval and reads each group in
  one request where the protocol allows.
- Readings are written in batches about once per second.
- The tool cannot be more current than the source: polling faster than the
  source refreshes gains nothing.

### Tiers

| Tier | Resolution | Default retention |
|---|---|---|
| Raw (`readings`) | As collected | 30 days, compressed after 7 |
| `readings_1m` | min / max / avg / last per minute | 2 years |
| `readings_1h` | min / max / avg / last per hour | Indefinitely |

The rollups are TimescaleDB continuous aggregates. Daily and monthly figures
are computed from the hourly rollup at query time, using day boundaries in the
configured timezone. Retention periods are admin
settings that update the database policies. Chart queries choose the tier from
the requested time range so that long ranges stay fast.

Both rollups are refreshed over a trailing 7-day window (phase 3; `readings_1h`
is built on `readings_1m`, so both are widened), so readings the collector
writes late after an outage still reach them. Data that arrives later than
that stays in raw until it expires and is never rolled up.
Raw retention must therefore be at least 8 days (one more than the refresh window); Settings refuses a shorter value.

Sizing estimate: 200 points at 1 second is about 17 million readings per day,
on the order of 1–2 GB/day before compression and roughly a tenth of that
after. At the default intervals it is far less. The admin Storage panel shows
actual database size, growth per day, and projected days until the disk is
full, and warns past a configurable threshold.

### Energy

One engine produces every energy figure (asset page, billing, dashboards). It
reads the hourly rollup, so figures agree everywhere and stay available after
raw data expires (phase 3; before that the asset page read raw readings). Hours
are the unit; days and months are sums of hours in the site timezone.

- If an asset has an `energy_kwh` mapping, the consumption of an hour is the
  hour's last counter value minus the previous bucket's last value. The first
  hour of a period uses the last bucket before the period as its baseline, so
  consumption accumulated across the boundary counts toward the period, and a
  gap in the data attributes what the meter counted to the hour in which the
  next value arrives. With no earlier bucket, the first hour counts
  `last - min`.
- A decrease is a counter reset or rollover. If an hour's minimum is below the
  previous bucket's last value, the hour counts
  `max(0, max - previous_last) + (last - min)`: the step across the reset adds
  nothing, no negative or inflated consumption is recorded, and one reset per
  hour is recovered exactly.
- If an asset has only `active_power_kw`, the consumption of an hour is its
  average power times the time covered by samples (`n` times the mapping
  interval, at most one hour), so outages add nothing. It is labeled as
  estimated wherever it is shown.
- A parent asset's consumption is its own meter if it has one, otherwise the
  sum of its children. A meter with no readings in the period counts 0 and
  does not fall back to its children; an asset with no energy or power mapping
  anywhere in its subtree has no figure.

### Time

Stored in UTC. Displayed in the timezone configured in settings, which also
defines where a "day" and a "month" begin for energy and cost. From phase 3 the
zone must have a whole-hour UTC offset in both January and July, so that day
and month edges fall on hourly rollup buckets; Settings refuses any other zone
and daylight saving time is supported.

## 7. Discovery (phase 2)

Updated 2026-10-07 after the phase 2 design review. Everything here is
read-only toward the network: a scan opens TCP connections and issues the same
data-retrieval requests connectors already use, nothing else.

### 7.1 Flow

1. The admin keeps named **scan scopes**: a list of targets (CIDR ranges, host
   names or addresses, URLs) and a list of ports. A new scope form is
   pre-filled with each of the collector's own network interfaces, clamped to
   the /24 around its address (in development this contains the simulator).
2. Pressing Scan shows "N hosts × M ports" and asks for confirmation on every
   run. The confirmation is enforced by the API: the start request must carry
   `confirm_host_count`, which must equal the API's own expansion of the
   scope's targets, or it is rejected and nothing runs. The start request must
   also carry the digest returned by the preview (a hash of the scope's targets
   and ports), so a scope edited after it was previewed cannot be started
   unconfirmed. A scan never exceeds `DCDASH_SCAN_MAX_HOSTS` hosts (default
   1024).
3. The collector runs one `scan` job:
   1. **Sweep**: a TCP connect to every (host, port) pair, at most 64 at a
      time and 200 attempts per second, 1 second timeout. Only pairs that
      accept a connection continue.
   2. **Probe**: every connector's `probe` is tried on each open endpoint (3
      second timeout each); the first to claim it wins. Open endpoints nobody
      claims are recorded as unidentified services.
   3. **Adopt as discovered sources**: each claim becomes a `sources` row with
      `origin = 'discovered'` and `enabled = false`. Claims are matched to
      existing sources by an endpoint key computed by the connector, so a
      source the admin added by hand at the same address is reused, never
      duplicated. A re-scan reuses existing source rows untouched (name,
      config, secret, enabled, origin) and only refreshes their points and
      findings.
   4. **Browse**: claimed sources are browsed (4 at a time) with the existing
      browse logic, which writes `points`. A source that answers
      `auth_failed` is flagged as needing credentials and the scan continues.
4. Progress (stage and counters) is written to the `scans` row; the UI polls it
   once a second, as it does for jobs.
5. Disabled discovered sources are never polled or tested. Collection starts
   only when the admin maps points (7.5).

Because the SCADA side is behind a firewall, a scan finds only what the
network team has opened to the host.

### 7.2 Data model additions

| Table / column | Contents |
|---|---|
| `scan_scopes` | id, name, targets (JSON list), ports (JSON list), created_by, created_at. |
| `scans` | id, scope_id (null if the scope was deleted), scope_snapshot (JSON: exact targets, ports, host count, digest), status (queued, running, done, failed), stage (sweep, probe, browse), progress (JSON counters), started_by, created_at, finished_at, error. A `jobs` row of kind `scan` only triggers execution; scan history does not depend on job housekeeping. |
| `scan_findings` | scan_id, host, port, source_id (null if unclaimed), connector_type, outcome (claimed, needs_credentials, unclaimed), detail. |
| `graph_layout` | node_id (stable text such as `src:12`, `cluster:12:LVP01`, `asset:5`), x, y. Shared by all users. |
| `sources.origin` | `manual` (default) or `discovered`. Discovered, not yet adopted sources are hidden from the Sources screen until they have a mapping. |

### 7.3 Suggestions

`suggest_groups(points)` is a pure function evaluated per source when the graph
is built; nothing is stored.

- **Grouping**: split each point name on `_`, space, `.`, `/`, `:` and `-`;
  the group key is every token except the last (`LVP01 kW` → `LVP01`). A group
  needs at least two points; the rest are shown ungrouped. Groups never span
  sources: the same panel offered over HTTP, OPC UA and Modbus appears once per
  source, and the admin adopts the set from the source they prefer.
- **Metric and scale** are guessed from the point's unit hint: kW →
  `active_power_kw`, kWh → `energy_kwh`, V, A, PF, Hz, kvar, kVA to their
  metrics, W → kW and Wh → kWh with scale 0.001, anything else `custom` with
  its own unit. The interval is the existing per-metric default.

### 7.4 Graph

A single React Flow canvas on its own screen.

- **Left, discovered**: source → cluster → point nodes with dashed borders.
  Sources and clusters start collapsed; expanding a cluster shows its points.
  Unidentified services appear as grey nodes. A source that needs credentials
  is marked, and selecting a source opens a side panel to enter credentials
  and re-browse it.
- **Right, assets**: the admin's hierarchy as nodes joined by parent edges.
- **Mapped points** (including those on manually added sources) are joined to
  their asset by a solid edge.
- Node positions are saved to `graph_layout` when dragging ends.
- The API returns the domain model (sources, clusters, points, assets,
  mappings); the browser builds nodes, edges and default positions.

### 7.5 Drag and drop

- Dropping a cluster or a single point on an asset opens a **review dialog**:
  one row per point showing the guessed metric, scale and interval, all
  editable. Rows whose metric the asset already has default to unchecked.
  One click commits every checked row.
- Dropping on empty canvas offers **create asset from suggestion**: the asset
  is named after the cluster key and placed under the asset the admin picks.
- Commit calls `POST /api/discovery/accept` with the source, the target asset
  (existing, or a new one with its parent and name) and the list of
  `{point_id, metric, scale, interval_seconds}`. In one transaction it creates
  the asset if needed, creates the mappings with the same validation as the
  mappings API, enables the source if it is disabled, and writes the audit row.
  The collector reloads its schedule and collection starts.

### 7.6 Access

Admin: scope create, edit and delete, start a scan, accept, save layout, view
the audit log. Operator: view the scans, the graph and its layout. Viewer: none.

### 7.7 Audit

`audit_log` gains a small helper used by discovery. Actions recorded, each
with the user and time: `scope.created`, `scope.updated`, `scope.deleted`,
`scan.started` (scope snapshot and host count), `scan.finished` (counts of
open endpoints, claimed sources, points found, unidentified services),
`discovery.accepted` (source, asset, number of mappings). A read-only admin
Audit screen lists entries newest first with paging. Phase 1 actions (user
management, source edits and so on) are not audited yet.

## 8. Users and security

| Role | Can do |
|---|---|
| Admin | Everything: sources, assets, mappings, settings, users, scans, tariffs and currency. |
| Operator | View everything (including tariffs), view source health, run Test connections. From phase 3: create, edit and delete dashboards. |
| Viewer | View asset pages, dashboards, billing and costs, and export their data as CSV. |

- On first start, with no users in the database, the UI shows a one-time
  setup screen to create the admin.
- Passwords are hashed with argon2. Sessions are server-side, carried in an
  HTTP-only, SameSite=Strict cookie. Login attempts are rate-limited.
- Roles are enforced in the API, not only hidden in the UI.
- Source credentials are encrypted with a key held in a local `.env` file,
  which the setup script generates and which is excluded from git.
- The web port serves plain HTTP on the LAN by default. Caddy can be switched
  to TLS with a provided certificate through one setting.

## 9. User interface (phase 1)

| Screen | Content |
|---|---|
| Setup / Login | First-run admin creation; sign in. |
| Assets | The hierarchy as a tree. Admin can add, rename, move, and delete nodes. |
| Asset page | Generated automatically from the asset's mappings: live power, today's energy, a trend chart with a time range picker, and a table of all mapped metrics. Phase 3 adds a cost tile (section 10.3). |
| Sources | List with status. Add a source through a form generated from the connector's schema. Test one or all connections. Browse a source's points and map them to assets. |
| Storage | Database size, growth, projection, retention settings. |
| Users | Create users, set roles, deactivate. |

Live values arrive over Server-Sent Events. Gaps in data are drawn as gaps.

## 10. Dashboards and billing (phase 3)

Updated 2026-10-08 after the phase 3 design review. This phase only reads the
database; it never contacts a source.

### 10.1 Site info and time ranges

- `GET /api/site` (any signed-in user) returns the site timezone and currency.
  The new screens, the asset-page chart and the audit page show times in the
  site timezone.
- Range presets: rolling `1h`, `6h`, `24h`, `7d`, `30d` (ending now) and
  calendar `today`, `yesterday`, `this_month`, `last_month` (site timezone).
  The client sends the preset's name and the API resolves it to a start and
  end, so the browser and the server never disagree about where a day begins.
  There are no custom date ranges.
- A stored timezone that breaks the whole-hour rule (section 6) makes billing
  and widget-data requests fail with 409 and an explanation.

### 10.2 Tariffs and cost

| Table / setting | Contents |
|---|---|
| `tariffs` | id, asset_id (null = the site default; cascades when the asset is deleted), rate_per_kwh (non-negative, up to 6 decimals), effective_from (site-local date), created_by, created_at. At most one row per asset (or site default) and effective_from. |
| `settings.billing` | `{currency}`: a three-letter uppercase code, one for the whole site. |

- The rate for an asset in an hour is the latest row with `effective_from` on
  or before that hour's local date, taken from the nearest ancestor-or-self
  that has such a row, else from the site default. An override therefore takes
  over from its own effective date, and earlier hours keep the inherited rate.
- Cost of an hour is its kWh times that rate; day and month cost are sums of
  hours, so a mid-month rate change is exact. A parent without its own meter
  sums its children's costs, so their overrides count.
- Every cost figure carries `estimated` (any part is estimated, section 6) and
  `partial` (some hour of the period with consumption had no rate). The cost is
  null when no hour of the period has a rate; the UI shows a dash, never zero.
  An hour with no consumption never makes a figure partial.
- Admins add, edit and delete tariffs and set the currency. Editing a past
  rate recalculates history; cost is for visibility, not invoicing.

### 10.3 Billing

- A Billing screen (everyone) shows one month at a time (previous/next, default
  the current month): the asset tree by day with kWh, cost, month totals and
  the rate in effect, `~` marking estimated and `*` partial figures. A missing
  rate shows a dash, with a pointer to Tariffs for admins. A CSV button
  exports the month.
- `GET /api/billing/costs?month=YYYY-MM` returns the whole tree in one call;
  `GET /api/billing/costs.csv?month=YYYY-MM` is the same data in long form: one
  row per asset per day with kWh, cost, currency, estimated and partial.
- The asset summary gains today's cost and its energy figure comes from the
  engine; the asset page shows a cost tile.

### 10.4 Dashboards

| Table | Contents |
|---|---|
| `dashboards` | id, name (unique, at most 100 characters), range (default preset), created_by, created_at, updated_at. |
| `widgets` | id, dashboard_id (cascades), type, title (at most 100 characters), config (JSON), x, y, w, h (grid cells). |

- Dashboards are shared by everyone: viewers read; operators and admins create,
  edit and delete. A dashboard has at most 24 widgets, the site at most 50
  dashboards.
- The editor saves a whole dashboard with one `PUT /api/dashboards/{id}` in one
  transaction. The request carries the `updated_at` it loaded; if someone else
  saved since, the API answers 409 and the editor offers to reload.
- A dashboard has one range, which a widget may override.

### 10.5 Widgets

A widget config has: `assets` (at most 20), `source` (`metric`, `energy` or
`cost`), `metric` (when the source is `metric`), `aggregation` and `range`
(a preset, or null to inherit the dashboard's). The API validates the config
for each type.

| Type | Behavior |
|---|---|
| Time series | One line per asset. Metrics use the tier rules of section 6 and show the average with a min–max band; energy and cost are bucketed by hour (ranges up to 48 hours) or by day (longer ranges). |
| Bar | `bars: asset` is one bar per asset (the aggregation over the range); `bars: time` is one bar per bucket, grouped by asset. |
| Stat | One asset: the aggregation over the range, with its unit or currency. |
| Gauge | One asset, source `metric`, aggregation `last` only; `min` (default 0) and `max` are set in the config. Live. |
| Table | One row per asset with the aggregation over the range. |

- Widgets cannot use the `custom` metric (an asset can have several `custom`
  mappings and a widget names none of them); custom metrics stay on the asset
  page.
- Aggregations: `avg`, `min`, `max`, `last` for metrics; `sum` for energy and
  cost. `last` on a rolling range is the latest reading and updates live over
  the stream; on a finished calendar range it is the last value in it.
- Live widgets (stat and gauge with `last`) share one stream subscription per
  dashboard; the others refetch every 30 to 60 seconds. Gaps are drawn as gaps.
- Parent and child assets are not netted against each other: a widget showing
  both shows both totals.

### 10.6 Widget data and CSV

- `POST /api/widget-data` takes `{type, config, range}`, so the editor can
  preview an unsaved widget, and returns the figures the widget draws.
- `POST /api/widget-data/csv` exports the same query: UTF-8 with a byte-order
  mark so Excel opens it cleanly; columns asset (full path), source or metric,
  unit or currency, bucket start (site timezone, ISO with offset), value,
  `estimated`, `partial`. Cell text starting with `=`, `+`, `-`, `@`, tab or
  carriage return is prefixed with an apostrophe, because asset names are typed
  by users and spreadsheets would run them as formulas.

### 10.7 Access and audit

Admin: tariffs and currency. Operator: read tariffs; create, edit and delete
dashboards. Everyone: read dashboards, billing, widget data and CSV. Audited
actions: `tariff.created`, `tariff.updated`, `tariff.deleted`,
`billing.currency_changed`, `dashboard.created`, `dashboard.updated`,
`dashboard.deleted`. Reads and exports are not audited.

### 10.8 Screens

Dashboards (list, view, and an edit mode with a drag-and-resize grid and a
widget editor; unsaved changes prompt before leaving), Billing (10.3) and
Tariffs (admin; also the currency). The grid library and the widget charts
load only on the pages that use them.

### 10.9 Not in phase 3

Custom date ranges, per-user or default dashboards, time-of-use tariffs
(section 15), image export, and the real-network items in the backlog.

## 11. Error handling

| Situation | Behavior |
|---|---|
| Source unreachable | Retries with exponential backoff up to 60 seconds. The source is marked offline with its last error. Other sources are unaffected. |
| Read returns a bad or missing value | Stored with a bad-quality flag or skipped. Bad-quality readings are excluded from rollups and energy. |
| Missing data | Remains a gap. Values are never interpolated into storage. |
| Counter reset or rollover | Handled as described under Energy. |
| Job fails or the collector dies mid-job | The job is marked failed with the error; jobs left running by a dead collector are failed at its next start. |
| Service crash | Compose restart policy brings it back; the collector rebuilds its schedule from the database. |
| Database unavailable | The collector buffers a bounded number of readings in memory and retries; the API returns a clear service-unavailable error. |
| Disk nearly full | Warning in the UI past the configured threshold. |

On the Windows development machine, Docker Desktop starts at user sign-in
rather than at boot. The install guide documents this. The Linux server does
not have the limitation.

## 12. Operations

- `scripts/setup` generates `.env` (database password, encryption key) and
  starts the stack. After that, `docker compose up -d` is all that is needed.
- `scripts/backup` writes a database dump to `backups/`. `scripts/restore`
  loads one, using TimescaleDB's pre- and post-restore steps.
- Moving from the Windows machine to the Linux server is: clone, copy `.env`
  and the latest backup, restore, start.
- Database schema changes are Alembic migrations applied automatically when
  `api` starts.

## 13. Testing

- **Simulator**: a stand-in SCADA exposing 10 LV panels with realistic daily
  load curves over OPC UA, Modbus TCP, and HTTP. It can be told to drop
  offline, reject credentials, and reset an energy counter.
- **Unit tests**: energy calculation including resets and estimation, tier
  selection, role enforcement, credential encryption, each connector against
  the simulator.
- **Integration tests**: the stack against the simulator — add source, browse,
  map, collect, query.
- **End-to-end test**: a browser run of first-time setup through seeing a live
  value on an asset page.
- Development is test-first.

## 14. Phases

Each phase has its own implementation plan. Phases 2 and 3 get a short spec
update before their plans are written.

| Phase | Contents | Done when |
|---|---|---|
| 1. Foundation | Compose stack; schema and migrations; setup, login, roles; connector framework; simulator, OPC UA, and Modbus connectors; sources screen with test and browse; asset hierarchy; mapping; collection with tiered storage; live stream; automatic asset pages; storage panel; user management; setup, backup, and restore scripts | From a fresh clone, one command starts the tool, and an admin can add the simulator as a source, map a panel, and see live and historical data on its asset page |
| 2. Discovery | Scan scopes, port sweep, connector probing, graph view, suggested groupings, drag-and-drop mapping | Scanning the simulator's network finds its sources, and all 10 panels can be arranged by drag and drop |
| 3. Dashboards and billing | Rollup energy engine, tariffs and currency, billing screen with CSV, dashboards with five widget types over metrics, energy and cost, widget editor, widget CSV export (section 10) | An operator can build and save a dashboard, and cost per panel per day and month is visible |

The SCADA vendor API connector is written when the vendor is known and does
not block any phase.

## 15. Out of scope

- Writing to or controlling any device.
- Alarms and notifications.
- Active Directory / SSO.
- Time-of-use tariffs, invoices, customer chargeback.
- High availability and multi-site deployment.
- Mobile layouts.

## 16. External dependencies still open

| Item | Owner | How the design copes until it is known |
|---|---|---|
| SCADA vendor and API details | SCADA / network team | Development runs against the simulator; the vendor connector is a later module. |
| Firewall rules: which IPs and ports the host may reach | Network team | Sources can always be added by address; scans are limited to what is reachable. |
| How often the SCADA refreshes its values | SCADA team | Polling interval is per point and adjustable. |
| Linux server availability | Infrastructure | The stack is OS-neutral; backup and restore cover the move. |
