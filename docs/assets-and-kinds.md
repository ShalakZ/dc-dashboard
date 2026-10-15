# Assets and kinds

This page is for the people who build and maintain the asset tree: the hierarchy of sites, rooms, panels, meters and equipment that
dashboards, billing and tariffs hang from. It covers asset kinds (what each kind of asset looks like, and the Asset kinds page) and
moving assets in the Assets Tree, including what a move does to billing.

## Asset kinds

A kind says once what each kind of asset looks like. An asset shows its own icon if it has one, else the icon of its kind, else the
generic one. That icon is the one in the tree, in the page title and beside each asset's name in the trail above an open asset. Change a kind's icon and every asset of that kind follows; rename a kind and the assets that carry the name follow it. A
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
  picks it, **Shift+Arrow** extends the range, **Escape** clears. The open asset's row has a bar on its left, a bold name and an
  accent-coloured icon, and no tint; a picked row has a tint and a frame; an asset that is both shows both. The line between the filter and
  the rows says "N picked" with **Move to...**, **Delete** and **Clear**. **Delete** is there only for someone who also holds **Delete
  assets** (`assets.delete`) and only while something is picked (see [Deleting several assets](#deleting-several-assets)). The count does not include
  the open asset unless it is picked too: the count's tooltip says "The open asset is not counted unless it is also picked", and a screen
  reader hears "The open asset, Pump 3, is not counted". With nothing picked the line shows a hint, and a **Move to...** button for the open
  asset, which is the way for a tablet. In a narrow tree column (276 px or less, which includes the narrowest, 220 px) the line is two lines
  high for someone who sees **Delete**: the count (or the hint, shortened there to "Ctrl-click to pick") and **Move to...** share the
  first line, and **Delete** and **Clear** are on the second; it is two lines whether or not anything is picked, so no row jumps when
  you pick the first one, and everyone else keeps one line. Ctrl-click does not open an asset in a new tab here; the
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
  every date a rate starts, past and future, so a past day is flagged only if the rate the new place gives on it differs from the old one. A reorder inside
  one parent and a move between two places that bill at the same rate on every one of those dates never ask (nor does an asset whose own
  rate covers them all). The rules are in [Which rate applies to a day](dashboards-and-billing.md#which-rate-applies-to-a-day).
- **Billing follows the tree.** Cost is worked out from the live tree on every request, so a move re-bills **past periods** at the new
  place, not only from today. A past day's cost changes only if the rate the new place gives on that day differs from the one the old place gave; a rate in effect on the
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

## Deleting several assets

Pick the assets as for a move, then press **Delete** in the line above the rows. It needs both **Change assets** (`assets.edit`, which
picking needs) and **Delete assets** (`assets.delete`); a person with only the first sees no Delete, and the server answers 403 to a delete
from them. A single asset is still deleted from its own page, and the bar's Delete never acts on the open asset unless it is picked too.

- **The dialog.** "Delete 3 assets?" opens at once and asks the server what the delete takes with it (the same impact check as the single
  delete). It lists the first 8 picked names and "and N more" for the rest, then what else goes with them, added up over the picks: the
  sub-assets nobody picked, the mappings and the tariffs. When anything beyond the picks goes, the button reads **Delete anyway** and the
  billing warning is the single delete's own: `5 assets, 2 mappings and 1 tariff will be deleted; their past energy and cost figures disappear
  from Billing and dashboards.` The dialog always ends with "This can't be undone." (the names and the notes are one paragraph, the billing warning and that sentence the next) A pick that sits inside another pick gets a note,
  `LVP02 is inside Data_Hall_1, which is also picked, so it goes with it.` (the first three, then "and N more are inside other picked assets,
  so they go with them"). Picks that the filter hides are still deleted, as they are still moved; the dialog names them.
- **Only top-level picks are sent.** Deleting an asset deletes everything below it, so a pick inside another pick goes with it and is not
  sent on its own. Each top-level asset is deleted by its own request (`DELETE /api/assets/{id}`), one after the other, with the counts the
  dialog showed. If a branch grew in the meantime the server refuses that request; when nothing has been deleted yet the dialog stays
  open, shows the new numbers and asks you to confirm again.
- **A stop is honest.** The first asset that cannot be deleted stops the rest. An error toast says how many assets went and which one
  failed and why, for example `Deleted 2 assets. "LVP03" could not be deleted: More was added under it since the numbers were shown. 1 was not
  tried.` The assets that failed or were not tried stay picked, so you can look and try again. An asset that someone else deleted
  meanwhile is not a failure: it counts as already gone and the rest go on. If a pick was already gone when the dialog opened, the dialog
  cannot be confirmed (only Close), says so, and the tree refreshes; pick again. The same happens when the tree changed under the picks
  since this tab last loaded it (someone else added, moved or deleted something: the dialog reads the asset list again while it opens and
  compares it with what you picked): "The tree changed while you were picking. It has been refreshed; pick again."
- **Counts.** At most 100 top-level assets go at once (a picked branch counts once); above that no dialog opens and a toast asks you to pick
  fewer. The success toast, `Deleted 3 assets`, counts the assets the dialog showed, branches included; the audit log has the exact number:
  one `asset.deleted` entry per top-level asset, with its name and the counts of its sub-assets, mappings and tariffs.
- **Afterwards.** The focus goes to the first row left after the first deleted one (else the last row before it, else the filter), without
  scrolling the page; after Cancel, or when some assets stayed, it goes back to the Delete button. If the open asset was deleted, or sits inside a deleted branch, the page moves to the parent of that deleted branch (the Assets
  Tree itself when it was a top-level asset), at once and not at the end. The tree, the fleet summary, Billing, dashboards, tariffs and
  sources refresh when the last request is done.

Related: [Sources and discovery](sources-and-discovery.md), [Dashboards and billing](dashboards-and-billing.md), [Roles and permissions](roles-and-permissions.md), [Screens](screens.md)
