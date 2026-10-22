"""`moves.freshness.not_seen_map` (w33 R2, P5, F4): which discovered sources did the latest scan of the SAME range not find?

A source is marked only when (1) it is discovered, (2) its newest finding belongs to a scan A, (3) a NEWER done scan B has the same
targets and ports as A (compared by `scan_digest` of the scan's own snapshot, so a scope edited or deleted afterwards changes
nothing) and (4) B has no finding at the source's own host and port. At most three statements however many sources there are.
"""
import contextlib
from datetime import UTC, datetime, timedelta

from sqlalchemy import event, select

from dcdash.core.db import get_engine, get_sessionmaker
from dcdash.core.models import Source
from dcdash.moves.freshness import not_seen_map

RANGE = ["10.0.0.0/29"]
PORTS = [4840]
T0 = datetime(2026, 10, 1, 8, 0, tzinfo=UTC)


@contextlib.contextmanager
def statements():
    """The SQL text of every statement the request engine runs while the block is open."""
    seen: list[str] = []

    def on(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", on)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", on)


async def make_scan(db, *, targets=RANGE, ports=PORTS, status="done", day=0, snapshot=None, scope_id=None) -> int:
    """A scan created at T0 + `day` days; every state but queued/running has a finish time one hour later."""
    created = T0 + timedelta(days=day)
    finished = created + timedelta(hours=1) if status in ("done", "failed") else None
    return await db.fetchval(
        "INSERT INTO scans (scope_id, scope_snapshot, status, created_at, finished_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        scope_id, {"scope_name": "lab", "targets": targets, "ports": ports} if snapshot is None else snapshot, status, created, finished,
    )


def finished_at(day: int) -> datetime:
    return T0 + timedelta(days=day, hours=1)


async def make_found(db, name, host="10.0.0.2", port=4840, *, origin="discovered", kind="opcua", config=None) -> int:
    if config is None:
        config = {"endpoint": f"opc.tcp://{host}:{port}/"} if kind == "opcua" else {"url": f"http://{host}:{port}"}
    return await db.fetchval(
        "INSERT INTO sources (name, connector_type, config, enabled, origin) VALUES ($1, $2, $3, false, $4) RETURNING id",
        name, kind, config, origin,
    )


async def make_finding(db, scan_id, host, port, source_id=None, outcome="claimed") -> int:
    return await db.fetchval(
        "INSERT INTO scan_findings (scan_id, host, port, source_id, connector_type, outcome) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        scan_id, host, port, source_id, "opcua" if source_id else None, outcome,
    )


async def marks(*source_ids: int) -> dict[int, dict]:
    async with get_sessionmaker()() as session:
        rows = (
            await session.execute(
                select(Source.id, Source.origin, Source.connector_type, Source.config).where(Source.id.in_(source_ids)).order_by(Source.id)
            )
        ).all()
        return await not_seen_map(session, rows)


async def test_a_source_the_newer_scan_of_the_same_range_did_not_find_is_marked(db):
    source = await make_found(db, "found")
    first = await make_scan(db, day=0)
    await make_finding(db, first, "10.0.0.2", 4840, source)
    second = await make_scan(db, day=3)
    assert await marks(source) == {
        source: {"scan_id": second, "at": finished_at(3), "last_seen_scan_id": first, "last_seen_at": finished_at(0)}
    }


async def test_a_source_the_newer_scan_found_again_is_not_marked(db):
    source = await make_found(db, "found")
    first = await make_scan(db, day=0)
    await make_finding(db, first, "10.0.0.2", 4840, source)
    second = await make_scan(db, day=3)
    await make_finding(db, second, "10.0.0.2", 4840, source)  # seen again: its newest finding is now the second scan's
    assert await marks(source) == {}


async def test_a_source_seen_again_is_marked_against_the_scan_it_was_last_seen_in(db):
    source = await make_found(db, "found")
    await make_finding(db, await make_scan(db, day=0), "10.0.0.2", 4840, source)
    second = await make_scan(db, day=3)
    await make_finding(db, second, "10.0.0.2", 4840, source)
    third = await make_scan(db, day=6)
    assert await marks(source) == {
        source: {"scan_id": third, "at": finished_at(6), "last_seen_scan_id": second, "last_seen_at": finished_at(3)}
    }


