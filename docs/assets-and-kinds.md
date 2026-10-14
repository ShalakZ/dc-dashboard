# Assets and kinds

This page is for the people who build and maintain the asset tree: the hierarchy of sites, rooms, panels, meters and equipment that
dashboards, billing and tariffs hang from. It covers asset kinds (what each kind of asset looks like, and the Asset kinds page) and
moving assets in the Assets Tree, including what a move does to billing.

## Asset kinds

A kind says once what each kind of asset looks like. An asset shows its own icon if it has one, else the icon of its kind, else the
generic one. Change a kind's icon and every asset of that kind follows; rename a kind and the assets that carry the name follow it. A
kind's name is matched in any spelling ("Rack", " rack " and "RACK" are one kind).

**Who may do what.** Everyone who may open the Assets Tree (`assets.view`) can read the Asset kinds page; every change needs
`assets.kinds` ("Manage asset kinds", a sensitive permission: a rename or a move changes the kind of every asset that uses it). The
button at the top of the Assets Tree opens the page.

**In the asset dialogs.** The kind list in the Add and Edit asset dialogs comes from this page, and a new kind typed there under
"Other…" is added here when the asset is saved **if you may manage asset kinds**; without that permission the dialog says so and the
asset keeps the text.

**Icons.** The 48 icons (an asset or a kind chooses one, or Automatic) are in six groups (Structure, Power, Cooling, IT and network,
Monitoring and safety, Other) with a search box that finds an icon by its name, a keyword or its short name ("transfer" finds ATS and
STS). The keyword guess (a word such as Pump or UPS in the kind) only suggests the icon when a kind is created, and stays as the fallback
for a kind text that is not on the list.

### The Starter tag and the filters

Built-in kinds carry a small **Starter** tag. The server decides it (the `starter` flag of each kind) by the kind's name in any
spelling: the ten the install starts with and the 39 of the data-centre set. Every other name is Yours. The tag follows the name, so
renaming a kind can add or remove it, and a kind you create by hand as "UPS" or "Pump" is tagged.

Four filters, **All**, **Starter**, **Yours** and **Unused**, each with its count, narrow the list.

### Ticking several kinds

With `assets.kinds` the table has checkboxes:

- a click ticks a kind; **Shift+click** or **Shift+Space** adds the range from the box last ticked on its own (a range never takes
  ticks away); **Space** toggles;
- the header box ticks every kind shown;
- once something is ticked, the bar shows **Select all unused** (adds the kinds with no assets), **Delete** and **Clear**;
- Clear or Escape takes the ticks away, and so does choosing another filter, so a tick can never hide in a row the filter took away.

### Deleting kinds

A kind that assets still use is deleted by moving them. The row's dialog shows how many assets use it and a "Move the assets to"
choice (Delete stays off until a kind is chosen); the assets, the delete and one audit row happen together or not at all. If the count
changed while the dialog was open the server refuses (409) and the dialog shows the new count.

The bar's **Delete** removes the ticked kinds in one go. The dialog lists them, and when some are in use it asks for one kind to move
their assets to (a kind that is being deleted is not offered, and Delete stays off until one is chosen). Each kind is its own request,
with its own count check and its own audit row, so a kind that went is gone even if a later one is refused. The run stops at the first
request that meets no connection, an ended session, a role that lost the permission or a server that does not answer; a kind somebody
else deleted first counts as gone. A toast says how many went and names the first one that did not, with the reason.

After a delete the focus goes to the next row's menu button, or to the filter in use after several, so the page does not scroll back to
the top.

### The starter pack

- **Add common data-centre kinds** (the header button) adds the 16 most common data-centre kinds: UPS, Battery, PDU, RPP, ATS, STS,
  Switchgear, Transformer, Generator, Chiller, CRAC, Cooling tower, Server, Network switch, Sensor, Fire suppression.
- The quieter **Add all 39 data-centre kinds** beside the filters adds the whole set (Busway, Pump, Router, Data hall and so on as well).

Each adds only what is missing: a kind you already have, in any spelling and with any icon, is skipped and never changed, and pressing
it again says they are all there and writes no audit entry. The route is `POST /api/asset-kinds/starter-pack`, which adds the common
kinds by default and the whole set with `?set=all` (`?set=common` is the default spelled out; any other value is a 422), and needs
`assets.kinds`.

## Moving assets

Anyone who holds **Change assets** (`assets.edit`) can move assets in the Assets Tree: one, or many at once, by dragging or from a
dialog. Without that permission the tree is plain links: no picking, no draggable rows, no `M` key, and the two routes below answer 403.

- **Picking.** A plain click opens an asset, as always, and clears the picks. **Ctrl-click** (**Cmd-click** on a Mac) picks or unpicks a row
  without opening it; **Shift-click** picks every visible row between the last row you picked or opened and the one you clicked (rows hidden
  by a folded branch or by the filter are left out, and a second Shift-click replaces the range). On the keyboard, **Space** on a row's link
  picks it, **Shift+Arrow** extends the range, **Escape** clears. A picked row has a tint and a frame; the open asset keeps its own bar. The
  line between the filter and the rows says "N picked" with **Move to...** and **Clear** (with nothing picked it shows a hint, and a
  **Move to...** button for the open asset, which is the way for a tablet). Ctrl-click does not open an asset in a new tab here; the
  middle button and the browser's menu still do. Picks live only in that browser tab and end when you move, press Clear or open an asset.
