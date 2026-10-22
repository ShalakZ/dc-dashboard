"""The Docker name hint (w33 R7): a name for an address that Docker hands out, offered only when it provably leads back to it.

No test here uses real DNS: the two functions that talk to the resolver (`names._reverse`, `names._forward`) are replaced."""
import asyncio
import threading
import time

import pytest

from dcdash.collector import names
from dcdash.collector.names import LookupBudget, name_hint

DOCKER_HOST = "172.20.0.5"
DOCKER_NAME = "dcdash-simulator-1.dcdash_default"


class Resolver:
    """A fake resolver: `reverse` maps an address to its reverse name, `forward` maps a name to the list of addresses it resolves
    to (a missing name fails the way the real call does). It records every call, in order."""

    def __init__(self, monkeypatch, reverse=None, forward=None):
        self.reverse, self.forward = dict(reverse or {}), dict(forward or {})
        self.reversed: list[str] = []
        self.forwarded: list[str] = []
        monkeypatch.setattr(names, "_reverse", self._reverse)
        monkeypatch.setattr(names, "_forward", self._forward)

    def _reverse(self, address):
        self.reversed.append(address)
        if address not in self.reverse:
            raise OSError("no such host")
        return self.reverse[address]

    def _forward(self, name):
        self.forwarded.append(name)
        if name not in self.forward:
            raise OSError("no such name")
        return self.forward[name]

    @property
    def calls(self) -> int:
        return len(self.reversed) + len(self.forwarded)


async def hint(host, **kwargs):
    return await name_hint(host, lookups=kwargs.pop("lookups", None) or LookupBudget())


# --- the answer ---------------------------------------------------------------------------------------------------------------


async def test_the_docker_form_gives_the_service_name_when_it_leads_back_to_the_address(monkeypatch):
    resolver = Resolver(monkeypatch, {DOCKER_HOST: DOCKER_NAME}, {"simulator": [DOCKER_HOST]})
    assert await hint(DOCKER_HOST) == "simulator"
    assert resolver.reversed == [DOCKER_HOST] and resolver.forwarded == ["simulator"]


async def test_candidates_are_tried_shortest_first_and_the_first_accepted_wins(monkeypatch):
    resolver = Resolver(
        monkeypatch,
        {DOCKER_HOST: DOCKER_NAME},
        {"simulator": ["172.20.0.9"], "dcdash-simulator": [DOCKER_HOST], "dcdash-simulator-1": [DOCKER_HOST]},
    )
    assert await hint(DOCKER_HOST) == "dcdash-simulator"  # "simulator" is another address; the next one is the answer
    assert resolver.forwarded == ["simulator", "dcdash-simulator"]


async def test_the_whole_candidate_order_is_suffixes_then_the_container_name_then_the_full_name(monkeypatch):
    resolver = Resolver(monkeypatch, {DOCKER_HOST: DOCKER_NAME}, {})  # nothing resolves: every candidate is tried
    assert await hint(DOCKER_HOST) is None
    assert resolver.forwarded == ["simulator", "dcdash-simulator", "dcdash-simulator-1", DOCKER_NAME]


async def test_the_container_name_is_the_answer_when_only_it_leads_back(monkeypatch):
    Resolver(monkeypatch, {DOCKER_HOST: DOCKER_NAME}, {"dcdash-simulator-1": [DOCKER_HOST]})
    assert await hint(DOCKER_HOST) == "dcdash-simulator-1"


async def test_a_name_without_a_container_number_keeps_its_own_dashes(monkeypatch):
    resolver = Resolver(monkeypatch, {DOCKER_HOST: "meter-gateway.lab.example"}, {})
    assert await hint(DOCKER_HOST) is None
    assert resolver.forwarded == ["gateway", "meter-gateway", "meter-gateway.lab.example"]


@pytest.mark.parametrize(
    "forward",
    [
        {"simulator": ["172.20.0.9"]},  # a DIFFERENT address
        {"simulator": [DOCKER_HOST, "172.20.0.9"]},  # several addresses
        {"simulator": ["172.20.0.9", DOCKER_HOST]},
        {"simulator": []},  # no address
        {},  # the lookup fails
    ],
)
async def test_a_candidate_is_never_accepted_unless_its_forward_lookup_is_exactly_the_address(monkeypatch, forward):
    Resolver(monkeypatch, {DOCKER_HOST: "dcdash-simulator-1"}, forward)
    assert await hint(DOCKER_HOST) is None


