"""The event loop stays free while the engine works (w26 R3): the rows are read in chunks and `assemble` runs on the compute
thread, so a request that arrives meanwhile (`GET /api/me`, every 50 ms) is answered at once.

The world is 240 meters under a site on five levels with 30 days of hourly rows (172,800 of them), enough for one `assemble` to
take a few hundred milliseconds. The rows are read through the real-time rollup view, not materialized (a refresh of that many
rows takes minutes in the test container, and the read is the same code either way). Numbers are printed (pytest -s) so a slow
machine can be read, not guessed; the bounds are loose on purpose (a CI machine, a test that must not flake)."""
import asyncio
import time
from datetime import datetime, timedelta, timezone

import pytest

from dcdash.core import energy
from dcdash.core.db import get_sessionmaker
from dcdash.core.tree import AssetTree
from helpers import login_as, make_asset, make_source

T0 = datetime(2026, 9, 1, tzinfo=timezone.utc)
HOURS = 30 * 24
END = T0 + timedelta(hours=HOURS)
FAN_OUT = (2, 3, 4, 10)  # children per asset at each level; the last level is the meters: 2 x 3 x 4 x 10 = 240


async def build_world(db) -> int:
    """240 kWh counters (the leaves of a tree 2 x 3 x 4 x 10 under one site), one reading an hour from the hour before T0 to the
    last hour of the window, so every hour has a row and the first has a baseline. Returns the number of meters."""
    source = await make_source(db)
    level = [await make_asset(db, "Site")]
    for depth, fan in enumerate(FAN_OUT[:-1]):
        level = [await make_asset(db, f"L{depth}.{parent}.{child}", parent) for parent in level for child in range(fan)]
    for parent in level:  # the meters, one statement per lowest parent
        await db.execute(
            "INSERT INTO assets (name, parent_id) SELECT 'Meter ' || $1::int::text || '.' || g, $1::int FROM generate_series(0, $2::int - 1) g",
            parent, FAN_OUT[-1],
        )
    await db.execute(
        "INSERT INTO points (source_id, address, name) SELECT $1, 'p' || id, name FROM assets WHERE name LIKE 'Meter %'", source
    )
    await db.execute(
        "INSERT INTO mappings (point_id, asset_id, metric, scale, interval_seconds) "
        "SELECT p.id, a.id, 'energy_kwh', 1.0, 3600 FROM assets a JOIN points p ON p.name = a.name"
    )
    await db.execute(
        """
        INSERT INTO readings (point_id, ts, value, quality)
        SELECT m.point_id, $1::timestamptz + g * interval '1 hour', 100 + g * 1.37 + m.point_id * 0.0113 + (g % 7) * 0.001, 0
        FROM mappings m CROSS JOIN generate_series(-1, $2::int - 1) AS g
        """,
        T0, HOURS,
    )
    return await db.fetchval("SELECT count(*) FROM mappings")


def p95(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))]


async def waits_of_me_during(client, work) -> list[float]:
    """Await `work()` while `GET /api/me` is due every 50 ms; the waits (from the moment a request was DUE to its answer, so a
    blocked loop shows up as a late request, not as a short one) of the requests that fell due while `work` ran."""
    loop = asyncio.get_running_loop()
    samples: list[tuple[float, float]] = []
    ended: float | None = None

    async def poll() -> None:
        due = loop.time()
        while ended is None or due <= ended:  # after the work, go on until every request that fell due during it is answered
            if due > loop.time():
                await asyncio.sleep(due - loop.time())
            response = await client.get("/api/me")
            assert response.status_code == 200
            samples.append((due, loop.time() - due))
            due += 0.05

    poller = asyncio.create_task(poll())
    await asyncio.sleep(0.3)  # the poller is warm (first request done) before the work starts
    began = loop.time()
    await work()
    ended = loop.time()
    await poller
    waits = [wait for due, wait in samples if began <= due <= ended]
    assert len(waits) >= 5, f"only {len(waits)} requests fell due while the work ran ({ended - began:.2f} s)"
    return waits


async def gaps_during(awaitable) -> tuple[object, list[float], float]:
    """Await `awaitable` while a task takes a turn of the loop as often as it can (`sleep(0)`); returns its result, the gaps
    between the task's turns (the longest stretch the awaitable held the loop is the largest gap) and the time it took."""
    loop = asyncio.get_running_loop()
    gaps: list[float] = []
    running = True

    async def ticker() -> None:
        last = loop.time()
        while running:
            await asyncio.sleep(0)
            now = loop.time()
            gaps.append(now - last)
            last = now

    task = asyncio.create_task(ticker())
    await asyncio.sleep(0.05)
    before, began = len(gaps), time.perf_counter()
    try:
        result = await awaitable
    finally:
        took = time.perf_counter() - began
        running = False
        await task
    return result, gaps[before:], took


