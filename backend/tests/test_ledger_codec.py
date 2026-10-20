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
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from dcdash.core import figures
from dcdash.core import ledger_codec as codec
from dcdash.core.cost import TariffRow
from dcdash.core.tree import AssetNode, AssetTree
from test_engine_oracle import gen_world
from test_figures import live_inputs, whole_hours

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

NAMES = ('Site "A"', "line\nbreak and \\ backslash", "emoji \U0001F680 and é中文", "tab\tand \x00 nul", "lone \ud800 surrogate")
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
