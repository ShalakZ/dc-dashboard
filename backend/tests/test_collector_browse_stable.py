"""A browse of a source with "Stable tag addresses" lands each listed tag on the point already stored for it (w34, plan Task 3).

The SCADA-shaped server (dcdash/simulator/scada.py) renumbers its tags at run time; the real OpcUaConnector is the client; the
money tests go through `poll_once` the way the collector does, so what they see is what lands in `readings`."""
import asyncio
import contextlib
import re

import pytest
from pydantic import BaseModel

from dcdash.collector.browse import BrowseResult, BrowseSettingsChanged, browse_source, browse_source_detailed, plan_browse
from dcdash.collector.jobs import run_pending_jobs
from dcdash.collector.scheduler import load_groups, poll_once
from dcdash.collector.writer import Writer
from dcdash.connectors.base import BAD, GOOD, ConnectionCheck, Connector, PointDescriptor, create_connector
from dcdash.connectors.opcua_ids import identity_key, stable_address
from dcdash.simulator.scada import ScadaConfig, ScadaSim
from helpers import free_port, make_asset, make_mapping, make_point, make_source

NUMBERED = re.compile(r"ns=3;s=\d+:Site\.(.+)")


@contextlib.asynccontextmanager
async def scada(**settings):
    sim = ScadaSim(ScadaConfig(pdus=1, **settings), free_port())  # 64 tags in the first listing, 27 more once restructured
    await sim.start()
    try:
        yield sim
    finally:
        await sim.stop()


async def opcua_source(db, sim: ScadaSim, *, stable: bool = False, name: str = "scada") -> int:
    endpoint = sim.endpoint.replace("0.0.0.0", "127.0.0.1")
    return await make_source(db, name, "opcua", {"endpoint": endpoint, "timeout_seconds": 5, "stable_addresses": stable})


async def set_option(db, source: int, on: bool) -> None:
    await db.execute("UPDATE sources SET config = config || $2::jsonb WHERE id = $1", source, {"stable_addresses": on})


async def points_of(db, source: int) -> dict[int, tuple[str, str]]:
    """point id -> (address, name)"""
    rows = await db.fetch("SELECT id, address, name FROM points WHERE source_id = $1 ORDER BY id", source)
    return {row["id"]: (row["address"], row["name"]) for row in rows}


async def map_points(db, point_ids) -> None:
    asset = await make_asset(db, "panel")
    for point_id in point_ids:
        await make_mapping(db, point_id, asset, "custom")  # "custom" may repeat on one asset


class Empty(BaseModel):
    pass


class Listing(Connector):
    """A connector that lists what it is given (the browse of a source whose server we do not run)."""

    type = "listing"
    config_schema = Empty

    def __init__(self, descriptors, hook=None) -> None:
        super().__init__(Empty(), None)
        self.descriptors, self.hook = list(descriptors), hook

    async def test(self) -> ConnectionCheck:
        return ConnectionCheck(True, "ok", 0.0)

    async def browse(self):
        if self.hook is not None:
            await self.hook()
        return list(self.descriptors)

    async def read(self, addresses):
        return []

    async def close(self) -> None:
        pass


def listing(*descriptors: PointDescriptor, hook=None):
    return lambda _type, _config, _secret: Listing(descriptors, hook)


async def listing_source(db, *stored: str) -> tuple[int, list[int]]:
    source = await make_source(db, "fake", "opcua", {"endpoint": "opc.tcp://x", "stable_addresses": True})
    return source, [await make_point(db, source, address) for address in stored]


# ---- the matching, with the server's tags renumbered --------------------------------------------------------------------------

async def test_rebrowse_after_renumbering_adds_no_point_with_the_option_on(db):
    async with scada() as sim:
        source = await opcua_source(db, sim)  # the option is off: the first browse stores the numbers
        assert await browse_source_detailed(db, source, create_connector) == BrowseResult(len(sim.tags))
        before = await points_of(db, source)
        assert len(before) == len(sim.tags) and all(NUMBERED.fullmatch(address) for address, _ in before.values())
        by_name = {name: point_id for point_id, (_, name) in before.items()}
        await map_points(db, [by_name[sim.tags[0]], by_name[sim.tags[27]]])
        await set_option(db, source, True)
        sim.restructure("bad")  # every number moves, and the extra equipment is listed in front
        second = await browse_source_detailed(db, source, create_connector)
        after = await points_of(db, source)
        assert {point_id: stored for point_id, stored in after.items() if point_id in before} == before  # same ids, addresses, names
        assert second.matched_stored == len(sim.tags) >= 2 and second.ambiguous == 0
        assert second.count == len(sim.tags) + len(sim.extra_tags)
        # the only new points are the tags the server did not list before, under their stable address: no twin of an old tag
        assert {name: address for _, (address, name) in after.items() if name not in by_name} == {
            tag: sim.stable_id(tag) for tag in sim.extra_tags
        }
        assert len(after) == len(sim.tags) + len(sim.extra_tags)


