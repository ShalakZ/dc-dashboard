"""The OPC UA connector's client says why a connection failed (a server refusal or a closed socket is not a timeout) and announces
the ApplicationUri of its certificate. Written against the failures a real SCADA server produces, which asyncua's stock client
reports as "no answer within N s"."""

import asyncio
import contextlib
import time

import asyncua
import pytest
from asyncua import Client, Server, ua
from asyncua.client.ua_client import UaClient, UASocketProtocol
from asyncua.crypto.truststore import TrustStore
from asyncua.crypto.validator import CertificateValidator, CertificateValidatorOptions
from asyncua.ua.ua_binary import uatcp_to_binary

from dcdash.connectors.base import ConnectorError, create_connector
from dcdash.connectors.opcua import ReportingClient, _certificate_uri, _point_value
from dcdash.diagnostics.hints import hint_for
from dcdash.simulator.faultserver import make_server_certificate
from dcdash.simulator.faults import Faults
from tests.helpers import free_port, opcua_server, write_client_certificate

REFUSED = "BadSecurityChecksFailed (0x80130000)"
FAST = 1.0  # seconds: a timeout would take the source's whole timeout_seconds (2)


def _cfg(url: str, **extra):
    return {"endpoint": url.replace("0.0.0.0", "127.0.0.1"), "timeout_seconds": 2, **extra}


def _secure(tmp_path, url: str, **cert):
    cert_path, key_path = write_client_certificate(tmp_path, **cert)
    return _cfg(url, security_policy="basic256sha256", client_cert=cert_path, client_key=key_path)


def _by_id(result):
    return {step.id: step for step in result.steps}


async def _timed(awaitable):
    started = time.perf_counter()
    try:
        return await awaitable, time.perf_counter() - started
    except Exception as exc:  # noqa: BLE001 - the caller looks at the error
        return exc, time.perf_counter() - started


@contextlib.asynccontextmanager
async def raw_server(protocol_factory):
    """A bare TCP server (no OPC UA) whose connections are handled by `protocol_factory()`; yields its endpoint URL."""
    server = await asyncio.get_running_loop().create_server(protocol_factory, "127.0.0.1", 0)
    try:
        yield f"opc.tcp://127.0.0.1:{server.sockets[0].getsockname()[1]}/"
    finally:
        server.close()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(server.wait_closed(), 2.0)


class CloseAtOnce(asyncio.Protocol):
    def connection_made(self, transport):
        transport.close()


class CloseAfterHello(asyncio.Protocol):
    """Answers the Hello with an Acknowledge, then closes when the next message (OpenSecureChannel) arrives."""

    def connection_made(self, transport):
        self.transport, self.messages = transport, 0

    def data_received(self, data):
        self.messages += 1
        if self.messages == 1:
            self.transport.write(uatcp_to_binary(ua.MessageType.Acknowledge, ua.Acknowledge()))
        else:
            self.transport.close()


def test_the_client_fix_is_written_for_asyncua_1_1_8():
    assert asyncua.__version__ == "1.1.8", (
        f"asyncua is {asyncua.__version__}: dcdash.connectors.opcua.ReportingClient copies lines of asyncua 1.1.8's "
        "Client.__init__, UaClient._make_protocol and UASocketProtocol (send_hello, _send_request, send_request, "
        "connection_lost, _process_received_message). Read client/client.py and client/ua_client.py of the new version, "
        "adjust the subclass, then change this number."
    )


def test_nothing_in_asyncua_is_patched():
    assert type(Client("opc.tcp://h:4840").uaclient) is UaClient
    assert type(Client("opc.tcp://h:4840").uaclient._make_protocol()) is UASocketProtocol
    assert UASocketProtocol.connection_lost.__module__ == "asyncua.client.ua_client"
    assert type(ReportingClient("opc.tcp://h:4840").uaclient) is not UaClient


# -- a refusal (ERR at OpenSecureChannel) ---------------------------------------------------------------------------------------


async def test_a_refused_secure_channel_is_reported_by_status_everywhere_not_as_a_timeout(tmp_path):
    async with opcua_server(faults=Faults.from_env({"SIM_FAULT_UNTRUSTED_CERT": "1"})) as srv:
        connector = create_connector("opcua", _secure(tmp_path, srv.endpoint))

        check, seconds = await _timed(connector.test())
        assert (check.ok, check.status, check.message) == (False, "protocol_error", REFUSED) and seconds < FAST

        for call in (connector.read(["ns=2;i=1"]), connector.browse()):
            error, seconds = await _timed(call)
            assert isinstance(error, ConnectorError) and (error.status, error.message) == ("protocol_error", REFUSED)
            assert seconds < FAST

        result, seconds = await _timed(connector.check(["ns=2;i=1"]))
        assert seconds < 2 * FAST
        steps = _by_id(result)
        assert result.first_failed == "session" and steps["endpoints"].ok  # discovery over None still works
        session = steps["session"]
        assert session.error["status_name"] == "BadSecurityChecksFailed" and session.error["status_hex"] == "0x80130000"
        assert session.hint == hint_for("BadSecurityChecksFailed", None, "session") and "thumbprint" in session.hint


