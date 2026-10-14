# Adding a connector

This page is for developers who add a new kind of data source (a protocol). A connector is one Python class: the API uses it to
validate a source's settings and to discover sources on the network, and the collector uses it to test, browse and read. The built-in
connectors are `opcua`, `modbus` and `simulator`; what each protocol does for a user is on
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

## Testing it

Look at `backend/tests/test_connector_simulator.py`: it runs the connector against the simulator app in memory through an
`httpx.ASGITransport`, with no network. `test_connector_base.py` registers a throwaway connector, and `test_connector_probe.py`
checks the default ports and the probes. The simulator (`backend/dcdash/simulator`) also serves OPC UA and Modbus TCP, so a new
protocol can get a simulated device there; Modbus register layouts live in YAML profiles in `backend/dcdash/profiles`.

## Documenting it

Describe the protocol for users in the Protocols section of [Sources and discovery](sources-and-discovery.md), add any field
debugging advice to [Field debugging](field-debugging.md), and note the change in [CHANGELOG.md](../CHANGELOG.md).

Related: [Developing](developing.md), [End-to-end tests](end-to-end-tests.md), [Sources and discovery](sources-and-discovery.md).
