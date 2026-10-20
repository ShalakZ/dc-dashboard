"""Check month on the figure ledger (w26b task 5): `GET /api/billing/month-check` serves a stored report when it is provably
current, and in every other case, or on any failure of the ledger, runs the code it always ran.

The law: an answer from the ledger equals, byte for byte, the answer of the live code on the same data. So every hit test here
compares `response.content` with the answer of the same request made with `DCDASH_FIGURE_LEDGER=0`, AND proves that a hit really
happened (`ledger.stats()["hits_exact"]` and a spy on `build_report`): a codec refusal is a silent miss, so an equality test alone
would pass with a ledger that is never used. Every fallback test proves the converse: the live code ran, nothing was a hit and the
answer is the live one.

A row is published here the way the worker will write it (`publish`): one repeatable-read transaction takes the configuration
fingerprint, the Check month fingerprint, `now()` and the report, and writes them with the codec.
"""
import contextlib
import copy
import json
import os
import random
import zlib
from datetime import datetime, timedelta, timezone
from unittest import mock
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import event, text
from sqlalchemy.exc import ProgrammingError

from billing_helpers import add_tariff, at, set_zone
from dcdash.api import billing_check
from dcdash.core import figure_cache, ledger, ledger_codec
from dcdash.core.db import get_engine, get_sessionmaker
from dcdash.core.energy import Meter, load_meters
from dcdash.core.month_check import CAP, THINGS, MeterInput, build_report
from dcdash.core.timeutil import month_bounds
from dcdash.core.tree import AssetNode, AssetTree
from helpers import login_as, make_asset, make_role
from test_api_billing_check import END, MONTH, START, URL, by_asset, hours, meter, signed_in, varying, world
from test_ledger_codec import CHECK_NAMES, CHECK_ZONES, POINT_NAMES, SOURCE_NAMES, check_rows
from test_month_check import crow, prow

UTC = timezone.utc
HOUR = timedelta(hours=1)
NOW = datetime(2026, 4, 15, 10, 20, tzinfo=UTC)  # March is finished
OPEN_NOW = datetime(2026, 3, 15, 10, 20, tzinfo=UTC)  # March is open: its stop is 15 March 10:00
OPEN_STOP = datetime(2026, 3, 15, 10, tzinfo=UTC)


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)


@pytest.fixture(autouse=True)
def _no_rollup_refresh(monkeypatch):
    """`world` would refresh the rollups (over a minute per test in a fresh test database): the worlds here are not settled, and
    the engine, the Check month statement and the fingerprints read the REAL-TIME aggregate of `readings_1h`, which holds the very
    same hourly rows (the test database starts with the watermark at its initial value, so every reading is read from the raw
    table at once): a refresh changes neither a row, a fingerprint nor a figure. A row inserted later is seen at once too."""
    async def nothing(db) -> None:
        pass

    monkeypatch.setattr("test_api_billing_check.settle_rollups", nothing)


@pytest.fixture(autouse=True)
def ledger_state():
    ledger.reset_stats()
    yield
    ledger.reset_stats()


