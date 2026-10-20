"""The shared figure values (core/figures.py): `MonthDays` and `WindowValues` equal what each handler used to compute for itself.

Two halves. The first needs no database: seeded random worlds go through TODAY'S engine (`tests/reference_engine.py`, copied from
main a62fce0) the old way, one asset and one `now` at a time, and the shared values must give the same entries and the same
tuples, compared with `==` and with `repr` (so `-0.0` counts). The second half uses a database: Billing and the comparison
card against the cache off, a request whose tree differs from the value's, a close that must not use an entry inside its TTL,
and the compute thread.
"""
import asyncio
import copy
import dataclasses
import json
import logging
import random
import threading
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import reference_engine as ref
from billing_helpers import add_counter, add_power, add_tariff, at, set_currency, set_zone
from dcdash.api import billing
from dcdash.core import cost, energy, figure_cache, figures
from dcdash.core import db as db_module
from dcdash.core import widgets as widgets_module
from dcdash.core.config import get_settings
from dcdash.core.db import get_sessionmaker
from dcdash.core.energy import hourly_energy
from dcdash.core.timeutil import local_days, month_bounds, resolve_range
from dcdash.core.tree import AssetNode, AssetTree
from dcdash.core.widgets import validate_config, widget_data
from helpers import insert_readings, login_as, make_asset, settle_rollups
from test_widget_data_compare import APRIL_READINGS, add_varied_counter
from test_engine_oracle import HOUR, World, gen_rows, gen_world, hours_in

UTC = timezone.utc


# ---- the old way, per asset, with the oracle ---------------------------------------------------------------------------------


def ref_priced(tree, meters, rows, baselines, first_buckets, tariffs, zone, start, end):
    """The engine as it was on a62fce0: `hourly_energy`'s two halves, then `cost_by_hour`. Returns (energy result, priced)."""
    result = ref.assemble(
        tree, {a: ref.Meter(*m) for a, m in meters.items()},
        {p: [ref.HourRow(*t) for t in ts] for p, ts in rows.items()}, dict(baselines), start, end, dict(first_buckets),
    )
    return result, ref.cost_by_hour(result, [ref.TariffRow(*t) for t in tariffs], tree, zone)


def live_inputs(meters, rows, baselines, first_buckets, tariffs):
    return (
        {a: energy.Meter(*m) for a, m in meters.items()},
        energy.EnergyRows(
            {p: [energy.HourRow(*t) for t in ts] for p, ts in rows.items()}, dict(baselines), dict(first_buckets)
        ),
        [cost.TariffRow(*t) for t in tariffs],
    )


def probes(days):
    """Instants around the days: before the month, on a day boundary, a microsecond either side of one, inside a day, at the end,
    long after, and a far future; each as an instant in UTC and the same instant in a zone with another offset."""
    mid = len(days) // 2
    found = [
        days[0][1] - timedelta(days=400), days[0][1] - HOUR * 5, days[0][1] - timedelta(microseconds=1), days[0][1],
        days[mid][1] - timedelta(microseconds=1), days[mid][1], days[mid][1] + timedelta(microseconds=1),
        days[mid][1] + (days[mid][2] - days[mid][1]) / 3, days[-1][1], days[-1][2] - timedelta(microseconds=1),
        days[-1][2], days[-1][2] + timedelta(days=3), figures.FAR_FUTURE,
    ]
    return found + [moment.astimezone(ZoneInfo("Asia/Tokyo")) for moment in found[3:9]]


def check_entries(tree, meters, rows, baselines, first_buckets, tariffs, zone, start, end) -> int:
    """`entries_at` against the old per-asset `day_entries`, for every asset and every probe; returns how many comparisons."""
    meters_, read, tariffs_ = live_inputs(meters, rows, baselines, first_buckets, tariffs)
    md = figures._build_month_days("fp", zone, start, end, tree, tariffs_, meters_, read)
    old_energy, priced = ref_priced(tree, meters, rows, baselines, first_buckets, tariffs, zone, start, end)
    old_tariffs = [ref.TariffRow(*t) for t in tariffs]
    days = local_days(start, end, zone)
    assert md.days == days and md.start_utc == start.astimezone(UTC) and md.tree is tree
    assert md.own == old_energy.own and md.own_from == old_energy.own_from
    assert list(md.entries) == tree.preorder() and all(len(e) == len(days) for e in md.entries.values())
    compared = 0
    for now in probes(days):
        for asset_id in tree.preorder():
            old = ref.day_entries(
                priced.get(asset_id), days, now=now,
                rate_on=lambda day, a=asset_id: ref.rate_at(old_tariffs, tree, a, day) is not None,
            )
            new = figures.entries_at(md, asset_id, now)
            assert new == old and repr(new) == repr(old), (asset_id, now)
            compared += 1
    return compared


def test_the_masked_entries_equal_day_entries_on_random_worlds():
    compared, features = 0, Counter()
    for seed in range(150):
        world: World = gen_world(seed, "gaps" if seed % 4 == 3 else "general")
        features.update(world.features)
        compared += check_entries(
            world.tree, world.meters, world.rows, world.baselines, world.first_buckets, world.tariffs, world.zone, *world.span
        )
    assert compared > 20000
    assert features["own_parent"] and features["gappy"] and features["first_inside"]  # the generator reached the hard shapes


