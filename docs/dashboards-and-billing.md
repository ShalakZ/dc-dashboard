# Dashboards and billing

This page is for the people who build dashboards, read the monthly energy and cost report and set the tariffs, and for anyone who has to
explain a cost figure. It covers the dashboards and their widgets, the default dashboard, the Billing page, tariffs, which rate applies
to a day, how energy and history are calculated, how a finished month is closed so that it stops changing, and the limits of all of it.

## Who may do what

Roles are enforced by the API; the screens only hide what you cannot use. The table is the three built-in roles; see
[Roles and permissions](roles-and-permissions.md) for what each permission allows and for making a role of your own.

| | Viewer | Operator | Admin |
|---|---|---|---|
| Open dashboards and Billing, export CSV | yes | yes | yes |
| Close and reopen a billing month (`billing.close`, [Closing a month](#closing-a-month)) | no | no | yes |
| Create, edit and delete dashboards | no | yes | yes |
| Choose the default dashboard (Dashboards list, row menu) | no | no | yes |
| Read tariffs and the currency (Tariffs screen, read-only for an Operator) | no | yes | yes |
| Set tariffs and the currency (Tariffs screen) | no | no | yes |

## Dashboards

Dashboards are shared by everyone.

- **Size.** A dashboard holds up to 24 widgets, and the site up to 50 dashboards. A dashboard name is 1 to 100 characters (spaces at
  the ends are trimmed) and unique: a name already in use is refused with a 409. A widget title is at most 100 characters.
- **Widgets.** Five types: time series, bar, stat, gauge and table. A widget shows a metric, energy or cost for up to 20 assets (a stat
  or a gauge shows one). A metric widget offers only assets that have a mapping for that metric. Custom metrics are not available in
  widgets; they stay on the asset page.
- **Time ranges.** A dashboard has one time range and a widget may override it. The ranges are the rolling `1h`, `6h`, `24h`, `7d`,
  `30d` and the calendar `today`, `yesterday`, `this_month`, `last_month` (in the site timezone); there are no custom date ranges, and
  changing the range on the page affects that visit only.
- **Live values.** Stat and gauge widgets that show the latest value follow the live stream while their range ends now (the rolling
  ranges, `today` and `this_month`; not `yesterday` or `last_month`); every widget also refreshes every 30 seconds.
- **Editing.** **Edit** (operators and admins) opens the grid editor: drag a widget by its title bar, resize it from the corner or the
  edges, **Add widget**, then **Save**, which stores the whole dashboard in one step. Widgets always close up vertically (there are no
  gaps), in the editor and in the view alike: dropping a widget on an occupied place moves the others down only as far as needed, and a
  dashboard saved earlier with gaps is shown closed up without being rewritten until someone changes it and saves. If someone else saved
  first you are told, nothing is overwritten, and you can reload their version. Leaving the editor from inside the app, or closing the
  page, asks first when something is unsaved; a session that expires while you edit does not: the app signs you out and the unsaved
  edits are dropped without a prompt.
- **Missing data.** A widget whose asset was deleted shows "N assets removed" and draws the rest. A metric with no reading in the range
  says "no data" (the dash is only for a missing rate), and a cost chart with unpriced buckets says "— no rate" under its title.
- **CSV.** Every widget has a CSV button: UTF-8 with a byte-order mark, times in the site timezone with their offset, columns
  `asset,source,unit,timestamp,value,estimated,partial,no_data`. Text starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a
  leading apostrophe so that spreadsheets do not run it as a formula.

## The default dashboard

The default dashboard is one dashboard an admin picks in the Dashboards list (the `⋯` menu of a row: **Make default**, or **Clear
default** on the one that is). It carries a `Default` badge. The sidebar's Dashboards entry then opens it directly and so does the
first page after signing in (a page you were sent away from when your session expired still wins; a deliberate sign-out forgets the
page, so signing in again lands on the default). The list of all dashboards stays one click away: the **Dashboards** crumb above the
dashboard, or the Quick find entry. With no default set, the entry opens the list and the first page is Assets Tree.

Deleting the default dashboard clears the choice (the audit row says so); choosing, switching and clearing it are audited as
`dashboard.default_changed`. An open page learns of a change within a minute or when you return to its window.

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

The asset page shows today's cost next to today's energy.

## Closing a month

Until a month is closed it is recalculated on every request from today's tree, mappings and rates, so moving an asset or editing a
rate changes it ([How history is calculated](#how-history-is-calculated)). Once the bill for a finished month is out, an administrator
can **close** it: the Billing page stores the figures it shows for that month and from then on shows those.

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
  month**. Closing takes a few seconds.
- **What a closed month shows.** The **Closed** chip beside the month name and a banner above the table, "Closed by <name> on Thu 15 Oct
  2026." (the date is the site's calendar date; the note, if any, is on the next line). The table is the stored one. A quiet line
  under the banner is always there on a closed month, so the table does not move when it changes: when today's tree and rates would
  give other figures it says so, for example "Today's tree and rates would give 1234.50 USD (+12.50), 3 assets differ."; it also
  notices assets that moved or whose own figures differ when the total is the same ("Today's tree and rates give the same total, but
  3 assets differ."); when nothing differs it reads "Today's tree and rates give the same figures."; and when today's tree cannot be
  priced right now it stays empty (it never claims "the same" then). If the site's currency changed after the close, the line gives
  today's total in both currencies and no signed change ("Today's tree and rates would give 1234.50 EUR (closed in USD)"), because the
  two amounts are in different units; a closed month keeps the currency it was closed in. The line tells you that
  something changed since the bill; it does not change the bill. If some consumption has no rate, the usual notice says that this
  month is closed, so a rate set now changes it only if the month is reopened. The CSV of a closed month is the file the month had when
  it was closed, named `billing-YYYY-MM-closed.csv` (an open month's is `billing-YYYY-MM.csv`). The name of the person who closed it
  stays even if their account is deleted.
- **Reopening.** On a closed month **Reopen month…** (with `billing.close`) takes the place of Close month…. Its dialog, **Reopen <Month
  Year>**, asks for a **Reason** of 5 to 500 characters (a live count shows how many are still needed; past 500 it reads, for example,
  501/500 in red and the button waits); its button reads **Reopen month**. Before you click, the dialog tells you that the page will
  show today's figures again, that the closed figures stay stored but the app does not show them once the month is reopened (so
  **download the CSV first** if you need them), and, when today's figures are not the billed ones, by how far (the same sentence as
  the line under the banner; "Today's tree and rates cannot be priced right now." when they cannot be priced). The month then shows
  live figures again at once. The old snapshot stays in the database, with who reopened it and why, but the app shows it nowhere;
  closing the month again freezes today's figures as a new record.
- **What changes a closed month: nothing.** Moving assets, mapping or unmapping points, editing or deleting tariffs, changing a
  mapping's scale, and deleting assets or sources do not change it; the move and delete warnings now say that closed
  months keep their billed figures. Readings that reach the database late do not change it either; they only show up in the "Today's tree and rates would
  give" line. A closed month stays reachable from **Previous month** and the Year and Month selects even after its meters are replaced
  or its source is deleted: the first month the selects offer is the first month with data or the first closed month, whichever is
  earlier. There is no list of closed months yet: open a month and look for the chip.
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
- One counter reset per hour is recovered exactly; a second one inside the same hour may understate that hour.
- Energy estimated from power is an estimate, not a measurement.
- The currency is one per site, there are no time-of-use tariffs, and custom metrics cannot be used in widgets.
- Closing a month has limits of its own (one snapshot per close, what a restore does to closed months, a close that lands during an
  edit): see [Closing a month](#closing-a-month).

Related: [Screens](screens.md), [Roles and permissions](roles-and-permissions.md), [Assets and kinds](assets-and-kinds.md), [Storage](storage.md)