@pytest.fixture
def build_calls(monkeypatch):
    """A list that gets one entry every time the endpoint (or `month_report`) runs the real `build_report`."""
    calls: list[int] = []
    real = billing_check.build_report

    def spy(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(billing_check, "build_report", spy)
    return calls


def ledger_off():
    return mock.patch.dict(os.environ, {"DCDASH_FIGURE_LEDGER": "0"})


@contextlib.contextmanager
def statements():
    """The SQL text of every statement the engine runs inside the block."""
    found: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        found.append(statement)

    sync_engine = get_engine().sync_engine
    event.listen(sync_engine, "before_cursor_execute", record)
    try:
        yield found
    finally:
        event.remove(sync_engine, "before_cursor_execute", record)


async def ask(client, month: str | None = MONTH):
    response = await client.get(URL, params={} if month is None else {"month": month})
    assert response.status_code == 200, response.text
    return response


async def publish(
    start: datetime, stop: datetime, tz_name: str = "UTC", *, engine: str | None = None, shift: timedelta = timedelta(0),
    payload=None, tamper=None,
) -> dict:
    """Write the row of the window the way the worker will: in ONE repeatable-read transaction, the fingerprints, the database
    clock and the report (made without names) are all of one moment. `shift` moves `snapshot_at` and `checked_at` (a row dated in
    the future), `engine` is the build that claims to have made it, `payload` replaces the bytes and `tamper(report)` the
    report before it is encoded. Returns the report."""
    async with get_sessionmaker()() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
        config_fp = await figure_cache.config_fingerprint(session)
        meters = await load_meters(session, await AssetTree.load(session))
        point_ids = sorted({m.point_id for m in meters.values()})
        data_fp = await billing_check.check_data_fingerprint(session, point_ids, start, stop)
        now = (await session.execute(text("SELECT now()"))).scalar_one()
        report = await billing_check.month_report(session, tz_name, start, stop)
        if tamper is not None:
            tamper(report)
        assert await ledger.write(
            session, ledger.CHECK_KIND, start, stop, ledger.check_params(tz_name),
            ledger_codec.encode(report) if payload is None else payload,
            engine=engine or ledger.engine_id(), config_fp=config_fp, data_fp=data_fp,
            snapshot_at=now + shift, checked_at=now + shift,
        )
        await session.commit()
    return report


async def point_of(db, asset_id: int) -> int:
    return await db.fetchval("SELECT point_id FROM mappings WHERE asset_id = $1", asset_id)


async def fingerprint(point_ids, start: datetime, stop: datetime) -> str:
    async with get_sessionmaker()() as session:
        return await billing_check.check_data_fingerprint(session, point_ids, start, stop)


async def served_live(client, month: str | None = MONTH):
    with ledger_off():
        return await ask(client, month)


# ---- (1) a hit is the live answer, byte for byte ------------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["admin", "Reader"])  # with and without `sources.view`
async def test_a_ledger_hit_is_the_live_answer_byte_for_byte(app, db, build_calls, role):
    ids = await world(db)
    await make_role(db, "Reader", ["billing.view"])
    await publish(START, END)
    build_calls.clear()
    ledger.reset_stats()
    async with signed_in(app, db, role, "ruth") as client:
        hit = await ask(client)
        stats = ledger.stats()
        assert (stats["hits_exact"], stats["misses"], stats["errors"]) == (1, 0, 0)  # the ledger path ran ...
        assert build_calls == []  # ... and the engine did not
        live = await served_live(client)
        assert len(build_calls) == 1 and ledger.stats()["hits_exact"] == 1  # (the live request did not touch the ledger)
    assert hit.content == live.content
    silent = by_asset(hit.json(), "silent")[ids["Silent"]]
    if role == "admin":
        assert silent["point"] is not None and silent["source"] is not None
    else:
        assert (silent["point"], silent["source"]) == (None, None)


async def test_both_kinds_of_account_share_one_row_and_get_their_own_names(app, db, build_calls):
    ids = await world(db)
    await make_role(db, "Reader", ["billing.view"])
    await publish(START, END)
    build_calls.clear()
    async with signed_in(app, db, "admin", "ada") as admin, signed_in(app, db, "Reader", "rita") as rita:
        named, plain = await ask(admin), await ask(rita)
    assert ledger.stats()["hits_exact"] == 2 and build_calls == []
    for group in THINGS:
        for item in named.json()["groups"][group]["items"]:
            assert item["point"] is not None and item["source"] is not None
        for item in plain.json()["groups"][group]["items"]:
            assert (item["point"], item["source"]) == (None, None)
    assert by_asset(named.json(), "gaps")[ids["Hole"]]["point"] == "Hole point"


# ---- (2) a finished month, an open month at a frozen now ------------------------------------------------------------------------


async def test_a_finished_month_is_served_from_the_ledger(app, db, build_calls):
    await world(db)
    await publish(START, END)
    build_calls.clear()
    async with signed_in(app, db, "admin", "ada") as client:
        hit = await ask(client)
        live = await served_live(client)
    assert hit.json()["state"] == "finished" and ledger.stats()["hits_exact"] == 1 and len(build_calls) == 1
    assert hit.content == live.content


async def test_an_open_month_at_a_frozen_now_is_served_from_the_ledger(app, db, build_calls, monkeypatch):
    await world(db)
    monkeypatch.setattr("dcdash.api.billing._now", lambda: OPEN_NOW)
    await publish(START, OPEN_STOP)
    build_calls.clear()
    async with signed_in(app, db, "admin", "ada") as client:
        hit = await ask(client)
        monkeypatch.setattr("dcdash.api.billing._now", lambda: OPEN_NOW + timedelta(minutes=30))  # same hour: same stop
        again = await ask(client)
        live = await served_live(client)
    body = hit.json()
    assert (body["state"], body["to"], body["hours"]) == ("open", "2026-03-15T10:00:00Z", 14 * 24 + 10)
    assert ledger.stats()["hits_exact"] == 2 and len(build_calls) == 1
    assert hit.content == again.content == live.content


# ---- (3) a row that is not provably current is not used -------------------------------------------------------------------------


async def fell_back(client, build_calls):
    """Ask once and prove the live code ran and no row was used (a plain miss, not a broken ledger); return the response."""
    ledger.reset_stats()
    build_calls.clear()
    response = await ask(client)
    stats = ledger.stats()
    assert len(build_calls) == 1, "the engine did not run: a row was used"
    assert (stats["hits_exact"], stats["misses"], stats["errors"]) == (0, 1, 0), stats  # a plain miss, not a broken ledger
    assert response.content == (await served_live(client)).content
    return response


async def test_no_row_at_all_is_a_miss(app, db, build_calls):
    await world(db)
    async with signed_in(app, db, "admin", "ada") as client:
        await fell_back(client, build_calls)


async def test_a_moved_row_is_a_miss_and_the_answer_shows_the_new_reading(app, db, build_calls):
    ids = await world(db)
    published = await publish(START, END)
    assert by_asset({"groups": published["groups"]}, "gaps")[ids["Hole"]]["hours"] == 3
    # one more hourly row inside the window, in an hour that had none
    await db.execute(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, 0)",
        await point_of(db, ids["Hole"]), at(2026, 3, 10, 9) + timedelta(minutes=30), 1225.0,
    )
    async with signed_in(app, db, "admin", "ada") as client:
        response = await fell_back(client, build_calls)
    assert by_asset(response.json(), "gaps")[ids["Hole"]]["hours"] == 2  # the stored report (3 hours) was not served


