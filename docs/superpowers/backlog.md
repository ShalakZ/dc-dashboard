# Backlog after Phase 2 (written 2026-10-08)

Handover for the next session. Source: the per-task reviews, the final code review and the live browser walkthrough of Phase 2 (`phase-2-discovery`, merged as `b9a3b80`). Items already fixed in the Phase 2 fix wave are not listed. File:line references are from the reviews and may have moved.

Recommended order: (1) Phase 3 brainstorm, spec update and plan, with **Task 0 = section A below**; (2) execute Phase 3 the same way as Phase 2; (3) section B just before the first real scan, on the SCADA workstation. Phase 3 does not depend on the real network and can be built against the simulator.

Working rules that still apply: implementers on `sonnet`, reviewers on `opus`, never Fable (weekly budget); one fresh subagent per task; never run `scripts/e2e.sh` or `docker compose down -v` on the default project (it deletes the owner's `dcdash_dbdata` volume) — use `docker compose -p dcdash_e2e ...` as documented in the README and project memory.

## A. Phase 3 Task 0 (cheap, and Phase 3 touches these areas) — DONE

Done in Phase 3 Task 0 (branch `phase-3-dashboards-billing`, built in Phase 3). All six items below were fixed test-first; they are kept as the record of what Task 0 covered. Sections B, C, D and E are still open.

- **Custom-unit input in the review dialog.** A row switched to the `custom` metric posts `custom_unit: null`; Phase 3 charts custom metrics, so they would show without a unit. Add a unit field per row (prefilled from the point's unit hint) and send it. (`frontend/src/components/graph/ReviewDialog.tsx`, `lib/drop.ts`.)
- **Hidden discovered-source name clash.** `POST /api/sources` can 409 on a name used by a discovered source that `GET /api/sources` hides; the message should say so (or the clash should be avoided). (`api/sources.py`, `collector/scan.py` " (2)" retry.)
- **Bare-host credentials echo.** A target like `admin:hunter2@10.0.0.1` (no scheme) is rejected, but the 422 echoes it ("not a valid host name: …"). Reject any `@` before building the message. Never stored or audited. (`core/discovery.py:68`.)
- **Scan summary wording.** The "claimed" count includes sources that need credentials; outcomes show raw `needs_credentials`; the sweep counter is labelled "probed"; empty Scans tables have no empty-state text. (`ScanProgress.tsx`, `ScansPage.tsx`; keep the e2e text `N hosts × M ports (P probes)` working.)
- **Pre-existing flaky test.** `backend/tests/test_api_storage.py::test_storage_stats_shape_and_rows_per_day` inserts 2 h of rows from "now − 1 day", so it fails after about 22:00 local time. Fix the test's time handling.
- **Test hygiene from the last re-review.** `test_collector_jobs.py:281` leftover-task assertion is vacuous (the worker coroutine repr never contains "jobs"); `:240` wake test passes without `wake.set()`.

## B. Real-network readiness (do on the workstation, just before the first real scan)

Build and test these only with SCADA access; write them down now, do not build yet.
- **Stuck-scan watchdog (M5).** A database error before the scan's status update or inside `_fail` leaves a scan `queued`/`running`, and every later start returns 409 until the collector restarts. Add a watchdog that fails scans older than a limit, plus an admin "mark failed" action. (`collector/scan.py` ~329-353, `api/scans.py`.)
- **Prefill will be wrong.** On Docker Desktop the collector's /24 prefill is the Docker bridge subnet, not the SCADA VLAN. The admin must type the real range; consider a hint in the form.
- **Verify reachability from inside the collector container first** (single-host scope) before trusting a sweep.
- **Fragile devices.** Some PLCs and Modbus gateways allow only a few TCP connections or misbehave on unexpected protocol bytes. The scan currently tries every connector on every open port (port-matching connectors first). Consider a conservative mode: only the connector whose `default_ports` match, lower rate and concurrency. Start with one known host/port and a low `DCDASH_SCAN_MAX_HOSTS`.
- **Coordinate with the SCADA and network teams first.** Scans can trip OT intrusion detection. Spec section 16 items are still open: firewall rules (IPs/ports the host may reach), SCADA vendor/API details (vendor connector not written), SCADA refresh rate.
- **Modbus on port 5020 (dev simulator)** is not a default scan port; real devices normally use 502.
- **OPC UA credentials path** (username/password, `basic256sha256`) was never exercised against a real server; the dev simulator is anonymous.
- **TLS mode, unidentified-service (grey) nodes** were not exercised (dev network has none).

## C. Deferred polish (one line each; pick up when touching the file anyway)

Scan pipeline / collector
- Failed audit write after `done` flips the scan to `failed` (`scan.py` ~295-302). `asyncio.gather` siblings are not cancelled when one raises (`scan.py`, `sweep.py`). The " (2)" name-clash retry can turn a race between overlapping scans into silent duplicates; a transient DNS failure in `_resolve` likewise duplicates a source.
- A failed scan leaves sources it created without findings (findings are written at the end).
- `needs_credentials` counted per finding vs `points` per source; sweep creates all tasks up front (~20k), hostname targets re-resolved per attempt and `open_connection` not pinned to `AF_INET`; logger quieting for asyncua/pymodbus is process-wide (hides the scheduler's own warnings during a scan); logger test fixture doesn't reset the refcount.
- Status drift: the scheduler only re-marks a source offline on a transition, so a successful browse can show `online` while polls fail; a disabled discovered source shows `online` after a browse though nothing polls it; a user browse can race the scan's browse. A job whose final status UPDATE fails stays `running` until restart (pre-existing).
- `fail_stale_jobs` orphan rule runs only at collector start; no test pins the `kind = 'scan'` filter; the scans UPDATE commits before the per-scan audit inserts.
- Probes: Modbus FC 3 fallback is starved if connect is slow (use half the remaining budget); OPC UA claim always `security_policy: none`; `http_server` test helper loop lacks a `task.done()` check; Modbus vendor/product label not asserted; probe timing test headroom (1.5 s at timeout 1.0).
- `local_addresses()` returns the default-route address plus hostname resolution, not each interface (multi-NIC may miss the SCADA VLAN).

Targets / validation
- CIDR targets skip the multicast/unspecified check (`224.0.0.0/30`, `0.0.0.0/32`, `255.255.255.255`); URL port 0 silently becomes the default; `10.0.0.1-20` and hex forms are accepted as host names; `[502]*21` is rejected before dedupe; `pairs` recomputed on each access; cap message wording; `parsePorts` accepts `0x50`/`1e3`/duplicates; whitespace-only scope names.
- Schema/test nits: `scan_findings.outcome` and `scans.stage` CHECK constraints untested; ORM default of `Source.origin` not asserted; `test_schema_tiers.py` hard-codes the Alembic head (read it from `ScriptDirectory`); `smoke.py` repeats metric names; testcontainers deprecation warning in `conftest.py:10`.

API
- `GET /scopes/suggestions` 500s on a non-object `collector_networks` value (unreachable today); the start-scan advisory lock assumes READ COMMITTED (add a comment); a scope deleted mid-start gives 500 (FK); `confirm_host_count` accepts lax ints (`"2"`, `2.0`, `true`); `PATCH {}` writes a `scope.updated` audit row; 401/403 test coverage gaps on `GET /scans/{id}`, `DELETE /scopes/99`.
- `POST /discovery/accept`: unbounded `points` list (>32k ids → 503 via the asyncpg param limit); every `IntegrityError` gets the uniqueness message (also FK races); latest-finding query scans all `scan_findings` — add an index on `(source_id, id)`; untested: cluster point name order, 409 emits no NOTIFY/audit, two `custom` metrics in one accept; non-finite layout positions return a string 422 while schema 422s are lists.
- Whitespace-only names in `POST /api/assets` (Phase 1).

Frontend
- Bundle: `@xyflow/react` is in the main chunk for every role — `React.lazy` the Discovery page.
- `useScan` keeps polling after a persistent error; `ScanProgress` hides last-known progress on a single failed poll; `ScanSummary.scope_name` should allow null; operator test doesn't assert Edit/Delete absent; real-timer test (1.3 s) → fake timers; scan confirmation panel isn't focused for keyboard users; Edit isn't disabled while busy; in-flight preview GET can reopen the panel after an edit save (request-epoch guard).
- Graph: "n mapped" counts points mapped to assets not in the model; a real cluster key `__ungrouped__` collides with the pseudo-cluster id; a failed refetch unmounts the canvas (loses state); graph stays stale after a browse if the panel is closed mid-job or the job exceeds `useJob`'s 60 s cap; a stored OPC UA username can't be cleared (spread expression); duplicate aria-labels ("Expand Ungrouped", same-named clusters in different sources); selection highlight dropped on rebuild; overlapping nodes/labels in default and saved layouts; text tiny after Fit view with many nodes; no drop cue while dragging over an asset; Escape in the source panel discards a half-typed secret; operator layout resets on reload.
- Review dialog: `pickDropTarget` takes the first intersecting asset (not the one under the cursor/largest overlap) and the Asset select shows only the name — no parent path, names aren't unique; dropping another panel's cluster onto a panel can mix panels (follows the spec, risky — consider a warning); no duplicate-name warning for "New asset from…"; suggested values never validated; a junk interval (`badInput`) is silently sent as null; `commit()` lacks a busy guard; focus gaps (Shift+Tab wrap, no `inert` background, focus lost when the opener disappears, `role="status"` mounted already filled); the disabled-reason text isn't `aria-describedby`; 100-char name cap only applies while typing; weak refresh test.
- Offer bar (top-centre overlay) can still cover an asset node's title.
- Audit page: loses its pager while loading/error (add `placeholderData: keepPreviousData` to `useAudit`); audit counts in the e2e come from the first UI page only; detail is raw JSON (ids only) — consider human-readable summaries; the viewer half of the Layout audit-link test passes trivially (wait for the "(viewer)" text first).
- Shared UI: Discovery empty state has no heading; tab title is "DC Dashboard" on every page; Setup/Create-user forms lack `autocomplete` attributes (browser autofills a saved login into "Create user"); Points page sorts addresses as text (`ns=2;i=101` before `ns=2;i=11`) and `SourcePointsPage` shows "source N" for hidden discovered sources; the HTTP source can only be managed from the graph until something on it is mapped.
- Phase 1 actions (users, sources, assets) are not audited (documented in the README; spec 7.7).

## D. Offline deployment to the SCADA workstation (added 2026-10-08)

Constraint from the owner: the workstation is reached over RDP, has no internet access, and cannot run Claude. Code and fixes must arrive as files, and the install must be self-contained and self-diagnosing.
- Runtime needs no internet (checked: no external URLs in the shipped frontend or Caddy config). Build time does (base images `node:22-alpine`, `caddy:2-alpine`, `python:3.12-slim`, `timescale/timescaledb:2.30.2-pg16` plus pip/npm), so build on a connected machine.
- Offline bundle: a script that builds the images, runs `docker save` into one archive together with the compose file, Caddyfile, `.env` template, PowerShell scripts (`setup.ps1`, `backup.ps1`, `restore.ps1` exist) and a README runbook; a matching load-and-start path with `image:` references and no `build:`; a SHA-256 manifest; transfer as ONE file over RDP drive redirection, never pasted source text.
- On-site tooling: a `doctor` script (Docker/WSL2 present, free disk, ports, time zone, reachability of the scan targets from inside the collector container), an offline smoke test, a log-collection script that zips logs to send back.
- Workstation facts known (owner, 2026-10-08): Windows, NO Docker and NO WSL, admin rights, no internet; whether CPU virtualization/Hyper-V is available is unknown. Two routes: (A) native Windows install (PostgreSQL 16 + the TimescaleDB Windows build, Python from a pre-downloaded wheelhouse, prebuilt frontend served by caddy.exe, services via NSSM; must first verify the Windows build offers compression, continuous aggregates and policies for the pinned version; `tzdata` is already a backend dependency and no Linux-only calls were found) or (B) a prebuilt Linux VM image (Hyper-V/VirtualBox) with our Docker images preloaded — B needs virtualization enabled and a bridged adapter to the scan network. Check on the workstation: `systeminfo` (OS Name, Hyper-V Requirements block) and `wmic cpu get VirtualizationFirmwareEnabled`; a workstation that is itself a VM usually rules out B.
- Workstation facts still needed: Windows edition, Docker/WSL2/Hyper-V availability, admin rights and software policy (Docker Desktop licensing), free disk, RDP file-transfer limits. Fallback if Docker is impossible: ship a ready Linux VM image (VHDX/OVA) with everything inside.
- Network path (told by the owner 2026-10-08, unconfirmed): the Windows SCADA workstation can reach a Kubernetes cluster that has access to the real SCADA, probably through OPC UA. The collector would connect to an endpoint exposed by the cluster. Ask: endpoint URL and port as seen from the workstation; direct OPC UA server or gateway/aggregator; security mode and login (read-only account); firewall rules; cluster-internal host names may not resolve from Docker on Windows. Risk: the OPC UA username/password path was never exercised against a real server.
- Raises the priority of section B (stuck-scan watchdog, conservative scan mode, reachability checks): there is nobody to debug on site.
- Before 0004 reaches ANY real database (the owner's `dcdash_dbdata` or the workstation): take a backup first (`scripts/backup.sh`); the hourly rollup is rebuilt from the minute tier.

## E. Phase 3 deferred (final review, 2026-10-09; none of these blocks the merge)

Charts
- Time-series gap rule: a gap is a step above 1.5 x the median step, so a slow meter's dots appear at 1 to 1.5 bucket widths and flip at 2 to 2.5; a window where half or more of the buckets are holes is drawn joined. The proper fix needs the backend to send the expected step (bucket width) per series. Cosmetic: `markIsolated` keeps every point visible. (`TimeSeriesWidget.tsx` `bucketMs`, `withGaps`.)
- Grouped bars: the no-rate dash sits at the category centre, not in the asset's slot (`BarWidget.tsx` `dashMarks`). Charts have no text alternative and a widget title is an `h3` under the page `h1` (`WidgetFrame.tsx`).
- Real-browser walkthrough of Task 9 (items 2, 7, 8) is still to do: the dash position in grouped bars; day-bucket labels with `useUTC: true` in Asia/Qatar (buckets start at 21:00 UTC, labels may sit off the bars); the `1h` preset with 30 s polling (12 s buckets, steps of 24 and 36 s break into dots or flip).
- Asset-page chart: the axis formatter has no finite guard (`TrendChart.tsx`); `WidgetConfig.metric` still admits `"custom"` at type level (`api/types.ts`; `WIDGET_METRICS` filters it out).

Editor and dashboards
- Drag and resize are pointer-only (no keyboard reorder), and the editor is not usable on a narrow screen.
- Cosmetic error UX: wording and guidance when a dashboard was deleted by someone else while open (`DashboardPage.tsx`, `DashboardEditor.tsx`).

Billing, tariffs and dialogs
- Billing/Tariffs: an export error survives a month change; an old server error can sit next to a new local one in the Add rate form; the "Set a rate" pointer is hidden when an asset has no rate and zero kWh, so its dashes have no pointer; Edit, Delete and Save buttons in tariff rows lack row context for screen readers (`BillingPage.tsx`, `TariffsPage.tsx`).
- `ConfirmDeleteDialog`: add `role` / `aria-describedby`, and put the focus back on Cancel after an error.
- Three screens still format times in the browser's zone, not the site's: `MetricsTable.tsx`, `ScansPage.tsx`, `SourcesPage.tsx`.

Tests and tooling
- Weak or missing assertions: Billing (`BillingPage.test.tsx`), the asset page (`AssetPage.test.tsx`), the dashboard editor tests (Task 10 M1, M3, M4, M6, M8), hook coverage and test hygiene in the asset-chart tests (Task 7 m8-m10); widget tests for the 50-dashboard cap, 100-character names, the debounce, and `FakeEventSource` copies (Task 9 M5-M7).
- End-to-end: gaps for a currency change, an override and the Billing cell states (`frontend/e2e/phase3.spec.ts`); the e2e folder is outside `tsc` (`tsconfig.json` includes only `src`).
- `LoginPage.test.tsx` prints "No routes matched location" (known, harmless).
