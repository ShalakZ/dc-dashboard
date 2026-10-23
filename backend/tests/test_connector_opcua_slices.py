"""The poll reads in slices, like the check (w34 R9, D6): how many nodes go in one Read request, what happens when a server refuses
a request as too big, and that every value still lands on the address the caller gave, in the caller's order.

Counts come from the SCADA-shaped server's counters: `read_sizes` has the node count of every Read that carries tags (the one-off
Read of `MaxNodesPerRead` is `limit_reads`). Most numbers are derived by hand in the comment next to them."""

import contextlib
import re
from contextlib import asynccontextmanager

import pytest
from asyncua import Client, ua

from dcdash.connectors import opcua as opcua_module
from dcdash.connectors import opcua_check
from dcdash.connectors.base import BAD, GOOD, ConnectorError, create_connector
from dcdash.connectors.opcua import OpcUaConnector
from dcdash.connectors.opcua_ids import stable_address
from dcdash.simulator.scada import ScadaConfig, ScadaSim
from tests.helpers import free_port

LIMIT_NODE = ua.NodeId(ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead)
ENDPOINT = "opc.tcp://127.0.0.1:1/"


@pytest.fixture(autouse=True)
def quick_timing(monkeypatch):
    monkeypatch.setattr(opcua_check, "TIMING_PAUSE", 0)


@contextlib.asynccontextmanager
async def scada(**knobs):
    sim = ScadaSim(ScadaConfig(**knobs), free_port())
    await sim.start()
    try:
        yield sim
    finally:
        await sim.stop()


def connector(sim, **extra):
    endpoint = sim.endpoint.replace("0.0.0.0", "127.0.0.1")
    return create_connector("opcua", {"endpoint": endpoint, "timeout_seconds": 10, **extra})


def stable_ids(sim, count):
    return [sim.stable_id(tag) for tag in sim.tags[:count]]


def assert_each_value_on_its_own_address(values, stored, sim, tags):
    assert [v.address for v in values] == stored
    assert [v.quality for v in values] == [GOOD] * len(stored)
    assert [v.value for v in values] == [sim.value_of(tag) for tag in tags]


# -- the sizes the poll sends ---------------------------------------------------------------------------------------------------


async def test_450_addresses_and_no_limit_advertised_go_in_slices_of_200():
    async with scada(pdus=9) as sim:  # 496 tags, advertises MaxNodesPerRead 0 (no limit) and enforces none
        stored = stable_ids(sim, 450)
        values = await connector(sim).read(stored)
        assert sim.counters.read_sizes == [200, 200, 50]  # 450 = 200 + 200 + 50
        assert sim.counters.limit_reads == 1
    assert_each_value_on_its_own_address(values, stored, sim, sim.tags[:450])


async def test_a_limit_the_server_advertises_and_enforces_is_obeyed_and_never_refused():
    async with scada(pdus=9, max_nodes_per_read=120) as sim:
        stored = stable_ids(sim, 450)
        values = await connector(sim).read(stored)
        assert sim.counters.read_sizes == [120, 120, 120, 90]  # 450 = 3 * 120 + 90, no refused request among them
        assert sim.counters.limit_reads == 1
    assert_each_value_on_its_own_address(values, stored, sim, sim.tags[:450])


async def test_a_server_that_advertises_no_limit_but_enforces_one_is_learned_from_the_refusal():
    async with scada(pdus=9, max_nodes_per_read=120, advertised_max_nodes=0) as sim:
        stored = stable_ids(sim, 450)
        c = connector(sim)
        values = await c.read(stored)
        # The cap is 200, and the first 200-slice is refused (it is still a request): sent again as 100 + 100, which are
        # accepted. The size 100 is remembered, so the 250 nodes left go as 100 + 100 + 50.
        assert sim.counters.read_sizes == [200, 100, 100, 100, 100, 50]
        assert sim.counters.limit_reads == 1
        assert_each_value_on_its_own_address(values, stored, sim, sim.tags[:450])
        sim.counters.reset()
        again = await c.read(stored)  # the same connector: it starts at 100 and does not ask for the limit again
        assert sim.counters.read_sizes == [100, 100, 100, 100, 50]  # 450 = 4 * 100 + 50
        assert sim.counters.limit_reads == 0
        assert_each_value_on_its_own_address(again, stored, sim, sim.tags[:450])


