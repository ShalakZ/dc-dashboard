from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, ClassVar

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


class ConnectorError(Exception):
    def __init__(self, status: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Connector(ABC):
    """One kind of data source. Implementations must only retrieve data."""

    type: ClassVar[str]
    config_schema: ClassVar[type[BaseModel]]

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
