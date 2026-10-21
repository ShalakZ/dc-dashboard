# Adding a connector

This page is for developers who add a new kind of data source (a protocol). A connector is one Python class: the API uses it to
validate a source's settings and to discover sources on the network, and the collector uses it to test, browse and read. The built-in
connectors are `opcua`, `modbus`, `simulator` and `file` (a source filled by importing files, never polled); what each protocol does for a user is on
[Sources and discovery](sources-and-discovery.md).

## The class

Create `backend/dcdash/connectors/<name>.py` with a subclass of `Connector` (`backend/dcdash/connectors/base.py`) decorated with
`@register`, and import the module in `backend/dcdash/connectors/__init__.py` (importing it is what registers it).
`backend/dcdash/connectors/simulator.py` is the shortest complete example.

| Member | Required | What it is |
|---|---|---|
| `type` | yes | the connector's name, stored in `sources.connector_type` |
| `config_schema` | yes | a pydantic model of the source's settings |
| `test()` | yes | connect and return a `ConnectionCheck` (`ok`, a `status` of `ok`, `auth_failed`, `timeout`, `unreachable`, `protocol_error` or `needs_profile` (Modbus), the latency, a message) |
| `browse()` | yes | the points the source offers, as `PointDescriptor`s (address, name, data type, unit hint) |
| `read(addresses)` | yes | one `PointValue` per address (time, value or `None`, quality `GOOD` or `BAD`, an optional status) |
| `default_ports` | no | the ports a network scan tries for this connector |
| `probe(host, port, timeout)` | no | a `Claim` (a ready source configuration) when the service at that address is this protocol, else `None`; never raises |
| `endpoint_key(config)` | no | host, port and qualifier of the endpoint a configuration points at, so a scan recognises a source that exists already |
| `check(points, publish)` | no | the step-by-step connection check; the default is one step that runs `test()` (OPC UA has its own) |
| `supports_history` | no | `True` when the connector can read a source's history; the default is `False` (see [Reading history](#reading-history)) |
| `polls` | no | `False` for a connector that must never be polled, such as `file`; the default is `True` (see [How the collector uses it](#how-the-collector-uses-it)) |
| `description` | no | one sentence under the type in the Add source form; the default is empty, for a type that explains itself |
| `read_history(addresses, start, end, resolution=None, *, after=None, limit=None)` | no | the samples the source stored between two times, as a `HistoryPage`; the default raises `not_supported` |
| `close()` | no | release connections |

Raise `ConnectorError(status, message)` for a failure, with one of the `ConnectionCheck` statuses. The constructor receives the
validated configuration and the source's secret.

## Rules

- **Read only.** A connector only retrieves data; `probe` may only send requests the connector would send anyway, and must give up
  after `timeout` seconds.
- **The secret is not a config field.** The password or key goes in the source's secret, which is stored encrypted with
  `DCDASH_SECRET_KEY`. A config field whose name looks like a credential (`password`, `secret`, `token`, `api_key`, `credential`) fails
  `backend/tests/test_audit.py`.
- **The form follows the schema.** The Sources form is built from `GET /api/connectors`, which returns each connector's JSON schema:
  one input per field, labelled with the field's `title` (or its name), with its default. Strings, numbers, integers and booleans
  are understood; anything else, an `enum` included, is shown as a text box.
- **The diagnostics report.** Add the connector to `REPORT_CONFIG_FIELDS` (the fields a report may show) and, for fields it must
  never show, to `EXCLUDED_CONFIG_FIELDS`, both in `backend/dcdash/diagnostics/report.py`; `backend/tests/test_diagnostics_report.py`
  fails until every config field is in one of the two lists.

## How the collector uses it

The collector groups the mapped points of each enabled source by interval and calls `read` for each group on that interval, backing
off after failures (`backend/dcdash/collector/scheduler.py`). The test, browse, scan and connection-check jobs that the API queues run
in the collector too (`backend/dcdash/collector/jobs.py`, `browse.py`, `scan.py`).

A connector with `polls = False` (today only `file`, whose readings come from imported files) is left out of all of that: the poll loop
never groups its points, the Sources page offers it no **Test**, **Check connection** or **Browse** and **Test all** skips it, and a
test or browse queued by hand does not change its status, which stays `unknown` (the page reads "filled by file import"; the
Diagnostics report does not rank it as a problem). `GET /api/connectors` lists such types last, so the Add source form still starts on one that polls, and shows each type's `description` under the select.

## Reading history

A source that keeps its own history can let the platform fill the holes an outage leaves (what that does for a user is on
[Sources and discovery](sources-and-discovery.md#history-and-backfill)). A connector takes part by setting `supports_history = True`
and implementing `read_history`. The loop in the collector (`backend/dcdash/ingest/backfill.py`) asks only connectors that set the flag;
the default `read_history` raises `ConnectorError("not_supported", ...)`.

```python
async def read_history(
    self, addresses: list[str], start: datetime, end: datetime, resolution: timedelta | None = None,
    *, after: Mapping[str, datetime] | None = None, limit: int | None = None,
) -> HistoryPage: ...
```

`start` and `end` are aware times and both ends are inclusive. `resolution=None` means the raw samples, the only value the backfill asks
for; a connector that cannot do anything else may refuse another value with `not_supported`. The answer is a `HistoryPage`:

| Field | Meaning |
|---|---|
| `values` | `PointValue`s with the source's own time as an aware UTC instant and a quality of `GOOD` or `BAD` |
| `complete_until` | aware UTC: the answer is complete for every requested address before this instant. A row exactly at it may be missing. When the source cut the answer at its row limit, this is where the cut was |
| `rejected` | how many items the normalisation rules refused (counted, not returned) |
| `unknown` | the addresses the source does not have; the backfill reports them once a day and never waits for them |

The caller continues a cut answer by asking again from `complete_until` (the next window starts at it, not after it), so a source that
answers a window inclusively is read correctly and the store absorbs the row read twice. An answer that stops no later than the
request started makes no progress; the backfill counts that as a failure of the batch. `after` maps an address to the last UTC instant
already received for it. It is the order evidence for the repeated hour of the autumn clock change, so a page that was cut inside that
hour still tells the first pass from the second. `limit` is the most rows the caller wants in one answer (the backfill passes its
`DCDASH_HISTORY_MAX_ROWS`): a source may cut earlier or later, and `complete_until` says where. The backfill passes both keywords at
every call, so a connector that has no use for one of them must still accept it (an unknown keyword is a `TypeError` on the first cycle).

**The source-time contract.** A connector that supports history must stamp the values of `read()` with the source's time too, in the
same form as its history. Then a live value and its history twin are one pair (the same address and time), and a re-read of a window
the live poll already stored adds nothing. A live value stamped with the platform's clock would be stored a second time under another
time, and a power-only meter would be counted twice. `backend/dcdash/connectors/simulator.py` sends both through one function.

**Read only.** `read_history` sends GET requests and nothing else, and the interface has no write method. The backfill never calls
`browse`, `probe`, `test` or `check`; its tests would fail if it did.

**The helpers in `backend/dcdash/ingest/normalise.py`.** They are pure functions: no database, no network, and none raises for a bad
reading (they return a value or a plain sentence a report can count).
- `parse_time(value, zone, previous=...)` and `convert_series(values, zone, previous=...)` turn what the source says into an aware UTC
  time, or a `Rejected` reason (a time without an offset and without a zone, a local time that does not exist, an ambiguous one, a
  time that is not a time). Call `convert_series` on an ascending series, so the repeated autumn hour becomes two different UTC hours;
  `previous` seeds it when the series continues an earlier page.
- `period_start(ts, period_seconds, stamp)` moves a value stamped at the end of its period back by the period. Call it for interval
  values.
- `quality(code)` gives `GOOD` only for a good code and `BAD` for everything else, with the lower-case label to count it by. Keep the
  label in `PointValue.status`.
- `check_window(ts, now, raw_retention_days)` refuses a time more than five minutes ahead and a time older than the raw retention
  minus a day. The backfill applies it to every value, so a connector does not have to.
- `scale_for(unit, metric)` gives the factor that turns a unit into the metric's base unit (the mapping's scale). A connector does not
  call it: readings keep the source's unit, and the scale converts when a figure is computed.
- `refuse_interval_as_energy(kind, metric)` is the rule that an interval tag (energy per period) may not be mapped as a cumulative
  energy counter. Nothing calls it yet, because interval energy is not built; a new mapping or import path should call it.

**Errors.** Raise `ConnectorError(status, message, retry_after=None)`. The backfill reacts to the status: `auth_failed` waits 15
minutes, `not_supported` waits a day, and `timeout`, `unreachable`, `rate_limited` and `protocol_error` back off (30, 60 and 120
seconds inside a cycle, then 4, 8 and 15 minutes between cycles). `retry_after` is the number of seconds the source asked to wait
(`Retry-After`, as seconds or as an HTTP date; ignore a value you cannot read); a longer wait than the back-off wins, up to 15 minutes
inside a cycle. A wait above 15 minutes ends the cycle at once and goes into the time of the next try (up to a day): it is not slept,
because a cycle holds the source's lease and a database connection. An exception that is not a `ConnectorError` is treated as a
`protocol_error` (struck, and the batch is set aside after three cycles in a row), except `TimeoutError` and `OSError` (a dropped
connection), which are transient like `timeout` and `unreachable`: raise `ConnectorError` yourself rather than let an exception
escape. `rate_limited` and `not_supported` belong to `read_history`. The simulator connector maps an HTTP 404 to
`not_supported`, 429 to `rate_limited` and 503 to `unreachable` inside `read_history` only; `read()` and `test()` keep reporting any
other answer than 200 as `protocol_error`.

**Size.** Send at most 200 addresses in a request and split a longer list into several requests; the simulator connector does. Convert
a large answer off the event loop (`asyncio.to_thread` above 2,000 items), because the collector's live polls share the loop.

## Testing it

Look at `backend/tests/test_connector_simulator.py`: it runs the connector against the simulator app in memory through an
`httpx.ASGITransport`, with no network. `test_connector_base.py` registers a throwaway connector, and `test_connector_probe.py`
checks the default ports and the probes. The simulator (`backend/dcdash/simulator`) also serves OPC UA and Modbus TCP, so a new
protocol can get a simulated device there; Modbus register layouts live in YAML profiles in `backend/dcdash/profiles`.

For history, `backend/tests/test_connector_history.py` drives the connector against the **stand-in Historian**
(`backend/dcdash/simulator/historian.py`, port 9100 in the dev profile) in memory, with a clock the test controls, and
`backend/tests/test_simulator_historian.py` tests the stand-in itself. The stand-in answers GET only. Its tags each stand for one
way a real Historian misbehaves: `GAP_kWh` (a daily hole), `LATE_kWh` (samples that arrive 90 minutes late), `DUP_kWh` (a sample
answered twice), `DIFF_kWh` (a re-read that differs), `RESET_kWh` and `WRAP_kWh` (a reset and a rollover), `BADQ_kW` (every quality),
`INTERVAL_kWh` (energy per 15 minutes, stamped at the end), `LOCAL_kWh` (naive local times), `DEADBAND_kW` (power stored only on a
change), `UNIT_Wh` and `UNIT_MWh` (other units), `POWER_5MIN_kW` and `MISMATCH_kW` (power on other grids than the mapping), and the plain meters `M001_kWh` and `M001_kW`. Its
switches `SIM_HISTORIAN_FAIL_EVERY`, `SIM_HISTORIAN_RATE` and `SIM_HISTORIAN_SLOW` make it answer 503, 429 or late, and its `/stats`
route counts what was asked, so a test can prove that a client only called `/history`. A test of the whole path is
`backend/tests/test_ingest_backfill.py`.

## Documenting it

Describe the protocol for users in the Protocols section of [Sources and discovery](sources-and-discovery.md), add any field
debugging advice to [Field debugging](field-debugging.md), and note the change in [CHANGELOG.md](../CHANGELOG.md).

Related: [Developing](developing.md), [End-to-end tests](end-to-end-tests.md), [Sources and discovery](sources-and-discovery.md).
