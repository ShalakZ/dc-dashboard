# Roadmap from the manual acceptance pass (2026-10-09)

Status: APPROVED by the owner on 2026-10-09 (draft 2, revised after an Opus logic review: 2 Blockers and 14 Majors, all
accepted, see the review log at the end). Decisions given with the approval: D4 and D7a as proposed, D10 (Windows script
test on the dev machine), D11 keep the name, D14 as proposed. D12 (the TimescaleDB Windows spike) installs software, so it
is announced with the exact list before it runs. There is no production stack today, only the dev stack with dev data, so
"live stack" below means whichever stack is running (the dev stack now, production later); the guards stay because the
same scripts will run on the workstation. Building starts with W0a and W0b, each with its own plan and Opus review first. Source of every item: `docs/superpowers/manual-test-notes.md` (finding ids
`S<section>-<n>`, 68 entries from sections 1-13, plus the owner decisions at its top). Older deferred items live in
`docs/superpowers/backlog.md` (`BL:<line>`); the ones that ride along with a finding are listed in the "rides along" table.

## How to read this

- **Effort** (agent work, not calendar time): S = one small task; M = two or three tasks; L = four or more tasks or a design step.
- **Risk** for the product: Low = isolated, easy to undo; Med = touches data lifetime, containers, builds, auth, scripts that
  can act on a live stack, or many routes; **High = a migration of stored data or billing arithmetic**. Two items are High
  and are marked: the audit actor snapshot (W1a) and, only if chosen, a database constraint for duplicate names (W1b).
- **Decision** marks an item that waits for the owner (list at the end).
- **Safety rule for every drill:** anything that stops, kills, restores or recreates containers runs only in a throwaway
  project whose name starts with `dcdash_e2e` with a prefix guard, never in `dcdash` (the method of section 12).
- **Process for every wave:** one implementation plan per wave (writing-plans skill); an Opus logic review of that plan before
  any implementer starts; one fresh Sonnet implementer per task; an Opus code review per task; the isolated e2e run; merge to
  `main` with `--no-ff` after a whole-wave review; the dev stack is rebuilt only after a verified backup. Each wave below is
  sized for one session; if a wave plan turns out larger it splits at the line marked in it.

## Order and reasoning

W0a and W0b first: cheap, independent, and they remove what the owner already hit. W1a and W1b next: they close the ways
data or evidence is lost silently, and W1a (audit) comes first because W1b's storage, duplicate-name and restore work writes
audit entries. W2 makes recovery and hardening routine. W3 is everyday usability. W4 waits for the workstation. W5 is ideas.
Phone support is deferred by the owner; accessibility beyond the listed items is parked (the keyboard pass was fine).

## W0a UI and docs quick wins (no decisions, Low risk)

**Status: DONE and merged 2026-10-09** (merge commit `ec1062b`; plan `2026-10-09-w0a-ui-docs-quick-wins.md`). Ten tasks, each Opus-reviewed, a whole-branch Opus review with no Critical or Important finding. Leftovers: backlog section G. Decisions taken inside it: Undo (not a confirm) for deleting a widget (S7-5); the Metrics table, Scans and Sources follow the site zone (S2-1); the source points page is admin-only in the UI (S13-4).

