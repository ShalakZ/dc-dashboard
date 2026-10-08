"""The energy engine and the asset tree against the real database and the real rollup views."""
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import event

from dcdash.core.db import get_engine, get_sessionmaker
from dcdash.core.energy import Energy, HourEnergy, hourly_energy, total
from dcdash.core.timeutil import local_days, month_bounds
from dcdash.core.tree import AssetTree
from helpers import insert_readings, make_asset, make_mapping, make_point, make_source, settle_rollups

T0 = datetime(2026, 6, 10, 0, 0, tzinfo=timezone.utc)
HOUR = timedelta(hours=1)
MINUTE = timedelta(minutes=1)


async def meter(db, source, name, parent_id=None, metric="energy_kwh", interval=60, scale=1.0):
    """An asset with one mapped point. Returns (asset_id, point_id)."""
    asset = await make_asset(db, name, parent_id)
    point = await make_point(db, source, f"{name}_{metric}")
    await make_mapping(db, point, asset, metric, interval, scale)
    return asset, point


async def energy(start=T0, end=T0 + 3 * HOUR):
    async with get_sessionmaker()() as session:
        return await hourly_energy(session, await AssetTree.load(session), start, end)


# ---- the tree --------------------------------------------------------------------------------


async def test_the_tree_loads_ordered_with_paths(db):
    site = await make_asset(db, "Site")
    mv2 = await make_asset(db, "MV2", site)
    panel_b = await make_asset(db, "Panel B", mv2)
    panel_a = await make_asset(db, "Panel A", mv2)
    pinned = await make_asset(db, "Zed", mv2)
    await db.execute("UPDATE assets SET sort_order = -1 WHERE id = $1", pinned)

    async with get_sessionmaker()() as session:
        tree = await AssetTree.load(session)

    assert tree.children(mv2) == [pinned, panel_a, panel_b]  # sort_order first, then name
    assert tree.preorder() == [site, mv2, pinned, panel_a, panel_b]
    assert tree.path(panel_a) == "Site / MV2 / Panel A"
    assert tree.ancestors_or_self(panel_a) == [panel_a, mv2, site]


# ---- counters --------------------------------------------------------------------------------


async def test_consumption_across_the_start_of_the_range_uses_the_last_earlier_bucket(db):
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel")
    await insert_readings(db, point, T0 - 3 * HOUR + 20 * MINUTE, 1, [80.0])  # the baseline, three hours earlier
    await insert_readings(db, point, T0 + 10 * MINUTE, 40 * 60, [100.0, 104.0])  # 00:10 and 00:50
    await insert_readings(db, point, T0 + 70 * MINUTE, 1, [110.0])  # 01:10
    await settle_rollups(db)

    result = await energy(T0, T0 + 3 * HOUR)

    # 80 -> 104 accumulated in hour 0 (it includes the stretch before the range began), then 104 -> 110
    assert result.hours[asset] == {T0: HourEnergy(24.0, False), T0 + HOUR: HourEnergy(6.0, False)}
    assert result.own == frozenset({asset})
    # a later range takes its baseline from the bucket just before it
    assert (await energy(T0 + HOUR, T0 + 3 * HOUR)).hours[asset] == {T0 + HOUR: HourEnergy(6.0, False)}


async def test_a_counter_reset_inside_an_hour_is_recovered(db):
    # Review Focus 1, against the real rollup.
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel")
    await insert_readings(db, point, T0 - HOUR + 30 * MINUTE, 1, [100.0])
    await insert_readings(db, point, T0 + 5 * MINUTE, 900, [110.0, 5.0, 8.0])  # 00:05, 00:20, 00:35
    await settle_rollups(db)
    assert (await energy()).hours[asset] == {T0: HourEnergy(13.0, False)}


async def test_a_counter_reset_exactly_between_two_hours_is_not_negative(db):
    # Review Focus 1, against the real rollup.
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel")
    await insert_readings(db, point, T0 - HOUR + 50 * MINUTE, 1, [500.0])
    await insert_readings(db, point, T0 + 5 * MINUTE, 25 * 60, [3.0, 9.0])  # 00:05 and 00:30
    await settle_rollups(db)
    assert (await energy()).hours[asset] == {T0: HourEnergy(6.0, False)}


