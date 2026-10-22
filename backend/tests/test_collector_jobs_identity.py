"""Test and the connection check ask the server who it is after a decisive success, and remember the answer."""
import json

from dcdash.collector import jobs as jobs_module
from dcdash.collector.jobs import run_pending_jobs
from dcdash.connectors.base import ConnectionCheck, Connector
from dcdash.connectors.opcua import OpcUaConfig
from dcdash.connectors.simulator import SimulatorConfig
from helpers import make_source

SERVER_A = {"instance": "plant-a"}
SERVER_B = {"instance": "plant-b"}


class Stub(Connector):
    """A simulator connector that answers `test()` as told and names itself with `answer` (or raises)."""

    type = "simulator"
    config_schema = SimulatorConfig
    ok = True
    answer: dict | None = None
    raises = False
    on_identity = None  # an async callable run inside identity(), before it answers

    def __init__(self, config, secret=None):
        super().__init__(config, secret)
        self.calls: list[str] = []

    async def test(self):
        self.calls.append("test")
        return ConnectionCheck(self.ok, "ok" if self.ok else "unreachable", 1.0, "" if self.ok else "no answer")

    async def browse(self):
        return []

    async def read(self, addresses):
        return []

    async def identity(self):
        self.calls.append("identity")
        if self.on_identity is not None:
            await self.on_identity()
        if self.raises:
            raise RuntimeError("the server said something odd")
        return self.answer

    async def close(self):
        self.calls.append("close")


def stub_factory(**attributes):
    made: list[Stub] = []
    kind = type("ConfiguredStub", (Stub,), attributes)

    def factory(type_name, config, secret):
        made.append(kind(kind.config_schema(**config), secret))
        return made[-1]

    return factory, made


async def add_job(db, kind, source_id) -> int:
    return await db.fetchval("INSERT INTO jobs (kind, params) VALUES ($1, $2) RETURNING id", kind, {"source_id": source_id})


async def run(db, kind, source, **attributes):
    factory, made = stub_factory(**attributes)
    job_id = await add_job(db, kind, source)
    await run_pending_jobs(db, factory)
    return await db.fetchrow("SELECT status, result FROM jobs WHERE id = $1", job_id), made[0]


async def identity_of(db, source):
    return await db.fetchval("SELECT identity FROM sources WHERE id = $1", source)


async def test_a_successful_test_asks_who_the_server_is_before_closing_and_remembers_it(db):
    source = await make_source(db)
    row, connector = await run(db, "test_source", source, answer=SERVER_A)
    assert row["status"] == "done" and row["result"]["ok"] is True
    assert connector.calls == ["test", "identity", "close"]
    assert await identity_of(db, source) == SERVER_A
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "online"


async def test_a_test_that_fails_does_not_ask(db):
    source = await make_source(db)
    row, connector = await run(db, "test_source", source, ok=False, answer=SERVER_A)
    assert row["status"] == "done" and row["result"]["ok"] is False
    assert connector.calls == ["test", "close"]
    assert await identity_of(db, source) is None
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "offline"


async def test_a_server_that_names_no_one_stores_nothing(db):
    source = await make_source(db)
    row, connector = await run(db, "test_source", source, answer=None)
    assert row["status"] == "done" and await identity_of(db, source) is None
    row, connector = await run(db, "test_source", source, answer={})
    assert row["status"] == "done" and await identity_of(db, source) is None


async def test_a_failing_identity_never_fails_the_test(db):
    source = await make_source(db)
    row, connector = await run(db, "test_source", source, answer=SERVER_A, raises=True)
    assert row["status"] == "done" and row["result"]["ok"] is True
    assert connector.calls == ["test", "identity", "close"]
    assert await identity_of(db, source) is None
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "online"


async def test_a_second_test_that_meets_another_server_notes_it_and_changes_nothing_else(db):
    source = await make_source(db)
    await run(db, "test_source", source, answer=SERVER_A)
    row, _ = await run(db, "test_source", source, answer=SERVER_B)
    assert row["status"] == "done" and row["result"]["ok"] is True
    stored = await identity_of(db, source)
    assert stored["instance"] == "plant-a" and stored["different"]["instance"] == "plant-b"
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "online"  # the source keeps being polled
    rows = await db.fetch("SELECT level, source_id FROM diag_events WHERE kind = 'source.identity_changed'")
    assert [(r["level"], r["source_id"]) for r in rows] == [("warning", source)]


