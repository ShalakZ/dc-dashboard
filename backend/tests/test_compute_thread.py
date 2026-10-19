"""The compute thread (core/compute.py): the engine's pure Python runs on one worker thread so the event loop stays free."""
import asyncio
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from dcdash.api import billing_check, data
from dcdash.core import compute, energy
from dcdash.core.db import get_sessionmaker
from dcdash.core.tree import AssetTree
from helpers import login_as, make_asset


def thread_name() -> str:
    return threading.current_thread().name


async def test_run_executes_on_a_compute_thread_and_not_on_the_loop_thread():
    name = await compute.run(thread_name)

    assert name.startswith("dcdash-compute")
    assert name != threading.current_thread().name


async def test_run_passes_the_positional_arguments_and_returns_the_result():
    assert await compute.run(lambda a, b, c: (a, b, c), 1, "two", [3]) == (1, "two", [3])


async def test_two_concurrent_runs_execute_one_after_the_other_never_overlapping():
    lock = threading.Lock()
    active = 0
    most = 0
    spans: list[tuple[float, float]] = []

    def work(pause: float) -> str:
        nonlocal active, most
        with lock:
            active += 1
            most = max(most, active)
        started = time.perf_counter()
        time.sleep(pause)
        finished = time.perf_counter()
        with lock:
            active -= 1
            spans.append((started, finished))
        return thread_name()

    names = await asyncio.gather(compute.run(work, 0.05), compute.run(work, 0.05))

    assert most == 1
    assert len(set(names)) == 1  # one worker thread, not two
    (first_start, first_end), (second_start, _) = sorted(spans)
    assert second_start >= first_end >= first_start


async def test_an_exception_propagates_to_the_awaiter_and_the_thread_goes_on():
    def fail() -> None:
        raise ValueError("no figure")

    with pytest.raises(ValueError, match="no figure"):
        await compute.run(fail)

    assert (await compute.run(thread_name)).startswith("dcdash-compute")


async def test_shutdown_then_run_works_again():
    before = await compute.run(thread_name)
    compute.shutdown()
    compute.shutdown()  # a second call, with nothing to stop, is harmless

    after = await compute.run(thread_name)

    assert before.startswith("dcdash-compute") and after.startswith("dcdash-compute")


def test_the_switch_interval_is_one_millisecond_after_import():
    # A thread hands the GIL back to the loop every millisecond instead of every five: the loop takes the GIL again after every
    # socket wait, so with 5 ms a request with a few waits could take 15 to 30 ms.
    assert sys.getswitchinterval() == 0.001


async def test_the_loop_keeps_ticking_while_a_pure_function_burns_300_ms_of_cpu():
    def burn() -> int:
        end = time.perf_counter() + 0.3
        count = 0
        while time.perf_counter() < end:
            count += sum(range(1000))
        return count

    loop = asyncio.get_running_loop()
    stamps: list[float] = []
    running = True

    async def ticker() -> None:
        while running:
            stamps.append(loop.time())
            await asyncio.sleep(0.01)

    task = asyncio.create_task(ticker())
    await asyncio.sleep(0.05)  # the ticker is running before the burn starts
    began = len(stamps)
    await compute.run(burn)
    running = False
    await task

    during = stamps[began - 1:]
    gaps = [later - earlier for earlier, later in zip(during, during[1:])]
    # A smoke test with a wide bound, so that a loaded machine does not fail it (a cache task left running by an earlier test
    # can queue ahead of the burn): run inline, the 300 ms would be ONE gap of more than 300 ms and about one tick.
    assert len(during) >= 5, f"the loop ticked only {len(during)} times while the thread burned 300 ms"
    assert max(gaps) < 0.3, f"the loop was blocked for {max(gaps) * 1000:.0f} ms"


# ---- who runs on the thread -----------------------------------------------------------------------------------------------


def spy(monkeypatch, module, name: str) -> list[str]:
    """Wrap `module.name` so each call records the name of the thread it ran on; returns that list."""
    original = getattr(module, name)
    seen: list[str] = []

    def wrapper(*args, **kwargs):
        seen.append(threading.current_thread().name)
        return original(*args, **kwargs)

    monkeypatch.setattr(module, name, wrapper)
    return seen


async def test_hourly_energy_assembles_on_the_compute_thread(db, monkeypatch):
    await make_asset(db, "Site")
    seen = spy(monkeypatch, energy, "assemble")
    start = datetime(2026, 6, 10, tzinfo=timezone.utc)

    async with get_sessionmaker()() as session:
        result = await energy.hourly_energy(session, await AssetTree.load(session), start, start + timedelta(hours=3))

    assert len(result.hours) == 1
    assert len(seen) == 1 and seen[0].startswith("dcdash-compute")


async def test_hourly_energy_still_refuses_a_naive_datetime(db):
    async with get_sessionmaker()() as session:
        with pytest.raises(ValueError, match="timezone"):
            await energy.hourly_energy(session, await AssetTree.load(session), datetime(2026, 6, 10), datetime(2026, 6, 11))


async def test_the_summaries_price_today_on_the_compute_thread(client, db, monkeypatch):
    await make_asset(db, "Site")
    await login_as(client, db, "admin")
    seen = spy(monkeypatch, data, "cost_by_hour")

    response = await client.get("/api/fleet/summary")

    assert response.status_code == 200
    assert len(seen) == 1 and seen[0].startswith("dcdash-compute")


async def test_check_month_builds_its_report_on_the_compute_thread(client, db, monkeypatch):
    await make_asset(db, "Site")
    await login_as(client, db, "admin")
    seen = spy(monkeypatch, billing_check, "build_report")

    response = await client.get("/api/billing/month-check", params={"month": "2026-03"})

    assert response.status_code == 200
    assert len(seen) == 1 and seen[0].startswith("dcdash-compute")
