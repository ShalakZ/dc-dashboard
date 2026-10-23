# End-to-end tests

This page is for developers: how to run the Playwright end-to-end suite against a fresh stack without touching your data, what each
spec guards, and the two scratch-stack self-tests. The unit tests are on [Developing](developing.md).

> **Data safety.** `docker compose down -v` on the normal project deletes the `dcdash_dbdata` volume:
> every reading, user, source, tariff and dashboard you have. Never run it where that data matters. Run
> the end-to-end tests only in the isolated Compose project described below, which has its own volume;
> `scripts/e2e.sh` does exactly that (it always names the project `dcdash_e2e`, refuses any other name
> and cannot reach `dcdash_dbdata`).

Fifty-one specs (`frontend/e2e/*.spec.ts`) run in one `playwright test` run against the dev-profile stack on `http://localhost/`
(`E2E_BASE_URL` changes it). `frontend/e2e/playwright.config.ts` makes each spec its own project and runs them one at a time in the
order below, each depending on the one before; all but `journey` use a 1600×1000 window unless a spec sets its own sizes. Its
`global-setup.ts` waits up to 120 s for the stack and refuses a database that already has users.

- `journey.spec.ts` drives a real browser through first-run setup, adding the simulator, mapping two
  points and watching live values.
- `discovery.spec.ts` (after it, at 1600×1000) scans the simulator's network, expands the OPC UA
  source into its ten panel clusters, maps `LVP01` onto an existing asset and `LVP02` onto a new one
  by real mouse drags, creates `LVP03`...`LVP10` through the buttons, then checks through the API that
  all 60 points are mapped (six distinct metrics per asset), that a live value arrives, and that the
  audit log holds the scope, the scan and ten accepted mappings (counted through the API, because the
  Audit page shows only the newest 50 rows and every sign-in adds one).
- `phase3.spec.ts` (after it, at 1600×1000) reuses that state. An admin sets the currency, sees a dash
  (not zero) on Billing while no rate exists, adds a site default rate, and checks the current month on
  Billing (a priced panel row, its month total and today's cell, the month CSV with its header and
  byte-order mark) and the cost tile on an asset page. The admin creates an operator and a viewer; the
  operator builds a dashboard with a stat and a bar widget, saves it, reloads and finds both widgets and
  their layout, changes the dashboard range and downloads a widget's CSV; the viewer sees the dashboard
  with no edit controls, no Tariffs link and `403` from the write API; the admin finds the tariff,
  currency and dashboard entries in the audit log (counted through the API as well).
- `headers.spec.ts` (after it) checks the security headers on the page and the API and walks every page an admin can open,
  failing on a Content-Security-Policy violation.
- `w3a.spec.ts` (after it, at 1600×1000) adds a child asset from a `+` and picks the Kind from the list, sorts, filters and searches the
  source's points, checks the unit warning in the mapping dialog, and adds and edits a source that has no mapped points.
- `w3b.spec.ts` (after it, at 1600×1000) checks that a dashboard saved with a gap closes up the same in the view and in the editor (and
  that Save stays disabled until something changes), that a parent asset shows the sum of its sub-assets' live power, that the asset
  page's Trend says when it was updated, and that a dashboard with a 45-character asset name draws its bar and time series widgets.
- `w3c.spec.ts` and `w3d.spec.ts` (after it, at 1600×1000) cover the Audit screen (filters, search, a link per entry, CSV export, paging,
  administrators only) and sign-in protection with the Users & Roles page (a blocked account, Unblock, Delete, and no screen or API answer showing
  the password stored inside a source's URL).
- `w7a.spec.ts` (after `w3d`, at 1600×1000) checks the Assets workspace and the shell: a tree node opens its asset with one click and the tree
  stays, the "Assets Tree" crumb returns to the summary, the tree column resizes by keyboard and keeps its width and its folds across a reload,
  quick find (Ctrl+K) and its Esc keys, the "Live" status chip, Billing and Users & Roles at the full width of a 1920 px window, the summary's four
  tiles and "Needs attention", and the profile panel's Sign out with its Cancel.
- `w8.spec.ts` (after `w7a`, at 1600×1000) checks field diagnostics: an administrator's Diagnostics page builds a summary report (a header,
  a size and a checksum line per part, the build id) and leaves an audit row without the content; a masked report names no source
  address in its text, and its address key lists what each alias stands for; Copy puts the exact text of a part on the clipboard and
  Download saves the same text; the connection check runs on a chosen source and shows its steps; an operator has no Diagnostics page
  (turned away from it and from the report) but checks a source from its row. It makes one operator and deletes it again.
- `w7b.spec.ts` (after `w8`, at 1600×1000) checks the shared controls: the Sources row menu from the keyboard, opened by hover and kept open
  by a click, not clipped or covered at 1600 and 1024 px wide, and the last row of a source's points staying inside the window; the trash
  button asking first, with Cancel keeping the source; the Storage tips and the rows per day following the chosen days; the sign-in
  protection switch (switching off asks first, off blocks nobody, on blocks again); and the Tariffs sections with their tip. The only
  thing it writes is the sign-in policy, which it puts back.
- `w7c.spec.ts` (after `w7b`, at 1600×1000) checks the default dashboard and the Billing picker: an administrator marks a dashboard as the
  default from its row menu and the sidebar, `/` and sign-in follow it; an operator and a viewer see the badge and the sidebar link but
  cannot change it (`403` from the API); and the Year and Month selects beside Previous and Next start at the current month and jump to a
  month far back. It makes two dashboards, an operator and a viewer, removes them again, and puts the default back to none.
- `w7d.spec.ts` (after `w7c`, at 1600×1000) checks the Appearance choice: Mode and Theme colour in the profile panel, a choice applying at
  once, saved on the account and surviving a cleared browser; sign-out keeping the look on the sign-in page while another account on the
  same browser gets its own; Match my device following the device only while it is chosen; the keyboard walk of the two selects; dark mode
  (a widget frame follows the theme, no sideways scroll at 1440 and 1024 px); and `theme-init.js` served as JavaScript and loaded without a
  Content-Security-Policy violation. It puts the admin's choice back to Light and Navy and gold.
- `w7e.spec.ts` (after `w7d`, at 1600×1000) checks the theme polish: buttons, links, hover and the open row taking the theme's colour
  for its bar and its name, with no tint, in all four presets, light and dark; the dropdowns from the keyboard (Esc, arrows then Esc, Enter, the choice kept across a reload); a
  refused save putting the dropdown and the page back and saying so; the loading bar along the top edge in the theme's marker colour
  (all four presets, a full line under reduced motion, never on a poll, never blocking a click); a kind icon on every tree row and in
  the asset header; the dashboard widgets taking the look's own accent in all eight looks; and no sideways scroll at 1024 px in any
  look. It makes two assets and a dashboard and removes them again.
- `w7f.spec.ts` (its own project, after `w7e`, at 1600×1000) holds a page's first data request and checks the loading skeletons: one status
  region per area and none of the content, and the content back with the region gone once the data arrives (an asset page, the summary,
  the Dashboards list, Users & Roles); the skeleton against the loaded page to 2 px (the asset page, the Trend frame's height, the summary at 1440
  and 1024 px); the stored tree width while the asset list loads; no flash for an answer within 40 ms and a fade-in from nothing for a
  slow one; no skeleton on a poll, and none after a failed poll; the error alert replacing the skeleton; no sweep under reduced motion;
  the dark token in dark mode.
- `w7g.spec.ts` (its own project, after `w7f`, at 1600×1000) checks the asset icons and the new page name: the sidebar entry, the first
  crumb and the tree heading read "Assets Tree"; the Add asset dialog's Icon field (a collapsed grid, the caption "Automatic (Generic)"
  that follows the Kind, the arrow keys changing the choice and the caption, Server chosen and saved) and the same icon in the tree row,
  the asset page's title and quick find; Edit back to Automatic (the icon follows the kind again); the choice kept across a reload;
  Esc inside the open grid closing only the grid (a second Esc closes the dialog) with nothing saved; Enter on a cell not saving; no horizontal scroll at 1440 and 1024 px
  with the dialog open. It creates one asset of its own and deletes it afterwards.
