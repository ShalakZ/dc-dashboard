"""The "pilot hall": a made-up data-centre tree for a DEV or SCRATCH stack, so the demo and later waves have something to look at.

    python -m dcdash.seed.history --layout pilot-hall                       # prints the plan, writes nothing
    DCDASH_ALLOW_SEED_HISTORY=1 python -m dcdash.seed.history --layout pilot-hall --yes
    DCDASH_ALLOW_SEED_HISTORY=1 python -m dcdash.seed.history --layout pilot-hall --metering panels [--panel-unit kw] --yes

The first part is the LAYOUT: what the tree looks like, which racks are busy, idle, single-fed or empty, and which meter sits on
which asset. Everything here is synthetic and generic ("Hall 1", "Pod A", "Row 1", "Rack 01", "Feed A", "Panel 1A"); no name comes
from a real site. The layout is a pure function of a seed (one `random.Random(seed)`, no clock, no database), and the module does
nothing on its own: importing it writes nothing and reads nothing. The series (the readings of every meter) is the second part of
this file, also pure. The third part writes them: the kinds the assets get, the rows, and the run. It borrows the old seeder's
machinery (the plan, the pending-drop check, the batch writer, the rollup refresh and the undo) through the `history` module, so
the two switches, the raw-retention clamp and the clean-up of a failed run are the same as for the default layout.

The tree, with its keys (a key is a unique label in this module, not a path):
  - the Site "Seeded pilot hall" (`site`) > Hall 1, Hall 2 (`h1`, `h2`) > Pod A, Pod B (`h1/pa`, `h1/pb`) > Row 1 to Row 4 of each
    hall (`h1/row1`; Rows 1 and 2 belong to Pod A, Rows 3 and 4 to Pod B) > racks (`h1/r01`; numbered across the hall, Hall 1 has
    Rack 01 to 59 and Hall 2 Rack 01 to 58, 117 in all) > Feed A and Feed B (`h1/r01/a`, `h1/r01/b`);
  - beside the halls, "Electrical" (`elec`, listed after them) > Panel 1A to Panel 4B (`elec/p1a`; the number is the pod across the
    site, the letter the feed). By default (`--metering feeds`) a panel is mapped only to voltage and current, never to energy, so
    the Site does not count the same kWh twice (the energy of a pod is the energy of its racks).
Variety, with the counts fixed and the choice of racks moved by the seed: 6 free racks (Feed A and Feed B exist, nothing is metered),
6 idle racks (a fraction of a kW), 5 single-feed racks (only Feed A, carrying everything) and the rest live (2 to 11 kW). A live
rack shares its load about half and half between the feeds. Eight of the Hall 2 B feeds report power instead of an energy counter
(so the engine has to estimate them), one Hall 1 Feed A counter has a gap in its samples and another one resets once.

Every feed that has an energy counter also reports its power: a second meter on the same feed, the counter's "kW twin" (an
`active_power_kw` point next to the `energy_kwh` one). It reads the very power the counter integrates and draws no random number of
its own, and a gap applies to both of them. The engine takes the energy counter over the power mapping of the same asset, so no
energy figure changes and the 8 power-only feeds are still the only estimated ones; what the twins give is a live power that adds
up at every level (rack, row, pod, hall, Site) and a kW trend on every feed. That makes 442 points: 209 counters, their 209 twins,
8 power-only feeds and 16 panel meters.

`--metering panels` is the "just the panels for now" case: the same tree and the same load, but ONE measured level. Each of the 8
panels gets an energy meter that carries the energy of the feeds it already carries a current for (`--panel-unit kwh`, the default:
an `energy_kwh` counter; `--panel-unit kw`: an `active_power_kw` point only, so the engine estimates the energy and flags it `~`),
and the feeds and racks get no meter at all (feeds and panels both metered would put the same energy in the Site total twice, since
the panels sit beside the halls). That makes 24 points: 8 panel energy meters, 8 voltages and 8 currents. The feeds' power is still
drawn inside the generator, with the same random stream as the default mode (the "hidden" meters of the layout, which are never
written), so the panels carry exactly the sum of what their feeds would have shown; a panel has no gap and no reset.

The load of every feed also moves with the local day (`day_factor`, 0.95 to 1.05), so a month of Billing does not read as one day
repeated.
"""
import argparse
import asyncio
import math
import random
import re
import sys
import time
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo

