"""w26 against a real database: the new paths give the figures of the OLD way, by `repr`, with the cache on and with it off.

The old way is rebuilt here from `tests/reference_engine.py` (main a62fce0): the oracle's row statement and `assemble`, its
`cost_by_hour`, `day_entries`, `month_total` and `rate_at`, in the order the handlers of a62fce0 called them (`month_costs`,
`_fill_billing`'s plain branch, `_fill_compare`). `core/compare.py`, `core/timeutil.py` and `core/daycost.py` are unchanged since
a62fce0, so the helpers taken from them (`windows`, `side_from_entries`, `change`, `contributing_meters`, `rate_change`,
`local_days`) are the old ones. Nothing here reads a shared value: Billing's days, a comparison card and a plain card are set
against what the old code would have computed from the same rows, so a bug in how the shared month is built (a wrong window
handed to `assemble`, a day shifted, a tariff of another month) shows as a difference, not as a card equal to itself.
"""
import numbers
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

import reference_engine as ref
from billing_helpers import add_tariff
from dcdash.api import billing, billing_check
from dcdash.core import cost, energy, figure_cache
from dcdash.core import widgets as widgets_module
from dcdash.core.compare import change, contributing_meters, rate_change, side_from_entries, windows
from dcdash.core.db import get_sessionmaker
from dcdash.core.timeutil import local_days, month_bounds, resolve_range
from dcdash.core.tree import AssetTree
from dcdash.core.widgets import validate_config, widget_data
from test_engine_oracle import old_hourly_energy
from test_figures import MONTH, NOW, build, compare_card

UTC = timezone.utc
ZONE = "UTC"
LATER = NOW + timedelta(days=30)  # April is over: every day of it counts


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    for target in ("dcdash.api.widget_data._now", "dcdash.api.billing._now", "dcdash.api.data._now"):
        monkeypatch.setattr(target, lambda: NOW)


@pytest.fixture
async def session(db):
    async with get_sessionmaker()() as s:
        yield s


async def small_world(db) -> dict[str, int]:
    """`test_figures.build` (counters read twice a day with a gap at the end of March, a power-only meter, a site rate of 0.10,
    Hall A at 0.18 from 3 April), plus a rate change on the site in the middle of April and an override on Pump in March."""
    ids = await build(db)
    await add_tariff(db, 0.12, "2026-04-05")
    await add_tariff(db, 0.25, "2026-03-10", ids["Pump"])
    return ids


# ---- the old way -----------------------------------------------------------------------------------------------------------------


async def old_inputs(session, start: datetime, end: datetime):
    """(tree, oracle tariffs, oracle energy result, oracle priced hours) for [start, end), as a62fce0 built them."""
    tree = await AssetTree.load(session)
    result = await old_hourly_energy(session, tree, start, end)
    tariffs = [ref.TariffRow(t.asset_id, t.rate_per_kwh, t.effective_from) for t in await cost.load_tariffs(session)]
    return tree, tariffs, result, ref.cost_by_hour(result, tariffs, tree, ZONE)


async def old_billing_assets(session, month: str, now: datetime) -> list[dict]:
    """`month_costs` of a62fce0, line for line (the part that builds the assets)."""
    start, end = month_bounds(month, ZONE)
    tree, tariffs, _, priced = await old_inputs(session, start.astimezone(UTC), end.astimezone(UTC))
    days = local_days(start, end, ZONE)
    today = now.astimezone(ZoneInfo(ZONE)).date()
    first_day, last_day = days[0][0], days[-1][0]
    rate_day = today if first_day <= today <= last_day else last_day
    assets = []
    for asset_id in tree.preorder():
        entries = ref.day_entries(
            priced.get(asset_id), days, now=now,
            rate_on=lambda day, a=asset_id: ref.rate_at(tariffs, tree, a, day) is not None,
        )
        assets.append({
            "asset_id": asset_id, "parent_id": tree.nodes[asset_id].parent_id, "name": tree.nodes[asset_id].name,
            "path": tree.path(asset_id), "rate_per_kwh": ref.rate_at(tariffs, tree, asset_id, rate_day), "days": entries,
            "total": ref.month_total(entries),
        })
    return assets


