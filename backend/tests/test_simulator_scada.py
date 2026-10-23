"""The SCADA-shaped OPC UA server (dcdash/simulator/scada.py): numbered and stable ids, restructure, the read limit, the counters.

The real OpcUaConnector is the client, so what these tests see is what the collector sees."""
import contextlib
import itertools
import math
import re
import struct
import time
from datetime import datetime, timezone

import pytest
from asyncua import Client, ua

from dcdash.connectors.base import BAD, GOOD, ConnectorError, create_connector
from dcdash.simulator import main as simulator_main
from dcdash.simulator import scada as scada_module
from dcdash.simulator.scada import KNOWN, METER_SUFFIXES, ScadaConfig, ScadaConfigError, ScadaSim, sample, value
from tests.helpers import free_port

NUMBERED = re.compile(r"ns=3;s=(\d+):Site\.(.+)")


@contextlib.asynccontextmanager
async def scada(**settings):
    sim = ScadaSim(ScadaConfig(**settings), free_port())
    await sim.start()
    try:
        yield sim
    finally:
        await sim.stop()


def endpoint(sim: ScadaSim) -> str:
    return sim.endpoint.replace("0.0.0.0", "127.0.0.1")


def connector(sim: ScadaSim):
    return create_connector("opcua", {"endpoint": endpoint(sim), "timeout_seconds": 5})


def expected_numbers(count: int) -> list[int]:
    return list(itertools.islice((n for n in itertools.count(20000) if n not in (20409, 20418)), count))


# ---- the model (no server) ---------------------------------------------------------------------------------------------------

def test_the_default_cluster_has_1306_tags_with_distinct_values():
    sim = ScadaSim(ScadaConfig(), free_port())
    assert len(sim.tags) == 48 * 27 + 10 == 1306
    assert sim.tags[0] == "PDUA01_PM0_A_L1" and sim.tags[26] == "PDUA01_PM0_PENRG" and sim.tags[27] == "PDUA02_PM0_A_L1"
    assert sim.tags[24 * 27] == "PDUB01_PM0_A_L1"  # feed A meters, then feed B meters
    assert sim.tags[-10:] == [f"{p}{n}IN_QM_P" for p in ("IT", "ME") for n in range(1, 6)]
    assert len(set(sim.tags)) == len(sim.tags)
    assert [sim.value_of(tag) for tag in sim.tags] == [1000.0 + i for i in range(len(sim.tags))]
    assert sim.endpoint.startswith("opc.tcp://0.0.0.0:") and sim.endpoint.endswith("/plantscada")
    assert sim.stable_id("PDUA01_PM0_P") == "ns=3;s=Site.PDUA01_PM0_P"


def test_branch_tags_are_spread_over_the_pdus_and_a_restructure_never_changes_tags_or_values():
    sim = ScadaSim(ScadaConfig(pdus=3, branch_tags=7), free_port())
    branch = [tag for tag in sim.tags if re.fullmatch(r"PDUA\d+_Q\d+_P", tag)]
    assert branch == ["PDUA01_Q1_P", "PDUA02_Q1_P", "PDUA03_Q1_P", "PDUA01_Q2_P", "PDUA02_Q2_P", "PDUA03_Q2_P", "PDUA01_Q3_P"]
    before = (list(sim.tags), [sim.value_of(tag) for tag in sim.tags], sim.numbered_id("PDUA01_PM0_P"))
    sim.restructure("bad")
    assert (list(sim.tags), [sim.value_of(tag) for tag in sim.tags]) == before[:2]
    assert sim.numbered_id("PDUA01_PM0_P") != before[2]  # only the numbers move
    sim.restructure("")
    assert sim.numbered_id("PDUA01_PM0_P") == before[2]
    with pytest.raises(ValueError):
        sim.restructure("sideways")


def test_no_pdus_with_branch_tags_does_not_divide_by_zero():
    sim = ScadaSim(ScadaConfig(pdus=0, branch_tags=3), free_port())
    assert sim.tags[:3] == ["PDUA01_Q1_P", "PDUA01_Q2_P", "PDUA01_Q3_P"] and len(sim.tags) == 13


