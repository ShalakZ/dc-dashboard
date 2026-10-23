"""Test compares the numbered and the stable address and suggests the option (w34 R6, R7, R8).

The comparison runs against the SCADA shape server and against a fake session; the Test job runs with a stand-in OPC UA connector
whose server is not needed. Everything here is a guess from a community answer: nothing is tested against a real Plant SCADA."""

import contextlib
import itertools
import re
from contextlib import asynccontextmanager

import pytest
from asyncua import Client, ua

from dcdash.collector.jobs import SUGGEST_STABLE, run_pending_jobs
from dcdash.connectors.base import ConnectionCheck, create_connector
from dcdash.connectors.opcua import OpcUaConfig, OpcUaConnector, StableComparison
from dcdash.connectors.opcua_check import _read_hints
from dcdash.connectors.opcua_ids import has_number_prefix, looks_like_plant_scada, stable_address, tag_name
from dcdash.diagnostics.hints import NUMBERING_CHANGED, hint_for
from dcdash.simulator.scada import ScadaConfig, ScadaSim
from helpers import free_port, make_asset, make_mapping, make_point, make_source

LIMIT_NODE = ua.NodeId(ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead)
BAD_UNKNOWN = ua.DataValue(StatusCode_=ua.StatusCode(ua.StatusCodes.BadNodeIdUnknown))

SAME = "10 of 10 tags read the same both ways"
UNKNOWN_ON = "the stable address is unknown to this server for 10 of 10 tags: turn the option off"
UNKNOWN_OFF = "the stable address is unknown to this server for 10 of 10 tags: do not turn the option on"
DEAD = "the numbered address no longer works for 10 of 10 tags but the stable one does: the SCADA numbering may have changed"


# ---- the pure functions -------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("address", "expected"),
    [
        ("ns=3;s=20403:Site.PDUA01_PM0_P", True),
        ("s=20403:Site.PDUA01_PM0_P", True),
        ("ns=3;s=1:foo", False),  # a normal id on other servers: no dot after the number
        ("ns=3;s=20403", False),  # the digits alone
        ("ns=3;s=Site.PDUA01_PM0_P", False),  # already stable
        ("ns=2;i=1234", False),
        ("ns=2;g=09087e75-8e5e-499b-954f-f2a9603db28a", False),
        ("ns=3;s=1:2:A.B", False),  # which number is "the" number?
        (" ns=3;s=20403:Site.A", False),
        ("", False),
    ],
)
def test_has_number_prefix_is_the_regex_of_stable_address(address, expected):
    assert has_number_prefix(address) is expected


def test_tag_name_is_the_tag_without_the_number_and_the_cluster():
    assert tag_name("ns=3;s=20403:Site.PDUA01_PM0_P") == "PDUA01_PM0_P"
    assert tag_name("ns=3;s=20403:Site.PDUA01.P") == "PDUA01.P"
    assert tag_name("ns=3;s=20403:Site.") == "Site."  # nothing after the dot: the whole rest
    assert tag_name("ns=2;i=5") == "ns=2;i=5"


NUMBERED = [f"ns=3;s={20000 + n}:Site.TAG{n}" for n in range(10)]
PLAIN = [f"ns=2;i={n}" for n in range(10)]
STRING_ID = "ns=3;s=20403"  # a string id that is not numbered


def mixed(numbered: int, others: int) -> list[str]:
    return [*NUMBERED[:numbered], *(f"ns=3;s=Site.OTHER{n}" for n in range(others))]


@pytest.mark.parametrize(
    ("identity", "endpoint", "sample", "expected"),
    [
        (None, "opc.tcp://10.0.0.5:4840/plantscada", NUMBERED, True),  # the path guess
        (None, "opc.tcp://10.0.0.5:4840/PlantSCADA", NUMBERED, True),  # case-insensitive
        (None, "opc.tcp://10.0.0.5:4840/", NUMBERED, False),  # nothing names it
        (None, "opc.tcp://plantscada:4840/", NUMBERED, False),  # only the PATH counts, not the host
        ({"application_name": "AVEVA Plant SCADA OPC UA"}, "opc.tcp://h:4840/", NUMBERED, True),
        ({"application_uri": "urn:host:PlantSCADA:server"}, "opc.tcp://h:4840/", NUMBERED, True),
        ({"product_uri": "http://www.citect.com/server"}, "opc.tcp://h:4840/", NUMBERED, True),
        ({"application_name": "Kepware"}, "opc.tcp://h:4840/", NUMBERED, False),
        ({"application_name": 7, "application_uri": None, "thumbprint": "plantscada"}, "opc.tcp://h:4840/", NUMBERED, False),
        ({}, "opc.tcp://h:4840/", NUMBERED, False),
        (None, "opc.tcp://h:4840/plantscada", [], False),  # no stored ids to judge
        (None, "opc.tcp://h:4840/plantscada", PLAIN, False),
        (None, "opc.tcp://h:4840/plantscada", [STRING_ID] * 10, False),  # the digits alone are never the number
        (None, "opc.tcp://h:4840/plantscada", mixed(8, 2), True),  # exactly 80 percent
        (None, "opc.tcp://h:4840/plantscada", mixed(7, 3), False),
        (None, "not a url [", NUMBERED, False),
        (None, "opc.tcp://[::1/plantscada", NUMBERED, False),  # a URL urlsplit refuses
    ],
)
def test_looks_like_plant_scada_table(identity, endpoint, sample, expected):
    assert looks_like_plant_scada(identity, endpoint, sample) is expected