MONTH_TREE = AssetTree([
    AssetNode(1, None, "Site", 0), AssetNode(2, 1, "A", 0), AssetNode(3, 1, "B", 1), AssetNode(4, 3, "C", 0),
    AssetNode(5, 3, "D", 1), AssetNode(6, None, "Annex", 5),
])
MONTH_TARIFFS = [
    (None, 0.12, date(2026, 1, 1)), (None, 0.15, date(2026, 10, 10)), (2, 0.2, date(2026, 10, 26)), (3, 0.17, date(2026, 3, 28)),
]


@pytest.mark.parametrize("zone", ["UTC", "Europe/London", "Europe/Berlin"])
@pytest.mark.parametrize("month", ["2026-03", "2026-10"])  # the clocks change in both
def test_the_masked_entries_equal_day_entries_across_a_clock_change(zone, month):
    start, end = month_bounds(month, zone)
    hrs = hours_in(start.astimezone(UTC), end.astimezone(UTC))
    for seed in range(4):
        rng, feats = random.Random(seed), Counter()
        meters = {2: (100, 1.0, 60, True), 4: (101, 3.7, 60, False), 5: (102, 1.0, 60, True), 6: (103, 0.001, 900, False)}
        rows, baselines = {}, {100: 250.0, 102: 4000.0}
        rows[100], _ = gen_rows(rng, hrs, True, 60, "gaps", 250.0, feats)
        rows[101], _ = gen_rows(rng, hrs, False, 60, "dense", None, feats)
        rows[102], _ = gen_rows(rng, hrs, True, 60, "late", 4000.0, feats)
        rows[103], _ = gen_rows(rng, hrs, False, 900, "single", None, feats)
        first_buckets = {100: hrs[0] - HOUR * 7, 101: rows[101][0][0], 102: hrs[0] - HOUR * 3, 103: rows[103][0][0]}
        check_entries(MONTH_TREE, meters, rows, baselines, first_buckets, MONTH_TARIFFS, zone, start, end)


def test_entries_at_hands_out_a_new_list_with_shared_entries_and_none_for_an_asset_it_does_not_hold():
    world = gen_world(7)
    meters, read, tariffs = live_inputs(world.meters, world.rows, world.baselines, world.first_buckets, world.tariffs)
    md = figures._build_month_days("fp", world.zone, *world.span, world.tree, tariffs, meters, read)
    asset = next(a for a, entries in md.entries.items() if any(e is not None for e in entries))
    first = figures.entries_at(md, asset, figures.FAR_FUTURE)
    again = figures.entries_at(md, asset, figures.FAR_FUTURE)
    assert first == again and first is not again and first is not md.entries[asset]
    first[0] = "scribble"
    assert md.entries[asset][0] != "scribble" and figures.entries_at(md, asset, figures.FAR_FUTURE) == again
    index = next(i for i, e in enumerate(again) if e is not None)
    assert figures.entries_at(md, asset, figures.FAR_FUTURE)[index] is md.entries[asset][index]  # the dicts are shared
    ghost = max(world.tree.nodes) + 1
    assert figures.entries_at(md, ghost, figures.FAR_FUTURE) == [None] * len(md.days)


# ---- window values ------------------------------------------------------------------------------------------------------------


def old_window_values(tree, meters, rows, baselines, first_buckets, tariffs, zone, first, last, end, as_cost):
    """`_fill_billing`'s plain value branch of a62fce0, line by line, on the oracle."""
    result, priced = ref_priced(tree, meters, rows, baselines, first_buckets, tariffs, zone, first, last)
    old_tariffs = [ref.TariffRow(*t) for t in tariffs]
    hours_of = priced if as_cost else result.hours
    last_day = (end - timedelta(microseconds=1)).astimezone(ZoneInfo(zone)).date()
    out = {}
    for asset_id in tree.preorder():
        figs = hours_of.get(asset_id)
        hours = {} if figs is None else {hour: fig for hour, fig in figs.items() if first <= hour < last}
        if figs is None:
            out[asset_id] = None
        elif as_cost:
            rated = ref.rate_at(old_tariffs, tree, asset_id, last_day) is not None
            total = ref.summarize(hours.values(), rate_in_effect=rated)
            cost_total = 0.0 if total.cost is None and rated else total.cost
            out[asset_id] = (cost_total, total.estimated, total.partial, ref.no_data(hours.values()))
        else:
            kwh = sum((h.kwh for h in hours.values()), 0.0)
            out[asset_id] = (kwh, any(h.estimated for h in hours.values()), False, not any(h.has_data for h in hours.values()))
    return out


def whole_hours(start, end):
    floor = start.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    ceil = end.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    return floor, ceil if ceil == end else ceil + HOUR


