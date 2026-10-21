# Historian integration

This page is for the IT and OT people who decide whether the platform may read from a Historian. It says what the platform sends, how often, and what it does when something fails. It lists the questions we need answered, and the alternative if no connection into OT is allowed. Each number says whether it is computed from the code or measured against the platform's own stand-in Historian.

In short: the platform only reads (the connector code has no write call). It needs one read-only account and one firewall rule, from the machine that runs the platform to the Historian, one TCP port, outbound, with TLS if the Historian offers it; nothing connects in. No real Historian's history can be read yet: that needs a connector for its product, written after your answers. If the Historian speaks OPC UA, today's OPC UA connector reads its current values only. The load is set by each tag's polling interval, which can be raised to fit what you accept.

## What the platform does to a Historian

### It only reads

The connector interface has test, browse, read (current values), read history, check, probe and close, and no call that writes ([Adding a connector](adding-a-connector.md)). The simulator connector sends GET requests; OPC UA sends Browse and Read services plus the session set-up; Modbus TCP sends register reads (function codes 3 and 4) and device identification (43/14). After a full fill in the measurement below, the stand-in's own request counter listed only `GET /history` and, for the live poll, `GET /read`. A test fails if the fill ever calls browse, test, check or probe.

### The live poll

This is the steady load. For every enabled source the collector reads its mapped tags (never an unmapped one), grouped by mapping interval. Each group has its own timer and sends one read per interval. The groups run side by side with the history fill, so a Historian can see one request per group plus one history request at the same moment. The interval is set per mapping; when none is set it is 60 seconds for an energy counter (kWh) and 5 seconds for every other metric, power included.

One read of a group sends, with the simulator connector, one `GET /read` for every 200 addresses; with OPC UA, a new session and one Read for the whole group (the code sets no limit); with Modbus TCP, a new connection and one register read per register block that holds a wanted address. The rule for a new connector is at most 200 addresses in a request, and the table assumes a Historian connector keeps it. Requests an hour (at most; computed, not measured) = tags ÷ 200, rounded up, × reads an hour, added over the groups:

| | every tag every 60 s | every tag every 5 min | defaults (kW 5 s, kWh 60 s) |
|---|---|---|---|
| 217 meters, 434 tags (a kWh and a kW tag each) | 180 | 36 | 1,560 |
| 2,000 meters, 4,000 tags | 1,200 | 240 | 7,800 |

The history fill comes on top. The interval can be set per mapping to whatever you accept (question 17).

After a failed read the wait doubles with each failure in a row, from twice the interval up to 60 seconds, and is never shorter than the interval (a 5-second group waits 10, 20, 40, then 60 seconds). Nothing is queued, so there is no burst when the Historian returns. A request unanswered within the source's timeout (5 seconds by default, 3 for Modbus) counts as failed. The collector log gets one warning when a source goes offline, not one per read; the journal records going offline and coming back.

### The history fill

The collector also fills gaps from the Historian's own history. It is automatic; nobody starts it.

| | |
|---|---|
| Which sources | enabled, with at least one mapped tag and a connector that can read history |
| When | the first cycle 10 minutes after the collector starts, then 10 minutes after each cycle ends (`DCDASH_HISTORY_EVERY`, in seconds; zero or less switches it off) |
| Each request | a GET for the raw samples of a time range: at most 200 addresses and 20,000 expected rows (`DCDASH_HISTORY_MAX_ROWS`) |
| Pace | one request in flight per source, at most 30 a minute (`DCDASH_HISTORY_RATE`) |
| Which period | from 7 days back (`DCDASH_HISTORY_LOOKBACK_DAYS`) and never before a tag's first reading, up to one mapping interval and a minute before now |
| Asked twice | each hour once as it arrives, and once more 3 hours later for late values (`DCDASH_HISTORY_REREAD_HOURS`) |

A tag mapped every 5 seconds counts 720 expected rows an hour, so about 27 of them fit in a request, against 200 for a tag mapped every minute (computed from the code).