async def test_the_chunked_read_never_holds_the_loop_for_long_and_files_the_same_rows(db):
    meters = await build_world(db)
    async with get_sessionmaker()() as session:
        tree = await AssetTree.load(session)
        found = await energy.load_meters(session, tree)
        params = {
            "ids": sorted({m.point_id for m in found.values()}),
            "counter_ids": sorted({m.point_id for m in found.values() if m.counter}),
            "start": T0,
            "end": END,
        }

        async def one_shot() -> energy.EnergyRows:
            return energy._collect(await session.execute(energy._ROWS, params))  # the old way: every row at once

        read, gaps, took = await gaps_during(energy.read_energy_rows(session, found, T0, END))
        whole, whole_gaps, whole_took = await gaps_during(one_shot())

    rows = sum(len(part) for part in read.rows.values())
    print(f"\nchunked read: {meters} meters, {rows} rows in {took * 1000:.0f} ms, longest gap between loop turns "
          f"{max(gaps) * 1000:.1f} ms over {len(gaps)} turns; read at once: {whole_took * 1000:.0f} ms, longest gap "
          f"{max(whole_gaps) * 1000:.1f} ms")
    assert meters == 240 and rows == 240 * HOURS
    assert rows > 5 * energy.PART_ROWS  # the read crossed many parts
    assert read == whole  # rows split across parts are filed exactly as the one-shot read files them (R1)
    assert len(gaps) > 20  # the loop took many turns during the read: it was not held to the end
    assert max(gaps) < 0.1, f"the loop was held for {max(gaps) * 1000:.0f} ms during the read"
    if max(whole_gaps) < 0.1:
        pytest.skip(f"reading at once held the loop only {max(whole_gaps) * 1000:.0f} ms here: too fast to tell the two apart")
    assert max(gaps) < max(whole_gaps)


async def test_assemble_on_the_thread_leaves_get_api_me_waiting_little(client, db):
    await build_world(db)
    await login_as(client, db, "admin")
    async with get_sessionmaker()() as session:
        tree = await AssetTree.load(session)
        sizes: list[float] = []

        async def threaded() -> None:
            began = time.perf_counter()
            result = await energy.hourly_energy(session, tree, T0, END)
            sizes.append(time.perf_counter() - began)
            assert len(result.hours[tree.roots()[0]]) == HOURS

        waits = await waits_of_me_during(client, threaded)

    print(f"\nthreaded hourly_energy ({sizes[0] * 1000:.0f} ms): GET /api/me waited p95 {p95(waits) * 1000:.0f} ms, "
          f"max {max(waits) * 1000:.0f} ms over {len(waits)} requests")
    assert p95(waits) < 0.15


async def test_assemble_in_the_loop_the_old_way_made_the_same_request_wait_longer(client, db):
    await build_world(db)
    await login_as(client, db, "admin")
    async with get_sessionmaker()() as session:
        tree = await AssetTree.load(session)
        meters = await energy.load_meters(session, tree)
        spent: dict[str, float] = {}

        async def inline() -> None:
            read = await energy.read_energy_rows(session, meters, T0, END)
            began = time.perf_counter()
            energy.assemble(tree, meters, read.rows, read.baselines, T0, END, read.first_buckets)  # in the loop, as before
            spent["assemble"] = time.perf_counter() - began

        async def threaded() -> None:
            await energy.hourly_energy(session, tree, T0, END)

        old = await waits_of_me_during(client, inline)
        new = await waits_of_me_during(client, threaded)

    print(f"\nassemble in the loop ({spent['assemble'] * 1000:.0f} ms): GET /api/me waited p95 {p95(old) * 1000:.0f} ms, "
          f"max {max(old) * 1000:.0f} ms; on the thread: p95 {p95(new) * 1000:.0f} ms, max {max(new) * 1000:.0f} ms")
    if spent["assemble"] < 0.15:
        pytest.skip(f"this machine assembles the world in {spent['assemble'] * 1000:.0f} ms: too fast to block the loop visibly")
    assert max(old) > max(new)
    assert p95(old) > p95(new)