async def test_a_changed_tariff_is_a_miss(app, db, build_calls):
    ids = await world(db)
    published = await publish(START, END)
    before = by_asset({"groups": published["groups"]}, "unpriced")[ids["NoRate"]]["days"]
    await add_tariff(db, 0.5, "2026-03-16", ids["Free"])
    async with signed_in(app, db, "admin", "ada") as client:
        response = await fell_back(client, build_calls)
    assert before == 31 and by_asset(response.json(), "unpriced")[ids["NoRate"]]["days"] < before


async def test_a_changed_mapping_is_a_miss(app, db, build_calls):
    ids = await world(db)
    await publish(START, END)
    await db.execute("UPDATE mappings SET scale = 2.0 WHERE asset_id = $1", ids["Power"])
    async with signed_in(app, db, "admin", "ada") as client:
        await fell_back(client, build_calls)


async def test_a_renamed_asset_is_a_miss(app, db, build_calls):
    ids = await world(db)
    await publish(START, END)
    await db.execute("UPDATE assets SET name = 'Hole renamed' WHERE id = $1", ids["Hole"])
    async with signed_in(app, db, "admin", "ada") as client:
        response = await fell_back(client, build_calls)
    assert by_asset(response.json(), "gaps")[ids["Hole"]]["path"] == "Site / Priced / Hole renamed"


async def test_a_row_of_another_engine_is_a_miss(app, db, build_calls):
    await world(db)
    await publish(START, END, engine="another-build")
    async with signed_in(app, db, "admin", "ada") as client:
        await fell_back(client, build_calls)


async def test_a_row_dated_in_the_future_is_a_miss(app, db, build_calls):
    await world(db)
    await publish(START, END, shift=timedelta(hours=1))
    async with signed_in(app, db, "admin", "ada") as client:
        await fell_back(client, build_calls)


async def test_a_row_of_another_zone_or_window_is_a_miss(app, db, build_calls):
    await world(db)
    await publish(START, END, tz_name="Asia/Qatar")  # the key's params differ
    await publish(START, END - HOUR)  # the key's stop differs
    async with signed_in(app, db, "admin", "ada") as client:
        await fell_back(client, build_calls)


async def test_a_row_that_stays_current_is_used_again_and_again(app, db, build_calls):
    await world(db)
    await publish(START, END)
    build_calls.clear()
    async with signed_in(app, db, "admin", "ada") as client:
        bodies = [(await ask(client)).content for _ in range(3)]
    assert ledger.stats()["hits_exact"] == 3 and build_calls == [] and len(set(bodies)) == 1


# ---- (4) the key includes stop ------------------------------------------------------------------------------------------------