async def test_the_scale_applies_after_the_maths_and_bad_quality_readings_are_ignored(db):
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel", scale=0.001)  # the counter reads Wh
    await insert_readings(db, point, T0 - HOUR + 30 * MINUTE, 1, [100_000.0])
    await insert_readings(db, point, T0 + 5 * MINUTE, 900, [110_000.0, 5_000.0, 8_000.0])
    await db.execute(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, 99999999, 1)", point, T0 + 10 * MINUTE
    )
    await settle_rollups(db)
    assert (await energy()).hours[asset] == {T0: HourEnergy(pytest.approx(13.0), False)}


async def test_a_counter_beats_active_power_on_the_same_asset(db):
    source = await make_source(db)
    asset = await make_asset(db, "Panel")
    counter, power = await make_point(db, source, "kWh"), await make_point(db, source, "kW")
    await make_mapping(db, counter, asset, "energy_kwh", 60)
    await make_mapping(db, power, asset, "active_power_kw", 10)
    await insert_readings(db, counter, T0 - HOUR + 30 * MINUTE, 1, [100.0])
    await insert_readings(db, counter, T0 + 10 * MINUTE, 1, [105.0])
    await insert_readings(db, power, T0, 10, [12.0] * 360)  # a full hour at 12 kW would be 12 kWh
    await settle_rollups(db)
    assert (await energy()).hours[asset] == {T0: HourEnergy(5.0, False)}


# ---- power-only meters ------------------------------------------------------------------------


async def test_a_power_only_meter_with_a_20_minute_outage_counts_the_covered_time(db):
    # Review Focus 1. 12 kW every 10 s for 40 minutes, then nothing until the end of the hour.
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel", metric="active_power_kw", interval=10)
    await insert_readings(db, point, T0, 10, [12.0] * 240)
    await settle_rollups(db)

    hours = (await energy()).hours[asset]

    assert list(hours) == [T0]
    assert hours[T0].kwh == pytest.approx(8.0) and hours[T0].estimated is True


async def test_a_one_second_poll_with_a_slow_read_is_covered_by_its_minutes_with_a_gap(db):
    # A 1 s mapping whose read takes 250 ms is sampled every 1.25 s (2880 samples an hour), so n x interval would
    # see 80% coverage in a perfect hour. Hour 0 has no gap; hour 1 loses minutes 20-29 (a 10-minute outage).
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel", metric="active_power_kw", interval=1)
    await insert_readings(db, point, T0, 1.25, [12.0] * 2880)
    await insert_readings(db, point, T0 + HOUR, 1.25, [12.0] * (20 * 48))  # minutes 0-19
    await insert_readings(db, point, T0 + HOUR + 30 * MINUTE, 1.25, [12.0] * (30 * 48))  # minutes 30-59
    await settle_rollups(db)

    hours = (await energy(T0, T0 + 2 * HOUR)).hours[asset]

    assert list(hours) == [T0, T0 + HOUR]
    assert hours[T0].kwh == pytest.approx(12.0) and hours[T0].estimated is True
    assert hours[T0 + HOUR].kwh == pytest.approx(12.0 * 50 / 60)  # 50 of 60 minutes have samples


# ---- roll-up ----------------------------------------------------------------------------------


async def test_a_silent_meter_counts_zero_and_does_not_fall_back_to_its_children(db):
    # Review Focus 1, against the real rollup. MV2 is metered but recorded nothing; its child did.
    source = await make_source(db)
    mv2, _ = await meter(db, source, "MV2")
    child, point = await meter(db, source, "LV Panel 1", mv2)
    await insert_readings(db, point, T0 - HOUR + 30 * MINUTE, 1, [100.0])
    await insert_readings(db, point, T0 + 10 * MINUTE, 1, [107.0])
    await settle_rollups(db)

    result = await energy()

    assert result.hours[mv2] == {}
    assert total(result.hours[mv2]) == Energy(0.0, False)
    assert result.hours[child] == {T0: HourEnergy(7.0, False)}


