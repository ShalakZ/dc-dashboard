"""The pilot-hall demo seed (w16): the shared machinery it borrows from the old history seeder takes a sample step, a batch writer
and an undo sentence of its own, and its layout and series are pure functions of a seed.

These tests do not touch the old layout's figures (`test_seed_history.py` pins those and runs unmodified). The first group needs no
database: it checks the plan arithmetic, the batch writer's checks and the undo texts of `dcdash.seed.history`."""
import asyncio
import math
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from billing_helpers import add_tariff, set_zone
from dcdash.api import billing
from dcdash.connectors.simulator import SimulatorConfig
from dcdash.core.asset_kinds import kind_key
from dcdash.core.db import get_sessionmaker
from dcdash.core.metrics import Metric
from dcdash.seed import history, pilot_hall
from helpers import insert_readings, make_asset, make_mapping, make_point, make_source, settle_rollups

NOW = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
ZONE = "Asia/Qatar"  # UTC+3, no daylight saving: a local day is a whole number of UTC hours
QUARTER = timedelta(minutes=15)


@pytest.fixture(autouse=True)
def frozen(monkeypatch):
    monkeypatch.setattr(history, "_now", lambda: NOW)
    monkeypatch.delenv(history.SWITCH, raising=False)


# ---- the shared machinery takes a step (task 1) ----------------------------------------------------------------------------


def test_the_interval_choices_are_the_five_minute_multiples_the_pilot_hall_offers():
    assert history.INTERVAL_CHOICES == (5, 10, 15, 30, 60)
    assert all(3600 % (minutes * 60) == 0 for minutes in history.INTERVAL_CHOICES)  # a bucket hour holds whole samples


def test_make_plan_with_a_15_minute_step_ends_on_quarter_hours():
    now = NOW + timedelta(minutes=7, seconds=30)
    plan = history.make_plan(now, ZONE, 2, raw_retention_days=30, step_seconds=900)
    assert plan.step_seconds == 900 and plan.step == QUARTER
    assert plan.end == NOW  # 12:07:30 floors to the quarter hour
    assert plan.start == datetime(2026, 10, 13, 12, 15, tzinfo=timezone.utc)  # 12:07:30 two days earlier, ceiled
    assert plan.count == int((plan.end - plan.start) / QUARTER) + 1 == 192
    times = plan.times()
    assert len(times) == plan.count and times[0] == plan.start and times[-1] == plan.end
    assert {later - earlier for earlier, later in zip(times, times[1:])} == {QUARTER}
    assert plan.reset_index == plan.count // 2 == 96  # the second Plan(...) in make_plan carries the step too
    assert plan.reset_at == plan.start + plan.reset_index * QUARTER == times[plan.reset_index]
    assert plan.gap is not None  # the range holds complete local days


def test_the_default_step_still_gives_the_old_numbers():
    plan = history.make_plan(NOW, ZONE, None)
    assert plan.step_seconds == history.STEP_SECONDS == 300 and plan.step == history.STEP
    assert plan.count == 8_353 and plan.clamped and plan.start == NOW - timedelta(days=29) and plan.end == NOW
    assert plan.reset_index == 8_353 // 2
    assert history._floor(NOW + timedelta(seconds=299)) == NOW
    assert history._ceil(NOW + timedelta(seconds=1)) == NOW + history.STEP and history._ceil(NOW) == NOW


def test_floor_and_ceil_take_a_step():
    odd = NOW + timedelta(minutes=7, seconds=30)
    assert history._floor(odd, 900) == NOW and history._ceil(odd, 900) == NOW + QUARTER
    assert history._floor(odd, 3600) == NOW and history._ceil(odd, 3600) == NOW + timedelta(hours=1)
    assert history._ceil(NOW, 900) == NOW


def test_clamped_uses_the_step():
    now = NOW + timedelta(minutes=7, seconds=30)
    # wanted_start (12:07:30 seven days back) is not on a mark but start is its ceiling: not clamped, for 15 minutes as for 5.
    plan = history.make_plan(now, ZONE, 7, raw_retention_days=30, step_seconds=900)
    assert plan.wanted_start == now - timedelta(days=7) and plan.start == plan.wanted_start + timedelta(minutes=7, seconds=30)
    assert plan.clamped is False
    # a retention that cuts the range back is clamped
    short = history.make_plan(now, ZONE, 7, raw_retention_days=3, step_seconds=900)
    assert short.clamped and short.start == history._ceil(now - timedelta(days=2), 900)
    # and the default step keeps its own answer
    assert history.make_plan(now, ZONE, 7, raw_retention_days=30).clamped is False


class _Brokenpool:
    """Every statement fails, as a database that went away would make it."""

    async def execute(self, *_args):
        raise RuntimeError("the database went away")


async def test_undo_takes_its_sentence(monkeypatch, capsys):
    plan = history.make_plan(NOW, ZONE, 2, raw_retention_days=30)
    created = history.Created(1, 2, {"a": 3}, {"a": 4})

    async def refresh_breaks(pool, plan):
        raise RuntimeError("the refresh went away")

    monkeypatch.setattr(history, "refresh_rollups", refresh_breaks)
    await history._undo(_Brokenpool(), plan, created)
    err = capsys.readouterr().err
    assert f"could not clean up (the database went away); {history.UNDO}" in err and "Seeded demo" in err
    assert "could not refresh the rollups after cleaning up (the refresh went away)" in err

    await history._undo(_Brokenpool(), plan, created, undo="remove the pilot hall with the normal deletes")
    err = capsys.readouterr().err
    assert "could not clean up (the database went away); remove the pilot hall with the normal deletes" in err
    assert "Seeded demo" not in err and err.count("could not clean up") == 3  # one per step, each with the new sentence


# ---- write_batches: the per-day checks of write_readings, for any iterable of batches ---------------------------------------


def _rows(point: int, count: int, first: datetime) -> list[history.Row]:
    return [(point, first + i * history.STEP, float(i), history.GOOD) for i in range(count)]


async def test_write_batches_returns_the_total_and_flushes_each_batch(monkeypatch):
    flushed: list[int] = []

    async def takes_everything(self):
        flushed.append(self.pending)
        count, self._buffer = self.pending, []
        return count

    monkeypatch.setattr(history.Writer, "flush", takes_everything)
    day = date(2026, 10, 1)
    batches = iter([(day, _rows(1, 5, NOW)), (day + timedelta(days=1), _rows(2, 7, NOW))])  # a generator is fine, not just a list
    assert await history.write_batches(None, batches) == 12
    assert flushed == [5, 7]
    assert await history.write_batches(None, []) == 0


async def test_write_batches_fails_when_a_flush_writes_less(monkeypatch):
    async def writes_nothing(self):
        return 0

    monkeypatch.setattr(history.Writer, "flush", writes_nothing)
    with pytest.raises(RuntimeError, match=r"the database took 0 of 3 readings of 2026-10-01 \(see the log above\)"):
        await history.write_batches(None, [(date(2026, 10, 1), _rows(1, 3, NOW))])


async def test_write_batches_fails_when_the_buffer_dropped_rows(monkeypatch):
    class Small(history.Writer):  # a buffer that holds 2 rows, so a batch of 3 loses its oldest
        def __init__(self, pool):
            super().__init__(pool, max_buffer=2)

    monkeypatch.setattr(history, "Writer", Small)
    with pytest.raises(RuntimeError, match="the write buffer dropped readings of 2026-10-01 before they were written"):
        await history.write_batches(None, [(date(2026, 10, 1), _rows(1, 3, NOW))])


# ---- the pilot-hall layout (task 2): pure, no database ---------------------------------------------------------------------


@pytest.fixture(scope="module")
def layout() -> pilot_hall.Layout:
    return pilot_hall.build_layout()


def _children(layout: pilot_hall.Layout, key: str) -> list[pilot_hall.Node]:
    return [node for node in layout.nodes if node.parent == key]


def _feed_meters(layout: pilot_hall.Layout) -> list[pilot_hall.Meter]:
    return [meter for meter in layout.meters if meter.kind in ("counter", "power")]


def _panel_meters(layout: pilot_hall.Layout) -> list[pilot_hall.Meter]:
    return [meter for meter in layout.meters if meter.kind in ("voltage", "current")]


