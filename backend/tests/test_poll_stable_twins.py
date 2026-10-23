"""Two mapped points of one source that are the same tag (stable addresses on) are never read, whatever interval each is polled at
(w34 F1, review finding I1). A poll group is one source at one interval, so the twin check cannot live in the connector's read:
`load_groups` sees the whole source and puts the twin addresses into each group (`refused`), and `poll_once` writes them BAD with
the status of `read_plan` and sends the rest to the connector."""
import contextlib
from datetime import datetime, timezone

from pydantic import BaseModel

from dcdash.collector.scheduler import PollGroup, Scheduler, _bad_points, load_groups, poll_once
from dcdash.collector.writer import Writer
from dcdash.connectors.base import BAD, GOOD, ConnectionCheck, Connector, PointValue, create_connector
from dcdash.connectors.opcua_ids import read_plan, stable_address
from dcdash.simulator.scada import ScadaConfig, ScadaSim
from helpers import free_port, make_asset, make_mapping, make_point, make_source

A_OLD = "ns=3;s=20403:Site.A"
A_NEW = "ns=3;s=20410:Site.A"  # the same tag after a SCADA project change
C = "ns=3;s=20405:Site.C"
STABLE_A = stable_address(A_OLD)
TWIN_STATUS = read_plan([A_OLD, A_NEW], stable_address).refused[A_OLD]  # the one text, from read_plan's own builder


class Empty(BaseModel):
    pass


class Recorder(Connector):
    """Answers 7.0 for every address it is asked for and remembers what it was asked."""

    type = "recorder"
    config_schema = Empty

    def __init__(self) -> None:
        super().__init__(Empty(), None)
        self.asked: list[list[str]] = []

    async def test(self) -> ConnectionCheck:
        return ConnectionCheck(True, "ok", 0.0)

    async def browse(self):
        return []

    async def read(self, addresses):
        self.asked.append(list(addresses))
        now = datetime.now(timezone.utc)
        return [PointValue(a, now, 7.0) for a in addresses]

    async def close(self) -> None:
        pass


async def opcua_source(db, *, stable: bool = True, name: str = "scada", endpoint: str = "opc.tcp://127.0.0.1:1/") -> int:
    return await make_source(db, name, "opcua", {"endpoint": endpoint, "timeout_seconds": 5, "stable_addresses": stable})


async def map_at(db, source: int, address: str, interval: int) -> int:
    point = await make_point(db, source, address)
    await make_mapping(db, point, await make_asset(db, f"asset {point}"), "custom", interval)
    return point


def group_at(groups: list[PollGroup], source: int, interval: int) -> PollGroup:
    [found] = [g for g in groups if g.source_id == source and g.interval == interval]
    return found


async def poll(group: PollGroup, connector: Connector):
    writer = Writer(None)
    values = await poll_once(group, connector, writer)
    return values, writer._buffer


# ---- load_groups ----------------------------------------------------------------------------------------------------------------

async def test_twins_at_different_intervals_are_refused_in_each_of_their_groups(db):
    source = await opcua_source(db)
    a_old = await map_at(db, source, A_OLD, 5)
    a_new = await map_at(db, source, A_NEW, 60)
    c = await map_at(db, source, C, 5)
    groups = await load_groups(db)
    fast, slow = group_at(groups, source, 5), group_at(groups, source, 60)
    assert fast.points == ((a_old, A_OLD), (c, C)) and slow.points == ((a_new, A_NEW),)  # the points are all still there
    assert fast.refused == ((A_OLD, TWIN_STATUS),) and slow.refused == ((A_NEW, TWIN_STATUS),)  # each group lists its own twin
    assert TWIN_STATUS == f"two points have the same stable address ({STABLE_A})"


async def test_twins_in_one_group_are_refused_too(db):
    source = await opcua_source(db)
    await map_at(db, source, A_OLD, 5)
    await map_at(db, source, A_NEW, 5)
    await map_at(db, source, C, 5)
    [group] = await load_groups(db)
    assert group.refused == ((A_OLD, TWIN_STATUS), (A_NEW, TWIN_STATUS))


async def test_a_source_with_the_option_off_is_untouched(db):
    source = await opcua_source(db, stable=False)
    await map_at(db, source, A_OLD, 5)
    await map_at(db, source, A_NEW, 60)
    assert [g.refused for g in await load_groups(db)] == [(), ()]


async def test_twins_of_two_sources_are_not_twins(db):
    first, second = await opcua_source(db, name="one"), await opcua_source(db, name="two")
    await map_at(db, first, A_OLD, 5)
    await map_at(db, second, A_NEW, 5)
    assert [g.refused for g in await load_groups(db)] == [(), ()]


async def test_an_unmapped_twin_is_not_refused(db):
    source = await opcua_source(db)
    await map_at(db, source, A_OLD, 5)
    await make_point(db, source, A_NEW)  # stored, never polled
    [group] = await load_groups(db)
    assert group.refused == ()


# ---- poll_once ------------------------------------------------------------------------------------------------------------------

