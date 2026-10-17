"""The "pilot hall": a made-up data-centre tree for a DEV or SCRATCH stack, so the demo and later waves have something to look at.

    python -m dcdash.seed.history --layout pilot-hall        # arrives with a later task of wave w16

This part is only the LAYOUT: what the tree looks like, which racks are busy, idle, single-fed or empty, and which meter sits on
which asset. Everything here is synthetic and generic ("Hall 1", "Pod A", "Row 1", "Rack 01", "Feed A", "Panel 1A"); no name comes
from a real site. The layout is a pure function of a seed (one `random.Random(seed)`, no clock, no database), and the module does
nothing on its own: importing it writes nothing and reads nothing. The series (the readings of every meter) is the second part of
this file, also pure; the writer, the dry run and the command line are added by a later task (4).

The tree, with its keys (a key is a unique label in this module, not a path):
  - the Site "Seeded pilot hall" (`site`) > Hall 1, Hall 2 (`h1`, `h2`) > Pod A, Pod B (`h1/pa`, `h1/pb`) > Row 1 to Row 4 of each
    hall (`h1/row1`; Rows 1 and 2 belong to Pod A, Rows 3 and 4 to Pod B) > racks (`h1/r01`; numbered across the hall, Hall 1 has
    Rack 01 to 59 and Hall 2 Rack 01 to 58, 117 in all) > Feed A and Feed B (`h1/r01/a`, `h1/r01/b`);
  - beside the halls, "Electrical" (`elec`, listed after them) > Panel 1A to Panel 4B (`elec/p1a`; the number is the pod across the
    site, the letter the feed). A panel is mapped only to voltage and current, never to energy, so the Site does not count the same
    kWh twice (the energy of a pod is the energy of its racks).
Variety, with the counts fixed and the choice of racks moved by the seed: 6 free racks (Feed A and Feed B exist, nothing is metered),
6 idle racks (a fraction of a kW), 5 single-feed racks (only Feed A, carrying everything) and the rest live (2 to 11 kW). A live
rack shares its load about half and half between the feeds. Eight of the Hall 2 B feeds report power instead of an energy counter
(so the engine has to estimate them), one Hall 1 Feed A counter has a gap in its samples and another one resets once.
"""
import math
import random
import re
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo

from dcdash.core.metrics import Metric, unit_for
from dcdash.seed import history

ROOT_NAME = "Seeded pilot hall"
SOURCE_NAME = "seeded-pilot-hall"
ELECTRICAL_NAME = "Electrical"
INTERVAL_CHOICES = history.INTERVAL_CHOICES
DEFAULT_INTERVAL_MINUTES = 60  # the sample spacing; the measurement of the real run (task 5) sets this

RACKS_PER_ROW = ((15, 15, 14, 15), (15, 15, 13, 15))  # Hall 1, Hall 2: the racks of Row 1 to Row 4, 117 in all
FREE_RACKS = 6
IDLE_RACKS = 6
SINGLE_FEED_RACKS = 5
POWER_ONLY_FEEDS = 8  # B feeds of live Hall 2 racks that report power, not an energy counter


@dataclass(frozen=True)
class Node:
    key: str  # unique in the layout, e.g. "site", "h1", "h1/pa", "h1/row1", "h1/r01", "h1/r01/a", "elec", "elec/p1a"
    parent: str | None
    name: str
    role: str  # "site" | "hall" | "pod" | "row" | "rack" | "feed" | "electrical" | "panel"
    sort_order: int = 0


@dataclass(frozen=True)
class Rack:
    node: str
    hall: int
    status: str  # "live" | "free" | "idle" | "single"
    kw: float  # the rack's load; 0 for a free rack
    share_a: float  # the part of the load that Feed A carries
    feeds: tuple[str, ...]  # the keys of its Feed assets: two, or one for a single-feed rack


@dataclass(frozen=True)
class Meter:
    node: str
    metric: Metric
    kind: str  # "counter" | "power" | "voltage" | "current"
    counter_base: float | None = None  # where an energy counter starts
    resets: bool = False  # the counter drops back to near zero once
    gap: bool = False  # the counter has a hole in its samples
    feeds: tuple[str, ...] = ()  # for a current meter: the feed nodes whose power it carries

    @property
    def id(self) -> str:
        return f"{self.node}|{self.metric.value}"


@dataclass(frozen=True)
class Layout:
    seed: int
    nodes: tuple[Node, ...]  # parents before children, depth first
    racks: tuple[Rack, ...]  # in tree order
    meters: tuple[Meter, ...]  # the feeds' meters in tree order, then the panels' (voltage, current)


