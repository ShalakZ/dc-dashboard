import csv
import io
from datetime import datetime, timedelta, timezone

import pytest

from billing_helpers import add_counter, add_power, add_tariff, at, set_currency, set_zone
from helpers import insert_readings, login_as, make_asset, make_mapping, make_point, settle_rollups

NOW = datetime(2026, 4, 15, 10, 20, tzinfo=timezone.utc)
URLS = ("/api/billing/costs", "/api/billing/costs.csv")


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("dcdash.api.billing._now", lambda: NOW)


async def get_costs(client, month: str = "2026-03") -> dict:
    response = await client.get("/api/billing/costs", params={"month": month})
    assert response.status_code == 200, response.text
    return response.json()


async def get_csv(client, month: str = "2026-03") -> list[list[str]]:
    response = await client.get("/api/billing/costs.csv", params={"month": month})
    assert response.status_code == 200, response.text
    assert response.content.startswith(b"\xef\xbb\xbf")
    return list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))


def by_name(body: dict) -> dict[str, dict]:
    return {asset["name"]: asset for asset in body["assets"]}


def check(entry, kwh, cost, estimated=False, partial=False):
    """One day or month figure. A missing cost must be None, never 0; 0.0 is a real cost."""
    assert entry is not None
    assert entry["kwh"] == pytest.approx(kwh)
    if cost is None:
        assert entry["cost"] is None
    else:
        assert entry["cost"] == pytest.approx(cost)
    assert (entry["estimated"], entry["partial"]) == (estimated, partial)


async def test_anonymous_is_refused_and_a_viewer_can_read(client, db):
    for url in URLS:
        assert (await client.get(url, params={"month": "2026-03"})).status_code == 401
    await login_as(client, db, "viewer")
    for url in URLS:
        assert (await client.get(url, params={"month": "2026-03"})).status_code == 200


@pytest.mark.parametrize(
    "month", ["2026-13", "2026-00", "26-03", "2026-3", "2026-03-01", "march", "2026-03 ", "2026/03"]
)
async def test_a_bad_month_is_422(client, db, month):
    await login_as(client, db, "viewer")
    for url in URLS:
        assert (await client.get(url, params={"month": month})).status_code == 422, (url, month)


@pytest.mark.parametrize("month", ["1969-12", "2101-01"])
async def test_a_year_outside_1970_to_2100_passes_the_pattern_but_is_422_from_month_bounds(client, db, month):
    await login_as(client, db, "viewer")
    for url in URLS:
        response = await client.get(url, params={"month": month})
        # The route pattern lets these through, so this detail (not a validation-error list) proves month_bounds ran.
        assert response.status_code == 422 and response.json()["detail"] == "month must look like 2026-10", (url, month)


async def test_a_stored_zone_without_whole_hour_offsets_is_409(client, db):
    await set_zone(db, "Asia/Kolkata")
    await login_as(client, db, "viewer")
    for url in URLS:
        response = await client.get(url, params={"month": "2026-03"})
        assert response.status_code == 409 and "Asia/Kolkata" in response.json()["detail"]


async def test_an_empty_site_has_the_days_and_no_assets(client, db):
    await login_as(client, db, "viewer")
    body = await get_costs(client)
    assert body["month"] == "2026-03" and body["timezone"] == "UTC" and body["currency"] is None
    assert len(body["days"]) == 31 and body["days"][0] == "2026-03-01" and body["assets"] == []


async def test_the_default_month_is_the_current_month_in_the_site_zone(client, db, monkeypatch):
    await set_zone(db, "Asia/Qatar")
    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 4, 30, 22, 0, tzinfo=timezone.utc))
    await login_as(client, db, "viewer")
    assert (await client.get("/api/billing/costs")).json()["month"] == "2026-05"  # 01:00 on 1 May in Qatar
    csv_response = await client.get("/api/billing/costs.csv")
    assert csv_response.headers["content-disposition"] == 'attachment; filename="billing-2026-05.csv"'