import asyncpg
from pydantic import AnyHttpUrl

from dcdash.api.asset_names import _KEY, ASSET_NAMES_LOCK  # the one definition of "the same sibling name"
from dcdash.connectors.base import GOOD
from dcdash.connectors.simulator import SimulatorConfig
from dcdash.core.asset_kinds import kind_key
from dcdash.core.metrics import Metric, unit_for
from dcdash.core.pg import create_pool
from dcdash.core.timeutil import validate_whole_hour_zone
from dcdash.seed import history

ROOT_NAME = "Seeded pilot hall"
SOURCE_NAME = "seeded-pilot-hall"
ELECTRICAL_NAME = "Electrical"
UNDO = 'delete the "Seeded pilot hall" asset and the source "seeded-pilot-hall" with the normal deletes (Assets Tree and Sources)'
INTERVAL_CHOICES = history.INTERVAL_CHOICES
METERING_CHOICES = history.METERING_CHOICES  # "feeds" (default) | "panels"
PANEL_UNIT_CHOICES = history.PANEL_UNIT_CHOICES  # "kwh" (default) | "kw"; only with metering "panels"
DEFAULT_INTERVAL_MINUTES = 30  # measured on the scratch stack (w16 task 5): 442 points, so about 1,000,000 readings over a full month at 30 minutes and twice that at 15

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
    # "counter" | "power" | "voltage" | "current" | "panel_counter" | "panel_power"; a "power" meter is a power-only feed OR the kW
    # twin of a counter; the two "panel_" kinds exist only with `--metering panels`: the energy counter (kWh) or the power-only point
    # (kW) of a panel, carrying the feeds in `feeds`
    kind: str
    counter_base: float | None = None  # where an energy counter starts (never set on a twin)
    resets: bool = False  # the counter drops back to near zero once (never set on a twin)
    gap: bool = False  # the counter has a hole in its samples; its kW twin has the same flag, so the hole is in both
    feeds: tuple[str, ...] = ()  # for a current or a panel energy meter: the feed nodes whose power it carries

    @property
    def id(self) -> str:
        return f"{self.node}|{self.metric.value}"


@dataclass(frozen=True)
class Layout:
    seed: int
    nodes: tuple[Node, ...]  # parents before children, depth first
    racks: tuple[Rack, ...]  # in tree order
    # the meters that are written. With the default `--metering feeds`: the feeds' meters in tree order (a counter is followed at
    # once by its kW twin on the same node; a power-only feed has one meter), 426 of them, then the panels' (voltage, current), 16:
    # 442 in all. With `--metering panels`: for each panel its voltage, its current and its energy meter, 24 in all.
    meters: tuple[Meter, ...]
    metering: str = "feeds"  # "feeds" | "panels"
    panel_unit: str = "kwh"  # "kwh" | "kw"; only meaningful with metering "panels"
    # the feeds' meters of the default layout when they are NOT written (metering "panels"), else empty: `samples` still runs
    # them, in front of `meters`, so the feeds' power (and the random stream) is exactly the default mode's, but emits nothing for them
    hidden: tuple[Meter, ...] = ()


