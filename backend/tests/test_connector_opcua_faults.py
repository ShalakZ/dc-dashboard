"""The OPC UA connection check against every fault of the simulator (SIM_FAULT_*).

Each test builds the source configuration a real user would have, switches one fault on, runs `connector.check` and pins WHICH
step fails, with which status or exception class, that the step's hint says who to ask, and which steps are skipped. The faults
model real failures (an untrusted certificate, a login, other security policies, a slow or short-lived gateway, a broken device,
a wrong clock), so a row that would fail at an artificial step trains the reports on the wrong thing.
"""

import json

import pytest
from asyncua import Client

from dcdash.connectors import opcua_check
from dcdash.connectors.base import create_connector
from dcdash.diagnostics.hints import CLOCK_SKEW, hint_for
from dcdash.simulator.faults import Faults
from tests.helpers import opcua_server, write_client_certificate

STEP_IDS = ["dns", "tcp", "endpoints", "certificates", "session", "server_time", "namespaces", "read_points", "timing"]
AFTER_SESSION = dict.fromkeys(STEP_IDS[5:], None)  # skipped when the session cannot be opened
REAL_TIMING_PAUSE = opcua_check.TIMING_PAUSE
V_PATH = ["2:Panels", "2:LVP01", "2:V"]


@pytest.fixture(autouse=True)
def quick_timing(monkeypatch):
    monkeypatch.setattr(opcua_check, "TIMING_PAUSE", 0)


def faults(**env: str) -> Faults:
    return Faults.from_env({f"SIM_FAULT_{name}": value for name, value in env.items()})


def _cfg(srv, **extra):
    return {"endpoint": srv.endpoint.replace("0.0.0.0", "127.0.0.1"), "timeout_seconds": 2, **extra}


def _secure(srv, tmp_path, **extra):
    """The source of a user who follows the README: Basic256Sha256 with a self-signed certificate (URI urn:dcdash:collector)."""
    cert_path, key_path = write_client_certificate(tmp_path)
    return _cfg(srv, security_policy="basic256sha256", client_cert=cert_path, client_key=key_path, **extra)


def _by_id(result):
    return {step.id: step for step in result.steps}


def _not_ok(result):
    """{step id: ok} of every step that did not pass (False: failed, None: skipped)."""
    return {step.id: step.ok for step in result.steps if step.ok is not True}


def _asks(step, *phrases):
    """The step has a hint that tells the owner who to ask, and contains `phrases`."""
    assert step.hint, f"{step.id} has no hint"
    assert "Ask" in step.hint or "ask" in step.hint, step.hint
    assert "SCADA" in step.hint, step.hint
    for phrase in phrases:
        assert phrase in step.hint, (phrase, step.hint)


def _status(step):
    return step.error["status_name"], step.error["status_hex"]


# -- UNTRUSTED_CERT: the server does not trust our certificate --------------------------------------------------------------------


async def test_an_untrusted_certificate_is_refused_at_the_channel_and_the_session_step_says_so_at_once(tmp_path):
    async with opcua_server(faults=faults(UNTRUSTED_CERT="1")) as srv:
        result = await create_connector("opcua", _secure(srv, tmp_path)).check(["ns=2;i=1"])
    steps = _by_id(result)
    assert _not_ok(result) == {"session": False, **AFTER_SESSION}
    session = steps["session"]
    assert _status(session) == ("BadSecurityChecksFailed", "0x80130000") and session.ms < 1500  # an answer, not a timeout
    assert session.error["class"] != "TimeoutError"
    thumbprint = steps["certificates"].detail["client"]["thumbprint_sha1"]
    assert thumbprint in steps["certificates"].summary  # the hint sends the reader here
    _asks(session, "thumbprint", "certificates step")
    assert "SHA-1 thumbprint" in steps["certificates"].summary and "URI urn:dcdash:collector" in steps["certificates"].summary
    assert [e["policy"] for e in steps["endpoints"].detail["endpoints"]] == ["Basic256Sha256"]  # secure only, discovery still works
    assert result.first_failed == "session" and result.finished and result.ok is False


async def test_the_session_variant_of_an_untrusted_certificate_answers_bad_certificate_untrusted(tmp_path):
    async with opcua_server(faults=faults(UNTRUSTED_CERT="session")) as srv:
        result = await create_connector("opcua", _secure(srv, tmp_path)).check(["ns=2;i=1"])
    session = _by_id(result)["session"]
    assert _not_ok(result) == {"session": False, **AFTER_SESSION}
    assert _status(session) == ("BadCertificateUntrusted", "0x801A0000")
    _asks(session, "thumbprint", "trusted list")
    assert result.first_failed == "session"


