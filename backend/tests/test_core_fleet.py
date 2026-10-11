from datetime import datetime, timedelta, timezone

from dcdash.core.fleet import ATTENTION_LIMIT, AttentionRow, MappedReading, PowerReading, attention, fleet_power
from dcdash.core.tree import AssetNode, AssetTree

NOW = datetime(2026, 3, 10, 10, 20, tzinfo=timezone.utc)


def tree_of(*nodes: tuple[int, int | None]) -> AssetTree:
    """Assets as (id, parent_id), named after their id, in id order."""
    return AssetTree(AssetNode(i, parent, f"A{i}", 0) for i, parent in nodes)


def live(kw: float, age: float = 5, interval: int = 5) -> PowerReading:
    return PowerReading(kw, NOW - timedelta(seconds=age), 0, interval)


# ---- fleet_power ----


def test_no_meters_at_all_is_none_with_nothing_to_count():
    assert fleet_power(tree_of((1, None), (2, 1)), {}, NOW) == (None, 0, 0)
    assert fleet_power(tree_of(), {}, NOW) == (None, 0, 0)


def test_an_unmetered_root_is_the_sum_of_the_meters_below_it():
    tree = tree_of((1, None), (2, 1), (3, 1))
    assert fleet_power(tree, {2: live(10.0), 3: live(5.5)}, NOW) == (15.5, 2, 2)


def test_a_root_with_its_own_meter_counts_only_that_meter():
    tree = tree_of((1, None), (2, 1), (3, 1))
    assert fleet_power(tree, {1: live(20.0), 2: live(10.0), 3: live(5.0)}, NOW) == (20.0, 1, 1)


def test_two_roots_add_up_and_an_unmetered_one_does_not_count_for_the_other():
    tree = tree_of((1, None), (2, 1), (3, None), (4, 3), (5, 3), (6, None))
    meters = {2: live(1.0), 4: live(2.0), 5: live(4.0)}  # root 6 has no meter anywhere below it
    assert fleet_power(tree, meters, NOW) == (7.0, 3, 3)


def test_a_metered_child_is_not_looked_into_again():
    tree = tree_of((1, None), (2, 1), (3, 2))
    assert fleet_power(tree, {2: live(10.0), 3: live(99.0)}, NOW) == (10.0, 1, 1)


def test_a_stale_meter_is_left_out_and_counted_in_of():
    tree = tree_of((1, None), (2, 1), (3, 1))
    meters = {2: live(10.0), 3: live(7.0, age=61)}  # 3 x 5 s is below the 60 s floor, so 61 s is stale
    assert fleet_power(tree, meters, NOW) == (10.0, 1, 2)
    assert fleet_power(tree, {2: live(10.0), 3: live(7.0, age=60)}, NOW) == (17.0, 2, 2)  # exactly on the floor: fresh
    assert fleet_power(tree, {2: live(10.0), 3: live(7.0, age=899, interval=300)}, NOW) == (17.0, 2, 2)
    assert fleet_power(tree, {2: live(10.0), 3: live(7.0, age=901, interval=300)}, NOW) == (10.0, 1, 2)


def test_a_bad_quality_meter_is_left_out():
    tree = tree_of((1, None), (2, 1), (3, 1))
    meters = {2: live(10.0), 3: PowerReading(7.0, NOW - timedelta(seconds=5), 192, 5)}
    assert fleet_power(tree, meters, NOW) == (10.0, 1, 2)


def test_a_meter_without_a_value_or_never_read_is_left_out():
    tree = tree_of((1, None), (2, 1), (3, 1), (4, 1))
    meters = {
        2: live(10.0),
        3: PowerReading(None, NOW - timedelta(seconds=5), 0, 5),  # good quality but no value
        4: PowerReading(None, None, None, 5),  # never read
    }
    assert fleet_power(tree, meters, NOW) == (10.0, 1, 3)


