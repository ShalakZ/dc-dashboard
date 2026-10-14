# Screens

UI screens, besides Assets Tree, Sources and Points:

- **Asset kinds**: see [Asset kinds](assets-and-kinds.md).
- **Users & Roles** (admin): on its **Users** tab, create users, change roles, deactivate / reactivate, reset a password, delete a user
  (after a confirmation; never yourself and never the last administrator). Deactivating signs that user out
  everywhere. You cannot deactivate, demote or delete yourself. An account that has been blocked after too many
  failed sign-ins shows `blocked`, and **Unblock** lets it in at once; see "If you are blocked from signing in".
  Its **Roles** tab makes and edits roles; see "Roles and permissions".
- **Settings** (admin): site timezone (IANA name). It decides where a day and a month start for energy
  totals, Billing and dashboard ranges, and it must have a whole-hour UTC offset in both January and
  July (Settings refuses any other zone). `DCDASH_TIMEZONE` in `.env` (or the `-Timezone` / `--timezone` flag of the setup script) only seeds this on first start.
  **Sign-in protection** sets how many failed sign-ins block an account (3 to 20) and for how many minutes
  (1 to 60); a change is applied at once. It is on by default and an administrator can switch it off (this asks
  for a confirmation and is audited); the two numbers are kept while it is off. While it is off a password can be
  guessed without limit (only the Argon2 time per attempt slows it), and it never switches itself back on.
  See "If you are blocked from signing in".
- **Storage** (admin): see [Storage](storage.md).
- **Password** (everyone): change your own password; your other sessions are signed out.
- **Scans** and **Discovery** (operators and admins; only admins can change anything): see "Discovery".
- **Audit** (admin): the read-only audit log, newest first, 50 entries per page. Changes to configuration
  and access are recorded with who did it (the name stays even after the account is deleted), when, and for
  updates the values before and after; sign-in successes, failures and lockouts are recorded too. A row, its
  chevron or its time opens the entry in a drawer on the right (the address becomes `/audit/ID` and keeps the
  log's filters and page), with **Previous** and **Next** to step through the log and a **Copy** button for the
  entry's number; Esc, Close or the browser's Back brings the log back exactly as it was. The friendly sentences
  name things instead of numbering them ("for asset MV2-R1-LV-Panel-02", or "a deleted asset" once it is gone);
  the Raw view, the drawer's JSON and the CSV keep every id.
- **Dashboards** (everyone can read; operators and admins build): shared dashboards of widgets; an
  admin can mark one as the default, and the sidebar entry and the first page after signing in then open
  it; see "Dashboards and billing".
- **Billing** (everyone): cost per asset per day and per month, with a CSV export.
- **Tariffs** (admin sets, the Operator reads): the site currency and the rates that cost is calculated with.