# -- POLICIES: the server offers other security policies than the source asks for ----------------------------------------------


async def test_a_source_without_security_against_a_secure_only_server_fails_endpoints_and_lists_what_is_offered():
    async with opcua_server(faults=faults(POLICIES="basic256sha256")) as srv:
        result = await create_connector("opcua", _cfg(srv)).check(["ns=2;i=1"])
    steps = _by_id(result)
    assert result.first_failed == "endpoints"
    assert _not_ok(result) == {"endpoints": False, "session": False, **AFTER_SESSION}  # the stock client refuses the session itself
    endpoints = steps["endpoints"]
    assert endpoints.error["class"] == "ConfigMismatch"
    assert "None/None" in endpoints.error["message"] and "configured" in endpoints.error["message"]
    assert "offered: Basic256Sha256/SignAndEncrypt" in endpoints.summary
    _asks(endpoints, "endpoints step", "security policy")
    assert steps["session"].error["class"] == "UaError" and steps["session"].error["message"].startswith("No matching endpoints")
    _asks(steps["session"], "security policy")  # the failure that follows from it says the same, not nothing


async def test_a_secure_source_against_a_secure_only_server_passes_all_nine_steps(tmp_path):
    async with opcua_server(faults=faults(POLICIES="basic256sha256")) as srv:
        result = await create_connector("opcua", _secure(srv, tmp_path)).check(["ns=2;i=1"])
    steps = _by_id(result)
    assert [step.id for step in result.steps] == STEP_IDS and all(step.ok is True for step in result.steps), result.to_json()
    assert [e["policy"] for e in steps["endpoints"].detail["endpoints"]] == ["Basic256Sha256"]  # the fault really was on
    assert "server certificate dcdash-simulator" in steps["certificates"].summary and "names 127.0.0.1" in steps["certificates"].summary
    assert steps["session"].summary.startswith("session opened (Basic256Sha256/SignAndEncrypt")
    assert result.ok and result.first_failed is None


async def test_a_secure_source_against_a_server_that_offers_no_security_fails_endpoints_and_the_session_with_the_policy_hint(tmp_path):
    async with opcua_server() as srv:  # the default simulator offers None only
        result = await create_connector("opcua", _secure(srv, tmp_path)).check(["ns=2;i=1"])
    steps = _by_id(result)
    assert result.first_failed == "endpoints"
    assert _not_ok(result) == {"endpoints": False, "session": False, **AFTER_SESSION}  # certificates only reads our own file
    assert "Basic256Sha256/SignAndEncrypt" in steps["endpoints"].error["message"] and "None/None" in steps["endpoints"].summary
    _asks(steps["endpoints"], "security policy")
    assert steps["session"].error["class"] == "UaError" and steps["session"].error["message"].startswith("No matching endpoints")
    _asks(steps["session"], "security policy")  # asyncua refuses inside _new_client here, before connect(): the same translation


# -- AUTH: the server wants a login -------------------------------------------------------------------------------------------


async def test_a_server_that_wants_a_login_fails_endpoints_without_a_user_name_and_the_session_with_a_wrong_password():
    async with opcua_server(password="right-pw", faults=faults(AUTH="required")) as srv:
        anonymous = await create_connector("opcua", _cfg(srv)).check(["ns=2;i=1"])
        wrong = await create_connector("opcua", _cfg(srv, username="sim"), secret="wrong-pw").check(["ns=2;i=1"])
        right = await create_connector("opcua", _cfg(srv, username="sim"), secret="right-pw").check(["ns=2;i=1"])

    # no user name: the endpoint list already shows it, and the anonymous session is then refused by name
    assert anonymous.first_failed == "endpoints"
    assert _not_ok(anonymous) == {"endpoints": False, "session": False, **AFTER_SESSION}
    endpoints = _by_id(anonymous)["endpoints"]
    assert endpoints.error["class"] == "ConfigMismatch" and "does not accept anonymous" in endpoints.error["message"]
    assert "[UserName]" in endpoints.summary and "Anonymous" not in endpoints.summary
    _asks(endpoints, "account")
    refused = _by_id(anonymous)["session"]
    assert _status(refused) == ("BadIdentityTokenRejected", "0x80210000")
    _asks(refused, "user name and password")

    # a wrong password: the endpoints are fine, the session is refused by name
    assert _not_ok(wrong) == {"session": False, **AFTER_SESSION} and wrong.first_failed == "session"
    denied = _by_id(wrong)["session"]
    assert denied.error["status_name"] in ("BadUserAccessDenied", "BadIdentityTokenRejected")
    _asks(denied)
    assert "wrong-pw" not in json.dumps(wrong.to_json())

    # the right one: all nine steps, and the endpoint really offered a login only
    assert all(step.ok is True for step in right.steps) and right.first_failed is None, right.to_json()
    tokens = {tuple(row["user_tokens"]) for row in _by_id(right)["endpoints"].detail["endpoints"]}
    assert tokens == {("UserName",)}
    assert "right-pw" not in json.dumps(right.to_json())


