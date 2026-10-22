# Screens

This page lists every screen of the web app behind the sign-in, what it is for and who can open it, in the order of the sidebar. It is for anyone
who uses the app or decides who may use which part of it. "Everyone", "operators" and "admins" mean the built-in Viewer,
Operator and Admin roles; the permission ids in each entry are what a role of your own needs, and the full list is on
[Roles and permissions](roles-and-permissions.md). The sidebar shows only the links a person may open, and a page their role
lacks says "No access".

## Monitor

- **Assets Tree** (everyone): needs `assets.view`. Your asset hierarchy on the left and, beside it, the fleet summary (the
  Assets, Live power, Energy today and Cost today tiles) or the asset you opened, with its live values and charts. The trail above
  an open asset (`Assets Tree / MV2 / Room 1 / LVP02`) shows each asset's own icon beside its name, the same icon as in the tree. A tree of
  more than 60 assets opens folded to its second level when nothing is remembered in this browser (Expand all, the filter or Ctrl+K
  reach the rest), and the tree scrolls the selected asset into view. Adding and
  editing assets and mapping points needs `assets.edit` (also needed to pick several assets and move them), deleting
  `assets.delete`. With `assets.edit` each row of an open asset's **Metrics** table has a menu (`Actions for <metric>`) with **Unmap…** and
  **Move to another asset…**, which ask first and offer an Undo for 10 seconds. The page header's "live" chip is as tall as the buttons
  beside it (every control with a visible edge is 34 px, the top-bar Live chip and the Find field included). Deleting an asset (or
  several) that has mapped points adds a paragraph to its confirmation: months that are not closed lose the figures, a finished month
  can be closed first, and the stored readings stay (see [Dashboards and billing](dashboards-and-billing.md)). See [Assets and kinds](assets-and-kinds.md).