async def test_rebrowse_after_renumbering_with_the_option_off_adds_a_twin_of_every_tag(db):
    async with scada() as sim:  # today's behaviour, pinned: the numbered address is the identity
        source = await opcua_source(db, sim)
        await browse_source_detailed(db, source, create_connector)
        before = await points_of(db, source)
        sim.restructure("bad")
        second = await browse_source_detailed(db, source, create_connector)
        after = await points_of(db, source)
        assert second == BrowseResult(len(sim.tags) + len(sim.extra_tags))  # no match, nothing ambiguous
        assert {point_id: stored for point_id, stored in after.items() if point_id in before} == before
        assert len(after) == 2 * len(sim.tags) + len(sim.extra_tags)
        names = [name for _, name in after.values()]
        assert all(names.count(tag) == 2 for tag in sim.tags)


async def test_new_tag_is_inserted_under_the_stable_address_and_a_rebrowse_finds_it_again(db):
    async with scada() as sim:
        source = await opcua_source(db, sim, stable=True)  # the option is on from the first browse
        first = await browse_source_detailed(db, source, create_connector)
        assert first == BrowseResult(len(sim.tags))
        stored = await points_of(db, source)
        assert {name: address for address, name in stored.values()} == {tag: sim.stable_id(tag) for tag in sim.tags}
        sim.restructure("bad")
        second = await browse_source_detailed(db, source, create_connector)
        assert second == BrowseResult(len(sim.tags) + len(sim.extra_tags), matched_stored=0, ambiguous=0)  # exact matches
        after = await points_of(db, source)
        assert {i: v for i, v in after.items() if i in stored} == stored
        assert len(after) == len(sim.tags) + len(sim.extra_tags)


# ---- the cases with no server --------------------------------------------------------------------------------------------------

@pytest.mark.parametrize(
    "mapped, updated",
    [(("b",), "b"), (("a",), "a"), ((), None), (("a", "b"), None)],
    ids=["b mapped", "a mapped", "none mapped", "both mapped"],
)
async def test_two_stored_points_for_one_tag_update_the_one_mapped_or_none(db, mapped, updated):
    source, (a, b) = await listing_source(db, "ns=3;s=20410:Site.X", "ns=3;s=20403:Site.X")
    ids = {"a": a, "b": b}
    await map_points(db, [ids[name] for name in mapped])
    result = await browse_source_detailed(db, source, listing(PointDescriptor("ns=3;s=Site.X", "X new", unit_hint="kW")))
    assert result == BrowseResult(1, matched_stored=0 if updated is None else 1, ambiguous=1 if updated is None else 0)
    after = await points_of(db, source)
    assert after[a][0] == "ns=3;s=20410:Site.X" and after[b][0] == "ns=3;s=20403:Site.X"  # a stored address is never rewritten
    assert len(after) == 2  # and nothing is inserted next to them
    for name, point_id in ids.items():
        assert after[point_id][1] == ("X new" if name == updated else after[point_id][0])
    if updated is not None:
        assert await db.fetchval("SELECT unit_hint FROM points WHERE id = $1", ids[updated]) == "kW"


async def test_a_single_stored_point_with_the_exact_stable_address_is_updated_not_counted_as_moved(db):
    source, (point,) = await listing_source(db, "ns=3;s=Site.X")
    result = await browse_source_detailed(db, source, listing(PointDescriptor("ns=3;s=Site.X", "X new")))
    assert result == BrowseResult(1, 0, 0)
    assert await points_of(db, source) == {point: ("ns=3;s=Site.X", "X new")}


@pytest.mark.parametrize("second_address", ["ns=3;s=Site.X", "ns=3;s=20403:Site.X"], ids=["identical", "numbered"])
async def test_two_listed_tags_with_the_same_stable_form_are_both_skipped_and_counted_ambiguous(db, second_address):
    source, _ = await listing_source(db)
    result = await browse_source_detailed(
        db, source, listing(PointDescriptor("ns=3;s=Site.X", "first"), PointDescriptor(second_address, "second"))
    )
    assert result == BrowseResult(2, matched_stored=0, ambiguous=2)  # neither is the tag: both are counted, nothing is stored
    assert await points_of(db, source) == {}


