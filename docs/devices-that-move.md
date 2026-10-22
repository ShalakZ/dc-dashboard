# Devices that move or disappear

This page is for the person who runs the platform and watches Discovery and Sources. It answers three questions: what a scan does when
a device is not where it was, what the platform does when the same device turns up at another address, and what you do about each.
It covers OPC UA servers and the DCDash simulator; a Modbus device has nothing to recognise it by, which is explained
[below](#how-a-source-knows-its-server). The screens are described on [Screens](screens.md); scans, scopes and mapping are on
[Sources and discovery](sources-and-discovery.md#discovery).

## What a scan does and does not do

A scan looks at the addresses and ports of its scope, asks every open one what it is, and for each server it recognises it either
finds the source that already points at that address or makes a new source for it (named `OPC UA server at 172.20.0.5:4840`) and
browses its points. Sources are matched **by address** (host and port), never by name.

- A scan **only adds**. It never removes a source, a point or a mapping, and it never changes the address of a source.
- So a device that is gone leaves its old source behind, and a device that turned up at a new address gets a second, new source
  beside the old one. That is what Discovery then shows: the old items next to the new ones.
- **Seen in scan #6, 10 min ago** on a source means the newest scan that found a server at that source's address was scan #6.
  **Added by hand** is a source you made yourself on Sources: a scan reports it as an existing source and leaves it alone. **Not seen
  in a scan yet** means no scan has found it.
- A closed port leaves no trace. Whether a later scan looked at an old address depends only on that scan's scope, which is why the
  next section compares scans of the same range and nothing else.

## Not seen and Remove not seen

A source is marked **Not seen** when a later scan of the same range looked for it and did not find it. All of this must hold:

- the source was found by a scan (a source added by hand is never marked) and has been seen at least once;
- there is a later scan that finished (a failed, queued or running scan does not count) with the same targets and the same ports as
  the scan that last saw the source. Each scan keeps its own copy of its scope, so editing or deleting the scope afterwards changes
  nothing. A scan of another range, or with a different list of ports, never marks anything: it did not look;
- that later scan found nothing at the source's own host and port. (A source added by hand at the same address takes the finding, and
  then the discovered copy reads as seen.)

The mark clears by itself when a later scan of the same range finds the server again.

**What you see.** The card is drawn quieter (a lighter ground and a lighter dashed edge; the text does not change). Its last line reads
`Not seen in scan #7 (last seen in #5, 4 days ago)`, with the same sentence in the tooltip, and the Details panel says it in full.
**More Discovery actions** gains two items:

- **Turn on Not seen lately** shows only the marked sources on the canvas (the same item turns it off again).
- **Remove not seen (3)...** removes the marked sources that have nothing mapped. It asks first, in the same dialog as **Clear
  unmapped**: it names the first five sources and how many more, and it sends exactly that list to the same removal. The server leaves
  alone every source that has a mapped point and every source added by hand, and refuses while a scan is queued or running.

Both items need `discovery.edit` and appear only while at least one source is marked. A marked source that has something mapped is
never removed this way: its card says `Mapped: move it or delete it on Sources`, because a mapping is work that billing may rest on.
Either the device moved (see [When a move is offered](#when-a-move-is-offered)) or you delete the source on Sources after checking
what depends on it. Removing a source only takes it off Discovery: a scan finds the device again if it is still there.

## How a source knows its server

A source remembers who its server is in one small record. Nothing in it is secret: the strings the server announces about itself, and
the thumbprint of its certificate (never the certificate, never a password). The Details panel of a source on Discovery shows it as
`Server: urn:dcdash:simulator:dev` and `certificate 3A:5F:...:91` (the first five and last two characters; resting the pointer on it
shows all of it). Sources made before this update know nothing yet.

**When it is learned.** A scan that meets the source, **Test**, and **Check connection** (when the server answered) ask the server who
it is and remember the answer. The normal polling never does. So after an update, run a scan or **Test all** once while everything is
up; a source that has not been reached since then still gets a move offer, but only the weaker kind (**possibly**, below).

**OPC UA.** The platform asks the server for its list of endpoints (no login needed) and keeps its **application URI** (the name the
server gives itself, such as `urn:plant:line1:scada`), its application name, its product URI and the **thumbprint** of its certificate
(the SHA-1 of the certificate, as pairs of hexadecimal digits separated by colons: the number OPC UA tools show). The application URI
is what two servers are compared on.

- **A default URI identifies nothing.** Much OPC UA software ships with a URI that every installation shares until somebody changes it:
  `urn:freeopcua:python:server`, `urn:open62541.server.application`, `urn:unconfigured:application`, or none at all. Such a URI is
  stored and shown but never used to say that two servers are the same one. The same holds when a source at a third address reports
  the very same URI: a URI that several servers share is no identity.
- **A renewed certificate is a renewal.** The same URI with another thumbprint, seen at the source's own address, is stored and
  recorded once in System events as `The server's certificate changed`. Nothing else happens.
- **A server that makes a new certificate at every start** (for example the simulator with `SIM_FAULT_POLICIES=basic256sha256`) has a
  new thumbprint after every restart. The move rule is that two different certificates never match, so such a server is moved by hand:
  edit its address on Sources.

**The simulator.** The HTTP simulator announces its **instance id** on `GET /`, and its OPC UA server announces the application URI
`urn:dcdash:simulator:<id>`. The id is `SIM_INSTANCE_ID` (default `dev`; see [The simulator](install-and-run.md#the-simulator)); it
stays the same when the container is recreated, which is the point. The stand-in Historian announces `<id>:historian`, so it is not
taken for the plain simulator. Two simulators left at the default `dev` are the same server as far as the platform can tell, so a
second stack on the same network needs its own value.

**Modbus has no identity.** A Modbus device answers to an address, a port and a unit number, and nothing tells one device from
another of the same make. The platform never offers to move a Modbus source. **Give Modbus devices fixed addresses** (a reservation
in the DHCP server or a fixed address on the device), and when one does change, edit the address on Sources.

**When a different server answers at a source's address.** If a scan, a Test or a connection check finds a server with another
identity where a source remembers one, the source **keeps** what it remembered and keeps polling: stopping a meter's readings because
a certificate was renewed would be worse. Instead, its Discovery card and panel say `A different server answers at this address`, and
System events gets a warning of the same name that says who it used to be and who it is now (at most once a day for each other
server). A scan does not refresh the points of a discovered source in that case, because they would come from the wrong server.

## When a move is offered

Two sources are involved: the **old** one, which has mappings and stopped answering, and the **new** one, which the scan made for the
address where the same device turned up and which has nothing mapped. The platform offers to move the old source's address to the new
one only when everything below holds. It never moves anything by itself.

**The old source.** It is an OPC UA or simulator source with at least one mapping, its status is offline, and either its last failure
was that the server did not answer at all (unreachable or timeout, not a refused login) or Discovery marks it Not seen.

**The new source.** A scan found it, nothing is mapped on it, it holds no readings, and it has the same protocol, the same port and the
same OPC UA path as the old one. It must have first appeared in a scan that started after the old source's last answer, so a neighbour
that was already there is never offered. The path is compared exactly, except that an empty path and `/` are the same; a source typed
by hand as `opc.tcp://host:4840/dcdash` (no closing slash) is therefore never offered, because the scan finds `/dcdash/`.

**The evidence**, one of two kinds:

- **Same server.** Both sides remember a usable identity and it is equal (the same application URI, or the same simulator instance
  id), and when both have a certificate the thumbprints are equal. When one side has no certificate, the identity is only a claim: the
  move then says `It is identified by its application URI only.` (for the simulator, `by its instance id only`), needs the tick `I
  checked that this is the same server`, and every (address, point name) pair mapped on the old source must exist on the new server.
  With equal certificates a few missing pairs are only a warning.
- **Possibly the same server.** The old source remembers nothing (every source made before this update, until it is reached again).
  Then the new server must have **every** address mapped on the old source **with the same point name** (numeric node ids repeat
  across servers of one make, so the address alone proves little), and you must tick `I checked that this is the same device`.

**Never:** a different application URI or instance id; different certificates; a default URI as the only evidence; an old source that
remembers a server while the new one says nothing; a name (two sources with equal names and different servers never match); a Modbus
source. And **never two candidates**: if two servers could be the old source, or one new server fits two old sources, nothing is
offered and the card says `Two servers could be this one; edit the address by hand`.

A source whose address is a host **name** (such as `opc.tcp://simulator:4840/dcdash/`) is matched by the scan at wherever the name
resolves now, so it follows its container by itself, never goes offline for that reason and is never an old source.

**Where it shows.**

- **Sources.** The offline banner names the offer: `1 source is offline: OPC UA server at 172.20.0.3:4840, for 4 d 2 h (since 18 Oct
  07:52): Connect call failed ('172.20.0.3', 4840). A scan found it at 172.20.0.5:4840:` followed by the button **Move to new address...**.
  With several offline sources the banner says for how many a scan found a new address and sends you to the row menus. The first item
  of the row menu of such a source is **Move to new address...**. A person without `sources.edit` reads the same sentence and has no
  button.
- **Discovery.** The new source's card says `Looks like OPC UA server at 172.20.0.3:4840` and has a **Move...** button beside
  **Details**; its panel says `This looks like OPC UA server at 172.20.0.3:4840 (12 mappings on 3 assets), which stopped answering at
  172.20.0.3:4840`.

## The preview and the move

**Move to new address...** opens a dialog that asks the server what the move would do (a dry run: nothing is written) and shows:

- `From opc.tcp://172.20.0.3:4840/dcdash/ to opc.tcp://172.20.0.5:4840/dcdash/` (never a user name or password);
- why the platform thinks it is the same server, in words;
- what else happens: the mappings keep their points and readings, the new source the scan made is removed, and whether the name
  changes;
- a warning when the new server lacks some of the old source's addresses (their values read as bad until they exist), or the note that
  the new address could not be browsed without credentials and the source's own credentials will be used;
- the tick, where one is needed. The only way on is the button **Move 12 mappings**.

While a scan is queued or running the dialog says `A scan is running; you can move when it has finished`, keeps Move off and asks again
every few seconds.

**What the move changes**, in one step:

1. Only the **host and port** inside the old source's own address are replaced. The user name, the password (the source's secret), the
   path, the security settings and every other setting stay exactly as they were.
2. The old source takes over the new server's identity.
3. The new source the scan made is **removed**, with its points (none of them was mapped) and its place on the Discovery canvas. Its
   scan findings now belong to the old source, so Discovery shows the old source as seen in that scan.
4. The name. A name that is the scan's default name for the old address (`OPC UA server at 172.20.0.3:4840`, with or without a
   ` (2)`) becomes the default name for the new one (`OPC UA server at 172.20.0.5:4840`). A name a person typed stays.
5. The collector is told at once and polls the new address.

The points, the mappings and the readings keep their ids, so assets, dashboards and bills do not notice. The hours the source was
offline stay a gap in OPC UA and Modbus data; only the HTTP simulator can fill a gap from the server's own history
([History and backfill](sources-and-discovery.md#history-and-backfill)).

**What the server checks again** when you press Move, under locks and on its own data, never on what the dialog remembers: no scan is
queued or running; the mappings, the two addresses and the new name are the ones the preview showed; the old source is still offline;
the new source still has nothing mapped and no readings; it is still the one match; the move was not already made. Anything else is
refused with a sentence, the preview is shown again, and nothing is changed.

**Who.** Moving and the Undo need `sources.edit`, which already allows editing and deleting any source; there is no separate
permission. See [Roles and permissions](roles-and-permissions.md). One audit entry is written, `Moved OPC UA server at 172.20.0.5:4840
from 172.20.0.3:4840 to 172.20.0.5:4840 (12 mappings kept, the duplicate removed)`; a possible match adds how it was recognised.

## Undo

The toast after a move has **Undo** for 10 seconds, and the audit entry has **Undo this move** in its drawer for **24 hours**. Undo
puts the old host and port back inside the source's current settings (credentials and secret stay), and restores the name and the
identity. It writes its own audit entry (`Undid the move of ...`).

- It does **not** bring the removed duplicate back. The next scan finds the new address again and makes a new source for it.
- It does **not** undo readings. Readings taken at the new address stay with the source, and the toast says how many when there are any.
- It refuses, in words, when the entry is older than 24 hours, was undone already, the source was deleted, or its address or name has
  changed since the move, and it refuses while a scan is queued or running. After that, edit the address by hand on Sources.

## A name instead of a Docker address

On a Docker network a container gets a new address whenever it is created again, and an update creates all of them again. Its **service
name** (such as `simulator`) always leads to wherever the container is now, so a source configured with the name never goes offline for
that reason. When a scan finds a server at a private IPv4 address, the platform asks the resolver which name leads back to that address.
It offers a name only when looking the name up gives **exactly** that address and no other, trying the shortest candidates first (for
the reverse name `dcdash-simulator-1.dcdash_default`: `simulator`, then `dcdash-simulator`, then `dcdash-simulator-1`, then the full
name). Loopback and link-local addresses get no hint, public addresses are never looked up, a scan looks up at most 50 addresses,
each for at most 3 seconds, and stops asking after four timeouts in a row.

A hint appears only in the move dialog: the choice is `Use the name simulator (it keeps working when Docker gives the container a new
address)`, preselected, or `Use the address 172.20.0.5`. With the name, the source's address text holds `simulator` from then on, and a
default name becomes `OPC UA server at simulator:4840`. When the old source is configured by a name, the dialog says `This source
uses the name ...; the move replaces it with ...`. The hint is only a suggestion; you can ignore it, and you can always type the
service name yourself in **Edit**.

## The risk the other way round

Moving fixes the case where the old address is empty. The reverse case is an old address that **another server of the same
protocol** has taken over: Docker gives an address to a different container, or a device is swapped. The old source then polls the
wrong machine, and if it has the same node ids the readings look plausible.

- For OPC UA the platform notices when a scan, a Test or a connection check reaches that address: the source keeps its remembered
  identity and `A different server answers at this address` appears on its Discovery card and in System events. **Polling does not
  notice**, so the warning comes with the next scan, Test or check; run **Test all** after an update. Read that event before you trust
  the numbers of the source.
- For **Modbus nothing can tell**. The same register at the same unit number on another device is a valid answer. Give Modbus devices
  fixed addresses.

## If no move is offered

| What you see | Usually because |
|---|---|
| The old source is online | There is nothing to move: the old address still answers. A refused login (`auth_failed`) is not "did not answer" either. |
| Nothing mapped on the old source | An unmapped source needs no move: remove it, or let Remove not seen do it. |
| Modbus | Never offered. Edit the address by hand. |
| The new source is missing | The scan did not reach the new address, or its port was not in the scope. Scan the range again. |
| The new source was first found before the old one went silent | A neighbour that was already there is never offered. |
| Another application URI, instance id or certificate | It is another server. |
| `Two servers could be this one` | Two candidates, or one candidate for two old sources. Edit the address by hand. |
| The old source remembers nothing and a mapped address or name is missing on the new server | Possibly needs every address with its name. |
| The paths differ, for example `/dcdash` against `/dcdash/` | Compared exactly (an empty path and `/` are the same). |
| The URI is shared with a source at a third address | A shared URI identifies nothing. |
| The new source has a mapping or readings | It is no longer the scan's untouched copy. |

## Example: the simulator after an update

An update recreated every container, and Docker gave the simulator a new address, `172.20.0.5` in place of `172.20.0.3`.

1. **Sources** shows `OPC UA server at 172.20.0.3:4840` offline since the update, last error `Connect call failed ('172.20.0.3',
   4840)`: another container holds the old address and refuses the connection.
2. A scan of the same range was run. Because a scan matches by address, it made a new source, `OPC UA server at
   172.20.0.5:4840`, and **Discovery** shows the old items beside the new ones. The old source, which has 12 mappings, reads `Mapped:
   move it or delete it on Sources`; the new one reads `Looks like OPC UA server at 172.20.0.3:4840` and has a **Move...** button.
3. On Sources the banner ends `A scan found it at 172.20.0.5:4840:` with **Move to new address...**. The old source was made before
   the update and remembers no server, so this is a **possible** match: all 12 mapped addresses and their names exist on the new
   server, and the dialog asks for the tick `I checked that this is the same device`. It offers the name `simulator` as the default.
4. **Move 12 mappings** moves the source to `opc.tcp://simulator:4840/dcdash/` (or to the address, if that is chosen). The new source
   is removed, the old one keeps its 12 mappings, polls again and turns online, and the toast offers **Undo** for 10 seconds. The source
   now remembers the simulator (`urn:dcdash:simulator:dev`), so a later move would be a **same server** match.
5. The leftovers on **Discovery** (for example the unmapped Modbus and HTTP sources at the old address) are marked Not seen.
   **More Discovery actions**, **Remove not seen**, and confirm. The mapped Modbus source stays: Modbus is never offered a move, so
   edit its address on Sources.