- **Asset kinds** (everyone reads, admins change): the Asset kinds button of the Assets Tree (`/assets/kinds`). Reading needs
  `assets.view`; adding, renaming, re-iconing and deleting kinds needs `assets.kinds`. See [Asset kinds](assets-and-kinds.md#asset-kinds).
- **Dashboards** (everyone can read; operators and admins build): needs `dashboards.view`; building needs `dashboards.edit`.
  Shared dashboards of widgets that follow the theme (light, dark and each theme colour; a text widget is a heading, a paragraph or a
  divider you write, with no data); the widget editor's asset picker has a search box, a kind filter and a pick-all button (see
  [Finding assets](dashboards-and-billing.md#dashboards)); a stat or a time series of energy or cost can compare this month so far with
  the same days of last month, and a bar chart can draw one bar for each asset of a kind, with a **Split by** choice on the card (see
  [Comparing with last month and Breakdown by kind](dashboards-and-billing.md#dashboards)); the information button on a card opens
  **Details**, a panel with what the card shows, its time window and freshness, what its markers mean and its figures as text (where a
  figure says "no rate", a person who may open Tariffs gets a link to it there). With `assets.view` as well, a dashboard can be pointed at
  one asset with the **Focus** button (held in the address as `?asset=<id>` and shown in the trail; the cards set to follow it show that
  asset), and a click on a bar of a breakdown narrows it further or opens the asset's page (see
  [A focus asset and Drill-through](dashboards-and-billing.md#dashboards)). Cards write a figure short ("275.43 MWh") and keep the exact one
  in the hover title, Details, tables and tooltips ([How figures are shown](dashboard-figures-and-templates.md#how-figures-are-shown)).
  The dashboard's header has, on a dashboard with a data card, **Updated 20:09** (when the oldest figure on screen was read) and
  **Refresh**; on a dashboard with something to explain, **How to read this** (reopens the first-run panel **How to read this
  dashboard**; **Got it** closes it); and, with `assets.view`, **Focus**
  ([the header](dashboard-figures-and-templates.md#the-header-updated-and-refresh)). **New dashboard** (and the cards on an empty list)
  opens a gallery dialog: **Choose a template** (**Recommended for this site**, **More templates**, **Blank** last), then
  **Name**, **Range**, **Back to templates**, **Cancel** and **Create**. The row menu of the Dashboards list has **Make a copy**
  for a role that may change dashboards ([templates and copies](dashboard-figures-and-templates.md#starting-a-dashboard-from-a-template)).
  An admin (`dashboards.default`) can mark one as the default (**Make default** in the same menu), and the sidebar entry and the
  first page after signing in then open it. See [Dashboards and billing](dashboards-and-billing.md).
- **Billing** (everyone): needs `billing.view`. Energy and cost per asset per day and per month, picked with the Year and Month
  selects, with a CSV export (`billing.export`); on a page about 1,600 px wide or more (a 1,920 px screen at 100 percent scaling, sidebar open) the month controls and the table
  controls below share one row, and the "Showing N of M rows" line sits at the right of the table's first row. A parent row has a small arrow that folds the rows below it (a folded row keeps its own
  totals, which already include everything below it); **Collapse all**, **Expand all** and **Show levels** fold many at once, and a
  filter box (**Filter by asset name**) shows the rows whose name contains your text with their parents ("12 of 370 rows match"). The day-number header
  stays at the top while the rows scroll and the first column stays while the days scroll sideways. A month with more than 60 rows
  opens folded to the deepest level that keeps 60 rows or fewer; the fold is remembered in this browser for this site address (not per
  month and not per account), the filter is not, and the CSV always has every asset and every day. See
  [Big months](dashboards-and-billing.md#big-months). An admin (`billing.close`) can **Close month…** on a finished month with data, which
  freezes its figures and CSV as they stand: the month then carries a **Closed** chip and a banner, "Closed by <name> on <date>", with
  the note given; a quiet line, "Today's tree and rates would give ..." (or "... give the same figures."), says how today's tree and rates
  compare; and **Reopen month…** (a reason of at least 5 characters; download the CSV first, the app does not show the closed figures
  again) goes back to today's figures. See
  [Closing a month](dashboards-and-billing.md#closing-a-month) and [Dashboards and billing](dashboards-and-billing.md).
  **Check month** (everyone who sees Billing) sits in the header between Close month… and Download CSV, with a count of the things to
  check beside it (a muted `0` when nothing was found, empty while it is read or when nothing could be looked at). It opens a drawer
  that lists, worst first, the meters with no readings, gaps, hours estimated from power, counters that went back or dipped, meters
  that started part way through, energy with no rate and readings that did not change, then (not counted) the assets nothing measures
  and the meters that started later; the Close month dialog repeats the answer in one line. Point and source names in it need
  `sources.view`. It only reads and certifies nothing. See [Checking a month](dashboards-and-billing.md#checking-a-month).

## Operate

- **Sources** (operators and admins): needs `sources.view`. The data sources with their status, last error and the age of their
  newest reading, and a notice when the collector has gone quiet (see [Health](operating.md#health)). A second notice above the table
  names the sources that have been offline for more than 2 minutes (only enabled sources with a mapped point; at most three names, then
  "and 2 more"): for how long and since when, and the last error, or "has not answered since it was added" for a source that never
  answered, with **See its events** for a person who also has `diagnostics.view`. It needs only `sources.view`; it is a plain notice, not
  an alert, so a screen reader does not read it out again at every refresh. Resting the pointer on an offline source's Status chip says
  `offline since 18 Oct 07:52`. **Test** and **Test all**
  need `sources.test`; adding, editing and deleting sources needs `sources.edit`. A row's menu also has **Import file...**
  (`readings.import`), **Map tag list...** (`discovery.accept`) and **Fill older range...** (`sources.edit`, and only for a source whose
  connector keeps history); each shows only to a person who holds its permission. The last item, **Events** (`diagnostics.view`), opens
  the System events page for that source. Under a source's name a line gives the state of its history
  fill ("History: up to date, last fill 3 min ago"); a source of type `file` is never polled, so its status reads "filled by file import",
  its line "Filled by importing files", and its menu has no **Test** or **Check connection**. **Import file...** opens a dialog that
  asks for a file and a saved or new profile; **Check file** shows the counts in place and writes nothing, and only then does
  **Import N rows** store that file. **Map tag list...** opens a dialog where you paste or load the list; **Check list** shows what it
  would create, and **Create N mappings** works only on a check of the text now shown, with an **Undo** in the toast for 10 seconds.
  The fill dialog takes a first and a last day, **Check range** shows the plan and **Start fill** queues it. See
  [Sources and discovery](sources-and-discovery.md#importing-readings-from-a-file).
- **Points** of a source (admins): the Points item of a source's row menu; needs `sources.edit`. **Browse points** asks the source
  what it offers; **Map** ties a point to an asset, and **Unmap…** (asks first, then offers an Undo for 10 seconds) takes it off. Both need
  `assets.edit` and `assets.view` as well.
- **Scans** and **Discovery** (operators and admins; only admins can change anything): need `discovery.view`. Scans lists the
  scan scopes and their results, names the ports it knows (`4840 (OPC UA)`) and warns, without blocking, about a port that looks like
  a typo of one; **Details** on a result opens that scan in a panel on the right, with the scope it covered
  (targets and ports), the figures in words and the findings, and Esc, the x or a click outside closes it, and **Scan again** on a
  result previews and confirms a new scan of the same scope. Discovery (its title carries the Discovery icon, and one line under it
  says `Dashed means discovered, solid means assets. Drag a group onto an asset to map it.`) shows what was
  found as a graph to map by drag and drop or with the buttons on its nodes, says when a scan last found each source, and lets an
  admin remove discovered sources that have nothing mapped, one by one (**Remove from Discovery…** in the source's `⋯` menu) or all at
  once (**Clear unmapped** in the bar's **More Discovery actions** menu).
  Dragging a node takes its open children along (hold Alt, Option on a Mac, to move it alone). One bar above the canvas holds the page's
  controls: small counts first (sources, points, mapped, and one for sources that need credentials), then the **View controls**
  (**Collapse all** and **Expand all**, each with a small arrow beside it for just the nodes you selected, or one branch, an **Unmapped
  only** switch that hides what is already mapped, and **Tidy layout**, which puts every node back in its default column for everyone),
  the **Canvas controls** (**Find**, or Ctrl+K on the canvas, jumps to any source, group, point or asset, and **Snap to grid** lines nodes
  up on an 8 px grid with guides while you drag) and the **Page controls** (**Refresh**, the keyboard button that lists the keys, also
  opened by `?` on the canvas, and **More Discovery actions**, which holds **Clear unmapped** for an admin). On a narrower window the
  controls lose their words one at a time while the counts keep theirs for as long as they fit, and on a still narrower one the less used
  controls move into the More menu. An open group of more than 50 points
  shows 50 and a **Show 50 more** button at the end of its list; an asset with sub-assets has a small arrow to fold them away. Arrow keys
  move between nodes and Enter opens or closes one. Every node starts with a small icon (a source shows its protocol, a point what it
  measures, an asset its own icon), and a source is a card: its short name on up to two lines, the protocol and address, a status dot with the status in
  words, `60 of 60 mapped` with a thin bar, **Details**, and when a scan last found it. Resting the pointer on a node lights its whole
  path, and on a mapped point it also shows the point's last value in a small card (`12.40 kW, 3 s ago`) for a person who may view
  assets; the view glides, a minimap sits at the bottom right, Shift-drag selects several
  nodes, and right-click (or Shift+F10) opens a node's actions. A mapped point or group has a small `Mapping actions for <name>` button for **Unmap…** and
  **Move to another asset…**, an asset has a **+** that adds a sub-asset (and the menu's **New asset…** items open the same **New asset**
  form as the Assets Tree), several unmapped points of one source dropped on an asset map in one review, and the toast after mapping,
  unmapping or moving carries an **Undo** for 10 seconds. Changing
  scopes and the layout, and removing unmapped discovered sources, needs `discovery.edit`, running a scan `discovery.scan`,
  accepting results (**Map…**, **New asset…**, **Create assets…** for a whole source) `discovery.accept`; unmapping, moving, the Undo
  and the New asset form (also the **+**) need `assets.edit`, the form `assets.view` too. See
  [Discovery](sources-and-discovery.md#discovery).

## Administer

- **Users & Roles** (admin): needs `users.view` for the Users tab or `roles.manage` for the Roles tab. On its **Users** tab
  (changes need `users.edit`), create users, change roles, deactivate / reactivate, reset a password, delete a user (after a
  confirmation; never yourself and never the last administrator). Deactivating signs that user out everywhere. You cannot
  deactivate, demote or delete yourself. An account that has been blocked after too many failed sign-ins shows `blocked`, and
  **Unblock** lets it in at once; see [If you are blocked from signing in](operating.md#if-you-are-blocked-from-signing-in).
  Its **Roles** tab makes and edits roles; see [Roles and permissions](roles-and-permissions.md).
- **Settings** (admin): needs `settings.view`; the time zone needs `settings.edit`, the sign-in protection `settings.security`.
  Site timezone (IANA name). It decides where a day and a month start for energy totals, Billing and dashboard ranges, and it
  must have a whole-hour UTC offset in both January and July (Settings refuses any other zone). `DCDASH_TIMEZONE` in `.env` (or
  the `-Timezone` / `--timezone` flag of the setup script) only seeds this on first start.
  **Sign-in protection** sets how many failed sign-ins block an account (3 to 20) and for how many minutes (1 to 60); a change
  is applied at once. It is on by default and an administrator can switch it off (this asks for a confirmation and is
  audited); the two numbers are kept while it is off. While it is off a password can be guessed without limit (only the
  Argon2 time per attempt slows it), and it never switches itself back on.
  See [If you are blocked from signing in](operating.md#if-you-are-blocked-from-signing-in).
  The page also shows the version (the build id) and, with HTTPS, the certificate's expiry
  ([Optional HTTPS](install-and-run.md#optional-https)).
- **Tariffs** (admin sets, the Operator reads): needs `tariffs.view` and `assets.view`; changes need `tariffs.edit`. The site
  currency, the site default rate and per-asset rates, each with the date it is effective from. Give a new rate the date of the
  day it should start: a rate applies to whole local days. How cost is worked out from the rates, and what a move in the tree
  does to it, is in [Dashboards and billing](dashboards-and-billing.md).
- **Storage** (admin): needs `storage.view`; changes need `storage.edit`. See [Storage](storage.md). Its card **System events and the
  audit log** says how long system events are kept and, with `storage.edit`, changes it (**Change...**).
- **Displays** (admin): needs `displays.manage` and `dashboards.view`. Playlists (an ordered list of dashboards, each with an optional
  focus asset and 10 to 3600 seconds on screen) and displays, the screens that show one playlist from a secret link, with no sign-in.
  **New display** shows the link once, with **Copy link**. A screen's row menu has **Rename**, **Change playlist** and **Revoke**
  (asks first), and the trash button deletes it. Skipped playlist items say why. See [Display screens](display-screens.md).
- **Audit** (admin): needs `audit.view`. The read-only audit log, newest first, 50 entries per page by default (25, 50, 100 or
  200). Changes to configuration and access are recorded with who did it (the name stays even after the account is deleted),
  when, and for updates the values before and after; sign-in successes, failures and lockouts are recorded too. The toolbar
  searches and filters by user, action and a From to To range, has quick filters, **Go to date** and **Export CSV**
  (`audit.export`). A row, its chevron or its time opens the entry in a drawer on the right (the address becomes `/audit/ID`
  and keeps the log's filters and page), with **Previous** and **Next** to step through the log and a **Copy** button for the
  entry's number; Esc, Close or the browser's Back brings the log back exactly as it was. The friendly sentences name things
  instead of numbering them ("for asset MV2-R1-LV-Panel-02", or "a deleted asset" once it is gone); the Raw view, the
  drawer's JSON (behind **Show the stored JSON**, closed until you open it) and the CSV keep every id. A `tags.mapped` entry of the
  last 24 hours has **Undo this tag list** in its drawer for a person with `discovery.accept`; the server refuses it, in words, when
  anything the list made has changed since. Excel cuts a CSV cell at 32,767 characters, and a `tags.mapped` row can be longer. What is
  and is not recorded is listed under
  [Discovery](sources-and-discovery.md#discovery). The entry of a started connection check, test or Test all (`source.checked`,
  `source.tested`, `source.test_all`) also says how it ended: in the friendly view a small square tag after the sentence (`passed`,
  `failed` or `running`; none once the outcome is no longer kept), and in the drawer an **Outcome** row, always the last one, with a
  plain sentence ("The connection check failed at "secure channel"."; for Test all, "3 passed, 1 failed"). With `diagnostics.view` the
  row also has **Open in System events**, which opens the event that ended the job. The outcome is looked up when the entry is shown: it
  is not written into the audit row and not in the CSV, and a drawer showing "Still running." asks again every 5 seconds until the job ends.
- **System events** (admin): needs `diagnostics.view` and `sources.view` (the first opens its routes, the second is needed because each
  event names its source). What the system did by itself: sources going offline and coming back, connection checks, imports, history
  fills and errors. The audit log records who did what; System events records what the system did, and each links to the other where one
  caused the other (the **Open in System events** of an audit entry, and **Open the audit entry** in an event's drawer, for a person with
  `audit.view`, on the event that ended a check or a test someone started). A source that is down or reading badly is **one row that
  counts**, not a row for every failed read: it stays open ("ongoing") with its count and how long it has lasted, and when the source
  answers again it is closed and one recovery row says how long it lasted ("back online after 4 d 2 h"). The collector's own
  `scan.finished` entries (a scan ended) stay in the Audit log, where they were always written. On top, four tiles: **Open problems**
  (red above zero), **Warnings, last 24 h**, **Errors, last 24 h** and **Kept** (how many events and the oldest); under them **Happening
  now** lists the open problems, the first ten (**Show all open problems** shows the rest), one line each (`OPC UA server at 172.20.0.3:4840 is offline since 18 Oct 07:52 (4 d 2 h), 1,204 failed
  reads. Could not connect: the connection was refused.`). The toolbar filters by source, kind, level (Info, Warning, Error) and a From to
  To range, has **Open only** and **Export CSV** (at most 20,000 events; a longer range is refused with a sentence); the filters are in the
  address. **Friendly** shows a sentence per event with a square level tag, its source, and for an incident its count and duration;
  **Raw** shows the stored kind, code, message and data. A row, its chevron or its time opens the event in a drawer on the right (`/events/ID`) with
  when it began, last failed and ended (one time for an event that is not an incident), source, kind, code, count, duration, the message, **Copy**, **Show the stored JSON** (closed until
  you open it) and **Previous** and **Next**; Esc, Close or Back returns to the list as it was. The page refreshes itself every 10 seconds
  while no To day is set and no drawer is open: counts and closings change in place, and events that are new appear as one button
  ("3 new events") instead of moving the list. How long events are kept, and the card that changes it, are on Storage (see
  [Storage](storage.md#how-long-system-events-are-kept)).
- **Diagnostics** (admin): needs `diagnostics.view` and `sources.view`; the connection check needs `diagnostics.run`. Builds a
  report to paste when a real source fails, and runs a step-by-step connection check of one source. See
  [Field debugging](field-debugging.md).

## The profile panel

- **Profile panel** (everyone): the name block at the right of the top bar. **Mode** (Light, Dark or Match my device) and
  **Theme colour** (Navy and gold, Maroon and gold, Graphite or Desert gold) are kept per account and follow you to any
  browser. It also holds the links to Password and Sign out.
- **Password** (everyone): change your own password; your other sessions are signed out.

Related: [Install and run](install-and-run.md), [Assets and kinds](assets-and-kinds.md), [Sources and discovery](sources-and-discovery.md), [Dashboards and billing](dashboards-and-billing.md), [Dashboard figures, templates and the guide](dashboard-figures-and-templates.md), [Storage](storage.md), [Roles and permissions](roles-and-permissions.md), [Operating the stack](operating.md), [Field debugging](field-debugging.md).
