from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from dcdash.core.cost import Cost, HourCost, TariffRow, cost_by_hour, load_tariffs, rate_at, summarize
from dcdash.core.db import get_sessionmaker
from dcdash.core.energy import EnergyResult, HourEnergy
from dcdash.core.tree import AssetNode, AssetTree
from helpers import make_asset

UTC = timezone.utc
ROOT, MV2, PANEL1, PANEL2 = 1, 2, 3, 4
ASSETS = (ROOT, MV2, PANEL1, PANEL2)


# Root(1) -> MV2(2) -> LV Panel 1(3), LV Panel 2(4)
TREE = AssetTree([
    AssetNode(ROOT, None, "Site", 0),
    AssetNode(MV2, ROOT, "MV2", 0),
    AssetNode(PANEL1, MV2, "LV Panel 1", 0),
    AssetNode(PANEL2, MV2, "LV Panel 2", 0),
])


def hour(day: int, h: int) -> datetime:
    return datetime(2026, 10, day, h, tzinfo=UTC)


def metered(*pairs, estimated: bool = False) -> dict[datetime, HourEnergy]:
    return {bucket: HourEnergy(kwh, estimated) for bucket, kwh in pairs}


def engine(meters: dict[int, dict[datetime, HourEnergy]]) -> EnergyResult:
    """What hourly_energy returns when only the assets in `meters` have their own meter:
    their parents sum them, assets with nothing underneath are None."""
    figures: dict[int, dict[datetime, HourEnergy] | None] = {asset: None for asset in ASSETS}
    figures.update(meters)
    children = [figures[a] for a in (PANEL1, PANEL2) if figures[a] is not None]
    summed: dict[datetime, HourEnergy] = {}
    for child in children:
        for bucket, h in child.items():
            before = summed.get(bucket)
            summed[bucket] = HourEnergy(
                (before.kwh if before else 0.0) + h.kwh, bool(before and before.estimated) or h.estimated
            )
    if children and MV2 not in meters:
        figures[MV2] = figures[ROOT] = summed
    return EnergyResult(hours=figures, own=frozenset(meters))


def test_rate_at_takes_the_latest_row_on_or_before_the_day():
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1)), TariffRow(None, 0.12, date(2026, 6, 1))]
    for rows in (tariffs, list(reversed(tariffs))):  # input order must not matter
        assert rate_at(rows, TREE, PANEL1, date(2025, 12, 31)) is None
        assert rate_at(rows, TREE, PANEL1, date(2026, 1, 1)) == 0.10
        assert rate_at(rows, TREE, PANEL1, date(2026, 5, 31)) == 0.10
        assert rate_at(rows, TREE, PANEL1, date(2026, 6, 1)) == 0.12
    assert rate_at([], TREE, PANEL1, date(2026, 6, 1)) is None


def test_a_child_override_beats_the_site_default_only_from_its_own_date():  # Review Focus 3
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1)), TariffRow(PANEL1, 0.20, date(2026, 10, 3))]
    assert rate_at(tariffs, TREE, PANEL1, date(2026, 10, 2)) == 0.10  # earlier days keep the inherited rate
    assert rate_at(tariffs, TREE, PANEL1, date(2026, 10, 3)) == 0.20
    assert rate_at(tariffs, TREE, PANEL2, date(2026, 10, 3)) == 0.10  # a sibling is untouched
    assert rate_at(tariffs, TREE, MV2, date(2026, 10, 3)) == 0.10  # and so is the parent


def test_the_nearest_ancestor_with_a_row_in_effect_wins():  # Review Focus 3
    tariffs = [
        TariffRow(None, 0.10, date(2026, 1, 1)),
        TariffRow(MV2, 0.15, date(2026, 9, 1)),
        TariffRow(PANEL1, 0.20, date(2026, 10, 3)),
        TariffRow(ROOT, 0.99, date(2026, 12, 1)),  # not in effect yet: skipped, never used early
    ]
    assert rate_at(tariffs, TREE, PANEL1, date(2026, 10, 2)) == 0.15  # its own row has not started; MV2's applies
    assert rate_at(tariffs, TREE, PANEL1, date(2026, 10, 3)) == 0.20
    assert rate_at(tariffs, TREE, PANEL2, date(2026, 10, 3)) == 0.15
    assert rate_at(tariffs, TREE, MV2, date(2026, 8, 31)) == 0.10  # before MV2's own row: the site default
    assert rate_at(tariffs, TREE, ROOT, date(2026, 10, 3)) == 0.10
    assert rate_at(tariffs, TREE, ROOT, date(2026, 12, 1)) == 0.99