def test_only_the_first_200_stored_ids_are_judged():
    first = [f"ns=3;s={n}:Site.T{n}" for n in range(160)] + [f"ns=3;s=Site.U{n}" for n in range(40)]  # 80 percent of 200
    assert looks_like_plant_scada(None, "opc.tcp://h/plantscada", first) is True
    assert looks_like_plant_scada(None, "opc.tcp://h/plantscada", [*first, *(f"ns=3;s=Site.V{n}" for n in range(500))]) is True  # cut at 200
    assert looks_like_plant_scada(None, "opc.tcp://h/plantscada", [*first[:159], *(f"ns=3;s=Site.W{n}" for n in range(41))]) is False


# ---- compare_stable against the shape server ----------------------------------------------------------------------------------

@contextlib.asynccontextmanager
async def scada(**settings):
    sim = ScadaSim(ScadaConfig(**settings), free_port())
    await sim.start()
    try:
        yield sim
    finally:
        await sim.stop()


def connector(sim: ScadaSim, **extra):
    return create_connector("opcua", {"endpoint": sim.endpoint.replace("0.0.0.0", "127.0.0.1"), "timeout_seconds": 5, **extra})


async def first_ten(sim: ScadaSim, c) -> tuple[list[str], list[str]]:
    """The tags and the numbered ids a first browse shows for the first ten tags."""
    by_name = {p.name: p.address for p in await c.browse()}
    tags = sim.tags[:10]
    return tags, [by_name[tag] for tag in tags]


async def test_a_fresh_server_reads_the_same_both_ways_in_one_request():
    async with scada(pdus=2) as sim:
        c = connector(sim)
        _tags, numbered = await first_ten(sim, c)
        sim.counters.reset()
        result = await c.compare_stable(numbered)
        assert result.message == SAME and (result.total, result.same) == (10, 10)
        assert not result.doubts_the_option
        assert sim.counters.read_sizes == [20] and sim.counters.limit_reads == 1  # ONE Value Read of both forms, in one session


async def test_the_comparison_ignores_the_option_it_reads_the_numbered_form_as_stored():
    async with scada(pdus=2) as sim:
        _tags, numbered = await first_ten(sim, connector(sim))
        on = connector(sim, stable_addresses=True)
        sim.restructure("bad")  # every old number is dead: with the option on, a plain read would never notice
        assert (await on.compare_stable(numbered)).message == DEAD


async def test_a_renumbered_server_says_the_numbered_address_no_longer_works():
    async with scada(pdus=2) as sim:
        c = connector(sim)
        _tags, numbered = await first_ten(sim, c)
        sim.restructure("bad")
        result = await c.compare_stable(numbered)
        assert result.message == DEAD and (result.numbered_dead, result.same) == (10, 0)
        assert not result.doubts_the_option  # the stable form works: nothing speaks against the option


async def test_a_server_that_answers_an_old_number_with_another_tag_says_the_values_differ():
    async with scada(pdus=2) as sim:
        c = connector(sim)
        tags, numbered = await first_ten(sim, c)
        sim.restructure("by_index")
        holders = sim.extra_tags + sim.tags  # the tag that holds the number of tag i now
        result = await c.compare_stable(numbered)
        assert result.message == (
            "the numbered and the stable address read different values for 10 of 10 tags: do not use the option "
            f"(e.g. {tags[0]}: {sim.value_of(holders[0]):.10g} and {sim.value_of(tags[0]):.10g})"
        )
        assert result.different == 10 and result.doubts_the_option
        assert holders[0] != tags[0]