def test_the_window_values_equal_the_old_per_asset_figures_on_random_worlds():
    compared, both = 0, Counter()
    for seed in range(150):
        world = gen_world(seed, "gaps" if seed % 4 == 3 else "general")
        floor, ceil = whole_hours(*world.span)
        rng = random.Random(seed)
        windows = [(floor, ceil, world.span[1]), (floor + HOUR * rng.randint(0, 4), ceil - HOUR * rng.randint(0, 5), ceil)]
        for first, last, end in windows:
            if last <= first:
                continue
            for as_cost in (False, True):
                meters, read, tariffs = live_inputs(world.meters, world.rows, world.baselines, world.first_buckets, world.tariffs)
                new = figures._build_window_values(
                    "fp", world.zone, first, last, (end - timedelta(microseconds=1)).astimezone(ZoneInfo(world.zone)).date(),
                    as_cost, world.tree, tariffs, meters, read,
                )
                old = old_window_values(
                    world.tree, world.meters, world.rows, world.baselines, world.first_buckets, world.tariffs, world.zone,
                    first, last, end, as_cost,
                )
                assert list(new.values) == world.tree.preorder()
                assert new.values == old and repr(new.values) == repr(old), (seed, as_cost)
                compared += len(old)
                both["cost" if as_cost else "energy"] += 1
                both["none"] += sum(1 for v in old.values() if v is None)
    assert compared > 5000 and both["none"] and both["cost"] and both["energy"]


# ---- a database ---------------------------------------------------------------------------------------------------------------

NOW = datetime(2026, 4, 8, 10, 0, tzinfo=UTC)  # seven complete days of April; March has 31
COMPARE = {"compare": "same_days_last_month", "range": "this_month"}
MONTH = "2026-03"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    for target in ("dcdash.api.widget_data._now", "dcdash.api.billing._now", "dcdash.api.data._now"):
        monkeypatch.setattr(target, lambda: NOW)


@pytest.fixture
async def session(db):
    async with get_sessionmaker()() as s:
        yield s


async def build(db) -> dict[str, int]:
    """Site > (Hall A > Pump, Fan; Hall B > Fx (power only)), and a second root, Annex. Counters read twice a day from 28 February
    to the morning of 8 April (the readings of test_widget_data_compare: every separate reading costs rollup time); the site rate
    is 0.10 and Hall A pays 0.18 from 3 April (inside the comparison's windows)."""
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    ids = {"Site": await make_asset(db, "Site")}
    ids["Hall A"] = await make_asset(db, "Hall A", ids["Site"])
    ids["Hall B"] = await make_asset(db, "Hall B", ids["Site"])
    ids["Pump"] = await add_varied_counter(db, "Pump", APRIL_READINGS, ids["Hall A"])
    ids["Fan"] = await add_varied_counter(db, "Fan", APRIL_READINGS[1:], ids["Hall A"])
    ids["Annex"] = await add_varied_counter(db, "Annex", APRIL_READINGS[2:])
    days = [at(2026, 3, 3), at(2026, 3, 5), at(2026, 4, 2), at(2026, 4, 4)]
    ids["Fx"] = await add_power(db, "Fx", [day + timedelta(hours=h) for day in days for h in range(8, 14)], 4.2, ids["Hall B"])
    await add_tariff(db, 0.10, "2026-01-01")
    await add_tariff(db, 0.18, "2026-04-03", ids["Hall A"])
    await settle_rollups(db)
    return ids


def compare_config(asset: int, source: str, widget_type: str = "stat"):
    return validate_config(
        widget_type, {"assets": [asset], "source": source, "aggregation": "sum", **COMPARE}
    )


async def compare_card(session, asset: int, source: str = "cost", widget_type: str = "stat") -> dict:
    return await widget_data(session, widget_type, compare_config(asset, source, widget_type), "this_month", NOW)


async def plain_card(session, assets: list[int], source: str, preset: str = "30d") -> dict:
    config = validate_config("table", {"assets": assets, "source": source, "aggregation": "sum"})
    return await widget_data(session, "table", config, preset, NOW)


async def test_a_month_value_carries_the_configuration_it_was_made_under_and_its_own_tree(db, session):
    ids = await build(db)
    start, end = month_bounds(MONTH, "UTC")
    md = await figures.month_days(session, "UTC", start, end)
    assert md.config_fp == await figure_cache.config_fingerprint(session)
    assert set(md.tree.nodes) == set(ids.values()) and list(md.entries) == md.tree.preorder()
    assert md.tz_name == "UTC" and (md.start, md.end) == (start, end) and len(md.days) == 31
    assert (await figures.month_days(session, "UTC", start, end)) is md  # the second ask is the stored value itself