| Id | Item | Effort |
|---|---|---|
| S5-1 | `step="0.01"` on the two rate inputs ONLY. Mapping Scale and disk capacity stay `step="any"` (those forms are not `noValidate`; 0.001 must stay valid); integer day fields may use `step="1"` | S |
| S2-1 (+BL:94) | Timezone hint: day and month boundaries, and shown times; make Metrics table, Scans and Sources follow the site zone, or word the hint narrowly | S |
| S3-3 | README: the dev simulator's HTTP source needs Secret `sim-key` | S |
| S4-6 (+BL:83) | Asset Trend chart: the widgets' isolated-point and gap rules, plus the finite-value guard | S |
| S4-8 | Drop the permanent `reconnecting…` on assets with no points | S |
| S4-3 (labels only) | Show the asset path in every asset list: mapping dialog (`MappingForm.tsx:36`), Assets parent list, Discovery ReviewDialog (BL:56), reuse `assetLabels`, fix its `#id` gap (BL:86) and `TariffOut.asset_path` (BL:120). No decision needed; removes the wrong-mapping risk now | S-M |
| S7-1, S7-5, S7-2 | Gauge name below the value; confirm or Undo when deleting a widget; dashboards and Billing opt out of the 1200 px page width | S each |
| S13-4, S13-5, S13-6 | `RequireRole` operator on `/sources` and admin on the points page; a not-found route that keeps the nav; style the current nav item and add a skip link | S each |
| S13-12 | Storage `PUT` takes a separate input model with every field required (an empty or partial body gets 422); the factory values live in ONE constant that `GET` exposes (the frontend keeps no copy). The `0002`/`0004` migration seeds stay as history | S-M |
| S12-4 | `setup.sh` and `setup.ps1` refuse (or ask) when the project's database volume exists and `.env` is missing (find the volume through the compose project, not a hard-coded name); `backup.sh` says `.env` is not in the dump; disaster-recovery steps name `.env` plus the dump. Closes a `down -v` data-loss trap | S |
| S12-13 | Document that a restore makes the collector rewrite `collector_networks` | S |

## W0b Container and health chain (ONE ordered task chain: S12-2, then S12-3, then S12-1; they edit the same `compose.yaml` and `collector/main.py`)

**Status: DONE and merged 2026-10-10** (merge commit `60d8b65`; plan `2026-10-09-w0b-container-health-chain.md`). Seven tasks, each
Opus-reviewed (Task 5 needed one fix round: a status write that timed out but committed could hide a source going offline), a
whole-branch Opus review with no Critical finding and two Important ones (a frozen database left the Sources page showing a
stale reading age; a test that could not fail), fixed in one wave with a scoped re-review. Evidence: backend 1304 passed (run
before the final fix wave, whose four touched files were re-run), frontend 791 passed and typecheck clean, the isolated
Playwright journey 3 passed on a scratch stack at the final commit, the stop drills against a paused database at the final code
(collector 10.3 s, api 5.5 s, exit 0), the density drill (1.96 and 2.08 readings per 10 s against 1.90 at baseline). The dev
stack was rebuilt from the merged tree after a verified backup (schema stays `0004`). Leftovers are in `backlog.md` section H.

Risk Med, effort L in total. Docker-route work; the route A counterpart is planned in W4 (NSSM stop, log rotation).

| Id | Item |
|---|---|
| S12-2 | `logging: options` (max-size, max-file) in `compose.yaml`; asyncua and pymodbus loggers at WARNING in the collector (the scan code restores the saved level, so scans are unaffected) |
| S12-3 | `exec uvicorn` plus `--timeout-graceful-shutdown` below the grace period (the SSE stream never ends by itself, so an open page would still force SIGKILL); set `stop_grace_period`; wire SIGTERM and SIGINT to the collector's existing stop and flush, guarded by platform (`add_signal_handler` raises on Windows). Verify with an SSE client attached: `docker stop -t 10` exits 0 and the reading count is continuous across the stop |
| S12-1 | `/api/health` becomes a readiness check (database query with a timeout under the 3 s healthcheck timeout) plus `start_period`, so a long migration does not fail `setup.sh`. Compose never restarts an unhealthy container; the risk being removed is a false green and a blocked start. The collector writes a heartbeat to the database (route A has no Docker; the UI and the doctor script read it there); "last reading age" on the Sources page; web gets a healthcheck. Also an investigation task: the half-density raw data seen after the 42 s database outage (possible silent loss) |

## W1a Audit foundation (needs D7a and D11 first)

