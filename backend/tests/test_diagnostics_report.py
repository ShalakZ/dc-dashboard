"""The diagnostics report: `render` on fixture data (no database), `gather` on a seeded database."""
import asyncio
import re
import socket
import threading
import time
from dataclasses import fields, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import select, text

import dcdash.connectors  # noqa: F401  (registers the connector types)
from dcdash.connectors.base import connector_types
from dcdash.core import journal
from dcdash.core.audit import SENSITIVE_KEYS
from dcdash.core.config import Settings
from dcdash.core.db import get_sessionmaker
from dcdash.diagnostics import report
from dcdash.diagnostics.redact import Masker, finalize, scrub, verify_paste
from dcdash.diagnostics.report import (
    AuditEntry, CheckInfo, CheckStep, DnsLookup, Environment, Event, HistoryInfo, PointRow, PointsInfo, PolicyJob, ReportData,
    ScanInfo, SettingsInfo, SourceHealth, SourceInfo, StorageInfo, Unavailable, gather, load_known, mask_names, render,
)
from helpers import make_asset, make_mapping, make_point, make_source

NOW = datetime(2026, 10, 12, 10, 0, 0, tzinfo=timezone.utc)
STEP_IDS = ("dns", "tcp", "endpoints", "certificates", "session", "server_time", "namespaces", "read_points", "timing")
SESSION_FAILURE = "LATEST CHECK: source 3 \"Main SCADA\" FAILED at session: BadUserAccessDenied (0x801F0000)"


REAL_RESOLVE = report._resolve


@pytest.fixture(autouse=True)
def no_real_dns(monkeypatch):
    """A report of a database with named sources must never ask the real resolver (a dead one costs 3 s per report)."""

    async def refuse(host: str) -> list[str]:
        raise socket.gaierror(-2, "Name or service not known")

    monkeypatch.setattr(report, "_resolve", refuse)


def ident(value: str) -> str:
    return value


def source(i=3, name="Main SCADA", **kw) -> SourceInfo:
    base = dict(
        id=i, name=name, connector_type="opcua", enabled=True, status="online", last_seen=NOW,
        config=(("endpoint", "opc.tcp://plc.example:4840/x"), ("security_policy", "none")), authentication="none", has_secret=False,
    )
    return SourceInfo(**{**base, **kw})


def check(source_id=3, job_id=17, fail_at: str | None = "session", **kw) -> CheckInfo:
    steps: list[CheckStep] = []
    cut = STEP_IDS.index(fail_at) if fail_at else len(STEP_IDS)
    for step_id in STEP_IDS[:cut]:
        steps.append(CheckStep(id=step_id, ok=True, ms=12.0, summary=f"{step_id} fine"))
    if fail_at:
        steps.append(
            CheckStep(
                id=fail_at, ok=False, ms=450.0, summary="session refused", error_class="UaStatusCodeError",
                status_name="BadUserAccessDenied", status_hex="0x801F0000", error_message="User does not have permission",
                hint="Wrong account or no right to read: ask the SCADA team",
            )
        )
        steps.extend(CheckStep(id=step_id, ok=None) for step_id in STEP_IDS[cut + 1:])
    base = dict(
        source_id=source_id, job_id=job_id, job_status="done", created_at=NOW, finished_at=NOW, connector_type="opcua", finished=True,
        ok=fail_at is None, first_failed=fail_at, steps=tuple(steps),
    )
    return CheckInfo(**{**base, **kw})


def event(i=0, *, message=None, source_id=3, level="warning", kind="source.offline", code="timeout", minutes=0, **kw) -> Event:
    return Event(
        ts=NOW - timedelta(minutes=minutes), level=level, component="collector", source_id=source_id, kind=kind, code=code,
        message=message or f"event number {i}", **kw,
    )


def lines_of(body: str, title: str) -> list[str]:
    """The lines of one section, without its header."""
    out, inside = [], False
    for line in body.split("\n"):
        if line.startswith("== "):
            inside = line == f"== {title} =="
        elif inside:
            out.append(line)
    return out


# --- layout, verdict ---------------------------------------------------------------------------------------------------------


def test_the_sections_come_in_the_pinned_order_and_the_verdict_comes_first():
    body = render(ReportData(generated_at=NOW), "summary", ident)
    assert [line[3:-3] for line in body.split("\n") if line.startswith("== ")] == list(report.SECTION_TITLES)
    assert body.split("\n")[0] == "LATEST CHECK: no connection check has been run"


@pytest.mark.parametrize(
    ("checks", "sources", "expected"),
    [
        ((check(),), (source(),), SESSION_FAILURE),
        ((check(fail_at=None),), (source(),), 'LATEST CHECK: source 3 "Main SCADA" all steps OK'),
        ((check(fail_at="tcp", steps=(CheckStep("dns", True, ms=3.0), CheckStep("tcp", False, error_class="ConnectionRefusedError", error_message="[Errno 111] refused"))),),
         (source(),), 'LATEST CHECK: source 3 "Main SCADA" FAILED at tcp: ConnectionRefusedError: [Errno 111] refused'),
        ((check(job_status="running", finished=False, ok=None, fail_at=None, steps=(CheckStep("dns", True, ms=3.0),)),),
         (source(),), 'LATEST CHECK: source 3 "Main SCADA" is still running (at step dns)'),
        ((check(job_status="pending", finished=False, ok=None, fail_at=None, steps=()),), (source(),),
         'LATEST CHECK: source 3 "Main SCADA" is queued'),
        ((check(job_status="failed", finished=False, ok=None, fail_at=None, steps=(), error="collector restarted"),), (source(),),
         'LATEST CHECK: source 3 "Main SCADA" check job failed: collector restarted'),
        ((check(),), (), 'LATEST CHECK: source 3 (deleted) FAILED at session: BadUserAccessDenied (0x801F0000)'),
    ],
)
def test_the_verdict_line_says_which_step_failed_and_how(checks, sources, expected):
    body = render(ReportData(generated_at=NOW, checks=checks, sources=sources), "summary", ident)
    assert body.split("\n")[0] == expected


def test_a_check_that_failed_on_another_source_is_not_hidden_by_a_newer_ok_one():
    newer = check(source_id=4, job_id=20, fail_at=None, finished_at=NOW + timedelta(minutes=5))
    data = ReportData(generated_at=NOW, checks=(check(), newer), sources=(source(), source(4, "Spare")))
    first, second = render(data, "summary", ident).split("\n")[:2]
    assert first == 'LATEST CHECK: source 4 "Spare" all steps OK'
    assert second == 'ALSO FAILED: source 3 "Main SCADA" FAILED at session: BadUserAccessDenied (0x801F0000)'


def test_the_connection_checks_section_shows_the_failing_step_with_its_error_and_hint_and_the_skipped_ones():
    data = ReportData(generated_at=NOW, checks=(check(),), sources=(source(),))
    section = "\n".join(lines_of(render(data, "summary", ident), "CONNECTION CHECKS"))
    assert "ok: dns 12 ms, tcp 12 ms, endpoints 12 ms, certificates 12 ms" in section
    ok_section = "\n".join(lines_of(render(replace(data, checks=(check(fail_at=None),)), "summary", ident), "CONNECTION CHECKS"))
    assert "all steps OK" in ok_section and "ok: dns" not in ok_section  # an all-OK check needs no list of its steps
    assert "5 session FAIL 450 ms: session refused" in section
    assert "error: UaStatusCodeError: BadUserAccessDenied (0x801F0000): User does not have permission" in section
    assert "hint: Wrong account or no right to read: ask the SCADA team" in section
    assert "skipped: server_time, namespaces, read_points, timing" in section
    full = "\n".join(lines_of(render(data, "full", ident), "CONNECTION CHECKS"))
    assert "9 timing skipped" in full and "1 dns ok 12 ms: dns fine" in full


def test_an_ok_check_keeps_the_steps_that_carry_news_in_a_summary():
    steps = tuple(
        CheckStep(id=i, ok=True, ms=5.0, summary="2 of 20 points are bad" if i == "read_points" else "")
        for i in STEP_IDS
    )
    data = ReportData(generated_at=NOW, checks=(check(fail_at=None, steps=steps),), sources=(source(),))
    assert "   read_points: 2 of 20 points are bad" in lines_of(render(data, "summary", ident), "CONNECTION CHECKS")


THUMBPRINT = "9F2C41D7A0B3E85C6D1F4A27B9C03E5D8A16F7B4"
CERTIFICATES_SUMMARY = (
    f"our certificate dcdash-client, SHA-1 thumbprint {THUMBPRINT}, URI urn:dcdash:collector, valid until 2027-10-12 (364 days); "
    "server certificate dcdash-simulator, valid until 2031-10-12 (1826 days), names scada-gw.plant.local"
)
ENDPOINTS_SUMMARY = (
    "3 endpoint(s); configured Basic256Sha256/SignAndEncrypt with user name and password is offered. Offered: None/None [Anonymous]; "
    "Basic256Sha256/SignAndEncrypt [UserName]; Basic256Sha256/Sign [UserName]"
)


def refused_session_check(**kw) -> CheckInfo:
    """A check that passed endpoints and certificates (with the summaries a real run has) and failed at the session."""
    base = check()
    steps = tuple(
        replace(step, summary={"certificates": CERTIFICATES_SUMMARY, "endpoints": ENDPOINTS_SUMMARY}.get(step.id, step.summary))
        if step.id in ("certificates", "endpoints") else (
            replace(step, status_name="BadSecurityChecksFailed", status_hex="0x80130000",
                    hint="The server refused the secure channel; ask the SCADA team to trust the thumbprint shown in the certificates step.")
            if step.id == "session" else step)
        for step in base.steps
    )
    return replace(base, steps=steps, **kw)


def test_a_failed_session_brings_the_certificates_and_endpoints_lines_the_hints_refer_to():
    data = ReportData(generated_at=NOW, checks=(refused_session_check(),), sources=(source(),))
    section = lines_of(render(data, "summary", ident), "CONNECTION CHECKS")
    assert f"   certificates: {CERTIFICATES_SUMMARY}" in section  # the whole line, thumbprint and the server certificate part
    assert f"   endpoints: {ENDPOINTS_SUMMARY}" in section and "[UserName]" in section[section.index(f"   endpoints: {ENDPOINTS_SUMMARY}")]
    assert section.index(f"   certificates: {CERTIFICATES_SUMMARY}") > next(i for i, line in enumerate(section) if "5 session FAIL" in line)
    long = replace(data, checks=(refused_session_check(),))
    long_steps = tuple(replace(s, summary=s.summary + " and more " * 60) if s.id == "certificates" else s for s in long.checks[0].steps)
    clipped = lines_of(render(replace(long, checks=(replace(long.checks[0], steps=long_steps),)), "summary", ident), "CONNECTION CHECKS")
    line = next(line for line in clipped if line.startswith("   certificates:"))
    assert len(line) == 300 and THUMBPRINT in line  # a 600-character summary is cut at the line limit, after the thumbprint
    others = replace(data, checks=(check(fail_at="tcp", steps=(CheckStep("dns", True, ms=3.0, summary="dns fine"),
                                                           CheckStep("tcp", False, error_class="ConnectionRefusedError"))),))
    assert not any(line.startswith(("   certificates:", "   endpoints:")) for line in lines_of(render(others, "summary", ident), "CONNECTION CHECKS"))
    ok = replace(data, checks=(check(fail_at=None),))
    assert not any(line.startswith(("   certificates:", "   endpoints:")) for line in lines_of(render(ok, "summary", ident), "CONNECTION CHECKS"))
    failed_later = replace(data, checks=(check(fail_at="read_points"),))
    assert not any(line.startswith(("   certificates:", "   endpoints:")) for line in lines_of(render(failed_later, "summary", ident), "CONNECTION CHECKS"))


