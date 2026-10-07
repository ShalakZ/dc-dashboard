"""OPC UA connector. Read-only: it only ever issues Browse and Read services."""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from asyncua import Client, Node, ua
from pydantic import BaseModel, Field

from dcdash.connectors.base import (
    BAD,
    GOOD,
    ConnectionCheck,
    Connector,
    ConnectorError,
    PointDescriptor,
    PointValue,
    register,
)

_AUTH_CODES = {
    ua.StatusCodes.BadUserAccessDenied,
    ua.StatusCodes.BadIdentityTokenRejected,
    ua.StatusCodes.BadIdentityTokenInvalid,
}
_OBJECTS_FOLDER = ua.NodeId(ua.ObjectIds.ObjectsFolder)


class OpcUaConfig(BaseModel):
    endpoint: str = Field(..., pattern=r"^opc\.tcp://", json_schema_extra={"title": "Endpoint URL"})
    security_policy: Literal["none", "basic256sha256"] = "none"
    username: str | None = None  # the password is the source secret
    root_node: str = "i=85"  # Objects folder
    timeout_seconds: float = Field(5.0, ge=0.5, le=60)
    # Only used with basic256sha256; the collector mounts ./certs read-only at /certs.
    client_cert: str = "/certs/opcua-client.pem"
    client_key: str = "/certs/opcua-client-key.pem"


def _translate(exc: BaseException) -> ConnectorError:
    if isinstance(exc, ua.UaStatusCodeError) and exc.code in _AUTH_CODES:
        return ConnectorError("auth_failed", str(exc))
    if isinstance(exc, asyncio.TimeoutError):
        return ConnectorError("timeout", "timed out")
    if isinstance(exc, (ConnectionError, OSError)):
        return ConnectorError("unreachable", str(exc) or exc.__class__.__name__)
    return ConnectorError("protocol_error", str(exc))


@register
class OpcUaConnector(Connector):
    type = "opcua"
    config_schema = OpcUaConfig

    def __init__(self, config: OpcUaConfig, secret: str | None = None) -> None:
        super().__init__(config, secret)
        self.config: OpcUaConfig = config

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[Client]:
        """A fresh client per call, always disconnected; a half-dead session is never reused."""
        client = Client(self.config.endpoint, timeout=self.config.timeout_seconds)
        if self.config.username:
            client.set_user(self.config.username)
            client.set_password(self.secret or "")
        if self.config.security_policy == "basic256sha256":
            for path in (self.config.client_cert, self.config.client_key):
                if not Path(path).is_file():
                    raise ConnectorError("protocol_error", f"client certificate not found: {path}")
            await client.set_security_string(
                f"Basic256Sha256,SignAndEncrypt,{self.config.client_cert},{self.config.client_key}"
            )
        try:
            await asyncio.wait_for(client.connect(), self.config.timeout_seconds)
        except Exception as exc:  # noqa: BLE001 - translated into a typed status
            raise _translate(exc) from exc
        try:
            yield client
        except ConnectorError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise _translate(exc) from exc
        finally:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001 - the session may already be gone
                pass

    async def test(self) -> ConnectionCheck:
        started = time.perf_counter()
        try:
            async with self._session() as client:
                await client.nodes.root.read_browse_name()
        except ConnectorError as exc:
            return ConnectionCheck(ok=False, status=exc.status, message=exc.message)
        return ConnectionCheck(ok=True, status="ok", latency_ms=(time.perf_counter() - started) * 1000)

    async def browse(self) -> list[PointDescriptor]:
        found: list[PointDescriptor] = []
        async with self._session() as client:
            root = client.get_node(self.config.root_node)
            # Under the Objects folder, namespace 0 holds only OPC Foundation infrastructure
            # (Server diagnostics, Aliases, ...), never process data.
            skip_standard = root.nodeid == _OBJECTS_FOLDER
            stack: list[Node] = [root]
            seen: set[str] = set()
            while stack:
                node = stack.pop()
                for child in await node.get_children(refs=ua.ObjectIds.HierarchicalReferences):
                    key = child.nodeid.to_string()
                    if key in seen or (skip_standard and child.nodeid.NamespaceIndex == 0):
                        continue
                    seen.add(key)
                    node_class = await child.read_node_class()
                    if node_class == ua.NodeClass.Variable:
                        name = (await child.read_display_name()).Text or key
                        found.append(PointDescriptor(address=key, name=name, unit_hint=await _unit(child)))
                    elif node_class == ua.NodeClass.Object:
                        stack.append(child)
        return sorted(found, key=lambda p: p.name)

    async def read(self, addresses: list[str]) -> list[PointValue]:
        ts = datetime.now(timezone.utc)
        async with self._session() as client:
            nodes = [client.get_node(a) for a in addresses]
            results = await client.read_attributes(nodes, ua.AttributeIds.Value)
        out: list[PointValue] = []
        for address, dv in zip(addresses, results, strict=True):
            good = dv.StatusCode_ is None or dv.StatusCode_.is_good()
            value = dv.Value.Value if good and dv.Value is not None else None
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                out.append(PointValue(address=address, ts=ts, value=float(value), quality=GOOD))
            else:
                out.append(PointValue(address=address, ts=ts, value=None, quality=BAD))
        return out


async def _unit(var: Node) -> str | None:
    for prop in await var.get_properties():
        if (await prop.read_browse_name()).Name == "EngineeringUnits":
            eu = await prop.read_value()
            text = getattr(getattr(eu, "DisplayName", None), "Text", None)
            return text or None
    return None
