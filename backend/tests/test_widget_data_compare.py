"""w24: a widget that compares the month so far with the same days of last month (core/compare.py, core/widgets.py).

Every figure of the comparison is a sum of the day cells Billing shows for the same days, so most tests read Billing's day cells
through GET /api/billing/costs under the same fake clock and set them against the widget's answer. The clock is fixed in the past
of the real one (March and April 2026), so refreshing the rollups never runs ahead of the wall clock.
"""
import csv
import io
from datetime import datetime, timedelta, timezone

import pytest
from billing_helpers import add_power, add_tariff, at, set_currency, set_zone
from helpers import login_as, make_asset, make_mapping, make_point, make_source, settle_rollups

UTC = timezone.utc
NOW = datetime(2026, 4, 8, 10, 0, tzinfo=UTC)  # 7 complete days of April; March has 31
COMPARE = {"compare": "same_days_last_month", "range": "this_month"}
CSV_HEADER = ["asset", "source", "unit", "timestamp", "value", "estimated", "partial", "no_data"]
NO_PREVIOUS = {"percent": None, "why_none": "no_previous"}


def set_now(monkeypatch, moment: datetime) -> None:
    monkeypatch.setattr("dcdash.api.widget_data._now", lambda: moment)
    monkeypatch.setattr("dcdash.api.billing._now", lambda: moment)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    set_now(monkeypatch, NOW)


READ_HOURS = (6, 18)  # a counter is read at half past these hours: the rollups cost time for every separate reading