def test_a_failed_endpoints_step_is_not_printed_twice_when_the_session_fails_too():
    steps = tuple(
        CheckStep(id=i, ok=True, ms=1.0, summary=f"{i} fine") for i in ("dns", "tcp")
    ) + (
        CheckStep("endpoints", False, ms=5.0, summary="not offered", error_class="ConfigMismatch", hint="ask"),
        CheckStep("certificates", True, ms=5.0, summary=CERTIFICATES_SUMMARY),
        CheckStep("session", False, ms=9.0, summary="", error_class="UaError", error_message="No matching endpoints"),
    ) + tuple(CheckStep(id=i, ok=None) for i in STEP_IDS[5:])
    data = ReportData(generated_at=NOW, checks=(check(fail_at="endpoints", steps=steps),), sources=(source(),))
    section = lines_of(render(data, "summary", ident), "CONNECTION CHECKS")
    assert sum(1 for line in section if line.startswith("   3 endpoints FAIL")) == 1 and "   endpoints: not offered" not in section
    assert f"   certificates: {CERTIFICATES_SUMMARY}" in section


def test_the_session_context_lines_fit_one_part_in_a_busy_report_and_keep_the_whole_thumbprint():
    base = busy(40, 500, failing=33)
    checks = tuple(c for c in base.checks if c.source_id != 33) + (refused_session_check(source_id=33, job_id=200),)
    body = render(replace(base, checks=checks), "summary", ident)
    parts = finalize(body, "abc1234-dirty", NOW)
    assert len(parts.parts) == 1 and len(parts.parts[0].text) <= 12_000 and verify_paste(parts.text()).ok
    section = lines_of(body, "CONNECTION CHECKS")
    assert any(THUMBPRINT in line and line.startswith("   certificates:") for line in section)
    assert any("[UserName]" in line and line.startswith("   endpoints:") for line in section)
    assert all(len(line) <= 300 for line in section)


def test_a_passed_read_points_step_still_shows_the_hint_about_the_bad_points():
    hint = "The SCADA server answers, but the device behind it reports a fault. Ask the SCADA team which device or signal this is."
    steps = tuple(
        CheckStep(id=i, ok=True, ms=5.0, summary="read 5 point(s): 4 good, 1 bad; first bad: ns=2;i=2: BadSensorFailure (0x808C0000)"
                  if i == "read_points" else "", hint=hint if i == "read_points" else None)
        for i in STEP_IDS
    )
    data = ReportData(generated_at=NOW, checks=(check(fail_at=None, steps=steps),), sources=(source(),))
    for detail in ("summary", "full"):
        section = lines_of(render(data, detail, ident), "CONNECTION CHECKS")
        shown = next(i for i, line in enumerate(section) if "BadSensorFailure (0x808C0000)" in line)
        assert section[shown + 1] == f"      hint: {hint}", detail
        assert sum(1 for line in section if "hint:" in line) == 1  # no other passed step grows a hint line


def test_sources_without_a_check_are_listed_by_id_and_a_filtered_report_does_not_say_so():
    data = ReportData(generated_at=NOW, checks=(check(),), sources=(source(), source(4, "Spare"), source(5, "Third")))
    assert "no connection check has been run for 2 other sources: 4, 5" in lines_of(render(data, "summary", ident), "CONNECTION CHECKS")
    filtered = replace(data, source_id=3)
    assert not any("other sources" in line for line in lines_of(render(filtered, "summary", ident), "CONNECTION CHECKS"))


# --- environment and the clock witness (M1) ----------------------------------------------------------------------------------


def env(**kw) -> Environment:
    base = dict(
        build_id="abc1234", build_time="2026-10-11T20:00:00+03:00", uptime_seconds=3 * 3600 + 120, collector_build_id="abc1234",
        collector_age_seconds=4.0, python="3.12.3", system="Linux x86_64 microsoft-standard-WSL2", asyncua="1.1.8", pymodbus="3.8.6",
        postgres="16.4", timescale="2.30.2", site_timezone="Asia/Qatar", container_time=NOW, database_time=NOW + timedelta(seconds=0.2),
    )
    return Environment(**{**base, **kw})


def environment_lines(**kw) -> str:
    return "\n".join(lines_of(render(ReportData(generated_at=NOW, environment=env(**kw)), "summary", ident), "ENVIRONMENT"))


def test_the_environment_lists_builds_runtime_and_database_versions():
    out = environment_lines()
    assert "generated: 2026-10-12T10:00:00Z, site time 2026-10-12 13:00:00 +03 (Asia/Qatar)" in out
    assert "api: build abc1234 (built 2026-10-11T17:00:00Z), up 3 h 2 min" in out  # the commit time is printed in UTC
    assert "collector: build abc1234, last heartbeat 4 s ago" in out
    assert "build check: OK" in out
    assert "runtime: Python 3.12.3, Linux x86_64 microsoft-standard-WSL2, asyncua 1.1.8, pymodbus 3.8.6" in out
    assert "database: PostgreSQL 16.4, TimescaleDB 2.30.2" in out


def test_a_collector_on_another_build_is_flagged_and_a_silent_one_is_called_stale():
    assert "build check: MISMATCH api abc1234 vs collector def5678" in environment_lines(collector_build_id="def5678")
    assert "build check: unknown" in environment_lines(collector_build_id=None)
    assert "(STALE: the collector is not running)" in environment_lines(collector_age_seconds=95.0)
    assert "no heartbeat on record" in environment_lines(collector_age_seconds=None, collector_build_id=None)


def test_browser_clock_far_from_the_container_clock_points_at_the_local_vm_and_a_small_difference_does_not():
    far = environment_lines(client_time=NOW + timedelta(seconds=95))
    assert "clock: browser minus container = +95.0 s" in far
    assert "a local VM clock problem (Docker/WSL2 clock drift), not the SCADA" in far
    near = environment_lines(client_time=NOW - timedelta(seconds=4))
    assert "clock: browser minus container = -4.0 s" in near
    assert "local VM clock problem" not in near
    assert "browser time not supplied" in environment_lines(client_time=None)


def test_the_database_clock_line_stays_and_never_carries_the_vm_sentence():
    out = environment_lines(database_time=NOW + timedelta(seconds=400))
    assert "clock: database minus container = +400.0 s (both run on one VM clock, so this cannot show drift)" in out
    assert "local VM clock problem" not in out


def test_the_last_server_time_seen_in_a_check_is_printed_with_its_skew():
    checked = check(fail_at=None, server_time="2026-10-12T09:59:58Z", local_time="2026-10-12T10:00:00Z", skew_seconds=-2.0)
    out = "\n".join(lines_of(render(ReportData(generated_at=NOW, environment=env(), checks=(checked,)), "summary", ident), "ENVIRONMENT"))
    assert "clock: last server time seen 2026-10-12T09:59:58Z (source 3, check job 17), skew -2.0 s against the container clock" in out


def test_the_kernel_version_is_not_printed_because_it_looks_like_an_address():
    assert re.search(r"\d+\.\d+\.\d+\.\d+", report._system()) is None


# --- config allow-list (M6) --------------------------------------------------------------------------------------------------


def test_every_registered_connector_field_is_shown_or_explicitly_excluded_and_nothing_else_is_listed():
    # Built-in connectors only: other test files register throwaway connectors (test_connector_base.py's "echo-test").
    types = {name: cls for name, cls in connector_types().items() if cls.__module__.startswith("dcdash.")}
    assert set(types) <= set(report.REPORT_CONFIG_FIELDS), "a new connector type needs an entry in REPORT_CONFIG_FIELDS"
    for name, connector in types.items():
        schema = set(connector.config_schema.model_fields)
        shown, excluded = set(report.REPORT_CONFIG_FIELDS[name]), set(report.EXCLUDED_CONFIG_FIELDS.get(name, ()))
        assert schema <= shown | excluded, f"{name}: fields in neither list: {sorted(schema - shown - excluded)}"
        assert shown <= schema, f"{name}: listed but not in the schema: {sorted(shown - schema)}"
        assert not shown & excluded
        assert not any(SENSITIVE_KEYS.search(field) for field in shown), "a credential-named field must never be shown"
    assert set(report.AUTH_FIELDS) <= set(types) and all(
        field in types[name].config_schema.model_fields for name, field in report.AUTH_FIELDS.items()
    )


def test_every_settings_field_is_reported_or_explicitly_excluded():
    declared = set(Settings.model_fields)
    shown, excluded = set(report.REPORT_ENV_FIELDS), set(report.EXCLUDED_ENV_FIELDS)
    assert declared == shown | excluded and not shown & excluded
    assert {"database_url", "secret_key"} <= excluded


def test_report_config_drops_credentials_the_user_name_and_unlisted_fields():
    config = {
        "endpoint": "opc.tcp://opcuser:Zq9-urlpw@10.1.2.3:4840/x", "security_policy": "basic256sha256", "username": "opcuser",
        "client_key": "/certs/key.pem", "client_cert": "/certs/cert.pem", "password": "Zq9-conf-pw", "timeout_seconds": 5.0, "extra": {"a": 1},
    }
    shown = dict(report.report_config("opcua", config))
    assert shown == {
        "endpoint": "opc.tcp://10.1.2.3:4840/x", "security_policy": "basic256sha256", "client_cert": "/certs/cert.pem",
        "timeout_seconds": "5.0",
    }
    assert "Zq9-urlpw" not in str(shown) and "opcuser" not in str(shown) and "Zq9-conf-pw" not in str(shown)
    assert report.report_config("a_future_type", config) == ()
    assert report._authentication("opcua", config) == "username/password"
    assert report._authentication("opcua", {"username": ""}) == "none"
    assert report._authentication("modbus", {"username": "x"}) is None


# --- transform before clip (M4) and the shape of values ---------------------------------------------------------------------


def one_event(message: str, **kw) -> ReportData:
    return ReportData(generated_at=NOW, journal=(event(message=message, **kw),))


def test_a_secret_that_straddles_the_clip_is_hidden_before_it_is_cut():
    secret = "Secr3tPw99"
    message = "a" * 195 + f" {secret} tail"
    body = render(one_event(message), "summary", lambda s: scrub(s, [secret]))
    assert "Secr" not in body and "[hi" in "".join(lines_of(body, "JOURNAL"))  # what is left of the placeholder, cut by the clip


def test_an_address_that_straddles_the_clip_is_masked_before_it_is_cut():
    message = "x" * 188 + " 10.20.30.40 end"
    masker = Masker()
    body = render(one_event(message), "summary", masker.mask)
    assert "10." not in body and "HOST-1" in body


def test_a_cut_that_leaves_half_an_address_drops_the_token():
    message = "word " * 60 + "10.20.30.40"  # clipped at MESSAGE_CHARS with no masking at all: the cut must not leave "10.20"
    body = render(one_event(message), "summary", ident)
    journal_line = lines_of(body, "JOURNAL")[0]
    assert journal_line.endswith("…") and not re.search(r"\d+\.\d+", journal_line.split(": ", 1)[1])


