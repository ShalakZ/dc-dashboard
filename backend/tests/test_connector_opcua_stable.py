"""The OPC UA connector's option `stable_addresses` (w34, R2 to R4, D5): what a read sends and how it files the answers.

Most tests use a fake session (no server), so they see exactly which node ids a read puts on the wire."""

from contextlib import asynccontextmanager

import pytest
from asyncua import ua
from pydantic import ValidationError

from dcdash.connectors import opcua as opcua_module
from dcdash.connectors.base import BAD, GOOD, create_connector
from dcdash.connectors.opcua import OpcUaConfig, OpcUaConnector
from dcdash.connectors.opcua_ids import address_key_for, stable_address
from tests.helpers import opcua_server

ENDPOINT = "opc.tcp://127.0.0.1:1/"
A_NUM, B_STABLE, C_NUM = "ns=3;s=20403:Site.A", "ns=3;s=Site.B", "ns=3;s=20418:Site.C"
A, B, C = "ns=3;s=Site.A", "ns=3;s=Site.B", "ns=3;s=Site.C"
SAME_TEXT = "two points are the same tag (stable address ns=3;s=Site.A)"
LIMIT_NODE = ua.NodeId(ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead)


def _good(value):
    return ua.DataValue(ua.Variant(value, ua.VariantType.Double), StatusCode_=ua.StatusCode(ua.StatusCodes.Good))


class _Node:
    def __init__(self, address):
        self.address = address


class FakeSession:
    """What `OpcUaConnector._session` yields: `get_node` keeps the address, `read_attributes` records it and answers from a dict
    keyed by the STABLE address (an unknown one is BadNodeIdUnknown, as a server answers)."""

    def __init__(self, values):
        self.values = values
        self.requests = []  # the Reads of tags (the one-off Read of the server's MaxNodesPerRead is counted in `limit_reads`)
        self.limit_reads = 0
        self.sessions = 0
        self.drop_last_answer = False

    def get_node(self, address):
        return _Node(address)

    async def read_attributes(self, nodes, attr):
        assert attr == ua.AttributeIds.Value
        addresses = [n.address for n in nodes]
        if addresses == [LIMIT_NODE]:
            self.limit_reads += 1
            return [_good(0)]  # "no limit"
        self.requests.append(addresses)
        answers = [
            _good(self.values[a]) if a in self.values else ua.DataValue(StatusCode_=ua.StatusCode(ua.StatusCodes.BadNodeIdUnknown))
            for a in addresses
        ]
        return answers[:-1] if self.drop_last_answer else answers


@pytest.fixture
def session(monkeypatch):
    fake = FakeSession({A: 1.0, B: 2.0, C: 3.0})

    @asynccontextmanager
    async def fake_session(self):
        fake.sessions += 1
        yield fake

    monkeypatch.setattr(OpcUaConnector, "_session", fake_session)
    return fake


def _connector(**extra):
    return create_connector("opcua", {"endpoint": ENDPOINT, **extra})


async def test_the_server_is_asked_for_the_stable_forms_and_each_answer_lands_on_its_stored_string(session):
    stored = [C_NUM, A_NUM, B_STABLE]
    values = await _connector(stable_addresses=True).read(stored)
    assert session.requests == [[C, A, B]]  # one request, the stable forms, the caller's order
    assert [(v.address, v.value, v.quality, v.status) for v in values] == [
        (C_NUM, 3.0, GOOD, None), (A_NUM, 1.0, GOOD, None), (B_STABLE, 2.0, GOOD, None)]


async def test_two_stored_strings_of_one_tag_are_not_read_and_come_back_bad(session):
    values = await _connector(stable_addresses=True).read([A_NUM, B_STABLE, "ns=3;s=20410:Site.A", C_NUM, A])
    assert session.requests == [[B, C]]  # neither form of Site.A went to the server
    assert [(v.address, v.value, v.quality, v.status) for v in values] == [
        (A_NUM, None, BAD, SAME_TEXT), (B_STABLE, 2.0, GOOD, None), ("ns=3;s=20410:Site.A", None, BAD, SAME_TEXT),
        (C_NUM, 3.0, GOOD, None), (A, None, BAD, SAME_TEXT)]


async def test_the_same_stored_string_twice_is_read_once_and_answered_twice(session):
    values = await _connector(stable_addresses=True).read([A_NUM, B_STABLE, A_NUM])
    assert session.requests == [[A, B]]
    assert [(v.address, v.value) for v in values] == [(A_NUM, 1.0), (B_STABLE, 2.0), (A_NUM, 1.0)]