# ---- (a) to (f) against the real connector ------------------------------------------------------------------------------------

async def test_every_browsed_address_is_numbered_and_both_forms_read_the_same():
    async with scada(pdus=8) as sim:  # 8 PDUs per feed: 442 tags, more than the 409 after which the real sequence skips two numbers
        c = connector(sim)
        browsed = await c.browse()
        assert len(browsed) == len(sim.tags) == 442
        by_name = {p.name: p.address for p in browsed}
        assert set(by_name) == set(sim.tags)  # the DisplayName is the tag name
        parsed = {tag: NUMBERED.fullmatch(address) for tag, address in by_name.items()}
        assert all(parsed.values()), "an address without a number in front of the tag"
        numbers = [int(parsed[tag][1]) for tag in sim.tags]  # in listing order
        assert numbers == expected_numbers(len(sim.tags))
        assert numbers[0] == 20000 and 20409 not in numbers and 20418 not in numbers
        assert all(by_name[tag] == sim.numbered_id(tag) and parsed[tag][2] == tag for tag in sim.tags)
        chosen = [sim.tags[i] for i in (0, 26, 27, 300, 441)]
        numbered = await c.read([sim.numbered_id(tag) for tag in chosen])
        stable = await c.read([sim.stable_id(tag) for tag in chosen])
        assert [v.value for v in numbered] == [v.value for v in stable] == [sim.value_of(tag) for tag in chosen]
        assert all(v.quality == GOOD for v in numbered + stable)
        assert [v.address for v in stable] == [sim.stable_id(tag) for tag in chosen]  # the caller's strings come back


async def test_restructure_bad_turns_old_numbered_ids_bad_and_keeps_stable_ids_good():
    async with scada(pdus=2) as sim:
        c = connector(sim)
        old = {p.name: p.address for p in await c.browse()}
        sim.restructure("bad")
        tags = sim.tags
        bad = await c.read([old[tag] for tag in tags])
        assert all(v.quality == BAD and "BadNodeIdUnknown" in v.status and v.value is None for v in bad)  # every number moved
        good = await c.read([sim.stable_id(tag) for tag in tags])
        assert [v.value for v in good] == [sim.value_of(tag) for tag in tags] and all(v.quality == GOOD for v in good)
        fresh = {p.name: p.address for p in await c.browse()}  # a new browse lists the extra equipment and its new numbers
        assert len(fresh) == len(tags) + len(sim.extra_tags) and sim.extra_tags[0] in fresh
        assert int(NUMBERED.fullmatch(fresh[sim.extra_tags[0]])[1]) == 20000
        assert fresh[tags[0]] == sim.numbered_id(tags[0]) != old[tags[0]]
        again = await c.read([fresh[tag] for tag in tags])  # the new numbers work
        assert [v.value for v in again] == [sim.value_of(tag) for tag in tags]


async def test_restructure_by_index_reads_another_tag_under_an_old_number():
    async with scada(pdus=2) as sim:
        c = connector(sim)
        old = {p.name: p.address for p in await c.browse()}
        sim.restructure("by_index")
        holders = sim.extra_tags + sim.tags  # the listing now: the extra equipment first, so the tag at position i holds number i
        for position in (0, 5, 26, 27, 60, len(sim.tags) - 1):
            tag, holder = sim.tags[position], holders[position]
            assert holder != tag
            [value] = await c.read([old[tag]])
            assert value.quality == GOOD
            assert value.value == sim.value_of(holder) != sim.value_of(tag)
        [past_the_end] = await c.read([f"ns=3;s=29999:Site.{sim.tags[0]}"])  # a number nobody holds is still unknown
        assert past_the_end.quality == BAD and "BadNodeIdUnknown" in past_the_end.status