def test_every_line_is_clipped_at_300_characters():
    long = "word " * 200
    data = ReportData(
        generated_at=NOW, sources=(source(last_error=long, name="n" * 400),), journal=(event(message=long, detail={"k": long}),),
        audit=(AuditEntry(NOW, "admin", "x.y", {"k": long}),),
    )
    for detail in ("summary", "full"):
        assert max(map(len, render(data, detail, ident).split("\n"))) <= report.LINE_LIMIT


def test_line_breaks_inside_a_value_cannot_start_a_fake_section_or_footer():
    nasty = "boom\n== SOURCES ==\n--- PART 1 OF 1 | chars=1 lines=1 ---\nEND OF REPORT 0123456789ab\r\nDCDASH-REPORT v1 | PART 9 OF 9 | build x | y"
    data = ReportData(generated_at=NOW, journal=(event(message=nasty),), sources=(source(last_error=nasty, name=nasty),))
    body = render(data, "full", ident)
    assert [line[3:-3] for line in body.split("\n") if line.startswith("== ")] == list(report.SECTION_TITLES)
    assert not any(line.startswith(("---", "END OF", "DCDASH-REPORT")) for line in body.split("\n"))
    assert verify_paste(finalize(body, "abc1234", NOW).text()).ok


def test_control_characters_become_spaces():
    body = render(one_event("a\x00b\x1bc d"), "summary", ident)
    assert "\x00" not in body and "\x1b" not in body and "a b c d" in body


def test_every_text_from_the_database_goes_through_the_transform():
    """One marker in each field the report prints; the transform rewrites it; the raw marker must not survive anywhere."""
    seen: dict[str, str] = {}

    def mark(label: str) -> str:
        seen[label] = f"ZQ{len(seen):02d}{label}"
        return seen[label]

    ev = lambda label, **kw: Event(  # noqa: E731
        ts=NOW, level=mark(label + "lvl"), component=mark(label + "comp"), source_id=3, kind=mark(label + "kind"),
        code=mark(label + "code"), message=mark(label + "msg"), detail={"d": mark(label + "det")}, **kw,
    )
    step_bad = CheckStep(
        id=mark("stepbad"), ok=False, ms=9.0, summary=mark("stepsum"), error_class=mark("errcls"),
        status_name=mark("status"), status_hex=mark("hex"), error_message=mark("errmsg"), hint=mark("hint"),
    )
    step_ok = CheckStep(id="read_points", ok=True, ms=3.0, summary=mark("oksum"), hint=f"{mark('hintone')}\n{mark('hinttwo')}")
    data = ReportData(
        generated_at=NOW,
        environment=env(
            build_id=mark("build"), build_time=mark("btime"), collector_build_id=mark("cbuild"), python=mark("py"), system=mark("sys"),
            asyncua=mark("ua"), pymodbus=mark("pm"), postgres=mark("pg"), timescale=mark("ts"), dns_servers=(mark("dns"),),
        ),
        settings=SettingsInfo(((mark("setkey"), mark("setval")),)),
        sources=(source(name=mark("name"), connector_type=mark("ctype"), status=mark("status2"), last_error=mark("lasterr"),
                        config=((mark("cfgkey"), mark("cfgval")),)),),
        points=PointsInfo(
            counts=(("bad", 1),), worst=(PointRow(3, mark("addr"), mark("pname"), "bad", NOW, None, 1, 5.0),),
        ),
        checks=(
            check(fail_at=None, connector_type=mark("cktype"), steps=(step_bad, step_ok), server_time=mark("srvtime"),
                  local_time=mark("loctime"), skew_seconds=1.0, ok=False, first_failed=step_bad.id),
        ),
        journal=(ev("j"),),
        scans=(ScanInfo(1, mark("scanstatus"), mark("scanstage"), NOW, NOW, (("hosts", 3),), ((mark("outcome"), 2),), mark("scanerr")),),
        storage=StorageInfo(jobs=(PolicyJob(mark("proc"), mark("hyper"), True, mark("jobstatus"), NOW, NOW, 0),)),
        audit=(
            AuditEntry(NOW, mark("actor"), mark("action"), {"k": mark("auditdet")}),
            AuditEntry(NOW, "admin", "source.updated", {
                "source_id": 3, "name": mark("audname"),
                "before": {"name": mark("audbeforename"), "config": {"endpoint": mark("audbeforeurl"), "security_policy": "none"}},
                "after": {"name": mark("audaftername"), "config": {"endpoint": mark("audafterurl"), "security_policy": "none"}},
            }),
            AuditEntry(NOW, "admin", "source.created", {
                "source_id": 4, "name": mark("audcreated"), "connector_type": mark("audtype"),
                "config": {"endpoint": mark("audcreatedurl"), "security_policy": mark("audpolicy")},
            }),
        ),
        api_errors=(ev("api"),),
    )
    for detail in ("summary", "full"):
        body = render(data, detail, lambda s: s.replace("ZQ", "ok"))
        assert "ZQ" not in body, [m for m in seen if seen[m] in body]
    body = render(data, "full", lambda s: s.replace("ZQ", "ok"))
    absent = [label for label, token in seen.items() if token.replace("ZQ", "ok") not in body]
    assert not absent, f"printed nowhere (and so untested): {absent}"


# --- sizes (M7) -------------------------------------------------------------------------------------------------------------


def busy(n_sources=40, n_events=500, failing=33, error="OPC UA session failed: " + "something went wrong " * 8) -> ReportData:
    sources = tuple(
        source(
            i, f"Plant {i}", status="offline" if i % 3 == 0 else "online", has_secret=True, authentication="username/password",
            last_error=error,
            config=(("endpoint", f"opc.tcp://10.0.{i % 250}.5:4840"), ("security_policy", "basic256sha256"),
                    ("root_node", "i=85"), ("timeout_seconds", "5.0"), ("client_cert", "/certs/opcua-client.pem")),
        )
        for i in range(1, n_sources + 1)
    )
    events = tuple(
        event(i, source_id=1 + i % n_sources, minutes=i, message=f"connection {i} failed: " + "reason " * 10, code=f"code{i % 7}",
              detail={"failures": i, "interval": 5})
        for i in range(n_events)
    )
    checks = tuple(check(i, 100 + i, fail_at=None) for i in range(1, 6)) + (check(failing, 200, finished_at=NOW + timedelta(minutes=3)),)
    return ReportData(
        generated_at=NOW, environment=env(), settings=SettingsInfo((("general.timezone", "Asia/Qatar"),)), sources=sources,
        health=tuple(SourceHealth(i, 120, 3, 2.0) for i in range(1, n_sources + 1)),
        points=PointsInfo(
            counts=(("good", 900), ("bad", 60)),
            worst=tuple(PointRow(1 + i % n_sources, f"ns=2;s=Plant.Point{i}", f"Point {i}", "bad", NOW, None, 1, 10.0) for i in range(30)),
        ),
        checks=checks, journal=events,
        scans=tuple(ScanInfo(i, "done", None, NOW, NOW, (("hosts", 20),)) for i in range(1, 6)),
        audit=tuple(AuditEntry(NOW - timedelta(minutes=i), "admin", "source.updated", {"source_id": i, "name": "x" * 40}) for i in range(20)),
        api_errors=tuple(event(i, source_id=None, kind="http.5xx", code="500", message=f"GET /api/x{i}: ValueError") for i in range(20)),
    )


def test_a_summary_with_40_sources_and_500_events_keeps_every_source_and_names_the_failing_step_in_one_part():
    body = render(busy(40, 500, failing=33), "summary", ident)
    parts = finalize(body, "abc1234-dirty", NOW)
    assert len(parts.parts) == 1 and len(parts.parts[0].text) <= 12_000
    assert len([line for line in lines_of(body, "SOURCES") if line.startswith("#")]) == 40  # M7: never truncated
    assert "more sources omitted" not in body  # nor the checks of any (the health lines of healthy sources may go)
    assert body.split("\n")[0] == 'LATEST CHECK: source 33 "Plant 33" FAILED at session: BadUserAccessDenied (0x801F0000)'
    assert "      hint: Wrong account or no right to read: ask the SCADA team" in body
    assert any(line.startswith('#33 "Plant 33"') for line in lines_of(body, "SOURCE HEALTH"))  # a source with a problem keeps its health
    assert verify_paste(parts.text()).ok


def test_with_200_sources_the_healthy_ones_are_dropped_and_the_failing_step_survives():
    body = render(busy(200, 500, failing=133), "summary", ident)
    parts = finalize(body, "abc1234-dirty", NOW)
    assert len(parts.parts) == 1
    assert body.split("\n")[0].startswith('LATEST CHECK: source 133 "Plant 133" FAILED at session: BadUserAccessDenied')
    assert "      hint: Wrong account or no right to read: ask the SCADA team" in body
    assert any(line.startswith("... ") and "more sources omitted" in line for line in lines_of(body, "SOURCES"))
    assert verify_paste(parts.text()).ok


def test_the_summary_source_line_is_short_and_the_full_one_has_the_whole_config():
    data = ReportData(generated_at=NOW, sources=(source(config=(("endpoint", "opc.tcp://h.example:4840"), ("security_policy", "none"), ("root_node", "i=85"),
                                                              ("timeout_seconds", "5.0"), ("client_cert", "/certs/c.pem"))),))
    (short,) = lines_of(render(data, "summary", ident), "SOURCES")
    assert "endpoint=opc.tcp://h.example:4840 security_policy=none" in short and "root_node" not in short and "last_seen" not in short
    full = "\n".join(lines_of(render(data, "full", ident), "SOURCES"))
    assert "root_node=i=85 timeout_seconds=5.0 client_cert=/certs/c.pem" in full and "last_seen=2026-10-12T10:00:00Z" in full


def test_a_summary_shows_the_last_error_only_of_a_source_that_is_not_online():
    sources = (source(3, status="online", last_error="old news"), source(4, "Down", status="offline", last_error="refused"))
    body = render(ReportData(generated_at=NOW, sources=sources), "summary", ident)
    assert "   last error: refused" in body and "old news" not in body
    assert "old news" in render(ReportData(generated_at=NOW, sources=sources), "full", ident)


def test_the_journal_tail_is_trimmed_before_the_sources_are():
    body = render(busy(8, 100, error="session failed"), "summary", ident)
    assert len([line for line in lines_of(body, "SOURCES") if line.startswith("#")]) == 8
    journal_lines = lines_of(body, "JOURNAL")
    assert len(journal_lines) < report.CAPS["journal"][0] and journal_lines[-1].endswith("more lines omitted")


def test_caps_per_section_for_summary_and_full():
    data = ReportData(
        generated_at=NOW,
        journal=tuple(event(i, minutes=i) for i in range(500)),
        audit=tuple(AuditEntry(NOW - timedelta(minutes=i), "admin", "a.b") for i in range(60)),
        api_errors=tuple(event(i, source_id=None, kind="http.5xx", message=f"m{i}") for i in range(60)),
        scans=tuple(ScanInfo(i, "done") for i in range(10)),
    )
    summary, full = render(data, "summary", ident), render(data, "full", ident)
    for title, key in (("JOURNAL", "journal"), ("AUDIT TAIL", "audit"), ("API ERRORS", "api_errors"), ("SCANS", "scans")):
        for body, column in ((summary, 0), (full, 1)):
            got = lines_of(body, title)
            cap = report.CAPS[key][column]
            assert len(got) <= cap + 1, (title, len(got))
            assert len([line for line in got if not line.startswith("...")]) == min(cap, {"journal": 500, "audit": 60, "api_errors": 60, "scans": 10}[key])
    assert lines_of(summary, "JOURNAL")[-1] == "... 470 more lines omitted"


