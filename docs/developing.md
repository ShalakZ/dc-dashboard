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
asked twice, with `--yes` and with `DCDASH_ALLOW_SEED_HISTORY=1` in its environment. **Never run it on a real installation.**

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