async def test_the_window_values_equal_the_old_computation_on_a_real_database(db, session):
    ids = await build(db)
    first, last = at(2026, 3, 10), at(2026, 4, 8, 11)
    tree = await AssetTree.load(session)
    for as_cost in (False, True):
        old = await hourly_energy(session, tree, first, last)
        tariffs = await cost.load_tariffs(session) if as_cost else []
        hours_of = cost.cost_by_hour(old, tariffs, tree, "UTC") if as_cost else old.hours
        last_day = (NOW - timedelta(microseconds=1)).date()
        expected = {}
        for asset_id in tree.preorder():
            figs = hours_of.get(asset_id)
            hours = {} if figs is None else {h: f for h, f in figs.items() if first <= h < last}
            if figs is None:
                expected[asset_id] = None
            elif as_cost:
                rated = cost.rate_at(tariffs, tree, asset_id, last_day) is not None
                total = cost.summarize(hours.values(), rate_in_effect=rated)
                cost_total = 0.0 if total.cost is None and rated else total.cost
                expected[asset_id] = (cost_total, total.estimated, total.partial, cost.no_data(hours.values()))
            else:
                expected[asset_id] = (
                    sum((h.kwh for h in hours.values()), 0.0), any(h.estimated for h in hours.values()), False,
                    not any(h.has_data for h in hours.values()),
                )
        found = await figures.window_values(session, first, last, NOW, "UTC", as_cost)
        assert found.values == expected and repr(found.values) == repr(expected)
        assert found.config_fp == await figure_cache.config_fingerprint(session) and found.tz_name == "UTC"
        assert expected[ids["Site"]] is not None and expected[ids["Pump"]][0] > 0
    assert figure_cache.stats()["computes"] == 2


async def test_the_rolling_end_of_a_window_does_not_make_a_new_key(db, session):
    await build(db)
    first, last = at(2026, 4, 1), at(2026, 4, 8, 11)
    one = await figures.window_values(session, first, last, NOW, "UTC", True)
    two = await figures.window_values(session, first, last, NOW + timedelta(minutes=7, seconds=3), "UTC", True)
    assert two is one  # same local day: a rolling preset moves `end` with every request, the figures do not depend on that
    other_day = await figures.window_values(session, first, last, NOW + timedelta(days=1), "UTC", True)
    assert other_day is not one and other_day.values == one.values  # the day a rate must be in effect on is part of the key


async def test_two_cards_of_one_window_share_one_computation(db, session):
    ids = await build(db)
    await plain_card(session, [ids["Pump"]], "energy")
    await plain_card(session, [ids["Fan"], ids["Site"]], "energy")
    assert figure_cache.stats()["computes"] == 1
    await compare_card(session, ids["Pump"], "cost")
    await compare_card(session, ids["Fan"], "energy", "timeseries")
    await compare_card(session, ids["Hall A"], "cost", "timeseries")
    assert figure_cache.stats()["computes"] == 3  # last month and this month, once each, for three cards


async def test_month_costs_called_twice_gives_equal_answers_and_changing_one_changes_nothing(db, session):
    await build(db)
    first = await billing.month_costs(session, MONTH)
    snapshot = json.dumps(first, sort_keys=True)
    first["assets"][0]["days"][3]["kwh"] = -1.0
    first["assets"][0]["total"]["kwh"] = -1.0
    first["assets"][0]["name"] = "scribble"
    again = await billing.month_costs(session, MONTH)
    assert json.dumps(again, sort_keys=True) == snapshot and again["assets"][0]["days"][3]["kwh"] != -1.0
    third = await billing.month_costs(session, MONTH)
    assert third == again and third is not again and third["assets"][0]["days"][3] is not again["assets"][0]["days"][3]


async def test_the_cache_off_gives_the_same_answers_for_billing_and_a_comparison_card(db, session, monkeypatch):
    ids = await build(db)

    async def everything():
        return {
            "march": await billing.month_costs(session, MONTH), "april": await billing.month_costs(session, "2026-04"),
            "cards": [
                await compare_card(session, ids[name], source, kind)
                for name in ("Pump", "Hall A", "Fx", "Site") for source in ("energy", "cost") for kind in ("stat", "timeseries")
            ],
            "plain": [
                await plain_card(session, [ids["Site"], ids["Hall A"], ids["Fx"]], source, preset)
                for source in ("energy", "cost") for preset in ("30d", "7d", "this_month")
            ],
        }

    on = await everything()
    assert figure_cache.stats()["computes"] > 0
    monkeypatch.setenv("DCDASH_FIGURE_CACHE", "0")
    off = await everything()
    assert on == off and repr(on) == repr(off)
    assert json.dumps(on, default=str) == json.dumps(off, default=str)


async def test_a_request_with_an_older_tree_is_answered_with_the_values_rates_and_tree(db, session, monkeypatch):
    """Hall A's rate rises on 3 April, inside the comparison: that is the 'rate change' the card names, because Pump is under
    Hall A in the values' tree. A request that still holds a tree in which Pump hangs straight under the site (older than the
    values) gets the same note, the same figures and its own names: nothing is read through the request's tree."""
    ids = await build(db)
    fresh = await compare_card(session, ids["Pump"], "cost")
    assert fresh["compare"]["assets"][0]["rate_change"] == {"date": "2026-04-03"}

    current = await AssetTree.load(session)
    old = AssetTree([
        dataclasses.replace(node, parent_id=ids["Site"], name="Old pump") if node.id == ids["Pump"] else node
        for node in current.nodes.values()
    ])

    class OldTree:
        @staticmethod
        async def load(db_):
            return old

    monkeypatch.setattr(widgets_module, "AssetTree", OldTree)
    stale = await compare_card(session, ids["Pump"], "cost")
    assert stale["values"][0]["name"] == "Old pump" and stale["compare"]["assets"][0]["name"] == "Old pump"
    for answer in (fresh, stale):
        answer["values"][0].pop("name")
        answer["compare"]["assets"][0].pop("name")
        answer["series"] = [{**s, "name": None, "path": None} for s in answer["series"]]
    assert stale == fresh