def test_distinct_errors_per_source_are_capped_three_in_a_summary_and_ten_in_full():
    events = tuple(event(i, source_id=3, minutes=i, message=f"distinct failure {i}") for i in range(30))
    data = ReportData(generated_at=NOW, sources=(source(),), health=(SourceHealth(3, 10, 0, 1.0),), journal=events)
    for detail, cap in (("summary", 3), ("full", 10)):
        health = lines_of(render(data, detail, ident), "SOURCE HEALTH")
        assert len([line for line in health if "distinct failure" in line]) == cap
        assert health[-1] == f"   ... {30 - cap} more distinct errors omitted"


def test_repeated_events_collapse_and_distinct_errors_count_first_and_last():
    events = tuple(event(minutes=i, message="same failure") for i in range(5)) + (event(minutes=9, message="other"),)
    data = ReportData(generated_at=NOW, sources=(source(),), health=(SourceHealth(3, 10, 0, 1.0),), journal=events)
    body = render(data, "summary", ident)
    journal_lines = lines_of(body, "JOURNAL")
    assert len(journal_lines) == 2 and "x5 since 2026-10-12T09:56:00Z" in journal_lines[0] and journal_lines[0].startswith("2026-10-12T10:00:00Z warning collector source.offline")
    assert any("x5 since 2026-10-12T09:56:00Z" in line and "same failure" in line for line in lines_of(body, "SOURCE HEALTH"))


def test_a_full_report_stays_under_its_budget_splits_into_parts_and_verifies():
    body = render(busy(40, 2000), "full", ident)
    assert len(body) <= report.FULL_BODY_CHARS
    parts = finalize(body, "abc1234", NOW)
    assert 2 <= len(parts.parts) <= 8 and all(len(p.text) <= 12_000 for p in parts.parts)
    assert verify_paste(parts.text()).ok


def test_the_hard_limit_always_holds():
    for limit in (400, 1500, 6000):
        body = render(busy(), "summary", ident, max_chars=limit)
        assert len(body) <= limit and body.split("\n")[0].startswith("LATEST CHECK: source 33")


def test_render_is_deterministic():
    data = busy()
    assert render(data, "summary", ident) == render(data, "summary", ident)
    assert render(data, "full", ident) == render(data, "full", ident)


def test_detail_must_be_summary_or_full():
    with pytest.raises(ValueError):
        render(ReportData(), "everything", ident)  # type: ignore[arg-type]


def test_a_storage_summary_names_only_the_policy_jobs_that_need_a_look():
    jobs = (
        PolicyJob("policy_retention", "readings", True, "Success", NOW, NOW, 0),
        PolicyJob("policy_retention", "readings_1m", False, None, None, None, None),
        PolicyJob("policy_compression", "readings", True, "Failed", NOW, NOW, 2),
    )
    data = ReportData(generated_at=NOW, storage=StorageInfo(jobs=jobs, journal_rows=3, journal_oldest=NOW))
    summary = lines_of(render(data, "summary", ident), "STORAGE AND RETENTION")
    assert "policy jobs: 3 in all, 2 not scheduled or failing" in summary and len([l for l in summary if l.startswith("policy policy_")]) == 2
    assert any("NOT SCHEDULED" in line for line in summary) and "journal: 3 events kept, oldest 2026-10-12T10:00:00Z" in summary
    assert len([l for l in lines_of(render(data, "full", ident), "STORAGE AND RETENTION") if l.startswith("policy policy_")]) == 3


def test_small_formatting_rules():
    assert report._iso(datetime(1, 1, 1, tzinfo=timezone.utc)) == "-"  # TimescaleDB's "never"
    assert report._days(1.8e6) == "over 10 years" and report._days(None) == "n/a" and report._days(12.5) == "12.5 days"
    assert report._signed(-0.04) == "+0.0 s" and report._signed(-95.26) == "-95.3 s"
    assert report._age(5) == "5 s" and report._age(600) == "10 min" and report._age(3 * 3600 + 120) == "3 h 2 min" and report._age(3 * 86400) == "3 d 0 h"


def test_the_report_says_whether_it_is_masked():
    assert "not masked" in render(ReportData(generated_at=NOW), "summary", ident)
    assert "masked (addresses and host names appear as HOST-n and URN-n)" in render(ReportData(generated_at=NOW), "summary", ident, masked=True)


def test_the_transform_runs_once_per_distinct_text_however_often_the_body_is_rebuilt():
    calls: dict[str, int] = {}

    def counting(value: str) -> str:
        calls[value] = calls.get(value, 0) + 1
        return value

    render(busy(40), "summary", counting)  # this one is trimmed several times
    assert calls and max(calls.values()) == 1


# --- unavailable sections ----------------------------------------------------------------------------------------------------


def test_an_unavailable_section_is_one_line_and_the_rest_of_the_report_is_unaffected():
    data = ReportData(generated_at=NOW, points=Unavailable("ProgrammingError (UndefinedTableError)"), checks=Unavailable("TimeoutError"))
    body = render(data, "summary", ident)
    assert lines_of(body, "POINTS") == ["section unavailable: ProgrammingError (UndefinedTableError)"]
    assert body.split("\n")[0] == "LATEST CHECK: unknown (the check results could not be read)"
    assert [line[3:-3] for line in body.split("\n") if line.startswith("== ")] == list(report.SECTION_TITLES)


def test_odd_data_in_one_section_becomes_a_line_not_an_exception():
    data = ReportData(generated_at=NOW, points=PointsInfo(counts=(("bad", "many"),)))  # type: ignore[arg-type]
    body = render(data, "summary", ident)
    assert lines_of(body, "POINTS") == ["section unavailable: render TypeError"]


@pytest.mark.parametrize("masked", [False, True])
@pytest.mark.parametrize("known, tail", [('pass"word1', "word1"), ("pässwort9", "sswort9"), ("back\\slash77", "slash77")])
def test_a_known_value_json_would_escape_is_hidden_in_a_journal_detail_and_an_audit_detail(known, tail, masked):
    data = ReportData(
        generated_at=NOW,
        journal=(event(message="login failed", detail={"error": f"rejected {known} for svc"}),),
        audit=(AuditEntry(NOW, "admin", "source.updated", {"note": f"changed to {known}"}),),
    )
    masker = Masker() if masked else None
    transform = (lambda value: masker.mask(scrub(value, [known]))) if masker else (lambda value: scrub(value, [known]))
    body = render(data, "summary", transform, masked=masked)
    assert tail not in body and known not in body, body
    assert "[hidden]" in "".join(lines_of(body, "JOURNAL")) and "[hidden]" in "".join(lines_of(body, "AUDIT TAIL"))


# --- masking -----------------------------------------------------------------------------------------------------------------


def test_mask_names_lists_source_hosts_and_the_names_the_checks_learned_in_a_stable_order():
    data = ReportData(
        sources=(source(5, config=(("endpoint", "opc.tcp://10.1.2.5:4840"),)), source(3, config=(("endpoint", "opc.tcp://plc.example:4840"), ("security_policy", "none"))),
                 source(4, connector_type="modbus", config=(("host", "10.1.2.4"), ("port", "502")))),
        checks=(check(5, fail_at=None, hosts=("SCADA-SRV", "10.1.2.5"), uris=("urn:SCADA-SRV:Vendor:Server",)), check(3, fail_at=None, hosts=("plc.example",))),
    )
    hosts, uris = mask_names(data)
    assert hosts == ["opc.tcp://plc.example:4840", "10.1.2.4", "opc.tcp://10.1.2.5:4840", "plc.example", "SCADA-SRV", "10.1.2.5"]
    assert uris == ["urn:SCADA-SRV:Vendor:Server"]
    assert mask_names(ReportData(sources=Unavailable("X"), checks=Unavailable("Y"))) == ([], [])


def test_mask_names_takes_the_hosts_of_all_sources_when_it_is_given_them():
    data = ReportData(sources=(source(5, config=(("endpoint", "opc.tcp://10.1.2.5:4840"),)),), checks=())
    hosts, _uris = mask_names(data, ["opc.tcp://scada01:4840", "10.1.2.5", "opc.tcp://scada01:4840", "  "])
    assert hosts == ["opc.tcp://scada01:4840", "10.1.2.5"]  # not the filtered list, no duplicates, no blanks


def test_a_masked_report_has_no_host_or_address_of_the_data_and_masking_again_changes_nothing():
    data = ReportData(
        generated_at=NOW,
        sources=(source(config=(("endpoint", "opc.tcp://plc.example:4840/x"), ("security_policy", "none")), last_error="no route to 10.9.8.7 (plc.example)"),),
        health=(SourceHealth(3, 5, 0, 1.0),),
        checks=(check(hosts=("SCADA-SRV",), uris=("urn:SCADA-SRV:Vendor:Server",)),),
        journal=(event(message="connect to opc.tcp://plc.example:4840/x failed, resolved 10.9.8.7, server SCADA-SRV urn:SCADA-SRV:Vendor:Server"),),
    )
    masker = Masker(*mask_names(data))
    body = render(data, "summary", lambda s: masker.mask(scrub(s)))
    for original in ("plc.example", "10.9.8.7", "SCADA-SRV"):
        assert original not in body, original
    assert "HOST-" in body and masker.mask(body) == body
    assert {entry["original"] for entry in masker.legend()} >= {"plc.example", "10.9.8.7"}


# --- gather (database) -------------------------------------------------------------------------------------------------------

PASSWORD, URL_PASSWORD, USER = "Zq9-secret-pw", "Zq9-url-pw", "opcuser"


@pytest.fixture
async def session(db):
    async with get_sessionmaker()() as s:
        yield s