async def test_a_silent_meter_across_an_hour_boundary_is_a_miss_then_the_live_report(app, db, build_calls, monkeypatch):
    await set_zone(db, "UTC")
    site = await make_asset(db, "Site")
    quiet = await meter(db, "Quiet", hours(START, 10 * 24, varying), parent=site, counter=False)  # nothing after 10 March
    stop1 = datetime(2026, 3, 20, 10, tzinfo=UTC)
    stop2 = stop1 + HOUR
    monkeypatch.setattr("dcdash.api.billing._now", lambda: stop1 + timedelta(minutes=20))
    await publish(START, stop1)
    build_calls.clear()
    async with signed_in(app, db, "admin", "ada") as client:
        first = await ask(client)
        assert ledger.stats()["hits_exact"] == 1 and build_calls == []
        monkeypatch.setattr("dcdash.api.billing._now", lambda: stop2 + timedelta(minutes=5))  # no new row has landed
        second = await ask(client)
        assert ledger.stats()["hits_exact"] == 1 and ledger.stats()["misses"] == 1 and len(build_calls) == 1
        live = await served_live(client)
    # no row landed, so the fingerprint of the longer window is the same: only the key (its stop) stood between the old report
    # and the new hour
    point = await point_of(db, quiet)
    assert await fingerprint([point], START, stop1) == await fingerprint([point], START, stop2)
    assert second.json()["hours"] == first.json()["hours"] + 1
    assert by_asset(second.json(), "silent")[quiet]["hours"] == by_asset(first.json(), "silent")[quiet]["hours"] + 1
    assert second.content == live.content


# ---- (5) the fingerprint ------------------------------------------------------------------------------------------------------


async def test_the_fingerprint_hashes_exactly_the_rows_the_report_reads(db):
    await world(db)
    only_before = await meter(db, "Retired", hours(at(2026, 2, 10), 48))  # rows before the window, none in it, none after
    point_ids = [r["point_id"] for r in await db.fetch("SELECT point_id FROM mappings ORDER BY point_id")]
    start, end = START + timedelta(days=9), START + timedelta(days=20)  # rows before it, in it and after it
    args = {"ids": point_ids, "start": start, "end": end}
    async with get_sessionmaker()() as session:
        wrapped = [(r.kind, r.point_id, r.bucket) for r in await session.execute(billing_check._FINGERPRINT_KEYS, args)]
        read = [(r.kind, r.point_id, r.bucket) for r in await session.execute(billing_check._ROWS, args)]
    assert sorted(wrapped) == sorted(read)
    kinds = {kind: [row for row in read if row[0] == kind] for kind in ("row", "before", "first")}
    assert all(kinds.values()) and len(read) == sum(map(len, kinds.values()))
    retired = await point_of(db, only_before)
    assert {kind for kind, point, _ in read if point == retired} == {"before", "first"}  # a point with only a `before` row
    assert await db.fetchval("SELECT count(*) FROM readings_1h WHERE bucket >= $1", end) > 0  # rows after the window exist ...
    assert not [row for row in kinds["row"] if row[2] >= end or row[2] < start]  # ... and are not read as rows of it
    # the wrapped text is the statement itself without its final ORDER BY (it cannot drift from what the report reads)
    assert billing_check._ROWS_BODY == billing_check._ROWS.text.rstrip().removesuffix("ORDER BY point_id, bucket")
    assert not billing_check._ROWS_BODY.rstrip().endswith("bucket")  # the sort of the union is gone
    assert "ORDER BY point_id" not in billing_check._ROWS_BODY


async def test_the_fingerprint_moves_with_every_row_the_report_reads_and_with_nothing_else(db):
    ids = await world(db)
    everyone = [r["point_id"] for r in await db.fetch("SELECT point_id FROM mappings ORDER BY point_id")]
    hole, midmonth = await point_of(db, ids["Hole"]), await point_of(db, ids["Midmonth"])
    start = START + timedelta(days=9)  # 10 March: most points have rows before it, in it, and (April) after it

    async def fp(points) -> str:
        return await fingerprint(points, start, END)

    async def add(point: int, moment: datetime, value: float) -> None:
        await db.execute("INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, 0)", point, moment, value)

    base, only_midmonth = await fp(everyone), await fp([midmonth])
    assert [part.split(":")[0] for part in base.split(";")] == ["before", "first", "row"]
    assert await fp(everyone) == base  # stable

    await add(hole, at(2026, 4, 5, 3), 5000.0)  # after the window: not read by the report, not in the fingerprint
    assert await fp(everyone) == base
    await add(hole, at(2026, 3, 10, 9) + timedelta(minutes=30), 1225.0)  # in the window, for another point than the one asked
    assert await fp([midmonth]) == only_midmonth
    assert await fp(everyone) != base  # in the window, for a point that is asked
    moved = await fp(everyone)
    await add(midmonth, at(2026, 2, 25, 6), 77.0)  # before the window: a new `before` row (and a new first bucket)
    assert await fp(everyone) != moved
    assert await fp([midmonth]) != only_midmonth


async def test_a_value_changed_in_place_changes_the_fingerprint(db):
    ids = await world(db)
    everyone = [r["point_id"] for r in await db.fetch("SELECT point_id FROM mappings ORDER BY point_id")]
    base = await fingerprint(everyone, START, END)
    # a second sample inside an hour that already has a row changes the hour's min, max, sum and n
    await db.execute(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, 0)",
        await point_of(db, ids["Silent"]), at(2026, 3, 5, 6) + timedelta(minutes=40), 9999.0,
    )
    assert await fingerprint(everyone, START, END) != base


