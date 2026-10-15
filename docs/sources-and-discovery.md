# Sources and discovery

This page is for the engineer who connects the platform to the field: the data sources it reads (OPC UA, Modbus TCP and the HTTP
simulator), their settings, the OPC UA client certificate, and Discovery, which finds sources on the network and maps their points to
assets. What gets recorded in the audit log is listed here too (item 8 of Discovery).

## Protocols

Every connector is read-only toward the source; only `collector` opens connections. When a source fails, its
`last_error` reads `<status>: <message>` with status `auth_failed`, `timeout`, `unreachable`,
`protocol_error` or `needs_profile` (a source that answers is `online` and has no `last_error`).

**HTTP simulator** (`simulator`): `url` (default `http://simulator:9000`) and `timeout_seconds` (5). The
secret is sent as the simulator's API key; see [The simulator](install-and-run.md#the-simulator) for the dev
profile and the key.

**OPC UA** (`opcua`): `endpoint` (`opc.tcp://...`), `security_policy` (`none` or `basic256sha256`),
optional `username` (the password is the source secret), `root_node` (default `i=85`, the Objects
folder; browsing descends from here) and `timeout_seconds` (default 5, 0.5 to 60). With `basic256sha256` the collector
signs and encrypts with a client certificate read from `client_cert` / `client_key` (default
`/certs/opcua-client.pem` and `/certs/opcua-client-key.pem`), as described below.

### OPC UA client certificate

`./certs` (the `certs/` folder of the install) is mounted read-only into the collector at `/certs`. Without the files the source
reports `protocol_error: client certificate not found: <path>`. Generate a self-signed client certificate and key, from the install
folder, with:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=dcdash" \
  -addext "subjectAltName=URI:urn:dcdash:collector" \
  -keyout certs/opcua-client-key.pem -out certs/opcua-client.pem
```

Then recreate the collector (`docker compose up -d --force-recreate collector`) and trust `certs/opcua-client.pem` on the OPC UA
server. No secured session opens until the server trusts `certs/opcua-client.pem`. The collector announces the URI in the certificate's
subjectAltName as its application URI, and it runs as user 10001, so both files must be readable by that user. The collector keeps no
trust list of its own; the connection check on the Diagnostics page shows the certificate's thumbprint and at which step the server
refused it ([Field debugging](field-debugging.md)).

**Modbus TCP** (`modbus`): `host`, `port` (502), `unit_id` (1, 0 to 247), `profile` (`auto` or the name of an
installed profile) and `timeout_seconds` (default 3, 0.5 to 30). Only function codes 3, 4 and 43/14 (device identification)
are ever sent. Point addresses are `fc:register`, e.g. `4:0` is input register 0. A profile is a
YAML file in `backend/dcdash/profiles/` describing the register layout; `auto` matches the device's
vendor/product from FC 43 against the installed profiles and fails with `needs_profile` when nothing
matches (pick a profile on the source) or the chosen profile is not installed. A block reads
`function` 3 or 4, from `start`, `count` registers (1 to 125), with `word_order` `big` (the default) or
`little`. Example (the installed `generic_float32.yaml`, with comments added):

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

Each point takes `data_type` (one of `int16`, `uint16`, `int32`, `uint32`, `float32`; default `uint16`), an optional
`unit` and an optional `scale` (default `1.0`) that the decoded register value is multiplied by, so
an `int16` register holding `1234` with `scale: 0.1` reads as `123.4`. A device that accepts the
TCP connection but never answers is reported as `timeout` after about twice `timeout_seconds`.

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

   On Scans, **Details** on a row of Recent scans (a scan you have just started opens the same view) shows that scan in a panel on the
   right. It starts with the scope in one line, for example `Simulator: 172.20.0.0/24, ports 9000, 4840, 5020`, then the figures in
   words: `762 checks (254 hosts × 3 ports)` (a check is one host and one port; while the scan runs it reads `310 of 762 checks`),
   `3 open`, `1 source read`, `60 points`, `1 needs credentials`, `1 unidentified`, and below them the findings. A running scan
   updates by itself. Esc, the x or a click outside closes the panel, and closing it never stops the scan. The scope line comes from
   the scan itself, so it still shows the targets and ports after the scope was edited or deleted: when a scan finds less than you
   expected, look there first (a mistyped port such as `4080` for `4840` shows). In Recent scans the column **Sources / points**
   reads `1 source, 60 points`: the sources the scan recognised and could read, and the points found in them (it is not a fraction),
   and the Scope cell shows the targets and ports under the scope's name.
4. **Discovered sources are disabled.** A discovered source is created disabled and is not polled,
   tested or listed under Sources until at least one of its points is mapped; mapping enables it. So a
   discovered source with nothing mapped shows on Discovery only, and the one you open from the Sources list has Enabled ticked
   because mapping a point enabled it. A re-scan reuses existing source rows untouched (name, config,
   secret, enabled, origin) and only refreshes their points and findings. A source that answers
   "authentication failed" is marked as needing credentials and the scan carries on.

   **A source you added by hand always wins.** If you add a source at an address a scan has already found, the next scan reuses
   yours, reports it as `existing source` and does not create or browse another one, whichever of the two is older. The older
   discovered duplicate is not browsed any more; it keeps its points and stays on Discovery until you remove it (item 5). Nothing is
   merged, moved or deleted by the scan itself.
5. **The graph** (Discovery). Discovered sources, clusters and points are on the left with dashed
   borders; your assets are on the right with solid ones; mapped points are joined to their asset by a
   solid edge. Sources and clusters start collapsed: use the + / − button on a node to expand or
   collapse it. Points are grouped into suggested clusters (for example one per panel). Dragging nodes
   saves their positions for everyone (admin); an operator's arrangement lasts for the session.

   Each source node says when a scan last found it (`Seen in scan #6, 10 min ago`), or `Added by hand` for a source you made
   yourself, or `Not seen in a scan yet`. A scan only adds sources and refreshes their points; it never removes one, so a source
   whose device is gone, or that you deleted on Sources, stays or comes back until you remove it here.

   **Removing leftovers** (needs `discovery.edit`). A discovered source with nothing mapped has a **Remove** button, and **Clear
   unmapped (N)** above the graph removes every such source at once. Both ask first, in the same delete dialog as everywhere else, and
   name the sources: the dialog lists the first five and says how many more. Removing takes the source, its points and their places on
   the graph; asset, billing and dashboard data never depended on it, because nothing is mapped. Only a discovered source with no
   mapped point can go. A source with a mapped point, or one you added by hand, is never removed here (the message says it was kept and
   why), and the server checks again at the moment of removal, so a point someone mapped after the dialog opened keeps its source.
   Nothing is removed while a scan is running (the dialog says to wait until it has finished). Past scans are not touched: their
   findings stay, they just no longer lead to a source. A scan can find them again: the next scan of the same address creates the
   source again, unmapped. Each removal is one audit entry. Unidentified services are not cleared: they are open ports no connector
   recognised, not sources, and they leave Discovery with the next finished scan.