async def test_an_asset_the_values_do_not_hold_reads_as_no_figure(db, session, monkeypatch):
    ids = await build(db)
    current = await AssetTree.load(session)
    ghost = max(current.nodes) + 1000
    newer = AssetTree([*current.nodes.values(), AssetNode(ghost, ids["Site"], "Ghost", 0)])

    class NewerTree:
        @staticmethod
        async def load(db_):
            return newer

    monkeypatch.setattr(widgets_module, "AssetTree", NewerTree)
    for source in ("energy", "cost"):
        plain = await plain_card(session, [ghost, ids["Pump"]], source)
        assert (plain["values"][0]["asset_id"], plain["values"][0]["value"], plain["values"][0]["no_data"]) == (ghost, None, True)
        assert plain["values"][1]["value"] is not None
        card = await compare_card(session, ghost, source)
        asset = card["compare"]["assets"][0]
        assert card["values"][0]["no_data"] is True and card["values"][0]["value"] is None
        assert asset["this"] is None and asset["last"] is None and asset["last_state"] == "no_readings"
        assert asset["rate_change"] is None


async def test_a_comparison_asks_again_when_its_two_months_disagree_about_the_configuration(db, session, monkeypatch):
    ids = await build(db)
    expected = await compare_card(session, ids["Pump"], "cost")
    real, calls = widgets_module.month_days, []

    async def disagreeing(db_, tz_name, start, end):
        value = await real(db_, tz_name, start, end)
        calls.append(start)
        return dataclasses.replace(value, config_fp=f"other-{len(calls)}") if len(calls) % 2 else value  # last month's differs

    monkeypatch.setattr(widgets_module, "month_days", disagreeing)
    assert await compare_card(session, ids["Pump"], "cost") == expected
    assert len(calls) == 6  # (last, this) three times: it gave up asking and went on with what it had

    calls.clear()

    async def agreeing(db_, tz_name, start, end):
        calls.append(start)
        return await real(db_, tz_name, start, end)

    monkeypatch.setattr(widgets_module, "month_days", agreeing)
    assert await compare_card(session, ids["Pump"], "cost") == expected and len(calls) == 2


async def test_the_pure_part_runs_on_the_compute_thread_and_is_given_no_session(db, session, monkeypatch):
    await build(db)
    seen = []
    real_month, real_window = figures._build_month_days, figures._build_window_values

    def spy(real):
        def wrapper(*args):
            seen.append((threading.current_thread().name, [a for a in args if isinstance(a, AsyncSession)]))
            return real(*args)
        return wrapper

    monkeypatch.setattr(figures, "_build_month_days", spy(real_month))
    monkeypatch.setattr(figures, "_build_window_values", spy(real_window))
    await billing.month_costs(session, MONTH)
    await figures.window_values(session, at(2026, 3, 10), at(2026, 4, 8, 11), NOW, "UTC", True)
    assert len(seen) == 2
    for name, sessions in seen:
        assert name.startswith("dcdash-compute") and sessions == []
        assert name != threading.current_thread().name


# ---- a close never uses an entry inside its TTL -------------------------------------------------------------------------------

CLOSE_NOW = datetime(2026, 4, 15, 10, 20, tzinfo=UTC)


async def build_for_close(db) -> dict[str, int]:
    """Site > Hall A > (Pump, Fan), and a second root, Annex: hourly counters from 2 to 8 March (the month to close)."""
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    ids = {"Site": await make_asset(db, "Site")}
    ids["Hall A"] = await make_asset(db, "Hall A", ids["Site"])
    ids["Pump"] = await add_counter(db, "Pump", at(2026, 3, 2), 168, per_hour=2.0, parent_id=ids["Hall A"])
    ids["Fan"] = await add_counter(db, "Fan", at(2026, 3, 2), 168, per_hour=1.0, parent_id=ids["Hall A"])
    ids["Annex"] = await add_counter(db, "Annex", at(2026, 3, 2), 168, per_hour=0.5)
    await add_tariff(db, 0.10, "2026-01-01")
    await settle_rollups(db)
    return ids


def total_kwh(figures_of_month: dict, asset_id: int) -> float:
    return next(a for a in figures_of_month["assets"] if a["asset_id"] == asset_id)["total"]["kwh"]