async def test_read_limit_is_enforced_and_advertised():
    async with scada(pdus=3, max_nodes_per_read=120) as sim:
        assert len(sim.tags) >= 121
        async with Client(endpoint(sim)) as client:
            limit = client.get_node(ua.NodeId(ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead))
            assert await limit.read_value() == 120  # advertised = enforced unless said otherwise
            ids = [client.get_node(sim.stable_id(tag)) for tag in sim.tags[:121]]
            assert len(await client.read_attributes(ids[:120], ua.AttributeIds.Value)) == 120
            with pytest.raises(ua.UaStatusCodeError) as refused:
                await client.read_attributes(ids, ua.AttributeIds.Value)
            assert refused.value.code == ua.StatusCodes.BadTooManyOperations
        c = connector(sim)  # through the connector the refusal is the typed protocol_error
        assert len(await c.read([sim.stable_id(tag) for tag in sim.tags[:120]])) == 120
        with pytest.raises(ConnectorError) as typed:
            await c.read([sim.stable_id(tag) for tag in sim.tags[:121]])
        assert typed.value.status == "protocol_error" and "BadTooManyOperations" in typed.value.message
    async with scada(pdus=1, max_nodes_per_read=120, advertised_max_nodes=500) as sim:
        async with Client(endpoint(sim)) as client:
            limit = client.get_node(ua.NodeId(ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead))
            assert await limit.read_value() == 500  # says 500, enforces 120
    async with scada(pdus=1) as sim:
        async with Client(endpoint(sim)) as client:
            limit = client.get_node(ua.NodeId(ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead))
            assert await limit.read_value() == 0  # no limit at all
            assert len(await client.read_attributes([client.get_node(sim.stable_id(t)) for t in sim.tags], ua.AttributeIds.Value)) == len(sim.tags)


async def test_counters_count_requests_and_nodes():
    async with scada(pdus=1, max_nodes_per_read=40) as sim:  # 64 tags in 12 folders
        c = connector(sim)
        assert sim.counters.read_sizes == [] and sim.counters.browse == 0  # the set-up is not counted
        await c.read([sim.stable_id(tag) for tag in sim.tags[:5]])
        await c.read([sim.numbered_id(tag) for tag in sim.tags[:40]])
        with pytest.raises(ConnectorError):
            await c.read([sim.stable_id(tag) for tag in sim.tags[:41]])  # a refused request is still a request
        assert sim.counters.read_sizes == [5, 40, 41]
        assert sim.counters.limit_reads == 0 and sim.counters.browse == 0
        async with Client(endpoint(sim)) as client:
            await client.get_node(ua.NodeId(ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead)).read_value()
            await client.get_node("i=2259").read_value()  # ServerState: not ours, not counted
        assert sim.counters.limit_reads == 1 and sim.counters.read_sizes == [5, 40, 41]
        sim.counters.reset()
        assert (sim.counters.read_sizes, sim.counters.limit_reads, sim.counters.browse, sim.counters.nodes_browsed) == ([], 0, 0, 0)
        await c.browse()
        # Objects, Site, the 12 folders (PDUA01 PDUB01 IT1IN..IT5IN ME1IN..ME5IN; the extra equipment is not listed) and the 64 variables
        assert sim.counters.browse == sim.counters.nodes_browsed == 1 + 1 + 12 + 64
        assert sim.counters.browse_next == 0
        assert sim.counters.read_sizes and all(size == 1 for size in sim.counters.read_sizes)  # the connector reads one node at a time


async def test_scale_knobs():
    started = time.perf_counter()
    async with scada(pdus=3, branch_tags=2000) as sim:
        assert len(sim.tags) == 6 * 27 + 10 + 2000 == 2172
        assert len(set(sim.tags)) == 2172
        browsed = await connector(sim).browse()
        assert len(browsed) == 2172 and {p.name for p in browsed} == set(sim.tags)
        assert sorted(int(NUMBERED.fullmatch(p.address)[1]) for p in browsed) == expected_numbers(2172)
    assert time.perf_counter() - started < 120


# ---- the application URI and the endpoint path -----------------------------------------------------------------------------------