**Status: DONE and merged 2026-10-10** (merge commit `efc7e66`; plan `2026-10-10-w1a-audit-foundation.md`). Nine tasks, each Opus-reviewed
(Task 2 needed a ruling: FastAPI 0.142 no longer lists `include_router` routes in `app.routes`, so the gate enumerates them with
`iter_route_contexts`; Task 8 needed one fix round: a change of only the credentials inside a source URL left no audit row), a whole-branch
Opus review with 0 Critical and 2 Important findings (URL credentials containing an unencoded `/`, `?` or `#` were not masked; the README
rollback steps pointed at Phase 2 code), fixed in one wave with a scoped re-review. Evidence: backend 1359 passed (run before the final fix
wave, whose touched files were re-run: 84 passed), frontend 791 passed and typecheck clean, the isolated Playwright journey 3 passed on a scratch
stack at the final commit, migration 0005 rehearsed on a restored copy of a dev backup (27 audit rows, 27 of 27 backfilled, the trigger fills the
snapshot, `alembic downgrade 0004` and back up lossless). The dev stack was rebuilt from the merged tree after a verified backup (schema `0005`).
Decisions taken inside it (owner, "lgtm" 2026-10-10): the snapshot is a fill-if-missing database trigger plus a plain integer `actor_id`; a failed
sign-in on a deactivated account is attributed to that account; failure rows are capped (30 failure and 30 lockout rows per 5 minutes, then a
count on the next row); logout and the discovery layout save stay unaudited. Not part of it: S1-2 (deleting accounts, W3d: the snapshot it needs now
exists). Leftovers are in `backlog.md` section I.

Risk Med, with one High item. Built first inside W1 because everything after it writes audit entries.

| Id | Item | Effort |
|---|---|---|
| S10-1 (+S2-2, S3-5, BL:60) | Audit every data-changing route on the agreed list (user create/patch, own password, storage, timezone, mappings, assets, sources, source test/browse, first-run setup); the audit call is part of the route, and a test fails for any write route without one (explicit read allow-list) | L |
| detail contract | Every update stores `{before, after}`; includes F6 (`tariff.updated` keeps only new values, BL:111), skips no-op updates (`PATCH {}` writing `scope.updated`, BL:48). S10-6 later renders older rows that have no `before` | M |
| security events | Sign-in success, failure and lockout are written with a separately committed write (the request transaction is rolled back on a failed login, `api/auth.py:86-94`, and `audit()` only joins it). Do not store a typed username when no such user exists; limit the volume of failure rows | M |
| actor snapshot (**High**) | A snapshot column of the actor's name on `audit_log` (migration with backfill), because deleting a user sets `user_id` to null (`ON DELETE SET NULL`) and erases the actor from every entry. Prerequisite for S1-2 | M |

## W1b Storage, restore and duplicate-name safety (uses the W1a mechanism)

**Status: DONE and merged 2026-10-10** (merge commit `ab0869c`; plan `2026-10-10-w1b-storage-restore-names.md`). Seven tasks on the lighter process the owner allowed that day: an Opus code review only for the two tasks that delete or restore data (Tasks 3 and 5), the other five an implementer plus tests. The plan had one Opus review that RAN its code in a scratch clone (0 Blockers, 3 Majors, 12 Minors, all folded in); Task 3's review found 1 Important (a false sentence in the "shorter only" 409), Task 5's found 2 Important (the fail-safe depended on a line inside the SQL file; the PowerShell twin claimed a pause it had not checked), the whole-branch review found 2 Important (a test that could not fail, a README sentence), all fixed. Evidence: backend 1430 passed (full run at `8222518`; the files touched afterwards re-run), frontend 810 passed and typecheck clean, the isolated Playwright journey on a scratch stack, and a real-stack drill (`dcdash_e2e_w1b_restore`): `restore.sh` default keeps the old chunks and pauses both retention jobs, `--apply-retention` drops them (the control), a failing retention check exits 4 with everything paused, a corrupt dump exits 1 with the services back, a restored copy of the dev backup says nothing would be deleted; on the Storage API an unchanged Save after the restore answers 409 with the chunks, `confirm=true` deletes them and the audit row carries `confirmed_loss`, a capacity-only Save with retention armed asks nothing; the key warning, the duplicate asset name (409) and an `Infinity` scale (422) were checked on the same stack. No migration (head stays `0005`). Decisions inside it (owner, 2026-10-10): D4 = an API check plus an advisory lock, no unique index; `restore.sh`/`restore.ps1` pause retention only when it would delete data, `--apply-retention` opts out, a banner on the Storage page; the Storage 409 also fires for chunks that no armed retention job would delete anyway. Planner's refinements for the owner to confirm or revert: a chunk that an ARMED daily job deletes anyway does not make a routine Save ask (in practice a Save then removes an expired chunk within a minute instead of a day); the 409 reports chunks, the day span and size, not rows (TimescaleDB's row estimate is 0 after a restore); the origin of a Save is judged by the server from the values; `MAX_SCALE` is 1e12. Leftovers are in `backlog.md` section J.