async def test_the_newest_done_scan_of_the_range_is_the_one_that_is_named(db):
    source = await make_found(db, "found")
    first = await make_scan(db, day=0)
    await make_finding(db, first, "10.0.0.2", 4840, source)
    await make_scan(db, day=2)
    newest = await make_scan(db, day=4)
    result = (await marks(source))[source]
    assert (result["scan_id"], result["at"], result["last_seen_scan_id"]) == (newest, finished_at(4), first)


async def test_another_range_or_another_port_list_marks_nothing(db):
    source = await make_found(db, "found")
    await make_finding(db, await make_scan(db, day=0), "10.0.0.2", 4840, source)
    await make_scan(db, day=1, targets=["10.0.1.0/29"])  # another range
    await make_scan(db, day=2, ports=[4840, 502])  # the same range, another port list
    await make_scan(db, day=3, ports=[502])
    await make_scan(db, day=4, targets=RANGE + ["10.0.2.1"])  # the same range plus a host
    assert await marks(source) == {}


async def test_the_order_of_the_targets_is_part_of_the_range(db):
    """`scan_digest` hashes the lists as stored, so a reordered list is another range: the source is never marked by a doubt."""
    source = await make_found(db, "found")
    await make_finding(db, await make_scan(db, day=0, targets=["10.0.0.1", "10.0.0.2"]), "10.0.0.2", 4840, source)
    await make_scan(db, day=1, targets=["10.0.0.2", "10.0.0.1"])
    assert await marks(source) == {}


async def test_a_failed_a_queued_and_a_running_scan_mark_nothing(db):
    source = await make_found(db, "found")
    await make_finding(db, await make_scan(db, day=0), "10.0.0.2", 4840, source)
    await make_scan(db, day=1, status="failed")
    await make_scan(db, day=2, status="queued")
    await make_scan(db, day=3, status="running")
    assert await marks(source) == {}


async def test_an_older_scan_of_the_same_range_than_the_last_sighting_marks_nothing(db):
    source = await make_found(db, "found")
    await make_scan(db, day=0)  # done, same range, but older than the scan that saw the source
    await make_finding(db, await make_scan(db, day=3), "10.0.0.2", 4840, source)
    assert await marks(source) == {}


async def test_a_scope_deleted_or_edited_afterwards_changes_nothing_the_snapshot_decides(db):
    scope = await db.fetchval(
        "INSERT INTO scan_scopes (name, targets, ports) VALUES ('lab', $1, $2) RETURNING id", RANGE, PORTS
    )
    source = await make_found(db, "found")
    first = await make_scan(db, day=0, scope_id=scope)
    await make_finding(db, first, "10.0.0.2", 4840, source)
    second = await make_scan(db, day=3, scope_id=scope)
    await db.execute("UPDATE scan_scopes SET targets = $2, ports = $3 WHERE id = $1", scope, ["192.168.0.0/24"], [502])
    assert (await marks(source))[source]["scan_id"] == second
    await db.execute("DELETE FROM scan_scopes WHERE id = $1", scope)
    assert await db.fetchval("SELECT scope_id FROM scans WHERE id = $1", second) is None
    assert (await marks(source))[source]["scan_id"] == second


async def test_a_snapshot_without_targets_or_ports_never_marks(db):
    source = await make_found(db, "found")
    await make_finding(db, await make_scan(db, day=0, snapshot={"scope_name": "lab"}), "10.0.0.2", 4840, source)
    await make_scan(db, day=1, snapshot={"scope_name": "lab"})
    assert await marks(source) == {}
    # a newer scan that has a full snapshot cannot equal a snapshot that has none
    await make_scan(db, day=2)
    assert await marks(source) == {}


