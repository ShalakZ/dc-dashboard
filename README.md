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

## Run it

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

The first run creates `.env` with a database password and an encryption key,
then builds and starts the stack. Keep `.env`: without its key, stored source
credentials cannot be decrypted. Keep a copy of `.env` with every backup (see "What the backup does not contain").

**Choose the timezone on the first run**, so that "today" starts at local midnight from the first start:

```powershell
scripts\setup.ps1 -Timezone Africa/Cairo
```

```bash
scripts/setup.sh --timezone Africa/Cairo          # or: DCDASH_TIMEZONE=Africa/Cairo scripts/setup.sh
```

(`--timezone=Africa/Cairo` and `-Timezone:Africa/Cairo` work too, and both scripts also read `DCDASH_TIMEZONE` from the
environment; the flag wins over the variable. Every other argument still goes to `docker compose`.) The script checks the name against
the list in `scripts/timezones.txt` before it writes `.env` or starts anything, and refuses a typo (`Africa/Ciro`; the spelling is
exact, `africa/cairo` is refused) or a Windows name (`Egypt Standard Time`) with a message: a wrong name in `.env` would make the api
and the collector restart forever. The zone must have a whole-hour UTC offset in both January and July (`Asia/Qatar`, `Africa/Cairo` and
`Europe/London` do, `Asia/Kolkata` does not, and the script refuses it); see "Dashboards and billing". Without a flag or variable the zone is `UTC`. The zone only
seeds the database on the FIRST start: editing `DCDASH_TIMEZONE` in `.env` later does not change an existing database. Change the
timezone of a running installation on the Settings page. If `.env` already exists, the flag changes nothing and the script says so (a name that is not on the list is still refused).

**Do not install inside OneDrive** (or another synced folder; on a managed laptop `Desktop` and `Documents` often are): `.env` and the backups would
be copied to the cloud, and bind mounts on synced paths can be slow or locked. Use a plain local folder such as `C:\dcdash`. The setup
scripts print a warning when the folder looks like OneDrive.

Later starts need only `docker compose up -d`. The exception is a start after you pulled a new
version: starting `api` migrates the database, so read "Upgrading and going back" (and the release
notes it points to) before the first start on a database that already holds data.

### Optional HTTPS

Put your certificate chain and private key in `./certs/` (the folder is mounted read-only into the
`web` container at `/certs`) and add to `.env`:

    DCDASH_TLS_CERT=/certs/fullchain.pem
    DCDASH_TLS_KEY=/certs/privkey.pem

Then `docker compose up -d`. Port 443 serves HTTPS and port 80 redirects to it; the session cookie
gets the `Secure` flag automatically. The `web` container runs as uid/gid 10002, so give it the key
without making the file world-readable: `sudo chown 10002:10002 certs/privkey.pem && chmod 640
certs/privkey.pem`. If either file is missing or unreadable the `web` container exits with
`TLS file not readable inside the container: ...` in `docker compose logs web`. Leave both variables
unset for plain HTTP. `scripts/check_tls.sh` exercises both paths in a throwaway Compose project of its own
(a self-signed certificate in a temporary folder, its own images, `web` published only on `127.0.0.1:18080`
and `127.0.0.1:18443`): it leaves `./certs`, your `.env`, the normal stack and ports 80 and 443 alone. See
"Practise a restore" for the project-name guard it shares with `scripts/backup_smoke.sh`.

**Renewing the certificate.** Write the new `fullchain.pem` and `privkey.pem` into `./certs` under the same names, keep
`chown 10002:10002` and `chmod 640` on the key, then run `docker compose restart web`. A new certificate is not picked up
without that restart (checked). The `collector` mounts `./certs` too and reads the certificate at the same path once an
hour, so the Settings page shows the new expiry within the hour; `docker compose restart collector` shows it at once.
`fullchain.pem` must stay readable by everyone (mode 644): the collector (uid 10001) reads the certificate to watch its expiry and
never reads the key. If the file is made unreadable, the Settings page and the notice both say "cannot be read" and name the
file, and the notice adds that its expiry is not being watched until that is fixed (checked with a mode 600 file).
While `DCDASH_TLS_CERT` is set, the Settings page has a read-only "Certificate" line with the expiry date, and
administrators see a notice at the top of every page when the certificate has less than 30 days left (the notice names
the date and the days left), when it has expired (browsers already warn your users then) or when the file cannot be read
(the notice says why). Nothing is shown when `DCDASH_TLS_CERT` is unset. If the collector is not running, the stored
answer is not trusted after three hours and no notice is shown.

**Security headers.** Every answer of the `web` container (pages, the API, and the redirect from port 80), over HTTP and
over HTTPS alike, carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY` and a
`Content-Security-Policy-Report-Only`; Caddy's own `Server` header is removed (so is the API's). That includes the error answer
Caddy gives while the `api` restarts (a short text body, `502 Bad Gateway`). They come from one file,
`deploy/security-headers.caddy`, which both Caddyfiles import in every site block and again in each block's `handle_errors`
(the part that gives Caddy's own error answers the headers). The content policy is **Report-Only on
purpose**: a browser that finds a violation writes it to the console and blocks nothing, so a policy that is too tight cannot
break a page. It allows scripts, connections (the live stream included), fonts and forms from the site's own origin only,
images from the site, `data:` and `blob:`, inline styles (React and the charts write `style` attributes), and no plug-ins.
It names no report address, because that would be a new unauthenticated route. To read violations, open the browser's developer
tools on any page: a violation is a console message that starts with `[Report Only] Refused to ...` and names the directive.
`frontend/e2e/headers.spec.ts` walks every page an administrator can open and fails on any such message. The policy has no
`frame-ancestors` because `X-Frame-Options: DENY` already forbids framing. The redirect from port 80 is `https://<host><path>`
and drops a non-standard port, so publish HTTPS on 443. Changes to the headers need `docker compose up -d --build web`.

To enforce the policy later: rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in
`deploy/security-headers.caddy`, run the Playwright `headers` project first (it must stay at zero violations), then
`docker compose up -d --build web`. `test_the_policy_is_report_only_on_purpose` in `backend/tests/test_caddy_headers.py` pins
Report-Only and has to be changed in the same commit, and so does the header name that `frontend/e2e/headers.spec.ts` reads.

Open `http://localhost/`. The first visit asks you to create the admin
account. Then: Sources → Add source → Test → Points → Browse points → Map;
Assets Tree → open the asset to see live and historical values.

To include the SCADA simulator (10 LV panels), add the dev profile:

```bash
scripts/setup.sh --profile dev
uv run --project backend python scripts/smoke.py          # drives http://localhost through Caddy
scripts/check_web.sh                                     # SPA, proxy and SSE route checks
```

The simulator's three protocols are added as sources in the app like any other. Its HTTP source
(type `simulator`, URL `http://simulator:9000`) needs the Secret `sim-key` (the simulator's API key,
`SIM_API_KEY` in `compose.yaml`). Without it, Test shows `auth_failed - credentials rejected` and
marks the source `offline` with that Last error, and Browse fails, so there is nothing to map. The
OPC UA simulator accepts any login (or none) unless `SIM_OPCUA_PASSWORD` is set in `.env`; then it takes
the user `sim` with that password. Modbus needs none.

## Services

| Service | Role |
|---|---|
| `db` | PostgreSQL + TimescaleDB |
| `api` | HTTP API; never contacts a source |
| `collector` | Polls sources and runs connection tests and browses; read-only toward sources |
| `simulator` | Stand-in SCADA, dev profile only: HTTP `:9000`, OPC UA `opc.tcp://simulator:4840/dcdash/` (user `sim`), Modbus TCP `simulator:5020` (unit 1); all three bound to `127.0.0.1` on the host |
| `web` | Caddy: serves the UI, proxies `/api` to `api` |

UI screens, besides Assets Tree, Sources and Points:

- **Asset kinds** (everyone who may open the Assets Tree can read it; `assets.kinds` changes it): the button at the top of the Assets
  Tree opens it. It says once what each kind of asset looks like. An asset shows its own icon if it has one, else the icon of its kind,
  else the generic one; change a kind's icon here and every asset of that kind follows, and rename a kind and the assets that carry the
  name follow it. A kind that assets still use is deleted by moving them: the dialog shows how many assets use it and a "Move the assets
  to" choice (Delete stays off until a kind is chosen), and the assets, the delete and one audit row happen together or not at all; if the
  count changed while the dialog was open the server refuses and the dialog shows the new count. **Add data-centre kinds** adds a starter
  set of 39 (UPS, PDU, ATS, Chiller, CRAC and so on) once: a kind you already have, in any spelling and with any icon, is skipped and never
  changed, and pressing it again says they are all there. The kind list in the Add and Edit asset dialogs comes from this page, and a new
  kind typed there under "Other…" is added here when the asset is saved **if you may manage asset kinds**; without that permission the
  dialog says so and the asset keeps the text. The 48 icons (an asset or a kind chooses one, or Automatic) are in six groups (Structure,
  Power, Cooling, IT and network, Monitoring and safety, Other) with a search box that finds an icon by its name, a keyword or its short
  name ("transfer" finds ATS and STS). The keyword guess that used to pick every icon (a word such as Pump or UPS in the kind) now only
  suggests the icon when a kind is created, and stays as the fallback for a kind text that is not on the list.
- **Users & Roles** (admin): on its **Users** tab, create users, change roles, deactivate / reactivate, reset a password, delete a user
  (after a confirmation; never yourself and never the last administrator). Deactivating signs that user out
  everywhere. You cannot deactivate, demote or delete yourself. An account that has been blocked after too many
  failed sign-ins shows `blocked`, and **Unblock** lets it in at once; see "If you are blocked from signing in".
  Its **Roles** tab makes and edits roles; see "Roles and permissions".
- **Settings** (admin): site timezone (IANA name). It decides where a day and a month start for energy
  totals, Billing and dashboard ranges, and it must have a whole-hour UTC offset in both January and
  July (Settings refuses any other zone). `DCDASH_TIMEZONE` in `.env` (or the `-Timezone` / `--timezone` flag of the setup script) only seeds this on first start.
  **Sign-in protection** sets how many failed sign-ins block an account (3 to 20) and for how many minutes
  (1 to 60); a change is applied at once. It is on by default and an administrator can switch it off (this asks
  for a confirmation and is audited); the two numbers are kept while it is off. While it is off a password can be
  guessed without limit (only the Argon2 time per attempt slows it), and it never switches itself back on.
  See "If you are blocked from signing in".
- **Storage** (admin): database and per-tier sizes, compression ratio, rows per day, growth and a
  projected days-until-full figure. Free disk space is not visible from the API container, so disk
  capacity is a setting: set it to the size of the volume holding the database. The page also edits
  raw retention, compression delay, 1-minute rollup retention and the warning threshold.