def test_no_tariff_means_cost_none_never_zero():  # Review Focus 3
    energy = engine({PANEL1: metered((hour(2, 10), 4.0), (hour(2, 11), 6.0))})
    costs = cost_by_hour(energy, [], TREE, "UTC")
    leaf = costs[PANEL1]
    assert [h.cost for h in leaf.values()] == [None, None]
    assert all(h.unpriced for h in leaf.values())
    assert all(h.cost is None for h in costs[MV2].values())
    assert summarize(leaf.values()) == Cost(kwh=10.0, cost=None, estimated=False, partial=True)


def test_a_rate_that_starts_mid_period_leaves_the_earlier_hours_unpriced():  # Review Focus 3
    tariffs = [TariffRow(None, 0.5, date(2026, 10, 3))]
    before = datetime(2026, 10, 2, 20, tzinfo=UTC)  # Asia/Qatar is UTC+3: 23:00 on the 2nd
    midnight = datetime(2026, 10, 2, 21, tzinfo=UTC)  # 00:00 on the 3rd
    energy = engine({PANEL1: metered((before, 2.0), (midnight, 4.0), (hour(3, 9), 6.0))})
    leaf = cost_by_hour(energy, tariffs, TREE, "Asia/Qatar")[PANEL1]
    assert leaf[before] == HourCost(kwh=2.0, cost=None, estimated=False, unpriced=True)
    assert leaf[midnight] == HourCost(kwh=4.0, cost=2.0, estimated=False, unpriced=False)
    assert leaf[hour(3, 9)] == HourCost(kwh=6.0, cost=3.0, estimated=False, unpriced=False)
    assert summarize(leaf.values()) == Cost(kwh=12.0, cost=5.0, estimated=False, partial=True)


def test_a_child_override_prices_from_its_date_and_earlier_hours_keep_the_inherited_rate():  # Review Focus 3
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1)), TariffRow(PANEL1, 0.20, date(2026, 10, 3))]
    energy = engine({PANEL1: metered((hour(2, 23), 10.0), (hour(3, 0), 10.0))})
    leaf = cost_by_hour(energy, tariffs, TREE, "UTC")[PANEL1]
    assert leaf[hour(2, 23)].cost == pytest.approx(1.0)
    assert leaf[hour(3, 0)].cost == pytest.approx(2.0)


def test_a_parent_without_a_meter_sums_its_children_including_a_child_override():  # Review Focus 3
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1)), TariffRow(PANEL2, 0.50, date(2026, 10, 1))]
    energy = engine({
        PANEL1: metered((hour(3, 9), 10.0)),
        PANEL2: metered((hour(3, 9), 2.0), estimated=True),
    })
    costs = cost_by_hour(energy, tariffs, TREE, "UTC")
    for parent in (MV2, ROOT):
        figure = costs[parent][hour(3, 9)]
        assert figure.kwh == pytest.approx(12.0)
        assert figure.cost == pytest.approx(10 * 0.10 + 2 * 0.50)
        assert figure.estimated is True and figure.unpriced is False


def test_a_parent_is_partial_when_one_child_has_no_rate():  # Review Focus 3
    tariffs = [TariffRow(PANEL2, 0.50, date(2026, 10, 1))]  # no default: LV Panel 1 has no rate at all
    energy = engine({PANEL1: metered((hour(3, 9), 10.0)), PANEL2: metered((hour(3, 9), 2.0))})
    costs = cost_by_hour(energy, tariffs, TREE, "UTC")
    figure = costs[MV2][hour(3, 9)]
    assert figure.cost == pytest.approx(1.0) and figure.unpriced is True
    assert summarize(costs[MV2].values()) == Cost(kwh=12.0, cost=pytest.approx(1.0), estimated=False, partial=True)


def test_an_hour_with_no_consumption_and_no_rate_is_not_partial():  # Review Focus 3
    energy = engine({PANEL1: metered((hour(3, 9), 0.0))})
    leaf = cost_by_hour(energy, [], TREE, "UTC")[PANEL1]
    assert leaf[hour(3, 9)] == HourCost(kwh=0.0, cost=None, estimated=False, unpriced=False)
    assert summarize(leaf.values()) == Cost(kwh=0.0, cost=None, estimated=False, partial=False)


