"""The connection-check framework (diagnostics/check.py, diagnostics/hints.py) and the default Connector.check. No database."""
import asyncio
import socket
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import pytest
from asyncua import ua

from dcdash.connectors.base import ConnectionCheck, Connector, ConnectorError
from dcdash.connectors.simulator import SimulatorConfig, SimulatorConnector
from dcdash.diagnostics import check as check_module
from dcdash.diagnostics.check import Checker, StepFailed, StepOutcome, error_object
from dcdash.diagnostics.hints import CLOCK_SKEW, hint_for
from dcdash.diagnostics.report import parse_check

SECRET = "hunter2-the-secret"


async def fine() -> str:
    return "worked"


def failing(exc: BaseException):
    async def run() -> None:
        raise exc

    return run


# --- hints ----------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "cls", "step", "expected"),
    [
        ("BadSecurityChecksFailed", None, "session", "trust"),
        ("BadCertificateUntrusted", None, "session", "trusted list"),
        ("BadCertificateInvalid", None, "certificates", "unusable"),
        ("BadCertificateHostNameInvalid", None, "session", "host"),
        ("BadIdentityTokenRejected", None, "session", "password"),
        ("BadUserAccessDenied", None, "session", "read"),
        ("BadTcpEndpointUrlInvalid", None, "session", "endpoint URL"),
        ("BadNodeIdUnknown", None, "read_points", "namespace"),
        ("BadTimeout", None, "read_points", "did not answer"),
        ("BadSecurityPolicyRejected", None, "session", "security policy"),
        ("BadSessionClosed", None, "read_points", "session"),
        (None, "ConnectionRefusedError", "tcp", "nothing listens"),
        (None, "gaierror", "dns", "could not be resolved"),
        (None, "TimeoutError", "tcp", "firewall"),
        (None, "TimeoutError", "session", "did not answer"),
        (CLOCK_SKEW, None, "server_time", "Docker Desktop"),
    ],
)
def test_hint_for_names_the_usual_cause(status, cls, step, expected):
    assert expected in (hint_for(status, cls, step) or "")


def test_the_session_step_adds_the_clock_to_the_security_failures_that_can_be_a_clock_problem():
    at_session = hint_for("BadSecurityChecksFailed", None, "session")
    elsewhere = hint_for("BadSecurityChecksFailed", None, "endpoints")
    assert "clock" in at_session and "clock" not in elsewhere
    for status in ("BadCertificateTimeInvalid", "BadInvalidTimestamp"):
        assert "clock" in hint_for(status, None, "session")


def test_the_skew_hint_puts_the_local_cause_first_and_points_at_the_report():
    hint = hint_for(CLOCK_SKEW, None, "server_time")
    assert hint.index("Local cause first") < hint.index("SCADA team")
    assert "browser-vs-container" in hint


def test_unknown_failures_get_no_hint_and_every_hint_fits_a_report_line():
    assert hint_for("BadSomethingNew", "WeirdError", "session") is None
    assert hint_for(None, None, "dns") is None
    from dcdash.diagnostics import hints

    texts = [*hints._BY_STATUS.values(), *hints._BY_CLASS.values(), hints._TIMEOUT_AT_NETWORK_STEP, hints._TIMEOUT_LATER]
    assert all(len(text) <= 300 for text in texts), [len(text) for text in texts]


# --- error conversion -----------------------------------------------------------------------------------------------------


def test_a_wrapped_exception_is_reported_as_its_root_cause_with_the_connectors_message():
    try:
        try:
            raise socket.gaierror(-2, "Name or service not known")
        except OSError as inner:
            raise ConnectorError("unreachable", "cannot reach scada.plant: name lookup failed") from inner
    except ConnectorError as exc:
        error = error_object(exc)
    assert error["class"] == "gaierror" and error["message"] == "cannot reach scada.plant: name lookup failed"
    assert error["status_name"] is None and error["status_hex"] is None
    assert hint_for(error["status_name"], error["class"], "dns")


def test_an_exception_raised_while_handling_another_is_followed_unless_it_says_from_none():
    def raised(suppress: bool) -> dict:
        try:
            try:
                raise ConnectionRefusedError("refused")
            except OSError:
                if suppress:
                    raise ConnectorError("unreachable", "cannot connect") from None
                raise ConnectorError("unreachable", "cannot connect")
        except ConnectorError as exc:
            return error_object(exc)

    assert raised(False)["class"] == "ConnectionRefusedError" and raised(False)["message"] == "cannot connect"
    assert raised(True)["class"] == "ConnectorError"