async def test_the_server_announces_its_instance_and_serves_on_the_plantscada_path():
    sim = ScadaSim(ScadaConfig(pdus=1), free_port(), instance="lab-2")
    await sim.start()
    try:
        assert sim.endpoint.endswith("/plantscada")
        async with Client(endpoint(sim)) as client:
            assert (await client.get_namespace_array())[1] == "urn:dcdash:simulator:scada:lab-2"
            assert len(await client.get_namespace_array()) == 4  # ns 0, the application URI, a spare one, the cluster's (3)
            endpoints = await client.get_endpoints()
            assert {e.Server.ApplicationUri for e in endpoints} == {"urn:dcdash:simulator:scada:lab-2"}
    finally:
        await sim.stop()


# ---- (g) main() starts the SCADA-shaped server only with a port ---------------------------------------------------------------

def test_the_settings_have_defaults_and_no_port_means_no_server():
    live = ScadaConfig(live=True)  # the simulator process serves live values; a dataclass built by hand keeps the constants
    assert ScadaConfig.from_env({}) == live and ScadaConfig().port is None and ScadaConfig().live is False
    assert ScadaConfig.from_env({"SIM_SCADA_PORT": "", "SIM_SCADA_PDUS": "  "}) == live  # empty = unset (compose passes empty)
    full = ScadaConfig.from_env({
        "SIM_SCADA_PORT": "4850", "SIM_SCADA_PDUS": "3", "SIM_SCADA_BRANCH_TAGS": "2000", "SIM_SCADA_SEED": "7",
        "SIM_SCADA_RESTRUCTURE": "by_index", "SIM_SCADA_MAX_NODES_PER_READ": "120", "SIM_SCADA_ADVERTISED_MAX_NODES": "500",
    })
    assert full == ScadaConfig(
        port=4850, pdus=3, branch_tags=2000, seed=7, restructure="by_index", max_nodes_per_read=120, advertised_max_nodes=500, live=True,
    )
    assert ScadaConfig.from_env({"SIM_SCADA_ADVERTISED_MAX_NODES": "0"}).advertised_max_nodes == 0  # "advertises none" is not "unset"
    assert set(KNOWN) == {f"SIM_SCADA_{name}" for name in (
        "PORT", "PDUS", "BRANCH_TAGS", "SEED", "RESTRUCTURE", "MAX_NODES_PER_READ", "ADVERTISED_MAX_NODES")}


def test_main_reads_the_scada_settings_once_and_hands_serve_the_config(monkeypatch):
    seen: list[dict] = []

    async def fake_serve(**kwargs):
        seen.append(kwargs)

    monkeypatch.setattr(simulator_main, "serve", fake_serve)
    reads = []
    original = ScadaConfig.from_env.__func__
    monkeypatch.setattr(ScadaConfig, "from_env", classmethod(lambda cls, environ: reads.append(1) or original(cls, environ)))
    simulator_main.main({})
    simulator_main.main({"SIM_SCADA_PORT": "4850", "SIM_SCADA_PDUS": "3"})
    assert len(reads) == 2  # once per start
    assert seen[0]["scada"].port is None and seen[0]["scada"] == ScadaConfig(live=True)
    assert seen[1]["scada"] == ScadaConfig(port=4850, pdus=3, live=True)


async def test_serve_starts_the_scada_server_only_when_it_has_a_port(monkeypatch):
    started: list[tuple] = []

    class Idle:  # stands in for a server: it takes its arguments and "runs" at once
        def __init__(self, *args, **kwargs):
            pass

        async def run(self):
            return None

        async def serve(self):
            return None

    class FakeScada(Idle):
        def __init__(self, config, port, instance="dev"):
            self.endpoint = ""
            started.append((config, port, instance, self))

        async def run(self):
            started[-1] = (*started[-1][:3], self.endpoint)

    monkeypatch.setattr(simulator_main, "OpcUaSim", Idle)
    monkeypatch.setattr(simulator_main, "ModbusSim", Idle)
    monkeypatch.setattr(simulator_main, "ScadaSim", FakeScada)
    monkeypatch.setattr(simulator_main, "create_sim_app", lambda *args, **kwargs: None)
    monkeypatch.setattr(simulator_main.uvicorn, "Config", lambda *args, **kwargs: None)
    monkeypatch.setattr(simulator_main.uvicorn, "Server", Idle)
    await simulator_main.serve()
    await simulator_main.serve(scada=ScadaConfig())
    assert started == []  # the three plain servers, nothing else
    await simulator_main.serve(scada=ScadaConfig(port=4850, pdus=3), instance="lab-2", host="0.0.0.0")
    assert started == [(ScadaConfig(port=4850, pdus=3), 4850, "lab-2", "opc.tcp://0.0.0.0:4850/plantscada")]


