import asyncio
import logging
import time
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

from dcdash.collector import scan as scan_module
from dcdash.collector.jobs import run_pending_jobs
from dcdash.collector.scan import run_scan
from dcdash.connectors.base import ConnectionCheck, Claim, Connector, PointDescriptor, connector_types
from dcdash.connectors.opcua import OpcUaConfig, OpcUaConnector
from dcdash.core.crypto import encrypt
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import free_port, free_ports, http_server, make_source, modbus_server, opcua_server, silent_server

STAGES = ["sweep", "probe", "browse"]


async def make_scan(db, targets, ports, user=None) -> int:
    snapshot = {"targets": targets, "ports": ports, "hosts": 1, "pairs": len(ports)}
    return await db.fetchval(
        "INSERT INTO scans (scope_snapshot, started_by) VALUES ($1, $2) RETURNING id", snapshot, user
    )


@pytest.fixture
async def simulator_network():
    """HTTP, OPC UA and Modbus simulators on free ports; yields their ports."""
    sim = Simulator()
    async with http_server(create_sim_app(sim, api_key="k")) as http_port:
        async with opcua_server(sim) as opcua, modbus_server(sim) as modbus:
            yield {"http": http_port, "opcua": urlparse(opcua.endpoint).port, "modbus": modbus.port}


def all_ports(net):
    return [net["http"], net["opcua"], net["modbus"], free_port()]


def collapsed(stages):
    """The stage sequence with consecutive repeats removed (the progress writer repeats `sweep`)."""
    return [s for i, s in enumerate(stages) if i == 0 or s != stages[i - 1]]


def never_goes_backwards(stages):
    return all(STAGES.index(a) <= STAGES.index(b) for a, b in zip(stages, stages[1:]))


@pytest.fixture
def protocol_loggers():
    """Remember and restore the levels of the loggers a scan quietens."""
    loggers = [logging.getLogger("asyncua"), logging.getLogger("pymodbus")]
    saved = [logger.level for logger in loggers]
    yield loggers
    for logger, level in zip(loggers, saved):
        logger.setLevel(level)


async def test_scan_finds_adopts_and_browses_the_three_simulator_sources(db, simulator_network):
    scan = await make_scan(db, ["127.0.0.1"], all_ports(simulator_network))
    await run_scan(db, scan)
    row = await db.fetchrow("SELECT status, stage, error, progress, finished_at FROM scans WHERE id = $1", scan)
    assert row["status"] == "done" and row["error"] is None and row["finished_at"] is not None
    sources = await db.fetch("SELECT id, connector_type, origin, enabled, secret FROM sources ORDER BY connector_type")
    assert [s["connector_type"] for s in sources] == ["modbus", "opcua", "simulator"]
    assert all(s["origin"] == "discovered" and s["enabled"] is False and s["secret"] is None for s in sources)
    counts = {
        s["connector_type"]: await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", s["id"])
        for s in sources
    }
    assert counts == {"modbus": 60, "opcua": 60, "simulator": 0}  # the HTTP simulator needs its API key
    findings = await db.fetch("SELECT connector_type, outcome FROM scan_findings WHERE scan_id = $1", scan)
    assert {f["connector_type"]: f["outcome"] for f in findings} == {
        "modbus": "claimed", "opcua": "claimed", "simulator": "needs_credentials"
    }
    progress = row["progress"]
    assert progress["hosts"] == 1 and progress["open"] == 3 and progress["claimed"] == 3
    assert progress["points"] == 120 and progress["unidentified"] == 0 and progress["needs_credentials"] == 1


async def test_finding_details_use_the_documented_strings(db, simulator_network):
    await run_scan(db, await make_scan(db, ["127.0.0.1"], all_ports(simulator_network)))
    details = {
        r["connector_type"]: r["detail"] for r in await db.fetch("SELECT connector_type, detail FROM scan_findings")
    }
    assert details == {"modbus": "60 points", "opcua": "60 points", "simulator": "credentials rejected"}


async def test_scan_writes_a_finished_audit_row_for_the_starting_user(db, simulator_network):
    user = await db.fetchval(
        "INSERT INTO users (username, password_hash, role_id) VALUES ('a', 'x', 3) RETURNING id"
    )
    scan = await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]], user)
    await run_scan(db, scan)
    row = await db.fetchrow("SELECT user_id, detail FROM audit_log WHERE action = 'scan.finished'")
    assert row["user_id"] == user and row["detail"]["scan_id"] == scan and row["detail"]["status"] == "done"
    assert row["detail"]["claimed"] == 1