Risk Med (High only if D4 picks a database constraint).

| Id | Item | Effort |
|---|---|---|
| S9-1, S9-2, S9-3 | Storage form with Set as default, Reset to default, Reset to factory (owner semantics; factory = 30 / 7 / 730 / 100 GB / 80 %). The site default is a new `settings` key that is never seeded (absent means "not set"), validated by the same rules. The server, not only the UI, refuses a shorter raw or 1-minute retention without `confirm` (409 with an estimate in whole 7-day chunks, the asset-delete pattern); additive to the W0a contract. Audit per D14 | M-L |
| S12-9 (revised) | `restore.sh` acts between `pg_restore` and `timescaledb_post_restore()`: it unschedules the retention jobs by default (or refuses without `--apply-retention`), prints the chunks that retention would drop for `readings` and `readings_1m`, and says that saving the Storage page re-arms retention (`core/storage.py` re-adds the policies). Same for `restore.ps1`; README advice rewritten (raising retention before a restore does not survive the restore). Verify with the large drill: the old chunks must survive | M |
| S12-4 (part 2) | Store a fingerprint of `DCDASH_SECRET_KEY` in `settings`; warn at api start (and on the Sources page) when stored secrets cannot be decrypted (a wrong key fails silently per source today) | S |
| S4-3 (refusal) | Refuse the same name under the same parent on `POST /api/assets`, rename, move, and Discovery's "new asset"; rule for case and whitespace (BL:50). D4 chooses API-only (racy) or a unique index `NULLS NOT DISTINCT` with a migration that refuses on existing duplicates (that variant is **High**) | M |
| BL:F4 | A non-finite scale or a Modbus NaN stored as GOOD reaches Billing as "no rate": a silent wrong number | S-M |

## W2 Operations, recovery and hardening

Order inside the wave: S12-5 and S12-14 first (the PowerShell scripts depend on the guard), then the rest.

**Status 2026-10-10: Part A is done** (branch `w2a-ops-scripts`, plan `2026-10-10-w2-operations-recovery-hardening.md` Tasks 1-8): S12-5, S12-14, the route A spike (D12: yes), S12-11, S12-12. **Part B is done 2026-10-10** (branch `w2b-web-hardening`, merged into main): S12-8, S12-6, S12-7, S13-7. **W2 is complete.** S12-8 ended as digest-pinned base images plus `BUILDX_NO_DEFAULT_ATTESTATIONS=1` in the setup scripts (the BuildKit attestation was why every build exported a new image id). The rebuild of the dev stack from the merged tree waits for the owner's go (it recreates `db` once; a verified backup comes first).