- **Password** (everyone): change your own password; your other sessions are signed out.
- **Scans** and **Discovery** (operators and admins; only admins can change anything): see "Discovery".
- **Audit** (admin): the read-only audit log, newest first, 50 entries per page. Changes to configuration
  and access are recorded with who did it (the name stays even after the account is deleted), when, and for
  updates the values before and after; sign-in successes, failures and lockouts are recorded too. A row, its
  chevron or its time opens the entry in a drawer on the right (the address becomes `/audit/ID` and keeps the
  log's filters and page), with **Previous** and **Next** to step through the log and a **Copy** button for the
  entry's number; Esc, Close or the browser's Back brings the log back exactly as it was. The friendly sentences
  name things instead of numbering them ("for asset MV2-R1-LV-Panel-02", or "a deleted asset" once it is gone);
  the Raw view, the drawer's JSON and the CSV keep every id.
- **Dashboards** (everyone can read; operators and admins build): shared dashboards of widgets; an
  admin can mark one as the default, and the sidebar entry and the first page after signing in then open
  it; see "Dashboards and billing".
- **Billing** (everyone): cost per asset per day and per month, with a CSV export.
- **Tariffs** (admin sets, the Operator reads): the site currency and the rates that cost is calculated with.

### Protocols

Every connector is read-only toward the source; only `collector` opens connections. A source's
`last_error` reads `<status>: <message>` with status `ok`, `auth_failed`, `timeout`, `unreachable`,
`protocol_error` or `needs_profile`.

**OPC UA** (`opcua`): `endpoint` (`opc.tcp://...`), `security_policy` (`none` or `basic256sha256`),
optional `username` (the password is the source secret), `root_node` (default `i=85`, the Objects
folder; browsing descends from here) and `timeout_seconds`. With `basic256sha256` the collector
signs and encrypts with a client certificate read from `client_cert` / `client_key` (default
`/certs/opcua-client.pem` and `/certs/opcua-client-key.pem`; `./certs` is mounted read-only into
the collector). Without the files the source reports `protocol_error: client certificate not
found: <path>`. Generate a self-signed client certificate with:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=dcdash" \
  -addext "subjectAltName=URI:urn:dcdash:collector" \
  -keyout certs/opcua-client-key.pem -out certs/opcua-client.pem
```

Trust `certs/opcua-client.pem` on the OPC UA server afterwards.

**Modbus TCP** (`modbus`): `host`, `port` (502), `unit_id` (1), `profile` (`auto` or the name of an
installed profile) and `timeout_seconds`. Only function codes 3, 4 and 43/14 (device identification)
are ever sent. Point addresses are `fc:register`, e.g. `4:0` is input register 0. A profile is a
YAML file in `backend/dcdash/profiles/` describing the register layout; `auto` matches the device's
vendor/product from FC 43 against the installed profiles and fails with `needs_profile` when nothing
matches (pick a profile on the source) or the chosen profile is not installed. Example
(`generic_float32.yaml`):

```yaml
name: generic_float32
vendor: null          # set vendor/product_code to let `auto` match the device
product_code: null
blocks:
  - function: 4       # 3 = holding registers, 4 = input registers
    start: 0
    count: 8
    word_order: little
    points:
      - {name: Active power, offset: 0, data_type: float32, unit: kW}
      - {name: Energy, offset: 2, data_type: float32, unit: kWh}
      - {name: Voltage, offset: 4, data_type: float32, unit: V}
      - {name: Current, offset: 6, data_type: float32, unit: A}
```

Each point takes `data_type` (`int16`, `uint16`, `int32`, `uint32`, `float32`, ...), an optional
`unit` and an optional `scale` (default `1.0`) that the decoded register value is multiplied by, so
an `int16` register holding `1234` with `scale: 0.1` reads as `123.4`. A device that accepts the
TCP connection but never answers is reported as `timeout` after about twice `timeout_seconds`.

### Storage tiers

| Tier | Table | Contents | Kept for (default) |
|---|---|---|---|
| raw | `readings` | every sample, compressed after `compress_after_days` (7) | `raw_retention_days` (30) |
| 1m | `readings_1m` | per-minute avg/min/max of good samples (`quality = 0`) | `rollup_1m_retention_days` (730) |
| 1h | `readings_1h` | per-hour avg/min/max of good samples | forever |

A chart reads whichever tier matches its bucket width: raw under one minute per bucket, `1m` under
one hour, `1h` beyond; the `series` response carries the chosen `tier` and the chart shows it as
"raw samples", "1-minute rollup" or "1-hour rollup". Rollups and retention are TimescaleDB
continuous aggregates and policies configured from the Storage settings; no application code ever
deletes readings.

**Defaults and resets.** Next to Save the Storage page has three buttons. *Set as default* remembers the values in the form as this
site's own default and changes nothing else. *Reset to default* fills the form with that default, or with the factory values (raw 30
days, compress after 7, 1-minute rollups 730, capacity 100 GB, warn at 80 %) when no default was set. *Reset to factory settings*
fills it with the factory values. The two Resets only fill in the form; nothing is saved until you press Save.

**Saving can delete data, so it asks first.** Retention deletes whole chunks (7 days wide for raw readings, 70 days for the 1-minute
rollup), and a save re-applies the policies, which TimescaleDB then runs within about a minute. So `PUT /api/settings/storage` answers
**409** unless the request carries `confirm=true` when the save shortens the raw or the 1-minute retention, or when chunks older than
the new limits exist that no scheduled retention would delete anyway (the state after a restore that paused retention: pressing Save
then deletes them, also with unchanged values). The 409 says how many chunks, which days and how much space they take; the page shows it in a
dialog. The audit row `storage.changed` records the `origin` of the values (`factory`, `site_default` or `manual`, judged by the
saved values) and, for a confirmed save, `confirmed_loss`.

## Discovery

Discovery finds sources on the network and lets an admin map their points to assets without typing
addresses. Everything it does toward the network is read-only: a TCP connect, then the same
data-retrieval requests the connectors already use, nothing else.

1. **Scan scopes** (Scans, admin): a named list of targets (CIDR ranges, host names or addresses,
   URLs) and TCP ports (at most 20). A new scope is pre-filled from the collector's own network
   interfaces, clamped to the /24 around its address, and from the ports the connectors know.
2. **Confirmation.** Pressing Scan shows "N hosts × M ports (P probes)" and asks for confirmation on
   every run. The API enforces it: the start request must carry the host count the API computed
   itself, or nothing runs. It must also carry the digest the preview returned (a hash of the scope's
   targets and ports), so a scope edited after it was previewed cannot be started unconfirmed: the
   page asks you to confirm again.
3. **What a scan does.** The collector tries a TCP connect to every host and port, then offers each
   open endpoint to every connector's read-only probe (first claim wins; an endpoint nobody claims is
   listed as an unidentified service), then browses the claimed sources to find their points. The page
   shows progress and, when done, one finding per open endpoint.
4. **Discovered sources are disabled.** A discovered source is created disabled and is not polled,
   tested or listed under Sources until at least one of its points is mapped; mapping enables it. A
   source you added by hand at the same address is reused, never duplicated. A re-scan reuses existing
   source rows untouched (name, config, secret, enabled, origin) and only refreshes their points and
   findings. A source that answers "authentication failed" is marked as needing credentials and the scan
   carries on.
5. **The graph** (Discovery). Discovered sources, clusters and points are on the left with dashed
   borders; your assets are on the right with solid ones; mapped points are joined to their asset by a
   solid edge. Sources and clusters start collapsed: use the + / − button on a node to expand or
   collapse it. Points are grouped into suggested clusters (for example one per panel). Dragging nodes
   saves their positions for everyone (admin); an operator's arrangement lasts for the session.
6. **Mapping by drag and drop** (admin). Drop a cluster or a point on an asset to open the **Review
   mappings** dialog: one row per unmapped point with a guessed metric, scale and interval, all
   editable; rows whose metric the asset already has start unchecked, and a conflicting selection
   cannot be committed. "Create mappings" commits every checked row in one transaction. Drop a cluster
   on empty canvas and a bar offers "Create asset from this cluster", which opens the same dialog with
   a new asset named after the cluster and a parent of your choice; the bar stays until you use or
   dismiss it. The same dialog opens from keyboard-reachable buttons, for admins only: **Map…** on
   unmapped clusters and unmapped points, **New asset…** on clusters only. The Ungrouped bag and fully
   mapped clusters get neither.
7. **Credentials.** Click a source that shows "needs credentials" (or press its **Details** button) to open its side panel, enter the
   secret (and the user name for OPC UA) and save: the source is browsed again. Secrets are stored
   encrypted and never returned by the API.
8. **Audit log** (Audit, admin). Every change is recorded with the user (name and id, kept on the row,
   so the name stays after the account is deleted) and the time, and an update records the values
   before and after (only the fields that changed; a save that changes nothing writes no row, except a
   storage save, which re-applies the compression and retention policies and is always recorded).
   Audited: users (create, role, active, password reset, delete: `user.deleted`), your own password changes, first-run
   setup, sign-ins (success, failure, lockout; a wrong current password on a password change counts as
   a failure), an admin unblocking an account (`login.unblocked`), a change to the sign-in protection numbers or its
   switch (`settings.sign_in_changed`), the site timezone, the currency, the storage settings (every save, `storage.changed`, whose
   subject carries `origin`, and, for a save that needed confirmation, `confirmed_loss`; remembering a site
   default is `storage.default_set`), assets (create, edit, delete, and moving in the tree: one `asset.moved` entry per moved
   asset, with its old and new parent, all sharing one request id), mappings,
   sources (create, edit, delete, test, test all, browse), tariffs, dashboards, asset kinds (a delete that moves assets records how many and
   where to; adding the starter kinds records which), scopes, scans (start and
   finish) and accepted discoveries. Never recorded: passwords and password hashes, source secrets and
   credentials inside a URL (a marker shows that one was set or changed: `secret: set -> changed`, or
   `config_credentials: unchanged -> changed` when the credentials inside a source's URL changed, also when
   other fields changed in the same edit),
   a sign-in with an unknown username (only that one happened, and from which address), logging out and
   the node positions on the Discovery graph. Failed sign-ins are capped at 30 rows per 5 minutes, then
   counted on the next row (lockouts have their own cap of 30).

Environment variables (set them in `.env`; both are optional):

| Variable | Default | Meaning |
|---|---|---|
| `DCDASH_SCAN_MAX_HOSTS` | `1024` | Most hosts a single scan may cover; a larger scope is rejected |
| `DCDASH_SCAN_EXTRA_PORTS` | empty | Comma-separated ports offered, besides the connectors' own, when a new scope is pre-filled. For the dev simulator set it to `5020` (its Modbus port), or type `5020` into the scope form |

Scan limits: at most 64 TCP connects at a time and 200 attempts per second, a 1 second connect
timeout, a 3 second timeout per connector probe, 4 sources browsed at a time. Targets are IPv4 only.
In the dev stack, a scope with targets `simulator` and ports `9000, 4840, 5020` finds all three
simulator protocols.

## Dashboards and billing

Roles are enforced by the API; the screens only hide what you cannot use. The table is the three built-in roles; see "Roles and permissions" for what each permission allows and for making a role of your own.

| | Viewer | Operator | Admin |
|---|---|---|---|
| Open dashboards and Billing, export CSV | yes | yes | yes |
| Create, edit and delete dashboards | no | yes | yes |
| Choose the default dashboard (Dashboards list, row menu) | no | no | yes |
| Read tariffs and the currency (Tariffs screen, read-only for an Operator) | no | yes | yes |
| Set tariffs and the currency (Tariffs screen) | no | no | yes |

**Dashboards** are shared by everyone. A dashboard holds up to 24 widgets (the site up to 50
dashboards) of five types: time series, bar, stat, gauge and table. A dashboard name is 1 to 100
characters (spaces at the ends are trimmed) and unique: a name already in use is refused with a 409. A
widget title is at most 100 characters. A widget shows a metric, energy or
cost for up to 20 assets (a stat or a gauge shows one). A dashboard has one time range and a widget may
override it. The ranges are the rolling `1h`, `6h`, `24h`, `7d`, `30d` and the calendar `today`,
`yesterday`, `this_month`, `last_month` (in the site timezone); there are no custom date ranges, and
changing the range on the page affects that visit only. Stat and gauge widgets that show the latest value
follow the live stream while their range ends now (the rolling ranges, `today` and `this_month`; not
`yesterday` or `last_month`); every widget also refreshes every 30 seconds. **Edit** (operators and admins)
opens the grid editor: drag a widget by its title bar, resize it from the corner or the edges, **Add
widget**, then **Save**, which stores the whole dashboard in one step. Widgets always close up vertically
(there are no gaps), in the editor and in the view alike: dropping a widget on an occupied place moves the
others down only as far as needed, and a dashboard saved earlier with gaps is shown closed up without being
rewritten until someone changes it and saves. If someone else saved first you are
told, nothing is overwritten, and you can reload their version. Leaving the editor from inside the app,
or closing the page, asks first when something is unsaved; a session that expires while you edit does
not: the app signs you out and the unsaved edits are dropped without a prompt. A widget whose asset
was deleted shows "N assets removed" and draws the rest. A metric with no reading in the range says "no
data" (the dash is only for a missing rate), and a cost chart with unpriced buckets says "— no rate" under
its title. Every widget has a CSV button (UTF-8 with a byte-order mark,
times in the site timezone with their offset, columns `asset,source,unit,timestamp,value,estimated,partial,no_data`;
text starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe so that
spreadsheets do not run it as a formula). Custom metrics are not available in widgets; they stay on the
asset page. A metric widget offers only assets that have a mapping for that metric.

**The default dashboard** is one dashboard an admin picks in the Dashboards list (the `⋯` menu of a row:
**Make default**, or **Clear default** on the one that is). It carries a `Default` badge. The sidebar's
Dashboards entry then opens it directly and so does the first page after signing in (a page you were sent
away from when your session expired still wins; a deliberate sign-out forgets the page, so signing in
again lands on the default). The list of all dashboards stays one click away: the **Dashboards** crumb
above the dashboard, or the Quick find entry. With no default set, the entry opens the list and the first
page is Assets Tree. Deleting the default dashboard clears the choice (the audit row says so); choosing, switching
and clearing it are audited as `dashboard.default_changed`. An open page learns of a change within a minute
or when you return to its window.

**Billing** shows one month at a time (previous and next month, or the Year and Month selects beside them
to jump straight to a month; the years start at the first month with energy data; the current month by
default) as the
asset tree by day: kWh above, cost below, then the month total and the rate in effect. `~` marks a
figure estimated from power and `*` a partial cost (some energy in the period had no rate). A dash means
one thing: there is no rate for that cost, and a missing rate is never shown as zero. An empty cell is an
asset without a meter, or a day that has not been reached yet. A shaded cell with `0.0` kWh and a `0.00`
cost (a dash when no rate applies), titled "no data", is a day with no data: its zero is not a
measurement. The CSV button exports one row per asset per day
(`asset,date,kwh,cost,currency,estimated,partial,no_data`). The asset page shows today's cost next to
today's energy.

**Tariffs** (an administrator sets them) hold the site currency (one three-letter code for the whole site; when it is unset,
costs show without a unit) and the rates, in that currency per kWh. Changing or clearing the currency
asks for confirmation: it relabels every past figure and converts nothing. A rate is a number of zero or
more with up to six decimals and an effective date (a date in the site timezone). For an asset on a
given day the rate is the latest one effective on or before that day, taken from the nearest asset up
the tree that has its own rates, otherwise from the site default; an override therefore takes over from
its own date. Editing a past rate recalculates history: cost is for visibility, not invoicing. Tariff,
currency and dashboard changes appear in the Audit log; an update shows the values before and after.

**The energy engine.** One engine produces every energy figure (asset page, Billing, dashboards), so
they agree. It reads the hourly rollup (`readings_1h`) and works in whole hours; a day or a month is the
sum of its hours in the site timezone. For an asset with an `energy_kwh` counter an hour's energy is the
hour's last counter value minus the previous hour's, the first hour of a period starts from the last
value before it, and a counter reset or rollover is recovered instead of counted as negative or inflated
energy. An asset with only `active_power_kw` gets average power times the time its samples cover, so an
outage adds nothing; such figures are marked `~` (estimated) wherever they appear. A parent asset uses
its own meter if it has one, otherwise the sum of its children; a meter with no readings at all counts
as 0, and an asset with no energy or power mapping anywhere beneath it has no figure.

**How history is calculated.** Billing and dashboards follow the current configuration: past months
are recomputed from today's mappings, scale factors, asset tree, tariffs and site timezone. Re-pointing
a panel to another source, changing a scale or the timezone, moving an asset or deleting one therefore
changes past figures. Deleting an asset that has children, mappings or tariffs, or a source with mapped
points, asks for confirmation and is audited. A parent's own meter counts from its first reading (the
hours before it are the sum of its children, so adding a meter later does not zero the past), and the
estimate for an asset with only a power reading covers the minutes in which it has samples. A day with
no data shows its energy as zero (`0.0` kWh in Billing cells, `0.00` in a widget), muted and titled
"no data" (a rate in effect makes its cost `0.00`, otherwise the cost is a dash). The hourly rollup is
the only permanent copy of this data, so back it up (see "Backup and restore").

**Asset names and scales.** Within one parent (the top level counts as one) two assets cannot have the same name; case and spacing do
not make a different name ("Panel A" and " panel  a " are the same). Creating, renaming, moving and Discovery's "new asset" are refused
with a 409 that names the clash. Twins created before the rule stay as they are and can still be edited while their name and parent
stay. A mapping's scale must be above 0 and at most 1e12; a reading that is NaN or infinite is stored with bad quality and never
reaches Billing.

Limits: the site timezone must have a whole-hour UTC offset in both January and July (so that day and
month edges fall on hourly buckets); Settings refuses other zones, and Billing and widget data answer 409
if a stored zone breaks the rule. The rollups refresh over the last 7 days, so readings that arrive later
than that are not included in energy figures. One counter reset per hour is recovered exactly; a second
one inside the same hour may understate that hour. Energy estimated from power is an estimate, not a
measurement. The currency is one per site, there are no time-of-use tariffs, and custom metrics cannot be
used in widgets.

## Roles and permissions

Every action in the API needs a named permission, and an account holds one role: a role is a set of permissions. The screens only hide
what the server would refuse. There are 30 permissions, in groups by area. A **See** permission opens a page, a **Change** permission
edits what is on it, and a few risky actions are separate on purpose (deleting assets, exporting billing or the audit log, running
scans, accepting scan results, choosing the default dashboard, changing sign-in protection, managing asset kinds, managing roles).

**Built-in roles.** Viewer, Operator and Admin exist from the start. They cannot be edited or deleted (the API answers 409), and they
behave as they did before roles were made of permissions (the one change, in W9b, is below):

- **Viewer**: `assets.view`, `dashboards.view`, `billing.view`, `billing.export`.
- **Operator**: everything a Viewer has, plus `dashboards.edit`, `tariffs.view`, `sources.view`, `sources.test`, `discovery.view` and
  `diagnostics.run`.
- **Admin**: every permission in the catalogue, now and when a later release adds one (it is computed from the catalogue, not stored).

**The 30 permissions** (`backend/dcdash/core/permissions.py` is the one list; the Roles tab draws from it):

| Area | Permission | What it allows |
|---|---|---|
| Assets Tree | `assets.view` | Open the Assets Tree, an asset's details and charts, and the fleet summary. |
| | `assets.edit` | Add and edit assets and map points to them. |
| | `assets.delete` | Delete an asset (its mappings go with it). |
| | `assets.kinds` | Create, rename, re-icon and delete asset kinds (a rename or a move changes the kind of every asset that uses it), and add the data-centre starter kinds. |
| Dashboards | `dashboards.view` | Open dashboards and their widgets, receive live values, and read the values of any point through a widget. |
| | `dashboards.edit` | Create, edit and delete dashboards and their widgets. |
| | `dashboards.default` | Choose the dashboard everybody lands on. |
| Billing and tariffs | `billing.view` | Open the Billing page: energy and cost per asset and month. |
| | `billing.export` | Download the billing table as a CSV file. |
| | `tariffs.view` | Open the Tariffs page, read-only (with `assets.view`), and read the tariff list and the currency. |
| | `tariffs.edit` | Set the currency, the site rate and per-asset rates (with `tariffs.view` and `assets.view`). |
| Sources and discovery | `sources.view` | Open the Sources page, a source's points and the collector status. |
| | `sources.edit` | Add, edit and delete data sources and browse their points. |
| | `sources.test` | Make the server try to reach a source (Test and Test all). |
| | `discovery.view` | Open the Scans and Discovery pages. |
| | `discovery.edit` | Add, edit and delete scan scopes; save the graph layout. |
| | `discovery.scan` | Start a scan of a scope (it probes a network). |
| | `discovery.accept` | Turn scan results into sources, assets and mappings. |
| Storage and settings | `storage.view` | Open the Storage page. |
| | `storage.edit` | Change retention, compression and disk limits. |
| | `settings.view` | Open the Settings page. |
| | `settings.edit` | Change the general settings, such as the time zone. |
| | `settings.security` | Switch the sign-in protection on or off and change its limits. |
| Audit log | `audit.view` | Open the audit log and its entries. |
| | `audit.export` | Download the audit log as CSV. |
| Users | `users.view` | Open the Users tab of Users & Roles. |
| | `users.edit` | Create, edit, deactivate and delete accounts; reset passwords; lift sign-in blocks. |
| Roles | `roles.manage` | Create, edit and delete roles. Only the built-in Admin role holds it. |
| Diagnostics | `diagnostics.view` | Open the Diagnostics page (with `sources.view`) and build a report, which includes settings, retention, the audit tail and each source's security settings. |
| | `diagnostics.run` | Run the step-by-step connection check of a source. |

A few things that are easy to miss:

- **Sign-in protection has its own permission.** The Settings page has two cards: General (`settings.edit`, the time zone) and
  Sign-in protection (`settings.security`: the switch and its two numbers). Whoever holds `settings.security` can switch the protection
  off, so it is a sensitive action; a role with only `settings.edit` sees that card read-only, and the API refuses it (403).
- **A custom role can never manage roles.** `roles.manage` is held by the built-in Admin role only: the API refuses a role that lists it
  (422), and a stored list that happens to name it grants nothing.
- **Nobody can pass on more than they hold** (the subset rule). You can save a role, or give an account a role, only if you hold every
  permission that role grants. And you can change an account (reset its password, deactivate or reactivate it, change its role, unblock
  it, delete it) only if you hold every permission its role grants. That second half is why `users.edit` cannot be used to become
  Admin: resetting an Admin's password, or giving anyone the Admin role, needs `roles.manage`, which no custom role has. Changing your
  own role is refused (409), and so is deactivating or deleting yourself; the last active Admin can never be removed.
- **Two pages need more than their own permission.** The Diagnostics page needs `diagnostics.view` and `sources.view`, and the
  Tariffs page needs `tariffs.view` and `assets.view` (it lists the assets its rates belong to); `tariffs.edit` turns its forms on. A role
  with only `diagnostics.view` gets "No access" on the Diagnostics page, and one with only `tariffs.view` gets it on Tariffs. The Roles tab
  says so in words under the role's ticks ("... also needs ...") before you save.
- **A role that accounts hold cannot be deleted** (409, with the number of accounts). Duplicating Admin gives a role with every
  permission except `roles.manage`.
- **There is no per-site or per-asset scoping yet.** A permission applies to the whole site: `assets.view` shows every asset.
- **A change takes effect on the person's next request**, with no cache in between. A page that person already has open keeps what it
  loaded, notices on its next focus (or the first request that is refused) and shows "Your access changed. Reload to see what you can
  use now." (or "Your role changed from X to Y. Reload the page to continue." when the role itself was changed).
- **Two small changes for the API's callers.** A role name in `POST /api/users` or `PATCH /api/users/{id}` is matched ignoring case, so
  `"Operator"` and `"ADMIN"` are accepted (they used to be refused with a 422), and an unknown name answers 422 with
  `{"detail": "unknown role"}` (it used to be a list of validation errors). Authorization is checked before the request body is
  validated; the one exception is a body that is not valid JSON at all, which gets its 422 first, signed in or not.
- **A page the role lacks** shows the heading "No access" and "Your role does not include this page." (this replaces the old "Admins
  only" and "Operators only"). A role that holds no permission at all can sign in, change its own password and read the site name, the
  version and the status chip, and lands on "Your role has no pages yet." (the top bar and the page, with no sidebar). An action the
  role lacks is refused, and where the page shows the reason it reads "Your role does not allow this."
- **Where an account lands** after signing in: the default dashboard if there is one and the role may see dashboards, else the Assets
  Tree, else the first page its sidebar offers.
- **Everything is audited.** `role.created`, `role.updated` and `role.deleted` are in the Audit log with the permissions added and removed,
  and a change of an account's role lists the permissions it adds and removes.

**Making a role.** Signed in as an administrator, open **Users & Roles**, then the **Roles** tab (only the Administrator role has it). The
list shows each role's accounts. **New role** opens an editor: a name (1 to 64 characters, unique
ignoring case, not a built-in name), an optional description, and the permissions as a grid with one row per area, **See** (opens the page)
and **Change** (edits what is on it), then **Sensitive actions**. **Start from** Viewer or Operator ticks their permissions for you
(choosing one replaces the ticks). Under the grid a summary says what the ticks add up to ("Opens: Assets Tree, Dashboards, Billing."),
and a line names a tick whose page would still show nothing ("Export billing as CSV also needs See billing ..."), but that line never ticks anything,
because the server accepts any combination. A row's menu has **Edit** and **Duplicate** (a built-in role says **View** instead:
it opens locked, with a Duplicate button), and the bin deletes a role nobody holds (it is disabled, with the reason, while an account has it).

**Offers while you tick (W9c).** Tick a permission whose page would show nothing without another one (**Change users** without **See users**)
and a small card opens beside the box: "Change users also needs See users to show anything." with **Also tick See users** (when several are
missing it lists them and one button ticks them all) and **Not now**. Not now, Escape, a click elsewhere and tabbing away all mean Not now:
the box stays ticked, the hint line stays and nothing is ticked for you. Unticking a permission that another ticked one needs (untick
**See users** while **Change users** is ticked) opens the reverse card, "Also untick Change users?", with **Leave ticked** as the quiet answer.
The card ignores the mouse for its first 0.4 seconds, so a quick click on the next box still reaches that box. Nothing opens when a role is
loaded, **Start from** is chosen or a role is duplicated, and Save still sends exactly the boxes that are ticked. This is the editor only:
there is no migration and no API change (the server still accepts any combination).

The Executive, who reads energy and cost and nothing else: Roles > **New role**, name `Executive`, tick **See the Assets Tree**,
**See dashboards**, **See billing** and **Export billing as CSV**, a **Description** such as `Sees energy and cost` (optional), **Save**. On
the Users tab, create the account and choose `Executive` in **Role** (when the role has a description, a line under the form shows it; a role
without one shows no line). That person's sidebar is Assets Tree, Dashboards and Billing, every other
page says "No access", and the API refuses the rest. Tick **See tariffs** later and the open page of that account offers a Reload.

**The same through the API.** `GET /api/permissions` lists the ids; `POST /api/roles` creates a role (201, with its id and the sorted permissions);
`PATCH /api/roles/{id}` changes its name, description or permissions; `DELETE /api/roles/{id}` removes it; `POST /api/roles/{id}/duplicate`
makes an editable copy of any role (an optional `{"name": "..."}` names it). A role name is 1 to 64 characters, unique ignoring case, and
may not be a built-in name. An example body for a role that reads energy and cost and nothing else:

    {"name": "Executive", "description": "Reads energy and cost", "permissions": ["assets.view", "dashboards.view", "billing.view", "billing.export"]}

From the browser's developer console on any page of the site, signed in as an administrator, this sends it with your session:

    await fetch("/api/roles", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Executive", description: "Reads energy and cost",
        permissions: ["assets.view", "dashboards.view", "billing.view", "billing.export"] }) }).then((r) => r.json())

Give the role to an account by its **name**, matched ignoring case: `POST /api/users` or `PATCH /api/users/{id}` with `"role": "Executive"`.
The Users tab lists the role of every account (an account with a custom role keeps it when you edit its other fields). Its Create
user form and role choice offer the roles the server says you may hand out (the built-in names first, then the others by name), and a
row whose role grants something you lack is shown read-only, with no role choice, menu or trash can. A person who may not hand out a role
never sees it offered once the page has the server's list of roles (while that list is loading, or could not be read, the three built-in
names are shown and the server still refuses what is not allowed).

**What changed in W9b.** The built-in roles keep their permissions; the one thing a person will notice is that the built-in **Operator**,
who has held `tariffs.view` since W9a, now sees **Tariffs** in the sidebar and the quick find (Ctrl+K), opens the page read-only (no forms,
no row menus) and may read the currency (`GET /api/settings/billing` answers 200 instead of 403; setting it stays `tariffs.edit`). The
missing-rate banner on Billing still tells the Operator to "Ask an administrator". Sign-in protection moved out of `settings.edit` into
`settings.security`, so **a role made through the API before W9b that holds `settings.edit` lacks `settings.security` until someone ticks
it** on the Roles tab (the Administrator has every permission and is unaffected). The `permissions` column of the three built-in rows in
the database is the snapshot migration `0009` wrote (28 ids, no `settings.security` and, since W7o, no `assets.kinds`) and is never refreshed: a
built-in role's permissions come from the code, so reading that column shows an Admin row without them, and nothing is affected.

## Develop

```bash
cd backend
uv sync
uv run pytest
```

Tests start their own TimescaleDB container, so Docker must be running.

Frontend (needs the stack running for the API):

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173, /api proxied to localhost:8000
npm test
npm run typecheck
npm run build      # typecheck + production bundle; the grid and the chart widgets are separate, lazily loaded chunks
npm run e2e        # Playwright; needs a fresh stack and an isolated Compose project, see "End-to-end test"
```

For `npm run dev` to reach the API without Caddy, temporarily publish it:
`docker compose run --rm -p 8000:8000 api` or add `ports: ["8000:8000"]` to a
`compose.override.yaml` (ignored by git).

### Brand assets

The logo and the browser-tab icon are the owner's gold M. His original is `docs/brand/logo-original.svg`; `frontend/public/` holds what the app
serves (`logo-mark.svg` for the top bar and the sign-in page, `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`).
Run `make-brand-assets.mjs` (in the `frontend/scripts` folder) with `node` from `frontend/` to make them from the original: the SVGs copy its
paths (nothing is redrawn) and Chromium, the one Playwright installs (or the executable in `CHROMIUM_PATH`), draws the PNGs and the ICO. The app
names the logo in one place, `BRAND_MARK_SRC` in `frontend/src/components/BrandMark.tsx`.

### End-to-end test

> **Data safety.** `docker compose down -v` on the normal project deletes the `dcdash_dbdata` volume:
> every reading, user, source, tariff and dashboard you have. Never run it where that data matters. Run
> the end-to-end tests only in the isolated Compose project described below, which has its own volume;
> `scripts/e2e.sh` does exactly that (it always names the project `dcdash_e2e`, refuses any other name
> and cannot reach `dcdash_dbdata`).

Twenty-six specs run in one `playwright test` run against the dev-profile stack on `http://localhost/`
(`frontend/e2e/playwright.config.ts` runs them in this order; each project depends on the one before):

- `journey.spec.ts` drives a real browser through first-run setup, adding the simulator, mapping two
  points and watching live values.
- `discovery.spec.ts` (after it, at 1600×1000) scans the simulator's network, expands the OPC UA
  source into its ten panel clusters, maps `LVP01` onto an existing asset and `LVP02` onto a new one
  by real mouse drags, creates `LVP03`...`LVP10` through the buttons, then checks through the API that
  all 60 points are mapped (six distinct metrics per asset), that a live value arrives, and that the
  audit log holds the scope, the scan and ten accepted mappings (counted through the API, because the
  Audit page shows only the newest 50 rows and every sign-in adds one).
- `phase3.spec.ts` (after it, at 1600×1000) reuses that state. An admin sets the currency, sees a dash
  (not zero) on Billing while no rate exists, adds a site default rate, and checks the current month on
  Billing (a priced panel row, its month total and today's cell, the month CSV with its header and
  byte-order mark) and the cost tile on an asset page. The admin creates an operator and a viewer; the
  operator builds a dashboard with a stat and a bar widget, saves it, reloads and finds both widgets and
  their layout, changes the dashboard range and downloads a widget's CSV; the viewer sees the dashboard
  with no edit controls, no Tariffs link and `403` from the write API; the admin finds the tariff,
  currency and dashboard entries in the audit log (counted through the API as well).
- `headers.spec.ts` (after it) checks the security headers on the page and the API and walks every page an admin can open,
  failing on a Content-Security-Policy violation.
- `w3a.spec.ts` (after it, at 1600×1000) adds a child asset from a `+` and picks the Kind from the list, sorts, filters and searches the
  source's points, checks the unit warning in the mapping dialog, and adds and edits a source that has no mapped points.
- `w3b.spec.ts` (after it, at 1600×1000) checks that a dashboard saved with a gap closes up the same in the view and in the editor (and
  that Save stays disabled until something changes), that a parent asset shows the sum of its sub-assets' live power, that the asset
  page's Trend says when it was updated, and that a dashboard with a 45-character asset name draws its bar and time series widgets.
- `w3c.spec.ts` and `w3d.spec.ts` (after it, at 1600×1000) cover the Audit screen (filters, search, a link per entry, CSV export, paging,
  administrators only) and sign-in protection with the Users & Roles page (a blocked account, Unblock, Delete, and no screen or API answer showing
  the password stored inside a source's URL).
- `w7a.spec.ts` (after `w3d`, at 1600×1000) checks the Assets workspace and the shell: a tree node opens its asset with one click and the tree
  stays, the "Assets Tree" crumb returns to the summary, the tree column resizes by keyboard and keeps its width and its folds across a reload,
  quick find (Ctrl+K) and its Esc keys, the "Live" status chip, Billing and Users & Roles at the full width of a 1920 px window, the summary's four
  tiles and "Needs attention", and the profile panel's Sign out with its Cancel.
- `w8.spec.ts` (after `w7a`, at 1600×1000) checks field diagnostics: an administrator's Diagnostics page builds a summary report (a header,
  a size and a checksum line per part, the build id) and leaves an audit row without the content; a masked report names no source
  address in its text, and its address key lists what each alias stands for; Copy puts the exact text of a part on the clipboard and
  Download saves the same text; the connection check runs on a chosen source and shows its steps; an operator has no Diagnostics page
  (turned away from it and from the report) but checks a source from its row. It makes one operator and deletes it again.
- `w7b.spec.ts` (after `w8`, at 1600×1000) checks the shared controls: the Sources row menu from the keyboard, opened by hover and kept open
  by a click, not clipped or covered at 1600 and 1024 px wide, and the last row of a source's points staying inside the window; the trash
  button asking first, with Cancel keeping the source; the Storage tips and the rows per day following the chosen days; the sign-in
  protection switch (switching off asks first, off blocks nobody, on blocks again); and the Tariffs sections with their tip. The only
  thing it writes is the sign-in policy, which it puts back.
- `w7c.spec.ts` (after `w7b`, at 1600×1000) checks the default dashboard and the Billing picker: an administrator marks a dashboard as the
  default from its row menu and the sidebar, `/` and sign-in follow it; an operator and a viewer see the badge and the sidebar link but
  cannot change it (`403` from the API); and the Year and Month selects beside Previous and Next start at the current month and jump to a
  month far back. It makes two dashboards, an operator and a viewer, removes them again, and puts the default back to none.
- `w7d.spec.ts` (after `w7c`, at 1600×1000) checks the Appearance choice: Mode and Theme colour in the profile panel, a choice applying at
  once, saved on the account and surviving a cleared browser; sign-out keeping the look on the sign-in page while another account on the
  same browser gets its own; Match my device following the device only while it is chosen; the keyboard walk of the two selects; dark mode
  (a widget frame stays white, no sideways scroll at 1440 and 1024 px); and `theme-init.js` served as JavaScript and loaded without a
  Content-Security-Policy violation. It puts the admin's choice back to Light and Navy and gold.
- `w7e.spec.ts` (after `w7d`, at 1600×1000) checks the theme polish: buttons, links, hover and the selected row taking the theme's colour
  in all four presets, light and dark; the dropdowns from the keyboard (Esc, arrows then Esc, Enter, the choice kept across a reload); a
  refused save putting the dropdown and the page back and saying so; the loading bar along the top edge in the theme's marker colour
  (all four presets, a full line under reduced motion, never on a poll, never blocking a click); a kind icon on every tree row and in
  the asset header; the dashboard widgets keeping their light blue accent in all eight looks; and no sideways scroll at 1024 px in any
  look. It makes two assets and a dashboard and removes them again.
- `w7f.spec.ts` (its own project, after `w7e`, at 1600×1000) holds a page's first data request and checks the loading skeletons: one status
  region per area and none of the content, and the content back with the region gone once the data arrives (an asset page, the summary,
  the Dashboards list, Users & Roles); the skeleton against the loaded page to 2 px (the asset page, the Trend frame's height, the summary at 1440
  and 1024 px); the stored tree width while the asset list loads; no flash for an answer within 40 ms and a fade-in from nothing for a
  slow one; no skeleton on a poll, and none after a failed poll; the error alert replacing the skeleton; no sweep under reduced motion;
  the dark token in dark mode.
- `w7g.spec.ts` (its own project, after `w7f`, at 1600×1000) checks the asset icons and the new page name: the sidebar entry, the first
  crumb and the tree heading read "Assets Tree"; the Add asset dialog's Icon field (a collapsed grid, the caption "Automatic (Generic)"
  that follows the Kind, the arrow keys changing the choice and the caption, Server chosen and saved) and the same icon in the tree row,
  the asset page's title and quick find; Edit back to Automatic (the icon follows the kind again); the choice kept across a reload;
  Esc inside the open grid closing only the grid (a second Esc closes the dialog) with nothing saved; Enter on a cell not saving; no horizontal scroll at 1440 and 1024 px
  with the dialog open. It creates one asset of its own and deletes it afterwards.