async def test_two_listed_tags_with_one_stable_form_do_not_touch_the_stored_point_of_that_form(db):
    source, (point,) = await listing_source(db, "ns=3;s=20410:Site.X")
    result = await browse_source_detailed(
        db,
        source,
        listing(PointDescriptor("ns=3;s=Site.X", "first"), PointDescriptor("ns=3;s=20403:Site.X", "second"), PointDescriptor("ns=3;s=Site.Y", "Y")),
    )
    assert result == BrowseResult(3, matched_stored=0, ambiguous=2)
    assert await points_of(db, source) == {point: ("ns=3;s=20410:Site.X", "ns=3;s=20410:Site.X")} | {
        point + 1: ("ns=3;s=Site.Y", "Y")
    }


async def test_a_listed_tag_next_to_a_stored_twin_pair_does_not_insert_a_third_point(db):
    source, (a, b) = await listing_source(db, "ns=3;s=20410:Site.X", "ns=3;s=20403:Site.X")
    await map_points(db, [b])
    other = PointDescriptor("ns=3;s=Site.Y", "Y")
    result = await browse_source_detailed(db, source, listing(PointDescriptor("ns=3;s=Site.X", "X"), other))
    assert result == BrowseResult(2, matched_stored=1, ambiguous=0)
    assert sorted(address for address, _ in (await points_of(db, source)).values()) == [
        "ns=3;s=20403:Site.X", "ns=3;s=20410:Site.X", "ns=3;s=Site.Y"
    ]


def test_the_plan_updates_in_ascending_point_id_and_follows_the_key():
    stored = [(9, "ns=3;s=20409:Site.C", False), (3, "ns=3;s=1:Site.A", True), (7, "ns=3;s=2:Site.B", False)]
    listed = [PointDescriptor(f"ns=3;s=Site.{tag}", tag) for tag in "CBAD"]
    plan = plan_browse(listed, stored, stable_address)
    assert [point_id for point_id, _ in plan.updates] == [3, 7, 9]
    assert [d.name for d in plan.inserts] == ["D"] and (plan.matched_stored, plan.ambiguous) == (3, 0)
    plain = plan_browse(listed, stored, identity_key)  # the identity key: nothing matches, everything is new
    assert plain.updates == [] and len(plain.inserts) == 4


def test_the_plan_inserts_in_ascending_address_whatever_order_the_server_listed_them_in():
    listed = [PointDescriptor(f"ns=3;s=Site.{tag}", tag) for tag in "CAB"]
    plan = plan_browse(listed, [], stable_address)
    assert [d.address for d in plan.inserts] == ["ns=3;s=Site.A", "ns=3;s=Site.B", "ns=3;s=Site.C"]  # two browses lock rows alike


def test_the_plan_skips_every_descriptor_of_a_shared_key_and_counts_each():
    stored = [(1, "ns=3;s=20403:Site.X", True)]
    listed = [PointDescriptor("ns=3;s=Site.X", "a"), PointDescriptor("ns=3;s=Site.Y", "y"), PointDescriptor("ns=3;s=7:Site.X", "b")]
    plan = plan_browse(listed, stored, stable_address)
    assert plan.updates == [] and [d.name for d in plan.inserts] == ["y"] and (plan.matched_stored, plan.ambiguous) == (0, 2)


async def test_browse_source_still_returns_the_count_for_both_settings(db):
    async with scada() as sim:
        off = await opcua_source(db, sim, name="off")
        on = await opcua_source(db, sim, stable=True, name="on")
        assert await browse_source(db, off, create_connector) == len(sim.tags)
        assert await browse_source(db, on, create_connector) == len(sim.tags)
        assert await browse_source(db, on, create_connector) == len(sim.tags)  # the same count when every tag is already stored


async def test_the_browse_job_reports_the_three_numbers(db):
    async with scada() as sim:
        source = await opcua_source(db, sim)
        first = await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('browse_source', $1) RETURNING id", {"source_id": source})
        await run_pending_jobs(db, create_connector)
        assert (await db.fetchval("SELECT result FROM jobs WHERE id = $1", first)) == {"count": len(sim.tags), "matched_stored": 0, "ambiguous": 0}
        await set_option(db, source, True)
        sim.restructure("bad")
        second = await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('browse_source', $1) RETURNING id", {"source_id": source})
        await run_pending_jobs(db, create_connector)
        assert (await db.fetchval("SELECT result FROM jobs WHERE id = $1", second)) == {
            "count": len(sim.tags) + len(sim.extra_tags), "matched_stored": len(sim.tags), "ambiguous": 0,
        }


