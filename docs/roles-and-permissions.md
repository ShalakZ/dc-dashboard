# Roles and permissions

Every action in the API needs a named permission, and an account holds one role: a role is a set of permissions. The screens only hide
what the server would refuse. There are 30 permissions, in groups by area. A **See** permission opens a page, a **Change** permission
edits what is on it, and a few risky actions are separate on purpose (deleting assets, exporting billing or the audit log, running
scans, accepting scan results, choosing the default dashboard, changing sign-in protection, managing asset kinds, managing roles).

**Built-in roles.** Viewer, Operator and Admin exist from the start. They cannot be edited or deleted (the API answers 409), and they
behave as they did before roles were made of permissions (the one change, in W9b, is below):

- **Viewer**: `assets.view`, `dashboards.view`, `billing.view`, `billing.export`.
- **Operator**: everything a Viewer has, plus `dashboards.edit`, `tariffs.view`, `sources.view`, `sources.test`, `discovery.view` and
  `diagnostics.run`.
- **Admin**: every permission in the catalogue, now and when a later release adds one (it is computed from the catalogue, not stored).

**The 30 permissions** (`backend/dcdash/core/permissions.py` is the one list; the Roles tab draws from it):

| Area | Permission | What it allows |
|---|---|---|
| Assets Tree | `assets.view` | Open the Assets Tree, an asset's details and charts, and the fleet summary. |
| | `assets.edit` | Add and edit assets, map points to them and move assets in the Assets Tree. |
| | `assets.delete` | Delete an asset (its mappings go with it). |
| | `assets.kinds` | Create, rename, re-icon and delete asset kinds (a rename or a move changes the kind of every asset that uses it), and add the data-centre starter kinds. |
| Dashboards | `dashboards.view` | Open dashboards and their widgets, receive live values, and read the values of any point through a widget. |
| | `dashboards.edit` | Create, edit and delete dashboards and their widgets. |
| | `dashboards.default` | Choose the dashboard everybody lands on. |
| Billing and tariffs | `billing.view` | Open the Billing page: energy and cost per asset and month. |
| | `billing.export` | Download the billing table as a CSV file. |
| | `tariffs.view` | Open the Tariffs page, read-only (with `assets.view`), and read the tariff list and the currency. |
| | `tariffs.edit` | Set the currency, the site rate and per-asset rates (with `tariffs.view` and `assets.view`). |
| Sources and discovery | `sources.view` | Open the Sources page, a source's points and the collector status. |
| | `sources.edit` | Add, edit and delete data sources and browse their points. |
| | `sources.test` | Make the server try to reach a source (Test and Test all). |
| | `discovery.view` | Open the Scans and Discovery pages. |
| | `discovery.edit` | Add, edit and delete scan scopes; save the graph layout. |
| | `discovery.scan` | Start a scan of a scope (it probes a network). |
| | `discovery.accept` | Turn scan results into sources, assets and mappings. |
| Storage and settings | `storage.view` | Open the Storage page. |
| | `storage.edit` | Change retention, compression and disk limits. |
| | `settings.view` | Open the Settings page. |
| | `settings.edit` | Change the general settings, such as the time zone. |
| | `settings.security` | Switch the sign-in protection on or off and change its limits. |
| Audit log | `audit.view` | Open the audit log and its entries. |
| | `audit.export` | Download the audit log as CSV. |
| Users | `users.view` | Open the Users tab of Users & Roles. |
| | `users.edit` | Create, edit, deactivate and delete accounts; reset passwords; lift sign-in blocks. |
| Roles | `roles.manage` | Create, edit and delete roles. Only the built-in Admin role holds it. |
| Diagnostics | `diagnostics.view` | Open the Diagnostics page (with `sources.view`) and build a report, which includes settings, retention, the audit tail and each source's security settings. |
| | `diagnostics.run` | Run the step-by-step connection check of a source. |

A few things that are easy to miss:

- **Sign-in protection has its own permission.** The Settings page has two cards: General (`settings.edit`, the time zone) and
  Sign-in protection (`settings.security`: the switch and its two numbers). Whoever holds `settings.security` can switch the protection
  off, so it is a sensitive action; a role with only `settings.edit` sees that card read-only, and the API refuses it (403).
- **A custom role can never manage roles.** `roles.manage` is held by the built-in Admin role only: the API refuses a role that lists it
  (422), and a stored list that happens to name it grants nothing.
- **Nobody can pass on more than they hold** (the subset rule). You can save a role, or give an account a role, only if you hold every
  permission that role grants. And you can change an account (reset its password, deactivate or reactivate it, change its role, unblock
  it, delete it) only if you hold every permission its role grants. That second half is why `users.edit` cannot be used to become
  Admin: resetting an Admin's password, or giving anyone the Admin role, needs `roles.manage`, which no custom role has. Changing your
  own role is refused (409), and so is deactivating or deleting yourself; the last active Admin can never be removed.
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
- **Two small changes for the API's callers.** A role name in `POST /api/users` or `PATCH /api/users/{id}` is matched ignoring case, so
  `"Operator"` and `"ADMIN"` are accepted (they used to be refused with a 422), and an unknown name answers 422 with
  `{"detail": "unknown role"}` (it used to be a list of validation errors). Authorization is checked before the request body is
  validated; the one exception is a body that is not valid JSON at all, which gets its 422 first, signed in or not.
