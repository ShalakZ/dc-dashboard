import asyncio
from datetime import datetime, timezone

import pytest
from pydantic import BaseModel

from dcdash.collector.scheduler import (
    PollGroup, Scheduler, backoff_delay, load_groups, poll_once, run_group,
)
from dcdash.collector.writer import Writer
from dcdash.connectors.base import BAD, GOOD, ConnectionCheck, Connector, ConnectorError, PointValue
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import make_asset, make_mapping, make_point, make_source, sim_factory, wait_for


class Empty(BaseModel):
    pass


class Flaky(Connector):
    """Fails the first `fail_times` reads, then answers 1.0 for each address it knows."""

    type = "flaky"
    config_schema = Empty

    def __init__(self, fail_times: int = 0, known: set[str] | None = None) -> None:
        super().__init__(Empty(), None)
        self.fail_times, self.known, self.calls, self.closed = fail_times, known, 0, False

    async def test(self) -> ConnectionCheck:
        return ConnectionCheck(True, "ok", 0.0)

    async def browse(self):
        return []

    async def read(self, addresses):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise ConnectorError("timeout", "no answer")
        now = datetime.now(timezone.utc)
        return [PointValue(a, now, 1.0) for a in addresses if self.known is None or a in self.known]

    async def close(self) -> None:
        self.closed = True


async def test_load_groups_groups_mapped_points_by_source_and_interval(db):
    asset = await make_asset(db, "panel")
    source = await make_source(db, "a", config={"url": "http://sim/"}, secret="k")
    fast1 = await make_point(db, source, "p1")
    fast2 = await make_point(db, source, "p2")
    slow = await make_point(db, source, "p3")
    await make_point(db, source, "unmapped")
    await make_mapping(db, fast1, asset, "active_power_kw", 5)
    await make_mapping(db, fast2, asset, "voltage_v", 5)
    await make_mapping(db, slow, asset, "energy_kwh", 60)
    disabled = await make_source(db, "b", enabled=False)
    await make_mapping(db, await make_point(db, disabled, "x"), asset, "custom", 5)

    groups = await load_groups(db)

    assert [(g.source_id, g.interval) for g in groups] == [(source, 5), (source, 60)]
    assert groups[0].points == ((fast1, "p1"), (fast2, "p2"))
    assert groups[1].points == ((slow, "p3"),)
    assert groups[0].secret == "k" and groups[0].config == {"url": "http://sim/"}
    assert groups[0].connector_type == "simulator"


async def test_load_groups_skips_a_source_whose_secret_cannot_be_decrypted(db):
    asset = await make_asset(db, "panel")
    source = await make_source(db, "a")
    await make_mapping(db, await make_point(db, source, "p1"), asset)
    await db.execute("UPDATE sources SET secret = 'garbage' WHERE id = $1", source)
    assert await load_groups(db) == []
    row = await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source)
    assert row["status"] == "offline" and "decrypt" in row["last_error"]


def test_backoff_delay():
    assert backoff_delay(5, 0) == 5.0
    assert backoff_delay(5, 1) == 10.0
    assert backoff_delay(5, 2) == 20.0
    assert backoff_delay(5, 10) == 60.0
    assert backoff_delay(1, 3) == 8.0
    assert backoff_delay(300, 2) == 300.0


async def test_poll_once_writes_one_row_per_point(db):
    writer = Writer(db)
    group = PollGroup(1, "flaky", {}, None, 5, ((10, "a"), (11, "b")))
    await poll_once(group, Flaky(), writer)
    assert writer.pending == 2
    assert [(r[0], r[2], r[3]) for r in writer._buffer] == [(10, 1.0, GOOD), (11, 1.0, GOOD)]


async def test_poll_once_writes_bad_row_for_missing_address(db):
    writer = Writer(db)
    group = PollGroup(1, "flaky", {}, None, 5, ((10, "a"), (11, "b")))
    await poll_once(group, Flaky(known={"a"}), writer)
    rows = {r[0]: r for r in writer._buffer}
    assert rows[10][2] == 1.0 and rows[10][3] == GOOD
    assert rows[11][2] is None and rows[11][3] == BAD and rows[11][1].tzinfo is not None