# ---- locks ---------------------------------------------------------------------------------------------------------------------

async def test_the_option_on_browse_takes_the_source_row_before_it_touches_a_point(db):
    source, (point,) = await listing_source(db, "ns=3;s=Site.X")
    task = None
    async with db.acquire() as holder, holder.transaction():
        await holder.fetchval("SELECT 1 FROM sources WHERE id = $1 FOR UPDATE", source)  # what a PATCH or a delete holds
        task = asyncio.create_task(browse_source_detailed(db, source, listing(PointDescriptor("ns=3;s=Site.X", "X new"))))
        await asyncio.sleep(0.5)
        assert not task.done()
        assert (await points_of(db, source))[point][1] == "ns=3;s=Site.X"  # nothing written yet
    assert await asyncio.wait_for(task, 10) == BrowseResult(1, 0, 0)
    assert (await points_of(db, source))[point][1] == "X new"


async def test_a_source_deleted_during_the_browse_is_a_plain_error_not_a_foreign_key_error(db):
    source, _ = await listing_source(db)

    async def delete_the_source():
        await db.execute("DELETE FROM sources WHERE id = $1", source)

    with pytest.raises(LookupError, match=f"source {source} not found"):
        await browse_source_detailed(db, source, listing(PointDescriptor("ns=3;s=Site.X", "X"), hook=delete_the_source))


# ---- the option cannot change under a browse (review M2, F1-A) ------------------------------------------------------------------
# The connector is built from the config read at the start, so its listing is in the form that option gives. If the option is not the
# same when the points are stored, the listing no longer fits the setting: nothing is stored, and the browse says so.

CHANGED = "the stable address option was changed while the browse was running; browse again"


async def test_an_option_turned_on_during_the_walk_stores_nothing_and_says_so(db):
    source = await make_source(db, "fake", "opcua", {"endpoint": "opc.tcp://x", "stable_addresses": False})
    stored = await make_point(db, source, "ns=3;s=20403:Site.X")
    before = await points_of(db, source)

    async def turn_on():
        await set_option(db, source, True)

    with pytest.raises(BrowseSettingsChanged) as raised:
        await browse_source_detailed(db, source, listing(PointDescriptor("ns=3;s=20403:Site.X", "X new"), hook=turn_on))
    assert str(raised.value) == CHANGED
    assert await points_of(db, source) == before == {stored: ("ns=3;s=20403:Site.X", "ns=3;s=20403:Site.X")}


async def test_an_option_turned_off_during_the_walk_stores_nothing_and_says_so(db):
    source, (stored,) = await listing_source(db, "ns=3;s=20403:Site.X")
    before = await points_of(db, source)

    async def turn_off():
        await set_option(db, source, False)

    with pytest.raises(BrowseSettingsChanged) as raised:  # the walk was in the stable form: no twin of the stored point is added
        await browse_source_detailed(db, source, listing(PointDescriptor("ns=3;s=Site.X", "X new"), hook=turn_off))
    assert str(raised.value) == CHANGED
    assert await points_of(db, source) == before == {stored: ("ns=3;s=20403:Site.X", "ns=3;s=20403:Site.X")}


async def test_an_option_turned_off_while_the_browse_waits_for_the_source_row_is_seen_inside_the_lock(db):
    source, (stored,) = await listing_source(db, "ns=3;s=20403:Site.X")
    before = await points_of(db, source)
    async with db.acquire() as holder, holder.transaction():
        await holder.fetchval("SELECT 1 FROM sources WHERE id = $1 FOR UPDATE", source)  # what a PATCH holds
        task = asyncio.create_task(browse_source_detailed(db, source, listing(PointDescriptor("ns=3;s=Site.X", "X new"))))
        await asyncio.sleep(0.5)  # the browse has read "on", walked, and waits for the row
        assert not task.done()
        await holder.execute("UPDATE sources SET config = config || $2::jsonb WHERE id = $1", source, {"stable_addresses": False})
    with pytest.raises(BrowseSettingsChanged, match=re.escape(CHANGED)):
        await asyncio.wait_for(task, 10)
    assert await points_of(db, source) == before == {stored: ("ns=3;s=20403:Site.X", "ns=3;s=20403:Site.X")}


