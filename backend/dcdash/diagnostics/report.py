"""The diagnostics report: `gather` reads the facts from the database, `render` turns them into the text a person pastes.

Two halves with one rule each.

`gather(db, ...)` is the only part that touches the database. Every section runs inside its own SAVEPOINT (after one
`SET LOCAL statement_timeout`), so a section that fails, or runs out of time, becomes `section unavailable: <ExcClass>` and the
others still run: a failed statement would otherwise leave the whole transaction aborted. What it returns is plain values (no ORM
instances, no secrets: `sources.secret` is never selected, only whether there is one), so it can be rendered after a commit.

`render(data, detail, transform)` is pure. EVERY text that came from the database passes `transform` (scrub, and mask when the
report is masked) BEFORE it is clipped, because a clip cut through a half-scrubbed value would hide it from the scrubber. Line
breaks inside a value are folded to spaces, so no value can start a line with `== ` or `--- PART` and fake a section or a footer.
`transform` has no default: the caller decides what "safe" means (`redact.scrub` with the known secrets, plus a `Masker`).

The body is sized for `redact.finalize`: a `summary` fits one part, a `full` report about 60 000 characters. When it does not fit,
the tails are trimmed first (JOURNAL, AUDIT TAIL, SCANS, API ERRORS, POINTS), then the distinct errors per source, then the sources
that look healthy; the LATEST CHECK verdict, the CONNECTION CHECKS of the failing sources and the header facts always stay.
"""
import asyncio
import importlib.metadata
import ipaddress
import json
import platform
import socket
import time
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core import journal
from dcdash.core.audit import SENSITIVE_KEYS, plain, without_credentials
from dcdash.core.build import build_info, uptime_seconds
from dcdash.core.config import get_settings
from dcdash.core.heartbeat import HEARTBEAT_KEY, STALE_AFTER_SECONDS
from dcdash.core.models import AuditLog, DiagEvent, Scan, Source, User, UserSession
from dcdash.core.sign_in_policy import get_sign_in_policy
from dcdash.core.storage import StorageStats, storage_stats
from dcdash.core.widgets import STALE_AFTER_INTERVALS, STALE_MINIMUM
from dcdash.diagnostics.redact import build_known, clip

Detail = Literal["summary", "full"]
Transform = Callable[[str], str]

LINE_LIMIT = 300  # characters per line, after the transform
SUMMARY_BODY_CHARS = 11_600  # PART_LIMIT (12 000) minus the header, footer and END line `finalize` reserves (about 210), with margin
FULL_BODY_CHARS = 60_000
STATEMENT_TIMEOUT = "5s"
CLOCK_WARN_SECONDS = 30.0  # browser vs container clock beyond this: a local VM clock problem
HEALTH_WINDOW_MINUTES = 10

# What a source's config may show per connector type (M6). A URL value passes `without_credentials`. Everything else in a config is
# left out. tests/test_diagnostics_report.py fails when a registered connector has a config field in neither this nor the list below.
REPORT_CONFIG_FIELDS: dict[str, tuple[str, ...]] = {
    "opcua": ("endpoint", "security_policy", "root_node", "timeout_seconds", "client_cert"),
    "modbus": ("host", "port", "unit_id", "profile", "timeout_seconds"),
    "simulator": ("url", "timeout_seconds"),
}
# Fields that are deliberately never shown: "username" is half a credential (the report says only whether one is set), the key
# path of the client certificate is of no use to a reader.
EXCLUDED_CONFIG_FIELDS: dict[str, tuple[str, ...]] = {"opcua": ("username", "client_key"), "modbus": (), "simulator": ()}
AUTH_FIELDS: dict[str, str] = {"opcua": "username"}  # the config field whose value means "username/password"
HOST_FIELDS = ("endpoint", "url", "host")  # config fields that hold a host: fed to the masker

# SETTINGS shows these and nothing else: keys of the `settings` table, the sign-in policy and the environment-seeded values.
REPORT_SETTINGS_KEYS: dict[str, tuple[str, ...]] = {"general": ("timezone",), "billing": ("currency",)}
REPORT_ENV_FIELDS = ("timezone", "session_hours", "scan_max_hosts", "scan_extra_ports")
# a test fails when a Settings field is in neither of these two lists
EXCLUDED_ENV_FIELDS = ("database_url", "secret_key")
SCAN_PROGRESS_KEYS = ("hosts", "pairs", "checked", "open", "claimed", "points", "unidentified", "needs_credentials")

# Line caps (summary, full) per tail section (M7). The names are the knobs `render` turns down when the body is too long.
CAPS: dict[str, tuple[int, int]] = {
    "journal": (30, 100), "points": (10, 20), "audit": (10, 20), "api_errors": (5, 20), "scans": (3, 5), "health_errors": (3, 10),
}
# How a body that is too long is cut down, in order: (knob, floor); a knob is halved until it reaches its floor. The tails go first
# (M7), then the health lines of healthy sources (one whose backfill is backing off or has an error on record is not healthy), then
# the history lines of the sources whose backfill is fine, and the one line of an unreadable history (w30: a line each, so
# a few dozen of them must not be what pushes a report into dropping sources), and only then the sources themselves (`source_limit`),
# which M7 wants kept whole.
TRIM_STEPS = (
    ("journal", 5), ("audit", 2), ("scans", 1), ("api_errors", 2), ("points", 3), ("health_sources", 0), ("history_lines", 0),
    ("health_errors", 1), ("journal", 0), ("audit", 0), ("scans", 0), ("api_errors", 0), ("points", 0), ("health_errors", 0),
)
SUMMARY_CONFIG_FIELDS = ("endpoint", "url", "host", "port", "unit_id", "security_policy")  # what a summary shows of a config
JOURNAL_FETCH = (300, 1000)  # events read (summary, full): the journal lines and the distinct errors per source come from these
MESSAGE_CHARS = 200
KEY_STEPS = ("server_time", "read_points", "timing")  # steps of an all-OK check that a summary still shows
SESSION_CONTEXT_STEPS = ("endpoints", "certificates")  # a failed session's hints point at these (thumbprint, offered token types)
AUDIT_PAIRS = 4  # changed fields a source.updated line names (the rest as "+N more")
# source.updated / source.created show a VALUE only for these fields; any other (the secret, the user name, the key path, ...) shows
# "<field> changed", never what it holds
AUDIT_VALUE_FIELDS = frozenset(
    {"name", "enabled", "connector_type", *(f"config.{name}" for names in REPORT_CONFIG_FIELDS.values() for name in names)}
)
RESOLV_CONF = "/etc/resolv.conf"
DNS_SERVERS_SHOWN = 3
EMBEDDED_RESOLVER = "127.0.0.11"  # Docker's own resolver: the only nameserver a container on a user-defined network lists
# One lookup per source host that is a name, run from inside this container (what the collector, on the same network, would get).
DNS_LOOKUP_SECONDS = 3.0
DNS_LOOKUP_MAX_HOSTS = 8
DNS_ADDRESSES_SHOWN = 3
# A DEDICATED pool: `wait_for` cannot stop a thread stuck in getaddrinfo, and a hung lookup must not starve the default executor.
_DNS_POOL = ThreadPoolExecutor(max_workers=DNS_LOOKUP_MAX_HOSTS, thread_name_prefix="dns-lookup")

SECTION_TITLES = (
    "ENVIRONMENT", "SETTINGS", "SOURCES", "SOURCE HEALTH", "POINTS", "CONNECTION CHECKS", "JOURNAL", "SCANS",
    "STORAGE AND RETENTION", "AUDIT TAIL", "API ERRORS",
)


# --- the gathered data ---------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Unavailable:
    """A section that could not be read. `error` is the exception class only, never its message (which can quote SQL or hosts)."""

    error: str


@dataclass(frozen=True)
class Event:
    ts: datetime
    level: str
    component: str
    source_id: int | None
    kind: str
    code: str | None
    message: str
    detail: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Environment:
    build_id: str = "dev"
    build_time: str = "unknown"
    uptime_seconds: float = 0.0
    collector_build_id: str | None = None
    collector_age_seconds: float | None = None  # None: no heartbeat on record
    python: str = ""
    system: str = ""
    asyncua: str | None = None
    pymodbus: str | None = None
    postgres: str | None = None
    timescale: str | None = None
    site_timezone: str | None = None
    container_time: datetime | None = None
    database_time: datetime | None = None
    client_time: datetime | None = None  # the browser's clock, when the Diagnostics page sent it (M1)
    dns_servers: tuple[str, ...] | None = None  # the nameservers of this container's resolv.conf; None: the file cannot be read


@dataclass(frozen=True)
class DnsLookup:
    host: str
    ok: bool
    addresses: tuple[str, ...] = ()
    ms: float = 0.0
    error: str | None = None  # the exception class and message, clipped; None when the lookup worked


@dataclass(frozen=True)
class SettingsInfo:
    values: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class SourceInfo:
    id: int
    name: str
    connector_type: str
    enabled: bool = True
    status: str = "unknown"
    last_seen: datetime | None = None
    last_error: str | None = None
    config: tuple[tuple[str, str], ...] = ()  # allow-listed fields only, URL credentials removed
    authentication: str | None = None  # "username/password" | "none" | None (the connector has no authentication)
    has_secret: bool = False


@dataclass(frozen=True)
class HistoryInfo:
    """The history backfill's status row of one source (w30). The counters are totals since the collector started."""

    state: str  # idle | filling | backing_off | not_supported
    answered_through: datetime | None = None
    short_hours: int = 0
    rows_new: int = 0
    rows_already: int = 0
    rows_differing: int = 0
    rows_rejected: int = 0
    requests: int = 0
    failures: int = 0
    next_try_at: datetime | None = None
    last_error: str | None = None  # scrubbed by the backfill when it stored it; the report scrubs it again like every text


@dataclass(frozen=True)
class SourceHealth:
    source_id: int
    reads: int = 0  # readings in the last HEALTH_WINDOW_MINUTES
    bad: int = 0
    newest_age_seconds: float | None = None  # by the database clock; None: no reading on record
    # None: the source has no history_status row (the report then says nothing about history). A read that failed is not kept
    # here, once per source: it is `ReportData.history_unavailable`.
    history: HistoryInfo | None = None