async def test_a_test_that_finishes_after_the_source_was_moved_does_not_write_the_old_addresss_identity(db):
    source = await make_source(db)

    async def moved():
        await db.execute("UPDATE sources SET config = $2 WHERE id = $1", source, {"url": "http://10.9.9.9:9000/"})

    row, _ = await run(db, "test_source", source, answer=SERVER_A, on_identity=moved)
    assert row["status"] == "done"
    assert await identity_of(db, source) is None


async def test_the_connection_check_remembers_the_identity_after_a_decisive_success(db):
    source = await make_source(db)
    row, connector = await run(db, "check_connection", source, answer=SERVER_A)
    assert row["status"] == "done" and row["result"]["ok"] is True
    assert connector.calls == ["test", "identity", "close"]
    assert await identity_of(db, source) == SERVER_A


async def test_a_failed_connection_check_does_not_ask(db):
    source = await make_source(db)
    row, connector = await run(db, "check_connection", source, ok=False, answer=SERVER_A)
    assert row["status"] == "done" and row["result"]["ok"] is False
    assert connector.calls == ["test", "close"]
    assert await identity_of(db, source) is None


async def test_a_failing_identity_never_fails_the_connection_check(db):
    source = await make_source(db)
    row, connector = await run(db, "check_connection", source, answer=SERVER_A, raises=True)
    assert row["status"] == "done" and row["result"]["ok"] is True
    assert await identity_of(db, source) is None
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "online"


async def test_a_connector_that_is_not_a_connector_subclass_still_runs(db):
    class Bare:
        polls = True

        async def test(self):
            return ConnectionCheck(True, "ok")

        async def close(self):
            pass

    source = await make_source(db)
    job_id = await add_job(db, "test_source", source)
    await run_pending_jobs(db, lambda *_args: Bare())
    assert (await db.fetchval("SELECT status FROM jobs WHERE id = $1", job_id)) == "done"
    assert await identity_of(db, source) is None


async def test_the_poll_loop_never_asks(db):
    from dcdash.collector import scheduler

    assert "identity" not in open(scheduler.__file__).read()


async def test_no_user_name_or_password_reaches_the_journal_or_a_job_result(db):
    class Credentialed(Stub):
        type = "opcua"
        config_schema = OpcUaConfig

    config = {"endpoint": "opc.tcp://operator:hunter2-pass@10.0.0.5:4840/dcdash/", "username": "operator"}
    source = await make_source(db, "creds", "opcua", config, secret="hunter2-secret")
    for answer in ({"application_uri": "urn:plant:a", "thumbprint": "AA:BB"}, {"application_uri": "urn:plant:b"},
                   {"application_uri": "urn:plant:a", "thumbprint": "CC:DD"}):
        Credentialed.answer = answer
        for kind in ("test_source", "check_connection"):
            await add_job(db, kind, source)
        await run_pending_jobs(db, lambda t, c, s: Credentialed(OpcUaConfig(**c), s))
    assert await db.fetchval("SELECT count(*) FROM diag_events WHERE kind = 'source.identity_changed'") >= 2
    everything = json.dumps([dict(r) for r in await db.fetch("SELECT * FROM diag_events")], default=str)
    everything += json.dumps([dict(r) for r in await db.fetch("SELECT result FROM jobs")], default=str)
    everything += json.dumps(await identity_of(db, source))
    assert "hunter2" not in everything and "operator" not in everything


async def test_the_real_simulator_connector_names_its_instance_to_test_and_to_the_check(db):
    from dcdash.simulator.app import create_sim_app
    from dcdash.simulator.model import Simulator
    from helpers import sim_factory

    factory = sim_factory(create_sim_app(Simulator(), api_key="k", instance="plant-a"))
    first = await make_source(db, "first", secret="k")
    second = await make_source(db, "second", secret="k")
    await add_job(db, "test_source", first)
    await add_job(db, "check_connection", second)
    await run_pending_jobs(db, factory)
    assert await identity_of(db, first) == {"instance": "plant-a"}
    assert await identity_of(db, second) == {"instance": "plant-a"}


def test_the_handlers_are_unchanged():
    assert set(jobs_module._HANDLERS) == {"test_source", "browse_source", "scan", "check_connection", "history_fill"}