def _rack_of(layout: pilot_hall.Layout, feed_key: str) -> pilot_hall.Rack:
    return next(rack for rack in layout.racks if feed_key in rack.feeds)


def test_the_module_names_and_the_interval_are_the_plans():
    assert pilot_hall.ROOT_NAME == "Seeded pilot hall" and pilot_hall.SOURCE_NAME == "seeded-pilot-hall"
    assert pilot_hall.ELECTRICAL_NAME == "Electrical"
    assert pilot_hall.INTERVAL_CHOICES is history.INTERVAL_CHOICES and pilot_hall.DEFAULT_INTERVAL_MINUTES == 60


def test_the_tree_has_the_planned_shape(layout):
    counts = Counter(node.role for node in layout.nodes)
    assert counts == {"site": 1, "hall": 2, "pod": 4, "row": 8, "rack": 117, "feed": 229, "electrical": 1, "panel": 8}
    assert len(layout.nodes) == 370 and len(layout.racks) == 117 and layout.seed == history.DEFAULT_SEED
    rows = [node for node in layout.nodes if node.role == "row"]
    assert [len(_children(layout, row.key)) for row in rows] == [15, 15, 14, 15, 15, 15, 13, 15]
    assert [node.name for node in layout.nodes if node.role == "hall"] == ["Hall 1", "Hall 2"]
    assert [node.name for node in layout.nodes if node.role == "pod"] == ["Pod A", "Pod B"] * 2
    assert [node.name for node in rows] == ["Row 1", "Row 2", "Row 3", "Row 4"] * 2
    assert {row.key: row.parent for row in rows[:4]} == {"h1/row1": "h1/pa", "h1/row2": "h1/pa", "h1/row3": "h1/pb", "h1/row4": "h1/pb"}
    # the rack numbers run across a hall: Hall 1 has Rack 01-59, Hall 2 Rack 01-58
    for hall, last in ((1, 59), (2, 58)):
        names = [node.name for node in layout.nodes if node.role == "rack" and node.key.startswith(f"h{hall}/")]
        assert names == [f"Rack {number:02d}" for number in range(1, last + 1)]
    # the keys the plan names
    keys = {node.key for node in layout.nodes}
    assert {"site", "h1", "h2", "h1/pa", "h1/row1", "h1/r01", "h1/r01/a", "h2/r58", "elec", "elec/p1a", "elec/p4b"} <= keys
    assert [(node.key, node.sort_order) for node in layout.nodes if node.sort_order] == [("elec", 1)]
    assert layout.nodes[0].key == "site" and layout.nodes[0].parent is None


def test_sibling_names_are_unique(layout):
    groups: dict[str | None, list[str]] = {}
    for node in layout.nodes:
        groups.setdefault(node.parent, []).append(pilot_hall.sibling_key(node.name))
    assert all(len(names) == len(set(names)) for names in groups.values())
    assert pilot_hall.sibling_key("  Hall   1 ") == "hall 1"
    assert len({node.key for node in layout.nodes}) == len(layout.nodes)


def test_parents_come_before_children_and_panels_are_outside_every_hall(layout):
    position = {node.key: index for index, node in enumerate(layout.nodes)}
    by_key = {node.key: node for node in layout.nodes}
    for node in layout.nodes:
        if node.parent is not None:
            assert position[node.parent] < position[node.key]
    for node in layout.nodes:
        if node.role in ("electrical", "panel"):
            ancestors, parent = [], node.parent
            while parent is not None:
                ancestors.append(by_key[parent].role)
                parent = by_key[parent].parent
            assert ancestors[-1] == "site" and not {"hall", "pod", "row", "rack"} & set(ancestors)
    # depth first: a rack is followed at once by its feeds, a row's racks come before the next row
    rack_at = position["h1/r01"]
    assert [node.key for node in layout.nodes[rack_at:rack_at + 4]] == ["h1/r01", "h1/r01/a", "h1/r01/b", "h1/r02"]


def test_every_rack_has_its_feeds(layout):
    for rack in layout.racks:
        feeds = _children(layout, rack.node)
        assert [node.role for node in feeds] == ["feed"] * len(feeds)
        assert tuple(node.key for node in feeds) == rack.feeds
        if rack.status == "single":
            assert [node.name for node in feeds] == ["Feed A"] and rack.feeds == (f"{rack.node}/a",)
        else:
            assert [node.name for node in feeds] == ["Feed A", "Feed B"] and rack.feeds == (f"{rack.node}/a", f"{rack.node}/b")
        assert rack.hall == int(rack.node[1])


def test_the_variety_counts(layout):
    statuses = Counter(rack.status for rack in layout.racks)
    assert statuses == {"free": 6, "idle": 6, "single": 5, "live": 100}
    metered = {meter.node for meter in _feed_meters(layout)}
    for rack in layout.racks:
        if rack.status == "free":
            assert rack.kw == 0.0 and not metered & set(rack.feeds)
        elif rack.status == "idle":
            assert 0.15 <= rack.kw <= 0.45 and set(rack.feeds) <= metered
        else:
            assert 2.0 <= rack.kw <= 11.0
    assert len(_feed_meters(layout)) == 217 and len(_panel_meters(layout)) == 16 and len(layout.meters) == 233
    power = [meter for meter in layout.meters if meter.kind == "power"]
    assert len(power) == 8
    for meter in power:
        assert meter.metric is Metric.ACTIVE_POWER_KW and meter.counter_base is None
        assert meter.node.startswith("h2/") and meter.node.endswith("/b") and _rack_of(layout, meter.node).status == "live"
    counters = [meter for meter in layout.meters if meter.kind == "counter"]
    assert len(counters) == 209 and all(meter.metric is Metric.ENERGY_KWH for meter in counters)
    assert all(2000 <= meter.counter_base <= 90000 and meter.counter_base == round(meter.counter_base, 3) for meter in counters)
    gap = [meter for meter in layout.meters if meter.gap]
    reset = [meter for meter in layout.meters if meter.resets]
    assert len(gap) == 1 and len(reset) == 1 and gap[0].node != reset[0].node
    for meter in gap + reset:
        assert meter.kind == "counter" and meter.node.startswith("h1/") and meter.node.endswith("/a")
        assert _rack_of(layout, meter.node).status == "live"
    assert not gap[0].resets and not reset[0].gap
    assert {meter.metric for meter in _panel_meters(layout)} == {Metric.VOLTAGE_V, Metric.CURRENT_A}  # no panel carries energy