# ---- (h) a typo or a bad value stops main() before anything starts -----------------------------------------------------------

def test_a_typo_in_a_scada_name_stops_the_simulator_before_anything_starts(monkeypatch):
    async def serve_must_not_run(**kwargs):
        raise AssertionError("serve() started with a mistyped SCADA setting")

    monkeypatch.setattr(simulator_main, "serve", serve_must_not_run)
    with pytest.raises(SystemExit) as stopped:
        simulator_main.main({"SIM_SCADA_PORTT": "4850"})
    assert "SIM_SCADA_PORTT" in str(stopped.value) and str(stopped.value).startswith("simulator: ")
    with pytest.raises(ScadaConfigError):
        ScadaConfig.from_env({"SIM_SCADA_PORTT": "4850"})


@pytest.mark.parametrize("name, value, sentence", [
    ("SIM_SCADA_PDUS", "many", "SIM_SCADA_PDUS must be a whole number"),
    ("SIM_SCADA_PDUS", "201", "SIM_SCADA_PDUS must be between 0 and 200"),
    ("SIM_SCADA_PORT", "0", "SIM_SCADA_PORT must be between 1 and 65535"),
    ("SIM_SCADA_BRANCH_TAGS", "-1", "SIM_SCADA_BRANCH_TAGS must be between 0 and 20000"),
    ("SIM_SCADA_RESTRUCTURE", "sideways", "SIM_SCADA_RESTRUCTURE must be bad or by_index"),
    ("SIM_SCADA_MAX_NODES_PER_READ", "lots", "SIM_SCADA_MAX_NODES_PER_READ must be a whole number"),
    ("SIM_SCADA_ADVERTISED_MAX_NODES", "1.5", "SIM_SCADA_ADVERTISED_MAX_NODES must be a whole number"),
])
def test_a_bad_scada_value_stops_the_simulator_with_the_plain_sentence(monkeypatch, name, value, sentence):
    async def serve_must_not_run(**kwargs):
        raise AssertionError("serve() started with a bad SCADA value")

    monkeypatch.setattr(simulator_main, "serve", serve_must_not_run)
    with pytest.raises(SystemExit) as stopped:
        simulator_main.main({name: value})
    assert sentence in str(stopped.value) and str(stopped.value).startswith("simulator: ")


# ---- live values (w34 Task 9): a pure function of seed, tag and instant, computed when a Read comes in -----------------------------

T0 = 1_792_000_000  # a multiple of 4 s, in October 2026
PERIODS = (64, 68, 72, 76)  # the seconds a tag can wait between two updates (on average)


@pytest.fixture
def now(monkeypatch):
    """The instant the live server believes it is; a test moves it by assigning now[0]. Nothing in the module reads the wall clock inline."""
    box = [float(T0 + 1234)]
    monkeypatch.setattr(scada_module, "clock", lambda: box[0])
    return box


def float32(number: float) -> float:
    return struct.unpack("f", struct.pack("f", number))[0]


def history(seed: int, tag: str, start: int = T0, seconds: int = 7200) -> list[tuple[float, float]]:
    """[(stamp, value)] for every update the tag made in the window, found by stepping the 4 s grid. The same stamp must always
    carry the same value: the value changes only when the tag updates."""
    seen: dict[float, float] = {}
    for offset in range(0, seconds, 4):
        number, stamp = sample(seed, tag, start + offset)
        assert seen.setdefault(stamp, number) == number, f"{tag} changed between two updates"
    return sorted(seen.items())