async def test_a_tag_list_with_only_some_numbered_addresses_reads_only_those():
    async with scada(pdus=2) as sim:
        c = connector(sim)
        _tags, numbered = await first_ten(sim, c)
        sim.counters.reset()
        result = await c.compare_stable([*numbered[:3], sim.stable_id(sim.tags[5]), "ns=2;i=5", numbered[0]])  # stable, plain, repeated
        assert result.message == "3 of 3 tags read the same both ways" and result.total == 3
        assert sim.counters.read_sizes == [6]


async def test_one_tag_reads_the_singular():
    async with scada(pdus=2) as sim:
        c = connector(sim)
        _tags, numbered = await first_ten(sim, c)
        assert (await c.compare_stable(numbered[:1])).message == "1 of 1 tag read the same both ways"


async def test_nothing_numbered_sends_no_request_and_says_nothing():
    async with scada(pdus=2) as sim:
        c = connector(sim)
        sim.counters.reset()
        assert (await c.compare_stable([])) == StableComparison("", 0)
        assert (await c.compare_stable(["ns=2;i=1", sim.stable_id(sim.tags[0])])).message == ""
        assert sim.counters.read_sizes == [] and sim.counters.limit_reads == 0


# ---- compare_stable against a fake session ------------------------------------------------------------------------------------

def good(value):
    return ua.DataValue(ua.Variant(value, ua.VariantType.Double), StatusCode_=ua.StatusCode(ua.StatusCodes.Good))


class _Node:
    def __init__(self, address):
        self.address = address


class FakeSession:
    """`values` is keyed by the exact node id string asked for; anything else is BadNodeIdUnknown. `requests` are the Reads of tags."""

    def __init__(self, values):
        self.values = values
        self.requests: list[list[str]] = []

    def get_node(self, address):
        return _Node(address)

    async def read_attributes(self, nodes, attr):
        addresses = [n.address for n in nodes]
        if addresses == [LIMIT_NODE]:
            return [good(0)]
        self.requests.append(addresses)
        return [good(self.values[a]) if a in self.values else BAD_UNKNOWN for a in addresses]


def patch_session(monkeypatch, values) -> FakeSession:
    fake = FakeSession(values)

    @asynccontextmanager
    async def fake_session(self):
        yield fake

    monkeypatch.setattr(OpcUaConnector, "_session", fake_session)
    return fake


ENDPOINT = "opc.tcp://127.0.0.1:1/"


def fake_connector(**extra):
    return create_connector("opcua", {"endpoint": ENDPOINT, **extra})


async def test_a_server_that_does_not_know_the_stable_form_says_so_and_the_advice_follows_the_option(monkeypatch):
    patch_session(monkeypatch, {address: float(n) for n, address in enumerate(NUMBERED)})  # only the numbered ids exist
    off = await fake_connector().compare_stable(NUMBERED)
    on = await fake_connector(stable_addresses=True).compare_stable(NUMBERED)
    assert off.message == UNKNOWN_OFF and on.message == UNKNOWN_ON
    assert off.doubts_the_option and (off.stable_unknown, off.numbered_dead) == (10, 0)


async def test_the_most_severe_finding_is_the_one_sentence_different_values_then_unknown_then_dead(monkeypatch):
    values = {}
    for n, address in enumerate(NUMBERED):
        values[address] = float(n)
        if n < 2:
            values[stable_address(address)] = float(n) + 0.5  # two tags read different values
        elif n < 5:
            pass  # three tags: the stable form is unknown
        elif n < 8:
            del values[address]
            values[stable_address(address)] = float(n)  # three tags: the numbered form is dead
        else:
            values[stable_address(address)] = float(n)  # two tags: the same
    patch_session(monkeypatch, values)
    c = fake_connector()
    assert (await c.compare_stable(NUMBERED)).message == (
        "the numbered and the stable address read different values for 2 of 10 tags: do not use the option (e.g. TAG0: 0 and 0.5)"
    )
    assert (await c.compare_stable(NUMBERED[2:])).message == (
        "the stable address is unknown to this server for 3 of 8 tags: do not turn the option on"
    )
    assert (await c.compare_stable(NUMBERED[5:])).message == (
        "the numbered address no longer works for 3 of 5 tags but the stable one does: the SCADA numbering may have changed"
    )
    assert (await c.compare_stable(NUMBERED[8:])).message == "2 of 2 tags read the same both ways"


async def test_values_are_compared_as_numbers_and_printed_with_ten_digits(monkeypatch):
    numbered = NUMBERED[0]
    patch_session(monkeypatch, {numbered: 44.9, stable_address(numbered): 61.2})
    result = await fake_connector().compare_stable([numbered])
    assert result.message.endswith("(e.g. TAG0: 44.9 and 61.2)")
    # a kWh counter: two readings that differ in the sixth digit must not print alike (:g would give 3.1165e+06 for both)
    patch_session(monkeypatch, {numbered: 3116496.25, stable_address(numbered): 3116497.5})
    assert (await fake_connector().compare_stable([numbered])).message.endswith("(e.g. TAG0: 3116496.25 and 3116497.5)")
    patch_session(monkeypatch, {numbered: 3116496.25, stable_address(numbered): 3116496.25})
    assert (await fake_connector().compare_stable([numbered])).message == "1 of 1 tag read the same both ways"


