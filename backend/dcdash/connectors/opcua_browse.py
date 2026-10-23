"""The OPC UA browse, asking for many nodes at a time (w34 R10, D7).

The walker this replaces asked the server one question per node: the children of a folder, the class of each child, the
DisplayName of each variable, the properties of each variable, the name and the value of the properties. At 15,000 tags that is
about 100,000 requests. Here the tree is fetched level by level into memory (one Browse request for up to 200 parents), the
DisplayNames, the properties and the units of the variables are fetched in requests of up to 200 nodes, and then the OLD
depth-first walk is replayed over what was fetched. The answer is the old one, entry for entry and in the same order, also for
equal names and for a node listed under two parents; only the number of requests changes.

Read-only: it only ever issues Browse, BrowseNext and Read.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import replace
from typing import Any

from asyncua import Client, ua
from asyncua.ua.uaerrors import UaInvalidParameterError

from dcdash.connectors.base import ConnectorError, PointDescriptor

BATCH = 200  # nodes per Browse and per Read request; a server that refuses that many is asked for half (see `_in_batches`)
_UNITS = "EngineeringUnits"
_HIERARCHICAL = ua.NodeId(ua.ObjectIds.HierarchicalReferences)
_HAS_PROPERTY = ua.NodeId(ua.ObjectIds.HasProperty)
_NO_POINTS = ua.StatusCodes.BadNoContinuationPoints


async def browse_tree(client: Client, root: ua.NodeId, skip_standard: bool) -> list[PointDescriptor]:
    """Every variable under `root` (raw node id as address, DisplayName as name, the EngineeringUnits text as unit hint), in the
    order the depth-first walk of the former connector found them. `skip_standard`: leave out the namespace-0 children (the OPC
    Foundation's own nodes), what is wanted under the Objects folder."""
    walk = _Walk(client.uaclient)
    try:
        tree = await walk.fetch_tree(root, skip_standard)
        variables = _replay(tree, root.to_string(), skip_standard)
        ids = [ref.NodeId for ref in variables]
        names = await walk.read(ids, ua.AttributeIds.DisplayName)
        properties = await walk.browse(ids, _HAS_PROPERTY, ua.NodeClass.Variable)
        flat = [ref.NodeId for refs in properties for ref in refs]
        flat_names = await walk.read(flat, ua.AttributeIds.BrowseName)
        spans, start = [], 0
        for refs in properties:
            spans.append(range(start, start + len(refs)))
            start += len(refs)
        # The unit of a variable is the Value of its FIRST property named EngineeringUnits; a property whose name cannot be read
        # stops the search here, and the pass below raises on it (the former walker did, at that property).
        unit_at = [_first_units(span, flat_names) for span in spans]
        wanted = [index for index in unit_at if index is not None]
        values = dict(zip(wanted, await walk.read([flat[i] for i in wanted], ua.AttributeIds.Value), strict=True))
        return [
            PointDescriptor(
                address=ref.NodeId.to_string(),
                name=_content(name).Text or ref.NodeId.to_string(),
                unit_hint=_unit(span, flat_names, values),
            )
            for ref, name, span in zip(variables, names, spans, strict=True)
        ]
    finally:
        await walk.release()


def _replay(tree: dict[str, list[ua.ReferenceDescription]], root: str, skip_standard: bool) -> list[ua.ReferenceDescription]:
    """The depth-first walk of the former connector over the fetched tree: the same stack, the same first-visit `seen` (the root
    is not in it), the same namespace-0 rule. A child is reported by the first parent that is popped and lists it."""
    found: list[ua.ReferenceDescription] = []
    stack = [root]
    seen: set[str] = set()
    while stack:
        for ref in tree[stack.pop()]:
            key = ref.NodeId.to_string()
            if key in seen or (skip_standard and ref.NodeId.NamespaceIndex == 0):
                continue
            seen.add(key)
            if ref.NodeClass == ua.NodeClass.Variable:
                found.append(ref)
            elif ref.NodeClass == ua.NodeClass.Object:
                stack.append(key)
    return found


def _content(data_value: ua.DataValue) -> Any:
    """What `Node.read_attribute` and the `read_*` helpers of asyncua do with an answer: a Bad status raises, a missing value raises."""
    data_value.StatusCode_.check()
    if data_value.Value is None:
        raise UaInvalidParameterError("Value must not be None if the result is in Good status")
    return data_value.Value.Value


def _first_units(span: range, names: Sequence[ua.DataValue]) -> int | None:
    """The index of the first property in `span` named EngineeringUnits, or None (no such property, or a name that cannot be read)."""
    for index in span:
        data_value = names[index]
        if not data_value.StatusCode_.is_good() or data_value.Value is None:
            return None
        if getattr(data_value.Value.Value, "Name", None) == _UNITS:
            return index
    return None


def _unit(span: range, names: Sequence[ua.DataValue], values: dict[int, ua.DataValue]) -> str | None:
    """The unit hint of one variable, raising exactly where the former per-node reads raised: on the name of each property up to the
    EngineeringUnits one, then on its value."""
    for index in span:
        if _content(names[index]).Name == _UNITS:
            units = _content(values[index])
            return getattr(getattr(units, "DisplayName", None), "Text", None) or None
    return None


class _Walk:
    """The requests of one browse. It keeps the ContinuationPoints the server has handed out and not yet had back, so that a walk
    that fails or is cancelled can tell the server to drop them (`release`)."""

    def __init__(self, uaclient: Any) -> None:
        self._ua = uaclient
        # "points": the most parents of a folder level that fit the server's ContinuationPoints (learned, see `_browse_chunk`)
        self._sizes = {"browse": BATCH, "read": BATCH, "points": BATCH}
        self._classes: dict[str, ua.NodeClass] = {}  # the NodeClass read for references that did not say it, by node id
        self._open: dict[Any, None] = {}  # the points handed out and not yet answered, in the order they were handed out

    async def fetch_tree(self, root: ua.NodeId, skip_standard: bool) -> dict[str, list[ua.ReferenceDescription]]:
        """The references of the root and of every folder (Object) reachable from it, level by level. Only what the replay can
        expand is fetched: not the namespace 0 under the Objects folder, and each folder once."""
        tree: dict[str, list[ua.ReferenceDescription]] = {}
        level: list[tuple[str, ua.NodeId]] = [(root.to_string(), root)]
        queued = {key for key, _ in level}
        while level:
            answers = await self.browse([nodeid for _, nodeid in level], _HIERARCHICAL, ua.NodeClass.Unspecified)
            answers = await self._with_classes(answers, skip_standard)
            following: list[tuple[str, ua.NodeId]] = []
            for (key, _), refs in zip(level, answers, strict=True):
                tree[key] = refs
                for ref in refs:
                    child = ref.NodeId.to_string()
                    if child in queued or (skip_standard and ref.NodeId.NamespaceIndex == 0):
                        continue
                    if ref.NodeClass == ua.NodeClass.Object:  # a server must return the NodeClass the result mask asks for
                        queued.add(child)
                        following.append((child, ref.NodeId))
            level = following
        return tree

    async def _with_classes(
        self, answers: list[list[ua.ReferenceDescription]], skip_standard: bool
    ) -> list[list[ua.ReferenceDescription]]:
        """A server that leaves the NodeClass of a reference at 0 (Unspecified) cannot say what to open: the class of all such nodes of
        a level is read in ONE batched Read (each node once, not the namespace 0 that is skipped anyway), as the former walker read it
        for every child. A server that fills the class in, as the default simulator does, costs no request here."""
        unknown: dict[str, ua.NodeId] = {}
        for refs in answers:
            for ref in refs:
                key = ref.NodeId.to_string()
                skipped = skip_standard and ref.NodeId.NamespaceIndex == 0
                if ref.NodeClass == ua.NodeClass.Unspecified and key not in self._classes and not skipped:
                    unknown.setdefault(key, ref.NodeId)
        if not unknown:
            return answers
        for key, data_value in zip(unknown, await self.read(list(unknown.values()), ua.AttributeIds.NodeClass), strict=True):
            self._classes[key] = ua.NodeClass(int(_content(data_value)))  # a Bad status raises here, as the former read of the class did
        return [[self._resolved(ref) for ref in refs] for refs in answers]

    def _resolved(self, ref: ua.ReferenceDescription) -> ua.ReferenceDescription:
        node_class = self._classes.get(ref.NodeId.to_string())
        return ref if node_class is None or ref.NodeClass != ua.NodeClass.Unspecified else replace(ref, NodeClass_=node_class)

    # -- Browse ---------------------------------------------------------------------------------------------------------------
    async def browse(self, nodeids: Sequence[ua.NodeId], reference: ua.NodeId, class_mask: ua.NodeClass) -> list[list[ua.ReferenceDescription]]:
        """The forward references of `reference` (and its subtypes) of every node, one list per node in the order asked, in requests
        of up to `BATCH` nodes, with every ContinuationPoint followed. A node the server cannot browse has no references, except
        when it had no ContinuationPoint left for the node, or lost a later page of it: that is asked again, in smaller batches or on
        its own (see `_browse_chunk`)."""

        async def send(chunk: Sequence[ua.NodeId]) -> list[list[ua.ReferenceDescription]]:
            return await self._browse_chunk(chunk, reference, class_mask)

        # the folders of a level can need a point each; the properties of a variable hardly ever do, so they keep the full batch
        return await self._in_batches("browse", nodeids, send, cap="points" if reference == _HIERARCHICAL else None)

    async def _browse_chunk(
        self, nodeids: Sequence[ua.NodeId], reference: ua.NodeId, class_mask: ua.NodeClass
    ) -> list[list[ua.ReferenceDescription]]:
        params = ua.BrowseParameters()
        params.View.Timestamp = ua.get_win_epoch()
        params.RequestedMaxReferencesPerNode = 0  # the server decides the page size
        for nodeid in nodeids:
            description = ua.BrowseDescription()
            description.NodeId = nodeid
            description.BrowseDirection = ua.BrowseDirection.Forward
            description.ReferenceTypeId = reference
            description.IncludeSubtypes = True
            description.NodeClassMask = class_mask
            description.ResultMask = ua.BrowseResultMask.NodeClass  # the class, to decide what to open; the NodeId always comes
            params.NodesToBrowse.append(description)
        results = _same_count(await self._ua.browse(params), nodeids)
        references = [list(result.References) for result in results]  # a copy: a server in this process hands out its own lists
        # A bad status for one node is "nothing under it" (what the former walker did: it read an empty list), except when the server
        # had no ContinuationPoint left for it (a server allows only a few open at a time, the former walker held one): that answer
        # carries no references although the node has some, and they are asked for again below.
        refused = [i for i, result in enumerate(results) if _status(result) == _NO_POINTS]
        waiting = {i: result.ContinuationPoint for i, result in enumerate(results) if result.ContinuationPoint}
        granted = len(waiting)  # the points this server gave at once: what it can hold open
        lost: dict[int, int] = {}  # the nodes whose next page the server answered with a Bad status, and which one
        self._open.update(dict.fromkeys(waiting.values()))
        while waiting:
            indexes = list(waiting)
            points = [waiting[i] for i in indexes]
            more = ua.BrowseNextParameters()
            more.ReleaseContinuationPoints = False
            more.ContinuationPoints = points
            answers = _same_count(await self._ua.browse_next(more), points)
            for point in points:  # the server forgets a point once it has answered it (a new one comes if more is left)
                self._open.pop(point, None)
            waiting = {}
            for i, answer in zip(indexes, answers, strict=True):
                if answer.StatusCode_.is_bad():
                    # A page the server lost (BadContinuationPointInvalid, BadNoContinuationPoints): nothing in this answer is kept and
                    # the node is not read to its end, so what it collected is dropped and it is browsed again below.
                    lost[i] = _status(answer)
                    continue
                references[i].extend(answer.References)
                if answer.ContinuationPoint:
                    waiting[i] = answer.ContinuationPoint
            self._open.update(dict.fromkeys(waiting.values()))
        # Every point of this request is back now. One node alone that still finds none, or loses a page, is a server that cannot be
        # walked: an empty or a short folder would be taken for the real one.
        if len(nodeids) == 1 and refused:
            raise ConnectorError("protocol_error", "the server has no continuation point left (BadNoContinuationPoints)")
        if len(nodeids) == 1 and lost:
            raise ConnectorError("protocol_error", f"the server lost a continuation point ({_status_name(lost[0])})")
        if refused:
            self._sizes["points"] = min(self._sizes["points"], max(1, granted))
            size = min(max(1, len(nodeids) // 2), self._sizes["points"])
            for start in range(0, len(refused), size):
                part = refused[start : start + size]
                again = await self._browse_chunk([nodeids[i] for i in part], reference, class_mask)
                for i, refs in zip(part, again, strict=True):
                    references[i] = refs
        for i in lost:  # each on its own, from its first page: the references it had collected are replaced, none is listed twice
            references[i] = (await self._browse_chunk([nodeids[i]], reference, class_mask))[0]
        return references

    async def release(self) -> None:
        """Hand back every ContinuationPoint still held (a walk that failed or was cancelled). Never raises what the walk did not."""
        if not self._open:
            return
        points, self._open = list(self._open), {}
        params = ua.BrowseNextParameters()
        params.ReleaseContinuationPoints = True
        params.ContinuationPoints = points
        with contextlib.suppress(Exception):
            async with asyncio.timeout(1.0):
                await self._ua.browse_next(params)

    # -- Read -----------------------------------------------------------------------------------------------------------------
    async def read(self, nodeids: Sequence[ua.NodeId], attribute: ua.AttributeIds) -> list[ua.DataValue]:
        """One attribute of every node, one answer per node in the order asked, in requests of up to `BATCH` nodes. A bad status is
        in the answer, not raised here: the caller raises at the node where the former walker would have."""

        async def send(chunk: Sequence[ua.NodeId]) -> list[ua.DataValue]:
            params = ua.ReadParameters()
            for nodeid in chunk:
                item = ua.ReadValueId()
                item.NodeId = nodeid
                item.AttributeId = attribute
                params.NodesToRead.append(item)
            return list(_same_count(await self._ua.read(params), chunk))

        return await self._in_batches("read", nodeids, send)

    # -- sizes ----------------------------------------------------------------------------------------------------------------
    async def _in_batches(
        self, kind: str, items: Sequence[Any], send: Callable[[Sequence[Any]], Awaitable[list[Any]]], cap: str | None = None
    ) -> list[Any]:
        """`send` for consecutive chunks of at most the current size of `kind` (and of `cap`, another learned size), the answers
        joined in order. A server that refuses a chunk as too many operations gets half the size from then on (the former walker
        never sent more than one node, so a limit of the server was never met); a refusal of a single node is the server's answer
        and is raised."""
        answers: list[Any] = []
        while len(answers) < len(items):
            chunk = items[len(answers) : len(answers) + min(self._sizes[kind], self._sizes[cap or kind])]
            try:
                answers.extend(await send(chunk))
            except ua.UaStatusCodeError as exc:
                if getattr(exc, "code", None) != ua.StatusCodes.BadTooManyOperations or len(chunk) <= 1:
                    raise
                self._sizes[kind] = max(1, len(chunk) // 2)
        return answers


def _status(result: ua.BrowseResult) -> int:
    """The status code proper of an answer: the high 16 bits. The low 16 carry info bits and flags (a server may set them)."""
    return result.StatusCode_.value & 0xFFFF0000


def _status_name(code: int) -> str:
    return ua.StatusCode(code).name


def _same_count(answers: Sequence[Any] | None, asked: Sequence[Any]) -> Sequence[Any]:
    """The answers of a service request, one per node asked; anything else is a server that cannot be trusted with the order."""
    if answers is None or len(answers) != len(asked):
        raise ua.UaError(f"the server answered {0 if answers is None else len(answers)} results for {len(asked)} nodes")
    return answers
