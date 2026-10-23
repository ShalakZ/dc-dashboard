"""The level-by-level OPC UA browse (w34 R10, D7, plan Task 10): the same answer as the walker it replaced, in far fewer requests.

`_reference_browse` is that walker as it was before w34 (one question per node, a copy of the old `OpcUaConnector._walk`). Every
test that matters runs both over the same server and compares what comes back, in discovery order, or compares how they fail.
Most tests use a fake session with scripted pages and Bad statuses (the shape server cannot answer BrowseNext); the others run
both walkers against real asyncua servers: the default simulator, a server full of equal names and shared nodes, the shape server."""

import asyncio
import contextlib
import math
from collections.abc import Awaitable
from typing import Any

import pytest
from asyncua import Client, Node, Server, ua

from dcdash.connectors.base import PointDescriptor, create_connector
from dcdash.connectors.opcua_browse import BATCH, browse_tree
from dcdash.simulator.scada import ScadaConfig, ScadaSim
from tests.helpers import free_port, opcua_server

OBJECTS = ua.NodeId(ua.ObjectIds.ObjectsFolder)
GOOD = ua.StatusCode(ua.StatusCodes.Good)
BAD = ua.StatusCode(ua.StatusCodes.BadNodeIdUnknown)
HAS_PROPERTY = ua.NodeId(ua.ObjectIds.HasProperty)
OBJECT, VARIABLE, METHOD = ua.NodeClass.Object, ua.NodeClass.Variable, ua.NodeClass.Method
DISPLAY, BROWSE_NAME, VALUE = ua.AttributeIds.DisplayName, ua.AttributeIds.BrowseName, ua.AttributeIds.Value


# -- the walker as it was --------------------------------------------------------------------------------------------------------
async def _reference_unit(var: Node) -> str | None:
    for prop in await var.get_properties():
        if (await prop.read_browse_name()).Name == "EngineeringUnits":
            eu = await prop.read_value()
            text = getattr(getattr(eu, "DisplayName", None), "Text", None)
            return text or None
    return None


async def _reference_browse(client: Any, root_node: str = "i=85") -> list[PointDescriptor]:
    """`OpcUaConnector._walk` before w34 (discovery order; the connector sorted it by name afterwards)."""
    found: list[PointDescriptor] = []
    root = client.get_node(root_node)
    skip_standard = root.nodeid == OBJECTS
    stack: list[Node] = [root]
    seen: set[str] = set()
    while stack:
        node = stack.pop()
        for child in await node.get_children(refs=ua.ObjectIds.HierarchicalReferences):
            key = child.nodeid.to_string()
            if key in seen or (skip_standard and child.nodeid.NamespaceIndex == 0):
                continue
            seen.add(key)
            node_class = await child.read_node_class()
            if node_class == ua.NodeClass.Variable:
                name = (await child.read_display_name()).Text or key
                found.append(PointDescriptor(address=key, name=name, unit_hint=await _reference_unit(child)))
            elif node_class == ua.NodeClass.Object:
                stack.append(child)
    return found


async def _new_browse(client: Any, root_node: str = "i=85") -> list[PointDescriptor]:
    root = client.get_node(root_node).nodeid
    return await browse_tree(client, root, root == OBJECTS)


async def _outcome(call: Awaitable[list[PointDescriptor]]) -> Any:
    """The list a walker returns, or the exception it raises (type and status code), so two walkers can be compared either way."""
    try:
        return await call
    except Exception as exc:  # noqa: BLE001 - the point is to compare failures
        return ("raised", type(exc).__name__, getattr(exc, "code", None))


async def _same_answer(client: Any, root_node: str = "i=85") -> list[PointDescriptor]:
    old = await _outcome(_reference_browse(client, root_node))
    new = await _outcome(_new_browse(client, root_node))
    assert new == old
    return new


# -- a fake session --------------------------------------------------------------------------------------------------------------
def _expanded(key: str) -> ua.ExpandedNodeId:
    node = ua.NodeId.from_string(key)
    return ua.ExpandedNodeId(node.Identifier, node.NamespaceIndex, node.NodeIdType)