async def test_a_tag_that_is_bad_both_ways_counts_only_in_the_total(monkeypatch):
    patch_session(monkeypatch, {NUMBERED[0]: 1.0, stable_address(NUMBERED[0]): 1.0})  # TAG1 and TAG2: Bad both ways
    result = await fake_connector().compare_stable(NUMBERED[:3])
    assert result.message == "1 of 3 tags read the same both ways" and result.total == 3
    nothing = await fake_connector().compare_stable(NUMBERED[1:3])
    assert nothing.message == "" and nothing.total == 2  # nothing comparable: nothing to say


async def test_the_reads_go_in_the_slices_of_the_poll(monkeypatch):
    many = [f"ns=3;s={20000 + n}:Site.T{n}" for n in range(30)]
    fake = patch_session(monkeypatch, {})
    connector_ = fake_connector()
    connector_._slice = 12  # what the poll would have learnt; the comparison shares the slicing helper
    await connector_.compare_stable(many)
    assert [len(request) for request in fake.requests] == [12, 12, 12, 12, 12]  # 60 nodes in slices of 12
    assert [node for request in fake.requests for node in request] == [*many, *(stable_address(a) for a in many)]  # numbered, then stable


# ---- the hints ----------------------------------------------------------------------------------------------------------------

def test_the_second_hint_is_a_line_of_its_own_and_the_generic_one_stays():
    kinds = [("BadNodeIdUnknown", NUMBERED[0]), ("BadSensorFailure", "ns=2;i=1")]
    generic = _read_hints(kinds)
    assert generic == "\n".join(
        [f"BadNodeIdUnknown: {hint_for('BadNodeIdUnknown', None, 'read_points')}",
         f"BadSensorFailure: {hint_for('BadSensorFailure', None, 'read_points')}"]
    )
    both = _read_hints(kinds, numbering_changed=True).split("\n")
    unknown, sensor = generic.split("\n")
    assert both == [unknown, f"BadNodeIdUnknown: {NUMBERING_CHANGED}", sensor]  # the second hint follows the generic one of its status
    assert len(both[1]) <= 280
    assert "a community answer" in NUMBERING_CHANGED and "not tested against your SCADA" in NUMBERING_CHANGED
    assert _read_hints([("BadSensorFailure", "ns=2;i=1")], numbering_changed=True) == _read_hints([("BadSensorFailure", "ns=2;i=1")])


async def read_points_hint(sim: ScadaSim, addresses: list[str], **extra) -> list[str]:
    result = await connector(sim, **extra).check(addresses)
    step = next(step for step in result.steps if step.id == "read_points")
    return (step.hint or "").split("\n")


async def test_the_check_adds_the_hint_only_for_numbered_bad_addresses_while_the_option_is_off():
    async with scada(pdus=2) as sim:
        _tags, numbered = await first_ten(sim, connector(sim))
        sim.restructure("bad")
        generic = f"BadNodeIdUnknown: {hint_for('BadNodeIdUnknown', None, 'read_points')}"
        assert await read_points_hint(sim, numbered) == [generic, f"BadNodeIdUnknown: {NUMBERING_CHANGED}"]
        assert await read_points_hint(sim, ["ns=3;s=Nowhere.Tag", "ns=3;s=Nowhere.Other"]) == [generic]  # not numbered


async def test_with_the_option_on_the_old_numbers_are_not_the_reason_so_no_hint_to_try_the_option():
    async with scada(pdus=2) as sim:
        _tags, numbered = await first_ten(sim, connector(sim))
        sim.restructure("bad")
        # the option on reads the stable form, which exists: the rows are good, so there is no BadNodeIdUnknown and no hint at all
        assert await read_points_hint(sim, numbered, stable_addresses=True) == [""]
        # a numbered address of a tag that no longer exists: Bad even by its stable form, and the option is already on
        gone = "ns=3;s=20999:Site.NoSuchTag"
        generic = f"BadNodeIdUnknown: {hint_for('BadNodeIdUnknown', None, 'read_points')}"
        assert await read_points_hint(sim, [gone], stable_addresses=True) == [generic]
        assert await read_points_hint(sim, [gone]) == [generic, f"BadNodeIdUnknown: {NUMBERING_CHANGED}"]