def build_layout(seed: int = history.DEFAULT_SEED, metering: str = "feeds", panel_unit: str = "kwh") -> Layout:
    if metering not in METERING_CHOICES or panel_unit not in PANEL_UNIT_CHOICES:
        raise ValueError(f"metering must be one of {METERING_CHOICES} and panel_unit one of {PANEL_UNIT_CHOICES}")
    if panel_unit == "kw" and metering == "feeds":
        raise ValueError("panel_unit kw needs metering panels (with metering feeds the panels carry no energy)")
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
                has_gap = is_a and index == gap_at
                meters.append(Meter(feed, Metric.ENERGY_KWH, "counter", base, resets=is_a and index == reset_at, gap=has_gap))
                meters.append(Meter(feed, Metric.ACTIVE_POWER_KW, "power", gap=has_gap))  # its kW twin: draws no random number

    metered = {meter.node for meter in meters}  # the feeds of the DEFAULT layout that are metered, whatever the metering mode
    panel_meters: list[Meter] = []
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
                panel_meters.append(Meter(panel, Metric.VOLTAGE_V, "voltage"))
                panel_meters.append(Meter(panel, Metric.CURRENT_A, "current", feeds=carried))
                if metering == "panels" and panel_unit == "kwh":  # the base is drawn after every other layout draw
                    base = round(rng.uniform(2000, 90000), 3)
                    panel_meters.append(Meter(panel, Metric.ENERGY_KWH, "panel_counter", base, feeds=carried))
                elif metering == "panels":
                    panel_meters.append(Meter(panel, Metric.ACTIVE_POWER_KW, "panel_power", feeds=carried))

    if metering == "feeds":
        return Layout(seed, tuple(nodes), tuple(racks), tuple(meters + panel_meters))
    return Layout(seed, tuple(nodes), tuple(racks), tuple(panel_meters), metering, panel_unit, hidden=tuple(meters))


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


def day_factor(day: date, seed: int) -> float:
    """How busy a local day is compared with the curve alone, 0.95 to 1.05: a made-up but repeatable number per day and seed, so the
    days of a month are not copies of each other. A string seed is the same in every process (an int-and-date hash would not be)."""
    return 0.95 + 0.10 * random.Random(f"{seed}:{day.isoformat()}").random()


def samples(plan: history.Plan, layout: Layout) -> Iterator[tuple[datetime, dict[str, float]]]:
    """One item per instant of the plan: (instant, {meter id: value}) for the meters that are sampled at that instant.

    A counter is a running sum of the power: value[i+1] = value[i] + power[i] x step. The jitter is on the power, so a counter
    never ticks down by chance; the one reset drops it to near zero once, and the gap meter keeps counting through its hole without
    emitting. The power of a feed is its rack's load x its share x the daily curve x the factor of the local day x the jitter.
    The random draws are the same with or without a gap: one per feed (a counter or a power-only meter) per instant, then one per
    panel voltage. A kW twin draws nothing: it reads the power its counter has just integrated (and has the counter's hole).

    With `--metering panels` the feeds' meters are the layout's `hidden` ones: they run first, exactly as in the default mode (the
    same draws in the same order, the reset's included), so every number is the default mode's, but they emit nothing. A panel's
    energy meter reads the sum of the true power of the feeds it carries: its counter integrates it, its kW point is it; it draws
    nothing."""
    rng = random.Random(plan.seed)
    zone = ZoneInfo(plan.tz)
    step_hours = plan.step_seconds / 3600
    feed_of = {feed: (rack, feed[-1]) for rack in layout.racks for feed in rack.feeds}  # feed key -> (its rack, "a" or "b")
    running = (*layout.hidden, *layout.meters)  # the hidden feeds first: they are before the panels in the default layout too
    hidden_ids = [meter.id for meter in layout.hidden]
    counters = {meter.id: meter.counter_base for meter in running if meter.kind in ("counter", "panel_counter")}
    day_factors: dict[date, float] = {}
    for index, ts in enumerate(plan.times()):
        factor = curve(history.base_kw(ts, zone))
        local_day = ts.astimezone(zone).date()
        if local_day not in day_factors:
            day_factors[local_day] = day_factor(local_day, plan.seed)
        factor *= day_factors[local_day]
        values: dict[str, float] = {}
        power_of: dict[str, float] = {}  # the true power of each feed now, also of the one that is not sampled
        volts_of: dict[str, float] = {}  # the voltage sample of each panel now, for its current
        for meter in running:
            if meter.kind in ("counter", "power"):
                if meter.kind == "power" and meter.node in power_of:  # a kW twin: the power its counter integrates, no new draw
                    power = power_of[meter.node]
                else:
                    rack, letter = feed_of[meter.node]
                    share = rack.share_a if letter == "a" else 1 - rack.share_a
                    power = rack.kw * share * factor * (1 + rng.uniform(-history.JITTER, history.JITTER))
                    power_of[meter.node] = power
                if meter.kind == "power":
                    if not (meter.gap and plan.in_gap(ts)):
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
            elif meter.kind == "current":  # the panel's voltage meter comes right before it in the layout
                carried = sum(power_of[feed] for feed in meter.feeds)
                values[meter.id] = round(carried * 1000 / (math.sqrt(3) * volts_of[meter.node] * POWER_FACTOR), 2)
            else:  # "panel_counter" | "panel_power": the energy of the feeds the panel carries (its current is right before it)
                carried = sum(power_of[feed] for feed in meter.feeds)
                if meter.kind == "panel_power":
                    values[meter.id] = round(carried, 3)
                else:
                    values[meter.id] = round(counters[meter.id], 3)
                    counters[meter.id] += carried * step_hours
        for meter_id in hidden_ids:  # run for their power and their draws, never written
            values.pop(meter_id, None)
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


