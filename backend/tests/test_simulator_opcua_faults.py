"""The faults of the OPC UA simulator (SIM_FAULT_*), driven by plain asyncua clients.

What each fault does to a client is recorded here as asyncua really does it, because the connection check and its hints are
built on those facts.
"""
import asyncio
import contextlib
import hashlib
import socket
import time
from datetime import datetime, timezone

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
CURRENT_TIME = ua.NodeId(ua.ObjectIds.Server_ServerStatus_CurrentTime)


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


# ---- SLOW: every incoming message is answered late, Hello and OpenSecureChannel included ------------------------------------

async def hello_took(srv: OpcUaSim) -> float:
    client = Client(url(srv))
    await client.connect_socket()
    try:
        started = time.perf_counter()
        await client.send_hello()
        return time.perf_counter() - started
    finally:
        client.disconnect_socket()


async def test_slow_delays_every_message_hello_included_and_only_on_the_server_that_has_the_fault():
    delay = 0.4
    async with fault_server(SLOW=str(delay)) as slow, opcua_server() as plain:
        assert delay - 0.05 <= await hello_took(slow) < delay + 1.0
        assert await hello_took(plain) < delay - 0.1  # a fault-free server in the same process answers at once

        started = time.perf_counter()
        client = Client(url(slow), timeout=10)
        async with client:
            connected = time.perf_counter() - started
            assert connected >= 4 * delay - 0.1  # Hello, OpenSecureChannel, CreateSession and ActivateSession each wait
            started = time.perf_counter()
            assert await read_voltage(client) == 400.0
            assert time.perf_counter() - started >= delay - 0.05

            started = time.perf_counter()  # the slow connection is still open: the other server is not held back by it
            async with Client(url(plain)) as fast:
                assert await read_voltage(fast) == 400.0
            assert time.perf_counter() - started < delay


# ---- DROP: each connection is closed that long after it was accepted ---------------------------------------------------------

def port_of(srv: OpcUaSim) -> int:
    return int(url(srv).split(":")[2].split("/")[0])


def pending_drop_timers() -> list:
    """Timers the DROP fault has scheduled and not cancelled (a peek into the event loop: there is no public list)."""
    return [handle for handle in asyncio.get_running_loop()._scheduled if not handle.cancelled() and "_drop_connection" in repr(handle)]


async def closed_after(reader: asyncio.StreamReader, started: float, limit: float) -> float:
    assert await asyncio.wait_for(reader.read(1), limit) == b""  # the server sends nothing unasked: EOF means it closed
    return time.perf_counter() - started


async def test_drop_closes_each_connection_that_long_after_it_was_accepted_and_the_listener_stays_up():
    drop = 0.8
    async with fault_server(DROP=str(drop)) as srv:
        first_reader, first_writer = await asyncio.open_connection("127.0.0.1", port_of(srv))
        first_started = time.perf_counter()
        with pytest.raises(TimeoutError):  # still open well before the interval
            await asyncio.wait_for(first_reader.read(1), 0.3)
        second_reader, second_writer = await asyncio.open_connection("127.0.0.1", port_of(srv))  # accepted 0.3 s after the first
        second_started = time.perf_counter()

        first = await closed_after(first_reader, first_started, drop + 1)
        second = await closed_after(second_reader, second_started, drop + 1)
        assert drop - 0.05 <= first < drop + 1 and drop - 0.05 <= second < drop + 1  # each counts from its own accept
        assert second_started + second > first_started + first  # the second one lived on after the first was closed
        first_writer.close(), second_writer.close()

        async with Client(url(srv), timeout=3) as client:  # the listener is still there: a new client connects and reads in time
            assert await read_voltage(client) == 400.0


async def test_the_drop_timer_is_cancelled_when_the_client_closes_first_and_when_the_server_stops():
    async with fault_server(DROP="30") as srv:
        _, closing = await asyncio.open_connection("127.0.0.1", port_of(srv))
        _, lingering = await asyncio.open_connection("127.0.0.1", port_of(srv))
        await asyncio.sleep(0.1)
        assert len(pending_drop_timers()) == 2
        closing.close()
        await closing.wait_closed()
        await asyncio.sleep(0.2)
        assert len(pending_drop_timers()) == 1
    lingering.close()
    assert not pending_drop_timers()  # the second connection was open when the server stopped, 30 s before its timer