# ---- the check: the comparison with the option on, the suggestion with it off (R6, R7) ----------------------------------------------

GENERIC_UNKNOWN = f"BadNodeIdUnknown: {hint_for('BadNodeIdUnknown', None, 'read_points')}"


async def numbered_of(sim: ScadaSim, count: int) -> tuple[list[str], list[str]]:
    by_name = {p.name: p.address for p in await connector(sim).browse()}
    return sim.tags[:count], [by_name[tag] for tag in sim.tags[:count]]


async def read_points_step(sim: ScadaSim, addresses: list[str], **extra):
    result = await connector(sim, **extra).check(addresses)
    assert result.ok, [(s.id, s.error) for s in result.steps]
    return next(step for step in result.steps if step.id == "read_points")


def spy_value_reads(monkeypatch) -> list[list[str]]:
    """The node ids of every Value Read the client sends, in order."""
    reads: list[list[str]] = []
    original = Client.read_attributes

    async def wrapper(self, nodes, attr=ua.AttributeIds.Value):
        nodes = list(nodes)
        if attr == ua.AttributeIds.Value:
            reads.append([node.nodeid.to_string() for node in nodes])
        return await original(self, nodes, attr)

    monkeypatch.setattr(Client, "read_attributes", wrapper)
    return reads


def spy_comparisons(monkeypatch, answer: StableComparison | Exception | None = None) -> list[tuple[list[str], object]]:
    """Replaces `compare_stable`: records (addresses, client) and answers `answer` (raises it when it is an exception); with no
    answer the real one runs."""
    calls: list[tuple[list[str], object]] = []
    original = OpcUaConnector.compare_stable

    async def fake(self, addresses, client=None):
        calls.append((list(addresses), client))
        if isinstance(answer, Exception):
            raise answer
        return answer if answer is not None else await original(self, addresses, client)

    monkeypatch.setattr(OpcUaConnector, "compare_stable", fake)
    return calls


async def test_with_the_option_on_the_check_puts_the_comparison_in_the_detail_and_the_summary_stays():
    async with scada(pdus=2) as sim:
        _tags, numbered = await numbered_of(sim, 10)
        off = await read_points_step(sim, numbered)
        on = await read_points_step(sim, numbered, stable_addresses=True)
        assert on.summary == off.summary and "stable" not in on.summary
        assert on.detail["requests"] == off.detail["requests"] == 3  # the extra Read is not counted: the summary does not change
        assert on.detail["stable_comparison"] == SAME and on.hint is None
        assert "stable_comparison" not in off.detail


async def test_the_extra_read_is_one_request_of_both_forms_in_the_session_the_check_already_has(monkeypatch):
    async with scada(pdus=2) as sim:
        _tags, numbered = await numbered_of(sim, 10)
        reads = spy_value_reads(monkeypatch)
        sessions: list[int] = []
        opened = OpcUaConnector._session
        monkeypatch.setattr(OpcUaConnector, "_session", lambda self: (sessions.append(1), opened(self))[1])
        await read_points_step(sim, numbered, stable_addresses=True)
        stable = [stable_address(address) for address in numbered]
        assert [read for read in reads if len(read) == 20] == [[*numbered, *stable]]  # both forms at ONE instant: a live tag cannot tick between
        assert stable in reads  # the read of the step itself sent the stable form
        assert sessions == []  # no session of its own


async def test_the_comparison_takes_at_most_ten_numbered_addresses_of_the_ones_that_were_read(monkeypatch):
    async with scada(pdus=2) as sim:
        _tags, numbered = await numbered_of(sim, 13)
        plain = sim.stable_id(sim.tags[20])
        calls = spy_comparisons(monkeypatch)
        step = await read_points_step(sim, [plain, *numbered], stable_addresses=True)
        assert [addresses for addresses, _client in calls] == [numbered[:10]]  # the plain one is not numbered; the 11th numbered is left out
        assert step.detail["stable_comparison"] == SAME  # "10 of 10 tags"


async def test_a_pair_of_stored_strings_for_one_tag_is_not_compared_it_was_not_read(monkeypatch):
    async with scada(pdus=2) as sim:
        _tags, numbered = await numbered_of(sim, 4)
        twin = re.sub(r";s=\d+:", ";s=99999:", numbered[0])  # the same tag under another number
        assert twin != numbered[0] and stable_address(twin) == stable_address(numbered[0])
        calls = spy_comparisons(monkeypatch)
        step = await read_points_step(sim, [numbered[0], twin, *numbered[1:]], stable_addresses=True)
        assert [addresses for addresses, _client in calls] == [numbered[1:]]
        assert step.detail["bad"] == 2 and step.detail["stable_comparison"] == "3 of 3 tags read the same both ways"