# ---- the kinds the assets get ---------------------------------------------------------------------------------------------

# What each role would like to be called, best first. The seeder registers NO kind: a role takes the first of these that the Asset
# kinds list (`asset_kinds`) holds, else "Other equipment" if the list holds that, else its first name, which is then flagged as
# not registered (an asset's kind is free text, so the tree is still made; it only shows the default icon).
PREFERRED_KINDS: dict[str, tuple[str, ...]] = {
    "site": ("Site",),
    "hall": ("Data hall", "Room"),
    "pod": ("Room",),
    "row": ("Row",),
    "rack": ("Rack",),
    "feed": ("Circuit", "Meter"),
    "electrical": ("Room",),
    "panel": ("Panel",),
}
FALLBACK_KIND = "Other equipment"
NOT_REGISTERED = "(not in the Asset kinds list)"  # what the dry run says of a role whose kind the registry does not hold
ROLE_LABELS = {  # the plural (or not) the report prints for a role
    "site": "site", "hall": "halls", "pod": "pods", "row": "rows", "rack": "racks", "feed": "feeds", "electrical": "electrical",
    "panel": "panels",
}


@dataclass(frozen=True)
class KindChoice:
    name: str  # the kind text the assets of the role get
    registered: bool  # False: the Asset kinds list does not hold it
    preferred: str  # the role's first choice, whatever was picked


def choose_kinds(registered: set[str]) -> dict[str, KindChoice]:
    """The kind of every role. `registered` holds `kind_key(name)` values, the `key` column of `asset_kinds`. Pure."""
    chosen: dict[str, KindChoice] = {}
    for role, names in PREFERRED_KINDS.items():
        name = next((candidate for candidate in names if kind_key(candidate) in registered), None)
        if name is None and kind_key(FALLBACK_KIND) in registered:
            name = FALLBACK_KIND
        chosen[role] = KindChoice(name, True, names[0]) if name is not None else KindChoice(names[0], False, names[0])
    return chosen


async def registered_kinds(pool: asyncpg.Pool) -> set[str]:
    return {row["key"] for row in await pool.fetch("SELECT key FROM asset_kinds")}


# ---- the database ---------------------------------------------------------------------------------------------------------


async def _refusal(conn: asyncpg.Connection) -> str | None:
    """Why this layout cannot be made here, or None. Only THIS layout's own rows count: the other layout's never refuse."""
    source = await conn.fetchval("SELECT id FROM sources WHERE name = $1", SOURCE_NAME)
    if source is not None:
        return f'a source named "{SOURCE_NAME}" already exists (id {source}); a seed was made here before. To undo it, {UNDO}'
    twin = await conn.fetchval(
        f"SELECT id FROM assets WHERE parent_id IS NULL AND {_KEY.format('name')} = {_KEY.format('CAST($1 AS text)')} ORDER BY id LIMIT 1",
        ROOT_NAME,
    )
    if twin is not None:
        return f'a top-level asset named "{ROOT_NAME}" already exists (id {twin}); delete it first (the source "{SOURCE_NAME}" is gone)'
    return None