async def test_no_row_at_all_gives_the_empty_fingerprint(db):
    await world(db)
    assert await fingerprint([], START, END) == ""
    assert await fingerprint([987654], START, END) == ""


# ---- (6) apply_names ----------------------------------------------------------------------------------------------------------


def random_world(seed: int) -> dict:
    """The arguments of one `build_report` call on a random tree, random meters and a random range (a whole month, a month not
    begun, the first hour only, an open month, an empty tree), as the Check month unit tests build them; names for half of them."""
    rng = random.Random(seed)
    zone_name = rng.choice(CHECK_ZONES)
    start, stop = month_bounds(f"2026-{rng.randint(1, 12):02d}", zone_name)
    shape = seed % 6
    if shape == 1:
        stop = start
    elif shape == 2:
        stop = start + HOUR
    elif shape == 3:
        stop = start + HOUR * rng.randint(2, 500) + timedelta(minutes=rng.choice([0, 20, 59]))
    nodes: list[AssetNode] = []
    for index in range(0 if shape == 4 else rng.randint(1, 14)):
        nodes.append(AssetNode(index + 1, rng.choice([None, *(n.id for n in nodes)]), rng.choice(CHECK_NAMES), rng.randint(0, 2)))
    hour_starts = [start + HOUR * i for i in range(max(0, int((stop - start) / HOUR)))]
    inputs = []
    for node in nodes:
        if rng.random() < 0.3:
            continue
        counter = rng.random() < 0.6
        before = (crow if counter else prow)(start - HOUR * rng.randint(1, 900), rng.uniform(0, 100)) if rng.random() < 0.3 else None
        mode = rng.choice(["rows", "rows", "rows", "silent", "never", "later", "late_start"])
        rows = (
            [] if mode in ("silent", "never", "later")
            else check_rows(rng, hour_starts[rng.randint(0, len(hour_starts) // 2) if mode == "late_start" else 0:], counter)
        )
        first = (
            before.bucket if before is not None else rows[0].bucket if rows else
            stop + HOUR * rng.randint(1, 100) if mode == "later" else None
        )
        meter_ = Meter(node.id * 10, rng.choice([1.0, 1.0, 2.0, -1.0, 0.001]), rng.choice([60, 900, 1800, 3600, 7200]), counter)
        inputs.append(MeterInput(node.id, meter_, rows, before, first))
    salt = rng.randint(0, 6)
    names = {n.id: (rng.choice(POINT_NAMES), rng.choice(SOURCE_NAMES)) for n in nodes if rng.random() < 0.7}
    names[10_000] = ("a point of no asset of this tree", "a source")  # a name nobody asks for
    return {
        "tree": AssetTree(nodes), "inputs": inputs, "start": start, "stop": stop, "zone": ZoneInfo(zone_name),
        "rate_for": lambda asset, day: None if salt and (asset + day.toordinal()) % (salt + 4) == 0 else 0.1 * (1 + asset % 3),
        "names": names,
    }


def report_of(world_: dict, names) -> dict:
    return build_report(
        world_["tree"], world_["inputs"], start=world_["start"], stop=world_["stop"], rate_for=world_["rate_for"],
        zone=world_["zone"], names=names,
    )


def bytes_of(report: dict) -> bytes:
    return json.dumps(report).encode()  # what a response writes: key order and every digit count, a dict comparison ignores order


def test_apply_names_on_a_report_without_names_is_the_report_with_names_on_random_worlds():
    seen = {"named": 0, "capped": 0, "empty": 0}
    for seed in range(120):
        world_ = random_world(seed)
        bare = report_of(world_, None)
        with_names = report_of(world_, world_["names"])
        patched = billing_check.apply_names(copy.deepcopy(bare), world_["names"])
        assert bytes_of(patched) == bytes_of(with_names), f"seed {seed}"
        assert patched == with_names
        seen["named"] += any(
            item["point"] is not None for group in THINGS for item in with_names["groups"][group]["items"]
        )
        seen["capped"] += any(with_names["groups"][group]["total"] > len(with_names["groups"][group]["items"]) for group in THINGS)
        seen["empty"] += with_names["hours"] == 0
    assert seen["named"] > 20 and seen["empty"] > 10, seen  # the worlds reached names and the empty ranges


def test_apply_names_keeps_the_cap_the_sort_order_and_the_untouched_groups():
    start, stop = START, START + 30 * HOUR
    nodes = [AssetNode(1, None, "Site", 0)] + [AssetNode(2 + n, 1, f"Feed {n:02d}", 0) for n in range(70)]
    nodes += [AssetNode(100, 1, "Bare leaf", 0), AssetNode(101, 1, "Not yet", 0)]
    inputs = [
        MeterInput(2 + n, Meter((2 + n) * 10, 1.0, 1800, False), [prow(start + HOUR * i, 5.0 + i % 5) for i in range(30)], None, start)
        for n in range(70)
    ]
    inputs.append(MeterInput(101, Meter(1010, 1.0, 1800, False), [], None, stop + 5 * HOUR))  # first reading after the range: `later`
    names = {2 + n: (f"point {n}", f"source {n % 3}") for n in range(0, 70, 2)}  # every other feed has names
    world_ = {
        "tree": AssetTree(nodes), "inputs": inputs, "start": start, "stop": stop, "zone": ZoneInfo("UTC"),
        "rate_for": lambda asset, day: 0.1,
    }
    bare = report_of(world_, None)
    with_names = report_of(world_, names)
    assert bare["groups"]["estimated"]["total"] == 70 > CAP == len(bare["groups"]["estimated"]["items"])  # the cap is in play
    assert bare["groups"]["unmetered"]["total"] == 1 and bare["groups"]["later"]["total"] == 1
    untouched = copy.deepcopy({name: bare["groups"][name] for name in ("unmetered", "later")})

    patched = billing_check.apply_names(bare, names)

    assert patched is bare  # in place
    assert bytes_of(patched) == bytes_of(with_names)
    assert [item["asset_id"] for item in patched["groups"]["estimated"]["items"]] == sorted(
        item["asset_id"] for item in patched["groups"]["estimated"]["items"]
    )  # the order the sort keys gave (all equal but the path): names did not move anything
    assert {name: patched["groups"][name] for name in ("unmetered", "later")} == untouched
    for name in ("unmetered", "later"):
        assert all("point" not in item and "source" not in item for item in patched["groups"][name]["items"])
    named = [item for item in patched["groups"]["estimated"]["items"] if item["point"] is not None]
    assert named and len(named) < len(patched["groups"]["estimated"]["items"])  # the assets without a name stay None, None


# ---- (7) nothing to look at: nothing is read, the ledger is not consulted ---------------------------------------------------


async def test_a_month_not_begun_reads_nothing_and_never_consults_the_ledger(app, db, monkeypatch):
    await set_zone(db, "UTC")
    await meter(db, "Panel", hours(at(2026, 4, 1), 48))
    consulted = []

    async def spy(*args, **kwargs):
        consulted.append(args)
        return None

    monkeypatch.setattr(ledger, "read_check", spy)
    async with signed_in(app, db, "admin", "ada") as client:
        with statements() as found:
            body = (await ask(client, "2026-05")).json()  # NOW is 15 April
    assert body["state"] == "not_begun" and body["hours"] == 0
    assert consulted == [] and not [s for s in found if "readings_1h" in s or "figure_ledger" in s]
    assert ledger.stats() == {"hits_exact": 0, "hits_open": 0, "misses": 0, "errors": 0}


async def test_the_first_hour_of_an_open_month_reads_nothing_and_never_consults_the_ledger(app, db, monkeypatch):
    await set_zone(db, "UTC")
    await meter(db, "Panel", hours(at(2026, 3, 1), 48))
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 4, 1, 0, 40, tzinfo=UTC))
    consulted = []

    async def spy(*args, **kwargs):
        consulted.append(args)
        return None

    monkeypatch.setattr(ledger, "read_check", spy)
    async with signed_in(app, db, "admin", "ada") as client:
        with statements() as found:
            body = (await ask(client, "2026-04")).json()
    assert (body["state"], body["hours"], body["to"]) == ("open", 0, "2026-04-01T00:00:00Z")
    assert consulted == [] and not [s for s in found if "readings_1h" in s or "figure_ledger" in s]


async def test_a_tree_with_no_meters_never_consults_the_ledger(app, db, monkeypatch):
    await set_zone(db, "UTC")
    site = await make_asset(db, "Site")
    await make_asset(db, "Rack", site)
    consulted = []

    async def spy(*args, **kwargs):
        consulted.append(args)
        return None

    monkeypatch.setattr(ledger, "read_check", spy)
    async with signed_in(app, db, "admin", "ada") as client:
        body = (await ask(client)).json()
    assert body["meters"] == 0 and body["groups"]["unmetered"]["total"] == 1 and consulted == []


@pytest.mark.parametrize("switch", [{"DCDASH_FIGURE_LEDGER": "0"}, {"DCDASH_FIGURE_CACHE": "0"}])
async def test_with_the_ledger_or_the_figure_cache_off_the_ledger_is_not_asked(app, db, build_calls, switch):
    await world(db)
    await publish(START, END)
    build_calls.clear()
    async with signed_in(app, db, "admin", "ada") as client:
        with mock.patch.dict(os.environ, switch), statements() as found:
            await ask(client)
    assert len(build_calls) == 1 and not [s for s in found if "figure_ledger" in s or "billing_check data fingerprint" in s]
    assert ledger.stats() == {"hits_exact": 0, "hits_open": 0, "misses": 0, "errors": 0}


# ---- (8) a ledger that fails never fails the request ------------------------------------------------------------------------


async def test_a_read_that_raises_is_the_live_answer_and_a_200(app, db, build_calls, monkeypatch):
    await world(db)
    await publish(START, END)

    async def broken(*args, **kwargs):
        raise ProgrammingError("SELECT ...", {}, Exception('relation "figure_ledger" does not exist'))

    async with signed_in(app, db, "admin", "ada") as client:
        live = await served_live(client)
        monkeypatch.setattr(ledger, "read_check", broken)
        build_calls.clear()
        response = await ask(client)
        assert len(build_calls) == 1 and ledger.stats()["errors"] == 1 and ledger.stats()["hits_exact"] == 0
        assert response.content == live.content
        await ask(client)  # and the next request works too
        assert ledger.stats()["errors"] == 2


async def test_a_statement_that_fails_in_the_database_leaves_the_requests_transaction_usable(app, db, build_calls, monkeypatch):
    ids = await world(db)
    await publish(START, END)
    # A real SQL error inside the savepoint (the table is "missing"): the transaction is aborted until the savepoint is rolled
    # back. The live code that follows (the inputs, the names, the tariffs: an account with `sources.view`) must still run.
    monkeypatch.setattr(ledger, "_CHECK", text(
        "SELECT now() AS now FROM figure_ledger_that_is_not_there "
        "WHERE :k = :k AND :s = :s AND :e = :e AND :p = :p AND :config_fp = :config_fp AND :data_fp = :data_fp"
    ))
    async with signed_in(app, db, "admin", "ada") as client:
        live = await served_live(client)
        build_calls.clear()
        response = await ask(client)
    assert len(build_calls) == 1 and ledger.stats()["errors"] == 1 and ledger.stats()["hits_exact"] == 0
    assert response.content == live.content
    assert by_asset(response.json(), "silent")[ids["Silent"]]["point"] is not None  # `_names` ran after the failure


@pytest.mark.parametrize("name, payload, tamper", [
    ("not zlib", b"this is not a zlib stream", None),
    ("a zlib stream of something else", zlib.compress(b'{"not":"a ledger value"}'), None),
    ("a truncated stream", ledger_codec.encode({"hours": 1, "groups": {}})[:-4], None),
    ("an empty report", ledger_codec.encode({}), None),
    ("a report without its groups", ledger_codec.encode({"hours": 1, "meters": 1, "meter_hours": 1, "things": 0, "groups": {}}), None),
    ("an item without its names", None, lambda report: report["groups"]["silent"]["items"][0].pop("point")),
    ("an item without its asset", None, lambda report: report["groups"]["gaps"]["items"][0].pop("asset_id")),
])
async def test_a_row_that_cannot_be_used_is_the_live_answer_and_a_200(app, db, build_calls, name, payload, tamper):
    await world(db)
    await publish(START, END, payload=payload, tamper=tamper)
    async with signed_in(app, db, "admin", "ada") as client:
        live = await served_live(client)
        ledger.reset_stats()
        build_calls.clear()
        response = await ask(client)
    stats = ledger.stats()
    assert len(build_calls) == 1, name
    assert (stats["hits_exact"], stats["errors"]) == (0, 1), (name, stats)
    assert response.content == live.content


# ---- (9) `closed` and `state` are per request -----------------------------------------------------------------------------------


async def test_closed_stays_per_request_while_the_row_keeps_serving(app, db, build_calls):
    await world(db)
    await publish(START, END)
    build_calls.clear()
    async with signed_in(app, db, "admin", "ada") as client:
        before = await ask(client)
        assert before.json()["closed"] is False and ledger.stats()["hits_exact"] == 1
        closed = await client.post(f"/api/billing/months/{MONTH}/close", json={"note": "checked first"})
        assert closed.status_code == 201, closed.text
        after = await ask(client)
        assert after.json()["closed"] is True and ledger.stats()["hits_exact"] == 2  # still from the ledger
        assert {**after.json(), "closed": False} == before.json()
        reopened = await client.post(f"/api/billing/months/{MONTH}/reopen", json={"note": "back to live figures"})
        assert reopened.status_code == 200, reopened.text
        again = await ask(client)
        assert again.json()["closed"] is False and ledger.stats()["hits_exact"] == 3
        assert again.content == before.content
    assert build_calls == []


async def test_the_state_comes_from_the_request_not_from_the_row(app, db, build_calls, monkeypatch):
    await world(db)
    monkeypatch.setattr("dcdash.api.billing._now", lambda: OPEN_NOW)
    await publish(START, OPEN_STOP)
    async with signed_in(app, db, "admin", "ada") as client:
        assert (await ask(client)).json()["state"] == "open"
        # the same window asked from a clock that says the month is finished would be another key (its stop is the month's end),
        # so nothing is served for it from this row
        monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)
        ledger.reset_stats()
        finished = await ask(client)
    assert finished.json()["state"] == "finished" and finished.json()["to"] == "2026-04-01T00:00:00Z"
    assert ledger.stats()["hits_exact"] == 0 and ledger.stats()["misses"] == 1


