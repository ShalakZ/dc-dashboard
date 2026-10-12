"""The OPC UA step-by-step connection check (connectors/opcua_check.py) against the in-process simulator."""

import asyncio
import builtins
import hashlib
import io
import ipaddress
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import aiofiles
import pytest
from asyncua import Client, ua
from asyncua.client.ua_client import UASocketProtocol
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from dcdash.connectors import opcua_check
from dcdash.connectors.base import create_connector
from dcdash.diagnostics.check import StepFailed
from dcdash.diagnostics.hints import CLOCK_SKEW, hint_for
from tests.helpers import free_port, opcua_server

STEP_IDS = ["dns", "tcp", "endpoints", "certificates", "session", "server_time", "namespaces", "read_points", "timing"]
MAX_NODES_PER_READ = ua.NodeId(ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead)


@pytest.fixture(autouse=True)
def quick_timing(monkeypatch):
    monkeypatch.setattr(opcua_check, "TIMING_PAUSE", 0)


def _cfg(srv, **extra):
    return {"endpoint": srv.endpoint.replace("0.0.0.0", "127.0.0.1"), "timeout_seconds": 2, **extra}


async def _addresses(connector, count):
    return [point.address for point in (await connector.browse())[:count]]


def _spy(monkeypatch, cls, name):
    """Count the awaited calls of an async method; returns the list of (args, kwargs)."""
    calls = []
    original = getattr(cls, name)

    async def wrapper(self, *args, **kwargs):
        calls.append((args, kwargs))
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(cls, name, wrapper)
    return calls


def _spy_reads(monkeypatch):
    """(attribute, number of nodes) of every Read the client sends."""
    reads = []
    original = Client.read_attributes

    async def wrapper(self, nodes, attr=ua.AttributeIds.Value):
        nodes = list(nodes)
        reads.append((attr, len(nodes)))
        return await original(self, nodes, attr)

    monkeypatch.setattr(Client, "read_attributes", wrapper)
    return reads


def _by_id(result):
    return {step.id: step for step in result.steps}


async def _set_max_nodes_per_read(srv, value):
    await srv._server.get_node(MAX_NODES_PER_READ).write_value(ua.Variant(value, ua.VariantType.UInt32))


# -- the healthy path ---------------------------------------------------------------------------------------------------------


async def test_healthy_source_has_nine_ok_steps_one_session_and_only_read_services(monkeypatch):
    sessions = _spy(monkeypatch, Client, "create_session")
    requests = []
    original = UASocketProtocol.send_request

    async def send_request(self, request, *args, **kwargs):
        requests.append(type(request).__name__)
        return await original(self, request, *args, **kwargs)

    monkeypatch.setattr(UASocketProtocol, "send_request", send_request)
    published = []

    async def publish(result):
        published.append(len(result.steps))

    async with opcua_server() as srv:
        connector = create_connector("opcua", _cfg(srv))
        addresses = await _addresses(connector, 5)
        requests.clear()
        sessions.clear()
        result = await connector.check(addresses, publish)

    assert [step.id for step in result.steps] == STEP_IDS
    assert all(step.ok is True for step in result.steps), [(s.id, s.error) for s in result.steps]
    assert result.finished and result.ok and result.first_failed is None
    assert len(sessions) == 1  # steps session..timing share ONE session
    assert published[:9] == list(range(1, 10)) and published[-1] == 9  # live progress, then the final result
    steps = _by_id(result)
    assert "5 point(s)" in steps["read_points"].summary and "0 bad" in steps["read_points"].summary
    assert steps["timing"].summary.startswith("5 reads of 5 node(s)")
    assert steps["endpoints"].detail["endpoints"][0]["policy"] == "None"
    assert abs(result.skew_seconds) < 5 and result.server_time is not None
    names = result.to_json()["names"]
    assert "127.0.0.1" in names["hosts"] and "urn:dcdash:simulator" in names["uris"]
    assert set(requests) <= {
        "OpenSecureChannelRequest", "CreateSessionRequest", "ActivateSessionRequest", "ReadRequest", "GetEndpointsRequest",
        "CloseSessionRequest", "CloseSecureChannelRequest",
    }, set(requests)