class FakeUa:
    """What `client.uaclient` (the new walker) and `Node.session` (the old one) need: browse, browse_next and read. A scripted address
    space: classes, DisplayNames, BrowseNames, values, hierarchical children and HasProperty children, plus the ways a server
    misbehaves (pages with ContinuationPoints, a Bad status for a node or a request, a limit on nodes per request)."""

    def __init__(self, page: int | None = None, refuse_over: int | None = None) -> None:
        self.cls: dict[str, ua.NodeClass] = {}
        self.display: dict[str, str] = {}
        self.bname: dict[str, str] = {}
        self.value: dict[str, Any] = {}
        self.children: dict[str, list[str]] = {}
        self.props: dict[str, list[str]] = {}
        self.bad_browse: set[str] = set()
        self.bad_read: set[tuple[str, ua.AttributeIds]] = set()
        self.page = page
        self.refuse_over = refuse_over
        self.drop_last_browse_result = False
        self.next_error: Exception | None = None
        self.gate: asyncio.Event | None = None  # when set, a BrowseNext waits on it
        self.in_next = asyncio.Event()
        self.points: dict[bytes, list[ua.ReferenceDescription]] = {}
        self.handed: list[bytes] = []
        self.released: list[list[bytes]] = []
        self.next_sizes: list[int] = []
        self.browse_sizes: list[int] = []
        self.read_sizes: list[int] = []
        self.read_log: list[tuple[int, str]] = []
        self._count = 0

    # building
    def add(self, parent: str, key: str, cls: ua.NodeClass, display: str | None = None) -> str:
        self.cls[key], self.display[key] = cls, key if display is None else display
        self.bname[key] = key.rpartition("=")[2]
        self.children.setdefault(parent, []).append(key)
        return key

    def link(self, parent: str, key: str) -> None:
        self.children.setdefault(parent, []).append(key)  # a second parent lists a node that exists

    def var(self, parent: str, key: str, display: str | None = None, unit: str | None = None) -> str:
        self.add(parent, key, VARIABLE, display)
        self.value[key] = 1.0
        if unit is not None:
            self.prop(key, "EngineeringUnits", ua.EUInformation(DisplayName=ua.LocalizedText(unit)))
        return key

    def prop(self, owner: str, name: str, value: Any) -> str:
        key = f"{owner}/{name}"
        if key in self.cls:  # a second property of the same name is its own node
            key += f"#{len(self.props[owner])}"
        self.cls[key], self.display[key], self.bname[key], self.value[key] = VARIABLE, name, name, value
        self.props.setdefault(owner, []).append(key)
        return key

    def client(self) -> "FakeClient":
        return FakeClient(self)

    # the three services
    def _refuse(self, count: int) -> None:
        if self.refuse_over is not None and count > self.refuse_over:
            raise ua.UaStatusCodeError(ua.StatusCodes.BadTooManyOperations)

    def _reference(self, key: str) -> ua.ReferenceDescription:
        # the reference's own DisplayName and BrowseName are deliberately wrong: a walker must read the attributes
        return ua.ReferenceDescription(
            NodeId=_expanded(key), NodeClass_=self.cls[key], BrowseName=ua.QualifiedName("from the reference", 2),
            DisplayName=ua.LocalizedText("from the reference"),
        )

    def _page(self, refs: list[ua.ReferenceDescription]) -> ua.BrowseResult:
        if self.page and len(refs) > self.page:
            self._count += 1
            point = f"point-{self._count}".encode()
            self.points[point] = refs[self.page :]
            self.handed.append(point)
            return ua.BrowseResult(StatusCode_=GOOD, ContinuationPoint_=point, References=refs[: self.page])
        return ua.BrowseResult(StatusCode_=GOOD, References=refs)

    async def browse(self, params: ua.BrowseParameters) -> list[ua.BrowseResult]:
        self.browse_sizes.append(len(params.NodesToBrowse))
        self._refuse(len(params.NodesToBrowse))
        results = []
        for description in params.NodesToBrowse:
            key = description.NodeId.to_string()
            if key in self.bad_browse:
                results.append(ua.BrowseResult(StatusCode_=BAD))
                continue
            keys = self.props.get(key, []) if description.ReferenceTypeId == HAS_PROPERTY else self.children.get(key, [])
            if description.NodeClassMask:
                keys = [k for k in keys if int(self.cls[k]) & int(description.NodeClassMask)]
            results.append(self._page([self._reference(k) for k in keys]))
        return results[:-1] if self.drop_last_browse_result else results

    async def browse_next(self, params: ua.BrowseNextParameters) -> list[ua.BrowseResult]:
        points = list(params.ContinuationPoints)
        if params.ReleaseContinuationPoints:  # answers at once, even while the other BrowseNext waits
            self.released.append(points)
            for point in points:
                self.points.pop(point, None)
            return [ua.BrowseResult(StatusCode_=GOOD) for _ in points]
        self.next_sizes.append(len(points))
        self.in_next.set()
        if self.gate is not None:
            await self.gate.wait()
        if self.next_error is not None:
            raise self.next_error
        return [self._page(self.points.pop(point)) for point in points]

    async def read(self, params: ua.ReadParameters) -> list[ua.DataValue]:
        self.read_sizes.append(len(params.NodesToRead))
        self._refuse(len(params.NodesToRead))
        answers = []
        for item in params.NodesToRead:
            key, attribute = item.NodeId.to_string(), ua.AttributeIds(item.AttributeId)
            self.read_log.append((int(attribute), key))
            if (key, attribute) in self.bad_read or key not in self.cls:
                answers.append(ua.DataValue(StatusCode_=BAD))
            elif attribute == DISPLAY:
                answers.append(ua.DataValue(ua.Variant(ua.LocalizedText(self.display[key]), ua.VariantType.LocalizedText), StatusCode_=GOOD))
            elif attribute == BROWSE_NAME:
                answers.append(ua.DataValue(ua.Variant(ua.QualifiedName(self.bname[key], 2), ua.VariantType.QualifiedName), StatusCode_=GOOD))
            elif attribute == ua.AttributeIds.NodeClass:
                answers.append(ua.DataValue(ua.Variant(int(self.cls[key]), ua.VariantType.Int32), StatusCode_=GOOD))
            elif isinstance(self.value.get(key), ua.EUInformation):
                answers.append(ua.DataValue(ua.Variant(self.value[key], ua.VariantType.ExtensionObject), StatusCode_=GOOD))
            else:
                answers.append(ua.DataValue(ua.Variant(self.value.get(key, 0.0), ua.VariantType.Double), StatusCode_=GOOD))
        return answers