async def create_rows(
    pool: asyncpg.Pool, layout: Layout, kinds: dict[str, KindChoice], step_seconds: int
) -> history.Created:
    """The source, assets, points and mappings, in ONE transaction: if anything fails nothing is left behind. The assets are made
    one by one in node order (a parent before its children), so each child gets its parent's id."""
    # A valid simulator config that points nowhere: .invalid never resolves, and the source is disabled anyway.
    config = SimulatorConfig(url=AnyHttpUrl("http://seeded-pilot-hall.invalid:9000")).model_dump(mode="json")
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock($1)", ASSET_NAMES_LOCK)  # as every route that creates an asset
        reason = await _refusal(conn)
        if reason is not None:
            raise history.Refused(reason)
        try:
            source_id = await conn.fetchval(
                "INSERT INTO sources (name, connector_type, config, enabled, origin) "
                "VALUES ($1, 'simulator', $2, false, 'manual') RETURNING id",
                SOURCE_NAME, config,
            )
        except asyncpg.UniqueViolationError:
            raise history.Refused(f'a source named "{SOURCE_NAME}" was created a moment ago by someone else') from None
        asset_ids: dict[str, int] = {}
        for node in layout.nodes:
            asset_ids[node.key] = await conn.fetchval(
                "INSERT INTO assets (parent_id, name, kind, sort_order) VALUES ($1, $2, $3, $4) RETURNING id",
                None if node.parent is None else asset_ids[node.parent], node.name, kinds[node.role].name, node.sort_order,
            )
        point_ids: dict[str, int] = {}
        for meter in layout.meters:
            point_ids[meter.id] = await conn.fetchval(
                "INSERT INTO points (source_id, address, name, data_type, unit_hint) VALUES ($1, $2, $3, 'float', $4) RETURNING id",
                source_id, point_address(meter), f"{path(layout, meter.node)} {meter.metric.value}", unit(meter),
            )
            await conn.execute(
                "INSERT INTO mappings (point_id, asset_id, metric, scale, interval_seconds) VALUES ($1, $2, $3, 1.0, $4)",
                point_ids[meter.id], asset_ids[meter.node], meter.metric.value, step_seconds,
            )
    return history.Created(source_id, asset_ids["site"], asset_ids, point_ids)


# ---- the command ----------------------------------------------------------------------------------------------------------

PROGRESS_EVERY_DAYS = 5
BATCH_ROWS = 50_000  # a batch is at most this many rows: a UTC day at the 5-minute step is up to 442 x 288 = 127,296, and the
# Writer drops what does not fit its buffer of 100,000


def _batches(
    plan: history.Plan, layout: Layout, point_ids: dict[str, int], total_days: int
) -> Iterator[tuple[date, list[history.Row]]]:
    """The UTC days as `history.write_batches` takes them, with meter ids turned into point ids, each day cut into slices of at
    most BATCH_ROWS rows (a small day is one batch). The writer asks for the next batch only after it has written the one before,
    so a progress line printed when a day is asked for (or when the days run out) says how many days are really in the database;
    it counts days, never slices."""
    done = 0
    for day, rows in readings_by_day(plan, layout):
        if done and done % PROGRESS_EVERY_DAYS == 0:
            print(f"written {done} of {total_days} days", flush=True)
        for start in range(0, len(rows), BATCH_ROWS):
            yield day, [(point_ids[meter_id], ts, value, GOOD) for meter_id, ts, value in rows[start:start + BATCH_ROWS]]
        done += 1
    if done and done % PROGRESS_EVERY_DAYS == 0:
        print(f"written {done} of {total_days} days", flush=True)


def _power_only(layout: Layout) -> list[Meter]:
    """The feeds that report kW and have no energy counter (a kW twin sits on a node that has a counter)."""
    counted = {meter.node for meter in layout.meters if meter.kind == "counter"}
    return [meter for meter in layout.meters if meter.kind == "power" and meter.node not in counted]


