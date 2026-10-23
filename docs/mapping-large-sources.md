# Mapping a large source by tag shape

This page is for the person who connects the platform to a server with thousands of tags, such as a SCADA with about 15,000 of them, and has to say which tags feed which asset. It explains **Map by shape**, a page that groups the tags of one source into a few dozen shapes so that you decide about a shape and never about thousands of points, and it says what Discovery and the Points page do with such a source. Adding and browsing a source is on [Sources and discovery](sources-and-discovery.md); the settings of a big OPC UA server, and the test server this page uses as its example, are on [Large OPC UA servers](opc-ua-at-scale.md).

Nothing here maps anything by itself. Every row starts at **Ignore**, the page shows what a decision would do before it does it, and a map can be undone.

## Why shapes

A SCADA lists one tag for every reading of every meter. One meter has about 27 of them, and a plant has hundreds of meters, so a source can hold 15,000 tags. Nobody maps 15,000 points one by one, and a graph with a node for every group of them cannot be read. But the names repeat: `PDUA01_PM0_PENRG`, `PDUA02_PM0_PENRG` and so on are the same reading of 200 meters, and what you decide about one you decide about all of them. Map by shape finds those repeats and gives you one row for each. On the 15,000-tag test server that is 29 rows.

## What a shape is

A shape is a tag name with its numbers replaced by `#`.

- `PDUA01_PM0_PENRG` and `PDUA02_PM0_PENRG` are one shape, written `PDUA#_PM0_PENRG`. A number that is the same in every tag of the shape (the `0` of `PM0`) stays in what the page shows; the shape itself ignores every number, so a later browse that adds a `PM1` meter changes the words on the row and not the shape.
- A server with another naming style works the same way: `HALL2.RK014.PDU-L.kWh` and `HALL2.RK015.PDU-L.kWh` are one shape, `HALL2.RK#.PDU-L.kWh`.
- Letters never merge. `PDUA#...` and `PDUB#...` are two shapes, and `...PDU-L.kWh` and `...PDU-R.kWh` are two shapes. In particular `P`, `S` and `Q` (active, apparent and reactive power) are never one shape.
- Only digits `0` to `9` count as numbers. A tag with no other tag like it belongs to no shape; the page counts those as **Other tags**.
- The text is the tag name the server gave. For an OPC UA node id such as `ns=3;s=20403:Site.PDUA01_PM0_PENRG` it is the part after the cluster, `PDUA01_PM0_PENRG`.

**The shapes, the billing label and the asset name are guesses.** The platform makes them from the tag text and the unit the server gives, and knows nothing about your plant. The page says so on every visit: "Every shape, billing label and asset name on this page is a guess made from the tag text: check the examples before you map." The SCADA names used on this page (`PDUA01_PM0_PENRG` and the rest) are a guess too: they are what the test server plays, which is a model of the real SCADA made from what is known about it, not a copy.

## Who can open it, and how

Opening the page and looking needs `discovery.view`. Deciding, reviewing and mapping needs `discovery.accept` (see [Roles and permissions](roles-and-permissions.md)). Without it the page says "Your role can look at the shapes but not map them", each row shows its decision as text (`Decision: Ignore`) and there is no **Review** button. The page needs nothing else: it carries the source's name and the list of assets itself.

It is at `/sources/<id>/shapes` and works for any source that has points. You reach it from:

- the **Map by shape** button on a large source's card in Discovery (below), and the link of the same name in the card's **Details** panel;
- the **Map by shape** link in the header of the source's Points page;
- the last option of Discovery's Find (below).

## The page

The heading is `<source name>: map by tag shape`, with the trail `Discovery / <source name>`. Under it, four tiles: **Points** (every tag the last browse found), **Shapes**, **Mapped** (tags that already belong to an asset) and **Other tags**. **Search tags** is under them.

The rows come in two sections.

- **Suggested for billing.** The shapes whose guessed reading is an energy counter (kWh) or an active power (kW), counters first, then power. Inside each group the bigger shapes come first.
- **Not needed for billing (N points).** Every other shape. It is closed; the button opens it, and its rows can be decided like the others.

Under both sections is the **Other tags** line: how many tags have no shape, three of them as examples, and, for a person who can open the Points page (`sources.edit`), a link **See them on the Points page**. Only the first 300 shapes are listed; a line `+ 12 more shapes. Use Search tags to find them.` says when there are more.