class FakeClient:
    def __init__(self, fake: FakeUa) -> None:
        self.uaclient = fake

    def get_node(self, nodeid: str) -> Node:
        return Node(self.uaclient, ua.NodeId.from_string(nodeid))


def _model() -> FakeUa:
    """Objects > Site (A, B) with units, a name that is empty, a method, a node under two parents and a standard (ns 0) subtree."""
    fake = FakeUa()
    fake.add("i=85", "i=2253", OBJECT, "Server")  # the standard subtree (namespace 0), skipped under the Objects folder
    fake.var("i=2253", "i=2259", "ServerState")
    fake.add("i=85", "ns=2;s=Site", OBJECT)
    a = fake.add("ns=2;s=Site", "ns=2;s=A", OBJECT)
    b = fake.add("ns=2;s=Site", "ns=2;s=B", OBJECT)
    fake.var(a, "ns=2;s=A.kW", "Same", "kW")
    fake.var(a, "ns=2;s=A.kWh", "Same", "kWh")
    fake.var(a, "ns=2;s=A.pf", "PF")  # no unit
    fake.var(a, "ns=2;s=A.nameless", "", "V")  # an empty DisplayName: the node id is the name
    fake.var(a, "ns=2;s=A.shared", "Shared", "A")
    fake.add(a, "ns=2;s=A.method", METHOD)
    sub = fake.add(a, "ns=2;s=A.sub", OBJECT)
    fake.var(sub, "ns=2;s=A.sub.kW", "Same", "")  # a unit whose text is empty
    fake.var(b, "ns=2;s=B.kW", "Same", "kW")
    fake.link(b, "ns=2;s=A.shared")  # two parents
    fake.link(b, sub)  # a folder under two parents
    fake.var(b, "ns=2;s=B.odd", "Odd")
    fake.prop("ns=2;s=B.odd", "EngineeringUnits", 5.0)  # a unit that is not an EUInformation
    fake.var(b, "ns=2;s=B.late", "Late")
    fake.prop("ns=2;s=B.late", "Other", 1.0)
    fake.prop("ns=2;s=B.late", "EngineeringUnits", ua.EUInformation(DisplayName=ua.LocalizedText("Hz")))  # behind another property
    fake.prop("ns=2;s=B.late", "EngineeringUnits", ua.EUInformation(DisplayName=ua.LocalizedText("kHz")))  # a second one: ignored
    return fake


