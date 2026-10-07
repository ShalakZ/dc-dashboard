import asyncio
import logging
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

from dcdash.collector import scan as scan_module
from dcdash.collector.jobs import run_pending_jobs
from dcdash.collector.scan import run_scan
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import free_port, http_server, make_source, modbus_server, opcua_server, silent_server

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
        "INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'admin') RETURNING id"
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
        ports = [free_port() for _ in range(6)] + [open_port]
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
    await run_scan(db, await make_scan(db, ["127.0.0.1"], [free_port() for _ in range(4)]))
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
    for column in ("name", "config", "secret", "enabled", "origin", "connector_type"):
        assert after[column] == before[column]
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
        await run_scan(db, scan)
    finding = await db.fetchrow("SELECT outcome, source_id, detail FROM scan_findings")
    assert finding["outcome"] == "unclaimed" and finding["source_id"] is None
    assert finding["detail"] == "no connector recognised the service"
    assert await db.fetchval("SELECT status FROM scans WHERE id = $1", scan) == "done"
    assert await db.fetchval("SELECT count(*) FROM sources") == 0
    assert (await db.fetchval("SELECT progress FROM scans WHERE id = $1", scan))["unidentified"] == 1


async def test_a_scope_that_finds_nothing_completes(db):
    scan = await make_scan(db, ["127.0.0.1"], [free_port()])
    await run_scan(db, scan)
    row = await db.fetchrow("SELECT status, progress FROM scans WHERE id = $1", scan)
    assert row["status"] == "done" and row["progress"]["open"] == 0
    assert await db.fetchval("SELECT count(*) FROM scan_findings") == 0


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
