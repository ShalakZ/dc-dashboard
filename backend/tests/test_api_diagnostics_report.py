"""GET /api/diagnostics/report: who may ask, what is audited, what survives a failing section, and the leak test.

The leak test is the point of the file. Every secret is planted with raw SQL (the journal writer would scrub it on the way in,
and the report must not rely on that) in every place a report reads free text from, and must not come out of any combination of
detail, mask and format.
"""
import json
import re
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from dcdash.core.config import get_settings
from dcdash.diagnostics import report
from dcdash.diagnostics.redact import verify_paste
from helpers import login_as, make_source, make_user

DB_PASSWORD = "Zk-Db-Pw-4471"  # the testcontainers password is "dcdash", which is also in every header and in job kinds
SOURCE_PASSWORD = "Zx7-Only-In-Secret-Col"  # lives in sources.secret only
URL_USER, URL_PASSWORD = "urluser", "Url-Pw-88213"
OPC_USER = "scada_op"
HOST_A, HOST_B, HOST_C, LOOSE_IP = "10.20.30.41", "scada-b.plant.example", "192.168.77.9", "172.16.5.9"
URL_B = f"opc.tcp://{URL_USER}:{URL_PASSWORD}@{HOST_B}:4840/x"
CERT_HOST, CERT_URI = "SCADA-SRV-77", "urn:SCADA-SRV-77:Vendor:Prod"
SECTIONS = (
    "ENVIRONMENT", "SETTINGS", "SOURCES", "SOURCE HEALTH", "POINTS", "CONNECTION CHECKS", "JOURNAL", "SCANS",
    "STORAGE AND RETENTION", "AUDIT TAIL", "API ERRORS",
)
LATEST = re.compile(r'LATEST CHECK: source (\d+) "(.*)" FAILED at (\w+): (.*)')


@pytest.fixture(autouse=True)
def other_database_password(monkeypatch):
    """The report hides the database password everywhere, and the container's is "dcdash": give the report another one."""
    monkeypatch.setattr(
        report, "get_settings",
        lambda: get_settings().model_copy(update={"database_url": f"postgresql://dcdash:{DB_PASSWORD}@db:5432/dcdash"}),
    )


async def ask(client, **params):
    return await client.get("/api/diagnostics/report", params=params)


async def audit_rows(db) -> list[dict]:
    rows = await db.fetch("SELECT user_id, detail FROM audit_log WHERE action = 'diagnostics.report' ORDER BY id")
    return [{"user_id": r["user_id"], **r["detail"]} for r in rows]


def body_lines(text_: str) -> list[str]:
    return text_.split("\n")


# --- who may ask, what is audited ------------------------------------------------------------------------------------------------


async def test_the_report_needs_a_session(client, db):
    assert (await ask(client)).status_code == 401
    assert await audit_rows(db) == []


@pytest.mark.parametrize("role", ["operator", "viewer"])
async def test_only_an_admin_may_read_the_report(client, db, role):
    await login_as(client, db, role)
    for params in ({}, {"detail": "full", "mask": 1, "format": "json"}):
        response = await ask(client, **params)
        assert response.status_code == 403
        assert "DCDASH-REPORT" not in response.text
    assert await audit_rows(db) == []


async def test_an_admin_gets_the_text_and_it_is_one_audit_row_that_holds_no_content(client, db):
    await login_as(client, db, "admin")
    admin_id = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    await make_source(db, "Quarry Pump House", "opcua", {"endpoint": f"opc.tcp://{HOST_A}:4840/x"})
    response = await ask(client)
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/plain; charset=utf-8"
    assert response.headers["cache-control"] == "no-store"
    assert response.text.startswith("DCDASH-REPORT v1 | PART 1 OF 1 | build ")
    assert verify_paste(response.text).ok
    (row,) = await audit_rows(db)
    assert row == {"user_id": admin_id, "detail": "summary", "mask": False, "source_id": None, "parts": 1, "chars": len(response.text)}
    response = await ask(client, detail="full", mask=1, source=1)
    (_, second) = await audit_rows(db)
    assert second["detail"] == "full" and second["mask"] is True and second["source_id"] == 1 and second["chars"] == len(response.text)
    stored = json.dumps([row["detail"] for row in await db.fetch("SELECT detail FROM audit_log WHERE action = 'diagnostics.report'")])
    assert "Quarry" not in stored and HOST_A not in stored  # how it was asked for, never what it said