def some_tags() -> list[str]:
    """All the tag classes: the 27 values of two meters (one per feed), branch tags, the incomers, the extra equipment."""
    sim = ScadaSim(ScadaConfig(pdus=2, branch_tags=6), free_port())
    return sim.tags[:27] + sim.tags[2 * 27:2 * 27 + 27] + [t for t in sim.tags if "_Q" in t] + sim.tags[-10:] + sim.extra_tags[:5]


def test_a_hand_built_config_keeps_the_constants_and_never_reads_the_clock(monkeypatch):
    def forbidden():
        raise AssertionError("the constant server must not look at the clock")

    monkeypatch.setattr(scada_module, "clock", forbidden)
    sim = ScadaSim(ScadaConfig(), free_port())
    assert ScadaConfig().live is False
    assert [sim.value_of(tag) for tag in sim.tags] == [1000.0 + i for i in range(len(sim.tags))]


def test_values_are_a_pure_function_of_seed_tag_and_instant(now):
    tags = some_tags()
    assert len(tags) > 100
    first = [sample(1, tag, T0 + 500) for tag in tags]
    assert first == [sample(1, tag, T0 + 500) for tag in tags]  # the same seed and instant give the same values and stamps
    assert [value(1, tag, T0 + 500) for tag in tags] == [v for v, _ in first]
    assert [sample(1, tag, T0 + 500.0 + 3.9) for tag in tags] == first  # an instant means its 4 s grid step
    other = [sample(2, tag, T0 + 500) for tag in tags]
    assert sum(a != b for a, b in zip(first, other, strict=True)) >= 0.9 * len(tags)  # another seed, other values and clocks
    sim = ScadaSim(ScadaConfig(pdus=2, branch_tags=6, seed=1, live=True), free_port())
    assert [sim.value_of(tag) for tag in tags] == [value(1, tag, now[0]) for tag in tags]  # value_of(tag) = the value at the clock's instant


def test_value_of_follows_the_injected_clock_one_update_at_a_time(now):
    sim = ScadaSim(ScadaConfig(pdus=1, live=True), free_port())
    tag = "PDUA01_PM0_P"
    now[0] = T0
    first, stamp = sim.value_of(tag), sample(1, tag, T0)[1]
    assert first == value(1, tag, T0)
    now[0] = stamp + 1.5  # still inside the same update
    assert sim.value_of(tag) == first
    now[0] = T0 + 596
    assert sim.value_of(tag) != first and sample(1, tag, now[0])[1] > stamp  # nine updates later it is another stamp and another value


def test_every_tag_updates_on_the_4_second_grid_and_keeps_its_own_clock(now):
    periods, firsts = [], []
    for tag in some_tags():
        updates = history(1, tag)
        stamps = [stamp for stamp, _ in updates]
        assert all(stamp % 4 == 0 for stamp in stamps), tag
        gaps = [b - a for a, b in itertools.pairwise(stamps)]
        assert 80 <= len(stamps) <= 125 and all(60 <= gap <= 80 for gap in gaps), (tag, min(gaps), max(gaps))  # 64..76 s and one step of jitter
        mean = (stamps[-1] - stamps[0]) / (len(stamps) - 1)
        assert min(abs(mean - period) for period in PERIODS) < 0.5, (tag, mean)  # the average gap is the tag's own period
        periods.append(min(PERIODS, key=lambda period: abs(mean - period)))
        firsts.append(stamps[1])
    assert set(periods) == set(PERIODS)  # the tags do not all share one clock
    assert len(set(firsts)) >= 12  # and not one phase either (20 grid steps are possible): the values of a meter do not arrive together
    for offset in range(0, 7200, 4):  # the stamp is the newest update at or before the instant, never ahead of it
        stamp = sample(1, "PDUA01_PM0_P", T0 + offset)[1]
        assert stamp <= T0 + offset < stamp + 84


