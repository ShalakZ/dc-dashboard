"""The lossless ledger codec (w26b): a stored value comes back bit for bit, and equal values give equal canonical bytes.

No database. The values are built by the PURE builders of `core/figures.py` on the random worlds of the engine oracle (the same
worlds `test_figures.py` uses), then sent through `encode` / `decode_*` and compared by a STRICT deep comparison (`same`): exact
types (float/int/bool/None, tuple/list), the key order of every dict that has one, the tzinfo kind and key and `fold` of every
datetime, `-0.0` told from `0.0`, the observable structure of the tree (nodes as a mapping by id, `preorder`, `roots`,
`children`). A test at the top shows the comparison does see each of those differences, so the round trips below are not vacuous.
"""
import dataclasses
import json
import math
import random
import re
import zlib
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from dcdash.core import figures
from dcdash.core import ledger_codec as codec
from dcdash.core.cost import TariffRow
from dcdash.core.energy import Meter
from dcdash.core.month_check import MeterInput, build_report
from dcdash.core.timeutil import local_days, month_bounds
from dcdash.core.tree import AssetNode, AssetTree
from test_engine_oracle import gen_world
from test_figures import live_inputs, whole_hours
from test_month_check import crow, prow

UTC = timezone.utc
HOUR = timedelta(hours=1)
NAN, INF = float("nan"), float("inf")


# ---- the strict deep comparison ----------------------------------------------------------------------------------------------------


def tz_kind(tz) -> tuple:
    if tz is UTC:
        return ("utc",)
    if type(tz) is ZoneInfo:
        return ("zone", tz.key)
    return ("other", repr(tz))


def same(a, b, path: str = "value") -> None:
    """Assert `a` and `b` are the same value in every way the engine, an equality test or a JSON response could tell apart."""
    assert type(a) is type(b), f"{path}: {type(a).__name__} is not {type(b).__name__}"
    kind = type(a)
    if kind is float:
        if math.isnan(a):
            # On purpose: a NaN comes back a NaN, its sign is not kept (the module docstring says so; no reachable output shows it).
            assert math.isnan(b), f"{path}: nan is not {b!r}"
        else:
            assert a == b and math.copysign(1.0, a) == math.copysign(1.0, b), f"{path}: {a!r} is not {b!r}"
    elif a is None or kind in (bool, int, str, date):
        assert a == b, f"{path}: {a!r} is not {b!r}"
    elif kind in (list, tuple):
        assert len(a) == len(b), f"{path}: length {len(a)} is not {len(b)}"
        for index, (x, y) in enumerate(zip(a, b)):
            same(x, y, f"{path}[{index}]")
    elif kind is dict:
        assert list(a) == list(b), f"{path}: key order {list(a)[:6]} is not {list(b)[:6]}"
        for key in a:
            same(a[key], b[key], f"{path}[{key!r}]")
    elif kind is frozenset:
        assert a == b, f"{path}: {sorted(a)} is not {sorted(b)}"
    elif kind is datetime:
        fields = lambda d: (d.year, d.month, d.day, d.hour, d.minute, d.second, d.microsecond, d.fold)  # noqa: E731
        assert tz_kind(a.tzinfo) == tz_kind(b.tzinfo), f"{path}: tzinfo {tz_kind(a.tzinfo)} is not {tz_kind(b.tzinfo)}"
        assert fields(a) == fields(b) and a == b, f"{path}: {a!r} is not {b!r}"
    elif kind is AssetTree:
        same_tree(a, b, path)
    elif dataclasses.is_dataclass(a):
        for field in dataclasses.fields(a):
            same(getattr(a, field.name), getattr(b, field.name), f"{path}.{field.name}")
    else:
        raise AssertionError(f"{path}: the comparison does not know a {kind.__name__}")


def same_tree(a: AssetTree, b: AssetTree, path: str) -> None:
    """The tree as every reader sees it. The dict order of `nodes` is NOT part of it (it is the heap order of the table)."""
    assert sorted(a.nodes) == sorted(b.nodes), f"{path}: other asset ids"
    for asset_id in a.nodes:
        same(a.nodes[asset_id], b.nodes[asset_id], f"{path}.nodes[{asset_id}]")
    assert a.roots() == b.roots(), f"{path}: roots"
    assert a.preorder() == b.preorder(), f"{path}: preorder"
    for asset_id in a.nodes:
        assert a.children(asset_id) == b.children(asset_id), f"{path}: children of {asset_id}"


def differs(a, b) -> bool:
    try:
        same(a, b)
    except AssertionError:
        return True
    return False


def test_the_strict_comparison_sees_what_the_round_trips_must_not_lose():
    entry = {"kwh": 1.0, "cost": None, "estimated": False, "partial": False, "no_data": False}
    assert differs(1, 1.0) and differs(True, 1) and differs(0.0, -0.0) and differs((1, 2), [1, 2]) and differs(1.0, 1.0000000000000002)
    assert differs(NAN, 1.0) and not differs(NAN, float("nan")) and not differs(-0.0, -0.0)
    assert differs(entry, dict(reversed(list(entry.items())))) and not differs(entry, dict(entry))
    assert differs({1: [], 2: []}, {2: [], 1: []}) and differs(frozenset({1}), frozenset({2}))
    start = datetime(2026, 10, 25, 1, 30, tzinfo=ZoneInfo("Europe/London"))
    assert differs(start, start.replace(fold=1)) and differs(start, start.astimezone(UTC))
    assert differs(datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 1, 1, tzinfo=ZoneInfo("UTC")))
    assert differs(datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 1, 1, tzinfo=UTC).replace(microsecond=1))
    tree = AssetTree([AssetNode(1, None, "A", 0), AssetNode(2, 1, "B", 0)])
    assert not differs(tree, AssetTree([AssetNode(2, 1, "B", 0), AssetNode(1, None, "A", 0)]))  # dict order is not observable
    assert differs(tree, AssetTree([AssetNode(1, None, "A", 0), AssetNode(2, 1, "C", 0)]))
    assert differs(tree, AssetTree([AssetNode(1, None, "A", 0), AssetNode(2, None, "B", 0)]))
    assert differs(tree, AssetTree([AssetNode(1, None, "A", 1), AssetNode(2, 1, "B", 0)]))


# ---- random worlds -----------------------------------------------------------------------------------------------------------------


def month_days_of(world, seed: int) -> figures.MonthDays:
    meters, read, tariffs = live_inputs(world.meters, world.rows, world.baselines, world.first_buckets, world.tariffs)
    return figures._build_month_days(f"fp-{seed:04d}", world.zone, *world.span, world.tree, tariffs, meters, read)


def window_values_of(world, seed: int, first, last, end, as_cost: bool) -> figures.WindowValues:
    meters, read, tariffs = live_inputs(world.meters, world.rows, world.baselines, world.first_buckets, world.tariffs)
    last_day = (end - timedelta(microseconds=1)).astimezone(ZoneInfo(world.zone)).date()
    return figures._build_window_values(
        f"fp-{seed:04d}", world.zone, first, last, last_day, as_cost, world.tree, tariffs, meters, read
    )


