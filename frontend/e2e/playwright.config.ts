import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "journey", testMatch: "journey.spec.ts", use: { ...devices["Desktop Chrome"] } },
    {
      name: "discovery",
      testMatch: "discovery.spec.ts",
      dependencies: ["journey"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "phase3",
      testMatch: "phase3.spec.ts",
      dependencies: ["discovery"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "headers",
      testMatch: "headers.spec.ts",
      dependencies: ["phase3"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w3a",
      testMatch: "w3a.spec.ts",
      dependencies: ["headers"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w3b",
      testMatch: "w3b.spec.ts",
      dependencies: ["w3a"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w3c",
      testMatch: "w3c.spec.ts",
      dependencies: ["w3b"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w3d",
      testMatch: "w3d.spec.ts",
      dependencies: ["w3c"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7a",
      testMatch: "w7a.spec.ts",
      dependencies: ["w3d"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w8",
      testMatch: "w8.spec.ts",
      dependencies: ["w7a"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7b",
      testMatch: "w7b.spec.ts",
      dependencies: ["w8"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7c",
      testMatch: "w7c.spec.ts",
      dependencies: ["w7b"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7d",
      testMatch: "w7d.spec.ts",
      dependencies: ["w7c"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7e",
      testMatch: "w7e.spec.ts",
      dependencies: ["w7d"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7f",
      testMatch: "w7f.spec.ts",
      dependencies: ["w7e"],
      // The chained-skeleton case (line 470) times a 150 ms fade against answers held back by 130 ms: on this machine it misses by one frame about one run in
      // three (W7i, W7j and W12b saw it, always with the same numbers, and the Discovery wave does not touch that page). One retry keeps a flake from
      // stopping the whole chain behind it; a real regression fails twice.
      retries: 1,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7g",
      testMatch: "w7g.spec.ts",
      dependencies: ["w7f"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7h",
      testMatch: "w7h.spec.ts",
      dependencies: ["w7g"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7i",
      testMatch: "w7i.spec.ts",
      dependencies: ["w7h"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7j",
      testMatch: "w7j.spec.ts",
      dependencies: ["w7i"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w9a",
      testMatch: "w9a.spec.ts",
      dependencies: ["w7j"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w9b",
      testMatch: "w9b.spec.ts",
      dependencies: ["w9a"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7k",
      testMatch: "w7k.spec.ts",
      dependencies: ["w9b"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w9c",
      testMatch: "w9c.spec.ts",
      dependencies: ["w7k"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7l",
      testMatch: "w7l.spec.ts",
      dependencies: ["w9c"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7m",
      testMatch: "w7m.spec.ts",
      dependencies: ["w7l"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7n",
      testMatch: "w7n.spec.ts",
      dependencies: ["w7m"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7o",
      testMatch: "w7o.spec.ts",
      dependencies: ["w7n"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7p",
      testMatch: "w7p.spec.ts",
      dependencies: ["w7o"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7q",
      testMatch: "w7q.spec.ts",
      dependencies: ["w7p"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    // Nothing may come after this one that needs a discovered source unless it scans for it first (w7t does, in its beforeAll): its Clear unmapped removes every unmapped discovered source of the shared stack.
    {
      name: "w7r",
      testMatch: "w7r.spec.ts",
      dependencies: ["w7q"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    // It works on assets and roles only (never a source), so it may follow w7r.
    {
      name: "w7s",
      testMatch: "w7s.spec.ts",
      dependencies: ["w7r"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // The LAST project that works on the real layout: its Tidy layout removes every saved node place of the shared stack and each case clears the layout first, so
    // nothing may come after it that reads a saved place from the stack. w7r (before it) may have removed the discovered Modbus source (Clear unmapped), so w7t scans its
    // own scope in beforeAll to bring it back.
    {
      name: "w7t",
      testMatch: "w7t.spec.ts",
      dependencies: ["w7s"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // WRITES NOTHING and needs no discovery data from the stack: every case answers GET /api/discovery/graph and the layout's PUT and DELETE through page.route from a generated
    // model (e2e/graphModel.ts, synthetic ids from 9,000,000 up), and any other write the app tries is refused and fails the case. That is why it may stand after w7t,
    // whose Tidy layout would otherwise matter to it. Its measurements go to .superpowers/sdd/2026-10-15-w7u-discovery-premium/measure.json.
    {
      name: "w7u",
      testMatch: "w7u.spec.ts",
      dependencies: ["w7t"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // It seeds a month of history into the stack (`docker compose exec ... python -m dcdash.seed.history`, so it runs only
    // when COMPOSE_PROJECT_NAME starts with dcdash_e2e_ and skips itself otherwise), closes and reopens the previous month, and in afterAll deletes the
    // seed again and puts the month back to open. Nothing may come after it that does not expect a stack that has just held a closed month (w12a works on
    // mappings, assets and roles only, and does not care). It measures 1440 x 900 first and 1024 x 640 by itself.
    {
      name: "w11",
      testMatch: "w11.spec.ts",
      dependencies: ["w7u"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // The tail of the chain. It READS what the projects before it left (a group of some source with nothing mapped; it scans for one itself when there is none) and puts every
    // mapping, asset, account and role it makes back, so nothing that follows it sees a difference. Each case that needs a size sets it itself (1440 x 900, 1024 x 640).
    {
      name: "w12a",
      testMatch: "w12a.spec.ts",
      dependencies: ["w11"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // WRITES NOTHING and needs nothing from the stack, like w7u: every case answers GET /api/discovery/graph (and the layout's PUT and DELETE) through page.route from a
    // generated model (e2e/graphModel.ts), so it may stand after w12a. It measures in the page at 1440 x 900 and 1024 x 640 (each case sets its size) and keeps the
    // graph's view settings (the Unmapped only switch, collapsed assets) in the browser's own storage, which a fresh context starts without.
    {
      name: "w12b",
      testMatch: "w12b.spec.ts",
      dependencies: ["w12a"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // Writes next to nothing, like w12b, and needs nothing from the stack: every Discovery case answers GET /api/discovery/graph, the layout's PUT and DELETE and GET /api/mappings/{id}/latest
    // through page.route from a generated model (e2e/graphModel.ts), so it may stand after w12b. Each case sets its own size (1440 x 900, 1024 x 640, 800 x 600) and the bar's cases resize the window
    // themselves; they pin no pixel width of a tier of the bar, only what holds at any width. The ONE case that writes is the last: it makes a role and an account (names start `w12c-`) to see
    // the real route answer 403, and removes both again (afterAll sweeps what a failed run left, users first).
    {
      name: "w12c",
      testMatch: "w12c.spec.ts",
      dependencies: ["w12b"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // Writes next to nothing and needs no readings from the stack, like w12c: beforeAll saves ONE dashboard (`w13 <run>`, the 15 widgets of e2e/w13Showcase.ts, on the first six real asset ids)
    // and every case answers POST /api/widget-data through page.route from that showcase, so it sees the states the seed cannot give on demand (estimated, partial, no rate, stale, no data). Its
    // cases set the admin's look (light navy-gold, dark desert-gold) through PUT /api/me/preferences before they open the page, and afterAll deletes the dashboard and puts the look back to
    // light navy-gold. Each case that needs a window size sets it itself (1024, 1440 and 1920 px); nothing may come after it that is not content with the admin on light navy-gold.
    {
      name: "w13",
      testMatch: "w13.spec.ts",
      dependencies: ["w12c"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // Writes next to nothing and needs no readings from the stack, like w13 and w12c: beforeAll saves ONE dashboard (`w14 <run>`, the 15 widgets of e2e/w13Showcase.ts) and the dashboard cases answer
    // POST /api/widget-data through page.route; the Discovery cases answer GET /api/discovery/graph (and the layout's PUT and DELETE) from a generated model (e2e/graphModel.ts), and any other write
    // the page tries is refused and fails the case. Its cases set the admin's look (light navy-gold, dark desert-gold) through PUT /api/me/preferences before they open the page, and afterAll deletes
    // the dashboard and puts the look back to light navy-gold. The ONE case that makes anything on the stack besides the dashboard is the Tariffs link of P5: it makes a role and an account (names
    // start `w14-`) to see Details without tariffs.view, and removes both again (beforeAll and afterAll sweep what a failed run left, users first). Each case that needs a window size sets it itself.
    {
      name: "w14",
      testMatch: "w14.spec.ts",
      dependencies: ["w13"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // WRITES NOTHING and needs nothing from the stack, like w14: every Billing case answers GET /api/billing/costs, /api/billing/months and /api/billing/costs.csv (and the Assets Tree cases
    // GET /api/assets) through page.route from a generated pilot-hall month of 370 rows (e2e/billingModel.ts, ids from 7,000 up), and any other write the page tries is refused and fails the
    // case. Its cases set the admin's look (light navy-gold, dark desert-gold) through PUT /api/me/preferences before a page opens, and afterAll puts it back to light navy-gold, so nothing
    // after it needs to know. Each case that needs a window size sets it itself (1440 x 900, 1024 x 768, 800 x 600). It signs in a second time on the other name of the stack (localhost against
    // 127.0.0.1) for the remembered-fold case, which the stack's web answers on any host.
    {
      name: "w17",
      testMatch: "w17.spec.ts",
      dependencies: ["w14"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // MEASURES the real pages (control heights on one line, the note box of the Close month and Reopen month dialogs, the remove dialogs). It needs from the stack either an asset that already has a
    // mapped metric (its page shows the "live" chip; then NO asset and NO mapping is made, the spec only reads) or, when there is none, at least one source with a FREE point (it makes the asset
    // `w18 <run>` and ONE mapping of that point, marked custom_unit `w18-spec`; a stack with neither fails the run with a message). It never moves, edits or deletes a mapping that was there before
    // it, and sweep() refuses to delete a leftover `w18 ` asset that holds a mapping it did not make. A stack with fewer than two top-level assets gets an unmapped `w18 <run> b` (the bulk remove
    // case picks two rows), and a dashboard `w18 <run>` is made for the dashboard cases; afterAll deletes only what the run made, also after a failed case. Every Billing case answers GET /api/billing/costs, /months and
    // /costs.csv through page.route from e2e/billingModel.ts and the remove dialogs get GET /api/assets/{id}/impact from page.route, so any other write the page tries is refused with a 500 and fails
    // the case (the Close month, Reopen month and delete buttons are never pressed). Its cases set the admin's look (light navy-gold, dark desert-gold) through PUT /api/me/preferences and
    // afterAll puts it back to light navy-gold. Each case that needs a window size sets it itself (1920, 1440, 1024, 800 wide).
    {
      name: "w18",
      testMatch: "w18.spec.ts",
      dependencies: ["w17"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // WRITES NOTHING and needs nothing from the stack beyond the sign-in, the site's time zone and the look preference (the Billing toolbar of w20): every case answers GET /api/billing/costs and
    // /api/billing/months through page.route from e2e/billingModel.ts (370 rows: an open month, a closed month, one missing rate, the two empty answers), and any other write the page tries is
    // refused with a 500 and fails the case. Its cases set the admin's look (light navy-gold, dark desert-gold) through PUT /api/me/preferences before a page opens, and afterAll puts it back to
    // light navy-gold. Each case that needs a window size sets it itself (1920, 1860, 1440, 1280, 1024, 800 wide, and the two widths around the 99rem threshold).
    {
      name: "w20",
      testMatch: "w20.spec.ts",
      dependencies: ["w18"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    // The Billing month check (Check month, its count and drawer, the line in the Close month dialog). Its cases A answer GET /api/billing/month-check from fixtures (e2e/monthCheckModel.ts) and
    // /api/billing/costs and /months from e2e/billingModel.ts through page.route, WRITE NOTHING (any other write the page tries is refused with a 500 and fails the case) and need nothing from the
    // stack beyond the sign-in, the site's time zone and the look preference: they set the admin's look (light navy-gold, dark desert-gold) through PUT /api/me/preferences before a page opens, and
    // afterAll puts it back to light navy-gold. Each case that needs a window size sets it itself (1440 x 900, 1024 x 640, 800 x 600). The ONE case B reads the real endpoint on the scratch stack:
    // it runs only when COMPOSE_PROJECT_NAME starts with `dcdash_e2e_` (like w11), seeds the three-panel history inside the stack in beforeAll, and removes the "Seeded demo" subtree and the
    // source `seeded-history` through the API in afterAll.
    {
      name: "w21",
      testMatch: "w21.spec.ts",
      dependencies: ["w20"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    // The Text widget (a heading, a paragraph or a divider; no data). It MAKES ITS OWN DASHBOARDS (`w22 <run>` and `w22 <run> dark`) through POST /api/dashboards in beforeAll and deletes both in afterAll,
    // also after a failed case, and talks to the real API (nothing is mocked). Its cases add the three styles through the Add widget dialog and read them back after a reload (light and dark), check that
    // a page of text widgets sends no /api/widget-data request, move and resize cards in edit mode (also at 1024 x 640), walk the dialog by keyboard, count an emoji as one character, and see the
    // server refuse a NUL, a heading with a line break and a text widget's data routes (PUT writes nothing that stays; the one valid CRLF save is undone). They set the admin's look (light navy-gold,
    // dark desert-gold) through PUT /api/me/preferences before a page opens, and afterAll puts it back to light navy-gold. The cases are serial: the later ones work on the cards of case 1.
    {
      name: "w22",
      testMatch: "w22.spec.ts",
      dependencies: ["w21"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // The asset picker of the widget editor (search, kind filter, folded tree, chips, Pick all under). It MAKES ITS OWN DATA through the API in beforeAll: the assets `W23 Site` > `W23 Hall 1` and
    // `W23 Hall 2` > 3 rows each > 10 racks each (69 assets, so with the other specs' assets the energy source offers more than 60 and the picker opens folded), and a dashboard `w23 <run>`
    // (the dialog is only opened and cancelled; nothing is saved). afterAll deletes the dashboard and the whole `W23 Site` subtree, also after a failed case, and sweeps what an earlier run left.
    // Its cases find a rack by typing, pick it and see it as a chip, filter by kind, Pick all under a row within and over the maximum of 20, remove chips from the keyboard, clear a search with
    // Escape without closing the dialog, check that a stat and a gauge pick one asset, that the list does not move at 1024 x 640 and 800 x 600, and the chips in the dark look. They set the admin's
    // look (light navy-gold, dark desert-gold) through PUT /api/me/preferences before a page opens, and afterAll puts it back to light navy-gold. The cases are serial.
    {
      name: "w23",
      testMatch: "w23.spec.ts",
      dependencies: ["w22"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // The month-to-date comparison and the breakdown by kind (a compare stat and daily chart, a bar chart with one bar per asset of a kind and its Split by select, and the editor's
    // comparison box and Bars choice). Cases 1 to 6 need NOTHING from the stack's data and never depend on today's date: beforeAll makes `W24 Site` > `W24 Hall 1` > three racks and the
    // dashboards `w24 <run>` (four compare/breakdown cards, only opened) and `w24 <run> edit` (empty; the editor cases add widgets and save it) through the API, every POST /api/widget-data (and
    // its CSV) is answered through page.route from fixtures with a fixed window ("1 to 17 Oct" against "1 to 17 Sep"), and any write a case does not expect is refused with a 500 and fails it. Its
    // cases set the admin's look (light navy-gold, dark desert-gold) through PUT /api/me/preferences before a page opens, and afterAll deletes both dashboards and the `W24 Site` subtree and puts the
    // account's own look back. Each case that needs a window size sets it itself (1440 x 900, 1024 x 640, 800 x 600). CASE R (R1 to R3) needs the scratch stack: it runs only when COMPOSE_PROJECT_NAME
    // starts with `dcdash_e2e_` (like w11 and w21), raises the raw retention to 90 days, seeds the pilot hall inside the stack (`docker compose exec ... --layout pilot-hall`), makes a site-wide rate when
    // there is none, reads its expected numbers from Billing's day cells (GET /api/billing/costs), closes last month through the API and changes the rack's rate, and in afterAll reopens last month and
    // deletes the rates, the dashboard, the seeded subtree and its source and puts the retention back. It expects last month open at its start (w11, w18 and w21 leave it so).
    {
      name: "w24",
      testMatch: "w24.spec.ts",
      dependencies: ["w23"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // The focus asset of a dashboard (`?asset=<id>`), the cards that follow it, drill-through on the breakdown and the starter Power dashboard. It MAKES ITS OWN DATA in beforeAll through the API:
    // `W25 Site` > `W25 Hall 1` > `W25 Row 1` > three racks, `W25 Hall 2` (with one asset of a very long name) and a Panel beside the halls, and the dashboards `w25 <run> follow`, `... edit`, `... drill`
    // (its breakdown follows the focus), `... plain` (the same breakdown with a root of its own: nothing follows the focus) and one with a very long name; afterAll deletes them (and the role `w25-dash-only`, its account and any "Power" it made), each step on its own, also after a failed case, and puts the account's
    // own look back. Cases that depend on how many top-level assets the stack holds read that number from GET /api/assets first (case 5 makes a second root and removes it; its last case runs only
    // when the stack has at most one top-level asset besides this spec's own, and removes `W25 Site` first when there is one). Most cases talk to the real server; the drill-through cases answer the
    // breakdown's POST /api/widget-data in the page with bars that are real asset ids and click the chart's canvas (the bars are found by their pixels). Its cases set the admin's look (light
    // navy-gold, dark desert-gold) through PUT /api/me/preferences before a page opens. Each case that needs a window size sets it itself (1440, 1024 with the sidebar minimised and expanded,
    // and 1440 x 900, 1024 x 640, 800 x 600 for the Focus dialog). No timing is asserted. The cases are serial.
    {
      name: "w25",
      testMatch: "w25.spec.ts",
      dependencies: ["w24"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // The dashboard experience (figures on the card, the two-step template gallery, the first-run guide, Updated and Refresh, Make a copy). It runs only when COMPOSE_PROJECT_NAME starts with
    // `dcdash_e2e_` (like w11, w21 and w24 case R) and is skipped with its message otherwise: beforeAll raises the raw retention to 90 days, seeds the pilot hall INSIDE the stack, makes a site-wide
    // rate when there is none, and makes the starter dashboards `w27 <run> power` and `w27 <run> <60 characters>` through POST /api/dashboards. Its figure cases read the expected numbers from
    // POST /api/widget-data (the body the page sent) through lib/figures.ts, never from fixed values; the gallery cases make and delete `w27 <run> ...` dashboards; one case makes a role and an
    // account (`w27-dash-only`, `w27-viewer`) and removes both; the guide cases use browser contexts of their own (every other case marks the guide as seen first, e2e/shell.ts). Its cases set
    // the admin's look (light navy-gold, dark desert-gold) through PUT /api/me/preferences before a page opens, and afterAll deletes every dashboard, the role, the account, the rate, the seeded
    // subtree and its source, puts the retention back and puts the account's own look back. Each case sets its own window size (1920 x 1080, 1440 x 900, 1024 x 640 or 768, 800 x 600). The cases are serial.
    {
      name: "w27",
      testMatch: "w27.spec.ts",
      dependencies: ["w25"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // Display screens (playlists and display links). It MAKES ITS OWN DATA through the API in beforeAll (`W28 <run> site` with two dashboards of one stat each; every playlist and display a case makes is
    // named `W28 <run> ...`) and deletes all of it in afterAll, also after a failed case (displays first), and puts the account's own look back. It talks to the real API (nothing is mocked) and needs no
    // scratch stack. Case 1 makes a playlist and a display in the dialogs and reads the link once; case 2 opens it in a new browser context (cookie, the three display routes, 401 elsewhere, figures equal the
    // administrator's); cases 3 and 4 revoke a display and delete a dashboard; case 5 is the keyboard-only pass at 1440 x 900 and 1024 x 640, light and dark. The last case (6) makes ten wrong claims
    // and an eleventh that is refused: it BLOCKS THE STACK'S CLIENT ADDRESS for 15 minutes for WRONG secrets (a right secret still connects, api/display.py:295-301), so no project after this one may make a
    // wrong claim (w29 makes right claims only), and it is skipped when W28_SKIP_BLOCK is set. The secrets it used are appended to the file named by W28_SECRET_FILE (default /tmp/w28-secret.txt). The cases are serial.
    {
      name: "w28",
      testMatch: "w28.spec.ts",
      dependencies: ["w27"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // The wall, the rotating screen a connected display shows (w29). It MAKES ITS OWN DATA through the API (`W29 <run> site`, two dashboards, a playlist of them with a focus asset on the second, a display; the
    // cases that edit or delete a dashboard make dashboards, a playlist and a display of their own, all named `W29 <run> ...`) and deletes it all in afterAll, also after a failed case (displays first). It talks to
    // the real API, needs no scratch stack of its own, and MAKES RIGHT CLAIMS ONLY: it runs after w28's case 6, which blocks the stack's client address for wrong secrets, and a right secret still connects.
    // Cases: the rotation (first dashboard, "1 of 2", the figure equal to the administrator's, no scroll, the cursor hidden after 3 s, the second dashboard with its focus asset within 20 s, in real time); a deleted
    // dashboard ("1 of 1" within 80 s) and an edited one (its new card within 80 s, no navigation, no band) under `page.clock`; band 1 (the playlist's `status` replaced in the page) and band 2 (130 s of aborted
    // requests under `page.clock`, then the way back); an empty playlist; the header's share of the height at 1920 x 1080 and 3840 x 2160; and that the page asks for /api/display/* only. The clock is moved with
    // `runFor` (never `fastForward`: a jump of over 15 s is a wake). The secrets it used are appended to the file named by W29_SECRET_FILE (default /tmp/w29-secret.txt). The cases are serial.
    {
      name: "w29",
      testMatch: "w29.spec.ts",
      dependencies: ["w28"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } },
    },
    // Importing readings and mapping tags (w31). It MAKES ITS OWN DATA through the API and the UI (`W31 <run> ...` sources, the top-level asset the tag list creates, the import profile `w31-<run>`, and the accounts and roles of
    // case 2, which start `w31-`) and removes it all in afterAll, also after a failed case; it needs no scratch stack. Cases: a `file` source made in the Add source dialog, a tag list checked (problem lines, then a clean report)
    // and created with its Undo toast, a CSV file checked and imported through a new profile and checked again with the saved one (0 new), and the Undo from the Audit drawer (the points stay, a second Undo says it was done);
    // the three row-menu items per permission; the keyboard and focus of the two dialogs; the Fill older range dialog refusing 400 days back and 51 days in the server's words; and a file source that never polls.
    {
      name: "w31",
      testMatch: "w31.spec.ts",
      dependencies: ["w29"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // System events (w32). It MAKES ITS OWN DATA through the API (`W32 <run> ...`: the asset, a `simulator` source at the live simulator with one mapped point, and the account and role `w32-...` of case 6) and removes it
    // all in afterAll, also after a failed case; it needs no scratch stack and never restarts the collector (it changes the source's URL through the API: the dead address `http://simulator:9`, then the live one back). Cases
    // (serial): the source goes offline (`offline_since`, `failed_reads`); the Sources banner, with the page's clock put three minutes ahead before it loads, is a plain banner that names the source and links to its events;
    // System events shows ONE open incident, pinned and as one row, whose count grows by itself (up to about 100 s of real time); the way back closes it (the recovery row with its duration, the pinned line and the banner
    // gone); a connection check's audit entry shows its outcome (tag, drawer row) and the link to the event and back; a role without diagnostics.view has no Events link; the Storage card says 90 days and has Change....
    {
      name: "w32",
      testMatch: "w32.spec.ts",
      dependencies: ["w31"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
