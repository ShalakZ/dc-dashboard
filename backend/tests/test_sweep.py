import asyncio
import time

from dcdash.collector import sweep as sweep_module
from dcdash.collector.sweep import SWEEP_CONCURRENCY, SWEEP_RATE_PER_SECOND, SWEEP_TIMEOUT, sweep
from helpers import free_port, silent_server


async def test_returns_only_the_pairs_that_accept_in_input_order():
    async with silent_server() as open_a, silent_server() as open_b:
        closed = free_port()
        pairs = [("127.0.0.1", open_b), ("127.0.0.1", closed), ("127.0.0.1", open_a)]
        assert await sweep(pairs, timeout=1.0) == [("127.0.0.1", open_b), ("127.0.0.1", open_a)]


async def test_unresolvable_hosts_are_simply_closed():
    assert await sweep([("no-such-host.invalid", 502)], timeout=1.0) == []


def test_defaults_match_the_spec():
    assert (SWEEP_CONCURRENCY, SWEEP_RATE_PER_SECOND, SWEEP_TIMEOUT) == (64, 200.0, 1.0)


async def test_rate_limit_spaces_attempts():
    pairs = [("127.0.0.1", free_port()) for _ in range(10)]
    started = time.perf_counter()
    await sweep(pairs, rate_per_second=50, timeout=0.5)
    assert time.perf_counter() - started >= 0.15  # 10 attempts at 50/s need at least ~0.18 s


async def test_concurrency_is_capped(monkeypatch):
    in_flight = peak = 0

    async def fake_open_connection(host, port):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.05)
        in_flight -= 1
        raise ConnectionRefusedError

    monkeypatch.setattr(sweep_module.asyncio, "open_connection", fake_open_connection)
    await sweep([("h", n) for n in range(1, 41)], concurrency=5, rate_per_second=10_000, timeout=1.0)
    assert peak <= 5


async def test_a_tarpit_attempt_times_out(monkeypatch):
    async def never(host, port):
        await asyncio.sleep(60)

    monkeypatch.setattr(sweep_module.asyncio, "open_connection", never)
    started = time.perf_counter()
    assert await sweep([("h", 1)], timeout=0.2) == []
    assert time.perf_counter() - started < 2


async def test_progress_callback_sees_every_attempt():
    seen = []
    async with silent_server() as port:
        await sweep([("127.0.0.1", port), ("127.0.0.1", free_port())], on_progress=lambda c, o: seen.append((c, o)))
    assert seen[-1] == (2, 1) and len(seen) == 2


async def test_empty_input():
    assert await sweep([]) == []