class OldCompare:
    """The two months `_fill_compare` of a62fce0 read for one `now`, and what it made of them for any asset."""

    def __init__(self, session, now: datetime) -> None:
        self.session, self.now, self.win = session, now, windows(now, ZONE)

    async def load(self) -> "OldCompare":
        self.tree = await AssetTree.load(self.session)
        self.live_tariffs = await cost.load_tariffs(self.session)
        self.tariffs = [ref.TariffRow(t.asset_id, t.rate_per_kwh, t.effective_from) for t in self.live_tariffs]
        self.reads = []  # (start of the read, its energy, the energy priced), last month first
        for month in (self.win.last_month, self.win.this_month):
            lo, hi = (bound.astimezone(UTC) for bound in month_bounds(month, ZONE))
            energy_ = await old_hourly_energy(self.session, self.tree, lo, hi)
            self.reads.append((lo, energy_, ref.cost_by_hour(energy_, self.tariffs, self.tree, ZONE)))
        return self

    def card(self, asset_id: int) -> dict:
        win, tree, tariffs = self.win, self.tree, self.tariffs
        (_, _, last_priced), (_, this_energy, this_priced) = self.reads

        def rate_on(day) -> bool:
            return ref.rate_at(tariffs, tree, asset_id, day) is not None

        this_entries = ref.day_entries(this_priced.get(asset_id), win.this_days, now=self.now, rate_on=rate_on)
        this = side_from_entries(this_entries[: win.days])
        last_entries = ref.day_entries(last_priced.get(asset_id), win.last_days, now=self.now, rate_on=rate_on)
        last = side_from_entries(last_entries)
        last_state = "no_readings" if last is None or last.no_data_days >= win.days else "ok"
        partial_owns = {
            owner for start, energy_, _ in self.reads for owner in energy_.own
            if energy_.own_from.get(owner) is not None and energy_.own_from[owner] > start
        }
        meters = contributing_meters(tree, this_energy.own, asset_id, partial_owns)
        rate_date = rate_change(self.live_tariffs, tree, meters, after=win.last_first, up_to=win.this_last)
        return {
            "this": None if this is None else asdict(this), "last": None if last is None else asdict(last),
            "kwh": asdict(change(this, last, "kwh", days=win.days, last_state=last_state)),
            "cost": asdict(change(this, last, "cost", days=win.days, last_state=last_state, same_currency=True)),
            "rate_change": None if rate_date is None else {"date": rate_date.isoformat()},
            "last_state": last_state, "this_side": this, "last_side": last,
            "this_entries": this_entries, "last_entries": last_entries,
        }


def point_of(entry: dict | None, as_cost: bool) -> dict:
    """What a chart point of a comparison says about one day entry (`widgets._entry_point`)."""
    if entry is None or entry["no_data"]:
        return {"value": None, "estimated": False, "partial": False, "no_data": True}
    if not as_cost:
        return {"value": entry["kwh"], "estimated": entry["estimated"], "partial": False, "no_data": False}
    return {"value": entry["cost"], "estimated": entry["estimated"], "partial": entry["partial"], "no_data": False}


def points_of(points: list[dict]) -> list[dict]:
    return [{key: p[key] for key in ("value", "estimated", "partial", "no_data")} for p in points]


