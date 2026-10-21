"""The `file` connector (w31): a source that is filled by importing files, never polled, tested or browsed."""
import pytest
from pydantic import ValidationError

from dcdash.collector.browse import browse_source
from dcdash.collector.jobs import run_pending_jobs
from dcdash.collector.scheduler import load_groups
from dcdash.connectors.base import ConnectionCheck, ConnectorError, connector_types, create_connector
from dcdash.connectors.file import FileConnector
from helpers import make_asset, make_mapping, make_point, make_source


def test_the_file_type_is_registered_and_is_the_only_one_that_does_not_poll():
    assert connector_types()["file"] is FileConnector
    assert {name: cls.polls for name, cls in connector_types().items() if cls.__module__.startswith("dcdash.")} == {
        "file": False, "modbus": True, "opcua": True, "simulator": True,
    }
    assert FileConnector.supports_history is False and FileConnector.default_ports == ()


def test_only_the_file_type_has_a_description():
    described = {name for name, cls in connector_types().items() if cls.description}
    assert "file" in described and "importing" in connector_types()["file"].description
    assert {"modbus", "opcua", "simulator"}.isdisjoint(described)


def test_the_config_is_empty_and_refuses_anything_else():
    assert create_connector("file", {}).config.model_dump() == {}
    assert FileConnector.config_schema.model_json_schema().get("properties", {}) == {}
    with pytest.raises(ValidationError):
        create_connector("file", {"host": "10.0.0.5"})


async def test_test_says_the_source_is_filled_by_importing_files():
    connector = create_connector("file", {})
    assert await connector.test() == ConnectionCheck(True, "ok", None, "this source is filled by importing files")


async def test_browse_finds_nothing_and_read_is_refused():
    connector = create_connector("file", {})
    assert await connector.browse() == []
    with pytest.raises(ConnectorError) as raised:
        await connector.read(["TAG-A"])
    assert raised.value.status == "not_supported"
    await connector.close()


async def test_a_default_check_runs_the_test_step(db):
    result = await create_connector("file", {}).check([])
    assert [(step.id, step.ok) for step in result.steps] == [("test", True)]


async def test_the_poll_loop_never_groups_the_points_of_a_file_source(db):
    asset = await make_asset(db, "panel")
    source = await make_source(db, "imports", connector_type="file")
    await make_mapping(db, await make_point(db, source, "TAG-A"), asset, "active_power_kw", 5)
    assert await load_groups(db) == []
    live = await make_source(db, "live", config={"url": "http://sim/"})
    await make_mapping(db, await make_point(db, live, "p1"), asset, "voltage_v", 5)
    assert [group.source_id for group in await load_groups(db)] == [live]


async def test_a_test_job_for_a_file_source_answers_ok_and_leaves_the_status_alone(db):
    source = await make_source(db, "imports", connector_type="file")
    job_id = await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('test_source', $1) RETURNING id", {"source_id": source})
    assert await run_pending_jobs(db) == 1
    row = await db.fetchrow("SELECT status, result FROM jobs WHERE id = $1", job_id)
    assert row["status"] == "done" and row["result"]["ok"] is True
    state = await db.fetchrow("SELECT status, last_seen, last_error FROM sources WHERE id = $1", source)
    assert (state["status"], state["last_seen"], state["last_error"]) == ("unknown", None, None)


async def test_a_check_job_for_a_file_source_leaves_the_status_alone(db):
    source = await make_source(db, "imports", connector_type="file")
    job_id = await db.fetchval(
        "INSERT INTO jobs (kind, params) VALUES ('check_connection', $1) RETURNING id", {"source_id": source}
    )
    assert await run_pending_jobs(db) == 1
    assert (await db.fetchval("SELECT status FROM jobs WHERE id = $1", job_id)) == "done"
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "unknown"


async def test_a_browse_of_a_file_source_stores_no_point_and_leaves_the_status_alone(db):
    source = await make_source(db, "imports", connector_type="file")
    point = await make_point(db, source, "TAG-A")
    assert await browse_source(db, source, create_connector) == 0
    assert await db.fetchval("SELECT count(*) FROM points WHERE source_id = $1", source) == 1  # nothing added, nothing removed
    assert await db.fetchval("SELECT id FROM points WHERE source_id = $1", source) == point
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "unknown"
