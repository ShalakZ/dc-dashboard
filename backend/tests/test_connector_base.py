from datetime import datetime, timezone

import pytest
from pydantic import BaseModel, ValidationError

from dcdash.connectors.base import (
    ConnectionCheck, Connector, ConnectorError, PointDescriptor, PointValue,
    connector_types, create_connector, register,
)


class EchoConfig(BaseModel):
    host: str
    port: int = 502


@register
class EchoConnector(Connector):
    type = "echo-test"
    config_schema = EchoConfig

    async def test(self) -> ConnectionCheck:
        return ConnectionCheck(True, "ok", 1.0)

    async def browse(self) -> list[PointDescriptor]:
        return [PointDescriptor("a", "A")]

    async def read(self, addresses: list[str]) -> list[PointValue]:
        return [PointValue(a, datetime.now(timezone.utc), 1.0) for a in addresses]


def test_registered_connector_is_listed():
    assert connector_types()["echo-test"] is EchoConnector


def test_create_validates_config_and_applies_defaults():
    connector = create_connector("echo-test", {"host": "10.0.0.5"}, "pw")
    assert connector.config.host == "10.0.0.5"
    assert connector.config.port == 502
    assert connector.secret == "pw"


def test_create_rejects_invalid_config():
    with pytest.raises(ValidationError):
        create_connector("echo-test", {"port": "not-a-number"})


def test_create_rejects_unknown_type():
    with pytest.raises(ValueError, match="unknown connector type: nope"):
        create_connector("nope", {})


def test_connector_error_carries_status_and_message():
    error = ConnectorError("timeout", "no answer in 5 s")
    assert error.status == "timeout"
    assert str(error) == "no answer in 5 s"


async def test_close_is_optional():
    await create_connector("echo-test", {"host": "h"}).close()