async def test_a_close_right_after_late_readings_freezes_them_even_with_a_long_ttl(client, db, session, monkeypatch):
    monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "3600")
    monkeypatch.setattr("dcdash.api.billing._now", lambda: CLOSE_NOW)
    ids = await build_for_close(db)
    await login_as(client, db)
    shown = await client.get("/api/billing/costs", params={"month": MONTH})
    assert shown.status_code == 200, shown.text
    before = total_kwh(shown.json(), ids["Pump"])
    # eight late hours, 2 kWh each, land after the counter's last reading (the collector re-queued its buffer after an outage)
    point = await db.fetchval("SELECT id FROM points WHERE address = 'Pump_kWh'")
    await insert_readings(db, point, at(2026, 3, 9) + timedelta(minutes=30), 3600, [1000.0 + (168 + i) * 2.0 for i in range(8)])
    await settle_rollups(db)
    # the premise: an ordinary read still serves the entry that is inside its TTL, without the late rows ...
    assert total_kwh(await billing.month_costs(session, MONTH), ids["Pump"]) == before
    computes = figure_cache.stats()["computes"]
    # ... and a close must not
    response = await client.post(f"/api/billing/months/{MONTH}/close", json={})
    assert response.status_code == 201, response.text
    frozen = await db.fetchval("SELECT figures FROM billing_closes WHERE month = $1", MONTH)
    assert total_kwh(frozen, ids["Pump"]) == pytest.approx(before + 16.0, abs=2.5) and total_kwh(frozen, ids["Pump"]) > before
    assert figure_cache.stats()["computes"] == computes + 1  # the close computed on its own, and replaced the stored entry
    assert total_kwh(await billing.month_costs(session, MONTH), ids["Pump"]) == total_kwh(frozen, ids["Pump"])


# ---- a prefix of the month is what the comparison asks for ----------------------------------------------------------------------