def build_layout(seed: int = history.DEFAULT_SEED) -> Layout:
    rng = random.Random(seed)
    slots = _slots()
    total = len(slots)

    # which racks are free, idle and single-fed: shuffle every rack index once, then take the first of the list
    order = list(range(total))
    rng.shuffle(order)
    status = {index: "live" for index in range(total)}
    for position, index in enumerate(order):
        if position < FREE_RACKS:
            status[index] = "free"
        elif position < FREE_RACKS + IDLE_RACKS:
            status[index] = "idle"
        elif position < FREE_RACKS + IDLE_RACKS + SINGLE_FEED_RACKS:
            status[index] = "single"

    racks: list[Rack] = []
    for index, (hall, row, number) in enumerate(slots):
        key = f"h{hall}/r{number:02d}"
        state = status[index]
        if state == "free":
            kw, share_a = 0.0, 0.5
        elif state == "idle":
            kw = round(rng.uniform(0.15, 0.45), 2)
            share_a = round(0.5 + rng.uniform(-0.05, 0.05), 3)
        elif state == "single":
            kw, share_a = round(rng.uniform(2.0, 11.0), 2), 1.0
        else:
            kw = round(rng.uniform(2.0, 11.0), 2)
            share_a = round(0.5 + rng.uniform(-0.05, 0.05), 3)
        feeds = (f"{key}/a",) if state == "single" else (f"{key}/a", f"{key}/b")
        racks.append(Rack(key, hall, state, kw, share_a, feeds))

    nodes, rack_pod = _nodes(slots, racks)

    # the selections, before any counter base is drawn, so the random stream is fixed
    live_hall_2 = sorted(i for i, rack in enumerate(racks) if rack.status == "live" and rack.hall == 2)
    live_hall_1 = [i for i, rack in enumerate(racks) if rack.status == "live" and rack.hall == 1]
    power_only = set(rng.sample(live_hall_2, POWER_ONLY_FEEDS))
    gap_at, reset_at = rng.sample(live_hall_1, 2)

    meters: list[Meter] = []
    for index, rack in enumerate(racks):
        if rack.status == "free":
            continue
        for feed in rack.feeds:
            is_a = feed.endswith("/a")
            if not is_a and index in power_only:
                meters.append(Meter(feed, Metric.ACTIVE_POWER_KW, "power"))
            else:
                base = round(rng.uniform(2000, 90000), 3)
                meters.append(
                    Meter(feed, Metric.ENERGY_KWH, "counter", base, resets=is_a and index == reset_at, gap=is_a and index == gap_at)
                )

    metered = {meter.node for meter in meters}
    for hall in (1, 2):
        for pod in ("a", "b"):
            number = (hall - 1) * 2 + (1 if pod == "a" else 2)
            for letter in ("a", "b"):
                panel = f"elec/p{number}{letter}"
                carried = tuple(
                    feed
                    for rack in racks
                    if rack_pod[rack.node] == f"h{hall}/p{pod}"
                    for feed in rack.feeds
                    if feed.endswith("/" + letter) and feed in metered
                )
                meters.append(Meter(panel, Metric.VOLTAGE_V, "voltage"))
                meters.append(Meter(panel, Metric.CURRENT_A, "current", feeds=carried))

    return Layout(seed, tuple(nodes), tuple(racks), tuple(meters))


def _slots() -> list[tuple[int, int, int]]:
    """(hall, row in the hall, rack number in the hall) of every rack, in tree order."""
    slots: list[tuple[int, int, int]] = []
    for hall, counts in enumerate(RACKS_PER_ROW, start=1):
        number = 0
        for row, count in enumerate(counts, start=1):
            for _ in range(count):
                number += 1
                slots.append((hall, row, number))
    return slots


def _nodes(slots: list[tuple[int, int, int]], racks: list[Rack]) -> tuple[list[Node], dict[str, str]]:
    """The nodes in tree order (a rack right before its feeds), and the key of the pod each rack sits in."""
    in_row: dict[tuple[int, int], list[Rack]] = {}
    for (hall, row, _number), rack in zip(slots, racks):
        in_row.setdefault((hall, row), []).append(rack)
    nodes = [Node("site", None, ROOT_NAME, "site")]
    rack_pod: dict[str, str] = {}
    for hall in (1, 2):
        nodes.append(Node(f"h{hall}", "site", f"Hall {hall}", "hall"))
        for pod, rows in (("a", (1, 2)), ("b", (3, 4))):
            pod_key = f"h{hall}/p{pod}"
            nodes.append(Node(pod_key, f"h{hall}", f"Pod {pod.upper()}", "pod"))
            for row in rows:
                row_key = f"h{hall}/row{row}"
                nodes.append(Node(row_key, pod_key, f"Row {row}", "row"))
                for rack in in_row[(hall, row)]:
                    rack_pod[rack.node] = pod_key
                    nodes.append(Node(rack.node, row_key, f"Rack {rack.node[-2:]}", "rack"))
                    for feed in rack.feeds:
                        nodes.append(Node(feed, rack.node, f"Feed {feed[-1].upper()}", "feed"))
    nodes.append(Node("elec", "site", ELECTRICAL_NAME, "electrical", sort_order=1))  # after the halls in the list
    for number in range(1, 5):
        for letter in ("a", "b"):
            nodes.append(Node(f"elec/p{number}{letter}", "elec", f"Panel {number}{letter.upper()}", "panel"))
    return nodes, rack_pod