async def test_the_current_month_stops_at_today_and_shows_todays_rate(client, db, monkeypatch):
    await add_power(db, "Panel", [at(2026, 4, 14, 10), at(2026, 4, 15, 9)], kw=10.0)
    await add_tariff(db, 0.10, "2026-04-01")
    await add_tariff(db, 0.30, "2026-04-20")  # still in the future on the 15th
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    panel = by_name(await get_costs(client, "2026-04"))["Panel"]  # NOW is 15 April 10:20 UTC
    assert len(panel["days"]) == 30
    check(panel["days"][13], 10.0, 1.0, estimated=True)  # 14 April
    check(panel["days"][14], 10.0, 1.0, estimated=True)  # today
    assert panel["days"][15:] == [None] * 15  # local days after today
    check(panel["total"], 20.0, 2.0, estimated=True)
    assert panel["rate_per_kwh"] == 0.10  # the rate in effect today, not on the 30th

    monkeypatch.setattr("dcdash.api.billing._now", lambda: datetime(2026, 5, 2, 8, 0, tzinfo=timezone.utc))
    finished = by_name(await get_costs(client, "2026-04"))["Panel"]
    assert all(entry is not None for entry in finished["days"])
    assert finished["rate_per_kwh"] == 0.30  # the rate in effect on the last day of a finished month


async def test_a_month_in_the_future_has_no_figures(client, db):
    await add_power(db, "Panel", [at(2026, 4, 14, 10)])
    await settle_rollups(db)
    await login_as(client, db, "viewer")
    panel = by_name(await get_costs(client, "2026-06"))["Panel"]
    assert panel["days"] == [None] * 30 and panel["total"] is None


async def test_a_25_hour_day_is_attributed_to_its_own_date_and_days_add_up_to_the_month(client, db):  # Review Focus 2
    await set_zone(db, "Europe/Berlin")
    # +1 kWh in every UTC hour from 24 Oct 22:00Z to 27 Oct 22:00Z; the 21:00Z reading is only the baseline.
    # 26 Oct 2025 runs from 25 Oct 22:00Z to 26 Oct 23:00Z: 25 hours.
    await add_counter(db, "Panel", at(2025, 10, 24, 21), 74)
    await add_tariff(db, 0.10, "2025-01-01")
    await add_tariff(db, 0.20, "2025-10-26")  # the new rate starts on the 25-hour day itself
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    body = await get_costs(client, "2025-10")
    panel = by_name(body)["Panel"]
    assert body["timezone"] == "Europe/Berlin"
    assert len(body["days"]) == 31 and body["days"][0] == "2025-10-01" and body["days"][-1] == "2025-10-31"
    assert len(panel["days"]) == 31
    check(panel["days"][24], 24.0, 2.4)  # 25 Oct, old rate
    check(panel["days"][25], 25.0, 5.0)  # 26 Oct: all 25 hours at the new rate
    check(panel["days"][26], 24.0, 4.8)  # 27 Oct
    check(panel["total"], 73.0, 12.2)
    assert sum(day["kwh"] for day in panel["days"]) == pytest.approx(panel["total"]["kwh"])
    assert panel["rate_per_kwh"] == 0.20


async def test_a_23_hour_day_loses_no_hour(client, db):  # Review Focus 2
    await set_zone(db, "Europe/Berlin")
    # 29 Mar 2026 runs from 28 Mar 23:00Z to 29 Mar 22:00Z: 23 hours. Readings from 28 Mar 22:00Z (baseline).
    await add_counter(db, "Panel", at(2026, 3, 28, 22), 48)
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    body = await get_costs(client, "2026-03")
    panel = by_name(body)["Panel"]
    assert len(body["days"]) == 31 and len(panel["days"]) == 31
    assert [day["kwh"] for day in panel["days"][27:30]] == pytest.approx([0.0, 23.0, 24.0])  # 28, 29, 30 Mar
    check(panel["total"], 47.0, None, partial=True)
    assert sum(day["kwh"] for day in panel["days"]) == pytest.approx(panel["total"]["kwh"])


