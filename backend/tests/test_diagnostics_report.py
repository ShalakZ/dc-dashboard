"""The diagnostics report: `render` on fixture data (no database), `gather` on a seeded database."""
import asyncio
import re
from dataclasses import fields, replace
from datetime import datetime, timedelta, timezone

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
    AuditEntry, CheckInfo, CheckStep, Environment, Event, PointRow, PointsInfo, PolicyJob, ReportData, ScanInfo,
    SettingsInfo, SourceHealth, SourceInfo, StorageInfo, Unavailable, gather, load_known, mask_names, render,
)
from helpers import make_asset, make_mapping, make_point, make_source

NOW = datetime(2026, 10, 12, 10, 0, 0, tzinfo=timezone.utc)
STEP_IDS = ("dns", "tcp", "endpoints", "certificates", "session", "server_time", "namespaces", "read_points", "timing")
SESSION_FAILURE = "LATEST CHECK: source 3 \"Main SCADA\" FAILED at session: BadUserAccessDenied (0x801F0000)"


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
    step_ok = CheckStep(id="read_points", ok=True, ms=3.0, summary=mark("oksum"))
    data = ReportData(
        generated_at=NOW,
        environment=env(
            build_id=mark("build"), build_time=mark("btime"), collector_build_id=mark("cbuild"), python=mark("py"), system=mark("sys"),
            asyncua=mark("ua"), pymodbus=mark("pm"), postgres=mark("pg"), timescale=mark("ts"),
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
        audit=(AuditEntry(NOW, mark("actor"), mark("action"), {"k": mark("auditdet")}),),
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
    admin = await db.fetchval("INSERT INTO users (username, password_hash, role) VALUES ('boss', 'HASH-of-a-password-9', 'admin') RETURNING id")
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


@pytest.mark.parametrize("stamp, shown", [
    ("2026-10-11T20:00:00+03:00", "2026-10-11T17:00:00Z"),
    ("2026-10-11T17:00:00Z", "2026-10-11T17:00:00Z"),
    ("2026-10-11 20:00:00+0300", "2026-10-11T17:00:00Z"),  # git's own %ci spelling
    ("unknown", "unknown"),
    ("2026-10-11T20:00:00", "2026-10-11T20:00:00"),  # no offset: nothing to convert with
])
def test_the_build_time_is_printed_in_utc_when_it_can_be_read(stamp, shown):
    assert f"(built {shown})" in environment_lines(build_time=stamp)
