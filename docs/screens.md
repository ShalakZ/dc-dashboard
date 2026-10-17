# Screens

This page lists every screen of the web app behind the sign-in, what it is for and who can open it, in the order of the sidebar. It is for anyone
who uses the app or decides who may use which part of it. "Everyone", "operators" and "admins" mean the built-in Viewer,
Operator and Admin roles; the permission ids in each entry are what a role of your own needs, and the full list is on
[Roles and permissions](roles-and-permissions.md). The sidebar shows only the links a person may open, and a page their role
lacks says "No access".

## Monitor

- **Assets Tree** (everyone): needs `assets.view`. Your asset hierarchy on the left and, beside it, the fleet summary (the
  Assets, Live power, Energy today and Cost today tiles) or the asset you opened, with its live values and charts. The trail above
  an open asset (`Assets Tree / MV2 / Room 1 / LVP02`) shows each asset's own icon beside its name, the same icon as in the tree. Adding and
  editing assets and mapping points needs `assets.edit` (also needed to pick several assets and move them), deleting
  `assets.delete`. With `assets.edit` each row of an open asset's **Metrics** table has a menu (`Actions for <metric>`) with **Unmap…** and
  **Move to another asset…**, which ask first and offer an Undo for 10 seconds. See [Assets and kinds](assets-and-kinds.md).
- **Asset kinds** (everyone reads, admins change): the Asset kinds button of the Assets Tree (`/assets/kinds`). Reading needs
  `assets.view`; adding, renaming, re-iconing and deleting kinds needs `assets.kinds`. See [Asset kinds](assets-and-kinds.md#asset-kinds).
- **Dashboards** (everyone can read; operators and admins build): needs `dashboards.view`; building needs `dashboards.edit`.
  Shared dashboards of widgets. An admin (`dashboards.default`) can mark one as the default, and the sidebar entry and the
  first page after signing in then open it. See [Dashboards and billing](dashboards-and-billing.md).
- **Billing** (everyone): needs `billing.view`. Energy and cost per asset per day and per month, picked with the Year and Month
  selects, with a CSV export (`billing.export`). An admin (`billing.close`) can **Close month…** on a finished month with data, which
  freezes its figures and CSV as they stand: the month then carries a **Closed** chip and a banner, "Closed by <name> on <date>", with
  the note given; a quiet line, "Today's tree and rates would give ..." (or "... give the same figures."), says how today's tree and rates
  compare; and **Reopen month…** (a reason of at least 5 characters; download the CSV first, the app does not show the closed figures
  again) goes back to today's figures. See
  [Closing a month](dashboards-and-billing.md#closing-a-month) and [Dashboards and billing](dashboards-and-billing.md).

## Operate

- **Sources** (operators and admins): needs `sources.view`. The data sources with their status, last error and the age of their
  newest reading, and a notice when the collector has gone quiet (see [Health](operating.md#health)). **Test** and **Test all**
  need `sources.test`; adding, editing and deleting sources needs `sources.edit`. See
  [Sources and discovery](sources-and-discovery.md).
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
  opened by `?` on the canvas, and **More Discovery actions**, which holds **Clear unmapped** for an admin). On a narrower window the bar
  shows icons only, and on a still narrower one the less used controls move into the More menu. An open group of more than 50 points
  shows 50 and a **Show 50 more** button at the end of its list; an asset with sub-assets has a small arrow to fold them away. Arrow keys
  move between nodes and Enter opens or closes one. Every node starts with a small icon (a source shows its protocol, a point what it
  measures, an asset its own icon), and a source is a card: its short name, the protocol and address, a status dot with the status in
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
- **Storage** (admin): needs `storage.view`; changes need `storage.edit`. See [Storage](storage.md).
- **Audit** (admin): needs `audit.view`. The read-only audit log, newest first, 50 entries per page by default (25, 50, 100 or
  200). Changes to configuration and access are recorded with who did it (the name stays even after the account is deleted),
  when, and for updates the values before and after; sign-in successes, failures and lockouts are recorded too. The toolbar
  searches and filters by user, action and a From to To range, has quick filters, **Go to date** and **Export CSV**
  (`audit.export`). A row, its chevron or its time opens the entry in a drawer on the right (the address becomes `/audit/ID`
  and keeps the log's filters and page), with **Previous** and **Next** to step through the log and a **Copy** button for the
  entry's number; Esc, Close or the browser's Back brings the log back exactly as it was. The friendly sentences name things
  instead of numbering them ("for asset MV2-R1-LV-Panel-02", or "a deleted asset" once it is gone); the Raw view, the
  drawer's JSON and the CSV keep every id. What is and is not recorded is listed under
  [Discovery](sources-and-discovery.md#discovery).
- **Diagnostics** (admin): needs `diagnostics.view` and `sources.view`; the connection check needs `diagnostics.run`. Builds a
  report to paste when a real source fails, and runs a step-by-step connection check of one source. See
  [Field debugging](field-debugging.md).

## The profile panel

- **Profile panel** (everyone): the name block at the right of the top bar. **Mode** (Light, Dark or Match my device) and
  **Theme colour** (Navy and gold, Maroon and gold, Graphite or Desert gold) are kept per account and follow you to any
  browser. It also holds the links to Password and Sign out.
- **Password** (everyone): change your own password; your other sessions are signed out.

Related: [Install and run](install-and-run.md), [Assets and kinds](assets-and-kinds.md), [Sources and discovery](sources-and-discovery.md), [Dashboards and billing](dashboards-and-billing.md), [Storage](storage.md), [Roles and permissions](roles-and-permissions.md), [Operating the stack](operating.md), [Field debugging](field-debugging.md).