async def seed(db) -> dict[str, int]:
    """Two sources, five points in every state, readings, three check jobs, journal, audit, a scan, a heartbeat."""
    a = await make_source(
        db, "Main SCADA", "opcua",
        {"endpoint": f"opc.tcp://{USER}:{URL_PASSWORD}@10.1.2.3:4840/x", "security_policy": "none", "username": USER,
         "client_key": "/certs/key.pem", "client_cert": "/certs/c.pem", "root_node": "i=85", "timeout_seconds": 5.0},
        secret=PASSWORD,
    )
    b = await make_source(db, "Spare", "simulator", {"url": "http://simulator:9000", "timeout_seconds": 5.0})
    asset = await make_asset(db, "Plant")
    points = [await make_point(db, a, f"ns=2;s=P{i}") for i in range(1, 6)]
    for point in points[:4]:  # the fifth is not mapped
        await make_mapping(db, point, asset, metric=f"m{point}", interval=5)
    await db.executemany(
        "INSERT INTO point_latest (point_id, ts, value, quality) VALUES ($1, now() - $2 * interval '1 second', 1.0, $3)",
        [(points[0], 1, 0), (points[1], 1, 1), (points[2], 3600, 0)],  # good, bad, stale; points[3] has none (no data)
    )
    await db.executemany(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, now() - $2 * interval '1 minute', 1.0, $3)",
        [(points[0], 1, 0), (points[0], 2, 0), (points[1], 3, 1), (points[1], 30, 0)],  # 3 within 10 minutes, 1 bad
    )
    failed = {
        "source_id": a, "connector_type": "opcua", "finished": True, "ok": False, "first_failed": "session",
        "steps": [
            {"id": "dns", "name": "DNS resolution", "ok": True, "ms": 12, "summary": "10.1.2.3", "error": None, "hint": None, "detail": {}},
            {"id": "session", "name": "Session", "ok": False, "ms": 450, "summary": "refused",
             "error": {"class": "UaStatusCodeError", "status_name": "BadUserAccessDenied", "status_hex": "0x801F0000", "message": "denied"},
             "hint": "check the account", "detail": {}},
            {"id": "server_time", "name": "Server time", "ok": None, "ms": None, "summary": "", "error": None, "hint": None, "detail": {}},
        ],
        "clock": {"server_time": None, "local_time": "2026-10-12T10:00:00Z", "skew_seconds": None},
        "names": {"hosts": ["SCADA-SRV"], "uris": ["urn:SCADA-SRV:V:S"]},
    }
    insert = "INSERT INTO jobs (kind, params, status, result, created_at, finished_at) VALUES ($1, $2, $3, $4, now() - $5 * interval '1 minute', now())"
    await db.execute(insert, "check_connection", {"source_id": a}, "done", {**failed, "ok": True, "first_failed": None, "steps": []}, 60)  # older
    await db.execute(insert, "check_connection", {"source_id": a}, "done", failed, 5)  # the latest
    await db.execute(insert, "check_connection", {"source_id": "not-a-number"}, "done", {}, 1)  # junk params must not break the section
    await db.execute(insert, "test_source", {"source_id": a}, "done", {"ok": True}, 1)  # another kind
    await db.executemany(
        "INSERT INTO diag_events (ts, level, component, source_id, kind, code, message) VALUES (now() - $1 * interval '1 minute', $2, $3, $4, $5, $6, $7)",
        [(10, "warning", "collector", a, "source.offline", "timeout", "read timed out"), (9, "warning", "collector", a, "source.offline", "timeout", "read timed out"),
         (8, "error", "api", None, "http.5xx", "500", "GET /api/x: ValueError"), (7, "info", "collector", b, "source.online", None, "up")],
    )
    admin = await db.fetchval("INSERT INTO users (username, password_hash, role_id) VALUES ('boss', 'HASH-of-a-password-9', 3) RETURNING id")
    await db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES ('SESSIONHASH-0123456789', $1, now() + interval '1 hour')", admin)
    await db.execute("INSERT INTO audit_log (user_id, action, detail) VALUES ($1, 'source.updated', '{\"source_id\": 1}')", admin)
    scan = await db.fetchval("INSERT INTO scans (scope_snapshot, status, progress) VALUES ('{}', 'done', '{\"hosts\": 12, \"open\": 3, \"junk\": 1}') RETURNING id")
    await db.execute("INSERT INTO scan_findings (scan_id, host, port, outcome) VALUES ($1, 'h', 4840, 'claimed'), ($1, 'h2', 502, 'needs_credentials')", scan)
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('collector_heartbeat', jsonb_build_object('at', now(), 'build_id', 'abc1234')) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )
    return {"a": a, "b": b}


async def test_gather_on_an_empty_database_gives_every_section(db, session):
    data = await gather(session, detail="summary")
    for f in fields(ReportData):
        assert not isinstance(getattr(data, f.name), Unavailable), (f.name, getattr(data, f.name))
    assert data.sources == () and data.checks == () and data.journal == () and data.audit == ()
    assert data.environment.postgres and data.environment.timescale and data.environment.collector_age_seconds is None
    assert data.storage.stats is not None and data.storage.journal_rows == 0
    assert dict(data.settings.values)["general.timezone"] and dict(data.settings.values)["sign_in.max_failures"] == "5"
    body = render(data, "summary", ident)
    assert "no sources configured" in body and "no connection check has been run" in body and verify_paste(finalize(body, "x", NOW).text()).ok


async def test_the_settings_block_says_whether_sign_in_protection_is_on(db, session):
    assert dict((await gather(session, detail="summary")).settings.values)["sign_in.enabled"] == "True"
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('sign_in', '{\"max_failures\": 5, \"block_minutes\": 5, \"enabled\": false}'::jsonb)"
    )
    assert dict((await gather(session, detail="summary")).settings.values)["sign_in.enabled"] == "False"
    await db.execute("UPDATE settings SET value = '{\"max_failures\": 5, \"block_minutes\": 5, \"enabled\": \"false\"}'::jsonb WHERE key = 'sign_in'")
    assert dict((await gather(session, detail="summary")).settings.values)["sign_in.enabled"] == "True"  # garbage means on


async def test_gather_reads_every_section_from_a_seeded_database(db, session):
    ids = await seed(db)
    data = await gather(session, detail="full", client_time=datetime.now(timezone.utc) + timedelta(seconds=90))
    for f in fields(ReportData):
        assert not isinstance(getattr(data, f.name), Unavailable), (f.name, getattr(data, f.name))
    main, spare = data.sources
    assert (main.id, main.name, main.connector_type, main.has_secret, main.authentication) == (ids["a"], "Main SCADA", "opcua", True, "username/password")
    assert dict(main.config) == {"endpoint": "opc.tcp://10.1.2.3:4840/x", "security_policy": "none", "root_node": "i=85", "timeout_seconds": "5.0", "client_cert": "/certs/c.pem"}
    assert (spare.has_secret, spare.authentication, dict(spare.config)["url"]) == (False, None, "http://simulator:9000")
    health = {h.source_id: h for h in data.health}
    assert (health[ids["a"]].reads, health[ids["a"]].bad) == (3, 1) and health[ids["a"]].newest_age_seconds is not None
    assert health[ids["b"]].reads == 0 and health[ids["b"]].newest_age_seconds is None
    assert dict(data.points.counts) == {"good": 1, "bad": 1, "stale": 1, "no data": 1, "unmapped": 1}
    assert [(p.state, p.address) for p in data.points.worst] == [("bad", "ns=2;s=P2"), ("stale", "ns=2;s=P3"), ("no data", "ns=2;s=P4")]
    (latest,) = data.checks  # one per source, the newest job, junk and other kinds ignored
    assert (latest.source_id, latest.state, latest.first_failed, latest.failed_step.status_hex) == (ids["a"], "failed", "session", "0x801F0000")
    assert latest.hosts == ("SCADA-SRV",) and latest.uris == ("urn:SCADA-SRV:V:S",) and len(latest.steps) == 3 and latest.steps[2].ok is None
    assert [e.message for e in data.journal] == ["up", "GET /api/x: ValueError", "read timed out", "read timed out"]
    assert [e.message for e in data.api_errors] == ["GET /api/x: ValueError"]
    assert (data.audit[0].action, data.audit[0].actor) == ("source.updated", "boss")
    (scan,) = data.scans
    assert scan.status == "done" and dict(scan.progress) == {"hosts": 12, "open": 3} and dict(scan.outcomes) == {"claimed": 1, "needs_credentials": 1}
    assert data.environment.collector_build_id == "abc1234" and 0 <= data.environment.collector_age_seconds < 30
    assert data.storage.stats.settings.raw_retention_days == 30 and data.storage.journal_rows == 4 and data.storage.jobs
    assert data.environment.client_time is not None


async def test_gathered_data_holds_no_secret_user_name_or_stored_token(db, session):
    await seed(db)
    stored = await db.fetchval("SELECT secret FROM sources WHERE name = 'Main SCADA'")
    data = await gather(session, detail="full")
    dumped = repr(data)
    for forbidden in (PASSWORD, URL_PASSWORD, USER, stored, "HASH-of-a-password-9", "SESSIONHASH-0123456789", "/certs/key.pem"):
        assert forbidden not in dumped, forbidden


async def test_the_source_filter_limits_the_per_source_sections_only(db, session):
    ids = await seed(db)
    data = await gather(session, detail="summary", source_id=ids["b"])
    assert [s.id for s in data.sources] == [ids["b"]] and [h.source_id for h in data.health] == [ids["b"]]
    assert data.checks == () and [e.message for e in data.journal] == ["up"]
    assert data.points.counts == () and len(data.audit) == 1 and len(data.api_errors) == 1
    missing = await gather(session, detail="summary", source_id=9999)
    assert missing.sources == () and "no source with id 9999" in render(missing, "summary", ident)


async def test_a_database_error_in_one_section_does_not_poison_the_session_or_the_other_sections(db, session, monkeypatch):
    await seed(db)

    async def broken(db_, *args):
        await db_.execute(text("SELECT * FROM a_table_that_does_not_exist"))

    monkeypatch.setattr(report, "_points", broken)
    data = await gather(session, detail="summary")
    assert data.points == Unavailable("ProgrammingError (UndefinedTableError)")
    assert len(data.sources) == 2 and len(data.checks) == 1 and len(data.journal) == 4 and not isinstance(data.storage, Unavailable)
    assert await session.scalar(select(1)) == 1  # the transaction is usable
    assert "section unavailable: ProgrammingError (UndefinedTableError)" in render(data, "summary", ident)


async def test_a_python_error_in_a_section_is_isolated_too(db, session, monkeypatch):
    async def boom(*args):
        raise RuntimeError("secret message: Zq9-secret-pw")

    monkeypatch.setattr(report, "_journal", boom)
    data = await gather(session, detail="summary")
    assert data.journal == Unavailable("RuntimeError") and not isinstance(data.sources, Unavailable)
    assert "Zq9-secret-pw" not in repr(data)  # the class name only, never the message


async def test_the_statement_timeout_is_set_once_for_all_sections_and_survives_a_rolled_back_section(db, session, monkeypatch):
    seen = []

    async def broken(db_, *args):
        await db_.execute(text("SELECT * FROM a_table_that_does_not_exist"))

    async def watch(db_, *args):
        seen.append(await db_.scalar(text("SHOW statement_timeout")))
        return ()

    monkeypatch.setattr(report, "_points", broken)
    monkeypatch.setattr(report, "_scans", watch)
    await gather(session, detail="summary")
    assert seen == ["5s"]


async def test_a_section_that_runs_too_long_is_cut_off_by_the_statement_timeout(db, session, monkeypatch):
    monkeypatch.setattr(report, "STATEMENT_TIMEOUT", "200ms")

    async def slow(db_, *args):
        await db_.execute(text("SELECT pg_sleep(5)"))

    monkeypatch.setattr(report, "_scans", slow)
    started = asyncio.get_running_loop().time()
    data = await gather(session, detail="summary")
    assert asyncio.get_running_loop().time() - started < 3
    assert isinstance(data.scans, Unavailable) and "QueryCanceledError" in data.scans.error
    assert not isinstance(data.audit, Unavailable)


async def test_gather_does_not_write_or_commit(db, session):
    await seed(db)
    before = await db.fetchval("SELECT count(*) FROM audit_log")
    await gather(session, detail="full")
    assert await db.fetchval("SELECT count(*) FROM audit_log") == before


async def test_a_client_time_without_an_offset_is_taken_as_utc(db, session):
    naive = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=120)
    data = await gather(session, detail="summary", client_time=naive)
    assert data.environment.client_time == naive.replace(tzinfo=timezone.utc)
    body = render(data, "summary", ident)
    assert "clock: browser minus container = +12" in body and "local VM clock problem" in body and "section unavailable" not in body


async def test_gather_refuses_an_unknown_detail(db, session):
    with pytest.raises(ValueError):
        await gather(session, detail="everything")  # type: ignore[arg-type]