def test_zero_kwh_with_a_rate_costs_zero_not_none():  # Review Focus 3
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1))]
    leaf = cost_by_hour(engine({PANEL1: metered((hour(3, 9), 0.0))}), tariffs, TREE, "UTC")[PANEL1]
    assert leaf[hour(3, 9)].cost == 0.0 and leaf[hour(3, 9)].cost is not None
    assert summarize(leaf.values()) == Cost(kwh=0.0, cost=0.0, estimated=False, partial=False)


def test_an_estimated_zero_hour_is_a_priced_zero_never_unpriced():  # a silent power-only meter, Review Focus 3
    silent = metered((hour(3, 9), 0.0), (hour(3, 10), 0.0), estimated=True)
    priced = cost_by_hour(engine({PANEL1: silent}), [TariffRow(None, 0.10, date(2026, 1, 1))], TREE, "UTC")
    assert priced[PANEL1][hour(3, 9)] == HourCost(kwh=0.0, cost=0.0, estimated=True, unpriced=False)
    assert summarize(priced[PANEL1].values()) == Cost(kwh=0.0, cost=0.0, estimated=True, partial=False)
    assert summarize(priced[MV2].values()) == Cost(kwh=0.0, cost=0.0, estimated=True, partial=False)
    unrated = cost_by_hour(engine({PANEL1: silent}), [], TREE, "UTC")
    assert unrated[PANEL1][hour(3, 9)] == HourCost(kwh=0.0, cost=None, estimated=True, unpriced=False)
    assert summarize(unrated[MV2].values()) == Cost(kwh=0.0, cost=None, estimated=True, partial=False)


def test_assets_without_an_energy_figure_stay_none():
    costs = cost_by_hour(engine({}), [TariffRow(None, 0.10, date(2026, 1, 1))], TREE, "UTC")
    assert costs == {ROOT: None, MV2: None, PANEL1: None, PANEL2: None}


def test_a_parent_skips_children_that_have_no_figure():
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1))]
    costs = cost_by_hour(engine({PANEL1: metered((hour(3, 9), 5.0))}), tariffs, TREE, "UTC")
    assert costs[PANEL2] is None
    assert costs[MV2][hour(3, 9)].cost == pytest.approx(0.5)


def test_a_meter_with_no_readings_is_an_empty_figure_not_none():
    costs = cost_by_hour(engine({PANEL1: {}}), [TariffRow(None, 0.10, date(2026, 1, 1))], TREE, "UTC")
    assert costs[PANEL1] == {} and costs[MV2] == {}
    # the caller says no rate is in effect, so there is nothing to price: a dash
    assert summarize(costs[PANEL1].values(), rate_in_effect=False) == Cost(0.0, None, False, False)


def test_a_parent_with_its_own_meter_is_priced_from_that_meter_not_its_children():
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1))]
    energy = EnergyResult(
        hours={
            ROOT: metered((hour(3, 9), 7.0)),  # no meter of its own: the engine gives it MV2's hours
            MV2: metered((hour(3, 9), 7.0)),
            PANEL1: metered((hour(3, 9), 3.0)),
            PANEL2: None,
        },
        own=frozenset({MV2, PANEL1}),
    )
    costs = cost_by_hour(energy, tariffs, TREE, "UTC")
    assert costs[MV2][hour(3, 9)].kwh == 7.0
    assert costs[MV2][hour(3, 9)].cost == pytest.approx(0.7)  # MV2's meter, not PANEL1's 3 kWh
    assert costs[ROOT][hour(3, 9)].cost == pytest.approx(0.7)  # the root sums its only child, MV2


def late_meter_energy() -> EnergyResult:
    """MV2 got its own meter whose first hour is 11:00. Before it, MV2 is what its panels add up to (here only
    LV Panel 1, 10 kWh an hour); from it on MV2 is the meter (4 kWh an hour) although LV Panel 1 keeps reading."""
    children = metered(
        (hour(3, 9), 10.0), (hour(3, 10), 10.0), (hour(3, 11), 10.0), (hour(3, 12), 10.0), (hour(3, 13), 10.0)
    )  # at 13:00 the meter recorded nothing: that hour has no entry for MV2, and is not filled from its panel
    mv2 = metered((hour(3, 9), 10.0), (hour(3, 10), 10.0), (hour(3, 11), 4.0), (hour(3, 12), 4.0))
    return EnergyResult(
        hours={ROOT: mv2, MV2: mv2, PANEL1: children, PANEL2: None},
        own=frozenset({MV2, PANEL1}),
        own_from={MV2: hour(3, 11)},
    )