- **Dragging.** Drag a picked row to move all the picked rows; drag a row that is not picked to move just that one. The row under the pointer
  shows where the assets would land: the top quarter of a row puts them **before** it (as its sibling), the middle half **inside** it (as its
  last child), the bottom quarter **after** it, except on an open row that shows children, where the bottom quarter means **first child**. The
  dashed area below the last row is the **top level**. Hovering a folded row for about 0.6 seconds opens it; the tree scrolls when the
  pointer nears its edge; Escape cancels. A place that cannot take the assets (into themselves or below themselves, a name already used
  there, nothing would change) is marked with a red dashed frame, says why in its tooltip and in the live line, and is refused if you drop.
  Pick a parent and one of its children and only the parent moves: the child travels inside it. Assets picked from different branches that
  are dropped on one place become siblings there, each keeping its own subtree, in the order they had in the tree.
- **Move to...** is the same move without a mouse. Press **M** on a focused row (or Shift+F10, or the context-menu key) for the picked
  rows, or for that row when none is picked; or press the button in the line above the rows. The dialog has a **Search places** box, **Top
  level**, and every asset as a radio button in tree order; a place that cannot take the assets is greyed out with the reason under it. The
  assets become the **last children** of the place you choose. When you cancel, the focus goes back to where you were; after a move it goes
  to the moved asset's link.
- **The rate warning.** Before anything is written the server is asked what the move would change. Only when it changes **the rate an asset
  is billed at** does a question appear (for a drag, a confirmation titled "This changes the rate"; for Move to..., a message inside the
  dialog, whose button then reads **Move anyway**): `Moving "Pump 3" changes its rate from 0.18 to 0.12 per kWh. Past periods are recalculated at
  the new place, and the totals of both branches change.` With a site currency the rates carry it ("0.18 USD"); when the rate changes only
  on other days than today the sentence reads "changes the rate some periods are billed at", and for several assets it names the first and
  "and N more". Cancel moves nothing and keeps your picks. An asset's rate on a day is the nearest rate in effect on itself or on an asset
  above it (else the site default), so moving an asset into another branch can change which rate applies. The comparison covers today and
  every date a rate starts, past and future, so a past day is flagged only if the new place's rates were in effect on it. A reorder inside
  one parent and a move between two places that bill at the same rate on every one of those dates never ask (nor does an asset whose own
  rate covers them all). The rules are in [Which rate applies to a day](dashboards-and-billing.md#which-rate-applies-to-a-day).
- **Billing follows the tree.** Cost is worked out from the live tree on every request, so a move re-bills **past periods** at the new
  place, not only from today. A past day's cost changes only if the new place's rates were in effect on that day; a rate in effect on the
  move day re-prices that whole day, the hours before the move included. The energy and cost totals of **both** branches change, with or
  without a warning (the warning is only about a changed rate), except for a place with its own meter, whose figures come from that meter.
  Nothing else is rewritten: dashboards, mappings, points and rates point at asset ids, which do not change, and the breadcrumbs, quick
  find and the Tariffs table's paths show the new path at once. To avoid surprises, move assets at a day boundary.
- **Undo.** The toast "Moved 3 assets to Row A" has an **Undo** button for 8 seconds (hovering it or focusing it holds the toast). Undo puts
  every moved asset back under its old parent, in its old place among the siblings that are still there, and is audited as its own batch. If
  something moved since, it is refused with "Something moved since; the move could not be undone" and changes nothing. On the keyboard,
  **Ctrl+Z** (**Cmd+Z** on a Mac) on a focused row undoes the latest move for the same 8 seconds (the button's tooltip says so, and so does the
  tree's live line after a move); only the latest move can be undone this way, an older toast's own button still undoes its own batch.
- **Order.** A drop numbers the new parent's children 0 to n-1 in the order you see them (most assets share the sort number 0 and are
  shown by name, so "before" needs real numbers); the old parent's children keep theirs. Renumbered siblings write no audit row.
- **The audit log.** One `asset.moved` entry for each asset you moved (the dragged assets, not what is below them), with the old and new parent
  by name and id: "Moved Pump 3 from Row A to Row B", "Moved Pump 3 to the top level", "Reordered Pump 3 within Row A", each followed by
  " together with 2 others" when one gesture moved several. The entries of one gesture share a `request_id` (and `moved_with`, how many
  others moved with it) in their details, which the audit drawer shows.
- **One move is all or nothing.** A refusal for any asset refuses the whole request and moves nothing. Two people moving overlapping sets
  at once are served one after the other. At most 500 assets in one request.
- **Not here yet.** Rules about which kind may sit under which (a Rack only in a Row, say), a note on a move, a frozen past, approvals, and
  routing the Edit dialog's Parent field through the same warning (it still moves one asset without it); see the backlog.

### The move API

For scripts, `POST /api/assets/move-preview` (what a move would do: the roots, where from and to, the rates before and after, whether a rate
changes; no side effects) and `POST /api/assets/move` (does it) take `{"moves": [{"ids": [...], "parent_id": 7 | null, "before_id": 12 | null}],
"expect": {...}, "undo_of": "<request_id>"}`; both need `assets.edit`. `parent_id` null is the top level and `before_id` null is "last".
Answers: 200; 422 with `refusals` (each with the asset, a reason in names and a code) when a rule refuses, or with an empty list and
`unchanged` when everything is already there; 409 with `"stale": true` when what the caller saw is no longer true (`expect` is optional: the
page sends the preview's own, so a child added after the preview, a parent that changed or a rate that changed is refused).

Related: [Sources and discovery](sources-and-discovery.md), [Dashboards and billing](dashboards-and-billing.md), [Roles and permissions](roles-and-permissions.md), [Screens](screens.md)