async def test_the_stage_moves_through_the_pipeline(db, simulator_network, monkeypatch):
    stages = []
    real = scan_module._set_stage

    async def spy(pool, scan_id, stage, progress):
        stages.append(stage)
        await real(pool, scan_id, stage, progress)

    monkeypatch.setattr(scan_module, "_set_stage", spy)
    await run_scan(db, await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]]))
    assert collapsed(stages) == STAGES and never_goes_backwards(stages)


async def test_a_slow_progress_write_never_overwrites_a_later_stage_or_the_final_progress(db, monkeypatch):
    """The background sweep write is still in flight when the sweep ends; it must land before probe."""
    written = []
    real = scan_module._set_stage

    async def slow_sweep_writes(pool, scan_id, stage, progress):
        if stage == "sweep":
            await asyncio.sleep(0.1)
        await real(pool, scan_id, stage, progress)
        written.append(stage)

    monkeypatch.setattr(scan_module, "_set_stage", slow_sweep_writes)
    monkeypatch.setattr(scan_module, "PROBE_TIMEOUT", 0.15)  # the silent port keeps the scan going past the slow write
    async with silent_server() as open_port:
        ports = free_ports(6) + [open_port]  # six different closed ports: the scan counts a repeated port once
        scan = await make_scan(db, ["127.0.0.1"], ports)
        await run_scan(db, scan)
    await asyncio.sleep(0.25)  # a stray late write would land now
    assert collapsed(written) == STAGES and never_goes_backwards(written)
    row = await db.fetchrow("SELECT status, stage, progress FROM scans WHERE id = $1", scan)
    assert row["status"] == "done" and row["stage"] == "browse"
    assert row["progress"]["checked"] == len(ports) and row["progress"]["open"] == 1


async def test_progress_counts_are_written_while_the_sweep_runs(db, monkeypatch):
    seen = []
    real = scan_module._set_stage

    async def spy(pool, scan_id, stage, progress):
        seen.append((stage, dict(progress)))
        await real(pool, scan_id, stage, progress)

    monkeypatch.setattr(scan_module, "_set_stage", spy)
    await run_scan(db, await make_scan(db, ["127.0.0.1"], free_ports(4)))
    assert any(stage == "sweep" and p["checked"] >= 1 for stage, p in seen)  # not only the 0-count first write
    assert seen[0][1]["pairs"] == 4 and seen[0][1]["hosts"] == 1


async def test_rescan_does_not_duplicate_and_leaves_adopted_sources_alone(db, simulator_network):
    ports = all_ports(simulator_network)
    await run_scan(db, await make_scan(db, ["127.0.0.1"], ports))
    modbus_id = await db.fetchval("SELECT id FROM sources WHERE connector_type = 'modbus'")
    await db.execute(
        "UPDATE sources SET enabled = true, name = 'Main meter', secret = 'sealed', "
        "config = config || '{\"timeout_seconds\": 9.0}'::jsonb WHERE id = $1", modbus_id,
    )
    before = await db.fetchrow("SELECT * FROM sources WHERE id = $1", modbus_id)
    await run_scan(db, await make_scan(db, ["127.0.0.1"], ports))
    assert await db.fetchval("SELECT count(*) FROM sources") == 3
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", modbus_id) == 60
    after = await db.fetchrow("SELECT * FROM sources WHERE id = $1", modbus_id)
    for column in ("name", "config", "secret", "enabled", "origin", "connector_type", "identity"):
        assert after[column] == before[column]
    assert after["identity"] is None  # on purpose: a Modbus device names no one, and a rescan writes nothing to it
    finding = await db.fetchrow(
        "SELECT source_id, outcome FROM scan_findings WHERE connector_type = 'modbus' ORDER BY scan_id DESC LIMIT 1"
    )
    assert finding["source_id"] == modbus_id and finding["outcome"] == "claimed"


async def test_rescan_keeps_a_credential_less_discovered_source_flagged_as_needing_credentials(db, simulator_network):
    ports = [simulator_network["http"]]
    await run_scan(db, await make_scan(db, ["127.0.0.1"], ports))
    await run_scan(db, await make_scan(db, ["127.0.0.1"], ports))
    assert await db.fetchval("SELECT count(*) FROM sources") == 1
    assert await db.fetchval("SELECT count(*) FROM points") == 0
    finding = await db.fetchrow(
        "SELECT outcome, detail FROM scan_findings WHERE connector_type = 'simulator' ORDER BY scan_id DESC LIMIT 1"
    )
    assert finding["outcome"] == "needs_credentials" and finding["detail"] == "credentials rejected"
    source = await db.fetchrow("SELECT status, last_error FROM sources")
    assert source["status"] == "offline" and source["last_error"] == "credentials rejected"