6. **Mapping by drag and drop** (admin). Drop a cluster or a point on an asset to open the **Review
   mappings** dialog: one row per unmapped point with a guessed metric, scale and interval, all
   editable; rows whose metric the asset already has start unchecked, and a conflicting selection
   cannot be committed. "Create mappings" commits every checked row in one transaction. Drop a cluster
   on empty canvas and a bar offers "Create asset from this cluster", which opens the same dialog with
   a new asset named after the cluster and a parent of your choice; the bar stays until you use or
   dismiss it. The same dialog opens from keyboard-reachable buttons, for admins only: **Map…** on
   unmapped clusters and unmapped points, **New asset…** on clusters only. The Ungrouped bag and fully
   mapped clusters get neither.

   **Create assets…** on a source node (needs `discovery.accept`) is the click path for a whole source. It opens
   one dialog with one parent asset (or the top level) and a row per group that can become an asset: a tick, the asset's name (the
   group's name, which you can change), the number of points and what the scan guessed for each point, such as `energy_kwh ×0.001`.
   **Create N assets** then makes them one after another, each the way New asset… on that group would. A name already used under
   the chosen parent, or twice in the batch, is shown before anything is sent and holds the button back until you change it. A group
   the server still refuses (a point mapped elsewhere in the meantime, a name taken in another tab) is marked with the server's reason
   and stays in the list; the others are created. The guesses are the scan's: look them over before you press Create, because they
   cannot be changed here. To change a metric or a scale first, use New asset… on the group. The Ungrouped
   bag, groups that are fully mapped and groups where every point needs a decision are left out (the dialog names the last kind), and
   a point whose metric repeats another one in its group stays unmapped, as the row says. The button is missing on a source with no
   such group.
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
   sources (create, edit, delete, test, test all, browse), removing unmapped discovered sources (`source.deleted`, `unmapped_only`), tariffs, dashboards, asset kinds (a delete that moves assets records how many and
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

Who may scan, map and accept results is set by the `sources.*` and `discovery.*` permissions (removing leftovers needs
`discovery.edit`, Create assets… `discovery.accept`); see [Roles and permissions](roles-and-permissions.md).

For scripts: removing discovered sources is `POST /api/discovery/sources/remove` with `{"source_ids": [...]}`, 1 to 500 ids in a
request (more is refused with a 422). It answers which sources were removed and which were skipped, each with the reason `mapped`,
`manual` or `gone`, and refuses with a 409 and removes nothing while a scan is queued or running. Each scan in `GET /api/scans` carries
the `targets` and `ports` it covered, and each source in `GET /api/discovery/graph` a `last_scan` (`{scan_id, at}` of the newest scan
that found it, or `null`).

Related: [Assets and kinds](assets-and-kinds.md), [Storage](storage.md), [Install and run](install-and-run.md), [Field debugging](field-debugging.md), [Adding a connector](adding-a-connector.md)