# -- the fake session: same answer as the old walker --------------------------------------------------------------------------------
async def test_the_fake_tree_gives_the_old_answer_in_the_old_order():
    fake = _model()
    answer = await _same_answer(fake.client())
    by_address = {d.address: d for d in answer}
    assert by_address["ns=2;s=A.nameless"].name == "ns=2;s=A.nameless"  # an empty DisplayName falls back to the node id
    assert by_address["ns=2;s=A.sub.kW"].unit_hint is None and by_address["ns=2;s=B.odd"].unit_hint is None
    assert by_address["ns=2;s=B.late"].unit_hint == "Hz"
    assert by_address["ns=2;s=A.pf"].unit_hint is None and by_address["ns=2;s=A.kW"].unit_hint == "kW"
    assert "i=2259" not in by_address  # the standard subtree
    assert not any("from the reference" in d.name for d in answer)  # names come from the DisplayName attribute
    assert sum(d.address == "ns=2;s=A.shared" for d in answer) == 1 and sum(d.address == "ns=2;s=A.sub.kW" for d in answer) == 1
    assert [d.name for d in answer].count("Same") == 4  # equal names stay in discovery order, as the old walker had them


async def test_the_walk_asks_for_the_attributes_of_the_reported_variables_only_and_each_once():
    fake = _model()
    fake.bad_read.add(("i=2259", DISPLAY))  # a Bad name on a node the old walker never read
    answer = await _new_browse(fake.client())
    reads = fake.read_log
    assert not any(key in ("i=2253", "i=2259") for _, key in reads)
    names = [key for attribute, key in reads if attribute == int(DISPLAY)]
    assert sorted(names) == sorted(d.address for d in answer) and len(names) == len(set(names))
    assert max(fake.read_sizes) <= BATCH and max(fake.browse_sizes) <= BATCH


async def test_a_root_that_is_not_the_objects_folder_keeps_the_standard_nodes_and_a_cycle_to_the_root_changes_nothing():
    fake = FakeUa()
    top = fake.add("i=84", "ns=2;s=Top", OBJECT)
    fake.var(top, "i=2259", "ServerState")
    sub = fake.add(top, "ns=2;s=Sub", OBJECT)
    fake.var(sub, "ns=2;s=Sub.v", "V", "kW")
    fake.link(sub, top)  # the root again, found as a child
    answer = await _same_answer(fake.client(), "ns=2;s=Top")
    assert sorted(d.address for d in answer) == ["i=2259", "ns=2;s=Sub.v"]


async def test_a_bad_status_for_one_parent_is_no_children_as_before():
    fake = _model()
    fake.bad_browse.add("ns=2;s=A.sub")
    answer = await _same_answer(fake.client())
    assert "ns=2;s=A.sub.kW" not in {d.address for d in answer} and "ns=2;s=A.kW" in {d.address for d in answer}


async def test_a_bad_property_list_is_no_unit_as_before():
    fake = _model()
    fake.bad_browse.add("ns=2;s=A.kW")  # the HasProperty browse of that variable (the same set answers the folder browse too)
    answer = await _same_answer(fake.client())
    assert {d.address: d.unit_hint for d in answer}["ns=2;s=A.kW"] is None