async def test_a_failing_candidate_falls_through_to_the_next(monkeypatch):
    Resolver(monkeypatch, {DOCKER_HOST: DOCKER_NAME}, {"dcdash-simulator": [DOCKER_HOST]})  # "simulator" raises
    assert await hint(DOCKER_HOST) == "dcdash-simulator"


async def test_no_reverse_name_is_no_hint(monkeypatch):
    resolver = Resolver(monkeypatch, {}, {"simulator": [DOCKER_HOST]})
    assert await hint(DOCKER_HOST) is None
    assert resolver.forwarded == []


@pytest.mark.parametrize("reverse", [DOCKER_HOST, "", "  ", ".", "0x0a000005", "12345", "a b.lab", "x/y@z.lab"])
async def test_a_reverse_name_that_is_not_a_hostname_is_no_hint(monkeypatch, reverse):
    """An address echoed back, an empty answer, a number the resolver would read as an address, a string that could not be a host
    part of a URL: none is offered, and none is looked up as a candidate."""
    resolver = Resolver(monkeypatch, {DOCKER_HOST: reverse}, {name: [DOCKER_HOST] for name in (reverse, reverse.strip(), "x", "a")})
    assert await hint(DOCKER_HOST) is None
    assert resolver.forwarded == []


async def test_the_reverse_name_is_lowered_and_loses_its_trailing_dot(monkeypatch):
    Resolver(monkeypatch, {DOCKER_HOST: "Dcdash-Simulator-1.dcdash_default."}, {"simulator": [DOCKER_HOST]})
    assert await hint(DOCKER_HOST) == "simulator"


# --- which addresses are looked up at all -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "host",
    [
        "8.8.8.8",  # public
        "1.1.1.1",
        "localhost",  # a name
        "meter-12.lab.example",
        "",
        "not an address",
        "fe80::1",  # IPv6, private or not
        "::1",
        "fd00::5",
        "127.0.0.1",  # loopback is "private" to Python, but "localhost" is no hint
        "169.254.10.10",  # link-local
        "0.0.0.0",
        "224.0.0.1",  # multicast
    ],
)
async def test_only_a_private_ipv4_address_is_looked_up(monkeypatch, host):
    resolver = Resolver(monkeypatch, {host: "anything-1.net"}, {"anything": [host]})
    budget = LookupBudget()
    assert await name_hint(host, lookups=budget) is None
    assert resolver.calls == 0
    assert budget.hosts_left == names.MAX_HOSTS_PER_SCAN  # and no budget was spent on it


@pytest.mark.parametrize("host", ["10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.20"])
async def test_every_private_range_is_looked_up(monkeypatch, host):
    Resolver(monkeypatch, {host: "pump-3.plant.local"}, {"pump": [host]})
    assert await hint(host) == "pump"


# --- the budget ---------------------------------------------------------------------------------------------------------------


async def test_at_most_fifty_hosts_per_scan_get_an_attempt(monkeypatch):
    hosts = [f"10.0.{n // 200}.{n % 200 + 1}" for n in range(60)]
    resolver = Resolver(monkeypatch, {h: "box-1.net" for h in hosts}, {"box": hosts[:1]})
    budget = LookupBudget(max_lookups=10_000)  # (the scan's total cap on lookups is tested below; this one is about hosts)
    answers = [await name_hint(h, lookups=budget) for h in hosts]
    assert len(resolver.reversed) == 50 == names.MAX_HOSTS_PER_SCAN
    assert resolver.reversed == hosts[:50]  # the first fifty, in order
    assert answers[:1] == ["box"] and not any(answers[1:])  # (only the first host is what "box" leads back to)
    assert budget.hosts_left == 0


async def test_a_budget_is_per_scan_so_a_new_one_starts_full(monkeypatch):
    resolver = Resolver(monkeypatch, {"10.0.0.1": "a-1.net"}, {})
    first = LookupBudget(max_hosts=1)
    await name_hint("10.0.0.1", lookups=first)
    await name_hint("10.0.0.1", lookups=first)  # spent
    assert len(resolver.reversed) == 1
    await name_hint("10.0.0.1", lookups=LookupBudget(max_hosts=1))
    assert len(resolver.reversed) == 2


