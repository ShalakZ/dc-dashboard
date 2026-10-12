"""The security faults of the OPC UA simulator (SIM_FAULT_POLICIES, UNTRUSTED_CERT, AUTH, CERT_HOSTS), driven by plain asyncua clients.

What each fault does to a client is recorded here as asyncua really does it, because the connection check and its hints are
built on those facts.
"""
import asyncio
import contextlib
import hashlib
import socket
import time

import asyncua
import pytest
from asyncua import Client, Server, ua
from asyncua.server.binary_server_asyncio import BinaryServer, OPCUAProtocol
from cryptography import x509

from dcdash.simulator.faults import FaultConfigError, Faults
from dcdash.simulator.model import Simulator
from dcdash.simulator.opcua import OpcUaSim
from tests.helpers import free_port, opcua_server, write_client_certificate

V_PATH = ["2:Panels", "2:LVP01", "2:V"]


def faults(**env: str) -> Faults:
    return Faults.from_env({f"SIM_FAULT_{name}": value for name, value in env.items()})


def url(srv: OpcUaSim) -> str:
    return srv.endpoint.replace("0.0.0.0", "127.0.0.1")


async def endpoints_of(srv: OpcUaSim):
    """What GetEndpoints says, asked over the None channel any client may use for discovery."""
    return await Client(url(srv)).connect_and_get_server_endpoints()


def offered(endpoints) -> list[str]:
    return [f"{ep.SecurityPolicyUri.split('#')[1]}/{ep.SecurityMode.name.rstrip('_')}" for ep in endpoints]


def tokens(endpoint) -> set[str]:
    return {token.TokenType.name for token in endpoint.UserIdentityTokens}


async def secure_client(srv: OpcUaSim, tmp_path, *, timeout: float = 3, **certificate) -> Client:
    cert_path, key_path = write_client_certificate(tmp_path, **certificate)
    client = Client(url(srv), timeout=timeout)
    await client.set_security_string(f"Basic256Sha256,SignAndEncrypt,{cert_path},{key_path}")
    return client


async def read_voltage(client: Client) -> float:
    return await (await client.nodes.objects.get_child(V_PATH)).read_value()


@contextlib.asynccontextmanager
async def fault_server(*, password: str | None = None, **env: str):
    async with opcua_server(password=password, faults=faults(**env)) as srv:
        yield srv


# ---- the asyncua version the fault server is written against --------------------------------------------------------------

def test_asyncua_is_the_version_the_fault_server_was_written_against():
    assert asyncua.__version__ == "1.1.8", (
        f"asyncua is {asyncua.__version__}, the fault server was written for 1.1.8. dcdash/simulator/faultserver.py repeats "
        "asyncua.Server.start() and subclasses BinaryServer/OPCUAProtocol, and connectors/ (A2b) touches the client's private "
        "protocol state: compare those with the new release, then move this version."
    )


# ---- what is offered --------------------------------------------------------------------------------------------------------

async def test_without_faults_the_simulator_offers_none_only_and_makes_no_certificate():
    async with opcua_server() as srv:
        found = await endpoints_of(srv)
        assert offered(found) == ["None/None"] and tokens(found[0]) == {"Anonymous", "UserName"}
        assert srv.server_certificate is None  # the default path stays as cheap as before


async def test_policies_none_is_the_default_endpoint_and_nothing_else():
    async with fault_server(POLICIES="none") as srv:
        assert offered(await endpoints_of(srv)) == ["None/None"] and srv.server_certificate is None


# ---- the server certificate -------------------------------------------------------------------------------------------------