def test_about_a_quarter_of_the_updates_repeat_the_previous_value(now):
    sim = ScadaSim(ScadaConfig(pdus=3, live=True), free_port())
    updates = repeats = 0
    for tag in sim.tags[:81]:  # three meters
        values = [number for _, number in history(1, tag)]
        updates += len(values) - 1
        repeats += sum(a == b for a, b in itertools.pairwise(values))
        assert len(set(values)) > 20, tag  # a tag is not a constant
    assert updates > 6000
    assert 0.15 <= repeats / updates <= 0.33, repeats / updates
    assert abs(repeats / updates - 0.24) < 0.04


def test_values_are_float32_and_the_widened_double_is_not_its_decimal_form(now):
    shown = total = 0
    for tag in some_tags():
        for _, number in history(3, tag, seconds=1200):
            assert struct.unpack("f", struct.pack("f", number))[0] == number, tag  # a float32 widened to a double, nothing finer
            total += 1
            shown += number != round(number, 1)
    assert shown > 0.8 * total  # 68.8 reads as 68.80000305..., never as the clean decimal
    # the same value a double server would show differs from its float32 form: the thing the connector must carry through unchanged
    assert float32(68.8) == 68.80000305175781 != 68.8


def test_penrg_is_a_kwh_counter_in_quarter_kwh_steps_that_rises_with_the_meters_power(now):
    for meter in ("PDUA01_PM0", "PDUB07_PM0", "PDUA24_PM0"):
        counter = history(1, f"{meter}_PENRG")
        numbers = [number for _, number in counter]
        assert all(3_116_496 <= number < 3_300_000 for number in numbers), meter  # near 3.1 million kWh
        assert all(number * 4 == round(number * 4) for number in numbers)  # float32 near 3.1 million has 0.25 steps
        steps = {b - a for a, b in itertools.pairwise(numbers)}
        assert min(steps) >= 0 and all(step * 4 == round(step * 4) for step in steps) and any(step > 0 for step in steps)
        raised = numbers[-1] - numbers[0]
        mean_power = sum(value(1, f"{meter}_P", T0 + offset) for offset in range(0, 7200, 4)) / 1800  # kW, so kWh per hour
        assert abs(raised - mean_power * 2) < 0.03 * raised + 0.6, (meter, raised, mean_power * 2)  # two hours of its own power
    # past 2^22 float32 has 0.5 steps, with no code of ours: the same counter, years later
    late = [value(1, "PDUA01_PM0_PENRG", T0 + 15 * 365 * 86400 + offset) for offset in range(0, 7200, 4)]
    assert min(late) > 4_194_304 and all(number * 2 == round(number * 2) for number in late)
    assert all(b >= a and (b - a) * 2 == round((b - a) * 2) for a, b in itertools.pairwise(late))  # every step is a whole number of halves
    assert float32(4_194_304.25) == 4_194_304.0


def test_every_kind_of_tag_has_a_plausible_value_in_its_unit(now):
    sim = ScadaSim(ScadaConfig(pdus=200, branch_tags=4190, live=True), free_port())
    assert len(sim.tags) == 400 * 27 + 10 + 4190 == 15_000 and len(set(sim.tags)) == 15_000
    started = time.perf_counter()
    values = {tag: sim.value_of(tag) for tag in [*sim.tags, *sim.extra_tags]}
    assert time.perf_counter() - started < 10
    limits = {"kW": (0.2, 450), "kVA": (0.2, 500), "kvar": (0.0, 500), "A": (0.0, 3000), "V": (220, 240), "%": (0.1, 15),
              "Hz": (49.9, 50.1), "PF": (0.8, 1.0), "kWh": (3_116_496, 3_400_000)}
    for tag, number in values.items():
        low, high = limits[scada_module.unit_of(tag)]
        assert low <= number <= high, (tag, number)
        assert number == float32(number)
    assert all(0.3 <= values[tag] <= 8 for tag in sim.tags if re.fullmatch(r"PDUA\d+_Q\d+_P", tag))  # a branch
    assert all(100 <= values[tag] <= 450 for tag in sim.tags[-10:])  # an incomer carries many PDUs
    assert set(METER_SUFFIXES) == {tag.split("_", 2)[2] for tag in sim.extra_tags}