async def test_the_right_password_passes_and_the_secret_is_nowhere_in_the_result():
    async with opcua_server(password="s3cret-pw") as srv:
        connector = create_connector("opcua", _cfg(srv, username="sim"), secret="s3cret-pw")
        result = await connector.check([])
    assert result.ok, [(s.id, s.error) for s in result.steps]
    assert "s3cret-pw" not in json.dumps(result.to_json())
    assert "no points are mapped" in _by_id(result)["read_points"].summary
    assert _by_id(result)["timing"].detail["nodes"] == 1  # the server time node stands in for the points


# -- failures ------------------------------------------------------------------------------------------------------------------


async def test_nothing_listening_fails_tcp_and_skips_the_rest():
    connector = create_connector("opcua", {"endpoint": f"opc.tcp://127.0.0.1:{free_port()}/", "timeout_seconds": 2})
    result = await connector.check(["ns=2;i=1"])
    steps = _by_id(result)
    assert [(s.id, s.ok) for s in result.steps] == [
        ("dns", True), ("tcp", False), *[(step_id, None) for step_id in STEP_IDS[2:]]
    ]
    assert steps["tcp"].error["class"] == "ConnectionRefusedError"
    assert "nothing listens" in steps["tcp"].hint
    assert steps["endpoints"].summary == "skipped: TCP connection failed"
    assert result.first_failed == "tcp" and result.finished and result.ok is False


async def test_unresolvable_host_fails_dns_with_the_dns_hint():
    connector = create_connector("opcua", {"endpoint": "opc.tcp://nohost.invalid:4840/", "timeout_seconds": 15})
    result = await connector.check([])
    steps = _by_id(result)
    assert steps["dns"].ok is False and steps["dns"].error["class"] == "gaierror"
    assert "could not be resolved" in steps["dns"].hint
    assert all(step.ok is None for step in result.steps[1:]) and steps["tcp"].summary == "skipped: DNS resolution failed"
    assert result.first_failed == "dns"


async def test_wrong_password_fails_the_session_with_the_status_and_skips_what_needs_it():
    async with opcua_server(password="right-pw") as srv:
        connector = create_connector("opcua", _cfg(srv, username="sim"), secret="wrong-pw")
        result = await connector.check(["ns=2;i=1"])
    steps = _by_id(result)
    assert [step.ok for step in result.steps[:4]] == [True, True, True, True]  # endpoints offer user name tokens
    session = steps["session"]
    assert session.ok is False
    assert (session.error["status_name"], session.error["status_hex"]) == ("BadUserAccessDenied", "0x801F0000")
    assert session.error["class"] == "BadUserAccessDenied" and "account" in session.hint
    assert all(steps[step_id].ok is None for step_id in STEP_IDS[5:])
    assert result.first_failed == "session"
    assert "wrong-pw" not in json.dumps(result.to_json())


async def test_endpoint_without_the_configured_user_token_fails_endpoints_but_not_the_session(monkeypatch):
    original = Client.connect_and_get_server_endpoints

    async def anonymous_only(self):
        endpoints = await original(self)
        for endpoint in endpoints:
            endpoint.UserIdentityTokens = [t for t in endpoint.UserIdentityTokens if t.TokenType == ua.UserTokenType.Anonymous]
        return endpoints

    monkeypatch.setattr(Client, "connect_and_get_server_endpoints", anonymous_only)
    async with opcua_server() as srv:
        connector = create_connector("opcua", _cfg(srv, username="sim"), secret="x")
        result = await connector.check([])
    steps = _by_id(result)
    assert steps["endpoints"].ok is False and "user name and password" in steps["endpoints"].error["message"]
    assert "offers user name and password" in steps["endpoints"].hint
    assert steps["session"].ok is True and steps["timing"].ok is True  # a diagnostic-only failure blocks nothing
    assert result.first_failed == "endpoints"