async def test_a_server_that_answers_an_old_number_with_another_tag_is_a_finding_in_the_detail_and_a_hint_line():
    async with scada(pdus=2) as sim:
        tags, numbered = await numbered_of(sim, 10)
        sim.restructure("by_index")
        holders = sim.extra_tags + sim.tags
        step = await read_points_step(sim, numbered, stable_addresses=True)
        finding = (
            "the numbered and the stable address read different values for 10 of 10 tags: do not use the option "
            f"(e.g. {tags[0]}: {sim.value_of(holders[0]):.10g} and {sim.value_of(tags[0]):.10g})"
        )
        assert step.detail["stable_comparison"] == finding
        assert step.hint == finding  # a line of its own, no status name in front
        assert step.summary.endswith("10 good, 0 bad")  # the stable form reads fine: the summary says nothing new


async def test_numbers_that_no_longer_work_are_good_news_for_the_option_so_detail_only_and_no_hint():
    async with scada(pdus=2) as sim:
        _tags, numbered = await numbered_of(sim, 10)
        sim.restructure("bad")
        step = await read_points_step(sim, numbered, stable_addresses=True)
        assert step.detail["stable_comparison"] == DEAD and step.hint is None


async def test_an_unknown_stable_address_is_a_hint_line_after_the_status_hints(monkeypatch):
    async with scada(pdus=2) as sim:
        _tags, numbered = await numbered_of(sim, 3)
        gone = "ns=3;s=20999:Site.NoSuchTag"
        spy_comparisons(monkeypatch, StableComparison(UNKNOWN_ON, 3, stable_unknown=3))
        step = await read_points_step(sim, [*numbered, gone], stable_addresses=True)
        assert step.detail["stable_comparison"] == UNKNOWN_ON
        assert step.hint.split("\n") == [GENERIC_UNKNOWN, UNKNOWN_ON]  # the option is on: no "try the option" hint beside them


async def test_an_empty_comparison_adds_nothing(monkeypatch):
    async with scada(pdus=2) as sim:
        _tags, numbered = await numbered_of(sim, 3)
        spy_comparisons(monkeypatch, StableComparison("", 3))  # both forms Bad for every tag
        step = await read_points_step(sim, numbered, stable_addresses=True)
        assert "stable_comparison" not in step.detail and step.hint is None


@pytest.mark.parametrize("failure", [ua.UaStatusCodeError(ua.StatusCodes.BadTooManyOperations), RuntimeError("odd"), TimeoutError()])
async def test_a_comparison_that_fails_leaves_the_step_as_it_was(monkeypatch, failure):
    async with scada(pdus=2) as sim:
        _tags, numbered = await numbered_of(sim, 3)
        plain = await read_points_step(sim, numbered, stable_addresses=True)
        spy_comparisons(monkeypatch, failure)
        step = await read_points_step(sim, numbered, stable_addresses=True)
        assert step.summary == plain.summary and step.hint is None
        assert {key: value for key, value in step.detail.items() if key != "stable_comparison"} == {
            key: value for key, value in plain.detail.items() if key != "stable_comparison"
        }
        assert "stable_comparison" not in step.detail


async def test_nothing_numbered_or_the_option_off_means_no_comparison_and_no_extra_read(monkeypatch):
    async with scada(pdus=2) as sim:
        _tags, numbered = await numbered_of(sim, 10)
        plain = [sim.stable_id(tag) for tag in sim.tags[:5]]
        calls = spy_comparisons(monkeypatch)
        reads = spy_value_reads(monkeypatch)
        on = await read_points_step(sim, plain, stable_addresses=True)
        off = await read_points_step(sim, numbered)
        assert calls == [] and "stable_comparison" not in on.detail and "stable_comparison" not in off.detail
        assert [read for read in reads if len(read) == 20] == []  # the option off: the reads of the check are what they were


async def test_the_suggestion_is_a_hint_line_while_the_option_is_off_and_the_source_looks_like_plant_scada():
    async with scada(pdus=2) as sim:  # its endpoint path is /plantscada
        _tags, numbered = await numbered_of(sim, 10)
        assert (await read_points_step(sim, numbered)).hint == SUGGEST_STABLE  # a line of its own
        assert (await read_points_step(sim, numbered, stable_addresses=True)).hint is None  # the option is on already
        mixed = [*numbered[:3], *(sim.stable_id(tag) for tag in sim.tags[10:17])]  # 3 of 10 numbered: not Plant SCADA's numbering
        assert (await read_points_step(sim, mixed)).hint is None
        sim.restructure("by_index")  # the numbered ids now read other tags, silently: the check cannot know without the extra Read
        step = await read_points_step(sim, numbered)
        assert step.hint == SUGGEST_STABLE and "stable_comparison" not in step.detail