async def test_a_snapshot_that_is_not_an_object_never_marks_and_never_fails(db):
    source = await make_found(db, "found")
    await make_finding(db, await make_scan(db, day=0, snapshot=["10.0.0.0/29"]), "10.0.0.2", 4840, source)
    await make_scan(db, day=1, snapshot={"targets": "10.0.0.0/29", "ports": 4840})
    await make_scan(db, day=2, snapshot={"targets": [1, 2], "ports": [4840]})
    assert await marks(source) == {}


async def test_a_scan_of_nothing_never_marks_anything(db):
    """Two snapshots with empty lists hash alike; a scan that scanned nothing found nothing and says nothing."""
    source = await make_found(db, "found")
    await make_finding(db, await make_scan(db, day=0, targets=[], ports=[]), "10.0.0.2", 4840, source)
    await make_scan(db, day=1, targets=[], ports=[])
    assert await marks(source) == {}


async def test_a_hand_added_source_is_never_marked(db):
    hand = await make_found(db, "hand", origin="manual")
    await make_finding(db, await make_scan(db, day=0), "10.0.0.2", 4840, hand)
    await make_scan(db, day=3)
    assert await marks(hand) == {}


async def test_a_source_without_a_finding_is_never_marked(db):
    source = await make_found(db, "never scanned")
    await make_scan(db, day=0)
    await make_scan(db, day=3)
    assert await marks(source) == {}


async def test_a_duplicate_at_the_same_address_that_the_newer_scan_linked_to_another_source_counts_as_seen(db):
    """A hand-added source at the discovered one's own host and port: the scan links its finding to ONE of them."""
    source = await make_found(db, "found")
    hand = await make_found(db, "hand", origin="manual")
    await make_finding(db, await make_scan(db, day=0), "10.0.0.2", 4840, source)
    second = await make_scan(db, day=3)
    await make_finding(db, second, "10.0.0.2", 4840, hand)  # the newer scan DID find the address, under the other source
    assert await marks(source) == {}
    # the same finding at ANOTHER address would not have helped
    third = await make_scan(db, day=6)
    await make_finding(db, third, "10.0.0.3", 4840, hand)
    assert (await marks(source))[source]["scan_id"] == third


async def test_the_address_comparison_ignores_the_case_of_the_host(db):
    source = await make_found(db, "found", host="Meter-1.Lab")
    await make_finding(db, await make_scan(db, day=0), "meter-1.lab", 4840, source)
    second = await make_scan(db, day=3)
    await make_finding(db, second, "METER-1.LAB", 4840, None, outcome="unclaimed")
    assert await marks(source) == {}


async def test_a_finding_at_the_same_host_on_another_port_is_not_the_same_address(db):
    source = await make_found(db, "found")
    await make_finding(db, await make_scan(db, day=0), "10.0.0.2", 4840, source)
    second = await make_scan(db, day=3)
    await make_finding(db, second, "10.0.0.2", 502, None, outcome="unclaimed")
    assert (await marks(source))[source]["scan_id"] == second


async def test_two_sources_last_seen_in_different_scans_each_name_their_own(db):
    early = await make_found(db, "early", host="10.0.0.2")
    late = await make_found(db, "late", host="10.0.0.3")
    seen_early = await make_scan(db, day=0)
    await make_finding(db, seen_early, "10.0.0.2", 4840, early)
    await make_finding(db, seen_early, "10.0.0.3", 4840, late)
    seen_late = await make_scan(db, day=2)
    await make_finding(db, seen_late, "10.0.0.3", 4840, late)  # only the second source was found again
    newest = await make_scan(db, day=4)
    assert await marks(early, late) == {
        early: {"scan_id": newest, "at": finished_at(4), "last_seen_scan_id": seen_early, "last_seen_at": finished_at(0)},
        late: {"scan_id": newest, "at": finished_at(4), "last_seen_scan_id": seen_late, "last_seen_at": finished_at(2)},
    }