async def test_a_mapped_address_that_does_not_exist_is_listed_first_and_the_step_still_passes():
    async with opcua_server() as srv:
        connector = create_connector("opcua", _cfg(srv))
        good = (await _addresses(connector, 1))[0]
        result = await connector.check([good, "ns=2;i=999999", "not a node id", "ns=9;i=1"])
    steps = _by_id(result)
    assert all(step.ok is True for step in result.steps), [(s.id, s.error) for s in result.steps]
    read_points = steps["read_points"]
    rows = read_points.detail["points"]
    assert read_points.detail["good"] == 1 and read_points.detail["bad"] == 3
    assert [row["good"] for row in rows] == [False, False, False, True]  # bad ones first
    by_address = {row["address"]: row for row in rows}
    assert by_address["ns=2;i=999999"]["status"] == "BadNodeIdUnknown (0x80340000)"
    assert by_address["not a node id"]["status"].startswith("invalid node id")
    assert "namespace index 9 does not exist" in by_address["ns=9;i=1"]["note"]
    assert "note" not in by_address["ns=2;i=999999"]
    assert by_address[good]["data_type"] == "Double" and by_address[good]["access"] == "read"
    assert read_points.summary.startswith("read 4 point(s)") and "3 bad" in read_points.summary
    assert "node id or its namespace index does not exist" in read_points.hint
    assert result.ok


# -- chunking -----------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("limit", "point_count", "chunks", "chunk_size", "timing_nodes"),
    [(3, 7, [3, 3, 1], 3, 3), (0, 7, [7], 100, 7), (None, 150, [100, 50], 100, 10)],
    ids=["small limit", "zero means no limit", "server default is capped at 100"],
)
async def test_points_are_read_in_chunks_of_the_servers_limit_at_most_100(
    monkeypatch, limit, point_count, chunks, chunk_size, timing_nodes
):
    reads = _spy_reads(monkeypatch)
    async with opcua_server() as srv:
        if limit is not None:
            await _set_max_nodes_per_read(srv, limit)
        connector = create_connector("opcua", _cfg(srv))
        addresses = await _addresses(connector, 7)
        addresses = (addresses * 30)[:point_count]
        reads.clear()
        result = await connector.check(addresses)
    steps = _by_id(result)
    assert result.ok, [(s.id, s.error) for s in result.steps]
    for attr in (ua.AttributeIds.DataType, ua.AttributeIds.AccessLevel):
        assert [count for kind, count in reads if kind == attr] == chunks, attr
    assert max(count for _kind, count in reads) <= max(chunks)
    detail = steps["read_points"].detail
    assert detail["chunk_size"] == chunk_size and detail["requests"] == 3 * len(chunks)
    assert detail["server_max_nodes_per_read"] == (10000 if limit is None else limit)
    assert steps["timing"].detail["nodes"] == timing_nodes


# -- the clock -----------------------------------------------------------------------------------------------------------------


def _local_clock_behind(monkeypatch, seconds):
    """Our clock reads `seconds` less than the real time: the server (really right) looks `seconds` ahead."""
    monkeypatch.setattr(opcua_check, "_local_now", lambda: datetime.now(timezone.utc) - timedelta(seconds=seconds))


@pytest.mark.parametrize(("offset", "direction"), [(400, "ahead of"), (-400, "behind")])
async def test_a_clock_more_than_five_minutes_off_fails_server_time_with_the_clock_hint(monkeypatch, offset, direction):
    _local_clock_behind(monkeypatch, offset)
    async with opcua_server() as srv:
        result = await create_connector("opcua", _cfg(srv)).check([])
    server_time = _by_id(result)["server_time"]
    assert server_time.ok is False and server_time.error["class"] == "ClockSkew"
    assert direction in server_time.error["message"]
    assert server_time.hint == hint_for(CLOCK_SKEW, None, "server_time") and "Docker Desktop" in server_time.hint
    assert result.skew_seconds == pytest.approx(offset, abs=5)
    assert result.first_failed == "server_time" and result.ok is False
    assert all(_by_id(result)[step_id].ok is True for step_id in ("session", "namespaces", "timing"))  # they do not depend on it


