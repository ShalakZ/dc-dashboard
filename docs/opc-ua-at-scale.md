# Large OPC UA servers

This page is for the engineer who connects the platform to an OPC UA server with thousands of tags, such as a SCADA with 15,000 of them, and for the OT people who are asked what the platform sends to it. It covers three things the platform does for such a server: the option "Stable tag addresses", reading in slices, and a browse that asks for many nodes at a time. It also says which mapping interval to choose for a tag that changes about once a minute, and how to rehearse all of it on the platform's own SCADA-shaped test server. The plain settings of an OPC UA source are on [Sources and discovery](sources-and-discovery.md); the load on a Historian-like server, as numbers an hour, is on [Historian integration](historian-integration.md#the-live-poll).

The platform only reads. Nothing on this page writes to the server.

## Stable tag addresses

### What the number is

Browsing an AVEVA Plant SCADA OPC UA server shows each tag as an id like `ns=3;s=20403:Site.PDUA01_PM0_P`: the namespace (`ns=3`), then a text made of a number, a colon, the cluster name (`Site`), a dot and the tag name. The platform stores the id exactly as the browse gave it and reads that same string later.

The number in front of the tag is the part that worries us. A **community answer on AVEVA's forum** (not documentation; who wrote it, and in what role, is not stated) calls it a "browse position index" and says, in short:

- it should be kept unless the structure of the tag name space is changed on the SCADA side, and when equipment is added to the hierarchy, every node below it gets a new number;
- a request that uses a node id with a new number can break the runtime data;
- an OPC UA client should ignore the number when it creates monitored items, and the form `ns=3;s=<Cluster Name>.<Tag Name>` can be built without a browse session.

Two other things in the same thread matter. The person who asked saw the number "reset on new session" and rise while browsing, so **do not assume the number stays the same from one session to the next**; the platform opens a new session for every read. And a later reply from the asker says that removing the number made the communication work, a user report about another product's client. **All of this is a community answer, not tested against your SCADA.** The forum thread is [here](https://community.aveva.com/heroes-hq/f/aveva-plant-scada/82294/opa-ua-server-number-on-nodeid).

What the platform does when the numbering changes and the option is off: it keeps sending the old number. Either the server answers `BadNodeIdUnknown` and every mapped point of the source turns bad (the System events page shows "N of N points read badly", the source can still look online with a fresh last reading, and the bills see no good readings), or, if the server resolves a number by position, the platform reads another tag's value into the point. Nobody knows yet which of the two Plant SCADA does, so this is the case to test (see "Ask OT to read three ids" below). The option avoids the question.

### Turning it on

The option is **off** for every source, and the platform never switches it on by itself. To turn it on, open Sources, Edit source on an OPC UA source (it needs the permission `sources.edit`), tick **Stable tag addresses** and save. The field says, in the form: "For AVEVA Plant SCADA: read each tag as ns=3;s=Cluster.Tag, without the number browsing puts in front of it (20403:), which can change when the SCADA project changes. Based on a community answer, not tested against your SCADA. Leave this off for other servers."

With the option on:

- **Read.** Every stored address is sent as its stable form (`ns=3;s=20403:Site.PDUA01_PM0_P` is read as `ns=3;s=Site.PDUA01_PM0_P`). The answer is filed under the address stored on the point, which is never rewritten, so a point keeps its mappings and its history. The connection check reads the same stable ids the poll reads.
- **Browse.** The browse lists tags by their stable address and lands each on the point already stored for it, whatever number the server shows now. It updates that point's name, type and unit and leaves its stored address alone. A tag no stored point has is added under its stable address. A browse never adds a twin of a tag a stored point already has. When the server lists two nodes with the same stable address, none of the two is stored or updated (which of them is "the" tag would depend on the order of the list), and the browse line counts both as left as they are. A walk of a big server takes minutes, so the option is checked again when the walk is over: if it was switched during the browse, nothing is stored and the browse fails with `the stable address option was changed while the browse was running; browse again`.
- **Tag lists and file imports** match a tag to a point by its stable form, so a list that names `ns=3;s=Site.PDUA01_PM0_P` finds a point stored as `ns=3;s=20403:Site.PDUA01_PM0_P`. A tag that two stored points share is a refused line: `two points of this source have the same stable address`.
- **Discovery** does not offer an unmapped point that is the same tag as a mapped point of the source. Its row reads `Already mapped as PDUA01_PM0_P` and it has no Map button, and the bulk lists leave it out. Twins left from earlier browses show up this way.