# -- SLOW: every message is answered late (a handshake needs about four of them under ONE timeout) ----------------------------


async def test_answers_a_fraction_of_the_timeout_late_still_pass_and_the_timing_step_shows_the_delay():
    async with opcua_server(faults=faults(SLOW="0.3")) as srv:
        result = await create_connector("opcua", _cfg(srv, timeout_seconds=2)).check(["ns=2;i=1"])
    assert all(step.ok is True for step in result.steps), [(s.id, s.error) for s in result.steps]
    reads = _by_id(result)["timing"].detail["reads_ms"]
    assert min(reads) >= 250 and max(reads) < 1500  # the fault really was on: each read waited for its answer
    assert _by_id(result)["endpoints"].ms > 600 and _by_id(result)["session"].ms > 600  # several delayed messages each


async def test_answers_later_than_the_timeout_fail_the_first_step_that_talks_opc_ua_and_its_hint_explains_the_handshake():
    async with opcua_server(faults=faults(SLOW="1.5")) as srv:
        result = await create_connector("opcua", _cfg(srv, timeout_seconds=1)).check(["ns=2;i=1"])
    steps = _by_id(result)
    assert result.first_failed == "endpoints"
    assert _not_ok(result) == {"endpoints": False, "session": False, **AFTER_SESSION}  # dns, tcp and certificates need no answer
    for step_id in ("endpoints", "session"):
        step = steps[step_id]
        assert step.error["class"] == "TimeoutError" and step.error["message"] == "no answer within 1 s"
        _asks(step, "did not answer", "four round trips", "a quarter of the timeout")
        assert 900 < step.ms < 1500


# -- DROP: the server closes each connection a short time after accepting it ----------------------------------------------------


async def test_connections_cut_half_a_second_after_they_open_fail_the_timing_step_with_a_reset(monkeypatch):
    monkeypatch.setattr(opcua_check, "TIMING_PAUSE", REAL_TIMING_PAUSE)  # the five reads must outlast the half second
    async with opcua_server(faults=faults(DROP="0.5")) as srv:
        result = await create_connector("opcua", _cfg(srv)).check([])
    steps = _by_id(result)
    assert _not_ok(result) == {"timing": False}, result.to_json()  # endpoints, session and the quick reads fit in 0.5 s
    timing = steps["timing"]
    assert timing.error["class"] == "ConnectionResetError"
    _asks(timing, "reset by the other end", "firewall")
    assert result.first_failed == "timing" and timing.ms < 1500  # at once, not after the timeout


# -- BAD: the device behind the server reports a fault for some points ----------------------------------------------------------


async def test_a_point_with_a_bad_status_is_named_with_its_code_and_the_hint_says_to_ask_about_the_device():
    async with opcua_server(faults=faults(BAD="LVP01_kW:BadSensorFailure")) as srv:
        async with Client(srv.endpoint.replace("0.0.0.0", "127.0.0.1")) as plain:
            broken = (await plain.nodes.objects.get_child(["2:Panels", "2:LVP01", "2:kW"])).nodeid.to_string()
            fine = (await plain.nodes.objects.get_child(V_PATH)).nodeid.to_string()
        result = await create_connector("opcua", _cfg(srv)).check([fine, broken])
    read_points = _by_id(result)["read_points"]
    assert all(step.ok is True for step in result.steps) and result.first_failed is None  # the step passes, the row is the finding
    assert f"bad: BadSensorFailure {broken}" in read_points.summary and read_points.detail["bad_status"] == 1
    assert read_points.summary.startswith("read 2 point(s)") and "1 good, 1 bad" in read_points.summary
    first = read_points.detail["points"][0]
    assert (first["address"], first["good"], first["status"], first["value"]) == (broken, False, "BadSensorFailure (0x808C0000)", None)
    _asks(read_points, "device behind it", "which device or signal")
    assert read_points.hint == f"BadSensorFailure: {hint_for('BadSensorFailure', None, 'read_points')}"