def prefix_lengths(n: int) -> dict[int, str]:
    """Prefix lengths 1, 2, 5, half, n - 1 and n (those that fit in n days), each with the name it was asked for."""
    found: dict[int, str] = {}
    for k, label in ((1, "1"), (2, "2"), (5, "5"), (n // 2, "half"), (n - 1, "n-1"), (n, "n")):
        if 1 <= k <= n:
            found.setdefault(k, label)  # a short window can ask for the same length twice: the first name stays
    return found


def check_prefixes(tree, meters, rows, baselines, first_buckets, tariffs, zone, start, end, reached: Counter) -> int:
    """`entries_at(md, a, now)[:k]` against the old call the comparison made, `day_entries(priced, days[:k], now, rate_on)`: the
    window's days are a prefix of the month's. Returns how many comparisons were made; `reached` counts the prefix names tried."""
    meters_, read, tariffs_ = live_inputs(meters, rows, baselines, first_buckets, tariffs)
    md = figures._build_month_days("fp", zone, start, end, tree, tariffs_, meters_, read)
    _, priced = ref_priced(tree, meters, rows, baselines, first_buckets, tariffs, zone, start, end)
    old_tariffs = [ref.TariffRow(*t) for t in tariffs]
    days = local_days(start, end, zone)
    compared = 0
    for now in probes(days)[::2]:
        for asset_id in tree.preorder():
            shared = figures.entries_at(md, asset_id, now)
            for k, label in prefix_lengths(len(days)).items():
                old = ref.day_entries(
                    priced.get(asset_id), days[:k], now=now,
                    rate_on=lambda day, a=asset_id: ref.rate_at(old_tariffs, tree, a, day) is not None,
                )
                new = shared[:k]
                assert new == old and repr(new) == repr(old), (asset_id, now, k)
                compared += 1
                reached[label] += 1
    return compared


def test_a_prefix_of_the_masked_entries_equals_day_entries_of_that_prefix_of_the_days_on_random_worlds():
    compared, reached = 0, Counter()
    for seed in range(60):
        world: World = gen_world(seed, "gaps" if seed % 4 == 3 else "general")
        compared += check_prefixes(
            world.tree, world.meters, world.rows, world.baselines, world.first_buckets, world.tariffs, world.zone, *world.span,
            reached,
        )
    assert compared > 5000 and reached["1"] and reached["2"] and reached["n-1"] and reached["n"]


@pytest.mark.parametrize("zone", ["UTC", "Europe/London"])
@pytest.mark.parametrize("month", ["2026-03", "2026-10"])  # a month of 30 or 31 local days, with a clock change
def test_a_prefix_of_the_masked_entries_equals_day_entries_of_that_prefix_across_a_month(zone, month):
    start, end = month_bounds(month, zone)
    hrs = hours_in(start.astimezone(UTC), end.astimezone(UTC))
    rng, feats, reached = random.Random(11), Counter(), Counter()
    meters = {2: (100, 1.0, 60, True), 4: (101, 3.7, 60, False), 5: (102, 1.0, 60, True), 6: (103, 0.001, 900, False)}
    rows, baselines = {}, {100: 250.0, 102: 4000.0}
    rows[100], _ = gen_rows(rng, hrs, True, 60, "gaps", 250.0, feats)
    rows[101], _ = gen_rows(rng, hrs, False, 60, "dense", None, feats)
    rows[102], _ = gen_rows(rng, hrs, True, 60, "late", 4000.0, feats)
    rows[103], _ = gen_rows(rng, hrs, False, 900, "single", None, feats)
    first_buckets = {100: hrs[0] - HOUR * 7, 101: rows[101][0][0], 102: hrs[0] - HOUR * 3, 103: rows[103][0][0]}
    check_prefixes(MONTH_TREE, meters, rows, baselines, first_buckets, MONTH_TARIFFS, zone, start, end, reached)
    assert set(reached) == {"1", "2", "5", "half", "n-1", "n"}  # a whole month has room for every length, 5 and half before n


# ---- the comparison gives up on agreement: once, in the log, with the values' own rates ---------------------------------------------


async def test_a_comparison_that_never_gets_two_months_of_one_configuration_logs_once_and_goes_on_with_this_months_value(
    db, session, monkeypatch, caplog
):
    ids = await build(db)
    expected = await compare_card(session, ids["Pump"], "cost")
    assert expected["compare"]["assets"][0]["rate_change"] == {"date": "2026-04-03"}  # Hall A's rate rises inside the windows
    real, calls = widgets_module.month_days, []

    async def disagreeing(db_, tz_name, start, end):
        value = await real(db_, tz_name, start, end)
        calls.append(start)
        if start.month == 3:  # last month's value: its own configuration
            return dataclasses.replace(value, config_fp="aaaaaaaa-last-month")
        # this month's value: another configuration, one without Hall A's rate (so the note can only come from THIS value)
        site_only = [t for t in value.tariffs if t.asset_id is None]
        assert len(site_only) < len(value.tariffs)
        return dataclasses.replace(value, config_fp="bbbbbbbb-this-month", tariffs=site_only)

    monkeypatch.setattr(widgets_module, "month_days", disagreeing)
    with caplog.at_level(logging.WARNING, logger="dcdash.core.widgets"):
        card = await compare_card(session, ids["Pump"], "cost")
    warnings = [r for r in caplog.records if r.name == "dcdash.core.widgets" and r.levelno == logging.WARNING]

    assert len(calls) == 6  # (last, this) three times, then it went on
    assert len(warnings) == 1  # one line for the whole give-up, not one per try
    text = warnings[0].getMessage()
    assert "aaaaaaaa" in text and "bbbbbbbb" in text  # the two short fingerprints, 8 characters each
    assert "last-month" not in text and "this-month" not in text  # and no more than those 8 characters of each
    assert all(name not in text for name in ("Pump", "Hall", "Fan", "Site", "Annex", "Fx"))  # no data in the message
    # the answer is built from this month's value: with its tariffs the rate note is gone, with last month's it would stay
    assert card["compare"]["assets"][0]["rate_change"] is None
    card["compare"]["assets"][0]["rate_change"] = expected["compare"]["assets"][0]["rate_change"]
    assert card == expected  # nothing else of the answer moved: the entries come from each value as computed

    calls.clear()
    caplog.clear()

    async def agreeing(db_, tz_name, start, end):
        calls.append(start)
        return await real(db_, tz_name, start, end)

    monkeypatch.setattr(widgets_module, "month_days", agreeing)
    with caplog.at_level(logging.WARNING, logger="dcdash.core.widgets"):
        assert await compare_card(session, ids["Pump"], "cost") == expected
    assert len(calls) == 2 and not [r for r in caplog.records if r.name == "dcdash.core.widgets"]  # agreement: silent


# ---- nothing a reader does changes a shared value ------------------------------------------------------------------------------


def tree_snapshot(tree: AssetTree) -> tuple:
    return (tree.nodes, tree.preorder(), tree.roots(), {asset_id: tree.children(asset_id) for asset_id in tree.nodes})


def month_snapshot(md: figures.MonthDays) -> tuple:
    return (
        md.config_fp, md.tz_name, md.start, md.end, tree_snapshot(md.tree), md.tariffs, md.days, md.entries, sorted(md.own),
        md.own_from, md.start_utc,
    )


def window_snapshot(value: figures.WindowValues) -> tuple:
    return value.config_fp, value.tz_name, tree_snapshot(value.tree), value.tariffs, value.values


def same_snapshot(before: tuple, after: tuple) -> bool:
    """`==` and the same `repr` (every float to the last digit, every dict in the same order; `-0.0` counts)."""
    return before == after and repr(before) == repr(after)


async def test_no_reader_changes_a_shared_value(client, db, session):
    ids = await build(db)
    await db.execute("UPDATE assets SET kind = 'Hall' WHERE name IN ('Hall A', 'Hall B')")
    await login_as(client, db, "admin")
    months = {m: month_bounds(m, "UTC") for m in (MONTH, "2026-04")}
    start, end = resolve_range("this_month", NOW, "UTC")
    first, last = widgets_module._hour_window("this_month", start, end)

    async def values() -> dict[str, object]:
        found = {m: await figures.month_days(session, "UTC", *bounds) for m, bounds in months.items()}
        found |= {f"window-{as_cost}": await figures.window_values(session, first, last, end, "UTC", as_cost) for as_cost in (False, True)}
        return found

    async def everything() -> None:
        for month in months:
            assert (await client.get("/api/billing/costs", params={"month": month})).status_code == 200
            assert (await client.get("/api/billing/costs.csv", params={"month": month})).status_code == 200
            await billing.month_costs(session, month)
        await compare_card(session, ids["Pump"], "cost")
        await compare_card(session, ids["Hall A"], "energy", "timeseries")
        await compare_card(session, ids["Fx"], "cost", "timeseries")
        bars = validate_config("bar", {"assets": [], "source": "cost", "aggregation": "sum", "bars": "kind", "kind": "Hall"})
        assert (await widget_data(session, "bar", bars, "this_month", NOW))["breakdown"]["count"] == 2
        await plain_card(session, [ids["Site"], ids["Fx"]], "energy", "this_month")

    held = await values()  # the values the readers below are given (the first ask computes them)
    snapshot = {name: (month_snapshot if isinstance(v, figures.MonthDays) else window_snapshot)(copy.deepcopy(v)) for name, v in held.items()}
    assert any(e is not None for md in held.values() if isinstance(md, figures.MonthDays) for es in md.entries.values() for e in es)
    computes = figure_cache.stats()["computes"]

    await everything()
    await everything()  # twice: the second pass reads what the first left behind

    after = await values()
    assert all(after[name] is held[name] for name in held)  # the very same objects: nothing was recomputed behind the test's back
    assert figure_cache.stats()["computes"] == computes  # every reader found the stored values (the plain card and the bars share a window)
    for name, value in after.items():
        now = (month_snapshot if isinstance(value, figures.MonthDays) else window_snapshot)(value)
        assert same_snapshot(snapshot[name], now), name

    # the check has teeth: a scribble on an entry, a tariff or a tree is seen by the same comparison
    md = held[MONTH]
    asset = next(a for a, es in md.entries.items() if any(e is not None for e in es))
    index = next(i for i, e in enumerate(md.entries[asset]) if e is not None)
    scribbled = copy.deepcopy(md)
    scribbled.entries[asset][index]["estimated"] = not scribbled.entries[asset][index]["estimated"]
    assert not same_snapshot(month_snapshot(scribbled), month_snapshot(md))
    renamed = copy.deepcopy(md)
    renamed.tree.nodes[asset] = dataclasses.replace(renamed.tree.nodes[asset], name="scribble")
    assert not same_snapshot(month_snapshot(renamed), month_snapshot(md))


# ---- the two months of a cold comparison are computed side by side --------------------------------------------------------------


async def test_a_cold_comparison_starts_both_months_before_either_has_finished_and_answers_as_before(db, session, monkeypatch):
    ids = await build(db)
    expected = await compare_card(session, ids["Pump"], "cost")
    await figure_cache.aclear()  # cold again
    assert figure_cache.stats()["computes"] == 0
    real, spans = figures.read_energy_rows, []
    loop = asyncio.get_running_loop()

    async def slow(*args, **kwargs):
        began = loop.time()
        await asyncio.sleep(0.25)  # long enough that one after the other cannot overlap
        try:
            return await real(*args, **kwargs)
        finally:
            spans.append((began, loop.time()))

    monkeypatch.setattr(figures, "read_energy_rows", slow)
    card = await compare_card(session, ids["Pump"], "cost")

    assert card == expected and repr(card) == repr(expected)
    assert figure_cache.stats()["computes"] == 2 and len(spans) == 2
    (first_began, first_ended), (second_began, _) = sorted(spans)
    assert second_began < first_ended, "the second month was not started until the first had finished"
    assert second_began - first_began < 0.2


# ---- a comparison never holds two connections of the request pool (review C1) ----------------------------------------------------


async def test_more_concurrent_comparisons_than_the_request_pool_holds_all_answer_without_waiting_for_the_pool(
    client, db, monkeypatch
):
    ids = await build(db)
    await login_as(client, db, "admin")
    config = {"assets": [ids["Pump"]], "source": "cost", "aggregation": "sum", **COMPARE}
    body = {"type": "stat", "config": config, "range": "this_month"}
    size, timeout = 4, 10  # the bound below is timeout - 1: wide enough for two cold computations on a busy machine
    tiny = create_async_engine(
        get_settings().sqlalchemy_url, pool_size=size, max_overflow=0, pool_timeout=timeout, pool_pre_ping=True
    )
    monkeypatch.setattr(db_module, "_engine", tiny)  # every request session now draws on a pool of exactly `size` connections
    loop = asyncio.get_running_loop()
    answers = []

    async def burst(phase: str) -> None:
        began = loop.time()
        # Each request holds its connection from its first statement on. Were a second one asked for while it waited, `size`
        # requests would hold one each and wait for one more: `timeout` seconds of nothing, then an error (the test client
        # raises what the app raised). The `size + 5` requests beyond that wait their turn for a connection.
        responses = await asyncio.wait_for(
            asyncio.gather(*(client.post("/api/widget-data", json=body) for _ in range(size + 5))), timeout * 4
        )
        elapsed = loop.time() - began
        assert [r.status_code for r in responses] == [200] * (size + 5), phase
        assert elapsed < timeout - 1, f"{phase}: {elapsed:.1f} s"  # nobody waited for the pool to time out
        answers.extend(r.json() for r in responses)

    try:
        await burst("cold")  # one computation per month, shared by all
        assert figure_cache.stats()["computes"] == 2
        await burst("warm, the data compared on every request (the tests' TTL is 0)")
        monkeypatch.setenv("DCDASH_FIGURE_CACHE_TTL", "1000")
        await burst("warm, inside the TTL")
        await figure_cache.aclear()
        await burst("cold again")
    finally:
        await tiny.dispose()
    assert all(answer == answers[0] for answer in answers)  # the same card every time
    assert answers[0]["compare"]["state"] == "ok" and answers[0]["compare"]["assets"][0]["this"] is not None