**A row** shows the shape (`PDUA#_PM0_PENRG`), how many tags it has (and how many of them are already mapped), three example tags (their stored addresses are in the hover text), the unit the tags carry, and the suggestion in words: `Unit kWh. Suggested: kWh counter, a guess from the unit kWh.` A shape whose tags do not all agree says so. The space under the row holds the row's saved rule (see Saved rules below) and a warning line for a shape with more than one unit, for tags that appear twice (see Renumbered below) and for an asset name that does not fit the example; the room for it is always there, so the row never jumps. The row only warns; it is the Review that blocks a map (see Units and the scale below).

**Search tags** takes 2 to 100 characters, a piece of a tag's name or address, with or without capitals. It waits a moment after you stop typing, keeps the shapes with a matching tag, and says `34 tags match "PENRG", in 2 shapes.` Up to five matching tags are listed; choosing one jumps to its row (opening the second section if it is in there) and puts the focus on it. A tag with no shape says so.

## One decision per row

Billing first: look at **Suggested for billing**, and leave everything else at **Ignore**. Nothing is mapped that you did not choose.

Each row has:

- **A decision.** **Ignore** (the default), then **Map as** the suggested reading (`Map as energy counter`), then every other reading the platform knows. Choosing is all it takes: the page has no box for a scale or a unit, and the scale of the lines is worked out from the unit the tags carry (next section). Custom needs a unit: it works when the tags of the shape name exactly one unit and is refused, in words, when they name none or several. The mapping interval is the platform's usual one (60 seconds for an energy counter, 5 seconds for the other readings); see the warning on [Large OPC UA servers](opc-ua-at-scale.md#mapping-intervals-for-tags-that-change-about-once-a-minute).
- **Asset name from.** The asset a tag lands on is named from the parts of its text, split at `_`, spaces, `.`, `/`, `:` and `-`. **Part 1** (the default) gives `PDUA01` for `PDUA01_PM0_PENRG`. **Parts 1 and 2** gives one asset called `PDUA01 PM0`. **Part 1 / part 2** makes `PDUA01` an asset and `PM0` a sub-asset beneath it. Under the choice the row shows the result for its first example (`Asset: PDUA01`). Part 1 is a guess at how a meter is named; feeds A and B stay separate assets (`PDUA01` and `PDUB01`), and the page does not pair them.
- **Same decision for PDUB#_PM0_PENRG.** Shown on a shape that has a near twin: another shape whose names differ in one letter of the first part, with the same guessed reading and unit. Ticking it copies the decision to the twin shape now and keeps them in step while the tick is on. It starts off, and the shapes are never merged.

At the bottom: **Review N mappings...**, **Put new assets under** (an existing asset to hang the new assets on, or the top level) and **Create missing assets** (ticked; unticked, an asset that does not exist is a problem). N is the number of tags the chosen shapes cover. The button is greyed out until something is chosen, and one review takes at most 60 shapes.

### Units and the scale

This is about money: a counter in Wh read as if it were kWh gives a bill 1,000 times too high. So the scale of every line is worked out from the unit the tags carry, and the Review stops whatever it cannot settle. For every reading except custom:

- **Every tag of the shape names the same unit** (capitals and spaces do not matter): the scale is taken from that unit. A counter in Wh mapped as an energy counter gets the scale 0.001, one in kWh gets 1 and one in MWh gets 1000 (for an active power: W 0.001, kW 1, MW 1000). A counter written as `energy_kwh` whose tags say Wh is therefore scaled by 0.001, not by 1. The **Scale** column of the samples shows the number that will be written.
- **The units differ, or some tags name a unit and some name none:** blocked as **Mixed units**. One scale cannot fit all of them, and nothing is guessed.
- **The unit is one that reading does not know** (kW mapped as an energy counter, kV mapped as a voltage): blocked as **Units**. The page has no scale box, so it cannot take a scale from you. Map those tags as custom, or decide them on the Points page.
- **No tag names a unit:** the scale of the platform's guess when you chose the suggested reading, otherwise 1. Look at the samples.

A custom reading keeps the unit the tags name, with the scale 1. Check the **Unit hint** and **Scale** columns of the samples before the first map of every shape.