# -- a connection that closes -----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("handler", [CloseAtOnce, CloseAfterHello], ids=["closed at once", "closed after the hello"])
async def test_a_closed_connection_is_a_reset_not_a_timeout(handler):
    async with raw_server(handler) as url:
        connector = create_connector("opcua", _cfg(url))

        check, seconds = await _timed(connector.test())
        assert (check.ok, check.status) == (False, "unreachable") and "closed by the server" in check.message
        assert seconds < FAST

        result, seconds = await _timed(connector.check([]))
        assert seconds < 2 * FAST
        endpoints = _by_id(result)["endpoints"]
        assert endpoints.error["class"] == "ConnectionResetError" and "closed by the server" in endpoints.error["message"]
        assert endpoints.hint == hint_for(None, "ConnectionResetError", "endpoints") and endpoints.hint
        session = _by_id(result)["session"]
        assert session.error["class"] == "ConnectionResetError" and session.hint == endpoints.hint


async def test_a_connection_lost_during_a_session_fails_the_next_request_at_once():
    async with opcua_server() as srv:
        client = await create_connector("opcua", _cfg(srv.endpoint))._new_client()
        await client.connect()
        try:
            await srv.stop()
            error, seconds = await _timed(client.nodes.root.read_browse_name())
            assert type(error) is ConnectionResetError and "closed by the server" in str(error) and seconds < FAST
        finally:
            with contextlib.suppress(Exception):
                await client.disconnect()


# -- the healthy path stays as it was -----------------------------------------------------------------------------------------------


async def test_a_healthy_source_behaves_as_with_the_stock_client():
    async with opcua_server() as srv:
        connector = create_connector("opcua", _cfg(srv.endpoint))
        assert isinstance(await connector._new_client(), ReportingClient)

        check = await connector.test()
        assert check.ok and check.status == "ok" and check.latency_ms is not None

        points = await connector.browse()
        assert len(points) == len({p.address for p in points}) and len(points) > 10
        values = await connector.read([p.address for p in points])

        stock = Client(srv.endpoint.replace("0.0.0.0", "127.0.0.1"), timeout=2)
        async with stock:
            expected = await stock.read_attributes([stock.get_node(p.address) for p in points], ua.AttributeIds.Value)
        assert [(v.value, v.quality, v.status) for v in values] == [
            (v.value, v.quality, v.status) for v in (_point_value(p.address, values[0].ts, dv) for p, dv in zip(points, expected))
        ]

        result = await connector.check([points[0].address, points[1].address])
        assert result.ok and result.first_failed is None
        assert [step.ok for step in result.steps] == [True] * len(result.steps)


# -- the ApplicationUri -----------------------------------------------------------------------------------------------------------


@contextlib.asynccontextmanager
async def uri_checking_server():
    """A server that compares the ApplicationUri a client announces with the URI in its certificate (and checks nothing else)."""
    server = Server()
    await server.init()
    port = free_port()
    server.set_endpoint(f"opc.tcp://127.0.0.1:{port}/dcdash/")
    server.set_security_policy([ua.SecurityPolicyType.Basic256Sha256_SignAndEncrypt])
    certificate = make_server_certificate(server.get_application_uri())
    await server.load_certificate(certificate.der)
    await server.load_private_key(certificate.key_der)
    options = CertificateValidatorOptions.URI | CertificateValidatorOptions.PEER_CLIENT
    server.set_certificate_validator(CertificateValidator(options, TrustStore([], [])))
    await server.start()
    try:
        yield f"opc.tcp://127.0.0.1:{port}/dcdash/"
    finally:
        await server.stop()


async def test_the_certificates_uri_is_announced_so_a_server_that_compares_them_accepts_us(tmp_path):
    async with uri_checking_server() as url:
        connector = create_connector("opcua", _secure(tmp_path, url))  # the certificate says urn:dcdash:collector

        client = await connector._new_client()
        assert client.application_uri == "urn:dcdash:collector"

        check = await connector.test()
        assert check.ok, check.message
        result = await connector.check([])
        assert _by_id(result)["session"].ok, result.first_failed


async def test_another_uri_in_the_certificate_is_announced_as_it_is(tmp_path):
    async with uri_checking_server() as url:
        connector = create_connector("opcua", _secure(tmp_path, url, uri="urn:plant:scada-reader"))
        assert (await connector._new_client()).application_uri == "urn:plant:scada-reader"
        assert (await connector.test()).ok


async def test_the_uri_comes_from_the_public_certificate_only(tmp_path):
    cert_path, key_path = write_client_certificate(tmp_path)
    assert await _certificate_uri(cert_path) == "urn:dcdash:collector"
    garbage = tmp_path / "garbage.pem"
    garbage.write_text("not a certificate")
    assert await _certificate_uri(str(garbage)) is None
    assert await _certificate_uri(str(tmp_path / "missing.pem")) is None
    # the key file is not a certificate: it is never parsed for anything, and a policy of none does not read either file
    assert await _certificate_uri(key_path) is None
    plain = await create_connector("opcua", _cfg("opc.tcp://127.0.0.1:1/", client_cert=cert_path))._new_client()
    assert plain.application_uri == Client("opc.tcp://x").application_uri


def test_the_uri_hint_names_both_uris():
    hint = hint_for("BadCertificateUriInvalid", None, "session")
    assert "announces" in hint and "certificate" in hint and "two URIs" in hint

