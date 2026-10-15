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

   **Port names and the typo warning.** The scope form, the Scopes table and the scan lines name the ports the app knows: `502 (Modbus)`,
   `4840 (OPC UA)`, `9000 (simulator)` and `5020 (Modbus, simulator)`, which is the dev simulator's own Modbus port. A port it does not
   know shows as the bare number, so a typo stands out beside its named neighbours. While you type in the Ports field, a line under it
   reads the list back (`Reads as 502 (Modbus), 4840 (OPC UA)`). When a port is one slip away from a known one, the line becomes a
   warning instead, for example `4080 is not a port any connector uses; did you mean 4840 (OPC UA)?` (with several suspect ports the
   first warning is shown in full, followed by one line that counts the rest, `and 4 more ports look like typos.`, so the Save button
   stays where it is). The warning is advice and never stops you: Save works whatever it says, and an unusual port you meant to scan is simply
   kept. Everyday and industrial ports (80, 443, 8080, 3306, 1502, 4843 and so on) never trigger it, nor does a port with one or two
   digits; port 9000 is named but not guarded, and 4800 or 5002 may still be flagged.
2. **Confirmation.** Pressing Scan shows "N hosts × M ports (P checks)" (`1 host × 1 port (1 check)` for one) and asks for confirmation on
   every run. The API enforces it: the start request must carry the host count the API computed
   itself, or nothing runs. It must also carry the digest the preview returned (a hash of the scope's
   targets and ports), so a scope edited after it was previewed cannot be started unconfirmed: the
   page asks you to confirm again.

   **Scan again.** Each row of Recent scans has a **Scan again** button (before Details). It opens the same preview and the same
   confirmation as **Scan** in that scope's row menu, for the scope as it is now: if you edited the scope since, the numbers you
   confirm are the new ones, not the old scan's. Nothing starts until you press Start scan. The button is greyed out, with the reason
   as its tooltip, when your role may not start scans (`discovery.scan`), when the scope was deleted, or while another request is
   running. The confirmation panel stands above the Scopes table, so the page brings it into view; the focus stays on the button you
   pressed.