| Id | Item | Effort | Risk |
|---|---|---|---|
| S12-5 | Isolate the ops scripts like `e2e.sh`: `check_tls.sh`, `backup_smoke.sh` (and the three `.ps1` scripts) take a scratch project name with a prefix guard that refuses `dcdash`, `check_tls.sh` gets its own certs directory and a throwaway container for the chown, no bare `down`, and a port override; test the guard against the name `dcdash`. `backup.sh` and `restore.sh` print the project they act on | M | Med |
| S12-14 | Run `setup.ps1`, `backup.ps1`, `restore.ps1` for real on the Windows dev machine, in a scratch project (the engine is shared with WSL, so a copy on a Windows drive would otherwise act on the dev stack `dcdash`), after a backup, port override for 80/443. D10 approved | S | Low (dev data only) |
| route A spike (D12) | On the same machine, prove whether the TimescaleDB Windows zip (2.30.2, PostgreSQL 16) offers compression, continuous aggregates and policies. It is a property of the build, so it can be settled now and decides whether route A is viable **Done 2026-10-10 (W2 Task 7): yes**, see the spike document. | S | Low |
| S12-6 | Certificate: README rotation steps (a `web` restart), expiry shown (the api has no `./certs` mount, so the collector publishes the expiry to `settings`, or the doctor script reads it), warning 30 days ahead; nothing to show in HTTP mode | S-M | Low |
| S12-8 | Pin base images by digest, including `timescale/timescaledb` and the uv image; stop rebuilds recreating containers when nothing changed (test `--provenance=false`); a re-pin step in the upgrade runbook so security fixes still arrive | M | Med |
| S13-7 | The UI refetches `/api/me` on window focus and after a 403 and says "your role changed, reload" | S-M | Low |
| S12-11 | Scheduled backups (Task Scheduler and cron examples), keep the last N, off-host copy, optional encryption of the dump (D13: target and key custody); the section 12 restore drill as a runbook. `backup.ps1` follows S12-14 | M | Low |
| S12-12 | The README upgrade section becomes a general upgrade and go-back runbook | S | Low |
| S12-7 | Security headers; the Content-Security-Policy ships as `Content-Security-Policy-Report-Only` first (ECharts tooltips use `style` attributes, expect `style-src 'unsafe-inline'`, keep `script-src 'self'`); the redirect that drops a non-443 port and `Server: Caddy` need the owner | M | Med |

## W3 Everyday usability (four sub-waves, each its own plan)

**Status 2026-10-11: W3a is done** (branch `w3a-assets-mapping-sources`, plan `2026-10-11-w3a-assets-mapping-sources.md`): S4-1, S4-2 (D5), S4-4, S4-5, S3-1, S3-2, S3-4 and the source-delete cache refresh (BL:87). Seven tasks and one fix wave; the process was the lighter one (an Opus plan review that ran the snippets in a scratch clone, a whole-wave Opus review, a scoped re-review of the fix wave). What the user sees: a `+` beside every asset in the tree adds a child under it; Add/Edit asset, Map/Edit mapping and Add/Edit source open as dialogs (one shared `Modal`); the points list sorts by column header, filters "Unmapped only", searches and says "Showing n of m points"; the mapping dialog warns (Save stays enabled) when a point's unit hint is a known unit of a different metric; the Sources page has Edit. **D5 resolved:** Kind stays free text in the database and the API (no migration); the form offers a list (starter kinds, the kinds already in use, "Other…"), and a typed kind that differs from an existing one only by case or blanks reuses the existing spelling. **S3-1 wording:** `not polled (no mapped points)` for an enabled source with none, `not polled (disabled)` for a disabled one; the plan review found that Test and Browse jobs DO write a source's status, so the label also carries `; last check: <status>` once one has run (the first draft assumed they did not). The only backend change is `mapped_points` on the rows of `GET /api/sources`. Evidence: backend 1769 passed, frontend 79 files / 1006 tests and typecheck clean, the Playwright run (journey, discovery, phase3, headers and the new w3a spec) 6 passed twice in scratch projects (`dcdash_e2e_w3a_pw`, `_pw2`; one before and one after the fix wave). Opus reviews: plan 0 Blockers / 6 Majors / 10 Minors (all folded into draft 2), whole wave 0/0/4 (fixed in one wave), scoped re-review of the fix wave 0/0/3 (parked). Not changed in W3a: `GET /api/sources` is operator-level and returns each source's raw `config`, which can hold URL credentials, and the new Edit form shows them to admins (a W3d-or-later security item). Leftovers are in `backlog.md` section M.