def step(index: int) -> float:
    """What a counter rises by between its `index`th reading and the one before: it differs from reading to reading."""
    return 1.0 + (index % 4) * 0.45 + (index // 4) % 7 * 0.3


def readings_on(first_day: datetime, last_day: datetime, until: datetime | None = None) -> list[datetime]:
    """The instants a counter is read, from 00:00 on `first_day` to the end of `last_day` (and not after `until`)."""
    found, day = [], first_day
    while day <= last_day:
        found += [day + timedelta(hours=hour, minutes=30) for hour in READ_HOURS]
        day += timedelta(days=1)
    return [moment for moment in found if until is None or moment <= until]


# 28 Feb to 7 March, one reading at the end of March (the gap before it falls into 31 March, which no test compares),
# 1 to 7 April and the morning of the 8th: the days a test of 8 April sets against each other, and today.
APRIL_READINGS = [
    *readings_on(at(2026, 2, 28), at(2026, 3, 7)), at(2026, 3, 31, 23) + timedelta(minutes=30),
    *readings_on(at(2026, 4, 1), at(2026, 4, 8), until=at(2026, 4, 8, 10)),
]


FIRST_OF_APRIL = [*readings_on(at(2026, 3, 1), at(2026, 3, 2)), at(2026, 4, 1, 6) + timedelta(minutes=30)]


async def add_varied_counter(db, name: str, times: list[datetime], parent_id: int | None = None) -> int:
    """An asset with a kWh counter read at `times` (ascending). The first reading is the baseline: it counts nothing."""
    asset = await make_asset(db, name, parent_id)
    source = await db.fetchval("SELECT id FROM sources LIMIT 1") or await make_source(db)
    point = await make_point(db, source, f"{name}_kWh")
    await make_mapping(db, point, asset, "energy_kwh", 60)
    values, total = [], 1000.0
    for index in range(len(times)):
        total += step(index) if index else 0.0
        values.append(total)
    await db.executemany(
        "INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, 0)",
        [(point, moment, value) for moment, value in zip(times, values)],
    )
    return asset


async def seed_pump(db, *, times=APRIL_READINGS, tariff=True, currency="USD") -> int:
    """Site > Hall > Pump (counter) in UTC, read at `times`. The rate is 0.10 from 1 January."""
    await set_zone(db, "UTC")
    await set_currency(db, currency)
    site = await make_asset(db, "Site")
    hall = await make_asset(db, "Hall", site)
    pump = await add_varied_counter(db, "Pump", times, hall)
    if tariff:
        await add_tariff(db, 0.10, "2026-01-01")
    await settle_rollups(db)
    return pump


def hours_of_day(day: datetime, hours=range(8, 10)) -> list[datetime]:
    return [day.replace(hour=hour) for hour in hours]


async def costs_cells(client, month: str, name: str) -> list[dict | None]:
    """Billing's day cells of one asset for a month."""
    response = await client.get("/api/billing/costs", params={"month": month})
    assert response.status_code == 200, response.text
    return next(asset for asset in response.json()["assets"] if asset["name"] == name)["days"]


def month_to_date(cells: list[dict | None], days: int) -> dict:
    """What days 1..`days` of Billing's cells add up to, worked out here with plain sums (not with the code under test)."""
    shown = [cell for cell in cells[:days] if cell is not None]
    costs = [cell["cost"] for cell in shown if cell["cost"] is not None]
    return {
        "kwh": sum(cell["kwh"] for cell in shown), "cost": sum(costs) if costs else None,
        "estimated": any(cell["estimated"] for cell in shown), "partial": any(cell["partial"] for cell in shown),
        "no_data": all(cell["no_data"] for cell in shown),
        "no_data_days": sum(1 for cell in cells[:days] if cell is None or cell["no_data"]),
    }


def request(widget_type: str, asset: int, source: str = "energy", **extra) -> dict:
    config = {"assets": [asset], "source": source, "aggregation": "sum", **COMPARE, **extra}
    return {"type": widget_type, "config": config, "range": "this_month"}


async def compare_of(client, asset: int, source: str = "energy", widget_type: str = "stat", **extra) -> dict:
    response = await client.post("/api/widget-data", json=request(widget_type, asset, source, **extra))
    assert response.status_code == 200, response.text
    return response.json()


def only(data: dict) -> dict:
    assert len(data["compare"]["assets"]) == 1
    return data["compare"]["assets"][0]


def sides_equal(side: dict, expected: dict) -> None:
    """A Side of the answer against the sums of Billing's cells; every number must be the very same float."""
    assert side["kwh"] == expected["kwh"]
    assert side["cost"] == expected["cost"]
    assert (side["estimated"], side["partial"], side["no_data_days"]) == (
        expected["estimated"], expected["partial"], expected["no_data_days"],
    )


# ---- the equality with Billing -----------------------------------------------------------------------------------

async def test_the_stat_is_the_sum_of_billings_day_cells_for_kwh_and_for_cost(client, db):
    pump = await seed_pump(db)
    await login_as(client, db, "admin")
    this_cells, last_cells = await costs_cells(client, "2026-04", "Pump"), await costs_cells(client, "2026-03", "Pump")
    this, last = month_to_date(this_cells, 7), month_to_date(last_cells, 7)
    assert this_cells[7] is not None and this_cells[7]["kwh"] > 0  # today has begun: it is NOT in the comparison
    assert this["kwh"] != month_to_date(this_cells, 8)["kwh"]
    for source, measure in (("energy", "kwh"), ("cost", "cost")):
        data = await compare_of(client, pump, source)
        assert data["compare"]["state"] == "ok" and (data["compare"]["elapsed_days"], data["compare"]["days"]) == (7, 7)
        assert data["unit"] == ("kWh" if source == "energy" else "USD")
        assert data["compare"]["currency"] == "USD"
        value = data["values"][0]
        assert (value["value"], value["estimated"], value["partial"], value["no_data"]) == (this[measure], False, False, False)
        asset = only(data)
        sides_equal(asset["this"], this)
        sides_equal(asset["last"], last)
        assert asset["last_state"] == "ok"
        for key in ("kwh", "cost"):
            change = asset[key]
            assert change["why_none"] is None
            assert change["abs"] == this[key] - last[key]
            assert change["percent"] == pytest.approx((this[key] - last[key]) / last[key] * 100)
        assert data["range"] == {
            "preset": "this_month", "start": "2026-04-01T00:00:00+00:00", "end": "2026-04-08T00:00:00+00:00",
        }
        assert data["bucket"] is None and data["series"] == [] and data["missing"] == []


async def test_the_windows_are_named_by_their_dates(client, db):
    pump = await seed_pump(db)
    await login_as(client, db, "admin")
    block = (await compare_of(client, pump))["compare"]
    assert block["mode"] == "same_days_last_month"
    assert block["this_window"] == {"from": "2026-04-01", "to": "2026-04-07"}
    assert block["last_window"] == {"from": "2026-03-01", "to": "2026-03-07"}
    assert block["left_out_days"] == [] and block["last_month"] == {"month": "2026-03", "closed": False}


async def test_the_chart_has_this_months_days_and_last_months_days_from_the_same_cells(client, db):
    pump = await seed_pump(db)
    await login_as(client, db, "admin")
    this_cells, last_cells = await costs_cells(client, "2026-04", "Pump"), await costs_cells(client, "2026-03", "Pump")
    for source, measure in (("energy", "kwh"), ("cost", "cost")):
        data = await compare_of(client, pump, source, "timeseries")
        assert (data["mode"], data["bucket"], data["values"]) == ("series", "day", [])
        assert data["range"]["start"] == "2026-04-01T00:00:00+00:00" and data["range"]["end"] == "2026-04-08T00:00:00+00:00"
        points = data["series"][0]["points"]
        assert [p["ts"] for p in points] == [f"2026-04-0{day}T00:00:00+00:00" for day in range(1, 8)]
        assert [p["value"] for p in points] == [cell[measure] for cell in this_cells[:7]]
        assert not any(p["no_data"] or p["estimated"] or p["partial"] for p in points)
        last_points = only(data)["last_points"]
        assert [p["ts"] for p in last_points] == [f"2026-03-0{day}T00:00:00+00:00" for day in range(1, 8)]
        assert [p["value"] for p in last_points] == [cell[measure] for cell in last_cells[:7]]
        assert set(last_points[0]) == {"ts", "value", "min", "max", "estimated", "partial", "no_data"}
    stat = await compare_of(client, pump)
    assert only(stat)["last_points"] == []  # only a chart carries them


# ---- the first days of a month -------------------------------------------------------------------------------------

@pytest.mark.parametrize("widget_type", ["stat", "timeseries"])
@pytest.mark.parametrize("source", ["energy", "cost"])
async def test_on_the_1st_there_is_nothing_to_compare_yet(client, db, monkeypatch, widget_type, source):
    set_now(monkeypatch, datetime(2026, 4, 1, 9, 0, tzinfo=UTC))
    pump = await seed_pump(db, times=FIRST_OF_APRIL)
    await login_as(client, db, "admin")
    data = await compare_of(client, pump, source, widget_type)
    block = data["compare"]
    assert (block["state"], block["elapsed_days"], block["days"]) == ("nothing_yet", 0, 0)
    assert block["this_window"] is None and block["last_window"] is None and block["left_out_days"] == []
    asset = only(data)
    assert (asset["this"], asset["last"], asset["last_state"], asset["rate_change"], asset["last_points"]) == (
        None, None, "no_readings", None, [],
    )
    for key in ("kwh", "cost"):
        assert (asset[key]["percent"], asset[key]["why_none"]) == (None, "no_previous")
    assert data["range"]["start"] == data["range"]["end"] == "2026-04-01T00:00:00+00:00"  # an empty span at the month start
    if widget_type == "stat":
        assert [(v["value"], v["no_data"]) for v in data["values"]] == [(None, True)]
    else:
        assert data["series"][0]["points"] == [] and data["bucket"] == "day"


async def test_on_the_2nd_one_day_is_compared(client, db, monkeypatch):
    set_now(monkeypatch, datetime(2026, 4, 2, 0, 0, tzinfo=UTC))  # the first instant of the 2nd
    pump = await seed_pump(db, times=[*readings_on(at(2026, 3, 1), at(2026, 3, 2)), *readings_on(at(2026, 4, 1), at(2026, 4, 1))])
    await login_as(client, db, "admin")
    data = await compare_of(client, pump)
    assert (data["compare"]["elapsed_days"], data["compare"]["days"]) == (1, 1)
    assert data["compare"]["this_window"] == {"from": "2026-04-01", "to": "2026-04-01"}
    assert data["compare"]["last_window"] == {"from": "2026-03-01", "to": "2026-03-01"}
    this, last = month_to_date(await costs_cells(client, "2026-04", "Pump"), 1), month_to_date(
        await costs_cells(client, "2026-03", "Pump"), 1)
    assert data["values"][0]["value"] == this["kwh"]
    sides_equal(only(data)["this"], this)
    sides_equal(only(data)["last"], last)
    assert only(data)["kwh"]["why_none"] is None


async def test_the_31st_against_a_short_month_leaves_the_extra_days_out(client, db, monkeypatch):
    set_now(monkeypatch, datetime(2026, 3, 31, 12, 0, tzinfo=UTC))  # 30 days elapsed; February has 28
    pump = await seed_pump(db, times=[*readings_on(at(2026, 1, 31), at(2026, 3, 30)), at(2026, 3, 31, 6) + timedelta(minutes=30)])
    await login_as(client, db, "admin")
    data = await compare_of(client, pump, widget_type="timeseries")
    block = data["compare"]
    assert (block["elapsed_days"], block["days"]) == (30, 28)
    assert block["this_window"] == {"from": "2026-03-01", "to": "2026-03-28"}
    assert block["last_window"] == {"from": "2026-02-01", "to": "2026-02-28"}
    assert block["left_out_days"] == ["2026-03-29", "2026-03-30"] and block["last_month"]["month"] == "2026-02"
    assert len(data["series"][0]["points"]) == 30 and len(only(data)["last_points"]) == 28  # the chart draws every elapsed day
    assert data["range"]["end"] == "2026-03-31T00:00:00+00:00"
    this_cells, last_cells = await costs_cells(client, "2026-03", "Pump"), await costs_cells(client, "2026-02", "Pump")
    asset = only(data)
    sides_equal(asset["this"], month_to_date(this_cells, 28))  # days 1 to 28, not 30
    sides_equal(asset["last"], month_to_date(last_cells, 28))
    assert asset["this"]["kwh"] != month_to_date(this_cells, 30)["kwh"]
    stat = await compare_of(client, pump)
    assert stat["values"][0]["value"] == month_to_date(this_cells, 28)["kwh"]
    assert stat["range"]["end"] == "2026-03-29T00:00:00+00:00"  # the stat's figures end with day D


# ---- estimates, missing days, no tariff ---------------------------------------------------------------------------

def power_days(first: int, last: int, month: int, skip=()) -> list[datetime]:
    return [hour for day in range(first, last + 1) if day not in skip for hour in hours_of_day(at(2026, month, day))]


async def test_a_power_meter_silent_this_month_is_billings_estimated_zero(client, db):
    # Readings in March only. A read that began in March would give April no placeholder hours for the meter, and lose the
    # estimated mark Billing shows for them, so this month is read as a whole month, exactly as Billing reads it.
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    quiet = await add_power(db, "Quiet", power_days(1, 7, 3))
    await add_tariff(db, 0.10, "2026-01-01")
    await settle_rollups(db)
    await login_as(client, db, "admin")
    this = month_to_date(await costs_cells(client, "2026-04", "Quiet"), 7)
    last = month_to_date(await costs_cells(client, "2026-03", "Quiet"), 7)
    assert this["estimated"] and this["no_data"] and this["no_data_days"] == 7  # Billing's own cells
    for source, measure in (("energy", "kwh"), ("cost", "cost")):
        data = await compare_of(client, quiet, source)
        value = data["values"][0]
        assert (value["value"], value["estimated"], value["partial"], value["no_data"]) == (
            this[measure], this["estimated"], this["partial"], this["no_data"],
        )
        asset = only(data)
        sides_equal(asset["this"], this)
        sides_equal(asset["last"], last)
        assert asset["last"]["estimated"] is True and asset["last"]["kwh"] == 7 * 2 * 6.0
        assert asset["kwh"]["why_none"] == "no_current" and asset["kwh"]["percent"] is None
        assert asset["cost"]["why_none"] == "no_current"


async def test_a_power_meter_that_started_this_month_is_compared_with_billing_too(client, db):
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    late = await add_power(db, "Late", power_days(3, 7, 4))  # no reading in March at all
    await add_tariff(db, 0.10, "2026-01-01")
    await settle_rollups(db)
    await login_as(client, db, "admin")
    this = month_to_date(await costs_cells(client, "2026-04", "Late"), 7)
    last = month_to_date(await costs_cells(client, "2026-03", "Late"), 7)
    data = await compare_of(client, late)
    asset = only(data)
    sides_equal(asset["this"], this)
    assert asset["this"]["no_data_days"] == 2 and asset["this"]["estimated"] is True
    sides_equal(asset["last"], last)  # no reading in March: Billing's cells say so, and so does the Side
    assert asset["last_state"] == "no_readings" and asset["kwh"]["why_none"] == "no_previous"
    assert asset["cost"]["why_none"] == "no_previous" and asset["kwh"]["percent"] is None


async def test_days_without_readings_withhold_the_percentage_but_keep_the_difference(client, db):
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    gappy = await add_power(db, "Gappy", power_days(1, 7, 3, skip=(4, 5)) + power_days(1, 7, 4))
    await add_tariff(db, 0.10, "2026-01-01")
    await settle_rollups(db)
    await login_as(client, db, "admin")
    this = month_to_date(await costs_cells(client, "2026-04", "Gappy"), 7)
    last = month_to_date(await costs_cells(client, "2026-03", "Gappy"), 7)
    assert last["no_data_days"] == 2 and this["no_data_days"] == 0
    asset = only(await compare_of(client, gappy))
    sides_equal(asset["this"], this)
    sides_equal(asset["last"], last)
    for key in ("kwh", "cost"):
        assert asset[key]["why_none"] == "missing_days" and asset[key]["percent"] is None
        assert asset[key]["abs"] == this[key] - last[key]  # the difference stays: it is the readings that are missing
    assert asset["last_state"] == "ok"


async def test_an_estimated_power_meter_keeps_its_percentage_and_its_mark_on_both_sides(client, db):
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    steady = await add_power(
        db, "Steady", [h for day in range(1, 8) for h in hours_of_day(at(2026, 3, day))]
        + [h for day in range(1, 8) for h in hours_of_day(at(2026, 4, day), range(8, 11))],
    )
    await add_tariff(db, 0.10, "2026-01-01")
    await settle_rollups(db)
    await login_as(client, db, "admin")
    data = await compare_of(client, steady, "cost")
    asset = only(data)
    assert asset["this"]["estimated"] is True and asset["last"]["estimated"] is True
    assert data["values"][0]["estimated"] is True
    assert asset["this"]["kwh"] == 7 * 3 * 6.0 and asset["last"]["kwh"] == 7 * 2 * 6.0
    assert asset["kwh"]["why_none"] is None and asset["kwh"]["percent"] == pytest.approx(50.0)
    assert asset["cost"]["why_none"] is None and asset["cost"]["percent"] == pytest.approx(50.0)
    this_points = (await compare_of(client, steady, "energy", "timeseries"))["series"][0]["points"]
    assert all(point["estimated"] for point in this_points)


async def test_a_cost_comparison_on_a_site_without_a_tariff_has_no_cost_and_no_error(client, db):
    pump = await seed_pump(db, tariff=False, currency=None)
    await login_as(client, db, "admin")
    data = await compare_of(client, pump, "cost")
    assert data["unit"] is None and data["compare"]["currency"] is None
    value = data["values"][0]
    assert (value["value"], value["no_data"], value["partial"]) == (None, False, True)  # consumed, but no rate: a dash, understated
    asset = only(data)
    assert asset["this"]["cost"] is None and asset["last"]["cost"] is None and asset["this"]["kwh"] > 0
    assert (asset["cost"]["percent"], asset["cost"]["why_none"]) == (None, "no_cost")
    assert asset["kwh"]["why_none"] is None and asset["kwh"]["percent"] is not None
    points = (await compare_of(client, pump, "cost", "timeseries"))["series"][0]["points"]
    assert all(p["value"] is None and not p["no_data"] for p in points)  # the dash of a cost with no rate, not a gap


async def test_an_asset_without_any_energy_has_no_figure_on_either_side(client, db):
    await seed_pump(db)
    bare = await make_asset(db, "Bare")
    await login_as(client, db, "admin")
    data = await compare_of(client, bare)
    asset = only(data)
    assert (asset["this"], asset["last"], asset["last_state"]) == (None, None, "no_readings")
    assert [(v["value"], v["no_data"]) for v in data["values"]] == [(None, True)]
    chart = await compare_of(client, bare, widget_type="timeseries")
    assert len(chart["series"][0]["points"]) == 7 and all(p["no_data"] for p in chart["series"][0]["points"])
    assert only(chart)["last_points"] == [] or all(p["no_data"] for p in only(chart)["last_points"])


async def test_a_deleted_asset_is_missing_and_the_block_has_no_asset(client, db):
    await seed_pump(db)
    await login_as(client, db, "admin")
    for widget_type in ("stat", "timeseries"):
        data = await compare_of(client, 999999, widget_type=widget_type)
        assert data["missing"] == [999999] and data["values"] == [] and data["series"] == []
        assert data["compare"]["state"] == "ok" and data["compare"]["assets"] == []
        assert data["compare"]["days"] == 7 and data["breakdown"] is None


async def test_widgets_without_a_comparison_carry_null_compare_and_breakdown(client, db):
    pump = await seed_pump(db)
    await login_as(client, db, "admin")
    plain = {"type": "stat", "config": {"assets": [pump], "source": "energy", "aggregation": "sum"}, "range": "this_month"}
    data = (await client.post("/api/widget-data", json=plain)).json()
    assert data["compare"] is None and data["breakdown"] is None


# ---- rates ---------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize(
    "rows,expected",
    [
        ([], None),
        ([(0.20, "2026-04-05")], "2026-04-05"),  # a new rate inside this month's window
        ([(0.20, "2026-03-10")], "2026-03-10"),  # inside last month's window
        ([(0.20, "2026-03-31")], "2026-03-31"),  # between the two windows
        ([(0.10, "2026-04-05")], None),  # the same rate again is no change
        ([(0.20, "2026-04-08")], None),  # today is not in the window
        ([(0.20, "2026-03-01")], None),  # the first day of last month's window is not after it
    ],
)
async def test_a_rate_change_between_the_windows_is_named_and_the_cost_change_keeps_its_numbers(client, db, rows, expected):
    pump = await seed_pump(db)
    for rate, effective_from in rows:
        await add_tariff(db, rate, effective_from)
    await settle_rollups(db)
    await login_as(client, db, "admin")
    data = await compare_of(client, pump, "cost")
    asset = only(data)
    assert asset["rate_change"] == (None if expected is None else {"date": expected})
    this = month_to_date(await costs_cells(client, "2026-04", "Pump"), 7)
    last = month_to_date(await costs_cells(client, "2026-03", "Pump"), 7)
    assert data["values"][0]["value"] == this["cost"]  # each day is priced at its own day's rate, as Billing prices it
    assert asset["last"]["cost"] == last["cost"]
    assert asset["cost"]["why_none"] is None and asset["cost"]["abs"] == this["cost"] - last["cost"]
    assert asset["cost"]["percent"] is not None and asset["kwh"]["why_none"] is None