async def test_a_rescan_clears_the_stale_error_once_the_credentials_were_fixed(db, simulator_network):
    ports = [simulator_network["http"]]
    await run_scan(db, await make_scan(db, ["127.0.0.1"], ports))
    source = await db.fetchrow("SELECT id, status, last_error FROM sources")
    assert source["status"] == "offline" and source["last_error"] == "credentials rejected"
    await db.execute("UPDATE sources SET secret = $2 WHERE id = $1", source["id"], encrypt("k"))  # the admin enters it
    scan = await make_scan(db, ["127.0.0.1"], ports)
    await run_scan(db, scan)
    finding = await db.fetchrow("SELECT outcome, detail FROM scan_findings WHERE scan_id = $1", scan)
    assert finding["outcome"] == "claimed" and finding["detail"] == "60 points"
    row = await db.fetchrow("SELECT status, last_error, last_seen FROM sources WHERE id = $1", source["id"])
    assert row["status"] == "online" and row["last_error"] is None and row["last_seen"] is not None


async def test_an_unusable_stored_secret_is_a_browse_failure_not_a_failed_scan(db, simulator_network):
    ports = [simulator_network["modbus"]]
    await run_scan(db, await make_scan(db, ["127.0.0.1"], ports))
    await db.execute("UPDATE sources SET secret = 'not-a-valid-token'")  # cannot be decrypted
    scan = await make_scan(db, ["127.0.0.1"], ports)
    await run_scan(db, scan)
    assert await db.fetchval("SELECT status FROM scans WHERE id = $1", scan) == "done"
    finding = await db.fetchrow("SELECT outcome, detail FROM scan_findings WHERE scan_id = $1", scan)
    assert finding["outcome"] == "claimed"
    assert finding["detail"].startswith("browse failed: ") and len(finding["detail"]) > len("browse failed: ")
    assert await db.fetchval("SELECT status FROM sources") == "offline"


async def test_a_hand_added_source_addressed_by_name_is_reused_not_duplicated(db, simulator_network):
    manual = await make_source(
        db, "plc", "modbus", {"host": "localhost", "port": simulator_network["modbus"], "unit_id": 1, "profile": "auto"}
    )
    await run_scan(db, await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]]))
    assert await db.fetchval("SELECT count(*) FROM sources") == 1
    assert await db.fetchval("SELECT origin FROM sources WHERE id = $1", manual) == "manual"
    assert await db.fetchval("SELECT source_id FROM scan_findings") == manual
    assert await db.fetchval("SELECT detail FROM scan_findings") == "existing source"
    assert await db.fetchval("SELECT count(*) FROM points") == 0  # a hand-added source is not browsed


def modbus_config(simulator_network, host="localhost"):
    return {"host": host, "port": simulator_network["modbus"], "unit_id": 1, "profile": "auto"}


async def scan_modbus(db, simulator_network) -> int:
    scan = await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]])
    await run_scan(db, scan)
    return scan


async def test_a_hand_added_source_added_after_a_discovered_duplicate_wins_the_next_scan(db, simulator_network):
    await scan_modbus(db, simulator_network)
    discovered = await db.fetchval("SELECT id FROM sources")
    manual = await make_source(db, "plc", "modbus", modbus_config(simulator_network))  # same device, a higher id
    assert manual > discovered and await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", discovered) == 60
    before = await db.fetchrow("SELECT * FROM sources WHERE id = $1", discovered)
    scan = await scan_modbus(db, simulator_network)
    finding = await db.fetchrow("SELECT source_id, outcome, detail FROM scan_findings WHERE scan_id = $1", scan)
    assert dict(finding) == {"source_id": manual, "outcome": "claimed", "detail": "existing source"}
    assert (await db.fetchval("SELECT progress FROM scans WHERE id = $1", scan))["points"] == 0  # nothing was browsed
    # Nothing is merged, moved or deleted: both sources and the duplicate's points are as they were.
    assert await db.fetchval("SELECT count(*) FROM sources") == 2
    assert await db.fetchrow("SELECT * FROM sources WHERE id = $1", discovered) == before
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", discovered) == 60
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", manual) == 0
    assert await db.fetchval("SELECT origin FROM sources WHERE id = $1", manual) == "manual"


async def test_two_discovered_sources_at_one_endpoint_still_resolve_to_the_oldest(db, simulator_network):
    await scan_modbus(db, simulator_network)
    oldest = await db.fetchval("SELECT id FROM sources")
    newer = await make_source(db, "later duplicate", "modbus", modbus_config(simulator_network))
    await db.execute("UPDATE sources SET origin = 'discovered', enabled = false WHERE id = $1", newer)
    scan = await scan_modbus(db, simulator_network)
    finding = await db.fetchrow("SELECT source_id, outcome, detail FROM scan_findings WHERE scan_id = $1", scan)
    assert dict(finding) == {"source_id": oldest, "outcome": "claimed", "detail": "60 points"}
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", newer) == 0  # only the oldest was browsed


