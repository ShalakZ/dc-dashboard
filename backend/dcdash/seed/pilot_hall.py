"""The "pilot hall": a made-up data-centre tree for a DEV or SCRATCH stack, so the demo and later waves have something to look at.

    python -m dcdash.seed.history --layout pilot-hall                       # prints the plan, writes nothing
    DCDASH_ALLOW_SEED_HISTORY=1 python -m dcdash.seed.history --layout pilot-hall --yes

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
    site, the letter the feed). A panel is mapped only to voltage and current, never to energy, so the Site does not count the same
    kWh twice (the energy of a pod is the energy of its racks).
Variety, with the counts fixed and the choice of racks moved by the seed: 6 free racks (Feed A and Feed B exist, nothing is metered),
6 idle racks (a fraction of a kW), 5 single-feed racks (only Feed A, carrying everything) and the rest live (2 to 11 kW). A live
rack shares its load about half and half between the feeds. Eight of the Hall 2 B feeds report power instead of an energy counter
(so the engine has to estimate them), one Hall 1 Feed A counter has a gap in its samples and another one resets once.
"""
import argparse
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


def _batches(
    plan: history.Plan, layout: Layout, point_ids: dict[str, int], total_days: int
) -> Iterator[tuple[date, list[history.Row]]]:
    """The UTC days as `history.write_batches` takes them, with meter ids turned into point ids. The writer asks for the next day
    only after it has written the one before, so a progress line printed when a day is asked for (or when the days run out) says
    how many days are really in the database."""
    done = 0
    for day, rows in readings_by_day(plan, layout):
        if done and done % PROGRESS_EVERY_DAYS == 0:
            print(f"written {done} of {total_days} days", flush=True)
        yield day, [(point_ids[meter_id], ts, value, GOOD) for meter_id, ts, value in rows]
        done += 1
    if done and done % PROGRESS_EVERY_DAYS == 0:
        print(f"written {done} of {total_days} days", flush=True)


async def dry_run(args: argparse.Namespace) -> int:
    print("Dry run: the pilot-hall dry run arrives with task 4b. Nothing written.")
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
            layout = build_layout(args.seed)
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
        by_role = Counter(node.role for node in layout.nodes)
        print("Seeded pilot hall created.")
        print(f'  source    "{SOURCE_NAME}" id {created.source_id} (disabled)')
        print(f'  root      "{ROOT_NAME}" id {created.root_id}')
        print(f"  assets    {len(layout.nodes)} (" + ", ".join(f"{ROLE_LABELS[role]} {by_role[role]}" for role in PREFERRED_KINDS) + ")")
        print(f"  points    {len(layout.meters)}")
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
        try:
            validate_whole_hour_zone(tz)
        except ValueError as exc:
            print(f"  warning   Billing cannot use this site time zone ({exc}); the figures will not show until it is changed")
        print("  Set a site rate in Tariffs to see costs.")
        print(f"To undo it: {UNDO}.")
        return 0
    finally:
        await pool.close()