- `w7h.spec.ts` (its own project, after `w7g`, at 1440 and 1024 px in fresh browser contexts) checks the first-load screen: the HTML the server
  sends already holds the shell and carries the security headers; with `/api/me` held, the navy bar, the sidebar and one "Loading" status
  are there (no bare "loading..." line) and the real shell replaces them with the same bar height, sidebar width and content corner (to 0.5 px)
  and the same single loading bar that never restarts; with the app's script held, the static copy alone has the same navy and widths in four
  looks, with the sidebar minimized and at 1024 px; the sign-in and setup pages (any case) show no shell; a signed-out deep link lands on the
  sign-in page without the real shell appearing and returns to the page asked for; a slow start never shows an empty page; reduced motion;
  no Content-Security-Policy violation on any of it.
- `w7i.spec.ts` (its own project, after `w7h`) checks what W7i added: with the API unreachable (the `/api/me` request answered 502 by the
  test) a deep link shows "Can't reach the server" at the same address instead of the sign-in page and the page loads once the answer
  is back; the banner inside the app appears after two failed requests and goes with the first answer; an expired session still goes to
  the sign-in page; a 200-character asset kind wraps instead of widening the page; and the "Skip the tree" link moves focus to the asset
  details. `headers.spec.ts` also checks the cache and compression headers of the built site.