async def test_a_rate_that_starts_mid_month_leaves_the_kwh_change_alone(client, db):
    pump = await seed_pump(db)
    await add_tariff(db, 0.20, "2026-04-05")
    await settle_rollups(db)
    await login_as(client, db, "admin")
    asset = only(await compare_of(client, pump, "energy"))
    this_cells, last_cells = await costs_cells(client, "2026-04", "Pump"), await costs_cells(client, "2026-03", "Pump")
    assert asset["rate_change"] == {"date": "2026-04-05"}
    assert asset["kwh"]["abs"] == month_to_date(this_cells, 7)["kwh"] - month_to_date(last_cells, 7)["kwh"]


# ---- a closed last month -------------------------------------------------------------------------------------------

async def close_march(client) -> None:
    response = await client.post("/api/billing/months/2026-03/close", json={})
    assert response.status_code == 201, response.text


async def reopen_march(client) -> None:
    response = await client.post("/api/billing/months/2026-03/reopen", json={"note": "late readings were corrected"})
    assert response.status_code == 200, response.text


async def test_a_closed_last_month_is_read_from_its_snapshot_and_does_not_move(client, db):
    pump = await seed_pump(db)
    await login_as(client, db, "admin")
    before = await compare_of(client, pump, "cost")
    assert before["compare"]["last_month"] == {"month": "2026-03", "closed": False}
    await close_march(client)
    frozen = month_to_date(await costs_cells(client, "2026-03", "Pump"), 7)  # the closed figures, as Billing shows them
    assert frozen["cost"] == only(before)["last"]["cost"]  # live and frozen agreed when it was closed
    # After the close: a rate changes for the whole period and the pump moves to another place in the tree.
    await db.execute("UPDATE tariffs SET rate_per_kwh = 0.50")
    elsewhere = await make_asset(db, "Elsewhere")
    await db.execute("UPDATE assets SET parent_id = $1 WHERE id = $2", elsewhere, pump)
    live = month_to_date(await costs_cells(client, "2026-04", "Pump"), 7)
    for source in ("energy", "cost"):
        data = await compare_of(client, pump, source)
        assert data["compare"]["last_month"] == {"month": "2026-03", "closed": True}
        asset = only(data)
        sides_equal(asset["last"], frozen)  # not what 0.50 would give
        assert asset["last"]["cost"] == only(before)["last"]["cost"] and asset["last_state"] == "ok"
        sides_equal(asset["this"], live)  # this month is live: the new rate applies to it
    assert live["cost"] != only(before)["this"]["cost"]
    chart = only(await compare_of(client, pump, "cost", "timeseries"))
    frozen_cells = await costs_cells(client, "2026-03", "Pump")
    assert [p["value"] for p in chart["last_points"]] == [cell["cost"] for cell in frozen_cells[:7]]