def test_the_opcua_status_is_found_anywhere_in_the_chain():
    try:
        try:
            raise ua.UaStatusCodeError(ua.StatusCodes.BadUserAccessDenied)
        except ua.UaStatusCodeError as inner:
            raise ConnectorError("auth_failed", str(inner)) from inner
    except ConnectorError as exc:
        error = error_object(exc)
    assert (error["status_name"], error["status_hex"]) == ("BadUserAccessDenied", "0x801F0000")
    assert error["class"] == "BadUserAccessDenied" and "BadUserAccessDenied" in error["message"]  # asyncua raises one class per code


def test_the_message_is_scrubbed_with_the_known_values_and_cut():
    error = error_object(RuntimeError(f"rejected {SECRET} for http://svc:Zq9-pw@host/ " + "x" * 2000), [SECRET])
    assert SECRET not in error["message"] and "Zq9" not in error["message"] and len(error["message"]) <= 500


def test_an_exception_without_text_falls_back_to_the_given_message_then_the_class_name():
    assert error_object(TimeoutError(), fallback="no answer within 5 s")["message"] == "no answer within 5 s"
    assert error_object(OSError())["message"] == "OSError"


# --- the Checker ----------------------------------------------------------------------------------------------------------


async def test_steps_are_timed_in_order_and_the_result_has_the_pinned_shape():
    published: list[dict] = []

    async def publish(result):
        published.append(result.to_json())

    checker = Checker("fake", publish)
    await checker.step("one", "First", fine)
    await checker.step("two", "Second", failing(RuntimeError("boom")), needs=("one",))
    result = await checker.finish()
    assert [len(p["steps"]) for p in published] == [1, 2, 2]  # after each step, and once more when finished
    assert [p["finished"] for p in published] == [False, False, True]
    assert [p["ok"] for p in published] == [None, None, False]
    body = result.to_json()
    assert set(body) == {
        "source_id", "connector_type", "started_at", "finished", "ok", "first_failed", "steps", "clock", "names",
    }
    assert body["connector_type"] == "fake" and body["first_failed"] == "two" and body["names"] == {"hosts": [], "uris": []}
    assert set(body["clock"]) == {"server_time", "local_time", "skew_seconds"} and body["clock"]["skew_seconds"] is None
    first, second = body["steps"]
    assert set(first) == {"id", "name", "ok", "ms", "summary", "error", "hint", "detail"}
    assert (first["id"], first["name"], first["ok"], first["summary"], first["error"]) == ("one", "First", True, "worked", None)
    assert first["ms"] >= 0
    assert second["ok"] is False and second["error"]["class"] == "RuntimeError" and second["error"]["message"] == "boom"


async def test_a_step_that_needs_a_failed_or_skipped_step_is_skipped_and_the_others_still_run():
    checker = Checker("fake")
    await checker.step("a", "A", failing(OSError("down")))
    await checker.step("b", "B", fine, needs=("a",))
    await checker.step("c", "C", fine, needs=("b",))
    await checker.step("d", "D", fine)
    await checker.step("e", "E", fine, needs=("nothing",))
    result = await checker.finish()
    states = {step.id: step.ok for step in result.steps}
    assert states == {"a": False, "b": None, "c": None, "d": True, "e": None}
    assert result.step("b").summary == "skipped: a failed" and result.step("c").summary == "skipped: b was skipped"
    assert result.step("e").summary == "skipped: nothing was not run"
    assert result.step("b").ms is None and result.step("b").error is None
    assert (result.ok, result.first_failed) == (False, "a")


async def test_an_all_ok_check_is_ok_and_an_empty_one_is_not():
    checker = Checker("fake")
    await checker.step("a", "A", fine)
    assert (await checker.finish()).ok is True
    assert (await Checker("fake").finish()).ok is False


async def test_a_step_may_return_an_outcome_with_detail_and_a_hint():
    async def step() -> StepOutcome:
        return StepOutcome("3 endpoints", {"when": datetime(2026, 1, 1, tzinfo=timezone.utc), "n": 3, "obj": object}, hint="note")

    checker = Checker("fake")
    done = await checker.step("endpoints", "Endpoints", step)
    assert done.summary == "3 endpoints" and done.hint == "note"
    assert done.detail["when"].startswith("2026-01-01") and done.detail["n"] == 3 and isinstance(done.detail["obj"], str)


