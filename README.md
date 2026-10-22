# DC Dashboard

DC Dashboard collects electrical data from the systems of a data centre (SCADA servers over OPC UA, meters and panels over
Modbus TCP), organises it under an asset hierarchy you define (site, building, room, row, rack, panel, circuit), and serves
live values, history, energy use and cost in a web browser. It runs as a small Docker Compose stack on one machine: a
TimescaleDB database, an API, a collector that polls the sources, and a web server.

It is for the engineers who run a data centre's electrical systems and need to see what each part draws and costs, and for
the administrators who install, back up and update it. The design is in
[docs/superpowers/specs/2026-10-06-dc-dashboard-design.md](docs/superpowers/specs/2026-10-06-dc-dashboard-design.md).

## What it does today

- **Sources over OPC UA, Modbus TCP and an HTTP simulator**, with a connection test and a point browser in the app:
  [Sources and discovery](docs/sources-and-discovery.md).
- **Discovery**: scan a network range for sources, see them in a graph and map their points to assets by drag and drop:
  [Sources and discovery](docs/sources-and-discovery.md).
- **The Assets Tree**: your hierarchy with live power, energy today and cost today; asset kinds with their own icons; pick
  several assets and move them, with Undo: [Assets and kinds](docs/assets-and-kinds.md).
- **Dashboards and widgets**, shared by everyone, with one default dashboard that the sidebar and sign-in open:
  [Dashboards and billing](docs/dashboards-and-billing.md).
- **Billing and tariffs**: energy and cost per asset per day and month, rates per site and per asset, CSV export:
  [Dashboards and billing](docs/dashboards-and-billing.md).
- **Roles and permissions**: the built-in Viewer, Operator and Admin roles and roles of your own:
  [Roles and permissions](docs/roles-and-permissions.md).
- **Audit log**: who changed what and when, sign-ins included, with filters and CSV export: [Screens](docs/screens.md).
- **System events**: what the system did by itself (a source going offline and back, checks, imports, errors), an outage counted as one
  row, kept 90 days by default and linked to the audit entry that started a check: [Screens](docs/screens.md), [Storage](docs/storage.md).
- **Storage tiers**: raw readings, 1-minute and 1-hour rollups, each with its own retention: [Storage](docs/storage.md).
- **Backups and restore**, by hand or from the machine's scheduler: [Backup and restore](docs/backup-and-restore.md),
  [Scheduled backups](docs/scheduled-backups.md).
- **Diagnostics for field debugging**: a report and a step-by-step connection check to paste to a helper when a real SCADA
  connection fails: [Field debugging](docs/field-debugging.md).
- **Safe updates and a way back**: one update command on Windows, and numbered steps for going back:
  [Upgrading and going back](docs/upgrading.md).
- **Optional HTTPS**, security headers, sign-in protection and a light or dark look per account:
  [Install and run](docs/install-and-run.md), [Screens](docs/screens.md).

## Quick start

You need Docker (Docker Desktop on Windows) and a copy of this repository in a plain local folder (not inside OneDrive or
another synced folder). Run the setup script from the repository folder.

Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -Timezone Africa/Cairo
```

Linux or WSL:

```bash
scripts/setup.sh --timezone Africa/Cairo
```

The first run creates `.env` (a database password and the key that encrypts stored source credentials: keep a copy of it
with your backups), then builds and starts the stack. Give the site timezone on this first run, so that "today" starts at
local midnight; without it the zone is `UTC`. The name must be an IANA name with a whole-hour UTC offset; see
[Install and run](docs/install-and-run.md) for the rules and for what to do when PowerShell refuses to run the script.

Then:

- Open `http://localhost/`. The first visit asks you to create the admin account.
- The API answers under `http://localhost/api`, with interactive API docs at `http://localhost/api/docs`.
- Add a source on the Sources page, test it, browse its points and map them to assets; the Assets Tree then shows live and
  historical values.
- Later starts need only `docker compose up -d`. After you pulled a new version, follow
  [Upgrading and going back](docs/upgrading.md) instead: the first start on new code migrates the database.