async def test_an_unknown_node_is_bad_under_its_stored_string(session):
    values = await _connector(stable_addresses=True).read(["ns=3;s=20999:Site.Nobody", A_NUM])
    assert session.requests == [["ns=3;s=Site.Nobody", A]]
    assert (values[0].address, values[0].value, values[0].quality) == ("ns=3;s=20999:Site.Nobody", None, BAD)
    assert values[0].status == "BadNodeIdUnknown (0x80340000)" and values[1].value == 1.0


async def test_a_request_for_no_node_is_not_sent_but_the_session_is_still_opened(session):
    connector = _connector(stable_addresses=True)
    assert await connector.read([]) == []
    both = await connector.read([A_NUM, "ns=3;s=20410:Site.A"])  # all refused
    assert [(v.value, v.quality, v.status) for v in both] == [(None, BAD, SAME_TEXT)] * 2
    assert session.requests == [] and session.sessions == 2


async def test_an_answer_of_the_wrong_length_is_an_error_not_a_misfiled_value(session):
    session.drop_last_answer = True
    with pytest.raises(ValueError):
        await _connector(stable_addresses=True).read([A_NUM, B_STABLE])


@pytest.mark.parametrize("extra", [{}, {"stable_addresses": False}], ids=["key missing", "off"])
async def test_option_off_sends_the_stored_strings_and_never_calls_the_helpers(session, monkeypatch, extra):
    def must_not_be_called(*args, **kwargs):
        raise AssertionError("the option is off: no address helper may run")

    monkeypatch.setattr(opcua_module, "stable_address", must_not_be_called)
    monkeypatch.setattr(opcua_module, "read_plan", must_not_be_called)
    session.values = {A_NUM: 7.0, B_STABLE: 8.0}
    stored = [A_NUM, B_STABLE, "ns=3;s=20410:Site.A", A_NUM]
    values = await _connector(**extra).read(stored)
    assert session.requests == [stored]  # as given: numbered forms, repeats and all
    assert [(v.address, v.value) for v in values] == [(A_NUM, 7.0), (B_STABLE, 8.0), ("ns=3;s=20410:Site.A", None), (A_NUM, 7.0)]


async def test_ns2_numeric_addresses_read_the_same_with_the_option_on_and_off():
    async with opcua_server() as srv:
        endpoint = srv.endpoint.replace("0.0.0.0", "127.0.0.1")
        off = create_connector("opcua", {"endpoint": endpoint, "timeout_seconds": 2})
        on = create_connector("opcua", {"endpoint": endpoint, "timeout_seconds": 2, "stable_addresses": True})
        addresses = [p.address for p in await off.browse()]
        before, after = await off.read(addresses), await on.read(addresses)
    assert len(addresses) == 60 and all(v.quality == GOOD for v in before)
    assert [(v.address, v.value, v.quality, v.status) for v in after] == [(v.address, v.value, v.quality, v.status) for v in before]
    assert [v.address for v in after] == addresses


async def test_browse_of_an_ns2_server_is_the_same_with_the_option_on():
    async with opcua_server() as srv:
        endpoint = srv.endpoint.replace("0.0.0.0", "127.0.0.1")
        off = await create_connector("opcua", {"endpoint": endpoint, "timeout_seconds": 2}).browse()
        on = await create_connector("opcua", {"endpoint": endpoint, "timeout_seconds": 2, "stable_addresses": True}).browse()
    assert on == off and len(on) == 60


def test_the_option_is_off_by_default_and_is_saved_with_the_config():
    assert OpcUaConfig(endpoint=ENDPOINT).stable_addresses is False
    assert OpcUaConfig(endpoint=ENDPOINT).model_dump(mode="json")["stable_addresses"] is False
    assert OpcUaConfig(endpoint=ENDPOINT, stable_addresses=True).model_dump(mode="json")["stable_addresses"] is True
    stored = {"endpoint": ENDPOINT, "security_policy": "none", "username": None, "root_node": "i=85", "timeout_seconds": 5.0,
              "client_cert": "/certs/opcua-client.pem", "client_key": "/certs/opcua-client-key.pem"}  # saved before the option existed
    assert OpcUaConfig.model_validate(stored).stable_addresses is False


def test_the_option_has_the_agreed_title_and_description():
    schema = OpcUaConfig.model_json_schema()["properties"]["stable_addresses"]
    assert schema["title"] == "Stable tag addresses"
    assert schema["description"] == (
        "For AVEVA Plant SCADA: read each tag as ns=3;s=Cluster.Tag, without the number browsing puts in front of it (20403:), "
        "which can change when the SCADA project changes. Based on a community answer, not tested against your SCADA. "
        "Leave this off for other servers.")
    assert schema["type"] == "boolean" and schema["default"] is False


_MISSING = object()