def worlds(count: int):
    for seed in range(count):
        yield seed, gen_world(seed, "gaps" if seed % 4 == 3 else "general")


def test_random_worlds_come_back_bit_for_bit():
    seen: Counter = Counter()
    for seed, world in worlds(80):
        md = month_days_of(world, seed)
        back = codec.decode_month_days(codec.encode(md))
        same(md, back)
        assert codec.canonical(back) == codec.canonical(md)
        seen["month"] += 1
        seen["own_from"] += bool(md.own_from)
        seen["entry"] += sum(1 for entries in md.entries.values() for e in entries if e is not None)
        seen["none_entry"] += sum(1 for entries in md.entries.values() for e in entries if e is None)
        seen["no_cost"] += sum(1 for entries in md.entries.values() for e in entries if e is not None and e["cost"] is None)
        seen["estimated"] += sum(1 for entries in md.entries.values() for e in entries if e is not None and e["estimated"])
        floor, ceil = whole_hours(*world.span)
        rng = random.Random(seed)
        for first, last, end in (
            (floor, ceil, world.span[1]), (floor + HOUR * rng.randint(0, 4), ceil - HOUR * rng.randint(0, 5), ceil)
        ):
            if last <= first:
                continue
            for as_cost in (False, True):
                wv = window_values_of(world, seed, first, last, end, as_cost)
                wv_back = codec.decode_window_values(codec.encode(wv))
                same(wv, wv_back)
                assert codec.canonical(wv_back) == codec.canonical(wv)
                seen["window"] += 1
                seen["figure_none"] += sum(1 for v in wv.values.values() if v is None)
                seen["figure_tuple"] += sum(1 for v in wv.values.values() if v is not None)
    # the worlds reached the shapes that matter: assets without a figure, days not begun, unpriced hours, own meters
    assert seen["month"] == 80 and seen["window"] > 200
    assert seen["entry"] > 5000 and seen["none_entry"] and seen["no_cost"] and seen["estimated"] and seen["own_from"]
    assert seen["figure_none"] and seen["figure_tuple"] > 1000


def test_the_canonical_bytes_do_not_depend_on_how_the_tree_was_built():
    checked = 0
    for seed, world in worlds(40):
        md = month_days_of(world, seed)
        nodes = list(world.tree.nodes.values())
        for order in (list(reversed(nodes)), random.Random(seed).sample(nodes, len(nodes))):
            other = AssetTree(order)
            assert list(other.nodes) == [n.id for n in order]  # the dict order really is another one
            same(md.tree, other)  # ... and nobody can see it
            assert codec.canonical(dataclasses.replace(md, tree=other)) == codec.canonical(md)
            checked += 1
    assert checked == 80


def test_two_trees_that_differ_in_any_one_node_give_different_bytes():
    checked = 0
    for seed, world in worlds(40):
        md = month_days_of(world, seed)
        base = codec.canonical(md)
        node = random.Random(seed).choice(list(world.tree.nodes.values()))
        others = [n for n in world.tree.nodes if n != node.id]
        variants = [
            dataclasses.replace(node, name=node.name + "x"),
            dataclasses.replace(node, sort_order=node.sort_order + 1),
            dataclasses.replace(node, parent_id=(None if node.parent_id is not None else (others[0] if others else 99999))),
        ]
        for variant in variants:
            nodes = [variant if n.id == node.id else n for n in world.tree.nodes.values()]
            assert codec.canonical(dataclasses.replace(md, tree=AssetTree(nodes))) != base
            checked += 1
    assert checked == 120


# ---- hand-made values --------------------------------------------------------------------------------------------------------------

# Legitimate names: quotes, control characters, an astral character (an emoji: one character, two UTF-16 units), accents, CJK. A lone
# surrogate is NOT one (PostgreSQL text cannot hold it): see `test_a_string_with_a_lone_surrogate_is_refused`.
NAMES = ('Site "A"', "line\nbreak and \\ backslash", "emoji \U0001F680 and é中文", "tab\tand \x00 nul", "astral \U0001F9EF and \U00010348 end")
TREE = AssetTree([
    AssetNode(1, None, NAMES[0], 0), AssetNode(2, 1, NAMES[1], 1), AssetNode(3, 1, NAMES[2], 2), AssetNode(7, None, NAMES[3], -3),
    AssetNode(9, 7, NAMES[4], 0),
])
START, END = datetime(2026, 3, 1, tzinfo=UTC), datetime(2026, 3, 3, tzinfo=UTC)


def entry(kwh=1.5, cost=0.25, estimated=False, partial=False, no_data=False) -> dict:
    return {"kwh": kwh, "cost": cost, "estimated": estimated, "partial": partial, "no_data": no_data}


def hand_month(**changes) -> figures.MonthDays:
    mid = START + timedelta(days=1)
    base = figures.MonthDays(
        config_fp="0123abcd", tz_name="Europe/London", start=START, end=END, tree=TREE,
        tariffs=[TariffRow(None, 0.1, date(2026, 1, 1)), TariffRow(2, 1e-300, date(2026, 2, 1)), TariffRow(None, 0.12, date(2026, 3, 1))],
        days=[(date(2026, 3, 1), START, mid), (date(2026, 3, 2), mid, END)],
        entries={1: [entry(), entry(-0.0, None)], 2: [None, None], 3: [entry(1, 2), entry(NAN, INF)], 7: [entry(5e-324), entry(1.7976931348623157e308)],
                 9: [entry(-INF, -0.0, True, True, True), None]},
        own=frozenset({3, 2, 9}), own_from={9: mid, 3: START, 2: END}, start_utc=START,
    )
    return dataclasses.replace(base, **changes)


def round_trip(value):
    encode_decode = {figures.MonthDays: codec.decode_month_days, figures.WindowValues: codec.decode_window_values}[type(value)]
    back = encode_decode(codec.encode(value))
    same(value, back)
    assert codec.canonical(back) == codec.canonical(value)
    return back


def test_a_hand_made_month_with_the_awkward_floats_and_names_comes_back_exactly():
    back = round_trip(hand_month())
    assert math.copysign(1.0, back.entries[1][1]["kwh"]) == -1.0
    assert back.entries[9][0]["cost"] is not None and math.copysign(1.0, back.entries[9][0]["cost"]) == -1.0
    assert math.isnan(back.entries[3][1]["kwh"]) and back.entries[3][1]["cost"] == INF
    assert back.entries[3][0]["kwh"] == 1 and type(back.entries[3][0]["kwh"]) is int and type(back.entries[3][0]["cost"]) is int
    assert back.entries[7][0]["kwh"] == 5e-324 and back.entries[7][1]["kwh"] == 1.7976931348623157e308
    assert back.tariffs[1].rate_per_kwh == 1e-300
    assert [back.tree.nodes[i].name for i in (1, 2, 3, 7, 9)] == list(NAMES)
    assert back.own == frozenset({2, 3, 9}) and type(back.own) is frozenset
    assert list(back.own_from) == [9, 3, 2] and list(back.entries) == [1, 2, 3, 7, 9]  # insertion order, not sorted


