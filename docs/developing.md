# Developing

This page is for developers who change the code: how to run the backend and frontend tests, how to run the frontend against the API
during development, the conventions the repository follows, and where things live. The browser tests are on
[End-to-end tests](end-to-end-tests.md); a new data source is on [Adding a connector](adding-a-connector.md).

## Backend

```bash
cd backend
uv sync
uv run pytest
```

The tests start their own TimescaleDB container (testcontainers, image `timescale/timescaledb:2.30.2-pg16`, pinned in
`backend/tests/conftest.py`), so Docker must be running. `uv run pytest tests/<file>.py` runs one file; the doc-reading tests
(`tests/test_readme_ops.py`, `tests/test_field_debugging_doc.py`, `tests/test_docs_links.py`) need no Docker.

## Frontend

The dev server needs the stack running for the API:

```bash
cd frontend
npm install
npm run dev
npm test
npm run typecheck
npm run build
npm run e2e
```

- `npm run dev` serves `http://localhost:5173` and proxies `/api` to `http://localhost:8000` (`VITE_API_TARGET` points it at another
  API).
- `npm test` is `vitest run` (`npx vitest run <file>` runs one file); `npm run typecheck` is `tsc --noEmit` and covers `src` only, not
  `e2e`.
- `npm run build` is the typecheck plus the production bundle; the dashboard editor, the chart widgets and a few large pages are
  separate, lazily loaded chunks.
- `npm run e2e` is Playwright; it needs a fresh stack in an isolated Compose project, see [End-to-end tests](end-to-end-tests.md).

For `npm run dev` to reach the API without Caddy, publish it for the time being: `docker compose run --rm -p 8000:8000 api`, or add
`ports: ["8000:8000"]` to a `compose.override.yaml` (ignored by git).

## Seeding a month of history

A new stack has no past, so Billing and its **Close month…** button have nothing to show. `dcdash.seed.history` makes a month of
made-up readings for a **development or scratch stack**. It ships in the `api` image but is inert: it writes nothing unless it is
asked twice, with `--yes` and with `DCDASH_ALLOW_SEED_HISTORY=1` in its environment. **Never run it on a real installation.** A demo
install (a laptop that only shows the simulator or a test connection) is fine; a stack that holds data someone needs is not.

```bash
docker compose exec -T api python -m dcdash.seed.history                  # the dry run: prints the plan, writes nothing
docker compose exec -T -e DCDASH_ALLOW_SEED_HISTORY=1 api python -m dcdash.seed.history --yes
```

With neither switch it prints what it would create and exits 0; with `--yes` but without the variable it refuses (exit 2); when it
refuses for another reason (below) it exits 1. In every refusal nothing is written. `--days N` uses the last N days instead of the
default range, and `--seed N` changes the small random jitter (the default seed is fixed).

- **What it makes.** A disabled simulator source called `seeded-history` (the collector never polls it) and, in the Assets Tree, the
  asset **Seeded demo** with three panels: **Seeded Panel A** has an `energy_kwh` counter with a 6-hour gap (no samples) on one day,
  **Seeded Panel B** only an `active_power_kw` point (so its energy is an estimate), and **Seeded Panel C** a counter that is reset to
  near zero once in the middle of the range. Readings are every 5 minutes along a daily load curve of about 20 to 80 kW, written the way
  the collector writes them, and the two rollups are then refreshed over the range. It adds no other row and writes no audit entry.
- **The range, and why it is short.** It starts at the beginning of the previous month, but never earlier than the raw retention
  allows, also with `--days N` (30 days by default, read from the Storage settings): a rollup refresh recomputes from the raw readings, and a window that
  holds data the retention has already dropped would erase real rollup history. So it writes only inside the raw retention, and it
  refuses (exit 1) on a stack whose rollups outlive their raw data. On most days of the month the previous month therefore holds only
  its last days, which is enough to close it; in the last days of a month the default range would keep less than a day of the previous
  month, and it refuses and says so (raise the raw retention, or run it earlier in the month). A second run is refused while the source
  `seeded-history`, or a top-level asset called Seeded demo, exists.
- **Undo.** Delete the **Seeded demo** asset (Assets Tree, with the normal Delete) and the source `seeded-history` (Sources, Delete).
  That is not a full undo: as after any source delete, the readings and rollup rows of the deleted points stay behind as orphans, and the
  seeder wrote no audit row (the deletes you make do). A scratch stack is better thrown away.
- **Who uses it.** The end-to-end tests of close month (`frontend/e2e/w11.spec.ts`) seed their own history this way in a scratch
  project ([End-to-end tests](end-to-end-tests.md)); the figures of a seeded month are also what `backend/tests/test_seed_history.py`
  checks against the energy engine.