async def test_the_hour_across_a_month_edge_is_counted_once(client, db):  # Review Focus 2
    await set_zone(db, "Europe/Berlin")
    # 1 Nov 00:00 Berlin (CET) is 31 Oct 23:00Z. Buckets 20:00Z..03:00Z; that hour and the four after it are November's.
    await add_counter(db, "Panel", at(2025, 10, 31, 20), 8)
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    october = by_name(await get_costs(client, "2025-10"))["Panel"]
    november = by_name(await get_costs(client, "2025-11"))["Panel"]
    check(october["total"], 2.0, None, partial=True)  # the 21:00Z and 22:00Z hours; 20:00Z is the baseline
    check(november["days"][0], 5.0, None, partial=True)  # 23:00Z, 00:00Z .. 03:00Z
    assert october["total"]["kwh"] + november["total"]["kwh"] == pytest.approx(7.0)


async def build_hierarchy(db, default_rate: float | None) -> None:
    """Site > MV2 > (LV Panel 1: kWh counter, 6 kWh; LV Panel 2: kW only, 18 kWh estimated) on 10 March, Qatar."""
    await set_zone(db, "Asia/Qatar")
    site = await make_asset(db, "Site")
    mv2 = await make_asset(db, "MV2", site)
    await add_counter(db, "LV Panel 1", at(2026, 3, 10, 6), 4, per_hour=2.0, parent_id=mv2)
    panel2 = await add_power(
        db, "LV Panel 2", [at(2026, 3, 10, 7), at(2026, 3, 10, 8), at(2026, 3, 10, 9)], parent_id=mv2
    )
    if default_rate is not None:
        await add_tariff(db, default_rate, "2026-01-01")
    await add_tariff(db, 0.50, "2026-03-10", asset_id=panel2)
    await settle_rollups(db)


async def test_a_parent_without_a_meter_sums_its_children_including_a_child_override(client, db):  # Review Focus 3
    await build_hierarchy(db, default_rate=0.10)
    await login_as(client, db, "viewer")
    body = await get_costs(client)
    assert [a["name"] for a in body["assets"]] == ["Site", "MV2", "LV Panel 1", "LV Panel 2"]  # tree preorder
    assert [a["path"] for a in body["assets"]] == [
        "Site", "Site / MV2", "Site / MV2 / LV Panel 1", "Site / MV2 / LV Panel 2",
    ]
    rows = by_name(body)
    ids = {name: row["asset_id"] for name, row in rows.items()}
    assert [a["parent_id"] for a in body["assets"]] == [None, ids["Site"], ids["MV2"], ids["MV2"]]
    day = 9  # 10 March in Qatar (UTC+3): 07:00-09:00Z is 10:00-12:00 local
    check(rows["LV Panel 1"]["days"][day], 6.0, 0.6)
    check(rows["LV Panel 2"]["days"][day], 18.0, 9.0, estimated=True)
    for parent in ("MV2", "Site"):
        check(rows[parent]["days"][day], 24.0, 9.6, estimated=True)  # 6 x 0.10 + 18 x 0.50
        check(rows[parent]["total"], 24.0, 9.6, estimated=True)
    assert [rows[n]["rate_per_kwh"] for n in ("Site", "MV2", "LV Panel 1", "LV Panel 2")] == [0.10, 0.10, 0.10, 0.50]
    # The CSV names each asset by its full path, so two assets called "Panel" under different parents stay apart.
    csv_rows = await get_csv(client)
    assert {row[0] for row in csv_rows[1:]} == {
        "Site", "Site / MV2", "Site / MV2 / LV Panel 1", "Site / MV2 / LV Panel 2",
    }
    assert ["Site / MV2 / LV Panel 1", "2026-03-10", "6", "0.6", "", "false", "false"] in csv_rows


