"""A second OPC UA server in the simulator process that plays a SCADA the way the real one behaves (dev profile only).

It exists to test the connector against what the real plant SCADA does and the plain simulator does not:

- a Browse answer shows each tag as `ns=3;s=<n>:Site.<tag>`, with a number n counted from 20000 in listing order (the real meter's
  sequence skips 20409 and 20418, so this one does too), while the node itself has the STABLE id `ns=3;s=Site.<tag>`. Read and
  Browse accept the stable id or the CURRENT numbered id. Everything about that numbering is a guess from a forum answer and the
  owner's briefing: it is a model of the trouble, not a copy of a product;
- `restructure(mode)` renumbers at run time, as a SCADA project change does: "bad" makes an old numbered id answer
  BadNodeIdUnknown, "by_index" makes it answer with whatever tag holds that number now (the worst case);
- a read of more nodes than `max_nodes_per_read` is refused with BadTooManyOperations, whatever `OperationLimits.MaxNodesPerRead`
  advertises;
- the tags are many (15,000 is the size to test with), each has a DisplayName and an EngineeringUnits property (units on every tag
  is the worst case for the browse), and the counters say how many requests of which size came in.

Nothing outside `dcdash/simulator/` may import this module (the walls are in tests/test_simulator_faults_isolation.py). Values are
constants that differ from tag to tag (`value_of`), so a test can prove a reading landed on its own tag.
"""

from __future__ import annotations

import asyncio
import dataclasses
import itertools
import re
from collections.abc import Mapping
from dataclasses import dataclass

from asyncua import Server, ua

from dcdash.simulator.faults import FaultConfigError

PREFIX = "SIM_SCADA_"
KNOWN = (
    "SIM_SCADA_PORT", "SIM_SCADA_PDUS", "SIM_SCADA_BRANCH_TAGS", "SIM_SCADA_SEED", "SIM_SCADA_RESTRUCTURE",
    "SIM_SCADA_MAX_NODES_PER_READ", "SIM_SCADA_ADVERTISED_MAX_NODES",
)
SPARE_NAMESPACE = "urn:dcdash:simulator:scada:vendor"  # registered first, so the cluster's namespace is index 3 like the real one's (guess)
CLUSTER_NAMESPACE = "urn:dcdash:simulator:scada:cluster"
NAMESPACE_INDEX = 3  # asyncua's own namespace 1 is the application URI; the spare one is 2
CLUSTER = "Site"  # never a real site name
ENDPOINT_PATH = "/plantscada"
FIRST_NUMBER = 20000
SKIPPED_NUMBERS = frozenset({20409, 20418})  # the real meter's tag sequence skips these two
EXTRA_EQUIPMENT = "PDUX00"  # guess: the equipment a SCADA project change adds in front of the others
MODES = ("", "bad", "by_index")

# The 27 values of one PDU meter (R-F13); `PDUA01_PM0_P` is the active power of feed A's first PDU.
METER_SUFFIXES = (
    "A_L1", "A_L2", "A_L3", "A_THDL1", "A_THDL2", "A_THDL3", "VL1N", "VL2N", "VL3N", "VTHD_L1N", "VTHD_L2N", "VTHD_L3N", "FQ",
    "P", "PL1", "PL2", "PL3", "S", "SL1", "SL2", "SL3", "Q", "QL1", "QL2", "QL3", "PF", "PENRG",
)
INCOMER_TAGS = tuple(f"{prefix}{n}IN_QM_P" for prefix in ("IT", "ME") for n in range(1, 6))

_NUMBERED = re.compile(r"(\d+):Site\.(.+)")
_LIMIT_NODE = ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead


class ScadaConfigError(FaultConfigError):
    """A SIM_SCADA_* setting that cannot be honoured; main() stops on it exactly as it stops on a bad SIM_FAULT_* switch."""