### The pilot hall (a demo tree with racks)

`--layout pilot-hall` makes a bigger made-up data centre instead of the three panels: halls, pods, rows and 117 racks with two feeds
each, and a month of readings for all of them. It is for a demo. The two switches and the refusals work as above, and the old
layout stays the default.

```bash
docker compose exec -T api python -m dcdash.seed.history --layout pilot-hall                       # the dry run: prints the plan, writes nothing
docker compose exec -T -e DCDASH_ALLOW_SEED_HISTORY=1 api python -m dcdash.seed.history --layout pilot-hall --yes
```

Run them in the folder that holds `compose.yaml`. The same two lines work on Linux, macOS and WSL and in Windows PowerShell 5.1: on the
work laptop run `scripts\update.ps1` first so the code is current, then type them in the install folder (PowerShell passes
`-e DCDASH_ALLOW_SEED_HISTORY=1`, `--layout pilot-hall` and `--yes` to docker unchanged). Options: `--interval-minutes 5|10|15|30|60`
(default 30, the spacing of the samples), `--days N` (the last N days instead of the previous month) and `--seed N`.

- **What it makes.** The Site **Seeded pilot hall** with **Hall 1** and **Hall 2**, two pods each (**Pod A**, **Pod B**), two rows per
  pod, 117 racks (Rack 01 to 59 in Hall 1, 01 to 58 in Hall 2), each with **Feed A** and **Feed B**; beside the halls an **Electrical**
  group with eight panels (Panel 1A to Panel 4B). That is 370 assets and 442 points in a disabled simulator source
  `seeded-pilot-hall`. 100 racks draw 2 to 11 kW, split about half and half between A and B; 6 are idle (a fraction of a kW); 5 have
  only Feed A; 6 are free (the feeds exist, nothing is metered, so no figure). A feed has an energy counter (`energy_kwh`) and a power
  point (`active_power_kw`) that reads the same load; the load follows the hour of the day and differs by a few per cent from one day
  to the next. Eight B feeds in Hall 2 have only the power point, so their energy is an estimate (`~`): Hall 2, the Site and the totals
  show it, Hall 1 is exact. One Hall 1 feed has a 6-hour gap and another resets once. Every name is made up, there are no tenants, and
  it writes no tariff, dashboard, audit row or asset kind.