The number is removed only from ids of the form `[ns=<digits>;]s=<digits>:<tag>` where the tag part contains a dot, has no space or other white space in it and does not itself start with a number and a colon; every other id (numeric `i=`, GUID, opaque, `nsu=`, a string id without the number or without a dot, or with white space in the tag part) is left exactly as it is. The rule never changes anything else, but on a server where `s=1:A.B` and `s=2:A.B` are two different nodes it would give both the stable address `A.B`; Test shows that (below) and the option must then stay off.

**What Test says.** Test (on the source's row) also reads up to 10 of the source's stored addresses that carry a number, mapped ones first, once as stored and once in the stable form, in one Read. It does this whether the option is on or off, only reads, and never changes the source. The sentence after the status is one of these, the first that applies:

| Test says | Meaning |
|---|---|
| `the numbered and the stable address read different values for 2 of 10 tags: do not use the option (e.g. PDUA01_PM0_P: 44.9 and 61.2)` | the two forms are not the same tag on this server: leave the option off |
| `the stable address is unknown to this server for 10 of 10 tags: turn the option off` | said when the option is on |
| `the stable address is unknown to this server for 10 of 10 tags: do not turn the option on` | said when the option is off |
| `the numbered address no longer works for 10 of 10 tags but the stable one does: the SCADA numbering may have changed` | the case the option is for; while the option is on, the sentence ends `; with "Stable tag addresses" on, your readings are not affected` |
| `10 of 10 tags read the same both ways` | the two forms agree |

When the option is off and the server looks like AVEVA Plant SCADA (its endpoint or its announced name says so, and most stored addresses carry a number), Test adds: `This server looks like AVEVA Plant SCADA and its tag addresses carry a number that can change (a community answer says so, not tested against your SCADA). Consider "Stable tag addresses" (Edit source).` The platform suggests, you decide. The same suggestion also appears under the connection check's read step (when the check has no comparison sentence of its own and the numbering hint below does not apply) and, as a `suggestion:` line, in the report's SOURCE HEALTH section. A different hint appears under the connection check's read step when a bad address carries the number, while the option is off: `The SCADA's tag numbering may have changed (a number in front of the tag from browsing; a community answer says it can, not tested against your SCADA). Try "Stable tag addresses" on this source, then Test.`

**What turning it off does.** It changes nothing that is stored. Reads send the stored strings as they are again (a point stored in the stable form keeps working if the community answer holds), and a browse works as it did before the option existed: it can list a tag a second time under its numbered address.

**What the option refuses**, so that one reading never reaches two points:

- Turning it on is refused (422) while two mapped points of the source are the same tag. The message names the first five pairs, for example `PDUA01_PM0_P is mapped twice: point 12 (ns=3;s=20403:Site.PDUA01_PM0_P) and point 98 (ns=3;s=20410:Site.PDUA01_PM0_P). Delete one of the two mappings, then try again.` Unmapped duplicates are allowed: they are not polled.
- Mapping a point whose tag another mapped point of the source already has is refused (409): `PDUA01_PM0_P is already mapped as point 12 (ns=3;s=20403:Site.PDUA01_PM0_P): this source reads both as one tag. Unmap that one first.` The same check runs for a new mapping and for Accept in Discovery (two points of one request are refused as `... is in this request twice ... Map only one of them.`). A tag list refuses a line for such a tag (`two points of this source have the same stable address`), and a file import stores no row for a tag that two stored points share.
- If two mapped points of the source have the same stable address anyway (which the refusals above should make impossible), none of them is read, whatever interval each is polled at: each comes back bad with `two points have the same stable address ...`, and the usual `points.bad` event shows it. The other points of the source are read as usual.

**How a reading could land on the wrong point, and what stops it.** A reading lands on a point by the stored address the poll asked for. That can go wrong in exactly three ways. (1) The stable rule gives two different tags one string, which can only happen on a server where ids that differ only in the number are different nodes: the option is a person's choice, Test compares both forms on real tags, and the rule's tests prove that two ids which differ in more than the number never become one. (2) One stable id is sent for two stored points and its value written to both: the read sends neither, and the refusals above stop the state from being made. (3) The server resolves a stale numbered id to another tag, which is what the option exists to avoid: with it on, the number is never sent. A place that compares addresses differently from the read would attach a mapping to the wrong point, so the read, the browse, tag lists, file imports, the connection check, Discovery and the mapping refusals all take their key from one function (`opcua_ids.address_key_for`, see [Adding a connector](adding-a-connector.md)). Moving a source to a new address ([Devices that move](devices-that-move.md)) compares stored addresses as they are, with or without the option. Nothing here changes a stored reading, a mapping's point or a figure.

### `ns=3` stays in every address

The namespace index (`ns=3`) is stored in every address as the browse gave it, with or without the option, and a server is not guaranteed to keep its namespace indexes either (the connection check's Namespaces step shows the server's table). Resolving the index through the server's namespace URI is not built yet.

### Ask OT to read three ids

The deciding test needs only an OPC UA client and read access, and it answers the question for your SCADA. For one tag that changes slowly (a kWh counter is a good choice), read these three ids a few seconds apart and compare:

1. the id as the browse shows it: `ns=3;s=20403:Site.PDUA01_PM0_P`;
2. the same tag with a deliberately wrong number: `ns=3;s=1:Site.PDUA01_PM0_P`;
3. the bare form: `ns=3;s=Site.PDUA01_PM0_P`.

If 1 and 3 give the same value, the stable form reads the tag. If 3 is unknown, do not turn the option on. For 2, the server answers `BadNodeIdUnknown` (a stale number fails loudly), or it gives the same value as 1 (it ignores the number), or it gives another tag's value (it resolves by position, and without the option a renumbered SCADA would put the wrong tag's value on a point). Send the three answers back; they are question 28 in [Historian integration](historian-integration.md#f-about-the-scada-itself). The Test button of the platform does the first and the third read for you.

## Reads in slices

A source's mapped tags are read in groups by mapping interval. For an OPC UA source the poll now sends a group in Read requests of at most 200 nodes, one after another inside the one session of that read; before w34 it sent a group of any size in a single request. This applies to **every** OPC UA source, with the option on or off.

- **The server's limit.** The first time a poll group reads, the connector asks the server for its `MaxNodesPerRead` (one extra Read of one node) and remembers the answer for as long as that poll group lives, so a restart of the collector asks again. The slice is the smaller of that limit and 200; no limit (0), or a limit the server will not tell, gives 200. The connection check uses the same rule with a cap of 100.
- **A server that refuses.** If a slice is answered with `BadTooManyOperations` (the server advertises a bigger limit than it accepts, or none), the same nodes are sent again as two requests of half the size, once, and the smaller size is kept for every later slice and poll. The size kept is half of the slice that was refused; when the refused slice is a short tail that follows slices the server answered, it is half of the size in use instead, so one refused tail does not cut the size down to the smallest. A slice is never halved below 10 nodes, so a server whose limit is below 10 cannot be read: the error then ends `a request is never split below 10 tags, so a server limit below 10 cannot be used` (only when no request of that read was answered; a request of 10 tags or fewer that is turned away after the server answered another one in the same read fails with `the server refused a read of N tags after answering a read of M tags (BadTooManyOperations)` instead, which claims no limit). If the halves are refused too, the read fails with `the server refuses reads of N tags at once (BadTooManyOperations)` and the source shows that as its error. A slice that the server answers with more or fewer values than it was asked for fails the read at once with `the server answered N values for M tags`: no value is filed under the address of its neighbour.
- Any other service error in a slice fails the whole read, as before, and the source goes offline until a read works.

So 450 mapped tags on a server with no limit are three Reads (200, 200, 50) plus the one Read of the limit; the requests an hour for a whole server are in the tables of [Historian integration](historian-integration.md#the-live-poll).

## The browse at scale

The browse used to ask the server one question per node, four or more for every tag. It now fetches the tree level by level: one Browse request for up to 200 folders at a time, following every continuation point (BrowseNext) a server returns and releasing what is left if a request fails, then reads the display names of the variables, and then their units, in requests of up to 200 nodes. A server that refuses 200 at once is asked for half. What it finds is the same as before, entry for entry and in the same order.

Measured on this machine (a laptop under WSL2, 2026-10-23, with the platform's SCADA-shaped test server of 15,000 tags that all carry a unit, which is the worst case; server and client in one process over the loopback, so network time is not in these numbers):

| | before (one node at a time) | after (level by level) |
|---|---|---|
| Browse requests | 15,060 | 78 |
| Read requests | 60,059 (one node each) | 225 (up to 200 nodes each, 45,000 nodes in all) |
| Seconds for the whole browse | 48.0 | 2.3 |

On a plant network each request also costs a round trip, a few milliseconds up to tens of milliseconds, so about 75,000 round trips against about 300 is the difference that matters there; the seconds above only show what the requests themselves cost. The test server has no continuation points (the library's server cannot send them), so the paging is tested with a fake server only, not against a real one. After a browse, Sources says `found 15,180 points`, and with the option on, when tags were left as they are because more than one point or server node has the same stable address, `found 15,180 points; 3 tags were left as they are (more than one point or server node has the same stable address)`.

## Mapping intervals for tags that change about once a minute

> **Warning: 60 s for kWh counters; 30 s or less for kW, never 60 s.**
> A mapping's timer waits its interval after each read, so a 60 s mapping really reads every 61 to 63 s. For a power tag (kW) on its own the energy estimate counts the minutes of the hour that hold a sample, so one to three empty minutes in an hour make the estimate **2 to 5 percent low** (computed from the code, not measured). A kWh counter is not affected: an hour is the last value minus the previous hour's last value. The defaults are 60 s for a kWh counter and 5 s for every other metric; they do not change here, and 5 s is safe for kW although it stores about 13 rows for each real change of a tag that changes every 64 s.

The platform stamps every value with its own clock when it reads it, not with the source's time. A fix for the timer and the coverage rule is on the backlog, not built.

## Rehearsing it on the SCADA-shaped test server

The platform's simulator can play a SCADA the way the real one behaves, so everything above can be tried without the SCADA. It is a second OPC UA server in the simulator process, in the dev profile only, and it **does not exist unless `SIM_SCADA_PORT` is set**. `compose.yaml` passes none of the `SIM_SCADA_*` settings (like `SIM_FAULT_*`, they are not for `.env`), so set them in a scratch override file for the simulator service and recreate it:

    services:
      simulator:
        environment:
          SIM_SCADA_PORT: "4850"
          SIM_SCADA_PDUS: "200"
          SIM_SCADA_BRANCH_TAGS: "4190"

    docker compose -f compose.yaml -f scada-override.yaml --profile dev up -d --force-recreate simulator

Add an OPC UA source with the endpoint `opc.tcp://simulator:4850/plantscada` and security policy `none`. The example above is 15,000 tags (400 meters of 27 tags, 10 incomers and 4,190 branch tags); starting such a server takes about 10 to 14 seconds. **Map by shape** is how to try it: browse the source, then decide its 29 shapes instead of its 15,000 points ([Mapping a large source by tag shape](mapping-large-sources.md)). A name that starts with `SIM_SCADA_` and is not in the table, or a value that is not honoured, stops the simulator at start with a sentence, so a typo never runs the rehearsal with the defaults.

| Setting | Default | What it does |
|---|---|---|
| `SIM_SCADA_PORT` | none (no SCADA server) | the OPC UA port, 1 to 65535 |
| `SIM_SCADA_PDUS` | 24 | meters per feed (0 to 200): feed A and feed B each get this many, so 24 gives 48 meters of 27 tags plus 10 incomers, 1,306 tags |
| `SIM_SCADA_BRANCH_TAGS` | 0 | extra branch tags `PDUAnn_Q<k>_P`, 0 to 20,000 |
| `SIM_SCADA_SEED` | 1 | values and each tag's own update clock are a function of it |
| `SIM_SCADA_RESTRUCTURE` | none | `bad`: an extra equipment folder shifts the numbers and an old numbered id answers `BadNodeIdUnknown`; `by_index`: an old number reads whatever tag holds it now (the worst case) |
| `SIM_SCADA_MAX_NODES_PER_READ` | 0 (no limit) | a Read of more nodes is refused with `BadTooManyOperations` |
| `SIM_SCADA_ADVERTISED_MAX_NODES` | the limit it enforces | what `MaxNodesPerRead` says, so a server can advertise more than it accepts |

What it plays: the cluster is called `Site` (a placeholder, not a real name); tags are `Site.PDUA01_PM0_<metric>` with 27 metrics per meter, in folders `Objects/Site/<equipment>`. A Browse answer shows `ns=3;s=<n>:Site.<tag>` with n counted from 20000 in the order of the simulator's tag list (feed A meters, feed B meters, branch tags, incomers), not in the order of the folders, while Read and Browse accept the stable id or the current numbered id. Each tag updates on its own clock of 64 to 76 seconds plus one 4-second grid step of jitter, so the gap between two updates is 60 to 80 seconds, about a quarter of the updates repeat the previous value, values are 32-bit floats widened to doubles, and the kWh counter `PENRG` starts near 3.1 million kWh and moves in steps of 0.25 kWh. Its source timestamp is the tag's own update, while the platform still stamps its own clock. **The folder layout, the names, the units and the numbers are guesses** from a forum answer and from what is known about the SCADA's shape; the server is a model of the trouble, not a copy of a product. The tests that use it are in `backend/tests/test_simulator_scada.py`.

Related: [Sources and discovery](sources-and-discovery.md), [Historian integration](historian-integration.md), [Adding a connector](adding-a-connector.md), [Field debugging](field-debugging.md), [Devices that move](devices-that-move.md)