def test_a_parent_whose_own_meter_starts_later_is_priced_from_its_children_before_that():
    # LV Panel 1 has its own, dearer rate: the parent's early hours must carry it (the children's cost), not the
    # parent's own rate, and the children's later hours must not leak into the meter's hours.
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1)), TariffRow(PANEL1, 0.50, date(2026, 10, 1))]
    costs = cost_by_hour(late_meter_energy(), tariffs, TREE, "UTC")
    mv2 = costs[MV2]
    assert list(mv2) == [hour(3, 9), hour(3, 10), hour(3, 11), hour(3, 12)]
    assert mv2[hour(3, 9)] == HourCost(kwh=10.0, cost=5.0, estimated=False, unpriced=False)  # 10 x LV Panel 1's 0.50
    assert mv2[hour(3, 10)].cost == pytest.approx(5.0)
    assert mv2[hour(3, 11)] == HourCost(kwh=4.0, cost=pytest.approx(0.4), estimated=False, unpriced=False)  # 4 x 0.10
    assert mv2[hour(3, 12)].cost == pytest.approx(0.4)
    assert costs[ROOT] == mv2  # the site sums MV2 only


def test_an_own_from_that_is_the_first_hour_prices_everything_from_the_meter():
    energy = EnergyResult(
        hours={ROOT: metered((hour(3, 9), 4.0)), MV2: metered((hour(3, 9), 4.0)),
               PANEL1: metered((hour(3, 9), 10.0)), PANEL2: None},
        own=frozenset({MV2, PANEL1}),
        own_from={MV2: hour(3, 9), PANEL1: hour(3, 9)},
    )
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1)), TariffRow(PANEL1, 0.50, date(2026, 10, 1))]
    costs = cost_by_hour(energy, tariffs, TREE, "UTC")
    assert costs[MV2][hour(3, 9)].cost == pytest.approx(0.4)
    assert costs[PANEL1][hour(3, 9)].cost == pytest.approx(5.0)


def test_nested_late_meters_are_priced_layer_by_layer():
    # Site > MV2 > Panel > Circuit. The circuit has always been metered; the panel's meter starts at 10:00 and MV2's
    # at 12:00. Each layer has its own rate, so the rate that prices an hour shows which layer supplied it.
    nested = AssetTree([
        AssetNode(ROOT, None, "Site", 0), AssetNode(MV2, ROOT, "MV2", 0), AssetNode(PANEL1, MV2, "Panel", 0),
        AssetNode(5, PANEL1, "Circuit", 0),
    ])
    tariffs = [
        TariffRow(None, 0.10, date(2026, 1, 1)),
        TariffRow(PANEL1, 0.20, date(2026, 10, 1)),
        TariffRow(5, 0.50, date(2026, 10, 1)),
    ]
    circuit = metered((hour(3, 9), 10.0), (hour(3, 10), 10.0), (hour(3, 11), 10.0), (hour(3, 12), 10.0))
    panel = metered((hour(3, 9), 10.0), (hour(3, 10), 6.0), (hour(3, 11), 6.0), (hour(3, 12), 6.0))
    mv2 = metered((hour(3, 9), 10.0), (hour(3, 10), 6.0), (hour(3, 11), 6.0), (hour(3, 12), 3.0))
    energy = EnergyResult(
        hours={ROOT: mv2, MV2: mv2, PANEL1: panel, 5: circuit},
        own=frozenset({MV2, PANEL1, 5}),
        own_from={MV2: hour(3, 12), PANEL1: hour(3, 10)},
    )

    costs = cost_by_hour(energy, tariffs, nested, "UTC")

    assert [h.cost for h in costs[5].values()] == pytest.approx([5.0] * 4)
    assert [h.cost for h in costs[PANEL1].values()] == pytest.approx([5.0, 1.2, 1.2, 1.2])  # circuit's 0.50, then 0.20
    # MV2: the circuit's rate through the panel, then the panel's own rate, then MV2's (the site default 0.10)
    assert [h.cost for h in costs[MV2].values()] == pytest.approx([5.0, 1.2, 1.2, 0.3])
    assert list(costs[MV2]) == [hour(3, 9), hour(3, 10), hour(3, 11), hour(3, 12)]
    assert [h.cost for h in costs[ROOT].values()] == pytest.approx([5.0, 1.2, 1.2, 0.3])