async def old_plain_values(session, first: datetime, last: datetime, end: datetime, as_cost: bool) -> dict[int, tuple | None]:
    """The plain branch of `_fill_billing` of a62fce0: one asset at a time, from the oracle's hours."""
    tree, tariffs, result, priced = await old_inputs(session, first, last)
    hours_of = priced if as_cost else result.hours
    last_day = (end - timedelta(microseconds=1)).astimezone(ZoneInfo(ZONE)).date()
    out: dict[int, tuple | None] = {}
    for asset_id in tree.preorder():
        figures = hours_of.get(asset_id)
        hours = {} if figures is None else {hour: fig for hour, fig in figures.items() if first <= hour < last}
        if figures is None:
            out[asset_id] = None
        elif as_cost:
            rated = ref.rate_at(tariffs, tree, asset_id, last_day) is not None
            total = ref.summarize(hours.values(), rate_in_effect=rated)
            cost_total = 0.0 if total.cost is None and rated else total.cost
            out[asset_id] = (cost_total, total.estimated, total.partial, ref.no_data(hours.values()))
        else:
            kwh = sum((h.kwh for h in hours.values()), 0.0)
            out[asset_id] = (kwh, any(h.estimated for h in hours.values()), False, not any(h.has_data for h in hours.values()))
    return out


# ---- the tests -------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("switch", ["1", "0"], ids=["cache on", "cache off"])
async def test_billings_days_and_totals_equal_the_old_way(db, session, monkeypatch, switch):
    await small_world(db)
    monkeypatch.setenv("DCDASH_FIGURE_CACHE", switch)
    checked = 0
    for month in (MONTH, "2026-04"):
        for now in (NOW, LATER):
            monkeypatch.setattr("dcdash.api.billing._now", lambda now=now: now)
            old = await old_billing_assets(session, month, now)
            new = (await billing.month_costs(session, month))["assets"]
            assert [a["asset_id"] for a in new] == [a["asset_id"] for a in old]
            for new_asset, old_asset in zip(new, old):
                assert repr(new_asset["days"]) == repr(old_asset["days"]), (month, now, old_asset["name"])
                assert repr(new_asset["total"]) == repr(old_asset["total"]), (month, now, old_asset["name"])
                assert repr(new_asset) == repr(old_asset), (month, now, old_asset["name"])
                checked += 1
    assert checked == 4 * 7  # seven assets, two months, two clocks
    assert any(a["total"]["kwh"] for a in old) and any(a["total"]["cost"] for a in old)  # not a world of zeros
    if switch == "1":
        assert figure_cache.stats()["computes"] > 0 and figure_cache.stats()["hits"] > 0  # the second clock found the stored months
    else:
        assert figure_cache.stats()["computes"] == 0 == figure_cache.stats()["hits"]  # off: nothing was stored or served


@pytest.mark.parametrize("switch", ["1", "0"], ids=["cache on", "cache off"])
async def test_comparison_cards_equal_the_old_way(db, session, monkeypatch, switch):
    ids = await small_world(db)
    monkeypatch.setenv("DCDASH_FIGURE_CACHE", switch)
    old = await OldCompare(session, NOW).load()
    marks, rate_dates = set(), set()
    for name in ("Pump", "Hall A", "Fan", "Fx", "Site", "Annex"):
        expected = old.card(ids[name])
        for source in ("energy", "cost"):
            as_cost = source == "cost"
            for widget_type in ("stat", "timeseries"):
                card = await compare_card(session, ids[name], source, widget_type)
                got = card["compare"]["assets"][0]
                where = (name, source, widget_type)
                for key in ("this", "last", "kwh", "cost", "rate_change", "last_state"):
                    assert repr(got[key]) == repr(expected[key]), (key, where)
                this, last = expected["this_side"], expected["last_side"]
                if widget_type == "stat":
                    value = card["values"][0]
                    measured = None if this is None else (this.cost if as_cost else this.kwh)
                    assert repr((value["value"], value["estimated"], value["partial"], value["no_data"])) == repr((
                        measured, False if this is None else this.estimated, as_cost and this is not None and this.partial,
                        this is None or this.no_data_days >= old.win.days,
                    )), where
                else:
                    assert repr(points_of(card["series"][0]["points"])) == repr(
                        [point_of(e, as_cost) for e in expected["this_entries"]]
                    ), where
                    assert repr(points_of(got["last_points"])) == repr(
                        [point_of(e, as_cost) for e in expected["last_entries"]]
                    ), where
                marks.add((this.estimated, this.partial) if this is not None else None)
                rate_dates.add(None if got["rate_change"] is None else got["rate_change"]["date"])
    assert len(marks) > 1  # estimated and plain figures were both met
    assert len(rate_dates - {None}) >= 2  # the rate notes differ by asset: a price change early in the windows and one later