async def test_two_hand_added_sources_at_one_endpoint_still_resolve_to_the_oldest(db, simulator_network):
    first = await make_source(db, "plc one", "modbus", modbus_config(simulator_network))
    await make_source(db, "plc two", "modbus", modbus_config(simulator_network, "127.0.0.1"))
    scan = await scan_modbus(db, simulator_network)
    finding = await db.fetchrow("SELECT source_id, outcome, detail FROM scan_findings WHERE scan_id = $1", scan)
    assert dict(finding) == {"source_id": first, "outcome": "claimed", "detail": "existing source"}
    assert await db.fetchval("SELECT count(*) FROM sources") == 2


async def test_a_hand_added_source_at_another_endpoint_changes_nothing_for_a_discovered_one(db, simulator_network):
    await scan_modbus(db, simulator_network)
    discovered = await db.fetchval("SELECT id FROM sources")
    other = {**modbus_config(simulator_network), "port": free_port()}
    await make_source(db, "somewhere else", "modbus", other)
    scan = await scan_modbus(db, simulator_network)
    finding = await db.fetchrow("SELECT source_id, outcome, detail FROM scan_findings WHERE scan_id = $1", scan)
    assert dict(finding) == {"source_id": discovered, "outcome": "claimed", "detail": "60 points"}  # browsed again
    assert await db.fetchval("SELECT count(*) FROM sources") == 2


async def test_one_device_reached_by_name_and_by_address_becomes_one_source(db, simulator_network):
    port = simulator_network["modbus"]
    await run_scan(db, await make_scan(db, ["127.0.0.1", "localhost"], [port]))
    assert await db.fetchval("SELECT count(*) FROM sources") == 1
    assert await db.fetchval("SELECT count(DISTINCT source_id) FROM scan_findings") == 1
    assert await db.fetchval("SELECT count(*) FROM scan_findings") == 2
    assert (await db.fetchval("SELECT progress FROM scans"))["points"] == 60  # browsed once, counted once


async def test_a_label_that_clashes_with_an_existing_source_name_gets_a_number(db, simulator_network):
    ports = [simulator_network["modbus"]]
    await run_scan(db, await make_scan(db, ["127.0.0.1"], ports))
    first = await db.fetchrow("SELECT id, name FROM sources")
    # Point the first source elsewhere: the next scan finds a "new" device with the same label.
    await db.execute(
        "UPDATE sources SET config = config || '{\"host\": \"10.9.9.9\"}'::jsonb WHERE id = $1", first["id"]
    )
    await run_scan(db, await make_scan(db, ["127.0.0.1"], ports))
    names = [r["name"] for r in await db.fetch("SELECT name FROM sources ORDER BY id")]
    assert names == [first["name"], f"{first['name']} (2)"]


async def test_a_service_that_never_answers_is_unclaimed_and_does_not_stall_the_scan(db, monkeypatch):
    monkeypatch.setattr(scan_module, "PROBE_TIMEOUT", 0.4)
    async with silent_server() as port:
        scan = await make_scan(db, ["127.0.0.1"], [port, free_port()])
        started = time.perf_counter()
        await run_scan(db, scan)
        elapsed = time.perf_counter() - started
    # Connectors are probed one after another, each bounded by PROBE_TIMEOUT (+1 s outer guard).
    assert elapsed < len(connector_types()) * (0.4 + 1) + 2
    finding = await db.fetchrow("SELECT outcome, source_id, detail FROM scan_findings")
    assert finding["outcome"] == "unclaimed" and finding["source_id"] is None
    assert finding["detail"] == "no connector recognised the service"
    assert await db.fetchval("SELECT status FROM scans WHERE id = $1", scan) == "done"
    assert await db.fetchval("SELECT count(*) FROM sources") == 0
    assert (await db.fetchval("SELECT progress FROM scans WHERE id = $1", scan))["unidentified"] == 1


@pytest.mark.parametrize("host", ["a..b", "a" * 300])
async def test_a_hand_added_source_with_a_malformed_host_does_not_break_the_scan(db, simulator_network, host):
    bad = await make_source(
        db, "bad host", "modbus", {"host": host, "port": 502, "unit_id": 1, "profile": "auto"}, enabled=False
    )
    scan = await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]])
    await run_scan(db, scan)
    assert await db.fetchval("SELECT status FROM scans WHERE id = $1", scan) == "done"
    finding = await db.fetchrow("SELECT source_id, outcome, detail FROM scan_findings")
    assert finding["source_id"] != bad and finding["outcome"] == "claimed" and finding["detail"] == "60 points"
    assert await db.fetchval("SELECT count(*) FROM sources") == 2  # the bad source was simply not matched
    assert await db.fetchval("SELECT origin FROM sources WHERE id = $1", bad) == "manual"