async def test_a_meter_added_to_a_parent_later_does_not_zero_the_parents_earlier_days(client, db):
    # The owner's case: an energy_kwh point mapped to MV2 on 20 March. March 1-19 stay what its panels add up to,
    # at the panels' own rates; from the 20th MV2 is its meter (and the panels no longer count towards it).
    mv2 = await make_asset(db, "MV2")
    await add_counter(db, "LV Panel 1", at(2026, 2, 28, 23), 745, per_hour=1.0, parent_id=mv2)  # 1 kWh an hour
    panel2 = await add_counter(db, "LV Panel 2", at(2026, 2, 28, 23), 745, per_hour=2.0, parent_id=mv2)
    point = await make_point(db, await db.fetchval("SELECT id FROM sources LIMIT 1"), "MV2_kWh")
    await make_mapping(db, point, mv2, "energy_kwh", 60)
    first = at(2026, 3, 20)
    await insert_readings(db, point, first + timedelta(minutes=10), 40 * 60, [5000.0, 5010.0])  # +10 in its first hour
    await insert_readings(db, point, first + timedelta(minutes=90), 3600, [5020.0 + 10 * i for i in range(287)])
    await add_tariff(db, 0.10, "2026-01-01")
    await add_tariff(db, 0.50, "2026-03-01", asset_id=panel2)  # the dearer panel makes the early cost distinguishable
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    rows = by_name(await get_costs(client))
    mv2_days = rows["MV2"]["days"]
    for day in mv2_days[:19]:
        check(day, 72.0, 26.4)  # 24 x (1 kWh at 0.10 + 2 kWh at 0.50): the panels' sum, with the override
    for day in mv2_days[19:]:
        check(day, 240.0, 24.0)  # the meter: 24 x 10 kWh at 0.10, not the panels' 72
    check(rows["MV2"]["total"], 19 * 72.0 + 12 * 240.0, 19 * 26.4 + 12 * 24.0)
    check(rows["LV Panel 1"]["total"], 744.0, 74.4)  # the panels themselves are untouched


async def test_a_parent_is_partial_when_only_one_child_has_a_rate(client, db):  # Review Focus 3
    await build_hierarchy(db, default_rate=None)  # only LV Panel 2 has a rate
    await login_as(client, db, "viewer")
    rows = by_name(await get_costs(client))
    day = 9
    check(rows["LV Panel 1"]["days"][day], 6.0, None, partial=True)
    check(rows["LV Panel 2"]["days"][day], 18.0, 9.0, estimated=True)
    check(rows["MV2"]["days"][day], 24.0, 9.0, estimated=True, partial=True)
    check(rows["MV2"]["total"], 24.0, 9.0, estimated=True, partial=True)
    assert rows["Site"]["rate_per_kwh"] is None and rows["LV Panel 2"]["rate_per_kwh"] == 0.50


async def test_a_rate_that_starts_mid_month_marks_the_earlier_days_partial(client, db):  # Review Focus 3
    await add_power(db, "Panel", [at(2026, 3, 1, 10), at(2026, 3, 2, 10), at(2026, 3, 3, 10)], kw=10.0)
    await add_power(db, "Idle", [at(2026, 3, 1, 12), at(2026, 3, 2, 12)], kw=0.0)
    await add_tariff(db, 0.20, "2026-03-02")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    rows = by_name(await get_costs(client))
    panel, idle = rows["Panel"], rows["Idle"]
    check(panel["days"][0], 10.0, None, estimated=True, partial=True)  # 1 March: before the rate
    check(panel["days"][1], 10.0, 2.0, estimated=True)
    check(panel["days"][2], 10.0, 2.0, estimated=True)
    check(panel["total"], 30.0, 4.0, estimated=True, partial=True)
    check(panel["days"][3], 0.0, 0.0)  # 4 March: no readings at all, the rate is in effect: costs 0, not partial
    assert panel["rate_per_kwh"] == 0.20
    # An hour that used no energy never makes a figure partial; with a rate in effect it costs 0, not "no rate".
    check(idle["days"][0], 0.0, None, estimated=True)
    check(idle["days"][1], 0.0, 0.0, estimated=True)
    check(idle["total"], 0.0, 0.0, estimated=True)


