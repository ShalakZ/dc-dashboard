# Changelog

What each release (a merged wave) changed, newest first. Each section is headed `## <wave> (<date>, <merge commit>)`.

A release that needs an upgrade note carries it as a `###` entry: the schema revision it leads to when there is a migration, what
changes and what you will notice, the pre-checks to run before it, how to verify it, whether its downgrade is lossless (which decides
whether option a of [Upgrading and going back](docs/upgrading.md) is open), and the commit to go back to. 18 releases have such an
entry; 9 of them have no migration. The other releases need nothing beyond the usual steps of
[Upgrading and going back](docs/upgrading.md); they have one or two lines here. Phase 1A, Phase 1C and Phase 2 brought migrations 0001
to 0003, from before the release notes (see [Migrations in order](docs/upgrading.md#migrations-in-order)).

**Before you upgrade,** read every entry between the version you run and the new one, starting at the oldest of them (lower on
this page) and working up. **To go back,** use the commit each entry names ("the code to go back to"): a wave's merge commit in a
heading is NOT a place to go back to, because it already contains that wave.

**The next release** gets its section at the TOP of this page, above the newest one.

## w13 (2026-10-17, 4202012)

w13 (the dashboard widget overhaul) changes how the dashboard widgets look and what they tell you; no figure, unit or rounding a widget
shows has changed. The widgets follow the theme: a card in the app's own colours (light, dark and the four theme colours; the white card
on a dark page is gone), with a 36 px header, small icon buttons (**Details** and **CSV**), and one footer line that holds "since 10:46"
and the marker hint (`~ estimated`, `* partial`, `— no rate`) for every widget type. A cost with no rate now says `— no rate` under a stat
and a table as well, not only under a chart. A card narrower than 200 px (a two-column stat or gauge on a small window) moves its CSV
button into **Details**. The charts use one palette of eight colours measured for contrast in light and in dark (a chart with one series
uses the theme colour; series 6 to 8 are dashed and 9 and later dotted), with the axes, grid, legend and tooltip in the theme's colours;
they repaint after a Mode or Theme colour switch without a reload, and a tooltip line carries the state in words (estimated, partial, no
rate) beside the markers. The gauge is a half-circle arc with the scale ends, the figure, its unit and the asset name under it, so
nothing overlaps at the smallest size (two columns by two rows); a screen reader hears a meter. **Details** opens a right-hand panel
for the widget: what it shows (type, source with its unit, what the figure is, the assets with links to their pages), the time window
with the site time zone, how fresh a latest reading is (for a finished range the hour the last value belongs to, never a made-up second),
what each marker means for this widget, the state of each asset, and for a chart a small table (lowest, highest and the bucket it fell
in, the last bucket, and a total only when it is exact). It never shows an average over buckets, and never a bucket width for a metric
time series, because the server does not send one. Small bugs are fixed: switching an asset off in a chart legend now removes its
min-max band too; the remembered legend choice is kept when an asset gains or loses a `~` or `*`; the grouped bar's no-rate dash sits in
its own asset's slot; a chart has a text alternative and a widget's title is a level 2 heading; the gauge no longer overlaps at two rows;
a card shows a skeleton instead of "loading…". The editor's preview is the same card as the dashboard's, and edit mode has a grip, a
pencil and a bin icon, with the resize handles and the drop placeholder visible in dark. No migration, no backend change, no new
permission, saved dashboards and widgets keep working unchanged. To tweak the look, the tokens are `--widget-pad`, `--widget-head-h`,
`--widget-row-h`, `--widget-radius`, `--widget-shadow`, `--widget-figure` (card density and corners), `--chart-1` to `--chart-8`,
`--chart-band-opacity`, `--chart-grid`, `--chart-tip-bg` (the palette) and `--gauge-width`, `--gauge-track`, `--gauge-fill` (the gauge);
the gauge's arc shape (a half circle) is a code constant. The usual steps of [Upgrading and going back](docs/upgrading.md) are all it
needs; the code to go back to is `b4f295f`. See [Dashboards and billing](docs/dashboards-and-billing.md), [Screens](docs/screens.md) and
[End-to-end tests](docs/end-to-end-tests.md).

## w12c (2026-10-17, 2572801)

w12c (Discovery visual polish) tidies the look of Discovery without changing what it does. The bar above the canvas is one regrouped bar:
on the left four small counts with icons (sources, points, mapped, and **needs credentials** when a source does), then **Collapse all** and
**Expand all** with their menus, **Unmapped only**, **Tidy layout**, then **Find** and **Snap to grid**, then three icon buttons: **Refresh**,
**Keyboard shortcuts and controls** and a **More** menu that holds **Clear unmapped (N)**. On a narrower window the words leave the buttons
one at a time (the icons stay, with tooltips and names for a screen reader), and on a still narrower one **Unmapped only**, **Tidy layout**
and **Snap to grid** move into the **More** menu; the **Find** card still opens at the top right of the canvas. The `?` hint beside the title
is gone: the keyboard button (or the `?` key while the canvas has the focus) opens a small bubble that lists the real controls in groups
with key caps. A source's card is calmer: the protocol icon, a short name (the host and port move to a grey line under it), a status dot
with its word, a bar and the words `60 of 60 mapped`, **Details** as the one visible button, and a **Source actions** `...` button that
opens the same menu as a right-click, where **Create assets for N groups...** and **Remove from Discovery...** now are. Every node has an
icon: an asset shows the icon the Assets Tree shows for it, a group, a point (by its metric: power, energy, voltage, current, other) and a
source (by protocol: OPC UA, Modbus, simulator). The page title has its icon like the other pages, and the **Find** results show the same
icons. Resting the pointer on a **mapped** point (or focusing it by keyboard) shows its last value, for example `51.43 A, 3 s ago`, with
the word `stale` when the reading is older than its interval allows, `No value ... bad reading` when the poll failed, and `No reading yet`
when there is none; a person who may not view assets sees no card and nothing is asked of the server. Behind it: `GET /api/discovery/graph`
now gives each asset its `icon` and `kind_icon`, and a new read `GET /api/mappings/{id}/latest` (needs `assets.view`) gives the value, unit,
time, quality, age and `stale` of one mapping. No migration, no new permission, nothing new in the Audit log. The usual steps of
[Upgrading and going back](docs/upgrading.md) are all it needs; the code to go back to is `bd96e05`. See
[Discovery](docs/sources-and-discovery.md), [Screens](docs/screens.md) and [End-to-end tests](docs/end-to-end-tests.md).

## w12b (2026-10-16, 0909a1e)

w12b (Discovery speed and navigation) makes the Discovery canvas quick on big graphs and adds the tools for working through them. It was
measured first: the slow drag over about 100 to 150 points came from the dashed lines between a group and its points, which are tens of
thousands of pixels long, so a group that draws more than 150 points now draws them solid (nothing else about them changes), and hovering
or opening a group in a graph of about 2,000 nodes redraws only the nodes that changed. New in the bar above the canvas: a small arrow
beside **Collapse all** and beside **Expand all** opens a menu to close or open only the **selection** (the sources, groups and assets
you selected) or one **branch** (them and everything under them), the right-click menus of nodes, selections and empty canvas offer the
same, and a message says how many opened or closed; an **Unmapped only** switch hides every point that is already mapped, the groups and
sources with nothing left to map, and the lines to assets, and the summary then reads `Showing 42 of 60 points, 3 sources, 18 mapped`
(remembered in your browser; **Find** still reaches a hidden node and turns the switch off for it). An open group of more than 50 points
draws 50, with a **Show 50 more (70 left)** button at the end of the list; a point that is not drawn yet keeps its line to its asset, so
no mapping disappears. An asset with sub-assets has a small arrow to fold them away (a folded asset shows how many points are mapped inside it;
remembered in your browser; adding a sub-asset under a folded asset unfolds it). The arrow keys move between nodes (Up and Down between neighbours, Right to the first child, Left to the
parent), Enter opens or closes a source, a group or an asset, the Menu key opens the actions, and every node has a name for a screen
reader such as `LVP01, group of 6 points, 6 mapped, open`. Expand all still never draws more than 600 new nodes in one go. One thing
to know: rows close up when you filter, fold or close, and a node you pinned by hand with an Alt-drag keeps its place, so closed-up rows can
lie over it; **Tidy layout** puts everything back. No migration, no new permission, front end only, and nothing new in the Audit log.
The usual steps of [Upgrading and going back](docs/upgrading.md) are all it needs; the code to go back to is `2d1493c`. See
[Discovery](docs/sources-and-discovery.md) and, for the speed script, [End-to-end tests](docs/end-to-end-tests.md).

## W12a (2026-10-16, merge commit 4e14905)

W12a (mapping actions) lets you take a mapping off an asset, or move it to another asset, from the places you see it, with one
confirmation and an Undo. In **Discovery**, a mapped point or group has a small **Mapping actions** button (the same menu as a
right-click, or Shift+F10 on the node) with **Unmap…** and **Move to another asset…** (for a group: **Unmap this group…** and
**Move this group's mappings…**); an asset's right-click menu has **Unmap everything from <source>…**. On the **asset page** every metric
row has an actions menu with the same two items, and on the **Points page** **Unmap…** now asks first. Each one says what it does to
billing (months that are still open are recalculated, closed months keep their billed figures), works one mapping at a time, stops at
the first failure and tells you which went, and shows an **Undo** for 10 seconds (also **Ctrl+Z**); Undo puts back exactly the scale,
interval and unit that were removed. Mapping in Discovery now gets an Undo too (**Mapped 6 points to Room 1.**), a note when the
target is a room, building, site or row ("meters usually belong to a Panel or Rack"; it never blocks), and the Review can take several
points dropped on an asset at once. **New asset…** in Discovery opens the same form as the Assets page (kind, icon, parent); for a
group the Review opens on the new asset next. A small **+** on an asset node (hover, focus or select it; click, press Enter, or drag
the line to empty canvas) adds a sub-asset. Unmap, move, Undo, New asset and the **+** need Edit assets; mapping still needs Accept
scan results. No migration, no new permission; one new read, `GET /api/mappings/{id}` (Edit assets), and the Audit entry for a deleted
mapping now also holds its scale, interval and unit. The usual steps of [Upgrading and going back](docs/upgrading.md) are all it
needs; the code to go back to is `09ed32a`. See [Discovery](docs/sources-and-discovery.md) and
[Taking mappings off an asset or moving them](docs/assets-and-kinds.md).

## W11 (2026-10-15, merge commit dee0ce8)

W11 (close month) lets an administrator freeze a finished billing month, so that the bill for it stops moving. On Billing, an
administrator now sees **Close month…** in the page header on a month that is over (it takes an optional note), and the month then
carries a **Closed** chip, a banner ("Closed by <name> on <date>") and the figures exactly as they stood, per asset and per day.
Moving assets, mapping or unmapping points, editing tariffs and deleting assets or sources no longer change that month; dashboards and
widgets stay live. A quiet line on a closed month is always there and says how today's tree and rates compare (it is empty when today's tree cannot be priced) ("Today's tree and rates would give ...",
counting assets that moved or changed even when the total is the same, or "... give the same figures."); readings that arrive late show up only there. The Billing CSV of a
closed month is the file it had when closed, named `billing-YYYY-MM-closed.csv`. **Reopen month…** asks for a reason of at least 5
characters and goes back to today's figures; the old snapshot stays stored but the app does not show it again (the dialog says so and tells you
to download the CSV first), and a new close stores a new one. The move and delete warnings now say that
closed months keep their billed figures. The Audit log gains `billing.closed` and `billing.reopened`. See
[Closing a month](docs/dashboards-and-billing.md#closing-a-month). Closing is a new permission, **Close and reopen billing months**
(`billing.close`, in the Sensitive actions of the Roles tab, 31 permissions in all) that migration `0012` gives to **no role**: the
built-in Admin holds it from the code, and nobody else until an administrator ticks it (it needs See billing). Also new, for developers:
`python -m dcdash.seed.history` makes a month of made-up readings on a development or scratch stack; it ships in the `api` image but
writes nothing unless it is given `--yes` and `DCDASH_ALLOW_SEED_HISTORY=1`, so a real installation never runs it (see
[Developing](docs/developing.md#seeding-a-month-of-history)).

### Upgrading to W11 (migration 0012)

Schema `0011` to `0012`. Downgrade: **lossless** for everything that existed before the upgrade (it only drops the new table of closed
months, described below), so option a is open. The code to go back to is `e9c1a5e` (the W7u merge; `main` before W11 differs from it
only in documentation).

Migration `0012` creates one table, `billing_closes` (one row per close: the month, who and when, the note, the currency and time zone,
the totals and the stored figures as JSON, and the reopening). It writes no row and touches no other table, runs in a moment and needs
no pre-check. A big site's snapshot is about 5 MB (2,000 assets, 31 days). The API gains `POST /api/billing/months/{month}/close` and
`POST /api/billing/months/{month}/reopen` (both `billing.close`); `GET /api/billing/costs` gains `closed` (null for an open month)
and, for a closed month, `live`; `GET /api/billing/months` counts a month that was ever closed (also after a reopen) when it names the first month. A client that does
not use them sees an open month as before, with one more key (`closed: null`). The `api` container applies the migration the first time it starts from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0011`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` prints `0012 (head)`; as an administrator, Billing on a finished month shows
   **Close month…** left of **Download CSV** (do not press it unless you mean to close that month), and on the Roles tab a custom role
   shows Close and reopen billing months among the Sensitive actions, not ticked.
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0011` and `<old commit>` = `e9c1a5e`. The
   `0012` downgrade drops `billing_closes`: **the closed months are lost**, and every month is then recalculated from the tree and
   the rates as they are, so a month you had closed may show other figures. **Download the CSV of each closed month first** if you need
   the closed figures. A custom role that had `billing.close` ticked keeps the id in its list; the older server ignores it, and a new
   upgrade honours it again. `upgrade` after a downgrade creates an empty table. A restart of the W11 `api` would run `alembic upgrade
   head` and apply `0012` again, so the W11 `api` must not be running once the schema is back at `0011`. Option b restores the
   dump of step 1, which holds no closed month, and loses whatever was closed since (a restore of any older dump brings back the older
   set of closed months; see [Backup and restore](docs/backup-and-restore.md)).

## W7u (2026-10-15, merge commit e9c1a5e)

The Discovery canvas feels finished. The view glides (Fit View, Tidy layout, opening a source with its + button and Find move it over a third of a second; with reduced motion on they happen at once). Dragging snaps to an 8 px grid, with a **Snap to grid** button at the top right of the canvas (on by default, remembered in the browser) and thin guide lines when the node lines up with a nearby one. Resting the pointer on a node, or tabbing to it, lights its whole path and dims the rest at once (no fade); a click on one node lights nothing, two or more selected nodes light the union of their paths. Enabled online sources have flowing dashes on their edges from the source to its groups and from mapped nodes to their assets (off under reduced motion, and off above 100 flowing edges; the dashed edges from a group to its points stay still). Source nodes show a status dot and a protocol (`OPC UA`, `Modbus`, `Simulator`), group nodes a thin bar for the share mapped, and a minimap sits at the bottom right. Shift-drag selects several nodes (Ctrl-click or Cmd-click adds), right-click or Shift+F10 opens a node's actions or, on empty canvas, Expand all, Collapse all, Tidy layout and Fit view, and **Find** (Ctrl+K, or Cmd+K, while the canvas or its Find button has the focus) jumps to any source, asset, group or point, also in a graph of thousands of points. The long hint line is one short line and a `?` that lists the keys. The "offer to create an asset" bar moved to the bottom of the canvas. Default places of sub-assets are 4 px further right per level so every default lies on the grid. No migration, no new permission, no new dependency and nothing to do when you update (rebuild as in [Upgrading and going back](docs/upgrading.md)); the schema stays `0011`. The API is unchanged. Going back needs no database step; the snap choice is a browser setting and stays harmlessly behind. See [Discovery](docs/sources-and-discovery.md#discovery).

## W7t (2026-10-15, efc58a8)

Discovery and the asset page polished. The trail above an open asset shows each asset's icon beside its name. On Discovery, dragging a source takes its open groups and points with it, dragging a group takes its points, and dragging an asset takes its sub-assets (hold Alt, Option on a Mac, to move a node alone); a group you had collapsed opens beside its source instead of where the source used to be. A new bar above the canvas gives a summary line (`3 sources, 120 points, 6 mapped, 1 needs credentials`), **Collapse all**, **Expand all** and **Tidy layout**, which asks first and then puts every node back in its default column for everyone; Remove on a source is now a small bin. The scope form names the ports it knows (`4840 (OPC UA)`) and warns, never blocks, about a port that looks like a typo (`4080 ... did you mean 4840 (OPC UA)?`), the scan lines read `1 host × 1 port (1 check)`, and each row of Recent scans has **Scan again**. In the Assets Tree's pick bar, **Move to...** now sits beside a shorter hint in a narrow column. No migration, no new permission and nothing to do when you update (rebuild as in [Upgrading and going back](docs/upgrading.md)); the schema stays `0011`. The API gains `DELETE /api/discovery/layout` (`discovery.edit`, 204, no audit row), which Tidy layout sends. Going back needs no database step; positions that Tidy layout deleted are not restored, the nodes stand in their default columns. See [Discovery](docs/sources-and-discovery.md#discovery).

## W7s (2026-10-15, 239952d)

The Assets Tree can delete several assets at once: pick them as for a move and press **Delete** in the pick bar (for people who hold both Change assets and Delete assets). One dialog lists the picks and what else goes with them, each top-level asset is then deleted by its own request, and the first one that cannot be deleted stops the rest and is named, with the failed and untried assets left picked. The open asset's row no longer looks like a pick: it keeps its bar and bold name and loses the tint, which only picked rows have. No migration, no new permission and nothing to do when you update (rebuild as in [Upgrading and going back](docs/upgrading.md)); the schema stays `0011`. See [Deleting several assets](docs/assets-and-kinds.md#deleting-several-assets).

## W7r (2026-10-15, 200c416)

Scans and Discovery tidied: Details on a scan opens a panel on the right that closes (Esc, the x, a click outside) and says what was scanned (`Simulator: 172.20.0.0/24, ports 9000, 4840, 5020`); the numbers read as words (`1 source, 60 points`, `762 checks (254 hosts × 3 ports)`); an admin with `discovery.edit` can remove discovered sources that have nothing mapped, one by one or with **Clear unmapped**; every source says when a scan last found it; a source you added by hand now wins over a discovered duplicate of the same address in a scan; and **Create assets…** on a source makes one asset per group in one go. Discovery now opens on the first three sources at a readable size (the Fit View control still shows the whole graph). No migration, no new permission and nothing to do when you update (rebuild as in [Upgrading and going back](docs/upgrading.md)); the schema stays `0011`. Two things you may notice: after you add a source by hand at an address a scan already found, the older discovered duplicate is no longer browsed (it stays on Discovery until you remove it) and the scan reports your source as `existing source`. The API gains `POST /api/discovery/sources/remove` (`discovery.edit`, 1 to 500 ids; it never removes a source with a mapped point and refuses while a scan runs) and additive `targets`, `ports` and `last_scan` fields. Going back needs no database step; sources that were removed can be found again by a scan. See [Discovery](docs/sources-and-discovery.md#discovery).

## W10 (2026-10-15, 7c3d2b8)

Documentation only: the README is a short front door, each topic has its own page under [docs/](docs/), and the release notes moved here from the README. No migration and no change to how the stack runs, so there is nothing to do when you update. Older messages that name README sections ("README, Upgrading and going back, step 6", migration 0004's "Upgrading an existing database to Phase 3") still lead somewhere: the README index lists each old name with its new page. The messages of `scripts\update.ps1`, `setup.ps1`, `setup.sh`, `e2e.sh`, `check_tls.sh` and the OPC UA certificate hint of the connection check now name the new pages (they reach a running stack with its next rebuild).

## W7q (2026-10-15, 50228b7)

Asset kinds you can tell apart and tidy: a Starter tag, filters (All, Starter, Yours, Unused), ticking and deleting several kinds with one move target, and a starter pack that adds the 16 common data-centre kinds ("Add all 39" adds the rest); no migration.

## W7p (2026-10-14, 246f103)

### Upgrading to W7p (no migration)

Schema stays `0011`; no data is rewritten, so there is nothing to restore. The code to go back to is `823560b` (`main` before W7p).

W7p (moving assets) rebuilds the `api` and `web` images and adds no permission: whoever may change assets (`assets.edit`) can now pick
several assets in the Assets Tree, drag them to a new place or use **Move to...**, and undo it from the toast; see "Moving assets". What you
will notice: for those people the tree has a line above the rows ("Ctrl-click to pick several"), the rows can be dragged, and Ctrl-click on a
row picks it instead of opening it in a new tab; a move that changes the rate an asset is billed at asks first. Moving an asset re-bills its
past periods at the new place (billing reads the live tree), so the totals of both branches change after any move; Undo puts it all back. The
audit log gains `asset.moved`, one entry per moved asset.

The API gains two routes, both needing `assets.edit`; a client that uses neither behaves exactly as before:

- `POST /api/assets/move-preview` answers what a move would do (the roots that really move, where from and to, the rate before and after, whether
  any rate changes, and the `expect` to send back) and changes nothing.
- `POST /api/assets/move` moves one or many assets in one transaction (all or nothing) and answers the `request_id`, the moved roots and the
  request that undoes the move. `PATCH /api/assets/{id}` still moves one asset and now takes the same lock first when its body names a parent
  or a name, so a rename that waits behind a move is checked against the new siblings.

1. **Back up first**, as in step 1 of "Upgrading and going back".
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has the
   simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` still prints `0011 (head)`; as an administrator Ctrl-click two assets in the Assets
   Tree: the line above the rows says "2 picked"; press Clear.
4. **Going back.** Check out `823560b` and rebuild as in step 2. There is no database step. Moves already made stay made (they are ordinary
   parent and order changes), and their `asset.moved` entries stay in the audit log.

## W7o (2026-10-14, 823560b)

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
   shows Manage asset kinds ticked (in the sensitive group), and the Asset kinds page offers Add data-centre kinds to an administrator (since W7q: Add common data-centre kinds).
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0010` and `<old commit>` = `425aaf9`. The
   `0011` downgrade removes `assets.kinds` from every custom role that also holds `assets.edit`; it cannot tell a role that was given it
   by the upgrade from one that had it ticked later, so it takes it from all of them (a role that held it without `assets.edit` keeps the
   id, and the older server ignores it). An icon chosen from the 20 new ones, on an asset or a kind, stays stored and **shows the generic
   icon on the older build** (it does not know the id); pick another icon there or upgrade again. `upgrade` after a downgrade adds the
   permission to the custom roles holding `assets.edit` again, including a role that was made on W7o without it on purpose. A restart of
   the W7o `api` would run `alembic upgrade head` and apply `0011` again, so the W7o `api` must not be running once the schema is back
   at `0010`.

## W8e (2026-10-14, 425aaf9)

`scripts\update.ps1`, one safe command that backs up, fast-forwards the code, rebuilds with the build id and checks every service (see [Upgrading and going back](docs/upgrading.md)); scripts and docs only, a Linux twin is parked.

## W7n (2026-10-14, 365b5e6)

The owner's gold M is the app's logo and favicon (the original file is kept in `docs/brand`); front end and static files only.

## W7m (2026-10-14, a7c855e)

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

## W7l (2026-10-14, af8f9f8)

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

## W9c (2026-10-14, e624a5a)

The Roles editor offers to tick what a permission needs and to untick what needs it, and help bubbles no longer clip in the Roles grid; front end only.

## W7k (2026-10-13, c286e3d)

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

## W9b (2026-10-13, 53fff56)

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

## W9a (2026-10-13, 2276b28)

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

## W7j (2026-10-13, 774cb6e)

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

## W7i (2026-10-13, eba2d92)

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

## W7h (2026-10-13, 65d9fab)

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

## W7g (2026-10-13, 45deb14)

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

## W7f (2026-10-12, 15be434)

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

## W7e (2026-10-12, 10feba7)

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

## W7d (2026-10-12, 499fdc5)

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

## W8c (2026-10-12, ee1e985)

Field polish: the offline diagnostics scripts filter routine log lines, save into `logs/`, compare the Docker clock and can mask names (`-Mask`); the report adds DNS lookup lines; the setup scripts take the timezone at install.

## W7c (2026-10-12, 298293f)

An admin chooses a default dashboard that the sidebar and sign-in open, and Billing gets Year and Month selects.

## W7b (2026-10-12, 40d71db)

A row action menu and trash button, help bubbles, the Storage tiles and rows per day, Tariffs in sections, and the sign-in protection switch.

## W8b (2026-10-12, 2f7a518)

Simulator fault switches (`SIM_FAULT_*`), client-side refusal reporting, the offline diagnostics scripts and blind-read examples for field debugging.

## W8 (2026-10-12, 682b636)

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

## W7a (2026-10-12, b933bc7)

One Assets workspace (tree and fleet summary) and the app shell with the navy top bar and breadcrumbs.

## W6 (2026-10-11, ffa44fd)

UI overhaul: a navy sidebar that can be minimized, the asset tree column, and restyled pages, dialogs, banners and forms (widgets unchanged).

## W3d follow-up (2026-10-11, b821ba7)

Passwords inside source URLs are scrubbed from the container logs, an account deleted mid-request answers 401, and the Audit filter refreshes after user changes.

## W3d (2026-10-11, 4ca1b6d)

The sign-in block is configurable and can be lifted per account, accounts can be deleted, and the user name and password inside a source's URL are never returned.

## W3c (2026-10-11, 8301733)

The Audit screen filters, searches, exports CSV, pages, jumps to a date, links each entry to what it is about and shows a friendly sentence next to the raw entry.

## W3b (2026-10-11, 03b3c6d)

Dashboards close up vertically, long names are shortened in legends and axes, the Trend refetches by range, and a parent asset shows the sum of its children's live power.

## W3a (2026-10-11, f0beeb8)

Add an asset under any branch, pick its kind from a list, a sortable and searchable points list, a mapping dialog with a unit warning, Edit on the Sources page, and an honest status for sources that are not polled.

## W2 Part B (2026-10-10, 1fec877)

Pinned base images and a re-pin command, the certificate expiry notice, security headers with a Report-Only content policy, and a notice when your role changes.

## W2 Part A (2026-10-10, f74eed0)

Backup and restore scripts that cannot reach the wrong stack, rotating verified backups, the Windows scripts, and the upgrade and go-back runbook.

## W1b (2026-10-10, ab0869c)

Storage, restore and name safety: a confirmation before retention deletes data, restore pauses retention, a warning when the secret key does not match, duplicate asset names refused, and non-finite readings and scales refused.

## W1a (2026-10-10, efc7e66)

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
   not use step 6 of the Phase 3 entry below for this: it returns to Phase 2 (schema `0003`), which is not a place to go back to from
   a `0004` or `0005` database (Alembic fails with an unknown revision). In both options a restart of the W1a `api` would run
   `alembic upgrade head` and apply `0005` again, so the W1a `api` must not be running again once the schema is back at `0004`.
   - **Option a, keep what was collected since the upgrade.** The `0005` downgrade drops the trigger, its function and the two snapshot
     columns, and `upgrade` rebuilds them from the users. That loses nothing for an entry whose user still exists; the names of
     users deleted after `0005` was applied are lost.
   - **Option b, restore the backup from step 1.** Everything collected since that backup is lost. The restore script is the one of
     the old commit (see step 5 of option b in "Upgrading and going back"). `--force` is needed: the volume
     still holds the W1a database (`0005`) and the dump's `.version` says `0004`, so the script refuses without it.

## W0b (2026-10-10, 60d8b65)

Log rotation, a graceful stop, a readiness health check, the collector heartbeat, and status writes off the poll path.

## W0a (2026-10-09, ec1062b)

UI and documentation fixes from the first manual acceptance pass.

## Phase 3 visual fixes (2026-10-09, e6ca151)

The time axis of energy and cost series is bounded to their range.

## Phase 3 (2026-10-09, 0ada373)

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

## Phase 2 (2026-10-08)

Network discovery: scan scopes, the scan job, the graph, drag-and-drop mapping and the audit log. Its merge commit is not named on purpose: a database at `0004` or later cannot go back to Phase 2 code (see the Phase 3 entry).

## Phase 1C (2026-10-07, 7ed2c44)

OPC UA and Modbus TCP connectors, the storage tiers and the backup scripts.

## Phase 1D (2026-10-07, dcbab5c)

Users, settings, hardening, optional TLS and the end-to-end tests.

## Phase 1B (2026-10-07, 25bf25a)

The React web UI served through Caddy.

## Phase 1A (2026-10-07, 552e9c7)

The backend, the collector and the API.