async def test_several_bad_statuses_are_each_named_once_with_their_first_point_and_get_a_hint_line_each():
    bad = "LVP01_kW:BadSensorFailure,LVP02_V:BadNodeIdUnknown,LVP03_kW:BadSensorFailure,LVP04_kW:BadDeviceFailure"
    async with opcua_server(faults=faults(BAD=bad)) as srv:
        async with Client(srv.endpoint.replace("0.0.0.0", "127.0.0.1")) as plain:
            ids = {
                name: (await plain.nodes.objects.get_child(["2:Panels", f"2:LVP{panel}", f"2:{field}"])).nodeid.to_string()
                for name, panel, field in (("a", "01", "kW"), ("b", "02", "V"), ("c", "03", "kW"), ("d", "04", "kW"), ("ok", "05", "kW"))
            }
        result = await create_connector("opcua", _cfg(srv)).check([ids["ok"], ids["a"], ids["b"], ids["c"], ids["d"]])
    read_points = _by_id(result)["read_points"]
    assert all(step.ok is True for step in result.steps) and read_points.detail["bad"] == 4 and read_points.detail["good"] == 1
    # the first point of each status, in the order the statuses first appear; the third point shares the first one's status
    assert f"bad: BadSensorFailure {ids['a']}; BadNodeIdUnknown {ids['b']}; BadDeviceFailure {ids['d']}" in read_points.summary
    assert ids["c"] not in read_points.summary and len(read_points.summary) <= opcua_check.SUMMARY_CHARS
    lines = read_points.hint.split("\n")
    assert len(lines) == 2  # BadSensorFailure and BadDeviceFailure share the device-fault hint, BadNodeIdUnknown has its own
    assert lines[0].startswith("BadSensorFailure, BadDeviceFailure: ") and "device behind it" in lines[0]
    assert lines[1].startswith("BadNodeIdUnknown: ") and "namespace" in lines[1] and all(len(line) <= 280 for line in lines)


# -- SKEW: the server's clock is wrong ------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("skew", "direction"), [(900, "ahead of"), (-900, "behind")])
async def test_a_server_clock_15_minutes_off_fails_server_time_with_the_clock_hint_and_blocks_nothing_else(skew, direction):
    async with opcua_server(faults=faults(SKEW=str(skew))) as srv:
        result = await create_connector("opcua", _cfg(srv)).check(["ns=2;i=1"])
    server_time = _by_id(result)["server_time"]
    assert _not_ok(result) == {"server_time": False} and result.first_failed == "server_time"
    assert server_time.error["class"] == "ClockSkew" and direction in server_time.error["message"]
    assert server_time.hint == hint_for(CLOCK_SKEW, None, "server_time")
    _asks(server_time, "Docker Desktop", "time source")
    assert result.skew_seconds == pytest.approx(skew, abs=5) and server_time.summary == f"clock difference {skew:+d} s"


async def test_a_server_clock_two_minutes_off_passes_with_a_warning():
    async with opcua_server(faults=faults(SKEW="120")) as srv:
        result = await create_connector("opcua", _cfg(srv)).check(["ns=2;i=1"])
    server_time = _by_id(result)["server_time"]
    assert all(step.ok is True for step in result.steps) and result.ok
    assert "ahead of ours" in server_time.summary and "more than 60 s, check both clocks" in server_time.summary
    assert result.skew_seconds == pytest.approx(120, abs=5)


# -- the certificates step shows what the server compares ------------------------------------------------------------------------


async def test_the_certificates_step_names_the_uri_of_our_certificate_or_says_it_has_none(tmp_path):
    with_uri = write_client_certificate(tmp_path, stem="with")
    without = write_client_certificate(tmp_path, stem="without", uri="")
    async with opcua_server(faults=faults(POLICIES="none,basic256sha256")) as srv:
        summaries = []
        for cert_path, key_path in (with_uri, without):
            config = _cfg(srv, security_policy="basic256sha256", client_cert=cert_path, client_key=key_path)
            outcome = await opcua_check.OpcUaCheck(create_connector("opcua", config), [], None).certificates()
            summaries.append(outcome.summary)
    assert "SHA-1 thumbprint" in summaries[0] and ", URI urn:dcdash:collector, valid until" in summaries[0]
    assert ", no URI, valid until" in summaries[1]