def test_the_meters_come_in_tree_order_feeds_first_then_the_panels(layout):
    assert [meter.kind for meter in layout.meters[217:]] == ["voltage", "current"] * 8
    assert [meter.node for meter in layout.meters[217::2]] == [f"elec/p{pod}{letter}" for pod in "1234" for letter in "ab"]
    assert all(meter.node == layout.meters[217 + 2 * (index // 2)].node for index, meter in enumerate(layout.meters[217:]))
    feed_nodes = [meter.node for meter in _feed_meters(layout)]
    tree_order = [node.key for node in layout.nodes if node.role == "feed" and node.key in set(feed_nodes)]
    assert feed_nodes == tree_order  # a rack's A before its B, racks in tree order


def test_a_panel_current_follows_the_feeds_of_its_pod_and_letter(layout):
    rack_pod = {}
    for node in layout.nodes:
        if node.role == "rack":
            row = next(row for row in layout.nodes if row.key == node.parent)
            rack_pod[node.key] = row.parent
    pods = {"1": "h1/pa", "2": "h1/pb", "3": "h2/pa", "4": "h2/pb"}
    metered = {meter.node for meter in _feed_meters(layout)}
    currents = [meter for meter in layout.meters if meter.kind == "current"]
    assert [meter.metric for meter in currents] == [Metric.CURRENT_A] * 8
    seen: list[str] = []
    for meter in currents:
        pod, letter = pods[meter.node[-2]], meter.node[-1]
        expected = tuple(
            feed
            for rack in layout.racks
            if rack_pod[rack.node] == pod
            for feed in rack.feeds
            if feed.endswith("/" + letter) and feed in metered
        )
        assert meter.feeds == expected and expected
        seen += meter.feeds
    assert sorted(seen) == sorted(metered)  # every metered feed lands on exactly one panel
    assert all(meter.feeds == () for meter in layout.meters if meter.kind != "current")


def test_a_rack_shares_its_load_between_the_feeds(layout):
    for rack in layout.racks:
        if rack.status == "single":
            assert rack.share_a == 1.0
        else:
            assert 0.45 <= rack.share_a <= 0.55
    assert all(rack.share_a == round(rack.share_a, 3) and rack.kw == round(rack.kw, 2) for rack in layout.racks)


def test_meter_ids_are_unique(layout):
    ids = [meter.id for meter in layout.meters]
    assert len(set(ids)) == len(ids) == 233
    assert pilot_hall.Meter("h1/r01/a", Metric.ENERGY_KWH, "counter").id == "h1/r01/a|energy_kwh"


def test_the_layout_is_deterministic_and_the_seed_moves_the_selection(layout):
    assert pilot_hall.build_layout(history.DEFAULT_SEED) == layout and pilot_hall.build_layout() == layout
    other = pilot_hall.build_layout(1)
    # the seed moves which racks are single-fed, so the Feed nodes differ; everything above them is the same
    def above_feeds(lay: pilot_hall.Layout) -> list[str]:
        return [node.key for node in lay.nodes if node.role != "feed"]

    assert other.seed == 1 and above_feeds(other) == above_feeds(layout)
    assert [node.key for node in other.nodes if node.role == "feed"] != [node.key for node in layout.nodes if node.role == "feed"]
    assert sum(node.role == "feed" for node in other.nodes) == 229
    assert {rack.node for rack in other.racks if rack.status == "free"} != {rack.node for rack in layout.racks if rack.status == "free"}
    assert Counter(rack.status for rack in other.racks) == Counter(rack.status for rack in layout.racks)
    assert other.meters != layout.meters


def test_every_name_is_generic(layout):
    allowed = re.compile(r"Seeded pilot hall|Hall \d|Pod [AB]|Row \d|Rack \d\d|Feed [AB]|Electrical|Panel \d[AB]")
    assert all(allowed.fullmatch(node.name) for node in layout.nodes)
    names = {node.key: node.name for node in layout.nodes}
    assert names["site"] == pilot_hall.ROOT_NAME and names["elec"] == pilot_hall.ELECTRICAL_NAME


def test_addresses_and_paths(layout):
    addresses = [pilot_hall.point_address(meter) for meter in layout.meters]
    assert len(set(addresses)) == len(addresses) and not any("|" in address for address in addresses)
    assert addresses[0] == "seed/pilot/h1/r01/a/energy_kwh" and addresses[-1] == "seed/pilot/elec/p4b/current_a"
    assert pilot_hall.path(layout, "h1/r01/a") == "Seeded pilot hall / Hall 1 / Pod A / Row 1 / Rack 01 / Feed A"
    assert pilot_hall.path(layout, "site") == "Seeded pilot hall"
    assert pilot_hall.path(layout, "elec/p2b") == "Seeded pilot hall / Electrical / Panel 2B"
    units = {meter.kind: pilot_hall.unit(meter) for meter in layout.meters}
    assert units == {"counter": "kWh", "power": "kW", "voltage": "V", "current": "A"}


def test_one_day_fits_the_writer_buffer(layout):
    assert len(layout.meters) * 288 < 90_000  # a UTC day at the 5-minute step stays under Writer(max_buffer=100_000)


# ---- the pilot-hall series (task 3): pure, no database ---------------------------------------------------------------------

HOUR = 3600


@pytest.fixture(scope="module")
def small():
    """Three days at 60 minutes: 73 instants of every meter. (plan, layout, [(instant, values)])"""
    plan = history.make_plan(NOW, ZONE, 3, raw_retention_days=30, step_seconds=HOUR)
    layout = pilot_hall.build_layout()
    return plan, layout, list(pilot_hall.samples(plan, layout))


def _series(frames, meter_id: str) -> list[tuple[datetime, float]]:
    return [(ts, values[meter_id]) for ts, values in frames if meter_id in values]


def test_the_curve_runs_from_086_to_1():
    assert pilot_hall.curve(20.0) == pytest.approx(0.86) and pilot_hall.curve(80.0) == pytest.approx(1.0)
    assert pilot_hall.curve(50.0) == pytest.approx(0.93)
    zone = ZoneInfo(ZONE)
    assert all(0.86 <= pilot_hall.curve(history.base_kw(NOW + timedelta(minutes=m), zone)) <= 1.0 for m in range(0, 1440, 15))


def test_one_item_per_instant_and_the_values_belong_to_the_layout(small):
    plan, layout, frames = small
    assert [ts for ts, _ in frames] == plan.times() and plan.count == 73
    ids = {meter.id for meter in layout.meters}
    assert all(set(values) <= ids for _, values in frames)
    assert {meter_id for _, values in frames for meter_id in values} == ids


def test_counters_only_rise_except_one_reset(small):
    plan, layout, frames = small
    counters = [meter for meter in layout.meters if meter.kind == "counter"]
    assert len(counters) == 217 - 8
    resets = [meter for meter in counters if meter.resets]
    assert len(resets) == 1
    for meter in counters:
        values = [value for _, value in _series(frames, meter.id)]
        assert values[0] == pytest.approx(round(meter.counter_base, 3))  # a counter starts at its base
        falls = [(earlier, later) for earlier, later in zip(values, values[1:]) if later < earlier]
        if meter.resets:
            assert len(falls) == 1 and falls[0][0] - falls[0][1] > 1000
        else:
            assert falls == []
    reset_values = dict(_series(frames, resets[0].id))
    assert 0.1 <= reset_values[plan.reset_at] <= 1.0  # the restarted meter shows near zero at the planned sample
    assert reset_values[plan.reset_at - plan.step] > 1000


def test_the_gap_meter_has_no_samples_in_its_gap_and_the_others_do():
    plan = history.make_plan(NOW, ZONE, 3, raw_retention_days=30, step_seconds=900)
    assert plan.gap is not None
    layout = pilot_hall.build_layout()
    frames = list(pilot_hall.samples(plan, layout))
    in_gap = [ts for ts in plan.times() if plan.in_gap(ts)]
    assert len(in_gap) == 24  # six hours of quarter hours
    gap_meters = [meter for meter in layout.meters if meter.gap]
    assert len(gap_meters) == 1
    for meter in layout.meters:
        seen = [ts for ts, _ in _series(frames, meter.id)]
        if meter.gap:
            assert len(seen) == plan.count - 24 and not (set(seen) & set(in_gap))
        else:
            assert len(seen) == plan.count
    # the gap meter keeps counting through its hole: the first sample after it jumps by about the energy of six hours
    values = dict(_series(frames, gap_meters[0].id))
    before, after = in_gap[0] - plan.step, in_gap[-1] + plan.step
    assert values[after] - values[before] > 25 * 0.5 * 0.25 * 0.86 * 0.9 * 2.0  # 25 steps at 2 kW x share x curve, a safe floor


def test_a_range_without_a_complete_day_has_no_gap_and_nothing_breaks():
    plan = history.make_plan(NOW, ZONE, 1, raw_retention_days=30, step_seconds=HOUR)
    assert plan.gap is None
    layout = pilot_hall.build_layout()
    frames = list(pilot_hall.samples(plan, layout))
    for meter in layout.meters:
        assert len(_series(frames, meter.id)) == plan.count


def test_a_rack_is_about_the_sum_of_its_feeds_and_a_panel_follows_its_feeds(small):
    plan, layout, frames = small
    step_hours = plan.step_seconds / 3600
    times = plan.times()
    by_id = {meter.id: meter for meter in layout.meters}

    def feed_power(node: str) -> list[float]:
        """The true power of a plain counter feed at every instant but the last: the rise of the counter over the step."""
        values = [value for _, value in _series(frames, f"{node}|energy_kwh")]
        return [(later - earlier) / step_hours for earlier, later in zip(values, values[1:])]

    # a live Hall 1 rack whose two feeds are plain counters (the gap and the reset meters are Feed A of other racks)
    def plain(r: pilot_hall.Rack) -> bool:
        feed_a = by_id[f"{r.node}/a|energy_kwh"]
        return not feed_a.gap and not feed_a.resets

    rack = next(r for r in layout.racks if r.hall == 1 and r.status == "live" and plain(r))
    both = [a + b for a, b in zip(feed_power(f"{rack.node}/a"), feed_power(f"{rack.node}/b"))]
    zone = ZoneInfo(ZONE)
    expected = [rack.kw * pilot_hall.curve(history.base_kw(ts, zone)) for ts in times[:-1]]
    assert sum(both) / len(both) == pytest.approx(sum(expected) / len(expected), rel=0.08)
    assert sum(feed_power(f"{rack.node}/a")) / sum(both) == pytest.approx(rack.share_a, abs=0.02)

    # Panel 1B carries the Feed B of Hall 1 Pod A: plain counters only; its current is the power of those feeds
    current = by_id["elec/p1b|current_a"]
    assert current.feeds and all(feed.startswith("h1/") and feed.endswith("/b") for feed in current.feeds)
    powers = [feed_power(feed) for feed in current.feeds]
    amps = [value for _, value in _series(frames, current.id)]
    volts = [value for _, value in _series(frames, "elec/p1b|voltage_v")]
    assert len(amps) == len(volts) == plan.count
    for index in range(plan.count - 1):
        carried = sum(power[index] for power in powers)
        assert amps[index] * math.sqrt(3) * volts[index] * 0.95 / 1000 == pytest.approx(carried, rel=0.03)


def test_a_panel_voltage_is_about_400_volts(small):
    _, layout, frames = small
    volts = [value for meter in layout.meters if meter.kind == "voltage" for _, value in _series(frames, meter.id)]
    assert len(volts) == 8 * 73 and all(396.0 <= value <= 404.0 for value in volts)
    assert all(round(value, 1) == value for value in volts)


def test_daylight_saving_inside_the_range():
    now = datetime(2026, 10, 27, 12, 0, tzinfo=timezone.utc)
    plan = history.make_plan(now, "Europe/Berlin", 5, raw_retention_days=30, step_seconds=HOUR)
    assert plan.start < datetime(2026, 10, 25, 1, 0, tzinfo=timezone.utc) < plan.end  # the clocks go back inside the range
    assert plan.gap is not None
    layout = pilot_hall.build_layout()
    times = plan.times()
    assert len(set(times)) == len(times) == plan.count
    days = list(pilot_hall.readings_by_day(plan, layout))
    assert [day for day, _ in days] == sorted({ts.date() for ts in times})
    counts: Counter[str] = Counter()
    seen: set[tuple[str, datetime]] = set()
    for day, rows in days:
        assert all(ts.date() == day for _, ts, _ in rows) and [ts for _, ts, _ in rows] == sorted(ts for _, ts, _ in rows)
        for meter_id, ts, _value in rows:
            assert (meter_id, ts) not in seen  # no instant is written twice
            seen.add((meter_id, ts))
            counts[meter_id] += 1
    hole = sum(1 for ts in times if plan.in_gap(ts))
    assert hole == 6
    for meter in layout.meters:
        assert counts[meter.id] == plan.count - (hole if meter.gap else 0)


def test_power_only_feeds_report_kw_in_range(small):
    plan, layout, frames = small
    powers = [meter for meter in layout.meters if meter.kind == "power"]
    assert len(powers) == 8
    for meter in powers:
        values = [value for _, value in _series(frames, meter.id)]
        assert len(values) == plan.count and all(0.0 < value < 12.0 for value in values)
        assert all(round(value, 3) == value for value in values)


def test_the_series_is_deterministic_and_the_seed_changes_it(small):
    plan, layout, frames = small
    assert list(pilot_hall.samples(plan, layout)) == frames
    other = history.make_plan(NOW, ZONE, 3, seed=plan.seed + 1, raw_retention_days=30, step_seconds=HOUR)
    assert list(pilot_hall.samples(other, layout)) != frames


def test_readings_by_day_groups_by_utc_day_and_is_sorted(small):
    plan, layout, frames = small
    days = list(pilot_hall.readings_by_day(plan, layout))
    assert [day for day, _ in days] == [date(2026, 10, 12), date(2026, 10, 13), date(2026, 10, 14), date(2026, 10, 15)]
    flat = [row for _, rows in days for row in rows]
    assert flat == [(meter_id, ts, value) for ts, values in frames for meter_id, value in values.items()]
    for day, rows in days:
        assert rows and all(ts.date() == day and ts.tzinfo is not None for _, ts, _ in rows)
        assert [ts for _, ts, _ in rows] == sorted(ts for _, ts, _ in rows)


def test_readings_by_day_holds_one_day_at_a_time(small, monkeypatch):
    plan, layout, _ = small
    pulled = []
    real = pilot_hall.samples

    def counting(p, l):
        for item in real(p, l):
            pulled.append(item[0])
            yield item

    monkeypatch.setattr(pilot_hall, "samples", counting)
    days = pilot_hall.readings_by_day(plan, layout)
    day, rows = next(days)
    assert day == date(2026, 10, 12) and rows
    assert {ts.date() for ts in pulled[:-1]} == {day}  # only the first instant of the next day was looked at, to see the day end
    assert pulled[-1].date() > day and len(pulled) == len(rows) // len(layout.meters) + 1


def test_free_racks_have_no_readings(small):
    _, layout, frames = small
    free = [rack for rack in layout.racks if rack.status == "free"]
    assert len(free) == 6
    seen = {meter_id for _, values in frames for meter_id in values}
    assert not [meter_id for meter_id in seen for rack in free if meter_id.startswith(rack.node + "/")]


def test_the_load_follows_the_local_hour(small):
    plan, layout, frames = small
    zone = ZoneInfo(ZONE)
    currents = [meter.id for meter in layout.meters if meter.kind == "current"]
    night, afternoon = [], []
    for ts, values in frames:
        total = sum(values[meter_id] for meter_id in currents)
        hour = ts.astimezone(zone).hour
        if hour < 5:
            night.append(total)
        elif 14 <= hour < 18:
            afternoon.append(total)
    assert night and afternoon
    assert sum(afternoon) / len(afternoon) > 1.1 * sum(night) / len(night)


# ---- the kinds a run uses (task 4a): pure -----------------------------------------------------------------------------------

ROLES = ["site", "hall", "pod", "row", "rack", "feed", "electrical", "panel"]


def test_choose_kinds_prefers_the_registry():
    empty = pilot_hall.choose_kinds(set())
    assert list(empty) == ROLES
    assert {role: (choice.name, choice.registered) for role, choice in empty.items()} == {
        "site": ("Site", False), "hall": ("Data hall", False), "pod": ("Room", False), "row": ("Row", False),
        "rack": ("Rack", False), "feed": ("Circuit", False), "electrical": ("Room", False), "panel": ("Panel", False),
    }
    assert all(choice.preferred == choice.name for choice in empty.values())  # nothing registered: the first preferred name

    basic = {"site", "room", "row", "rack", "circuit", "panel"}  # what a fresh install holds, roughly
    chosen = pilot_hall.choose_kinds(basic)
    assert all(choice.registered for choice in chosen.values())
    assert (chosen["hall"].name, chosen["hall"].preferred) == ("Room", "Data hall")  # the second preferred name is registered
    assert (chosen["feed"].name, chosen["pod"].name, chosen["electrical"].name) == ("Circuit", "Room", "Room")

    pack = pilot_hall.choose_kinds(basic | {"data hall"})
    assert (pack["hall"].name, pack["hall"].registered, pack["hall"].preferred) == ("Data hall", True, "Data hall")
    assert pack["pod"].name == "Room"

    # "Other equipment" is the fallback only for a role whose preferred names are ALL missing
    fallback = pilot_hall.choose_kinds({"other equipment", "room", "meter"})
    assert (fallback["hall"].name, fallback["hall"].registered) == ("Room", True)
    assert (fallback["feed"].name, fallback["feed"].registered) == ("Meter", True)  # the second preferred name beats the fallback
    assert (fallback["rack"].name, fallback["rack"].registered, fallback["rack"].preferred) == ("Other equipment", True, "Rack")
    assert (fallback["panel"].name, fallback["panel"].registered) == ("Other equipment", True)
    only_other = pilot_hall.choose_kinds({"other equipment"})
    assert all((choice.name, choice.registered) == ("Other equipment", True) for choice in only_other.values())
    assert only_other["site"].preferred == "Site" and only_other["hall"].preferred == "Data hall"

    # the registry holds kind_key values: spelling and spacing of the stored name do not matter, the key does
    assert pilot_hall.choose_kinds({kind_key("  DATA   Hall ")})["hall"].registered is True


# ---- the command line (task 4a) ---------------------------------------------------------------------------------------------
# A seeding test takes tens of seconds (the rollup refresh), so every run below is one or two days at a 60-minute step.

HOUR = 3600
QUICK = ["--days", "1", "--interval-minutes", "60"]
TWO_DAYS = ["--days", "2", "--interval-minutes", "60"]
WATCHED = (
    "sources", "assets", "points", "mappings", "readings", "point_latest", "tariffs", "settings", "audit_log", "asset_kinds",
    "users", "dashboards", "widgets", "jobs", "graph_layout", "scans",
)
UNTOUCHED = ("tariffs", "settings", "audit_log", "asset_kinds", "users", "dashboards", "widgets", "jobs", "graph_layout", "scans")


@pytest.fixture(autouse=True)
def frozen_billing(monkeypatch):
    monkeypatch.setattr(billing, "_now", lambda: NOW)


@pytest.fixture
def allowed(monkeypatch):
    monkeypatch.setenv(history.SWITCH, "1")


@pytest.fixture
async def site(db):
    """Qatar, and the factory raw retention of 30 days (which the `db` fixture stores)."""
    await set_zone(db, ZONE)
    return db


async def counts(db) -> dict[str, int]:
    return {table: await db.fetchval(f"SELECT count(*) FROM {table}") for table in WATCHED}


async def dump(db, table: str, order: str = "id") -> list[tuple]:
    return [tuple(row) for row in await db.fetch(f"SELECT * FROM {table} ORDER BY {order}")]


async def seed_pilot(args: list[str] | None = None) -> int:
    return await history.amain(["--yes", "--layout", "pilot-hall", *(args or [])])


async def asset_rows(db) -> dict[str, object]:
    """Every asset row by its path (the names from the root down): a name repeats across halls, a path does not."""
    rows = {row["id"]: row for row in await db.fetch("SELECT * FROM assets")}

    def route(row) -> str:
        names = []
        while row is not None:
            names.append(row["name"])
            row = rows.get(row["parent_id"])
        return " / ".join(reversed(names))

    return {route(row): row for row in rows.values()}


async def month_figures(month: str) -> dict[int, dict]:
    async with get_sessionmaker()() as session:
        body = await billing.month_costs(session, month)
    return {asset["asset_id"]: asset for asset in body["assets"]}


async def test_the_old_layout_is_still_the_default(site, capsys):
    assert await history.amain([]) == 0
    out = capsys.readouterr().out
    assert "Seeded Panel A" in out and "Seeded pilot hall" not in out and "seeded-history" in out


async def test_yes_without_the_variable_exits_2(site, capsys, monkeypatch):
    before = await counts(site)
    assert await seed_pilot() == 2
    assert history.SWITCH in capsys.readouterr().err
    monkeypatch.setenv(history.SWITCH, "true")
    assert await seed_pilot() == 2
    assert await counts(site) == before


async def test_interval_minutes_is_refused_for_the_old_layout(site, allowed, capsys):
    before = await counts(site)
    for argv in (["--interval-minutes", "60"], ["--layout", "three-panels", "--interval-minutes", "15"], ["--yes", "--interval-minutes", "5"]):
        with pytest.raises(SystemExit) as caught:
            await history.amain(argv)
        assert caught.value.code == 2
        assert "--interval-minutes only applies to --layout pilot-hall" in capsys.readouterr().err
    with pytest.raises(SystemExit) as caught:  # a value that is not an offered interval is refused by argparse
        await history.amain(["--layout", "pilot-hall", "--interval-minutes", "7"])
    assert caught.value.code == 2
    with pytest.raises(SystemExit) as caught:  # and so is a layout that does not exist
        await history.amain(["--layout", "nope"])
    assert caught.value.code == 2
    assert await counts(site) == before


# ---- one run: the rows, the report, the figures ---------------------------------------------------------------------------


async def test_a_run_creates_exactly_the_planned_rows(site, allowed, capsys):
    before = await counts(site)
    layout = pilot_hall.build_layout()
    plan = history.make_plan(NOW, ZONE, 1, raw_retention_days=30, step_seconds=HOUR)
    frames = list(pilot_hall.samples(plan, layout))
    expected = sum(len(values) for _, values in frames)
    assert plan.gap is None and expected == len(layout.meters) * plan.count == 233 * 25

    assert await seed_pilot(QUICK) == 0
    out = capsys.readouterr().out
    assert out.splitlines()[0] == "Seeded pilot hall created."
    assert "assets    370 (site 1, halls 2, pods 4, rows 8, racks 117, feeds 229, electrical 1, panels 8)" in out and len(layout.nodes) == 370
    assert "points    233" in out and "interval  60 minutes" in out and f"readings  {expected}" in out
    assert "range     " in out and f" in {ZONE}" in out and "clamped" not in out
    assert re.search(r"took \d+(\.\d+)? s writing, \d+(\.\d+)? s refreshing the rollups", out)
    assert "Set a site rate in Tariffs to see costs." in out and f"To undo it: {pilot_hall.UNDO}." in out
    assert "Billing cannot use" not in out
    for role in ROLES:  # the test registry is empty, so every role's kind is unregistered and the report says so
        preferred = pilot_hall.choose_kinds(set())[role].name
        assert f'kind "{preferred}" for {role} is not in the Asset kinds list (preferred "{preferred}")' in out

    after = await counts(site)
    assert after["sources"] == before["sources"] + 1 and after["assets"] == before["assets"] + len(layout.nodes)
    assert after["points"] == after["mappings"] == after["point_latest"] == len(layout.meters)
    assert after["readings"] == expected
    for table in UNTOUCHED:
        assert after[table] == before[table], table  # no audit row, no registered kind, no other row

    source = await site.fetchrow("SELECT * FROM sources")
    assert (source["name"], source["connector_type"], source["enabled"], source["origin"]) == ("seeded-pilot-hall", "simulator", False, "manual")
    assert source["status"] == "unknown" and source["secret"] is None
    assert SimulatorConfig.model_validate(source["config"]).model_dump(mode="json") == source["config"]
    assert f'"{pilot_hall.SOURCE_NAME}" id {source["id"]}' in out

    # the tree is the layout: same paths, kinds from choose_kinds, Electrical listed after the halls, no icon of its own
    rows = await asset_rows(site)
    kinds = pilot_hall.choose_kinds(set())
    assert set(rows) == {pilot_hall.path(layout, node.key) for node in layout.nodes}
    for node in layout.nodes:
        row = rows[pilot_hall.path(layout, node.key)]
        assert (row["kind"], row["sort_order"], row["icon"]) == (kinds[node.role].name, node.sort_order, None), node.key
        assert (row["parent_id"] is None) == (node.parent is None)
    assert rows[pilot_hall.ROOT_NAME]["kind"] == "Site" and rows[f"{pilot_hall.ROOT_NAME} / Electrical"]["sort_order"] == 1
    assert f"root      \"{pilot_hall.ROOT_NAME}\" id {rows[pilot_hall.ROOT_NAME]['id']}" in out

    points = {row["address"]: row for row in await site.fetch(
        "SELECT p.*, m.metric, m.scale, m.interval_seconds, m.asset_id FROM points p JOIN mappings m ON m.point_id = p.id"
    )}
    assert len(points) == len(layout.meters)
    for meter in layout.meters:
        row = points[pilot_hall.point_address(meter)]
        assert row["name"] == f"{pilot_hall.path(layout, meter.node)} {meter.metric.value}" and row["data_type"] == "float"
        assert (row["unit_hint"], row["metric"], row["scale"], row["interval_seconds"]) == (pilot_hall.unit(meter), meter.metric.value, 1.0, HOUR)
        assert row["asset_id"] == rows[pilot_hall.path(layout, meter.node)]["id"]
    panel_metrics = {points[pilot_hall.point_address(m)]["metric"] for m in layout.meters if m.kind in ("voltage", "current")}
    assert panel_metrics == {"voltage_v", "current_a"}  # a panel carries no energy mapping

    # the readings are the generator's, through the collector's writer: quality GOOD, point_latest holds each meter's last value
    assert await site.fetchval("SELECT count(*) FROM readings WHERE quality <> 0") == 0
    assert await site.fetchval("SELECT min(ts) FROM readings") == plan.start and await site.fetchval("SELECT max(ts) FROM readings") == plan.end
    last = frames[-1][1]
    for meter in layout.meters:
        latest = await site.fetchrow("SELECT ts, value FROM point_latest WHERE point_id = $1", points[pilot_hall.point_address(meter)]["id"])
        assert (latest["ts"], latest["value"]) == (plan.end, last[meter.id]), meter.id
    assert await site.fetchval("SELECT count(*) FROM readings_1h") > 0 and await site.fetchval("SELECT count(*) FROM readings_1m") > 0


async def test_totals_do_not_double_count(site, allowed):
    layout = pilot_hall.build_layout()
    assert await seed_pilot(TWO_DAYS) == 0
    rows = await asset_rows(site)
    figures = await month_figures("2026-10")

    def total(key: str) -> dict | None:
        return figures[rows[pilot_hall.path(layout, key)]["id"]]["total"]

    racks_of = {hall: [rack for rack in layout.racks if rack.hall == hall] for hall in (1, 2)}
    for hall, racks in racks_of.items():
        live = [rack for rack in racks if rack.status != "free"]
        assert total(f"h{hall}")["kwh"] == pytest.approx(sum(total(rack.node)["kwh"] for rack in live), rel=1e-9)
        assert total(f"h{hall}")["kwh"] > 0
    assert total("site")["kwh"] == pytest.approx(total("h1")["kwh"] + total("h2")["kwh"], rel=1e-9)  # no Electrical energy on top
    for rack in layout.racks:
        if rack.status == "free":
            assert total(rack.node) is None and all(total(feed) is None for feed in rack.feeds), rack.node
        else:
            assert total(rack.node)["kwh"] == pytest.approx(sum(total(feed)["kwh"] for feed in rack.feeds), rel=1e-9), rack.node
    assert total("elec") is None and all(total(node.key) is None for node in layout.nodes if node.role == "panel")
    # Hall 1 is exact; Hall 2 holds the power-only feeds the engine has to estimate, and the Site above it shows the same "~"
    assert total("h1")["estimated"] is False
    assert total("h2")["estimated"] is True and total("site")["estimated"] is True


async def test_a_feed_matches_the_generator(site, allowed):
    layout = pilot_hall.build_layout()
    plan = history.make_plan(NOW, ZONE, 2, raw_retention_days=30, step_seconds=HOUR)
    meter = next(m for m in layout.meters if m.node.startswith("h1/") and m.kind == "counter" and not m.gap and not m.resets)
    rows = [(ts, values[meter.id]) for ts, values in pilot_hall.samples(plan, layout) if meter.id in values]
    zone = ZoneInfo(ZONE)
    model: dict[date, float] = defaultdict(float)
    for (_, before), (when, after) in zip(rows, rows[1:]):
        model[when.astimezone(zone).date()] += max(0.0, after - before)

    assert await seed_pilot(TWO_DAYS) == 0
    figures = await month_figures("2026-10")
    asset = (await asset_rows(site))[pilot_hall.path(layout, meter.node)]["id"]
    complete = date(2026, 10, 14)  # the one local day wholly inside the two days
    assert figures[asset]["days"][complete.day - 1]["kwh"] == pytest.approx(model[complete], rel=1e-6)
    assert model[complete] > 20  # a real figure: a feed of 1 to 11 kW draws tens of kWh in a day


# ---- refusals, other layout, clean-up ---------------------------------------------------------------------------------------


async def test_a_second_run_refuses_and_changes_nothing(site, allowed, capsys):
    assert await seed_pilot(QUICK) == 0
    capsys.readouterr()
    before = {"counts": await counts(site), "assets": await dump(site, "assets"), "sources": await dump(site, "sources")}
    assert await seed_pilot(QUICK) == 1
    err = capsys.readouterr().err
    assert "Refused, nothing written" in err and "seeded-pilot-hall" in err and "To undo it" in err
    assert {"counts": await counts(site), "assets": await dump(site, "assets"), "sources": await dump(site, "sources")} == before
    assert await history.amain(["--layout", "pilot-hall"]) == 0  # the dry run still exits 0


@pytest.mark.parametrize("first", ["three-panels", "pilot-hall"])
async def test_the_other_layout_coexists_both_ways(site, allowed, capsys, first):
    arguments = {"three-panels": ["--layout", "three-panels", "--days", "1"], "pilot-hall": ["--layout", "pilot-hall", *QUICK]}
    names = {"three-panels": "seeded-history", "pilot-hall": "seeded-pilot-hall"}
    second = "pilot-hall" if first == "three-panels" else "three-panels"
    assert await history.amain(["--yes", *arguments[first]]) == 0
    assert await history.amain(["--yes", *arguments[second]]) == 0  # the other layout's rows never refuse
    assert await site.fetchval("SELECT count(*) FROM sources") == 2
    capsys.readouterr()
    before = await counts(site)
    for layout_name in (first, second):  # each guard refuses its own second run, and names its own source
        assert await history.amain(["--yes", *arguments[layout_name]]) == 1
        assert names[layout_name] in capsys.readouterr().err
        assert await counts(site) == before
    rows = await asset_rows(site)
    assert {"Seeded demo", "Seeded pilot hall"} <= set(rows)


async def test_a_flush_that_fails_after_the_first_day_takes_everything_back(site, allowed, monkeypatch, capsys):
    real = history.Writer.flush
    calls: list[int] = []

    async def first_then_nothing(self):
        calls.append(self.pending)
        return await real(self) if len(calls) == 1 else 0  # what Writer.flush does when the database is unavailable

    monkeypatch.setattr(history.Writer, "flush", first_then_nothing)
    before = await counts(site)
    assert await seed_pilot(QUICK) == 1
    err = capsys.readouterr().err
    assert len(calls) == 2 and "Failed, and what it had made was removed" in err and "took 0 of" in err
    assert await counts(site) == before  # source, assets, points, mappings, readings and point_latest are all gone
    for table in ("readings", "readings_1m", "readings_1h"):
        assert await site.fetchval(f"SELECT count(*) FROM {table}") == 0, table


async def test_a_failed_refresh_takes_everything_back(site, allowed, monkeypatch, capsys):
    calls = []
    real = history.refresh_rollups

    async def refreshes_then_breaks(pool, plan):
        calls.append(plan)
        await real(pool, plan)  # the rollups now hold the seeded minutes and hours ... (the cleanup refreshes them again)
        if len(calls) == 1:
            raise RuntimeError("the refresh broke")

    monkeypatch.setattr(history, "refresh_rollups", refreshes_then_breaks)
    before = await counts(site)
    assert await seed_pilot(QUICK) == 1
    assert "the refresh broke" in capsys.readouterr().err and len(calls) == 2
    assert await counts(site) == before
    assert await site.fetchval("SELECT count(*) FROM readings_1m") == 0 and await site.fetchval("SELECT count(*) FROM readings_1h") == 0


async def test_cancellation_takes_everything_back_and_propagates(site, allowed, monkeypatch):
    real = history.Writer.flush
    calls: list[int] = []

    async def cancelled_on_the_second(self):
        calls.append(self.pending)
        if len(calls) == 2:
            raise asyncio.CancelledError()  # Ctrl+C or a cancelled task, half way through the days
        return await real(self)

    monkeypatch.setattr(history.Writer, "flush", cancelled_on_the_second)
    before = await counts(site)
    with pytest.raises(asyncio.CancelledError):
        await seed_pilot(QUICK)
    assert len(calls) == 2
    assert await counts(site) == before
    for table in ("readings", "readings_1m", "readings_1h"):
        assert await site.fetchval(f"SELECT count(*) FROM {table}") == 0, table


async def test_the_write_phase_reports_every_fifth_day(site, allowed, monkeypatch, capsys):
    async def drains(pool, batches):  # the progress lines belong to the days as they are pulled, so no database writes are needed
        return sum(len(rows) for _day, rows in batches)

    async def no_refresh(pool, plan):
        return None

    monkeypatch.setattr(history, "write_batches", drains)
    monkeypatch.setattr(history, "refresh_rollups", no_refresh)
    for days, expected in ((9, 10), (11, 12)):  # 10 UTC dates: a line after the 5th and the 10th; 12 dates: 5th and 10th only
        plan = history.make_plan(NOW, ZONE, days, raw_retention_days=30, step_seconds=HOUR)
        assert len({ts.date() for ts in plan.times()}) == expected
        await site.execute("DELETE FROM sources; DELETE FROM assets")
        assert await seed_pilot(["--days", str(days), "--interval-minutes", "60"]) == 0
        lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("written ")]
        assert lines == [f"written 5 of {expected} days", f"written 10 of {expected} days"]


# ---- the dry run, the kinds in the database, the refusals (task 4b) ---------------------------------------------------------

WARNING = "(not in the Asset kinds list)"
DRY = "  would create  "


async def set_retention(db, days: int) -> None:  # as in test_seed_history.py
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('storage', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"raw_retention_days": days, "compress_after_days": 7, "rollup_1m_retention_days": 730, "disk_capacity_gb": 100,
         "warn_threshold_pct": 80},
    )


async def dry_output(capsys, args: list[str] | None = None) -> str:
    """What the dry run prints. It always exits 0, whatever it finds."""
    capsys.readouterr()
    assert await history.amain(["--layout", "pilot-hall", *(args or [])]) == 0
    return capsys.readouterr().out


async def test_no_arguments_prints_the_plan_and_writes_nothing(site, capsys):
    before = {"counts": await counts(site), "settings": await dump(site, "settings", "key")}
    out = await dry_output(capsys)
    lines = out.splitlines()
    assert lines[0] == "Dry run: the seeder would create the following. Nothing written."
    assert all(line.startswith(DRY) for line in lines[1:-2])  # no note and no refusal here: only plan lines in between
    assert lines[-2] == f"To do it, run again with --yes and {history.SWITCH}=1 in the environment."
    assert lines[-1].startswith("Set a site rate in Tariffs to see costs") and "several minutes" in lines[-1]
    assert "--days N" in lines[-1] and "--interval-minutes" in lines[-1]
    assert "seeded-pilot-hall" in out and "Seeded pilot hall" in out and "Nothing written" in out and "Tariffs" in out
    assert "clamped" in out  # the factory retention of 30 days cuts the default range back to 29 days
    assert "would be refused" not in out and "not read" not in out
    assert {"counts": await counts(site), "settings": await dump(site, "settings", "key")} == before


async def test_the_dry_run_says_what_it_would_make(site, capsys):
    layout = pilot_hall.build_layout()
    plan = history.make_plan(NOW, ZONE, 3, raw_retention_days=30, step_seconds=HOUR)
    assert plan.gap is not None
    out = await dry_output(capsys, ["--days", "3", "--interval-minutes", "60"])
    by_status = Counter(rack.status for rack in layout.racks)
    gap_meter = next(meter for meter in layout.meters if meter.gap)
    reset_meter = next(meter for meter in layout.meters if meter.resets)
    power_only = [meter for meter in layout.meters if meter.kind == "power"]
    expected = len(layout.meters) * plan.count - int((plan.gap[1] - plan.gap[0]) / plan.step)

    assert f'{DRY}source   "seeded-pilot-hall" (simulator, DISABLED: nothing ever polls it)' in out
    assert f"{DRY}assets   370 (site 1, halls 2, pods 4, rows 8, racks 117, feeds 229, electrical 1, panels 8)" in out
    for role, names in pilot_hall.PREFERRED_KINDS.items():  # the test registry is empty: every role says so
        assert f'{DRY}kinds    {role} "{names[0]}" {WARNING}' in out
    assert f"{DRY}racks    117 ({by_status['live']} live, {by_status['idle']} idle, {by_status['single']} single-feed" in out
    assert (by_status["live"], by_status["idle"], by_status["single"], by_status["free"]) == (100, 6, 5, 6)
    assert f"{by_status['free']} free" in out
    assert f"{DRY}points   233, each mapped with an interval of 3600 seconds: 209 energy counters" in out
    assert "8 power-only feeds" in out and "8 panel voltages" in out and "8 panel currents" in out
    assert (
        f"{DRY}range    {history._local(plan.start, ZONE)} to {history._local(plan.end, ZONE)} in {ZONE} "
        f"({plan.start:%Y-%m-%d %H:%M} to {plan.end:%Y-%m-%d %H:%M} UTC), one sample every 60 minutes"
    ) in out
    assert "clamped" not in out  # --days replaces the range: nothing is cut back
    assert re.search(rf"{DRY}readings {expected} \(", out) and expected == 233 * 73 - 6
    assert len(power_only) == 8 and all(meter.node.startswith("h2/") for meter in power_only)
    assert f"{DRY}power    8 feeds (all in Hall 2) report kW instead of a kWh counter" in out
    assert (
        f"{DRY}gap      {pilot_hall.path(layout, gap_meter.node)} has no samples from {history._local(plan.gap[0], ZONE)} "
        f"to {history._local(plan.gap[1], ZONE)}"
    ) in out
    assert (
        f"{DRY}reset    the counter of {pilot_hall.path(layout, reset_meter.node)} drops back to near zero at "
        f"{history._local(plan.reset_at, ZONE)}"
    ) in out
    assert "Hall 1 / " in pilot_hall.path(layout, gap_meter.node) and gap_meter.node != reset_meter.node


@pytest.mark.parametrize(
    "zone, args",
    [
        (ZONE, ["--days", "3"]),  # the default interval
        (ZONE, ["--days", "3", "--interval-minutes", "15"]),
        (ZONE, ["--days", "1", "--interval-minutes", "60"]),  # no complete day: no gap
        ("Asia/Kolkata", ["--days", "3", "--interval-minutes", "60"]),  # the gap starts at 03:30 UTC, between the hour marks
        ("Asia/Kolkata", ["--days", "3", "--interval-minutes", "30"]),
    ],
)
async def test_the_dry_run_estimate_equals_the_real_count(site, capsys, zone, args):
    await set_zone(site, zone)
    interval = int(args[args.index("--interval-minutes") + 1]) if "--interval-minutes" in args else pilot_hall.DEFAULT_INTERVAL_MINUTES
    plan = history.make_plan(NOW, zone, int(args[1]), raw_retention_days=30, step_seconds=interval * 60)
    real = sum(len(values) for _ts, values in pilot_hall.samples(plan, pilot_hall.build_layout()))
    out = await dry_output(capsys, args)
    printed = re.search(rf"{DRY}readings (\d+) ", out)
    assert printed is not None and int(printed.group(1)) == real
    assert (plan.gap is None) == ("gap      none (the range holds no complete day)" in out)
    assert real == 233 * plan.count - (0 if plan.gap is None else int((plan.gap[1] - plan.gap[0]) / plan.step))


async def test_the_dry_run_works_without_a_database(monkeypatch, capsys):
    async def no_database():
        raise OSError("no database here")

    monkeypatch.setattr(pilot_hall, "create_pool", no_database)
    out = await dry_output(capsys, ["--days", "3", "--interval-minutes", "60"])
    preferred = ", ".join(f"{role} {names[0]}" for role, names in pilot_hall.PREFERRED_KINDS.items())
    assert (
        f"  (the database was not read: OSError; kinds not read, the preferred kinds would be used: {preferred}; "
        f"using the time zone {history._default_timezone()})"
    ) in out
    assert f'{DRY}assets   370 (' in out and f'{DRY}kinds    hall "Data hall"\n' in out  # the plan is still shown, kinds by preference
    assert f"{DRY}points   233, " in out and f"{DRY}readings " in out
    assert WARNING not in out and "would be refused" not in out  # nothing is claimed about the registry or about leftovers
    assert out.splitlines()[-2] == f"To do it, run again with --yes and {history.SWITCH}=1 in the environment."


async def test_kinds_come_from_the_registry(site, allowed, capsys):
    assert await site.fetchval("SELECT count(*) FROM asset_kinds") == 0  # the test database starts with an empty registry

    async def register(*names: str) -> None:
        for name in names:
            await site.execute("INSERT INTO asset_kinds (name, key, icon) VALUES ($1, $2, 'generic')", name, kind_key(name))

    out = await dry_output(capsys, QUICK)  # nothing registered: every role falls back to its first preferred name and says so
    assert out.count(WARNING) == 8
    for role, names in pilot_hall.PREFERRED_KINDS.items():
        assert f'{DRY}kinds    {role} "{names[0]}" {WARNING}' in out

    await register("Site", "Room")  # site, hall (Room), pod, electrical are registered now; row, rack, feed and panel are not
    out = await dry_output(capsys, QUICK)
    assert out.count(WARNING) == 4
    for role in ("row", "rack", "feed", "panel"):
        assert f'{DRY}kinds    {role} "{pilot_hall.PREFERRED_KINDS[role][0]}" {WARNING}' in out
    assert f'{DRY}kinds    hall "Room" (preferred "Data hall")\n' in out and f'{DRY}kinds    site "Site"\n' in out

    await register("Row", "Rack", "Circuit", "Panel")
    out = await dry_output(capsys, QUICK)
    assert WARNING not in out and f'{DRY}kinds    hall "Room" (preferred "Data hall")\n' in out
    assert f'{DRY}kinds    feed "Circuit"\n' in out

    await register("Data hall")
    out = await dry_output(capsys, QUICK)
    assert WARNING not in out and f'{DRY}kinds    hall "Data hall"\n' in out and "(preferred" not in out
    assert await site.fetchval("SELECT count(*) FROM asset_kinds") == 7  # a dry run registers nothing

    assert await seed_pilot(QUICK) == 0  # a real run reads the same registry, and registers nothing either
    report = capsys.readouterr().out
    assert "is not in the Asset kinds list" not in report
    assert await site.fetchval("SELECT count(*) FROM asset_kinds") == 7
    wanted = {"site": "Site", "hall": "Data hall", "pod": "Room", "row": "Row", "rack": "Rack", "feed": "Circuit", "electrical": "Room", "panel": "Panel"}
    layout = pilot_hall.build_layout()
    rows = await asset_rows(site)
    for node in layout.nodes:
        assert rows[pilot_hall.path(layout, node.key)]["kind"] == wanted[node.role], node.key


async def test_a_leftover_root_asset_refuses(site, allowed, capsys):
    await make_asset(site, " seeded   PILOT hall ")  # the API treats this as the same name: it ignores case and spacing
    before = await counts(site)
    out = await dry_output(capsys, QUICK)
    assert 'A real run would be refused: a top-level asset named "Seeded pilot hall" already exists' in out
    assert "To do it, run again with --yes" in out  # the dry run still ends as always: it only warns
    assert await seed_pilot(QUICK) == 1
    err = capsys.readouterr().err
    assert "Refused, nothing written" in err and 'a top-level asset named "Seeded pilot hall" already exists' in err
    assert await counts(site) == before


async def test_a_leftover_source_refuses(site, allowed, capsys):
    await make_source(site, "seeded-pilot-hall")
    before = await counts(site)
    out = await dry_output(capsys, QUICK)
    assert 'A real run would be refused: a source named "seeded-pilot-hall" already exists' in out and "To undo it" in out
    assert await seed_pilot(QUICK) == 1
    err = capsys.readouterr().err
    assert "Refused, nothing written" in err and 'a source named "seeded-pilot-hall" already exists' in err
    assert await counts(site) == before


async def test_the_other_layouts_rows_do_not_make_the_dry_run_refuse(site, allowed, capsys):
    assert await history.amain(["--yes", "--layout", "three-panels", "--days", "1"]) == 0
    out = await dry_output(capsys, QUICK)
    assert "would be refused" not in out and 'source   "seeded-pilot-hall"' in out


async def test_the_range_clamp_and_the_pending_drop_check_apply(site, allowed, capsys):
    # a retention too short for the previous month: the default range is refused (the dry run says so, and still exits 0) ...
    await set_retention(site, 10)
    before = await counts(site)
    out = await dry_output(capsys, ["--interval-minutes", "60"])
    assert "A real run would be refused" in out and "raw retention is 10 days" in out and f"{DRY}range" not in out
    assert await seed_pilot(["--interval-minutes", "60"]) == 1
    assert "raw retention is 10 days" in capsys.readouterr().err
    assert await counts(site) == before
    assert "would be refused" not in await dry_output(capsys, QUICK)  # ... but an explicit --days does not promise the previous month

    # --days beyond the retention is cut back, and the dry run says so
    await set_retention(site, 8)
    out = await dry_output(capsys, ["--days", "60", "--interval-minutes", "60"])
    assert "2026-10-08 15:00 to 2026-10-15 15:00" in out and "clamped" in out and "raw retention is 8 days" in out
    assert "would be refused" not in out

    # raw readings the retention dropped while their rollups remain: a refresh over the range would delete that history
    await set_retention(site, 30)
    source = await make_source(site, "Real source")
    point = await make_point(site, source, "kW")
    await insert_readings(site, point, datetime(2026, 10, 1, 0, 0, tzinfo=timezone.utc), 60, [float(i) for i in range(180)])
    await settle_rollups(site)
    await site.execute("SELECT drop_chunks('readings', older_than => TIMESTAMPTZ '2026-10-10')")  # what the retention policy does
    assert await site.fetchval("SELECT count(*) FROM readings") == 0
    rollups = {view: await dump(site, view, "point_id, bucket") for view in ("readings_1m", "readings_1h")}
    assert len(rollups["readings_1m"]) == 180 and len(rollups["readings_1h"]) == 3
    counts_before = await counts(site)

    assert await seed_pilot(["--interval-minutes", "60"]) == 1
    err = capsys.readouterr().err
    assert "readings_1m" in err and "2026-10-01 00:00" in err and "nothing is written" in err
    out = await dry_output(capsys, ["--interval-minutes", "60"])
    assert "A real run would be refused: the 1-minute rollup (readings_1m)" in out and "2026-10-01 00:00" in out
    assert await counts(site) == counts_before
    for view, rows in rollups.items():  # the real history is untouched, row for row
        assert await dump(site, view, "point_id, bucket") == rows, view


async def test_rows_that_existed_before_are_unchanged(site, allowed):
    source = await make_source(site, "Existing source", config={"host": "10.0.0.5"})
    point = await make_point(site, source, "kW")
    asset = await make_asset(site, "Existing asset")
    await make_mapping(site, point, asset, "active_power_kw", 5)
    await add_tariff(site, 0.10, "2026-01-01")
    # real readings inside the range, with their rollups: the refresh the seeder runs over the range must leave them as they were
    await insert_readings(site, point, datetime(2026, 10, 14, 6, 0, tzinfo=timezone.utc), 30, [float(i % 17) for i in range(2400)])
    await settle_rollups(site)
    tables = ("sources", "points", "assets", "mappings", "tariffs")
    before = {table: await dump(site, table) for table in tables} | {"settings": await dump(site, "settings", "key")}
    rollups = {view: await dump(site, view, "point_id, bucket") for view in ("readings_1m", "readings_1h")}
    assert len(rollups["readings_1m"]) == 20 * 60 and len(rollups["readings_1h"]) == 20
    assert await seed_pilot(TWO_DAYS) == 0
    for table in tables:
        old_ids = {row[0] for row in before[table]}
        assert [row for row in await dump(site, table) if row[0] in old_ids] == before[table], table
    assert await dump(site, "settings", "key") == before["settings"]
    assert await site.fetchval("SELECT count(*) FROM readings WHERE point_id = $1", point) == 2400
    for view, rows in rollups.items():
        assert [row for row in await dump(site, view, "point_id, bucket") if row[0] == point] == rows, view


async def test_a_range_without_a_complete_day_runs(site, allowed, capsys):
    layout = pilot_hall.build_layout()
    plan = history.make_plan(NOW, ZONE, 1, raw_retention_days=30, step_seconds=HOUR)
    assert plan.gap is None and plan.count == 25
    out = await dry_output(capsys, QUICK)
    assert f"{DRY}gap      none (the range holds no complete day)" in out

    assert await seed_pilot(QUICK) == 0
    capsys.readouterr()
    per_point = {row["point_id"]: row["n"] for row in await site.fetch("SELECT point_id, count(*) AS n FROM readings GROUP BY point_id")}
    assert len(per_point) == len(layout.meters) and set(per_point.values()) == {plan.count}  # no meter lacks a sample


async def test_a_site_zone_billing_cannot_use_prints_the_warning(site, allowed, capsys):
    await set_zone(site, "Asia/Kolkata")  # UTC+5:30: Billing works in whole hours
    assert await seed_pilot(QUICK) == 0
    out = capsys.readouterr().out
    assert "Billing cannot use this site time zone" in out and " in Asia/Kolkata" in out
    assert out.splitlines()[0] == "Seeded pilot hall created."