@pytest.mark.parametrize("value", [
    0.0, -0.0, NAN, INF, -INF, 1e22, 1e-7, 0.1 + 0.2, 5e-324, 1.7976931348623157e308, -2.2250738585072014e-308, 123456789.123456789,
    1, 0, -1, 2**63, -(2**70), True, False, None, "", "x", 1.0, 100.0,
])
def test_every_scalar_keeps_its_value_and_its_type(value):
    wv = figures.WindowValues("fp", "UTC", TREE, [], {1: (value, False, False, False), 2: (1.0, value, False, True)})
    round_trip(wv)
    month = hand_month(entries={1: [entry(kwh=value, cost=value)]}, days=[(date(2026, 3, 1), START, END)])
    round_trip(month)


def test_a_window_values_tuple_and_a_missing_figure_come_back_as_they_were():
    wv = figures.WindowValues("fp", "UTC", TREE, [], {9: (1.5, True, False, False), 1: None, 3: (-0.0, False, True, True)})
    back = round_trip(wv)
    assert back.values[1] is None and type(back.values[9]) is tuple and list(back.values) == [9, 1, 3]
    assert math.copysign(1.0, back.values[3][0]) == -1.0


def test_the_empty_values_come_back_empty():
    round_trip(figures.WindowValues("", "", AssetTree([]), [], {}))
    round_trip(hand_month(tree=AssetTree([]), tariffs=[], days=[], entries={}, own=frozenset(), own_from={}))


def test_the_canonical_bytes_are_ascii_and_compact_and_hold_the_names_escaped():
    raw = codec.canonical(hand_month())
    assert raw.isascii() and b"\n" not in raw and b"\t" not in raw and b"\x00" not in raw
    obj = json.loads(raw)
    assert json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode() == raw  # no separator whitespace, nothing else
    assert [row[2] for row in obj["tree"]] == list(NAMES)  # the nodes are in id order 1, 2, 3, 7, 9
    assert b"\\ud83d\\ude80" in raw and b'\\"A\\"' in raw  # the emoji as a surrogate pair, the quotes escaped


# ---- datetimes ----------------------------------------------------------------------------------------------------------------------

LONDON, TOKYO = ZoneInfo("Europe/London"), ZoneInfo("Asia/Tokyo")


@pytest.mark.parametrize("moment", [
    datetime(2026, 3, 1, tzinfo=UTC),
    datetime(2026, 3, 1, 12, 34, 56, 789012, tzinfo=UTC),
    datetime(2026, 3, 1, 0, 0, 0, 1, tzinfo=UTC),
    datetime(2026, 3, 1, tzinfo=UTC).replace(fold=1),
    datetime(2026, 7, 1, 12, tzinfo=LONDON),
    datetime(2026, 1, 1, 12, 0, 0, 5, tzinfo=LONDON),
    datetime(2026, 10, 25, 1, 30, tzinfo=LONDON),  # ambiguous, first time (BST)
    datetime(2026, 10, 25, 1, 30, fold=1, tzinfo=LONDON),  # the second time (GMT)
    datetime(2026, 3, 29, 2, 30, tzinfo=LONDON),  # just after the spring gap
    datetime(2026, 3, 1, 9, tzinfo=TOKYO),
    datetime(2026, 3, 1, tzinfo=ZoneInfo("UTC")),  # a ZoneInfo, not the singleton: the kind is kept
    datetime(1970, 1, 1, tzinfo=UTC),
    datetime(2099, 12, 31, 23, 59, 59, 999999, tzinfo=UTC),
])
def test_a_datetime_keeps_its_instant_microsecond_tzinfo_kind_and_fold(moment):
    back = round_trip(hand_month(start=moment, own_from={3: moment}, start_utc=moment.astimezone(UTC)))
    assert back.start == moment and tz_kind(back.start.tzinfo) == tz_kind(moment.tzinfo) and back.start.fold == moment.fold
    if moment.tzinfo is UTC:
        assert back.start.tzinfo is UTC  # the singleton, not an equal timezone


def test_the_two_times_of_an_ambiguous_hour_stay_two_times():
    first = datetime(2026, 10, 25, 1, 30, tzinfo=LONDON)
    second = first.replace(fold=1)
    back = round_trip(hand_month(start=first, end=second))
    assert back.start.fold == 0 and back.end.fold == 1 and back.end - back.start == timedelta(0)  # same wall clock, same zone
    assert back.start.astimezone(UTC) != back.end.astimezone(UTC)  # ... but an hour apart as instants
    assert codec.canonical(hand_month(start=first)) != codec.canonical(hand_month(start=second))


@pytest.mark.parametrize("moment", [
    datetime(2026, 3, 1),  # naive
    datetime(2026, 3, 1, 12, tzinfo=timezone(timedelta(hours=2))),
    datetime(2026, 3, 1, 12, tzinfo=timezone(timedelta(0), "UTC")),  # equal to UTC but not the singleton
    datetime(2026, 3, 29, 1, 30, tzinfo=LONDON),  # does not exist: the spring gap; it could not be rebuilt as it is
])
def test_a_datetime_that_cannot_come_back_exactly_is_refused(moment):
    for field in ("start", "end", "start_utc"):
        with pytest.raises(ValueError):
            codec.canonical(hand_month(**{field: moment}))
    with pytest.raises(ValueError):
        codec.encode(hand_month(own_from={1: moment}))
    with pytest.raises(ValueError):
        codec.encode(hand_month(days=[(date(2026, 3, 1), moment, END)]))


def test_a_zone_object_that_is_not_the_cached_zone_of_its_key_still_comes_back_as_that_zone():
    fresh = ZoneInfo.no_cache("Europe/London")  # same key and rules, another object
    assert fresh is not LONDON
    back = round_trip(hand_month(start=datetime(2026, 3, 1, tzinfo=fresh)))
    assert tz_kind(back.start.tzinfo) == ("zone", "Europe/London")


def test_a_zone_without_a_key_is_refused():
    tzdata = pytest.importorskip("tzdata")  # the zone rules the project ships; read one file from it
    london = Path(tzdata.__file__).parent / "zoneinfo" / "Europe" / "London"
    with london.open("rb") as file:
        zone = ZoneInfo.from_file(file)  # a ZoneInfo made from a file has no key
    assert zone.key is None
    with pytest.raises(ValueError):
        codec.canonical(hand_month(start=datetime(2026, 3, 1, tzinfo=zone)))


def test_a_date_is_not_a_datetime_and_the_other_way_round():
    with pytest.raises(ValueError):
        codec.canonical(hand_month(start=date(2026, 3, 1)))
    with pytest.raises(ValueError):
        codec.canonical(hand_month(days=[(START, START, END)]))
    with pytest.raises(ValueError):
        codec.canonical(hand_month(tariffs=[TariffRow(None, 0.1, START)]))