async def test_a_live_read_serves_float32_with_the_source_timestamp_on_the_grid(now):
    async with scada(pdus=1, seed=5, live=True) as sim:
        tags = [*sim.tags[:27], *sim.tags[-10:]]
        reads = []
        for moment in (T0 + 1234, T0 + 1234.5, T0 + 1300, T0 + 4000):  # inside one update, then later ones
            now[0] = float(moment)
            reads.append(await connector(sim).read([sim.stable_id(tag) for tag in tags]))
            assert all(v.quality == GOOD for v in reads[-1])
            assert [v.value for v in reads[-1]] == [value(5, tag, moment) for tag in tags] == [sim.value_of(tag) for tag in tags]
        assert [v.value for v in reads[0]] == [v.value for v in reads[1]]  # half a second later nothing has updated
        assert [v.value for v in reads[0]] != [v.value for v in reads[3]]
        for read in reads:
            for point in read:
                assert struct.unpack("f", struct.pack("f", point.value))[0] == point.value  # the widened float32 survives the connector
        assert sum(v.value != round(v.value, 1) for v in reads[0]) > 0.8 * len(tags)
        async with Client(endpoint(sim)) as client:
            now[0] = float(T0 + 1300)
            node = client.get_node(sim.stable_id("PDUA01_PM0_P"))
            assert await node.read_data_type_as_variant_type() == ua.VariantType.Float
            [answer] = await client.read_attributes([node], ua.AttributeIds.Value)
            number, stamp = sample(5, "PDUA01_PM0_P", now[0])
            assert answer.Value.VariantType == ua.VariantType.Float and answer.Value.Value == number
            assert answer.SourceTimestamp == datetime.fromtimestamp(stamp, timezone.utc)  # the instant of the tag's own update
            assert stamp % 4 == 0 and stamp <= now[0] < stamp + 84
            assert answer.ServerTimestamp == datetime.fromtimestamp(now[0], timezone.utc)
            [name] = await client.read_attributes([node], ua.AttributeIds.DisplayName)  # other attributes pass through untouched
            assert name.Value.Value.Text == "PDUA01_PM0_P"


async def test_the_constant_server_still_shows_doubles(monkeypatch):
    monkeypatch.setattr(scada_module, "clock", lambda: pytest.fail("the constant server must not look at the clock"))
    async with scada(pdus=1) as sim:
        async with Client(endpoint(sim)) as client:
            node = client.get_node(sim.stable_id("PDUA01_PM0_P"))
            assert await node.read_data_type_as_variant_type() == ua.VariantType.Double
            [answer] = await client.read_attributes([node], ua.AttributeIds.Value)
            assert answer.Value.Value == sim.value_of("PDUA01_PM0_P") == 1013.0
            assert answer.SourceTimestamp != datetime.fromtimestamp(T0, timezone.utc)


async def test_live_values_follow_the_tag_a_number_means_now(now):
    async with scada(pdus=2, live=True, seed=9) as sim:
        old = {tag: sim.numbered_id(tag) for tag in sim.tags}  # the numbers of the first listing
        sim.restructure("by_index")
        holders = sim.extra_tags + sim.tags
        for position in (0, 5, 27, 60):
            tag, holder = sim.tags[position], holders[position]
            [answer] = await connector(sim).read([old[tag]])
            assert answer.quality == GOOD and answer.value == value(9, holder, now[0]) == sim.value_of(holder)


def test_a_live_value_is_a_float32_for_every_seed_and_instant(now):
    for seed in (0, 1, 999_999):
        for tag in ("PDUA01_PM0_PENRG", "PDUB24_PM0_PF", "IT1IN_QM_P", "PDUA02_Q3_P"):
            for instant in (0, T0, T0 + 10**9):
                number, stamp = sample(seed, tag, instant)
                assert math.isfinite(number) and number == float32(number) and stamp % 4 == 0 and stamp <= instant