@dataclass(frozen=True)
class PointRow:
    source_id: int
    address: str
    name: str
    state: str  # bad | stale | no data
    ts: datetime | None
    value: float | None
    quality: int | None
    age_seconds: float | None


@dataclass(frozen=True)
class PointsInfo:
    counts: tuple[tuple[str, int], ...] = ()  # (state, points): good | bad | stale | no data | unmapped
    by_source: tuple[tuple[int, str, int], ...] = ()  # (source id, state, points)
    worst: tuple[PointRow, ...] = ()


@dataclass(frozen=True)
class CheckStep:
    id: str
    ok: bool | None  # None: skipped
    name: str = ""
    ms: float | None = None
    summary: str = ""
    error_class: str | None = None
    status_name: str | None = None
    status_hex: str | None = None
    error_message: str | None = None
    hint: str | None = None
    points_bad: int | None = None  # read_points only: how many points answered a Bad status, and how many were read
    points_total: int | None = None


@dataclass(frozen=True)
class CheckInfo:
    """The latest `check_connection` job of one source, parsed from its `jobs.result` (any shape: it may be partial or an error)."""

    source_id: int
    job_id: int
    job_status: str  # pending | running | done | failed
    created_at: datetime | None = None
    finished_at: datetime | None = None
    connector_type: str | None = None
    finished: bool = False  # result["finished"]
    ok: bool | None = None
    first_failed: str | None = None
    steps: tuple[CheckStep, ...] = ()
    error: str | None = None  # result["error"] of a job that failed before it could report
    server_time: str | None = None
    local_time: str | None = None
    skew_seconds: float | None = None
    hosts: tuple[str, ...] = ()  # result["names"]: what the server calls itself (for the masker)
    uris: tuple[str, ...] = ()

    @property
    def failed_step(self) -> CheckStep | None:
        for step in self.steps:
            if step.ok is False:
                return step
        return next((step for step in self.steps if step.id == self.first_failed), None) if self.first_failed else None

    @property
    def state(self) -> str:
        """queued | running | job_failed | failed | ok | unknown"""
        if self.job_status == "pending":
            return "queued"
        if self.job_status == "failed":
            return "job_failed"
        if self.failed_step is not None or self.ok is False:
            return "failed"
        if self.job_status == "running":
            return "running"
        finished = self.finished or self.job_status == "done"
        return "ok" if finished and self.steps and all(step.ok for step in self.steps) else "unknown"

    @property
    def sort_key(self) -> tuple[float, int]:
        moment = self.finished_at or self.created_at
        return (moment.timestamp() if moment else 0.0, self.job_id)


@dataclass(frozen=True)
class ScanInfo:
    id: int
    status: str
    stage: str | None = None
    created_at: datetime | None = None
    finished_at: datetime | None = None
    progress: tuple[tuple[str, int], ...] = ()
    outcomes: tuple[tuple[str, int], ...] = ()  # findings by outcome
    error: str | None = None


@dataclass(frozen=True)
class PolicyJob:
    proc: str
    hypertable: str | None = None
    scheduled: bool = True
    last_status: str | None = None
    last_finish: datetime | None = None
    next_start: datetime | None = None
    failures: int | None = None


@dataclass(frozen=True)
class StorageInfo:
    stats: StorageStats | None = None
    jobs: tuple[PolicyJob, ...] = ()
    journal_rows: int = 0
    journal_oldest: datetime | None = None


@dataclass(frozen=True)
class AuditEntry:
    ts: datetime
    actor: str
    action: str
    detail: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ReportData:
    """Everything `render` needs. A section is its data or `Unavailable`; the defaults are the empty report."""

    detail: str = "summary"
    source_id: int | None = None
    generated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    environment: Environment | Unavailable = field(default_factory=Environment)
    # None: not gathered (a fixture); (): no source host is a name; Unavailable: the step failed. Rendered inside ENVIRONMENT.
    dns_lookups: tuple[DnsLookup, ...] | None | Unavailable = None
    settings: SettingsInfo | Unavailable = field(default_factory=SettingsInfo)
    sources: tuple[SourceInfo, ...] | Unavailable = ()
    health: tuple[SourceHealth, ...] | Unavailable = ()
    # The history status rows could not be read (an older schema, a timeout): SOURCE HEALTH says so once, at its end, not per source.
    history_unavailable: Unavailable | None = None
    points: PointsInfo | Unavailable = field(default_factory=PointsInfo)
    checks: tuple[CheckInfo, ...] | Unavailable = ()
    journal: tuple[Event, ...] | Unavailable = ()
    scans: tuple[ScanInfo, ...] | Unavailable = ()
    storage: StorageInfo | Unavailable = field(default_factory=StorageInfo)
    audit: tuple[AuditEntry, ...] | Unavailable = ()
    api_errors: tuple[Event, ...] | Unavailable = ()


# --- gather --------------------------------------------------------------------------------------------------------------------


def _error_name(exc: BaseException) -> str:
    """The exception class, plus the driver's own class when SQLAlchemy wrapped it ("OperationalError (QueryCanceledError)")."""
    name = type(exc).__name__
    orig = getattr(exc, "orig", None)
    if orig is not None:
        cause = orig.__cause__ or orig
        name += f" ({type(cause).__name__})"
    return name


async def _guard[T](db: AsyncSession, section: Callable[[], Awaitable[T]]) -> T | Unavailable:
    """Run one section in a SAVEPOINT. A failure (an SQL error, the statement timeout, a bug) rolls back to the savepoint, so the
    transaction stays usable for the next section, and becomes `Unavailable(<ExcClass>)`."""
    try:
        async with db.begin_nested():
            return await section()
    except Exception as exc:
        return Unavailable(_error_name(exc))


