"""The oracle: the live energy engine, pricing and day calculation against `tests/reference_engine.py` (today's code
as it was on main a62fce0), bit for bit, on seeded random worlds (w26).

The law of the wave: no digit of any answer may change, and no addition may change its place in the order. A parent's
PRICED hours are kept in first-appearance order (not bucket order) and Billing's day sums add them in that order; Python's
`sum()` is compensated and `+=` is not. So everything is compared as `repr` of every float (`-0.0` counts), every dict is
compared in ITERATION order, and the data is non-dyadic and of mixed magnitude (integer-valued data cannot tell `sum()`
from `+=`). Each side runs on its own classes: the rows, meters and tariffs of a world are plain tuples, turned into
`reference_engine.HourRow(*t)` for the oracle and `energy.HourRow(*t)` for the live code.
"""
import random
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from itertools import count
from types import SimpleNamespace

import pytest

import reference_engine as ref
from dcdash.core import cost, daycost, energy
from dcdash.core.timeutil import local_days
from dcdash.core.tree import AssetNode, AssetTree

WORLDS = 300  # per test function
UTC = timezone.utc
HOUR = timedelta(hours=1)
MAX_DEPTH = 6
NAMES = ("Feed A", "Feed B", "Panel", "Rack 1", "Rack 2", "Pump", "Hall")
ZONES = ("UTC", "Europe/London", "Europe/Berlin", "Europe/London", "Europe/Berlin", "Asia/Kolkata")
# Windows near the clock changes of 2026-03-29 and 2026-10-25 (23- and 25-hour local days), a month end and a year end.
BASES = (
    datetime(2026, 3, 27, tzinfo=UTC), datetime(2026, 10, 23, tzinfo=UTC), datetime(2026, 6, 10, tzinfo=UTC),
    datetime(2026, 1, 30, tzinfo=UTC), datetime(2026, 12, 30, tzinfo=UTC), datetime(2026, 3, 28, tzinfo=UTC),
    datetime(2026, 10, 24, tzinfo=UTC),
)

OLD = SimpleNamespace(name="oracle", energy=ref, cost=ref, daycost=ref)
NEW = SimpleNamespace(name="live", energy=energy, cost=cost, daycost=daycost)


# ---- the worlds ------------------------------------------------------------------------------------------------------


@dataclass
class World:
    seed: int
    family: str
    tree: AssetTree
    meters: dict[int, tuple[int, float, int, bool]]  # asset id -> (point id, scale, interval seconds, counter)
    rows: dict[int, list[tuple]]  # point id -> (bucket, min, max, sum, n, last, minutes), ascending
    baselines: dict[int, float]
    first_buckets: dict[int, datetime]
    span: tuple[datetime, datetime]  # the data window; the whole-hour buckets that begin in it carry the rows
    start: datetime | None  # what assemble is told (None = not given)
    end: datetime | None
    tariffs: list[tuple[int | None, float, date]]
    zone: str
    depth: int
    features: Counter = field(default_factory=Counter)


def fl(rng: random.Random) -> float:
    """A float that is not a dyadic rational, of mixed magnitude."""
    return rng.uniform(0.05, 9.99) * 10.0 ** rng.randint(-3, 3)


def hours_in(start: datetime, end: datetime) -> list[datetime]:
    bucket = start.replace(minute=0, second=0, microsecond=0)
    if bucket < start:
        bucket += HOUR
    out = []
    while bucket < end:
        out.append(bucket)
        bucket += HOUR
    return out


def gen_nodes(rng: random.Random, n: int, spine: int, hub: bool) -> list[AssetNode]:
    """`n` assets, ids in no particular order, names and sort orders that collide (ties fall to the id), depth up to 6;
    `spine` forces a chain of that many extra levels below the first root; `hub` piles children onto the first nodes."""
    ids = rng.sample(range(1, 5000), n)
    depth: dict[int, int] = {}
    kids: Counter = Counter()
    nodes: list[AssetNode] = []

    def add(asset_id: int, parent: int | None) -> None:
        nodes.append(AssetNode(asset_id, parent, rng.choice(NAMES), rng.choice((0, 0, 0, 1, 2, -1))))
        depth[asset_id] = 1 if parent is None else depth[parent] + 1
        if parent is not None:
            kids[parent] += 1

    add(ids[0], None)
    last, cursor = ids[0], 1
    for _ in range(spine):
        if cursor >= n:
            break
        add(ids[cursor], last)
        last, cursor = ids[cursor], cursor + 1
    for asset_id in ids[cursor:]:
        if rng.random() < 0.04:
            add(asset_id, None)  # a second root
            continue
        eligible = [a for a in depth if depth[a] < MAX_DEPTH and kids[a] < 12]
        if hub and rng.random() < 0.6:
            eligible = eligible[:3]
        add(asset_id, rng.choice(eligible))
    rng.shuffle(nodes)  # inserted in random order
    return nodes