- **Kinds.** It uses only kinds that exist. A fresh install has Site, Room, Row, Rack, Circuit and Panel, so a hall and a pod are
  "Room" there; press **Add all 39 data-centre kinds** on the Asset kinds page first
  ([The starter pack](assets-and-kinds.md#the-starter-pack)) to get **Data hall** for the halls. The dry run and the final report say
  which kind each level got.
- **Size and time.** Measured on a development PC. With the default 30 minutes and the default 30-day raw retention (29 days of data):
  about 615,000 readings and a minute and a half. With the raw retention raised to 60 days (a whole previous month, 47 days): about
  1,000,000 readings and a little over two minutes. `--interval-minutes 15` doubles the readings (about three minutes measured with
  the 60-day retention); `--interval-minutes 60` roughly halves them and `--interval-minutes 5` is about six times the default (both
  estimated from these runs, not run over a whole month). A slow laptop takes longer, a
  repeated seed on one database takes longer too (a rollup refresh also recomputes the readings of earlier, removed seeds), and
  `--days 7` makes it small. It prints "written 5 of 30 days" lines while it works.
- **The range.** From the start of the previous site month up to now, but never earlier than the raw retention allows (30 days by
  default), with the same raw-retention and rollup refusals as above. On 18 October the previous month therefore holds only 19 to 30
  September, and the first 18 days of September read 0.0 in Billing. For the whole previous month raise the raw retention first
  (Settings, Storage, 60 days; then the range starts on 1 September; see [Storage](storage.md#the-storage-page)).
- **Seeing past data.** Set a rate first: Tariffs, a site-wide rate with an effective-from date before the range, for example
  2020-01-01. Then in Billing pick the previous month (the Year and Month selects): the Site total and every hall, row and rack are
  there, with the day columns on the right (the Billing CSV has one row per asset and day at every level, so do not add up its kWh
  column). In the Assets Tree a Feed page has a Trend that opens on `active_power_kw` (the daily curve; pick `energy_kwh` for the
  rising counter) and has a 7d range; a hall, row or rack page shows Live power, Energy today and Cost today, because it adds up the
  feeds below it, but no Trend of its own. In a browser that remembers no fold, the tree (370 assets) opens folded to its second level
  (the Site, the halls and Electrical) and Billing to level 4 (24 rows); Expand all, the filter or Ctrl+K reach the rest. The data
  ends at the moment the command ran, so "Energy today", the 1h, 6h and 24h trends and the live chip only show
  something in the hours after the run: run it shortly before a demo.
- **Live power.** A parent adds up the live power of the feeds below it: the Site reads about 600 to 700 kW depending on the hour of
  the day, and each rack a few kW. Between one hour and an hour and a half after the run (three sample spacings counted from the last
  sample, which is up to half an hour old) the feeds count as not reporting and a parent says so; Billing and the 7d and month views
  are not affected.
- **Why the panels carry no kWh.** A parent without a meter adds up every child. A kWh meter on a panel beside the halls would count
  the same energy twice at the Site and in the total of Billing, so the panels carry voltage and current only (the current follows the
  feeds of their pod). Energy per panel needs a "fed by" relation between assets, which does not exist yet.
- **Refusals and "half-way".** Nothing is written without `--yes` and `DCDASH_ALLOW_SEED_HISTORY=1`. A second run is refused while the
  source `seeded-pilot-hall`, or a top-level asset **Seeded pilot hall**, exists; the old layout (Seeded demo) can exist beside it. On
  a stack whose rollups outlive their raw data it refuses and says so. A run that fails or is stopped removes what it made (source,
  assets, points, mappings and readings) and says so. If the process was killed, the next run is refused and you remove the seed by
  hand, as below. Ctrl+C on `docker compose exec` stops your terminal, not the command inside the container: wait for it to finish
  before you start another.
- **Remove it.** In the Assets Tree pick **Seeded pilot hall** and Delete (the dialog says 370 assets and 442 mappings), then in
  Sources delete `seeded-pilot-hall`. It takes under a second. As with the old layout, the readings and rollup rows of the removed
  points stay behind as orphans: the raw readings until the raw retention drops them, the rollups much later.

## Conventions

- A database change is a new Alembic migration in `backend/migrations/versions/` (the next number), with a downgrade, an entry in
  [CHANGELOG.md](../CHANGELOG.md) and a row in [Migrations in order](upgrading.md#migrations-in-order).
- Documentation: a new feature gets a section in its topic page under `docs/`; an upgrade note goes into `CHANGELOG.md` (newest
  entry at the top); `README.md` stays a short front door. `docs/superpowers/` holds plans, specs and the backlog: history, not
  user documentation.
- `scripts/*.ps1` are ASCII with CRLF line ends (`.gitattributes`) and must run on Windows PowerShell 5.1; everything else is LF.
- No tracked file may be larger than 2 MB (`backend/tests/test_repo_hygiene.py` checks the working tree and the local commits).
- External images are pinned by digest (see [Upgrading images](upgrading.md#upgrading-images)).

## Repository map

| Path | What it holds |
|---|---|
| `backend/` | the Python package `dcdash` (`api`, `collector`, `connectors`, `core`, `diagnostics`, `profiles`, `seed`, `simulator`), the Alembic migrations and the tests |
| `frontend/` | the React app (`src`), the Playwright specs (`e2e`), the static files (`public`) and the brand script (`scripts`) |
| `deploy/` | the Caddy configuration (`Caddyfile`, `Caddyfile.tls`, `security-headers.caddy`) and the web image's `entrypoint.sh` |
| `scripts/` | setup, backup, restore, update, diagnostics and test scripts, bash and PowerShell |
| `docs/` | these pages, `field-debugging.md`, the brand original and the project's planning history (`superpowers/`) |
| `certs/` | empty in git; holds the HTTPS and OPC UA certificates of an installation |
| `compose.yaml` | the stack: `db`, `api`, `collector`, `web` and the `dev`-profile `simulator` |
| `.env.example` | an example `.env`: the database password, the secret key, the timezone, the discovery limits, the TLS paths and the simulator's settings |

## Brand assets

The logo and the browser-tab icon are the owner's gold M. His original is `docs/brand/logo-original.svg`; `frontend/public/` holds what
the app serves (`logo-mark.svg` for the top bar and the sign-in page, `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`,
`icon-192.png`, `icon-512.png`). Run `make-brand-assets.mjs` (in the `frontend/scripts` folder) with `node` from `frontend/` to make
them from the original: the SVGs copy its paths (nothing is redrawn) and Chromium, the one Playwright installs (or the executable in
`CHROMIUM_PATH`), draws the PNGs and the ICO. The app names the logo in one place, `BRAND_MARK_SRC` in
`frontend/src/components/BrandMark.tsx`.

Related: [End-to-end tests](end-to-end-tests.md), [Adding a connector](adding-a-connector.md), [Upgrading and going back](upgrading.md).