# -- failures are the old failures ---------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "bad",
    [
        ("ns=2;s=A.kWh", DISPLAY),  # a variable's DisplayName
        ("ns=2;s=A.kW/EngineeringUnits", BROWSE_NAME),  # the name of the first property
        ("ns=2;s=A.kW/EngineeringUnits", VALUE),  # the value of the units property
        ("ns=2;s=B.late/Other", BROWSE_NAME),  # a property in front of the units one
    ],
)
async def test_a_bad_read_raises_the_same_exception_as_the_old_walker(bad):
    fake = _model()
    fake.bad_read.add(bad)
    outcome = await _same_answer(fake.client())
    assert outcome[0] == "raised" and outcome[2] == ua.StatusCodes.BadNodeIdUnknown  # a UaStatusCodeError of the Bad status


@pytest.mark.parametrize("missing", [True, False], ids=["no variant", "null variant"])
async def test_a_good_read_without_a_value_raises_the_same_exception_as_the_old_walker(missing):
    class NoValue(FakeUa):
        async def read(self, params):
            answers = await super().read(params)
            for item, answer in zip(params.NodesToRead, answers, strict=True):
                if item.AttributeId == DISPLAY and item.NodeId.to_string() == "ns=2;s=A.pf":
                    object.__setattr__(answer, "Value", None if missing else ua.Variant())  # a DataValue is frozen
            return answers

    fake = _model()
    fake.__class__ = NoValue
    outcome = await _same_answer(fake.client())
    assert outcome[0] == "raised" and outcome[1] == ("UaInvalidParameterError" if missing else "AttributeError")


async def test_a_bad_name_after_the_units_property_is_not_an_error_in_either_walker():
    fake = _model()
    fake.bad_read.add(("ns=2;s=B.late/EngineeringUnits#2", BROWSE_NAME))  # the second EngineeringUnits: behind the first one
    answer = await _same_answer(fake.client())
    assert {d.address: d.unit_hint for d in answer}["ns=2;s=B.late"] == "Hz"


async def test_the_exception_is_the_one_the_old_walker_met_first():
    fake = _model()
    fake.bad_read.add(("ns=2;s=B.kW", DISPLAY))
    fake.bad_read.add(("ns=2;s=A.kW/EngineeringUnits", VALUE))
    outcome = await _same_answer(fake.client())
    assert outcome[0] == "raised"


async def test_a_wrong_number_of_answers_is_an_error_not_a_shifted_list():
    fake = _model()
    fake.drop_last_browse_result = True
    with pytest.raises(ua.UaError, match="results for"):
        await _new_browse(fake.client())


# -- pages and ContinuationPoints ---------------------------------------------------------------------------------------------------
def _wide(page: int | None, first: int = 5, second: int = 3) -> FakeUa:
    fake = FakeUa(page=page)
    one = fake.add("i=85", "ns=2;s=One", OBJECT)
    two = fake.add("i=85", "ns=2;s=Two", OBJECT)
    for i in range(first):
        fake.var(one, f"ns=2;s=One.{i}", f"One {i}", "kW")
    for i in range(second):
        fake.var(two, f"ns=2;s=Two.{i}", f"Two {i}", "V")
    return fake


async def test_a_browse_answered_in_pages_returns_every_child_and_leaves_no_point_open():
    fake = _wide(page=2)
    answer = await _same_answer(fake.client())
    assert len(answer) == 8
    assert fake.handed and fake.points == {} and fake.released == []
    fake.next_sizes.clear()
    await _new_browse(fake.client())
    assert fake.next_sizes == [2, 1]  # the two folders with a second page in ONE BrowseNext, then the one with a third


async def test_the_pages_of_the_property_lists_are_followed_too():
    fake = FakeUa(page=1)
    folder = fake.add("i=85", "ns=2;s=F", OBJECT)
    fake.var(folder, "ns=2;s=F.v", "V")
    fake.prop("ns=2;s=F.v", "Other", 1.0)
    fake.prop("ns=2;s=F.v", "Another", 1.0)
    fake.prop("ns=2;s=F.v", "EngineeringUnits", ua.EUInformation(DisplayName=ua.LocalizedText("kW")))  # on the third page
    answer = await _same_answer(fake.client())
    assert [d.unit_hint for d in answer] == ["kW"] and fake.points == {}