def test_none_reporting_is_none_never_zero():
    tree = tree_of((1, None), (2, 1), (3, 1), (4, None))
    meters = {2: live(10.0, age=500), 3: PowerReading(1.0, NOW, 192, 5), 4: PowerReading(None, None, None, 5)}
    assert fleet_power(tree, meters, NOW) == (None, 0, 3)


def test_a_live_zero_is_a_zero_not_a_none():
    assert fleet_power(tree_of((1, None), (2, 1)), {2: live(0.0)}, NOW) == (0.0, 1, 1)


# ---- attention ----


def reading(asset_id: int, age: float | None, value: float | None = 1.0, quality: int | None = 0,
            interval: int = 5) -> MappedReading:
    """A mapped point of `asset_id` last read `age` seconds before NOW (never when None)."""
    ts = None if age is None else NOW - timedelta(seconds=age)
    return MappedReading(asset_id, interval, ts, value, None if ts is None else quality)


def test_fresh_good_readings_need_no_attention():
    assert attention([reading(1, 5), reading(2, 60)], NOW) == []
    assert attention([], NOW) == []


def test_a_point_never_read_is_skipped():
    assert attention([reading(1, None)], NOW) == []


def test_a_stale_reading_is_stale_by_the_rule_of_the_asset_pages():
    assert attention([reading(1, 61)], NOW) == [AttentionRow(1, "stale", 1, NOW - timedelta(seconds=61))]
    assert attention([reading(1, 60)], NOW) == []
    assert attention([reading(1, 901, interval=300)], NOW) == [
        AttentionRow(1, "stale", 1, NOW - timedelta(seconds=901))
    ]
    assert attention([reading(1, 899, interval=300)], NOW) == []


def test_bad_quality_and_a_missing_value_are_bad_even_when_fresh():
    assert attention([reading(1, 5, quality=192)], NOW) == [AttentionRow(1, "bad", 1, NOW - timedelta(seconds=5))]
    assert attention([reading(1, 5, value=None)], NOW) == [AttentionRow(1, "bad", 1, NOW - timedelta(seconds=5))]


def test_a_bad_and_stale_reading_is_bad_not_stale():
    assert attention([reading(1, 500, quality=192)], NOW)[0].problem == "bad"


def test_bad_beats_stale_per_asset_and_points_counts_the_mappings_with_a_problem():
    rows = attention(
        [
            reading(1, 500),  # stale
            reading(1, 10, quality=192),  # bad
            reading(1, 300),  # stale
            reading(1, 5),  # fine: not counted, and its ts is not the last_ts
        ],
        NOW,
    )
    assert rows == [AttentionRow(1, "bad", 3, NOW - timedelta(seconds=10))]  # last_ts: the newest of the three


def test_an_asset_with_only_stale_mappings_is_stale():
    rows = attention([reading(1, 500), reading(1, 200)], NOW)
    assert rows == [AttentionRow(1, "stale", 2, NOW - timedelta(seconds=200))]


def test_bad_first_then_the_oldest_then_the_asset_id():
    rows = attention(
        [
            reading(5, 100),  # stale, newer
            reading(4, 900),  # stale, oldest
            reading(9, 70, quality=192),  # bad, newer
            reading(8, 80, quality=192),  # bad, older
            reading(3, 100),  # stale, the same ts as asset 5: the lower id first
            reading(7, 80, quality=192),  # bad, the same ts as asset 8: the lower id first
        ],
        NOW,
    )
    assert [(r.asset_id, r.problem) for r in rows] == [
        (7, "bad"), (8, "bad"), (9, "bad"), (4, "stale"), (3, "stale"), (5, "stale"),
    ]


def test_the_function_returns_every_asset_and_the_caller_applies_the_limit():
    assert ATTENTION_LIMIT == 25
    rows = attention([reading(i, 500) for i in range(1, 31)], NOW)
    assert len(rows) == 30