def gap_nodes(rng: random.Random, deeper: bool) -> tuple[list[AssetNode], int]:
    """The review's C1 shape. A group P whose FIRST child (by sort order) will have gaps that a later child fills; with
    `deeper`, that first child is itself a group whose first child has gaps, so the grandparent's first child is unsorted.
    Returns the nodes and the id of the leaf that gets the gaps."""
    ids = iter(rng.sample(range(1, 5000), 80))
    nodes: list[AssetNode] = []

    def add(parent: int | None, sort: int | None = None) -> int:
        asset_id = next(ids)
        nodes.append(AssetNode(asset_id, parent, rng.choice(NAMES), rng.choice((0, 1, 2)) if sort is None else sort))
        return asset_id

    root = add(None, 0)
    group = add(root, -9)  # P: first under the root
    for _ in range(rng.randint(0, 2)):
        add(root)  # later siblings of P
    if deeper:
        first = add(group, -9)  # a group itself
        gapped = add(first, -9)
        for _ in range(rng.randint(2, 4)):
            add(first)
    else:
        gapped = add(group, -9)
    for _ in range(rng.randint(2, 6)):
        add(group)  # the later children that fill the gaps
    rng.shuffle(nodes)
    return nodes, gapped


def counter_values(rng: random.Random, value: float, feats: Counter) -> tuple[float, float, float]:
    """(min, max, last) of one counter hour that starts at `value`: a rise, a flat hour, a reset or a glitch."""
    rise = fl(rng)
    event = rng.random()
    if event < 0.04 and value > 10.0:  # a reset: the counter fell to near zero and climbed a little
        feats["reset"] += 1
        low = rng.uniform(0.0, 3.0)
        return low, value + rise * rng.random(), low + rng.uniform(0.0, 4.0)
    if event < 0.08:  # a glitch: one sample read 0, the last value recovered
        feats["glitch"] += 1
        return 0.0, value + rise, value + rise
    if event < 0.11:  # a flat hour
        return value, value, value
    low = value + rise * rng.random() * 0.5
    last = value + rise
    return low, last, last