async def test_a_scope_that_finds_nothing_completes(db):
    scan = await make_scan(db, ["127.0.0.1"], [free_port()])
    await run_scan(db, scan)
    row = await db.fetchrow("SELECT status, progress FROM scans WHERE id = $1", scan)
    assert row["status"] == "done" and row["progress"]["open"] == 0
    assert await db.fetchval("SELECT count(*) FROM scan_findings") == 0


async def test_a_scan_finishes_done_when_its_starting_user_is_deleted_mid_run(db, monkeypatch):
    """run_scan reads started_by once at its start; deleting that account later must not turn the scan into a failure."""
    user = await db.fetchval(
        "INSERT INTO users (username, password_hash, role_id) VALUES ('a', 'x', 3) RETURNING id"
    )
    scan = await make_scan(db, ["127.0.0.1"], [free_port()], user)
    real = scan_module._record_findings

    async def delete_the_user_then_record(pool, scan_id, findings):
        await db.execute("DELETE FROM users WHERE id = $1", user)
        await real(pool, scan_id, findings)

    monkeypatch.setattr(scan_module, "_record_findings", delete_the_user_then_record)
    await run_scan(db, scan)
    row = await db.fetchrow("SELECT status, error, started_by FROM scans WHERE id = $1", scan)
    assert row["status"] == "done" and row["error"] is None and row["started_by"] is None
    audit = await db.fetchrow("SELECT user_id, detail FROM audit_log WHERE action = 'scan.finished'")
    assert audit["user_id"] is None and audit["detail"]["scan_id"] == scan and audit["detail"]["status"] == "done"


async def test_an_invalid_snapshot_fails_the_scan_with_a_reason_and_audits_it(db):
    scan = await make_scan(db, ["not a host!"], [502])
    with pytest.raises(Exception):
        await run_scan(db, scan)
    row = await db.fetchrow("SELECT status, error, finished_at, progress FROM scans WHERE id = $1", scan)
    assert row["status"] == "failed" and "not a valid host" in row["error"] and row["finished_at"] is not None
    detail = await db.fetchval("SELECT detail FROM audit_log WHERE action = 'scan.finished'")
    assert detail["status"] == "failed" and "not a valid host" in detail["error"]
    assert set(detail) >= set(scan_module._PROGRESS_KEYS)  # a failed scan still reports every counter


async def test_the_host_cap_is_applied_inside_the_scan(db, monkeypatch):
    monkeypatch.setattr(scan_module, "get_settings", lambda: SimpleNamespace(scan_max_hosts=4))
    scan = await make_scan(db, ["10.0.0.0/24"], [502])
    with pytest.raises(Exception):
        await run_scan(db, scan)
    row = await db.fetchrow("SELECT status, error FROM scans WHERE id = $1", scan)
    assert row["status"] == "failed" and "limit is 4 hosts" in row["error"]


async def test_a_missing_scan_raises(db):
    with pytest.raises(LookupError):
        await run_scan(db, 999)


async def test_the_scan_job_kind_runs_through_the_job_runner(db, simulator_network):
    scan = await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]])
    job = await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('scan', $1) RETURNING id", {"scan_id": scan})
    assert await run_pending_jobs(db) == 1
    row = await db.fetchrow("SELECT status, result FROM jobs WHERE id = $1", job)
    assert row["status"] == "done" and row["result"] == {"scan_id": scan}
    assert await db.fetchval("SELECT status FROM scans WHERE id = $1", scan) == "done"


async def test_protocol_loggers_are_quietened_during_a_scan_and_restored_after(db, protocol_loggers, monkeypatch):
    asyncua, pymodbus = protocol_loggers
    asyncua.setLevel(logging.INFO)
    pymodbus.setLevel(logging.NOTSET)
    during = []
    real = scan_module._set_stage

    async def spy(pool, scan_id, stage, progress):
        during.append((asyncua.level, pymodbus.level))
        await real(pool, scan_id, stage, progress)

    monkeypatch.setattr(scan_module, "_set_stage", spy)
    await run_scan(db, await make_scan(db, ["127.0.0.1"], [free_port()]))
    assert during and all(levels == (logging.ERROR, logging.ERROR) for levels in during)
    assert (asyncua.level, pymodbus.level) == (logging.INFO, logging.NOTSET)


