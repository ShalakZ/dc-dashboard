# End-to-end tests

This page is for developers: how to run the Playwright end-to-end suite against a fresh stack without touching your data, what each
spec guards, and the two scratch-stack self-tests. The unit tests are on [Developing](developing.md).

> **Data safety.** `docker compose down -v` on the normal project deletes the `dcdash_dbdata` volume:
> every reading, user, source, tariff and dashboard you have. Never run it where that data matters. Run
> the end-to-end tests only in the isolated Compose project described below, which has its own volume;
> `scripts/e2e.sh` does exactly that (it always names the project `dcdash_e2e`, refuses any other name
> and cannot reach `dcdash_dbdata`).

Thirty-seven specs (`frontend/e2e/*.spec.ts`) run in one `playwright test` run against the dev-profile stack on `http://localhost/`
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
- `w14.spec.ts` (its own project, last in the list, after `w13`, the tail of the chain) checks the six small fixes of the polish wave. It
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
