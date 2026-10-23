"""OPC UA connector. Read-only: it only ever issues Browse and Read services."""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import urlparse, urlsplit, urlunsplit

from asyncua import Client, Node, ua
from asyncua.client.ua_client import UaClient, UASocketProtocol
from asyncua.common.shortcuts import Shortcuts
from pydantic import BaseModel, Field, StrictBool

from dcdash.connectors.base import (
    BAD,
    GOOD,
    Claim,
    ConnectionCheck,
    Connector,
    ConnectorError,
    PointDescriptor,
    PointValue,
    register,
    url_host_port,
)
from dcdash.connectors.identity import from_endpoints
from dcdash.connectors.opcua_ids import read_plan, stable_address

if TYPE_CHECKING:
    from dcdash.diagnostics.check import CheckResult, Publish

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
    # Off unless a person ticks it, never switched on by the platform (w34 R3). A strict bool: the string "true" or the number 1 is
    # refused, and `address_key_for` (which the matchers use) treats anything but the real True as off, so the two never disagree.
    stable_addresses: StrictBool = Field(
        False,
        json_schema_extra={
            "title": "Stable tag addresses",
            "description": (
                "For AVEVA Plant SCADA: read each tag as ns=3;s=Cluster.Tag, without the number browsing puts in front of it "
                "(20403:), which can change when the SCADA project changes. Based on a community answer, not tested against "
                "your SCADA. Leave this off for other servers."
            ),
        },
    )


def _reported_path(endpoint_url: object) -> str:
    """The path of the EndpointUrl a server reports; empty if it is null or malformed."""
    if not isinstance(endpoint_url, str):
        return ""
    try:
        return urlparse(endpoint_url).path
    except ValueError:
        return ""


def _without_user_info(url: str) -> str:
    """`url` without the `user:password@` part of its address. GetEndpoints is anonymous, and asyncua's Client takes a user and a
    password from the URL, so they must not reach it from here (the credentials are applied once, by `_new_client`)."""
    parts = urlsplit(url)
    return urlunsplit(parts._replace(netloc=parts.netloc.rpartition("@")[2]))


def _translate(exc: BaseException) -> ConnectorError:
    if isinstance(exc, ua.UaStatusCodeError) and exc.code in _AUTH_CODES:
        return ConnectorError("auth_failed", str(exc))
    if isinstance(exc, asyncio.TimeoutError):
        return ConnectorError("timeout", "timed out")
    if isinstance(exc, (ConnectionError, OSError)):
        return ConnectorError("unreachable", str(exc) or exc.__class__.__name__)
    code = exc.code if isinstance(exc, ua.UaStatusCodeError) else None
    if isinstance(code, int) and not isinstance(code, bool):
        return ConnectorError("protocol_error", _status_text(ua.StatusCode(code)))  # a refusal by name, not asyncua's long doc text
    return ConnectorError("protocol_error", str(exc))


class UnusableAnswerError(ConnectionResetError):
    """asyncua closed the connection itself because the server's answer was not OPC UA it could read (a wrong port, a TLS proxy, a
    server bug). A `ConnectionResetError` for everything that handles connection errors; its own class name for the hints."""


