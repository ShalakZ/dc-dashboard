from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, ClassVar
from urllib.parse import urlparse

from pydantic import BaseModel

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
    def __init__(self, status: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Connector(ABC):
    """One kind of data source. Implementations must only retrieve data."""

    type: ClassVar[str]
    config_schema: ClassVar[type[BaseModel]]
    default_ports: ClassVar[tuple[int, ...]] = ()

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

    async def close(self) -> None:
        return None


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