async def test_an_asset_that_is_not_in_the_closed_figures_gets_no_comparison(client, db):
    await seed_pump(db)
    await login_as(client, db, "admin")
    await close_march(client)
    late = await add_varied_counter(db, "Late", APRIL_READINGS)  # created after the close
    await settle_rollups(db)
    for widget_type in ("stat", "timeseries"):
        data = await compare_of(client, late, widget_type=widget_type)
        asset = only(data)
        assert data["compare"]["last_month"]["closed"] is True
        assert (asset["last_state"], asset["last"], asset["last_points"]) == ("not_in_closed", None, [])
        assert asset["this"]["kwh"] > 0  # this month still has its figure
        assert asset["kwh"]["why_none"] == "no_previous" and asset["cost"]["why_none"] == "no_previous"
    stat = await compare_of(client, late)
    assert stat["values"][0]["value"] == only(stat)["this"]["kwh"]


async def test_a_closed_month_in_another_currency_gives_no_cost_comparison(client, db):
    pump = await seed_pump(db)
    await login_as(client, db, "admin")
    await close_march(client)
    frozen = month_to_date(await costs_cells(client, "2026-03", "Pump"), 7)
    await set_currency(db, "EUR")
    data = await compare_of(client, pump, "cost")
    asset = only(data)
    assert data["compare"]["currency"] == "EUR" and data["unit"] == "EUR"
    assert asset["last"]["cost"] is None and asset["last"]["kwh"] == frozen["kwh"]  # its energy is still its energy
    assert (asset["cost"]["percent"], asset["cost"]["why_none"]) == (None, "currency")
    assert asset["kwh"]["why_none"] is None and asset["kwh"]["percent"] is not None
    assert asset["last_state"] == "ok"
    chart = only(await compare_of(client, pump, "cost", "timeseries"))
    assert all(p["value"] is None and not p["no_data"] for p in chart["last_points"])  # no cost to draw, and no gap either
    rows = await csv_rows(client, request("stat", pump, "cost"))
    assert rows[-1][4] == ""  # the last window's cost is not written in another currency