async def test_the_suggestion_makes_way_for_the_numbering_hint_which_already_says_it():
    async with scada(pdus=2) as sim:
        _tags, numbered = await numbered_of(sim, 10)
        sim.restructure("bad")
        step = await read_points_step(sim, numbered)
        assert step.hint.split("\n") == [GENERIC_UNKNOWN, f"BadNodeIdUnknown: {NUMBERING_CHANGED}"]  # not the suggestion as well


def test_extra_hint_lines_follow_the_status_hints_as_lines_of_their_own():
    kinds = [("BadNodeIdUnknown", NUMBERED[0])]
    generic = _read_hints(kinds)
    assert _read_hints(kinds, notes=["a note"]) == f"{generic}\na note"
    assert _read_hints([], notes=["a note", "another"]) == "a note\nanother"
    assert _read_hints([]) is None and _read_hints([], notes=[]) is None


# ---- the Test job -------------------------------------------------------------------------------------------------------------

class Stand(OpcUaConnector):
    """The OPC UA connector without a server: Test answers ok, `compare_stable` answers as told and records what it was asked."""

    comparison: StableComparison | None = StableComparison("10 of 10 tags read the same both ways", 10, same=10)
    compare_raises: Exception | None = None
    identity_answer: dict | None = None
    asked: list[list[str]] = []

    async def test(self):
        return ConnectionCheck(True, "ok", 12.0)

    async def identity(self):
        return self.identity_answer

    async def compare_stable(self, addresses):
        self.asked.append(list(addresses))
        if self.compare_raises is not None:
            raise self.compare_raises
        return self.comparison

    async def close(self):
        pass


def stand_factory(**attributes):
    kind = type("ConfiguredStand", (Stand,), {"asked": [], **attributes})
    made: list[Stand] = []

    def factory(type_name, config, secret):
        made.append(kind(kind.config_schema(**config), secret))
        return made[-1]

    return factory, kind


async def run_test(db, source, **attributes):
    factory, kind = stand_factory(**attributes)
    job_id = await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('test_source', $1) RETURNING id", {"source_id": source})
    await run_pending_jobs(db, factory)
    row = await db.fetchrow("SELECT status, result FROM jobs WHERE id = $1", job_id)
    assert row["status"] == "done"
    return row["result"], kind.asked


_names = itertools.count(1)


async def opcua_source(db, addresses, *, endpoint="opc.tcp://10.0.0.5:4840/plantscada", mapped=(), **config):
    source = await make_source(db, f"scada {next(_names)}", "opcua", {"endpoint": endpoint, **config})
    ids = {address: await make_point(db, source, address) for address in addresses}
    for address in mapped:
        await make_mapping(db, ids[address], await make_asset(db, f"asset {address}"))
    return source


async def test_a_plain_source_has_exactly_todays_test_result(db):
    source = await opcua_source(db, PLAIN, endpoint="opc.tcp://10.0.0.5:4840/")
    result, asked = await run_test(db, source)
    assert result == {"ok": True, "status": "ok", "latency_ms": 12.0, "message": ""}
    assert asked == []  # nothing numbered: the server is not asked


async def test_a_source_that_is_not_opc_ua_never_compares(db):
    """The connector has `compare_stable`, but the source row says it is a simulator: the job must not call it."""
    source = await make_source(db, "sim", "simulator", {"url": "http://localhost:9"})
    await make_point(db, source, NUMBERED[0])
    asked: list = []

    class Guard(Stand):
        async def compare_stable(self, addresses):
            asked.append(addresses)
            return StableComparison("never", 1)

    job_id = await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('test_source', $1) RETURNING id", {"source_id": source})
    await run_pending_jobs(db, lambda type_name, config, secret: Guard(OpcUaConfig(endpoint=ENDPOINT), secret))
    assert (await db.fetchval("SELECT result FROM jobs WHERE id = $1", job_id))["message"] == "" and asked == []


async def test_the_comparison_and_the_suggestion_are_added_for_a_source_that_looks_like_plant_scada(db):
    source = await opcua_source(db, NUMBERED)
    result, asked = await run_test(db, source)
    assert result["message"] == f"{SAME}. {SUGGEST_STABLE}"
    assert asked == [NUMBERED] and result["ok"] is True and result["latency_ms"] == 12.0
    assert SUGGEST_STABLE == (
        "This server looks like AVEVA Plant SCADA and its tag addresses carry a number that can change (a community answer says so, "
        'not tested against your SCADA). Consider "Stable tag addresses" (Edit source).'
    )
    assert await db.fetchval("SELECT config FROM sources WHERE id = $1", source) == {"endpoint": "opc.tcp://10.0.0.5:4840/plantscada"}