# ---- BAD: the chosen variables answer with a Bad status ---------------------------------------------------------------------

async def test_bad_variables_read_back_their_status_after_every_refresh_and_the_others_stay_good():
    async with fault_server(BAD="LVP01_kW:BadSensorFailure,LVP02_V:BadNodeIdUnknown") as srv:
        async with Client(url(srv)) as client:
            async def status(panel: str, signal: str):
                node = await client.nodes.objects.get_child(["2:Panels", f"2:{panel}", f"2:{signal}"])
                return (await node.read_data_value(raise_on_bad_status=False)).StatusCode_

            for refreshes in range(2):  # refresh() rewrites every variable: the Bad ones must stay Bad
                if refreshes:
                    await srv.refresh()
                broken = await status("LVP01", "kW")
                assert (broken.name, f"0x{broken.value:08X}") == ("BadSensorFailure", "0x808C0000")
                missing = await status("LVP02", "V")
                assert (missing.name, f"0x{missing.value:08X}") == ("BadNodeIdUnknown", "0x80340000")
                for panel, signal in (("LVP01", "V"), ("LVP02", "kW"), ("LVP03", "kW"), ("LVP10", "Hz")):
                    assert (await status(panel, signal)).is_good()
            with pytest.raises(ua.UaStatusCodeError) as refused:  # what a client that insists on a good value sees
                await (await client.nodes.objects.get_child(["2:Panels", "2:LVP01", "2:kW"])).read_value()
            assert refused.value.code == ua.StatusCodes.BadSensorFailure
            assert await read_voltage(client) == 400.0


# ---- SKEW: the server's clock and the timestamps it stamps are off by that many seconds ------------------------------------

async def clock_offset(client: Client) -> float:
    return ((await client.get_node(CURRENT_TIME).read_value()) - datetime.now(timezone.utc)).total_seconds()


def skew_clock_tasks() -> list:
    return [task for task in asyncio.all_tasks() if task.get_name() == "sim-skew-clock"]


async def test_skew_keeps_current_time_and_the_point_stamps_off_by_that_much_for_seconds_and_stops_with_the_server():
    async with fault_server(SKEW="900") as ahead, fault_server(SKEW="-900") as behind, opcua_server() as plain:
        assert len(skew_clock_tasks()) == 2  # one writer per skewed server, none for the fault-free one
        async with Client(url(ahead)) as late, Client(url(behind)) as early, Client(url(plain)) as real:
            for round_ in range(2):  # asyncua's own writer would put the real time back within a second
                if round_:
                    await asyncio.sleep(2)
                assert abs(await clock_offset(late) - 900) < 10
                assert abs(await clock_offset(early) + 900) < 10
                assert abs(await clock_offset(real)) < 10

            for srv, client, skew in ((ahead, late, 900), (behind, early, -900)):
                await srv.refresh()
                stamped = await (await client.nodes.objects.get_child(V_PATH)).read_data_value()
                for stamp in (stamped.SourceTimestamp, stamped.ServerTimestamp):
                    assert abs((stamp - datetime.now(timezone.utc)).total_seconds() - skew) < 10
                assert stamped.Value.Value == 400.0 and stamped.StatusCode_.is_good()
    assert not skew_clock_tasks()


async def test_a_server_that_fails_after_its_listener_is_up_does_not_leave_the_listener_behind(monkeypatch):
    async def failing(self):
        raise RuntimeError("the first skewed time could not be written")

    monkeypatch.setattr("dcdash.simulator.faultserver._FaultServer._after_start", failing)
    srv = OpcUaSim(Simulator(), free_port(), faults=faults(SKEW="900"))
    port = int(srv.endpoint.rsplit(":", 1)[1].split("/")[0])
    try:
        with pytest.raises(RuntimeError, match="first skewed time"):
            await srv.start()
        with pytest.raises(OSError):  # nothing listens any more
            await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), 2)
    finally:
        with contextlib.suppress(Exception):
            await srv.stop()


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