async def test_a_cancelled_walk_gives_the_continuation_points_back():
    fake = _wide(page=2)
    fake.gate = asyncio.Event()  # never set: the BrowseNext hangs
    client = fake.client()
    task = asyncio.create_task(_new_browse(client))
    await asyncio.wait_for(fake.in_next.wait(), 2)
    assert len(fake.points) == 2
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert fake.released == [fake.handed] and fake.points == {}


async def test_a_failed_walk_gives_the_points_back_and_raises_its_own_error():
    fake = _wide(page=2)
    fake.next_error = ua.UaStatusCodeError(ua.StatusCodes.BadSessionClosed)
    with pytest.raises(ua.UaStatusCodeError) as caught:
        await _new_browse(fake.client())
    assert caught.value.code == ua.StatusCodes.BadSessionClosed
    assert fake.released == [fake.handed] and fake.points == {}


async def test_a_walk_that_ends_well_releases_nothing():
    fake = _wide(page=None)
    await _new_browse(fake.client())
    assert fake.released == [] and fake.next_sizes == []


# -- request sizes ----------------------------------------------------------------------------------------------------------------------
async def test_requests_carry_at_most_200_nodes_and_the_answer_is_still_the_old_one():
    fake = _wide(page=None, first=450, second=3)
    answer = await _same_answer(fake.client())
    assert len(answer) == 453
    fake.browse_sizes.clear()
    fake.read_sizes.clear()
    await _new_browse(fake.client())
    assert max(fake.browse_sizes) == BATCH and max(fake.read_sizes) == BATCH
    assert len(fake.read_sizes) == 3 * math.ceil(453 / BATCH)  # DisplayName, property name, units value
    assert len(fake.browse_sizes) == 2 + math.ceil(453 / BATCH)  # Objects, the two folders, the property lists


async def test_a_server_that_refuses_200_nodes_is_asked_for_fewer_and_the_answer_is_the_same():
    fake = _wide(page=None, first=450, second=3)
    expected = await _outcome(_reference_browse(fake.client()))
    fake.refuse_over = 60
    assert await _new_browse(fake.client()) == expected
    assert fake.browse_sizes[-1] <= 60 and fake.read_sizes[-1] <= 60


async def test_a_server_that_refuses_even_one_node_ends_in_its_own_error():
    fake = _wide(page=None)
    fake.refuse_over = 0
    with pytest.raises(ua.UaStatusCodeError) as caught:
        await _new_browse(fake.client())
    assert caught.value.code == ua.StatusCodes.BadTooManyOperations
    assert fake.browse_sizes[-1] == 1  # it halved down to one node, then stopped


# -- real servers --------------------------------------------------------------------------------------------------------------------------
def _endpoint(srv) -> str:
    return srv.endpoint.replace("0.0.0.0", "127.0.0.1")


async def test_the_default_simulator_gives_the_old_answer_through_the_connector_too():
    async with opcua_server() as srv:
        async with Client(_endpoint(srv), timeout=5) as client:
            old = await _same_answer(client)
        assert len(old) == 60
        browsed = await create_connector("opcua", {"endpoint": _endpoint(srv), "timeout_seconds": 5}).browse()
    assert browsed == sorted(old, key=lambda p: p.name)  # the connector's order: by name, ties in discovery order