def _kinds_summary(kinds: dict[str, KindChoice]) -> str:
    """Every role with the kind its assets get, in the order of `choose_kinds`; a role that fell back says what it wanted."""
    return ", ".join(
        f'{role} "{choice.name}"' + (f' (preferred "{choice.preferred}")' if choice.name != choice.preferred else "")
        for role, choice in kinds.items()
    )


def _zone_warning(tz: str) -> str | None:
    """The sentence the dry run and the report print when Billing cannot work in the site's time zone, else None."""
    try:
        validate_whole_hour_zone(tz)
    except ValueError as exc:
        return f"warning   Billing cannot use this site time zone ({exc}); the figures will not show until it is changed"
    return None


def _by_role(layout: Layout) -> str:
    by_role = Counter(node.role for node in layout.nodes)
    return ", ".join(f"{ROLE_LABELS[role]} {by_role[role]}" for role in PREFERRED_KINDS)


def _preferred_kinds() -> dict[str, KindChoice]:
    """The kinds a run would use if the Asset kinds list were not read: every role's first preferred name."""
    return choose_kinds({kind_key(names[0]) for names in PREFERRED_KINDS.values()})


def _layout_lines(layout: Layout, kinds: dict[str, KindChoice], known: bool, step_seconds: int) -> list[str]:
    """What the dry run says about the tree, whatever the range is. `known` is False when the Asset kinds list was not read."""
    by_status = Counter(rack.status for rack in layout.racks)
    by_kind = Counter(meter.kind for meter in layout.meters)
    lines = [
        f'source   "{SOURCE_NAME}" (simulator, DISABLED: nothing ever polls it)',
        f"assets   {len(layout.nodes)} ({_by_role(layout)})",
    ]
    for role, choice in kinds.items():
        line = f'kinds    {role} "{choice.name}"'
        if known and not choice.registered:
            line += f" {NOT_REGISTERED}"
        elif choice.name != choice.preferred:
            line += f' (preferred "{choice.preferred}")'
        lines.append(line)
    if layout.metering == "panels":
        lines.append(
            f"racks    {len(layout.racks)} ({by_status['live']} live, {by_status['idle']} idle, {by_status['single']} single-feed "
            f"with Feed A only, {by_status['free']} free); the feeds and racks carry no meter in this mode"
        )
        lines.append(f"metering {_metering_text(layout)}")
        energy = (
            f"{by_kind['panel_counter']} panel energy counters (kWh)" if layout.panel_unit == "kwh"
            else f"{by_kind['panel_power']} panel power points (kW)"
        )
        lines.append(
            f"points   {len(layout.meters)}, each mapped with an interval of {step_seconds} seconds: {energy}, "
            f"{by_kind['voltage']} panel voltages (V) and {by_kind['current']} panel currents (A)"
        )
        return lines
    lines.append(
        f"racks    {len(layout.racks)} ({by_status['live']} live, {by_status['idle']} idle, {by_status['single']} single-feed "
        f"with Feed A only, {by_status['free']} free with no readings)"
    )
    lines.append(
        f"points   {len(layout.meters)}, each mapped with an interval of {step_seconds} seconds: {by_kind['counter']} energy "
        f"counters (kWh) each with a power point (kW), {len(_power_only(layout))} power-only feeds (kW), {by_kind['voltage']} "
        f"panel voltages (V) and {by_kind['current']} panel currents (A)"
    )
    return lines


def _metering_text(layout: Layout) -> str:
    """What the dry run and the report say of `--metering panels` (the default mode says nothing of its own)."""
    if layout.panel_unit == "kwh":
        what = "an energy counter (kWh) that carries the energy of the feeds it has a current for"
    else:
        what = "a power point (kW) only, so its energy is estimated and shown with ~"
    panels = sum(1 for meter in layout.meters if meter.kind == "voltage")
    return (
        f"panels (--panel-unit {layout.panel_unit}): each of the {panels} panels has {what}; no feed has "
        "an energy or power point, so there is one measured level, a breakdown by Panel shows figures and one by Rack shows no data"
    )