async def test_step_failed_carries_its_own_status_hint_and_detail():
    async def skewed() -> None:
        raise StepFailed(
            "the server clock is 400 s ahead", summary="skew +400 s", hint_key=CLOCK_SKEW, detail={"skew": 400.0},
        )

    async def explicit() -> None:
        raise StepFailed("policy missing", status_name="BadSecurityPolicyRejected", status_hex="0x80550000", hint="my own hint")

    checker = Checker("fake")
    one = await checker.step("server_time", "Server time", skewed)
    two = await checker.step("endpoints", "Endpoints", explicit)
    assert one.ok is False and one.summary == "skew +400 s" and one.detail == {"skew": 400.0}
    assert one.error == {
        "class": "CheckFailed", "status_name": None, "status_hex": None, "message": "the server clock is 400 s ahead",
    }
    assert "Docker Desktop" in one.hint
    assert two.error["status_name"] == "BadSecurityPolicyRejected" and two.error["status_hex"] == "0x80550000"
    assert two.hint == "my own hint"


async def test_a_step_that_hangs_fails_with_a_timeout_not_a_cancellation():
    checker = Checker("fake", step_timeout=0.05)

    async def hang() -> None:
        await asyncio.sleep(30)

    step = await checker.step("tcp", "TCP connect", hang)
    assert step.ok is False and step.error["class"] == "TimeoutError" and step.error["message"] == "no answer within 0.05 s"
    assert "firewall" in step.hint and 40 <= step.ms < 2000
    own = await checker.step("later", "Later", hang, timeout=0.02)
    assert own.error["message"] == "no answer within 0.02 s" and "did not answer" in own.hint


async def test_the_overall_deadline_fails_the_step_in_flight_then_the_next_and_skips_the_rest():
    checker = Checker("fake", deadline_seconds=0.1)

    async def hang() -> None:
        await asyncio.sleep(30)

    await checker.step("one", "One", hang)
    await checker.step("two", "Two", fine)
    await checker.step("three", "Three", fine)
    result = await checker.finish()
    one, two, three = result.steps
    assert one.ok is False and one.error["class"] == "TimeoutError"
    assert two.ok is False and "overall time limit of 0.1 s" in two.error["message"]
    assert three.ok is None and "overall time limit" in three.summary
    assert (result.ok, result.first_failed) == (False, "one")


async def test_a_publish_that_fails_or_hangs_never_fails_the_check(monkeypatch, caplog):
    monkeypatch.setattr(check_module, "PUBLISH_TIMEOUT_SECONDS", 0.05)
    calls = 0

    async def broken(result) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("database is down")
        await asyncio.sleep(30)

    checker = Checker("fake", broken)
    with caplog.at_level("WARNING"):
        await checker.step("a", "A", fine)
        await checker.step("b", "B", fine)
        result = await checker.finish()
    assert result.ok is True and calls == 3
    assert len([r for r in caplog.records if "could not store the progress" in r.getMessage()]) == 1  # one warning per streak


async def test_cancelling_a_check_is_not_swallowed():
    async def cancelled(result) -> None:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await Checker("fake", cancelled).step("a", "A", fine)


async def test_known_values_never_reach_a_message_summary_detail_or_name():
    async def step() -> StepOutcome:
        return StepOutcome(f"user rejected {SECRET}", {"nested": [f"token {SECRET}"]})

    checker = Checker("fake", known=[SECRET])
    await checker.step("ok", "Ok", step)
    await checker.step("bad", "Bad", failing(RuntimeError(f"password {SECRET} is wrong")))
    await checker.step("named", "Named", failing(StepFailed(f"nope {SECRET}", detail={"x": SECRET})))
    checker.add_names(hosts=[f"{SECRET}.example"], uris=["urn:plant:server"])
    assert SECRET not in str((await checker.finish()).to_json())


async def test_the_clock_is_server_minus_local_and_the_names_are_deduplicated():
    checker = Checker("fake")
    local = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    assert checker.clock(local + timedelta(minutes=5), local) == 300.0
    assert checker.clock(datetime(2026, 1, 1, 11, 0), local) == -3600.0  # a naive time counts as UTC
    checker.add_names(hosts=["scada.plant", "scada.plant", "", 5, " other "], uris=["urn:plant:srv", "urn:plant:srv"])
    body = (await checker.finish()).to_json()
    assert body["clock"] == {
        "server_time": "2026-01-01T11:00:00+00:00", "local_time": "2026-01-01T12:00:00+00:00", "skew_seconds": -3600.0,
    }
    assert body["names"] == {"hosts": ["scada.plant", "other"], "uris": ["urn:plant:srv"]}


