# DC Dashboard

Collects electrical data from data center systems, organizes it under a
hierarchy you define, and serves live values, history and energy use.

Design: `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md`

Status: Phase 3 (dashboards and billing). The web UI is served at `http://localhost/`; the API is
proxied at `http://localhost/api` (interactive docs at `/api/docs`). Sources
can be the simulator, OPC UA servers or Modbus TCP devices; readings are kept
in raw, 1-minute and 1-hour tiers (see "Storage tiers"). An admin can scan a
network for sources and map what is found to assets by drag and drop (see
"Discovery"). Everyone can read shared dashboards and a cost report per asset; operators build
dashboards and admins set tariffs (see "Dashboards and billing").

## Documentation

| Topic | File | What it covers |
|---|---|---|
| Install and run | [docs/install-and-run.md](docs/install-and-run.md) | First run, timezone, optional HTTPS, first sign-in, the simulator, services and ports |
| Screens | [docs/screens.md](docs/screens.md) | What each screen of the web UI does |
| Assets and kinds | [docs/assets-and-kinds.md](docs/assets-and-kinds.md) | Asset kinds and their icons, and moving assets in the Assets Tree |
| Sources and discovery | [docs/sources-and-discovery.md](docs/sources-and-discovery.md) | The protocols (simulator, OPC UA, Modbus) and finding sources on the network |
| Storage | [docs/storage.md](docs/storage.md) | Storage tiers, retention and the Storage page |
| Dashboards and billing | [docs/dashboards-and-billing.md](docs/dashboards-and-billing.md) | Dashboards, widgets, tariffs and the cost report |
| Roles and permissions | [docs/roles-and-permissions.md](docs/roles-and-permissions.md) | The permissions, the built-in roles and custom roles |
| Developing | [docs/developing.md](docs/developing.md) | Running the tests, the frontend dev server, the brand assets |
| End-to-end tests | [docs/end-to-end-tests.md](docs/end-to-end-tests.md) | The Playwright specs and the isolated end-to-end stack |
| Operating the stack | [docs/operating.md](docs/operating.md) | Logs, restart loops, stopping, health, housekeeping, "If you are blocked from signing in" |
| Backup and restore | [docs/backup-and-restore.md](docs/backup-and-restore.md) | Taking and restoring a backup, "What the backup does not contain", "Practise a restore" |
| Scheduled backups | [docs/scheduled-backups.md](docs/scheduled-backups.md) | Running backups from the machine's scheduler |
| Upgrading and going back | [docs/upgrading.md](docs/upgrading.md) | The numbered steps to update an install and to go back |
| Release notes | [CHANGELOG.md](CHANGELOG.md) | The release entries with their upgrade notes, newest first, including "Upgrading an existing database to Phase 3" |
| Adding a connector | [docs/adding-a-connector.md](docs/adding-a-connector.md) | How a new kind of source is added to the code |
| Field debugging | [docs/field-debugging.md](docs/field-debugging.md) | Debugging a real SCADA connection by copy and paste |

## Quick start

Requires Docker (Docker Desktop on Windows).

Linux / WSL:

```bash
scripts/setup.sh
```

Windows PowerShell:

```powershell
scripts\setup.ps1
```

(If PowerShell refuses the script, for example because the folder came over a share or a download, run
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1`; see "Backup and restore" for what that does.)

## Update and go back

To update an install, or to go back to the previous version, follow [docs/upgrading.md](docs/upgrading.md)
("Upgrading and going back"). The release notes are in [CHANGELOG.md](CHANGELOG.md).

## Help

Debugging a real SCADA connection: [docs/field-debugging.md](docs/field-debugging.md). Everyday problems: [docs/operating.md](docs/operating.md).