def _plan_lines(layout: Layout, plan: history.Plan) -> list[str]:
    """What the dry run says about the range and the series. The reading count is arithmetic: the series is never generated."""
    tz = plan.tz
    gap_instants = 0 if plan.gap is None else int((plan.gap[1] - plan.gap[0]) / plan.step)
    gap_missing = gap_instants * sum(1 for meter in layout.meters if meter.gap)  # the gap feed's counter AND its kW twin
    lines = [
        f"range    {history._local(plan.start, tz)} to {history._local(plan.end, tz)} in {tz}"
        + ("" if tz == "UTC" else f" ({plan.start:%Y-%m-%d %H:%M} to {plan.end:%Y-%m-%d %H:%M} UTC)")
        + f", one sample every {plan.step_seconds // 60} minutes"
    ]
    if plan.clamped:
        lines.append(
            f"clamped  the range would start at {history._local(plan.wanted_start, tz)} but the raw retention is "
            f"{plan.raw_retention_days} days, so it starts no earlier than {plan.raw_retention_days - 1} days back"
        )
    lines.append(
        f"readings {len(layout.meters) * plan.count - gap_missing} ({len(layout.meters)} points x {plan.count} samples"
        + (f", minus {gap_missing} in the gap)" if gap_missing else ")")
    )
    power_only = _power_only(layout)
    if layout.metering == "panels" and layout.panel_unit == "kw":
        lines.append(
            f"power    {sum(1 for meter in layout.meters if meter.kind == 'panel_power')} panels report kW instead of a kWh counter, "
            "so their energy is estimated and Electrical, the Site and the totals above them show ~"
        )
    if power_only:
        hall_of = {feed: rack.hall for rack in layout.racks for feed in rack.feeds}
        halls = ", ".join(f"Hall {hall}" for hall in sorted({hall_of[meter.node] for meter in power_only}))
        lines.append(
            f"power    {len(power_only)} feeds (all in {halls}) report kW instead of a kWh counter, so their energy is estimated "
            "and the racks, halls, the Site and the totals above them show ~"
        )
    if plan.gap is None:
        lines.append("gap      none (the range holds no complete day)")
    elif layout.metering == "panels":
        lines.append("gap      none (a panel meter has no gap in this mode)")
    else:
        gap_meter = next(meter for meter in layout.meters if meter.gap)
        lines.append(
            f"gap      {path(layout, gap_meter.node)} has no samples from {history._local(plan.gap[0], tz)} "
            f"to {history._local(plan.gap[1], tz)}"
        )
    if layout.metering == "panels":
        lines.append("reset    none (a panel meter never resets in this mode)")
        return lines
    reset_meter = next(meter for meter in layout.meters if meter.resets)
    lines.append(
        f"reset    the counter of {path(layout, reset_meter.node)} drops back to near zero at {history._local(plan.reset_at, tz)}"
    )
    return lines


def _layout_of(args: argparse.Namespace) -> Layout:
    """The layout the command line asks for (the parser has already refused `--panel-unit kw` without `--metering panels`)."""
    return build_layout(args.seed, getattr(args, "metering", None) or "feeds", getattr(args, "panel_unit", None) or "kwh")