| When the Historian | The platform |
|---|---|
| times out, cannot be reached, answers 429 or 503 (the stand-in connector's names for these) or sends an answer it cannot read | asks the same thing again after about 30 seconds, then 60, then 120, or after its `Retry-After` when that is longer (at most 15 minutes). After the fourth failure the cycle ends and the source is left alone for at least 4 minutes, then 8, then 15, for as long as it keeps failing. The loop looks again at its next 10-minute turn |
| sends a `Retry-After` above 15 minutes | ends the cycle at once; the wait it asked for (up to a day) becomes the time of the next try |
| refuses the credentials, or has no history interface | leaves the source alone for 15 minutes, or for a day |

The position reached and the time of the next try are kept in the database, so a restart continues from the saved position (see the numbers below). To switch the fill off, set `DCDASH_HISTORY_EVERY=0` in `.env` and run `docker compose up -d`. A source switched off in the Sources page is not polled and gets no new fill cycle. More: [Operating the stack](operating.md#background-history-fill).

### What reads history today

Only the stand-in Historian does, a test server of the platform's own simulator. The OPC UA and Modbus connectors cannot, and the fill skips them. A real Historian needs a connector written for its product, which is a later piece of work. It must be read-only, return the Historian's own time as UTC with a quality of good or bad, send at most 200 addresses in a request, and report failures with the typed errors the back-off above reacts to ([the contract](adding-a-connector.md#reading-history)).

### What else touches a Historian, and only when a person asks

| Action and permission | What reaches the Historian |
|---|---|
| Test, Test all (`sources.test`) | one connection test per source; Test all does every enabled source. Simulator: `GET /points`. OPC UA: a session and one read. Modbus: a connection and one block read |
| Check connection (`diagnostics.run`) | OPC UA: nine read-only steps (DNS, TCP, endpoints, certificates, session, server time, namespaces, a read of up to 200 mapped addresses, timing). Other types: the single test. One at a time per source |
| Browse (`sources.edit`) | asks for every tag the source offers. Simulator: `GET /points`. OPC UA: walks the whole tree under the root node, several requests per node |
| Discovery scan (`discovery.scan`) | for the addresses and ports of a scope an administrator typed and confirmed: a TCP connection to each pair, closed at once with no data (at most 200 a second); then on each open port every connector's probe until one recognises the service (Modbus: device identification, then, if that gives nothing, a read of register 0; OPC UA: GetEndpoints; simulator: `GET /`). A port nobody recognises still gets all three, so keep a Historian's address out of a scope if that is not wanted. A recognised service that is not yet a source becomes a disabled one, which the scan browses |
| Fill by hand (a shell on the machine) | `docker compose exec api python -m dcdash.ingest.backfill --source N`: a dry run unless `--yes` is added, with the pace and size limits above |
| Fill older range... (`sources.edit`) | the same fill, started by a person for a range of at most 31 days: it reads the same way (the limits above), and only one fill is waiting or running at a time, whichever source |

Nothing else reaches a source: the Diagnostics report only looks up host names in DNS, dashboards, billing and reports read the platform's own database, and only the collector and the fill command open connections to a source.

### When the Historian fails

Both loops wait and retry as above and never flood. No data is lost while the Historian keeps it: when it is back, the fill asks for the missed time from the saved position, up to 7 days back (a fill a person starts, 29 days by default), provided the connector reads history, which only the stand-in does today. The Sources page shows the status offline with the last error (`<status>: <message>`, such as `timeout` or `auth_failed`). The Diagnostics report adds a `history:` line per source (state, answered through, counts, next try, last error) and the journal.

### The account, the firewall rule and the credentials

- **Account.** One read-only account: the right to read the values and the history of the mapped tags, and no right to write, acknowledge or configure.
- **Firewall.** From the machine that runs the platform to the Historian's address, one TCP port, outbound only; the Historian never connects to the platform. A source set up by host name also needs DNS for it.
- **Encryption.** TLS where the Historian offers it. The HTTP connector accepts an `https://` URL and the code does not turn certificate checking off; OPC UA can sign and encrypt (`basic256sha256`); Modbus TCP has none. Over plain `http://` the key travels in a header in clear text.
- **The credential.** Typed once in the source form and stored encrypted with `DCDASH_SECRET_KEY` from `.env`. `.env` is not in the database backups, so a backup alone cannot be decrypted; anyone holding both can. The web app only tells whether a secret is set. The audit log records "set" or "changed", never the value. Log lines are scrubbed of URL credentials; job results and journal text are scrubbed of those and of the source's known secret values.

### The numbers

Measured against the stand-in with 217 meters (449 tags: a kWh and a kW tag per meter plus 15 test tags), each tag mapped at the stand-in's own interval, a minute for the meters. The times were taken while other heavy jobs ran on the same machine and are pessimistic by a factor of about 2 to 4; the request and row counts do not depend on load.

| Measure | First fill, 6.5 days | Afterwards, at the default pace |
|---|---|---|
| Requests (all `GET /history`) | 322 to 327 | 6 per cycle (3 for the new window, 3 for the second look) = 36 an hour |
| Rows received | 4,229,490 (about 92 bytes each as JSON, about 390 MB) | about 54,000 an hour (5 MB) |
| Time | 18 minutes under load | a few seconds a cycle |
| Failed requests | 0 | 0 |

A stand-in that answered every 5th history request 503 and more than 2 requests in a second 429 still completed a 24-hour range: 10 minutes, 62 history requests, 12 answered 503 and 10 answered 429, each asked again after its back-off, none lost. A restart of the collector in the middle of a fill needed 77 more requests instead of about 125 from the start.

**2,000 meters is an extrapolation, not a measurement.** For 4,000 tags the same rules give a first fill of about 37 million rows (3.4 GB as JSON) in roughly 3,000 requests, at least 100 minutes at 30 a minute, then about 480,000 rows (44 MB) and about 250 requests an hour. With the live poll at a minute, the two loops together send about 216 requests an hour for 217 meters and about 1,450 for 2,000.

## What we need from you

Write each answer next to its question. Nothing here needs a full answer at once; questions 1 to 5 decide the most. [B] marks a question a billing person can answer. [IT] marks one for the network or security people. Every other question is for whoever runs the Historian.

### A. The five from the team meeting

1. What is the Historian's brand and version? Is there API documentation (a PDF, a web page, an SDK) we can read?
2. Can we get a sample extract for 3 to 5 meters covering about two days: the tag names, the values, the units, the timestamps and the quality flags? Remove anything confidential; we only need the shape.
3. [B, partly] Do the LV panels record energy (kWh), or only power (kW)? How long does the Historian keep data (raw, and any summaries)?
4. [IT] Are connections from IT into OT allowed (us asking the Historian), or only connections that go out of OT (the Historian sending to us)?
5. [IT] Where will production run, and who maintains it (patches, backups, restarts)?

### B. How the Historian stores the numbers

6. Energy: is it a running total that only goes up (a counter, like a car's odometer), or the energy of each period (for example "kWh in these 15 minutes")?
7. If it is per period: is the timestamp the START or the END of the period?
8. Does it store a value at a fixed interval (every minute, every 15 minutes), or only when the value changes by more than some amount (a deadband, or "compression")? If on change, what is the deadband for kW and for kWh?
9. Timestamps: in UTC, or in local time? If local, which time zone, and how does it handle the hour that repeats when daylight saving ends?
10. Quality flags: what is the full list (for example good, uncertain, bad, substituted, interpolated, manual entry)? Which of them would you trust for a bill?
11. Counters: when a meter is replaced or reset, or rolls over at its maximum, how does that show in the data? Is there a record of meter replacements?
12. Units: is the unit stored with each tag (W, kW, Wh, kWh, MWh)? Can a tag's unit or scale ever change?
13. Tag naming: do tag names tell you the hall, row, rack, panel and feed? Is there a list of all tags with their descriptions and units (a CSV is ideal)?

### C. How we would ask it

14. Which interface do consumers use: a REST or web API, OPC UA (with history access, HDA), ODBC or SQL, a vendor SDK, or file exports?
15. Can it return the raw values for a time range? Can it also return an hourly summary computed on its side (the last value of each hour for a counter, the average for kW)? Does it interpolate or time-weight values when you ask for a fixed step?
16. What are the limits per request: the most tags, the longest time range, the most values returned? Does it page large answers?
17. Is there a rate limit (requests per second or per minute)? What load is acceptable to you? The tables above show what the platform sends by default; the interval of every mapping can be raised to fit your answer.
18. How late can data arrive? Can a value for 10:00 appear only at 11:30 (a buffered field device, a store-and-forward link)? Can a stored value be corrected later, and if so, how would we see that?
19. Does the current value (the "live" reading) carry the Historian's own timestamp, the same one the history will show later?

### D. Access and approval

20. [IT] Authentication: a read-only user and password, an API key or token, a client certificate, or Windows (Kerberos) sign-in? Who issues it, and how often must it be renewed?
21. [IT] The network path: the Historian's address and port, whether the connection is encrypted (TLS), and the one firewall rule needed (workstation to Historian, that port, nothing else).
22. [IT] Is there a test or staging copy of the Historian we could use first, so we never touch production while we build?
23. [IT] Governance: who approves the read-only account and the firewall rule, and what do they need from us beyond this page?

### E. Billing

24. [B] How long must the readings behind a bill be kept, and must they be the raw values or are hourly totals enough?
25. [B] When the Historian corrects a value after a month was billed, what should happen: nothing (the bill stands), a note on the month, or a re-bill?

## If a connection into OT is not allowed: Option 2, files

If no connection from the platform into OT is allowed, readings can be loaded from a file that someone exports from the Historian and hands over. This needs no connection to anything in OT: the collector never polls a source of the file type, the web app offers it no Test, Check connection or Browse, and Test all leaves it out.
A file goes in by hand: a person with the permission `readings.import` uploads it in the Sources page, or an administrator runs `docker compose exec -T api python -m dcdash.ingest.importer --source 3 --profile-name hourly - < export.csv`. Both start as a dry run that reads the whole file and reports what a real import would store, without storing anything; the real import is a second, explicit step (`--yes` for the command). A script that uploads with `curl` needs `-H 'Content-Type: text/csv'`. There is no scheduled or automatic ingest of an export; a watched folder would be a later, thin addition if this option is chosen.

**What an export must contain.**
One line per reading under a header line that names the columns: the tag (the Historian's own name, matching exactly, capitals included, the address of a point of the source it is imported into; an import never creates points or mappings, and it counts the tags it does not know and lists the first 20), the time and the value, and optionally the unit and a quality.
The time is ISO 8601 with a zone or offset (`2026-10-19T12:00:00Z`), seconds or milliseconds since 1970, or a pattern the profile spells out (such as `%d.%m.%Y %H:%M`); a time with no zone needs the profile to name one (such as `Europe/Berlin`) and is rejected with a reason when it does not. A local time that does not exist, or that cannot be told apart from its repeat when the clocks go back, is rejected. A unit that disagrees with the mapping is rejected (it is only compared, never used to convert). A quality code that the profile does not list as good (`good` by default; an empty cell counts as good) is stored as bad quality and left out of every figure.
A profile, saved on the platform (up to 20), names the columns, the delimiter, the decimal mark, the time format and zone, the codes that count as good and whether the value is a running total, a power or an energy per period (then it also gives the period and whether the time marks its start or end). Energy per period (not a running total) must not be mapped as an energy counter: the import refuses the rows of a point mapped that way, and the meter kind that sums periods is not built yet.
The limits are 20 MB, 500,000 rows, 4,096 bytes a line and UTF-8 (another encoding is refused with a sentence that says to save it as CSV UTF-8), and one check or import runs at a time. A row older than the raw retention less a day (29 days by default), or more than five minutes ahead, is rejected and counted.

**When a file is sent again.**
The first value stored for a tag and a time wins and nothing is stored twice: a row that repeats a stored value is counted as already there, one with another value or quality as differing (the stored reading stays, so a value the Historian corrects later is not applied), and a second copy of a tag and time inside one file is rejected (the first is used). A missed export is therefore covered by sending that file again, or a larger one that includes the period, as long as the period is inside the window above.
After an import the summaries over the hours it filled are refreshed, so the figures follow: the import does the hours older than about a week itself, right after storing them, and says so if it could not; the platform's own schedule does the newer ones. Readings loaded into a closed month are stored and its frozen figures do not change; the report names the month. Each real import writes an audit row (the account for an upload, `command` for the command; the source, the profile, the file's SHA-256 and size, the counts; never the values).

## The first real test

For the day the sample extract (question 2) arrives. Nothing here connects to the Historian. Sign in as an administrator.

**In the web app**

1. **Add the source.** Sources, Add source: a name and the connector `file` (it has no address to fill in), Save.
2. **Map the tags.** Write a tag list from the extract: a header line, then a line per tag. `tag` is spelled exactly as in the extract. `asset` is a path of names (`Hall 1 / Row A / Meter 01`; one that exists is reused). `metric` is what it measures, such as `energy_kwh` or `active_power_kw` (the dialog lists them all). `unit` is Wh, kWh or MWh for energy and W, kW or MW for power (the other metrics take their own unit only). `kind` is the kind of a new asset. Three lines:

       tag,asset,metric,unit,kind
       M01.kWh,Hall 1 / Row A / Meter 01,energy_kwh,kWh,meter
       M01.kW,Hall 1 / Row A / Meter 01,active_power_kw,kW,meter

   Row menu **Map tag list...**: paste the list, tick "Create missing assets" if the assets are new, press **Check list**. The report shows what would be created and the problem lines by line number; with any problem nothing is created, so fix the list and check again. Then **Create N mappings**. A toast offers **Undo** for 10 seconds, the Audit page for 24 hours: it removes the mappings, assets and points the list made, except a point that holds readings, and refuses, with a sentence, if something it made was changed since (a changed kind, icon or sort order is not noticed).
3. **Import the readings.** Row menu **Import file...**, pick the extract. Describe its layout once as a profile and save it under a name: the headings of its tag, time and value columns (and unit and quality, if any), the delimiter and decimal mark, the time format (and the zone's name, such as `Africa/Cairo`, for times with none), what the value means (a running total and a value at one moment are read alike; a total for one period needs its length and whether the time marks its start or end), and the quality codes that count as good if not `good`. **Check file** stores nothing and says `N rows read, N new, N already there, N differing, N rejected, N unknown tags`. New will be stored. Already there is stored with the same value. Differing is stored with another value or quality, which stays. Rejected: the first 20 are listed by line with a reason; fix the profile or the file and check again (an import stores the rows that pass). Unknown tags are not points of this source and an import never creates one: map a second list of only those, or leave them out. Rows of a quality that is not good are stored as bad quality and count in no figure; if the report puts most of the file there, the good codes are wrong, so fix them first, because a later import does not replace a stored reading. Then **Import N rows**. Check the same file again: it says `0 new`.
4. **Look at the result.** Billing, **Check month** for the month the file covers, then the page of one meter's asset: compare a figure with the Historian's own. Bad-quality rows count in no figure, a closed month keeps its frozen figures, and the summaries over the imported hours refresh by themselves.

**With the command** (the laptop's copy-and-paste loop). Map the tags in the web app as above, then in the project folder (`3` is the source's number, shown before its name in the Diagnostics report):

    docker compose exec -T api python -m dcdash.ingest.importer --source 3 --profile-name hourly - < export.csv

In PowerShell, which has no `<`, run it inside `cmd /c "..."`. Without `--yes` it is a dry run: it prints the sentence and the first 20 rejected lines and writes nothing. `--yes` imports. `--profile-file` (a JSON file of the profile's fields, inside the container) replaces `--profile-name`. `--refresh`, with `--yes`, repairs an import that was cut short: run the same file again with `--yes --refresh`. Exit codes: 0 done or checked, 1 refused or failed, 2 bad arguments or profile, 3 another import is running. Paste back the command, everything it printed and the exit code, never the file or a value from it.

**For a script**, sign in once (`POST /api/login`, JSON with the user name and password) and keep the session cookie, then send the file as the body. A real import adds `dry_run=0` and the check's `sha256` as `expect_sha256`:

    curl -b cookies.txt -H 'Content-Type: text/csv' --data-binary @export.csv 'https://HOST/api/sources/3/import?profile=hourly&dry_run=1'

Related: [Sources and discovery](sources-and-discovery.md#history-and-backfill), [Adding a connector](adding-a-connector.md#reading-history), [Operating the stack](operating.md#background-history-fill), [Field debugging](field-debugging.md)