- `w7h.spec.ts` (its own project, after `w7g`, at 1440 and 1024 px in fresh browser contexts) checks the first-load screen: the HTML the server
  sends already holds the shell and carries the security headers; with `/api/me` held, the navy bar, the sidebar and one "Loading" status
  are there (no bare "loading..." line) and the real shell replaces them with the same bar height, sidebar width and content corner (to 0.5 px)
  and the same single loading bar that never restarts; with the app's script held, the static copy alone has the same navy and widths in four
  looks, with the sidebar minimized and at 1024 px; the sign-in and setup pages (any case) show no shell; a signed-out deep link lands on the
  sign-in page without the real shell appearing and returns to the page asked for; a slow start never shows an empty page; reduced motion;
  no Content-Security-Policy violation on any of it.
- `w7i.spec.ts` (its own project, after `w7h`) checks the offline and recovery paths: with the API unreachable (the `/api/me` request answered 502 by the
  test) a deep link shows "Can't reach the server" at the same address instead of the sign-in page and the page loads once the answer
  is back; the banner inside the app appears after two failed requests and goes with the first answer; an expired session still goes to
  the sign-in page; a 200-character asset kind wraps instead of widening the page; and the "Skip the tree" link moves focus to the asset
  details. `headers.spec.ts` also checks the cache and compression headers of the built site.
- `w7j.spec.ts` (its own project, after `w7i`) checks the page layouts at 1920, 1440 and 1024 px: no sideways scroll on the Audit log,
  Storage, Tariffs, Settings and Diagnostics; Settings' two cards the same height with their Save buttons level; Tariffs' and Storage's two cards
  side by side at 1440 and stacked at 1024; Tariffs' description wider than 800 px; the Audit toolbar in at most two rows with every accessible
  name still found, the table still a table with a header row and a Details button that opens a detail row; the version line never saying
  "built unknown"; and the loading skeleton of each page landing within 2 px of the loaded page at 1024 (Settings at 1440 too).
- `w9a.spec.ts` (its own project, after `w7j`, at 1600×1000) checks roles and permissions: a viewer, an operator and an administrator each see
  exactly their sidebar and get `No access` on a page they lack (and `/api/me` lists their permissions); the API, with each role's own session,
  refuses every route above the role (a Viewer, an Operator, an account whose role holds nothing, a role with only `assets.view` and
  `dashboards.view`) with the one 403 text, refuses the live stream to a role with no permission (403) and to nobody signed in (401), and
  keeps setup closed (409); a role made through the API with only `assets.view` sees only the Assets Tree and lands on it, a role with no permission lands on "Your role has no pages yet.", and a
  permission taken from a role is refused at once while the open page of that account says "Your access changed" on its next focus check and
  the Audit log words the change; a role that may change users (every permission but `roles.manage`) cannot make an Admin, give itself Admin
  or reset, deactivate, demote, unblock or delete one; an Admin cannot demote, deactivate or delete itself (409), the built-in roles
  cannot be changed or deleted, `roles.manage` cannot be put in a custom role, and a role an account holds cannot be deleted (409). It
  makes its accounts and roles (every name starts with `w9a-`) and removes them again, users first.
- `w9b.spec.ts` (its own project, after `w9a`, at 1600×1000) checks Users & Roles: the tabs follow the arrow keys, the address, a reload and
  Back; an administrator makes the Executive role with four ticks, gives it to a new account, whose sidebar is exactly Assets Tree,
  Dashboards and Billing (other pages say "No access", the API answers 403 except the billing export), and a tick added later reaches
  that account's open page (the Reload notice) and opens Tariffs read-only; a role in use has a disabled bin (a direct delete is 409), the
  admin cannot change their own role, a taken name keeps the dialog open; Duplicate of the Operator opens `Copy of operator` with its
  ticks; the Operator's Tariffs has no form; `settings.edit` and `settings.security` each open one card of Settings (the spec puts the
  time zone back); and the editor works from the keyboard. Every name starts with `w9b-`; they are removed again, users first.
- `w7k.spec.ts` (its own project, after `w9b`, at 1600×1000) checks the save and delete feedback. The three Save buttons that save in place (Settings'
  General and Sign-in protection, Tariffs' Site currency, saved unchanged) go from "Save" to "Saving…" (the request is held) to a green
  "Saved" on the theme's `--ok` colour and back in about 3 s, with one width in all four phases, light and dark at 1440 px, no toast and no
  loose "saved" word. A leaf asset's trash opens ONE styled dialog (the browser's own box never opens) that says "Checking what this
  deletes…" while the preview is held, then `Delete "NAME"?`; Cancel keeps the asset and the focus goes back to the trash button; Delete
  sends the counts the dialog showed and raises the toast `Asset "NAME" deleted` in the lower right corner, gone within 6 s. A branch asset
  (a child and a rate) shows the impact sentence with "Delete anyway"; a child added while the dialog is open makes the first confirm
  answer 409 with the new numbers, and only the second deletes. A source with mapped points shows the sources wording (cancelled, never
  deleted); a source with no points is deleted with its toast. "Asset created" does not cover the profile menu and can be dismissed, Esc
  still closes a dialog under a toast, a toast appears and leaves under reduced motion, the menu of the last Sources row is reachable under
  "Source added" at 1440×900 and 1024×768, the toast keeps its 16 px margins below 720 px, and the dialog works from the keyboard. Every name
  it makes contains `W7k` and the run suffix; it removes them again.
- `w9c.spec.ts` (its own project, after `w7k`, at 1600×1000) checks the Roles editor's dependency card: ticking Change users offers to
  tick See users too (the card sits whole inside the window, "Also tick" ticks both, Save posts exactly the two ids), "Not now" ticks
  nothing more and leaves the hint line, unticking a permission another ticked one needs offers to untick that one too, the whole flow
  works from the keyboard (Escape closes only the card), every `?` bubble of the Change column opens whole without sideways scroll, a
  quick click on a box the card covers reaches that box, and at 1024, 1440 and 800×600 the card never covers its own box, Cancel or
  Save. Every role it makes starts with `w9c-` and is removed again; it makes no account.
- `w7l.spec.ts` (its own project, after `w9c`, at 1600×1000) checks the audit log's names and drawer. A rate's entry reads `Created tariff 0.37
  per kWh from 2019-03-14 for asset NAME` with no `#`, in the row and in the drawer, and `for a deleted asset` once the asset is gone, while
  Raw and the drawer's JSON keep `asset_id`. An entry opens in a drawer 480-520 px wide at the right edge (a click on the sentence, the chevron
  or the time), focus inside, the page behind inert and not scrollable; Previous and Next replace the address (one Back closes the drawer),
  cross the end of a page, and stop at the newest and oldest entries with the reason in the button's name; Esc, Close and a click beside the
  drawer put the focus back on the chevron of the entry that was open; a deep link opens the drawer over its own page, and an entry that is
  not on that page opens but cannot be stepped from. Closing keeps the page number and the scroll position. Copy shows its toast above the
  drawer without covering Previous or Next, at 1600 and 600 px. The Create user card has one height for Viewer, Operator and a role with no
  description, and the Tariffs cards and left date picker do not move when Add rate is pressed with nothing chosen, before and after a valid
  add, both at 1440 and 1024 px. The bin's lid lifts on hover (a screenshot goes into the report). The asset, rates and role it makes contain
  `W7l` and the run suffix; it removes them again.
- `w7m.spec.ts` (its own project, after `w7l`, at 1600×1000) checks the Asset kinds page and the default icon of a kind. A viewer opens
  `/assets/kinds`, reads the list, has no New kind and no row menu, and the API refuses its POST, PATCH and DELETE with 403. The tree
  header's link opens the page (heading, crumb, the tree beside it). New kind "W7m Pump N" guesses the Pump icon from its name until an
  icon is picked, and its row reads "No assets". An asset added with that kind and Automatic draws the kind's icon in the tree row, the
  asset page's header and quick find; editing the kind to Server changes all three without a reload, and renaming it to "W7m Pumps N"
  rewrites the asset's kind text ("1 asset follows"), keeps the icon, and shows the new text on the asset page. An icon of the asset's own
  (Rack) wins over the kind's. The kind's Delete asks where to move the asset (Delete stays off until a kind is chosen, and
  Cancel leaves everything as it was) and the API refuses a plain delete of a kind in use (409), and the page survives a reload; once the
  asset is gone the kind deletes and leaves the list. Adding an asset with a new typed kind registers that kind
  with the suggested icon, and the next asset of it needs no choice. No horizontal scroll at 1440 and 1024 px on the page and with the New
  kind dialog and its grid open. Every kind and asset it makes starts with `W7m` and carries the run suffix, and it makes a viewer account;
  it removes them all again.