async def test_a_parent_sums_its_children_and_an_unmapped_asset_has_no_figure(db):
    source = await make_source(db)
    site = await make_asset(db, "Site")
    mv2 = await make_asset(db, "MV2", site)
    spare = await make_asset(db, "Spare", site)
    lv1, counter = await meter(db, source, "LV Panel 1", mv2)
    lv2, power = await meter(db, source, "LV Panel 2", mv2, metric="active_power_kw", interval=10)
    await insert_readings(db, counter, T0 - HOUR + 30 * MINUTE, 1, [100.0])
    await insert_readings(db, counter, T0 + 10 * MINUTE, 1, [107.0])
    await insert_readings(db, power, T0, 10, [6.0] * 60)  # 6 kW for 10 minutes = 1 kWh
    await settle_rollups(db)

    result = await energy()

    assert result.hours[mv2] == {T0: HourEnergy(pytest.approx(8.0), True)}
    assert result.hours[site] == result.hours[mv2]  # Spare has no figure and is skipped, not counted as zero
    assert result.hours[spare] is None
    assert total(result.hours[spare]) is None
    assert result.own == frozenset({lv1, lv2})


async def test_a_power_only_meter_with_no_readings_is_an_estimated_zero_for_every_hour(db):
    # Spec section 6: power-only consumption is labeled estimated wherever it is shown, even when it is zero.
    source = await make_source(db)
    asset, _ = await meter(db, source, "Panel", metric="active_power_kw", interval=10)
    counter_asset, _ = await meter(db, source, "Metered")  # a counter that recorded nothing is an exact zero

    result = await energy()

    assert result.hours[asset] == {T0 + n * HOUR: HourEnergy(0.0, True) for n in range(3)}
    assert total(result.hours[asset]) == Energy(0.0, True)
    assert result.hours[counter_asset] == {} and total(result.hours[counter_asset]) == Energy(0.0, False)


async def test_a_parent_of_a_counter_and_a_silent_power_meter_is_estimated(db):
    source = await make_source(db)
    parent = await make_asset(db, "MV2")
    _, counter = await meter(db, source, "LV Panel 1", parent)
    await meter(db, source, "LV Panel 2", parent, metric="active_power_kw", interval=10)  # no readings
    await insert_readings(db, counter, T0 - HOUR + 30 * MINUTE, 1, [100.0])
    await insert_readings(db, counter, T0 + 10 * MINUTE, 1, [107.0])
    await settle_rollups(db)

    assert total((await energy()).hours[parent]) == Energy(7.0, True)


async def test_assets_with_nothing_mapped_have_no_figure(db):
    asset = await make_asset(db, "Empty")
    result = await energy()
    assert result.hours == {asset: None} and result.own == frozenset()


async def test_the_range_must_be_timezone_aware(db):
    with pytest.raises(ValueError, match="timezone"):
        await energy(datetime(2026, 6, 10), T0 + HOUR)


# ---- an own meter counts only from its first reading ----------------------------------------------


async def parent_with_children_and_a_late_meter(db, source, own_first_hour):
    """MV2 with two counter children that read in every hour from T0 - 1h (LV1 +2 kWh an hour, LV2 +3), and a
    counter of its own that first reads in hour `own_first_hour` of the day: two readings 40 minutes apart in
    that hour (+4 kWh), then one an hour (+10 kWh each)."""
    mv2, own = await meter(db, source, "MV2")
    lv1, p1 = await meter(db, source, "LV1", mv2)
    lv2, p2 = await meter(db, source, "LV2", mv2)
    for point, step in ((p1, 2.0), (p2, 3.0)):
        await insert_readings(db, point, T0 - HOUR + 30 * MINUTE, 3600, [step * i for i in range(8)])
    first = T0 + own_first_hour * HOUR
    await insert_readings(db, own, first + 10 * MINUTE, 40 * 60, [500.0, 504.0])
    await insert_readings(db, own, first + HOUR + 30 * MINUTE, 3600, [514.0, 524.0, 534.0])
    await settle_rollups(db)
    return mv2, lv1, lv2