**Status 2026-10-11: W3b is done** (branch `w3b-charts-dashboards`, plan `2026-10-11-w3b-charts-dashboards.md`): S4-7, S4-9, S7-3, S7-4 and D6. Six tasks and one fix wave; the lighter process again (an Opus plan review that ran the snippets in a scratch clone, a whole-wave Opus review, a scoped re-review of the fix wave). What the user sees: dragging a widget onto an occupied place makes the other widgets close up under it instead of flying far down; the read-only view and the editor use the same vertical compaction, so a saved gappy dashboard is shown closed up, opening the editor on one is not "unsaved", and the first real change makes Save store the closed-up positions (a view-only visit writes nothing); long asset names are shortened with a middle ellipsis in chart legends and bar axes (the `(#id)`, `~` and `*` suffixes survive, two names that would look alike keep their full text, the full name is in the tooltip and the legend's hover) and new bar and time series widgets are 6x5; the asset page's Trend refetches by range (1h every 10 s, 6h 30 s, 24h 60 s, 7d 5 min), says `updated hh:mm:ss` in the site zone and waits while a mouse rests on it; a parent asset without its own power meter shows `Live power` as the sum of its sub-assets' power meters (the own meter wins; only good, fresh readings count; a partial sum says `Sum of K of N meters below; the other(s) not reporting` with a visible `Not reporting: <paths>` line; none reporting shows `—`); the Energy tile's `(estimated)` explains itself in a tooltip. **D6 resolved:** vertical compaction, applied the same way in the editor, the view and Save; saved layouts are not rewritten on a view-only visit. **S4-9 is display only:** `core/cost.py` and `core/energy.py` are untouched (D1 untouched), no migration; the only backend change is the additive `power_rollup` key of `GET /api/assets/{id}/summary` (new `core/rollup.py`, `is_stale` made public in `core/widgets.py`). Parked: dashboard widgets for a parent asset, a rolled-up Trend for a parent, and appending streamed points to the Trend (S4-7 is refetch plus the time, not appending). Evidence: backend 1787 passed, frontend 81 files / 1098 tests and typecheck clean, the Playwright run (journey, discovery, phase3, headers, w3a and the new w3b spec) 7 passed twice in scratch projects (`dcdash_e2e_w3b_pw`, `_pw2`; one before and one after the fix wave), torn down, the dev stack untouched. Opus reviews: plan 1 Blocker / 7 Majors / 12 Minors (all folded into draft 2 before any implementer), whole wave 0 / 0 / 6 Minors + 3 nits (the 6 fixed in one wave), scoped re-review 0 / 0 / 0 + 2 nits (parked). Leftovers are in `backlog.md` section N.

| Sub-wave | Items | Effort |
|---|---|---|
| W3a Assets, mapping, sources | S4-1 (`+` per branch), S4-2 (kind list, D5), S4-4 (mapping without scrolling), S4-5 (sort, "unmapped only", search), S3-2 (unit vs metric warning), S3-4 (Edit on Sources, plus the source-delete cache refresh BL:87), S3-1 ("not polled, no mapped points") | L |
| W3b Charts and dashboards | S4-7 (Trend live or "updated hh:mm:ss"), S4-9 (parent roll-up of live power, display only: no `core/cost.py` change, D1 untouched; define the rule when a parent has its own meter or a child is stale), S7-3 (long names), S7-4 (dropped widget; D6) | L |
| W3c Audit screen | S10-2 filters, S10-3 export, S10-4 jump and links, S10-5 UI pass (+ pager BL:58), S10-6 raw and friendly views (uses the W1a `before/after`) | L |
| W3d Users and sign-in | S1-1 configurable block timer (bounded: a minimum of failures, a maximum block time, a recovery path, so one bad value cannot lock out every admin); S1-2 delete accounts (after the W1a snapshot; D11) | M |

## W4 Real network and offline (blocked until the owner reaches the workstation)

Entry gate: D9 and the SCADA's session limit and session-audit policy (in D2) are decided BEFORE the first real connection;
until then OPC UA sources default to a longer interval (about 720 sessions an hour per source today). Docker-route work from
W0b, W2 (S12-1/2/3/11/14) gets its route A counterpart here (NSSM stop, native `pg_dump`, log rotation). Route-independent
parts (doctor and log-collection script design, the runbook, the 0004 backup and pre-checks BL:72) can be planned earlier.

| Id | Item | Effort | Risk |
|---|---|---|---|
| Offline bundle, both routes | A first (native Windows: PostgreSQL 16 plus the TimescaleDB Windows zip if D12 says yes, Python wheelhouse, caddy.exe, NSSM), then B (`docker save` bundle, 0.73 GB compressed, image-only compose, no `--build`, SHA-256 manifest, doctor, log collector, offline smoke test) | L each | Med |
| S12-10 | OPC UA: one long-lived session with a watchdog, or a longer interval (D9) | M | Med |
| BL:B | Stuck-scan watchdog, conservative scan mode, reachability check, SCADA coordination | L | Med |

## W5 Ideas for later (not planned in detail)

S11-1 snap and tidy, S11-2 graph legend (cheap, may ride along with W3), S11-3 node types and icons, saved views and export,
S11-4 "feeds" relation (ties to D1, D8), S9-4 outbound alerts and retention profiles, S9-5 factory values (D3), S10-7 audit
retention and forwarding (D7b).

## W6 UI/UX overhaul (owner request 2026-10-09; future session, no plan yet)

The owner wants a full UI/UX overhaul or improvement: still simple for the user to use and understand, and at the same time clean, slick and functional. The owner's inspiration is the way Sunbird (the data-center management product) builds its dashboards, menus and so on: inspiration only, not a copy.

Design rules given by the owner (hard constraints for any design, mockup or CSS in this project):

- no cream or off-white background;
- no italic accent words in headlines;
- no numbered "01 / 02 / 03" section labels;
- no monospace labels;
- no pill-shaped buttons.

How to run it (proposal, for the owner to confirm in that session): its own session, started with the brainstorming skill, then a design spec and a plan, both Opus-reviewed before any implementer starts. Look at Sunbird's public material for the patterns (navigation and menus, dashboard layout, density, status colours), decide the design direction and the shared style tokens first (`app.css` today is plain black on white with no tokens), and only then restyle screen by screen. It belongs after W3a to W3c, so screens whose layout is about to change are not restyled twice. The parked items fit in naturally: phone support (S13-1 to S13-3, S13-8) and the accessibility items (S13-9 to S13-11), and the Discovery ideas S11-1 to S11-3.

**Widgets overhaul (separate, dedicated session).** The owner looked at W0a in the browser on 2026-10-09 ("looks fine") and said the dashboard widgets themselves (stat, gauge, time series, bar, table, and the widget frame and editor) need an overhaul of their own, to be done in its own future session, not folded into the rest of W6. Inputs for it: the owner's design rules above, W3b's widget items (S7-3 long names, S7-4 overlap, D6) and the gauge and Trend-chart leftovers in backlog section G.

## Parked

- Phone support (owner): S13-1, S13-2, S13-3, the phone part of S13-8. S13-1 (the nav) is the one cheap fix that would help
  every page; say if you want it pulled into W0a.
- Accessibility beyond W0a: S13-9 (chart text alternatives, Gauge value), S13-10 (focus ring on Discovery nodes), S13-11 (row
  context for row buttons), the keyboard part of S13-8. Revisit with phone. S13-13 is information only.

## Open decisions

| Id | Question | Needed by |
|---|---|---|
| D1 | **S6-1 A parent's cost: its own energy times its own rate (today), or the sum of its children's costs? The owner is asking the real administrators.** No change until answered; if it changes it is one rule in `core/cost.py` plus the sentence in spec 10.2 | open; nothing but S11-4 depends on it |
| D2 | Workstation facts (Windows edition, virtualization, Docker allowed, RDP limits, the OPC UA endpoint, the SCADA's session limit and session-audit policy) | W4 |
| D3 | Factory values: today's (30 / 7 / 730 / 100 GB / 80 %) are what W1b uses; adopt the S9-5 recommendation (rollups 365, warning 70 %, capacity asked at install) or not | W5 (S9-5) |
| D4 | Duplicate asset names: refuse the same name under the same parent (proposed); rule for case and whitespace; API-only or a database unique index (High) | W1b |
| D5 | Asset `Kind`: free text or a list | W3a; **done 2026-10-11: stored as free text, picked from a list** (starter kinds + kinds in use + "Other…"; spellings that differ only by case or blanks reuse the existing one; no migration) |
| D6 | Dashboard overlap: vertical compaction or swapping positions (editor and view identical) | W3b; **done 2026-10-11: vertical compaction** (one pure `compactVertical`, applied the same way in the editor, the view and Save; saved layouts are not rewritten on a view-only visit; no migration) |
| D7a | Which actions count as important to audit (proposal: the high-importance list in section 10) | W1a |
| D7b | The audit log's own retention and forwarding | W5 |
| D8 | "contains" versus "feeds", and which one Billing follows | W5, with D1 |
| D9 | OPC UA session strategy | before the first real connection (W4 entry gate) |
| D10 | May the Windows script test (S12-14) and the route A spike (D12) run on the dev machine, in a scratch project and with a copy of the repo on a Windows drive? | W2 |
| D11 | After a user is deleted, keep the actor's name in old audit entries (proposed) or anonymise it | W1a |
| D12 | Route A spike: allow proving the TimescaleDB Windows build now, on the dev machine | W2; **done 2026-10-10: the Windows build supports what the app uses** (`docs/superpowers/spikes/route-a-timescaledb-windows.md`) |
| D13 | Backups: off-host target, and who keeps the encryption key on an offline workstation | W2 |
| D14 | What "audit all three storage actions" means: proposal, audit Set as default, and record the origin (factory, site default or manual) in the following Save's `storage.changed`, because the two Resets only fill the form | W1b |

## Rides along (backlog items attached to a finding)

| Backlog | Goes with |
|---|---|
| BL:F4 non-finite readings reaching Billing | W1b |
| BL:F6, BL:60 (Phase 1 actions unaudited), BL:48 (`PATCH {}`) | S10-1 (W1a) |
| BL:94 browser-zone screens | S2-1 (W0a) |
| BL:56 ReviewDialog, BL:86 AssetPicker, BL:120 `TariffOut.asset_path` | S4-3 labels (W0a) |
| BL:83 TrendChart finite guard | S4-6 (W0a) |
| BL:87 source-delete cache refresh | S3-4 (W3a) |
| BL:58 Audit pager and readable detail | S10-5, S10-6 (W3c) |
| BL:72 the 0004 backup and pre-checks | W4 runbook |

## Coverage check

Every finding id is assigned exactly once (S4-3 once: labels in W0a, refusal in W1b; S12-4 once: scripts in W0a, key
fingerprint in W1b). W0a: S5-1, S2-1, S3-3, S4-6, S4-8, S4-3, S7-1, S7-5, S7-2, S13-4, S13-5, S13-6, S13-12, S12-4, S12-13.
W0b: S12-2, S12-3, S12-1. W1a: S10-1, S2-2, S3-5. W1b: S9-1, S9-2, S9-3, S12-9. W2: S12-5, S12-14, S12-6, S12-8, S13-7,
S12-11, S12-12, S12-7. W3: S4-1, S4-2, S4-4, S4-5, S3-2, S3-4, S3-1, S4-7, S4-9, S7-3, S7-4, S10-2, S10-3, S10-4, S10-5,
S10-6, S1-1, S1-2. W4: S12-10. W5: S11-1, S11-2, S11-3, S11-4, S9-4, S9-5, S10-7. Open: S6-1. Parked: S13-1, S13-2, S13-3,
S13-8, S13-9, S13-10, S13-11, S13-13.

## Review log (what the Opus review changed)

Blockers: S12-14 acted on the live stack (now a scratch project, guarded scripts first, Med); S12-9's "raise retention first"
could not work and its count came too late (now pauses retention between restore and `post_restore`). Majors accepted: SIGTERM
and the open SSE stream, Windows signal handling, readiness versus liveness and `start_period`, the audit transaction and
security events, the actor snapshot (deleting users erased audit evidence), the storage contract changing twice and the
factory values in three places, S4-3 split and its extra write paths, honest risk labels, D9 timing, wave sizing, the route A
spike, unassigned backlog items, S5-1's `step` trap, D3 timing, drills only in guarded projects. Minors folded in as the
sub-items above.