async def test_a_refused_request_writes_no_audit_row(client, db):
    await login_as(client, db, "admin")
    for params in ({"mask": 2}, {"detail": "everything"}, {"format": "xml"}, {"source": 0}, {"client_time": "yesterday"}):
        assert (await ask(client, **params)).status_code == 422, params
    assert await audit_rows(db) == []


# --- shape ---------------------------------------------------------------------------------------------------------------------


async def test_an_empty_database_gives_every_section_and_masking_finds_nothing_in_it(client, db):
    await login_as(client, db, "admin")
    for mask in (0, 1):
        response = await ask(client, mask=mask, format="json")
        assert response.status_code == 200
        body = response.json()
        joined = "\n".join(part["text"] for part in body["parts"])
        assert [line for line in body_lines(joined) if line.startswith("== ")] == [f"== {name} ==" for name in SECTIONS]
        assert "no sources configured" in joined and "no connection check has been run" in joined
        assert body["legend"] == [] and not re.search(r"(?:HOST|URN)-\d", joined)  # nothing in the environment looks like a host
        assert verify_paste(joined).ok
    assert len(await audit_rows(db)) == 2


async def test_the_json_carries_the_parts_the_checksum_and_the_legend_only_for_a_masked_report(client, db):
    await login_as(client, db, "admin")
    await make_source(db, "Main", "opcua", {"endpoint": f"opc.tcp://{HOST_A}:4840/x"})
    await make_source(db, "Spare", "modbus", {"host": HOST_C, "port": 502})
    as_text = (await ask(client, mask=1)).text
    plain = (await ask(client, format="json")).json()
    masked = (await ask(client, mask=1, format="json")).json()
    assert set(masked) == {"format", "build_id", "detail", "mask", "checksum", "parts", "legend"}
    assert masked["format"] == "DCDASH-REPORT v1" and masked["detail"] == "summary" and masked["mask"] is True
    assert plain["mask"] is False and plain["legend"] == []
    assert {entry["original"] for entry in masked["legend"]} == {HOST_A, HOST_C}
    assert all(entry["alias"].startswith("HOST-") for entry in masked["legend"])
    assert HOST_A in json.dumps(masked["legend"]) and HOST_A not in "".join(part["text"] for part in masked["parts"])
    for part in masked["parts"]:
        assert set(part) == {"index", "of", "text", "chars", "lines"} and part["of"] == len(masked["parts"])
    joined = "\n\n".join(part["text"] for part in masked["parts"])
    assert verify_paste(joined).ok
    assert joined.splitlines()[-1] == f"END OF REPORT {masked['checksum']}"
    assert "HOST-1" in as_text.split("== SOURCES ==")[1] and HOST_A not in as_text


async def test_the_source_filter_limits_the_report_and_an_unknown_source_says_so(client, db):
    await login_as(client, db, "admin")
    first = await make_source(db, "Alpha Meter", "simulator", {"url": "http://sim:9000"})
    second = await make_source(db, "Beta Meter", "simulator", {"url": "http://sim:9000"})
    body = (await ask(client, source=second)).text
    assert "Beta Meter" in body and "Alpha Meter" not in body
    assert "no source with id 9999" in (await ask(client, source=9999)).text
    assert [row["source_id"] for row in await audit_rows(db)] == [second, 9999]
    assert first != second


async def test_the_browser_clock_is_compared_with_the_container_clock(client, db):
    await login_as(client, db, "admin")
    ahead = (datetime.now(timezone.utc) + timedelta(seconds=90)).isoformat()
    body = (await ask(client, client_time=ahead)).text
    shown = re.search(r"clock: browser minus container = \+([\d.]+) s", body)
    assert shown and 80 < float(shown[1]) <= 90  # 90 s ahead, less the time the request took
    assert "a local VM clock problem" in body
    assert "browser time not supplied" in (await ask(client)).text


# --- a failing section ---------------------------------------------------------------------------------------------------------