@pytest.mark.parametrize(
    ("raw", "accepted", "on"),
    [(True, True, True), (False, True, False), (_MISSING, True, False), ("true", False, False), ("True", False, False),
     (1, False, False), (0, False, False), (None, False, False), ("false", False, False)],
    ids=["true", "false", "missing", "string true", "string True", "one", "zero", "null", "string false"],
)
def test_the_read_and_the_matchers_agree_on_the_flag(raw, accepted, on):
    config = {"endpoint": ENDPOINT} | ({} if raw is _MISSING else {"stable_addresses": raw})
    key = address_key_for("opcua", config)
    if accepted:
        assert OpcUaConfig.model_validate(config).stable_addresses is on
        assert create_connector("opcua", config).config.stable_addresses is on
    else:  # the connector cannot be built (the source goes offline with "invalid configuration"): loud, not a silent other answer
        with pytest.raises(ValidationError):
            OpcUaConfig.model_validate(config)
        with pytest.raises(ValidationError):
            create_connector("opcua", config)
    assert (key is stable_address) is on


# -- against the SCADA-shaped server (simulator/scada.py): the numbers a Browse shows, and the values a read brings back ------------


@asynccontextmanager
async def scada_server(**knobs):
    from dcdash.simulator.scada import ScadaConfig, ScadaSim  # imported here: a problem in that module fails these tests only
    from tests.helpers import free_port

    sim = ScadaSim(ScadaConfig(**knobs), free_port())
    await sim.start()
    try:
        yield sim
    finally:
        await sim.stop()


def _scada_connector(sim, **extra):
    endpoint = sim.endpoint.replace("0.0.0.0", "127.0.0.1")
    return create_connector("opcua", {"endpoint": endpoint, "timeout_seconds": 10, **extra})


async def test_browse_with_the_option_on_lists_no_number_and_with_it_off_every_address_has_one():
    import re

    async with scada_server(pdus=2) as sim:  # 4 meters x 27 tags + 10 incomers
        off = await _scada_connector(sim).browse()
        on = await _scada_connector(sim, stable_addresses=True).browse()
    assert len(sim.tags) == 118 and len(off) == len(on) == 118
    assert all(re.fullmatch(r"ns=3;s=[0-9]+:Site\.[A-Za-z0-9_]+", d.address) for d in off)
    assert not any(re.search(r"s=[0-9]+:", d.address) for d in on)
    assert {d.address for d in on} == {sim.stable_id(tag) for tag in sim.tags}
    assert [(d.name, d.unit_hint) for d in on] == [(d.name, d.unit_hint) for d in off]  # the same descriptors in the same order
    assert [d.address for d in on] == [stable_address(d.address) for d in off]
    assert [d.name for d in on] == sorted(d.name for d in on)


async def test_200_mixed_numbered_and_stable_addresses_each_get_their_own_value():
    async with scada_server(pdus=4) as sim:  # 226 tags, every one has its own value
        tags = sim.tags[:200]
        stored = [sim.numbered_id(tag) if index % 2 == 0 else sim.stable_id(tag) for index, tag in enumerate(tags)]
        values = await _scada_connector(sim, stable_addresses=True).read(stored)
        assert sim.counters.read_sizes == [200]  # one request, today's shape
    assert [v.address for v in values] == stored
    assert [v.quality for v in values] == [GOOD] * 200
    assert [v.value for v in values] == [sim.value_of(tag) for tag in tags]
    assert len({v.value for v in values}) == 200


async def test_the_stored_numbers_can_be_wrong_and_every_value_still_lands_on_its_own_address():
    async with scada_server(pdus=4) as sim:
        tags = sim.tags[:200]
        stored = [sim.numbered_id(tag) for tag in tags]  # the numbers of the first browse
        for mode in ("bad", "by_index"):
            sim.restructure(mode)
            on = await _scada_connector(sim, stable_addresses=True).read(stored)
            assert [v.value for v in on] == [sim.value_of(tag) for tag in tags], mode
            assert [v.address for v in on] == stored


async def test_two_stored_forms_of_one_tag_are_both_bad_and_the_rest_are_read():
    async with scada_server(pdus=4) as sim:
        tags = sim.tags[:50]
        stored = [sim.stable_id(tag) for tag in tags] + [sim.numbered_id(tags[0])]  # the first tag is stored twice, in two forms
        values = await _scada_connector(sim, stable_addresses=True).read(stored)
        assert sim.counters.read_sizes == [49]  # the pair was not sent
    text = f"two points are the same tag (stable address {sim.stable_id(tags[0])})"
    assert [(v.address, v.value, v.quality, v.status) for v in (values[0], values[-1])] == [
        (stored[0], None, BAD, text), (stored[-1], None, BAD, text)]
    assert [v.value for v in values[1:-1]] == [sim.value_of(tag) for tag in tags[1:]]