@pytest.mark.parametrize("switch", ["1", "0"], ids=["cache on", "cache off"])
@pytest.mark.parametrize("preset", ["this_month", "7d", "30d"])
async def test_plain_cards_equal_the_old_per_asset_arithmetic(db, session, monkeypatch, switch, preset):
    ids = await small_world(db)
    monkeypatch.setenv("DCDASH_FIGURE_CACHE", switch)
    start, end = resolve_range(preset, NOW, ZONE)
    first, last = widgets_module._hour_window(preset, start, end)
    order = [ids[name] for name in ("Site", "Hall A", "Hall B", "Pump", "Fan", "Fx", "Annex")]
    for source in ("energy", "cost"):
        old = await old_plain_values(session, first, last, end, source == "cost")
        table = await widget_data(
            session, "table", validate_config("table", {"assets": order, "source": source, "aggregation": "sum"}), preset, NOW
        )
        assert [v["asset_id"] for v in table["values"]] == order
        for value in table["values"]:
            figure = old[value["asset_id"]]
            expected = (None, False, False, True) if figure is None else figure
            assert repr((value["value"], value["estimated"], value["partial"], value["no_data"])) == repr(expected), (
                preset, source, value["name"],
            )
        for name in ("Pump", "Fx", "Site"):  # a stat is the same figure for one asset
            stat = await widget_data(
                session, "stat", validate_config("stat", {"assets": [ids[name]], "source": source, "aggregation": "sum"}),
                preset, NOW,
            )
            expected = old[ids[name]]
            got = stat["values"][0]
            assert repr((got["value"], got["estimated"], got["partial"], got["no_data"])) == repr(expected), (preset, source, name)
        assert any(f is not None and f[0] for f in old.values())  # not all zeros


# ---- the two row statements ------------------------------------------------------------------------------------------------------


async def test_the_engines_rows_and_the_check_months_rows_have_equal_values_and_the_engines_n_is_an_int(db, session):
    await small_world(db)
    ids = sorted(r["point_id"] for r in await db.fetch("SELECT point_id FROM mappings"))
    counters = sorted(r["point_id"] for r in await db.fetch("SELECT point_id FROM mappings WHERE metric = 'energy_kwh'"))
    start, end = datetime(2026, 3, 10, tzinfo=UTC), datetime(2026, 4, 8, 11, tzinfo=UTC)  # rows, a baseline before them
    columns = ("point_id", "bucket", "min_value", "max_value", "sum_value", "n", "last_value", "minutes")
    mine = list(await session.execute(energy._ROWS, {"ids": ids, "counter_ids": counters, "start": start, "end": end}))
    other = list(await session.execute(billing_check._ROWS, {"ids": ids, "start": start, "end": end}))

    def kind(rows, name):
        return [tuple(getattr(row, c) for c in columns) for row in rows if row.kind == name]

    assert kind(mine, "row") and kind(mine, "row") == kind(other, "row")  # equal values: Decimal == int
    assert kind(mine, "first") == kind(other, "first")
    assert kind(mine, "baseline") == [row for row in kind(other, "before") if row[0] in counters]
    assert len(kind(mine, "baseline")) > 0
    for row in mine:
        assert type(row.n) is int and type(row.minutes) is int, row.kind  # whole numbers, as `int(Decimal)` made them
    for row in other:
        assert isinstance(row.n, numbers.Number) and isinstance(row.minutes, numbers.Number), row.kind  # Decimal here: still pinned by value
    assert any(type(row.n) is not int for row in other)  # the other statement still returns the numeric sum: the pin is by value
