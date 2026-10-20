# Dashboard figures, templates and the guide

This page is for anyone who reads a dashboard or starts a new one. It says how a figure is written on a card and where to find its
exact value, which templates **New dashboard** offers and what each one needs, what the first-run guide says, and what **Updated** and
**Refresh** in the header mean. The widgets, the focus and the Details panel are described in
[Dashboards and billing](dashboards-and-billing.md#dashboards).

## How figures are shown

A figure is written in three ways, one for each place where it is read.

- **On the card: short.** The big figure of a stat or a gauge, both sides of a comparison, the change line and the line under a
  breakdown ("and 219 more Circuits: ~262.07 MWh in all (12 with no data)"). It has thousands separators and moves up a unit when it
  gets big, so it fits the card and can be read at a glance.
- **Exact: the full value.** Hold the pointer on a figure on a card and its title shows the exact value with its unit and its marks.
  The Details panel, the tables and the chart tooltips show the exact value too. These places never change the unit, so digits can be
  compared. A table names its unit in the column heading (**Value (kWh)**).
- **On a chart axis or a gauge: ticks.** An axis label has separators and only the decimals it needs ("18,000", "0", "0.5"). The unit
  is written once, in the name of the axis. A gauge writes its two ends under the arc ("0" and "20 kW").

An example, with this month's energy at 275,430.2575 kWh and a cost of 33,051.6309: the card says **~275.43 MWh** and **~33,051.63**,
their titles say **~275,430.26 kWh** and **~33,051.63**, and a table cell for one hall says **138,130.96**. Last month, beside this
month, reads **~275.99 MWh**, and the change reads **down ~0.2 % (~-562.82 kWh)**.

The short figure follows these rules. The size is the size of the figure after it is rounded.

| Kind of figure | Size | Written as | Examples |
|---|---|---|---|
| Energy and power (kWh, kW, kVA, kvar) | below 10,000 | two decimals | 7.25 kWh, 1,124.00 kWh |
| | 10,000 to below 100,000 | whole numbers | 33,052 kWh |
| | 100,000 and more | the next unit up, by the same rules | 275.43 MWh, 1,234.57 MWh, 45,678 MWh, 123.46 GWh |
| Cost (the site currency, or none) | below 100,000 | two decimals | 33,051.63 QAR |
| | 100,000 to below 1,000,000 | thousands, written k, two decimals | 275.43k QAR |
| | 1,000,000 and more | millions, written M, two decimals | 1.23M QAR |
| Every other unit (V, A, Hz, power factor, your own) | any | two decimals, never scaled | 229.80 V |

- The unit is chosen after the figure is rounded. 9,999.996 kWh reads "10,000 kWh", 99,999.5 kWh reads "100.00 MWh" and a cost of
  99,999.996 reads "100.00k".
- kW goes up to MW and GW, kVA to MVA and kvar to Mvar. Past the last unit a figure only gets more digits.
- The marks stay where they were: `~` in front when part of the figure is estimated, `*` behind when some hours have no rate
  ("~-562.82 kWh", "275.43k* QAR"). A figure with no data is a dash and has no unit. Zero never has a minus sign: -0.004 kWh reads
  "0.00 kWh". A percentage has one decimal ("down 3.1 %").
- **One unit for figures you compare.** Both sides of a comparison use the unit of the larger side, so "~275.43 MWh" stands against
  "~275.99 MWh" and never against "275,993.08 kWh". The change line takes the unit that suits its own size. A chart draws all its
  values on one axis with one unit, named on the axis ("MWh"; for a cost "k QAR" or "M QAR", and "thousands" or "millions" when the
  site has no currency). A gauge uses one unit for its figure and both ends of its scale.
- When a small figure would round to zero beside a very large one (4 kWh next to 500,000 kWh), the group uses the smaller unit
  instead ("500,000 kWh" and "4.00 kWh"), so nothing reads 0.00 when it is not zero.

Only the way a figure is written changed. The values, the CSV, the Details panel and every total are as before. Billing (kWh with one
decimal, cost with two) and the asset page keep their own formats and write no thousands separator, so the same figure can look
different there; the rounding is the same.

## Starting a dashboard from a template

A person who may change dashboards presses **New dashboard** on the Dashboards page. On a site with no dashboards yet that person sees
"No dashboards yet. Create one to get started." with the same cards under it, and a card opens the second step. A person who may only
view dashboards sees "No dashboards yet." and no cards.

1. **Choose a template.** The cards sit in two rows: **Recommended for this site**, then **More templates**. **Blank** is always the
   last card and is never recommended. Each card has a small picture of its layout, a title and one line. A **Recommended** tag means
   the template is true of this site today (see below). A template that cannot work yet says what it needs on its card. Tab goes
   through the cards, Enter or Space chooses one, Escape closes the dialog. While the list loads, or if it cannot be loaded ("The
   templates could not be loaded. A blank dashboard still works."), only Blank is offered.
2. **Name and range.** **Name** (left empty it becomes the template's title; a name already in use is refused in the dialog),
   **Range** (the template's own: This month, except Last 24 hours for the Last 24 hours template and for Blank), **Back to
   templates**, **Cancel** and **Create**. A template opens in view mode, already filled. Blank asks for a name and opens in the
   editor, empty.

What the templates make. All but the heading follow the focus, so each answers for the whole site, a hall or a rack, depending on the
focus you choose ([A focus asset](dashboards-and-billing.md#dashboards)). Edit the result like any other dashboard.

| Template | What it holds | What it needs |
|---|---|---|
| **Power** | A heading "Power use and cost"; the stats **Energy** and **Cost**, each this month so far against the same days of last month; "Energy by Panel" (or Rack and so on: the kind that has meters), a bar for each asset of that kind; the chart "Energy by day, against last month". | An asset with its own meter. |
| **Cost** | A heading "Cost and where it goes"; the stat **Cost** against last month; "Cost by Panel" (the same kind); the chart "Cost by day, against last month"; the table "Cost by area", one line for each area inside the focus. | A meter, and a rate that applies today to at least one metered asset (**Tariffs**; the site's default rate counts). |
| **Energy by area** | A heading "Where the energy goes"; the table "Energy by area"; the bars "Energy per area"; the chart "Energy by day" with a line for each area. | At least two areas with a meter. An area is a child of the focus; with one top-level asset that is its children, with several it is the top-level assets. |
| **Last 24 hours** | A heading "Last 24 hours"; the chart "Energy per hour"; the table "Energy by area". Both cards keep 24 hours even when you pick another range for the visit. | A meter. Never recommended. |
| **Blank** | Nothing. | Nothing. |

**Recommended** is decided by the server from the site as it is now. With no meter anywhere, nothing is recommended and the gallery says
"Nothing is metered yet, so every template shows no data until a meter is mapped." Otherwise Power is recommended; Cost when a rate
applies today; Energy by area when two areas have a meter; Last 24 hours never. On the pilot-hall demo that tags Power, Cost and
Energy by area. A template that is not recommended can still be chosen; its card says what is missing ("Needs a rate in Tariffs.",
"Needs at least two areas with a meter.").

Why no template shows live power in kW: a live-power card reads only an asset's own meter and never adds up what is below it, so a
site or a hall cannot show its power. The templates show energy, which is added up for every asset.

### Make a copy

In the Dashboards list, the row menu (the `⋯` button) of a person who may change dashboards has **Make a copy**. It makes a new
dashboard with the same range and the same widgets. A copy of "Power" is named "Power (copy)", then "Power (copy 2)", "Power (copy 3)"
and so on when the name is taken; a very long name is cut so the new name still fits in 100 characters. The copy is never the default dashboard and counts
toward the 50 dashboards. A message says "Copied to Power (copy)" and you stay on the list. The same menu holds **Make default** or **Clear
default** for a person who may choose the default ([Who may do what](dashboards-and-billing.md#who-may-do-what)), so an Operator's menu
holds only **Make a copy**, an Admin's both, and a Viewer has no menu.

## How to read this dashboard

A dashboard that has something to explain (a card that follows the focus, a comparison or a breakdown by kind) shows a short panel
above its cards the first time a person opens one. It is shown once for each browser and each account. **Got it** closes it and the
browser remembers that. The header of such a dashboard has a text button **How to read this** that opens the panel again (a dashboard
with nothing to explain has no panel and no button). If the browser does not let the page remember anything, the panel shows again after each reload of the page, and **Got it** closes it until then.

The panel has two to five lines, and a line appears only when the dashboard has the thing it explains and the role can use it:

- "Energy and Cost cards set this month so far against the same days of last month." (a comparison)
- "Focus picks the asset this dashboard follows; cards that follow it change when you change it." (a card that follows the focus, for a
  role that may see the Assets Tree)
- "Click a bar of a breakdown: an asset with other assets inside it narrows the dashboard to it, and any other opens its page." (a
  breakdown by kind, for a role that may see the Assets Tree; where no card follows the focus it says "Click a bar of a breakdown to
  open that asset's page.")
- "~ means some of the figure is estimated. * means some hours have no rate, so a cost is incomplete." (always)
- "The (i) button on a card (Details) shows how its figures were worked out; the download button saves them as a CSV file." (always)

Small ? buttons (What does this mean?) beside **Focus**, the focus dialog's picker, **Split by** and the widget form's **Show** say in
one sentence what the choice does. A dashboard with no widgets tells a person who may edit: "This dashboard has no widgets yet. Use Edit, then Add widget."

## The header: Updated and Refresh

The header of a dashboard with data cards says **Updated 20:09** and has a **Refresh** button. A dashboard with no data card (no cards,
or only text cards) has neither.

- **Updated** is the time, in the site's time zone, at which this browser received the oldest figure now on the page. The oldest one
  decides, because that is the figure furthest behind. It is a time to the minute: the server may serve a figure up to 30 seconds old,
  60 for the current month ([Limits](dashboards-and-billing.md#limits)). A card asks again by itself every 30 seconds, and a card that compares with last month
  every 5 minutes, so on a dashboard with a comparison the time can be up to 5 minutes behind. Nothing shows before the first figure
  arrives, and while a new range or focus loads the old time stays, dimmed. If a card cannot be refreshed, the time stays at its last
  good figure. A screen reader is not told about each change of the time.
- **Refresh** asks again for every card on screen at once. The button waits while figures are being read. It cannot make the server
  serve a figure younger than the server keeps it. A browser tab that is not on screen stops asking and catches up when you return.

## Smaller things

- **Cards use their room.** The figure of a stat or a gauge grows with its card, up to about 48 pixels, and shrinks before it would
  clip or break. On a stat that compares, a card about 360 pixels wide or more (three columns on a 1920 pixel screen, four at
  1440) sets this month and the same days of last month side by side. A narrower card puts them under each other. The change line and
  the one note line stay underneath.
- **The same name twice.** When several bars, lines or table rows have the same name, a person who may see the Assets Tree sees the
  parent's name too: "Hall 2 / Rack 04". If that is still the same for two assets, the number follows: "Hall 2 / Rack 04 (#12)". A role
  without that permission, and the moment before the asset list arrives, see "Rack 04 (#12)". The name is the same in the chart, the
  legend, the table and Details.
- **A card that fails.** It says "This card could not be loaded. It tries again in 30 seconds." (in 5 minutes for a comparison). When
  older figures are still drawn it says "could not be refreshed" instead. Hold the pointer on the sentence for the server's message; in
  the widget form's Preview the message is written out.

Related: [Dashboards and billing](dashboards-and-billing.md), [Screens](screens.md), [Roles and permissions](roles-and-permissions.md)