async def test_protocol_loggers_are_restored_when_the_scan_fails(db, protocol_loggers):
    asyncua, pymodbus = protocol_loggers
    asyncua.setLevel(logging.DEBUG)
    pymodbus.setLevel(logging.WARNING)
    with pytest.raises(Exception):
        await run_scan(db, await make_scan(db, ["not a host!"], [502]))
    assert (asyncua.level, pymodbus.level) == (logging.DEBUG, logging.WARNING)


def test_overlapping_quiet_sections_restore_the_original_levels_only_when_the_last_one_ends(protocol_loggers):
    asyncua, pymodbus = protocol_loggers
    asyncua.setLevel(logging.INFO)
    pymodbus.setLevel(logging.NOTSET)
    first, second = scan_module._quiet_protocol_loggers(), scan_module._quiet_protocol_loggers()
    first.__enter__()
    second.__enter__()
    first.__exit__(None, None, None)
    assert (asyncua.level, pymodbus.level) == (logging.ERROR, logging.ERROR)
    second.__exit__(None, None, None)
    assert (asyncua.level, pymodbus.level) == (logging.INFO, logging.NOTSET)


LEAKY = "connect failed: http://svc:Zq9-unique-pw@host:9000/x (timeout)"
SCRUBBED = "connect failed: http://[hidden]@host:9000/x (timeout)"


async def test_a_failed_scan_stores_its_error_and_audit_row_without_the_url_credentials(db, monkeypatch):
    async def boom(*_args, **_kwargs):
        raise RuntimeError(LEAKY)

    monkeypatch.setattr(scan_module, "_sweep_stage", boom)
    scan = await make_scan(db, ["127.0.0.1"], [free_port()])
    with pytest.raises(RuntimeError):
        await run_scan(db, scan)
    assert await db.fetchval("SELECT error FROM scans WHERE id = $1", scan) == SCRUBBED
    detail = await db.fetchval("SELECT detail FROM audit_log WHERE action = 'scan.finished'")
    assert detail["status"] == "failed" and detail["error"] == SCRUBBED


async def test_a_browse_failure_is_stored_in_the_finding_and_the_source_without_the_url_credentials(
    db, simulator_network
):
    def raising(*_args):
        raise RuntimeError(LEAKY)

    scan = await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]])
    await run_scan(db, scan, raising)
    assert await db.fetchval("SELECT status FROM scans WHERE id = $1", scan) == "done"
    finding = await db.fetchrow("SELECT outcome, detail FROM scan_findings WHERE scan_id = $1", scan)
    assert finding["outcome"] == "claimed" and finding["detail"] == f"browse failed: {SCRUBBED}"
    assert await db.fetchval("SELECT last_error FROM sources") == SCRUBBED


# Error text of 5000 characters whose URL password starts at character 995: a cut at 1000 before the scrub would leave
# half of it behind.
HUGE = "a" * 984 + "http://svc:Zq9-unique-pw@host:9000/x " + "b" * 5000


def assert_cut_and_scrubbed(text: str) -> None:
    assert len(text) <= 1000 and text.startswith("a" * 984 + "http://[hidden]")
    assert "Zq9" not in text and "unique" not in text


async def test_a_failed_scan_stores_a_huge_error_scrubbed_and_cut_in_the_scan_and_the_audit_row(db, monkeypatch):
    async def boom(*_args, **_kwargs):
        raise RuntimeError(HUGE)

    monkeypatch.setattr(scan_module, "_sweep_stage", boom)
    scan = await make_scan(db, ["127.0.0.1"], [free_port()])
    with pytest.raises(RuntimeError):
        await run_scan(db, scan)
    assert_cut_and_scrubbed(await db.fetchval("SELECT error FROM scans WHERE id = $1", scan))
    detail = await db.fetchval("SELECT detail FROM audit_log WHERE action = 'scan.finished'")
    assert_cut_and_scrubbed(detail["error"])


async def test_a_huge_browse_failure_is_scrubbed_and_cut_in_the_finding_and_the_source(db, simulator_network):
    def raising(*_args):
        raise RuntimeError(HUGE)

    scan = await make_scan(db, ["127.0.0.1"], [simulator_network["modbus"]])
    await run_scan(db, scan, raising)
    finding = await db.fetchrow("SELECT outcome, detail FROM scan_findings WHERE scan_id = $1", scan)
    assert finding["outcome"] == "claimed"
    assert len(finding["detail"]) <= 1000 and finding["detail"].startswith("browse failed: " + "a" * 900)
    assert "Zq9" not in finding["detail"] and "unique" not in finding["detail"]
    assert_cut_and_scrubbed(await db.fetchval("SELECT last_error FROM sources"))