## The Review

**Review N mappings...** opens a window titled `Review mappings by shape: <source name>`. Nothing is written yet; the platform checks twice.

1. **The platform's own check.** The server reads the source's tags again (never the list in your browser) and turns the decisions into a tag list, the same kind of CSV as **Map tag list...** takes ([Sources and discovery](sources-and-discovery.md#importing-readings-from-a-file)). The window opens with the checks (below), then shows, for each shape, the counts (`400 tags on up to 400 assets`, then `12 already mapped, left as they are` when some are) and **five sample tags** in a table: the tag with its address under it, the asset it would go on, the unit hint, the reading and the scale. The count says "up to" because it is an upper bound: it counts an asset that already exists as a new one, and for **Part 1 / part 2** it counts the parent and the child together; the planner's report (next) has the exact number of assets to create. Tags that are mapped already, and the unmapped copies of a mapped tag, are left out and counted; they never stop the review. The server also asks the tag list planner about the list, without writing anything, and shows whatever the planner would refuse as a blocking check naming the tag, the asset it would have gone on and the planner's reason (an asset that already holds that reading, for example), so a list the planner would refuse is never offered.
2. **The tag list planner's dry run.** When no check blocks, the list goes to the tag list's own dry run, and the window shows the planner's report: points, assets and mappings it would create, how many tags go onto assets that already exist, any problem lines, and the units.

Under the title a line says how many shapes were chosen, where the new assets go (`under Hall 1`, or `at the top level`) and that the asset names are a guess: check the samples. At the foot of the window, left of the buttons, one line says where things stand: `400 tags would be mapped. Nothing is mapped until you press Map.`, or `Some checks block this. Fix them first (choose other shapes or another asset name); nothing has been mapped.`, or that the planner found problems.

The platform's own check and the tag list's dry run each count the assets the list would create, and the page compares the two numbers when the dry run is back. The new assets are chosen under a parent by its id but written by its name, so if something above them was renamed, removed or added in between the two counts differ. Then the first check reads `The assets changed while this list was being checked (something above the new assets was renamed, removed or added). Review again.`, the foot line says `Nothing has been mapped. Press Review again to check the list once more.`, and a **Review again** button appears beside **Cancel**. It reads the lines and the dry run again inside the window and puts the focus on the result. **Map N points** does not work until the two numbers agree.

**Map N points** is the only way on. It stays greyed out while a check blocks, the planner has a problem, the assets changed or a call is running.

### The checks

A **Blocking** check stops the map. A **Warning** does not.

- **Collision (blocking).** Two tags of one shape would land on the same asset as the same reading, or two decisions would. `3 tags of this shape would land on each of 200 assets (PDUA01 gets PDUA01_PM0_PL1, PDUA01_PM0_PL2 and PDUA01_PM0_PL3)`, with the way out: choose another asset name if that separates them, or map the shape as custom (an asset may hold any number of custom readings).
- **Renumbered (blocking).** `200 tags of this shape appear twice (the SCADA renumbered them)`: the browse holds two numbered addresses for one tag, or a tag is already mapped under its other number. Mapping them would put one tag on an asset twice, so this blocks under every reading, custom included. Switch on "Stable tag addresses" for the source and browse again ([Large OPC UA servers](opc-ua-at-scale.md#stable-tag-addresses)), or decide those tags on the Points page.
- **Mixed units (blocking).** `This shape has the units kWh and Wh (3 name kWh and 1 names Wh)`, or `2 tags of this shape name the unit Wh and 3 name none`: one scale cannot fit all of them, so nothing is guessed (see Units and the scale above). The sentence offers custom, but a custom reading needs exactly one unit and this page has no box to type one: it works when the tags that name a unit all name the same one (the others name none), and not when they name several units. For those, decide the tags on the Points page.
- **Units (blocking).** `The unit "kW" of the 200 tags of this shape is not one that energy_kwh knows; map it as custom, or decide them on the Points page`: every tag names the same unit, but the reading chosen does not take it. Choose the reading the unit belongs to, map the shape as custom, or decide the tags on the Points page.
- **Address (blocking).** `2 tags of this shape have an address a tag list cannot name exactly (a space at the start or end, an unprintable character or more than 500 characters); decide them on the Points page`. A tag list trims every cell, so such an address would map another point or none. The tag is never written.
- **Too many (blocking).** `at most 1,000 tags at a time (the limit of a tag list): choose fewer shapes`. It counts the tags, and also the assets the list would create (at most 1,000). A single shape of more than 1,000 tags cannot be mapped here at all (the branch shape of the test server has 4,190); decide those tags on the Points page. They are rarely the ones a bill reads.
- **Name (blocking).** An asset name that cannot be made: a tag with fewer parts than the choice needs, a name longer than 100 characters, holding a `/` or holding control or invisible characters, or a "Put new assets under" asset that has been deleted since or has a `/` in its name.
- **Custom unit (blocking).** Custom was chosen and the tags name no unit, or more than one.
- **Gone (blocking).** The shape is no longer in the source: a browse changed the tags since the page loaded. Open the page again.
- **Nothing left (warning).** Every tag of the shape is mapped already.
- **Outlier (warning).** A meter that lacks the tag: `198 of 200 like PDUA01 have this tag; PDUA17 and PDUA44 do not`. The platform compares the first part of the tag names (here `PDUA01`, `PDUA02`, ...), not any product name. A meter that lacks its energy counter would be missing from the bills, so look before you map; the warning is repeated in the message that follows the map.

## Map and Undo

**Map N points** makes the real run through the tag list, with the numbers and the digest of the dry run, so it is all or nothing and refuses, with the server's own sentence, if anything changed since the check (the window then reads everything again; check the new numbers before you press Map again). A message says `Created 400 mappings.` (with the outlier warnings added after `Check:` when there were some) and has an **Undo** button for 10 seconds; the window closes, the page forgets its decisions, the new rules are saved (below), and the lists on every page are read again.

Because it goes through the tag list there is nothing new to learn about the record: the Audit log has **one** `tags.mapped` row for the map, and its drawer has **Undo this tag list** for 24 hours (`discovery.accept`). Undo removes the mappings and the assets the map created, and refuses, undoing nothing, if a mapping was edited or a created asset was renamed, moved or given something since ([Sources and discovery](sources-and-discovery.md#importing-readings-from-a-file)). A mapping made here is an ordinary mapping; it feeds the bills like any other ([Dashboards and billing](dashboards-and-billing.md)).

## Saved rules

After a successful map the page remembers what you decided, for that source, as a **rule** for each shape that was in the review. A rule holds the reading and the "Asset name from" choice, nothing else, and names the shape (the shape itself, not the words on the row), so it survives a browse that renumbers or adds meters. The new rules are added to the ones the source already has; the other rules stay as they were. If the rules cannot be saved, a message says `The mapping was done; the rules could not be saved.` and the map stands.

A shape with a rule shows it under its row: `Saved rule: Map as energy counter, asset name part 1`, with a **Forget this rule** button that removes just that rule. Forgetting a rule, like saving one, needs `discovery.accept`; reading it needs `discovery.view`, and a person with only that sees the sentence and no button. Saving a rule writes nothing that a figure reads and has no Audit row of its own; the mappings it led to have theirs.

**A rule is never applied by itself.** The platform counts the tags that are not mapped yet (the unmapped copies of a mapped tag do not count) and belong to a shape with a rule; a browse that finds new meters raises the number. It is counted for a large source only (rules are saved and shown on the rows of a smaller source too, but its card never says "new"). When there are some on a large source:

- its card on Discovery reads `15,000 points, 800 mapped, 12 new`, and its **Map by shape** button reads **Review 12 new**;
- its **Details** panel says `12 new tags match your rules: review`, as a link.

Both go to the shapes page with `?rules=1` in the address. The first time the page has read its shapes after it opened, every row that has a rule and tags still to decide about is set to its rule (a closed second section is opened if it holds such a row). The rows can be changed, and nothing is mapped: you still press **Review** and **Map**, so a new meter is never mapped without someone looking at it. A person who cannot decide (`discovery.accept`) gets no preset. Reload the page and the address asks for the same again.

Rules stay when a map is undone. After an **Undo** the tags are not mapped again, so they match the rules again and the card of a large source says `Review 400 new` once more. Only **Forget this rule** removes a rule; mapping the shape again with another decision replaces it.

## What a large card looks like on Discovery

A source with more than 1,000 points is a **large** source. Discovery would otherwise draw a node for every group of its tags, which for 15,000 tags is thousands of nodes, too many for the page to move or a person to read. So the graph holds only what is mapped: the card says `15,000 points, 800 mapped` (the source's real figures, with a bar for the share), opening it shows its mapped groups and points and the unmapped copies of mapped tags, and the button **Map by shape** sits beside **Details** for a person with `discovery.view` (when saved rules match unmapped tags the line ends `, 12 new` and the button reads **Review 12 new**; see Saved rules). The counts above the canvas read the real totals, **Unmapped only** keeps a large source while it has unmapped tags, and **Create assets...** is not offered for it: use the shapes page instead.

A source of 1,000 points or fewer is drawn exactly as before. The server decides: it marks a source as large when it holds more than 1,000 points.

For any source, large or not, the page also refuses to open what would draw more than 600 groups: pressing its arrow or Enter shows `Plant has 13,851 groups, too many to draw; use Map by shape` (adding ` or the Points page` for a person who can open it), and Find takes you to the card with the same note instead of opening it.

## Find

**Find** (Ctrl+K on the canvas) lists matches on the canvas as before. A large source's tags are not on the canvas, so for a query of 2 to 100 characters Find ends its list with one more option for each large source: `Search the 15,000 tags of <source> for "PENRG"`. Choosing it opens that source's shapes page with the search filled in, for a person with `discovery.view`.

## The Points page shows 200 rows at a time

The Points page of a source (`sources.edit`) used to draw every point, which is 15,000 rows for a big source. It now draws the first 200 and says `Showing 200 of 1,306 points. Search to narrow them.`, with a **Show 200 more** button; when everything is drawn, the button stays as the words `All 1,306 shown`. **Search points**, **Unmapped only** and the sort order still look at every point, and changing any of them starts again at 200 rows. The row menu and the Map dialog are as before, and the header has the **Map by shape** link.

## The real SCADA in five lines

1. Add the source (Sources), then **Browse** it and wait for the job.
2. Open **Map by shape** from its card on Discovery.
3. Under **Suggested for billing**, set the energy-counter rows to **Map as energy counter**, and tick **Same decision for ...** where a twin shape is offered.
4. Choose **Put new assets under** an asset of the site, and press **Review N mappings...**: look at the samples (the asset, the unit hint and the scale of each), the checks and the planner's report.
5. Press **Map N points**; if the result is not right, **Undo** in the message or from the Audit log.

Check the asset names in the samples before the first map: they are a guess.

## A worked example

The 15,000-tag test server ([Large OPC UA servers](opc-ua-at-scale.md#rehearsing-it-on-the-scada-shaped-test-server): 200 meters on each of two feeds, 27 tags each, 10 incomers and 4,190 branch tags) gives 29 rows and no other tags: 13 shapes for each feed behind `PDUA#_PM0_` and `PDUB#_PM0_`, the branch shape `PDUA#_Q#_P` and two for the incomers. Under **Suggested for billing** the counters come first: `PDUA#_PM0_PENRG` and `PDUB#_PM0_PENRG`, 200 tags each, suggested as a kWh counter from the unit.

To map every meter's energy counter: leave **Asset name from** at part 1; choose **Map as energy counter** on `PDUA#_PM0_PENRG` (it is the first choice after Ignore); tick **Same decision for PDUB#_PM0_PENRG**; choose the asset the new ones go under; **Review 400 mappings...**; **Map 400 points**. The review shows `200 tags on up to 200 assets` for each shape, samples such as `PDUA01` with the unit hint kWh and the scale 1 (every tag of the shape names kWh), no check, and the planner's report of 400 mappings. That is the five actions.

The same page shows why the checks exist. `PDUA#_PM0_PL#` has three tags for every meter (600 in all); mapped as active power with part 1, all three of a meter would land on `PDUA01`, and the Review blocks it with a collision. The 4,190 branch tags are a shape of their own and, being over 1,000, cannot be mapped in one review.

Related: [Sources and discovery](sources-and-discovery.md), [Large OPC UA servers](opc-ua-at-scale.md), [Screens](screens.md), [Roles and permissions](roles-and-permissions.md), [Dashboards and billing](dashboards-and-billing.md)

## What it was measured at

The measured table is added when the wave is closed.
