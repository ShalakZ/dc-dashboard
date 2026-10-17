"""The pilot-hall demo seed (w16): the shared machinery it borrows from the old history seeder takes a sample step, a batch writer
and an undo sentence of its own, and its layout and series are pure functions of a seed.

These tests do not touch the old layout's figures (`test_seed_history.py` pins those and runs unmodified). The first group needs no
database: it checks the plan arithmetic, the batch writer's checks and the undo texts of `dcdash.seed.history`."""
import math
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from dcdash.core.metrics import Metric
from dcdash.seed import history, pilot_hall

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