- `w7j.spec.ts` (its own project, after `w7i`) checks the page layouts of W7j at 1920, 1440 and 1024 px: no sideways scroll on the Audit log,
  Storage, Tariffs, Settings and Diagnostics; Settings' two cards the same height with their Save buttons level; Tariffs' and Storage's two cards
  side by side at 1440 and stacked at 1024; Tariffs' description wider than 800 px; the Audit toolbar in at most two rows with every accessible
  name still found, the table still a table with a header row and a Details button that opens a detail row; the version line never saying
  "built unknown"; and the loading skeleton of each page landing within 2 px of the loaded page at 1024 (Settings at 1440 too).
- `w9a.spec.ts` (its own project, after `w7j`, at 1600×1000) checks roles and permissions: a viewer, an operator and an administrator each see
  exactly their sidebar and get `No access` on a page they lack (and `/api/me` lists their permissions); the API, with each role's own session,
  refuses every route above the role (a Viewer, an Operator, an account whose role holds nothing, a role with only `assets.view` and
  `dashboards.view`) with the one 403 text, refuses the live stream to a role with no permission (403) and to nobody signed in (401), and
  keeps setup closed (409); a role made through the API with only `assets.view` sees only the Assets Tree and lands on it, a role with no permission lands on "Your role has no pages yet.", and a
  permission taken from a role is refused at once while the open page of that account says "Your access changed" on its next focus check and
  the Audit log words the change; a role that may change users (every permission but `roles.manage`) cannot make an Admin, give itself Admin
  or reset, deactivate, demote, unblock or delete one; an Admin cannot demote, deactivate or delete itself (409), the built-in roles
  cannot be changed or deleted, `roles.manage` cannot be put in a custom role, and a role an account holds cannot be deleted (409). It
  makes its accounts and roles (every name starts with `w9a-`) and removes them again, users first.
- `w9b.spec.ts` (its own project, after `w9a`, at 1600×1000) checks Users & Roles: the tabs follow the arrow keys, the address, a reload and
  Back; an administrator makes the Executive role with four ticks, gives it to a new account, whose sidebar is exactly Assets Tree,
  Dashboards and Billing (other pages say "No access", the API answers 403 except the billing export), and a tick added later reaches
  that account's open page (the Reload notice) and opens Tariffs read-only; a role in use has a disabled bin (a direct delete is 409), the
  admin cannot change their own role, a taken name keeps the dialog open; Duplicate of the Operator opens `Copy of operator` with its
  ticks; the Operator's Tariffs has no form; `settings.edit` and `settings.security` each open one card of Settings (the spec puts the
  time zone back); and the editor works from the keyboard. Every name starts with `w9b-`; they are removed again, users first.
- `w7k.spec.ts` (its own project, after `w9b`, at 1600×1000) checks the W7k feedback. The three Save buttons that save in place (Settings'
  General and Sign-in protection, Tariffs' Site currency, saved unchanged) go from "Save" to "Saving…" (the request is held) to a green
  "Saved" on the theme's `--ok` colour and back in about 3 s, with one width in all four phases, light and dark at 1440 px, no toast and no
  loose "saved" word. A leaf asset's trash opens ONE styled dialog (the browser's own box never opens) that says "Checking what this
  deletes…" while the preview is held, then `Delete "NAME"?`; Cancel keeps the asset and the focus goes back to the trash button; Delete
  sends the counts the dialog showed and raises the toast `Asset "NAME" deleted` in the lower right corner, gone within 6 s. A branch asset
  (a child and a rate) shows the impact sentence with "Delete anyway"; a child added while the dialog is open makes the first confirm
  answer 409 with the new numbers, and only the second deletes. A source with mapped points shows the sources wording (cancelled, never
  deleted); a source with no points is deleted with its toast. "Asset created" does not cover the profile menu and can be dismissed, Esc
  still closes a dialog under a toast, a toast appears and leaves under reduced motion, the menu of the last Sources row is reachable under
  "Source added" at 1440×900 and 1024×768, the toast keeps its 16 px margins below 720 px, and the dialog works from the keyboard. Every name
  it makes contains `W7k` and the run suffix; it removes them again.
- `w7l.spec.ts` (its own project, after `w9c`, at 1600×1000) checks the audit log's names and drawer. A rate's entry reads `Created tariff 0.37
  per kWh from 2019-03-14 for asset NAME` with no `#`, in the row and in the drawer, and `for a deleted asset` once the asset is gone, while
  Raw and the drawer's JSON keep `asset_id`. An entry opens in a drawer 480-520 px wide at the right edge (a click on the sentence, the chevron
  or the time), focus inside, the page behind inert and not scrollable; Previous and Next replace the address (one Back closes the drawer),
  cross the end of a page, and stop at the newest and oldest entries with the reason in the button's name; Esc, Close and a click beside the
  drawer put the focus back on the chevron of the entry that was open; a deep link opens the drawer over its own page, and an entry that is
  not on that page opens but cannot be stepped from. Closing keeps the page number and the scroll position. Copy shows its toast above the
  drawer without covering Previous or Next, at 1600 and 600 px. The Create user card has one height for Viewer, Operator and a role with no
  description, and the Tariffs cards and left date picker do not move when Add rate is pressed with nothing chosen, before and after a valid
  add, both at 1440 and 1024 px. The bin's lid lifts on hover (a screenshot goes into the report). The asset, rates and role it makes contain
  `W7l` and the run suffix; it removes them again.
- `w7m.spec.ts` (its own project, after `w7l`, at 1600×1000) checks the Asset kinds page and the default icon of a kind. A viewer opens
  `/assets/kinds`, reads the list, has no New kind and no row menu, and the API refuses its POST, PATCH and DELETE with 403. The tree
  header's link opens the page (heading, crumb, the tree beside it). New kind "W7m Pump N" guesses the Pump icon from its name until an
  icon is picked, and its row reads "No assets". An asset added with that kind and Automatic draws the kind's icon in the tree row, the
  asset page's header and quick find; editing the kind to Server changes all three without a reload, and renaming it to "W7m Pumps N"
  rewrites the asset's kind text ("1 asset follows"), keeps the icon, and shows the new text on the asset page. An icon of the asset's own
  (Rack) wins over the kind's. The kind's Delete asks where to move the asset (since W7o: Delete stays off until a kind is chosen, and
  Cancel leaves everything as it was) and the API refuses a plain delete of a kind in use (409), and the page survives a reload; once the
  asset is gone the kind deletes and leaves the list. Adding an asset with a new typed kind registers that kind
  with the suggested icon, and the next asset of it needs no choice. No horizontal scroll at 1440 and 1024 px on the page and with the New
  kind dialog and its grid open. Every kind and asset it makes starts with `W7m` and carries the run suffix, and it makes a viewer account;
  it removes them all again.