async def test_an_option_that_stays_as_it_was_is_stored_as_before_for_both_settings(db):
    on, (stored,) = await listing_source(db, "ns=3;s=20403:Site.X")
    off = await make_source(db, "plain", "opcua", {"endpoint": "opc.tcp://x", "stable_addresses": False})
    assert await browse_source_detailed(db, on, listing(PointDescriptor("ns=3;s=Site.X", "X new"))) == BrowseResult(1, 1, 0)
    assert (await points_of(db, on))[stored] == ("ns=3;s=20403:Site.X", "X new")
    assert await browse_source_detailed(db, off, listing(PointDescriptor("ns=3;s=20403:Site.X", "X"))) == BrowseResult(1)
    assert sorted(a for a, _ in (await points_of(db, off)).values()) == ["ns=3;s=20403:Site.X"]


async def test_the_browse_job_fails_with_the_sentence_and_the_source_keeps_its_status(db):
    source, (stored,) = await listing_source(db, "ns=3;s=20403:Site.X")
    status = await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source)

    async def turn_off():
        await set_option(db, source, False)

    job = await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('browse_source', $1) RETURNING id", {"source_id": source})
    await run_pending_jobs(db, listing(PointDescriptor("ns=3;s=Site.X", "X new"), hook=turn_off))
    row = await db.fetchrow("SELECT status, result FROM jobs WHERE id = $1", job)
    assert (row["status"], row["result"]) == ("failed", {"error": CHANGED})
    assert await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", source) == status  # a setting is no outage
    assert list(await points_of(db, source)) == [stored]


# ---- the money tests (R4): which stored point a value lands on ---------------------------------------------------------------

async def poll_source(db, source: int):
    """One poll of the source the way the collector does it: the group and its connector come from the stored rows."""
    [group] = [g for g in await load_groups(db) if g.source_id == source]
    connector = create_connector(group.connector_type, group.config, group.secret)
    writer = Writer(db)
    try:
        values = await poll_once(group, connector, writer)
    finally:
        await connector.close()
    return group, values, writer


@pytest.mark.parametrize("mode", ["bad", "by_index"])
async def test_a_stored_numbered_address_after_a_renumbering(db, mode):
    async with scada() as sim:
        off, on = await opcua_source(db, sim, name="off"), await opcua_source(db, sim, name="on")
        for source in (off, on):
            await browse_source(db, source, create_connector)  # both store the numbers of the first listing
            await map_points(db, list(await points_of(db, source)))
        await set_option(db, on, True)
        names = {source: {pid: name for pid, (_, name) in (await points_of(db, source)).items()} for source in (off, on)}
        sim.restructure(mode)

        # option off: the address the point was stored under is what the server answers for, and it answers wrongly
        group, values, writer = await poll_source(db, off)
        assert [point_id for point_id, _ in group.points] == list(names[off])
        if mode == "bad":
            assert all(v.quality == BAD and v.value is None and "BadNodeIdUnknown" in v.status for v in values)
            assert all(row[2] is None and row[3] == BAD for row in writer._buffer)
        else:  # the number now belongs to another tag: a good reading of the WRONG tag lands on the point (today's risk)
            listing_now = sim.extra_tags + sim.tags
            for (point_id, _), value in zip(group.points, values, strict=True):
                own = names[off][point_id]
                holder = listing_now[sim.tags.index(own)]  # the tag at the position the old number now points to
                assert value.quality == GOOD and holder != own
                assert value.value == sim.value_of(holder) != sim.value_of(own)

        # option on: the same stored addresses read the right tag, for the same point ids, before and after a re-browse
        for rebrowse in (False, True):
            if rebrowse:
                result = await browse_source_detailed(db, on, create_connector)
                assert result.matched_stored == len(sim.tags) and result.ambiguous == 0
            group, values, writer = await poll_source(db, on)
            assert [point_id for point_id, _ in group.points] == list(names[on])
            assert [(row[0], row[2], row[3]) for row in writer._buffer] == [
                (point_id, sim.value_of(names[on][point_id]), GOOD) for point_id, _ in group.points
            ]
            assert [v.value for v in values] == [sim.value_of(names[on][point_id]) for point_id, _ in group.points]
        assert set(await points_of(db, on)) >= set(names[on])  # no mapped point was replaced by a twin
        assert await db.fetchval("SELECT count(*) FROM mappings m JOIN points p ON p.id = m.point_id WHERE p.source_id = $1", on) == len(sim.tags)