- **A page the role lacks** shows the heading "No access" and "Your role does not include this page." (this replaces the old "Admins
  only" and "Operators only"). A role that holds no permission at all can sign in, change its own password and read the site name, the
  version and the status chip, and lands on "Your role has no pages yet." (the top bar and the page, with no sidebar). An action the
  role lacks is refused, and where the page shows the reason it reads "Your role does not allow this."
- **Where an account lands** after signing in: the default dashboard if there is one and the role may see dashboards, else the Assets
  Tree, else the first page its sidebar offers.
- **Everything is audited.** `role.created`, `role.updated` and `role.deleted` are in the Audit log with the permissions added and removed,
  and a change of an account's role lists the permissions it adds and removes.

**Making a role.** Signed in as an administrator, open **Users & Roles**, then the **Roles** tab (only the Administrator role has it). The
list shows each role's accounts. **New role** opens an editor: a name (1 to 64 characters, unique
ignoring case, not a built-in name), an optional description, and the permissions as a grid with one row per area, **See** (opens the page)
and **Change** (edits what is on it), then **Sensitive actions**. **Start from** Viewer or Operator ticks their permissions for you
(choosing one replaces the ticks). Under the grid a summary says what the ticks add up to ("Opens: Assets Tree, Dashboards, Billing."),
and a line names a tick whose page would still show nothing ("Export billing as CSV also needs See billing ..."), but that line never ticks anything,
because the server accepts any combination. A row's menu has **Edit** and **Duplicate** (a built-in role says **View** instead:
it opens locked, with a Duplicate button), and the bin deletes a role nobody holds (it is disabled, with the reason, while an account has it).

**Offers while you tick (W9c).** Tick a permission whose page would show nothing without another one (**Change users** without **See users**)
and a small card opens beside the box: "Change users also needs See users to show anything." with **Also tick See users** (when several are
missing it lists them and one button ticks them all) and **Not now**. Not now, Escape, a click elsewhere and tabbing away all mean Not now:
the box stays ticked, the hint line stays and nothing is ticked for you. Unticking a permission that another ticked one needs (untick
**See users** while **Change users** is ticked) opens the reverse card, "Also untick Change users?", with **Leave ticked** as the quiet answer.
The card ignores the mouse for its first 0.4 seconds, so a quick click on the next box still reaches that box. Nothing opens when a role is
loaded, **Start from** is chosen or a role is duplicated, and Save still sends exactly the boxes that are ticked. This is the editor only:
there is no migration and no API change (the server still accepts any combination).

The Executive, who reads energy and cost and nothing else: Roles > **New role**, name `Executive`, tick **See the Assets Tree**,
**See dashboards**, **See billing** and **Export billing as CSV**, a **Description** such as `Sees energy and cost` (optional), **Save**. On
the Users tab, create the account and choose `Executive` in **Role** (when the role has a description, a line under the form shows it; a role
without one shows no line). That person's sidebar is Assets Tree, Dashboards and Billing, every other
page says "No access", and the API refuses the rest. Tick **See tariffs** later and the open page of that account offers a Reload.

**The same through the API.** `GET /api/permissions` lists the ids; `POST /api/roles` creates a role (201, with its id and the sorted permissions);
`PATCH /api/roles/{id}` changes its name, description or permissions; `DELETE /api/roles/{id}` removes it; `POST /api/roles/{id}/duplicate`
makes an editable copy of any role (an optional `{"name": "..."}` names it). A role name is 1 to 64 characters, unique ignoring case, and
may not be a built-in name. An example body for a role that reads energy and cost and nothing else:

    {"name": "Executive", "description": "Reads energy and cost", "permissions": ["assets.view", "dashboards.view", "billing.view", "billing.export"]}

From the browser's developer console on any page of the site, signed in as an administrator, this sends it with your session:

    await fetch("/api/roles", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Executive", description: "Reads energy and cost",
        permissions: ["assets.view", "dashboards.view", "billing.view", "billing.export"] }) }).then((r) => r.json())

Give the role to an account by its **name**, matched ignoring case: `POST /api/users` or `PATCH /api/users/{id}` with `"role": "Executive"`.
The Users tab lists the role of every account (an account with a custom role keeps it when you edit its other fields). Its Create
user form and role choice offer the roles the server says you may hand out (the built-in names first, then the others by name), and a
row whose role grants something you lack is shown read-only, with no role choice, menu or trash can. A person who may not hand out a role
never sees it offered once the page has the server's list of roles (while that list is loading, or could not be read, the three built-in
names are shown and the server still refuses what is not allowed).

**What changed in W9b.** The built-in roles keep their permissions; the one thing a person will notice is that the built-in **Operator**,
who has held `tariffs.view` since W9a, now sees **Tariffs** in the sidebar and the quick find (Ctrl+K), opens the page read-only (no forms,
no row menus) and may read the currency (`GET /api/settings/billing` answers 200 instead of 403; setting it stays `tariffs.edit`). The
missing-rate banner on Billing still tells the Operator to "Ask an administrator". Sign-in protection moved out of `settings.edit` into
`settings.security`, so **a role made through the API before W9b that holds `settings.edit` lacks `settings.security` until someone ticks
it** on the Roles tab (the Administrator has every permission and is unaffected). The `permissions` column of the three built-in rows in
the database is the snapshot migration `0009` wrote (28 ids, no `settings.security` and, since W7o, no `assets.kinds`) and is never refreshed: a
built-in role's permissions come from the code, so reading that column shows an Admin row without them, and nothing is affected.