async def test_neither_twin_is_read_or_written_good_and_the_third_point_reads_fine(db):
    source = await opcua_source(db)
    a_old = await map_at(db, source, A_OLD, 5)
    a_new = await map_at(db, source, A_NEW, 60)
    c = await map_at(db, source, C, 5)
    groups = await load_groups(db)
    fast, slow = group_at(groups, source, 5), group_at(groups, source, 60)

    connector = Recorder()
    values, rows = await poll(fast, connector)
    assert connector.asked == [[C]]  # the twin is not sent, the other point is
    assert [(v.address, v.quality, v.value, v.status) for v in values] == [
        (A_OLD, BAD, None, TWIN_STATUS), (C, GOOD, 7.0, None),
    ]
    assert [(r[0], r[2], r[3]) for r in rows] == [(a_old, None, BAD), (c, 7.0, GOOD)]

    connector = Recorder()
    values, rows = await poll(slow, connector)
    assert connector.asked == [[]]  # still asked, with nothing to read: a connector that cannot connect says so
    assert [(v.address, v.quality, v.value, v.status) for v in values] == [(A_NEW, BAD, None, TWIN_STATUS)]
    assert [(r[0], r[2], r[3]) for r in rows] == [(a_new, None, BAD)]


async def test_the_incident_code_of_a_twin_is_the_sentence_and_never_the_address(db):
    source = await opcua_source(db)
    await map_at(db, source, A_OLD, 5)
    await map_at(db, source, A_NEW, 60)
    await map_at(db, source, C, 5)
    fast = group_at(await load_groups(db), source, 5)
    values, _rows = await poll(fast, Recorder())
    code, message, detail = _bad_points([v for v in values if v.quality == BAD], len(values))
    # `_bad_points` cuts a status at " (": the address stays in the parentheses, so the code of this incident is one sentence
    assert code == "two points have the same stable address" and STABLE_A not in code
    assert message == f"1 of 2 points have a bad reading: {TWIN_STATUS} x1" and detail["statuses"] == {TWIN_STATUS: 1}


async def test_a_group_without_twins_is_read_whole_and_in_order(db):
    source = await opcua_source(db)
    await map_at(db, source, A_OLD, 5)
    await map_at(db, source, C, 5)
    [group] = await load_groups(db)
    connector = Recorder()
    values, _rows = await poll(group, connector)
    assert connector.asked == [[A_OLD, C]] and [v.quality for v in values] == [GOOD, GOOD]


@contextlib.asynccontextmanager
async def scada():
    sim = ScadaSim(ScadaConfig(pdus=1), free_port())
    await sim.start()
    try:
        yield sim
    finally:
        await sim.stop()


async def test_the_real_connector_reads_nothing_for_twins_at_two_intervals(db):
    async with scada() as sim:
        endpoint = sim.endpoint.replace("0.0.0.0", "127.0.0.1")
        source = await opcua_source(db, endpoint=endpoint)
        first, other = sim.tags[0], sim.tags[1]
        await map_at(db, source, sim.numbered_id(first), 5)
        await map_at(db, source, sim.stable_id(first), 60)  # the same tag, stored in its other form, at another interval
        third = await map_at(db, source, sim.numbered_id(other), 5)
        groups = await load_groups(db)
        results = {}
        for interval in (5, 60):
            group = group_at(groups, source, interval)
            connector = create_connector(group.connector_type, group.config, group.secret)
            try:
                results[interval] = await poll(group, connector)
            finally:
                await connector.close()
        assert sim.counters.read_sizes == [1]  # one tag went on the wire: the third point's
        fast_values, fast_rows = results[5]
        slow_values, slow_rows = results[60]
        assert [(v.quality, v.value) for v in fast_values] == [(BAD, None), (GOOD, sim.value_of(other))]
        assert [(v.quality, v.value) for v in slow_values] == [(BAD, None)]
        twin_text = f"two points have the same stable address ({sim.stable_id(first)})"
        assert fast_values[0].status == slow_values[0].status == twin_text
        assert {r[0]: r[3] for r in fast_rows + slow_rows}[third] == GOOD
        assert [r[3] for r in fast_rows + slow_rows].count(GOOD) == 1


# ---- reload ---------------------------------------------------------------------------------------------------------------------

async def test_a_group_restarts_when_a_twin_appears_in_another_interval_and_again_when_it_goes(db):
    source = await opcua_source(db)
    await map_at(db, source, A_OLD, 5)
    await map_at(db, source, C, 5)
    scheduler = Scheduler(db, Writer(db), lambda *_: Recorder())
    key = (source, 5)
    try:
        assert await scheduler.reload() == 1
        task = scheduler._running[key][1]
        assert await scheduler.reload() == 1
        assert scheduler._running[key][1] is task  # nothing changed: the same task keeps polling

        twin = await map_at(db, source, A_NEW, 60)  # a twin at ANOTHER interval appears
        assert await scheduler.reload() == 2
        appeared = scheduler._running[key][1]
        assert appeared is not task and task.cancelled()
        assert scheduler._running[key][0].refused == ((A_OLD, TWIN_STATUS),)
        assert scheduler._running[(source, 60)][0].refused == ((A_NEW, TWIN_STATUS),)

        await db.execute("DELETE FROM mappings WHERE point_id = $1", twin)  # and goes again
        assert await scheduler.reload() == 1
        gone = scheduler._running[key][1]
        assert gone is not appeared and appeared.cancelled()
        assert scheduler._running[key][0].refused == () and (source, 60) not in scheduler._running
    finally:
        await scheduler.stop()