async def test_the_whole_seeded_report_renders_scrubbed_framed_and_verifiable(db, session):
    ids = await seed(db)
    known = await load_known(session, database_url="postgresql://u:Db-Pass-Word-1@h/d")
    for value in (PASSWORD, f"{USER}:{URL_PASSWORD}", "HASH-of-a-password-9", "SESSIONHASH-0123456789", "Db-Pass-Word-1"):
        assert value in known, value
    data = await gather(session, detail="summary")
    masker = Masker(*mask_names(data))
    for masked in (False, True):
        body = render(data, "summary", (lambda s: masker.mask(scrub(s, known))) if masked else (lambda s: scrub(s, known)))
        assert body.split("\n")[0] == f'LATEST CHECK: source {ids["a"]} "Main SCADA" FAILED at session: BadUserAccessDenied (0x801F0000)'
        for forbidden in (PASSWORD, URL_PASSWORD, USER):
            assert forbidden not in body
        assert ("10.1.2.3" not in body) == masked
        assert verify_paste(finalize(body, "abc1234", data.generated_at).text()).ok


async def test_load_known_fails_closed(db, session):
    class Broken:
        async def execute(self, *args, **kwargs):
            raise RuntimeError("database gone")

        scalars = execute

    with pytest.raises(RuntimeError):
        await load_known(Broken())  # type: ignore[arg-type]


async def test_a_journal_row_written_by_the_writer_shows_up_in_a_report(db, session):
    pool = db
    assert await journal.record(pool, "collector", journal.SOURCE_OFFLINE, "link lost", level="warning", code="unreachable", detail={"failures": 3})
    data = await gather(session, detail="summary")
    line = lines_of(render(data, "summary", ident), "JOURNAL")[0]
    assert "warning collector source.offline code=unreachable: link lost" in line and '{"failures":3}' in line


async def test_a_figures_mismatch_event_of_the_figures_worker_shows_up_in_a_report(db, session):
    """The report lists every event of the journal (no allow-list of components or kinds): the figures worker's nightly self-check
    writes `figures` / `figures.mismatch` and a field report must show it."""
    message = "a stored figure differed from the live one and was deleted: month-days 2026-04: asset 12, day 2026-04-04"
    assert await journal.record(
        db, "figures", journal.FIGURES_MISMATCH, message, level="warning", code="month-days",
        detail={"kind": "month-days", "window": "2026-04"},
    )
    data = await gather(session, detail="summary")
    line = lines_of(render(data, "summary", ident), "JOURNAL")[0]
    assert f"warning figures figures.mismatch code=month-days: {message}" in line and '"window":"2026-04"' in line


@pytest.mark.parametrize("stamp, shown", [
    ("2026-10-11T20:00:00+03:00", "2026-10-11T17:00:00Z"),
    ("2026-10-11T17:00:00Z", "2026-10-11T17:00:00Z"),
    ("2026-10-11 20:00:00+0300", "2026-10-11T17:00:00Z"),  # git's own %ci spelling
    ("unknown", "unknown"),
    ("2026-10-11T20:00:00", "2026-10-11T20:00:00"),  # no offset: nothing to convert with
])
def test_the_build_time_is_printed_in_utc_when_it_can_be_read(stamp, shown):
    assert f"(built {shown})" in environment_lines(build_time=stamp)


# --- the audit tail names what a source edit changed (blind-read gap G1) -----------------------------------------------------------


def audit_update(before, after, **subject) -> AuditEntry:
    """A source.updated row the way the API writes it: only the changed top-level fields, config as a whole on both sides."""
    return AuditEntry(NOW, "admin", "source.updated", {"source_id": 3, "name": "SCADA main", "before": before, "after": after, **subject})


def audit_lines(*entries: AuditEntry, transform=ident, detail="summary", **kw) -> list[str]:
    return lines_of(render(ReportData(generated_at=NOW, audit=entries, **kw), detail, transform), "AUDIT TAIL")


CONFIG = {"endpoint": "opc.tcp://scada.plant.local:4840/", "security_policy": "none", "timeout_seconds": 5.0, "username": "svc"}


@pytest.mark.parametrize("detail", ["summary", "full"])
def test_a_security_policy_edit_shows_the_policy_pair_and_not_the_fields_that_stayed(detail):
    entry = audit_update({"config": CONFIG}, {"config": {**CONFIG, "security_policy": "basic256sha256"}})
    [line] = audit_lines(entry, detail=detail)
    assert "changed: config.security_policy none -> basic256sha256" in line
    assert "config.endpoint" not in line and "timeout_seconds" not in line and "source_id" in line and "SCADA main" in line


def test_a_password_edit_says_the_secret_changed_and_a_user_name_or_key_edit_never_shows_what_it_holds():
    password = audit_update({"secret": "set"}, {"secret": "changed"})
    login = audit_update({"config": CONFIG}, {"config": {**CONFIG, "username": "reader-two", "client_key": "/certs/k2.pem"}})
    removed = audit_update({"secret": "set"}, {"secret": "none"})
    first, second, third = audit_lines(password, login, removed)
    assert "changed: secret changed" in first and "->" not in first
    assert "config.username changed" in second and "config.client_key changed" in second
    assert "reader-two" not in second and "k2.pem" not in second and "svc" not in second
    assert "changed: secret changed" in third  # a removed secret is still a change of the secret, nothing else is said about it


def test_more_than_four_changed_fields_show_four_and_count_the_rest_in_a_line_that_fits():
    before = {"name": "A", "enabled": True, "config": {"endpoint": "opc.tcp://a.plant.local:4840", "security_policy": "none", "root_node": "i=85", "timeout_seconds": 5.0}}
    after = {"name": "B", "enabled": False, "config": {"endpoint": "opc.tcp://b.plant.local:4840", "security_policy": "basic256sha256", "root_node": "i=86", "timeout_seconds": 9.0}}
    [line] = audit_lines(audit_update(before, after))
    assert line.count(" -> ") == 4 and "(+2 more)" in line and len(line) <= 300
    assert "enabled true -> false" in "".join(audit_lines(audit_update({"enabled": True}, {"enabled": False})))


@pytest.mark.parametrize("detail", ["summary", "full"])
def test_a_created_source_is_summed_up_by_name_type_endpoint_and_policy_without_its_secret(detail):
    entry = AuditEntry(NOW, "admin", "source.created", {
        "source_id": 4, "connector_type": "opcua", "name": "SCADA main", "enabled": True, "config": CONFIG, "secret": "set",
    })
    [line] = audit_lines(entry, detail=detail)
    for part in ("created:", "name=SCADA main", "connector_type=opcua", "config.endpoint=opc.tcp://scada.plant.local:4840/", "config.security_policy=none"):
        assert part in line, line
    assert "svc" not in line and "secret" not in line and len(line) <= 300


def test_a_value_in_an_audit_pair_goes_through_the_known_values_and_the_mask_before_it_is_clipped():
    old, new = "opc.tcp://old-gw.plant.local:4840/", "opc.tcp://new-gw.plant.local:4840/"
    entries = (
        audit_update({"config": {"host": "plc-old-7"}, "name": "pw-xx12 line"}, {"config": {"host": "plc-new-8"}, "name": "pw-xx12 line two"}),
        audit_update({"config": {"endpoint": old}}, {"config": {"endpoint": new}}),
        AuditEntry(NOW, "admin", "source.created", {"source_id": 5, "name": "other", "config": {"endpoint": "opc.tcp://third.plant.local:4840/"}}),
    )
    data = ReportData(generated_at=NOW, audit=entries)
    masker = Masker(*mask_names(data))
    body = render(data, "summary", lambda value: masker.mask(scrub(value, ["pw-xx12"])), masked=True)
    audit = "\n".join(lines_of(body, "AUDIT TAIL"))
    for hidden in ("old-gw", "new-gw", "third.plant", "plc-old-7", "plc-new-8", "pw-xx12"):
        assert hidden not in audit, (hidden, audit)
    assert "HOST-" in audit and "[hidden]" in audit
    # the old host belongs to no source any more, yet it is listed for the masker
    assert "opc.tcp://old-gw.plant.local:4840/" in mask_names(data)[0]


# --- a passed check with bad points, and several bad statuses (blind-read gap G2) ------------------------------------------------


def read_points_check(summary, hint=None, bad=2, total=10, **kw) -> CheckInfo:
    steps = tuple(
        CheckStep(id=i, ok=True, ms=5.0, summary=summary if i == "read_points" else "", hint=hint if i == "read_points" else None,
                  points_bad=bad if i == "read_points" else None, points_total=total if i == "read_points" else None)
        for i in STEP_IDS
    )
    return check(fail_at=None, steps=steps, **kw)


def test_the_verdict_of_a_passed_check_says_how_many_points_answered_a_bad_status():
    data = ReportData(generated_at=NOW, checks=(read_points_check("read 10 point(s): 8 good, 2 bad"),), sources=(source(),))
    first = render(data, "summary", ident).split("\n")[0]
    assert first == 'LATEST CHECK: source 3 "Main SCADA" all steps OK, but 2 of 10 points answered a Bad status'
    assert "all steps OK, but 2 of 10 points answered a Bad status" in "\n".join(lines_of(render(data, "full", ident), "CONNECTION CHECKS"))
    clean = ReportData(generated_at=NOW, checks=(read_points_check("read 10 point(s): 10 good, 0 bad", bad=0),), sources=(source(),))
    assert render(clean, "summary", ident).split("\n")[0].endswith("all steps OK")


def test_the_bad_point_counts_come_from_the_detail_of_the_read_points_step():
    def parsed(detail):
        step = {"id": "read_points", "ok": True, "summary": "x", "detail": detail}
        return report.parse_check(1, 3, "done", {"finished": True, "ok": True, "steps": [step]}, NOW, NOW).steps[0]

    assert (parsed({"good": 8, "bad": 2, "bad_status": 1}).points_bad, parsed({"good": 8, "bad": 2, "bad_status": 1}).points_total) == (1, 10)
    assert (parsed({"good": 8, "bad": 2}).points_bad, parsed({"good": 8, "bad": 2}).points_total) == (2, 10)  # an older result
    assert parsed({}).points_bad is None and parsed({"good": "x", "bad": True}).points_total is None


@pytest.mark.parametrize("detail", ["summary", "full"])
def test_a_summary_with_three_bad_statuses_is_not_cut_and_each_status_gets_its_own_hint_line(detail):
    summary = (
        "read 12 point(s) in 3 request(s) of up to 100 node(s): 9 good, 3 bad; bad: BadSensorFailure ns=2;s=Panels.LVP01.kW; "
        "BadNodeIdUnknown ns=2;s=Panels.LVP02.V; BadDeviceFailure ns=2;s=Panels.LVP03.kW"
    )
    hint = "BadSensorFailure, BadDeviceFailure: Ask the SCADA team which device or signal this is.\nBadNodeIdUnknown: The node id does not exist on this server."
    data = ReportData(generated_at=NOW, checks=(read_points_check(summary, hint, bad=3, total=12),), sources=(source(),))
    section = lines_of(render(data, detail, ident), "CONNECTION CHECKS")
    assert any(summary in line for line in section), section
    hints = [line for line in section if "hint:" in line]
    assert hints == [f"      hint: {part}" for part in hint.split("\n")]


# --- the nameservers of the API container (blind-read gap G3) -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("servers", "expected"),
    [(("127.0.0.11", "10.0.0.2"), "dns servers: 127.0.0.11, 10.0.0.2"), (None, "dns servers: unknown"), ((), "dns servers: none listed")],
)
def test_the_environment_names_the_dns_servers_of_the_container(servers, expected):
    assert expected in environment_lines(dns_servers=servers).split("\n")


def test_dns_servers_pass_through_the_mask():
    data = ReportData(generated_at=NOW, environment=env(dns_servers=("10.20.30.40",)))
    masker = Masker()
    body = render(data, "summary", masker.mask, masked=True)
    assert "10.20.30.40" not in body and "dns servers: HOST-1" in body