async def test_a_closed_month_made_in_another_time_zone_gives_no_comparison(client, db):
    pump = await seed_pump(db)
    await login_as(client, db, "admin")
    await close_march(client)
    await set_zone(db, "Asia/Qatar")  # 13:00 on the 8th there: still 7 complete days
    data = await compare_of(client, pump)
    asset = only(data)
    assert (asset["last_state"], asset["last"]) == ("other_zone", None)
    assert asset["kwh"]["why_none"] == "no_previous" and asset["this"] is not None
    assert data["compare"]["last_month"]["closed"] is True


async def test_a_reopened_month_is_live_again(client, db):
    pump = await seed_pump(db)
    await login_as(client, db, "admin")
    await close_march(client)
    await db.execute("UPDATE tariffs SET rate_per_kwh = 0.50")
    frozen_cost = only(await compare_of(client, pump, "cost"))["last"]["cost"]
    await reopen_march(client)
    data = await compare_of(client, pump, "cost")
    assert data["compare"]["last_month"] == {"month": "2026-03", "closed": False}
    live = month_to_date(await costs_cells(client, "2026-03", "Pump"), 7)
    assert only(data)["last"]["cost"] == live["cost"] and live["cost"] != frozen_cost


# ---- the answers that refuse ---------------------------------------------------------------------------------------