async def test_one_host_makes_about_six_lookups_at_most(monkeypatch):
    resolver = Resolver(monkeypatch, {DOCKER_HOST: "a-b-c-d-e-f-g-h-1.deep.lab"}, {})
    assert await hint(DOCKER_HOST) is None
    assert len(resolver.reversed) == 1 and resolver.calls == names.MAX_LOOKUPS_PER_HOST == 6
    assert resolver.forwarded[0] == "h"  # the shortest first; the long tail is what the cap cuts


DEEP = "a-b-c-d-e-f-g-h-1.deep.lab"  # a reverse name that leads nowhere and has more candidates than a host may check: six lookups each


def deep_hosts(count: int) -> list[str]:
    return [f"10.1.{n // 200}.{n % 200 + 1}" for n in range(count)]


async def test_a_scan_makes_at_most_sixty_lookups_in_all_whatever_the_hosts(monkeypatch):
    # 50 hosts x 6 lookups would be 300 lookups of up to 3 seconds each (whole-wave review, minor 9): the total is capped as well.
    hosts = deep_hosts(50)
    resolver = Resolver(monkeypatch, {h: DEEP for h in hosts}, {})
    budget = LookupBudget()
    assert budget.lookups_left == names.MAX_LOOKUPS_PER_SCAN == 60
    assert [await name_hint(h, lookups=budget) for h in hosts] == [None] * 50
    assert resolver.calls == 60  # reverse and forward lookups counted together
    assert len(resolver.reversed) == 10 and len(resolver.forwarded) == 50  # ten hosts of six lookups; the eleventh was never started
    assert resolver.reversed == hosts[:10]
    assert budget.lookups_left == 0 and budget.hosts_left == 50 - 10  # a host the spent budget refused did not use up a host slot


async def test_the_total_cap_stops_a_host_in_the_middle_and_counts_the_reverse_lookup(monkeypatch):
    resolver = Resolver(monkeypatch, {DOCKER_HOST: DEEP}, {})
    budget = LookupBudget(max_lookups=3)
    assert await name_hint(DOCKER_HOST, lookups=budget) is None
    assert len(resolver.reversed) == 1 and resolver.forwarded == ["h", "g-h"]  # the reverse lookup and two checks, then nothing
    assert budget.lookups_left == 0


async def test_a_name_found_before_the_cap_is_still_the_answer(monkeypatch):
    resolver = Resolver(monkeypatch, {DOCKER_HOST: DOCKER_NAME}, {"simulator": [DOCKER_HOST]})
    budget = LookupBudget(max_lookups=2)
    assert await name_hint(DOCKER_HOST, lookups=budget) == "simulator"
    assert resolver.calls == 2 and budget.lookups_left == 0


async def test_failed_lookups_count_against_the_total_as_well(monkeypatch):
    resolver = Resolver(monkeypatch, {}, {})  # every reverse lookup fails
    budget = LookupBudget(max_lookups=4)
    for host in deep_hosts(10):
        assert await name_hint(host, lookups=budget) is None
    assert len(resolver.reversed) == 4 and budget.lookups_left == 0


async def test_a_host_that_is_never_looked_up_costs_the_total_nothing(monkeypatch):
    Resolver(monkeypatch, {}, {})
    budget = LookupBudget()
    for host in ("8.8.8.8", "127.0.0.1", "not-an-address", "fe80::1"):
        assert await name_hint(host, lookups=budget) is None
    assert budget.lookups_left == names.MAX_LOOKUPS_PER_SCAN and budget.hosts_left == names.MAX_HOSTS_PER_SCAN


async def test_a_slow_resolver_costs_at_most_the_total_not_every_host(monkeypatch):
    release = threading.Event()
    asked: list[str] = []

    def slow(_value):
        asked.append(_value)
        release.wait(0.05)  # slower than the timeout below, but it answers: "no such host" resets the count of timeouts in a row
        raise OSError("no such host")

    monkeypatch.setattr(names, "_reverse", slow)
    monkeypatch.setattr(names, "LOOKUP_TIMEOUT", 5)
    budget = LookupBudget(max_lookups=7)
    try:
        for host in deep_hosts(50):
            await name_hint(host, lookups=budget)
    finally:
        release.set()
    assert len(asked) == 7  # a slow resolver that never times out in a row is stopped by the total, not by the timeouts rule


# --- failure: it never raises, never hangs --------------------------------------------------------------------------------------