class _ReportingProtocol(UASocketProtocol):
    """asyncua's client protocol, made to say why a connection ended.

    Stock asyncua drops the status of a server ERR message (what a real server answers to a certificate it does not trust) and
    leaves every waiting request alone when the socket closes, so a refusal or a dropped connection looks like a timeout. Here a
    closed connection fails the waiting requests at once, with the ERR status if one arrived, else with a ConnectionResetError.
    Instance state only: nothing in asyncua is patched.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._refusal: ua.StatusCode | None = None  # the status of a server ERR message
        self._closed_here = False

    def _why_lost(self) -> Exception | None:
        """What a request on this connection fails with, or None while it is open."""
        if self.state != self.CLOSED:
            return None
        if self._refusal is not None:
            return ua.UaStatusCodeError(self._refusal.value)
        if self._closed_here:  # asyncua closes the socket itself when it cannot use an answer
            return UnusableAnswerError("connection closed by this client after an answer from the server it could not use")
        return ConnectionResetError("connection closed by the server")

    def _process_received_message(self, msg: Any) -> None:
        if isinstance(msg, ua.ErrorMessage) and msg.Error is not None:
            self._refusal = msg.Error
        super()._process_received_message(msg)

    def disconnect_socket(self) -> None:
        self._closed_here = True
        super().disconnect_socket()

    def connection_lost(self, exc: Exception | None) -> None:
        super().connection_lost(exc)
        for future in list(self._callbackmap.values()):
            if not future.done():
                future.set_exception(self._why_lost())

    async def send_hello(self, url: str, max_messagesize: int = 0, max_chunkcount: int = 0) -> Any:
        if (error := self._why_lost()) is not None:
            raise error
        return await super().send_hello(url, max_messagesize, max_chunkcount)

    def _send_request(
        self, request: Any, timeout: float = 1, message_type: ua.MessageType = ua.MessageType.SecureMessage
    ) -> Any:
        # Stock asyncua writes to the dead transport and waits for the timeout. Closing the channel stays as it is: it is
        # the clean-up after a failure and must not replace the failure.
        if message_type != ua.MessageType.SecureClose and (error := self._why_lost()) is not None:
            raise error
        return super()._send_request(request, timeout, message_type)

    async def send_request(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return await super().send_request(*args, **kwargs)
        except ConnectionError:
            if (error := self._why_lost()) is not None:
                raise error from None  # stock asyncua turns every failure of a closed connection into "Connection is closed"
            raise


class _ReportingUaClient(UaClient):
    def _make_protocol(self) -> UASocketProtocol:
        self.protocol = _ReportingProtocol(self._timeout, security_policy=self.security_policy)
        self.protocol.pre_request_hook = self._pre_request_hook
        return self.protocol


class ReportingClient(Client):
    """An asyncua `Client` whose failures name their cause (see `_ReportingProtocol`). Written against asyncua 1.1.8: a test
    fails when the version changes, because this copies a few lines of its `Client.__init__` and `UaClient._make_protocol`."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        stock = self.uaclient
        self.uaclient = _ReportingUaClient(stock._timeout)
        self.uaclient.pre_request_hook = stock.pre_request_hook
        self.nodes = Shortcuts(self.uaclient)
        self._login_error: Exception | None = None

    async def activate_session(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return await super().activate_session(*args, **kwargs)
        except Exception as exc:
            self._login_error = exc
            raise

    async def connect(self) -> None:
        # A refused login is followed by asyncua's clean-up (CloseSession). A server that hangs up after the refusal makes that
        # request fail with a reset, which replaces the refusal: report the refusal, it is what the owner has to act on.
        self._login_error = None
        try:
            await super().connect()
        except Exception as exc:
            if self._login_error is not None and exc is not self._login_error:
                raise self._login_error from None
            raise


async def close_quietly(client: Client, seconds: float = 1.0) -> None:
    """Close a client that may be half open, without raising and without waiting longer than `seconds` for the server: disconnect
    (this also stops the watchdog and channel renewal asyncua starts with a session), then drop the socket whatever happened."""
    with contextlib.suppress(Exception):
        async with asyncio.timeout(seconds):
            await client.disconnect()
    with contextlib.suppress(Exception):
        client.disconnect_socket()


async def _certificate_uri(path: str) -> str | None:
    """The first URI among the alternative names of the public certificate at `path` (the key is never read), or None."""
    from dcdash.connectors.opcua_check import certificate_facts, load_certificate  # imported here: that module imports this one

    try:
        return certificate_facts(await load_certificate(path))["application_uri"]
    except Exception:  # noqa: BLE001 - asyncua reads the file next and reports a bad one in its own way
        return None


@register
class OpcUaConnector(Connector):
    type = "opcua"
    config_schema = OpcUaConfig
    default_ports = (4840,)

    @classmethod
    async def probe(cls, host: str, port: int, timeout: float = 3.0) -> Claim | None:
        client = Client(f"opc.tcp://{host}:{port}", timeout=timeout)
        try:
            endpoints = await asyncio.wait_for(client.connect_and_get_server_endpoints(), timeout)
        except Exception:  # noqa: BLE001 - not an OPC UA server, or unreachable
            return None
        if not endpoints:
            return None
        path = _reported_path(getattr(endpoints[0], "EndpointUrl", None))
        config = OpcUaConfig(endpoint=f"opc.tcp://{host}:{port}{path}").model_dump(mode="json")
        return Claim("opcua", config, f"OPC UA server at {host}:{port}", from_endpoints(endpoints) or None)

    @classmethod
    def endpoint_key(cls, config: dict[str, Any]) -> tuple[str, int, str] | None:
        if not isinstance(config, dict):
            return None
        found = url_host_port(config.get("endpoint"))
        if found is None:
            return None
        host, port, _scheme = found
        return host, port if port is not None else 4840, ""

    def __init__(self, config: OpcUaConfig, secret: str | None = None) -> None:
        super().__init__(config, secret)
        self.config: OpcUaConfig = config

    async def _new_client(self) -> Client:
        """A client with the configured authentication and security, not yet connected."""
        client = ReportingClient(self.config.endpoint, timeout=self.config.timeout_seconds)
        if self.config.username:
            client.set_user(self.config.username)
            client.set_password(self.secret or "")
        if self.config.security_policy == "basic256sha256":
            for path in (self.config.client_cert, self.config.client_key):
                if not Path(path).is_file():
                    raise ConnectorError("protocol_error", f"client certificate not found: {path}")
            # The server compares the ApplicationUri we announce with the one in the certificate; asyncua's default is not it
            if (uri := await _certificate_uri(self.config.client_cert)) is not None:
                client.application_uri = uri
            await client.set_security_string(
                f"Basic256Sha256,SignAndEncrypt,{self.config.client_cert},{self.config.client_key}"
            )
        return client

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[Client]:
        """A fresh client per call, always disconnected; a half-dead session is never reused."""
        client = await self._new_client()
        try:
            await asyncio.wait_for(client.connect(), self.config.timeout_seconds)
        except (Exception, asyncio.CancelledError) as exc:  # noqa: BLE001 - translated into a typed status
            # A connect that ran out of time, or that the scheduler cancelled because its source was edited, stops where it
            # stands, past asyncua's own clean-up; what it opened (socket, channel, a session with its watchdog) would stay and
            # poll the server for good.
            await close_quietly(client)
            if isinstance(exc, asyncio.CancelledError):
                raise
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

    async def identity(self) -> dict[str, Any] | None:
        """Who the server says it is (application URI, name, product URI, certificate thumbprint) from its GetEndpoints answer, or None.

        A plain client, no login and no security: GetEndpoints is anonymous, so this works for a server that wants credentials too.
        """
        timeout = self.config.timeout_seconds
        try:
            client = Client(_without_user_info(self.config.endpoint), timeout=timeout)
            endpoints = await asyncio.wait_for(client.connect_and_get_server_endpoints(), timeout)
            return from_endpoints(endpoints) or None
        except Exception:  # noqa: BLE001 - unreachable, not OPC UA, a junk answer: the caller only wants to know whether it was told
            return None

    async def check(self, points: list[str], publish: Publish | None = None) -> CheckResult:
        from dcdash.connectors.opcua_check import run_check  # imported here: that module imports this one

        return await run_check(self, points, publish)

    async def browse(self) -> list[PointDescriptor]:
        async with self._session() as client:
            found = await self._walk(client)
        # The post step (w34): whatever walks the server, the descriptors of a source with the option on carry the stable
        # address. The walk deduplicated on the raw id, so two descriptors can share a stable address (the browse upsert counts
        # the second as ambiguous). The order is the old one: by name, ties in discovery order.
        if self.config.stable_addresses:
            found = [replace(d, address=stable_address(d.address)) for d in found]
        return sorted(found, key=lambda p: p.name)

    async def _walk(self, client: Client) -> list[PointDescriptor]:
        """Every variable under the root node, as the server names it (a raw node id), in discovery order."""
        found: list[PointDescriptor] = []
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
        return found

    async def read(self, addresses: list[str]) -> list[PointValue]:
        ts = datetime.now(timezone.utc)
        if self.config.stable_addresses:
            return await self._read_stable(addresses, ts)
        async with self._session() as client:
            results = await self._read_values(client, addresses)
        return [_point_value(address, ts, dv) for address, dv in zip(addresses, results, strict=True)]

    async def _read_stable(self, addresses: list[str], ts: datetime) -> list[PointValue]:
        """`read` for a source with the option on: the server is asked for the stable form of each address, and each answer is
        filed under the STORED string it was asked for, in the caller's order. Distinct stored strings that are one tag are
        not read at all: each comes back BAD, so one reading never reaches two points."""
        plan = read_plan(addresses, stable_address)
        sent = [stable for _stored, stable in plan.sent]
        async with self._session() as client:
            results = await self._read_values(client, sent) if sent else []  # a request for no node is not sent
        answers = {
            stored: _point_value(stored, ts, dv) for (stored, _stable), dv in zip(plan.sent, results, strict=True)
        }
        return [
            PointValue(address, ts, None, BAD, plan.refused[address]) if address in plan.refused else answers[address]
            for address in addresses
        ]

    async def _read_values(self, client: Client, addresses: Sequence[str]) -> list[ua.DataValue]:
        """The wire request of a read: the Value of every node, in one request, one answer per address in the same order."""
        nodes = [client.get_node(a) for a in addresses]
        return await client.read_attributes(nodes, ua.AttributeIds.Value)


def _status_text(code: ua.StatusCode) -> str:
    """"BadNodeIdUnknown (0x80340000)": the name, and the hex because a code this asyncua does not know is only named "Bad"."""
    return f"{code.name} (0x{code.value:08X})"


def _point_value(address: str, ts: datetime, dv: ua.DataValue) -> PointValue:
    """A DataValue as a PointValue. A reading that is not good, or good but not a number, is BAD and says why in `status`."""
    code = dv.StatusCode_
    if code is not None and not code.is_good():
        return PointValue(address=address, ts=ts, value=None, quality=BAD, status=_status_text(code))
    value = dv.Value.Value if dv.Value is not None else None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return PointValue(address=address, ts=ts, value=float(value), quality=GOOD)
    kind = dv.Value.VariantType.name if dv.Value is not None else "no value"
    return PointValue(address=address, ts=ts, value=None, quality=BAD, status=f"Good, non-numeric ({kind})")


async def _unit(var: Node) -> str | None:
    for prop in await var.get_properties():
        if (await prop.read_browse_name()).Name == "EngineeringUnits":
            eu = await prop.read_value()
            text = getattr(getattr(eu, "DisplayName", None), "Text", None)
            return text or None
    return None