async def test_a_section_that_raises_does_not_lose_the_report_or_the_audit_row(client, db, monkeypatch):
    await login_as(client, db, "admin")
    await make_source(db, "Main", "opcua", {"endpoint": f"opc.tcp://{HOST_A}:4840/x"})

    async def boom(*_args, **_kwargs):
        raise RuntimeError(f"boom {SOURCE_PASSWORD}")

    monkeypatch.setattr(report, "_points", boom)
    response = await ask(client)
    assert response.status_code == 200
    assert "section unavailable: RuntimeError" in response.text
    assert SOURCE_PASSWORD not in response.text  # the class only, never the message
    assert "== STORAGE AND RETENTION ==" in response.text and "#1 \"Main\"" in response.text
    assert len(await audit_rows(db)) == 1


async def test_an_sql_error_in_a_section_does_not_abort_the_transaction_the_audit_row_needs(client, db, monkeypatch):
    await login_as(client, db, "admin")

    async def broken(db_, *_args, **_kwargs):
        await db_.execute(text("SELECT * FROM a_table_that_does_not_exist"))

    monkeypatch.setattr(report, "_scans", broken)
    response = await ask(client, format="json")
    assert response.status_code == 200
    assert "section unavailable: ProgrammingError" in response.json()["parts"][0]["text"]
    assert len(await audit_rows(db)) == 1


async def test_a_masked_report_of_one_source_still_hides_the_host_names_of_the_others_in_unfiltered_sections(client, db):
    from dcdash.core.audit import audit_pool

    await login_as(client, db, "admin")
    await make_source(db, "Alpha Meter", "simulator", {"url": "http://alpha-host:9000"})
    second = await make_source(db, "Beta Meter", "simulator", {"url": "http://beta-host:9000"})
    await audit_pool(db, None, "source.updated", {"note": "moved alpha-host to rack 4"})
    body = (await ask(client, source=second, mask=1)).text
    assert "alpha-host" not in body and "beta-host" not in body and "moved HOST-" in body


async def test_a_database_that_cannot_be_read_for_the_secrets_gives_no_report_at_all(client, db, monkeypatch):
    await login_as(client, db, "admin")

    async def failing(*_args, **_kwargs):
        raise RuntimeError("cannot read the secrets")

    monkeypatch.setattr("dcdash.api.diagnostics.load_known", failing)
    with pytest.raises(RuntimeError):  # fail closed: an unscrubbed report is never produced
        await ask(client)
    assert await audit_rows(db) == []


# --- the leak test -------------------------------------------------------------------------------------------------------------