async def test_the_suggestion_follows_what_the_server_announces_when_the_path_does_not_say(db):
    source = await opcua_source(db, NUMBERED, endpoint="opc.tcp://10.0.0.5:4840/")
    result, _asked = await run_test(db, source, comparison=StableComparison("", 10))
    assert result["message"] == ""  # the path says nothing and the server announces nothing
    # the identity is re-read after the Test learned it: the connector announces who it is, the job stores it, and the suggestion appears
    result, _asked = await run_test(db, source, comparison=StableComparison("", 10), identity_answer={"application_name": "AVEVA Plant SCADA OPC UA Server"})
    assert result["message"] == SUGGEST_STABLE


async def test_no_suggestion_with_the_option_on_or_when_the_comparison_speaks_against_it(db):
    on = await opcua_source(db, NUMBERED, stable_addresses=True)
    result, _asked = await run_test(db, on)
    assert result["message"] == SAME  # the comparison runs with the option on; the suggestion does not
    against = await opcua_source(db, NUMBERED)
    different = StableComparison("the numbered and the stable address read different values for 2 of 10 tags: do not use the option (e.g. T: 1 and 2)", 10, different=2, same=8)
    result, _asked = await run_test(db, against, comparison=different)
    assert result["message"] == different.message
    unknown = StableComparison(UNKNOWN_OFF, 10, stable_unknown=10)
    result, _asked = await run_test(db, against, comparison=unknown)
    assert result["message"] == UNKNOWN_OFF
    dead = StableComparison(DEAD, 10, numbered_dead=10)
    result, _asked = await run_test(db, against, comparison=dead)
    assert result["message"] == f"{DEAD}. {SUGGEST_STABLE}"  # the stable form works: the suggestion stands


async def test_the_comparison_takes_ten_numbered_addresses_mapped_first_then_by_id_and_the_ids_of_other_kinds_do_not_dilute(db):
    numbered = [f"ns=3;s={20000 + n}:Site.TAG{n}" for n in range(14)]
    addresses = [*PLAIN, *numbered, "ns=3;s=Site.STABLE"]
    source = await opcua_source(db, addresses, mapped=(numbered[12], numbered[3]))
    result, asked = await run_test(db, source)
    assert asked == [[numbered[3], numbered[12], numbered[0], numbered[1], numbered[2], *numbered[4:9]]]  # mapped by id, then by id
    assert result["message"] == f"{SAME}. {SUGGEST_STABLE}"  # 14 of 15 string ids numbered; the 10 `i=` ids do not count


async def test_a_failing_or_slow_comparison_adds_nothing_and_never_fails_the_test(db, monkeypatch):
    from dcdash.collector import jobs as jobs_module

    source = await opcua_source(db, NUMBERED)
    result, _asked = await run_test(db, source, compare_raises=RuntimeError("the server said something odd"))
    assert result["ok"] is True and result["message"] == ""
    monkeypatch.setattr(jobs_module, "COMPARE_SECONDS", 0.05)

    async def slow(self, addresses):
        import asyncio

        await asyncio.sleep(5)

    result, _asked = await run_test(db, source, compare_stable=slow)
    assert result["ok"] is True and result["message"] == ""
    assert await db.fetchval("SELECT status FROM sources WHERE id = $1", source) == "online"


async def test_the_job_against_the_shape_server_says_what_it_sees(db):
    async with scada(pdus=2) as sim:
        c = connector(sim)
        by_name = {p.name: p.address for p in await c.browse()}
        addresses = [by_name[tag] for tag in sim.tags[:12]]
        source = await opcua_source(db, addresses, endpoint=sim.endpoint.replace("0.0.0.0", "127.0.0.1"), mapped=(addresses[5],))

        async def test_it():
            job_id = await db.fetchval("INSERT INTO jobs (kind, params) VALUES ('test_source', $1) RETURNING id", {"source_id": source})
            await run_pending_jobs(db, create_connector)
            return (await db.fetchval("SELECT result FROM jobs WHERE id = $1", job_id))["message"]

        assert await test_it() == f"{SAME}. {SUGGEST_STABLE}"  # the path of the shape server is /plantscada
        sim.restructure("bad")
        assert await test_it() == f"{DEAD}. {SUGGEST_STABLE}"
        sim.restructure("by_index")
        message = await test_it()
        assert message.startswith("the numbered and the stable address read different values for 10 of 10 tags: do not use the option (e.g. ")
        assert "Consider" not in message