3. **What a scan does.** The collector tries a TCP connect to every host and port, then offers each
   open endpoint to every connector's read-only probe (first claim wins; an endpoint nobody claims is
   listed as an unidentified service), then browses the claimed sources to find their points. The page
   shows progress and, when done, one finding per open endpoint.

   On Scans, **Details** on a row of Recent scans (a scan you have just started opens the same view) shows that scan in a panel on the
   right. It starts with the scope, for example `Simulator: 172.20.0.0/24, ports 9000 (simulator), 4840 (OPC UA), 5020 (Modbus, simulator)` (a long list wraps onto more lines; every target and port is there), then the figures in
   words: `762 checks (254 hosts × 3 ports)` (a check is one host and one port; while the scan runs it reads `310 of 762 checks`),
   `3 open`, `1 source recognised`, `60 points`, `1 needs credentials`, `1 unidentified`, and below them the findings. A running scan
   updates by itself. Esc, the x or a click outside closes the panel, and closing it never stops the scan. The scope line comes from
   the scan itself, so it still shows the targets and ports after the scope was edited or deleted: when a scan finds less than you
   expected, look there first (a mistyped port such as `4080` for `4840` shows). In Recent scans the column **Sources / points**
   reads `1 source, 60 points`: the sources the scan recognised (not necessarily browsed: one you added by hand that the scan only matched counts too), and the points found in them (it is not a fraction),
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
   saves their positions for everyone (admin); an operator's arrangement lasts for the session. The canvas opens on the first three
   sources at a readable size, so their buttons are in view; the assets on the right may be out of view until you pan or press **Fit
   View** (the bottom-left control), which shows the whole graph.

   **Children follow their parent.** Drag a source and its open groups and their points move with it, each keeping its distance from the
   source; drag a group and its open points follow; drag an asset and its sub-assets follow. A group you have collapsed moves too, out of
   sight: its saved place is shifted by the same distance in the same save, so when you open it again it stands beside its source,
   not where the source used to be. A group or point that has never been moved has no place of its own and simply opens next to where
   its parent now stands. One you dragged away on purpose keeps its own place and travels with its parent from then on, at the same
   offset. Dragging a child never moves its parent. Dropping a group or point on an asset to map it puts it, and anything that went
   with it, back where it was.

   **Alt (Option on a Mac) moves a node alone.** Hold Alt when you start the drag and only that node moves; its open children stay
   where they stand and are given a place there, so they do not jump back beside it the next time the graph redraws. That place is a
   saved one like any other: it is saved for everyone, so one Alt drag of a source with ten open groups saves ten places, and only
   **Tidy layout** (below) takes them away again (dragging such a child moves its place, it does not remove it). A collapsed group that
   has no place of its own is not drawn, so it is not given one: when you open it later it stands next to the source's new place, not
   where the source used to be. Let go of Alt
   mid-drag or press it later and nothing changes: the key is read once, at the start. On some Linux desktops Alt-drag is taken by
   the window manager to move the whole window, so the page never sees the key; change the desktop's window-move key there, or drag
   without Alt and move the children back by hand. Two ways of moving nodes are unchanged and take no children along: the arrow keys
   on a focused node, and dragging a group of nodes that you selected with a Shift box. Neither is saved; they move on screen only.

   **The bar above the canvas** holds a one-line summary of what the graph shows, such as `3 sources, 120 points, 6 mapped, 1 needs
   credentials` (it is read out only when a number changes), and three buttons.

   - **Collapse all** closes every source, and with it its groups. **Expand all** opens every source and then every group, but never draws
     more than 600 new nodes in one go: what does not fit stays closed and a message says so, for example `Opened 3 sources and 12 groups.
     4 groups stay closed: opening them would draw more than 600 nodes.` Open those one by one with their + button. Neither button moves
     the view. A button with nothing to do is greyed out and keeps its place.
   - **Tidy layout** puts every node back in its default column. For someone who may change the layout (`discovery.edit`) it asks
     first, `Tidy the layout for everyone?`, because the saved places are shared: confirming deletes every saved place, for every
     user, and the canvas then opens as if nobody had ever dragged anything (mappings, assets, sources and points are not touched,
     and the clear is not written to the audit log, like dragging). Use it when a graph has been pulled into a mess. For anyone else it
     asks nothing and sends nothing: their own view is tidied until they reload, and a message says that the shared layout is
     unchanged. If the server refuses, nothing changes and the reason is shown.

   **What a node shows.** The facts line of a source starts with a small dot and the protocol of its connector, then the words it
   always had: dot, `OPC UA`, `discovered · online · 60 points`. The dot is green for an enabled source that answered its last poll,
   red for one that did not, amber for one that needs credentials, and grey for one that is disabled or has never been polled (the
   status word beside it still says which, so colour is never the only signal; the green dot also pulses softly). The protocol reads
   `OPC UA`, `Modbus` or `Simulator`, or the connector's own name when the app has no label for it. A group node keeps its `N mapped`
   and gains a thin bar along its bottom edge, as long as the share of its points that are mapped (hover it for `3 of 6 mapped`).
   None of this makes a node taller.

   **The camera glides.** Fit View (the bottom-left control), the refit after **Tidy layout** and **Find** (below) move the view
   over about a third of a second instead of jumping. Opening a source with its + button (or **Expand** in its right-click menu) pans
   the view just far enough to keep the source and its groups in sight, with a margin of 40 px, and never changes the zoom; when they are
   already in view nothing moves. Opening a group, closing anything, **Expand all** and **Collapse all** leave the view alone, and
   so does the first view when the page opens.

   **The overview.** At the bottom right, a small map of the whole graph shows where the view is (it is named `Overview of the whole
   graph` for a screen reader). Click or drag in it to move the view and scroll over it to zoom. Sources, groups, points, assets and
   unidentified services each have their own shade of the theme. It is not drawn when the canvas is narrower than about 700 px.

   **Snap to grid and guides.** A node you drag snaps to an 8 px grid, and the default place of every node lies on that grid, so
   nudging one group does not leave it a few pixels off its untouched neighbours (assets nested under an asset stand 224 px per level
   further right, 4 px more than before, for the same reason). The **Snap to grid** button at the top right of the canvas turns
   this off and on (pressed means on); it starts on and the choice is remembered in this browser. While you drag, thin accent-coloured
   guide lines appear when the node's left edge, centre or right edge, or its top, middle or bottom, lines up to the pixel with
   a nearby node's (the 200 nearest are compared). The guides only show; they never pull the node, so it is dropped exactly where
   you let go. With snap on, equal edges are common; with snap off a guide shows only on an exact match, which is rare by hand.

   **Lighting a path.** Rest the pointer on a node for a moment, tab to it (when the focus ring shows) or select it, and its path
   stands out: the nodes it comes from and the nodes it leads to along the edges (a point lights its group, its source and the asset
   it is mapped to, with that asset's sub-assets; an asset lights its mapped points, their groups and sources), the edges between them
   turn to the accent colour, and everything else fades to about a third. Moving off clears it after a short pause, so crossing the
   canvas from one node to the next never flashes. A selection of up to 20 nodes lights the union of their paths. Nothing lights while
   you drag, for a node with no edge, or when the path has more than 400 nodes (a source with hundreds of drawn points). A touch
   screen has no hover: select a node to light its path. The faded text is below the usual contrast on purpose, and only while the path
   is lit; the same facts are on the lit nodes and in the summary above.

   **Live edges.** The edges of a source that is enabled and online flow: dashes travel along the dashed edges to its groups and points
   and along the edges from its mapped nodes to their assets (these are almost solid, with a small gap that moves, so they still read
   as asset links). Offline, disabled and never-polled sources stay still, and so do the edges between assets. It means "this
   source is being polled", not a measurement of traffic. If more than 300 edges would flow, none do.

   **Selecting several nodes.** Shift-drag on empty canvas draws a selection box (a plain drag still pans); Ctrl-click, or Cmd-click on
   a Mac, adds or removes one node. The selection survives opening and closing nodes and the graph refreshing. Drag any selected
   node and the whole selection moves; the children rule above applies once, so a source and its own group selected together move
   their points once. Dropping a selection on an asset never maps (only one group or point maps). A frame is drawn over the
   selected nodes: click empty canvas or press Esc to clear the selection, because the buttons under the frame do not answer
   until you do.

   **Right-click menus.** Right-click a node for the actions it has. A source: **Details**, **Collapse** or **Expand**, **Create
   assets…**, **Remove**. A group: **Collapse** or **Expand**, **Map…**, **New asset…**. A point: **Map…**. Each is the same action
   as the button on the node, and an item is there only when the button is for your role (**Map…**, **New asset…** and **Create
   assets…** need `discovery.accept`, **Remove** needs `discovery.edit`, so a role that can only view sees Details and Collapse or
   Expand). An asset, an unidentified service, empty canvas and a selection frame open the canvas menu instead: **Expand all**,
   **Collapse all**, **Tidy layout** and **Fit view**, greyed out when the button above the canvas is. From the keyboard, press the
   Menu key or Shift+F10 on a node that has the focus; anywhere else inside the canvas the canvas menu opens at its centre. Up and
   Down move (and wrap), Home and End jump, Enter chooses, Esc closes the menu and puts the focus back on the node, and Tab closes it too.
   A click elsewhere, scrolling, resizing, moving the view and the graph refreshing close it too. The menu is never the only way:
   every action also has a visible button.

   **Find.** The **Find** button at the top right of the canvas, or Ctrl+K (Cmd+K on a Mac) while the canvas has the focus (click
   empty canvas first), opens a search card over the canvas. Type part of a name and it lists matching sources (by name or endpoint),
   assets (by name or kind), groups (by name) and points (by name or address). Every word you type must appear; names that start with
   it come first, then names with a word that starts with it, then the rest. At most 50 are listed, and `N more` says how many are
   not. Up and Down move through the list, Enter chooses, and Esc, or a click outside, closes the card and puts the focus back where
   it was. Choosing a result opens the source and group it sits in when they are closed, glides the view to it (zooming in to at
   least 75%, never past 100%) and outlines it in the accent colour for about 1.5 seconds. If a group is too big to draw (more than
   600 nodes), the source opens and the group stays closed, and a message says so, for example `LVP01 has 6,000 points, too many to
   draw at once. Showing the group instead.`; when opening the source would draw too many nodes because its groups are already open,
   those groups are closed first and the message says that. Elsewhere on the page, Ctrl+K is still the top bar's **Quick find**.

   **Keys on the canvas.**

   | Key | What it does |
   |---|---|
   | Ctrl+K, or Cmd+K (canvas has the focus) | Open Find; anywhere else on the page it opens Quick find |
   | Shift-drag | Draw a selection box |
   | Ctrl-click, or Cmd-click | Add a node to the selection or remove it |
   | Alt, or Option, held when you start a drag | Move the node alone, without its children |
   | Menu key, or Shift+F10 | Open the actions of the focused node; elsewhere in the canvas, the canvas menu |
   | Up, Down, Home, End, Enter in a menu or Find | Move, jump, choose |
   | Esc | Close the open menu or Find card (one layer at a time), then clear a selection |

   **Reduced motion.** When your system asks for less motion, the camera moves at once, the green dot does not pulse, the edges do not
   flow (they keep their dashes), the Find outline does not pulse (it still shows for 1.5 seconds), and the fade of the path highlight is
   switched off, so lit and faded nodes change at once.

   **The hint under the title** is one line, `Dashed: discovered. Solid: assets. Drag a group onto an asset or press New asset…`,
   followed by a `?` (named `What can I do on the canvas?`) that lists the keys above in six short lines.

   Each source node says when a scan last found it (`Seen in scan #6, 10 min ago`), or `Added by hand` for a source you made
   yourself, or `Not seen in a scan yet`. A scan only adds sources and refreshes their points; it never removes one, so a source
   whose device is gone, or that you deleted on Sources, stays or comes back until you remove it here.

   **Removing leftovers** (needs `discovery.edit`). A discovered source with nothing mapped has a **Remove** button (a small bin at the
   right end of its row of buttons, named `Remove <source> from Discovery` for a screen reader), and **Clear
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
   the node positions on the Discovery graph (saving or clearing them with Tidy layout). Failed sign-ins are capped at 30 rows per 5 minutes, then
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

For scripts: `DELETE /api/discovery/layout` (`discovery.edit`) removes every saved node position and answers 204; calling it again is
harmless, it writes no audit row, and `PUT /api/discovery/layout` still saves positions afterwards. It is what **Tidy layout** sends.
Removing discovered sources is `POST /api/discovery/sources/remove` with `{"source_ids": [...]}`, 1 to 500 ids in a
request (more is refused with a 422). It answers which sources were removed and which were skipped, each with the reason `mapped`,
`manual` or `gone`, and refuses with a 409 and removes nothing while a scan is queued or running. Each scan in `GET /api/scans` carries
the `targets` and `ports` it covered, and each source in `GET /api/discovery/graph` a `last_scan` (`{scan_id, at}` of the newest scan
that found it, or `null`).

Related: [Assets and kinds](assets-and-kinds.md), [Storage](storage.md), [Install and run](install-and-run.md), [Field debugging](field-debugging.md), [Adding a connector](adding-a-connector.md)
