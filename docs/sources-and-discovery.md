# Sources and discovery

This page is for the engineer who connects the platform to the field: the data sources it reads (OPC UA, Modbus TCP and the HTTP
simulator), their settings, the OPC UA client certificate, and Discovery, which finds sources on the network and maps their points to
assets. What gets recorded in the audit log is listed here too (item 8 of Discovery), and so is how the platform fills the holes an
outage leaves from a source's own history ([History and backfill](#history-and-backfill)) and how a file is imported
([Importing readings from a file](#importing-readings-from-a-file)).

## Protocols

Every connector is read-only toward the source; only `collector` opens connections. When a source fails, its
`last_error` reads `<status>: <message>` with status `auth_failed`, `timeout`, `unreachable`,
`protocol_error` or `needs_profile` (a source that answers is `online` and has no `last_error`).

**HTTP simulator** (`simulator`): `url` (default `http://simulator:9000`) and `timeout_seconds` (5). The
secret is sent as the simulator's API key; see [The simulator](install-and-run.md#the-simulator) for the dev
profile and the key. It is the only connector that can read history, from the stand-in Historian on port 9100
([History and backfill](#history-and-backfill)).

**File import** (`file`): no settings; see [below](#importing-readings-from-a-file).

**OPC UA** (`opcua`): `endpoint` (`opc.tcp://...`), `security_policy` (`none` or `basic256sha256`),
optional `username` (the password is the source secret), `root_node` (default `i=85`, the Objects
folder; browsing descends from here) and `timeout_seconds` (default 5, 0.5 to 60). With `basic256sha256` the collector
signs and encrypts with a client certificate read from `client_cert` / `client_key` (default
`/certs/opcua-client.pem` and `/certs/opcua-client-key.pem`), as described below. `stable_addresses` (off) reads Plant SCADA tags without the number browsing puts in front of them: [Large OPC UA servers](opc-ua-at-scale.md).

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
   solid edge. Sources and clusters start collapsed: use the small arrow at the left of a source, or the + / − button on a group, to expand or
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
   without Alt and move the children back by hand. The arrow keys on a node you have selected (clicked, or ticked with Space) still
   take no children along and are not saved; they nudge it on screen only (on a node that only has the focus they move to the
   next node instead, see **Arrow keys** below). Dragging nodes you selected (with a Shift box or Ctrl-click) is a drag like any other: the whole selection
   moves, each node takes its open children along once, and the places are saved.

   **The bar above the canvas** is one row of controls that keeps its height whatever it shows. It starts with small counts: `3 sources`,
   `120 points` (`42 of 120 points` while **Unmapped only** is on), `6 mapped` and, when a source needs credentials, `1 needs credentials`.
   The counts are only a picture; a screen reader is given the same figures as one sentence, such as `3 sources, 120 points, 6 mapped, 1
   needs credentials`, which it reads out only when a number changes. After the counts come three groups of controls, set apart by thin
   dividers: the **View controls** (the first four items below), the **Canvas controls** (**Find** and **Snap to grid**, described further
   down) and the **Page controls** (**Refresh**, the keyboard button and **More Discovery actions**, described after the list).

   - **Collapse all** closes every source, and with it its groups. **Expand all** opens every source and then every group, but never draws
     more than 600 new nodes in one go: what does not fit stays closed and a message says so, for example `Opened 3 sources and 12 groups.
     4 groups stay closed: opening them would draw more than 600 nodes.` Open those one by one with their + button. Neither button moves
     the view. A button with nothing to do is greyed out and keeps its place. Neither touches the fold of an asset's sub-assets
     (below): assets have their own toggle and the branch and selection actions.
   - **More ways to collapse** and **More ways to expand** (the small arrow beside each) open a menu of two items: **Collapse selection**
     and **Collapse this branch**, or **Expand selection** and **Expand this branch**. They act on the nodes you selected (Shift-drag a
     box, or Ctrl-click): **selection** opens or closes only the selected sources, groups and assets that have sub-assets, and ignores the
     others, a point for instance; **branch** does the same and also reaches everything under them that can open or close, a source's
     groups for example. The same two words are in the right-click menu of a node that can open or close (**Expand this branch**, **Collapse
     this branch**, always for that node whatever is selected), and **Expand selection** and **Collapse selection** are in the menu of a
     selection frame and of empty canvas. When nothing can be done the item, or the whole arrow, is greyed out and says why: `Select a
     source, group or asset first.`, `Nothing selected opens or closes.`, `Everything selected is already open.` or `... already closed.`
     What was done is said in a message, for example `Opened 3 groups and 1 source.` or `Closed 2 groups.`. Opening still obeys the budget
     of 600 new nodes (below) and says what stayed closed, in the sentence of Expand all; opening or closing an asset's sub-assets costs
     nothing and is counted in the message (`Opened 2 groups and 3 assets.`).
   - **Unmapped only** hides what is already mapped, so what is left is what still needs a decision. See below.
   - **Tidy layout** puts every node back in its default column. For someone who may change the layout (`discovery.edit`) it asks
     first, `Tidy the layout for everyone?`, because the saved places are shared: confirming deletes every saved place, for every
     user, and the canvas then opens as if nobody had ever dragged anything (mappings, assets, sources and points are not touched,
     and the clear is not written to the audit log, like dragging). Use it when a graph has been pulled into a mess. For anyone else it
     asks nothing and sends nothing: their own view is tidied until they reload, and a message says that the shared layout is
     unchanged. If the server refuses, nothing changes and the reason is shown.

   **Page controls.** **Refresh** (a button with the circular arrow) reads the graph again; it was in the page header before. The keyboard
   button, named `Keyboard shortcuts and controls`, opens the list of keys (below). **More Discovery actions** (three dots) holds **Clear
   unmapped (N)** (see **Removing leftovers**) for a role that has `discovery.edit` (greyed out, `Nothing to clear`, when no source
   can go), and, while a source is marked not seen, **Turn on Not seen lately** (everyone who can open Discovery) and **Remove not seen
   (N)...** (`discovery.edit`; [Devices that move or disappear](devices-that-move.md#not-seen-and-remove-not-seen)).

   **A narrower window.** The bar keeps to one row. When the window is narrower the controls lose their words one at a time and keep
   their icons (**Snap to grid** first, then **Find**, **Tidy layout**, **Unmapped only**, and last **Collapse all** and **Expand all**), while the
   counts keep their words (`4 sources`, `180 points`, `62 mapped`) for as long as they fit, and then keep the icon and the number (hover for
   the words). A set that has a `needs credentials` count, or a count of 1,000 or more, is wider and loses its words earlier, so that no
   count is ever dropped for the sake of a word. Every button keeps its name for a screen reader and for the tooltip. A count that still
   does not fit is left out whole rather than cut in half (the sentence a screen reader hears is unaffected). On a still narrower window **Unmapped only**, **Tidy layout** and **Snap to grid** leave the bar
   and appear in the **More Discovery actions** menu instead, as `Turn on Unmapped only` (or `Turn off ...`), `Tidy layout` and `Turn on Snap
   to grid` (or `Turn off ...`), so each is in exactly one place. A role that may not clear unmapped sources gets the More button only on a window that narrow
   or while sources are marked not seen.

   **Unmapped only.** The switch in the bar's View controls hides every point that is mapped, every group whose points are all mapped and
   every source with at least one point and all of them mapped (a source with no points stays), and draws no line from a point to an
   asset. It is for working through what is left. The points count then reads `42 of 60 points`, and the sentence a screen reader hears leads
   with the count and drops the repeat of the points, for example `Showing 42 of 60 points, 3 sources, 18 mapped` (all the points of
   every source, not only the open ones, and `mapped` here means linked to an asset); with the switch off the sentence is the one above. A group's title still shows its total, mapped points included. The
   choice is remembered in this browser, the same words as the **Unmapped only** tick on the Points page, and nothing is deleted or
   changed by it. Mapping a point while the switch is on removes it from the canvas, and the focus then goes to the next unmapped point
   of its group, else the group, else the source, else the canvas, never to nowhere. **Find** (below) still reaches a hidden node: it
   turns the switch off and says so (`Unmapped only is off so LVP01 can be shown.`).

   **Big groups, 50 at a time.** An open group of more than 50 points that the filter leaves draws the first 50, and a **Show 50 more
   (70 left)** button stands at the end of the list, where you are looking (a 500-point list is 32,000 px tall, so the group's own node is
   far from its end). Each press adds 50 (the last press adds what is left) and puts the focus on the first new point; when everything is
   drawn the button goes and the focus goes to the group. The group node says `50 of 120 shown`. A group of 50 points or fewer never
   pages. The page you have reached is not remembered: reload, or close the group, and it starts at 50 again. A point you have mapped
   but that is not drawn yet is not lost from the picture: the group keeps one line to its asset for them, labelled `N mapped` when
   there are several, so no mapping ever disappears. Paging counts toward the 600-node budget by what is drawn (the 50 and the button).
   **Find** extends the page to reach a point (below).

   **Folding an asset's sub-assets.** An asset that has sub-assets carries a small arrow named
   `Hide sub-assets of <name>` or `Show sub-assets of <name>`, and its right-click menu has **Hide sub-assets** or **Show sub-assets**.
   Adding a sub-asset under a folded asset (the + on the asset, or **New sub-asset…**) unfolds it, so the new asset is seen. Folding hides every
   asset below it; a point mapped to a hidden asset keeps its line, which now ends on the folded asset, and that asset shows a small
   `N mapped` badge (hover it for `N mapped inside`) counting the points mapped to it or to anything under it. Anyone who can open the
   page can fold; the choice is remembered in this browser. **Collapse all** and **Expand all** leave it alone, and **Tidy layout**
   does not undo it.

   **Arrow keys.** Tab reaches the nodes (the canvas itself takes the focus when you click empty space, or when Esc closes Find or a
   menu, and Down or Right on it goes to the first node). Then: Up and Down move to the previous or next node in the same list (the
   sources, the groups of a source, the points of a group, the assets of one level), Right moves to the first node under it and Left
   back to its parent; at the end of a group's points Down reaches **Show 50 more**, and the arrows work from that button too (Up goes
   to the last point, Left to the group). The arrows walk inside one column and do not cross to the other: **Ctrl+K** (Find) is the
   quick way to an asset from a source or a point. Enter opens or closes a source, a group or an asset that has sub-assets; on a
   point, an asset without sub-assets and an unidentified service it selects the node, as Space does on every node (on **Show 50
   more** it presses the button). The Menu key or Shift+F10 opens its actions. The view moves only as far as it must to keep the node
   in sight, clear of the overview map and the Find panel, and never zooms. On a node you have selected the arrows move the node
   instead, on screen only (8 px with **Snap to grid** on, 5 px without): press Esc to clear the selection, the focus stays on the
   node and the arrows walk again. Every node has a name for a screen reader that says its kind and state, such as `LVP01, group of 6
   points, 6 mapped, open`, and a group that draws only a page of its points says how many it shows; the canvas says how to use the
   keys.

   **Big graphs.** The long lines from a group to its points are solid, not dashed, once a group draws more than 150 points: dashes on
   a line tens of thousands of pixels long are what made dragging slow, and nothing else changes in how they look. Opening a group and
   resting the pointer on a node redraw only the nodes that changed, so a graph of 2,000 nodes answers them faster than it did.
   **Expand all** still never draws more than 600 new nodes in one go. One thing to know: when you switch **Unmapped
   only**, fold an asset or close a group, the rows of the default columns close up. A node you pinned by hand with an Alt-drag keeps
   the place you gave it, so rows that closed up can lie over it; **Tidy layout** puts everything back.

   **Icons on every node.** Each node starts with a small icon, then its name. The icon is decoration: the name already says what the
   node is. A source shows the icon of its protocol (OPC UA, Modbus and the simulator each have their own; any other connector gets a
   plain source icon), a group a stack of layers, a point an icon for what it measures (a bolt for power, a ringed bolt for energy, a V
   for volts, an A for amps, four small rings for anything else, including a point with no metric yet), and an asset its own icon: the
   one chosen for it, else the one of its kind, else the one the name suggests (the same as in the Assets Tree). An unidentified service
   has the plain source icon. **Find** lists its results with the same icons.

   **The source card.** A source is a card of six lines, each of a fixed height, so a word that changes (a status, `9 min ago`) moves
   nothing, and the card fits the room a source has always had, so no default place moved. From the top:

   1. A small arrow to open or close the source, the protocol icon, the source's **short name** on up to two lines, and, when it has
      something to offer, a `⋯` button named `Source actions for <name>`. The short name is the name without the address a scan adds to it
      (`OPC UA server`, not `OPC UA server at 172.20.0.2:4840`; `Modbus Schneider PM5560` for `Modbus Schneider PM5560 at
      10.0.0.5:502`). A name you typed yourself is shown whole, and so is any name that does not end with the source's own address. The full
      name is the tooltip and is what a screen reader reads and what the buttons are named after. A name that needs more than two lines ends
      with an ellipsis on the card; **Details** (Tab to it, Enter) opens the source panel, whose heading is the whole name.
   2. The protocol and where the source listens, for example `OPC UA · 172.20.0.2:4840` (just the protocol when no address is known).
   3. A small dot, the status in words, and the origin: `online · discovered`, or `online · manual` for a source you added by hand. The
      status words are `online`, `offline`, `needs credentials` (in bolder type),
      `disabled` and `not polled`. The dot is green for an enabled source that answered its last poll,
      red for one that did not, amber for one that needs credentials and grey for one that is disabled or has never been polled; the
      word says which, so colour is never the only signal (the green dot also pulses softly).
   4. `60 of 60 mapped` (`No points yet` for a source with none) with a thin bar under it, as long as the share of its points that are
      mapped. The bar is only a picture; the words say the same.
   5. **Details**, which opens the source's side panel.
   6. When a scan last found it (`Seen in scan #6, 10 min ago`, `Added by hand` or `Not seen in a scan yet`); [Devices that move or
      disappear](devices-that-move.md) lists its other texts.

   The dashed border of a discovered source is kept. The protocol reads `OPC UA`, `Modbus` or `Simulator`, or the connector's own name when
   the app has no label for it. **Create assets for N groups…** and **Remove from Discovery…** are not buttons on the card: they are in
   the `⋯` menu (below, **Right-click menus**). A group node keeps its `N mapped` and gains a thin bar along its bottom edge, as long as
   the share of its points that are mapped (hover it for `3 of 6 mapped`).

   **The camera glides.** Fit View (the bottom-left control), the refit after **Tidy layout** and **Find** (below) move the view
   over about a third of a second instead of jumping. Opening a source with its arrow (or **Expand** in its right-click menu) pans
   the view just far enough to keep the source and its groups in sight, with a margin of 40 px, and never changes the zoom; when they are
   already in view nothing moves. Opening a group, closing anything, **Expand all** and **Collapse all** leave the view alone, and
   so does the first view when the page opens.

   **The overview.** At the bottom right, a small map of the whole graph shows where the view is (it is named `Overview of the whole
   graph` for a screen reader). Click or drag in it to move the view and scroll over it to zoom. Sources, groups, points, assets and
   unidentified services each have their own shade of the theme. It is not drawn when the canvas is narrower than about 700 px.

   **Snap to grid and guides.** A node you drag snaps to an 8 px grid, and the default place of every node lies on that grid, so
   nudging one group does not leave it a few pixels off its untouched neighbours (assets nested under an asset stand 224 px per level
   further right, 4 px more than before, for the same reason). The **Snap to grid** button in the bar's Canvas controls (beside
   Find; on a narrow window it is an item of **More Discovery actions**) turns this off and on (pressed means on: a tinted button with a line along its foot, which is not the focus ring, the outline that appears around a control reached by keyboard); it starts on and the choice is remembered in this browser. While you drag, thin accent-coloured
   guide lines appear when the node's left edge, centre or right edge, or its top, middle or bottom, lines up to the pixel with
   a nearby node's (the 200 nearest are compared). The guides only show; they never pull the node, so it is dropped exactly where
   you let go. With snap on, equal edges are common; with snap off a guide shows only on an exact match, which is rare by hand.

   **Lighting a path.** Rest the pointer on a node for a moment, or tab to it (when the focus ring shows), and its path
   stands out: the nodes it comes from and the nodes it leads to along the edges (a point lights its group, its source and the asset
   it is mapped to, with that asset's sub-assets; an asset lights its mapped points, their groups and sources), the edges between them
   turn to the accent colour, and everything else dims to about a third, at once (there is no fade). Moving off clears it after
   a short pause, so crossing the canvas from one node to the next never flashes. Clicking a single node lights nothing: you click a
   node to drag it or to open its menu, and the rest of the canvas would only look disabled. A selection of two or more nodes (a
   Shift box or Ctrl-click, see below) is a deliberate "show me these", and lights the union of their paths, for up to 20 nodes.
   Nothing lights while you drag, for a node with no edge, or when the path has more than 400 nodes (a source with hundreds of drawn
   points). A touch screen has no hover and no Shift or Ctrl, so it lights no path. The dimmed text is below the usual contrast on
   purpose, and only while a path is lit; the same facts are on the lit nodes and in the summary above.

   **The last value of a mapped point.** Rest the pointer on a point that is mapped to an asset for a moment, or Tab to it (when the focus
   ring shows), and a small card appears just below it (above it near the bottom of the window) with its newest reading, for example
   `12.40 kW, 3 s ago`: the figure already multiplied by the mapping's scale, in the unit of its metric, with an age that keeps counting
   while the card stays. A reading older than the mapping's interval allows adds `stale` (`12.40 kW, 5 min ago, stale`), a reading whose
   quality is not good adds `bad reading`, and a point nobody has read yet says `No reading yet`. While the answer is on its way the card
   says `Reading…`, and when the server cannot be asked it says `Could not read the value`; it does not try again by itself, the next
   hover does. The card is only for a mapped point (an unmapped point, a group, a source and an asset show none) and only for a person
   who may see assets (`assets.view`): a role without it is never asked anything. One request is made per hover, never on a timer. The
   card goes when the pointer leaves (after a short pause), when you drag a node, pan or zoom, scroll or resize, when you press Esc (that
   key closes the card first and goes no further) and when the node is closed away; a screen reader is told its words as the node's
   description while it shows. A touch screen has no hover and so shows no card on touch.

   **Live edges.** The edges of a source that is enabled and online flow: dashes travel along the dashed edges from the source to
   its groups and along the edges from its mapped nodes to their assets (these are almost solid, with a small gap that moves, so they
   still read as asset links). The dashed edges from a group to its points stay still, even for a live source: there can be hundreds
   of them and they add little to the picture. Offline, disabled and never-polled sources stay still, and so do the edges between
   assets. It means "this source is being polled", not a measurement of traffic. If more than 100 edges would flow, none do (a
   flowing edge is repainted on every frame, which over a remote desktop is screen traffic for as long as the page is open).

   **Selecting several nodes.** Shift-drag on empty canvas draws a selection box (a plain drag still pans); Ctrl-click, or Cmd-click on
   a Mac, adds or removes one node. Two or more selected nodes light their paths (above); one does not. The selection survives
   opening and closing nodes and the graph refreshing. Drag any selected node and the whole selection moves; the children rule above applies once, so a source and its own group selected together move
   their points once. Dropping a selection on an asset maps it only when it is made of unmapped points of one source (item 6, **Several
   points at once**); any other selection is only moved, and a group or a point dropped alone still maps. A frame is drawn over the
   selected nodes: click empty canvas or press Esc to clear the selection, because the buttons under the frame do not answer
   until you do.

   **Right-click menus.** Right-click a node for the actions it has. A source: **Details**, **Collapse** or **Expand**, **Create
   assets for N groups…**, **Remove from Discovery…**. A group: **Collapse** or **Expand**, **Map…**, **New asset…**. A point: **Map…**, and **New asset…** while it is
   unmapped. A mapped point also holds **Unmap…** and **Move to another asset…**, and a group with mapped points (the Ungrouped bag
   too) **Unmap this group…** and **Move this group's mappings…**. An asset holds **New sub-asset…** and, for each source with points
   mapped to it (the first five by name), `Unmap everything from <source>…`. A source, a group and an asset that has sub-assets end with
   **Expand this branch** and **Collapse this branch** (everyone who can see Discovery has them), and an asset with sub-assets also
   **Hide sub-assets** or **Show sub-assets**. Most are the same action as a button on the node. The two a source's card does not
   draw as buttons, **Create assets for N groups…** and **Remove from Discovery…**, are here and in the `⋯` button on the card (named
   `Source actions for <name>`), which opens this same menu beside the card. The card has that button only when at least one of the two is
   for your role and the source (a source with nothing to create or remove has none: Details and the arrow already do the rest). An item is there only when
   the action is for your role (**Map…**, **New asset…** on a group or a point and **Create assets for N groups…** need
   `discovery.accept`, **Remove from Discovery…** needs `discovery.edit`, the unmap and move items need `assets.edit`, and **New sub-asset…** and
   **New asset…** (a point's, and the canvas's below) need `assets.edit` and `assets.view`, so a role that can only view sees Details
   and Collapse or Expand). An unidentified service, a selection frame, empty canvas and an asset with no item for your role open the
   canvas menu instead: **Expand all**, **Collapse all**, **Tidy layout** and **Fit view**, greyed out when the button above the
   canvas is, then **Expand selection** and **Collapse selection** (greyed out, with the reason, when nothing selected can do it), and, on empty canvas only, **New asset…** for a role that has it. A mapped point and a mapped group also carry a small
   button at the right of their title, named `Mapping actions for <name>`, which opens the same menu beside it; it adds no height to
   the node. From the keyboard, press the Menu key or Shift+F10 on a node that has the focus; anywhere else inside the canvas the
   canvas menu opens at its centre. Up and Down move (and wrap), Home and End jump, Enter chooses, Esc closes the menu and puts the
   focus back where it was (the node, or its `Mapping actions` or `Source actions` button), and Tab closes it too. A click elsewhere, scrolling,
   resizing, moving the view and the graph refreshing close it too. Three items have no button of their own: `Unmap everything from
   <source>…` and the **New asset…** of empty canvas and of an unmapped point; the Menu key reaches them. Unmapping and moving,
   the new asset forms and the + on an asset are in item 6.

   **Find.** The **Find** button in the bar's Canvas controls (a second press closes the card), or Ctrl+K (Cmd+K on a Mac) while the
   canvas has the focus (click empty canvas first) or the focus is anywhere on the bar, opens a search card over the top right of the
   canvas: the button is in the bar, but the card stays in the canvas, so it never moves the bar. Type part of
   a name and it lists matching sources (by name or endpoint), assets (by name or kind), groups (by name) and points (by name or address), each with the icon of its node. Every word you type must appear; names that start with
   it come first, then names with a word that starts with it, then the rest. At most 50 are listed, and `N more` says how many are
   not. Up and Down move through the list, Enter chooses, and Esc, or a click outside, closes the card and puts the focus back where
   it was. Choosing a result opens the source and group it sits in when they are closed, glides the view to it (zooming in to at
   least 75%, never past 100%) and outlines it in the accent colour for about 1.5 seconds. Find reaches what the canvas has put away: for
   a point past the first 50 of its group it shows as many more pages as it takes to draw that point; for an asset inside a folded asset it
   shows the folded assets above it; for a source, group or point that **Unmapped only** hides it turns the switch off first, with a
   message (`Unmapped only is off so LVP01 can be shown.`). If drawing a point would take more than 600 nodes, the group opens on the
   page it has and a message says to go on with **Show 50 more**, for example `LVP01 has 6,000 points; the one you chose is too far down
   to draw at once. Showing the group: use Show 50 more to go on.`; when opening the source would draw too many nodes because its groups are already open,
   those groups are closed first and the message says that. Elsewhere on the page, Ctrl+K is still the top bar's **Quick find**.

   **Keys on the canvas.**

   | Key | What it does |
   |---|---|
   | Ctrl+K, or Cmd+K (the canvas, or anything on the bar above it, has the focus) | Open Find; anywhere else on the page it opens Quick find |
   | `?` on the canvas (not while typing in a field) | Open the list of keys and controls; the same as the keyboard button in the bar |
   | Shift-drag | Draw a selection box |
   | Ctrl-click, or Cmd-click | Add a node to the selection or remove it |
   | Alt, or Option, held when you start a drag | Move the node alone, without its children |
   | Menu key, or Shift+F10 | Open the actions of the focused node; elsewhere in the canvas, the canvas menu |
   | Up, Down, Home, End, Enter in a menu or Find | Move, jump, choose |
   | Arrow keys on a node that is not selected, on **Show 50 more**, or on the canvas | Move to the next, previous, parent or first child node (Down or Right on the canvas goes to the first node); on a selected node they move it instead (8 px with Snap to grid on, 5 px without) |
   | Enter on a source, a group or an asset with sub-assets | Open or close it; on **Show 50 more** it shows the next 50 |
   | Space on a node (Enter too on a point, an asset without sub-assets and an unidentified service) | Select it |
   | Esc | Close the open value card, keys list, menu or Find card (one layer at a time), then clear a selection (on a selected node it clears the selection and the focus stays on the node) |

   **Reduced motion.** When your system asks for less motion, the camera moves at once, the green dot does not pulse, the edges do not
   flow (they keep their dashes) and the Find outline does not pulse (it still shows for 1.5 seconds). The path highlight needs no
   setting: it never fades, so lit and dimmed nodes always change at once.

   **The hint under the title** is one sentence, `Dashed means discovered, solid means assets. Drag a group onto an asset to map it.`
   The `?` that used to follow it is gone: the keys and controls are in the **Keyboard shortcuts and controls** button in the bar
   (or the `?` key on the canvas), which opens a small list in six groups: Move and select, Camera, Find, Menus, Mapping and Navigation,
   with the keys drawn as key caps. It is not modal, so the page behind stays usable; Esc, Tab, a click outside, a scroll or a resize
   closes it; when Esc or Tab does, the focus goes back to where it was before (the button, or the canvas when the `?` key opened it).

   Each source node says when a scan last found it (`Seen in scan #6, 10 min ago`), or `Added by hand` for a source you made
   yourself, or `Not seen in a scan yet`. A scan only adds sources and refreshes their points; it never removes one, so a source
   whose device is gone or moved, or that you deleted on Sources, stays or comes back until you remove it here
   ([Devices that move or disappear](devices-that-move.md)).

   **Removing leftovers** (needs `discovery.edit`). A discovered source with nothing mapped has **Remove from Discovery…** in its `⋯` menu
   (`Source actions for <name>`, or a right-click on the source; it is no longer a button on the card), and **Clear unmapped (N)** in
   the bar's **More Discovery actions** menu removes every such source at once. Both ask first, in the same delete dialog as everywhere
   else, and name the sources: the dialog lists the first five and says how many more. When the dialog closes, the focus goes to
   **Refresh** after a single removal and back to the **More Discovery actions** button after Clear unmapped (to the page itself when
   nothing is left on Discovery). Removing takes the source, its points and their places on
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
   on empty canvas and a bar offers `Create asset "LVP01" from this cluster?` with a **Create asset…** button, which opens
   **New asset** (below) for a role that may make assets, or else the same dialog with
   a new asset named after the cluster and a parent of your choice; the bar stays until you use or
   dismiss it. The same dialog opens from keyboard-reachable buttons, for admins only: **Map…** on
   unmapped clusters and unmapped points, **New asset…** on clusters (and in the menu of an unmapped point). The Ungrouped bag and fully
   mapped clusters get neither. After **Create mappings** a toast says `Mapped 6 points to Room 1.` (see **The Undo after mapping**).

   **Create assets for N groups…** in a source's `⋯` menu or right-click menu (needs `discovery.accept`) is the click path for a whole source. It opens
   one dialog with one parent asset (or the top level) and a row per group that can become an asset: a tick, the asset's name (the
   group's name, which you can change), the number of points and what the scan guessed for each point, such as `energy_kwh ×0.001`.
   **Create N assets** then makes them one after another, each the way New asset… on that group would. A name already used under
   the chosen parent, or twice in the batch, is shown before anything is sent and holds the button back until you change it. A group
   the server still refuses (a point mapped elsewhere in the meantime, a name taken in another tab) is marked with the server's reason
   and stays in the list; the others are created. The guesses are the scan's: look them over before you press Create, because they
   cannot be changed here. To change a metric or a scale first, use New asset… on the group. The Ungrouped
   bag, groups that are fully mapped and groups where every point needs a decision are left out (the dialog names the last kind), and
   a point whose metric repeats another one in its group stays unmapped, as the row says. The menu item is missing on a source with no
   such group.

   **The Undo after mapping.** The toast after **Create mappings** reads `Mapped 6 points to Room 1.` and, for a person who holds
   `assets.edit`, carries **Undo** for 10 seconds (hovering the toast or focusing it holds it). The toast of **Create N assets** keeps
   its own words (`Created 3 assets`, or `Created 2 of 3 assets` when a group failed) and carries the Undo for the mappings that were
   made. A role with `discovery.accept` but not `assets.edit` maps and gets the same toast with no Undo. Undo takes off the mappings that
   step made, each only if it is still on the asset it was made on (one that was moved since is named and left alone), and it never
   deletes an asset: an asset the step created stays, because it may have gained sub-assets or rates meanwhile, and the toast says so,
   `Unmapped 6 points. Room 1 stays; delete it from Assets Tree if you do not need it.` The source stays enabled, as mapping left it
   (item 4), and the collector goes on polling it.

   **Unmapping and moving** (needs `assets.edit`). A mapping can be taken off its asset, or moved to another asset, without leaving
   Discovery: with the `Mapping actions for <name>` button of a mapped point or group, from the right-click menu, or with `Unmap
   everything from <source>…` on an asset, which takes off every point of that source mapped to that asset. **Unmap…** asks first,
   `Unmap "Active power" from Room 1?` (`Unmap 6 points from Room 1?` for several, `from 2 assets` when they stand on two), and says
   that billing for months that are still open is recalculated without the points, that closed months keep their billed figures, and
   that charts and dashboards show the asset without them. **Move to another asset…** opens a dialog with a **Move to** choice of
   assets (the asset the mappings are on now is left out) and the matching sentence, `Billing for months that are still open is
   recalculated with them under the asset you choose; closed months keep their billed figures.` **Move** stays off until an asset is
   chosen, and while the choice would give that asset the same metric twice, `"Active power" would clash: Room 1 already has that
   metric.` (an asset may have any number of `custom` mappings). Points, scans and sources are not touched. The asset page and the
   Points page have the same two actions ([Assets and kinds](assets-and-kinds.md#taking-mappings-off-an-asset-or-moving-them)).

   The work is done one mapping at a time, in the order shown, and each mapping is read from the server first. The first request that
   fails stops the rest, and the toast says so in words: `Moved 2 of 5. "Voltage" could not be moved: The asset already has that
   metric. 2 were not tried.` If the server gives no answer to a request, the toast says that mapping `may or may not have been`
   unmapped or moved, so look at the asset before you try again. A mapping that was moved to another asset after the question was
   shown is not unmapped (`"Voltage" was moved since, so it was left alone.`), and one that is already gone counts as done, not as an
   error. While one change is running a new Unmap or Move is refused with `Still working on the last change.` When the change
   worked, even in part, the toast carries **Undo** for 10 seconds; at most three toasts show at once, so a fourth change in quick
   succession pushes the oldest toast, and its Undo, out. **Undo** of an unmap makes each mapping again with the point, asset,
   metric, scale, interval and custom unit it had (it is a new mapping, with a new number); if a point was mapped again meanwhile it
   stops there, says `It is mapped again, or the asset already has that metric.` and counts what it put back. **Undo** of a move puts
   each mapping back on the asset it came from, but only if it is still on the asset the move put it on; one that has changed since
   is named and left alone (`"Voltage" was changed since, so nothing was undone for it.`). The Undo does not depend on the page, so
   it works if you have gone elsewhere in the app. Each unmap is one `mapping.deleted` audit entry, which also records `scale`,
   `interval_seconds` and `custom_unit`, so the entry alone is enough to make the mapping again once the toast is gone.

   **Rooms and halls.** Meters usually belong to a panel or a rack, not to the room around them. When the asset you map to (in
   **Review mappings**, under **Existing asset**) or move to is a place, a note under the choice says `Room 1 is a room; meters
   usually belong to a Panel or Rack. Map here anyway?` (`Move here anyway?` in the Move dialog). A place is an asset whose kind has
   the site, building, hall, room or row icon on the Asset kinds page, or, for a kind that is not on that page, whose name suggests one
   (the same guess that draws its icon); a rack is not a place. It is only a note: nothing is blocked, and its space is reserved, so
   the dialog does not jump when it appears.

   **New asset, with the real form** (needs `assets.edit` and `assets.view`). **New asset…** on a group, on an unmapped point (its
   menu) and on empty canvas, **New sub-asset…** on an asset and the + below open the **New asset** dialog, the same form as Add asset
   on the Assets Tree: name, parent, kind and icon, saved with the same toast, `Asset created`, and a kind typed under Other… is added
   to the registry if you may manage kinds (`assets.kinds`). Name starts as the group's or the point's name, and Parent as the asset
   you pressed **New sub-asset…** or the + on (none otherwise). Empty canvas and an asset only make the asset. For a group or a
   point the **Review mappings** dialog opens next on the new asset, to choose the points (the group's or point's **New asset…** also
   needs `discovery.accept`), and the New asset dialog says so before you save: `Next you choose the points to map. Cancel keeps the
   new asset.` Saving makes the asset at once, so cancelling the Review leaves the new, empty asset in the tree; delete it from the
   Assets Tree if you do not want it. While the asset list is still being read the items are greyed out, and a click is answered by a
   message. A role with `discovery.accept` but without `assets.edit` and `assets.view` keeps the older way: the Review's own **New
   asset** choice, with a name and a parent only.

   **The + on an asset.** An asset node has a small round + at its top right corner (not the arrow or the + that opens a source or a group; needs
   `assets.edit` and `assets.view`). It shows while the pointer is on the node, while the node or the + has the keyboard focus (Tab to
   the node, then Tab again) and while the node is selected. Click it, or press Enter or Space on it, and **New asset** opens with
   that asset as the parent. You can also drag from it and let go on empty canvas: a dashed line follows the pointer and the same
   dialog opens. Letting go over a node or a control does nothing, and no edge is ever made by hand. A touch screen cannot drag from
   it; tap it, or use **New sub-asset…** in the node's menu. A screen reader reads it as `Add a sub-asset under <asset>`.

   **Several points at once.** Select unmapped points of one source (Shift-drag a box, or Ctrl-click) and drag them together onto an
   asset: one **Review mappings** dialog opens for all of them (`6 unmapped points from Plant OPC`) and they are mapped in one
   request. If a selected point is already mapped, or the points come from two sources, nothing opens: a message says why (`2 of the
   selected points are already mapped. Unmap them first, or select only unmapped points.` or `These points come from different
   sources. Select the points of one source at a time.`) and the nodes go back to where they were. A selection with a group, a source
   or an asset in it is only moved, as before. Needs `discovery.accept`.

   **Who may do what.** Mapping (**Map…**, the drop, **Review mappings**, **Create assets…**) needs `discovery.accept`, and the page
   itself `discovery.view`. Unmapping, moving, Undo and everything that makes an asset (**New asset…**, **New sub-asset…**, the +) need
   `assets.edit`, and the New asset form also `assets.view`, because it lists the assets; a custom role may hold either side without
   the other. The page only hides what a role lacks: each route checks the permission itself and answers 403.
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
   sources (create, edit, delete, test, test all, browse; an edit that changes the host or port of an OPC UA or simulator source that remembers its server also
   records `identity_cleared`; a move and its Undo are `source.moved` and `source.move_undone`), removing unmapped discovered sources (`source.deleted`, `unmapped_only`), tariffs, dashboards, asset kinds (a delete that moves assets records how many and
   where to; adding the starter kinds records which), scopes, scans (start and
   finish), accepted discoveries, a tag list and its Undo (`tags.mapped`, `tags.unmapped`), a file import (`readings.imported`: counts,
   never a value), import profiles (`import_profile.saved`, `.deleted`) and a requested fill (`history.fill_requested`). Never recorded: passwords and password hashes, source secrets and
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
`discovery.edit`, Create assets… `discovery.accept`; unmapping, moving, the Undo and making assets from Discovery need `assets.edit`);
see [Roles and permissions](roles-and-permissions.md).

For scripts: `DELETE /api/discovery/layout` (`discovery.edit`) removes every saved node position and answers 204; calling it again is
harmless, it writes no audit row, and `PUT /api/discovery/layout` still saves positions afterwards. It is what **Tidy layout** sends.
`GET /api/mappings/{id}` (`assets.edit`) answers one mapping with every stored value (`point_id`, `asset_id`, `metric`, `scale`,
`interval_seconds`, `custom_unit`) or a 404 `mapping not found`; unmapping, moving and their Undo read it before they write.
`DELETE /api/mappings/{id}` still answers 204.
`GET /api/mappings/{id}/latest` (`assets.view`) answers the last reading of one mapped point and is what the value card on a
mapped point in Discovery asks for: `mapping_id`, `value` (already multiplied by the scale), `unit`, `ts`, `quality`, `age_seconds`
(by the database's clock) and `stale` (the same rule the dashboard widgets use). A mapping nobody has read yet answers `value`, `ts`,
`quality` and `age_seconds` as `null` and `stale` as `false`; an unknown id is a 404 `mapping not found`. Each asset in
`GET /api/discovery/graph` now also carries `icon` (the chosen icon, `null` for Automatic) and `kind_icon` (the icon of its kind in
the registry, `null` when no kind matches), the same two fields `GET /api/assets` serves.
Removing discovered sources is `POST /api/discovery/sources/remove` with `{"source_ids": [...]}`, 1 to 500 ids in a
request (more is refused with a 422). It answers which sources were removed and which were skipped, each with the reason `mapped`,
`manual` or `gone`, and refuses with a 409 and removes nothing while a scan is queued or running. Each scan in `GET /api/scans` carries
the `targets` and `ports` it covered, and each source in `GET /api/discovery/graph` a `last_scan` (`{scan_id, at}` of the newest scan
that found it, or `null`).

## History and backfill

Some sources keep their own history and can answer "the values between 10:00 and 14:00". The platform uses that to fill the holes an
outage leaves: when the collector was down, or the source could not be reached, it asks the source afterwards for the readings of that
time. It asks the source's Historian read-only. Only GET requests are sent, and the connector interface has no way to write.

**What reads history today.** No connector for a named Historian product exists yet, because nobody has confirmed which product it will
be. The one connector that can read history is `simulator` (HTTP), and what it reads is the **stand-in Historian**: a second server of
the simulator process on port 9100, in the dev profile only (`http://simulator:9100` inside the stack, `127.0.0.1:9100` from the host,
the same API key as the plain simulator). That is how the feature is tested. OPC UA and Modbus sources keep no history that can be
read, so for them nothing happens. A scan offers port 9100 only when you add it to the scan's ports (the connector's own default is
9000); the stand-in answers the same probe as the plain simulator. A `simulator` source that points at port 9000, the plain simulator,
has no history interface: the first request is answered "not found", the status becomes `not_supported`, and the platform waits a day
before it asks again. That wait is kept when you change the source's URL to port 9100, so the next automatic try can be a day away; the
fill command (below) does not wait.

**What is filled.**
- Holes after an outage, and values the source stored late. Each cycle asks for everything after the point where the last cycle was
  answered (the mark, kept in the database, so it survives a restart). After an outage exactly the outage is asked.
- At most 7 days back (`DCDASH_HISTORY_LOOKBACK_DAYS`) and never further back than two days inside the raw retention. The first time a
  source is seen, those 7 days are fetched in one catch-up.
- Only after a point's first reading, meaning its first hour in the hourly rollup. A parent asset counts a meter from that hour on;
  filling earlier hours would change the past figures of every asset above it.
- Only mapped points of enabled sources. The automatic fill skips a source that is switched off; when you switch it on again, the next
  cycle fills the time it was off, within the 7 days.

**What is never filled.**
- Anything older than the raw retention minus a day (29 days with the default of 30). Older days exist only as rollups, and rewriting a
  rollup over raw readings that are gone would delete real history. See [Storage](storage.md#filling-older-gaps).
- Anything before a point's first reading, unless the fill command is told `--before-first-reading` (its dry run then says in plain
  words that it changes the past figures of the assets above).
- The frozen figures of a closed month. A fill into a closed month stores the readings, and the month keeps the figures it was closed
  with; the Billing page of that month says that today's figures differ ([Closing a month](dashboards-and-billing.md#closing-a-month)).
  The journal gets one `history.closed_month` event per month and cycle.
- Anything more than five minutes ahead of the platform's clock.

**How politely it asks.** One request at a time per source, at most 30 requests a minute (`DCDASH_HISTORY_RATE`), at most 20,000 rows
expected in a request (`DCDASH_HISTORY_MAX_ROWS`) and at most 200 addresses. When a request times out, finds the source unreachable or
is answered "too many requests" (429) or "not available" (503), the platform waits 30 seconds, then 60, then 120, or longer when the
source asks for longer (`Retry-After`, up to 15 minutes), and tries again. A source that asks for more than 15 minutes ends the cycle
at once, and the wait it asked for (up to a day) becomes the time of the next try: the platform does not sit through it holding the
source's lease and a database connection. After three tries the cycle ends and the source is left alone for 4 minutes, then 8, then
15 minutes, as long as it keeps failing. A connector that breaks on an answer (anything that is not its own error) counts as a bad
answer, like a malformed one. A source that refuses our credentials is left alone for 15 minutes;
a source that has no history interface, for a day. Each hour is asked for at most twice: once as it arrives, and once more 3 hours
later (`DCDASH_HISTORY_REREAD_HOURS`) for values the source stored late. An hour that was answered is not asked again whatever it
holds. A Historian that stores only on change leaves some hours thin for good; the status counts them as short hours, and asking again
every cycle would be a flood. A group of points that three tries in a row could not read is set aside and journaled, so one bad
address cannot hold a whole source for ever.

**A reading already stored is never changed.** The first value of a point at a time wins. Since migration 0016 the database itself
refuses a second copy of the same point and time ([Upgrading and going back](upgrading.md#migrations-in-order)). A reading that arrives
again with the same value and quality is counted as already there. One that arrives with another value or another quality is
differing: the stored value stays, the new one is dropped and counted, and the journal gets a `readings.conflict` warning (one per
source and 10 minutes, with the counts added up). A re-read of a window the live poll already stored therefore adds nothing, as long as
the live value carries the source's own time ([Adding a connector](adding-a-connector.md#reading-history)).

**Quality.** Only a good reading counts. Uncertain, substituted, interpolated, bad and unknown quality codes are stored as bad
quality: kept as evidence, left out of every figure. An uncertain kWh must not reach a bill unseen. If a real Historian marks normal
data as uncertain, those readings are missing from the figures. Mapping a source's own quality codes is planned, not built; the
platform does not change what it counts.

**Units and times.**
- A reading keeps the source's own unit and value. The mapping's scale converts when a figure is computed: W, kW or MW for power, Wh,
  kWh or MWh for energy. Another metric takes only its base unit (V, A, Hz, kvar, kVA), and a different spelling is refused with a
  sentence rather than guessed.
- Times are stored as UTC. A time with an offset is converted. A time without one is accepted only when the tag declares its zone;
  a local time that does not exist (the clock skipped it) is refused and counted. The repeated hour of the autumn clock change is told
  apart by order: the first pass, then the second one. When order cannot tell, the reading is refused and counted.
- An interval value (energy per period) that is stamped at the end of its period moves back by the period, so 23:45 to 24:00 lands in
  the right hour, day and month.
- A counter that resets or rolls over is stored as it is. The energy engine reads a decrease as a reset, and the energy between the
  last value before and the first value after is not counted, as for live readings.

**Power-only meters and thinning.** A meter with no energy counter is estimated from its power samples (samples times the mapping's
interval), and the energy of an hour of a counter is its last value less the last value before it. A history that is denser than the
mapping must not add samples to an hour the poll already covers, or the estimate would move (and a counter's last value of the hour
would move from the poll's last stamp to the history's, shifting energy between hours). So the history of every point is thinned, an
energy counter as much as any other. A history sample is kept only when no stored good sample of that point lies within one whole
mapping interval of it, and it is at least 0.9 of an interval after the previous sample kept. So a hole of two intervals or more is
filled, while a poll that merely drifted (two samples 6 minutes apart on a 5-minute mapping) is not: that would move the estimate of
an hour the poll already covers. Holes fill at the mapping's density and a covered hour never changes. A sample at a time that is
already stored is not thinned; it is counted as already there or differing. Samples thinned away are counted as rejected.

**The newest minutes belong to the live poll.** The automatic fill asks up to one mapping interval and a minute before now (the longest
interval of the source's mapped points), not up to now. The live poll stores its own sample of the newest minutes first, so the fill
never stores the sample that a poll which drifts by a minute is about to store, and the poll's own copy is not counted as already
there (which would also skip the update of a live widget). A source whose poll is down is filled one interval and a minute later.
The second look, 3 hours later, is not held back. A fill by hand asks exactly the range it was given.

**Where to see it.**
- The Diagnostics report: a `history:` line per source in SOURCE HEALTH, for a source that has run at least one cycle
  ([Field debugging](field-debugging.md#history-fill)).
- `GET /api/sources/{id}/history` (permission `sources.view`): `supports_history`, `state` (`never_run`, `idle`, `filling`,
  `backing_off` or `not_supported`), the two marks (`answered_through`, `reread_through`), the times of the last cycle, the last success
  and the next try, `short_hours`, the totals since the collector started (`rows_new`, `rows_already`, `rows_differing`,
  `rows_rejected`, `requests`, `failures`) and the scrubbed `last_error`. An unknown source is a 404; a source that never ran answers
  `never_run` with empty values.
- The journal: `history.filled`, `history.failed` (written when trouble begins, then at most every 15 minutes), `history.closed_month`
  and `readings.conflict`. [Operating the stack](operating.md#background-history-fill) has the settings and the loop.

**Fill a range by hand.** The command runs inside the `api` container and asks the source for one explicit range:

    docker compose exec api python -m dcdash.ingest.backfill --source 3
    docker compose exec api python -m dcdash.ingest.backfill --source 3 --start 2026-10-14T00:00:00+00:00 --end 2026-10-15T00:00:00+00:00 --yes

Without `--yes` it is a dry run: it prints the windows it would ask and the rows it expects, and it asks nothing and writes nothing.
With `--yes` it fills, always refreshes the rollups over what it stored, and ends with one line:

    12,480 rows read, 12,000 new, 480 already there, 0 differing, 0 rejected

Without `--start` and `--end` the range is the lookback window. The range must lie inside the raw retention minus a day and must not
end in the future. The command takes the same per-source lease as the loop, so it refuses while the loop works on that source; it never
moves the marks, so the loop is not disturbed. A source whose connector cannot read history is told so and nothing is done. More in
[Field debugging](field-debugging.md#history-fill).

**Fill an older range from the Sources page.** **Fill older range...** in the row menu (`sources.edit`; only for a connector that keeps
history, today the stand-in). Choose the first and last day (at most 31 days, none older than the raw retention minus a day), press
**Check range**, then **Start fill**, which queues it in the collector; the dialog follows it. One fill
runs at a time in total. A collector restart fails a running fill; run it again and it adds only what is missing. The line under the
source's name reads "History: not started yet", "filling, 3 hours behind", "up to date, last fill 3 min ago" or "waiting, `<error>`"
("Filled by importing files" for `file`, nothing for a connector without history).

**Decisions that are still the owner's.** Until the owner decides, the safe default is in force.
- A reading stored twice makes the update to migration 0016 refuse, with nothing removed ([Upgrading and going back](upgrading.md#duplicate-readings)).
- Only good quality counts.
- A closed month receives the readings and shows that today's figures differ.
- Interval energy (energy per period, not a counter) waits for the answer. Such a tag is stored as it comes, and it must not be
  mapped as an energy counter: the counter maths would read every period as a reset. The meter kind that sums periods is not built.

Measured numbers: see below.

### Measured against the stand-in

Measured in wave w30 against the stand-in with 217 meters (449 tags, one sample a minute), on a machine that was busy with other work
(the times are about 2 to 4 times worse than an idle machine; the request and row counts do not depend on load):

| Measure | First fill, 6.5 days | Afterwards (default pace) |
|---|---|---|
| Requests to the Historian | about 325, all `GET /history`, at most 200 addresses and 20,000 expected rows each | 36 an hour (3 for the new minutes and 3 for the one late-pass hour, every 10 minutes) |
| Rows received | 4.2 million (about 92 bytes each as JSON, about 390 MB) | about 54,000 an hour (5 MB) |
| Time | 18 minutes (10 minutes on an idle machine) | a few seconds a cycle |
| Stored | 4.18 million new readings, 2.5 MB to 508 MB of database (about 121 bytes a reading with both indexes) | almost all "already there", late data as new rows |
| Collector | CPU at most 49 percent, memory 115 MB | idle between cycles |

A Historian that answers 503 to every fifth request and 429 above 2 requests a second still finished its 24-hour range (10 minutes,
12 and 10 failed requests, all retried after their back-off, none lost, no storm). A restart of the collector in the middle of a fill
resumes from the saved mark: 77 more requests after the restart instead of about 125 from the start. The live poll of a second source
(every 5 seconds) was delayed by at most 0.5 seconds during the fill. A 2,000-meter run was not made; the numbers scale with the number of addresses (about 10 times the
requests and rows of the 217-meter case).

## Importing readings from a file

A source's row menu can load a CSV export (**Import file...**, `readings.import`) and map its tags in one go (**Map tag list...**,
`discovery.accept`). The questions for a reviewer and a first-day how-to are on [Historian integration](historian-integration.md).

**The `file` source.** Type `file` is never polled: it reads "filled by file import", not online or offline, has no **Test**,
**Check connection** or **Browse**, and **Test all** leaves it out. The freshness chip and the fleet "stale" mark go by the age of an
asset's newest reading, so an asset fed only by imports turns stale three mapping intervals (at least a minute) after its newest
imported time. An import may also target a live source whose tags have the same names.

**Import file...** **Check file** is a dry run (nothing is written or audited); **Import N rows** then stores that same file. A profile,
saved by name (at most 20), names the tag, time, value and optional unit and quality columns, the delimiter, decimal mark, time format
and zone, what a value is (counter, power or amount per period) and the good quality codes. The report is one sentence,
`12,480 rows read, 12,000 new, 480 already there, 0 differing, 0 rejected, 3 unknown tags (TAG-A, TAG-B, TAG-C)`, with rows read = new +
already there + differing + rejected + rows of unknown tags. Already there: stored with the same value. Differing: another value is
stored and stays. Rejected: refused, counted by reason.
- An import never creates a point. The first stored value of a tag and time wins, so a file repeated is safe; the same tag and time twice
  in one file is rejected after the first (so is a line repeated in the hour the clocks go back, and that hour's genuine second pass
  with the same value). An import cannot be undone.
- A quality other than good is stored as bad quality (counted in "new") and counts in no figure.
- Rows in a closed month are written; its frozen figures do not change. A time older than the raw retention minus a day, or more than 5
  minutes ahead, is refused; so is one in a stretch whose raw readings the retention removed while it kept the summaries
  (`older_than_stored_raw_readings`; no later rise of the retention or fill reopens it, and a row after it is stored even when no raw
  reading is left). A value is stored as written (the mapping's scale converts it for a figure); a unit column is only checked.
- Also refused: energy per period (`interval`) for any metric but `custom`, and a row with a filled cell beyond the header. Energy counter
  readings that fall or jump are listed as a warning and stored; a wrong stored row is repaired by hand with SQL. Unknown tags with
  non-ASCII letters read `[non-ASCII]`.
- Limits: 20 MB, 500,000 rows, 4,096 bytes a line, 50 columns, UTF-8. One import at a time. An upload that stops for 30 seconds is cut
  (408); the import, tag list and Undo refuse a request from another site (403).
  A closed tab does not stop an import; a shutdown does, and may lose its audit row. Command line and the repair:
  [Field debugging](field-debugging.md#importing-a-file-by-command).

**Map tag list...** A CSV with `tag`, `asset` (a path such as `Hall 1 / Row A / Rack 01`) and `metric`, optionally `unit`, `scale`,
`interval_seconds`, `kind` (of an asset it creates) and `reading`; at most 1,000 lines. For a `file` source, every power line
(`active_power_kw`) needs `interval_seconds`: the export's spacing in seconds (3600 for an hourly file), as a power reading becomes
energy by its spacing. **Check list** is a dry run naming what it
would create and every problem by line; it is all or nothing, one problem line creates nothing. Missing assets are created only with
**Create missing assets** ticked. Points are created on `file` sources only; elsewhere an unknown tag is a problem (run Browse first).
**Create N mappings** goes through only on a check of the text now in the dialog. **Undo** is offered for 10 seconds in the toast and
for 24 hours as **Undo this tag list** in the Audit drawer. It removes the mappings, the assets the list created and the points that
hold no readings (a point with readings stays, unmapped). It refuses, undoing nothing, if a mapping was edited or a created asset
was renamed, moved or given a child, another mapping or a tariff; an edit of a created asset's kind, icon or sort order is not noticed.

Related: [Assets and kinds](assets-and-kinds.md), [Storage](storage.md), [Install and run](install-and-run.md), [Field debugging](field-debugging.md), [Adding a connector](adding-a-connector.md)
