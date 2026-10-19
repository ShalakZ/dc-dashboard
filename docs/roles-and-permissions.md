# Roles and permissions

This page is for the administrator who decides who may do what, and for a developer who calls the API. Every action in the API needs a
named permission; an account holds one role, and a role is a set of permissions. The screens only hide what the server would refuse.
The page lists the 31 permissions, the three built-in roles, how to make a role of your own, the safeguards, and the same through the API.

## The permissions

`backend/dcdash/core/permissions.py` is the one list (the `CATALOGUE`); the Roles tab and `GET /api/permissions` draw from it, and
`frontend/src/lib/permissions.ts` mirrors its ids and labels (`backend/tests/test_permissions_parity.py` fails when the two drift).
There are 31 permissions, in groups by area. Each has a kind: a **see** permission opens a page, a **change** permission edits what is
on it, and a **risky** permission is a sensitive action kept apart on purpose (deleting assets, managing asset kinds, choosing the
default dashboard, exporting billing or the audit log, closing billing months, running scans, accepting scan results, changing sign-in protection, managing
roles). The Roles editor shows the risky ones under **Sensitive actions**.

"Also needs" is what the Roles editor suggests ticking with it (`PERMISSION_NEEDS` in `frontend/src/lib/roleEditor.ts`): without
those, the page or the control shows nothing. The server does not enforce these pairs; see [Offers while you tick](#offers-while-you-tick).

| Area | Permission | Label | Kind | What it allows | Also needs |
|---|---|---|---|---|---|
| Assets Tree | `assets.view` | See the Assets Tree | see | Open the Assets Tree, an asset's details and charts, and the fleet summary. | |
| | `assets.edit` | Change assets | change | Add and edit assets and map points to them. | `assets.view` |
| | `assets.delete` | Delete assets | risky | Delete an asset (its mappings go with it). | `assets.view` |
| | `assets.kinds` | Manage asset kinds | risky | Create, rename, re-icon and delete asset kinds (a rename or a move changes the kind of every asset that uses it), and add the data-centre starter kinds. | `assets.edit`, `assets.view` |
| Dashboards | `dashboards.view` | See dashboards | see | Open dashboards and their widgets, receive live values, and read the values of any point through a widget. | |
| | `dashboards.edit` | Change dashboards | change | Create, edit and delete dashboards and their widgets. | `dashboards.view`, `assets.view`, `discovery.view` |
| | `dashboards.default` | Choose the default dashboard | risky | Choose the dashboard everybody lands on. | `dashboards.view` |
| Billing and tariffs | `billing.view` | See billing | see | Open the Billing page: energy and cost per asset and month. | |
| | `billing.export` | Export billing as CSV | risky | Download the billing table as a CSV file. | `billing.view` |
| | `billing.close` | Close and reopen billing months | risky | Close a finished month so its billed figures stop changing, and reopen it with a reason ([Closing a month](dashboards-and-billing.md#closing-a-month)). Admin only by default. | `billing.view` |
| | `tariffs.view` | See tariffs | see | Open the Tariffs page, read-only (it also needs See the Assets Tree). | `assets.view` |
| | `tariffs.edit` | Change tariffs | change | Set the currency, the site rate and per-asset rates. | `tariffs.view`, `assets.view` |
| Sources and discovery | `sources.view` | See sources | see | Open the Sources page, a source's points and the collector status. | |
| | `sources.edit` | Change sources | change | Add, edit and delete data sources and browse their points. | `sources.view` |
| | `sources.test` | Test source connections | change | Make the server try to reach a source (Test and Test all). | `sources.view` |
| | `discovery.view` | See scans and the graph | see | Open the Scans and Discovery pages. | |
| | `discovery.edit` | Change scan scopes and the graph layout | change | Add, edit and delete scan scopes; save the graph layout; remove discovered sources that have nothing mapped. | `discovery.view` |
| | `discovery.scan` | Run network scans | risky | Start a scan of a scope (it probes a network). | `discovery.view` |
| | `discovery.accept` | Accept scan results | risky | Turn scan results into sources, assets and mappings. | `discovery.view` |
| Storage and settings | `storage.view` | See storage | see | Open the Storage page. | |
| | `storage.edit` | Change storage settings | change | Change retention, compression and disk limits. | `storage.view` |
| | `settings.view` | See settings | see | Open the Settings page. | |
| | `settings.edit` | Change settings | change | Change the general settings, such as the time zone. | `settings.view` |
| | `settings.security` | Change sign-in protection | risky | Switch the brute-force protection on or off and change its limits. | `settings.view` |
| Audit log | `audit.view` | See the audit log | see | Open the audit log and its entries. | |
| | `audit.export` | Export the audit log | risky | Download the audit log as CSV. | `audit.view` |
| Users | `users.view` | See users | see | Open the Users tab of Users & Roles. | |
| | `users.edit` | Change users | change | Create, edit, deactivate and delete accounts; reset passwords; lift sign-in blocks. | `users.view` |
| Roles | `roles.manage` | Manage roles | risky | Create, edit and delete roles. Only the built-in Admin role holds it. | |
| Diagnostics | `diagnostics.view` | See diagnostics | see | Open the Diagnostics page and build a report, which includes settings, retention, the audit tail and each source's security settings. | `sources.view` |
| | `diagnostics.run` | Run the connection check | change | Run the step-by-step connection check of a source. | `sources.view` |

`billing.close` is held by the built-in Admin only, until an administrator ticks it on a role of their own (unlike `roles.manage` it can
be ticked on a custom role, as `billing.export` can). Migration `0012` gave it to no role, so after an upgrade nobody but the Admin can
close or reopen a month. It needs See billing: the buttons live on the Billing page, so the Roles editor offers to tick **See billing**
with it, and the API refuses a person without the permission with a 403 whatever the page shows.

See billing also opens **Check month** on the Billing page, a read-only list of what to look at in a month's readings
(`GET /api/billing/month-check`, [Checking a month](dashboards-and-billing.md#checking-a-month)); the names of the points and sources
in it are shown only to a person who also holds See sources, and a point's address never. It does include each meter's reading
interval (`interval_seconds`, the polling the mapping states) and, for a counter that went back, the size of the fall in the meter's own
units.

`assets.view` also decides who may use a dashboard's focus ([A focus asset](dashboards-and-billing.md#dashboards)): choosing one with
the **Focus** button, the **Open <name> page** link, and the click on a bar of a breakdown that narrows the dashboard or opens an
asset's page all need See the Assets Tree. A role with only `dashboards.view` sees the whole site: the controls are not there, a link
with `?asset=<id>` is ignored (the page says "This link opens the dashboard on one asset. Your role cannot open assets, so it shows the
whole site."), and the server refuses a `POST /api/widget-data` or `/api/widget-data/csv` that carries a `focus` with a 403
(`INSUFFICIENT_PERMISSION`). A request without `focus` is unchanged. **Change dashboards** lists See the Assets Tree under "Also needs"
(the widget form picks assets), so a role with both sees the Focus button when it views a dashboard; starting a
dashboard from Power needs only `dashboards.edit`. There is no per-asset visibility, so See the Assets Tree opens the whole tree and a
focus can name any asset in it.

`assets.edit` also lets a person move assets in the Assets Tree ([Moving assets](assets-and-kinds.md#moving-assets)); deleting the picked
assets from the tree's pick bar needs `assets.delete` as well ([Deleting several assets](assets-and-kinds.md#deleting-several-assets)).

`assets.edit` also covers taking a mapping off an asset or moving it to another one, and the 10-second Undo of either and of a mapping made
in Discovery: **Unmap…** and **Move to another asset…** on an asset's Metrics table, on a source's Points page and on the Discovery canvas
([Taking mappings off an asset or moving them](assets-and-kinds.md#taking-mappings-off-an-asset-or-moving-them)), and the routes under
`/api/mappings`, `GET` included (the one exception is `GET /api/mappings/{id}/latest`, the last reading of a mapped point that
Discovery shows in a small card when you rest the pointer on it: it needs only `assets.view`, like every other read of a value). On the Discovery canvas it is also the permission to make an asset with the New asset form (**New
asset…**, **New sub-asset…**, the **+** on an asset node), which needs `assets.view` as well because it lists the assets. `discovery.accept` is
what maps: **Map…**, the drop onto an asset, **Review mappings** and **Create assets…**. The two are separate: a role with
`discovery.accept` but not `assets.edit` maps and sees the toast `Mapped 6 points to Room 1.` with no Undo, and a role with `assets.edit`
but not `discovery.accept` can unmap and move but not map ([Sources and discovery](sources-and-discovery.md#discovery)).

## Built-in roles

Viewer, Operator and Admin exist from the start. They cannot be edited or deleted (the API answers 409). Their permissions come from
`BUILTIN` in `permissions.py`:

- **Viewer**: `assets.view`, `dashboards.view`, `billing.view`, `billing.export`.
- **Operator**: everything a Viewer has, plus `dashboards.edit`, `tariffs.view`, `sources.view`, `sources.test`, `discovery.view` and
  `diagnostics.run`. With `tariffs.view` an Operator sees **Tariffs** in the sidebar and in quick find (Ctrl+K), opens it read-only (no
  forms, no row menus) and may read the currency (`GET /api/settings/billing`; setting it needs `tariffs.edit`). The missing-rate banner
  on Billing tells the Operator to "Ask an administrator".
- **Admin**: every permission in the catalogue, now and when a later release adds one (it is computed from the catalogue, not stored).

What the three roles mean for dashboards, billing and tariffs is summed up in [Dashboards and billing](dashboards-and-billing.md).

## Rules that are easy to miss

- **Sign-in protection has its own permission.** The Settings page has two cards: General (`settings.edit`, the time zone) and
  Sign-in protection (`settings.security`: the switch and its two numbers). Whoever holds `settings.security` can switch the protection
  off, so it is a sensitive action; a role with only `settings.edit` sees that card read-only, and the API refuses it (403).
- **A custom role can never manage roles.** `roles.manage` is held by the built-in Admin role only: the API refuses a role that lists it
  (422), and a stored list that happens to name it grants nothing.
- **Nobody can pass on more than they hold** (the subset rule). You can save a role, or give an account a role, only if you hold every
  permission that role grants (otherwise 403, "cannot save a role with more access than yours"). And you can change an account (reset
  its password, deactivate or reactivate it, change its role, unblock it, delete it) only if you hold every permission its role grants.
  That second half is why `users.edit` cannot be used to become Admin: resetting an Admin's password, or giving anyone the Admin role,
  needs `roles.manage`, which no custom role has.
- **Changes to yourself are refused.** Changing your own role is refused (409), and so is deactivating or deleting yourself; the last
  active Admin can never be removed (409).
- **Two pages need more than their own permission.** The Diagnostics page needs `diagnostics.view` and `sources.view`, and the
  Tariffs page needs `tariffs.view` and `assets.view` (it lists the assets its rates belong to); `tariffs.edit` turns its forms on. A role
  with only `diagnostics.view` gets "No access" on the Diagnostics page, and one with only `tariffs.view` gets it on Tariffs. The Roles tab
  says so in words under the role's ticks ("... also needs ...") before you save.
- **A role that accounts hold cannot be deleted** (409, with the number of accounts). Duplicating Admin gives a role with every
  permission except `roles.manage`.
- **There is no per-site or per-asset scoping yet.** A permission applies to the whole site: `assets.view` shows every asset.
- **A change takes effect on the person's next request**, with no cache in between. A page that person already has open keeps what it
  loaded, notices on its next focus (or the first request that is refused) and shows "Your access changed. Reload to see what you can
  use now." (or "Your role changed from X to Y. Reload the page to continue." when the role itself was changed).
- **A page the role lacks** shows the heading "No access" and "Your role does not include this page.". A role that holds no permission
  at all can sign in, change its own password and read the site name, the version and the status chip, and lands on "Your role has no
  pages yet." (the top bar and the page, with no sidebar). An action the role lacks is refused, and where the page shows the reason it
  reads "Your role does not allow this."
- **Where an account lands** after signing in: the default dashboard if there is one and the role may see dashboards, else the Assets
  Tree, else the first page its sidebar offers.
- **Everything is audited.** `role.created`, `role.updated` and `role.deleted` are in the Audit log with the permissions added and removed,
  and a change of an account's role lists the permissions it adds and removes.

## Making a role

Signed in as an administrator, open **Users & Roles**, then the **Roles** tab (it needs `roles.manage`, so only the Administrator role
has it). The list shows each role's accounts. **New role** opens an editor:

- a name (1 to 64 characters, unique ignoring case, not a built-in name: Viewer, Operator, Admin or Administrator in any case);
- an optional description (at most 200 characters);
- the permissions as a grid with one row per area, **See** (opens the page) and **Change** (edits what is on it), then **Sensitive
  actions**. `roles.manage` is never offered as a box.

**Start from** Viewer or Operator ticks their permissions for you (choosing one replaces the ticks). Under the grid a summary says what
the ticks add up to ("Opens: Assets Tree, Dashboards, Billing."), and a line names a tick whose page would still show nothing ("Export
billing as CSV also needs See billing ..."). That line never ticks anything, because the server accepts any combination. A row's menu
has **Edit** and **Duplicate** (a built-in role says **View** instead: it opens locked, with a Duplicate button), and the bin deletes a
role nobody holds (it is disabled, with the reason, while an account has it).

### Offers while you tick

Tick a permission whose page would show nothing without another one (**Change users** without **See users**) and a small card opens
beside the box: "Change users also needs See users to show anything." with **Also tick See users** (when several are missing it lists
them and one button ticks them all) and **Not now**. Not now, Escape, a click elsewhere and tabbing away all mean Not now: the box stays
ticked, the hint line stays and nothing is ticked for you. Unticking a permission that another ticked one needs (untick **See users**
while **Change users** is ticked) opens the reverse card, "Change users needs See users to show anything. Also untick Change users?",
with **Leave ticked** as the quiet answer. The card ignores the mouse for its first 0.4 seconds, so a quick click on the next box still
reaches that box. Nothing opens when a role is loaded, **Start from** is chosen or a role is duplicated, and Save sends exactly the boxes
that are ticked. The pairs are the "Also needs" column of [the table above](#the-permissions); the card is the editor's help only, and
the server still accepts any combination.

### Example: the Executive

The Executive reads energy and cost and nothing else. Roles > **New role**, name `Executive`, tick **See the Assets Tree**, **See
dashboards**, **See billing** and **Export billing as CSV**, a **Description** such as `Sees energy and cost` (optional), **Save**. On
the Users tab, create the account and choose `Executive` in **Role** (when the role has a description, a line under the form shows it;
a role without one shows no line). That person's sidebar is Assets Tree, Dashboards and Billing, every other page says "No access", and
the API refuses the rest. Tick **See tariffs** later and the open page of that account offers a Reload.

## The same through the API

| Route | Needs | Does |
|---|---|---|
| `GET /api/permissions` | `roles.manage` | The catalogue: `id`, `area`, `kind`, `label` and `description` of every permission, in catalogue order |
| `GET /api/roles` | `roles.manage`, `users.view` or `users.edit` | Every role with its account count; the permissions only for a holder of `roles.manage` |
| `POST /api/roles` | `roles.manage` | Creates a role (201, with its id and the permissions in catalogue order) |
| `PATCH /api/roles/{id}` | `roles.manage` | Changes its name, description or permissions |
| `DELETE /api/roles/{id}` | `roles.manage` | Removes a role nobody holds (204) |
| `POST /api/roles/{id}/duplicate` | `roles.manage` | An editable copy of any role (an optional `{"name": "..."}` names it, else "Copy of ...") |

A role name is 1 to 64 characters, unique ignoring case, and may not be a built-in name. A permission list with an unknown id, an id
given twice, or `roles.manage` is refused with a 422. An example body for a role that reads energy and cost and nothing else:

    {"name": "Executive", "description": "Reads energy and cost", "permissions": ["assets.view", "dashboards.view", "billing.view", "billing.export"]}

From the browser's developer console on any page of the site, signed in as an administrator, this sends it with your session:

    await fetch("/api/roles", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Executive", description: "Reads energy and cost",
        permissions: ["assets.view", "dashboards.view", "billing.view", "billing.export"] }) }).then((r) => r.json())

Give the role to an account by its **name**, matched ignoring case: `POST /api/users` or `PATCH /api/users/{id}` with
`"role": "Executive"` (so `"Operator"` and `"ADMIN"` are accepted). An unknown name answers 422 with `{"detail": "unknown role"}`.
Authorization is checked before the request body is validated; the one exception is a body that is not valid JSON at all, which gets
its 422 first, signed in or not.

The Users tab lists the role of every account (an account with a custom role keeps it when you edit its other fields). Its Create user
form and role choice offer the roles the server says you may hand out (the built-in names first, then the others by name), and a row
whose role grants something you lack is shown read-only, with no role choice, menu or trash can. A person who may not hand out a role
never sees it offered once the page has the server's list of roles (while that list is loading, or could not be read, the three
built-in names are shown and the server still refuses what is not allowed).

## Notes for sites upgraded from older releases

- Sign-in protection used to be part of `settings.edit` and now has `settings.security` (a change of the W9b release, see [CHANGELOG.md](../CHANGELOG.md)). **A role made through the API before that release
  that holds `settings.edit` lacks `settings.security` until someone ticks it** on the Roles tab (the Administrator has every
  permission and is unaffected).
- The `permissions` column of the three built-in rows in the database is the snapshot migration `0009` wrote (28 ids, without
  `settings.security` and `assets.kinds`) and is never refreshed. A built-in role's permissions come from the code, so reading that
  column shows an Admin row without them, and nothing is affected.
- Close and reopen billing months (`billing.close`, release W11) was given to no role by its migration `0012`: only the Administrator
  holds it until you tick it on a role of your own (Sensitive actions on the Roles tab). Nothing a role could do before is taken away.
- What each release changed is in [CHANGELOG.md](../CHANGELOG.md).

Related: [Screens](screens.md), [Dashboards and billing](dashboards-and-billing.md), [Assets and kinds](assets-and-kinds.md), [Operating the stack](operating.md)