# --- a server's identity: stored when the source is created, remembered and compared when the scan meets it again ----------------

SERVER_A = {"application_uri": "urn:plant:meters:a", "application_name": "Meters A", "thumbprint": "AA:BB:CC:DD"}
SERVER_B = {"application_uri": "urn:plant:meters:b", "application_name": "Meters B", "thumbprint": "11:22:33:44"}


def identifying_opcua(answer):
    """An OPC UA connector whose probe recognises ANY open port and names itself with `answer` (a dict, `{}` or None); it counts
    the browses it is asked for."""

    class Stub(Connector):
        type = "opcua"
        config_schema = OpcUaConfig
        browses = 0

        @classmethod
        async def probe(cls, host, port, timeout=3.0):
            config = OpcUaConfig(endpoint=f"opc.tcp://{host}:{port}/dcdash/").model_dump(mode="json")
            return Claim("opcua", config, f"OPC UA server at {host}:{port}", identity=answer)

        @classmethod
        def endpoint_key(cls, config):
            return OpcUaConnector.endpoint_key(config)

        async def test(self):
            return ConnectionCheck(True, "ok")

        async def browse(self):
            type(self).browses += 1
            return [PointDescriptor("ns=2;s=a", "A"), PointDescriptor("ns=2;s=b", "B")]

        async def read(self, addresses):
            return []

    def factory(type_name, config, secret):
        return Stub(OpcUaConfig(**config), secret)

    return Stub, factory


async def scan_stub(db, port, stub, factory) -> int:
    scan = await make_scan(db, ["127.0.0.1"], [port])
    await run_scan(db, scan, factory, {"opcua": stub})
    return scan


async def journal_rows(db):
    return await db.fetch("SELECT level, kind, message, source_id, detail FROM diag_events ORDER BY id")


async def test_a_new_source_is_created_with_the_identity_its_probe_found(db):
    stub, factory = identifying_opcua(SERVER_A)
    async with silent_server() as port:
        await scan_stub(db, port, stub, factory)
    row = await db.fetchrow("SELECT identity, origin, enabled FROM sources")
    assert row["identity"] == SERVER_A and row["origin"] == "discovered" and row["enabled"] is False
    assert await db.fetchval("SELECT count(*) FROM points") == 2


async def test_a_probe_without_an_identity_leaves_the_column_null(db):
    for answer in (None, {}):
        await db.execute("TRUNCATE sources CASCADE")
        stub, factory = identifying_opcua(answer)
        async with silent_server() as port:
            await scan_stub(db, port, stub, factory)
        assert await db.fetchval("SELECT count(*) FROM sources") == 1
        assert await db.fetchval("SELECT identity FROM sources") is None


async def test_meeting_the_same_server_again_changes_nothing_and_browses_it_as_before(db):
    stub, factory = identifying_opcua(SERVER_A)
    async with silent_server() as port:
        await scan_stub(db, port, stub, factory)
        second = await scan_stub(db, port, stub, factory)
    assert await db.fetchval("SELECT count(*) FROM sources") == 1
    assert await db.fetchval("SELECT identity FROM sources") == SERVER_A
    assert stub.browses == 2
    finding = await db.fetchrow("SELECT outcome, detail FROM scan_findings WHERE scan_id = $1", second)
    assert (finding["outcome"], finding["detail"]) == ("claimed", "2 points")
    assert await journal_rows(db) == []


async def test_a_discovered_source_without_an_identity_learns_it_on_the_next_scan(db):
    stub, factory = identifying_opcua(None)
    async with silent_server() as port:
        await scan_stub(db, port, stub, factory)
        assert await db.fetchval("SELECT identity FROM sources") is None
        stub, factory = identifying_opcua(SERVER_A)  # the same address, now a server that names itself
        await scan_stub(db, port, stub, factory)
    assert await db.fetchval("SELECT count(*) FROM sources") == 1
    assert await db.fetchval("SELECT identity FROM sources") == SERVER_A