# ---- (10) month_report is plain JSON ------------------------------------------------------------------------------------------


def assert_plain(value, path: str = "report") -> None:
    kind = type(value)
    if kind is dict:
        for key, item in value.items():
            assert type(key) is str, f"{path}: key {key!r}"
            assert_plain(item, f"{path}.{key}")
    elif kind is list:
        for index, item in enumerate(value):
            assert_plain(item, f"{path}[{index}]")
    else:
        assert value is None or kind in (bool, int, float, str), f"{path}: {kind.__name__}"


async def test_month_report_is_plain_json_and_goes_through_the_codec_unchanged(db):
    ids = await world(db)  # gaps, resets, estimated (power) hours, unpriced hours, a silent meter, a standing-still one
    async with get_sessionmaker()() as session:
        report = await billing_check.month_report(session, "UTC", START, END)
    assert_plain(report)
    for group in (*THINGS, "unmetered", "later"):
        assert report["groups"][group]["total"] >= 1, group
    assert by_asset({"groups": report["groups"]}, "resets")[ids["Reset"]]["events"]  # (a list of dicts)
    assert all(item["point"] is None and item["source"] is None for group in THINGS for item in report["groups"][group]["items"])

    raw = ledger_codec.encode(report)  # refuses a tuple, a non-str key or any other type
    back = ledger_codec.decode_json(raw)
    assert ledger_codec.canonical(back) == ledger_codec.canonical(report)
    assert json.dumps(back) == json.dumps(report) and back == report
    assert report == json.loads(json.dumps(report))