@contextlib.asynccontextmanager
async def tie_server():
    """Equal DisplayNames (in one folder and in two), a node and a folder with two parents, a method, a property of an object, a
    variable under a variable and the standard namespace 0 beside it."""
    server = Server()
    await server.init()
    port = free_port()
    server.set_endpoint(f"opc.tcp://127.0.0.1:{port}/ties/")
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace("urn:test:ties")

    async def variable(parent, name, display, unit):
        node = await parent.add_variable(idx, name, 1.0, ua.VariantType.Double)
        await node.write_attribute(
            ua.AttributeIds.DisplayName, ua.DataValue(ua.Variant(ua.LocalizedText(display), ua.VariantType.LocalizedText)),
        )
        if unit:
            await node.add_property(idx, "EngineeringUnits", ua.EUInformation(DisplayName=ua.LocalizedText(unit)))
        return node

    objects = server.nodes.objects
    a, b = await objects.add_object(idx, "A"), await objects.add_object(idx, "B")
    first = await variable(a, "first", "Same", "kW")
    await variable(a, "second", "Same", "kWh")
    await variable(a, "alone", "Alone", None)
    shared = await variable(a, "shared", "Shared", "V")
    await variable(b, "b_first", "Same", "kW")
    inner = await a.add_object(idx, "inner")
    await variable(inner, "deep", "Same", "A")
    await first.add_variable(idx, "under_a_variable", 2.0)  # a variable below a variable is not walked into
    await a.add_method(idx, "method", lambda parent: [], [], [])
    await a.add_property(idx, "Note", "text")
    await b.add_reference(shared, ua.ObjectIds.HasComponent)  # a node with two parents
    await b.add_reference(inner, ua.ObjectIds.HasComponent)  # a folder with two parents
    await server.start()
    try:
        yield f"opc.tcp://127.0.0.1:{port}/ties/", a
    finally:
        await server.stop()


async def test_equal_names_and_shared_nodes_come_back_in_the_old_order():
    async with tie_server() as (endpoint, folder_a):
        async with Client(endpoint, timeout=5) as client:
            old = await _same_answer(client)
            assert [d.name for d in old].count("Same") == 4 and len({d.address for d in old}) == len(old)
            assert next(d for d in old if d.name == "Shared").unit_hint == "V"
            assert "Note" in {d.name for d in old}  # a property of an object is a variable under it
            inside = await _same_answer(client, folder_a.nodeid.to_string())  # a root that is not the Objects folder
            assert {d.address for d in inside} < {d.address for d in old} and "Same" in {d.name for d in inside}
        browsed = await create_connector("opcua", {"endpoint": endpoint, "timeout_seconds": 5}).browse()
    assert browsed == sorted(old, key=lambda p: p.name)


async def test_the_server_object_walked_from_its_own_root_keeps_namespace_zero():
    async with opcua_server() as srv, Client(_endpoint(srv), timeout=10) as client:
        old = await _same_answer(client, "i=2253")  # the standard Server object: no Objects-folder rule, hundreds of nodes
    assert len(old) > 20


async def test_the_shape_server_gives_the_old_answer_in_a_few_requests():
    async with scada(pdus=2) as sim:  # 4 meters x 27 tags + 10 incomers
        async with Client(_endpoint(sim), timeout=30) as client:
            sim.counters.reset()
            old = await _reference_browse(client)
            old_browses, old_reads = sim.counters.browse, len(sim.counters.read_sizes)
            sim.counters.reset()
            new = await _new_browse(client)
            new_browses, new_reads = sim.counters.browse, len(sim.counters.read_sizes)
            assert new == old and len(new) == 118
            assert sim.counters.browse_next == 0
    assert (new_browses, new_reads) == (3 + 1, 3)  # Objects, Site, its folders; one property list; three reads of 118 nodes
    assert old_browses >= 30 * new_browses and old_reads >= 100 * new_reads


async def test_the_browse_of_1306_tags_takes_ten_browse_requests_and_twenty_one_reads_of_at_most_200():
    async with scada(pdus=24) as sim:
        found = await create_connector("opcua", {"endpoint": _endpoint(sim), "timeout_seconds": 30}).browse()
        assert len(found) == len(sim.tags) == 1306
        chunks = math.ceil(1306 / BATCH)
        assert sim.counters.browse == 3 + chunks and sim.counters.browse_next == 0
        assert sorted(sim.counters.read_sizes) == sorted([BATCH] * 6 * 3 + [1306 - 6 * BATCH] * 3)
        assert len(sim.counters.read_sizes) == 3 * chunks


@contextlib.asynccontextmanager
async def scada(**settings):
    sim = ScadaSim(ScadaConfig(**settings), free_port())
    await sim.start()
    try:
        yield sim
    finally:
        await sim.stop()