async def test_the_scan_that_found_a_source_may_still_be_running_and_the_last_seen_time_is_its_start(db):
    source = await make_found(db, "found")
    running = await make_scan(db, day=0, status="running")
    await make_finding(db, running, "10.0.0.2", 4840, source)
    done = await make_scan(db, day=1)
    result = (await marks(source))[source]
    assert (result["scan_id"], result["last_seen_scan_id"], result["last_seen_at"]) == (done, running, T0)


async def test_a_source_of_an_unknown_type_or_without_an_address_is_never_marked(db):
    odd = await make_found(db, "odd", kind="gadget", config={"endpoint": "opc.tcp://10.0.0.2:4840/"})
    nowhere = await make_found(db, "nowhere", config={"endpoint": "not a url"})
    empty = await make_found(db, "empty", config={})
    first = await make_scan(db, day=0)
    for source in (odd, nowhere, empty):
        await make_finding(db, first, "10.0.0.2", 4840, source)
    await make_scan(db, day=3)
    assert await marks(odd, nowhere, empty) == {}


async def test_a_simulator_source_is_marked_by_its_url(db):
    source = await make_found(db, "sim", kind="simulator", host="10.0.0.4", port=8080)
    first = await make_scan(db, day=0, ports=[8080])
    await make_finding(db, first, "10.0.0.4", 8080, source)
    second = await make_scan(db, day=1, ports=[8080])
    assert (await marks(source))[source]["scan_id"] == second


async def test_it_runs_at_most_three_statements_however_many_sources_there_are(db):
    ids = []
    first = await make_scan(db, day=0)
    for number in range(2, 12):
        host = f"10.0.0.{number}"
        source = await make_found(db, f"found {number}", host=host)
        await make_finding(db, first, host, 4840, source)
        ids.append(source)
    second = await make_scan(db, day=1)
    await make_finding(db, second, "10.0.0.2", 4840, ids[0])  # one of them was found again
    third = await make_scan(db, day=2)
    async with get_sessionmaker()() as session:
        rows = (await session.execute(select(Source.id, Source.origin, Source.connector_type, Source.config))).all()
        with statements() as sql:
            result = await not_seen_map(session, rows)
    assert len(sql) <= 3, sql
    assert sorted(result) == sorted(ids)  # all ten are marked: the first source was last seen in the second scan, the others in the first
    assert result[ids[0]]["last_seen_scan_id"] == second and result[ids[1]]["last_seen_scan_id"] == first
    assert {mark["scan_id"] for mark in result.values()} == {third}


async def test_empty_inputs_run_no_statement_and_a_list_without_a_discovered_source_runs_none_either(db):
    hand = await make_found(db, "hand", origin="manual")
    async with get_sessionmaker()() as session:
        with statements() as sql:
            assert await not_seen_map(session, []) == {}
        assert sql == []
        rows = (await session.execute(select(Source.id, Source.origin, Source.connector_type, Source.config))).all()
        assert [row.id for row in rows] == [hand]
        with statements() as sql:
            assert await not_seen_map(session, rows) == {}
        assert sql == []


async def test_a_discovered_source_that_was_never_found_costs_one_statement_and_no_scan_table_is_read_further(db):
    source = await make_found(db, "never scanned")
    await make_scan(db, day=0)
    async with get_sessionmaker()() as session:
        rows = (await session.execute(select(Source.id, Source.origin, Source.connector_type, Source.config))).all()
        with statements() as sql:
            assert await not_seen_map(session, rows) == {}
    assert len(sql) == 1 and source in [row.id for row in rows]


async def test_it_does_not_change_the_rows_it_is_given(db):
    source = await make_found(db, "found")
    await make_finding(db, await make_scan(db, day=0), "10.0.0.2", 4840, source)
    await make_scan(db, day=3)
    before = await db.fetchrow("SELECT * FROM sources WHERE id = $1", source)
    counts = [await db.fetchval(f"SELECT count(*) FROM {table}") for table in ("scans", "scan_findings", "sources")]
    await marks(source)
    assert dict(await db.fetchrow("SELECT * FROM sources WHERE id = $1", source)) == dict(before)
    assert [await db.fetchval(f"SELECT count(*) FROM {table}") for table in ("scans", "scan_findings", "sources")] == counts