def gen_rows(rng, hrs, counter, interval, pattern, base_value, feats):
    """The rows of one point over `hrs` under a pattern; returns (rows, value after the last row)."""
    if pattern == "silent":
        return [], base_value
    chosen = list(hrs)
    if pattern == "gaps":
        keep = rng.choice((0.9, 0.7, 0.4))
        chosen = [h for h in chosen if rng.random() < keep]
        if chosen and len(chosen) < len(hrs):
            feats["gappy"] += 1
    elif pattern == "late":
        chosen = chosen[rng.randint(1, max(1, len(chosen) // 2)):]
    elif pattern == "early":
        chosen = chosen[: rng.randint(1, max(1, len(chosen) // 2))]
    elif pattern == "single":
        chosen = [rng.choice(chosen)] if chosen else []
    rows: list[tuple] = []
    value = base_value
    for bucket in chosen:
        if counter:
            if value is None:
                value = rng.uniform(0.0, 1000.0) * 10.0 ** rng.randint(0, 3)
            low, high, last = counter_values(rng, value, feats)
            sum_value, n, minutes = fl(rng), rng.randint(1, 3600), rng.randint(1, 60)
            if not rows and base_value is None and rng.random() < 0.05:
                feats["neg_zero"] += 1
                low, high, last = 0.0, 0.0, -0.0  # last - min is -0.0
            row = (bucket, low, high, sum_value, n, last, minutes)
            value = last
        else:
            max_n = max(1, 3600 // interval)
            n = rng.randint(1, max_n + 2)
            if rng.random() < 0.05:
                n = rng.choice((0, 0, -1))
                feats["n_le_0"] += 1
            kw = fl(rng) * (-1 if rng.random() < 0.03 else 1)
            sum_value = kw * max(n, 1) if rng.random() < 0.9 else fl(rng) * max(n, 1)
            if rng.random() < 0.02:
                feats["neg_zero"] += 1
                kw, sum_value = -0.0, -0.0
            minutes = rng.choice((60, 60, 30, rng.randint(0, 60)))
            row = (bucket, kw * 0.9, kw * 1.1, sum_value, n, kw, minutes)
        rows.append(row)
        if rng.random() < 0.04:  # the same bucket twice
            feats["duplicate_bucket"] += 1
            rows.append(row)
    return rows, value


def gen_world(seed: int, family: str = "general") -> World:
    rng = random.Random(seed)
    feats: Counter = Counter()
    # the window
    base = rng.choice(BASES)
    start = base + timedelta(hours=rng.randint(0, 30))
    end = start + timedelta(hours=rng.choice((3, 6, 24, 30, 48, 72, 96, 140)))
    if rng.random() < 0.3:
        start += timedelta(minutes=rng.choice((15, 30, 45)))
        feats["offhour_start"] += 1
    if rng.random() < 0.3:
        end += timedelta(minutes=rng.choice((15, 30, 45)))
        feats["offhour_end"] += 1
    hrs = hours_in(start, end)
    given = rng.choice(("both", "both", "both", "neither", "start", "end"))
    # the tree
    gapped = None
    if family == "gaps":
        nodes, gapped = gap_nodes(rng, deeper=bool(seed % 2))
    else:
        nodes = gen_nodes(rng, rng.choice((3, 5, 8, 12, 20, 30, 45, 70, 120)), spine=rng.choice((0, 0, 3, 5)), hub=rng.random() < 0.3)
    tree = AssetTree(nodes)
    depth = max(len(tree.ancestors_or_self(a)) for a in tree.nodes)
    # the meters and their rows
    pids = count(100)
    meters: dict[int, tuple[int, float, int, bool]] = {}
    rows: dict[int, list[tuple]] = {}
    baselines: dict[int, float] = {}
    first_buckets: dict[int, datetime] = {}
    for asset_id in tree.preorder():
        leaf = not tree.children(asset_id)
        if asset_id != gapped and rng.random() > (0.85 if leaf else 0.15):
            feats["unmetered_leaf" if leaf else "unmetered_parent"] += 1
            continue
        if not leaf:
            feats["own_parent"] += 1
        counter = rng.random() < 0.65
        interval = rng.choice((1, 5, 60, 900))
        point = next(pids)
        meters[asset_id] = (point, rng.choice((1.0, 1.0, 0.001, 3.7)), interval, counter)
        if asset_id == gapped:
            pattern = rng.choice(("gaps", "gaps", "gaps", "silent", "late"))
            feats["gap_first_" + pattern] += 1
        else:
            pattern = rng.choice(("dense", "dense", "dense", "gaps", "gaps", "late", "early", "silent", "single"))
        baseline_value = None
        before = rng.random() < 0.35
        if counter and before and pattern != "silent":
            baseline_value = rng.uniform(1.0, 5000.0)
        point_rows, _ = gen_rows(rng, hrs, counter, interval, pattern, baseline_value, feats)
        if point_rows:
            rows[point] = point_rows
        if not hrs:
            continue
        if point_rows:
            if before:  # the point existed before the window began
                first_buckets[point] = hrs[0] - HOUR * rng.randint(1, 400)
                feats["first_before"] += 1
                if counter and baseline_value is not None:
                    baselines[point] = baseline_value
            else:
                first_buckets[point] = point_rows[0][0]
                feats["first_inside"] += 1
            if rng.random() < 0.04:  # a first bucket that disagrees with the rows
                first_buckets[point] = point_rows[0][0] + HOUR * rng.randint(1, 5)
                feats["first_mismatch"] += 1
        else:
            mode = rng.choice(("never", "never", "before", "after"))
            feats[("silent_counter_" if counter else "silent_power_") + mode] += 1
            if mode == "before":
                first_buckets[point] = hrs[0] - HOUR * rng.randint(1, 400)
                if counter:
                    baselines[point] = rng.uniform(1.0, 5000.0)
            elif mode == "after":
                first_buckets[point] = hrs[-1] + HOUR * rng.randint(1, 50)
    # the tariffs
    local_start = start.date()
    tariffs: list[tuple[int | None, float, date]] = []
    kind = rng.random()
    if kind < 0.85:
        tariffs.append((None, rng.choice((0.12, 0.15, 0.0833, fl(rng) / 100)), date(2020, 1, 1)))
    elif kind < 0.95:
        tariffs.append((None, rng.choice((0.12, 0.2)), local_start + timedelta(days=rng.randint(0, 3))))  # starts mid-window
    if rng.random() < 0.5:
        tariffs.append((None, rng.choice((0.15, 0.31, fl(rng) / 100)), local_start + timedelta(days=rng.randint(-1, 4))))
    for _ in range(rng.choice((0, 0, 1, 2, 3))):
        owner = rng.choice(list(tree.nodes))
        tariffs.append((owner, rng.choice((0.2, 0.0, fl(rng) / 100)), local_start + timedelta(days=rng.randint(-5, 4))))
    if tariffs and rng.random() < 0.1:
        tariffs.append((tariffs[0][0], 0.99, tariffs[0][2]))  # a tie on the same date: the first row wins
    rng.shuffle(tariffs)
    world = World(
        seed, family, tree, meters, rows, baselines, first_buckets, (start, end),
        start if given in ("both", "start") else None, end if given in ("both", "end") else None,
        tariffs, rng.choice(ZONES), depth, feats,
    )
    if world.start is None:
        feats["no_start"] += 1
    if world.end is None:
        feats["no_end"] += 1
    if depth >= MAX_DEPTH:
        feats["depth6"] += 1
    return world


# ---- one world through one side's engine -------------------------------------------------------------------------------


def run_energy(world: World, side) -> object:
    meters = {a: side.energy.Meter(*m) for a, m in world.meters.items()}
    rows = {p: [side.energy.HourRow(*t) for t in ts] for p, ts in world.rows.items()}
    return side.energy.assemble(
        world.tree, meters, rows, dict(world.baselines), start=world.start, end=world.end,
        first_buckets=dict(world.first_buckets),
    )


def run_cost(world: World, side, result) -> tuple[dict, list]:
    tariffs = [side.cost.TariffRow(*t) for t in world.tariffs]
    return side.cost.cost_by_hour(result, tariffs, world.tree, world.zone), tariffs


def nows(world: World) -> list[datetime]:
    first, last = world.span
    return [last + timedelta(days=1), first + (last - first) / 2, first - HOUR]


def run_days(world: World, side, priced: dict, tariffs: list, now: datetime) -> dict:
    days = local_days(world.span[0], world.span[1], world.zone)
    out = {}
    for asset_id, hours in priced.items():
        def rate_on(day: date, asset_id: int = asset_id) -> bool:
            return side.cost.rate_at(tariffs, world.tree, asset_id, day) is not None

        out[asset_id] = side.daycost.day_entries(hours, days, now=now, rate_on=rate_on)
    return out


def slices(world: World, priced: dict) -> list[tuple[int, datetime, datetime, bool]]:
    """Window slices (asset, from, to, rate_in_effect) chosen from the world alone, the same for both sides."""
    rng = random.Random(world.seed ^ 0x5EED)
    first, last = world.span
    out = []
    for asset_id in priced:
        if priced[asset_id] is not None and rng.random() < 0.3:
            a = first + HOUR * rng.randint(-2, 40)
            out.append((asset_id, a, a + HOUR * rng.randint(0, 60), rng.random() < 0.5))
    return out


def run_summaries(side, priced: dict, cuts) -> list:
    out = []
    for asset_id, a, b, in_effect in cuts:
        hours = [h for bucket, h in priced[asset_id].items() if a <= bucket < b]  # dict order, as the callers do
        out.append((asset_id, side.cost.summarize(hours, rate_in_effect=in_effect), side.cost.no_data(hours)))
    return out


# ---- canonical forms: plain tuples, repr of every float, dicts in iteration order -------------------------------------------


def canon_energy(result) -> tuple:
    return (
        tuple(
            (asset_id, None if hours is None else tuple((b.isoformat(), repr(h.kwh), repr(h.estimated), repr(h.has_data)) for b, h in hours.items()))
            for asset_id, hours in result.hours.items()
        ),
        tuple(sorted(result.own)),
        tuple((asset_id, b.isoformat()) for asset_id, b in result.own_from.items()),
    )


def canon_totals(side, result) -> tuple:
    out = []
    for asset_id, hours in result.hours.items():
        figure = side.energy.total(hours)
        out.append((asset_id, None if figure is None else (repr(figure.kwh), repr(figure.estimated))))
    return tuple(out)


def canon_priced(priced: dict) -> tuple:
    return tuple(
        (
            asset_id,
            None if hours is None else tuple(
                (b.isoformat(), repr(h.kwh), repr(h.cost), repr(h.estimated), repr(h.unpriced), repr(h.has_data))
                for b, h in hours.items()
            ),
        )
        for asset_id, hours in priced.items()
    )


def canon_entries(entries: dict) -> tuple:
    return tuple(
        (asset_id, tuple(None if e is None else tuple((k, repr(v)) for k, v in e.items()) for e in day_list))
        for asset_id, day_list in entries.items()
    )


def canon_summaries(summaries: list) -> tuple:
    return tuple(
        (asset_id, repr(c.kwh), repr(c.cost), repr(c.estimated), repr(c.partial), repr(no_data))
        for asset_id, c, no_data in summaries
    )


def same(world: World, what: str, old: tuple, new: tuple) -> None:
    if old == new:
        return
    if len(old) != len(new):
        pytest.fail(f"seed {world.seed} ({world.family}): {what}: {len(old)} entries in the oracle, {len(new)} in the live code")
    for position, (a, b) in enumerate(zip(old, new)):
        if a != b:
            pytest.fail(f"seed {world.seed} ({world.family}): {what}: entry {position} differs\n  oracle {a!r:.600}\n  live   {b!r:.600}")


# ---- the tests -------------------------------------------------------------------------------------------------------------


def test_assemble_and_total_match_the_oracle():
    for seed in range(WORLDS):
        world = gen_world(seed)
        old, new = run_energy(world, OLD), run_energy(world, NEW)
        same(world, "assemble", canon_energy(old), canon_energy(new))
        same(world, "total", canon_totals(OLD, old), canon_totals(NEW, new))


def test_assemble_matches_the_oracle_when_a_later_child_fills_the_gaps_of_the_first():
    for seed in range(1000, 1000 + WORLDS):
        world = gen_world(seed, "gaps")
        old, new = run_energy(world, OLD), run_energy(world, NEW)
        same(world, "assemble", canon_energy(old), canon_energy(new))
        same(world, "total", canon_totals(OLD, old), canon_totals(NEW, new))


@pytest.mark.parametrize("family, first_seed", [("general", 2000), ("gaps", 3000)])
def test_cost_by_hour_matches_the_oracle_including_the_order_of_every_key(family, first_seed):
    for seed in range(first_seed, first_seed + WORLDS):
        world = gen_world(seed, family)
        old_result, new_result = run_energy(world, OLD), run_energy(world, NEW)
        old_priced, _ = run_cost(world, OLD, old_result)
        new_priced, _ = run_cost(world, NEW, new_result)
        same(world, "priced hours (keys in order)", canon_priced(old_priced), canon_priced(new_priced))


@pytest.mark.parametrize("family, first_seed", [("general", 4000), ("gaps", 5000)])
def test_day_entries_match_the_oracle_for_the_local_days_of_the_window(family, first_seed):
    for seed in range(first_seed, first_seed + WORLDS):
        world = gen_world(seed, family)
        old_priced, old_tariffs = run_cost(world, OLD, run_energy(world, OLD))
        new_priced, new_tariffs = run_cost(world, NEW, run_energy(world, NEW))
        for now in nows(world):
            old = run_days(world, OLD, old_priced, old_tariffs, now)
            new = run_days(world, NEW, new_priced, new_tariffs, now)
            same(world, f"day entries at now={now.isoformat()}", canon_entries(old), canon_entries(new))


def test_summarize_of_window_slices_matches_the_oracle():
    for seed in range(6000, 6000 + WORLDS):
        world = gen_world(seed)
        old_priced, _ = run_cost(world, OLD, run_energy(world, OLD))
        new_priced, _ = run_cost(world, NEW, run_energy(world, NEW))
        cuts = slices(world, old_priced)
        same(world, "summarize", canon_summaries(run_summaries(OLD, old_priced, cuts)), canon_summaries(run_summaries(NEW, new_priced, cuts)))


def test_the_same_seed_gives_the_same_world():
    # The generator shuffles the nodes it hands to the tree; a failing seed must reproduce.
    first, second = gen_world(7), gen_world(7)
    assert canon_energy(run_energy(first, OLD)) == canon_energy(run_energy(second, OLD))
    assert first.tariffs == second.tariffs and first.rows == second.rows


# ---- the harness has teeth -----------------------------------------------------------------------------------------------


def bucket_order_entries(side, hours, days, now, rate_on):
    """What Billing would show if a parent's hours were added in bucket order instead of the engine's order."""
    return side.daycost.day_entries(None if hours is None else dict(sorted(hours.items())), days, now=now, rate_on=rate_on)


def test_the_worlds_can_tell_a_changed_order_a_changed_sum_and_a_reordered_day_apart():
    unsorted_parents = sum_differs = order_differs = deepest = 0
    reordered_entries = compensated_entries = 0
    features: Counter = Counter()
    for seed in range(WORLDS):
        world = gen_world(7000 + seed, "gaps" if seed % 2 else "general")
        features.update(world.features)
        deepest = max(deepest, world.depth)
        priced, tariffs = run_cost(world, OLD, run_energy(world, OLD))
        days = local_days(world.span[0], world.span[1], world.zone)
        now = world.span[1] + timedelta(days=1)
        starts = [first for _, first, _ in days]
        for asset_id, hours in priced.items():
            if hours is None:
                continue
            if world.tree.children(asset_id) and list(hours) != sorted(hours):
                unsorted_parents += 1
            per_day = OLD.daycost.split_by_day(hours, starts, days[-1][2])
            per_day_sorted = OLD.daycost.split_by_day(dict(sorted(hours.items())), starts, days[-1][2])
            for day_hours, sorted_hours in zip(per_day, per_day_sorted):
                plain = 0.0
                for h in day_hours:
                    plain += h.kwh
                if repr(plain) != repr(sum((h.kwh for h in day_hours), 0.0)):
                    sum_differs += 1
                in_bucket_order = 0.0
                for h in sorted_hours:
                    in_bucket_order += h.kwh
                if repr(plain) != repr(in_bucket_order):
                    order_differs += 1

            def rate_on(day: date, asset_id: int = asset_id) -> bool:
                return ref.rate_at(tariffs, world.tree, asset_id, day) is not None

            engine_entries = ref.day_entries(hours, days, now=now, rate_on=rate_on)
            if canon_entries({asset_id: engine_entries}) != canon_entries({asset_id: bucket_order_entries(OLD, hours, days, now, rate_on)}):
                reordered_entries += 1
            compensated = [
                None if e is None else {**e, "kwh": sum((h.kwh for h in day), 0.0)}
                for e, day in zip(engine_entries, ref.split_by_day(hours, starts, days[-1][2]))
            ]
            if canon_entries({asset_id: engine_entries}) != canon_entries({asset_id: compensated}):
                compensated_entries += 1
    assert deepest == MAX_DEPTH
    assert unsorted_parents > 20, "no parent's priced hours were out of bucket order: the generator cannot see the C1 failure"
    assert sum_differs > 20, "sum() and += never differed: the data cannot tell a compensated sum from a plain one"
    assert order_differs > 20, "adding a day in bucket order never changed a digit: the data cannot see a reordered fold"
    assert reordered_entries > 10 and compensated_entries > 10  # and the comparison of day entries sees both
    for feature in (
        "reset", "glitch", "neg_zero", "n_le_0", "duplicate_bucket", "own_parent", "unmetered_leaf", "unmetered_parent",
        "first_before", "first_inside", "first_mismatch", "silent_counter_never", "silent_counter_before", "silent_counter_after",
        "silent_power_never", "silent_power_before", "silent_power_after", "gappy", "offhour_start", "offhour_end",
        "no_start", "no_end", "depth6", "gap_first_gaps", "gap_first_silent", "gap_first_late",
    ):
        assert features[feature] > 5, f"the generator hardly ever makes '{feature}' ({features[feature]})"


def test_the_world_families_cover_the_rate_and_zone_cases():
    zones, with_override, with_change, starts_mid_window, no_site_rate = set(), 0, 0, 0, 0
    for seed in range(WORLDS):
        world = gen_world(8000 + seed)
        zones.add(world.zone)
        owners = [t[0] for t in world.tariffs]
        with_override += any(o is not None for o in owners)
        with_change += sum(o is None for o in owners) > 1
        starts_mid_window += any(o is None and t[2] > world.span[0].date() for o, t in zip(owners, world.tariffs))
        no_site_rate += not any(o is None for o in owners)
    assert zones == {"UTC", "Europe/London", "Europe/Berlin", "Asia/Kolkata"}
    assert min(with_override, with_change, starts_mid_window) > 20 and no_site_rate > 0
