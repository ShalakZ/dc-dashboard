# Dashboards and billing

This page is for the people who build dashboards, read the monthly energy and cost report and set the tariffs, and for anyone who has to
explain a cost figure. It covers the dashboards and their widgets, the default dashboard, the Billing page, tariffs, which rate applies
to a day, how energy and history are calculated, what the month check lists, how a finished month is closed so that it stops changing,
and the limits of all of it.

## Who may do what

Roles are enforced by the API; the screens only hide what you cannot use. The table is the three built-in roles; see
[Roles and permissions](roles-and-permissions.md) for what each permission allows and for making a role of your own.

| | Viewer | Operator | Admin |
|---|---|---|---|
| Open dashboards and Billing, export CSV, open Check month ([Checking a month](#checking-a-month)) | yes | yes | yes |
| Close and reopen a billing month (`billing.close`, [Closing a month](#closing-a-month)) | no | no | yes |
| Create, edit and delete dashboards | no | yes | yes |
| Choose the default dashboard (Dashboards list, row menu) | no | no | yes |
| Read tariffs and the currency (Tariffs screen, read-only for an Operator) | no | yes | yes |
| Set tariffs and the currency (Tariffs screen) | no | no | yes |

## Dashboards

Dashboards are shared by everyone.

- **Size.** A dashboard holds up to 24 widgets, and the site up to 50 dashboards. A dashboard name is 1 to 100 characters (spaces at
  the ends are trimmed) and unique: a name already in use is refused with a 409. A widget title is at most 100 characters.
- **Widgets.** Six types: time series, bar, stat, gauge, table and text. Text is the one type with no data (see **Text widget** below);
  the other five show a metric, energy or cost for up to 20 assets (a stat or a gauge shows one). A metric widget offers only assets
  that have a mapping for that metric. Custom metrics are not available in widgets; they stay on the asset page. A stat or a time series
  of energy or cost can set this month against last month (**Comparing with last month**), and a bar chart of energy or cost can draw one
  bar for each asset of a kind (**Breakdown by kind**), both below.
- **Finding assets.** The asset picker of the widget form (**Assets**, or **Asset** for a stat and a gauge) has a **Search assets** box:
  type part of a name or a kind (capitals do not matter) and the list narrows to the matches, with the halls, rows and racks above them;
  the name of a hall or a rack also lists what is inside it, and a line says how many match. Escape clears the text, a second Escape closes
  the dialog. **Filter by kind** gives All kinds or one kind with its count, for example Rack (117), for the assets the widget can offer.
  A list of more than 60 rows opens folded like the Assets Tree; a search or a kind opens the way to every match; **Show 200 more** adds
  to a long result. Picks show as tags above the list, in the order picked (the x removes one, **Clear all** all of them, **N selected (up
  to 20)** counts them); a tag shows the name and the end of the parent path when the path is long ("Feed A (… / Row 1 / Rack 05)") and
  the full name is its tooltip; a stat or a gauge takes one asset and a second pick replaces it. **Pick all under**, at the right of a row, picks
  every matching asset below it, in tree order, if they all fit in the 20; if not it picks nothing and says how many there are and how
  much room is left ("34 assets under Hall 1, room for 17: nothing was picked"). For a metric widget the rows above an asset with the
  metric are greyed, with no tick box, and Pick all under there picks only the assets that have it. Tab goes search, **Filter by kind**,
  the tags' x buttons, the rows (fold arrow, tick box, **Pick all under**), **Show more** if there is one, then **Clear all**; Space ticks.
- **Text widget.** A heading, a paragraph or a divider that you write on the dashboard. **Edit**, **Add widget**, Type: **Text**, then
  **Style** (Heading, Paragraph or Divider) and **Text**. It has no asset, source, metric, range, CSV, Details or live values, and the
  dashboard asks the server for no data for it. The viewer draws a heading as a heading (no card title), a paragraph as a card and a
  divider as a plain line; in edit mode every text widget keeps the normal title bar (grip, title, Edit, Delete). A new heading or
  paragraph is 6 columns by 2 rows, a divider 12 by 1; the smallest is 2 by 1.
  - **Title.** Still required: it names the card for a screen reader and for the Edit and Delete buttons. The form fills it in from the
    text (the first line, 40 characters; "Divider", "Divider 2" and so on) until you type your own.
  - **Plain text only.** No HTML, no markdown, no links: `<b>x</b>` shows as typed. Line breaks are kept (a pasted CRLF becomes a
    line feed; U+2028 and U+2029 count as line breaks) and both ends are trimmed. A heading is 1 to 200 characters on one line, a
    paragraph 1 to 2,000, a divider has no text. Control characters (all except tab and line feed) and unpaired surrogates are
    refused. Characters are counted as Unicode code points: an emoji counts 1, an emoji with a skin tone 2, a family emoji 5. The form
    and the server apply the same rules; the server is the judge.
  - **API.** `PUT /api/dashboards/{id}` accepts `type: "text"` with `config: {"style": "heading"|"paragraph"|"divider", "text": "..."}`
    (any other key is refused). `POST /api/widget-data` and `/api/widget-data/csv` answer 422 `a text widget has no data` for it. A
    widget title with a control character other than a tab is refused with a 422. The 24-widget cap and the dashboard list's widget count include text
    widgets.
  - **Audit.** The dashboard-save audit row holds only the widget count and a short digest of the widgets, never the words.
- **Comparing with last month.** A stat or a time series of Energy or Cost for exactly one asset can set this month so far against the
  same days of last month. In the widget form tick **Compare with the same days of last month**: the box is offered only for those two
  types and those two sources; ticking it keeps the first asset picked (the picker then takes one asset and a second pick replaces it),
  sets **Widget range** to **This month** and locks it there
  ("A comparison always looks at this month so far, against the same days of last month."), and unticking gives the range back. The widget
  keeps its own range, so changing the dashboard's range does not move it. A stat that compares starts 3 columns wide and 3 high, and a
  stat that gains the comparison grows to that size.
  - **Which days.** Days are the site's local days. "This month so far" means the complete days only, the 1st up to yesterday: today is
    left out because it is not finished and would change all day. With N complete days the comparison uses D, the smaller of N and the
    length of last month, on both sides: days 1 to D of this month against days 1 to D of last month. Days this month has and last month
    did not are left out and the card says so ("29 and 30 March have no matching day in February."). A day of 23 or 25 hours at a clock
    change counts as one day on its side. On the 1st no day is complete yet: the card says "Nothing to compare yet" and shows no figure.
  - **Every figure names its window.** The card shows "1 to 17 Oct" under the headline and, under "Same days last month", "1 to 17 Sep". A
    plain **This month** widget includes today so far and shows a larger number; the two are not meant to match.
  - **One calculation.** Each day is worked out the way Billing works it out (each local day on its own, with the rate of that day) and the
    days are added up, so a figure on the card is the sum of Billing's day cells for days 1 to D (see [Billing](#billing)). kWh and cost
    are two measures: shown separately, never mixed or converted. A stat shows its own source (kWh for Energy, cost for Cost); Details
    shows both; two stats side by side give both on the dashboard.
  - **Marks.** `~` (estimated), `*` (a cost with an hour that has no rate; a kWh figure never carries it) and the dash (no readings, or no
    rate; never a zero) travel with the figure to the card, the chart's line names and tooltip, Details and the CSV.
  - **The change** is said in words and sign, never by colour alone: "up 12.4 % (+340.00 kWh)", "down 3.1 % (-120.00 kWh)", "no change". It carries the marks of the figures it is made from: `~` when a side is estimated ("down ~0.2 % (~-294.32 kWh)") and, for a cost, `*` when a side has an hour with no rate ("up 18.60* USD").
    The card shows no percentage, and says why on its note line, when last month used nothing ("No percentage: last month used
    nothing."; for cost "... last month's cost was zero."), when a day has no readings on either side ("No percentage: last month has no
    readings on 3 of the 17 days."), or, for a cost, when some of it has no rate ("No percentage: some of the cost has no rate."). It shows
    no change at all, neither amount nor percentage, when a side has no figure ("No readings last month.", "No readings this month."; for
    cost also "No cost comparison: no rate applies to these days."). An estimated (`~`) side keeps its percentage and its mark.
  - **Rate note.** When a rate that reaches the asset (its own, an ancestor's or the site default, as far as the meters under it) takes
    effect after the first day of last month's window and no later than the last day of this month's, the cost says "A rate changed on 5
    Oct, so the cost change is not only usage." The note only tells you the cost change is not all usage; it does not take the change out.
  - **A closed last month** is read from its closed figures, the ones Billing shows (see [Closing a month](#closing-a-month)), never
    worked out again, so the card and Billing cannot disagree after a rate or an asset changed; the card says "Last month is closed:
    these are its closed figures." An asset that is not in the closed figures (created or moved in after the close) gets "Not in last
    month's closed figures." and no comparison; a month closed in another site time zone gets "Last month was closed in another time zone,
    so it cannot be compared day by day." and none; one closed in another currency compares kWh but not cost ("No cost comparison: the
    currency changed since last month closed."). A reopened month is read live again, as Billing does, and closing or reopening a month
    refreshes the comparing widgets. **The gap that stays:** a plain **Last month** widget still shows live figures even when that month
    is closed, so after a change that follows a close it and Billing can disagree; only the comparison reads the closed figures.
  - **The stat.** The headline, the asset name, the window, **Same days last month** with its figure and window, the change, and one note
    line: the most important note, with "(+2 more in Details)" when several apply (the whole text is its tooltip). **Details** has a
    **Comparison** table (This month so far, Same days last month and Change, in Energy and in Cost, the windows by date) and every note
    in full, prefixed "Energy:" or "Cost:" when only one measure says it.
  - **The chart.** A time series that compares draws two lines on a day-of-the-month axis, named by their months ("October",
    "September", with their marks): this month's complete days and last month's days 1 to D, last month's dashed. The buckets are always
    days, even early in the month. The tooltip names both dates of the day with each figure and its marks; a day with no readings is a gap,
    never a zero.
  - **CSV.** Same columns as any widget. A comparing stat has one row for this window and one for last month's same days, dated at their
    first day; a comparing time series has this month's day rows and last month's day rows. `estimated`, `partial` and `no_data` are
    filled as usual.
  - **API.** `POST /api/widget-data` and `/api/widget-data/csv` take the optional config key `compare` (`"none"` or
    `"same_days_last_month"`) and the answer gains a `compare` block (null when unused). A comparison on another type, on the Metric source,
    on other than one asset, or whose range is not This month is a 422 whose text starts with the field ("range: a comparison needs the
    range this month"). The stored config leaves a key out while it holds its default, so every widget saved earlier is stored and
    fingerprinted exactly as before.
- **Breakdown by kind.** A bar chart of Energy or Cost can draw one bar for each asset of a kind, for example a bar per Rack or per Panel.
  In the form set **Bars** to **One bar per asset of a kind** (not offered on the Metric source). The **Assets** picker is replaced by
  three fields: **Look under** (pick one asset, or press **Whole site**; the bars are the assets of the kind anywhere below it, the asset
  itself not counted), **One bar for each** (the kind; the asset kinds are suggested, capitals and extra blanks do not matter) and **Bars to
  show** (3 to 50, 10 by default). If the asset it looks under is deleted later, the form says so and shows Whole site.
  - **The rule: one measured level at a time.** Choose the level that carries the meters, for example Panels or Racks. Each bar is that
    asset's own reading. If two levels both have meters (racks and the panels that feed them), a total over both counts the same energy
    twice. The (i) beside **One bar for each** says the same. Telling the engine which meter is the measured one (meter roles) is not
    built. The pilot-hall demo data has its meters on the feeds by default, so a breakdown by Rack, Row or Hall draws figures and one by
    Panel shows no data; `--metering panels` is the other way round (see [Developing](developing.md#the-pilot-hall-a-demo-tree-with-racks)).
  - **How the bars are made.** The server adds up each asset's figure for the widget's range with the same calculation every other bar
    widget uses, highest first. The card draws the top bars and one line under the chart: "and 107 more Racks: 1234.50 kWh in all", the
    sum of the others with its `~` and `*` marks and, when some of them have no figure, "(N with no data)". There is never an "Other" bar.
  - **No data is not zero.** An asset of the kind with no figure is a dash on the axis, never a zero bar, and comes after the ones with
    figures. When none has a figure the card says so ("None of the 8 Panels under Seeded pilot hall has energy readings.").
  - **Inside another.** An asset of the kind inside another asset of the same kind (a rack in a rack) is not a bar of its own: the outer
    one already holds its energy. The card says how many ("3 Racks are inside other Racks and are counted there.").
  - **Split by.** Under the chart, **Split by** lists the kinds present under the asset it looks under, with their counts ("Rack (117)").
    Choosing one redraws the chart for that kind for this visit only, like the dashboard range: it is not saved and not in the address.
    In the editor and its Preview the choice is shown but cannot be used.
  - **CSV and Details.** The CSV lists every asset the breakdown counts, in the same order, not only the bars drawn (an asset inside
    another of its kind has no row of its own: the outer one holds it); the columns are the same. **Details** has a **Breakdown** list: the kind, where it looks, how many assets of the kind, how many bars are drawn, the ones not
    drawn with their sum, how many have no data and how many are inside others.
  - **API.** The config keys are `bars: "kind"`, `kind` (1 to 100 characters), `root` (an asset id; null is the whole site) and `top`;
    `assets` must be empty. The answer gains a `breakdown` block (null when unused). A rule broken is a 422 that starts with the field.
- **A focus asset.** A dashboard can be pointed at one asset, a hall, a row or a rack, and the widgets that follow it then show that
  asset (see **Widgets that follow the focus**). Until someone chooses a focus a dashboard shows what it always showed.
  - **Choosing.** The **Focus** button in the dashboard's header, beside the range, opens the dialog **Choose a focus**: the asset
    picker (**Focus asset**, with the search box and the kind filter described above), a **Whole site** button that goes back to no
    focus, and **Show** and **Cancel**. What you pick is only a draft until you press **Show**; **Cancel** and Escape change nothing. The
    button is there only for a role that may see the Assets Tree, and only in view mode. In edit mode the page keeps the focus and says
    "Widgets that follow the focus show Hall 1." under the trail, so the previews follow it.
  - **The address.** The focus is held in the address as `?asset=<id>`. A link with it opens the dashboard on that asset, so a focus can
    be shared. Each change of focus is a new step in the browser's history, so Back walks back through the assets you looked at, and the
    range you picked for the visit stays. The sidebar, the first page after signing in and the Dashboards list open a dashboard without
    it: the whole site.
  - **The trail.** With a focus the trail above the dashboard goes on through the asset's parents: Dashboards / Power / Hall 1 /
    Row 2 / Rack 05. A click on the dashboard's name shows the whole site (it clears the focus), a click on a parent moves the focus up to
    it, and the last crumb is the focus itself. When the site has exactly one top-level asset, the trail does not repeat it.
  - **Open page.** With a focus, the link **Open Hall 1 page** beside the Focus button opens that asset's page in the Assets Tree.
  - **A link that cannot be followed.** A role that may not see the Assets Tree ignores `?asset`, shows the whole site and says "This
    link opens the dashboard on one asset. Your role cannot open assets, so it shows the whole site."; the line names nothing. A link to
    an asset that was deleted, never existed or is not a number shows the whole site too, with "The asset in this link no longer exists,
    so the dashboard shows the whole site." (the same line for all three, so it does not tell them apart), and the address is cleaned so
    Back does not return to it.
- **Widgets that follow the focus.** In the widget form the choice **Show** says what a widget draws: **Assets chosen here** (what every
  widget did until now), **The focus asset** or **The children of the focus asset**. A widget that follows the focus has no asset picker:
  the focus chooses its assets.
  - **Where it applies.** **The focus asset** works for every data type, a stat and a gauge included. **The children of the focus
    asset** works for a time series, a bar chart of one figure per asset or per time bucket, and a table: one line or bar for each child, in
    the tree's order, at most 20. A breakdown by kind has no such choice; its **Look under** gains a button **The focus asset** beside
    **Whole site**, and the live line reads "Under: The focus asset". A comparison always shows one asset, so it takes only the focus
    asset.
  - **Children.** With more than 20 children the card shows the first 20 and its footer says "20 of 34 children of Hall 1 shown". An
    asset with no children gets a sentence in place of the figures ("Seeded pilot hall / Hall 1 / Rack 05 / Feed A has no children."), and so
    does a breakdown whose kind is not found under the focus ("No Panels under Hall 1. Choose another kind in Split by.").
  - **Cards that keep their own assets.** While a focus is set, every data card that does not follow it says so at the end of its
    footer line: "Its own assets, not Hall 1". A text widget says nothing. Those cards do not move when the focus changes and make
    no new request for it.
  - **Changing the focus.** A card that follows it keeps its old figures, dimmed and marked busy for a screen reader, until the new
    ones land, so figures of one asset are never shown plain under the name of another. A focus you looked at a moment ago is drawn at
    once from what the page remembers, and the card reads it again in the background. **Details** and **CSV** of such a card are for the
    asset it shows, and Details closes when the focus changes. A card with only a sentence to show has no Details button.
  - **No focus, and the sites with several top-level assets.** With no focus the dashboard shows the whole site. A site with exactly one
    top-level asset treats that asset as the focus when none is chosen (a link to it is shown without the `?asset`). With several, a card
    that shows one asset says "This site has 3 top-level assets: choose a focus to see this figure." (to a role that cannot choose
    one: "This site has 3 top-level assets, so this figure needs a focus asset, and your role cannot choose one."), a children card
    lists the top-level assets, and a breakdown by kind looks at the whole site. A month or a comparison added up over several
    top-level assets is not built yet. A demo seed sits beside your own assets as one more top-level asset, so on such a stack the
    Power starter asks for a focus until you choose one.
  - **API.** A widget's config has the key `scope` (`"fixed"` by default, `"focus"` or `"children"`); a stored config leaves it out
    while it is `fixed`, so every widget saved earlier is stored and fingerprinted as before. A following widget must have `assets`
    empty (422 "assets: leave the assets empty; the focus chooses them"). `POST /api/widget-data` and `/csv` take the optional `focus`
    (an asset id) and the answer gains a `focus` block (null for a widget that does not follow): the asset with its path, a `state` of
    `ok`, `gone` or `choose`, the children shown and counted, and the number of top-level assets. A request that carries `focus`
    needs See the Assets Tree as well as See dashboards, or it is refused with a 403. A deleted and a never-existing id get the same
    answer.
- **Drill-through.** In view mode a click on a bar of a breakdown by kind, or on its name under the chart, narrows the whole
  dashboard to that asset when it has children, and opens its page when it is a leaf; the tooltip says which ("Click to narrow the
  dashboard to Rack 05", "Click to open Feed A's page"). The keyboard way is in **Details**: each bar's row has a **Narrow** button
  (**Narrow to Rack 05** for a screen reader) when the asset has children; it narrows the dashboard, closes the panel and puts you back
  on that card's Details button, and an asset without children keeps its name link. There is nothing of this in edit mode or in a
  preview, and none for a role that may not see the Assets Tree.
- **The Power starter.** **New dashboard**, then **Start from** Power, makes a dashboard with its widgets already on it; **Blank** is
  the empty dashboard it was before, and opens in the editor as before. Choosing Power sets the range to **This month**, an empty name
  becomes "Power" (a second one needs another name: the dialog shows the server's "a dashboard with this name already exists"), and the
  dashboard opens in view mode, not in the editor. On the Dashboards page with no dashboards yet, a role that may build them also
  sees **Start blank** and **Start from Power**; a viewer sees only the line "No dashboards yet.". The server makes the dashboard and its widgets in
  one step and writes one `dashboard.created` audit row, which adds `"recipe": "power"` and the real widget count.
  - **The five widgets.** A heading, "Power use and cost"; the stats "Energy" and "Cost", each for this month so far against the same
    days of last month (**Comparing with last month**); "Energy by <kind>", a breakdown of energy by the kind that has meters; and the
    daily chart "Energy by day, against last month". All but the heading follow the focus, so the whole dashboard answers for the site,
    a hall or a rack depending on the focus (choose it with **Focus**, a click on a bar or a link). Edit it like any other dashboard.
  - **Which kind.** Panel as soon as any Panel has a meter of its own; else the kind with the most assets that have one (a tie goes to
    the name that comes first); a site with nothing metered gets Panel. A meter here is a kWh counter or, failing that, power in kW,
    so the starter is the same whether the panels report kWh or kW. A site with no assets still gets the dashboard.
- **Look.** Widgets follow the theme like the rest of the app: Light, Dark or Match my device, and each Theme colour, in the profile
  panel. A card in dark mode is a dark card, and the chart text, grid lines, legend and tooltip are drawn in the same colours, so an
  open chart repaints in the new look as soon as you switch, without a reload. A **gauge** is a half-circle arc filled from its minimum
  to the latest value; the two ends of the scale are written under the ends of the arc, and the figure, its unit and the asset name are
  written under the arc, never on it, so they stay readable on the smallest card. A value outside the scale fills the arc to its end
  and the figure still shows the real reading; a gauge with no reading shows the empty arc and "no data" in place of the figure.
- **Time ranges.** A dashboard has one time range and a widget may override it. The ranges are the rolling `1h`, `6h`, `24h`, `7d`,
  `30d` and the calendar `today`, `yesterday`, `this_month`, `last_month` (in the site timezone); there are no custom date ranges, and
  changing the range on the page affects that visit only.
- **Live values.** Stat and gauge widgets that show the latest value follow the live stream while their range ends now (the rolling
  ranges, `today` and `this_month`; not `yesterday` or `last_month`); every widget also refreshes every 30 seconds.
- **Details.** Every card on a dashboard has an information button in its title bar (**Details for <title>**). It opens a panel on the
  right, **Details: <title>**, which says exactly what the card shows, from the answer the card already has (nothing is fetched again).
  The button waits while the card is still loading, and it is not there while you edit the dashboard, in the widget form's Preview,
  or when the widget could not be loaded. Escape, **Close** or a click outside the panel shuts it and puts you back on the button.
  The panel has:
  - **What it shows**: the type, the metric (with its unit) or Energy or Cost, what one figure is in words (for example "Total per
    hour", "Average of each bucket, with the lowest and highest as a band" or "The latest reading"), and the assets. Each asset is a link
    to its page for a role that may open the Assets Tree, and plain text for one that may not. Assets left out are listed: those
    removed, and those without the metric (by name when the page already has them, else a count).
  - **Time window**: the real window of the answer, from and to in the site time zone with the zone named (for example "2026-10-17
    10:46 to 2026-10-18 10:46 (Asia/Qatar)"), the range's name, and what the data is. For a metric chart over time it also names the
    stored data that served it (the raw readings, the 1-minute roll-up or the hourly roll-up). It never states the width of a time
    series bucket, because the server chooses it and the answer does not carry it.
  - **Freshness**, for the latest reading of a metric in a stat, a gauge or a table: "Last reading 12:04:31 (9 s ago)" per asset, the
    age counting up every second while the panel is open, with a sentence when the reading is stale (older than three polling
    intervals of its meter, and at least a minute). When the range has ended (`yesterday`, `last_month`) there is no reading time to
    show, only the hour of the roll-up the last value belongs to ("Last value of the hour from 23:00 (hourly roll-up)"), and nothing
    is called stale.
  - **What the markers mean here**: one line for each marker this card actually uses (`~`, `*`, the dash for no rate, "no data").
  - **Per asset**: the state of each asset in words (estimated, partial, no rate, no data, stale). A bar chart of one figure per asset
    adds its value. A chart adds a **figures table** as text, since a chart is a picture: for a metric, **Lowest** and **Highest**
    (the extremes of the stored readings, because the roll-ups keep them; under **Highest** the start of the bucket it fell in, as
    `bucket from <time>`, which is the start of a bucket and never the moment of the peak), and the **Last bucket** (with the start of that
    bucket under it); for energy and cost, the highest bucket, the last bucket and **Total of the buckets shown**. The panel is 560 px wide
    (the whole window on a narrow one). Where a figure says no rate, a person who may open **Tariffs** also finds the link **Set a rate in
    Tariffs** next to that line. A total appears only when every bucket has a value, and it carries `~` or `*` when any bucket does; a cost whose highest
    hour cannot be named because some hours have no rate shows "— unpriced hours" instead of a number. There is no average over the buckets,
    because buckets hold different numbers of readings and it would not be exact.
  - **Download CSV** at the foot of the panel: the same export as the card's CSV button.

  A chart is also a labelled picture for a screen reader: its name gives the kind, the assets, the metric and unit and the window, and
  points to Details for the figures. Hovering a chart shows the time and, per asset, the figure with its unit and the state in words
  (estimated, partial, no rate) beside its `~` or `*`. On a bar chart of one figure per asset every asset's name stands under its bar (also
  the asset that has no data, whose slot stays empty): wrapped over up to three lines when the card is wide enough for that, turned at an
  angle when it is not, and cut in the middle with an ellipsis when it is still too long; the full name is in the tooltip and in Details.
- **Legend.** A chart with more than one asset has a legend. Clicking an entry hides or shows that asset: its line and, in a metric time
  series, its min-max band go together. The choice is kept for that asset while the chart refreshes (every 30 seconds), also when a
  `~` or `*` appears on or leaves its name; it is forgotten when you leave the dashboard, and if every asset is switched off the next
  refresh shows them all again. The legend is part of the chart picture and is not reachable with the keyboard: the same names and figures are in
  Details.
- **Editing.** **Edit** (operators and admins) opens the grid editor: drag a widget by its title bar, resize it from the corner or the
  edges, **Add widget**, then **Save**, which stores the whole dashboard in one step. While you edit, a card shows a grip, an Edit
  (pencil) and a Delete (trash) button in its title bar in place of the Details and CSV buttons, and its figures do not follow the
  live stream. The **Preview** in the widget form is the same card a dashboard draws for the same settings, without the Details and
  CSV buttons. Widgets always close up vertically (there are no
  gaps), in the editor and in the view alike: dropping a widget on an occupied place moves the others down only as far as needed, and a
  dashboard saved earlier with gaps is shown closed up without being rewritten until someone changes it and saves. If someone else saved
  first you are told, nothing is overwritten, and you can reload their version. Leaving the editor from inside the app, or closing the
  page, asks first when something is unsaved; a session that expires while you edit does not: the app signs you out and the unsaved
  edits are dropped without a prompt.
- **Missing data.** A widget whose asset was deleted shows an "N assets removed" chip in its title bar and draws the rest; assets that
  exist but have no reading of the widget's metric are counted the same way ("N assets without this metric"). On a card narrower than
  about 280 px a chip shows only its count (the words stay for a screen reader), and Details lists what was left out. A metric with no
  reading in the range says "no data" (the dash is only for a missing rate). A cost with no rate shows the dash, never zero, in every
  kind of widget that can show a cost (stat, table, bar chart and time series; a gauge is always a metric); in a chart the dash is in
  the tooltip and, in a bar chart, in the place the bar would be, and in a grouped bar chart that place is the asset's own among the
  bars. The line under the card says "— no rate" for all of them, next to the other markers it explains (`~ estimated`, `* partial,
  some hours have no rate`), and for energy and cost on a rolling range it also starts with the window really covered ("since 10:00").
  That line is the same on every widget type, whether or not the chart's legend is on.
- **CSV.** Every widget in a dashboard has a CSV button in its title bar, and the Details panel has the same one as **Download CSV**
  at its foot: UTF-8 with a byte-order mark, times in the site timezone with their offset, columns
  `asset,source,unit,timestamp,value,estimated,partial,no_data`. Text starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a
  leading apostrophe so that spreadsheets do not run it as a formula. On a card narrower than about 200 px the title bar has no room
  for the CSV button, so it moves into Details.

## The default dashboard

The default dashboard is one dashboard an admin picks in the Dashboards list (the `⋯` menu of a row: **Make default**, or **Clear
default** on the one that is). It carries a `Default` badge. The sidebar's Dashboards entry then opens it directly and so does the
first page after signing in (a page you were sent away from when your session expired still wins; a deliberate sign-out forgets the
page, so signing in again lands on the default). The list of all dashboards stays one click away: the **Dashboards** crumb above the
dashboard, or the Quick find entry. With no default set, the entry opens the list and the first page is Assets Tree.

Deleting the default dashboard clears the choice (the audit row says so); choosing, switching and clearing it are audited as
`dashboard.default_changed`. An open page learns of a change within a minute or when you return to its window.

**Make default** works on a Power dashboard ([The Power starter](#dashboards)) like on any other, and the default always opens on the
whole site, with no focus (the sidebar and the first page after signing in open it without `?asset`).

## Billing

Billing shows one month at a time: previous and next month, or the Year and Month selects beside them to jump straight to a month (the
years start at the first month with energy data; the current month by default). It shows the asset tree by day: kWh above, cost below,
then the month total and the rate in effect.

- `~` marks a figure estimated from power and `*` a partial cost (some energy in the period had no rate).
- A dash means one thing: there is no rate for that cost. A missing rate is never shown as zero.
- An empty cell is an asset without a meter, or a day that has not been reached yet.
- A shaded cell with `0.0` kWh and a `0.00` cost (a dash when no rate applies), titled "no data", is a day with no data: its zero is
  not a measurement.
- The CSV button exports one row per asset per day (`asset,date,kwh,cost,currency,estimated,partial,no_data`).
- A month an administrator has **closed** shows a **Closed** chip beside its name and a banner; its figures no longer follow the tree
  or the rates. See [Closing a month](#closing-a-month).
- **Check month** (header button, with a count) lists what to look at in the month's readings before it is trusted or closed. See
  [Checking a month](#checking-a-month).

The asset page shows today's cost next to today's energy.

### Big months

A data centre has hundreds of assets, so Billing lets you fold the rows, filter them and keep the day numbers in sight. None of it
changes a figure, a marker, a rate, a total or the CSV.

- **Fold.** A row with assets below it has a small arrow in its name cell; the arrow's name is, for example, "Collapse Hall 1, 181 rows
  below" (or "Expand Hall 1, 181 rows below" when the row is folded; 181 is the demo hall's Hall 1). A folded row still shows its own rate, month total and day figures,
  which already include everything below it, so folding hides detail and never a total. **Collapse all** folds everything into the top
  row, **Expand all** opens everything, and **Show levels** (1 up to the deepest level, then All) shows that many levels: level 1 is the top
  row alone, level 2 adds the rows directly below it, and so on. It reads "Custom" while the fold you made matches no level. The `?` beside
  it says the same thing about totals.
- **How many rows are on screen.** A line at the right of the table's first row, opposite the sentence that explains the cells, says
  "All 370 rows shown", or "Showing 24 of 370 rows" while something is folded, or "12 of 370 rows match" while you filter ("No rows
  match" when nothing does). It stays at the right edge of the table when you scroll the days sideways, and it scrolls up out of sight
  with that first row when you scroll the rows down (a new filter brings the table back to the top).
- **One row of controls on a wide window.** The month controls (Previous month, Next month, Year, Month) and the table controls
  (filter box, Collapse all, Expand all, Show levels) share one row when the page is about 1,600 px wide or more (a screen that shows 1,920 px, a 1,920 px display at 100 percent scaling, with
  the sidebar open, or about 1,700 px with the sidebar minimised; a laptop at 125 percent scaling shows 1,536 px and keeps the two rows); on a narrower page the table controls sit on their own row under the month
  controls, as before. The table is taller by the row that goes.
- **The filter box (Filter by asset name).** Type part of an asset name: the table shows every row whose name contains it (capital letters do not matter; only
  the name is searched, not the path), each with the rows above it so the indent still reads as a tree. Rows below a match that do not
  match themselves are left out. The filter ignores the fold, and when you clear it (the **Clear filter** button in the box, or Escape
  while you are in it) the fold you had comes back. Collapse all, Expand all and Show levels are greyed out while the box has text. The
  filter is not remembered.
- **Opening folded.** A month with more than 60 rows opens folded to the deepest level that keeps 60 rows or fewer; with the demo hall of
  370 assets that is level 4, 24 rows. A month with 60 rows or fewer opens fully open, as before.
- **What is remembered.** The first time you fold or unfold something, the fold is remembered in this browser, for this site address (it
  is not per month, so paging to another month keeps it, and not per account). Just visiting remembers nothing, so the size rule above
  keeps applying until you change something; from then on every month opens the way you left it. Expand all is remembered as "nothing
  folded" (the stored text is `none`): every month then opens fully open. The fold is not shared between browsers or with other people.
- **A header that stays.** The table scrolls inside its own box, so the header row with the day numbers stays at the top while the rows
  scroll, and the first column (the asset names) stays while the days scroll sideways. On a window less than 560 px high the whole page
  scrolls instead.
- **Keyboard.** Tab goes to the filter, then Clear filter (only while there is text), Collapse all, Expand all, Show levels and its `?`,
  then to the arrow of each row that has rows below it (rows without any have none; while you filter the rows have no arrows); Enter or
  Space folds or unfolds, and the focus stays on that arrow. Escape in the filter clears it.
- **A closed month** folds and filters the same way; the stored figures are never touched.
- **The CSV** always has every asset and every day, whatever is folded or filtered.

Try it with the demo hall ([The pilot hall](developing.md#the-pilot-hall-a-demo-tree-with-racks)): open Billing and choose Show levels 5
(the 141 rows down to the racks); scroll down and watch the day numbers stay at the top. Then type Rack 01 in the filter box (Filter by asset name): the racks
with that name show, each under its hall, pod and row. Press Escape and the level you chose is back.

## Closing a month

Until a month is closed it is recalculated on every request from today's tree, mappings and rates, so moving an asset or editing a
rate changes it ([How history is calculated](#how-history-is-calculated)). Once the bill for a finished month is out, an administrator
can **close** it: the Billing page stores the figures it shows for that month and from then on shows those. Before you close, look at
**Check month** ([Checking a month](#checking-a-month)); it lists what the month's readings leave open, and it never blocks the close.

- **What it freezes.** The Billing page and the Billing CSV of that month, exactly as they showed at the moment of closing, for every
  asset and every day (the hierarchy, names, paths, kWh, cost, the `~` and `*` marks, the currency and the time zone of that moment).
  It does not freeze dashboards and widgets: they stay live and keep following the tree and the rates.
- **Who may.** Closing and reopening need `billing.close`, a sensitive permission that only the Admin role holds by default; nobody else
  has it after an upgrade. An administrator can tick it on a role of their own (it needs See billing). See
  [Roles and permissions](roles-and-permissions.md). Both actions are audited (`billing.closed` and `billing.reopened`, with the month,
  the totals and the note; the entry links to Billing).
- **Which months.** A finished month that has data: it has ended in the site time zone, and at least one asset has a day with recorded
  data. For a person with `billing.close`, **Close month…** sits in the page header, left of **Download CSV**, on every month before
  the current one that is open. The server is the judge: it refuses a month that is not over yet ("that month is not over yet"), a month
  with no data ("no energy data was recorded for that month") and a month that is already closed ("that month is already closed by
  <name> on <date>"), and the refusal appears inside the dialog. The dialog, **Close <Month Year>**, explains that later changes to
  assets, mappings or rates will not change the figures and takes an optional note of up to 500 characters; its button reads **Close
  month**. The note box is at least four lines tall and at most twelve (or 40 percent of the window, whichever is less): you can drag
  it taller or shorter inside those limits, and a longer note scrolls inside it (the Reopen dialog's reason box is the same). Closing
  takes a few seconds.
- **What a closed month shows.** The **Closed** chip beside the month name and a banner above the table, "Closed by <name> on Thu 15 Oct
  2026." (the date is the site's calendar date; the note, if any, is on the next line). The table is the stored one. A quiet line
  under the banner is always there on a closed month, so the table does not move when it changes: when today's tree and rates would
  give other figures it says so, for example "Today's tree and rates would give 1234.50 USD (+12.50), 3 assets differ."; it also
  notices assets with figures that moved or whose own figures differ when the total is the same ("Today's tree and rates give the same total, but
  3 assets differ."); when nothing differs it reads "Today's tree and rates give the same figures."; and when today's tree cannot be
  priced right now it stays empty (it never claims "the same" then). If the site's currency changed after the close, the line gives
  today's total in both currencies and no signed change ("Today's tree and rates would give 1234.50 EUR (closed in USD)"), because the
  two amounts are in different units; a closed month keeps the currency it was closed in. The line tells you that
  something changed since the bill; it does not change the bill. If some consumption has no rate, the usual notice says that this
  month is closed, so a rate set now changes it only if the month is reopened. The CSV of a closed month is the file the month had when
  it was closed, named `billing-YYYY-MM-closed.csv` (an open month's is `billing-YYYY-MM.csv`). The name of the person who closed it
  stays even if their account is deleted.
- **Reopening.** On a closed month **Reopen month…** (with `billing.close`) takes the place of Close month…. Its dialog, **Reopen <Month
  Year>**, asks for a **Reason** of 5 to 500 characters (a live count such as 4/5; past 500 it reads, for example,
  501/500 in red and the button waits); its button reads **Reopen month**. Before you click, the dialog tells you that the page will
  show today's figures again, that the closed figures stay stored but the app does not show them once the month is reopened (so
  **download the CSV first** if you need them), and, when today's figures are not the billed ones, by how far (the same sentence as
  the line under the banner; "Today's tree and rates cannot be priced right now." when they cannot be priced). The month then shows
  live figures again at once. The old snapshot stays in the database, with who reopened it and why, but the app shows it nowhere;
  closing the month again freezes today's figures as a new record (if its data is gone, for example a deleted source, the month stays reachable but cannot be closed again).
- **What changes a closed month: nothing.** Moving assets, mapping or unmapping points, editing or deleting tariffs, changing a
  mapping's scale, and deleting assets or sources do not change it; the move and delete warnings now say that closed
  months keep their billed figures. Readings that reach the database late do not change it either; they only show up in the "Today's tree and rates would
  give" line. A closed month stays reachable from **Previous month** and the Year and Month selects even after its meters are replaced
  or its source is deleted: the first month the selects offer is the first month with data or the first month that was ever closed (also after a reopen), whichever is
  earlier. There is no list of closed months yet: open a month and look for the chip.
- **Removing assets or sources, and the readings.** A month that is not closed is worked out from today's tree and mappings, so removing
  assets (or the source that feeds them) takes their figures out of every month that is not closed, and out of the dashboards; a closed
  month keeps what it billed. When a removal takes mappings with it, its confirmation says so in a paragraph of its own, under the
  sentence with the counts: *Months that are not closed follow today's assets, so they lose these figures. To keep a finished month's
  bill, close that month before you delete. The meter readings themselves stay stored: map the same points to an asset again and those
  months get their figures back.* A source's note differs in one fact: a source's points go with it, so its figures cannot be mapped
  back (the stored readings stay on disk, and the retention limits on the Storage page trim the detailed ones in time). Only a finished
  month can be closed, so the current month always follows the tree. No removal ever deletes readings (the table has no link to assets
  or points), which is why the database does not shrink after you remove assets: retention drops the raw and 1-minute readings when
  their days are up ([Storage](storage.md)).
- **Size.** A snapshot holds every asset and every day of the month as JSON: about 5 MB for a big site (2,000 assets, 31 days),
  stored once per close and compressed by the database. There is no cap, and a reopened snapshot stays in the database.

Limits of closing:

- There is **one cost engine**. A snapshot is what the engine gave at that moment, with every limit of
  [The energy engine](#the-energy-engine) (an estimate stays an estimate, an hour with no rate stays unpriced); closing does not make a
  figure a measurement or an invoice.
- A close reads the tree, the energy and the rates one after the other, in a few seconds. An edit that lands in that moment can be half
  in the snapshot; reopen and close again if you suspect it.
- A closed month's JSON from the API holds the same data as the open month's (the field order may differ); its CSV is identical byte
  for byte to the open month's CSV taken at the same moment.
- **A restore of an older backup brings back the older set of closed months** (a month closed since is open again, one reopened since
  is closed again). Going back to a release older than the one with migration `0012` drops the closed months altogether. See
  [Backup and restore](backup-and-restore.md) and [Migrations in order](upgrading.md#migrations-in-order); take the CSV of every
  closed month before going back if you need them.
- A closed month keeps the time zone and the currency it was closed in; changing them in Settings or on the Tariffs page later
  relabels or re-cuts only the months that are not closed.

## Checking a month

**Check month** is a list of things to look at before a month is trusted or closed. It reads the same hourly readings that Billing
uses and says where they are missing, thin or odd, and what each of those does to the figures. It only reads: it never blocks **Close
month…**, changes no figure, marker, rate or CSV, and writes nothing (not even an audit row). It does not certify a month. The headline
**Nothing to check** says only that the rules below found nothing in the readings; it never says that the figures are right.

- **Where it is.** A **Check month** button sits in the Billing page header, between **Close month…** (or **Reopen month…**) and
  **Download CSV**, with a count beside it: the number of things to check (`99+` above 99), a muted `0` when meters were looked at and
  nothing was found, and nothing at all while the answer is being read, if it failed, or when nothing was looked at. The button opens a
  drawer with the whole list. The **Close month** dialog repeats the answer in one line ("Month check: 3 things to check (see Check
  month on the page).", or "... nothing to check ...", or "... not read yet ..."); closing works exactly as before.
- **Who sees it.** Everyone who can open Billing (`billing.view`). The name of the point and of its source ("Reads <point>
  (<source>)") appears only for a person who also holds `sources.view`; a point's address, a source's URL and its credentials are never
  sent.
- **The headline.** `N things to check` when there is anything to look at (one thing is one meter and one kind of finding, so a meter
  with a gap and a reset is two). Otherwise `Nothing to look at yet` when nothing could be read (the month has not begun, its first hour
  is not over, no meter recorded anything in it, or no asset has a meter mapped at all; the line under it says which), and only then
  `Nothing to check`. A month in which every meter is silent therefore says `N things to check`, never `Nothing to check`. Under the
  headline the drawer says what it looked at, for example "Looked at 217 meters over 720 hours (156,240 meter hours in all), from
  2026-09-01 00:00 to 2026-10-01 00:00. Only the hourly readings that billing uses were read, so this check cannot see every kind of
  fault." The meter hours are the hours expected of each meter added up (217 meters times 720 hours), whether or not each of those
  hours has a reading: the missing ones are the findings below. Times are in the site time zone.
- **What it looks at.** Every asset that has a meter of its own: an energy counter (`energy_kwh`), or, when it has none, a power meter
  (`active_power_kw`, called a power-only meter below). A parent is not repeated: what its children add up to is not checked again.
  It looks at the whole hours of the month, and for a month that is still running up to the last full hour (the hour in progress is
  left out; the drawer says so). A meter is expected to have a reading in every hour from its first reading on; a meter that never
  recorded anything is expected in every hour of the month. It sees only good readings.
- **A closed month.** The check describes the readings as they are stored today, not the frozen figures, and the drawer says so. Unlike
  the frozen figures, it needs a usable site time zone: the API answers 409 for a zone without a whole-hour offset, with the words
  Billing uses.

The findings, worst first inside each list:

1. **Meters with no readings.** A meter that never recorded anything; one that recorded nothing in this month (the last reading before
   it is named); or one that went silent: the last hours looked at have no reading, and the item says since when. A silent meter on an
   asset with assets under it bills 0 for those hours whatever its children read, so their energy is missing from that asset's figure
   (the item says how many assets are under it). A meter that never recorded, or recorded nothing this month, counts as 0 kWh for the
   month. A counter's energy is not lost, though, when it recorded before: for one that went silent, or that recorded nothing this month
   but did before it, the energy is counted in the hour readings return, which is in a later month if they return after this one ends
   (the item says so); a power-only meter's silent time counts as 0 kWh.
2. **Gaps in the readings.** Whole hours in a row without any reading.
   - **Counter.** A counter polled faster than once an hour tolerates none: any empty hour is a gap. A counter polled once an hour or
     slower leaves empty hours by design, so it tolerates `ceil(interval / 3600)` hours in a row, at most 24 (a counter read every
     7,200 s tolerates 2). The same tolerance applies to the end of the month before a counter counts as silent. The energy of a gap
     is not lost: it is counted in the hour the readings return. A gap at the start of the month brings energy used before the month
     into it, and a gap that runs past the end of the month moves energy into the next month.
   - **The hole before the month.** A counter's first reading of the month is measured from its last reading before the month,
     however old that is. When the hours without a reading between the two, plus any empty hours at the start of the month, are more
     than the tolerance, the item says "The first reading of the month counts everything since <time>" and how many hours that is.
     Such a counter can be listed with no gap inside the month at all.
   - **Power-only meter.** It tolerates nothing: an hour without a reading, or a row with no samples, counts as no energy, that time
     counts as 0 kWh and the meter reads low by what it used then. It also lists partly covered hours, hours that have a row but whose
     samples cover less than the whole hour by the engine's own rule (a meter polled every 60 s or faster: the minutes that have a
     sample out of 60; a slower one: samples times interval out of 3,600 s). They are listed only when the missing time adds up to at
     least 60 minutes and at least one hundredth of the minutes looked at, so the ordinary drift of a polling loop does not list every
     meter, while one that loses a whole minute in every hour (1.7 percent) is listed. The missing part counts as 0 kWh.
3. **Estimated from power.** The rule, in one sentence: *An hour is marked estimated when the asset has no energy (kWh) counter, so its
   energy is worked out from average power (kW) readings; anything that adds up estimated hours is marked estimated too.* Every
   power-only meter is listed (also a silent one, because Billing shows `~` for it), with the hours estimated out of the hours looked at.
   The parents that add these meters up show `~` on Billing too; the check lists the meters, not the parents. A **negative power
   reading** is named here: a transformer fitted the wrong way round gives negative kW, which makes negative kWh and lowers the asset's
   figure and the figures above it; the item gives the hours and the kWh. A counter cannot do this.
4. **Counter went back or dipped.** A counter should only count up. Three cases, each with the full count and the first five times, with
   how far the reading went down in the meter's own units:
   - **Reset**: an hour ends below the previous hour's last reading (a reset or a rollover). The hour is approximate: the engine counts
     the rise from the previous reading up to the hour's highest reading, plus the climb from its lowest reading to the last one; what
     happened in between is not counted.
   - **Dip**: the lowest reading of the hour went below the previous reading but the hour ended at or above it. The figure ignores the
     dip and counts the rise from the earlier reading.
   - **Fell**: neither of those, yet the hour's highest reading is above its last. A reading went down inside the hour; the hour is
     counted from its last reading.
5. **Started part way through the month.** The meter's first reading is after the first hour of the month. Before it, the asset counts
   what the assets under it add up to (nothing, when it has none); from then on its own meter. The hours before the first reading are
   not missing hours.
6. **Energy with no rate.** Hours of a meter's own energy above 0 with no rate on that local day, by the rule of
   [Which rate applies to a day](#which-rate-applies-to-a-day). The item gives the kWh, hours and days, and the first and last day.
   Those hours are in the kWh figures and not in the cost (Billing marks that cost `*`, or shows a dash when no rate applies at all).
7. **Readings that did not change.** A run of **24 hours** or more of clock time in which the reading stays exactly the same: for a
   counter, the hour's last reading equals the previous one (energy 0); for a power-only meter, every sample in the hour has one value
   and it is the same value all through the run. An hour with no reading between two equal ones does not break the run. A counter's run
   is counted from the end of the previous reading's hour, but not from before the month (a counter read every 7,200 s that stood
   still for 24 hours shows 24, not 23). It can mean a meter that stopped updating. A counter counts 0 kWh for that time; a power-only meter's energy is worked out as if
   the power had stayed the same.

Two lists are information only and are never counted in the number at the top:

- **Assets that nothing measures.** Assets with no assets under them, no meter of their own and no meter above them. No energy is
  counted for them. The ones whose parent is billed from other meters under it come first ("beside measured"): that figure leaves
  their power out. Only the direct parent is looked at, so the feeds of a free rack under a row billed from its other racks are not
  marked beside measured, although the row's figure lacks them too.
- **Meters that started later.** Meters whose first reading is at or after the end of what was looked at (after the month, or in
  the hour still running). They are not counted in "Looked at" either.

Limits, all stated by the API under `limits`:

- 24 hours for a run of unchanged readings; 60 minutes and one hundredth of the time looked at for a power-only meter's partly covered
  hours; a cap of 24 hours on the counter polling tolerance.
- 50 items per list. The list says how many more there are ("and 11 more"); the number at the top counts all of them. The first five
  reset, dip and fall times of a meter are listed.

### What the check cannot see

The check lists what the rules above find; the absence of a finding is not a statement about the figures. It cannot see:

- A counter that is reset and climbs back **past its earlier reading within one hour**. The hour looks like a normal rise and its
  figure is understated.
- A counter whose first reading ever **starts from a bad zero**: the hour counts the climb from that zero.
- A **huge torn reading** as the last sample of an hour: the hour is over-counted, and the check lists a reset in the next hour, not in
  the hour that was spoiled. A **jump that stays up** (readings rise normally, then are higher by a fixed amount from some hour on) is
  not seen at all: a counter must not go down, but it may go up by any amount.
- A counter that **stood still across a month boundary**. The 24 hours are counted inside each month, so 12 hours at the end of one
  month and 23 at the start of the next are listed in neither.
- A counter's **partly covered hour** is not listed, because it loses no energy inside the month (the hour counts the last reading
  minus the previous one). At the very end of a month up to 59 minutes of its energy can move into the next month.
- A slow counter's **tolerated empty hours at the end of a finished month**. A counter polled once an hour or slower may end the month
  with up to `ceil(interval / 3600)` empty hours (at most 24) and the check calls that normal, but the energy of those hours is counted
  in the next month, when the next reading arrives, with no finding.
- A power meter whose mapping states a **longer polling interval than the point really has**. The collector polls a point once for each
  source and interval, so a point mapped twice (for example kW at 1,800 s on the billed asset and at 60 s on another) is read about
  60 times an hour. The engine takes samples times the mapped interval out of 3,600 s as the part of the hour covered, so a few
  samples read as a fully covered hour and a long outage inside it is not listed as partly covered. The check follows the engine's
  rule, so Billing's figure has the same blind spot; the rollup's `minutes` column shows the hole.
- In the first hours of a month still running, a slow counter can read as **silent** before its first reading of the month has arrived.
- A reading the collector stores as **bad** (not a number, or infinite) is not in the hourly rollup at all: an hour made only of such
  readings is an hour with no row, and the check cannot tell it was ever there.
- The check **reads the hourly rollup only**. A reading that arrived later than the rollup refreshes (7 days) is not in it.

### How it is counted

For engineers. The check reads one row per meter and hour of `readings_1h` (the same rows as the energy engine, with the last row
before the month for every meter). Hours are UTC hours, which are the site's hours because the site time zone must have a whole-hour
offset. An open month is read up to the last full hour. The rules mirror `backend/dcdash/core/energy.py` and `core/cost.py`: the reset
and dip branches of `counter_hours`, the coverage rule of `power_hours`, the splice at a meter's first reading (`own_from`), and the rate
lookup `rate_at` by local date. The code is `backend/dcdash/core/month_check.py` (no database) and `backend/dcdash/api/billing_check.py`;
the route is `GET /api/billing/month-check?month=YYYY-MM` (`month` defaults to the current site month; 422 for a bad month, 409 for an
unusable time zone, both with the words of `/api/billing/costs`). Its gate is `billing.view`. It has no migration, writes nothing and
touches none of the engine's files.

## Tariffs

An administrator sets the tariffs (`tariffs.edit`); an Operator may read them. They hold:

- **The site currency**: one three-letter code for the whole site; when it is unset, costs show without a unit. Changing or clearing
  the currency asks for confirmation: it relabels every past figure of a month that is not closed and converts nothing (a closed
  month keeps the label it was closed with).
- **The rates**, in that currency per kWh: the site default and per-asset overrides. A rate is a number of zero or more, at most
  1,000,000, with up to six decimals, and an effective date (a date in the site timezone, not a time). Two rates for the same asset (or
  two site defaults) cannot start on the same date (409).

An override on an asset applies to that asset and everything under it, unless a lower asset has its own. Which rate prices a given day
is set out in [Which rate applies to a day](#which-rate-applies-to-a-day). Give a new rate the date of the day it should start.

Editing or deleting a past rate recalculates every month that is not closed; a closed month keeps its billed figures (see
[Closing a month](#closing-a-month)). Cost is for visibility, not invoicing. Tariff, currency and dashboard changes appear in the Audit
log; an update shows the values before and after.

## Which rate applies to a day

Cost is not stored: it is worked out on every request from the hourly energy, today's asset tree and the tariff table
(`backend/dcdash/core/cost.py`). The one exception is a month that has been [closed](#closing-a-month), which shows the figures stored
when it was closed; everything below is about a month that is not closed. Three rules follow from that.

**1. A rate is chosen once per asset per local day.** For an asset with its own meter, `cost_by_hour` asks `rate_at` for the rate of
each hour's date in the site timezone, and a tariff's `effective_from` is a date. So:

- a rate that starts on a date prices all 24 hours of that day, including the hours before you entered it;
- a move into a place whose rate is in effect that day re-prices the whole day, including the hours before the move;
- nothing is split inside a day.

A parent without a meter of its own has no rate: its cost is the sum of its children's priced hours.

**2. The tree and the mappings are not dated.** Every past day is priced against today's tree. For each day, `rate_at` takes the asset
itself or the nearest asset above it that has a rate in effect on that day (the latest one that started on or before it), else the
site default, else no rate. That means:

- a room's override applies only from its own effective date; earlier days fall through to the next asset above that has a rate in
  effect, and then to the site default;
- an old room's override stops applying, on every day, to an asset that left the room;
- a move re-evaluates every past day, and a day changes only if the rate the new place gives on that day differs from the one the old
  place gave (so after a move from a place on the site rate into a room whose override starts today, the earlier days stay as they were);
- the asset's energy goes with it, so the energy and cost totals of both places (and of the assets above them) change for every past
  day, whether or not the rate changed. The exception is a place with its own meter: from that meter's first reading on, its figures come
  from the meter, so moving an asset in or out does not change them.

**3. The practical rule.** Make rate changes and moves at a day boundary, and give a new rate the date of the day it should start. Past
figures of a month that is not closed always follow today's configuration. When the month's bill is out, **close** it
([Closing a month](#closing-a-month)): from then on its figures stay as billed, whatever you move or edit.

**Worked example: moving an asset into another room.** The owner's test on the development stack: after a move to a dearer room the
five earlier days did not change, and today's whole day did. The table shows the general cases for the moved asset's own past days.

| Before the move, the asset's rate came from | The new room's rate | The asset's past days |
|---|---|---|
| the site default | an override that starts on or after the move date | unchanged, as long as no asset above the new room has a rate in effect on those days; from the override's date on, the days are priced at it (when it starts on the move day, that whole day, all 24 hours) |
| the site default, or an asset above the old room | an override already in effect on past days | each day on which that override is in effect is re-priced at it (a rate on the moved asset itself, or on an asset between it and that room, still wins on the days it is in effect) |
| an override on the old room | any | the old override no longer applies: each past day falls back to what the new place's chain gives (the new room's rate where it is in effect, else an asset above it, else the site default) |

The Assets Tree warns before a move that changes a rate; see [Moving assets](assets-and-kinds.md#moving-assets).

## The energy engine

One engine produces every energy figure (asset page, Billing, dashboards), so they agree. It reads the hourly rollup (`readings_1h`)
and works in whole hours; a day or a month is the sum of its hours in the site timezone.

- For an asset with an `energy_kwh` counter, an hour's energy is the hour's last counter value minus the previous hour's; the first hour
  of a period starts from the last value before it, and a counter reset or rollover is recovered instead of counted as negative or
  inflated energy.
- An asset with only `active_power_kw` gets average power times the time its samples cover, so an outage adds nothing; such figures are
  marked `~` (estimated) wherever they appear.
- A parent asset uses its own meter if it has one, otherwise the sum of its children; a meter with no readings at all counts as 0, and
  an asset with no energy or power mapping anywhere beneath it has no figure.
- **Check month** reads the same hourly rows and mirrors these rules without changing them; see [Checking a month](#checking-a-month).
- **One shared read per window, kept for 30 seconds.** Billing, a month's comparison, a closed month's live line and the plain value
  widgets (a stat, a gauge, a table, a breakdown) do not read the rollup once per card. The server reads a window once, in one
  consistent snapshot, with this same engine, keeps a compact result (every asset's day figures for a month, or every asset's value for
  a window) and gives it to every card that asks for the same window. The figures are exactly the ones the engine always gave: the same
  maths in the same order. A change of configuration (a rename or move that changes the order, a scale, a mapping, a tariff, the zone)
  shows at once; new readings, a seed, a restore or a manual rollup refresh show within 30 seconds; closing a month always checks again
  first. The memory belongs to one api process and is empty after a restart. `DCDASH_FIGURE_CACHE=0` turns it off and
  `DCDASH_FIGURE_CACHE_TTL` sets the seconds. The maths runs on one worker thread and the rows are read in chunks, so a slow dashboard
  does not make the other pages wait.

### The figure ledger

A background service, `figures`, keeps each month's figures ready in the database table `figure_ledger`. It makes them with the very
code a live request runs, and after an api restart the api reads them instead of computing them again. A stored figure is used only
when it is provably current:

- The configuration (tree, meters, tariffs, zone) and the code must be the same as when it was made.
- For a month that ended more than a week ago the readings must be exactly the same too.
- For the current month and the first week of the next, a figure may be up to 60 seconds behind the readings in all (the cache's own
  30 seconds included, not on top of them).

Closing a month and Check month always check on the spot: a close never uses a stored figure, and never trusts a cache entry that came
from one: it computes from the readings. Check month uses its stored report only when the readings and the configuration it reads are
exactly the same as now. If anything is in doubt the page computes the figure as before, only slower. The service is described in
[Operating the stack](operating.md#the-figures-service). `DCDASH_FIGURE_LEDGER` set to `0`, `false`, `off` or `no` (any case)
switches the ledger off; anything else, also empty, leaves it on. `DCDASH_FIGURE_CACHE=0` switches the whole figure cache off, and
the ledger with it.

## How history is calculated

Dashboards, and Billing for every month that is not closed, follow the current configuration: past months are recomputed from today's
mappings, scale factors, asset tree, tariffs and site timezone. Re-pointing a panel to another source, changing a scale or the timezone,
moving an asset or deleting one therefore changes past figures. A month an administrator has [closed](#closing-a-month) is the
exception on the Billing page and in its CSV: it keeps its billed figures, while the dashboards' widgets still follow the
configuration for that month too. Deleting an asset that has children, mappings or tariffs, or a source with mapped points, asks for
confirmation and is audited.

A parent's own meter counts from its first reading (the hours before it are the sum of its children, so adding a meter later does not
zero the past), and the estimate for an asset with only a power reading covers the minutes in which it has samples. A day with no data
shows its energy as zero (`0.0` kWh in Billing cells, `0.00` in a widget), muted and titled "no data" (a rate in effect makes its cost
`0.00`, otherwise the cost is a dash).

The hourly rollup is the only permanent copy of this data, so back it up (see [Backup and restore](backup-and-restore.md)).

## Asset names and scales

Within one parent (the top level counts as one) two assets cannot have the same name; case and spacing do not make a different name
("Panel A" and " panel  a " are the same). Creating, renaming, moving and Discovery's "new asset" are refused with a 409 that names the
clash. Twins created before the rule stay as they are and can still be edited while their name and parent stay.

A mapping's scale must be above 0 and at most 1e12; a reading that is NaN or infinite is stored with bad quality and never reaches
Billing.

## Limits

- The site timezone must have a whole-hour UTC offset in both January and July (so that day and month edges fall on hourly buckets);
  Settings refuses other zones, and Billing and widget data answer 409 if a stored zone breaks the rule.
- The rollups refresh over the last 7 days, so readings that arrive later than that are not included in energy figures.
- A figure on a dashboard or in Billing can be up to 30 seconds behind the newest readings (a configuration change shows at once). The
  first load after an api restart, or of a window nobody asked for lately, computes it once, which takes seconds on a big site;
  `python -m dcdash.diagnostics.speed` shows how long.
- After an api restart, or when the api has not been asked for that window for a while, a figure may step back by up to 60 seconds: it
  comes from the ledger, which can be that far behind the readings. The ledger keeps the 6 newest months (`DCDASH_FIGURES_MONTHS`); an
  older month is computed live. Rolling windows (1 hour to 30 days), plain time-series charts and the asset and fleet summary do not
  use it; the month comparison's chart does (it reads the month's day figures).
- One counter reset per hour is recovered exactly; a second one inside the same hour may understate that hour.
- Energy estimated from power is an estimate, not a measurement.
- The currency is one per site, there are no time-of-use tariffs, and custom metrics cannot be used in widgets.
- A text widget is plain text: a heading holds 200 characters on one line, a paragraph 2,000 (Unicode code points), and a dashboard
  holds 24 widgets of any type, text included.
- A comparison is month to date only. It does not include today so far, draw the whole of last month as a faint line or give per-day
  averages; a stat compares one measure (two stats give kWh and cost); it compares one asset; and a plain **Last month** widget still
  reads live figures for a closed month (see **Comparing with last month**).
- A breakdown by kind assumes one measured level (meter roles do not exist yet), and a click on a bar goes nowhere yet (no
  drill-through). The focus asset and the starter dashboard come later.
- A widget's Details panel says only what the widget's own answer proves. It does not show the source point's address, how many
  readings a figure rests on or alarm limits, nor the width of a time series bucket, nor an average over buckets.
- Closing a month has limits of its own (one snapshot per close, what a restore does to closed months, a close that lands during an
  edit): see [Closing a month](#closing-a-month).
- Check month lists what its rules find and certifies nothing; what it cannot see is in
  [What the check cannot see](#what-the-check-cannot-see).

Related: [Screens](screens.md), [Roles and permissions](roles-and-permissions.md), [Assets and kinds](assets-and-kinds.md), [Storage](storage.md)