async def test_a_clock_one_to_five_minutes_off_passes_with_a_warning(monkeypatch):
    _local_clock_behind(monkeypatch, 120)
    async with opcua_server() as srv:
        result = await create_connector("opcua", _cfg(srv)).check([])
    server_time = _by_id(result)["server_time"]
    assert server_time.ok is True and "ahead of ours" in server_time.summary and "check both clocks" in server_time.summary
    assert result.ok and result.skew_seconds == pytest.approx(120, abs=5)


# -- the session is always closed ---------------------------------------------------------------------------------------------


async def test_the_session_is_closed_when_the_check_is_cancelled(monkeypatch):
    disconnects = _spy(monkeypatch, Client, "disconnect")
    monkeypatch.setattr(opcua_check, "TIMING_PAUSE", 3600)
    reached = asyncio.Event()

    async def publish(result):
        if result.step("read_points") is not None:
            reached.set()

    async with opcua_server() as srv:
        task = asyncio.create_task(create_connector("opcua", _cfg(srv)).check([], publish))
        await asyncio.wait_for(reached.wait(), 15)
        await asyncio.sleep(0.3)  # timing has made its first read and sleeps
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert len(disconnects) == 1


async def test_the_session_is_closed_when_the_overall_time_runs_out(monkeypatch):
    disconnects = _spy(monkeypatch, Client, "disconnect")
    monkeypatch.setattr(opcua_check, "TIMING_PAUSE", 3600)
    monkeypatch.setattr(opcua_check, "DEADLINE_SECONDS", 4)
    async with opcua_server() as srv:
        result = await create_connector("opcua", _cfg(srv, timeout_seconds=30)).check([])
    timing = _by_id(result)["timing"]
    assert timing.ok is False and timing.error["class"] == "TimeoutError" and result.finished
    assert len(disconnects) == 1


# -- certificates -------------------------------------------------------------------------------------------------------------


def _certificate(
    *, cn="dcdash-client", valid_from=None, days=365, dns=("collector.example",), ips=("10.1.2.3",), uri="urn:dcdash:client"
):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    start = valid_from or datetime.now(timezone.utc) - timedelta(days=1)
    alternative = [x509.DNSName(item) for item in dns] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    if uri:
        alternative.append(x509.UniformResourceIdentifier(uri))
    builder = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(start).not_valid_after(start + timedelta(days=days))
    )
    if alternative:
        builder = builder.add_extension(x509.SubjectAlternativeName(alternative), critical=False)
    return builder.sign(key, hashes.SHA256()), key


@pytest.fixture(scope="module")
def certificate():
    return _certificate()


def test_certificate_facts_has_the_thumbprint_expiry_and_names(certificate):
    cert, _key = certificate
    facts = opcua_check.certificate_facts(cert)
    assert facts["thumbprint_sha1"] == hashlib.sha1(cert.public_bytes(serialization.Encoding.DER)).hexdigest().upper()
    assert facts["common_name"] == "dcdash-client" and "CN=dcdash-client" in facts["subject"] and facts["self_signed"]
    assert facts["not_after"] == cert.not_valid_after_utc.isoformat()
    assert facts["days_left"] in (363, 364) and not facts["expired"] and not facts["not_yet_valid"]
    assert facts["dns_names"] == ["collector.example"] and facts["ip_addresses"] == ["10.1.2.3"]
    assert facts["application_uri"] == "urn:dcdash:client"


