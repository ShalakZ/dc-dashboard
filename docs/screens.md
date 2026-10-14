# Screens

This page lists every screen of the web app, what it is for and who can open it, in the order of the sidebar. It is for anyone
who uses the app or decides who may use which part of it. "Everyone", "operators" and "admins" mean the built-in Viewer,
Operator and Admin roles; the permission ids in each entry are what a role of your own needs, and the full list is on
[Roles and permissions](roles-and-permissions.md). The sidebar shows only the links a person may open, and a page their role
lacks says "No access".

## Monitor

- **Assets Tree** (everyone): needs `assets.view`. Your asset hierarchy on the left and, beside it, the fleet summary (the
  Assets, Live power, Energy today and Cost today tiles) or the asset you opened, with its live values and charts. Adding and
  editing assets and mapping points needs `assets.edit` (also needed to pick several assets and move them), deleting
  `assets.delete`. See [Assets and kinds](assets-and-kinds.md).
- **Asset kinds** (everyone reads, admins change): the Asset kinds button of the Assets Tree (`/assets/kinds`). Reading needs
  `assets.view`; adding, renaming, re-iconing and deleting kinds needs `assets.kinds`. See [Asset kinds](assets-and-kinds.md#asset-kinds).
- **Dashboards** (everyone can read; operators and admins build): needs `dashboards.view`; building needs `dashboards.edit`.
  Shared dashboards of widgets. An admin (`dashboards.default`) can mark one as the default, and the sidebar entry and the
  first page after signing in then open it. See [Dashboards and billing](dashboards-and-billing.md).
- **Billing** (everyone): needs `billing.view`. Energy and cost per asset per day and per month, picked with the Year and Month
  selects, with a CSV export (`billing.export`). See [Dashboards and billing](dashboards-and-billing.md).

## Operate

- **Sources** (operators and admins): needs `sources.view`. The data sources with their status, last error and the age of their
  newest reading, and a notice when the collector has gone quiet (see [Health](operating.md#health)). **Test** and **Test all**
  need `sources.test`; adding, editing and deleting sources needs `sources.edit`. See
  [Sources and discovery](sources-and-discovery.md).
- **Points** of a source (admins): the Points item of a source's row menu; needs `sources.edit`. **Browse points** asks the source
  what it offers; **Map** ties a point to an asset.
- **Scans** and **Discovery** (operators and admins; only admins can change anything): need `discovery.view`. Scans lists the
  scan scopes and their results; Discovery shows what was found as a graph to map by drag and drop. Changing scopes and the
  layout needs `discovery.edit`, running a scan `discovery.scan`, accepting results `discovery.accept`. See
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