The web server publishes ports 80 and 443 (443 only answers when HTTPS is set up); the database and the API are not
published. To try it without real equipment, add the simulator: [The simulator](docs/install-and-run.md#the-simulator).

## Update, and go back

On Windows, one command backs up the database first (and stops if the backup fails), brings the new code, rebuilds, checks
every service and tells you the way back:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update.ps1
```

By hand (and on Linux, where there is no update script yet), the same is three commands: a backup, the new code, a rebuild.

```bash
scripts/backup.sh
git pull
docker compose up -d --build
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup.ps1
git pull
docker compose up -d --build
```

Before you update, read the release notes from the version you run up to the new one. Set the build id before a hand-typed
build, or Settings shows `dev`. **Never use `docker compose down -v`**: it deletes the database volume. The full steps,
the pre-checks and how to go back to the previous version are on the pages below. Older scripts and error messages still
name the old README sections; this is where each one is now:

- "Backup and restore": [docs/backup-and-restore.md](docs/backup-and-restore.md).
- "What the backup does not contain": the section of that name in [docs/backup-and-restore.md](docs/backup-and-restore.md#what-the-backup-does-not-contain).
- "Scheduled backups": [docs/scheduled-backups.md](docs/scheduled-backups.md).
- "Upgrading and going back" (steps 1 to 6, step 6 is going back): [docs/upgrading.md](docs/upgrading.md).
- "Release notes": [CHANGELOG.md](CHANGELOG.md), newest first.
- "Upgrading an existing database to Phase 3" (its steps 4 and 6): the Phase 3 entry near the bottom of [changelog archive](docs/changelog-archive.md#upgrading-an-existing-database-to-phase-3).

## Where everything is

| Topic | Page | What it covers |
|---|---|---|
| Install and run | [docs/install-and-run.md](docs/install-and-run.md) | First run, the timezone, optional HTTPS, first sign-in, the simulator, services and ports |
| Screens | [docs/screens.md](docs/screens.md) | Every screen of the web app, who can open it, and the audit log |
| Assets and kinds | [docs/assets-and-kinds.md](docs/assets-and-kinds.md) | Asset kinds and their icons, moving assets in the Assets Tree |
| Sources and discovery | [docs/sources-and-discovery.md](docs/sources-and-discovery.md) | The protocols (simulator, OPC UA, Modbus TCP) and finding sources on a network |
| Devices that move or disappear | [docs/devices-that-move.md](docs/devices-that-move.md) | What a scan does when a device is gone, "Not seen" and Remove not seen, moving a source to its new address with Undo |
| Storage | [docs/storage.md](docs/storage.md) | The storage tiers, retention and the Storage page |
| Dashboards and billing | [docs/dashboards-and-billing.md](docs/dashboards-and-billing.md) | Dashboards and widgets, tariffs, the billing rules and the cost report |
| Display screens | [docs/display-screens.md](docs/display-screens.md) | Playlists and secret display links for a wall screen that needs no sign-in, revoking a link |
| Dashboard figures, templates and the guide | [docs/dashboard-figures-and-templates.md](docs/dashboard-figures-and-templates.md) | How a figure is written on a card and where its exact value is, the New dashboard templates, the first-run guide, Updated and Refresh |
| Roles and permissions | [docs/roles-and-permissions.md](docs/roles-and-permissions.md) | Every permission, the built-in roles and custom roles |
| Operating the stack | [docs/operating.md](docs/operating.md) | Logs, restart loops, stopping, health, housekeeping, "If you are blocked from signing in" |
| Backup and restore | [docs/backup-and-restore.md](docs/backup-and-restore.md) | Taking and restoring a backup, "What the backup does not contain", "Practise a restore" |
| Scheduled backups | [docs/scheduled-backups.md](docs/scheduled-backups.md) | Backups from the machine's scheduler, a second copy, rotation |
| Upgrading and going back | [docs/upgrading.md](docs/upgrading.md) | `scripts\update.ps1`, the numbered steps to update and to go back, the migrations, images |
| Developing | [docs/developing.md](docs/developing.md) | Running the tests, the frontend dev server, the brand assets |
| End-to-end tests | [docs/end-to-end-tests.md](docs/end-to-end-tests.md) | The Playwright specs and the isolated end-to-end stack |
| Adding a connector | [docs/adding-a-connector.md](docs/adding-a-connector.md) | How a new kind of source is added to the code |
| Field debugging | [docs/field-debugging.md](docs/field-debugging.md) | Connecting to a real SCADA and debugging it by copy and paste |
| Historian integration | [docs/historian-integration.md](docs/historian-integration.md) | What the platform sends to a Historian and how often, the questions for its owners, and the file alternative, for the approval review |
| Release notes | [CHANGELOG.md](CHANGELOG.md) | What each release changed and its upgrade notes, newest first |
| Changelog archive | [docs/changelog-archive.md](docs/changelog-archive.md) | The release notes of the older releases (up to W7j), with the upgrade notes of migrations 0004 to 0008 |

## Getting help

- A source does not connect, or the stack misbehaves on the SCADA workstation: follow
  [docs/field-debugging.md](docs/field-debugging.md). It explains the Diagnostics page in the app (a report and a
  connection check you can copy), the offline diagnostics scripts for when the web app is down, and what never to paste.
- Logs, a container that restarts forever, health checks, and an account blocked after wrong passwords:
  [docs/operating.md](docs/operating.md).
- Something went wrong during an update: step 6 of [docs/upgrading.md](docs/upgrading.md) and the entry for your release
  in [CHANGELOG.md](CHANGELOG.md).

## Where documentation goes

- A new feature, or a change to one, gets its text in the topic page it belongs to (the table above). Describe what the
  product does now; the history goes in the changelog. If no page fits, add one under `docs/` and a row to the table.
- Every release that is merged gets an entry at the TOP of [CHANGELOG.md](CHANGELOG.md), under
  `## <wave> (<date>, <merge commit>)`: what changes, and, when the database or the upgrade steps change, the full upgrade
  note (pre-checks, how to verify, how to go back and to which commit).
- When the upgrade procedure itself changes, update [docs/upgrading.md](docs/upgrading.md) as well.
- A new permission goes into the table in [docs/roles-and-permissions.md](docs/roles-and-permissions.md).
- This README stays short: a line in "What it does today" and a row in the table, never a full section.