async def test_the_server_certificate_names_the_application_uri_and_every_host_a_client_may_use_and_is_made_once_per_instance():
    async with fault_server(POLICIES="basic256sha256", CERT_HOSTS="scada-gw.plant.local, other.plant.local") as first, \
            fault_server(POLICIES="basic256sha256") as second:
        der = (await endpoints_of(first))[0].ServerCertificate
        names = x509.load_der_x509_certificate(der).extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        assert names.get_values_for_type(x509.UniformResourceIdentifier) == ["urn:freeopcua:python:server"]  # namespace 1 is untouched
        dns = names.get_values_for_type(x509.DNSName)
        assert {"simulator", "localhost", "scada-gw.plant.local", "other.plant.local", socket.gethostname()} <= set(dns)
        assert [str(ip) for ip in names.get_values_for_type(x509.IPAddress)] == ["127.0.0.1"]

        before = hashlib.sha1(der).hexdigest().upper()
        assert before == first.server_certificate.thumbprint
        await first.stop()
        await first.start()  # run() rebuilds the server at every offline toggle: the thumbprint must survive it
        assert hashlib.sha1((await endpoints_of(first))[0].ServerCertificate).hexdigest().upper() == before
        assert second.server_certificate.thumbprint != before  # another instance, another certificate


# ---- POLICIES: any client certificate is accepted ---------------------------------------------------------------------------

async def test_a_secure_only_server_offers_the_secure_policy_and_accepts_any_client_certificate(tmp_path):
    async with fault_server(POLICIES="basic256sha256") as srv:
        assert offered(await endpoints_of(srv)) == ["Basic256Sha256/SignAndEncrypt"]
        with pytest.raises(ua.UaError, match="No matching endpoints"):  # a client that insists on None: the stock client refuses itself
            await Client(url(srv), timeout=2).connect()
        for index, certificate in enumerate(({}, {"key_usage": True}, {"uri": "urn:someone:else"})):
            client = await secure_client(srv, tmp_path, stem=f"client{index}", **certificate)
            async with client:
                assert await read_voltage(client) == 400.0


async def test_none_and_secure_can_be_offered_together(tmp_path):
    async with fault_server(POLICIES="none,basic256sha256") as srv:
        assert offered(await endpoints_of(srv)) == ["None/None", "Basic256Sha256/SignAndEncrypt"]
        async with Client(url(srv)) as plain:
            assert await read_voltage(plain) == 400.0
        async with await secure_client(srv, tmp_path) as secure:
            assert await read_voltage(secure) == 400.0


# ---- UNTRUSTED_CERT=1: an ERR message at OpenSecureChannel, as a real stack answers -----------------------------------------

async def connect_recording(client: Client) -> dict:
    """Hello and OpenSecureChannel, noting what the server's TCP stream hands asyncua (an ERR message, a lost connection).

    Returns as soon as the connection is lost, or after 2 s without that; `seen["after"]` is how long it took.
    """
    seen: dict = {}
    gone = asyncio.Event()
    await client.connect_socket()
    protocol = client.uaclient.protocol
    received, lost = protocol._process_received_message, protocol.connection_lost

    def on_message(message):
        if isinstance(message, ua.ErrorMessage):
            seen["error"] = message.Error.value
        return received(message)

    def on_lost(exc):
        seen["lost"] = True
        gone.set()
        return lost(exc)

    protocol._process_received_message, protocol.connection_lost = on_message, on_lost

    async def handshake():
        await client.send_hello()
        await client.open_secure_channel()

    started = time.perf_counter()
    attempt = asyncio.create_task(handshake())  # asyncua itself would wait out its timeout here; what the server sent is the point
    try:
        await asyncio.wait_for(gone.wait(), 2.0)
    except TimeoutError:
        pass
    seen["after"] = time.perf_counter() - started
    attempt.cancel()
    with contextlib.suppress(BaseException):
        await attempt
    return seen


async def test_untrusted_cert_sends_an_err_message_and_closes_the_socket_for_every_secure_channel(tmp_path):
    async with fault_server(UNTRUSTED_CERT="1") as srv:
        assert offered(await endpoints_of(srv)) == ["Basic256Sha256/SignAndEncrypt"]  # discovery over None still works
        for index, certificate in enumerate(({}, {"key_usage": True})):  # no certificate is trusted, whatever it carries
            client = await secure_client(srv, tmp_path, stem=f"c{index}", **certificate)
            seen = await connect_recording(client)
            assert seen["error"] == ua.StatusCodes.BadSecurityChecksFailed and seen["lost"] is True
            assert seen["after"] < 0.5  # an answer and a closed socket at once, not a silence
            with contextlib.suppress(Exception):
                await client.disconnect()

        # Today's asyncua drops the server's ERR message and fails no pending request when the connection closes, so a real
        # refusal looks like "the server did not answer". The collector's own client (A2b) fixes that; this records the stock one.
        stock = await secure_client(srv, tmp_path, stem="stock", timeout=1)
        started = time.perf_counter()
        with pytest.raises(TimeoutError):
            await stock.connect()
        assert 0.9 <= time.perf_counter() - started < 3.0
        with contextlib.suppress(Exception):
            await stock.disconnect()


