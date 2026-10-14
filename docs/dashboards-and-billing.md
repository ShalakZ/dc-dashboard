# Dashboards and billing

This page is for the people who build dashboards, read the monthly energy and cost report and set the tariffs, and for anyone who has to
explain a cost figure. It covers the dashboards and their widgets, the default dashboard, the Billing page, tariffs, which rate applies
to a day, how energy and history are calculated, and the limits of all of it.

## Who may do what

Roles are enforced by the API; the screens only hide what you cannot use. The table is the three built-in roles; see
[Roles and permissions](roles-and-permissions.md) for what each permission allows and for making a role of your own.

| | Viewer | Operator | Admin |
|---|---|---|---|
| Open dashboards and Billing, export CSV | yes | yes | yes |
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

The asset page shows today's cost next to today's energy.

## Tariffs

An administrator sets the tariffs (`tariffs.edit`); an Operator may read them. They hold:

- **The site currency**: one three-letter code for the whole site; when it is unset, costs show without a unit. Changing or clearing
  the currency asks for confirmation: it relabels every past figure and converts nothing.
- **The rates**, in that currency per kWh: the site default and per-asset overrides. A rate is a number of zero or more, at most
  1,000,000, with up to six decimals, and an effective date (a date in the site timezone, not a time). Two rates for the same asset (or
  two site defaults) cannot start on the same date (409).

An override on an asset applies to that asset and everything under it, unless a lower asset has its own. Which rate prices a given day
is set out in [Which rate applies to a day](#which-rate-applies-to-a-day). Give a new rate the date of the day it should start.

Editing or deleting a past rate recalculates history: cost is for visibility, not invoicing. Tariff, currency and dashboard changes
appear in the Audit log; an update shows the values before and after.

## Which rate applies to a day

Cost is not stored. It is worked out on every request from the hourly energy, today's asset tree and the tariff table
(`backend/dcdash/core/cost.py`). Three rules follow from that.

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
- a move re-evaluates every past day, but a day only changes if the new place's rates were in effect on it (that is, if the rate the
  new place gives on that day differs from the one the old place gave);
- the asset's energy goes with it, so the energy and cost totals of both places (and of the assets above them) change for every past
  day, whether or not the rate changed. The exception is a place with its own meter: from that meter's first reading on, its figures come
  from the meter, so moving an asset in or out does not change them.

**3. The practical rule.** Make rate changes and moves at a day boundary, and give a new rate the date of the day it should start. Past
figures always follow today's configuration. A planned **Close month** will freeze closed months so that past billing stays as billed;
it is **not built yet**, so until then a past month can change.

**Worked example: moving an asset into another room.** The owner's test on the development stack: after a move to a dearer room the
five earlier days did not change, and today's whole day did. The table shows the general cases for the moved asset's own past days.

| Before the move, the asset's rate came from | The new room's rate | The asset's past days |
|---|---|---|
| the site default | an override that starts on or after the move date | unchanged, as long as no asset above the new room has a rate in effect on those days; from the override's date on, the days are priced at it (the move day included, all 24 hours) |
| any place | an override that started before the asset's history | re-priced at the new room's rate, back to that rate's effective date |
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

Billing and dashboards follow the current configuration: past months are recomputed from today's mappings, scale factors, asset tree,
tariffs and site timezone. Re-pointing a panel to another source, changing a scale or the timezone, moving an asset or deleting one
therefore changes past figures. Deleting an asset that has children, mappings or tariffs, or a source with mapped points, asks for
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

Related: [Screens](screens.md), [Roles and permissions](roles-and-permissions.md), [Assets and kinds](assets-and-kinds.md), [Storage](storage.md)