def test_estimated_hours_make_the_figure_estimated():
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1))]
    energy = engine({PANEL1: metered((hour(3, 9), 4.0), estimated=True)})
    leaf = cost_by_hour(energy, tariffs, TREE, "UTC")[PANEL1]
    assert summarize(leaf.values()) == Cost(kwh=4.0, cost=pytest.approx(0.4), estimated=True, partial=False)


def test_summarize_adds_priced_hours_and_flags_estimates_and_gaps():
    figure = summarize([
        HourCost(1.0, 0.5, False, False),
        HourCost(2.0, None, True, True),
        HourCost(0.0, None, False, False),
    ])
    assert figure == Cost(kwh=3.0, cost=0.5, estimated=True, partial=True)


def test_summarize_of_nothing_without_a_rate_in_effect_is_a_dash_not_zero():
    assert summarize([]) == Cost(kwh=0.0, cost=None, estimated=False, partial=False)  # the default
    assert summarize([], rate_in_effect=False) == Cost(kwh=0.0, cost=None, estimated=False, partial=False)


def test_summarize_of_nothing_with_a_rate_in_effect_is_a_zero_not_a_dash():  # Review Focus 3
    assert summarize([], rate_in_effect=True) == Cost(kwh=0.0, cost=0.0, estimated=False, partial=False)
    assert summarize(iter(()), rate_in_effect=True) == Cost(kwh=0.0, cost=0.0, estimated=False, partial=False)


def test_summarize_of_some_hours_ignores_rate_in_effect():
    unpriced = [HourCost(2.0, None, True, True), HourCost(0.0, None, False, False)]
    priced = [HourCost(1.0, 0.5, False, False)]
    for flag in (False, True):
        assert summarize(unpriced, rate_in_effect=flag) == Cost(kwh=2.0, cost=None, estimated=True, partial=True)
        assert summarize(priced, rate_in_effect=flag) == Cost(kwh=1.0, cost=0.5, estimated=False, partial=False)
        assert summarize([HourCost(0.0, None, False, False)], rate_in_effect=flag) == Cost(0.0, None, False, False)


def test_a_silent_counter_under_a_site_default_costs_zero_when_the_caller_knows_a_rate_is_in_effect():
    """An hour-less period (a comms outage, days before collection started, a silent counter meter) still has
    a rate: the caller asks rate_at for the period's last local day and passes the answer as rate_in_effect."""
    tariffs = [TariffRow(None, 0.10, date(2026, 1, 1))]
    costs = cost_by_hour(engine({PANEL1: {}}), tariffs, TREE, "UTC")
    assert costs[PANEL1] == {}
    for asset in (PANEL1, MV2):
        in_effect = rate_at(tariffs, TREE, asset, date(2026, 10, 3)) is not None
        assert summarize(costs[asset].values(), rate_in_effect=in_effect) == Cost(0.0, 0.0, False, False)
    not_yet = rate_at(tariffs, TREE, PANEL1, date(2025, 12, 31)) is not None  # the rate starts after the period
    assert summarize(costs[PANEL1].values(), rate_in_effect=not_yet) == Cost(0.0, None, False, False)
    nothing = rate_at([], TREE, PANEL1, date(2026, 10, 3)) is not None  # no tariff at all
    assert summarize(costs[PANEL1].values(), rate_in_effect=nothing) == Cost(0.0, None, False, False)


