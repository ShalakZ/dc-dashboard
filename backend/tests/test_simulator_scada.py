"""The SCADA-shaped OPC UA server (dcdash/simulator/scada.py): numbered and stable ids, restructure, the read limit, the counters.

The real OpcUaConnector is the client, so what these tests see is what the collector sees."""
import contextlib
import itertools
import re
import time

import pytest
from asyncua import Client, ua

from dcdash.connectors.base import BAD, GOOD, ConnectorError, create_connector
from dcdash.simulator.scada import ScadaConfig, ScadaSim
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