async def test_month_report_of_an_empty_range_and_of_a_tree_without_meters_is_the_endpoints(db):
    await set_zone(db, "UTC")
    site = await make_asset(db, "Site")
    await make_asset(db, "Rack", site)
    async with get_sessionmaker()() as session:
        empty_tree = await billing_check.month_report(session, "UTC", START, END)
        not_begun = await billing_check.month_report(session, "UTC", START, START)
    assert empty_tree["hours"] == 744 and empty_tree["meters"] == 0 and empty_tree["groups"]["unmetered"]["total"] == 1  # the Rack
    assert not_begun["hours"] == 0 and all(group["total"] == 0 for group in not_begun["groups"].values())
    for report in (empty_tree, not_begun):
        assert_plain(report)
        assert ledger_codec.canonical(ledger_codec.decode_json(ledger_codec.encode(report))) == ledger_codec.canonical(report)


async def test_the_ledger_serves_a_month_with_no_meter_readings_at_all(app, db, build_calls):
    """Every meter has never recorded: the fingerprint is the empty string, and a row for it is still a row."""
    await set_zone(db, "UTC")
    site = await make_asset(db, "Site")
    await meter(db, "First", [], parent=site)
    await meter(db, "Second", [], parent=site, counter=False)
    await publish(START, END)
    build_calls.clear()
    async with signed_in(app, db, "admin", "ada") as client:
        hit = await ask(client)
        live = await served_live(client)
    assert ledger.stats()["hits_exact"] == 1 and hit.content == live.content and hit.json()["meters"] == 2


async def test_an_anonymous_request_is_refused_before_the_ledger_is_asked(app, db, client):
    """The anonymous request is refused before the ledger is asked (the gate comes first)."""
    await world(db)
    await publish(START, END)
    assert (await client.get(URL, params={"month": MONTH})).status_code == 401
    assert ledger.stats() == {"hits_exact": 0, "hits_open": 0, "misses": 0, "errors": 0}
    await login_as(client, db, "admin")
    assert (await client.get(URL, params={"month": MONTH})).status_code == 200 and ledger.stats()["hits_exact"] == 1