def test_the_dns_servers_are_the_first_three_nameserver_lines_and_a_missing_file_is_unknown(tmp_path, monkeypatch):
    conf = tmp_path / "resolv.conf"
    conf.write_text("# Generated by Docker\nsearch plant.local\nnameserver 127.0.0.11 # embedded\nnameserver 10.0.0.2\nnameserver 10.0.0.3\nnameserver 10.0.0.4\noptions ndots:0\n")
    monkeypatch.setattr(report, "RESOLV_CONF", str(conf))
    assert report._dns_servers() == ("127.0.0.11", "10.0.0.2", "10.0.0.3")
    conf.write_text("search plant.local\n")
    assert report._dns_servers() == ()
    monkeypatch.setattr(report, "RESOLV_CONF", str(tmp_path / "missing"))
    assert report._dns_servers() is None


# --- the lookups from inside the API container (W8c finding 6) ---------------------------------------------------------------------

NO_SUCH_NAME = "gaierror [Errno -2] Name or service not known"
CLUSTER_NAMES_HINT = (
    "dns lookup: names that only the cluster knows often do not resolve from Docker on Windows; use an address the workstation can "
    "reach (docs/field-debugging.md, First connection day)"
)


def fake_resolver(monkeypatch, answers: dict[str, list[str] | BaseException]) -> list[str]:
    """Patch the lookup: a name in `answers` gets that answer (an exception is raised), any other name is not found. Returns the log."""
    asked: list[str] = []

    async def resolve(host: str) -> list[str]:
        asked.append(host)
        answer = answers.get(host, socket.gaierror(-2, "Name or service not known"))
        if isinstance(answer, BaseException):
            raise answer
        return answer

    monkeypatch.setattr(report, "_resolve", resolve)
    return asked


async def test_each_source_host_that_is_a_name_gets_a_lookup_and_a_failure_keeps_its_error_text(db, session, monkeypatch):
    await make_source(db, "Main", "opcua", {"endpoint": "opc.tcp://scada01:4840/x"})
    await make_source(db, "Meter", "modbus", {"host": "plc.plant.local", "port": 502})
    fake_resolver(monkeypatch, {"scada01": ["10.0.0.5", "10.0.0.6"]})
    found = await report._dns_lookups(session, None)
    assert [(lookup.host, lookup.ok, lookup.addresses) for lookup in found] == [
        ("scada01", True, ("10.0.0.5", "10.0.0.6")), ("plc.plant.local", False, ()),
    ]
    assert found[0].error is None and found[1].error == NO_SUCH_NAME and all(lookup.ms >= 0 for lookup in found)


async def test_the_error_text_of_a_failed_lookup_is_clipped_to_120_characters(db, session, monkeypatch):
    await make_source(db, "Main", "opcua", {"endpoint": "opc.tcp://scada01:4840/x"})
    fake_resolver(monkeypatch, {"scada01": OSError("x" * 500)})
    (lookup,) = await report._dns_lookups(session, None)
    assert not lookup.ok and lookup.error.startswith("OSError xxx") and len(lookup.error) <= 120


async def test_literal_addresses_and_urns_are_not_looked_up_and_a_name_is_asked_once(db, session, monkeypatch):
    await make_source(db, "A", "opcua", {"endpoint": "opc.tcp://opuser:Pw-Secret-1@Scada01:4840/x"})
    await make_source(db, "B", "opcua", {"endpoint": "opc.tcp://10.1.2.3:4840/x"})
    await make_source(db, "C", "modbus", {"host": "192.168.0.7", "port": 502})
    await make_source(db, "D", "opcua", {"endpoint": "opc.tcp://[fd00::5]:4840/x"})
    await make_source(db, "E", "modbus", {"host": "scada01"})
    await make_source(db, "F", "simulator", {"url": "urn:vendor:scada01"})
    await make_source(db, "G", "simulator", {"url": "http://simulator:9000"})
    asked = fake_resolver(monkeypatch, {"scada01": ["10.0.0.5"], "simulator": ["172.20.0.9"]})
    found = await report._dns_lookups(session, None)
    assert [lookup.host for lookup in found] == ["scada01", "simulator"] and sorted(asked) == ["scada01", "simulator"]
    assert "Pw-Secret-1" not in repr(found) and "opuser" not in repr(found)  # the host comes out of a URL, never its credentials


async def test_an_address_only_source_list_and_an_empty_one_need_no_lookup(db, session, monkeypatch):
    asked = fake_resolver(monkeypatch, {})
    assert await report._dns_lookups(session, None) == ()
    await make_source(db, "A", "opcua", {"endpoint": "opc.tcp://10.1.2.3:4840/x"})
    await make_source(db, "B", "modbus", {"host": "192.168.0.7", "port": 502})
    assert await report._dns_lookups(session, None) == () and asked == []


async def test_at_most_eight_names_are_looked_up_the_first_by_source_id(db, session, monkeypatch):
    for i in range(10):
        await make_source(db, f"S{i}", "modbus", {"host": f"plc{i:02d}.plant.local"})
    asked = fake_resolver(monkeypatch, {})
    found = await report._dns_lookups(session, None)
    expected = [f"plc{i:02d}.plant.local" for i in range(8)]
    assert [lookup.host for lookup in found] == expected and sorted(asked) == expected


async def test_a_source_filter_limits_the_lookups_to_that_source(db, session, monkeypatch):
    await make_source(db, "A", "modbus", {"host": "plc-a.plant.local"})
    second = await make_source(db, "B", "modbus", {"host": "plc-b.plant.local"})
    fake_resolver(monkeypatch, {})
    assert [lookup.host for lookup in await report._dns_lookups(session, second)] == ["plc-b.plant.local"]
    assert await report._dns_lookups(session, 9999) == ()


async def test_hung_lookups_cost_one_timeout_not_one_per_host(db, session, monkeypatch):
    for i in range(3):
        await make_source(db, f"S{i}", "modbus", {"host": f"plc{i}.plant.local"})

    async def hang(host: str) -> list[str]:
        await asyncio.sleep(10)
        return []

    monkeypatch.setattr(report, "_resolve", hang)
    monkeypatch.setattr(report, "DNS_LOOKUP_SECONDS", 0.3)
    started = time.monotonic()
    found = await report._dns_lookups(session, None)
    assert time.monotonic() - started < 0.8  # three serial timeouts would be 0.9
    assert [lookup.ok for lookup in found] == [False] * 3
    assert all(lookup.error.startswith("TimeoutError") and lookup.ms >= 150 for lookup in found)


async def test_the_real_lookup_runs_on_its_own_thread_pool_and_returns_the_unique_addresses_in_order(monkeypatch):
    threads: list[str] = []
    real = socket.getaddrinfo

    def fake(host, port, **kwargs):
        if host != "plc.test":
            return real(host, port, **kwargs)
        threads.append(threading.current_thread().name)
        v4, v6 = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 0)), (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("fd00::5", 0, 0, 0))
        return [v4, v6, v4]

    monkeypatch.setattr(socket, "getaddrinfo", fake)
    assert await REAL_RESOLVE("plc.test") == ["10.0.0.5", "fd00::5"]
    assert threads and threads[0].startswith("dns-lookup")
    assert "127.0.0.1" in await REAL_RESOLVE("127.0.0.1")


async def test_gather_looks_the_names_up_after_the_environment_section(db, session, monkeypatch):
    await make_source(db, "Main", "opcua", {"endpoint": "opc.tcp://scada01:4840/x"})
    order: list[str] = []
    real_environment, real_lookups = report._environment, report._dns_lookups

    async def environment(*args):
        order.append("environment")
        return await real_environment(*args)

    async def lookups(*args):
        order.append("dns")
        return await real_lookups(*args)

    monkeypatch.setattr(report, "_environment", environment)
    monkeypatch.setattr(report, "_dns_lookups", lookups)
    data = await gather(session, detail="summary")
    assert order == ["environment", "dns"]
    assert [(lookup.host, lookup.ok, lookup.error) for lookup in data.dns_lookups] == [("scada01", False, NO_SUCH_NAME)]


async def test_a_failing_source_query_makes_only_the_lookups_unavailable(db, session, monkeypatch):
    await make_source(db, "Main", "opcua", {"endpoint": "opc.tcp://scada01:4840/x"})

    async def broken(db_, source_id):
        raise RuntimeError("boom")

    monkeypatch.setattr(report, "_dns_hosts", broken)
    data = await gather(session, detail="summary")
    assert data.dns_lookups == Unavailable("RuntimeError") and not isinstance(data.environment, Unavailable)
    lines = lines_of(render(data, "summary", ident), "ENVIRONMENT")
    assert "dns lookups: not tried" in lines and not any(line.startswith("section unavailable") for line in lines)


def lookups_in(servers=("10.0.0.2",), *found) -> list[str]:
    data = ReportData(generated_at=NOW, environment=env(dns_servers=servers), dns_lookups=tuple(found))
    return lines_of(render(data, "summary", ident), "ENVIRONMENT")


def test_the_environment_shows_one_line_per_lookup_and_the_cluster_hint_after_any_failure():
    lines = lookups_in(
        ("10.0.0.2",), DnsLookup("scada01", True, ("10.0.0.5", "10.0.0.6"), 12.4), DnsLookup("plc.plant.local", False, (), 3000.0, NO_SUCH_NAME)
    )
    start = lines.index("dns servers: 10.0.0.2")
    assert lines[start + 1:start + 4] == [
        "dns lookup scada01: OK in 12 ms -> 10.0.0.5, 10.0.0.6", f"dns lookup plc.plant.local: FAILED in 3000 ms: {NO_SUCH_NAME}", CLUSTER_NAMES_HINT,
    ]
    assert lines[start + 4].startswith("clock:")


def test_only_working_lookups_add_no_hint_and_no_gathered_lookups_add_no_line():
    lines = lookups_in(("10.0.0.2",), DnsLookup("scada01", True, ("10.0.0.5",), 3.0))
    assert "dns lookup scada01: OK in 3 ms -> 10.0.0.5" in lines and not any(line.startswith("dns lookup:") for line in lines)
    data = ReportData(generated_at=NOW, environment=env())  # the lookups were not gathered at all (a fixture)
    assert not any("dns lookup" in line for line in lines_of(render(data, "summary", ident), "ENVIRONMENT"))


def test_no_names_and_an_unavailable_step_are_said_in_one_line_each():
    assert "dns lookups: none needed (every source host is an address)" in lookups_in(("10.0.0.2",))
    data = ReportData(generated_at=NOW, environment=env(), dns_lookups=Unavailable("RuntimeError"))
    assert "dns lookups: not tried" in lines_of(render(data, "summary", ident), "ENVIRONMENT")


def test_the_embedded_resolver_is_explained_only_when_it_is_the_only_server():
    note = (
        "dns servers: 127.0.0.11 (Docker's embedded resolver; it forwards to the resolvers of the Docker host, which this container "
        "cannot see: compare with the DNS servers in the offline script's NETWORK section)"
    )
    assert note in lookups_in(("127.0.0.11",))
    assert "dns servers: 127.0.0.11, 10.0.0.2" in lookups_in(("127.0.0.11", "10.0.0.2"))
    assert "dns servers: 10.0.0.2" in lookups_in(("10.0.0.2",))