async def test_another_server_at_a_discovered_sources_address_is_not_browsed_and_is_reported(db):
    stub, factory = identifying_opcua(SERVER_A)
    async with silent_server() as port:
        await scan_stub(db, port, stub, factory)
        source = await db.fetchval("SELECT id FROM sources")
        await db.execute("UPDATE points SET name = 'kept as it was'")
        other, other_factory = identifying_opcua(SERVER_B)
        second = await scan_stub(db, port, other, other_factory)
    assert other.browses == 0  # the points of the first server are not refreshed from the second
    finding = await db.fetchrow("SELECT source_id, outcome, detail FROM scan_findings WHERE scan_id = $1", second)
    assert dict(finding) == {"source_id": source, "outcome": "claimed", "detail": "a different server answers here"}
    assert await db.fetchval("SELECT count(*) FROM points WHERE name = 'kept as it was'") == 2
    stored = await db.fetchval("SELECT identity FROM sources")
    assert stored["application_uri"] == SERVER_A["application_uri"] and stored["different"]["application_uri"] == SERVER_B["application_uri"]
    assert await db.fetchval("SELECT count(*) FROM sources") == 1
    rows = await journal_rows(db)
    assert [(r["level"], r["kind"], r["source_id"]) for r in rows] == [("warning", "source.identity_changed", source)]


async def test_a_hand_added_source_learns_its_identity_and_keeps_its_finding(db):
    stub, factory = identifying_opcua(SERVER_A)
    async with silent_server() as port:
        manual = await make_source(db, "plc", "opcua", {"endpoint": f"opc.tcp://localhost:{port}/dcdash/"}, enabled=False)
        scan = await scan_stub(db, port, stub, factory)
    assert await db.fetchval("SELECT identity FROM sources WHERE id = $1", manual) == SERVER_A
    finding = await db.fetchrow("SELECT source_id, outcome, detail FROM scan_findings WHERE scan_id = $1", scan)
    assert dict(finding) == {"source_id": manual, "outcome": "claimed", "detail": "existing source"}
    assert await db.fetchval("SELECT count(*) FROM sources") == 1 and stub.browses == 0


async def test_another_server_at_a_hand_added_sources_address_is_noted_but_the_finding_is_unchanged(db):
    stub, factory = identifying_opcua(SERVER_B)
    async with silent_server() as port:
        manual = await make_source(db, "plc", "opcua", {"endpoint": f"opc.tcp://127.0.0.1:{port}/dcdash/"}, enabled=False)
        await db.execute("UPDATE sources SET identity = $2 WHERE id = $1", manual, SERVER_A)
        scan = await scan_stub(db, port, stub, factory)
    finding = await db.fetchrow("SELECT outcome, detail FROM scan_findings WHERE scan_id = $1", scan)
    assert (finding["outcome"], finding["detail"]) == ("claimed", "existing source")
    assert (await db.fetchval("SELECT identity FROM sources"))["different"]["application_uri"] == SERVER_B["application_uri"]
    assert [r["source_id"] for r in await journal_rows(db)] == [manual]


async def test_a_source_configured_by_name_learns_the_identity_of_the_server_the_scan_found(db):
    stub, factory = identifying_opcua(SERVER_A)
    async with silent_server() as port:
        named = await make_source(db, "by name", "opcua", {"endpoint": f"opc.tcp://localhost:{port}/dcdash/"}, enabled=False)
        await scan_stub(db, port, stub, factory)  # found at 127.0.0.1, the same device as "localhost"
    assert await db.fetchval("SELECT identity FROM sources WHERE id = $1", named) == SERVER_A


async def test_a_source_moved_while_the_scan_was_adopting_is_not_given_the_old_addresss_identity(db, monkeypatch):
    stub, factory = identifying_opcua(SERVER_A)
    real = scan_module.remember_safely

    async def moved_first(pool, source_id, seen, *, expected_config):
        await pool.execute(
            "UPDATE sources SET config = $2 WHERE id = $1", source_id, {"endpoint": "opc.tcp://10.9.9.9:4840/dcdash/"}
        )
        return await real(pool, source_id, seen, expected_config=expected_config)

    monkeypatch.setattr(scan_module, "remember_safely", moved_first)
    async with silent_server() as port:
        manual = await make_source(db, "plc", "opcua", {"endpoint": f"opc.tcp://127.0.0.1:{port}/dcdash/"}, enabled=False)
        await scan_stub(db, port, stub, factory)
    assert await db.fetchval("SELECT identity FROM sources WHERE id = $1", manual) is None


async def test_a_failure_to_remember_never_fails_the_scan(db, monkeypatch):
    async def broken(*_args, **_kwargs):
        raise RuntimeError("the database hiccuped")

    monkeypatch.setattr("dcdash.collector.identity.remember", broken)
    stub, factory = identifying_opcua(SERVER_A)
    async with silent_server() as port:
        manual = await make_source(db, "plc", "opcua", {"endpoint": f"opc.tcp://127.0.0.1:{port}/dcdash/"}, enabled=False)
        scan = await scan_stub(db, port, stub, factory)
    assert await db.fetchval("SELECT status FROM scans WHERE id = $1", scan) == "done"
    assert await db.fetchval("SELECT identity FROM sources WHERE id = $1", manual) is None