@dataclass(frozen=True)
class ScadaConfig:
    """The SCADA's knobs (SIM_SCADA_* in the environment, read by main.py). `port` None = the server does not exist."""

    port: int | None = None
    pdus: int = 24  # PDUs per feed: 24 gives 48 meters x 27 + 10 incomers = 1,306 tags
    branch_tags: int = 0  # extra tags PDUAnn_Q<k>_P, spread over the PDUs round robin
    seed: int = 1  # for the live values of a later task; the constants of this one do not use it
    restructure: str = ""  # "", "bad" or "by_index": the numbering the server starts with
    max_nodes_per_read: int = 0  # 0 = no limit; above 0 a Read of more nodes is refused (enforced)
    advertised_max_nodes: int | None = None  # what OperationLimits.MaxNodesPerRead shows; None = the enforced value

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> ScadaConfig:
        """Unset or empty = the default (no port = no SCADA server). A name that is not a setting, or a value that is not honoured,
        raises ScadaConfigError with a plain sentence: a typo must never run the rehearsal with the defaults."""
        unknown = sorted(name for name in environ if name.startswith(PREFIX) and name not in KNOWN)
        if unknown:
            raise ScadaConfigError(
                f"{', '.join(unknown)} is not a setting of the SCADA-shaped OPC UA server (a typo would run the rehearsal with the "
                f"defaults). The settings are: {', '.join(KNOWN)}."
            )

        def value(name: str) -> str:
            return environ.get(name, "").strip()

        default = cls()
        restructure = value("SIM_SCADA_RESTRUCTURE")
        if restructure not in MODES:
            raise ScadaConfigError(f"SIM_SCADA_RESTRUCTURE must be bad or by_index (or empty for none), not '{restructure}'.")
        advertised = value("SIM_SCADA_ADVERTISED_MAX_NODES")
        return cls(
            port=_whole("SIM_SCADA_PORT", value("SIM_SCADA_PORT"), None, 1, 65535),
            pdus=_whole("SIM_SCADA_PDUS", value("SIM_SCADA_PDUS"), default.pdus, 0, 200),
            branch_tags=_whole("SIM_SCADA_BRANCH_TAGS", value("SIM_SCADA_BRANCH_TAGS"), default.branch_tags, 0, 20_000),
            seed=_whole("SIM_SCADA_SEED", value("SIM_SCADA_SEED"), default.seed, 0, 1_000_000),
            restructure=restructure,
            max_nodes_per_read=_whole("SIM_SCADA_MAX_NODES_PER_READ", value("SIM_SCADA_MAX_NODES_PER_READ"), default.max_nodes_per_read, 0, 1_000_000),
            advertised_max_nodes=_whole("SIM_SCADA_ADVERTISED_MAX_NODES", advertised, None, 0, 4_294_967_295) if advertised else None,
        )

    def describe(self) -> list[str]:
        """One line per active fault, each starting with the variable and its value; empty for a plain (even a much bigger) cluster."""
        lines = []
        if self.restructure:
            effect = ("an old numbered address answers BadNodeIdUnknown" if self.restructure == "bad"
                      else "an old numbered address reads whatever tag holds that number now")
            lines.append(f"SIM_SCADA_RESTRUCTURE={self.restructure}: the numbering is shifted by an extra equipment folder, {effect}")
        if self.max_nodes_per_read:
            lines.append(f"SIM_SCADA_MAX_NODES_PER_READ={self.max_nodes_per_read}: a Read of more nodes is refused with BadTooManyOperations")
        if self.advertised_max_nodes is not None and self.advertised_max_nodes != self.max_nodes_per_read:
            lines.append(f"SIM_SCADA_ADVERTISED_MAX_NODES={self.advertised_max_nodes}: MaxNodesPerRead advertises {self.advertised_max_nodes}, not the limit it enforces")
        return lines


def _whole(name: str, text: str, default: int | None, low: int, high: int) -> int | None:
    if not text:
        return default
    try:
        number = int(text)
    except ValueError:
        raise ScadaConfigError(f"{name} must be a whole number, not '{text}'.") from None
    if not low <= number <= high:
        raise ScadaConfigError(f"{name} must be between {low} and {high}, not '{text}'.")
    return number