def test_a_masked_report_shows_neither_the_looked_up_host_nor_its_addresses():
    data = ReportData(
        generated_at=NOW, environment=env(dns_servers=("127.0.0.11",)),
        dns_lookups=(
            DnsLookup("scada01.meeza.local", True, ("10.0.0.5", "fd00::5"), 9.0), DnsLookup("plc.plant.local", False, (), 3000.0, NO_SUCH_NAME),
        ),
    )
    hosts, uris = mask_names(data)
    assert hosts == ["scada01.meeza.local", "plc.plant.local"]
    body = render(data, "summary", Masker(hosts, uris).mask, masked=True)
    for hidden in ("scada01", "meeza", "plc.plant", "10.0.0.5", "fd00::5", "127.0.0.11"):
        assert hidden not in body, hidden
    assert re.search(r"^dns lookup HOST-\d+: OK in 9 ms -> HOST-\d+, HOST-\d+$", body, re.M)
    assert re.search(r"^dns lookup HOST-\d+: FAILED in 3000 ms: gaierror", body, re.M)


def test_a_busy_summary_with_eight_failing_lookups_is_still_one_part():
    failing = tuple(DnsLookup(f"scada{i:02d}.plant.example.com", False, (), 3000.0, NO_SUCH_NAME) for i in range(8))
    data = replace(busy(40, 500, failing=33), dns_lookups=failing)
    body = render(data, "summary", ident)
    parts = finalize(body, "abc1234-dirty", NOW)
    assert len(parts.parts) == 1 and len(parts.parts[0].text) <= 12_000 and verify_paste(parts.text()).ok
    assert sum(1 for line in body.split("\n") if line.startswith("dns lookup scada")) == 8 and CLUSTER_NAMES_HINT in body


# --- the history line in SOURCE HEALTH (w30 D11) ---------------------------------------------------------------------------------

THROUGH = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)


def history(state="idle", **kw) -> HistoryInfo:
    base = dict(answered_through=THROUGH, short_hours=3, rows_new=14_200, rows_already=480, rows_differing=0, rows_rejected=2,
                requests=12, failures=0)
    return HistoryInfo(state, **{**base, **kw})


def health_lines(item: SourceHealth, detail="summary", transform=ident, **kw) -> list[str]:
    return lines_of(render(ReportData(generated_at=NOW, sources=(source(**kw),), health=(item,)), detail, transform), "SOURCE HEALTH")


def test_a_source_with_a_history_row_gets_one_line_under_its_health_line():
    for detail in ("summary", "full"):
        lines = health_lines(SourceHealth(3, 120, 3, 2.0, history()), detail)
        assert len(lines) == 2 and lines[0].startswith('#3 "Main SCADA": ')
        assert lines[1] == (
            "   history: idle, answered through 2026-10-21 12:00 UTC, since restart 14,200 new / 480 already / 0 differing / "
            "2 rejected, 3 hours short, 12 requests, 0 failed"
        )


def test_the_history_line_says_the_next_try_and_the_last_error_when_there_are_some_and_the_state_in_plain_words():
    failing = history(
        "backing_off", failures=4, next_try_at=datetime(2026, 10, 21, 12, 30, tzinfo=timezone.utc), last_error="unreachable: no route to host",
    )
    (_, line) = health_lines(SourceHealth(3, 120, 3, 2.0, failing))
    assert line.startswith("   history: backing off, answered through 2026-10-21 12:00 UTC, ")
    assert line.endswith(", 4 failed, next try 2026-10-21 12:30 UTC, last error: unreachable: no route to host")
    (_, line) = health_lines(SourceHealth(3, 120, 3, 2.0, history("not_supported", last_error=None)))
    assert line.startswith("   history: not supported, ") and "next try" not in line and "last error" not in line


def test_a_source_nothing_was_answered_for_yet_and_one_hour_or_request_read_in_the_singular():
    (_, line) = health_lines(SourceHealth(3, 120, 3, 2.0, history("filling", answered_through=None, short_hours=1, requests=1)))
    assert line.startswith("   history: filling, nothing answered yet, since restart ") and line.endswith(", 1 hour short, 1 request, 0 failed")


def test_a_source_without_a_history_row_prints_nothing_extra_and_the_old_output_is_unchanged():
    lines = health_lines(SourceHealth(3, 120, 3, 2.0))
    assert lines ==['#3 "Main SCADA": 12.0 reads/min, 2.5% bad, newest reading 2 s ago']
    # the stored example of a healthy stack: the same facts render to exactly the lines the example holds
    example = (Path(__file__).resolve().parents[2] / "docs" / "field-debugging-examples" / "01-healthy.txt").read_text(encoding="utf-8")
    stored = lines_of(example, "SOURCE HEALTH")
    data = ReportData(generated_at=NOW, sources=(source(1, "SCADA main"),), health=(SourceHealth(1, 424, 0, 4.0),))
    assert stored and lines_of(render(data, "summary", ident), "SOURCE HEALTH") == stored
    assert "history" not in render(data, "full", ident)


def test_the_history_line_is_scrubbed_and_clipped_like_every_text_of_the_report():
    error = "unreachable: " + "Zq9-secret-pw and a very long reason " * 20
    (_, line) = health_lines(SourceHealth(3, 120, 3, 2.0, history("backing_off", last_error=error)), "full", lambda s: s.replace("Zq9-secret-pw", "[hidden]"))
    assert "Zq9-secret-pw" not in line and "[hidden]" in line and line.endswith("…") and len(line) <= report.LINE_LIMIT
    body = render(ReportData(generated_at=NOW, sources=(source(),), health=(SourceHealth(3, 120, 3, 2.0, history("backing_off", last_error=error)),)), "full", ident)
    assert all(len(line) <= report.LINE_LIMIT for line in body.split("\n"))


def test_a_history_that_could_not_be_read_is_one_line_and_the_health_lines_stay():
    lines = health_lines(SourceHealth(3, 120, 3, 2.0, Unavailable("ProgrammingError (UndefinedTableError)")))
    assert lines[0].startswith('#3 "Main SCADA": 12.0 reads/min') and lines[1] == "   history: unavailable (ProgrammingError (UndefinedTableError))"


def test_a_busy_summary_with_a_history_line_on_every_source_still_keeps_every_source_in_one_part():
    """The 40-source summary of the M7 test fits only once the health lines of the healthy sources are gone. A line of history on every
    source must not push it past that point (into dropping sources): the lines of a backfill that is fine go next, and the lines
    that say something is wrong stay."""
    def state(i: int) -> HistoryInfo:
        if i == 33:  # the source whose check fails
            return history("backing_off", failures=4, next_try_at=THROUGH + timedelta(minutes=30), last_error="unreachable: no route")
        return history("not_supported") if i == 6 else history()

    data = replace(busy(40, 500, failing=33), health=tuple(SourceHealth(i, 120, 3, 2.0, state(i)) for i in range(1, 41)))
    body = render(data, "summary", ident)
    parts = finalize(body, "abc1234-dirty", NOW)
    assert len(parts.parts) == 1 and len(parts.parts[0].text) <= 12_000 and verify_paste(parts.text()).ok
    assert len([line for line in lines_of(body, "SOURCES") if line.startswith("#")]) == 40 and "more sources omitted" not in body
    lines = lines_of(body, "SOURCE HEALTH")
    assert any(line.startswith("... health of ") and "without a problem omitted" in line for line in lines)  # the healthy blocks went
    mine = [(lines[i - 1].split(":")[0], line.split(",")[0]) for i, line in enumerate(lines) if line.startswith("   history:")]
    assert mine == [('#6 "Plant 6"', "   history: not supported"), ('#33 "Plant 33"', "   history: backing off")]  # each under its own source
    # and with room to spare every source keeps its line, the idle ones too
    roomy = render(data, "summary", ident, max_chars=60_000)
    assert len([line for line in lines_of(roomy, "SOURCE HEALTH") if line.startswith("   history:")]) == 40


def test_the_history_line_keeps_a_source_that_has_no_row_out_of_the_pair_of_lines():
    data = ReportData(
        generated_at=NOW, sources=(source(3), source(4, "Spare")),
        health=(SourceHealth(3, 120, 3, 2.0, history()), SourceHealth(4, 0, 0, None)),
    )
    lines = lines_of(render(data, "summary", ident), "SOURCE HEALTH")
    assert [line[:12] for line in lines] == ['#3 "Main SCA', "   history: ", '#4 "Spare": ']


async def history_row(db, source_id: int, state="idle", **columns) -> None:
    columns = {
        "answered_through": THROUGH, "short_hours": 3, "rows_new": 14_200, "rows_already": 480, "rows_differing": 0, "rows_rejected": 2,
        "requests": 12, "failures": 0, **columns,
    }
    names = ", ".join(columns)
    marks = ", ".join(f"${n}" for n in range(3, 3 + len(columns)))
    await db.execute(f"INSERT INTO history_status (source_id, state, {names}) VALUES ($1, $2, {marks})", source_id, state, *columns.values())


async def test_gather_reads_the_history_row_of_each_source_that_has_one(db, session):
    ids = await seed(db)
    await history_row(
        db, ids["b"], "backing_off", next_try_at=THROUGH + timedelta(minutes=30), last_error="unreachable: no route", failures=4,
    )
    data = await gather(session, detail="summary")
    health = {h.source_id: h for h in data.health}
    assert health[ids["a"]].history is None
    assert health[ids["b"]].history == HistoryInfo(
        "backing_off", THROUGH, 3, 14_200, 480, 0, 2, 12, 4, THROUGH + timedelta(minutes=30), "unreachable: no route",
    )
    lines = lines_of(render(data, "summary", ident), "SOURCE HEALTH")
    mine = [line for line in lines if line.startswith("   history:")]
    assert len(mine) == 1 and mine[0].endswith("next try 2026-10-21 12:30 UTC, last error: unreachable: no route")
    assert lines[lines.index(mine[0]) - 1].startswith('#' + str(ids["b"]))
    only = await gather(session, detail="summary", source_id=ids["a"])
    assert [h.history for h in only.health] == [None]
    assert [h.history for h in (await gather(session, detail="summary", source_id=ids["b"])).health] == [health[ids["b"]].history]


async def test_a_failing_history_read_leaves_the_health_lines_and_marks_each_source(db, session, monkeypatch):
    ids = await seed(db)

    async def broken(db_, *args):
        raise RuntimeError("secret message: Zq9-secret-pw")

    monkeypatch.setattr(report, "_history", broken)
    data = await gather(session, detail="summary")
    assert not isinstance(data.health, Unavailable) and {h.source_id for h in data.health} == set(ids.values())
    assert {h.history for h in data.health} == {Unavailable("RuntimeError")} and "Zq9-secret-pw" not in repr(data)
    assert await session.scalar(select(1)) == 1  # the transaction is usable
    assert "   history: unavailable (RuntimeError)" in render(data, "summary", ident)


async def test_a_database_without_the_history_table_still_gives_the_health_section(db, session):
    ids = await seed(db)
    await session.execute(text("ALTER TABLE history_status RENAME TO history_status_away"))  # undone with the session's transaction
    data = await gather(session, detail="summary")
    assert not isinstance(data.health, Unavailable) and len(data.health) == 2
    assert {h.history for h in data.health} == {Unavailable("ProgrammingError (UndefinedTableError)")}
    assert not isinstance(data.points, Unavailable) and not isinstance(data.journal, Unavailable)  # the other sections never noticed
    lines = lines_of(render(data, "summary", ident), "SOURCE HEALTH")
    assert any(line.startswith(f'#{ids["a"]} "Main SCADA": ') for line in lines)