@pytest.mark.parametrize(
    "widget_type,overrides,start",
    [
        ("gauge", {"source": "metric", "metric": "active_power_kw", "aggregation": "last", "max": 100.0}, "compare:"),
        ("table", {}, "compare:"),
        ("bar", {}, "compare:"),
        ("stat", {"source": "metric", "metric": "active_power_kw", "aggregation": "avg"}, "compare:"),
        ("stat", {"assets": [1, 2]}, "assets:"),
        ("timeseries", {"assets": [1, 2]}, "assets:"),
        ("stat", {"range": "7d"}, "range:"),
        ("stat", {"range": None}, "range:"),
    ],
)
async def test_a_comparison_that_breaks_a_rule_is_422(client, db, widget_type, overrides, start):
    await seed_pump(db)
    await login_as(client, db, "admin")
    config = {"assets": [1], "source": "energy", "aggregation": "sum", **COMPARE, **overrides}
    for path in ("/api/widget-data", "/api/widget-data/csv"):
        response = await client.post(path, json={"type": widget_type, "config": config, "range": "this_month"})
        assert response.status_code == 422, response.text
        assert response.json()["detail"].startswith(start)


@pytest.mark.parametrize("preset", ["7d", "today", "last_month", "24h"])
async def test_the_request_range_of_a_comparison_must_be_this_month(client, db, preset):
    pump = await seed_pump(db)
    await login_as(client, db, "admin")
    body = request("stat", pump)
    body["range"] = preset
    for path in ("/api/widget-data", "/api/widget-data/csv"):
        response = await client.post(path, json=body)
        assert response.status_code == 422, response.text
        assert response.json()["detail"] == "range: a comparison needs the range this month"