class ScadaCounters:
    """What the server was asked, so a test can prove how a client reads and browses."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.browse = 0  # Browse requests
        self.browse_next = 0  # BrowseNext requests: asyncua's server has none, so this stays 0
        self.nodes_browsed = 0  # nodes in all the Browse requests
        self.read_sizes: list[int] = []  # nodes per Read request that contains at least one node of the cluster's namespace, in order
        self.limit_reads = 0  # Read requests that contain the MaxNodesPerRead node


def _build_tags(config: ScadaConfig) -> tuple[list[str], list[str]]:
    """(the tags in listing order, the tags of the extra equipment). Listing order: feed A meters, feed B meters, branch tags, incomers."""
    tags = [f"PDU{feed}{n:02d}_PM0_{suffix}" for feed in "AB" for n in range(1, config.pdus + 1) for suffix in METER_SUFFIXES]
    spread = max(config.pdus, 1)  # guess: with no PDU at all the branch tags hang on PDUA01 alone
    tags += [f"PDUA{j % spread + 1:02d}_Q{j // spread + 1}_P" for j in range(config.branch_tags)]
    tags += INCOMER_TAGS
    return tags, [f"{EXTRA_EQUIPMENT}_PM0_{suffix}" for suffix in METER_SUFFIXES]


def equipment_of(tag: str) -> str:
    """The folder under Site that holds a tag: the part before the first underscore."""
    return tag.split("_", 1)[0]


def unit_of(tag: str) -> str:  # guess: a plausible unit for every tag
    suffix = tag.split("_", 2)[2]
    if suffix == "PF":
        return "PF"
    if suffix == "PENRG":
        return "kWh"
    if suffix == "FQ":
        return "Hz"
    if "THD" in suffix:
        return "%"
    if suffix.startswith("A_"):
        return "A"
    if suffix.startswith("V"):
        return "V"
    return {"P": "kW", "S": "kVA", "Q": "kvar"}[suffix[0]]


class ScadaSim:
    def __init__(self, config: ScadaConfig, port: int, instance: str = "dev") -> None:
        if config.restructure not in MODES:
            raise ValueError(f"restructure must be one of {MODES}, not {config.restructure!r}")
        self.config = config
        self.instance = instance
        self.endpoint = f"opc.tcp://0.0.0.0:{port}{ENDPOINT_PATH}"
        self.tags, self.extra_tags = _build_tags(config)  # never change after this: a restructure renumbers, it does not rename
        self._values = {tag: 1000.0 + index for index, tag in enumerate(self.tags)}
        self._values.update({tag: 1000.0 + len(self.tags) + index for index, tag in enumerate(self.extra_tags)})
        self.counters = ScadaCounters()
        self._server: Server | None = None
        self._mode = ""
        self._number_of: dict[str, int] = {}
        self._tag_at: dict[int, str] = {}
        self.restructure(config.restructure)

    # -- the model ------------------------------------------------------------------------------------------------------------
    def value_of(self, tag: str) -> float:
        """The value the tag shows (a constant, distinct per tag)."""
        return self._values[tag]

    def stable_id(self, tag: str) -> str:
        return f"ns={NAMESPACE_INDEX};s={CLUSTER}.{tag}"

    def numbered_id(self, tag: str) -> str:
        """The id a Browse shows for the tag NOW."""
        try:
            number = self._number_of[tag]
        except KeyError:
            raise ValueError(f"{tag} is not listed in the restructure mode {self._mode!r}") from None
        return f"ns={NAMESPACE_INDEX};s={number}:{CLUSTER}.{tag}"

    def restructure(self, mode: str) -> None:
        """Renumber the model at run time (no restart, no node added): "" is the numbering of the first browse; the other two list the
        extra equipment in front of the others, so every later number moves by the number of its tags."""
        if mode not in MODES:
            raise ValueError(f"restructure must be one of {MODES}, not {mode!r}")
        self._mode = mode
        listed = self.tags if mode == "" else self.extra_tags + self.tags
        numbers = (n for n in itertools.count(FIRST_NUMBER) if n not in SKIPPED_NUMBERS)
        self._number_of = dict(zip(listed, numbers, strict=False))
        self._tag_at = {number: tag for tag, number in self._number_of.items()}

    # -- the server -----------------------------------------------------------------------------------------------------------
    async def start(self) -> None:
        server = Server()
        await server.init()
        await server.set_application_uri(f"urn:dcdash:simulator:scada:{self.instance}")
        server.set_endpoint(self.endpoint)
        server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
        await server.register_namespace(SPARE_NAMESPACE)
        idx = await server.register_namespace(CLUSTER_NAMESPACE)
        assert idx == NAMESPACE_INDEX, f"the cluster's namespace is {idx}, not {NAMESPACE_INDEX}"
        site = await server.nodes.objects.add_object(ua.NodeId(CLUSTER, idx), ua.QualifiedName(CLUSTER, idx))
        folders = {}
        for tag in [*self.extra_tags, *self.tags]:  # the extra equipment first, so it sits in front of PDUA01 in the folder too
            equipment = equipment_of(tag)
            if equipment not in folders:
                folders[equipment] = await site.add_object(ua.NodeId(f"{CLUSTER}.{equipment}", idx), ua.QualifiedName(equipment, idx))
            variable = await folders[equipment].add_variable(
                ua.NodeId(f"{CLUSTER}.{tag}", idx), ua.QualifiedName(tag, idx), self._values[tag], ua.VariantType.Double,
            )  # the DisplayName is the tag name (guess)
            unit = unit_of(tag)
            await variable.add_property(idx, "EngineeringUnits", ua.EUInformation(DisplayName=ua.LocalizedText(unit), Description=ua.LocalizedText(unit)))
        await server.start()
        advertised = self.config.advertised_max_nodes if self.config.advertised_max_nodes is not None else self.config.max_nodes_per_read
        await server.write_attribute_value(
            ua.NodeId(_LIMIT_NODE), ua.DataValue(ua.Variant(advertised, ua.VariantType.UInt32)),
        )
        # After the server is up, so nothing the set-up reads or browses is counted
        service = server.iserver.attribute_service
        self._read_original = service.read
        service.read = self._read  # an instance attribute: asyncua calls attribute_service.read(params) synchronously
        view = server.iserver.view_service
        self._browse_original = view.browse
        view.browse = self._browse
        self.counters.reset()
        self._server = server

    async def stop(self) -> None:
        if self._server is not None:
            await self._server.stop()
            self._server = None

    async def run(self) -> None:
        await self.start()
        try:
            await asyncio.Event().wait()
        finally:
            await self.stop()

    # -- the two wrappers (plain `def`: asyncua calls them without await) ---------------------------------------------------------
    def _translate(self, nodeid: ua.NodeId) -> ua.NodeId:
        """The node an id means: a numbered id of this moment (or, in "by_index", of any moment) becomes the stable id of the tag it
        names; an id that means nothing is returned as it is, so the address space itself answers that it is unknown."""
        identifier = nodeid.Identifier
        if nodeid.NamespaceIndex != NAMESPACE_INDEX or not isinstance(identifier, str):
            return nodeid
        match = _NUMBERED.fullmatch(identifier)
        if match is None:
            return nodeid
        number, tag = int(match[1]), match[2]
        holder = self._tag_at.get(number) if self._mode == "by_index" else (tag if self._number_of.get(tag) == number else None)
        return nodeid if holder is None else dataclasses.replace(nodeid, Identifier=f"{CLUSTER}.{holder}")

    def _read(self, params: ua.ReadParameters) -> list[ua.DataValue]:
        nodes = params.NodesToRead
        if any(node.NodeId.NamespaceIndex == NAMESPACE_INDEX for node in nodes):
            self.counters.read_sizes.append(len(nodes))
        if any(node.NodeId.NamespaceIndex == 0 and node.NodeId.Identifier == _LIMIT_NODE for node in nodes):
            self.counters.limit_reads += 1
        if self.config.max_nodes_per_read and len(nodes) > self.config.max_nodes_per_read:
            raise ua.UaStatusCodeError(ua.StatusCodes.BadTooManyOperations)
        translated = [
            node if (nodeid := self._translate(node.NodeId)) is node.NodeId else dataclasses.replace(node, NodeId_=nodeid) for node in nodes
        ]
        return self._read_original(dataclasses.replace(params, NodesToRead=translated))

    def _browse(self, params: ua.BrowseParameters) -> list[ua.BrowseResult]:
        self.counters.browse += 1
        self.counters.nodes_browsed += len(params.NodesToBrowse)
        translated = [
            item if (nodeid := self._translate(item.NodeId)) is item.NodeId else dataclasses.replace(item, NodeId_=nodeid)
            for item in params.NodesToBrowse
        ]
        results = self._browse_original(dataclasses.replace(params, NodesToBrowse=translated))
        return [self._present(result) for result in results]

    def _present(self, result: ua.BrowseResult) -> ua.BrowseResult:
        """The references as this moment lists them. The live reference objects belong to the address space, so a changed one is a copy."""
        shown: list[ua.ReferenceDescription] = []
        changed = False
        hidden = f"{CLUSTER}.{EXTRA_EQUIPMENT}" if self._mode == "" else None
        for ref in result.References:
            nodeid = ref.NodeId
            identifier = nodeid.Identifier
            if nodeid.NamespaceIndex == NAMESPACE_INDEX and isinstance(identifier, str):
                if identifier == hidden:
                    changed = True  # the extra equipment exists but is not listed yet
                    continue
                number = self._number_of.get(identifier.removeprefix(f"{CLUSTER}.")) if identifier.startswith(f"{CLUSTER}.") else None
                if number is not None:
                    ref = dataclasses.replace(ref, NodeId=dataclasses.replace(nodeid, Identifier=f"{number}:{identifier}"))
                    changed = True
            shown.append(ref)
        return dataclasses.replace(result, References=shown) if changed else result