async def test_a_server_that_advertises_500_and_enforces_120_is_halved_once():
    async with scada(pdus=5, max_nodes_per_read=120, advertised_max_nodes=500) as sim:
        stored = stable_ids(sim, 250)
        values = await connector(sim).read(stored)
        assert sim.counters.read_sizes == [200, 100, 100, 50]  # min(500, 200) = 200 refused, 100 + 100, then the last 50
    assert_each_value_on_its_own_address(values, stored, sim, sim.tags[:250])


async def test_option_on_slices_the_stable_forms_and_files_every_value_under_the_stored_string():
    async with scada(pdus=9) as sim:
        stored = [sim.numbered_id(tag) if index % 2 == 0 else sim.stable_id(tag) for index, tag in enumerate(sim.tags[:450])]
        values = await connector(sim, stable_addresses=True).read(stored)
        assert sim.counters.read_sizes == [200, 200, 50]
    assert_each_value_on_its_own_address(values, stored, sim, sim.tags[:450])


async def test_a_refused_pair_and_a_halved_slice_in_the_same_call():
    """Option on, a server that advertises 0 and enforces 120, two stored strings that are one tag, and more than 200 others."""
    async with scada(pdus=5, max_nodes_per_read=120, advertised_max_nodes=0) as sim:  # 280 tags
        tags = sim.tags[:250]
        pair = sim.stable_id(tags[0])
        stored = [sim.numbered_id(tag) for tag in tags] + [pair]  # the first tag is stored twice, in two forms
        c = connector(sim, stable_addresses=True)
        values = await c.read(stored)
        # 249 tags are sent (neither form of the pair is). The 200-slice is refused, goes again as 100 + 100; the 49 left follow.
        assert sim.counters.read_sizes == [200, 100, 100, 49]
        again = await c.read(stored)  # the learned size 100 is kept: 249 = 100 + 100 + 49
        assert sim.counters.read_sizes[4:] == [100, 100, 49]
    for result in (values, again):
        assert [v.address for v in result] == stored  # the caller's list, in the caller's order
        text = f"two points have the same stable address {pair}"
        assert [(v.value, v.quality, v.status) for v in (result[0], result[-1])] == [(None, BAD, text)] * 2
        assert [v.value for v in result[1:-1]] == [sim.value_of(tag) for tag in tags[1:]]
        assert [v.quality for v in result[1:-1]] == [GOOD] * 249


# -- a refusal that does not go away ------------------------------------------------------------------------------------------


async def test_a_second_refusal_is_a_typed_error_and_the_next_poll_starts_smaller():
    async with scada(pdus=9, max_nodes_per_read=60, advertised_max_nodes=0) as sim:
        stored = stable_ids(sim, 450)
        c = connector(sim)
        with pytest.raises(ConnectorError) as typed:
            await c.read(stored)
        # 200 is refused, halved to 100 + 100, and 100 is refused again: the error names the refused half
        assert typed.value.status == "protocol_error"
        assert typed.value.message == "the server refuses reads of 100 tags at once (BadTooManyOperations)"
        assert sim.counters.read_sizes == [200, 100]
        assert c._slice == 100  # remembered anyway, so the next poll gets nearer
        sim.counters.reset()
        values = await c.read(stored)
        # 100 is refused, halved to 50 + 50 (accepted), 50 is kept for the 350 nodes left: 7 * 50
        assert sim.counters.read_sizes == [100, 50, 50, *[50] * 7]
    assert_each_value_on_its_own_address(values, stored, sim, sim.tags[:450])


async def test_a_server_that_refuses_every_size_ends_in_the_typed_error_never_in_a_loop():
    async with scada(pdus=2, max_nodes_per_read=5, advertised_max_nodes=0) as sim:  # 118 tags, the server accepts 5 at most
        stored = stable_ids(sim, 118)
        c = connector(sim)
        named = []
        for _poll in range(7):
            sim.counters.reset()
            with pytest.raises(ConnectorError) as typed:
                await c.read(stored)
            assert typed.value.status == "protocol_error" and "(BadTooManyOperations)" in typed.value.message
            named.append(int(re.search(r"reads of (\d+) tags", typed.value.message)[1]))
            assert len(sim.counters.read_sizes) <= 2  # a refusal and one halving, nothing more
        # slice 118 (all of it) -> halves of 59; slice 59 -> halves of 30; 30 -> 15; 15 is too small to halve (8 < 10); then 10
        assert named == [59, 30, 15, 15, 10, 10, 10]
        assert c._slice == 10  # never below 10


# -- the limit is asked once, and what is not a limit means the cap ---------------------------------------------------------------