# ---- UNTRUSTED_CERT=session: asyncua's own validator, which refuses at CreateSession ----------------------------------------

@pytest.mark.parametrize("certificate", [{}, {"key_usage": True}], ids=["plain certificate", "key usage and client auth"])
async def test_untrusted_cert_session_mode_refuses_at_create_session_with_bad_certificate_untrusted(tmp_path, certificate):
    async with fault_server(UNTRUSTED_CERT="session") as srv:
        assert offered(await endpoints_of(srv)) == ["Basic256Sha256/SignAndEncrypt"]
        client = await secure_client(srv, tmp_path, **certificate)
        with pytest.raises(ua.UaStatusCodeError) as refused:
            await client.connect()
        assert refused.value.code == ua.StatusCodes.BadCertificateUntrusted
        with contextlib.suppress(Exception):
            await client.disconnect()


# ---- AUTH=required ------------------------------------------------------------------------------------------------------------

async def test_auth_required_refuses_anonymous_and_a_wrong_password_and_accepts_the_right_one():
    async with fault_server(password="pw", AUTH="required") as srv:
        found = await endpoints_of(srv)
        assert offered(found) == ["None/None"] and tokens(found[0]) == {"UserName"}  # no Anonymous

        anonymous = Client(url(srv), timeout=2)
        with pytest.raises(ua.UaStatusCodeError) as refused:
            await anonymous.connect()
        assert refused.value.code == ua.StatusCodes.BadIdentityTokenRejected

        wrong = Client(url(srv), timeout=2)
        wrong.set_user("sim")
        wrong.set_password("not-the-password")
        with pytest.raises(ua.UaStatusCodeError) as denied:
            await wrong.connect()
        assert denied.value.code == ua.StatusCodes.BadUserAccessDenied

        right = Client(url(srv), timeout=2)
        right.set_user("sim")
        right.set_password("pw")
        async with right:
            assert await read_voltage(right) == 400.0


def test_auth_required_without_a_password_is_refused_when_the_simulator_is_built():
    with pytest.raises(FaultConfigError, match="SIM_OPCUA_PASSWORD"):
        OpcUaSim(Simulator(), free_port(), faults=faults(AUTH="required"))
    with pytest.raises(FaultConfigError, match="SIM_OPCUA_PASSWORD"):
        OpcUaSim(Simulator(), free_port(), password="", faults=faults(AUTH="required"))


# ---- nothing is shared between servers or left behind -----------------------------------------------------------------------

def asyncua_internals() -> tuple:
    return (Server.start, Server.stop, BinaryServer._make_protocol, OPCUAProtocol._process_one_msg,
            OPCUAProtocol.connection_made, OPCUAProtocol.connection_lost)


async def test_two_servers_in_one_process_do_not_influence_each_other_and_no_asyncua_class_is_changed(tmp_path):
    before = asyncua_internals()
    async with fault_server(UNTRUSTED_CERT="1") as refusing, opcua_server() as plain:
        assert asyncua_internals() == before  # no class patch while a fault server runs
        assert offered(await endpoints_of(plain)) == ["None/None"]
        async with Client(url(plain)) as client:  # the plain server answers while the other one refuses
            assert await read_voltage(client) == 400.0
        assert (await connect_recording(await secure_client(refusing, tmp_path)))["error"] == ua.StatusCodes.BadSecurityChecksFailed
        async with Client(url(plain)) as client:
            assert await read_voltage(client) == 400.0
        assert not hasattr(OPCUAProtocol, "faults") and not hasattr(BinaryServer, "faults")
    assert asyncua_internals() == before  # and nothing outlives them