def test_the_fall_back_day_is_priced_by_local_date_across_its_25_hours():
    """Europe/Amsterdam leaves summer time on 2026-10-25 (local 03:00 -> 02:00): that day has 25 UTC buckets.
    A rate effective on the local 25th starts at 22:00Z on the 24th, not at UTC midnight."""
    amsterdam = ZoneInfo("Europe/Amsterdam")
    tariffs = [TariffRow(None, 0.30, date(2026, 10, 25))]
    first = datetime(2026, 10, 24, 21, tzinfo=UTC)  # 23:00 on the 24th, local summer time: before the rate
    buckets = [first + timedelta(hours=i) for i in range(27)]  # 21:00Z on the 24th through 23:00Z on the 25th
    leaf = cost_by_hour(engine({PANEL1: {b: HourEnergy(2.0, False) for b in buckets}}), tariffs, TREE, "Europe/Amsterdam")[PANEL1]

    assert leaf[first] == HourCost(kwh=2.0, cost=None, estimated=False, unpriced=True)  # the 24th: not priced
    midnight = datetime(2026, 10, 24, 22, tzinfo=UTC)  # 00:00 on the 25th, summer time (UTC+2)
    assert midnight.astimezone(amsterdam).hour == 0 and midnight.astimezone(amsterdam).day == 25
    assert leaf[midnight].cost == pytest.approx(0.6)
    for twice in (datetime(2026, 10, 25, 0, tzinfo=UTC), datetime(2026, 10, 25, 1, tzinfo=UTC)):  # both 02:00s
        assert twice.astimezone(amsterdam).hour == 2
        assert leaf[twice].cost == pytest.approx(0.6)
    local_25th = [b for b in buckets if b.astimezone(amsterdam).date() == date(2026, 10, 25)]
    assert len(local_25th) == 25
    assert summarize(leaf[b] for b in local_25th) == Cost(
        kwh=50.0, cost=pytest.approx(25 * 2.0 * 0.30), estimated=False, partial=False
    )


async def test_load_tariffs_returns_every_row_as_plain_values(db):
    asset = await make_asset(db, "LV Panel 1")
    await db.execute(
        "INSERT INTO tariffs (asset_id, rate_per_kwh, effective_from) "
        "VALUES (NULL, 0.125, DATE '2026-01-01'), ($1, 0.2, DATE '2026-10-03')",
        asset,
    )
    async with get_sessionmaker()() as session:
        rows = await load_tariffs(session)
    assert sorted(rows, key=lambda r: r.effective_from) == [
        TariffRow(None, 0.125, date(2026, 1, 1)),
        TariffRow(asset, 0.2, date(2026, 10, 3)),
    ]


# ---- has_data is carried through the pricing ------------------------------------------------------


def test_an_hour_cost_has_data_unless_it_says_otherwise():
    assert HourCost(1.0, 0.5, False, False).has_data is True
    assert list(HourCost.__dataclass_fields__) == ["kwh", "cost", "estimated", "unpriced", "has_data"]


def test_cost_by_hour_carries_has_data_for_an_own_meter_and_for_a_sum_of_children():
    silent = {hour(3, 9): HourEnergy(0.0, True, False), hour(3, 10): HourEnergy(0.0, True, False)}
    real = {hour(3, 10): HourEnergy(4.0, False, True)}
    energy = EnergyResult(
        hours={
            ROOT: {hour(3, 9): silent[hour(3, 9)], hour(3, 10): HourEnergy(4.0, True, True)},
            MV2: {hour(3, 9): silent[hour(3, 9)], hour(3, 10): HourEnergy(4.0, True, True)},
            PANEL1: silent, PANEL2: real,
        },
        own=frozenset({PANEL1, PANEL2}),
    )
    costs = cost_by_hour(energy, [TariffRow(None, 0.10, date(2026, 1, 1))], TREE, "UTC")
    assert costs[PANEL1][hour(3, 9)].has_data is False and costs[PANEL1][hour(3, 10)].has_data is False
    assert costs[PANEL2][hour(3, 10)].has_data is True
    assert costs[MV2][hour(3, 9)].has_data is False  # only the silent panel contributed
    assert costs[MV2][hour(3, 10)].has_data is True  # one panel with data is enough
    assert costs[ROOT][hour(3, 10)].has_data is True


def test_the_earlier_hours_of_a_parent_with_a_late_meter_carry_their_childrens_has_data():
    children = {hour(3, 9): HourEnergy(0.0, True, False), hour(3, 11): HourEnergy(2.0, False, True)}
    mv2 = {hour(3, 9): HourEnergy(0.0, True, False), hour(3, 11): HourEnergy(5.0, False, True)}
    energy = EnergyResult(
        hours={ROOT: mv2, MV2: mv2, PANEL1: children, PANEL2: None},
        own=frozenset({MV2, PANEL1}),
        own_from={MV2: hour(3, 11)},
    )
    costs = cost_by_hour(energy, [TariffRow(None, 0.10, date(2026, 1, 1))], TREE, "UTC")
    assert costs[MV2][hour(3, 9)].has_data is False and costs[MV2][hour(3, 11)].has_data is True