- `w7n.spec.ts` (its own project, after `w7m`, at 1600×1000) checks the gold M logo and the icons. The served HTML links the ICO, then the SVG,
  then the touch icon, and each of them and `/logo-mark.svg` answers 200 as an image (never the app's HTML) with no `immutable` cache header.
  In all eight looks (light and dark, the four theme colours) the pixel the browser paints in the top bar's mark is the owner's gold (read from
  a screenshot of the image, so a filter, an opacity or a blend would show), and desert gold shows a dark keyline round it. The minimized rail
  keeps the mark and the name, the sign-in page shows the mark at 58 by 56, and the static copy of the shell in `index.html` (only the app's
  script is held) puts the mark where the real bar does. No request for an icon fails and no console message names one; with the logo blocked
  the bar keeps the mark's 29 by 28 box and the name does not move. It creates and changes nothing.
- `w7o.spec.ts` (its own project, after `w7n`, at 1600×1000) checks the kinds pack. On an asset's page Add asset, Edit and Delete are one
  height at 1440 and 1024 px, light and dark, and Delete is an outlined button that reads "Delete" and keeps the name "Delete NAME". The icon
  picker has 48 icons (49 choices with Automatic) in six labelled groups; typing "transfer" leaves the Automatic transfer switch and the
  Static transfer switch (Rack is gone), and choosing the transfer switch saves it and draws it in the tree row and the page header. Typing
  "security" leaves Firewall and Camera, which sit in two groups: Tab from the search lands on Automatic, the arrow keys walk across the
  boundary and back, a cell that was picked is not hidden by a later search, and Escape clears the text, then closes the grid, then the
  dialog. With the grid open the page does not scroll sideways at 1440 and 1024 px, the dialog does not at 1440, 1024 and 800 px, Save stays
  inside the window at 1440×900, 1024×640 and 800×600, and typing in the search moves nothing. A kind that three assets use opens the move dialog (the count, a
  "Move the assets to" choice of the other kinds, Delete off until one is chosen); an asset that joins while it is open turns the answer into
  the new count and keeps the choice; the assets follow (an icon of the asset's own stays), the kind is gone, and the toast and the audit
  entry name the kind they moved to. The header's Add common data-centre kinds adds only the missing ones of the 16 common kinds,
  and Add all 39 data-centre kinds (beside the filter) adds the rest; a second press of either says they are all there and writes no audit
  entry, and a starter kind that is already there under another spelling or icon is left alone. A custom role with Change assets but
  not Manage asset kinds sees the list and one line saying what is missing (no New kind, no pack button, no row menu), the API answers 403
  to every write and changes nothing, and a new kind typed in Add asset keeps its text and registers nothing, with the note saying so (an
  administrator's typed kind is registered); the Roles editor offers to tick Change assets and See the Assets Tree with Manage asset kinds.
  At 1024 px with the sidebar open, an asset page whose name is only 11 characters long keeps its title and its sub line on one line each
  (the buttons drop under the title when the pane is narrow). Every name it makes starts with `W7o` or `w7o-`; the kinds the pack added are
  removed again by name and the admin's look is put back.
- `w7p.spec.ts` (its own project, after `w7o`, at 1600×1000) checks moving assets in the Assets Tree. Each case builds a small tree of its own
  through the API (halls, racks, pumps, rates) and removes it again. Ctrl-click picks two racks of different halls and opens nothing, and
  dragging one with the mouse, Ctrl still held at the drop, moves both under a third place with their pumps; Shift-click picks the visible rows
  between the anchor and the click (a folded branch is skipped, a second Shift-click replaces the range, one above the anchor picks upwards),
  and a plain click opens an asset and clears the picks; a parent picked with its child moves alone and the audit log has one row; a drop onto
  an own descendant shows the red mark, the reason in the row's title and in the live line, and changes nothing; Move to... from the keyboard
  (M, type in "Search places", Tab, the arrow key, Tab to Move, Enter) moves the asset and puts the focus on its link. The rate warning
  appears only when the effective rate changes: a drag that changes it opens "This changes the rate" with both rates (Cancel moves nothing,
  Move anyway moves), the Move to... dialog warns inside itself, and a reorder, a move between two places without a rate and a pump with a rate
  of its own never ask. Undo of a move of two racks that are not neighbours puts both back between the racks that stayed, and Undo of a reorder
  restores the order. The audit log reads "Moved ... from ... to ... together with 1 other", "Moved ... to the top level" and "Reordered ...
  within ..." in names and the drawer says the same and keeps the shared `request_id`. A custom viewer sees no pick handle, no draggable row
  and no Selection line, M and Space do nothing, and both routes answer 403. At 1440 px and at 1024 px with the sidebar minimised and expanded
  the tree's title is there, the first pick moves no row, and the tree does not scroll sideways. Every name it makes starts with `W7p` or
  `w7p-` and is removed again.
- `w7q.spec.ts` (its own project, after `w7p`, at 1600×1000) checks telling kinds apart and tidying them on the Asset kinds page. The stack is shared, so
  every kind it makes is named `W7q <run> ...`, an account and a role start `w7q-`, and it removes only those (and the starter kinds its pack
  cases added that were not there before). In a 1024×640 window with a list at least 600 px longer than the window, deleting one kind through
  the row menu leaves `scrollY` where it was (1 px, or the new end of the page when it got shorter), with the focus on the next row's menu
  button, and so does deleting three through the bar, with the focus on the filter in use. `Rack` and a pack kind carry a Starter tag beside
  their label, a W7q kind does not; the four filters carry the counts of the API and show that many rows, choosing another filter clears
  the ticks and pressing the same one does not. Shift+click and Shift+Space add a range to what is ticked (a second range does not replace the
  first), Space toggles, the header box is empty, indeterminate or ticked, Select all unused ticks as many kinds as the Unused filter says
  (Delete is never pressed on it), Clear and Escape leave the focus on a named element. Three unused kinds go and no others, with the toast
  `Deleted 3 kinds`; one kind in use plus two unused makes the dialog ask for a kind to move to (the selection is not offered, Delete is off
  until one is chosen), the asset follows, and the audit log has a `kind.deleted` row per kind. The table's top does not move on the first
  tick at 1440, 1024 and 800 px with the sidebar expanded and minimised, and at 1024 px with it expanded the title stays on one line. The
  header's button adds exactly the common kinds that are missing and sends no query, Add all 39 adds the rest with `?set=all`, a second press
  of either says they are all there and writes no audit entry, and `?set=bogus` is a 422. A custom role without Manage asset kinds sees
  the tag and the filters and no checkbox, pack button or bar, and the API answers 403 for both packs and for a delete.
- `w7r.spec.ts` (its own project, after `w7q`, at 1600×1000) checks the Scan details drawer and the Discovery clean-up. It runs
  about fourteen scans of the simulator on the shared stack and removes what it made (assets, hand-added sources and scopes named `W7r <run> ...`,
  accounts and roles `w7r-`); it runs near the end because Clear unmapped removes every unmapped discovered source of the stack (`w7s`, which follows,
  uses no source). Details opens a dialog
  named `Scan #N — done` with the scope line (`<scope>: simulator, ports 9000, 5020`) and a stats line that says `checks`, never `ports checked`;
  Escape, the x and a click outside close it and the focus goes back to that row's Details button; Recent scans reads `N source(s), M points` with the
  targets and ports under the scope name (a scan started from a scope with the mistyped port 4080 shows 4080). Every discovered node says
  `Seen in scan #N`, a hand-added one `Added by hand`. Remove from Discovery… (in a source's menu) and Clear unmapped (in the `More Discovery actions` menu; the count and first names in the dialog) take away only
  discovered sources with nothing mapped, each with an audit row `Deleted source <name>`, a rescan brings them back, a source with a mapped point
  has no Remove and the API answers `skipped: mapped`, and the route answers 409 while a scan is running. A hand-added Modbus source added after
  a scan wins over the discovered one at the same address (`existing source`, the duplicate is not browsed). A role with only `discovery.view`
  sees no Remove, Clear unmapped or Create assets and gets 403; a role with `discovery.edit` but not `discovery.accept` can remove but not
  create. Create assets for N groups… in the menu of the collapsed source opens one dialog with a row per group and creates one asset each under the chosen parent.
  At 1440 and 1024 px neither Scans nor Discovery scrolls sideways and the drawer fits, and a fresh load of Discovery at 1024×640 opens on the first
  sources (the buttons of the first source are inside the canvas and the node text is at least 9 px at the opening zoom).
- `w7s.spec.ts` (its own project, after `w7r`, at 1440×900 unless a case sets its own size) checks deleting several assets
  from the Assets Tree and telling the open asset from the picked ones. Each case builds its own small tree through the API, named `W7s <run> ...`
  (accounts and roles `w7s-`), and removes what it made. With two leaves picked and a third open, the open row is not on the tint and the picked
  rows are, the bar says `2 picked` and its count carries the "open asset is not counted" tooltip; Delete opens a dialog that lists both names,
  says "This can't be undone" and has a plain `Delete` button; confirming removes both, shows the toast `Deleted 2 assets`, clears the picks,
  leaves the focus on a named element and does not move `scrollY`. A picked parent with a picked child shows the "is inside ... so it goes with
  it" note, the totals count the whole branch, and the audit log has one `asset.deleted` row for the parent. A child added to a picked leaf
  after the dialog loaded makes the confirm show the new numbers and the "delete again to confirm" sentence with nothing deleted, and the
  second confirm deletes the leaf with its child; a pick that someone else deleted before the dialog opened blocks it (only Close) and the
  tree refreshes, dropping the vanished pick from the bar. With two picks and a child added to the second, the first is deleted and the
  second refused: an error toast `Deleted 1 asset. "<name>" could not be deleted: ...`, `1 picked` remains and Delete is still in the bar.
  Deleting the open asset moves the page to its parent's. A custom role with only `assets.view` and `assets.edit` can pick and Move to... but
  has no Delete, and the API answers 403 to a delete from it. From the keyboard, Tab reaches Delete, Enter opens the dialog with the focus on
  Cancel, Escape closes it and the focus is back on Delete. At 1440, 1024 and 800 px the bar is whole and does not change height on the first
  pick; with the stored tree width 220 its buttons lie inside the bar, and the bar is 32 px high in a column of 277 px and 64 px in one of 276 px
  or less for the admin, but 32 px at every width for the role without Delete. The browser prints its own console lines for the refusals the app
  handles on purpose (the 404s of a vanished pick, the 409s of a grown branch, the 403 of a role that lost the permission); they are not app errors.
- `w12a.spec.ts` (its own project, after `w11`, the tail of the chain until `w12b`; at 1440 and 1024 px) checks the mapping actions.
  It works on one group of the simulator's OPC UA source: it records that group's mappings through the API first and puts every one back
  at the end, even when a case fails, comparing scale, interval and custom unit, so the stack ends as it began. Every asset it makes is
  named `W12a <run> ...` and is deleted again, and its accounts and roles start `w12a-`. Mapping the whole group (six points) to a room by
  mistake shows the note `... is a room; meters usually belong to a Panel or Rack. Map here anyway?` in **Review mappings** without
  blocking it, then the toast `Mapped 6 points to <room>.` with **Undo**; Undo takes the six mappings off and leaves the room in the
  tree. From the group's `Mapping actions for ...` button, **Move this group's mappings…** asks first and moves all six to a panel on the
  Discovery canvas. On the asset page, `Actions for <metric>` then **Unmap…** takes one metric off, and Undo makes the mapping again with
  exactly the metric, scale, interval and custom unit it had (compared through the API, before and after). A viewer sees no `Actions for`
  menu and no +, and a role with `discovery.accept` but not `assets.edit` maps and gets the toast with no Undo. The + on an asset node
  opens **New asset** with that asset as parent and the real form: the kind and the icon chosen are saved (read back from `GET
  /api/assets` and from the icon in the Assets Tree row, not from the Discovery node). The + and the dialogs also work from the keyboard,
  and several unmapped points of one source selected and dragged onto an asset open one review for all of them.
- `w12b.spec.ts` (its own project, last in the list, after `w12a`, the tail of the chain; at 1440 and 1024 px) checks the faster, paged,
  filtered Discovery canvas. Every graph is mocked in the page (`page.route`, like `w7u.spec.ts`), so nothing is written to the stack and
  it needs no clean-up. **Expand all** on a 500-point graph draws its first point within 900 ms (three times the target; a miss is
  measured once more alone before it counts). A group of 200 points draws its lines to the points solid and a group of 60 dashed, and
  the lines from a source to its groups stay dashed. A group of 120 opens with 50 points and **Show 50 more** (`70 left`); pressing it
  with the mouse or the Enter key draws 100, then 120 and then the button is gone, the focus is on a point and never on the page; a
  mapped point past the first page keeps its line to its asset (one line labelled `N mapped`), and closing and opening the group
  starts again at 50. **Unmapped only** puts `Showing U of N points` at the start of the summary (whole at 1024 px with the sidebar
  open), takes away mapped points, fully mapped groups and sources and every mapped line, is still on after a reload, is turned off
  by Find on a mapped point with the message `Unmapped only is off so <name> can be shown.`, and mapping a point while it is on leaves
  the focus on a named element. An asset with sub-assets folds (`Hide sub-assets of <name>`): its `N mapped` badge appears, its
  sub-assets and their lines go, the mapped lines end on the folded asset as one summed line, **Show** brings them back, the fold is
  still there after a reload, and a role that can only view still has the toggle. With nothing selected the arrow beside **Expand
  all** and **Collapse all** is greyed out and says why; a box of two groups and **Expand selection** open both and the message says
  `Opened 2 groups.`; **Expand this branch** on a closed source opens it and its groups, **Collapse this branch** closes them, from the
  bar and from the right-click menu. With the keyboard, Tab onto a node, then Down and Up walk between sibling groups, Right goes to
  the first child and Left back to the parent, Enter opens and closes a group and never opens or closes a point (it selects it), the Menu key opens the
  node's actions, a node's name reads like `LVP01, group of 6 points, 6 mapped, open`, the view pans to a node that was off screen
  without changing the zoom, and the focus is never on the page itself. In a graph of about 2,000 nodes (ten sources of four groups of
  49 points) closing and opening one group, and resting the pointer on a node, stay within three times the measured times (rerun once
  alone on a miss), and none of it prints a console error.
- `w12c.spec.ts` (its own project, after `w12b`, the tail of the chain until `w13`; at 1440, 1024 and 800 px, with the sidebar
  minimised and expanded) checks the Discovery visual polish. The bar above the canvas has its three groups (`View controls`,
  `Canvas controls`, `Page controls`) and does not overflow at any of those sizes. On a narrower window it shows icons only, and at 800 px
  every button of the bar, and the `Unmapped only` switch, still has its name, either in the bar or as an item of the `More Discovery
  actions` menu, with each narrow item (Unmapped only, Tidy layout, Snap to grid) in exactly one of the two places. A role that holds
  only `discovery.view` has no `More Discovery actions` button at 1440, and at 800 px its menu holds those narrow items. The Find card, which still opens
  at the top right of the canvas, does not cover the Close button of the Source details panel at 1024×640 and 800×600. The keyboard
  button opens the shortcuts list, and so does the `?` key on the canvas; Escape closes it and returns the focus to where it was, and
  Tab from the open list never lands on the page itself. A source is a card with a one-line short name, its protocol and address, the
  status in words, `N of N mapped`, **Details** and a `Source actions for <name>` menu that holds **Create assets for N groups…** and
  **Remove from Discovery…**. Every kind of node carries its icon, and an asset the generated model gives a chosen icon (`icon: "rack"`)
  shows that icon instead of its kind's; nothing is set through the API for this. Everything is also looked at in light and dark. The
  last-value card is checked with answers made up in the page (`page.route`, a fresh reading, a stale one, a bad one and none): the
  text it shows, the word `stale`, no card on an unmapped point, and the node's description (`aria-describedby`) back to what it was
  once the card has gone. Two cases cover the failed read and the menu. A failed read (a row with a time and no value, quality 1)
  says `No value, N s ago, bad reading` in the bad tone, never `No reading yet`, which is for a point with no row at all. A right-click
  on a mapped point with its card showing takes the card away (it would cover the menu), and one Escape then closes the menu only and
  puts the focus back on the node. A separate case, also with made-up answers, checks that a role without `assets.view` makes no value
  request at all and shows no card. One case asks the real stack for `GET /api/mappings/{id}/latest` on a real mapping (200 for the
  administrator, 404 for an unknown one, 401 signed out and 403 for a role that holds only `discovery.view`).
- `w13.spec.ts` (its own project, after `w12c`; at 1440, 1024 and 1920 px) checks the dashboard
  widgets. It writes next to nothing: one dashboard (`w13 <run>`, 15 widgets of `e2e/w13Showcase.ts`) is saved through the API and every
  `POST /api/widget-data` is answered in the page from that showcase (the same config gets the same answer), so estimated, partial, no-rate,
  stale, no-data and removed-asset states are always there; the dashboard is removed afterwards and the admin goes back to Light and Navy and
  gold. In light navy-gold and dark desert-gold (the unit tests read all eight looks) every card is a `region` named by its title with an `h2`
  title, sits on the `--widget-bg` token (not white in dark), shows its markers, and reads at 4.5:1. At 1024, 1440 and 1920 px the page does
  not scroll sideways and no two cards meet. The 2 x 2 gauge is 170 px high with its figure and name apart and nothing clipped, and below
  200 px of card width the CSV button leaves the header. A time series repaints in the other mode's axis colour after a Mode switch with no
  navigation. The **Details** button opens from the keyboard and from a click, Escape returns the focus to it, and what the panel says is
  what the answer proves (freshness, window with the zone, marker meanings, lowest and highest from the data, a total only when it is exact,
  never an average over buckets). The editor's preview is the dashboard card, edit mode has no Details or CSV button, and in dark the drop
  placeholder and the resize handles show against the card.
- `w14.spec.ts` (its own project, after `w13`, the tail of the chain until `w17`) checks the six small fixes of the polish wave. It
  writes next to nothing: the dashboard showcase of `e2e/w13Showcase.ts` is saved once and answered in the page, Discovery is answered from a
  generated graph (`e2e/graphModel.ts`, with source names of 12, 30 and 70 characters), and the one case that writes makes a role and an
  account (names start `w14-`) and removes both. The bar chart "Energy per asset" renders at 1024, 1440 and 1920 px in light and dark with
  no sideways scroll (the label geometry is proven by `barAxis.ssr.test.ts`, which draws the real chart). On Discovery no source card is
  taller than 136 px or meets another, the 70-character name is cut on the card to two lines and the source panel opened with Tab and Enter
  names it whole; at a 1148 px bar the counts keep their words (and a set with a credentials chip keeps all four chips), and Snap to grid
  switched on differs from a control that only has the keyboard focus. In Details the table has the headings `Asset`, `Lowest`, `Highest` and
  `Last bucket (average)`, `Highest` says `bucket from <time>`, the panel is 560 px wide with no sideways scroll, and a no-rate widget has
  the link `Set a rate in Tariffs` for the administrator (reachable by keyboard) and none for a role without `tariffs.view`. At 800 and
  1024 px, with the sidebar open and minimised, four pages do not scroll sideways.
- `w17.spec.ts` (its own project, last in the list, after `w14`, the tail of the chain) checks Billing at scale. It writes nothing and needs
  nothing from the stack: `GET /api/billing/costs` (and the month list and the asset list) are answered in the page by `page.route` from a
  generated month of hundreds of assets (`e2e/billingModel.ts`), so the same rows come back on every run. It checks the fold (the arrow of
  a row, Collapse all, Expand all, Show levels, a month of more than 60 rows opening folded), the filter (matches with their parents,
  the "N of M rows match" line, Escape), the day-number header that stays while the rows scroll, the Assets Tree opening folded to its
  second level when it is big, and that the figures and the CSV do not change.
- `w18.spec.ts` (its own project, last in the list, after `w17`, the tail of the chain) is the guard for control heights. It measures the
  real pages: on every page of the app, two controls with a visible edge (a border, a fill or an inset ring) on one line must be the same
  height within 1 px (a short allow-list in the file says why table-cell controls, `?` tips, tree twisties and chips in running text are
  exempt), the top-bar Live chip equals the Find field and the asset header's "live" chip equals the Edit button at 1920, 1440, 1024 and
  800 px, light and dark, and a case that puts three old heights back checks that the checker reports them. It also checks the note box
  of the Close month and Reopen month dialogs (four to twelve lines, never above 40 percent of the window, scrolls inside, nothing moves
  while typing, both buttons reachable at 800 x 600) and that the removal confirmations show the new note paragraph only when the
  removal has mappings. It makes what it needs (an asset with a mapped point, a dashboard) and removes it again; Billing is answered by
  `page.route` from `e2e/billingModel.ts`, so it writes nothing else.
- `w20.spec.ts` (its own project, last in the list, after `w18`, the tail of the chain) checks the Billing toolbar. It writes nothing and
  needs nothing from the stack beyond the sign-in and the look preference: `GET /api/billing/costs` and the month list are answered in
  the page by `page.route` from the generated pilot-hall month (`e2e/billingModel.ts`: an open month, a closed month, one missing rate,
  the two empty answers), and any other write the page tries is refused and fails the case. It measures the real page. At 1920 px the
  month controls and the table controls share one row (one centre line, 34 px tall, the table controls on one line); at 1860, 1440,
  1280, 1024 and 800 px they stack with nothing overlapping or clipped; the switch is exactly at 99rem of the page's own width (1583 px
  stacks, 1585 px shares a row); nothing above the table moves when the costs land, when a fold, a filter or another month changes the
  rows; the Tab order runs from the month controls to the table controls; the "Showing N of M rows" line is a polite live region in
  the table's caption that stays at the right edge of the table box while it scrolls sideways; and a closed month, a missing-rate month
  and the two empty answers keep the toolbar first, the banner next and the table box inside the window. Light and dark.
- `w21.spec.ts` (its own project, last in the list, after `w20`, the tail of the chain) checks the Billing month check. Its cases write
  nothing and need nothing from the stack beyond the sign-in, the site's time zone and the look preference: `GET /api/billing/month-check`
  is answered in the page by `page.route` from the fixtures in `e2e/monthCheckModel.ts` (the pilot hall's September with ten things to
  check, a clear month, an empty one, one that has not begun, a long list, a closed month, a running month and a 500), the costs and the
  month list from `e2e/billingModel.ts`, and any other write the page tries is refused and fails the case. The header reads Close or
  Reopen month, Check month, Download CSV, in that order, with Check month named exactly that; its count reads 10, 0, 99+ or nothing (and
  says so to assistive technology), adds no live region, and Check month and Download CSV keep one box on the current month, on a
  finished month before and after its costs land, on a closed month and when the answer lands. The drawer is checked light and dark at
  1440 x 900, 1024 x 640 and 800 x 600: its title, the headline, the groups in order, the one-sentence estimate rule, the gap and the
  reset with their sizes, the assets nothing measures, inside the window with no sideways scroll, and no figure on the page changes
  when it opens and closes. By keyboard, Tab reaches Check month and Enter opens it with the focus on the panel, Tab and Shift+Tab wrap
  inside it, Escape closes it and gives the focus back, and a list of more than five lines shows five, expands with the focus kept and
  says how many more the server did not send. It also checks the skeleton while the answer is held, the error line of a 500, the empty,
  clear and not-begun wording, the closed and running notes, and the one line the Close month dialog shows about the check (with no
  link or button of its own, and fixed at the click). One more case, which needs the scratch stack (the same guard as `w11.spec.ts`:
  `COMPOSE_PROJECT_NAME` starts with `dcdash_e2e_`, skipped otherwise), seeds the three-panel history inside the stack, reads the real
  endpoint through the real drawer and checks that the headline, the count, the groups and the paths equal what the API answered, and
  that Panel B is listed as estimated; it removes the seed through the API afterwards.
- `w22.spec.ts` (its own project, last in the list, after `w21`, the tail of the chain) checks the Text widget. It creates its own
  dashboard `w22 <run>`, deletes it at the end and restores the look preference. It adds a heading, a paragraph and a divider through
  the dialog, saves and reloads, in light and dark, and checks that no `/api/widget-data` request is made for a text widget. In edit mode
  it checks the title bar, moving, resizing to one row and a 1-row heading at 1024 px wide. It drives the dialog by keyboard, checks the
  counter (an emoji counts once) and the API refusals: a NUL in a title or a text, a CRLF kept as a line feed, and `type: "text"` on
  `POST /api/widget-data` and `/api/widget-data/csv`.
- `w23.spec.ts` (its own project, last in the list, after `w22`) checks the asset picker of the widget editor. It creates its own
  assets through the API (`W23 Site` with two halls, three rows each and ten racks per row, 69 assets, so the picker opens folded) and
  its own dashboard `w23 <run>`, deletes both at the end and restores the look preference. It finds a rack by typing and picks it, filters
  by kind, uses Pick all under a row within and over the maximum of 20 (over it nothing is picked and the live line says so), clears the
  search with Escape without closing the dialog, and walks the chips by keyboard (the focus never falls to the page). It checks that a
  stat and a gauge pick one asset, that the list does not move at 1024 x 640 and 800 x 600, and the chips in the dark look.
- `w24.spec.ts` (its own project, after `w23`) checks the month-to-date comparison and the breakdown by kind. Its
  first cases never depend on today's date: they create their own assets (`W24 Site` with a hall and three racks) and two dashboards
  (`w24 <run>` with a comparing stat of energy, one of cost, a comparing daily chart and a breakdown by Rack, which they only open, and
  `w24 <run> edit`, which the editor cases save), answer every `POST /api/widget-data` and its CSV in the page from fixtures with a
  fixed window ("1 to 17 Oct" against "1 to 17 Sep"), and refuse any write they do not expect (the breakdown cases expect none). The
  stats are checked word for word: the figure for days 1 to 17, the two window labels, "Same days last month", the change in words and
  sign ("up 12.4 % (+124.00 kWh)", "down 10.0 %", "no change"), `~` on an estimated side, `*` and its missing percentage on a partial
  cost, the rate note, the closed-month note, four notes at once ("+3 more in Details", all four in the Details table), the texts for a
  month closed in another time zone, an asset missing from the closed figures, no readings last month and another currency, and
  "Nothing to compare yet" on the 1st; the note line keeps its place and the card its seven rows whatever it says. The daily chart is
  read through its text alternative (the legend is drawn on a canvas) and its hover tooltip, which names both dates of a day and leaves
  out a day with no readings. The breakdown cases check the line "and 107 more Racks: 1234.50 kWh in all", its marks, "Split by" (it
  keeps the focus, sends a request whose config has the chosen kind, the CSV follows it, nothing is saved, and a new visit starts from
  the stored kind), the sentences for a kind nobody meters and for no assets at all. The editor cases tick the comparison box (Widget
  range locks on This month and the picker turns from checkboxes to radios, unticking restores the range), choose One bar per asset of
  a kind (Look under, One bar for each, Bars to show, Whole site), read the saved configs back with `GET /api/dashboards/<id>` (the
  new keys are there only when they are not the default, and a comparing stat starts 3 x 3), and walk the box, the tip and Whole site by
  keyboard (Escape closes the tip before the dialog). Placement is measured at 1440 x 900, 1024 x 640 and 800 x 600, light and dark:
  the card's rows and the editor's new fields do not overlap or scroll, Save widget stays in the window, and a skeleton draws the rows
  of the loaded card. The last three cases (R1 to R3) need the scratch stack: they run only when `COMPOSE_PROJECT_NAME` starts with
  `dcdash_e2e_` (like `w11.spec.ts` and `w21.spec.ts`) and are skipped otherwise. They raise the raw retention to 90 days, seed the pilot
  hall inside the stack, make a site-wide rate when there is none, read D and N from the widget-data answer and the expected figures from
  Billing's day cells (`GET /api/billing/costs`, never fixed values), and check that the compare stats equal those sums in kWh and in
  cost to the digits shown (the 1st says "Nothing to compare yet" instead), that a breakdown by Rack under Hall 1 says "and 54 more
  Racks" and that the one under the whole pilot hall splits by Panel ("None of the 8 Panels under Seeded pilot hall has energy
  readings."). They then close last month through the API, change the rack's rate and check, after a reload, that the card's last side
  did not move and says "Last month is closed". Last month must be open when they start (the earlier projects leave it so); afterwards
  they reopen it, delete the rack's and the site rate, the dashboard, the seeded subtree and its source, and put the retention back.
- `w25.spec.ts` (its own project, after `w24`) checks the dashboard's focus asset, the drill-through and the Power
  starter. It creates its own assets through the API (`W25 Site` with `W25 Hall 1` > `W25 Row 1` > three racks, `W25 Hall 2` and a Panel
  beside them) and the dashboards it needs, sets the look through `PUT /api/me/preferences`, and removes the assets, the dashboards, the
  role and the user it made in `afterAll`, also after a failed case, and puts the look back. No case needs the scratch stack. The cases
  are serial. Opening `?asset=<hall id>` shows the trail and the link **Open W25 Hall 1 page**; a card that follows the focus sends the
  `focus` in its `POST /api/widget-data` and a fixed card does not (it makes no new request when the focus changes); choosing a focus in
  the dialog pushes a history entry, Back returns to the one before, and the range picked for the visit stays. From a rack the trail's
  parents move the focus up and the dashboard crumb clears it, and the page holds exactly one navigation named Breadcrumb. A value that
  is not a number, an id that never existed and an id deleted just before the load all show the whole site with the line "The asset in this link no longer
  exists, ..." and drop `?asset` from the address. A role made through the API with only `dashboards.view` has no Focus button and no
  Open page link, ignores `?asset` with the line "This link opens the dashboard on one asset. ...", never asks for the asset list, and
  gets a 403 from `POST /api/widget-data` only when the body carries a `focus`. With a second top-level asset (made in the case and
  removed in it; where the stack already holds one other root, the case first removes `W25 Site`) a card that follows the focus says "This site has N top-level assets: choose a focus to see this figure." (N read from the API) through the
  real server, a children card lists the two roots and a breakdown looks at the whole site; with one top-level asset the sole root is
  the focus without being chosen (that case runs only when the stack has at most one root besides `W25 Site` and is skipped on a stack with
  several leftover roots, as the suite's own stack has). **New dashboard** with the **Power** template card makes the five widgets and opens in view mode, an empty name
  becomes "Power", a second one shows the name-taken line in the dialog, and the compare stats and the breakdown carry the focus when it
  is opened with `?asset=`. The drill-through cases answer the breakdown's `POST /api/widget-data` from a fixture whose bars are real ids
  and click the chart's canvas (the bar is found by its pixels): a bar of an asset with children narrows the focus (the address and the
  trail change), a leaf's bar and an axis name open `/assets/<id>`, and by keyboard Details, Tab to **Narrow to <name>** and Enter
  narrows, closes the panel and leaves the focus on that card's Details button; a bar with no figure answers only its axis name and its
  tooltip says so; on a dashboard where no widget follows the focus a click opens the asset's page and Details has no Narrow buttons; edit
  mode has none of it. The Power case is skipped when a dashboard called "Power" already exists. The editor case checks the
  quiet line "Widgets that follow the focus show ...", saves a stat set to **The focus asset** and a breakdown whose **Look under** is
  **The focus asset**, reads them back with `GET /api/dashboards/<id>` (`scope: "focus"`, empty assets, no `root`), reopens them with the
  radio checked, and finds a stored fixed widget byte for byte the same after an unrelated save. The last case measures the header's
  Focus, Open page and Edit (none clips or overlaps, with a long dashboard name) in light and dark at 1440 and at 1024 with the sidebar
  minimised and expanded, the Focus dialog at 1440 x 900, 1024 x 640 and 800 x 600 (Show and Cancel stay in the window, the picker
  scrolls inside), and the dimmed, busy card while its answer is held. It puts no timing in an assertion.
- `w27.spec.ts` (its own project, last in the list, after `w25`) checks the dashboard experience on the seeded pilot hall. It runs only
  on the scratch stack (`COMPOSE_PROJECT_NAME` starts with `dcdash_e2e_`, like w11, w21 and w24 case R): `beforeAll` raises the raw
  retention to 90 days, seeds the pilot hall inside the stack, makes a site-wide rate when there is none and makes the starter dashboards
  it needs; `afterAll` puts the stack back (dashboards, the role and account it made, the rate, the seeded subtree, the retention and the
  look). The expected figures are never fixed numbers: they come from the API's `POST /api/widget-data` answer (the same body the page
  sent) through `lib/figures.ts`. Cases: the Energy and Cost cards show the card face of the API's figure with the exact face as their
  title, both sides of a comparison share one unit, and the two months sit side by side at 1920 and stacked at 1024; no card clips,
  splits a figure or changes size when its answer lands, in light and dark at three widths; **New dashboard** by mouse (Choose a
  template, Recommended for this site as the server says, More templates, Back to templates, Create from Cost and from Energy by area with
  the widgets the server previewed position by position, Blank in edit mode) and by keyboard alone (focus lands on a named control,
  Tab wraps, Escape closes and focus returns); the first-run guide in fresh browser contexts (Got it, a reload, the header button, storage
  blocked); "Updated HH:MM" and Refresh (and that the header does not move at 1024 with a 60 character name and a focus link); Make a copy
  ("(copy)", "(copy 2)", the widgets equal the source's); and a role with only `dashboards.view` (no gallery, no row menu, no request for
  the templates, 403 from the server). Every other spec that opens a dashboard calls `markGuideSeen` (`e2e/shell.ts`) so the guide panel
  does not move its cards.
- `w28.spec.ts` (its own project, after `w27`; `w29` follows it) checks display screens: playlists and the secret links that show them
  without signing in. It makes its own data through the API (an asset, two dashboards with one stat each, and the playlists and displays
  of each case, all named `W28 <run> ...`) and deletes it in `afterAll`, displays first, also after a failed case; it needs no scratch
  stack. Cases: an administrator makes a playlist of two dashboards and a display in the dialogs, sees the link once in the **Display
  link** field, copies it and presses **Done** (the page, its storage and a reload then hold no trace of the secret); a new browser
  context opens the link and ends on exactly `/display` with the cookie `dcdash_display` (httpOnly, SameSite=Strict, path
  `/api/display`) and shows the wall (the first dashboard's name and "1 of 2"; there is no "Connected as ..." sentence any more), that
  cookie gets 401 on `/api/me`, `/api/widget-data`, `/api/dashboards` and
  `/api/assets` (also when sent by hand), the three display routes answer and the figures equal the administrator's `/api/widget-data`
  for the same stored widget; revoking shows "revoked or is not valid" on the page within a minute (`page.clock`) and **Revoked** on the
  Screens card; deleting a dashboard of a playlist in use shows "1 item is skipped" on the Displays page, and the wall, after a reload,
  shows the other dashboard alone ("1 of 1"); the keyboard-only pass (Tab and Enter, **Move up**, **Move down**, **Remove**, the row menu
  and **Revoke**, focus returning to the opener, no sideways scroll) at 1440 x 900 and 1024 x 640, light and dark. The last case sends ten
  wrong claims (401, one body) and an eleventh (429 with `Retry-After`): it blocks the stack's client address for 15 minutes for WRONG
  secrets (a right secret from that address still connects, and the case checks it), so no later project may make a wrong claim (`w29`
  makes right ones only) and `W28_SKIP_BLOCK=1` skips the case. Every secret the spec used is appended to the file named by
  `W28_SECRET_FILE` (default `/tmp/w28-secret.txt`) so a log check can look for it.
- `w29.spec.ts` (its own project, after `w28`, `dependencies: ["w28"]`; `w31` follows it) checks the wall, the rotating screen a connected
  display shows. It makes its own data through the API (an asset, two dashboards, a playlist of them with a focus asset on the second and
  a display, plus dashboards, playlists and displays of their own for the cases that change or delete a dashboard, all named
  `W29 <run> ...`), deletes it in `afterAll` (displays first, also after a failed case), needs no scratch stack of its own and no running
  collector (the playlist's `status` is replaced in the page where a case depends on it), and **makes right claims only**: it runs after
  w28's blocking case, which refuses wrong secrets from the stack's address but lets a right one through. Cases: (1) a new browser
  opens the link at 1920 x 1080 and the wall names the first dashboard with "1 of 2", the figure on its card equals the administrator's
  `/api/widget-data` for the stored widget (through `lib/figures.ts`), nothing scrolls, the cursor is hidden after 3 s without a move and
  shown on the next, and within 20 s the second dashboard comes with its focus asset in the heading and "2 of 2"; (2) deleting a
  dashboard of the playlist leaves "1 of 1" within 80 s of clock time and never a full-screen sentence; (3) saving a dashboard with a new
  widget title (so its widget id changes) brings the new card within 80 s, with no page navigation and no band; (4) band 1: with the
  playlist's `status` replaced, "Readings stopped arriving at HH:MM." appears after the next poll over dimmed figures while the grid does
  not move, and goes with a healthy status; (5) band 2: with every `/api/display/*` request failing for 130 s, no band shows for the
  first 100 s and no full-screen sentence ever, then "This screen has not been updated since HH:MM. Trying again..." shows over dimmed
  figures, and it clears within 100 s of clock time after the requests return (a card that failed five times waits up to 78 s); (6) a
  display on an empty playlist says "Nothing to show. Every dashboard in playlist ... is skipped or the playlist is empty. ..."; (7) the
  header is 4.5 % of the height, within 0.2 %, at 1920 x 1080 and at 3840 x 2160, and the grid fits and lies under it at both; (8) every
  `/api` URL the page of case 1 asked for is under `/api/display/` (the claim, the playlist, widget-data), none a user route. Cases 2 to 5
  move the page's clock with `page.clock.runFor` in steps of 10 s, never `fastForward` (a jump of over 15 s is read as a sleep and a
  wake); case 1 runs in real time, because `runFor` pushes the page's clock ahead of the server's and the wall corrects its own clock from
  the `Date` header of every answer, which would move a turn later by the amount pushed. Every secret the spec used is appended to the
  file named by `W29_SECRET_FILE` (default `/tmp/w29-secret.txt`) so a log check can look for it.
- `w31.spec.ts` (its own project, last in the list, after `w29`, `dependencies: ["w29"]`; 1440 x 900) checks importing readings and
  mapping tags. It makes its own data through the API and the pages (sources, the top-level asset the tag list creates and the
  import profile, all named `W31 <run> ...` or `w31-<run>`, and the accounts and roles of case 2 that start `w31-`), removes it in
  `afterAll` also after a failed case, needs no scratch stack, and its cases do not depend on each other. Cases: (1) a `file` source from
  start to Undo: **Add source** shows the `file` description and no field of its own; **Map tag list...** refuses six lines until
  **Create missing assets** is ticked, **Check list** counts 6 mappings, 4 assets and 6 points, and **Create 6 mappings** raises a
  toast with an **Undo**; **Import file...** checks a file of 147 rows (144 new, 2 rejected, 1 unknown tag, each in words) through a new
  profile and imports it, a second check with the saved profile says 0 new and writes no audit row, and the Audit drawer's **Undo this
  tag list** removes 6 mappings and 4 assets, keeps the 6 points (they hold readings), waits while it works and answers "already undone" the
  second time; (2) a role with only `sources.view` has no Actions menu and gets 403 from the three routes, one with `discovery.accept`
  sees **Map tag list...** and not **Import file...**, one with `readings.import` the other way round; (3) the keyboard: both dialogs open
  from the menu by keys, focus lands inside and Tab wraps, Escape closes and focus returns to the menu button; (4) **Fill older range...**
  appears only on a source whose connector keeps history, and refuses 400 days and 51 days in the server's words without sending a fill;
  (5) the `file` source reads "filled by file import" and "Filled by importing files", has no **Test**, **Check connection** or **Browse
  points**, and its Points page says where its points come from. Lookups use `exact: true` where a name is part of another ("File" is
  inside "Profile", "Undo" inside "Undo this tag list").
- `w32.spec.ts` (its own project, last in the list, after `w31`; 1440 x 900) checks System events. It makes its own data (the asset
  `W32 <run>`, a `simulator` source at the live simulator with one mapped point, and the account and role `w32-...` of case 6), removes it
  in `afterAll` also after a failed case, never restarts the collector, and its cases are serial and depend on each other. Cases: (1) the
  source's address is changed to one nothing listens at and the sources list says `offline`, since when, and how many reads failed;
  (2) with the page's clock put three minutes ahead before it loads (Playwright's clock, so the two-minute banner needs no real wait), a
  plain banner (no alert role, no live region) names the source and offers **See its events**; (3) System events shows ONE open line and
  ONE row for it, and after about 70 to 100 s of real time (the count is written once a minute) the count has grown, still one; (4) the
  address is put back, the incident closes, the list holds the recovery row and the closed incident, and the banner is gone; (5) a
  connection check's audit entry carries a `passed` tag and an Outcome row whose link opens the event, which links back; (6) a role
  without `diagnostics.view` has no Events link, the page says No access and the API answers 403; (7) the Storage card reads `90 days`.
  Lookups use `exact: true` ("System events" is part of "System events and the audit log").
- `w33.spec.ts` (its own project, last in the list, after `w32`; 1440 x 900, and 1024 x 768 for the row menu) checks devices that move or
  disappear. Every case talks to ONE endpoint, the stand-in Historian at `simulator:9100` (an HTTP source of the `simulator` type), because
  a scan LINKS its finding to a source that already holds an endpoint and then makes no new source; no other spec keeps a source at 9100.
  If somebody else holds it, all cases SKIP with the holder's name (a skipped w33 in the summary line means that), and a silent
  Historian fails. It makes its own data (`W33 <run> ...`, the account and role `w33-...`) and removes it in `afterAll`. Cases (serial):
  (1) a hand-added source with two mapped points is pointed at `127.0.0.1:9100`, where nothing listens, and goes offline with an open
  `unreachable` incident; (2) a scan of the live endpoint makes a new source and both Sources and Discovery offer the move as `possibly`
  (the old source has no identity, so only the addresses speak); (3) its row menu opens with **Move to new address...** first, inside the
  window at 1024 x 768; (4) the new source's card says `Looks like ...` or `Was at ...`, the dialog opens from it, **Move 2 mappings**
  stays off until the tick is set and Cancel returns the focus to the card; (5) a role without `sources.edit` sees none of it and gets
  403; (6) the move from Sources keeps the mappings and the SAME point ids, the old source answers, the duplicate is gone, the toast Undo
  puts the dead address back, and the Audit page reads both entries; (7) a second round from Discovery undone from the audit drawer, and a
  second Undo of the same entry refused in words; (8) Not seen: three scans of one scope, the dimmed card, the panel sentence,
  **Turn on Not seen lately**, **Remove not seen (N)...** removing only the unmapped ones. The OPC UA move itself is covered by the
  backend tests and by the controller's drill. Lookups use `exact: true` ("Undo" is inside "Undo this move").
- `w35.spec.ts` (its own project, last in the list, after `w33`; 1440 x 900, and 1024 x 768 for the top bar) checks the data watchdog. It is
  the slow one, in real time (about 8 to 12 minutes): it sets the stale floor to 2 minutes (put back in `afterAll`), makes a `simulator`
  source with ONE energy counter at 5 s, waits for its first reading, then points it at a dead address. Cases (serial): `meters_stale` rises;
  the chip reads `N of M meters stale` with `oldest ... ago` and keeps the bar's height; the Sources row says `1 of 1 meter stale`;
  `GET /api/health/data` answers 503 without a cookie, with nine keys and no names; the figures worker opens ONE `data.stale` incident
  (1 to 3 minutes later); deleting the source clears the chip and the URL and closes the incident as `polling_stopped`; the Storage card
  **Data watchdog** and its dialog. Other specs may leave stale meters (N is read first); a dead enabled source with a billing meter would not.

It needs a fresh database (setup must still be pending), so the run starts the stack from scratch in a
separate Compose project (its own `dcdash_e2e_dbdata` volume; stop your normal stack first with
`docker compose --profile dev stop`, never with `-v`, because both use ports 80 and 443):

    docker compose -p dcdash_e2e --profile dev down -v --remove-orphans
    docker compose -p dcdash_e2e --profile dev up -d --build
    (cd frontend && npm run e2e)
    docker compose -p dcdash_e2e --profile dev down -v

or, with a fresh stack already running: `cd frontend && npx playwright test -c e2e/playwright.config.ts`.
First time only: `npx playwright install chromium`. Reports: `npx playwright show-report`. On Windows run `scripts/e2e.sh` from WSL
(`wsl bash scripts/e2e.sh`) or type the commands above in PowerShell.

`scripts/e2e.sh` runs the same steps in one go, always in the project `dcdash_e2e` (so its `down -v`
removes only `dcdash_e2e_dbdata`); only its final `down` has no `-v`. It refuses to start while the
normal stack is running, because both hold ports 80 and 443, and it refuses a project name that does
not start with `dcdash_e2e` (`E2E_COMPOSE_PROJECT` can pick another throwaway name). It also refuses to start while a
`SIM_FAULT_*` switch is set in the shell or in `.env`, because the simulator it starts would inherit the fault (see
[Field debugging](field-debugging.md#rehearsing-a-failure-development-simulator-only)). It passes the build id to the images like
`setup.sh` does. When it ends it removes the containers but
keeps the volume until the next run, which starts with `down -v`;
`docker compose -p dcdash_e2e --profile dev down -v` removes it right away.

The isolated `-p dcdash_e2e` run builds the same `dcdash-backend:local` and `dcdash-web:local` images
as the normal stack, so it re-tags them. If your database is still at an older schema, read [Upgrading
and going back](upgrading.md) before you start the normal stack again: because the image tag was
replaced, any later `docker compose up -d` on the normal project (with or without `--build`) creates or
recreates `api`, which then runs the database migrations. Otherwise rebuild your normal stack afterwards
(`docker compose --profile dev up -d --build`) to be sure it runs your own code. Either way, check with
`docker volume ls` that `dcdash_dbdata` is still listed.

`scripts/check_tls.sh` and `scripts/backup_smoke.sh` are different: each builds images of its own
(`<project>-backend:scratch` and `<project>-web:scratch`, so `dcdash-backend:local` and `dcdash-web:local`
are not re-tagged) and publishes only on `127.0.0.1` (ports 18080 and 18443 by default), so neither takes
ports 80 and 443. They run in a Compose project whose name must start with `dcdash_e2e`, and they delete only
that project's own volume; see [Practise a restore](backup-and-restore.md#practise-a-restore).

**Measuring Discovery speed.** `discovery-perf.mjs` (in the `frontend/scripts` folder) times the Discovery canvas on any build of the front end, with no
stack and no Docker: it serves a `dist` folder and answers every `/api` request itself with a mocked graph (the builder of
`frontend/e2e/graphModel.ts`), in headless Chromium at 1440×900. From `frontend/`:

    npx vite build --outDir /tmp/dist-x --emptyOutDir
    node <path to discovery-perf.mjs> <label> /tmp/dist-x <out.json> [scenario ...]

The scenarios are `expandAll:<points>` (click on **Expand all** to the first point drawn and visible; 60, 150 or 500), `expandOne:<points>`
(the click that opens the one group of a source of that many points, up to 2000; the source is opened first and not timed), `toggle` (closing and opening one group in a graph of about 2,000 nodes), `hover` (the
work after the 120 ms dwell on a node, in that graph), `drag` (frames per second while dragging in it), and `dragLive` and `hoverLive` (the
same with online sources, whose lines flow), `dragGroup:<points>` (one open group), and `dragW7u` and `hoverW7u` (the 2,286-node graph of
W7u). With none named it runs `expandAll:60`, `:150`, `:500`, `expandOne:60`, `:150`, `:500`, `:2000`, `hover` and `drag`. A scenario
with the suffix `All` (`dragGroupAll:<points>`, `dragW7uAll`, `hoverW7uAll`, `expandOneAll:<points>`) first presses every **Show 50 more**
so that all the pages are drawn: that is the like-for-like number against a build from before paging, where nothing is hidden and the `All`
scenario equals the plain one. Run the plain scenario as well for how it feels to a person, with only the first page drawn.
`REPEAT=n` sets the samples per scenario (default 3, the median is printed, every sample is kept in the file) and `CPU_SLOWDOWN=4` runs the
page on a CPU four times slower, which is nearer a laptop reached over a remote desktop. Compare two builds by running the same scenarios,
on the same machine, with the same `REPEAT`, and keep the output files: a number is only worth anything next to the other build's.

Related: [Developing](developing.md), [Adding a connector](adding-a-connector.md), [Backup and restore](backup-and-restore.md).