async def test_run_group_backs_off_then_recovers(db):
    source = await make_source(db)
    point = await make_point(db, source, "a")
    group = PollGroup(source, "flaky", {}, None, 5, ((point, "a"),))
    connector = Flaky(fail_times=2)
    writer = Writer(db)
    delays: list[float] = []
    statuses: list[str] = []

    async def fake_sleep(delay: float) -> None:
        delays.append(delay)
        statuses.append(await db.fetchval("SELECT status FROM sources WHERE id = $1", source))
        if len(delays) == 3:
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await run_group(group, db, writer, lambda *_: connector, fake_sleep)

    assert delays == [10.0, 20.0, 5.0]
    assert statuses == ["offline", "offline", "online"]
    assert connector.closed and writer.pending == 1
    row = await db.fetchrow("SELECT last_error, last_seen FROM sources WHERE id = $1", source)
    assert row["last_error"] is None and row["last_seen"] is not None


async def test_run_group_records_the_error_while_offline(db):
    source = await make_source(db)
    group = PollGroup(source, "flaky", {}, None, 5, ((1, "a"),))

    async def stop_after_first(_delay: float) -> None:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await run_group(group, db, Writer(db), lambda *_: Flaky(fail_times=99), stop_after_first)
    assert await db.fetchval("SELECT last_error FROM sources WHERE id = $1", source) == "no answer"


async def test_run_group_marks_source_offline_on_invalid_config(db):
    source = await make_source(db)
    group = PollGroup(source, "flaky", {}, None, 5, ((1, "a"),))

    def broken_factory(*_):
        raise ValueError("url is required")

    await run_group(group, db, Writer(db), broken_factory)
    row = await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source)
    assert row["status"] == "offline"
    assert row["last_error"] == "invalid configuration: url is required"


async def test_scheduler_collects_from_the_simulator_and_reloads(db):
    sim_app = create_sim_app(Simulator(), api_key="k")
    asset = await make_asset(db, "LV Panel 1")
    source = await make_source(db, secret="k")
    kw = await make_point(db, source, "LVP01_kW")
    kwh = await make_point(db, source, "LVP01_kWh")
    await make_mapping(db, kw, asset, "active_power_kw", 1)
    writer = Writer(db)
    scheduler = Scheduler(db, writer, sim_factory(sim_app))

    async def has_readings() -> bool:
        return writer.pending > 0

    try:
        assert await scheduler.reload() == 1
        await wait_for(has_readings, True)
        await writer.flush()
        assert await db.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", kw) >= 1
        assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "online"

        await make_mapping(db, kwh, asset, "energy_kwh", 60)
        assert await scheduler.reload() == 2
    finally:
        await scheduler.stop()


async def test_reload_keeps_unchanged_groups(db):
    sim_app = create_sim_app(Simulator(), api_key="k")
    a = await make_source(db, name="a", secret="k")
    b = await make_source(db, name="b", secret="k")
    asset = await make_asset(db, "MV2")
    await make_mapping(db, await make_point(db, a, "sim.p1"), asset)
    await make_mapping(db, await make_point(db, b, "sim.p1"), asset, metric="energy_kwh")
    scheduler = Scheduler(db, Writer(db), sim_factory(sim_app))
    key_a, key_b = (a, 5), (b, 5)  # groups are keyed by (source_id, interval); make_mapping defaults to 5s
    try:
        assert await scheduler.reload() == 2
        task_a = scheduler._running[key_a][1]
        task_b = scheduler._running[key_b][1]
        await db.execute("UPDATE sources SET config = '{\"url\": \"http://changed:1\"}' WHERE id = $1", b)
        assert await scheduler.reload() == 2
        assert scheduler._running[key_a][1] is task_a            # untouched
        assert scheduler._running[key_b][1] is not task_b and task_b.cancelled()
        await db.execute("UPDATE sources SET enabled = false WHERE id = $1", a)
        assert await scheduler.reload() == 1 and key_a not in scheduler._running and task_a.cancelled()
    finally:
        await scheduler.stop()
    assert scheduler._running == {}