async def test_a_silent_day_costs_zero_only_where_a_rate_is_in_effect(client, db):  # Review Focus 3
    # Readings only in one hour of 10 March; the rate starts on 5 March. A day with no energy hours (an outage,
    # or before collection started) used nothing: 0 kWh, and 0 cost under a rate but no figure without one.
    await add_power(db, "Panel", [at(2026, 3, 10, 10)], kw=10.0)
    await add_tariff(db, 0.20, "2026-03-05")
    await set_currency(db, "QAR")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    panel = by_name(await get_costs(client))["Panel"]
    check(panel["days"][1], 0.0, None)  # 2 March: silent and no rate yet: a dash, and not partial
    check(panel["days"][3], 0.0, None)  # 4 March: the day before the rate starts
    check(panel["days"][4], 0.0, 0.0)  # 5 March: silent, the rate has started: a real zero
    check(panel["days"][6], 0.0, 0.0)  # 7 March
    check(panel["days"][9], 10.0, 2.0, estimated=True)  # 10 March, the one hour with readings
    check(panel["days"][10], 0.0, 0.0)  # 11 March
    assert all(day["cost"] is None for day in panel["days"][:4])
    assert all(day["cost"] is not None for day in panel["days"][4:])
    # The month total is the sum of the priced hours (the silent days add 0 kWh and 0 cost); it is not partial
    # because no hour that consumed energy lacked a rate.
    check(panel["total"], 10.0, 2.0, estimated=True)
    assert panel["total"]["cost"] == pytest.approx(sum(day["cost"] for day in panel["days"] if day["cost"] is not None))

    rows = await get_csv(client)
    assert rows[2] == ["Panel", "2026-03-02", "0", "", "QAR", "false", "false"]  # no rate: an empty cell
    assert rows[5] == ["Panel", "2026-03-05", "0", "0", "QAR", "false", "false"]  # silent under a rate: 0
    assert rows[10] == ["Panel", "2026-03-10", "10", "2", "QAR", "true", "false"]


async def test_a_counter_silent_all_month_costs_zero_under_a_rate_and_nothing_without_one(client, db):  # Review Focus 3
    # Both meters were read in February only, so the engine has no hours at all for March (an exact zero).
    priced = await add_counter(db, "Priced", at(2026, 2, 10, 0), 5)
    await add_counter(db, "Unpriced", at(2026, 2, 10, 0), 5)
    await add_tariff(db, 0.20, "2026-01-01", asset_id=priced)
    await set_currency(db, "QAR")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    rows = by_name(await get_costs(client))
    for entry in [*rows["Priced"]["days"], rows["Priced"]["total"]]:
        check(entry, 0.0, 0.0)
    for entry in [*rows["Unpriced"]["days"], rows["Unpriced"]["total"]]:
        check(entry, 0.0, None)
    assert rows["Priced"]["rate_per_kwh"] == 0.20 and rows["Unpriced"]["rate_per_kwh"] is None
    csv_rows = await get_csv(client)
    assert {tuple(row[3:]) for row in csv_rows[1:] if row[0] == "Priced"} == {("0", "QAR", "false", "false")}
    assert {tuple(row[3:]) for row in csv_rows[1:] if row[0] == "Unpriced"} == {("", "QAR", "false", "false")}


async def test_the_current_month_total_leaves_out_future_days(client, db):  # Review Focus 3
    # A power-only meter with no April readings is an estimated zero for every hour of the requested range,
    # future days included. The rate starts on 20 April, after today (15 April): nothing shown has a rate.
    await add_power(db, "Panel", [at(2026, 3, 10, 10)])
    await add_tariff(db, 0.20, "2026-04-20")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    panel = by_name(await get_costs(client, "2026-04"))["Panel"]  # NOW is 15 April 10:20 UTC
    assert panel["rate_per_kwh"] is None
    assert panel["days"][15:] == [None] * 15
    for day in panel["days"][:15]:
        check(day, 0.0, None, estimated=True)
    check(panel["total"], 0.0, None, estimated=True)  # not 0.0: the priced hours of 20-30 April are not shown