# ---- the CSV ---------------------------------------------------------------------------------------------------------

async def csv_rows(client, body: dict) -> list[list[str]]:
    response = await client.post("/api/widget-data/csv", json=body)
    assert response.status_code == 200, response.text
    return list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))


async def test_the_csv_of_a_compare_stat_has_one_row_for_each_window(client, db):
    pump = await seed_pump(db)
    await login_as(client, db, "admin")
    this = month_to_date(await costs_cells(client, "2026-04", "Pump"), 7)
    last = month_to_date(await costs_cells(client, "2026-03", "Pump"), 7)
    rows = await csv_rows(client, request("stat", pump))
    assert rows[0] == CSV_HEADER and len(rows) == 3
    path = "Site / Hall / Pump"
    assert [row[:4] + row[5:] for row in rows[1:]] == [  # the CSV writer rounds a number a little: the value is set apart
        [path, "energy", "kWh", "2026-04-01T00:00:00+00:00", "false", "false", "false"],
        [path, "energy", "kWh", "2026-03-01T00:00:00+00:00", "false", "false", "false"],
    ]
    assert float(rows[1][4]) == pytest.approx(this["kwh"]) and float(rows[2][4]) == pytest.approx(last["kwh"])
    cost_rows = await csv_rows(client, request("stat", pump, "cost"))
    assert [row[3] for row in cost_rows[1:]] == ["2026-04-01T00:00:00+00:00", "2026-03-01T00:00:00+00:00"]
    assert [row[2] for row in cost_rows[1:]] == ["USD", "USD"]
    assert float(cost_rows[2][4]) == pytest.approx(last["cost"])