async def plant(client, db) -> dict[str, list[str]]:
    """Secrets and addresses in every place the report reads free text from, written around the journal's own scrubbing."""
    secret_key = get_settings().secret_key
    a = await make_source(
        db, "Main SCADA", "opcua",
        {"endpoint": f"opc.tcp://{HOST_A}:4840/scada", "security_policy": "none", "username": OPC_USER}, secret=SOURCE_PASSWORD,
    )
    b = await make_source(db, "Backup SCADA", "opcua", {"endpoint": URL_B, "security_policy": "none"})
    c = await make_source(db, "Meter bank", "modbus", {"host": HOST_C, "port": 502, "unit_id": 1})
    await make_user(db, "second", "viewer")
    hashes = [r["password_hash"] for r in await db.fetch("SELECT password_hash FROM users")]
    sessions = [r["id"] for r in await db.fetch("SELECT id FROM sessions")]
    cookie = client.cookies.get("dcdash_session")
    assert hashes and sessions and cookie
    await db.execute(
        "UPDATE sources SET status = 'offline', last_error = $2 WHERE id = $1",
        a, f"MKE {SOURCE_PASSWORD} against {URL_B} from {LOOSE_IP}",
    )
    await db.execute("UPDATE sources SET status = 'offline', last_error = $2 WHERE id = $1", b, f"MKE2 {URL_B}")
    journal = (
        "INSERT INTO diag_events (level, component, source_id, kind, code, message, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)"
    )
    await db.execute(
        journal, "warning", "collector", a, "source.offline", "auth_failed",
        f"MKJ {SOURCE_PASSWORD} {URL_B} key {secret_key} connect to {LOOSE_IP}:4840 failed, {CERT_HOST} ({CERT_URI}) rejected",
        {"error": f"MKJD {SOURCE_PASSWORD}", "url": URL_B},
    )
    await db.execute(
        journal, "error", "api", None, "http.5xx", "500",
        f"MKX GET /api/x: RuntimeError {DB_PASSWORD} {hashes[0]} {sessions[0]} {cookie}",
        {"exception": f"{DB_PASSWORD} {cookie}", "route": f"/api/{SOURCE_PASSWORD}"},
    )
    await db.execute(
        "INSERT INTO audit_log (user_id, action, detail) VALUES ((SELECT id FROM users WHERE username = 'admin'), 'source.updated', $1)",
        {"note": f"MKA {SOURCE_PASSWORD} {sessions[0]} {hashes[-1]}", "endpoint": URL_B, "host": HOST_A},
    )
    step_error = {
        "class": "UaStatusCodeError", "status_name": "BadUserAccessDenied", "status_hex": "0x801F0000",
        "message": f"MKC {SOURCE_PASSWORD} {URL_B} {secret_key}",
    }
    result = {
        "source_id": a, "connector_type": "opcua", "finished": True, "ok": False, "first_failed": "session",
        "steps": [
            {"id": "dns", "name": "DNS resolution", "ok": True, "ms": 12, "summary": f"{HOST_A} MKS {URL_B}", "error": None,
             "hint": None, "detail": {}},
            {"id": "session", "name": "Session", "ok": False, "ms": 450, "summary": f"MKSS {SOURCE_PASSWORD}", "error": step_error,
             "hint": "check the account", "detail": {"endpoint": URL_B}},
        ],
        "clock": {"server_time": None, "local_time": "2026-10-12T10:00:00Z", "skew_seconds": None},
        "names": {"hosts": [CERT_HOST], "uris": [CERT_URI]},
    }
    await db.execute(
        "INSERT INTO jobs (kind, params, status, result, finished_at) VALUES ('check_connection', $1, 'done', $2, now())",
        {"source_id": a}, result,
    )
    await db.execute(
        "INSERT INTO jobs (kind, params, status, result, finished_at) VALUES ('test_source', $1, 'done', $2, now())",
        {"source_id": c}, {"ok": False, "error": f"{SOURCE_PASSWORD} {URL_B}"},
    )
    return {
        "credentials": [
            SOURCE_PASSWORD, URL_PASSWORD, URL_USER, OPC_USER, DB_PASSWORD, secret_key, cookie, *hashes, *sessions,
        ],
        "hosts": [HOST_A, HOST_B, HOST_C, LOOSE_IP, CERT_HOST, CERT_URI, f"{HOST_A}:4840", f"{HOST_B}:4840"],
    }


@pytest.mark.parametrize("detail", ["summary", "full"])
@pytest.mark.parametrize("mask", [0, 1])
@pytest.mark.parametrize("fmt", ["text", "json"])
async def test_no_secret_survives_in_any_report_and_a_masked_one_shows_no_host_either(client, db, detail, mask, fmt):
    await login_as(client, db, "admin")
    forbidden = await plant(client, db)
    response = await ask(client, detail=detail, mask=mask, format=fmt)
    assert response.status_code == 200
    if fmt == "json":
        body = response.json()
        text_ = "\n\n".join(part["text"] for part in body["parts"])
        whole = response.text  # the legend names hosts on purpose; no credential may be in it
        assert (len(body["legend"]) > 0) == bool(mask)
    else:
        text_ = whole = response.text
    assert verify_paste(text_).ok
    for secret in forbidden["credentials"]:
        assert secret not in whole, secret[:6]
    # the planted channels did reach the report (a leak test that reads nothing proves nothing); one line each, scrubbed
    for marker in ("MKE ", "MKJ ", "MKX ", "MKA ", "MKC ", "LATEST CHECK: source 1"):
        assert marker in text_, marker
    assert "[hidden]" in text_
    if mask:
        for host in forbidden["hosts"]:
            assert host not in text_, host
        assert re.search(r"HOST-\d", text_) and re.search(r"URN-\d", text_)
        assert "== STORAGE AND RETENTION ==" in text_
    else:
        assert HOST_A in text_ and HOST_C in text_


async def test_the_verdict_names_the_failing_step_in_the_masked_report_too(client, db):
    await login_as(client, db, "admin")
    await plant(client, db)
    for mask in (0, 1):
        first = (await ask(client, mask=mask)).text.split("\n")[1]
        found = LATEST.fullmatch(first)
        assert found and found[3] == "session" and "BadUserAccessDenied" in found[4], first


