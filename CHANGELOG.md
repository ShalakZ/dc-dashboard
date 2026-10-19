# Changelog

What each release (a merged wave) changed, newest first. Each section is headed `## <wave> (<date>, <merge commit>)`.

A release that needs an upgrade note carries it as a `###` entry: the schema revision it leads to when there is a migration, what
changes and what you will notice, the pre-checks to run before it, how to verify it, whether its downgrade is lossless (which decides
whether option a of [Upgrading and going back](docs/upgrading.md) is open), and the commit to go back to. 9 releases on this page
have such an entry (4 of them have no migration) and the archive has 10 more. The other releases need nothing beyond the usual steps of
[Upgrading and going back](docs/upgrading.md); they have one or two lines here. The releases up to W7j (2026-10-13) are in the
[changelog archive](docs/changelog-archive.md), with migrations 0004 to 0008; Phase 1A, Phase 1C and Phase 2 brought migrations 0001
to 0003, from before the release notes (see [Migrations in order](docs/upgrading.md#migrations-in-order)).

**Before you upgrade,** read every entry between the version you run and the new one, starting at the oldest of them (lower on
this page; for a version older than W9a, first in the [changelog archive](docs/changelog-archive.md)) and working up. **To go back,** use the commit each entry names ("the code to go back to"): a wave's merge commit in a
heading is NOT a place to go back to, because it already contains that wave.

**The next release** gets its section at the TOP of this page, above the newest one.

## w25 (2026-10-19, merge pending)

w25 lets a dashboard follow **one focus asset**. The Focus button (needs See the Assets Tree) or the address `?asset=<id>` points it at a hall,
row or rack: widgets set to follow it show that asset or its children, the others keep their own assets and say so, the trail climbs back up, and
a link to a deleted asset falls back to the whole site. In view mode a click on a breakdown bar narrows the dashboard to that asset or opens its
page. **New dashboard > Start from Power** builds a starter: energy and cost this month against last month, a daily chart and a breakdown by the
kind that has meters. No migration, no new permission; the widget API takes an optional `focus` and the config key `scope`, `POST /api/dashboards`
an optional `recipe`. Rules: [Dashboards and billing](docs/dashboards-and-billing.md). Nothing to do when you upgrade; the code to go back to is `c43a903`.

## w24 (2026-10-19, 9874792)

w24 adds two things to dashboard widgets. A stat or a time series of energy or cost for one asset can **compare this month so far with the
same days of last month** (complete days only, the same number on both sides; each figure names its window and equals the sum of Billing's
day cells; a closed last month is read from its closed figures; no percentage against zero, missing days or a partial cost). A bar chart can
draw **one bar per asset of a kind**, with "and N more" and a Split by choice. No migration, no new permission; the widget API takes the new
config keys `compare`, `kind`, `root` and `top`. The dev seeder gains `--metering panels`. Rules and limits:
[Dashboards and billing](docs/dashboards-and-billing.md). Nothing to do when you upgrade; the code to go back to is `075db5f`.

## w23 (2026-10-19, 83acfa4)

w23 rebuilds the asset picker of the widget editor (Edit, Add widget): a **Search assets** box (part of a name or a kind), a **Filter by kind**
list, a tree that opens folded when it has more than 60 rows, the picks as removable tags above the list, and **Pick all under** a row (within the
20 maximum; otherwise it picks nothing and says why). No migration, no new permission, no API change. On a 4x slowed CPU with 2,000 assets the
dialog opens in 54 ms and a keystroke shows its rows in 33 ms (median). How to use it: [Dashboards and billing](docs/dashboards-and-billing.md).
Nothing to do when you upgrade; the code to go back to is `486315d`.

## w22 (2026-10-19, dbc5425)

w22 adds a sixth dashboard widget, **Text**: a heading, a paragraph or a divider you write on the dashboard, with no data. Edit, Add widget,
Type: Text, then Style and Text. The viewer draws a heading as a heading, a paragraph as a card and a divider as a plain line; in edit mode
it keeps the usual title bar. Plain text only (no HTML, markdown or links); a heading holds 200 characters on one line, a paragraph 2,000.
Migration `0013`, no new permission, no new route. `POST /api/widget-data` and its CSV answer 422 for a text widget, and a widget title
with a control character other than a tab is refused with a 422 (a NUL was a server error). The save's audit row keeps a digest of the widgets, never the
words. Rules and limits: [Dashboards and billing](docs/dashboards-and-billing.md).

### Upgrading to w22 (migration 0013)

Schema `0012` to `0013`. Downgrade: **lossless while no text widget exists; it refuses while one does** (the message names the
dashboards: remove their text widgets in the dashboard editor, then downgrade). The code to go back to is `c73aca4` (the main before w22).
Migration `0013` widens the allowed widget types from five to six (the `widgets_type_known` CHECK); it writes no row and needs no pre-check.

1. **Back up first**, as in step 1 of "Upgrading and going back".
2. **Apply** as in step 4: `docker compose up -d --build`.
3. **Verify.** `docker compose exec api alembic current` prints `0013 (head)`; Add widget offers Type: Text.
4. **Going back.** Follow [Upgrading and going back](docs/upgrading.md) with `<previous>` = `0012` and `<old commit>` = `c73aca4`.

## w21 (2026-10-18, 56da1bf)

w21 adds a read-only month check to Billing: a Check month button in the page header (with a count) opens a drawer that lists, in plain words, what to look at before a
month is trusted or closed: meters with no readings, gaps, estimated hours, counters that went back, meters that started late, energy with no rate, readings that did not
change for 24 hours. No migration and no new permission; one new route, `GET /api/billing/month-check` (`billing.view`). It changes no figure and blocks nothing; Close month
shows its count in one line. The header buttons go under the title below 600 px. Rules, limits and what it cannot see: [Dashboards and billing](docs/dashboards-and-billing.md).

## w20 (2026-10-18, 310db08)

w20 puts the Billing month controls and table controls on one row, front end only: no migration, no new permission, no API change. On a page
about 1,600 px wide or more (a 1,920 px screen at 100 percent scaling with the sidebar open, about 1,700 px with it minimised) Previous month,
Next month, Year and Month sit on the left and the filter box, Collapse all, Expand all and Show levels on the right of the same row, level and
34 px tall; on a narrower page they stack as before. The "Showing N of M rows" line moved to the right of the table's first row (it stays at the
right edge when you scroll the days sideways and scrolls up with that row), and the table is taller by the row that went. Every figure, fold,
filter, remembered fold, CSV and closed month is unchanged.

## w18 (2026-10-18, e1be322)

w18 makes the controls consistent and says plainly what removing assets does, front end only: no migration, no new permission, no API
change. **One height for every control:** buttons, fields, selects, filter chips, the top bar's Find field and its Live chip are all 34
px tall (borderless text buttons stay 30 px and icon buttons 28 px), and the loading skeletons draw the same heights. **The note box** of
Close month and Reopen month (and the Targets box of a scan scope) is at least four lines tall and at most twelve lines or 40 percent of
the window; a longer note scrolls inside it. **Removing assets or a source:** when the removal takes mappings, the confirmation says that
a month that is not closed follows today's assets and loses those figures, so close a finished month first to keep its bill; after an
asset is removed its points and readings stay, so mapping the same points to an asset again brings the figures back, while removing a
source takes its points too. The Storage page says that removing assets or sources never removes readings, that retention trims them, and
that the hourly summaries stay. **Not changed:** every figure, rate, marker, CSV and closed month, and the readings themselves. A new
end-to-end spec, `w18.spec.ts`, measures the real pages, so a control that is 4 px off fails a test. Nothing to do when you upgrade; the
code to go back to is `71be4c9`.

## w17 (2026-10-18, d68bf39)

w17 makes Billing usable with a real data centre, front end only: no migration, no new permission, no API change. **Billing:** a row with
assets below it has an arrow that folds them (a folded row keeps its own rate, month total and day figures, which already include
everything below it); **Collapse all**, **Expand all** and **Show levels** fold many rows at once; a filter box (**Filter by asset
name**) shows the matching rows with their parents ("12 of 370 rows match"); and the header with the day numbers stays at the top while
the rows scroll. A month with more than 60 rows opens folded to the deepest level that keeps 60 rows or fewer. The fold is remembered in
this browser for this site address, not per month or account; the filter is not. **Assets Tree:** a tree of more than 60 assets opens
folded to its second level when nothing is remembered, and the selected asset is scrolled into view. **Not changed:** every figure,
marker, rate and total, the CSV (every asset and every day, whatever is folded), closed months and the API. Nothing to do when you
upgrade; the code to go back to is `8d3ef40`.

## w14 (2026-10-18, 73d0469)

w14 is a polish wave after w12c and w13, front end only: no migration, no new permission, no new widget type, and no figure, unit,
rounding or claim of a widget has changed. **Bar charts:** every asset's name now stands under its bar, wrapped over up to three lines
when the card is wide enough (turned at an angle when it is not); the asset with no data keeps its label and an empty slot.
**Discovery:** a source card shows its name on up to two lines, the empty progress track of `0 of 60 mapped` is visible in the dark
looks, the bar above the canvas keeps the words of its counts on a 1440 px window with the sidebar open (the Snap to grid, Find and Tidy
layout buttons turn into icons first), and **Snap to grid** switched on is a tinted button with a line along its foot. **Details:** the
figures table has three plain columns (`Lowest`, `Highest`, `Last bucket`), `Highest` says `bucket from <time>` (the start of a bucket,
not the moment of the peak), the panel is 560 px wide, and next to a "no rate" line a person who may open Tariffs gets **Set a rate in
Tariffs**. **Top bar:** at an 800 px window with the sidebar open the page no longer scrolls sideways. Nothing to do when you upgrade;
the code to go back to is `c0e355d`.

## w16 (2026-10-18, 088aa67)

w16 adds a second layout to the development history seeder: `python -m dcdash.seed.history --layout pilot-hall` makes a made-up data
centre for demos and tests, with a month of readings, on a development or scratch stack. It is the Site "Seeded pilot hall" with two
halls, four pods, eight rows and 117 racks, each rack with a Feed A and a Feed B (370 assets, 442 points), and an "Electrical" group with
eight panels. A feed has an energy counter and a power point; 100 racks are live, 6 idle, 5 have one feed, 6 are free (nothing is
metered); eight Hall 2 feeds report power only, so their energy is an estimate (`~`) and Hall 1 is exact; one feed has a 6-hour gap and
one counter resets once. The panels carry voltage and current only, never energy, because a kWh meter on a panel beside the halls would
count the same energy twice at the Site and in Billing. Every name is generic; there are no tenants. It is as guarded as the first
layout: nothing is written without `--yes` and `DCDASH_ALLOW_SEED_HISTORY=1`, no audit row, tariff, dashboard, setting or kind is
written, a second run is refused, and a run that fails or is stopped removes what it made. `--interval-minutes` (5, 10, 15, 30, 60;
default 30) sets the spacing of the samples and `--days N` the range; the default range is about 615,000 readings and a minute and a
half, a whole previous month about 1,000,000 readings and a little over two minutes (raw retention 60 days). The commands for Linux and
Windows PowerShell, how to see past data and how to remove the seed are in
[Developing](docs/developing.md#the-pilot-hall-a-demo-tree-with-racks). The default layout and its figures are unchanged. No migration,
no API or screen change, no new permission; nothing to do on upgrade.

## w13 (2026-10-17, 4202012)

w13 (the dashboard widget overhaul) changes how the widgets look and what they tell you; no figure, unit or rounding has changed. The
widgets follow the theme (light, dark and the four theme colours; the white card on a dark page is gone), with a 36 px header, small
**Details** and **CSV** buttons and one footer line that holds "since 10:46" and the marker hint (`~ estimated`, `* partial`, `— no
rate`) for every widget type; a cost with no rate now says `— no rate` under a stat and a table too. The charts use one palette of
eight colours measured for contrast in light and dark (series 6 to 8 are dashed, 9 and later dotted) with the axes, grid, legend and
tooltip in the theme's colours, repainting after a Mode or Theme switch without a reload. The gauge is a half-circle arc that no longer
overlaps at the smallest size. **Details** opens a right-hand panel: what the widget shows (type, source and unit, the assets with
links), the time window with the site time zone, how fresh the latest reading is, what each marker means, the state of each asset and,
for a chart, a small table (lowest, highest and its bucket, the last bucket, a total only when it is exact); it never shows an average
over buckets. Small bugs are fixed (a legend switch now removes its min-max band, the legend choice survives a `~` or `*`, a chart has a
text alternative, a card shows a skeleton while loading). No migration, no backend change, no new permission; saved dashboards keep
working. To tweak the look, the tokens are `--widget-pad`, `--widget-head-h`, `--widget-row-h`, `--widget-radius`, `--widget-shadow`,
`--widget-figure` (density and corners), `--chart-1` to `--chart-8`, `--chart-band-opacity`, `--chart-grid`, `--chart-tip-bg` (the
palette) and `--gauge-width`, `--gauge-track`, `--gauge-fill` (the gauge); the gauge's half-circle shape is a code constant. The usual
steps of [Upgrading and going back](docs/upgrading.md) are all it needs; the code to go back to is `b4f295f`. See [Dashboards and
billing](docs/dashboards-and-billing.md), [Screens](docs/screens.md) and [End-to-end tests](docs/end-to-end-tests.md).

## w12c (2026-10-17, 2572801)

w12c (Discovery visual polish) tidies the look of Discovery without changing what it does. The bar above the canvas is regrouped: counts
with icons (sources, points, mapped, **needs credentials**), **Collapse all** and **Expand all**, **Unmapped only**, **Tidy layout**,
**Find**, **Snap to grid**, and the icon buttons **Refresh**, **Keyboard shortcuts and controls** (a bubble of the real controls, also
the `?` key) and a **More** menu that holds **Clear unmapped (N)**; on a narrower window the words leave the buttons one at a time and
the rarer ones move into **More**. A source card is calmer (protocol icon, a short name, a status dot with its word, a progress bar with
`60 of 60 mapped`, **Details**, and a **Source actions** `...` button that opens the right-click menu). Every node has an icon, and
resting the pointer on a **mapped** point shows its last value (`51.43 A, 3 s ago`, with `stale`, `bad reading` or `No reading yet` when
that applies); a person who may not view assets sees no card. Behind it: `GET /api/discovery/graph` now gives each asset its `icon` and
`kind_icon`, and a new read `GET /api/mappings/{id}/latest` (needs `assets.view`) gives one mapping's value, unit, time, quality, age and
`stale`. No migration, no new permission. The usual steps of [Upgrading and going back](docs/upgrading.md) are all it needs; the code to
go back to is `bd96e05`. See [Discovery](docs/sources-and-discovery.md), [Screens](docs/screens.md) and [End-to-end
tests](docs/end-to-end-tests.md).

## w12b (2026-10-16, 0909a1e)

w12b (Discovery speed and navigation) makes the Discovery canvas quick on big graphs. The slow drag came from the dashed lines between a
group and its points, so a group that draws more than 150 points now draws them solid, and hovering or opening a group in a graph of
about 2,000 nodes redraws only what changed. New: a menu beside **Collapse all** and **Expand all** to close or open only the
**selection** or one **branch**; an **Unmapped only** switch (remembered in your browser; **Find** still reaches a hidden node); **Show
50 more** at the end of a group of more than 50 points (a point not drawn yet keeps its line to its asset, so no mapping disappears); a
fold arrow on an asset with sub-assets; and arrow-key navigation with a screen-reader name on every node (Enter opens or closes, the Menu
key opens the actions). Expand all never draws more than 600 new nodes at once. Closed-up rows can lie over a node you pinned by hand
with an Alt-drag; **Tidy layout** puts everything back. No migration, no new permission, front end only. The usual steps of [Upgrading
and going back](docs/upgrading.md) are all it needs; the code to go back to is `2d1493c`. See [Discovery](docs/sources-and-discovery.md)
and [End-to-end tests](docs/end-to-end-tests.md).

## W12a (2026-10-16, merge commit 4e14905)

W12a (mapping actions) lets you take a mapping off an asset, or move it to another asset, with one confirmation and a 10-second **Undo**
(also **Ctrl+Z**). In **Discovery**, a mapped point or group has a **Mapping actions** button (the same menu as a right-click) with
**Unmap…** and **Move to another asset…**; the **asset page**'s metric rows have the same two items, and **Unmap…** on the **Points
page** now asks first. Each says what it does to billing (open months are recalculated, closed months keep their billed figures). Mapping
in Discovery gets an Undo too, a soft note when the target is a room, building, site or row, and the Review takes several dropped points
at once; **New asset…** opens the real asset form, and a **+** on an asset node adds a sub-asset. These need Edit assets (mapping still
needs Accept scan results). No migration, no new permission; one new read, `GET /api/mappings/{id}` (Edit assets), and the Audit entry
for a removed mapping now also holds its scale, interval and unit. The usual steps of [Upgrading and going back](docs/upgrading.md) are
all it needs; the code to go back to is `09ed32a`. See [Discovery](docs/sources-and-discovery.md) and [Taking mappings off an asset or
moving them](docs/assets-and-kinds.md).

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