- `w7n.spec.ts` (its own project, after `w7m`, at 1600×1000) checks the gold M logo and the icons. The served HTML links the ICO, then the SVG,
  then the touch icon, and each of them and `/logo-mark.svg` answers 200 as an image (never the app's HTML) with no `immutable` cache header.
  In all eight looks (light and dark, the four theme colours) the pixel the browser paints in the top bar's mark is the owner's gold (read from
  a screenshot of the image, so a filter, an opacity or a blend would show), and desert gold shows a dark keyline round it. The minimized rail
  keeps the mark and the name, the sign-in page shows the mark at 58 by 56, and the static copy of the shell in `index.html` (only the app's
  script is held) puts the mark where the real bar does. No request for an icon fails and no console message names one; with the logo blocked
  the bar keeps the mark's 29 by 28 box and the name does not move. It creates and changes nothing.
- `w7o.spec.ts` (its own project, after `w7n`, at 1600×1000) checks the kinds pack. On an asset's page Add asset, Edit and Delete are one
  height at 1440 and 1024 px, light and dark, and Delete is an outlined button that reads "Delete" and keeps the name "Delete NAME". The icon
  picker has 48 icons (49 choices with Automatic) in six labelled groups; typing "transfer" leaves the Automatic transfer switch and the
  Static transfer switch (Rack is gone), and choosing the transfer switch saves it and draws it in the tree row and the page header. Typing
  "security" leaves Firewall and Camera, which sit in two groups: Tab from the search lands on Automatic, the arrow keys walk across the
  boundary and back, a cell that was picked is not hidden by a later search, and Escape clears the text, then closes the grid, then the
  dialog. With the grid open the page does not scroll sideways at 1440 and 1024 px, the dialog does not at 1440, 1024 and 800 px, Save stays
  inside the window at 1440×900, 1024×640 and 800×600, and typing in the search moves nothing. A kind that three assets use opens the move dialog (the count, a
  "Move the assets to" choice of the other kinds, Delete off until one is chosen); an asset that joins while it is open turns the answer into
  the new count and keeps the choice; the assets follow (an icon of the asset's own stays), the kind is gone, and the toast and the audit
  entry name the kind they moved to. Add data-centre kinds adds only what is missing, and a second press says they are all there and writes no
  audit entry, and a starter kind that is already there under another spelling or icon is left alone. A custom role with Change assets but
  not Manage asset kinds sees the list and one line saying what is missing (no New kind, no pack button, no row menu), the API answers 403
  to every write and changes nothing, and a new kind typed in Add asset keeps its text and registers nothing, with the note saying so (an
  administrator's typed kind is registered); the Roles editor offers to tick Change assets and See the Assets Tree with Manage asset kinds.
  At 1024 px with the sidebar open, an asset page whose name is only 11 characters long keeps its title and its sub line on one line each
  (the buttons drop under the title when the pane is narrow). Every name it makes starts with `W7o` or `w7o-`; the kinds the pack added are
  removed again by name and the admin's look is put back.

It needs a fresh database (setup must still be pending), so the run starts the stack from scratch in a
separate Compose project (its own `dcdash_e2e_dbdata` volume; stop your normal stack first with
`docker compose --profile dev stop`, never with `-v`, because both use ports 80 and 443):

    docker compose -p dcdash_e2e --profile dev down -v --remove-orphans
    docker compose -p dcdash_e2e --profile dev up -d --build
    (cd frontend && npm run e2e)
    docker compose -p dcdash_e2e --profile dev down -v

or, with a fresh stack already running: `cd frontend && npx playwright test -c e2e/playwright.config.ts`.
First time only: `npx playwright install chromium`. Reports: `npx playwright show-report`.

`scripts/e2e.sh` runs the same steps in one go, always in the project `dcdash_e2e` (so its `down -v`
removes only `dcdash_e2e_dbdata`); only its final `down` has no `-v`. It refuses to start while the
normal stack is running, because both hold ports 80 and 443, and it refuses a project name that does
not start with `dcdash_e2e` (`E2E_COMPOSE_PROJECT` can pick another throwaway name). When it ends it removes the containers but
keeps the volume until the next run, which starts with `down -v`;
`docker compose -p dcdash_e2e --profile dev down -v` removes it right away.

The isolated `-p dcdash_e2e` run builds the same `dcdash-backend:local` and `dcdash-web:local` images
as the normal stack, so it re-tags them. If your database is still at an older schema, read "Upgrading
and going back" before you start the normal stack again: because the image tag was
replaced, any later `docker compose up -d` on the normal project (with or without `--build`) creates or
recreates `api`, which then runs the database migrations. Otherwise rebuild your normal stack afterwards
(`docker compose --profile dev up -d --build`) to be sure it runs your own code. Either way, check with
`docker volume ls` that `dcdash_dbdata` is still listed.

`scripts/check_tls.sh` and `scripts/backup_smoke.sh` are different: each builds images of its own
(`<project>-backend:scratch` and `<project>-web:scratch`, so `dcdash-backend:local` and `dcdash-web:local`
are not re-tagged) and publishes only on `127.0.0.1` (ports 18080 and 18443 by default), so neither takes
ports 80 and 443. They run in a Compose project whose name must start with `dcdash_e2e`, and they delete only
that project's own volume; see "Practise a restore".

### Debugging on the SCADA workstation

The protocol for connecting to the real SCADA and debugging it by copy-paste (the Diagnostics page, the connection check, the report format, the offline `scripts/collect-diagnostics.ps1` / `scripts/collect-diagnostics.sh`, the simulator fault switches `SIM_FAULT_*` for rehearsing a failure) is in [docs/field-debugging.md](docs/field-debugging.md). The offline scripts save their files in the git-ignored `logs/` folder of the project, leave routine lines out of the log tails (`-RawLogs` / `--raw-logs` keeps them), compare the Docker clock with the computer's, and the PowerShell script can hide host names, addresses and the user name with `-Mask`.

### Logs

Every container keeps at most 5 log files of 10 MB (50 MB per service, set in `compose.yaml`). The collector logs
`asyncua`, `pymodbus` and `httpx` at WARNING and above only. Read it with `docker compose logs --since 10m collector`.

### If the api or the collector restarts forever

`docker compose ps` shows `api` or `collector` restarting, and `docker compose logs api` ends in `unknown timezone: <name>`: the name in
`DCDASH_TIMEZONE` is not an IANA zone name (a typo, a different case such as `africa/cairo`, or a Windows name such as `Egypt Standard
Time`). Fix the value in `.env` (for example `DCDASH_TIMEZONE=Africa/Cairo`; a `DCDASH_TIMEZONE` variable set in your shell beats `.env`) and run `docker compose up -d`. `scripts/setup.ps1` and
`scripts/setup.sh` refuse such a name before they start anything, so this happens only when `.env` was edited by hand.

### Stopping

The api and the collector stop on SIGTERM instead of waiting out their grace period: usually within a second, and within
about 11 s each when the database does not answer. `web` is the exception while a browser has a page open: Caddy waits
for the page's live stream until Docker kills it at its stop timeout (10 s on a standard Docker engine). With a page
open, the api waits up to 5 s for it (a live dashboard keeps its stream open) before it closes it. The collector writes
its last readings before it exits. If the database is unreachable at that moment, the readings still in memory
(everything collected since the database stopped answering, at most 100,000) are lost, and the collector logs how many.

### Health

`GET /api/health` is a readiness check that needs no login: it answers `{"status":"ok"}` while the database answers a
query, and 503 `{"status":"unavailable","detail":"database unavailable"}` when it does not answer within 2 s (stopped or
frozen). `docker compose ps` shows `healthy` or `unhealthy` for `api`, `web` and `db`; the `web` check confirms that the
UI is baked into the image and that Caddy is running, in HTTP and in HTTPS mode. The collector serves nothing to probe and
has no Docker health status. Compose never restarts an unhealthy container: an `api` that lost its database shows as
`unhealthy` and keeps running until the database is back. The `api` gets 120 s before failed checks count, so a long
database migration does not make `scripts/setup.sh` fail; a migration that takes longer than about 220 s needs
`docker compose up -d` run again, which is safe.

The collector writes a heartbeat to the database every 10 s. `GET /api/collector/status` (operators and admins) says
whether a beat arrived within the last 30 s, measured by the database's clock. The Sources page shows a notice when the
last beat is older than 30 s and, per source, the age of its newest stored reading in the Last reading column
(BAD-quality readings count; a source with no stored reading shows a dash; the age keeps counting after a point is
unmapped, as long as the source is still listed, because a discovered source leaves the list when its last mapped point
is unmapped). No notice is shown when the status cannot be read, for example while the database is down; once the page
has had no answer for 30 s it says "Collector status cannot be read" instead, and the Last reading ages keep counting
from the last answer. After a restore the old heartbeat reads as "silent" until the collector starts.

### Housekeeping

The collector deletes expired sessions and finished jobs older than 7 days every hour
(`backend/dcdash/collector/housekeeping.py`). "Test all" runs at most 4 connector tests at once.

### If you are blocked from signing in

After too many wrong passwords for one account from one computer, that account is blocked from that computer and the sign-in page
says `too many failed attempts, try again in about N minutes`. Other accounts are not affected. The block ends by itself. To get in
sooner:

1. **Another admin presses Unblock.** On the Users tab of Users & Roles a blocked account shows `blocked` and an `Unblock <name>` button; it clears
   that account's blocks from every computer. Resetting the account's password or deleting it clears them too.
2. **An admin changes the numbers** on the Settings page, section Sign-in protection: how many failed sign-ins block an account
   (3 to 20, default 5) and for how many minutes (1 to 60, default 5). A change applies to the next sign-in attempt, also to a block
   that is running: a shorter block time ends a block that has already lasted that long.
3. **An admin switches the protection off** (same section, the Sign-in protection switch; it asks for a confirmation). Every block
   ends at once and no account is blocked while it is off. Failed sign-ins are still written to the audit log, and the Argon2
   password check still takes its time on every attempt: off removes the block, not that slowdown. Plainly: while it is off a
   password can be guessed without limit, and only that Argon2 time slows each attempt. It never switches itself back on: an
   administrator must switch it on again, and then failures are counted from zero. The numbers are kept while it is off.
   Switching it off or on is audited as `settings.sign_in_changed`; the row for switching it off also says how many blocks it
   ended (`blocks_ended`).
4. **If every admin is blocked,** run `docker compose restart api`. The blocks are held in the api's memory, so a restart clears
   all of them (the stored numbers and the switch are kept).

On this Docker setup every browser may look like one computer: Docker can present all browser connections to the stack as coming
from the one Compose gateway address, so the wrong passwords typed on one machine can block that account for everyone who signs in
the same way. Browsers on other computers of a network, behind a Linux server, are told apart.

## Backup and restore

Both scripts talk to the `db` container of the running stack (`.ps1` twins exist for Windows).

    scripts/backup.sh [out_dir] [--keep N] [--copy-to DIR]   # ./backups/dcdash-YYYYmmdd-HHMMSS.dump + .dump.version (Alembic revision)
    scripts/restore.sh <dump> [--force] [--apply-retention]  # reads the dump, stops api+collector, recreates the database, restores, restarts

A self-test that runs both in a throwaway Compose project of its own, never in your stack, is
`OPS_COMPOSE_PROJECT=dcdash_e2e_drill scripts/backup_smoke.sh` (see "Practise a restore").

Windows PowerShell (run them like this):

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup.ps1 [Out] [-Keep N] [-CopyTo DIR]
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore.ps1 <dump> [--force] [--apply-retention]

`-ExecutionPolicy Bypass` applies to that one process and changes nothing on the machine. It is there because the default
policy, `RemoteSigned`, refuses a script that came over a share or a download. `-File` (not `-Command`) matters for
`backup.ps1`: Task Scheduler gets exit code 5 only when the script is started with `-File`. `-Keep` also accepts the bash spelling
`--keep 3`; `--copy-to DIR` is refused with exit 2 (the PowerShell parameter is `-CopyTo`).

`restore.sh` prints `restoring into Compose project: <name>` as the first line on stderr; `backup.sh` prints
`backing up Compose project: <name>` and `setup.sh` `starting Compose project: <name>` (the `.ps1` twins print the same lines). The scripts
print the name and then go on without asking, so check it BEFORE you run one: `docker compose config --no-interpolate | grep '^name:'`
(Windows: `| Select-String '^name:'`). A script acts on the project that `COMPOSE_PROJECT_NAME`, `-p` or the `name:` of `compose.yaml`
selects, and the one with your data is `dcdash` unless you changed it.

`backup.sh` writes the dump under a temporary name, reads the whole of it back (`pg_restore -f /dev/null`, because a dump cut off in
its data section still passes a table-of-contents check), reads the schema revision, and only then gives the dump its name and
writes the `.version` file next to it (the Alembic revision, for example `0005`; `backup.sh` ends it with a newline, `backup.ps1` does not, and both restore scripts trim it). A failed, empty or cut-off dump
therefore never replaces or evicts a good backup. After every backup it says that `.env` and `certs/` are not in the dump (see "What the
backup does not contain"). With Docker stopped it cannot reach the database: it prints `pg_dump failed; no backup was made and no old
backup was touched` and exits 1 (read from the script; not tried with Docker stopped).

| Exit | `backup.sh` / `backup.ps1` | `restore.sh` / `restore.ps1` |
|---|---|---|
| 0 | the backup was made (and copied, when `--copy-to` was given) | restored |
| 1 | failed: `pg_dump` failed, the dump was empty or cannot be read back, another backup is running in that folder (one at a time per output folder), or a backup with this timestamp exists. Nothing was created, nothing deleted | the dump file does not exist (`no such dump file`) or cannot be read (cut off, damaged): refused up front, "nothing was changed". Or something failed after `api` and `collector` were stopped but before the dump was loaded (the `DROP`/`CREATE DATABASE` step, say): they are started again, the database may be missing or empty, run the restore again with the same dump. Or the restore failed after the database was replaced: read the messages and the log path it prints (it still runs `timescaledb_post_restore()` and starts `api` and `collector`, so the database may be partly restored) |
| 2 | usage error (`--keep` outside 1 to 99999, an unknown argument, a `%` in the output folder on Windows; PowerShell's own parameter errors, such as a missing value or a duplicate parameter, exit 1 instead) | usage error |
| 3 | - | the dump's `.version` differs from the running schema (needs `--force`) |
| 4 | - | restored, but the retention check failed (see "Retention and a restore") |
| 5 | **the local backup was made but NOT copied**; nothing was rotated | - |

Exit 5 and the copy folder are explained under "Scheduled backups".

`restore.sh` refuses (exit 3) when the dump's `.version` differs from the running schema.
`--force` restores anyway; the `api` container then runs `alembic upgrade head` on start, which
brings an older dump up to the current schema. Never force-restore a dump from a *newer* version: the script does not stop you
(it replaces the database, and the `api` then fails on start with an unknown revision); recover by checking out the newer code, or by
restoring the backup you made first.

`restore.sh` reads the whole dump before it stops or drops anything. A dump that is missing, cut off or damaged is refused with exit 1
and the message `nothing was changed`: the database and the containers are untouched. (The first version of the script dropped the
database first, and the Windows drill showed that a cut-off dump then left the running database empty; this check is the fix, and it
was run for real afterwards, with a dump cut to half its size in bash and one cut to 1,500 bytes in PowerShell.) `restore.sh` keeps `pg_restore`'s messages in
`dcdash-restore-<stamp>.log` under `$TMPDIR` (default `/tmp`); every `restore.ps1` run that gets as far as loading the dump leaves the same kind of log in `%TEMP%`, empty
when nothing went wrong.

A restore takes no lock. Do not start two at once, and do not let a scheduled backup fire while one runs (pause the schedule first):
the second restore's `DROP DATABASE` kills the first one's load, and a backup of a half-restored database passes its checks and counts
toward `--keep`.

The dump is a full `pg_dump -Fc` wrapped in `timescaledb_pre_restore()` / `timescaledb_post_restore()`,
so hypertables, the 1-minute and 1-hour rollups and their compression and retention policies are
part of the backup and come back with it; nothing has to be re-created by hand. The `pg_dump`
warning about `continuous_agg` circular foreign keys is expected and harmless for a full dump.

**Retention and a restore.** The dump contains the retention policies, and a restored policy runs the moment the database starts its
background jobs again, so restoring an old dump used to delete everything older than its retention limits within seconds. Raising the
retention before the restore does not help: the restore brings the old limits back. `restore.sh` and `restore.ps1` now stop that.
After `pg_restore` and before `timescaledb_post_restore()` they print, per table, how many chunks the restored policies would delete
(and the oldest and newest day), and if that is more than none they pause the retention jobs and print `Retention is PAUSED`. While
retention is paused nothing is deleted and the disk is not trimmed either: the Storage page shows a banner, and pressing Save there
starts retention again (the save lists what it would delete and asks first). `--apply-retention` skips the pause, so the data beyond
the limits is deleted as the policies say. Read the printed table before you go back to normal use. If the restore worked but the
retention check itself fails, the scripts pause every retention job anyway (unless `--apply-retention` was given) and exit with code 4; if that pause fails as well they say so (`could not check or pause retention`) and still exit 4, and the restored policies may then delete data older than their limits.

### What the backup does not contain

The dump is the database only. `.env` is not in it, and `.env` holds `DCDASH_SECRET_KEY`, the key that encrypts the
passwords and keys stored for your sources. `certs/` (the HTTPS key and certificate, and an OPC UA client certificate if you
use one) is not in it either. Keep a copy of `.env` and `certs/` with every backup, off the machine. The scripts never copy them, not
even with `--copy-to`; `backup.sh` says so after every backup.

The api checks the key when it starts. It test-decrypts the stored source secrets and, once every one of them decrypts, stores a
fingerprint of `DCDASH_SECRET_KEY` in the database (`settings`, key `secret_key_check`; it cannot be turned back into the key). If some cannot be decrypted,
the api log names the sources, and the Sources page shows a banner to operators and admins until the original `.env` is back or the
secrets are typed in again.

- **Restoring on a new machine:** put that `.env` and `certs/` in place, run `scripts/setup.sh`, then `scripts/restore.sh <dump>`
  (the whole sequence, with the checks, is under "Practise a restore").
- **`.env` lost, dump kept:** the data restores, but every enabled source that has mapped points and a stored secret goes
  `offline` with `stored secret cannot be decrypted` until an admin types its secret in again (Discovery, the source's
  Details, Secret).
- **`.env` lost, database volume still there:** `scripts/setup.sh` refuses to create a new `.env`, because a new password
  cannot open the old volume. Put the original `.env` back. Do not "fix" it with `docker compose down -v`: that deletes the database.
- **`.env` lost, old containers still there:** containers keep the values they were created with.
  `docker ps -a --filter label=com.docker.compose.project=dcdash` lists them (use your
  `COMPOSE_PROJECT_NAME` if set). If `dcdash-api-1` is there,
  `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' dcdash-api-1` prints
  `DCDASH_SECRET_KEY`, `DCDASH_TIMEZONE` and `DCDASH_DATABASE_URL`; the database password is the part
  between `dcdash:` and `@db` (`dcdash-web-1` holds `DCDASH_TLS_*`). Write a new `.env` with
  `DCDASH_DB_PASSWORD=`, `DCDASH_SECRET_KEY=` and `DCDASH_TIMEZONE=`, then run `scripts/setup.sh`:
  everything comes back, source secrets included. The output contains secrets, so do not paste it
  anywhere. Do this before any `docker compose down` or `up`, which remove or recreate those containers.
- **`.env` lost, no copy of it anywhere, no old containers either, database volume still there:** the data
  is still in the volume. Start only the database (`docker compose up -d db`) and run
  `scripts/backup.sh`. Then remove the volume on purpose and start over from the dump:
  `docker compose down` (without `-v`), `docker volume rm` of the project's `dbdata` volume
  (`dcdash_dbdata` unless `COMPOSE_PROJECT_NAME` is set), `scripts/setup.sh`,
  `scripts/restore.sh <dump>`, then type each source's secret in again. Without `.env`, Compose warns
  many times that `DCDASH_DB_PASSWORD` and `DCDASH_SECRET_KEY` are not set and default to a blank
  string. That is expected here: the password is only used to create a new database, and the commands
  still work.

### After a restore

Every collector start, including the one at the end of a restore, rewrites the stored scan network (`collector_networks`)
with the /24 around the collector's own addresses, so the targets pre-filled in a new scope follow this installation, not
the restored data. Check them before the first scan.

### Practise a restore

A backup you have never restored is a guess. Practise the restore before you need it, and again after you change anything about how
backups are made. The sequence for a new machine (or a machine whose stack you have lost):

1. Install Docker (Docker Desktop on Windows) and get the code. Check out the commit the dump was made on, or a later one: the
   dump's `.version` file says which schema it has (see "Upgrading and going back" for what a different schema means).
2. Put the copies of `.env` and `certs/` that you kept with the dump in place (see "What the backup does not contain"; the HTTPS key
   needs the owner and mode from "Optional HTTPS").
3. `scripts/setup.sh` (Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1`). It leaves an existing
   `.env` alone, and refuses to create a new one when the database volume already exists. It prints
   `starting Compose project: <name>`; check the name.
4. `scripts/restore.sh <dump>` (Windows: `scripts\restore.ps1`, started the way "Backup and restore" shows). Check the first line,
   `restoring into Compose project: <name>`. A dump from an older schema needs `--force`; a dump from a newer one must not be restored.
   Read the retention table it prints: if it says `Retention is PAUSED`, decide on the Storage page before you press Save (see
   "Retention and a restore").
5. Check: `docker compose ps` shows `db`, `api` and `web` healthy; `docker compose exec api alembic current` prints the head revision;
   `scripts/check_web.sh` prints four `ok` lines; sign in with the account from the old system; on the Sources page no source says
   `stored secret cannot be decrypted` (it does when `.env` is not the original) and the Last reading ages shrink once the collector
   runs; check the scan targets in a new scope before the first scan (see "After a restore").

What the drills did and did not cover. Run for real, in throwaway Compose projects: on Windows `setup.ps1`, `backup.ps1` (with
`-Keep` and `-CopyTo`), `restore.ps1` and a Task Scheduler task; on Linux `backup.sh` (with `--keep` and `--copy-to`: rotation, the
marker file, every exit 5 case, the usage errors, a second backup at the same time, a dump dated in the future, and the database
stopped), `restore.sh` (with and without `--force`, with `--apply-retention`, with a cut-off dump and with a missing one), both
"going back" options of "Upgrading and going back", and the two self-test scripts below. Not run for real: `setup.sh` (its Windows
twin `setup.ps1` was), Docker Desktop stopped under `backup.ps1`, a cron or Task Scheduler trigger firing by itself, a copy drive
pulled out in the middle of a copy, and a restore on a second machine from a dump and an `.env` that were carried over.

**The self-test.** `OPS_COMPOSE_PROJECT=dcdash_e2e_drill scripts/backup_smoke.sh` builds a throwaway stack of its own, backs it up,
deletes an asset, checks that a dump with a wrong `.version` is refused (exit 3), restores, checks that the asset is back, and then
checks that a corrupted dump is refused with nothing changed (exit 1, `api` still running). It removes its project and its volume
when it ends (run for real: it ended with `backup smoke OK` and `restore failure-path OK`, and left no container or volume). `scripts/check_tls.sh` is the same kind
of script for HTTPS (see "Optional HTTPS"). Both:

- need a project name that starts with `dcdash_e2e` (`OPS_COMPOSE_PROJECT` picks it; without it `backup_smoke.sh` uses
  `dcdash_e2e_smoke` and `check_tls.sh` uses `dcdash_e2e_tls`) and refuse any other name, so they cannot be pointed at the project with
  your data (`dcdash`, volume `dcdash_dbdata`);
- build images of their own (`<project>-backend:scratch`, `<project>-web:scratch`) and make up a database password and a secret key
  for the run, so `dcdash-backend:local`, `dcdash-web:local` and your `.env` are not used or changed. They remove their containers,
  network and volume when they end but leave those images behind (the drill left three); remove them with
  `docker image rm <project>-backend:scratch <project>-web:scratch` when you do not need the build cache they hold;
- publish what they publish (`check_tls.sh`: the `web` service) only on `127.0.0.1:18080` and `127.0.0.1:18443`
  (`SCRATCH_HTTP_PORT` and `SCRATCH_HTTPS_PORT` change the numbers, from 1024 to 65535), never on ports 80 and 443.

They are bash scripts: on Windows run them from WSL.

## Scheduled backups

Nothing in the stack takes backups by itself. Run `scripts/backup.sh` (or `backup.ps1`) from the machine's scheduler, with a folder
for the local copies, `--keep N` so that the folder does not fill the disk, and `--copy-to` a folder on another drive or share, so
that a lost disk does not take the backups with it.

**Linux (cron).** This is an example: the cron entry itself was not run (the script it calls, with `--keep` and `--copy-to`, was; see
"Practise a restore" for what was proved how). The cron user must be
allowed to run `docker`. cron keeps no exit code, so send the output to a file and look at it (an exit 5 shows as the line
`local backup made, NOT copied; nothing was rotated (exit 5)`):

    0 2 * * * cd /path/to/DC_Dashboard && scripts/backup.sh /var/backups/dcdash --keep 14 --copy-to /mnt/offsite >> "$HOME/dcdash-backup.log" 2>&1

**Windows (Task Scheduler).** A task with this action and principal was registered and started by hand with `Start-ScheduledTask` for
real: it ended with `LastTaskResult` 0, and, with a copy folder that did not exist, with 5. The trigger line is the standard
PowerShell form and was not run:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\DC_Dashboard\scripts\backup.ps1" -Keep 14 -CopyTo D:\backups'
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive   # runs only while this user is logged on
Register-ScheduledTask -TaskName dcdash_backup -Action $action -Trigger $trigger -Principal $principal
(Get-ScheduledTaskInfo -TaskName dcdash_backup).LastTaskResult   # 0 ok, 1 failed, 5 made but not copied
```

- Docker Desktop must be running in that user's session, and the copy drive must be mounted, when the task fires. With Docker not
  running the script exits 1 and makes no backup (see "Backup and restore").
- With `-LogonType Interactive` the task runs only while that user is logged on. After a reboot without a logon, or with the machine
  asleep at the trigger time, it does not run, and `LastTaskResult` keeps the PREVIOUS result: a `0` there can be stale. Read
  `(Get-ScheduledTaskInfo -TaskName dcdash_backup).LastRunTime` as well (or the date of the newest file in the backup folder), and
  consider `New-ScheduledTaskSettingsSet -StartWhenAvailable` on the `Register-ScheduledTask` call so that a missed run starts as
  soon as the machine is back (not tried).
- `-File` (not `-Command`) is what hands exit code 5 to Task Scheduler. `-ExecutionPolicy Bypass` applies to that process only and
  changes nothing on the machine; without it the default policy, `RemoteSigned`, refuses a script that came over a share or a
  download.
- The task's environment has no `COMPOSE_PROJECT_NAME`, so it acts on the Compose project named in the `compose.yaml` next to the
  script it runs, unless a `.env` next to it sets `COMPOSE_PROJECT_NAME` (Compose reads that variable from `.env` too; the drill's
  `.env` did not set it).
- `backup.ps1` leaves a permanent, empty file `.dcdash-backup.lock` in the output folder (the one-backup-at-a-time lock; `backup.sh`
  locks the folder itself, leaves no file, and only warns when `flock` is not installed). Do not delete it while a backup runs. Folders with spaces, `&` and `()` in their
  names work; a `%` in the output folder is refused with exit 2.

**Read the result.** `0` is a backup. `1` is no backup (and nothing was deleted). **`5` means the local backup was made but NOT copied**
and nothing was rotated, anywhere. A task list that only shows that the task ran looks the same for `0` and `5`, so read
`LastTaskResult` (or the cron log) and treat anything but `0` as a failure to be looked at. Even `0` does not prove that old backups
were rotated: the line `not rotating` in the log says rotation was skipped (see `--keep` below). While the copy drive stays absent the
local folder is never rotated, so it grows without limit, and the database volume may be on the same disk: do not leave an exit 5
unanswered.

**`--keep N`** (1 to 99999; without it nothing is ever deleted):

- After a verified new dump it keeps the newest N dated pairs (`dcdash-YYYYmmdd-HHMMSS.dump` and `.dump.version`) in the output
  folder, and in the `--copy-to` folder when there is one, and deletes the older pairs. The new backup is never deleted.
- It never touches other names: a pair you named yourself (`before-upgrade.dump` and `before-upgrade.dump.version`) stays, and so
  does any dump without its `.version`.
- It refuses to rotate a folder that holds a dump dated later than the new one (the clock went back, or a file was misnamed), with a
  message on stderr: rotating oldest-first would otherwise delete the previous nights' backups while the clock is wrong. The exit
  code stays 0. If the clock once jumped FORWARD, the script itself wrote a future-dated dump, and from then on every run prints
  `not rotating` while the folders keep growing, with the clock right again. A monitor that reads only the exit code does not see it:
  look for the `not rotating` line in the log, and move or delete the future-dated file and its `.version` file so that rotation
  can resume.
- A removal that fails is reported on stderr and the exit code stays 0, because the new backup is fine.
- Nothing is rotated when the backup was not copied (exit 5).

**`--copy-to DIR`** copies the dump and its `.version` to `DIR`, under a temporary name first, compares the copy with the original and
only then renames it.

- `DIR` must exist (the script never creates it) and must not be the output folder.
- `DIR` must hold a file `.dcdash-backup-target` whose first line is the Compose project name (CRLF line ends and a byte order mark are
  fine). Create it once on the drive: `echo dcdash > /mnt/offsite/.dcdash-backup-target` in bash, and
  `Set-Content -Encoding ascii D:\backups\.dcdash-backup-target dcdash` in PowerShell (`dcdash` is the name in `compose.yaml`; the
  refusal message for a missing marker prints the exact command for your project). Why: on Linux a mount point with nothing mounted
  is an empty folder on the root disk, which a plain "folder exists" test would accept and then rotate; and a drive set up for
  another installation would be treated as one set.
- One folder per installation. Two installations on one drive need two folders, each with its own marker, and different Compose
  project names. The same goes for the OUTPUT folder: `--keep` counts every dated pair in it, whichever installation wrote it (the
  file names carry no project name), so two installations that back up into the same folder delete each other's backups. Give each
  its own output folder (the cron example below uses one path; change it per installation).
- If the folder is missing, has no marker, names another installation, or is the output folder itself, the local backup is still made
  and verified, nothing is rotated, and the script exits 5.

**What is decided and what is not** (the owner's decision D13). The off-host target is a folder you point `--copy-to` at, for example
a USB drive or a share. The scripts do no file encryption: encrypt the drive or share itself (BitLocker To Go on a Windows edition
that has it; otherwise a password-protected archive made by hand, for example with 7-Zip). That was decided, not drilled. The scripts
never copy `.env` or `certs/`, so you keep those yourself. `.env` holds the key for the stored source secrets, so whoever holds the
dump and `.env` together can read them: keep a copy of `.env` (and `certs/`) off the machine, in a place as well protected as the
backups, and again whenever they change.

After the first night, look at the folder and at `LastTaskResult` (or the cron log), and do one "Practise a restore" with the dump.

## Upgrading and going back

Starting an `api` container from a newer image runs `alembic upgrade head`, which applies the release's migrations to your data: treat
"start the stack on the new code" as "upgrade the database". Do these steps for every upgrade. **Never use `docker compose down -v`**:
it deletes the database volume.

**The quick way on Windows: `scripts\update.ps1`.** One command does the safe version of steps 1, 4 and 5 below and shows you the
list of step 2. The manual steps below stay as the explanation and as the fallback (there is no shell twin for Linux yet, see the
backlog).

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update.ps1
```

What it does, in this order (each step prints a heading `== N/7 ... ==`):

1. **Checks this computer** and stops with the reason and the fix, before anything is touched, when: Docker does not answer, `.env`
   is missing, a tracked file is changed, you are not on `main`, a merge is half done, less than 5 GB of disk is free, the update would
   overwrite a file you copied in by hand, or another update is running.
2. **Shows where you are**: the commit, the database revision and the build that runs now.
3. **Shows what is coming**: it fetches, lists the new commits (the first 30), lists the new migration files with the sentence "This
   update changes the database", points at the release notes, and asks `Continue? (y/N)`.
4. **Backs up** with `backup.ps1`. If the backup fails, or `-CopyTo` could not copy it, nothing else is touched. It prints the commit,
   the revision and the backup path to write down, and keeps them in `logs\update-anchor.txt`.
5. **Brings the new code** with `git merge --ff-only`: never a merge commit.
6. **Builds and starts** with the commit as the build id (Settings then shows the commit, not `dev`), and waits up to 10 minutes: a
   migration can be long, the site is unavailable meanwhile and readings are not collected.
7. **Checks** that every service runs the image just built, that `alembic current` is the newest revision the code knows, that the
   collector keeps running and the four web checks of step 5 below, then prints a summary: old commit to new commit, old revision to
   new revision, the backup, the version Settings now shows, and the way back (step 6 below, with your commit and revision).

Every line is also written to `logs\update-<time>.log`. The script never runs `docker compose down`, a restore, a downgrade or a
prune, never deletes a volume or a dump, and never changes the code except by `git merge --ff-only`. Run it again after a failure: it
tells you what is wrong. "Already up to date" is printed only when every check passed; when the code is current but the containers
were built by hand (Settings shows `dev`), it rebuilds.

| Flag | Meaning |
|---|---|
| `-Branch main` | the branch to follow |
| `-CopyTo DIR` | passed to `backup.ps1` (see "Scheduled backups") |
| `-NoPull` | do not fetch or merge: back up, build and check the code that is checked out now (a detached HEAD is fine) |
| `-Yes` | do not ask `Continue? (y/N)` |
| `-DryRun` | the checks, the fetch and the lists are real; every other step is only printed; nothing is changed |
| `-Force` | rebuild even when the code and the running site are already current |

A bash-style `--dry-run`, `--no-pull` or `--copy-to` is refused with the usage line, never run for real (`--yes` and `--force` are
accepted as `-Yes` and `-Force`).

| Exit code | Meaning |
|---|---|
| 0 | done, or already current and healthy (also a finished `-DryRun`) |
| 1 | a check refused, you answered no, bad arguments, or another update is running (`backup.ps1` uses 2 for bad arguments; here 2 is the backup) |
| 2 | the backup failed or was not copied |
| 3 | the new code could not be fetched or applied |
| 4 | the build failed, or the stack did not start, become healthy or answer, or runs the wrong version |
| 5 | the database revision does not match the code |

**The first time:** the update that brings this script still uses the three commands, `.\scripts\backup.ps1`, `git pull` and
`docker compose up -d --build` (set the build id first, see "Build id" below, or Settings says `dev`). Do not copy `update.ps1` in by
hand before the pull: git then refuses to overwrite it, and the script refuses to start. From then on use the script.

**If the window shows "Waiting" for more than 10 minutes,** press Ctrl+C: nothing is lost, the backup path is on the screen and in the
log, and `docker compose logs api` says what the api is doing. On a development machine, `scripts/e2e.sh` re-tags the images the stack
uses, so the first update after it reports that the api still runs the old version: run it again with `-Force`.

1. **Back up first, and write down where you are.**
   - `scripts/backup.sh --copy-to <folder>` (Windows: `backup.ps1 -CopyTo <folder>`; the folder is explained under "Scheduled
     backups", and plain `scripts/backup.sh` does when you have none). The `db` container must be running.
     If the stack is not running, start only the database with `docker compose up -d db` (`db` has no dependencies and uses the
     TimescaleDB image, so `api` is not created and nothing is migrated). Do not use a plain `docker compose up -d` yet. Keep both
     files the script writes, the `.dump` and the `.version` file.
   - Note the commit you run now (`git rev-parse --short HEAD`) and the revision (`docker compose exec api alembic current`): going
     back needs both.
   - A scheduled `--keep N` deletes dated dumps after N more nights. If you may need this one longer, copy both files of the pair
     under another name (`before-upgrade.dump` and `before-upgrade.dump.version`); `--keep` never touches other names.
   - Keep a copy of `.env` and `certs/` as well (see "What the backup does not contain").
2. **Read the release notes** below, for every release between the one you run and the new one, oldest first: what each changes, which
   pre-checks it names, how to verify it, and whether its downgrade is lossless.
3. **Do the pre-checks the notes name**, and stop if one says to.
4. **Apply.** Get the new code (`git pull`, or check out the commit you want), then `docker compose up -d --build` (add
   `--profile dev` on a stack that has the simulator; set `BUILDX_NO_DEFAULT_ATTESTATIONS` first, as "Upgrading images"
   below explains). Alembic prints nothing while it migrates, so watch
   `docker compose logs -f api` until Uvicorn's start-up lines appear (`Application startup complete`); a migration that fails prints
   an error instead. If Compose reports `api` unhealthy, or a dependency failed, while a long migration was running, wait for Uvicorn
   to start and run the same `up -d` again (it is safe); `web` and `collector` start once `api` is healthy. Collection pauses while
   the migration runs, so readings for that interval are not collected. If your Docker stops with an image tag that "already exists"
   (the drills did not see this: `up -d --build` and `build` ran clean although the backend services share one image tag), run
   `docker compose build api web` and then `docker compose up -d`.
5. **Verify.** `docker compose exec api alembic current` prints the revision the release notes name (for example `0005 (head)`);
   `scripts/check_web.sh` prints four `ok` lines (index, spa fallback, api proxy, stream route); the Sources page shows no collector
   notice and the Last reading ages stay small once the collector runs; then the extra checks of the release notes.
6. **Going back.** The release notes say which of the two ways is open. Two rules hold for both. First, go back to the commit you noted
   in step 1, the code that matches the revision you noted and the dump, and **not further**: the code must know the revision the database ends
   up at, and older code fails on start with an unknown revision. With a database at `0004` or `0005` the Phase 2 code (schema
   `0003`) is not a place to go back to. Second, a restart of the new
   `api` would run `alembic upgrade head` and apply the migration again, so the new `api` must not be running again once the schema is
   back; the orders below make sure of that. Afterwards `git checkout main` (or the branch you came from) returns to the new code;
   `.env` and `backups/` are not in git, so they stay. This README changes with the checkout, so copy these steps somewhere first.
   - **Option a, keep what was collected since the upgrade.** Only when the release notes say that the downgrade of this release is
     lossless. `<previous>` is the revision you noted in step 1, `<old commit>` the commit.
     1. `docker compose stop collector`.
     2. `docker compose exec api alembic downgrade <previous>`.
     3. `docker compose stop api` at once.
     4. `git checkout <old commit>`.
     5. `docker compose up -d --build` (add `--profile dev` on a stack that has the simulator). The new `api` runs
        `alembic upgrade head` on the old code, where `<previous>` is the head: nothing to do.
     6. `docker compose exec api alembic current` prints `<previous> (head)`.
   - **Option b, restore the dump from step 1.** It works for every release, and everything collected since that dump is lost. Do it
     with the old code and with no new container left to be restarted. Restoring the dump on the new image would not undo the
     upgrade: the last step of `restore.sh` starts the existing `api` and `collector` containers, and they run the migration again.
     1. `docker compose --profile dev rm --stop --force api collector web simulator` removes the new containers (containers only:
        never the `dbdata` volume, and `db` is left alone). Do not add `-v`.
     2. `git checkout <old commit>`.
     3. `docker compose build` builds the images of the old code (see step 4 for a tag that "already exists").
     4. `docker compose up -d db` (a no-op when `db` is already running).
     5. `scripts/restore.sh backups/<dump file> --force`. This is the script of the OLD commit you checked out in step 2, not the
        current one: depending on its age it may not print the project line, may not read the dump first and may not pause retention,
        so expect fewer messages than described under "Backup and restore" (the drill of option b ran the old script of `1ef27a2`).
        `--force` is needed when the volume holds a newer revision than the dump's
        `.version` says: without it the script refuses (exit 3). It is not needed when the migration never ran. The script drops and
        recreates the database from the dump (read the retention table it prints). Its last step, `docker compose start api
        collector`, finds no containers and prints `collector is missing dependency api`, which the script ignores by design.
     6. `docker compose --profile dev up -d` creates fresh containers of the old code; on the restored database Alembic has
        nothing to do. `docker compose exec api alembic current` prints the dump's revision.

Both options were run step by step as written, in a throwaway Compose project, on `1ef27a2` (schema `0004`) upgraded to `a6d11e1`
(schema `0005`). Option a was lossless: the asset made and the readings collected after the upgrade were still there, and
`alembic current` printed `0004 (head)`. Option b refused without `--force` (exit 3), restored with it (exit 0,
and the ignored message appeared as described), and lost what came after the dump.

**Upgrading images.** The images the project builds on (`python`, `uv`, `node`, `caddy` and the TimescaleDB image of `db`) are pinned by
digest in `backend/Dockerfile`, `frontend/Dockerfile` and `compose.yaml`. A rebuild therefore no longer changes the base layers by
surprise, and a security fix in a base image only arrives when you re-pin. Run `scripts/pin_images.sh --update` before a release, or
monthly: it asks the registry for the digest of each tag and prints a before and after table (`--check` needs no network and fails
on an unpinned or malformed reference). Then rebuild, run the tests and commit the changed files. `backend/tests/conftest.py` pins
`timescale/timescaledb:2.30.2-pg16` for the test database separately, and is re-pinned by hand with the others.

The first `docker compose up -d` after the digests arrived recreates `db` as well as the other services, once: the `image:` line of
`db` gained the digest, which changes its configuration although the image is the same. The database is unavailable for a short
while, and `api` and `collector` restart too. The data volume is kept. Take a backup first, as for any upgrade (step 1 above, and
"Backup and restore").

`scripts/setup.sh` and `setup.ps1` set `BUILDX_NO_DEFAULT_ATTESTATIONS=1` before they build, so running them again when nothing changed
keeps the running containers. A hand-typed `docker compose up -d --build` should set it first (bash: `export BUILDX_NO_DEFAULT_ATTESTATIONS=1`;
PowerShell: `$env:BUILDX_NO_DEFAULT_ATTESTATIONS = '1'`). Without it every build gives `api` and `web` a new image id, because the default
attestation record is part of the id, and `up -d` recreates `api`, `collector`, `web` and `simulator` (about 12 s without service) even
though nothing changed; `db` is kept after that first time (the one described above). The first run after adopting the variable recreates them once.

**Build id.** The backend images carry the commit they were built from, so a diagnostics report (and Settings, and `GET /api/version`)
proves which code produced it. `scripts/setup.sh`, `setup.ps1` and `e2e.sh` pass it on by themselves. For a hand-typed
`docker compose build` or `up -d --build`, set the two variables first (bash:
`export DCDASH_BUILD_ID=$(git describe --always --dirty) DCDASH_BUILD_TIME=$(git log -1 --format=%cI)`; PowerShell:
`$env:DCDASH_BUILD_ID = git describe --always --dirty; $env:DCDASH_BUILD_TIME = git log -1 --format=%cI`); without them the images say
`dev` / `unknown`. The id is the commit, with `-dirty` while tracked files differ from it, and the time is the commit's, never the
clock of the build, so building the same tree again changes nothing. A new id (a new commit, or `-dirty` appearing) rebuilds the
last image layer and recreates `api`, `collector` and `simulator` once. The `web` image carries no build id.

## Release notes

One entry for each release that changes the database: the revision it leads to, what it changes, the pre-checks to run before it,
how to verify it, and whether its downgrade is lossless (which decides whether option a of "Upgrading and going back" is open). Read
the entries of every release you skip over, oldest first. Add the entry of the next release at the end.

### Upgrading an existing database to Phase 3

Schema `0003` to `0004`. Downgrade: **not lossless** (step 6), so go back with option b. (The error messages of migration 0004 call this
entry "Upgrading an existing database to Phase 3" and name its steps 4 and 6; the numbering is kept for that reason.)

Phase 3 adds migration `0004` (tariffs, dashboards, widgets, the billing setting and a rebuilt hourly
rollup `readings_1h`). The `api` container runs `alembic upgrade head` every time it starts, so the
first start of an `api` container created from the Phase 3 image applies it to your data: treat
"start the stack on the new code" as "upgrade the database". The upgrade is safe on a normal install
and can be run again after an interruption, but it rebuilds `readings_1h` from `readings_1m`, which is
why the steps below start with a backup. Collection pauses while the migration runs, so readings for that
interval are not collected.

1. **Back up first**, as in step 1 of "Upgrading and going back" (start only the database when the stack is not running, and note the
   commit you run now). Keep both files the script writes, the `.dump` and the `.version` file (it says `0003`). Restoring with
   `scripts/restore.sh` is the only way back to the database as it was before the upgrade (see step 6).
2. **Pre-check.** In `docker compose exec db psql -U dcdash -d dcdash` run:

   ```sql
   SELECT (SELECT min(bucket) FROM readings_1h) AS h,
          (SELECT time_bucket(INTERVAL '1 hour', min(bucket)) FROM readings_1m) AS m;
   ```

   If `h` is earlier than `m` (or `m` is empty while `h` is not), migration 0004 refuses to run (see
   step 4) rather than lose those hours (the 1-minute tier is kept for `rollup_1m_retention_days`, 730
   by default, while the hourly tier is kept forever). Stop and decide before going on. Also run
   `SELECT value FROM settings WHERE key = 'storage';`: a `raw_retention_days` below 8 is raised to 8
   by the migration, and the retention policy is applied again. **Always run the next query as well,
   whatever `raw_retention_days` says** (it is cheap). The hazard depends on the history, not on today's
   setting: an install that raised its retention within the last 8 days shows 8 or more and can still
   hold minutes whose raw data was already dropped.

   ```sql
   SELECT min(bucket) AS oldest, max(bucket) AS newest, (SELECT min(ts) FROM readings) AS oldest_raw
   FROM readings_1m
   WHERE bucket >= now() - INTERVAL '8 days'
     AND bucket < coalesce((SELECT time_bucket(INTERVAL '1 minute', min(ts)) FROM readings), 'infinity');
   ```

   If it returns rows (`oldest` is not empty), **stop**: the raw retention has already dropped raw data
   that the rollups still hold from the last 8 days. Phase 3 refreshes the rollups over their last 7
   days, which would delete those minutes and then the hours built from them (`readings_1h` is the only
   copy of those). Migration 0004 refuses to run in that state (see step 4). Raise the raw retention
   first (step 4 has the SQL), wait until `newest` + 8 days + 1 minute (the migration's message prints
   that time as well), run the query again (it must return an empty `oldest`), and only then go on with
   step 3.
3. **Apply.** Only when you mean to upgrade: `docker compose --profile dev up -d --build` (without
   `--profile dev` on a stack that has no simulator). Alembic prints nothing while it migrates, so watch
   `docker compose logs -f api` until Uvicorn's start-up lines appear (`Application startup complete`);
   a migration that fails prints an error instead. Then `docker compose exec api alembic current` must
   print the head revision (`0005 (head)` since W1a). If Compose reports the `api` unhealthy or a
   dependency failed while the rollup was rebuilding, wait for Uvicorn to start and run the same
   `up -d` again; `web` and `collector` start once `api` is healthy.
4. **If something goes wrong.**
   - `tuple concurrently deleted` in the log: a refresh job raced the drop of the view. The container
     restarts and the migration runs again by itself.
   - The log shows `migration 0004 was stopped before it changed anything, because rebuilding the
     hourly rollup (readings_1h) from the 1-minute rollup (readings_1m) would permanently lose hourly
     history`: this is the case from step 2 (`h` earlier than `m`, or `m` empty while `h` is not). Nothing
     was changed, but Compose restarts the `api` in a loop and it stops at the same place every time.
     Run `docker compose stop api`, take a backup (step 1) and report the message.
   - The log shows `migration 0004 was stopped before it changed anything, because it widens the refresh
     window of the rollups to 7 days`: this is the second query of step 2 returning a row. Nothing was
     changed (the database is still at `0003`), but Compose restarts the `api` in a loop and it stops at
     the same place every time. Run `docker compose stop api`, then raise the raw retention to at least 8
     days (or to `compress_after_days` + 1 when that is larger) so that no more raw data is dropped:

     ```sql
     UPDATE settings SET value = jsonb_set(value, '{raw_retention_days}', '8') WHERE key = 'storage';
     SELECT remove_retention_policy('readings', if_exists => true);
     SELECT add_retention_policy('readings', INTERVAL '8 days');
     ```

     (`docker compose exec db psql -U dcdash -d dcdash`; the Storage page of the Phase 2 app does the same
     when that app is running.) The rollup rows that lost their raw data stay as they are until the date and
     time that the message prints, when the newest of the affected minutes is more than 8 days old. Until
     then there is no collection and no UI on the Phase 3 images. The database is still at `0003`, so you
     can run Phase 2 meanwhile (the commit you noted in step 1, or the commit on `main` just before Phase 3 was merged): do option b of
     "Upgrading and going back" without its step 5, the restore (nothing was migrated, so there is nothing to restore), raise the retention on Phase 2's Storage page instead of with the SQL
     above, and check out the Phase 3 code again when the date has passed. Then start again
     at step 1 and take a fresh backup: the one from before the wait lacks everything collected since
     (Phase 2 may have run for days), and a restore of it would lose that data. Go on with steps 2 and 3
     after it.
   - Any other error that repeats: `docker compose stop api` and report the error.
   - Never use `docker compose down -v`: it deletes the database volume.
5. **Verify.**
   - `SELECT version_num FROM alembic_version;` returns the head revision of the code you run (`0004` on the Phase 3 release,
     `0005` since W1a).
   - `\d readings_1h` lists a `minutes` column.
   - `SELECT view_name FROM timescaledb_information.continuous_aggregates;` lists `readings_1m` and
     `readings_1h`.
   - `SELECT key, value FROM settings WHERE key IN ('billing', 'storage');` shows the currency (null
     until you set it) and the storage settings.
   - In the UI, set the currency and the rates on Tariffs. Check that Settings has a timezone with
     whole-hour UTC offsets, or Billing answers 409.
6. **Going back.** The `0004` downgrade is not lossless, so option a of "Upgrading and going back" is not open for this release. Do not
   run `alembic downgrade`: it rebuilds the hourly rollup from the minutes again and
   refuses (leaving the database as it is) when that would lose hourly history older than the 1-minute
   tier. Restoring the step 1 dump on the Phase 3 image does not undo the upgrade: its
   `.version` says `0003` while the running schema is `0004`, so `scripts/restore.sh` refuses without
   `--force`, and with `--force` the script restarts the existing `api` and `collector` containers,
   which run migration 0004 again. To really return to Phase 2, use option b of "Upgrading and going back": restore the step 1
   dump with the Phase 2 code and images and with no Phase 3 container left to be restarted. The Phase 2 code is the commit you noted
   in step 1; if you upgraded before this README asked for the note, it is the commit on `main` just before Phase 3 was merged.
   `--force` is needed when the database was already migrated to `0004`; it is not when the migration never ran. The script's last
   step, `docker compose start api collector`, finds no containers and prints `collector is missing dependency api`, which the script
   ignores by design. Afterwards check out the branch you came from to return to the Phase 3 code; `.env` and `backups/` are not in
   git, so they stay.

### Upgrading to W1a (migration 0005)

Schema `0004` to `0005`. Downgrade: **lossless** for every audit entry whose user still exists, so option a is open. The code to go
back to is `1ef27a2` (`main` before W1a).

W1a (the audit foundation) adds migration `0005`: two columns (`actor_id`, `actor_name`) on `audit_log`, a
backfill that copies the name of each existing entry's user into them, and a trigger that fills them on every
new entry, so an entry keeps who did it after the account is gone. It runs in a moment and needs no pre-check.
The `api` container applies it the first time it starts from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0004`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator).
3. **Verify.** `docker compose exec api alembic current` prints `0005 (head)`.
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0004` and `<old commit>` = `1ef27a2`. Do
   not use step 6 of the Phase 3 entry above for this: it returns to Phase 2 (schema `0003`), which is not a place to go back to from
   a `0004` or `0005` database (Alembic fails with an unknown revision). In both options a restart of the W1a `api` would run
   `alembic upgrade head` and apply `0005` again, so the W1a `api` must not be running again once the schema is back at `0004`.
   - **Option a, keep what was collected since the upgrade.** The `0005` downgrade drops the trigger, its function and the two snapshot
     columns, and `upgrade` rebuilds them from the users. That loses nothing for an entry whose user still exists; the names of
     users deleted after `0005` was applied are lost.
   - **Option b, restore the backup from step 1.** Everything collected since that backup is lost. The restore script is the one of
     the old commit (see step 5 of option b in "Upgrading and going back"). `--force` is needed: the volume
     still holds the W1a database (`0005`) and the dump's `.version` says `0004`, so the script refuses without it.

### Upgrading to W8 (migration 0006)

Schema `0005` to `0006`. Downgrade: **lossless** for every other table (the dropped table only holds diagnostics), so option a is open.
The code to go back to is `b933bc7` (`main` before W8).

W8 (field diagnostics) adds migration `0006`: one new table, `diag_events`, the persistent event journal behind the Diagnostics report
(connection transitions, job results, check results, API errors), with two indexes. It runs in a moment and needs no pre-check. The
collector's hourly housekeeping keeps at most 14 days and 20 000 rows of it. The `api` container applies the migration the first time it
starts from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0005`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you.
3. **Verify.** `docker compose exec api alembic current` prints `0006 (head)`; the Settings page shows "Version <id>".
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0005` and `<old commit>` = `b933bc7`. The `0006`
   downgrade drops `diag_events`; nothing else changes, and `upgrade` creates it empty again. A restart of the W8 `api` would run
   `alembic upgrade head` and apply `0006` again, so the W8 `api` must not be running once the schema is back at `0005`.

### Upgrading to W7d (migration 0007)

Schema `0006` to `0007`. Downgrade: **lossless** for everything else (it only loses the display choices described below), so option a
is open. The code to go back to is `ee1e985` (`main` before W7d).

W7d (appearance) adds migration `0007`: one new column, `users.preferences`, a JSON object that holds each account's Mode (Light,
Dark or Match my device) and Theme colour (Navy and gold, Maroon and gold, Graphite or Desert gold). It runs in a moment and needs no
pre-check. Every existing account starts on Light and Navy and gold; each person changes it in the profile panel (the name block in the
top bar, section Mode and Theme colour) and it follows them to any browser. The default look changes slightly for everyone: the navy
panels now carry gold markers (the selected item's marker, the focus ring and the logo mark, all light blue before) and a gold avatar. The first page load after changing
the look on another computer, or after another person used this browser, shows the previous look for a moment, until the page has asked
the server. The `api` container applies the migration the first time it starts from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0006`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you.
3. **Verify.** `docker compose exec api alembic current` prints `0007 (head)`; the profile panel shows the Mode and Theme colour choices.
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0006` and `<old commit>` = `ee1e985`. The `0007`
   downgrade drops `users.preferences`; nothing else changes, so only the display choices are lost, and `upgrade` adds the column
   again with every account on the defaults. A restart of the W7d `api` would run `alembic upgrade head` and apply `0007` again, so the
   W7d `api` must not be running once the schema is back at `0006`.

### Upgrading to W7e (no migration)

Schema stays at `0007`; nothing in the database or the API changes, so there is nothing to undo there. The code to go back to is
`499fdc5` (`main` before W7e).

W7e (theme polish) is front end only:

- **Buttons, links, hover and selection take the theme colour.** The Add asset button, the links, the breadcrumb links, the selected
  tree row, the pressed toggles and the focus ring follow the Theme colour in the profile panel, in Light and in Dark. They used to be
  the same blue in every theme. **The default look changes:** Navy and gold's buttons were a vivid blue (`#1d5bd8`) and are now a
  navy blue (`#2a4590`) in Light mode and a soft blue in Dark mode; Graphite keeps its blue. The dashboard widgets keep their light
  blue in every theme.
- **The profile panel has two dropdowns,** Mode and Theme colour, instead of seven round buttons.
- **A thin bar runs along the top edge while a page loads or you change pages,** in the theme's marker colour (gold on Navy and gold
  and on Maroon and gold, light blue on Graphite, dark brown on Desert gold). Pages that refresh themselves in the background
  (the status chip, the summary) do not show it. With "reduce motion" switched on in the system it is a full line that appears and
  disappears instead of sweeping. The sign-in and setup pages do not have it.
- **The Assets tree, the asset's title, the "By kind" list and quick find carry an icon** that follows the asset's kind (Site,
  Building, Room, Row, Rack, Panel, Meter, Circuit, UPS, PDU, generator, transformer, chiller, and a plain cube for any other kind).
  The four tiles (Assets, Live power, Energy today, Cost today) have an icon of their own beside their caption.

1. **Back up first** (a habit here: nothing in the database changes), as in step 1 of "Upgrading and going back".
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` still prints `0007 (head)`; the profile panel shows the Mode and Theme
   colour dropdowns, and choosing Maroon and gold turns the Add asset button maroon in Light mode.
4. **Going back.** Check out `499fdc5` and rebuild as in step 2. There is no database step: the stored Mode and Theme colour choices
   are the same in both versions.

### Upgrading to W7f (no migration)

Schema stays at `0007`; nothing in the database or the API changes, so there is nothing to restore. The code to go back to is
`10feba7` (`main` before W7f).

W7f (loading skeletons) is front end only, so only the `web` image changes: while a page waits for its first data it shows quiet grey
shapes in the layout the data will have (the Assets tree, the summary tiles, the asset page and its chart, the tables of Dashboards,
Billing, Sources, Scans, Users & Roles, Tariffs, Storage and Audit, the forms of Settings and Storage, the dashboard and the Discovery graph)
instead of a bare "loading..." line. The shapes appear only if the wait lasts longer than about a sixth of a second, so a quick page
shows none, and only on the first load of a page: the pages that refresh themselves in the background never bring them back, and a
failed load shows its error as before. Screen readers hear one "Loading ..." line per area. With "reduce motion" switched on in the
system the shapes do not shimmer. Sign-in, setup, Password and Diagnostics are unchanged, and the dashboard widgets keep their own
"loading..." line until their own redesign.

1. **Back up first** (a habit here: nothing in the database changes), as in step 1 of "Upgrading and going back".
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). Only `web` is rebuilt. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` still prints `0007 (head)`. In the browser's developer tools set the network
   to "Slow 4G", open the Users & Roles page and watch grey bars take the place of the table until the list arrives.
4. **Going back.** Check out `10feba7` and rebuild as in step 2. There is no database step.

### Upgrading to W7g (migration 0008)

Schema `0007` to `0008`. Downgrade: **lossless** for everything else (it only loses the icon choices described below), so option a
is open. The code to go back to is `15be434` (`main` before W7g).

W7g (asset icons) adds migration `0008`: one new column, `assets.icon`, a nullable text that holds the icon an admin chose for an
asset. It runs in a moment and needs no pre-check. Every existing asset starts on "Automatic", which changes nothing: the icon still
follows the asset's kind. In the Add asset and Edit asset dialogs the new Icon field shows the icon in a small tile and, under Change
icon, a grid of 28 icons to choose from; the choice shows in the Assets Tree, the asset page's title and quick find, and the audit log
records the change. The Assets page is now called "Assets Tree" (the sidebar entry, the first breadcrumb, the tree heading and the
summary's title). The `api` container applies the migration the first time it starts from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0007`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` prints `0008 (head)`; the Add asset dialog shows an Icon field.
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0007` and `<old commit>` = `15be434`. The `0008`
   downgrade drops `assets.icon`; nothing else changes, so only the icon choices are lost, and `upgrade` adds the column again with
   every asset on Automatic. A restart of the W7g `api` would run `alembic upgrade head` and apply `0008` again, so the W7g `api`
   must not be running once the schema is back at `0007`.

### Upgrading to W7h (no migration)

Schema stays at `0008`; nothing in the database or the API changes, so there is nothing to restore. The code to go back to is
`45deb14` (`main` before W7h).

W7h (a real first-load screen) is front end only, so only the `web` image changes. A refresh used to show a blank white page and then a
bare "loading..." line until the sign-in check had answered. Now the navy top bar and the sidebar are painted as soon as the page's
stylesheet has arrived (a static copy of the shell inside `index.html`, in the look this browser remembers and with the sidebar open or
minimized as you left it); while the two sign-in requests are out, the same frame shows quiet placeholders and the loading bar runs along
the top edge; then the real shell replaces it without anything moving. The sign-in and setup pages do not show the frame. Screen readers
hear one "Loading" line. A first-ever visit in a browser shows Light and Navy and gold. The frame's content area stays empty until the
page itself starts loading (its own grey shapes appear after the usual sixth of a second). If the app script never arrives (a blocked or stale file), the frame says "Still loading. If this stays, reload the page." after 15 seconds.

1. **Back up first** (a habit here: nothing in the database changes), as in step 1 of "Upgrading and going back".
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). Only `web` is rebuilt. `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` still prints `0008 (head)`. In the browser's developer tools set the network
   to "Slow 4G", reload any page and watch the navy bar and the sidebar appear before anything else; on `/login` no frame shows.
4. **Going back.** Check out `45deb14` and rebuild as in step 2. There is no database step.

### Upgrading to W7i (no migration)

Schema stays at `0008`; nothing in the database or the API changes, so there is nothing to restore. The code to go back to is
`65d9fab` (`main` before W7i).

W7i (an acceptance sweep and polish) changes the `web` image, the front end and two diagnostic scripts. What you will notice:
the first load is about four times smaller (the web server now compresses its files, and Discovery's graph library is only fetched
when that page opens); files with a hash in their name are cached for a year, while `index.html` and `theme-init.js` are checked
with the server on every visit, so an update shows at once instead of after a hard reload; with the server down the app says
"Can't reach the server" (with a Retry button) instead of showing the sign-in page, and a page left open recovers by itself; a tab
left open across an update reloads once when it needs a file the update removed, then shows a plain "could not be loaded" panel if
that does not help; the browser tab names the page; a very long asset kind wraps; and `scripts\collect-diagnostics.ps1` (and the
shell twin) now name the program that owns each listening port and note the first-start noise of the database image.

1. **Back up first** (a habit here: nothing in the database changes), as in step 1 of "Upgrading and going back".
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). Only `web` is rebuilt. `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you.
3. **Verify.** `docker compose exec api alembic current` still prints `0008 (head)`; `scripts/check_web.sh http://localhost` prints
   nine `ok` lines. If a browser shows a white page or a broken layout right after the update, press Ctrl+F5 once: before this
   update the web server sent no caching rule for the page, so a browser may reuse the old copy of `index.html` one more time.
4. **Going back.** Check out `65d9fab` and rebuild as in step 2. There is no database step.

### Upgrading to W7j (no migration)

Schema stays `0008`; nothing in the database or the API changes, so there is nothing to restore. The code to go back to is
`eba2d92` (`main` before W7j).

W7j (the pages use their space) changes the `web` image and the front end only. What you will notice: the Audit log has one compact
toolbar (search, user, action, a From to To pair, quick-filter chips, Go to date and Export CSV), rows with an event icon, a user disc,
a "how long ago" line and a Details arrow at the end; Storage has icons on its five tiles, Rows per day (with a small bar per day) and
Retention and capacity side by side; Tariffs puts the site default rate and the asset overrides in two columns under a Currency card and
says once that no currency is set; Settings has two equal cards and an About card whose version line says "Version dev, built ..." when a
stack was built without a build id; Diagnostics uses the whole page width; and Automatic icons now pick a battery, a cooling unit, a fan,
a pump and a sensor for kinds that say so. The pages go to one column below 1280 px.

1. **Back up first** (a habit here: nothing in the database changes), as in step 1 of "Upgrading and going back".
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). Only `web` is rebuilt. `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you.
3. **Verify.** `docker compose exec api alembic current` still prints `0008 (head)`; `scripts/check_web.sh http://localhost` prints
   nine `ok` lines; the Audit log, Storage, Tariffs, Settings and Diagnostics pages open. A stale page after the update reloads once by itself.
4. **Going back.** Check out `eba2d92` and rebuild as in step 2. There is no database step.

### Upgrading to W9a (migration 0009)

Schema `0008` to `0009`. Downgrade: **lossless** for every account that holds Viewer, Operator or Admin (it only loses the custom roles
described below, and an account that held one comes back as a Viewer), so option a is open. The code to go back to is `774cb6e`
(`main` before W9a).

W9a (roles and permissions, part 1) adds migration `0009`: a new table, `roles`, and a new column `users.role_id` that replaces
`users.role`. The table is seeded with the three built-in roles (ids 1, 2 and 3: `viewer`, `operator`, `admin`); every account keeps its
id, name, password, sessions, preferences and audit trail and is given the built-in role of the name it had (a value that could not
exist, which the old check did not allow, would become Viewer: least privilege). It runs in a moment and needs no pre-check. What you
will notice: **nothing changes for Viewer, Operator and Admin** except the screen a person sees when they open a page their role lacks, which
now reads "No access" and "Your role does not include this page." (it said "Admins only" or "Operators only"). Behind it every API route needs a named permission (see "Roles and permissions"), `/api/me`,
sign-in and setup answer with the account's `permissions` next to its `role` (still the role's name, so a script that reads `role` keeps
working), and `/api/permissions` and `/api/roles` are new. Custom roles were made through the API until
the Roles tab arrived in W9b. The `api` container applies the migration the first time it starts from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0008`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` prints `0009 (head)`; sign in as an administrator, an operator and a viewer
   (if you have one of each) and see that each gets the pages it had before.
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0008` and `<old commit>` = `774cb6e`. The `0009`
   downgrade puts `users.role` back (as the last column of `users`, filled by role id: 1 `viewer`, 2 `operator`, 3 `admin`, any other
   role `viewer`), then drops `users.role_id` and `roles`. The custom roles are lost, and the accounts that held one come back as Viewers:
   **write down which accounts hold a custom role before you go back**. `upgrade` seeds the three built-in roles again and gives every
   account the role of its name. A restart of the W9a `api` would run `alembic upgrade head` and apply `0009` again, so the W9a `api`
   must not be running once the schema is back at `0008`.

### Upgrading to W9b (no migration)

Schema stays `0009`; no data is rewritten, so there is nothing to restore. The code to go back to is `2276b28` (`main` before W9b).

W9b (the Roles tab) rebuilds the `api` and `web` images. What you will notice: the Users page is now **Users & Roles**, with a **Users**
tab (as before) and a **Roles** tab where an administrator makes, duplicates, edits and deletes roles (see "Roles and permissions").
The catalogue grows to 29 permissions: `settings.security` now guards the sign-in protection switch and `settings.edit` covers the
general settings only. The built-in Operator now sees Tariffs, read-only; nothing else changes for the built-in roles. A custom role made
before W9b that holds `settings.edit` lacks `settings.security` until someone ticks it. On the development stack this was checked before
the upgrade (2026-10-13): it has only the three built-in roles and no custom role, so no account loses a right there.

1. **Back up first**, as in step 1 of "Upgrading and going back".
2. **List your custom roles.** `docker compose exec db psql -U dcdash -d dcdash -c "SELECT name, permissions FROM roles WHERE NOT builtin"`
   (read-only). For each one that lists `settings.edit` and should keep switching the sign-in protection, tick **Change sign-in
   protection** on the Roles tab after the upgrade.
3. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has the
   simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
4. **Verify.** `docker compose exec api alembic current` still prints `0009 (head)`; sign in as an administrator, open Users & Roles >
   Roles and see the three built-in roles with their account counts.
5. **Going back.** Check out `2276b28` and rebuild as in step 3. There is no database step; the roles you made keep working (the W9a
   code ignores the extra permission). To edit a role that already holds `settings.security` under the W9a code, untick **Change sign-in
   protection** first, or send the permission list without it: the W9a code refuses the id it does not know on `PATCH /api/roles/{id}`.

### Upgrading to W7k (no migration)

Schema stays `0009`; no data is rewritten, so there is nothing to restore. The code to go back to is `53fff56` (`main` before W7k).

W7k (feedback) rebuilds the `api` and `web` images. What you will notice: the four Save buttons that save in place (Settings' time zone
and sign-in protection, Tariffs' currency, Storage's retention) turn green and read "Saved" for a moment instead of printing "saved" beside
them; every delete asks in the page's own dialog (the browser's own box is gone), and deleting an asset or a source first asks the server
what it takes with it ("Checking what this deletes…") and cannot be confirmed before the answer is in; and a small message in the lower
right corner, which goes away by itself, confirms what has no button of its own to turn green (a create or delete, the default
dashboard, a saved dashboard, a password change, a CSV or report download).

The API gains two read-only routes and an optional check; a client that uses neither behaves exactly as before:

- `GET /api/assets/{id}/impact` (needs `assets.delete`) answers `{"assets", "mappings", "tariffs"}`: what deleting the asset, everything
  under it, their mappings and their rates would remove. `GET /api/sources/{id}/impact` (needs `sources.edit`) answers
  `{"points", "mappings"}` (mapped points and their mappings). Both answer 404 for an unknown id, change nothing and write no audit entry.
- `DELETE /api/assets/{id}` accepts `expect_assets`, `expect_mappings` and `expect_tariffs`, and `DELETE /api/sources/{id}` accepts
  `expect_points` and `expect_mappings` (whole numbers, 0 or more): the counts the caller was shown. Each one given is compared on its
  own, and a real count **greater** than the expected one makes the server answer 409, with the new counts, even with `confirm=true`, and
  delete nothing; a smaller or equal count deletes as asked. The page always sends the counts its dialog showed, so a child or a rate
  added while the dialog was open is never deleted unseen: the dialog shows the new numbers and asks again.

1. **Back up first**, as in step 1 of "Upgrading and going back".
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has the
   simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` still prints `0009 (head)`; open an asset's page and press its bin: one dialog
   opens, says what the delete takes with it, and Cancel changes nothing.
4. **Going back.** Check out `53fff56` and rebuild as in step 2. There is no database step.

### Upgrading to W7l (no migration)

Schema stays `0009`; no data is rewritten, so there is nothing to restore. The code to go back to is `e624a5a` (`main` before W7l).

W7l rebuilds the `api` and `web` images. What you will notice: an audit entry opens in a drawer on the right instead of a page of its own
(the old `/audit/ID` page is gone; the address still works and now opens the log with the drawer over it), with Previous, Next and a Copy
button for its number; the audit sentences name assets, users, sources, dashboards and points instead of numbering them, and a target that
no longer exists reads "a deleted asset"; and two cards no longer change height when a message appears (the Create user card under a role
without a description, and the two Tariffs add forms).

The one API change is additive: each item of `GET /api/audit` and the entry from `GET /api/audit/{id}` gains `refs`, always present and `{}`
when empty: `{"asset": {"5": "MV2-R1-LV-Panel-02"}}`, the current names (from `assets.name`, `users.username`, `sources.name`,
`dashboards.name`, `points.name`) of the ids the entry's details point at, for the kinds `asset`, `user`, `source`, `dashboard` and `point`. An
id that no longer exists is left out. Nothing else about the answer changes: the stored details, `GET /api/audit.csv` and the permissions
(`audit.view`, `audit.export`) are as before, and a client that ignores `refs` behaves exactly as it did.

1. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has the
   simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
2. **Verify.** `docker compose exec api alembic current` still prints `0009 (head)`; open the Audit log, press a row's chevron and see the
   drawer open on the right; Esc brings the log back where it was.
3. **Going back.** Check out `e624a5a` and rebuild as in step 1. There is no database step.

### Upgrading to W7m (migration 0010)

Schema `0009` to `0010`. Downgrade: **lossless** for everything else (it only loses the registry of asset kinds described below, and the
icons go back to the keyword guess), so option a is open. The code to go back to is `af8f9f8` (`main` before W7m).

W7m (asset kinds) adds migration `0010`: one new table, `asset_kinds`, with a name and an icon for each kind of asset (the same 28 icons an
asset can be given). It runs in a moment and needs no pre-check. The table is filled from the kinds your assets already use, one row for
every kind (`LV_Panel` and `lv_panel` are one kind), each with the icon the keyword guess gave it, so **no asset changes its icon**: an
asset shows its own icon if it has one, else its kind's icon, and the kind's icon is what the guess said before. A kind the guess reads
differently in two spellings, a blank kind, a kind longer than 200 characters and a kind with a character this server does not know are not
registered and keep the guess. The starter kinds
(Site, Building, Room, Row, Rack, Panel, Meter, Circuit, Other equipment and generic) are added for every name no asset uses. `assets` and
every other table are untouched. What you will notice: the Assets Tree has an Asset kinds button, the Kind list in the Add and Edit asset
dialogs comes from that page, and a new kind typed under "Other…" is added to it. The API gains `GET` and `POST /api/asset-kinds` and `PATCH`
and `DELETE /api/asset-kinds/{id}` (needing `assets.view` to read and `assets.edit` to write; since W7o the write needs `assets.kinds`), and each asset gains `kind_icon`. The `api`
container applies the migration the first time it starts from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0009`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` prints `0010 (head)`; the Assets Tree shows the same icons as before, and its
   Asset kinds button opens a page that lists the kinds your assets use and the starter kinds.
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0009` and `<old commit>` = `af8f9f8`. The `0010`
   downgrade drops `asset_kinds`; nothing else changes, so only the registry (and any icon you changed in it) is lost, and every asset
   shows the keyword guess again, as it did before W7m. `upgrade` fills the registry again from the assets as they are then. A restart of
   the W7m `api` would run `alembic upgrade head` and apply `0010` again, so the W7m `api` must not be running once the schema is back
   at `0009`.

### Upgrading to W7o (migration 0011)

Schema `0010` to `0011`. Downgrade: **lossless** for the data of the schema (the migration only changes which permissions a custom role
lists, described below), so option a is open. The code to go back to is `425aaf9` (`main` before W7o).

W7o (the data-centre kinds pack) adds migration `0011`, **data only**: no table, column or index changes. Until now every change to the
asset kinds list needed Change assets (`assets.edit`). It now needs its own permission, **Manage asset kinds** (`assets.kinds`), because a
rename or a delete-and-move changes the kind of every asset that uses it. So that nobody loses what they could do, the migration adds
`assets.kinds` to every **custom** role that holds `assets.edit` (once: running it again adds nothing). A custom role without
`assets.edit` is not changed, the built-in Viewer and Operator never held either, and the built-in Admin holds every permission, so it
has the new one without any change. A role that may add and edit assets but must not touch the kinds list has the new tick taken off on
the Roles tab. Reading the list stays `assets.view`. Everything else in W7o is code: 20 more icons (48 in all, in six groups, with a search
box in the picker), deleting a kind that assets use by moving them to another kind, the **Add data-centre kinds** button, and the asset
page's Delete button (labelled, the same height as Add asset and Edit). The `api` container applies the migration the first time it starts
from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0010`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` prints `0011 (head)`; on the Roles tab a custom role that held Change assets now
   shows Manage asset kinds ticked (in the sensitive group), and the Asset kinds page offers Add data-centre kinds to an administrator.
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0010` and `<old commit>` = `425aaf9`. The
   `0011` downgrade removes `assets.kinds` from every custom role that also holds `assets.edit`; it cannot tell a role that was given it
   by the upgrade from one that had it ticked later, so it takes it from all of them (a role that held it without `assets.edit` keeps the
   id, and the older server ignores it). An icon chosen from the 20 new ones, on an asset or a kind, stays stored and **shows the generic
   icon on the older build** (it does not know the id); pick another icon there or upgrade again. `upgrade` after a downgrade adds the
   permission to the custom roles holding `assets.edit` again, including a role that was made on W7o without it on purpose. A restart of
   the W7o `api` would run `alembic upgrade head` and apply `0011` again, so the W7o `api` must not be running once the schema is back
   at `0010`.

## Add a connector

Create `backend/dcdash/connectors/<name>.py` with a `Connector` subclass
decorated with `@register`, and import it in
`backend/dcdash/connectors/__init__.py`. See `simulator.py` for a complete
example. Nothing else changes.