async def test_a_parent_given_a_counter_later_keeps_its_earlier_hours_as_the_sum_of_its_children(db):
    # The owner's case: an own meter mapped on 20 October must not zero the parent's September.
    source = await make_source(db)
    mv2, lv1, lv2 = await parent_with_children_and_a_late_meter(db, source, own_first_hour=3)

    result = await energy(T0, T0 + 7 * HOUR)

    children = {b: result.hours[lv1][b].kwh + result.hours[lv2][b].kwh for b in (T0, T0 + HOUR, T0 + 2 * HOUR)}
    assert children == {T0: 5.0, T0 + HOUR: 5.0, T0 + 2 * HOUR: 5.0}  # the first hour counts from the baseline
    assert result.hours[mv2] == {
        T0: HourEnergy(5.0, False), T0 + HOUR: HourEnergy(5.0, False), T0 + 2 * HOUR: HourEnergy(5.0, False),
        T0 + 3 * HOUR: HourEnergy(4.0, False),  # the meter, not the children's 5
        T0 + 4 * HOUR: HourEnergy(10.0, False), T0 + 5 * HOUR: HourEnergy(10.0, False),
        T0 + 6 * HOUR: HourEnergy(10.0, False),
    }
    assert result.own_from[mv2] == T0 + 3 * HOUR
    assert mv2 in result.own


async def test_hours_before_a_parents_first_reading_have_no_entry_when_its_children_have_none_either(db):
    source = await make_source(db)
    mv2, own = await meter(db, source, "MV2")
    await insert_readings(db, own, T0 + 2 * HOUR + 10 * MINUTE, 40 * 60, [500.0, 504.0])
    await settle_rollups(db)

    result = await energy(T0, T0 + 4 * HOUR)

    assert result.hours[mv2] == {T0 + 2 * HOUR: HourEnergy(4.0, False)}  # nothing for the two hours before
    assert result.own_from[mv2] == T0 + 2 * HOUR


async def test_a_first_bucket_before_the_range_start_changes_nothing(db):
    source = await make_source(db)
    mv2, own = await meter(db, source, "MV2")
    lv1, child = await meter(db, source, "LV1", mv2)
    await insert_readings(db, own, T0 - 5 * HOUR + 30 * MINUTE, 3600, [500.0 + 10 * i for i in range(11)])  # hours -5..5
    await insert_readings(db, child, T0 - HOUR + 30 * MINUTE, 3600, [5.0 * i for i in range(7)])  # 5 kWh an hour
    await settle_rollups(db)

    result = await energy(T0 + 2 * HOUR, T0 + 5 * HOUR)

    assert result.hours[mv2] == {T0 + n * HOUR: HourEnergy(10.0, False) for n in (2, 3, 4)}  # the meter, not 5
    assert result.own_from[mv2] == T0 + 2 * HOUR  # the range start, since the first bucket is earlier


async def test_a_meter_that_first_reads_after_the_range_is_its_children_for_the_whole_range(db):
    source = await make_source(db)
    mv2, lv1, lv2 = await parent_with_children_and_a_late_meter(db, source, own_first_hour=5)

    result = await energy(T0, T0 + 3 * HOUR)

    assert result.hours[mv2] == {b: HourEnergy(5.0, False) for b in (T0, T0 + HOUR, T0 + 2 * HOUR)}
    assert result.own_from[mv2] == T0 + 5 * HOUR