async def gather(
    db: AsyncSession, *, detail: Detail = "summary", source_id: int | None = None, client_time: datetime | None = None
) -> ReportData:
    """Read the report's facts. Every section is isolated (see the module doc); the session is usable afterwards.

    `source_id` limits SOURCES, SOURCE HEALTH, POINTS, CONNECTION CHECKS and JOURNAL to one source. `client_time` is the browser's
    clock (M1; a value without an offset is taken as UTC). The sections are looked up by name at call time, so a test can patch one:
    `monkeypatch.setattr(report, "_points", ...)`.
    Does not commit. Never selects a secret.
    """
    if detail not in ("summary", "full"):
        raise ValueError(f"detail must be summary or full, not {detail!r}")
    full = detail == "full"
    if client_time is not None and client_time.tzinfo is None:
        client_time = client_time.replace(tzinfo=timezone.utc)  # a caller that sends no offset means UTC
    # Once, before the first savepoint: a SET LOCAL inside a savepoint is undone when that savepoint rolls back.
    await db.execute(text(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'"))
    generated = datetime.now(timezone.utc)
    data = ReportData(
        detail=detail,
        source_id=source_id,
        generated_at=generated,
        environment=await _guard(db, lambda: _environment(db, client_time)),
        dns_lookups=await _guard(db, lambda: _dns_lookups(db, source_id)),  # after the environment: adds nothing to its clock sample
        settings=await _guard(db, lambda: _settings(db)),
        sources=await _guard(db, lambda: _sources(db, source_id)),
        health=await _guard(db, lambda: _health(db, source_id)),
        points=await _guard(db, lambda: _points(db, source_id, CAPS["points"][full])),
        checks=await _guard(db, lambda: _checks(db, source_id)),
        journal=await _guard(db, lambda: _journal(db, source_id, JOURNAL_FETCH[full])),
        scans=await _guard(db, lambda: _scans(db, CAPS["scans"][full])),
        storage=await _guard(db, lambda: _storage(db)),
        audit=await _guard(db, lambda: _audit(db, CAPS["audit"][full])),
        api_errors=await _guard(db, lambda: _api_errors(db, CAPS["api_errors"][full] * 3)),
    )
    # Its own savepoint, after the sections above: a database without the table (an older schema) still gets its health lines.
    history = await _guard(db, lambda: _history(db, source_id))
    if isinstance(history, Unavailable):
        return replace(data, history_unavailable=history)
    if isinstance(data.health, Unavailable):
        return data
    return replace(data, health=tuple(replace(item, history=history.get(item.source_id)) for item in data.health))


async def load_known(
    db: AsyncSession, *, secret_key: str | None = None, database_url: str | None = None, extra: Iterable[str] = ()
) -> list[str]:
    """The values `scrub` must hide in this report: every source's credentials and decrypted secret, the secret key, the database
    password, the stored password hashes and session ids, and `extra` (see `redact.build_known`). Fails CLOSED: an error propagates,
    so there is no report scrubbed with an incomplete list. Call it before `gather` (a failing query here is not isolated).
    Needs the sources' stored secrets, which is why it is not part of `ReportData`."""
    settings = get_settings()
    sources = (await db.execute(select(Source.config, Source.secret))).all()
    tokens = (await db.scalars(select(UserSession.id))).all()
    hashes = (await db.scalars(select(User.password_hash))).all()
    return build_known(
        sources, secret_key or settings.secret_key, database_url or settings.database_url, extra=[*tokens, *hashes, *extra]
    )


async def load_source_hosts(db: AsyncSession) -> list[str]:
    """The endpoint/host of EVERY source (not only the one a `source=` filter keeps), by source id, for `mask_names`: the sections
    that are not filtered (audit tail, scans, api errors) may name the other sources' hosts. Selects the config only, and
    fails CLOSED like `load_known`: call it before `gather` when the report is masked."""
    hosts: dict[str, None] = {}
    for (config,) in (await db.execute(select(Source.config).order_by(Source.id))).all():
        for key in HOST_FIELDS:
            value = config.get(key) if isinstance(config, Mapping) else None
            if isinstance(value, str) and value.strip():
                hosts.setdefault(without_credentials(value))
    return list(hosts)


def _audit_hosts(entry: AuditEntry) -> list[str]:
    """The host-bearing config values a source.created / source.updated row holds (before and after), URL credentials removed."""
    if not entry.action.startswith("source."):
        return []
    detail = entry.detail
    configs = [detail.get("config")] + [side.get("config") for side in (detail.get("before"), detail.get("after")) if isinstance(side, Mapping)]
    found = []
    for config in configs:
        if isinstance(config, Mapping):
            found += [without_credentials(config[key]) for key in HOST_FIELDS if isinstance(config.get(key), str) and config[key].strip()]
    return found


def mask_names(data: ReportData, source_hosts: Iterable[str] | None = None) -> tuple[list[str], list[str]]:
    """(hosts, uris) to give the `Masker`: every source's endpoint/host and what the checks learned about the server (M5), in a
    stable order (source id, then check), without duplicates. Aliases are numbered in registration order, so the order matters.

    `source_hosts` (see `load_source_hosts`) replaces the hosts read from `data.sources`, which a source filter narrows."""
    hosts: dict[str, None] = {}
    uris: dict[str, None] = {}
    if source_hosts is not None:
        hosts.update(dict.fromkeys(host for host in source_hosts if host.strip()))
    elif not isinstance(data.sources, Unavailable):
        for source in sorted(data.sources, key=lambda s: s.id):
            for key, value in source.config:
                if key in HOST_FIELDS and value:
                    hosts.setdefault(value)
    if isinstance(data.dns_lookups, tuple):  # no source has this name any more when an edit moved it, and it is in the lookup lines
        hosts.update(dict.fromkeys(lookup.host for lookup in data.dns_lookups))
    if not isinstance(data.checks, Unavailable):
        for check in sorted(data.checks, key=lambda c: c.source_id):
            hosts.update(dict.fromkeys(check.hosts))
            uris.update(dict.fromkeys(check.uris))
    if not isinstance(data.audit, Unavailable):  # an edit names the OLD host, which no source has any more
        for entry in data.audit:
            hosts.update(dict.fromkeys(_audit_hosts(entry)))
    return list(hosts), list(uris)


def _event(row: DiagEvent) -> Event:
    return Event(
        ts=row.ts, level=row.level, component=row.component, source_id=row.source_id, kind=row.kind, code=row.code,
        message=row.message, detail=dict(row.detail or {}),
    )


def _obj(value: Any) -> Any:
    """A JSONB value as Python data (a text() query may hand it back undecoded)."""
    if isinstance(value, (str, bytes)):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def _str(value: Any) -> str | None:
    return None if value is None else str(value)


def _float(value: Any) -> float | None:
    try:
        return None if value is None or isinstance(value, bool) else float(value)
    except (TypeError, ValueError):
        return None


def _flag(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _version(package: str) -> str | None:
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


def _system() -> str:
    """OS facts without the kernel's dotted version, which looks like an IPv4 address to the masker:
    "Linux x86_64 microsoft-standard-WSL2"."""
    flavour = platform.release().partition("-")[2]
    return " ".join(part for part in (platform.system(), platform.machine(), flavour) if part)


def _dns_servers() -> tuple[str, ...] | None:
    """The first nameservers of the container's resolv.conf, in file order; None when it cannot be read."""
    try:
        with open(RESOLV_CONF, encoding="utf-8", errors="replace") as handle:
            lines = handle.read(20_000).splitlines()
    except OSError:
        return None
    servers = []
    for line in lines:
        parts = line.split("#", 1)[0].split()
        if len(parts) >= 2 and parts[0] == "nameserver":
            servers.append(parts[1])
    return tuple(servers[:DNS_SERVERS_SHOWN])


def _host_of(value: str) -> str | None:
    """The host name of a source's endpoint/url/host value, or None when it is no name to look up: an address, a `urn:` value or
    something urlsplit cannot read. The credentials of a URL are removed first and are never part of the result."""
    value = without_credentials(value.strip())
    if not value or value.lower().startswith("urn:"):
        return None
    try:
        host = urlsplit(value if "://" in value else f"//{value}").hostname
    except ValueError:
        return None
    if not host:
        return None
    try:
        ipaddress.ip_address(host.partition("%")[0])
    except ValueError:
        return host
    return None


async def _dns_hosts(db: AsyncSession, source_id: int | None) -> list[str]:
    """The distinct host names (not addresses) of the sources' endpoints, in source-id order, at most DNS_LOOKUP_MAX_HOSTS."""
    query = select(Source.config).order_by(Source.id)
    if source_id is not None:
        query = query.where(Source.id == source_id)
    hosts: dict[str, None] = {}
    for config in (await db.scalars(query)).all():
        for key in HOST_FIELDS:
            value = config.get(key) if isinstance(config, Mapping) else None
            if isinstance(value, str) and (host := _host_of(value)):
                hosts.setdefault(host)
    return list(hosts)[:DNS_LOOKUP_MAX_HOSTS]


async def _resolve(host: str) -> list[str]:
    """The unique addresses `host` resolves to, in the resolver's order (tests patch this)."""
    found = await asyncio.get_running_loop().run_in_executor(_DNS_POOL, lambda: socket.getaddrinfo(host, None, type=socket.SOCK_STREAM))
    return list(dict.fromkeys(info[4][0] for info in found))


async def _lookup(host: str) -> DnsLookup:
    started = time.monotonic()
    try:
        found = await asyncio.wait_for(_resolve(host), DNS_LOOKUP_SECONDS)
        error = None if found else "no address returned"
    except TimeoutError:
        found, error = [], f"TimeoutError no answer within {DNS_LOOKUP_SECONDS:g} s"
    except Exception as exc:
        found, error = [], clip(" ".join(f"{type(exc).__name__} {exc}".split()), 120)
    return DnsLookup(host, error is None, tuple(found[:DNS_ADDRESSES_SHOWN]), (time.monotonic() - started) * 1000, error)


async def _dns_lookups(db: AsyncSession, source_id: int | None) -> tuple[DnsLookup, ...]:
    """A real lookup from this container for every source host that is a name, all at once (a dead resolver costs one timeout)."""
    hosts = await _dns_hosts(db, source_id)
    return tuple(await asyncio.gather(*(_lookup(host) for host in hosts)))


async def _environment(db: AsyncSession, client_time: datetime | None) -> Environment:
    container_now = datetime.now(timezone.utc)  # sampled right next to the database clock
    row = (
        await db.execute(
            text(
                "SELECT now() AS db_now, current_setting('server_version') AS pg, "
                "(SELECT extversion FROM pg_extension WHERE extname = 'timescaledb') AS ts, "
                "(SELECT value->>'build_id' FROM settings WHERE key = :beat) AS beat_build, "
                "(SELECT extract(epoch FROM now() - (value->>'at')::timestamptz) FROM settings WHERE key = :beat) AS beat_age, "
                "(SELECT value->>'timezone' FROM settings WHERE key = 'general') AS tz"
            ),
            {"beat": HEARTBEAT_KEY},
        )
    ).one()
    build = build_info()
    age = _float(row.beat_age)
    return Environment(
        build_id=build.build_id,
        build_time=build.build_time,
        uptime_seconds=uptime_seconds(),
        collector_build_id=row.beat_build,
        collector_age_seconds=None if age is None else max(0.0, age),
        python=platform.python_version(),
        system=_system(),
        asyncua=_version("asyncua"),
        pymodbus=_version("pymodbus"),
        postgres=row.pg,
        timescale=row.ts,
        site_timezone=row.tz or get_settings().timezone,
        container_time=container_now,
        database_time=row.db_now,
        client_time=client_time,
        dns_servers=_dns_servers(),
    )


async def _settings(db: AsyncSession) -> SettingsInfo:
    rows = (
        await db.execute(
            text("SELECT key, value FROM settings WHERE key = ANY(CAST(:keys AS text[]))"), {"keys": list(REPORT_SETTINGS_KEYS)}
        )
    ).all()
    stored = {key: _obj(value) for key, value in rows}
    values: list[tuple[str, str]] = []
    for key, fields in REPORT_SETTINGS_KEYS.items():
        row = stored.get(key) if isinstance(stored.get(key), dict) else {}
        for name in fields:
            values.append((f"{key}.{name}", "(not set)" if row.get(name) is None else str(row[name])))
    policy = await get_sign_in_policy(db)
    values.append(("sign_in.max_failures", str(policy.max_failures)))
    values.append(("sign_in.block_minutes", str(policy.block_minutes)))
    values.append(("sign_in.enabled", str(policy.enabled)))
    env = get_settings()
    values.extend((f"env.{name}", str(getattr(env, name)) or "(empty)") for name in REPORT_ENV_FIELDS)
    return SettingsInfo(tuple(values))


def report_config(connector_type: str, config: Mapping[str, Any]) -> tuple[tuple[str, str], ...]:
    """The allow-listed fields of a source's config, URL credentials removed. An unknown connector type shows no field."""
    shown: list[tuple[str, str]] = []
    for name in REPORT_CONFIG_FIELDS.get(connector_type, ()):
        if name not in config or SENSITIVE_KEYS.search(name):
            continue
        value = config[name]
        if isinstance(value, str):
            shown.append((name, without_credentials(value)))
        elif isinstance(value, (int, float, bool)) or value is None:
            shown.append((name, str(value)))
        else:
            shown.append((name, json.dumps(plain(value), default=str)[:200]))
    return tuple(shown)


def _authentication(connector_type: str, config: Mapping[str, Any]) -> str | None:
    """Whether a user name is set, never the name itself (it is half a credential)."""
    name = AUTH_FIELDS.get(connector_type)
    if name is None:
        return None
    return "username/password" if config.get(name) else "none"


async def _sources(db: AsyncSession, source_id: int | None) -> tuple[SourceInfo, ...]:
    query = select(
        Source.id, Source.name, Source.connector_type, Source.config, Source.enabled, Source.status, Source.last_seen,
        Source.last_error, Source.secret.is_not(None).label("has_secret"),  # the secret itself is never read
    ).order_by(Source.id)
    if source_id is not None:
        query = query.where(Source.id == source_id)
    found = []
    for row in (await db.execute(query)).all():
        config = row.config if isinstance(row.config, dict) else {}
        found.append(
            SourceInfo(
                id=row.id, name=row.name, connector_type=row.connector_type, enabled=row.enabled, status=row.status,
                last_seen=row.last_seen, last_error=row.last_error, config=report_config(row.connector_type, config),
                authentication=_authentication(row.connector_type, config), has_secret=bool(row.has_secret),
            )
        )
    return tuple(found)


async def _health(db: AsyncSession, source_id: int | None) -> tuple[SourceHealth, ...]:
    where = "" if source_id is None else "WHERE s.id = :sid"
    rows = (
        await db.execute(
            text(
                f"""
                SELECT s.id, coalesce(h.n, 0) AS reads, coalesce(h.bad, 0) AS bad, a.age
                FROM sources s
                LEFT JOIN (
                    SELECT p.source_id, count(*) AS n, count(*) FILTER (WHERE r.quality <> 0) AS bad
                    FROM readings r JOIN points p ON p.id = r.point_id
                    WHERE r.ts > now() - make_interval(mins => :minutes)
                    GROUP BY p.source_id
                ) h ON h.source_id = s.id
                LEFT JOIN (
                    SELECT p.source_id, extract(epoch FROM now() - max(l.ts)) AS age
                    FROM point_latest l JOIN points p ON p.id = l.point_id
                    GROUP BY p.source_id
                ) a ON a.source_id = s.id
                {where}
                ORDER BY s.id
                """
            ),
            {"minutes": HEALTH_WINDOW_MINUTES, **({} if source_id is None else {"sid": source_id})},
        )
    ).all()
    return tuple(SourceHealth(r.id, int(r.reads), int(r.bad), _float(r.age)) for r in rows)


async def _history(db: AsyncSession, source_id: int | None) -> dict[int, HistoryInfo]:
    """The backfill's status row of every source that has one, by source id. Plain SQL: the table has no model."""
    where = "" if source_id is None else "WHERE source_id = :sid"
    rows = (
        await db.execute(
            text(
                f"""
                SELECT source_id, state, answered_through, short_hours, rows_new, rows_already, rows_differing, rows_rejected,
                       requests, failures, next_try_at, last_error
                FROM history_status {where}
                """
            ),
            {} if source_id is None else {"sid": source_id},
        )
    ).all()
    return {
        r.source_id: HistoryInfo(
            state=str(r.state), answered_through=r.answered_through, short_hours=int(r.short_hours), rows_new=int(r.rows_new),
            rows_already=int(r.rows_already), rows_differing=int(r.rows_differing), rows_rejected=int(r.rows_rejected),
            requests=int(r.requests), failures=int(r.failures), next_try_at=r.next_try_at, last_error=r.last_error,
        )
        for r in rows
    }


_POINT_STATES = """
    WITH st AS (
        SELECT p.id, p.source_id, p.address, p.name, l.ts, l.value, l.quality, extract(epoch FROM now() - l.ts) AS age,
               (SELECT min(m.interval_seconds) FROM mappings m WHERE m.point_id = p.id) AS interval_s
        FROM points p LEFT JOIN point_latest l ON l.point_id = p.id
        {where}
    ), cls AS (
        SELECT st.*, CASE
            WHEN interval_s IS NULL THEN 'unmapped'
            WHEN ts IS NULL THEN 'no data'
            WHEN quality <> 0 THEN 'bad'
            WHEN age > greatest(interval_s * CAST(:k AS integer), CAST(:floor AS integer)) THEN 'stale'
            ELSE 'good' END AS state
        FROM st
    )
"""
_STATE_ORDER = ("good", "bad", "stale", "no data", "unmapped")


async def _points(db: AsyncSession, source_id: int | None, worst: int) -> PointsInfo:
    states = _POINT_STATES.format(where="" if source_id is None else "WHERE p.source_id = :sid")
    params: dict[str, Any] = {"k": STALE_AFTER_INTERVALS, "floor": int(STALE_MINIMUM.total_seconds())}
    if source_id is not None:
        params["sid"] = source_id
    by_state = "SELECT source_id, state, count(*) AS n FROM cls GROUP BY 1, 2 ORDER BY 1, 2"
    counts = (await db.execute(text(states + by_state), params)).all()
    rows = (
        await db.execute(
            text(
                states
                + "SELECT source_id, address, name, state, ts, value, quality, age FROM cls "
                "WHERE state IN ('bad', 'stale', 'no data') "
                "ORDER BY CASE state WHEN 'bad' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END, ts ASC NULLS LAST, id LIMIT :worst"
            ),
            {**params, "worst": worst},
        )
    ).all()
    totals: dict[str, int] = {}
    for row in counts:
        totals[row.state] = totals.get(row.state, 0) + int(row.n)
    return PointsInfo(
        counts=tuple((state, totals[state]) for state in _STATE_ORDER if state in totals),
        by_source=tuple((int(r.source_id), r.state, int(r.n)) for r in counts),
        worst=tuple(
            PointRow(r.source_id, r.address, r.name, r.state, r.ts, _float(r.value), r.quality, _float(r.age)) for r in rows
        ),
    )


def _count(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _point_counts(raw: dict[str, Any]) -> tuple[int | None, int | None]:
    """(points that answered a Bad status, points read) out of the detail of a read_points step."""
    detail = raw.get("detail") if raw.get("id") == "read_points" and isinstance(raw.get("detail"), dict) else {}
    bad = _count(detail.get("bad_status"))
    if bad is None:
        bad = _count(detail.get("bad"))
    good, all_bad = _count(detail.get("good")), _count(detail.get("bad"))
    return bad, (good + all_bad if good is not None and all_bad is not None else None)


def _step(raw: Any) -> CheckStep | None:
    if not isinstance(raw, dict):
        return None
    error = raw.get("error") if isinstance(raw.get("error"), dict) else {}
    points_bad, points_total = _point_counts(raw)
    return CheckStep(
        id=str(raw.get("id", "?")), ok=_flag(raw.get("ok")), name=str(raw.get("name") or ""), ms=_float(raw.get("ms")),
        summary=str(raw.get("summary") or ""), error_class=_str(error.get("class")), status_name=_str(error.get("status_name")),
        status_hex=_str(error.get("status_hex")), error_message=_str(error.get("message")), hint=_str(raw.get("hint")),
        points_bad=points_bad, points_total=points_total,
    )


def _names(raw: Any) -> tuple[str, ...]:
    return tuple(str(item) for item in raw if isinstance(item, (str, int))) if isinstance(raw, list) else ()


def parse_check(job_id: int, source_id: int, status: str, result: Any, created_at: Any, finished_at: Any) -> CheckInfo:
    """A `check_connection` job as `CheckInfo`. Tolerant on purpose: the result may be None, partial, an `{"error": ...}` of a job
    that failed, or have missing keys."""
    body = _obj(result)
    body = body if isinstance(body, dict) else {}
    clock = body.get("clock") if isinstance(body.get("clock"), dict) else {}
    names = body.get("names") if isinstance(body.get("names"), dict) else {}
    steps = body.get("steps")
    return CheckInfo(
        source_id=source_id, job_id=job_id, job_status=status, created_at=created_at, finished_at=finished_at,
        connector_type=_str(body.get("connector_type")), finished=body.get("finished") is True, ok=_flag(body.get("ok")),
        first_failed=_str(body.get("first_failed")),
        steps=tuple(step for step in map(_step, steps) if step is not None) if isinstance(steps, list) else (),
        error=_str(body.get("error")), server_time=_str(clock.get("server_time")), local_time=_str(clock.get("local_time")),
        skew_seconds=_float(clock.get("skew_seconds")), hosts=_names(names.get("hosts")), uris=_names(names.get("uris")),
    )


async def _checks(db: AsyncSession, source_id: int | None) -> tuple[CheckInfo, ...]:
    where = "" if source_id is None else "AND sid = :sid"
    rows = (
        await db.execute(
            text(
                f"""
                SELECT DISTINCT ON (sid) id, sid, status, result, created_at, finished_at FROM (
                    SELECT id, status, result, created_at, finished_at,
                           CASE WHEN params->>'source_id' ~ '^[0-9]{{1,9}}$' THEN (params->>'source_id')::int END AS sid
                    FROM jobs WHERE kind = 'check_connection'
                ) j WHERE sid IS NOT NULL {where}
                ORDER BY sid, id DESC
                """
            ),
            {} if source_id is None else {"sid": source_id},
        )
    ).all()
    return tuple(parse_check(r.id, r.sid, r.status, r.result, r.created_at, r.finished_at) for r in rows)


async def _journal(db: AsyncSession, source_id: int | None, limit: int) -> tuple[Event, ...]:
    return tuple(_event(row) for row in await journal.recent(db, limit=limit, source_id=source_id))


async def _api_errors(db: AsyncSession, limit: int) -> tuple[Event, ...]:
    query = (
        select(DiagEvent).where(DiagEvent.kind == journal.HTTP_5XX)
        .order_by(DiagEvent.ts.desc(), DiagEvent.id.desc()).limit(limit)
    )
    return tuple(_event(row) for row in (await db.scalars(query)).all())


async def _scans(db: AsyncSession, limit: int) -> tuple[ScanInfo, ...]:
    query = (
        select(Scan.id, Scan.status, Scan.stage, Scan.created_at, Scan.finished_at, Scan.progress, Scan.error)
        .order_by(Scan.id.desc()).limit(limit)
    )
    scans = (await db.execute(query)).all()
    outcomes: dict[int, list[tuple[str, int]]] = {}
    if scans:
        found = await db.execute(
            text(
                "SELECT scan_id, outcome, count(*) AS n FROM scan_findings WHERE scan_id = ANY(CAST(:ids AS int[])) "
                "GROUP BY 1, 2 ORDER BY 1, 2"
            ),
            {"ids": [s.id for s in scans]},
        )
        for row in found:
            outcomes.setdefault(row.scan_id, []).append((row.outcome, int(row.n)))
    result = []
    for s in scans:
        progress = s.progress if isinstance(s.progress, dict) else {}
        result.append(
            ScanInfo(
                id=s.id, status=s.status, stage=s.stage, created_at=s.created_at, finished_at=s.finished_at,
                progress=tuple((key, progress[key]) for key in SCAN_PROGRESS_KEYS if isinstance(progress.get(key), int)),
                outcomes=tuple(outcomes.get(s.id, ())), error=s.error,
            )
        )
    return tuple(result)


async def _storage(db: AsyncSession) -> StorageInfo:
    stats = await storage_stats(db)
    jobs = (
        await db.execute(
            text(
                """
                SELECT j.proc_name, j.hypertable_name, j.scheduled, s.last_run_status, s.last_successful_finish, s.next_start,
                       s.total_failures
                FROM timescaledb_information.jobs j
                LEFT JOIN timescaledb_information.job_stats s ON s.job_id = j.job_id
                WHERE j.proc_name IN ('policy_retention', 'policy_compression', 'policy_refresh_continuous_aggregate')
                ORDER BY j.proc_name, j.hypertable_name
                """
            )
        )
    ).all()
    kept = (await db.execute(text("SELECT count(*) AS n, min(ts) AS oldest FROM diag_events"))).one()
    return StorageInfo(
        stats=stats,
        jobs=tuple(
            PolicyJob(
                r.proc_name, r.hypertable_name, bool(r.scheduled), r.last_run_status, r.last_successful_finish, r.next_start,
                r.total_failures,
            )
            for r in jobs
        ),
        journal_rows=int(kept.n),
        journal_oldest=kept.oldest,
    )


async def _audit(db: AsyncSession, limit: int) -> tuple[AuditEntry, ...]:
    query = (
        select(AuditLog.ts, AuditLog.actor_name, AuditLog.actor_id, AuditLog.user_id, AuditLog.action, AuditLog.detail)
        .order_by(AuditLog.ts.desc(), AuditLog.id.desc()).limit(limit)
    )
    entries = []
    for row in (await db.execute(query)).all():
        actor = row.actor_name or (f"user#{row.actor_id or row.user_id}" if (row.actor_id or row.user_id) else "-")
        entries.append(AuditEntry(row.ts, actor, row.action, row.detail if isinstance(row.detail, dict) else {}))
    return tuple(entries)


# --- render --------------------------------------------------------------------------------------------------------------------

_CONTROL = {code: " " for code in [*range(0, 32), 127]}


def _iso(moment: datetime | None) -> str:
    if moment is None or moment.year < 2000:  # TimescaleDB reports "never" as year 1
        return "-"
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _utc_minute(moment: datetime) -> str:
    """"2026-10-21 12:00 UTC": the form the history line (and the fill command) use for a time."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return f"{moment.astimezone(timezone.utc):%Y-%m-%d %H:%M} UTC"


def _utc_text(stamp: str | None) -> str:
    """An ISO time as UTC ("2026-10-11T17:00:00Z"), so that every time in the report is read the same way; the text as it is when
    it is not an ISO time with an offset."""
    if stamp is None:
        return "-"
    try:
        moment = datetime.fromisoformat(stamp.strip())
    except ValueError:
        return stamp
    return stamp if moment.tzinfo is None else moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _age(seconds: float | None) -> str:
    if seconds is None:
        return "never"
    s = max(0, int(seconds))
    if s < 120:
        return f"{s} s"
    if s < 7200:
        return f"{s // 60} min"
    if s < 172_800:
        return f"{s // 3600} h {s % 3600 // 60} min"
    return f"{s // 86_400} d {s % 86_400 // 3600} h"


def _bytes(n: int | float) -> str:
    size = float(n)
    for unit in ("bytes", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} bytes" if unit == "bytes" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def _compact(value: Mapping[str, Any]) -> str:
    """A small JSON object on one line."""
    return json.dumps(plain(dict(value)), sort_keys=True, separators=(",", ":"), default=str)


def _transform_strings(value: Any, transform: Callable[[str], str]) -> Any:
    """`value` with `transform` applied to every string in it, however deep (keys are left alone)."""
    if isinstance(value, str):
        return transform(value)
    if isinstance(value, Mapping):
        return {key: _transform_strings(item, transform) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_transform_strings(item, transform) for item in value]
    return value


def _flatten(value: Mapping[str, Any], prefix: str = "") -> dict[str, Any]:
    """A nested mapping as {"config.endpoint": ...}: one entry per leaf (a list is a leaf)."""
    flat: dict[str, Any] = {}
    for key, item in value.items():
        path = f"{prefix}{key}"
        if isinstance(item, Mapping):
            flat.update(_flatten(item, path + "."))
        else:
            flat[path] = item
    return flat


def _days(days: float | None) -> str:
    if days is None:
        return "n/a"
    return "over 10 years" if days > 3650 else f"{days:g} days"


def _same(a: Event, b: Event) -> bool:
    key = lambda e: (e.level, e.component, e.kind, e.source_id, e.code, e.message)  # noqa: E731
    return key(a) == key(b)


def _signed(seconds: float) -> str:
    return f"{round(seconds, 1) + 0.0:+.1f} s"


class _Renderer:
    def __init__(
        self, data: ReportData, detail: str, transform: Transform, caps: dict[str, int], source_limit: int | None,
        memo: dict[str, str], masked: bool,
    ) -> None:
        self.data, self.detail, self.caps, self.masked = data, detail, caps, masked
        self.full = detail == "full"
        self._transform = transform
        self._memo = memo
        self.names: dict[int, str] = {}
        self.kept: set[int] | None = None  # the sources a too-long report still shows; None: all
        self.problems: set[int] = set()
        if not isinstance(data.sources, Unavailable):
            self.names = {source.id: source.name for source in data.sources}
            ranked = self._ranked(data)
            self.problems = {sid for rank, sid in ranked if rank < 2}
            if source_limit is not None:
                self.kept = {sid for _, sid in ranked[: max(source_limit, 1)]}

    # every free-text value goes through here: transform, then fold line breaks, then clip (never the other way round)
    def text(self, value: Any, limit: int = LINE_LIMIT) -> str:
        if value is None:
            return "-"
        return clip(self._done(str(value)), limit)

    def _done(self, raw: str) -> str:
        done = self._memo.get(raw)
        if done is None:
            done = self._memo[raw] = " ".join(self._transform(raw).translate(_CONTROL).split())
        return done

    def compact(self, value: Mapping[str, Any], limit: int) -> str:
        """A detail as one JSON line. The strings are transformed BEFORE `json.dumps` escapes them: a known value with a quote, a
        backslash or a non-ASCII character no longer matches in the JSON text. `text` is the second net over the line."""
        return self.text(_compact(_transform_strings(plain(dict(value)), self._done)), limit)

    def src(self, source_id: int | None) -> str:
        if source_id is None:
            return "-"
        if source_id in self.names:
            return f'#{source_id} "{self.text(self.names[source_id], 60)}"'
        return f"#{source_id}" if isinstance(self.data.sources, Unavailable) else f"#{source_id} (deleted)"

    @staticmethod
    def _rank(source: SourceInfo, checks: Mapping[int, CheckInfo]) -> int:
        """0: its latest check failed or has not finished; 1: enabled but not online; 2: nothing to see."""
        check = checks.get(source.id)
        if check is not None and check.state in ("failed", "job_failed", "running", "queued"):
            return 0
        return 1 if source.enabled and source.status != "online" else 2

    @classmethod
    def _ranked(cls, data: ReportData) -> list[tuple[int, int]]:
        """(rank, source id) of every source, most worrying first."""
        if isinstance(data.sources, Unavailable):
            return []
        checks = {} if isinstance(data.checks, Unavailable) else {c.source_id: c for c in data.checks}
        return sorted((cls._rank(source, checks), source.id) for source in data.sources)

    def shown(self, source_id: int) -> bool:
        return self.kept is None or source_id in self.kept

    def omitted_sources(self) -> int:
        if self.kept is None or isinstance(self.data.sources, Unavailable):
            return 0
        return sum(1 for source in self.data.sources if source.id not in self.kept)

    @staticmethod
    def capped(lines: list[str], cap: int) -> list[str]:
        return lines if len(lines) <= cap else [*lines[:cap], f"... {len(lines) - cap} more lines omitted"]

    # -- the verdict ---------------------------------------------------------------------------------------------------------

    def latest_check(self) -> list[str]:
        checks = self.data.checks
        if isinstance(checks, Unavailable):
            return ["LATEST CHECK: unknown (the check results could not be read)"]
        if not checks:
            return ["LATEST CHECK: no connection check has been run"]
        latest = max(checks, key=lambda c: c.sort_key)
        lines = [f"LATEST CHECK: source {latest.source_id}{self._named(latest.source_id)} {self.verdict(latest)}"]
        failed = (c for c in checks if c.source_id != latest.source_id and c.state in ("failed", "job_failed"))
        others = sorted(failed, key=lambda c: c.source_id)
        if others:
            shown = "; ".join(f"source {c.source_id}{self._named(c.source_id)} {self.verdict(c)}" for c in others[:5])
            lines.append(f"ALSO FAILED: {shown}" + (f" (+{len(others) - 5} more)" if len(others) > 5 else ""))
        return lines

    def _named(self, source_id: int) -> str:
        if source_id in self.names:
            return f' "{self.text(self.names[source_id], 60)}"'
        return "" if isinstance(self.data.sources, Unavailable) else " (deleted)"

    def verdict(self, check: CheckInfo) -> str:
        state = check.state
        if state == "queued":
            return "is queued"
        if state == "running":
            last = check.steps[-1].id if check.steps else "start"
            return f"is still running (at step {self.text(last, 40)})"
        if state == "job_failed":
            return f"check job failed: {self.text(check.error or 'no error recorded', 120)}"
        if state == "failed":
            step = check.failed_step
            return f"FAILED at {self.text(step.id, 40) if step else self.text(check.first_failed or '?', 40)}: {self.reason(step)}"
        if state == "ok":
            return "all steps OK" + self._bad_points(check)
        return "has no usable result"

    @staticmethod
    def _bad_points(check: CheckInfo) -> str:
        """A check passes with bad points (the server answers, the device behind it does not): the verdict must not hide them."""
        step = next((s for s in check.steps if s.id == "read_points" and s.ok and s.points_bad), None)
        if step is None:
            return ""
        total = step.points_total if step.points_total is not None else step.points_bad
        return f", but {step.points_bad} of {total} points answered a Bad status"

    def reason(self, step: CheckStep | None) -> str:
        if step is None:
            return "no detail recorded"
        if step.status_name:
            hex_part = f" ({self.text(step.status_hex, 20)})" if step.status_hex else ""
            return self.text(step.status_name, 60) + hex_part
        if step.error_class or step.error_message:
            return self.text(": ".join(part for part in (step.error_class, step.error_message) if part), 120)
        return self.text(step.summary or "failed", 120)

    # -- sections ------------------------------------------------------------------------------------------------------------

    def environment(self, env: Environment) -> list[str]:
        data = self.data
        lines = [f"generated: {_iso(data.generated_at)}" + self._site_time(env, data.generated_at)]
        shown = "all" if data.source_id is None else f"#{data.source_id}"
        mask = "masked (addresses and host names appear as HOST-n and URN-n)" if self.masked else "not masked"
        lines.append(f"report: detail={data.detail}, {mask}, source filter: {shown}")
        built = f"built {self.text(_utc_text(env.build_time), 40)}"
        lines.append(f"api: build {self.text(env.build_id, 64)} ({built}), up {_age(env.uptime_seconds)}")
        lines.append(self._collector(env))
        lines.append(self._build_check(env))
        runtime = ", ".join(
            part for part in (
                f"Python {self.text(env.python, 20)}", self.text(env.system, 60) if env.system else "",
                f"asyncua {self.text(env.asyncua, 20)}" if env.asyncua else "",
                f"pymodbus {self.text(env.pymodbus, 20)}" if env.pymodbus else "",
            ) if part
        )
        lines.append(f"runtime: {runtime}")
        lines.append(
            "database: PostgreSQL " + (self.text(env.postgres, 60) if env.postgres else "unknown")
            + ", TimescaleDB " + (self.text(env.timescale, 20) if env.timescale else "not installed")
        )
        servers = "unknown" if env.dns_servers is None else (", ".join(self.text(item, 64) for item in env.dns_servers) or "none listed")
        if env.dns_servers == (EMBEDDED_RESOLVER,):
            servers += (
                " (Docker's embedded resolver; it forwards to the resolvers of the Docker host, which this container cannot see: "
                "compare with the DNS servers in the offline script's NETWORK section)"
            )
        lines.append(f"dns servers: {servers}")
        lines.extend(self._dns_lookups(data.dns_lookups))
        lines.extend(self._clocks(env))
        return lines

    def _dns_lookups(self, lookups: tuple[DnsLookup, ...] | None | Unavailable) -> list[str]:
        if lookups is None:
            return []
        if isinstance(lookups, Unavailable):
            return ["dns lookups: not tried"]
        if not lookups:
            return ["dns lookups: none needed (every source host is an address)"]
        lines = []
        for lookup in lookups:
            host, took = self.text(lookup.host, 100), f"{lookup.ms:.0f} ms"
            if lookup.ok:
                lines.append(f"dns lookup {host}: OK in {took} -> " + ", ".join(self.text(address, 64) for address in lookup.addresses))
            else:
                lines.append(f"dns lookup {host}: FAILED in {took}: {self.text(lookup.error or 'no answer', 120)}")
        if not all(lookup.ok for lookup in lookups):
            lines.append(
                "dns lookup: names that only the cluster knows often do not resolve from Docker on Windows; use an address the "
                "workstation can reach (docs/field-debugging.md, First connection day)"
            )
        return lines

    def _site_time(self, env: Environment, moment: datetime) -> str:
        if not env.site_timezone:
            return ""
        try:
            local = moment.astimezone(ZoneInfo(env.site_timezone))
        except Exception:
            return f", site time zone {self.text(env.site_timezone, 40)} is unknown"
        return f", site time {local:%Y-%m-%d %H:%M:%S %Z} ({self.text(env.site_timezone, 40)})"

    def _collector(self, env: Environment) -> str:
        if env.collector_age_seconds is None:
            return "collector: no heartbeat on record (never started, or its database is not this one)"
        build = self.text(env.collector_build_id, 64) if env.collector_build_id else "unknown (an older collector build)"
        stale = " (STALE: the collector is not running)" if env.collector_age_seconds > STALE_AFTER_SECONDS else ""
        return f"collector: build {build}, last heartbeat {_age(env.collector_age_seconds)} ago{stale}"

    def _build_check(self, env: Environment) -> str:
        if not env.collector_build_id:
            return "build check: unknown (no collector build on record)"
        if env.collector_build_id == env.build_id:
            return "build check: OK (api and collector run the same build)"
        return (
            f"build check: MISMATCH api {self.text(env.build_id, 64)} vs collector {self.text(env.collector_build_id, 64)}: "
            "one of them is an older container, rebuild and restart both"
        )

    def _clocks(self, env: Environment) -> list[str]:
        lines = []
        if env.container_time and env.database_time:
            diff = (env.database_time - env.container_time).total_seconds()
            lines.append(f"clock: database minus container = {_signed(diff)} (both run on one VM clock, so this cannot show drift)")
        if env.client_time and env.container_time:
            diff = (env.client_time - env.container_time).total_seconds()
            line = f"clock: browser minus container = {_signed(diff)}"
            if abs(diff) > CLOCK_WARN_SECONDS:
                line += (
                    ": the browser and the container disagree by more than 30 s, a local VM clock problem "
                    "(Docker/WSL2 clock drift), not the SCADA"
                )
            lines.append(line)
        elif env.client_time is None:
            lines.append(
                "clock: browser time not supplied (build the report from the Diagnostics page to compare it with the container clock)"
            )
        seen = None if isinstance(self.data.checks, Unavailable) else [c for c in self.data.checks if c.server_time]
        if seen:
            latest = max(seen, key=lambda c: c.sort_key)
            skew = f", skew {_signed(latest.skew_seconds)} against the container clock" if latest.skew_seconds is not None else ""
            seen_at = f"source {latest.source_id}, check job {latest.job_id}"
            lines.append(f"clock: last server time seen {self.text(latest.server_time, 40)} ({seen_at}){skew}")
        return lines

    def settings(self, info: SettingsInfo) -> list[str]:
        if not info.values:
            return ["none"]
        return [" ".join(f"{self.text(name, 40)}={self.text(value, 60)}" for name, value in info.values)]

    def sources(self, sources: Sequence[SourceInfo]) -> list[str]:
        if not sources:
            return [f"no source with id {self.data.source_id}" if self.data.source_id is not None else "no sources configured"]
        lines = []
        for source in sources:
            if not self.shown(source.id):
                continue
            line = (
                f'#{source.id} "{self.text(source.name, 60)}" {self.text(source.connector_type, 20)} '
                f"{'DISABLED ' if not source.enabled else 'enabled ' if self.full else ''}status={self.text(source.status, 20)} "
            )
            if self.full or source.status != "online":  # an online source was just seen
                line += f"last_seen={_iso(source.last_seen) if source.last_seen else 'never'} "
            line += f"secret={'yes' if source.has_secret else 'no'}"
            if source.authentication:
                line += f" authentication={source.authentication}"
            fields = source.config if self.full else tuple(pair for pair in source.config if pair[0] in SUMMARY_CONFIG_FIELDS)
            config = " ".join(f"{self.text(k, 30)}={self.text(v, 120 if self.full else 70)}" for k, v in fields)
            if self.full:  # one line each for the facts, the config and the last error
                lines.append(line)
                if config:
                    lines.append("   config: " + config)
            else:  # compact: the config joins the first line
                lines.append(f"{line} {config}" if config else line)
            if source.last_error and (self.full or source.status != "online"):
                lines.append("   last error: " + self.text(source.last_error, 300 if self.full else 80))
        if (n := self.omitted_sources()):
            lines.append(
                f"... {n} more sources omitted to fit one part (the ones with problems are kept); use detail=full or source=<id>"
            )
        return lines

    def health(self, health: Sequence[SourceHealth]) -> list[str]:
        lines = []
        events = self.data.journal
        healthy_left_out = 0
        errors_left_out = False
        for item in health:
            if not self.shown(item.source_id):
                continue
            # A source whose backfill is in trouble keeps its block even when the source itself reads fine: its history line is the
            # only place that says so, and the note below must not call it problem-free.
            if not self.caps["health_sources"] and item.source_id not in self.problems and not self._history_alarm(item.history):
                healthy_left_out += 1
                continue
            newest = "no reading on record" if item.newest_age_seconds is None else f"newest reading {_age(item.newest_age_seconds)} ago"
            if self.full:
                bad = f", {item.bad} bad ({item.bad / item.reads:.1%})" if item.reads else ""
                reads = f"{item.reads} reads in {HEALTH_WINDOW_MINUTES} min ({item.reads / HEALTH_WINDOW_MINUTES:.1f}/min)"
            else:  # compact
                bad = f", {item.bad / item.reads:.1%} bad" if item.reads else ""
                reads = f"{item.reads / HEALTH_WINDOW_MINUTES:.1f} reads/min"
            lines.append(f"{self.src(item.source_id)}: {reads}{bad}, {newest}")
            # A source the backfill never ran for says nothing: every older report stays as it was. A tight report keeps only the
            # history lines that say something is wrong (see TRIM_STEPS).
            if item.history is not None and (self.caps["history_lines"] or self._history_trouble(item.history)):
                lines.append(self._history_line(item.history))
            if isinstance(events, Unavailable):
                lines.append(f"   errors: journal unavailable ({events.error})")
                continue
            groups = self._error_groups(events, item.source_id)
            cap = self.caps["health_errors"]
            for first, last, count, event in groups[:cap]:
                lines.append("   " + self._event_line(event, count, first, with_source=False))
            if len(groups) > cap > 0:
                lines.append(f"   ... {len(groups) - cap} more distinct errors omitted")
            errors_left_out = errors_left_out or (cap == 0 and bool(groups))
        if errors_left_out:
            lines.append("... distinct errors per source omitted to fit one part (see JOURNAL, or use detail=full or source=<id>)")
        if healthy_left_out:
            lines.append(f"... health of {healthy_left_out} sources without a problem omitted to fit one part")
        # One line for the whole section: the same failed read would otherwise print under every source. A tight report drops it.
        if lines and (unreadable := self.data.history_unavailable) is not None and self.caps["history_lines"]:
            lines.append(f"history: unavailable ({self.text(unreadable.error, 80)})")
        return lines or ["no sources"]

    @staticmethod
    def _history_trouble(info: HistoryInfo) -> bool:
        """A history that is not simply idle or filling: the backfill is backing off or cannot read history, or has an error on
        record."""
        return info.state in ("backing_off", "not_supported") or bool(info.last_error)

    @staticmethod
    def _history_alarm(info: HistoryInfo | None) -> bool:
        """A backfill that needs a look even when the source reads fine: backing off, or an error on record. Not `not_supported`
        (the source simply has no history interface, which is no fault) and not a row that could not be read."""
        return info is not None and (info.state == "backing_off" or bool(info.last_error))

    def _history_line(self, info: HistoryInfo) -> str:
        """One line under a source's health: where the history backfill stands, in plain words and UTC."""
        through = f"answered through {_utc_minute(info.answered_through)}" if info.answered_through else "nothing answered yet"
        line = (
            f"   history: {self.text(info.state.replace('_', ' '), 20)}, {through}, since restart {info.rows_new:,} new / "
            f"{info.rows_already:,} already / {info.rows_differing:,} differing / {info.rows_rejected:,} rejected, "
            f"{info.short_hours:,} hour{'' if info.short_hours == 1 else 's'} short, "
            f"{info.requests:,} request{'' if info.requests == 1 else 's'}, {info.failures:,} failed"
        )
        if info.next_try_at is not None:
            line += f", next try {_utc_minute(info.next_try_at)}"
        if info.last_error:
            tail = ", last error: "
            line += tail + self.text(info.last_error, max(LINE_LIMIT - len(line) - len(tail), 20))
        return line

    @staticmethod
    def _error_groups(events: Sequence[Event], source_id: int) -> list[tuple[datetime, datetime, int, Event]]:
        groups: dict[tuple[str, str | None, str], list[Event]] = {}
        for event in events:
            if event.source_id == source_id and event.level in ("warning", "error"):
                groups.setdefault((event.kind, event.code, event.message), []).append(event)
        found = [
            (min(e.ts for e in same), max(e.ts for e in same), len(same), max(same, key=lambda e: e.ts)) for same in groups.values()
        ]
        return sorted(found, key=lambda g: g[1], reverse=True)

    def points(self, info: PointsInfo) -> list[str]:
        total = sum(n for _, n in info.counts)
        if not total:
            return ["no points"]
        lines = [f"{total} points: " + ", ".join(f"{state} {n}" for state, n in info.counts)]
        if self.full:
            problems: dict[int, list[str]] = {}
            for source_id, state, n in info.by_source:
                if state in ("bad", "stale", "no data"):
                    problems.setdefault(source_id, []).append(f"{state} {n}")
            lines.extend(f"{self.src(sid)}: {', '.join(found)}" for sid, found in sorted(problems.items()) if self.shown(sid))
        problems_total = sum(n for state, n in info.counts if state in ("bad", "stale", "no data"))
        worst = [
            f"   {self.src(p.source_id)} {self.text(p.address, 100)}"
            + (f" ({self.text(p.name, 60)})" if p.name != p.address else "")
            + f" {p.state}"
            + (f" quality={p.quality}" if p.quality else "")
            + (f" value={p.value:g}" if p.value is not None else "")
            + (f", last reading {_age(p.age_seconds)} ago" if p.age_seconds is not None else ", never read")
            for p in info.worst
        ]
        shown = worst[: self.caps["points"]]
        if (omitted := max(problems_total, len(worst)) - len(shown)) > 0:
            shown.append(f"   ... {omitted} more lines omitted")
        return [*lines, *(["worst points (bad first, then stale, then no data):"] if shown else []), *shown]

    def checks(self, checks: Sequence[CheckInfo]) -> list[str]:
        if not checks:
            return ["no connection check has been run"]
        lines = []
        for check in sorted(checks, key=lambda c: c.source_id):
            if self.shown(check.source_id):
                lines.extend(self._check(check))
        if self.data.source_id is None and not isinstance(self.data.sources, Unavailable):
            missing = [s.id for s in self.data.sources if s.id not in {c.source_id for c in checks}]
            if missing:
                plural = "s" if len(missing) != 1 else ""
                listed = ": " + ", ".join(map(str, missing)) if len(missing) <= (20 if self.full else 8) else ""
                lines.append(f"no connection check has been run for {len(missing)} other source{plural}{listed}")
        if (n := sum(1 for c in checks if not self.shown(c.source_id))):
            lines.append(f"... checks of {n} more sources omitted to fit one part")
        return lines

    def _check(self, check: CheckInfo) -> list[str]:
        kind = f" ({self.text(check.connector_type, 20)})" if check.connector_type else ""
        when = f"job {check.job_id} {self.text(check.job_status, 20)}, {_iso(check.finished_at or check.created_at)}"
        lines = [f"{self.src(check.source_id)}{kind}: {when}: {self.verdict(check)}"]
        steps = check.steps
        if self.full:
            for number, step in enumerate(steps, start=1):
                lines.extend(self._step_lines(number, step))
        else:
            ok = [step for step in steps if step.ok]
            if ok and check.state != "ok":  # an all-OK check says so in its first line
                timed = (f"{self.text(s.id, 30)} {s.ms:.0f} ms" if s.ms is not None else self.text(s.id, 30) for s in ok)
                lines.append("   ok: " + ", ".join(timed))
            for number, step in enumerate(steps, start=1):
                if step.ok is False:
                    lines.extend(self._step_lines(number, step))
            if any(step.id == "session" and step.ok is False for step in steps):
                for s in steps:  # the session hints say "the thumbprint in the certificates step": show it, with the full line allowance
                    if s.ok and s.id in SESSION_CONTEXT_STEPS and s.summary:
                        prefix = f"   {self.text(s.id, 30)}: "
                        lines.append(prefix + self.text(s.summary, LINE_LIMIT - len(prefix)))
            skipped = [step.id for step in steps if step.ok is None]
            if skipped:
                lines.append("   skipped: " + ", ".join(self.text(s, 30) for s in skipped))
            if check.state in ("ok", "failed"):
                for s in steps:
                    if s.ok and s.id in KEY_STEPS and s.summary:
                        prefix = f"   {self.text(s.id, 30)}: "  # the whole line: read_points names up to three bad statuses
                        lines.append(prefix + self.text(s.summary, LINE_LIMIT - len(prefix)))
                        lines.extend(self._hint_lines(s.hint))  # read_points: a passed step says who to ask about the bad points
        if check.skew_seconds is not None:
            server, local = self.text(check.server_time, 40), self.text(check.local_time, 40)
            lines.append(f"   clock: server {server}, local {local}, skew {_signed(check.skew_seconds)}")
        return lines

    def _step_lines(self, number: int, step: CheckStep) -> list[str]:
        mark = "ok" if step.ok else ("FAIL" if step.ok is False else "skipped")
        ms = f" {step.ms:.0f} ms" if step.ms is not None else ""
        head = f"   {number} {self.text(step.id, 30)} {mark}{ms}"
        lines = [head + (f": {self.text(step.summary, LINE_LIMIT - len(head) - 2)}" if step.summary else "")]
        if step.ok and step.id in KEY_STEPS:
            lines.extend(self._hint_lines(step.hint))
        if step.ok is False:
            status = step.status_hex
            if step.status_name:
                status = step.status_name + (f" ({step.status_hex})" if step.status_hex else "")
            error = ": ".join(part for part in (step.error_class, status, step.error_message) if part)
            if error:
                lines.append("      error: " + self.text(error, 240))
            lines.extend(self._hint_lines(step.hint))
        return lines

    def _hint_lines(self, hint: str | None) -> list[str]:
        """One `hint:` line per line of the hint (read_points gives one per bad status; the others are a single line)."""
        return ["      hint: " + self.text(part, 300) for part in (hint or "").split("\n") if part.strip()]

    def _event_line(self, event: Event, count: int, first: datetime | None, *, with_source: bool = True) -> str:
        head = [_iso(event.ts), self.text(event.level, 10), self.text(event.component, 12), self.text(event.kind, 30)]
        if with_source and event.source_id is not None:
            head.append(f"source={event.source_id}")
        if event.code:
            head.append(f"code={self.text(event.code, 40)}")
        if count > 1:
            head.append(f"x{count} since {_iso(first)}")
        detail = ""
        if event.detail:
            detail = " " + self.compact(event.detail, 120)
        return " ".join(head) + ": " + self.text(event.message, MESSAGE_CHARS) + detail

    def events(self, events: Sequence[Event], cap: int, empty: str) -> list[str]:
        if not events:
            return [empty]
        runs: list[tuple[Event, int, datetime]] = []
        for event in events:  # newest first: a run of identical events is one line with a count
            if runs and _same(runs[-1][0], event):
                runs[-1] = (runs[-1][0], runs[-1][1] + 1, event.ts)
            else:
                runs.append((event, 1, event.ts))
        return self.capped([self._event_line(event, count, first) for event, count, first in runs], cap)

    def scans(self, scans: Sequence[ScanInfo]) -> list[str]:
        if not scans:
            return ["no scans"]
        lines = []
        for scan in scans:
            line = f"scan {scan.id}: {self.text(scan.status, 20)}" + (f" (stage {self.text(scan.stage, 20)})" if scan.stage else "")
            line += f", created {_iso(scan.created_at)}, finished {_iso(scan.finished_at)}"
            if scan.progress:
                line += ", " + " ".join(f"{self.text(k, 20)}={v}" for k, v in scan.progress)
            if scan.outcomes:
                line += "; findings: " + ", ".join(f"{self.text(k, 20)} {v}" for k, v in scan.outcomes)
            lines.append(line)
            if scan.error:
                lines.append("   error: " + self.text(scan.error, 200))
        return self.capped(lines, self.caps["scans"])

    def storage(self, info: StorageInfo) -> list[str]:
        lines = []
        stats = info.stats
        if stats is not None:
            s = stats.settings
            lines.append(
                f"database {_bytes(stats.database_bytes)}; readings {_bytes(stats.readings_bytes_total)} (compressed "
                f"{_bytes(stats.readings_bytes_compressed)} of {_bytes(stats.readings_bytes_uncompressed)}); 1m rollup "
                f"{_bytes(stats.rollup_1m_bytes)}; 1h rollup {_bytes(stats.rollup_1h_bytes)}"
            )
            until = _days(stats.days_until_full)
            lines.append(
                f"disk: capacity {_bytes(stats.disk_capacity_bytes)}, used {stats.used_pct:g}%, "
                f"growth {_bytes(stats.growth_bytes_per_day)}/day, "
                f"full in {until}, warning at {s.warn_threshold_pct}%: {'YES' if stats.warn else 'no'}"
            )
            lines.append(
                f"retention: raw {s.raw_retention_days} d, compress after {s.compress_after_days} d, "
                f"1m rollup {s.rollup_1m_retention_days} d"
                + (": PAUSED (a restore paused it; saving the storage settings re-arms it)" if stats.retention_paused else "")
            )
            lines.append("rows per day (hourly tier): " + ", ".join(f"{d.day:%m-%d}={d.rows}" for d in stats.rows_per_day))
        ailing = [job for job in info.jobs if not job.scheduled or job.last_status == "Failed" or (job.failures or 0) > 0]
        lines.append(f"policy jobs: {len(info.jobs)} in all, {len(ailing)} not scheduled or failing")
        for job in info.jobs if self.full else ailing:  # a summary names only the ones that need a look
            lines.append(
                f"policy {self.text(job.proc, 40)} {self.text(job.hypertable or '-', 30)}: "
                f"{'scheduled' if job.scheduled else 'NOT SCHEDULED'}, last run {self.text(job.last_status or 'never', 20)}, "
                f"last success {_iso(job.last_finish)}, next {_iso(job.next_start)}, "
                f"failures {job.failures if job.failures is not None else '-'}"
            )
        lines.append(f"journal: {info.journal_rows} events kept, oldest {_iso(info.journal_oldest)}")
        return lines

    def audit(self, entries: Sequence[AuditEntry]) -> list[str]:
        if not entries:
            return ["no audit entries"]
        lines = []
        for entry in entries:
            head = f"{_iso(entry.ts)} {self.text(entry.actor, 40)} {self.text(entry.action, 40)}"
            lines.append(head + self._audit_detail(entry, len(head)))
        return self.capped(lines, self.caps["audit"])

    def _audit_detail(self, entry: AuditEntry, used: int) -> str:
        detail = entry.detail
        if not detail:
            return ""
        story = self._source_story(entry.action, detail)
        if story is None:
            return " " + self.compact(detail, 160)
        subject, label, pairs, more = story
        shown = " " + self.compact(subject, 80) if subject else ""
        room = LINE_LIMIT - used - len(shown) - len(label) - 2
        return f"{shown} {label}: " + clip(", ".join(pairs) + more, max(room, 60))

    def _source_story(self, action: str, detail: Mapping[str, Any]) -> tuple[dict[str, Any], str, list[str], str] | None:
        """(the rest of the detail, "changed" | "created", the field texts, "(+N more)") of a source.updated / source.created row, or
        None for any other row (and for one of these without the shape the API writes)."""
        if action == "source.updated" and isinstance(detail.get("before"), Mapping) and isinstance(detail.get("after"), Mapping):
            before, after = _flatten(detail["before"]), _flatten(detail["after"])
            changed = [key for key in {*before, *after} if before.get(key) != after.get(key)]
            # what the secret or a credential did first: it is the change a reader most needs to see, and the shown ones are few
            changed.sort(key=lambda key: (key in AUDIT_VALUE_FIELDS, key))
            pairs = [self._audit_pair(key, before.get(key), after.get(key)) for key in changed[:AUDIT_PAIRS]]
            more = f" (+{len(changed) - AUDIT_PAIRS} more)" if len(changed) > AUDIT_PAIRS else ""
            if pairs:
                return {k: v for k, v in detail.items() if k not in ("before", "after")}, "changed", pairs, more
        if action == "source.created":
            flat = _flatten(detail)
            host = next((f"config.{name}" for name in HOST_FIELDS if f"config.{name}" in flat), None)
            keys = ("name", "connector_type", host, "config.security_policy")
            pairs = [f"{key}={self._audit_value(flat[key])}" for key in keys if key in flat]
            if pairs:
                return {k: v for k, v in detail.items() if k == "source_id"}, "created", pairs, ""
        return None

    def _audit_pair(self, key: str, before: Any, after: Any) -> str:
        if key not in AUDIT_VALUE_FIELDS:
            return f"{self.text(key, 40)} changed"
        return f"{self.text(key, 40)} {self._audit_value(before)} -> {self._audit_value(after)}"

    def _audit_value(self, value: Any) -> str:
        """A value of an audited field, through the same transform as every other text, before it is clipped."""
        if value is None:
            return "(unset)"
        if isinstance(value, bool):
            return "true" if value else "false"
        shown = value if isinstance(value, str) else json.dumps(plain(value), sort_keys=True, default=str)
        return self.text(shown, 50) or "(empty)"


def _assemble(
    data: ReportData, detail: str, transform: Transform, caps: dict[str, int], source_limit: int | None,
    memo: dict[str, str], masked: bool,
) -> str:
    renderer = _Renderer(data, detail, transform, caps, source_limit, memo, masked)
    jobs: tuple[tuple[str, Any, Callable[[Any], list[str]]], ...] = (
        ("ENVIRONMENT", data.environment, renderer.environment),
        ("SETTINGS", data.settings, renderer.settings),
        ("SOURCES", data.sources, renderer.sources),
        ("SOURCE HEALTH", data.health, renderer.health),
        ("POINTS", data.points, renderer.points),
        ("CONNECTION CHECKS", data.checks, renderer.checks),
        ("JOURNAL", data.journal, lambda events: renderer.events(events, caps["journal"], "no events recorded")),
        ("SCANS", data.scans, renderer.scans),
        ("STORAGE AND RETENTION", data.storage, renderer.storage),
        ("AUDIT TAIL", data.audit, renderer.audit),
        ("API ERRORS", data.api_errors, lambda events: renderer.events(events, caps["api_errors"], "no server errors recorded")),
    )
    lines: list[str] = []
    try:
        lines.extend(renderer.latest_check())
    except Exception as exc:
        lines.append(f"LATEST CHECK: unknown (render {type(exc).__name__})")
    for title, value, build in jobs:
        lines.append(f"== {title} ==")
        if isinstance(value, Unavailable):
            lines.append(f"section unavailable: {value.error}")
            continue
        try:
            lines.extend(build(value))
        except Exception as exc:  # never a half report because one section holds odd data
            lines.append(f"section unavailable: render {type(exc).__name__}")
    return "\n".join(clip(line, LINE_LIMIT) for line in lines)


def _hard_clip(body: str, limit: int) -> str:
    """The last resort when trimming was not enough: whole lines from the top, then a note. Always <= limit."""
    lines = body.split("\n")
    kept: list[str] = []
    size = 0
    for line in lines:
        if size + len(line) + 1 > limit - 60:
            break
        kept.append(line)
        size += len(line) + 1
    kept.append(f"... {len(lines) - len(kept)} more lines omitted to fit the size limit")
    return "\n".join(kept)


def render(data: ReportData, detail: Detail, transform: Transform, *, masked: bool = False, max_chars: int | None = None) -> str:
    """The report body (no header, no footer: `redact.finalize` adds them) for `data`.

    `transform` is applied to every free-text value before it is clipped; it has no default on purpose. `masked` only says so in
    the ENVIRONMENT section (the caller's transform does the masking). `max_chars` defaults to
    SUMMARY_BODY_CHARS (one part) for `summary` and FULL_BODY_CHARS for `full`; the body is trimmed until it fits (see the module
    doc), and is never longer. Pure: the same data gives the same text. Aliases a masking `transform` handed out for lines that
    were trimmed away stay in the Masker's legend, so filter the legend by what the final text contains.
    """
    if detail not in ("summary", "full"):
        raise ValueError(f"detail must be summary or full, not {detail!r}")
    limit = max_chars or (FULL_BODY_CHARS if detail == "full" else SUMMARY_BODY_CHARS)
    column = detail == "full"
    caps = {name: pair[column] for name, pair in CAPS.items()}
    caps["health_sources"] = 1  # 0: only the sources with a problem (or a backfill in trouble) keep their SOURCE HEALTH lines
    caps["history_lines"] = 1  # 0: only the history lines of a backfill in trouble stay
    source_limit: int | None = None
    count = 0 if isinstance(data.sources, Unavailable) else len(data.sources)
    memo: dict[str, str] = {}  # one transform per distinct text, however many times the body is rebuilt
    while True:
        body = _assemble(data, detail, transform, caps, source_limit, memo, masked)
        if len(body) <= limit:
            return body
        step = next(((name, floor) for name, floor in TRIM_STEPS if caps[name] > floor), None)
        if step is not None:
            name, floor = step
            caps[name] = max(floor, caps[name] // 2)
            continue
        if count > 1 and (source_limit is None or source_limit > 1):
            source_limit = max(1, (count if source_limit is None else source_limit) // 2)
            continue
        return _hard_clip(body, limit)