async def dry_run(args: argparse.Namespace) -> int:
    """Print what a real run would make and whether it would be refused. Writes nothing and exits 0 whatever it finds."""
    tz, retention = history._default_timezone(), history.FACTORY_STORAGE_SETTINGS.raw_retention_days
    step_seconds = (args.interval_minutes or DEFAULT_INTERVAL_MINUTES) * 60
    layout = _layout_of(args)
    registered: set[str] | None = None
    refusal = exc_name = None
    pool = None
    try:
        pool = await asyncio.wait_for(create_pool(), 5)
        tz, retention = await history.site_timezone(pool), await history.raw_retention_days(pool)
        registered = await registered_kinds(pool)
        async with pool.acquire() as conn:
            refusal = await _refusal(conn)
    except Exception as exc:  # no database here: the plan is still worth showing
        exc_name, registered, refusal = type(exc).__name__, None, None
        if pool is not None:
            await pool.close()
            pool = None
    kinds = _preferred_kinds() if registered is None else choose_kinds(registered)
    print("Dry run: the seeder would create the following. Nothing written.")
    problem = None
    try:
        for line in _layout_lines(layout, kinds, registered is not None, step_seconds):
            print(f"  would create  {line}")
        plan = history.make_plan(history._now(), tz, args.days, args.seed, retention, step_seconds=step_seconds)
        for line in _plan_lines(layout, plan):
            print(f"  would create  {line}")
        zone_warning = _zone_warning(tz)  # known now, not after the readings are written
        if zone_warning is not None:
            print(f"  {zone_warning}")
        if pool is not None:
            problem = await history.pending_drop(pool, plan)
    except history.Refused as refused:
        problem = str(refused)
    finally:
        if pool is not None:
            await pool.close()
    if exc_name is not None:
        preferred = ", ".join(f"{role} {choice.name}" for role, choice in kinds.items())
        print(
            f"  (the database was not read: {exc_name}; kinds not read, the preferred kinds would be used: {preferred}; "
            f"using the time zone {tz})"
        )
    if refusal is not None:
        print(f"  A real run would be refused: {refusal}.")
    if problem is not None:
        print(f"  A real run would be refused: {problem}.")
    print(f"To do it, run again with --yes and {history.SWITCH}=1 in the environment.")
    print(
        "Set a site rate in Tariffs to see costs. A run takes one to several minutes, longer on a slow laptop (the rollups are "
        "rebuilt over the whole range); "
        "--days N or a larger --interval-minutes makes it faster."
    )
    return 0


async def seed(args: argparse.Namespace) -> int:
    pool = await create_pool()
    try:
        tz = await history.site_timezone(pool)
        step_seconds = (args.interval_minutes or DEFAULT_INTERVAL_MINUTES) * 60
        try:
            plan = history.make_plan(
                history._now(), tz, args.days, args.seed, await history.raw_retention_days(pool), step_seconds=step_seconds
            )
            problem = await history.pending_drop(pool, plan)
            if problem is not None:
                raise history.Refused(problem)
            layout = _layout_of(args)
            kinds = choose_kinds(await registered_kinds(pool))
            created = await create_rows(pool, layout, kinds, step_seconds)
        except history.Refused as refused:
            print(f"Refused, nothing written: {refused}", file=sys.stderr)
            return 1
        total_days = len({ts.date() for ts in plan.times()})
        started = time.monotonic()
        try:
            readings = await history.write_batches(pool, _batches(plan, layout, created.point_ids, total_days))
            written = time.monotonic()
            await history.refresh_rollups(pool, plan)
            refreshed = time.monotonic()
        except BaseException as exc:
            await history._undo(pool, plan, created, undo=UNDO)
            if not isinstance(exc, Exception):
                raise
            print(f"Failed, and what it had made was removed: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        print("Seeded pilot hall created.")
        print(f'  source    "{SOURCE_NAME}" id {created.source_id} (disabled)')
        print(f'  root      "{ROOT_NAME}" id {created.root_id}')
        print(f"  assets    {len(layout.nodes)} ({_by_role(layout)})")
        print(f"  points    {len(layout.meters)}")
        if layout.metering == "panels":
            print(f"  metering  {_metering_text(layout)}")
        print(f"  kinds     {_kinds_summary(kinds)}")
        print(
            f"  range     {history._local(plan.start, tz)} to {history._local(plan.end, tz)} in {tz}"
            + (" (clamped to the raw retention)" if plan.clamped else "")
        )
        print(f"  interval  {step_seconds // 60} minutes")
        for role, choice in kinds.items():
            if not choice.registered:
                print(f'  kind "{choice.name}" for {role} is not in the Asset kinds list (preferred "{choice.preferred}")')
        print(f"  readings  {readings}")
        print(f"  took {written - started:.1f} s writing, {refreshed - written:.1f} s refreshing the rollups")
        zone_warning = _zone_warning(tz)
        if zone_warning is not None:
            print(f"  {zone_warning}")
        print("  Set a site rate in Tariffs to see costs.")
        print(f"To undo it: {UNDO}.")
        return 0
    finally:
        await pool.close()