def sibling_key(name: str) -> str:
    """The Python twin of the database's sibling-name key: collapse white space, trim, lower-case."""
    return re.sub(r"\s+", " ", name).strip().lower()


def path(layout: Layout, key: str) -> str:
    """The names from the root down to the node, joined with " / " (for point names)."""
    by_key = {node.key: node for node in layout.nodes}
    names: list[str] = []
    current: str | None = key
    while current is not None:
        names.append(by_key[current].name)
        current = by_key[current].parent
    return " / ".join(reversed(names))


def unit(meter: Meter) -> str:
    return unit_for(meter.metric, None)


def point_address(meter: Meter) -> str:
    return f"seed/pilot/{meter.node}/{meter.metric.value}"


# ---- the series: the readings of every meter, pure ------------------------------------------------------------------------

NOMINAL_VOLTS = 400.0  # a panel's line voltage, +-1 % around it
VOLTAGE_JITTER = 0.01
POWER_FACTOR = 0.95  # for the panel current: I = P / (sqrt(3) x V x 0.95)


def curve(load_kw: float) -> float:
    """The part of a rack's rated load that is drawn at a moment, 0.86 (night) to 1.0 (peak): the old seeder's daily curve
    (`history.base_kw`, 20 to 80 kW) scaled down to a gentle swing, since a rack's draw hardly follows the hall's schedule."""
    return 0.86 + 0.14 * (load_kw - 20) / 60


def samples(plan: history.Plan, layout: Layout) -> Iterator[tuple[datetime, dict[str, float]]]:
    """One item per instant of the plan: (instant, {meter id: value}) for the meters that are sampled at that instant.

    A counter is a running sum of the power: value[i+1] = value[i] + power[i] x step. The jitter is on the power, so a counter
    never ticks down by chance; the one reset drops it to near zero once, and the gap meter keeps counting through its hole without
    emitting. The random draws are the same with or without a gap: one per feed meter per instant, then one per panel voltage."""
    rng = random.Random(plan.seed)
    zone = ZoneInfo(plan.tz)
    step_hours = plan.step_seconds / 3600
    feed_of = {feed: (rack, feed[-1]) for rack in layout.racks for feed in rack.feeds}  # feed key -> (its rack, "a" or "b")
    counters = {meter.id: meter.counter_base for meter in layout.meters if meter.kind == "counter"}
    for index, ts in enumerate(plan.times()):
        factor = curve(history.base_kw(ts, zone))
        values: dict[str, float] = {}
        power_of: dict[str, float] = {}  # the true power of each feed now, also of the one that is not sampled
        volts_of: dict[str, float] = {}  # the voltage sample of each panel now, for its current
        for meter in layout.meters:
            if meter.kind in ("counter", "power"):
                rack, letter = feed_of[meter.node]
                share = rack.share_a if letter == "a" else 1 - rack.share_a
                power = rack.kw * share * factor * (1 + rng.uniform(-history.JITTER, history.JITTER))
                power_of[meter.node] = power
                if meter.kind == "power":
                    values[meter.id] = round(power, 3)
                    continue
                if meter.resets and index == plan.reset_index:
                    counters[meter.id] = rng.uniform(0.1, 1.0)  # the meter restarted
                if not (meter.gap and plan.in_gap(ts)):
                    values[meter.id] = round(counters[meter.id], 3)
                counters[meter.id] += power * step_hours
            elif meter.kind == "voltage":
                volts_of[meter.node] = round(NOMINAL_VOLTS * (1 + rng.uniform(-VOLTAGE_JITTER, VOLTAGE_JITTER)), 1)
                values[meter.id] = volts_of[meter.node]
            else:  # "current": the panel's voltage meter comes right before it in the layout
                carried = sum(power_of[feed] for feed in meter.feeds)
                values[meter.id] = round(carried * 1000 / (math.sqrt(3) * volts_of[meter.node] * POWER_FACTOR), 2)
        yield ts, values


def readings_by_day(plan: history.Plan, layout: Layout) -> Iterator[tuple[date, list[tuple[str, datetime, float]]]]:
    """The samples grouped by UTC day, oldest day first, as (meter id, instant, value) rows: one day in memory at a time."""
    day: date | None = None
    rows: list[tuple[str, datetime, float]] = []
    for ts, values in samples(plan, layout):
        if day is not None and ts.date() != day:
            yield day, rows
            rows = []
        day = ts.date()
        rows.extend((meter_id, ts, value) for meter_id, value in values.items())
    if day is not None:
        yield day, rows