@pytest.mark.parametrize("month, zone_name", [
    ("2026-03", "America/Havana"),  # the clock goes 00:00 to 01:00: local midnight does not exist on 8 March
    ("2026-04", "Africa/Cairo"),  # the same on 24 April
    ("2026-09", "America/Santiago"),  # the same on 6 September
])
def test_a_month_whose_midnight_falls_in_a_clock_gap_comes_back_exactly(month, zone_name):
    zone = ZoneInfo(zone_name)
    start, end = month_bounds(month, zone_name)
    days = local_days(start, end, zone_name)
    gaps = [d for d, _, _ in days if _midnight_does_not_exist(d, zone)]
    assert len(gaps) == 1, f"{zone_name} {month}: the month must hold a midnight in a clock gap, else this test proves nothing"
    own_from = {3: days[len(days) // 2][1], 2: start}
    md = hand_month(
        tz_name=zone_name, start=start, end=end, days=days, start_utc=start.astimezone(UTC),
        entries={1: [entry(float(i), 0.1 * i) for i in range(len(days))], 2: [None] * len(days)}, own_from=own_from,
    )
    back = round_trip(md)
    assert back.days == days and back.start == start and back.end == end
    assert all(day[1].tzinfo is UTC and day[2].tzinfo is UTC for day in back.days)  # all of it UTC, as `_midnight` makes it
    assert sum((to - frm for _, frm, to in back.days), timedelta(0)) == end - start  # the days still abut and cover the month


def _midnight_does_not_exist(day: date, zone: ZoneInfo) -> bool:
    wall = datetime.combine(day, time(0), tzinfo=zone)
    return wall.astimezone(UTC).astimezone(zone).replace(tzinfo=None) != wall.replace(tzinfo=None)


# ---- the canonical form --------------------------------------------------------------------------------------------------------------


def test_the_canonical_bytes_are_compact_ascii_json_with_the_tag_and_the_format_first():
    wv = figures.WindowValues(
        "fp", "UTC", AssetTree([AssetNode(2, 1, "B", 0), AssetNode(1, None, "A", 0)]), [TariffRow(None, 0.1, date(2026, 1, 1))],
        {2: (1.5, False, True, False), 1: None},
    )
    assert codec.canonical(wv) == (
        b'{"t":"WindowValues","f":1,"config_fp":"fp","tz_name":"UTC","tree":[[1,null,"A",0],[2,1,"B",0]],'
        b'"tariffs":[[null,0.1,"2026-01-01"]],"values":[[2,[1.5,false,true,false]],[1,null]]}'
    )
    assert codec.canonical({"b": 1, "a": [1.0, None, "é"]}) == b'{"t":"json","f":1,"v":{"b":1,"a":[1.0,null,"\\u00e9"]}}'
    assert codec.LEDGER_FORMAT == 1


def test_the_canonical_bytes_carry_every_field_of_both_values_in_order():
    month = json.loads(codec.canonical(hand_month()))
    assert list(month) == ["t", "f", *(f.name for f in dataclasses.fields(figures.MonthDays))]
    window = json.loads(codec.canonical(figures.WindowValues("fp", "UTC", TREE, [], {})))
    assert list(window) == ["t", "f", *(f.name for f in dataclasses.fields(figures.WindowValues))]
    assert month["t"] == "MonthDays" and window["t"] == "WindowValues" and month["f"] == window["f"] == codec.LEDGER_FORMAT


PIN = "the codec encodes this by position: extend `ledger_codec` and bump `LEDGER_FORMAT`"


def test_the_shapes_the_codec_encodes_by_position_are_pinned():
    """`_enc_tree` and `_enc_tariffs` write fixed lists, `canonical` lists the members of both values by name. A field added to any
    of them would be dropped WITHOUT an error and every check (canonical bytes, the worker's round trip, rebuild --check, the
    nightly self-check) would be blind to it, because they all compare what the codec writes. This test is the only guard."""
    assert [f.name for f in dataclasses.fields(AssetNode)] == ["id", "parent_id", "name", "sort_order"], f"AssetNode: {PIN}"
    assert [f.name for f in dataclasses.fields(TariffRow)] == ["asset_id", "rate_per_kwh", "effective_from"], f"TariffRow: {PIN}"
    tree = AssetTree([AssetNode(1, None, "A", 0), AssetNode(2, 1, "B", 0)])
    assert set(vars(tree)) == {"nodes", "_children", "_roots"}, f"AssetTree: {PIN}"
    month_fields = ["config_fp", "tz_name", "start", "end", "tree", "tariffs", "days", "entries", "own", "own_from", "start_utc"]
    assert [f.name for f in dataclasses.fields(figures.MonthDays)] == month_fields == list(codec._MONTH_DAYS_FIELDS), f"MonthDays: {PIN}"
    window_fields = ["config_fp", "tz_name", "tree", "tariffs", "values"]
    assert [f.name for f in dataclasses.fields(figures.WindowValues)] == window_fields == list(codec._WINDOW_VALUES_FIELDS), f"WindowValues: {PIN}"


GOLDEN_TEXT = (
    b'{"t":"WindowValues","f":1,"config_fp":"fp-golden","tz_name":"Europe/London","tree":[[1,null,"A",0],[2,1,"B \\u00e9",1]],'
    b'"tariffs":[[null,0.1,"2026-01-01"],[2,0.25,"2026-02-01"]],"values":[[2,[1.5,false,true,false]],[1,null],[3,[-0.0,true,false,true]]]}'
)
# The zlib stream (level 6) that the FIRST build of the codec (format 1, before the review fixes) made of `golden_window_values()`.
GOLDEN_ROW = bytes.fromhex(
    "789c4d8ec10ac23010447f45f6bcad9b48057b53f0e6590f31946293528849691b05c57f774d15843d0c336f9679c204259c3adf84fbb176d18c8060a1140897e"
    "06dd756b667c0f6591b5c633ca7d3a3f2f5d5b0bb8f43e8cdf210b89d92c1b0ad94401f9d43d80292462591bfed16e748643680426b46eba1b376fcd089a59c19"
    "49729d91e08354a35c163f5726979bb7792517252a9117686b371a9c866866c9d077018b15aa8c72fa8b93d45abfde303f4b54"
)


def golden_window_values() -> figures.WindowValues:
    return figures.WindowValues(
        "fp-golden", "Europe/London", AssetTree([AssetNode(2, 1, "B é", 1), AssetNode(1, None, "A", 0)]),
        [TariffRow(None, 0.1, date(2026, 1, 1)), TariffRow(2, 0.25, date(2026, 2, 1))],
        {2: (1.5, False, True, False), 1: None, 3: (-0.0, True, False, True)},
    )


def test_a_row_written_before_the_review_fixes_still_decodes_to_the_same_value():
    """The on-disk format of every valid value is unchanged: a row stored by an earlier build is still read (a row that
    stopped decoding would only be a miss, but a silent one). The compressed bytes are fixed on purpose and not compared with
    `encode`'s output: another zlib build may compress the same text to other bytes, and decoding does not care."""
    assert zlib.decompress(GOLDEN_ROW) == GOLDEN_TEXT == codec.canonical(golden_window_values())
    same(codec.decode_window_values(GOLDEN_ROW), golden_window_values())


def test_a_nan_comes_back_a_nan_and_its_sign_is_not_kept():
    positive, negative = float("nan"), -float("nan")
    assert math.copysign(1.0, positive) != math.copysign(1.0, negative)  # two different NaNs go in ...
    one, other = (figures.WindowValues("fp", "UTC", TREE, [], {1: (v, False, False, False)}) for v in (positive, negative))
    assert codec.canonical(one) == codec.canonical(other)  # ... and the same bytes are written (as JSON and format() do)
    for wv in (one, other):
        assert math.isnan(codec.decode_window_values(codec.encode(wv)).values[1][0])


def test_encode_is_the_zlib_stream_of_the_canonical_bytes_at_level_six():
    for value in (hand_month(), figures.WindowValues("fp", "UTC", TREE, [], {1: None}), {"a": 1}):
        assert codec.encode(value) == zlib.compress(codec.canonical(value), 6)
        assert zlib.decompress(codec.encode(value)) == codec.canonical(value)


def test_equal_values_built_in_another_order_give_the_same_bytes():
    nodes = list(TREE.nodes.values())
    assert codec.canonical(hand_month(tree=AssetTree(list(reversed(nodes))))) == codec.canonical(hand_month())
    assert codec.canonical(hand_month(tree=AssetTree({n.id: n for n in reversed(nodes)}))) == codec.canonical(hand_month())
    a, b = frozenset([1, 9, 17, 25]), frozenset([25, 17, 9, 1])
    assert list(a) != list(b)  # the iteration order really depends on the insertion order here
    assert codec.canonical(hand_month(own=a)) == codec.canonical(hand_month(own=b))
    assert list(codec.decode_month_days(codec.encode(hand_month(own=b))).own) == list(a)


def test_a_different_order_of_a_dict_that_has_an_order_is_a_different_value():
    base = hand_month()
    flipped_entry = {k: v for k, v in reversed(list(entry().items()))}
    assert codec.canonical(hand_month(entries={1: [flipped_entry]})) != codec.canonical(hand_month(entries={1: [entry()]}))
    entries = base.entries
    assert codec.canonical(hand_month(entries=dict(reversed(list(entries.items()))))) != codec.canonical(base)
    assert codec.canonical(hand_month(own_from=dict(reversed(list(base.own_from.items()))))) != codec.canonical(base)
    assert codec.canonical(hand_month(tariffs=list(reversed(base.tariffs)))) != codec.canonical(base)
    values = {1: (1.0, False, False, False), 2: None}
    one = figures.WindowValues("fp", "UTC", TREE, [], values)
    two = figures.WindowValues("fp", "UTC", TREE, [], dict(reversed(list(values.items()))))
    assert codec.canonical(one) != codec.canonical(two)
    # and the decoder gives each its own order back
    assert list(codec.decode_window_values(codec.encode(two)).values) == [2, 1]
    assert list(codec.decode_month_days(codec.encode(hand_month(entries=dict(reversed(list(entries.items())))))).entries) == [9, 7, 3, 2, 1]


def test_a_small_difference_in_any_member_is_a_different_value():
    base = codec.canonical(hand_month())
    changes = [
        {"config_fp": "0123abce"}, {"tz_name": "UTC"}, {"start": START + timedelta(microseconds=1)}, {"end": END + HOUR},
        {"start_utc": START + HOUR}, {"own": frozenset({2, 3})}, {"own_from": {9: START, 3: START, 2: END}},
        {"entries": {**hand_month().entries, 2: [None, entry()]}},
        {"entries": {**hand_month().entries, 1: [entry(), entry(0.0, None)]}},  # -0.0 against 0.0
        {"entries": {**hand_month().entries, 3: [entry(1.0, 2), entry(NAN, INF)]}},  # 1 against 1.0
        {"tariffs": hand_month().tariffs[:2]}, {"tariffs": [TariffRow(2, 0.1, date(2026, 1, 1)), *hand_month().tariffs[1:]]},
        {"days": hand_month().days[:1]},
    ]
    for change in changes:
        assert codec.canonical(hand_month(**change)) != base, change


# ---- refusals ------------------------------------------------------------------------------------------------------------------------


class FakeFloat(float):
    pass


class FakeInt(int):
    pass


@pytest.mark.parametrize("bad", [
    Decimal("1.5"), FakeFloat(1.5), FakeInt(3), (1.0,), {1: 2}, {"k": 1}, b"bytes", 3 + 4j, object(), {1, 2}, [1],
])
def test_a_value_of_an_unknown_type_is_refused_in_a_day_entry(bad):
    for target in (entry(kwh=bad), {"kwh": 1.0, "cost": 1.0, "odd": bad}):
        with pytest.raises(ValueError):
            codec.canonical(hand_month(entries={1: [target]}))


def test_other_misplaced_types_are_refused():
    with pytest.raises(ValueError):
        codec.canonical(hand_month(entries={True: [None]}))  # a bool is not an asset id
    with pytest.raises(ValueError):
        codec.canonical(hand_month(entries={"1": [None]}))
    with pytest.raises(ValueError):
        codec.canonical(hand_month(entries={1: (None,)}))  # a tuple where a list belongs
    with pytest.raises(ValueError):
        codec.canonical(hand_month(own={1, 2}))  # a set, not a frozenset
    with pytest.raises(ValueError):
        codec.canonical(hand_month(own=frozenset({1, "2"})))
    with pytest.raises(ValueError):
        codec.canonical(hand_month(days=[[date(2026, 3, 1), START, END]]))  # a list where a tuple belongs
    with pytest.raises(ValueError):
        codec.canonical(hand_month(tariffs=[(None, 0.1, date(2026, 1, 1))]))
    with pytest.raises(ValueError):
        codec.canonical(hand_month(tree={1: TREE.nodes[1]}))
    with pytest.raises(ValueError):
        codec.canonical(hand_month(config_fp=None))
    with pytest.raises(ValueError):
        codec.canonical(figures.WindowValues("fp", "UTC", TREE, [], {1: [1.0, False, False, False]}))  # a list, not a tuple
    with pytest.raises(ValueError):
        codec.canonical(figures.WindowValues("fp", "UTC", TREE, [], {1: (1.0, False, False)}))
    for bad in ([1, 2], "text", None, 5, (1, 2), {1: 2}, {"a": (1, 2)}, {"a": {1: 2}}, {"a": Decimal(1)}, {"a": datetime(2026, 1, 1, tzinfo=UTC)}):
        with pytest.raises(ValueError):
            codec.canonical(bad)


def test_a_dict_subclass_is_not_a_dict():
    from collections import OrderedDict

    with pytest.raises(ValueError):
        codec.canonical(OrderedDict(a=1))
    with pytest.raises(ValueError):
        codec.canonical({"a": OrderedDict(b=1)})


def test_garbage_and_foreign_bytes_are_refused():
    decoders = (codec.decode_month_days, codec.decode_window_values, codec.decode_json)
    good = codec.encode(hand_month())
    foreign = [
        b"", b"garbage", b"\x00" * 40, good[:-4], good[: len(good) // 2], good + b"extra", good[:10] + bytes([good[10] ^ 0xFF]) + good[11:],
        zlib.compress(b"not json"), zlib.compress(b""), zlib.compress(b"{"), zlib.compress(b'{"a":1}'), zlib.compress(b"[1,2]"),
        zlib.compress(b"null"), zlib.compress(b"3"), zlib.compress(b'"text"'), zlib.compress(b'{"t":"MonthDays"}'),
        zlib.compress("{\"t\":\"json\",\"f\":1,\"v\":{\"a\":\"é\"}}".encode()),  # not ASCII
        zlib.compress(b"[" * 100000), zlib.compress(b'{"f":1,"t":"json","v":{}}'),  # the tag must come first
        zlib.compress(codec.canonical({"a": 1}) + codec.canonical({"a": 1})), zlib.compress(codec.canonical({"a": 1}) + b"x"),
    ]
    for raw in foreign:
        for decode in decoders:
            with pytest.raises((ValueError, zlib.error)):
                decode(raw)


def every_kind():
    """(a value, the decoder of it) for the three kinds of value the ledger holds."""
    return (
        (hand_month(), codec.decode_month_days),
        (figures.WindowValues("fp", "UTC", TREE, [], {1: None}), codec.decode_window_values),
        ({"a": 1}, codec.decode_json),
    )


def test_a_stream_that_inflates_past_the_cap_is_refused():
    assert codec.MAX_BYTES == 64 * 1024 * 1024
    for value, decode in every_kind():
        # A valid value followed by 70 MiB of blanks (JSON allows them): a few KB of zlib. Without a cap the row inflated to the
        # full 70 MiB first, and was refused (or not) only afterwards.
        bomb = zlib.compress(codec.canonical(value) + b" " * (70 * 1024 * 1024), 9)
        assert len(bomb) < 400_000  # about 70 KB: deflate packs a long run of one byte about 1000 to 1
        with pytest.raises(ValueError, match="at most"):  # refused for its size, not for anything found after inflating it all
            decode(bomb)


def test_the_inflate_cap_is_the_one_in_the_module(monkeypatch):
    for value, decode in every_kind():
        raw, size = codec.encode(value), len(codec.canonical(value))
        monkeypatch.setattr(codec, "MAX_BYTES", size + 100)
        decode(raw)  # under the cap: read
        for cap in (size - 1, size // 2, 1):
            monkeypatch.setattr(codec, "MAX_BYTES", cap)
            with pytest.raises(ValueError):
                decode(raw)


def test_a_truncated_or_overlong_stream_is_refused():
    for value, decode in every_kind():
        raw = codec.encode(value)
        decode(raw)
        for cut in (1, 4, 5, len(raw) // 2):
            with pytest.raises(ValueError):  # the data may all be there, but the end of the stream is not: never accepted
                decode(raw[:-cut])
        for extra in (b"\x00", b"x" * 100, raw):
            with pytest.raises(ValueError):
                decode(raw + extra)


PAIR_OF_LONE_SURROGATES = chr(0xD83D) + chr(0xDE00)  # two characters, which JSON writes as the very escapes of the emoji "\U0001F600"
LONE_SURROGATES = ["\ud800", "a\udfffb", PAIR_OF_LONE_SURROGATES, "\ude00\ud83d", "x\udc00"]


@pytest.mark.parametrize("bad", LONE_SURROGATES)
def test_a_string_with_a_lone_surrogate_is_refused(bad):
    # PAIR_OF_LONE_SURROGATES is TWO characters (Python does not join them); JSON would write the very bytes of the one emoji
    # "\U0001F600", and the decoder would read one character where two went in. So the encoder refuses it everywhere.
    assert json.dumps(PAIR_OF_LONE_SURROGATES) == json.dumps("\U0001F600") and PAIR_OF_LONE_SURROGATES != "\U0001F600"  # the hole closed
    bad_values = [
        hand_month(tree=AssetTree([AssetNode(1, None, bad, 0)])), hand_month(config_fp=bad), hand_month(tz_name=bad),
        hand_month(entries={1: [{"kwh": 1.0, bad: 1.0}]}), hand_month(entries={1: [entry(kwh=bad)]}),
        figures.WindowValues(bad, "UTC", TREE, [], {}), figures.WindowValues("fp", "UTC", TREE, [], {1: (bad, False, False, False)}),
        {"a": bad}, {bad: 1}, {"a": [{"b": bad}]},
    ]
    for value in bad_values:
        with pytest.raises(ValueError):
            codec.canonical(value)
        with pytest.raises(ValueError):
            codec.encode(value)
    # the astral character itself is a name like any other: one character, stored as a surrogate PAIR of escapes, back as one
    back = round_trip(hand_month(config_fp="\U0001F600", tree=AssetTree([AssetNode(1, None, "\U0001F600", 0)])))
    assert back.config_fp == "\U0001F600" and len(back.config_fp) == 1 and back.tree.nodes[1].name == "\U0001F600"


def test_a_lone_surrogate_in_a_stored_row_is_refused_and_a_pair_is_the_astral_character():
    assert codec.decode_json(zlib.compress(b'{"t":"json","f":1,"v":{"a":"\\ud83d\\ude00"}}')) == {"a": "\U0001F600"}
    for text in (b'"\\ud800"', b'"\\ude00\\ud83d"', b'"a\\udfff"'):
        with pytest.raises(ValueError):
            codec.decode_json(zlib.compress(b'{"t":"json","f":1,"v":{"a":' + text + b"}}"))


def pack(obj) -> bytes:
    """A stored row made of a plain object, in the compact form `canonical` writes."""
    return zlib.compress(json.dumps(obj, separators=(",", ":")).encode())


def test_a_row_that_is_not_in_the_form_encode_writes_is_refused():
    """Every `decode_*` is a strict inverse: it reads back only text that `canonical` of the value it built gives again."""
    raw = json.loads(codec.canonical(hand_month()))
    text = codec.canonical(hand_month())
    codec.decode_month_days(pack(raw))
    assert b"\\u00e9" in text and b"\\u4e2d" in text  # the names hold accents and CJK, written as lower-case escapes
    month_variants = [
        zlib.compress(json.dumps(raw).encode()),  # spaces after the separators
        zlib.compress(text.replace(b"\\u4e2d", b"\\u4E2D", 1)),  # another spelling of the same escape
        zlib.compress(text.replace(b"\\u4e2d", "中".encode(), 1)),  # not ASCII (a real character)
        pack({**raw, "tree": list(reversed(raw["tree"]))}),  # the nodes are stored by id
        pack({**raw, "own": [9, 3, 2]}), pack({**raw, "own": [2, 3, 9, 9]}),  # the set is stored sorted
        zlib.compress(text.replace(b'"kwh":1.5,', b'"kwh":1.5,"kwh":1.5,', 1)),  # a duplicate key
        pack({**raw, "start": ["2026-03-01T00:00:00Z", "u", 0]}), pack({**raw, "start": ["2026-03-01T00:00:00.000000+00:00", "u", 0]}),
    ]
    for variant in month_variants:
        with pytest.raises(ValueError):
            codec.decode_month_days(variant)
    for variant in (
        zlib.compress(b'{"t":"json","f":1,"v":{"a":1,"a":2}}'), zlib.compress(b'{"t":"json","f":1,"v":{"a": 1}}'),
        zlib.compress(b'{"t":"json","f":1,"v":{"a":1.0e0}}'), zlib.compress(b'{"t":"json","f":1,"v":{"a":"\\u00E9"}}'),
        zlib.compress(b'{"t":"json","f":1,"v":{"a":1}} '),
    ):
        with pytest.raises(ValueError):
            codec.decode_json(variant)
    codec.decode_json(zlib.compress(b'{"t":"json","f":1,"v":{"a":1.0,"b":"\\u00e9"}}'))  # and the canonical one is read
    window = json.loads(codec.canonical(figures.WindowValues("fp", "UTC", TREE, [], {1: (1.0, True, False, False)})))
    for variant in (
        zlib.compress(json.dumps(window).encode()), pack({**window, "tree": list(reversed(window["tree"]))}),
        pack({**window, "values": [[1, [1.0, True, False, False]], [1, [1.0, True, False, False]]]}),
    ):
        with pytest.raises(ValueError):
            codec.decode_window_values(variant)


def test_a_wrong_tag_is_refused_by_every_other_decoder():
    month = codec.encode(hand_month())
    window = codec.encode(figures.WindowValues("fp", "UTC", TREE, [], {1: None}))
    plain = codec.encode({"a": 1})
    for raw, ok in ((month, codec.decode_month_days), (window, codec.decode_window_values), (plain, codec.decode_json)):
        for decode in (codec.decode_month_days, codec.decode_window_values, codec.decode_json):
            if decode is ok:
                decode(raw)
                continue
            with pytest.raises(ValueError):
                decode(raw)
    # a tag the codec never wrote
    retagged = zlib.compress(codec.canonical(hand_month()).replace(b'"t":"MonthDays"', b'"t":"MonthDay"', 1))
    with pytest.raises(ValueError):
        codec.decode_month_days(retagged)


def test_another_format_number_is_refused():
    for value, decode in ((hand_month(), codec.decode_month_days), (figures.WindowValues("fp", "UTC", TREE, [], {}), codec.decode_window_values), ({"a": 1}, codec.decode_json)):
        raw = codec.canonical(value)
        assert b'"f":1,' in raw
        for number in (b"0", b"2", b"1.0", b"true", b'"1"', b"null", b"-1"):
            with pytest.raises(ValueError):
                decode(zlib.compress(raw.replace(b'"f":1,', b'"f":' + number + b",", 1)))
        decode(zlib.compress(raw))  # the same bytes with the number untouched are fine


def test_a_member_added_removed_or_moved_is_refused():
    raw = json.loads(codec.canonical(hand_month()))
    pack = lambda obj: zlib.compress(json.dumps(obj, separators=(",", ":")).encode())  # noqa: E731
    codec.decode_month_days(pack(raw))
    for broken in (
        {**raw, "extra": 1}, {k: v for k, v in raw.items() if k != "own"}, {k: raw[k] for k in reversed(list(raw))},
        {**raw, "tree": [[1, None, "A"]]}, {**raw, "tree": [[1, None, "A", 0], [1, None, "B", 0]]},
        {**raw, "entries": [[1, [None]], [1, [None]]]}, {**raw, "entries": {"1": [None]}}, {**raw, "entries": [[1.0, [None]]]},
        {**raw, "start": ["2026-03-01T00:00:00+00:00", "u"]}, {**raw, "start": ["2026-03-01T00:00:00+00:00", "u", 2]},
        {**raw, "start": ["2026-03-01T01:00:00+01:00", "u", 0]}, {**raw, "start": ["2026-03-01", "u", 0]},
        {**raw, "start": ["2026-03-01T00:00:00Z", "u", 0]}, {**raw, "start": ["2026-03-01T00:00:00.000000+00:00", "u", 0]},  # not isoformat
        {**raw, "start": ["2026-03-01T00:00:00+00:00", "q", 0]}, {**raw, "start": ["2026-03-01T00:00:00+00:00", "z:Nowhere/Land", 0]},
        {**raw, "start": ["2026-03-01T00:00:00+00:00", "z:../../etc/passwd", 0]}, {**raw, "start": ["2026-03-01T00:00:00+00:00", "z:Europe", 0]},
        {**raw, "start": ["2026-10-25T00:30:00+00:00", "z:Europe/London", 1]},  # a fold that does not belong to the instant
        {**raw, "days": [["2026-03-01", raw["start"]]]}, {**raw, "days": [["20260301", raw["start"], raw["end"]]]},
        {**raw, "own": [1, 1]}, {**raw, "own": ["1"]}, {**raw, "tariffs": [[None, 0.1, "2026-1-1"]]}, {**raw, "config_fp": 5},
        {**raw, "entries": [[1, [{"kwh": [1.0]}]]]}, {**raw, "entries": [[1, "x"]]},
    ):
        with pytest.raises(ValueError):
            codec.decode_month_days(pack(broken))
    window = json.loads(codec.canonical(figures.WindowValues("fp", "UTC", TREE, [], {1: (1.0, True, False, False)})))
    codec.decode_window_values(pack(window))
    for broken in ({**window, "values": [[1, [1.0, True, False]]]}, {**window, "values": [[1, 5]]}, {**window, "values": [[1]]}, {**window, "values": {}}):
        with pytest.raises(ValueError):
            codec.decode_window_values(pack(broken))
    with pytest.raises(ValueError):
        codec.decode_json(pack({"t": "json", "f": 1, "v": [1]}))


def test_the_module_imports_no_pickle_marshal_or_shelve():
    source = Path(codec.__file__).read_text()
    assert not re.search(r"^\s*(?:import|from)\s+(?:pickle|cPickle|_pickle|marshal|shelve|dill|cloudpickle)\b", source, re.M)
    assert "pickle.loads" not in source and "marshal.loads" not in source and "eval(" not in source


# ---- the Check month report ----------------------------------------------------------------------------------------------------------

REPORT = {
    "hours": 720, "meters": 3, "meter_hours": 2160, "things": 4,
    "groups": {
        "silent": {"total": 1, "items": [{
            "asset_id": 4, "path": 'Site / "A" / é', "kind": "counter", "point": None, "source": None,
            "interval_seconds": 60, "reason": "never", "since": None, "hours": 720, "last_reading": None, "children": 0,
        }]},
        "gaps": {"total": 2, "items": [{
            "asset_id": 5, "path": "Site / B", "kind": "power", "point": "kW", "source": "PLC 1", "interval_seconds": 5,
            "runs": 2, "hours": 12, "longest_hours": 9, "longest_start": "2026-03-04T10:00:00+00:00",
            "first_start": "2026-03-01T00:00:00+00:00", "last_end": "2026-03-04T19:00:00+00:00", "leading_hours": 0,
            "hours_before_month": 0, "previous_reading": None, "short_hours": 1, "short_minutes": 17,
        }, {"asset_id": 6, "negative_kwh": -0.0, "kwh": 12.0, "partial": True, "ratio": 0.1 + 0.2}]},
        "resets": {"total": 0, "items": []},
        "unmetered": {"total": 1, "items": [{"asset_id": 9, "path": "Site / Spare", "beside_measured": False}]},
        "later": {"total": 0, "items": []},
    },
}


def test_a_check_month_report_comes_back_exactly():
    back = codec.decode_json(codec.encode(REPORT))
    same(REPORT, back)
    assert codec.canonical(back) == codec.canonical(REPORT)
    assert json.dumps(back) == json.dumps(REPORT)  # what a response would write is the same text, key order included
    assert list(back["groups"]["gaps"]["items"][0]) == list(REPORT["groups"]["gaps"]["items"][0])
    assert type(back["hours"]) is int and type(back["groups"]["gaps"]["items"][1]["kwh"]) is float
    assert back["groups"]["silent"]["items"][0]["point"] is None


def test_an_empty_and_a_not_begun_report_come_back():
    for report in ({}, {"hours": 0, "meters": 0, "meter_hours": 0, "things": 0, "groups": {"silent": {"total": 0, "items": []}}}):
        same(report, codec.decode_json(codec.encode(report)))


# ---- real Check month reports, from random worlds --------------------------------------------------------------------------------------

CHECK_ZONES = ("UTC", "Europe/London", "Asia/Qatar", "America/Havana", "Africa/Cairo", "America/Santiago")
CHECK_NAMES = ("Hall", 'Rack "7"', "Zone é", "Line\nbreak", "Room \U0001F680", "Panel / 2", "中文")
POINT_NAMES = (None, "Active power", 'Energy "kWh"', "é")
SOURCE_NAMES = (None, "Meter 7", "PLC \U0001F680")


def check_rows(rng: random.Random, hours: list[datetime], counter: bool) -> list:
    """A month of hourly rows with the troubles the check lists: holes, resets, flat stretches, negative power, frozen power."""
    rows, value, step, hole_rate, skip = [], rng.uniform(0, 1000), rng.choice([0.0, 0.25, 1.0, 5.0]), rng.choice([0.0, 0.0, 0.02, 0.3]), 0
    for hour in hours:
        if skip:
            skip -= 1
            continue
        if rng.random() < hole_rate:
            continue
        if rng.random() < 0.004:
            skip = rng.randint(2, 60)  # a long hole
        if counter:
            value = rng.uniform(0, 50) if rng.random() < 0.005 else value + step * rng.random()  # now and then a reset
            rows.append(crow(hour, round(value, rng.choice([1, 3, 6]))))
        else:
            kw = rng.choice([5.0, 5.0, -2.0, 0.0]) + (0.0 if rng.random() < 0.2 else rng.random())
            rows.append(prow(hour, kw, n=rng.randint(1, 3), minutes=rng.choice([60, 60, 45, 1])))
    return rows


def check_world(seed: int) -> dict:
    """One real `build_report` answer for a random tree, random meters and a random range (a whole month, a month not begun, the
    first hour only, an open month, a month with no tree at all)."""
    rng = random.Random(seed)
    zone_name = rng.choice(CHECK_ZONES)
    start, stop = month_bounds(f"2026-{rng.randint(1, 12):02d}", zone_name)
    shape = seed % 6
    if shape == 1:
        stop = start  # not begun
    elif shape == 2:
        stop = start + HOUR  # the first hour
    elif shape == 3:
        stop = start + HOUR * rng.randint(2, 500) + timedelta(minutes=rng.choice([0, 20, 59]))  # open: ends inside an hour
    nodes: list[AssetNode] = []
    for index in range(0 if shape == 4 else rng.randint(1, 14)):  # shape 4: an empty tree
        nodes.append(AssetNode(index + 1, rng.choice([None, *(n.id for n in nodes)]), rng.choice(CHECK_NAMES), rng.randint(0, 2)))
    hours = [start + HOUR * i for i in range(max(0, int((stop - start) / HOUR)))]
    inputs = []
    for node in nodes:
        if rng.random() < 0.3:
            continue  # nothing measures this one
        counter = rng.random() < 0.6
        before = (crow if counter else prow)(start - HOUR * rng.randint(1, 900), rng.uniform(0, 100)) if rng.random() < 0.3 else None
        mode = rng.choice(["rows", "rows", "rows", "silent", "never", "later", "late_start"])
        rows = [] if mode in ("silent", "never", "later") else check_rows(rng, hours[rng.randint(0, len(hours) // 2) if mode == "late_start" else 0:], counter)
        first = (
            before.bucket if before is not None else rows[0].bucket if rows else
            stop + HOUR * rng.randint(1, 100) if mode == "later" else None
        )
        meter = Meter(node.id * 10, rng.choice([1.0, 1.0, 2.0, -1.0, 0.001]), rng.choice([60, 900, 1800, 3600, 7200]), counter)
        inputs.append(MeterInput(node.id, meter, rows, before, first))
    salt = rng.randint(0, 6)
    names = None if rng.random() < 0.5 else {n.id: (rng.choice(POINT_NAMES), rng.choice(SOURCE_NAMES)) for n in nodes if rng.random() < 0.7}
    return build_report(
        AssetTree(nodes), inputs, start=start, stop=stop, zone=ZoneInfo(zone_name), names=names,
        rate_for=lambda asset, day: None if salt and (asset + day.toordinal()) % (salt + 4) == 0 else 0.1 * (1 + asset % 3),
    )


def test_real_check_month_reports_come_back_bit_for_bit():
    seen: Counter = Counter()
    for seed in range(96):
        live = check_world(seed)
        back = codec.decode_json(codec.encode(live))  # a ValueError here would mean a report holds a type the codec refuses (a tuple ...)
        same(live, back)
        assert codec.canonical(back) == codec.canonical(live)
        assert json.dumps(back) == json.dumps(live)  # what a response would write
        seen["hours_0"] += live["hours"] == 0
        seen["hours_1"] += live["hours"] == 1
        seen["empty_tree"] += live["groups"]["unmetered"]["total"] == 0 and live["meters"] == 0 and live["things"] == 0
        seen["point_name"] += any(
            item.get("point") is not None for group in live["groups"].values() for item in group["items"]
        )
        for group, content in live["groups"].items():
            seen[group] += content["total"] > 0
            seen["items"] += len(content["items"])
    # the worlds reached every group, the empty and not-begun ranges, the first hour, and names
    for group in ("silent", "gaps", "estimated", "resets", "started", "unpriced", "flat", "unmetered", "later"):
        assert seen[group], f"no random world listed anything in {group}"
    assert seen["hours_0"] and seen["hours_1"] and seen["empty_tree"] and seen["point_name"] and seen["items"] > 500, seen