def test_certificate_facts_flags_an_expired_and_a_not_yet_valid_certificate():
    now = datetime.now(timezone.utc)
    expired = opcua_check.certificate_facts(_certificate(valid_from=now - timedelta(days=30), days=10)[0])
    assert expired["expired"] and expired["days_left"] < 0
    future = opcua_check.certificate_facts(_certificate(valid_from=now + timedelta(days=5))[0])
    assert future["not_yet_valid"] and not future["expired"]


async def test_load_certificate_reads_pem_files_der_files_and_der_bytes(certificate, tmp_path):
    cert, _key = certificate
    der = cert.public_bytes(serialization.Encoding.DER)
    (tmp_path / "c.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (tmp_path / "c.der").write_bytes(der)
    thumbprints = {
        opcua_check.certificate_facts(await opcua_check.load_certificate(source))["thumbprint_sha1"]
        for source in (str(tmp_path / "c.pem"), str(tmp_path / "c.der"), der)
    }
    assert len(thumbprints) == 1
    with pytest.raises(ValueError):
        await opcua_check.load_certificate(b"")


def test_host_matches_dns_wildcard_ip_and_common_name():
    def facts(dns=(), ips=(), cn=None):
        return {"dns_names": list(dns), "ip_addresses": list(ips), "common_name": cn}

    assert opcua_check.host_matches(facts(dns=["scada.plant.example"]), "SCADA.plant.example") is True
    assert opcua_check.host_matches(facts(dns=["*.plant.example"]), "scada.plant.example") is True
    assert opcua_check.host_matches(facts(dns=["*.plant.example"]), "plant.example") is False
    assert opcua_check.host_matches(facts(ips=["10.0.0.5"]), "10.0.0.5") is True
    assert opcua_check.host_matches(facts(ips=["10.0.0.5"], dns=["scada"]), "10.0.0.6") is False
    assert opcua_check.host_matches(facts(cn="scada"), "scada") is True
    assert opcua_check.host_matches(facts(), "scada") is None


class _OpenedFiles:
    """Records every file the code under test opens through the usual doors."""

    def __init__(self, monkeypatch):
        self.paths: list[str] = []
        record = self.paths.append
        for owner, name in ((builtins, "open"), (io, "open"), (aiofiles, "open")):
            real = getattr(owner, name)
            monkeypatch.setattr(owner, name, lambda file, *a, _real=real, **k: (record(str(file)), _real(file, *a, **k))[1])
        for name in ("open", "read_bytes", "read_text"):
            real_method = getattr(Path, name)
            monkeypatch.setattr(Path, name, lambda self, *a, _real=real_method, **k: (record(str(self)), _real(self, *a, **k))[1])


@pytest.fixture
def cert_files(certificate, tmp_path):
    cert, key = certificate
    cert_path, key_path = tmp_path / "client.pem", tmp_path / "client-key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_text("SENTINEL-PRIVATE-KEY-MATERIAL")
    return cert_path, key_path


def _secure_config(srv, cert_path, key_path):
    return _cfg(srv, security_policy="basic256sha256", client_cert=str(cert_path), client_key=str(key_path))


async def test_the_certificates_step_reads_our_certificate_but_never_the_key_file(monkeypatch, cert_files):
    cert_path, key_path = cert_files
    opened = _OpenedFiles(monkeypatch)
    async with opcua_server() as srv:
        connector = create_connector("opcua", _secure_config(srv, cert_path, key_path))
        outcome = await opcua_check.OpcUaCheck(connector, [], None).certificates()
    assert str(cert_path) in opened.paths and str(key_path) not in opened.paths
    assert outcome.detail["client"]["key_file_present"] is True
    assert outcome.detail["client"]["thumbprint_sha1"] in outcome.summary
    assert "SENTINEL" not in json.dumps(outcome.detail) + outcome.summary


async def test_a_secure_check_against_a_server_that_offers_no_security_names_the_endpoints_and_leaves_the_key_alone(
    monkeypatch, cert_files
):
    cert_path, key_path = cert_files
    opened = _OpenedFiles(monkeypatch)

    async def refuse(self, security_string):
        raise RuntimeError("stubbed: asyncua is not asked to load the key here")

    monkeypatch.setattr(Client, "set_security_string", refuse)
    async with opcua_server() as srv:
        result = await create_connector("opcua", _secure_config(srv, cert_path, key_path)).check([])
    steps = _by_id(result)
    assert steps["endpoints"].ok is False and "Basic256Sha256/SignAndEncrypt" in steps["endpoints"].error["message"]
    assert "None/None" in steps["endpoints"].summary and "security policy" in steps["endpoints"].hint
    assert steps["certificates"].ok is True and "SHA-1 thumbprint" in steps["certificates"].summary
    assert steps["session"].ok is False and steps["session"].error["class"] == "RuntimeError"  # reached despite endpoints failing
    assert all(steps[step_id].ok is None for step_id in STEP_IDS[5:])
    assert str(key_path) not in opened.paths
    assert "SENTINEL" not in json.dumps(result.to_json())


async def test_an_expired_client_certificate_fails_the_certificates_step_with_a_hint(monkeypatch, tmp_path):
    cert, _key = _certificate(valid_from=datetime.now(timezone.utc) - timedelta(days=40), days=10)
    cert_path = tmp_path / "old.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (tmp_path / "old-key.pem").write_text("k")
    async with opcua_server() as srv:
        connector = create_connector("opcua", _secure_config(srv, cert_path, tmp_path / "old-key.pem"))
        check = opcua_check.OpcUaCheck(connector, [], None)
        outcome = await check.checker.step("certificates", "Certificates", check.certificates)
    assert outcome.ok is False and outcome.error["class"] == "CertificateTimeInvalid"
    assert "expired" in outcome.error["message"] and "expired or not valid yet" in outcome.hint
    assert "EXPIRED" in outcome.summary


async def test_a_missing_client_certificate_file_is_reported_with_its_path_and_a_hint(tmp_path):
    missing = tmp_path / "nope.pem"
    connector = create_connector("opcua", {
        "endpoint": "opc.tcp://127.0.0.1:1/", "security_policy": "basic256sha256",
        "client_cert": str(missing), "client_key": str(tmp_path / "nope-key.pem"),
    })
    check = opcua_check.OpcUaCheck(connector, [], None)
    step = await check.checker.step("certificates", "Certificates", check.certificates)
    assert step.ok is False and step.error["message"] == f"client certificate not found: {missing}"
    assert "README" in step.hint


def test_hints_for_the_read_failures_exist():
    for name in ("BadTooManyOperations", "BadNotReadable", "BadNodeIdUnknown"):
        hint = hint_for(name, None, "read_points")
        assert hint and len(hint) <= 300



def test_the_read_points_budget_follows_the_real_chunk_size():
    budget = opcua_check.OpcUaCheck._read_budget
    assert budget(2.0, 250, 100) == 2.0 * (2 + 3 * 3)
    assert budget(2.0, 250, 10) == 2.0 * (2 + 3 * 25)  # a server that reads 10 nodes at a time needs 8 times the requests
    assert budget(2.0, 0, 100) == 4.0


async def test_a_read_that_never_answers_fails_the_step_with_its_budget(monkeypatch):
    connector = create_connector("opcua", {"endpoint": "opc.tcp://127.0.0.1:4840/", "timeout_seconds": 2})
    check = opcua_check.OpcUaCheck(connector, ["ns=2;i=1"], None)

    async def stalled(*_args, **_kwargs):
        await asyncio.sleep(30)

    monkeypatch.setattr(opcua_check.OpcUaCheck, "_read_budget", staticmethod(lambda *_args: 0.05))
    monkeypatch.setattr(check, "_read", stalled)
    with pytest.raises(StepFailed) as failed:
        await check.read_points()
    assert failed.value.error_class == "TimeoutError" and "no answer within 0.05 s" in str(failed.value)