def _dv(value):
    kind = {bool: ua.VariantType.Boolean, str: ua.VariantType.String}.get(type(value), ua.VariantType.UInt32)
    return ua.DataValue(ua.Variant(value, kind), StatusCode_=ua.StatusCode(ua.StatusCodes.Good))


class _Node:
    def __init__(self, address):
        self.address = address


class FakeSession:
    """What `OpcUaConnector._session` yields: records the size of every request for tags and every ask for the limit."""

    def __init__(self, limit=None, refuse_above=None, fail_with=None, short_answers=False):
        self.limit = limit  # an int/bool/str answer, "raise" (the Read fails), "bad" (a Bad status), or None (answers 0)
        self.refuse_above = refuse_above
        self.fail_with = fail_with
        self.short_answers = short_answers  # every answer lacks its last value
        self.requests = []
        self.limit_asks = 0
        self.sessions = 0

    def get_node(self, address):
        return _Node(address)

    async def read_attributes(self, nodes, attr):
        assert attr == ua.AttributeIds.Value
        addresses = [n.address for n in nodes]
        if addresses == [LIMIT_NODE]:
            self.limit_asks += 1
            if self.limit == "raise":
                raise RuntimeError("the server cannot say")
            if self.limit == "bad":
                return [ua.DataValue(StatusCode_=ua.StatusCode(ua.StatusCodes.BadAttributeIdInvalid))]
            return [_dv(0 if self.limit is None else self.limit)]
        self.requests.append(len(addresses))
        if self.fail_with is not None:
            raise ua.UaStatusCodeError(self.fail_with)
        if self.refuse_above is not None and len(addresses) > self.refuse_above:
            raise ua.UaStatusCodeError(ua.StatusCodes.BadTooManyOperations)
        answers = [_dv(1) for _ in addresses]
        return answers[:-1] if self.short_answers else answers


def use(monkeypatch, fake):
    @asynccontextmanager
    async def fake_session(self):
        fake.sessions += 1
        yield fake

    monkeypatch.setattr(OpcUaConnector, "_session", fake_session)
    return fake


def addresses(count):
    return [f"ns=2;i={n}" for n in range(1, count + 1)]


@pytest.mark.parametrize(
    "answer",
    ["raise", "bad", None, 0, True, "120", -5],
    ids=["the Read fails", "a Bad status", "zero", "zero again", "a bool", "text", "negative"],
)
async def test_a_limit_that_is_not_a_positive_number_means_the_cap_and_is_asked_once(monkeypatch, answer):
    fake = use(monkeypatch, FakeSession(limit=answer))
    c = create_connector("opcua", {"endpoint": ENDPOINT})
    for _call in range(2):
        values = await c.read(addresses(450))
        assert len(values) == 450 and all(v.quality == GOOD for v in values)
    assert fake.requests == [200, 200, 50] * 2
    assert fake.limit_asks == 1 and fake.sessions == 2  # "unreadable" is remembered as well: not asked again


async def test_a_limit_the_server_names_is_used_with_the_cap_as_the_ceiling(monkeypatch):
    fake = use(monkeypatch, FakeSession(limit=80))
    await create_connector("opcua", {"endpoint": ENDPOINT}).read(addresses(450))
    assert fake.requests == [80] * 5 + [50]  # 450 = 5 * 80 + 50
    fake = use(monkeypatch, FakeSession(limit=10_000))
    await create_connector("opcua", {"endpoint": ENDPOINT}).read(addresses(450))
    assert fake.requests == [200, 200, 50]


async def test_a_read_of_no_node_sends_nothing_and_asks_nothing(monkeypatch):
    fake = use(monkeypatch, FakeSession())
    assert await create_connector("opcua", {"endpoint": ENDPOINT}).read([]) == []
    assert fake.requests == [] and fake.limit_asks == 0 and fake.sessions == 1


async def test_any_other_error_fails_the_whole_read_without_a_halving(monkeypatch):
    fake = use(monkeypatch, FakeSession(fail_with=ua.StatusCodes.BadConnectionClosed))
    with pytest.raises(ua.UaStatusCodeError) as raised:
        await create_connector("opcua", {"endpoint": ENDPOINT}).read(addresses(450))
    assert raised.value.code == ua.StatusCodes.BadConnectionClosed
    assert fake.requests == [200]  # no second request, no halving


async def test_a_short_answer_ends_in_an_error_and_not_in_a_loop(monkeypatch):
    fake = use(monkeypatch, FakeSession(short_answers=True))
    with pytest.raises(ValueError):  # the caller's strict zip: a value is never filed under the wrong address
        await create_connector("opcua", {"endpoint": ENDPOINT}).read(addresses(450))
    assert fake.requests == [200, 200, 50]