async def test_the_report_reads_what_the_checker_writes():
    """The two sides of the JSON contract: a stored check result goes through the report's own parser."""
    checker = Checker("opcua")
    await checker.step("dns", "DNS resolution", fine)
    await checker.step("tcp", "TCP connect", fine, needs=("dns",))

    async def session() -> None:
        raise ua.UaStatusCodeError(ua.StatusCodes.BadUserAccessDenied)

    await checker.step("session", "Session", session, needs=("tcp",))
    await checker.step("server_time", "Server time", fine, needs=("session",))
    checker.clock(datetime(2026, 1, 1, 0, 0, 30, tzinfo=timezone.utc), datetime(2026, 1, 1, tzinfo=timezone.utc))
    checker.add_names(hosts=["scada.plant"], uris=["urn:plant:server"])
    result = await checker.finish()
    result.source_id = 3
    info = parse_check(9, 3, "done", result.to_json(), None, None)
    assert info.state == "failed" and info.failed_step.id == "session" and info.first_failed == "session"
    assert (info.failed_step.status_name, info.failed_step.status_hex) == ("BadUserAccessDenied", "0x801F0000")
    assert info.failed_step.hint and info.connector_type == "opcua" and info.finished is True and info.ok is False
    assert [step.ok for step in info.steps] == [True, True, False, None]
    assert info.skew_seconds == 30.0 and info.hosts == ("scada.plant",) and info.uris == ("urn:plant:server",)
    running = parse_check(9, 3, "running", {**result.to_json(), "finished": False, "ok": None, "first_failed": None,
                                             "steps": result.to_json()["steps"][:2]}, None, None)
    assert running.state == "running"


# --- the default Connector.check ------------------------------------------------------------------------------------------


class Scripted(Connector):
    type = "scripted"
    config_schema = SimulatorConfig

    def __init__(self, outcome: ConnectionCheck | BaseException, secret: str | None = None) -> None:
        super().__init__(SimulatorConfig(), secret)
        self.outcome = outcome

    async def test(self) -> ConnectionCheck:
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome

    async def browse(self):
        return []

    async def read(self, addresses):
        return []


async def test_the_default_check_is_one_test_step_with_the_only_opcua_hint():
    seen: list[int] = []

    async def publish(result) -> None:
        seen.append(len(result.steps))

    result = await Scripted(ConnectionCheck(ok=True, status="ok", latency_ms=12.4)).check(["a"], publish)
    [step] = result.steps
    assert (step.id, step.ok, step.summary) == ("test", True, "connected in 12 ms") and "OPC UA" in step.hint
    assert result.ok is True and result.finished and result.connector_type == "scripted" and seen == [1, 1]


async def test_the_default_check_reports_a_no_as_a_failed_step_and_an_exception_too():
    no = await Scripted(ConnectionCheck(ok=False, status="auth_failed", message="credentials rejected")).check([], None)
    [step] = no.steps
    assert step.ok is False and step.summary == "auth_failed" and "OPC UA" in step.hint
    assert step.error["message"] == "auth_failed: credentials rejected" and no.first_failed == "test" and no.ok is False

    boom = await Scripted(RuntimeError(f"cannot log in with {SECRET}"), secret=SECRET).check([], None)
    assert boom.steps[0].error["class"] == "RuntimeError" and SECRET not in str(boom.to_json())


async def test_the_default_check_runs_against_the_simulator_connector():
    from dcdash.simulator.app import create_sim_app
    from dcdash.simulator.model import Simulator
    import httpx

    transport = httpx.ASGITransport(app=create_sim_app(Simulator(), api_key="k"))
    good = await SimulatorConnector(SimulatorConfig(url="http://sim"), "k", transport=transport).check([], None)
    bad = await SimulatorConnector(SimulatorConfig(url="http://sim"), "wrong", transport=transport).check([], None)
    assert good.ok is True and bad.ok is False and bad.steps[0].error["message"] == "auth_failed: credentials rejected"


# --- layering -------------------------------------------------------------------------------------------------------------


def test_the_check_module_does_not_import_the_connectors():
    code = (
        "import sys, dcdash.diagnostics.check, dcdash.diagnostics.hints\n"
        "loaded = sorted(m for m in sys.modules if m.startswith('dcdash.connectors'))\n"
        "print(loaded)\nsys.exit(1 if loaded else 0)"
    )
    run = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stdout + run.stderr