async def test_a_power_only_meter_that_first_reads_after_the_range_is_its_children_not_estimated_zeros(db):
    source = await make_source(db)
    mv2, own = await meter(db, source, "MV2", metric="active_power_kw", interval=10)
    lv1, counter = await meter(db, source, "LV1", mv2)
    await insert_readings(db, counter, T0 - HOUR + 30 * MINUTE, 3600, [100.0, 107.0])
    await insert_readings(db, own, T0 + 5 * HOUR, 10, [6.0] * 60)  # first reads in hour 5
    await settle_rollups(db)

    result = await energy(T0, T0 + 3 * HOUR)

    assert result.hours[mv2] == {T0: HourEnergy(7.0, False)}
    # while a range that includes its first hour has it as a real, estimated hour
    assert (await energy(T0, T0 + 6 * HOUR)).hours[mv2][T0 + 5 * HOUR] == HourEnergy(pytest.approx(1.0), True)


async def test_a_first_bucket_months_before_the_range_is_still_found_and_the_meter_wins(db):
    # The first bucket is looked up over the whole history, not only the requested range.
    source = await make_source(db)
    mv2, own = await meter(db, source, "MV2")
    lv1, child = await meter(db, source, "LV1", mv2)
    await insert_readings(db, own, T0 - timedelta(days=90), 3600, [500.0, 501.0])
    await insert_readings(db, own, T0 + 30 * MINUTE, 1, [600.0])
    await insert_readings(db, child, T0 - HOUR + 30 * MINUTE, 3600, [100.0, 105.0])
    await settle_rollups(db)

    result = await energy(T0, T0 + 2 * HOUR)

    assert result.hours[mv2] == {T0: HourEnergy(99.0, False)}  # the meter's 501 -> 600, not the child's 5
    assert result.own_from[mv2] == T0


# ---- daylight saving (Review Focus 2) and size ------------------------------------------------


async def test_a_dst_month_splits_into_local_days_that_add_up_to_the_month(db):
    # Review Focus 2. March 2026 in Berlin has a 23-hour day (the 29th). One reading an hour, +1 kWh each.
    source = await make_source(db)
    asset, point = await meter(db, source, "Panel")
    start, end = month_bounds("2026-03", "Europe/Berlin")
    hours = (end - start) // HOUR
    assert hours == 743
    # One reading an hour from the hour before the month; the last (hours + 1) lands in the bucket that begins
    # exactly at `end`, which the exclusive upper bound must leave out.
    await insert_readings(db, point, start - HOUR, 3600, [float(i) for i in range(hours + 2)])
    await settle_rollups(db)

    month = (await energy(start, end)).hours[asset]

    assert len(month) == hours and total(month) == Energy(float(hours), False)
    per_day = {
        day: sum(h.kwh for bucket, h in month.items() if frm <= bucket < to)
        for day, frm, to in local_days(start, end, "Europe/Berlin")
    }
    assert per_day[date(2026, 3, 29)] == 23.0
    assert {kwh for day, kwh in per_day.items() if day.day != 29} == {24.0}
    assert sum(per_day.values()) == total(month).kwh  # no hour dropped or counted twice


async def test_sixty_meters_over_a_month_are_read_in_one_batched_query(db):
    source = await make_source(db)
    site = await make_asset(db, "Site")
    start, hours = T0, 31 * 24
    for number in range(60):
        _, point = await meter(db, source, f"Panel {number:02d}", site)
        # one reading an hour from the hour before the range, rising 2 kWh every hour
        await insert_readings(db, point, start - HOUR, 3600, [2.0 * i for i in range(hours + 1)])
    await settle_rollups(db)

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    async with get_sessionmaker()() as session:
        tree = await AssetTree.load(session)
        sync_engine = get_engine().sync_engine
        event.listen(sync_engine, "before_cursor_execute", record)
        try:
            result = await hourly_energy(session, tree, start, start + hours * HOUR)
        finally:
            event.remove(sync_engine, "before_cursor_execute", record)

    assert sum("readings_1h" in statement for statement in statements) == 1  # all 60 points in one statement
    assert len(statements) <= 2  # that one and the mappings; nothing per asset
    assert total(result.hours[site]) == Energy(pytest.approx(60 * 2.0 * hours), False)
    assert all(len(result.hours[a]) == hours for a in tree.nodes if a != site)