async def test_the_halving_keeps_the_order_of_a_refused_slice(monkeypatch):
    fake = use(monkeypatch, FakeSession(refuse_above=100))
    seen = []
    original = fake.read_attributes

    async def spy(nodes, attr):
        if nodes[0].address != LIMIT_NODE:
            seen.append([n.address for n in nodes])
        return await original(nodes, attr)

    monkeypatch.setattr(fake, "read_attributes", spy)
    values = await create_connector("opcua", {"endpoint": ENDPOINT}).read(addresses(250))
    assert [len(part) for part in seen] == [200, 100, 100, 50]
    assert [a for part in seen[1:] for a in part] == addresses(250)  # the halves and the rest, in the caller's order
    assert [v.address for v in values] == addresses(250)


# -- the check and the poll --------------------------------------------------------------------------------------------------


def _spy_slice_size(monkeypatch, module):
    calls = []
    original = module.slice_size

    def spy(server_limit, cap):
        calls.append((server_limit, cap, original(server_limit, cap)))
        return calls[-1][2]

    monkeypatch.setattr(module, "slice_size", spy)
    return calls


async def test_the_check_and_the_poll_take_their_slice_from_the_same_rule(monkeypatch):
    poll_calls, check_calls = _spy_slice_size(monkeypatch, opcua_module), _spy_slice_size(monkeypatch, opcua_check)
    async with scada(pdus=4, max_nodes_per_read=80) as sim:  # advertises 80 and enforces 80: both caps (200 and 100) give 80
        stored = stable_ids(sim, 200)
        c = connector(sim)
        await c.read(stored)
        assert sim.counters.read_sizes == [80, 80, 40]
        sim.counters.reset()
        result = await c.check(stored)
    detail = {step.id: step for step in result.steps}["read_points"].detail
    assert poll_calls == [(80, 200, 80)] and check_calls == [(80, 100, 80)]
    assert detail["chunk_size"] == 80 and detail["server_max_nodes_per_read"] == 80
    assert max(sim.counters.read_sizes) == 80


async def test_with_no_limit_the_check_uses_100_and_the_poll_200_by_ruling():
    async with scada(pdus=4) as sim:
        stored = stable_ids(sim, 200)
        c = connector(sim)
        await c.read(stored)
        assert sim.counters.read_sizes == [200]
        result = await c.check(stored)
    assert {step.id: step for step in result.steps}["read_points"].detail["chunk_size"] == 100


async def test_the_check_reads_the_stable_forms_the_poll_reads_and_keeps_the_stored_string_in_its_rows(monkeypatch):
    reads = []
    original = Client.read_attributes

    async def spy(self, nodes, attr=ua.AttributeIds.Value):
        nodes = list(nodes)
        reads.append((attr, [node.nodeid.to_string() for node in nodes]))
        return await original(self, nodes, attr)

    monkeypatch.setattr(Client, "read_attributes", spy)

    def tag_values(attr):  # the reads of one attribute that carry tags (not the server time, the namespaces or the limit)
        return [ids for kind, ids in reads if kind == attr and any(i.startswith("ns=3;") for i in ids)]

    async with scada(pdus=2) as sim:
        tags = sim.tags[:12]
        pair = sim.stable_id(tags[0])
        stored = [sim.numbered_id(tag) for tag in tags[:11]] + [pair]  # the first tag is stored twice (a numbered and a stable form)
        c = connector(sim, stable_addresses=True)
        await c.read(stored)
        polled = tag_values(ua.AttributeIds.Value)
        reads.clear()
        result = await c.check(stored)
    wanted = [stable_address(address) for address in stored[1:11]]  # the pair is read by neither
    assert polled == [wanted]
    checked = tag_values(ua.AttributeIds.Value)
    assert checked[0] == wanted  # the read_points step: one chunk, the stable forms, the caller's order
    assert not any(re.search(r"s=[0-9]+:", i) for ids in checked for i in ids)  # the timing step reads stable forms too
    rows = {row["address"]: row for row in {step.id: step for step in result.steps}["read_points"].detail["points"]}
    assert set(rows) == set(stored)  # the stored strings, not the stable forms
    text = f"two points have the same stable address {pair}"
    assert [rows[a]["status"] for a in (stored[0], pair)] == [text, text] and not rows[pair]["good"] and not rows[stored[0]]["good"]
    assert all(rows[a]["good"] for a in stored[1:11])