async def test_the_csv_of_a_compare_time_series_adds_last_months_days_after_this_months(client, db):
    pump = await seed_pump(db)
    await login_as(client, db, "admin")
    this_cells, last_cells = await costs_cells(client, "2026-04", "Pump"), await costs_cells(client, "2026-03", "Pump")
    rows = await csv_rows(client, request("timeseries", pump))
    assert rows[0] == CSV_HEADER and len(rows) == 1 + 7 + 7
    assert [row[3] for row in rows[1:8]] == [f"2026-04-0{day}T00:00:00+00:00" for day in range(1, 8)]
    assert [row[3] for row in rows[8:]] == [f"2026-03-0{day}T00:00:00+00:00" for day in range(1, 8)]
    assert [float(row[4]) for row in rows[1:8]] == pytest.approx([cell["kwh"] for cell in this_cells[:7]])  # the writer rounds
    assert [float(row[4]) for row in rows[8:]] == pytest.approx([cell["kwh"] for cell in last_cells[:7]])


async def test_the_csv_of_a_compare_marks_travel_with_the_rows(client, db):
    await set_zone(db, "UTC")
    await set_currency(db, "USD")
    steady = await add_power(db, "Steady", [h for m in (3, 4) for day in range(1, 8) for h in hours_of_day(at(2026, m, day))])
    await add_tariff(db, 0.10, "2026-01-01")
    await settle_rollups(db)
    await login_as(client, db, "admin")
    for widget_type, count in (("stat", 2), ("timeseries", 14)):
        rows = (await csv_rows(client, request(widget_type, steady)))[1:]
        assert len(rows) == count and all(row[5] == "true" for row in rows)  # estimated on every row, last window included


async def test_the_csv_on_the_1st_has_the_single_empty_row(client, db, monkeypatch):
    set_now(monkeypatch, datetime(2026, 4, 1, 9, 0, tzinfo=UTC))
    pump = await seed_pump(db, times=FIRST_OF_APRIL)
    await login_as(client, db, "admin")
    rows = await csv_rows(client, request("stat", pump))
    assert rows[1:] == [["Site / Hall / Pump", "energy", "kWh", "2026-04-01T00:00:00+00:00", "", "false", "false", "true"]]
    assert len(await csv_rows(client, request("timeseries", pump))) == 1  # the header only
