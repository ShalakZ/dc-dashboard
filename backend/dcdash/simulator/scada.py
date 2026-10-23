"""A second OPC UA server in the simulator process that plays a SCADA the way the real one behaves (dev profile only).

It exists to test the connector against what the real plant SCADA does and the plain simulator does not:

- a Browse answer shows each tag as `ns=3;s=<n>:Site.<tag>`, with a number n counted from 20000 in the order of the `tags` list (feed A
  meters, feed B meters, branch tags, incomers), not in the order of the folders (the real meter's sequence skips 20409 and 20418, so
  this one does too), while the node itself has the STABLE id `ns=3;s=Site.<tag>`. Read and
  Browse accept the stable id or the CURRENT numbered id. Everything about that numbering is a guess from a forum answer and the
  owner's briefing: it is a model of the trouble, not a copy of a product;
- `restructure(mode)` renumbers at run time, as a SCADA project change does: "bad" makes an old numbered id answer
  BadNodeIdUnknown, "by_index" makes it answer with whatever tag holds that number now (the worst case);
- a read of more nodes than `max_nodes_per_read` is refused with BadTooManyOperations, whatever `OperationLimits.MaxNodesPerRead`
  advertises;
- the tags are many (15,000 is the size to test with), each has a DisplayName and an EngineeringUnits property (units on every tag
  is the worst case for the browse), and the counters say how many requests of which size came in.

Nothing outside `dcdash/simulator/` may import this module (the walls are in tests/test_simulator_faults_isolation.py).

Values come in two forms. A hand-built `ScadaConfig()` has `live=False`: constants that differ from tag to tag (`1000.0 + index`,
as `Double`), so a test can prove a reading landed on its own tag. The simulator process (`ScadaConfig.from_env`) has `live=True`:
every Read is answered at the instant `clock()` gives, by the pure function `sample(seed, tag, instant)` further down, as the real
meters behave (each tag on its own clock of 64 to 76 s plus one 4 s grid step of jitter, so the gap between two updates is 60 to 80 s;
a quarter of the updates repeating, float32 widened to double, a kWh counter, `SourceTimestamp` on the tag's own update). `value_of(tag)` is then "the value at the clock's instant".
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import itertools
import math
import re
import struct
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache

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
    seed: int = 1  # the live values (and every tag's own clock) are a function of it
    live: bool = False  # True = time-varying float32 values (the simulator process, from_env); False = the constants of `value_of`
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
            live=True,  # the process that serves a rehearsal serves live values; there is no setting for it (and none for the tests: they build the dataclass)
        )

    def describe(self) -> list[str]:
        """One line per active fault, each starting with the variable and its value; empty for a plain (even a much bigger) cluster.
        `live` is not a fault, so it never adds a line."""
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


# ---- the live values: a pure function of seed, tag and instant (the style of simulator/historian.py) -------------------------------
# What the briefing showed (all of it a model, none of it a copy of a product): a tag changes on its OWN clock of 64 to 76 s on a 4 s
# grid, about a quarter of its updates repeat the last value, the values are float32 widened to double, and PENRG is a kWh counter near
# 3,116,496 that moves in 0.25 steps (float32 has no finer step up there, and 0.5 steps above 4,194,304, with no code of ours).

GRID_S = 4  # every update of every tag sits on this grid (seconds since 1970)
PERIOD_STEPS = (16, 17, 18, 19)  # a tag's period in grid steps: 64, 68, 72 or 76 s
REPEAT_SHARE = 0.24  # the share of a tag's updates that repeat its previous value
MAX_REPEAT_RUN = 16  # a run of repeats is followed back at most this far (0.24 ** 16 is nothing); keeps the function O(1)
COUNTER_BASE_KWH = 3_116_496  # PENRG at the counter's epoch
COUNTER_EPOCH_S = datetime(2026, 10, 1, tzinfo=timezone.utc).timestamp()
LOAD_SWING = 0.15  # a meter's load moves this much around its mean in a day
DAY_S = 86400
OMEGA = 2 * math.pi / DAY_S
_MASK = (1 << 64) - 1


def clock() -> float:
    """The instant the live values are computed for, in seconds since 1970 (UTC). The ONE place the wall clock is read: a test replaces
    this function (monkeypatch `dcdash.simulator.scada.clock`) to fix or move time."""
    return time.time()


def _mix(*numbers: int) -> int:
    """A 64-bit hash of whole numbers (splitmix64 steps): the same numbers always give the same answer, in every process."""
    x = 0x9E3779B97F4A7C15
    for number in numbers:
        x = (x + (number & _MASK) + 0x9E3779B97F4A7C15) & _MASK
        x ^= x >> 30
        x = (x * 0xBF58476D1CE4E5B9) & _MASK
        x ^= x >> 27
        x = (x * 0x94D049BB133111EB) & _MASK
        x ^= x >> 31
    return x


def _uniform(*numbers: int) -> float:
    """A number in [0, 1) that depends on nothing but the arguments."""
    return (_mix(*numbers) >> 11) / (1 << 53)


@lru_cache(maxsize=None)
def _name_key(text: str) -> int:
    return int.from_bytes(hashlib.blake2b(text.encode(), digest_size=8).digest(), "big")  # python's own str hash changes per process


def float32(number: float) -> float:
    """What a float32 variable shows once a client widens it to a double."""
    return struct.unpack("f", struct.pack("f", number))[0]


@dataclass(frozen=True, slots=True)
class _Meter:
    """The seeded character of one meter, shared by its tags. Guesses throughout: sizes that look like a PDU, a branch and an incomer."""

    p0: float  # mean active power, kW
    pf: float  # mean power factor
    shares: tuple[float, float, float]  # how the power splits over the three phases (they add up to 1)
    v0: float  # mean phase voltage, V
    thd_a: float  # mean current distortion, %
    thd_v: float  # mean voltage distortion, %
    phase: float  # where in its day the load peaks, radians


@lru_cache(maxsize=None)
def _meter(seed: int, name: str) -> _Meter:
    """`name` is the first two parts of a tag: PDUA01_PM0 (a PDU meter), PDUA01_Q3 (a branch) or IT1IN_QM (an incomer)."""
    key = _mix(seed, _name_key(name))
    second = name.split("_", 1)[1]
    if second == "PM0":
        p0 = 20 + 40 * _uniform(key, 1)  # a PENRG that moves by more than one 0.25 kWh step per update, whatever the clock
    elif second == "QM":
        p0 = 120 + 280 * _uniform(key, 1)
    else:
        p0 = 0.5 + 5.5 * _uniform(key, 1)
    first, second_share = 1 / 3 + 0.08 * (_uniform(key, 2) - 0.5), 1 / 3 + 0.08 * (_uniform(key, 3) - 0.5)
    return _Meter(
        p0=p0, pf=0.88 + 0.09 * _uniform(key, 4), shares=(first, second_share, 1 - first - second_share), v0=228 + 4 * _uniform(key, 5),
        thd_a=2 + 5 * _uniform(key, 6), thd_v=0.8 + 1.7 * _uniform(key, 7), phase=2 * math.pi * _uniform(key, 8),
    )


@dataclass(frozen=True, slots=True)
class _Clock:
    key: int  # the tag's own hash: its clock, its repeats and its noise all come from it
    period: int  # grid steps between two updates, on average
    phase: int  # the grid step modulo the period at which it updates
    meter: _Meter
    metric: str


@lru_cache(maxsize=None)
def _clock_of(seed: int, tag: str) -> _Clock:
    key = _mix(seed, _name_key(tag))
    period = PERIOD_STEPS[_mix(key, 1) % len(PERIOD_STEPS)]
    first, second, metric = tag.split("_", 2)  # PDUA01 _ PM0 _ A_L1: the metric keeps its own underscore
    return _Clock(key, period, _mix(key, 2) % period, _meter(seed, f"{first}_{second}"), metric)


def _update_step(clock_: _Clock, n: int) -> int:
    """The grid step of the tag's n-th update: n periods after the phase, one step late on half of them (the jitter), so two
    updates are 15 to 20 steps (60 to 80 s) apart and never closer."""
    return clock_.phase + n * clock_.period + (_mix(clock_.key, 4, n) & 1)


def _load(meter: _Meter, instant: float) -> float:
    return 1 + LOAD_SWING * math.sin(OMEGA * instant + meter.phase)


_PHASED = re.compile(r"(PL|SL|QL|A_THDL|A_L|VTHD_L|VL)([123])N?")


def _signal(meter: _Meter, metric: str, instant: float) -> float:
    """The noise-free value of a metric at an instant (seconds since 1970); `metric` is one of METER_SUFFIXES (or P for branches and incomers)."""
    power = meter.p0 * _load(meter, instant)
    pf = meter.pf + 0.01 * math.sin(OMEGA * 3 * instant + meter.phase)
    apparent = power / pf
    reactive = math.sqrt(max(apparent * apparent - power * power, 0.0))
    if metric == "PENRG":  # kWh: the integral of the load from the epoch, in closed form, so it only ever rises
        late = max(instant, COUNTER_EPOCH_S)
        swing = LOAD_SWING / OMEGA * (math.cos(OMEGA * COUNTER_EPOCH_S + meter.phase) - math.cos(OMEGA * late + meter.phase))
        return COUNTER_BASE_KWH + meter.p0 / 3600 * (late - COUNTER_EPOCH_S + swing)
    whole = {"P": power, "S": apparent, "Q": reactive, "PF": pf, "FQ": 50 + 0.04 * math.sin(OMEGA * 40 * instant + meter.phase)}
    if metric in whole:
        return whole[metric]
    found = _PHASED.fullmatch(metric)
    if found is None:
        raise ValueError(f"no live model for the metric {metric}")
    kind, index = found[1], int(found[2]) - 1
    share = meter.shares[index]
    volts = meter.v0 * (1 + 0.004 * math.sin(OMEGA * 5 * instant + meter.phase + index))
    ripple = 1 + 0.2 * math.sin(OMEGA * 2 * instant + meter.phase + index)
    return {
        "PL": power * share, "SL": apparent * share, "QL": reactive * share, "VL": volts, "A_L": power * share * 1000 / (volts * pf),
        "A_THDL": meter.thd_a * ripple, "VTHD_L": meter.thd_v * ripple,
    }[kind]


def sample(seed: int, tag: str, instant: float) -> tuple[float, float]:
    """(the value the tag shows, the instant of its latest update) at `instant`, both a pure function of the three arguments.

    The latest update is the tag's own: update n happens on the 4 s grid at phase + n * period (+ one step of jitter). The value
    changes only then; 24 percent of the updates repeat the previous value (a hash of the update decides, and a run of repeats is
    followed back to the update that last changed it). A value is the metric's smooth signal at the time of the update that last
    changed it, plus a little noise, rounded and narrowed to float32. The instant returned is on the grid and never ahead of `instant`."""
    tag_clock = _clock_of(seed, tag)
    step = math.floor(instant / GRID_S)
    n = (step - tag_clock.phase) // tag_clock.period
    if _update_step(tag_clock, n) > step:  # the jitter put this update one step later than the instant asked for
        n -= 1
    stamp = _update_step(tag_clock, n) * GRID_S
    changed = n
    for _ in range(MAX_REPEAT_RUN):
        if _uniform(tag_clock.key, 3, changed) >= REPEAT_SHARE:
            break
        changed -= 1  # this update repeated the one before it
    at = _update_step(tag_clock, changed) * GRID_S
    metric = tag_clock.metric
    number = _signal(tag_clock.meter, metric, at)
    wobble = 2 * _uniform(tag_clock.key, 5, changed) - 1  # -1 .. 1, new on every update that changes the value
    if metric == "PENRG":
        return float32(number), float(stamp)  # a counter has no noise: it only rises, in float32 steps
    if metric == "FQ":
        return float32(round(number + 0.01 * wobble, 4)), float(stamp)
    if metric == "PF":
        return float32(round(number + 0.004 * wobble, 4)), float(stamp)
    relative = 0.003 if metric.startswith("V") and "THD" not in metric else 0.01
    return float32(round(number * (1 + relative * wobble), 3)), float(stamp)


def value(seed: int, tag: str, instant: float) -> float:
    """The value of the tag at an instant: `sample(...)[0]`."""
    return sample(seed, tag, instant)[0]


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
        """The value the tag shows: `live=False` a constant, distinct per tag; `live=True` the value at the instant `clock()` gives
        now (the one a Read would answer, float32 widened to a double)."""
        if not self.config.live:
            return self._values[tag]
        if tag not in self._values:
            raise KeyError(tag)
        return value(self.config.seed, tag, clock())

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
                ua.NodeId(f"{CLUSTER}.{tag}", idx), ua.QualifiedName(tag, idx), self.value_of(tag),
                ua.VariantType.Float if self.config.live else ua.VariantType.Double,  # a Read of a live node is answered by `_live`
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
        answers = self._read_original(dataclasses.replace(params, NodesToRead=translated))
        return self._live(translated, answers) if self.config.live else answers

    def _live(self, nodes: list[ua.ReadValueId], answers: list[ua.DataValue]) -> list[ua.DataValue]:
        """Replace the Value of every cluster tag in a Read by the live one: a float32 Variant, `SourceTimestamp` on the tag's own update
        (the grid instant), `ServerTimestamp` the clock's now. The nodes are the translated ones, so a number that means another tag
        (restructure "by_index") reads that tag's live value. Anything else (another attribute, a bad answer) is left as it is."""
        instant = clock()
        server_time = datetime.fromtimestamp(instant, timezone.utc)
        live = list(answers)
        for position, (node, answer) in enumerate(zip(nodes, answers, strict=True)):
            identifier = node.NodeId.Identifier
            if node.AttributeId != ua.AttributeIds.Value or node.NodeId.NamespaceIndex != NAMESPACE_INDEX or not isinstance(identifier, str):
                continue
            tag = identifier.removeprefix(f"{CLUSTER}.")
            if tag == identifier or tag not in self._values or (answer.StatusCode_ is not None and not answer.StatusCode_.is_good()):
                continue
            number, stamp = sample(self.config.seed, tag, instant)
            live[position] = ua.DataValue(
                Value=ua.Variant(number, ua.VariantType.Float),
                SourceTimestamp=datetime.fromtimestamp(stamp, timezone.utc), ServerTimestamp=server_time,
            )
        return live

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