async def test_a_listed_host_that_is_also_a_word_of_the_report_does_not_rename_the_sections(client, db):
    await login_as(client, db, "admin")
    for name in ("storage", "scada", "points"):
        await make_source(db, f"Odd {name}", "opcua", {"endpoint": f"opc.tcp://{name}:4840/x"})
    text_ = (await ask(client, mask=1)).text
    assert [line for line in text_.split("\n") if line.startswith("== ")] == [f"== {name} ==" for name in SECTIONS]
    assert re.search(r"HOST-\d", text_.split("== SOURCES ==")[1]) and verify_paste(text_).ok
    assert max(map(len, text_.split("\n"))) <= 300


# --- size ----------------------------------------------------------------------------------------------------------------------


async def crowd(db, sources=200, events=500) -> None:
    await db.executemany(
        "INSERT INTO sources (name, connector_type, config, status, last_error) VALUES ($1, 'opcua', $2, $3, $4)",
        [
            (
                f"Meter {i:03d}", {"endpoint": f"opc.tcp://10.9.{i // 250}.{i % 250 + 1}:4840/x", "security_policy": "none"},
                "offline" if i % 5 == 0 else "online",
                f"read timed out after 5 s on 10.9.{i // 250}.{i % 250 + 1}" if i % 5 == 0 else None,
            )
            for i in range(sources)
        ],
    )
    await db.executemany(
        "INSERT INTO diag_events (ts, level, component, source_id, kind, code, message) "
        "VALUES (now() - $1 * interval '1 second', 'warning', 'collector', $2, 'source.offline', 'timeout', $3)",
        [(i, i % sources + 1, f"session to opc.tcp://10.9.{i % 4}.{i % 250 + 1}:4840/x failed: " + "x" * 120) for i in range(events)],
    )
    failing = {
        "source_id": 5, "connector_type": "opcua", "finished": True, "ok": False, "first_failed": "tcp",
        "steps": [
            {"id": "dns", "name": "DNS", "ok": True, "ms": 3, "summary": "ok", "error": None, "hint": None, "detail": {}},
            {"id": "tcp", "name": "TCP", "ok": False, "ms": 5000, "summary": "no answer",
             "error": {"class": "TimeoutError", "status_name": None, "status_hex": None, "message": "timed out"},
             "hint": "firewall", "detail": {}},
        ],
        "clock": {"server_time": None, "local_time": "2026-10-12T10:00:00Z", "skew_seconds": None},
    }
    await db.execute(
        "INSERT INTO jobs (kind, params, status, result, finished_at) VALUES ('check_connection', $1, 'done', $2, now())",
        {"source_id": 5}, failing,
    )


@pytest.mark.parametrize("mask", [0, 1])
async def test_a_summary_of_a_big_installation_is_one_part_and_still_names_the_failing_step(client, db, mask):
    await login_as(client, db, "admin")
    await crowd(db)
    response = await ask(client, mask=mask, format="json")
    parts = response.json()["parts"]
    assert len(parts) == 1 and len(parts[0]["text"]) <= 12_000
    lines = parts[0]["text"].split("\n")
    assert max(map(len, lines)) <= 300
    assert LATEST.fullmatch(lines[1]) and lines[1].startswith('LATEST CHECK: source 5 "Meter 004" FAILED at tcp')
    assert verify_paste(parts[0]["text"].replace("\n", "\r\n")).ok  # through a Windows clipboard
    if mask:
        assert "10.9." not in parts[0]["text"]


@pytest.mark.parametrize("mask", [0, 1])
async def test_a_full_report_of_a_big_installation_stays_within_its_caps_and_survives_a_crlf_paste(client, db, mask):
    await login_as(client, db, "admin")
    await crowd(db)
    body = (await ask(client, detail="full", mask=mask, format="json")).json()
    parts = body["parts"]
    assert 1 < len(parts) <= 7 and all(len(part["text"]) <= 12_000 for part in parts)
    assert sum(part["chars"] for part in parts) <= 62_000
    text_ = "\n\n".join(part["text"] for part in parts)
    assert max(map(len, text_.split("\n"))) <= 300
    check = verify_paste(text_.replace("\n", "\r\n"))
    assert check.ok and check.parts == len(parts) and check.checksum == body["checksum"]
    plain = (await ask(client, detail="full", mask=mask)).text
    assert verify_paste(plain.replace("\n", "\r\n")).ok
    (_, second) = await audit_rows(db)
    assert second["parts"] == len(parts) and second["detail"] == "full"