async def test_the_month_total_is_built_from_the_days_it_shows(client, db):  # Review Focus 3
    # A counter read 1-10 March and then went silent; the site rate starts on 15 March. Days 1-10 consumed energy
    # with no rate (partial); 11-14 are silent with no rate (dash); 15-31 are silent under a rate (a real 0).
    await add_counter(db, "Meter", at(2026, 3, 1, 0), 240)
    await add_tariff(db, 0.20, "2026-03-15")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    meter = by_name(await get_costs(client))["Meter"]
    check(meter["days"][0], 23.0, None, partial=True)  # the first hour is the baseline and counts 0
    for day in meter["days"][1:10]:
        check(day, 24.0, None, partial=True)
    for day in meter["days"][10:14]:
        check(day, 0.0, None)
    for day in meter["days"][14:]:
        check(day, 0.0, 0.0)
    check(meter["total"], 239.0, 0.0, partial=True)
    assert meter["total"]["kwh"] == pytest.approx(sum(day["kwh"] for day in meter["days"]))


async def test_no_tariff_means_no_cost_anywhere_and_an_empty_csv_cell(client, db):  # Review Focus 3
    await add_power(db, "Panel", [at(2026, 3, 1, 10), at(2026, 3, 2, 10)], kw=10.0)
    await set_currency(db, "QAR")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    body = await get_costs(client)
    panel = by_name(body)["Panel"]
    assert body["currency"] == "QAR" and panel["rate_per_kwh"] is None
    check(panel["days"][0], 10.0, None, estimated=True, partial=True)
    check(panel["days"][1], 10.0, None, estimated=True, partial=True)
    check(panel["total"], 20.0, None, estimated=True, partial=True)
    check(panel["days"][2], 0.0, None)  # a silent day with no rate at all stays a dash
    rows = await get_csv(client)
    assert rows[0] == ["asset", "date", "kwh", "cost", "currency", "estimated", "partial"]
    assert rows[1] == ["Panel", "2026-03-01", "10", "", "QAR", "true", "true"]
    assert len(rows) == 1 + 31 and all(row[3] == "" for row in rows[1:])


async def test_an_asset_without_an_energy_mapping_has_null_entries(client, db):
    await add_power(db, "Panel", [at(2026, 3, 5, 10)])
    await make_asset(db, "Bare")
    await add_tariff(db, 0.10, "2026-03-01")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    bare = by_name(await get_costs(client))["Bare"]
    assert bare["days"] == [None] * 31 and bare["total"] is None
    assert bare["rate_per_kwh"] == 0.10  # the rate in effect is still shown
    assert "Bare" not in {row[0] for row in await get_csv(client)}  # no entry, no CSV row


async def test_csv_has_one_row_per_asset_per_day_up_to_today(client, db):
    await add_power(db, "Panel", [at(2026, 4, 14, 10)], kw=10.0)
    await add_tariff(db, 0.10, "2026-04-01")
    await set_currency(db, "QAR")
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    response = await client.get("/api/billing/costs.csv", params={"month": "2026-04"})
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"] == 'attachment; filename="billing-2026-04.csv"'
    assert response.content.startswith(b"\xef\xbb\xbf") and b"\r\n" in response.content
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))
    assert len(rows) == 1 + 15  # 1-15 April; the 16th onwards is in the future
    assert rows[14] == ["Panel", "2026-04-14", "10", "1", "QAR", "true", "false"]
    assert rows[1] == ["Panel", "2026-04-01", "0", "0", "QAR", "false", "false"]  # silent, the rate is in effect


async def test_an_asset_named_like_a_formula_is_neutralised_in_the_csv(client, db):  # Review Focus 5
    hostile = '=HYPERLINK("http://x","y")'
    await add_power(db, hostile, [at(2026, 3, 5, 10)])
    await settle_rollups(db)
    await login_as(client, db, "viewer")

    assert by_name(await get_costs(client))[hostile]["path"] == hostile  # JSON keeps the real name
    rows = await get_csv(client)
    assert {row[0] for row in rows[1:]} == {"'" + hostile}