async def test_a_resolver_that_blows_up_in_any_way_is_no_hint(monkeypatch):
    def boom(_value):
        raise RuntimeError("the resolver exploded")

    monkeypatch.setattr(names, "_reverse", boom)
    assert await hint(DOCKER_HOST) is None
    monkeypatch.setattr(names, "_reverse", lambda _host: DOCKER_NAME)
    monkeypatch.setattr(names, "_forward", boom)
    assert await hint(DOCKER_HOST) is None
    monkeypatch.setattr(names, "_forward", lambda _name: "not a list")
    assert await hint(DOCKER_HOST) is None


async def test_a_lookup_that_hangs_is_cut_at_the_timeout(monkeypatch):
    release = threading.Event()

    def hangs(_address):
        release.wait(5)  # a thread cannot be stopped; the test frees it at the end
        return DOCKER_NAME

    monkeypatch.setattr(names, "_reverse", hangs)
    monkeypatch.setattr(names, "LOOKUP_TIMEOUT", 0.05)
    try:
        started = time.monotonic()
        assert await hint(DOCKER_HOST) is None
        assert time.monotonic() - started < 2
    finally:
        release.set()


async def test_a_forward_lookup_that_hangs_is_cut_and_the_next_candidate_is_tried(monkeypatch):
    release = threading.Event()

    def slow_forward(name):
        if name == "simulator":
            release.wait(5)
        return [DOCKER_HOST]

    monkeypatch.setattr(names, "_reverse", lambda _host: DOCKER_NAME)
    monkeypatch.setattr(names, "_forward", slow_forward)
    monkeypatch.setattr(names, "LOOKUP_TIMEOUT", 0.05)
    try:
        assert await hint(DOCKER_HOST) == "dcdash-simulator"
    finally:
        release.set()


async def test_a_cancelled_lookup_is_not_swallowed(monkeypatch):
    """The scan being cancelled must stop the lookups, not be mistaken for a failed one."""
    release = threading.Event()
    monkeypatch.setattr(names, "_reverse", lambda _host: release.wait(5) and DOCKER_NAME)
    task = asyncio.create_task(hint(DOCKER_HOST))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()


async def test_lookups_run_in_their_own_small_pool_not_in_the_loops_default_executor(monkeypatch):
    """asyncio's own getaddrinfo uses the default executor; a hung reverse lookup must not starve it."""
    seen: dict[str, str] = {}

    def where(_host):
        seen["thread"] = threading.current_thread().name
        return DOCKER_NAME

    monkeypatch.setattr(names, "_reverse", where)
    monkeypatch.setattr(names, "_forward", lambda _name: [DOCKER_HOST])
    assert await hint(DOCKER_HOST) == "simulator"
    assert seen["thread"].startswith("dcdash-names")
    assert names._POOL._max_workers == 4


async def test_a_resolver_that_times_out_again_and_again_is_not_asked_for_the_rest_of_the_scan(monkeypatch):
    release = threading.Event()
    asked: list[str] = []

    def hangs(address):
        asked.append(address)
        release.wait(5)
        return DOCKER_NAME

    monkeypatch.setattr(names, "_reverse", hangs)
    monkeypatch.setattr(names, "LOOKUP_TIMEOUT", 0.02)
    budget = LookupBudget()
    try:
        for n in range(1, 11):
            assert await name_hint(f"10.0.0.{n}", lookups=budget) is None
    finally:
        release.set()
    assert len(asked) == names.MAX_TIMEOUTS_IN_A_ROW == 4  # the fifth host was never tried
    assert budget.stopped


async def test_an_answer_even_a_failure_resets_the_timeout_count(monkeypatch):
    release = threading.Event()
    state = {"hang": True}

    def reverse(_address):
        if state["hang"]:
            release.wait(5)
        raise OSError("no such host")

    monkeypatch.setattr(names, "_reverse", reverse)
    monkeypatch.setattr(names, "LOOKUP_TIMEOUT", 0.02)
    budget = LookupBudget()
    try:
        for n in range(1, 4):
            await name_hint(f"10.0.0.{n}", lookups=budget)
        assert budget.timeouts == 3 and not budget.stopped
        state["hang"] = False
        release.set()
        await name_hint("10.0.0.9", lookups=budget)  # the resolver answers (with "no such host")
        assert budget.timeouts == 0
    finally:
        release.set()
