from abc import ABC, abstractmethod
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, ClassVar
from urllib.parse import urlparse

from pydantic import BaseModel

if TYPE_CHECKING:  # diagnostics.check must stay importable without the connectors, so the import here is lazy
    from dcdash.diagnostics.check import CheckResult, Publish

GOOD = 0
BAD = 1


@dataclass(frozen=True)
class PointDescriptor:
    address: str
    name: str
    data_type: str = "float"
    unit_hint: str | None = None


@dataclass(frozen=True)
class PointValue:
    address: str
    ts: datetime
    value: float | None
    quality: int = GOOD
    status: str | None = None  # why a reading is bad, when the source says (OPC UA: "BadNodeIdUnknown (0x80340000)")


@dataclass(frozen=True)
class HistoryPage:
    """One answer to `Connector.read_history`."""

    values: list[PointValue]
    complete_until: datetime  # aware UTC: complete for EVERY requested address before this instant (a row AT it may be missing)
    rejected: int = 0  # items whose time the normalisation rules refused (dropped, only counted)
    unknown: tuple[str, ...] = ()  # addresses the source does not have


@dataclass(frozen=True)
class ConnectionCheck:
    ok: bool
    status: str  # ok | auth_failed | timeout | unreachable | protocol_error
    latency_ms: float | None = None
    message: str = ""


@dataclass(frozen=True)
class Claim:
    """What a probe recognised at an address: a ready-to-store source configuration."""

    connector_type: str
    config: dict[str, Any]
    label: str
    identity: dict[str, Any] | None = None  # what the server says about itself (OPC UA application URI, simulator instance), when it does


def url_host_port(url: object) -> tuple[str, int | None, str] | None:
    """(host lowercased, explicit port or None, scheme) of a URL string; None if it is not a usable URL.

    Never raises: junk values, malformed ports and bracketed hosts all give None.
    """
    if not isinstance(url, str):
        return None
    try:
        parsed = urlparse(url)
        host, port = parsed.hostname, parsed.port
    except ValueError:  # bad port, out of range, malformed [bracketed] host
        return None
    if not host or port == 0:
        return None
    return host.lower(), port, parsed.scheme


class ConnectorError(Exception):
    def __init__(self, status: str, message: str, *, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after  # seconds the source asked to wait (Retry-After), when it did


class Connector(ABC):
    """One kind of data source. Implementations must only retrieve data."""

    type: ClassVar[str]
    config_schema: ClassVar[type[BaseModel]]
    default_ports: ClassVar[tuple[int, ...]] = ()
    supports_history: ClassVar[bool] = False
    # False for a source that is never asked for values (the `file` type is filled by importing files): the poll loop skips it, and
    # Test, Check connection and Browse neither run nor change its status.
    polls: ClassVar[bool] = True
    description: ClassVar[str] = ""  # one sentence under the type in the "Add source" form; empty for the types that explain themselves

    @classmethod
    async def probe(cls, host: str, port: int, timeout: float = 3.0) -> Claim | None:
        """Return a Claim if this connector understands the service at host:port, else None.

        Must only issue requests the connector may already issue (read-only), and must give up
        after `timeout` seconds. Never raises for an unreachable or unrecognised service.
        """
        return None

    @classmethod
    def endpoint_key(cls, config: dict[str, Any]) -> tuple[str, int, str] | None:
        """(host lowercased, port, qualifier) identifying the endpoint a configuration points at."""
        return None

    def __init__(self, config: BaseModel, secret: str | None = None) -> None:
        self.config = config
        self.secret = secret

    @abstractmethod
    async def test(self) -> ConnectionCheck: ...

    @abstractmethod
    async def browse(self) -> list[PointDescriptor]: ...

    @abstractmethod
    async def read(self, addresses: list[str]) -> list[PointValue]: ...

    async def read_history(
        self,
        addresses: list[str],
        start: datetime,
        end: datetime,
        resolution: timedelta | None = None,
        *,
        after: Mapping[str, datetime] | None = None,
        limit: int | None = None,
    ) -> HistoryPage:
        """The samples the source stored for `addresses` between `start` and `end` (aware, both inclusive), for the backfill.

        The contract every implementation keeps:
        - read-only: GET requests only, and this interface has no write method;
        - a value carries the SOURCE's time as an aware UTC instant, never ours, and its quality is mapped by the normalisation
          rules (GOOD only for a good code, BAD otherwise, the label kept in `PointValue.status`);
        - `resolution=None` means the raw samples, the only value the backfill asks for;
        - the answer may be cut at the source's row limit: `HistoryPage.complete_until` says up to where it is complete for EVERY
          requested address, and the caller continues from it (the next window starts AT it, because a row at that instant may be
          missing, even when it equals `end`). `after` maps an address to the last instant already received for it,
          so a page cut inside the repeated autumn hour still tells the first pass from the second;
        - `limit` is the most rows the caller wants in one answer; a source may cut earlier or later, `complete_until` says where;
        - a connector that sets `supports_history` must stamp the values of `read()` with the source's time too, so a live value and
          its history twin are one `(point, time)` pair and a re-read of a polled window adds nothing.

        The default is for source types that keep no history.
        """
        raise ConnectorError("not_supported", "this source type cannot read history")

    async def check(self, points: list[str], publish: "Publish | None" = None) -> "CheckResult":
        """The step-by-step connection check of this source. `points` are the addresses mapped to it (at most 200), `publish`
        is awaited with the partial result after every step.

        The default is one step, `test`, which runs `test()`; a connector with more to tell (OPC UA) overrides this with a
        `Checker` of its own. Read-only, like everything a connector does. Never raises for a failed step.
        """
        from dcdash.diagnostics.check import Checker, StepFailed, StepOutcome

        checker = Checker(
            self.type, publish, known=[self.secret] if self.secret else [],
            step_timeout=getattr(self.config, "timeout_seconds", None),
        )

        async def run_test() -> StepOutcome:
            outcome = await self.test()
            if not outcome.ok:
                text = f"{outcome.status}: {outcome.message}" if outcome.message else outcome.status
                raise StepFailed(text, summary=outcome.status, error_class="ConnectorError", hint=_ONLY_OPCUA_STEPS)
            latency = "" if outcome.latency_ms is None else f" in {outcome.latency_ms:.0f} ms"
            return StepOutcome(f"connected{latency}", hint=_ONLY_OPCUA_STEPS)

        await checker.step("test", "Connection test", run_test)
        return await checker.finish()

    async def identity(self) -> dict[str, Any] | None:
        """What the server says about itself (read-only, anonymous where the protocol allows it), or None when unknown.

        Used by Test and the connection check. Never raises: a server that cannot be asked gives None.
        """
        return None

    async def close(self) -> None:
        return None


_ONLY_OPCUA_STEPS = "A detailed step-by-step check exists for OPC UA sources only; this source type gets a single connection test."


ConnectorFactory = Callable[[str, dict[str, Any], str | None], Connector]

_REGISTRY: dict[str, type[Connector]] = {}


def register(cls: type[Connector]) -> type[Connector]:
    _REGISTRY[cls.type] = cls
    return cls


def connector_types() -> dict[str, type[Connector]]:
    return dict(_REGISTRY)


def create_connector(type_name: str, config: dict[str, Any], secret: str | None = None) -> Connector:
    try:
        cls = _REGISTRY[type_name]
    except KeyError:
        raise ValueError(f"unknown connector type: {type_name}") from None
    return cls(cls.config_schema.model_validate(config), secret)
