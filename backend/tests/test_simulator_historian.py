"""The stand-in Historian (dcdash/simulator/historian.py): one test for every behaviour a real Historian is known for.

No Docker, no sockets: the app is driven through httpx.ASGITransport with a fake clock. The wire format is plan D9; the walls around the
SIM_HISTORIAN_ variables are in test_simulator_faults_isolation.py.
"""
import asyncio
import signal
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from dcdash.simulator import historian as h
from dcdash.simulator.faults import FaultConfigError
from dcdash.simulator.historian import HistorianConfig, HistorianConfigError, create_historian_app
from tests.helpers import free_ports, wait_for

KEY = {"X-API-Key": "k"}
NOW = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)
MINUTE = timedelta(minutes=1)


class Clock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def make_app(clock=None, **settings):
    return create_historian_app(HistorianConfig(**settings), clock=clock or Clock(), api_key="k")


def client_for(app, headers=KEY) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://hist", headers=headers)


def client(clock=None, **settings) -> httpx.AsyncClient:
    return client_for(make_app(clock, **settings))


def iso(moment) -> str:
    return moment if isinstance(moment, str) else moment.isoformat()


async def history(c, addresses, start, end, **extra) -> dict:
    response = await c.get("/history", params={"addresses": addresses, "start": iso(start), "end": iso(end), **extra})
    assert response.status_code == 200, response.text
    return response.json()


def series(body: dict) -> dict[str, list[dict]]:
    found: dict[str, list[dict]] = {}
    for item in body["values"]:
        found.setdefault(item["address"], []).append(item)
    return found


def at(day: str, clock_time: str = "00:00") -> datetime:
    return datetime.fromisoformat(f"{day}T{clock_time}:00+00:00")


# ---- the settings -----------------------------------------------------------------------------------------------------------


def test_the_defaults_and_empty_values_mean_the_defaults():
    expected = HistorianConfig()
    assert (expected.port, expected.meters, expected.max_rows, expected.late_minutes, expected.zone) == (9100, 20, 50_000, 90, "Europe/Berlin")
    assert (expected.fail_every, expected.rate, expected.slow_seconds) == (0, 0, 0.0)
    assert HistorianConfig.from_env({}) == expected
    assert HistorianConfig.from_env({name: "" for name in h.KNOWN}) == expected  # compose passes every name, empty when unset
    assert HistorianConfig.from_env({name: "  " for name in h.KNOWN}) == expected


def test_every_setting_is_read():
    config = HistorianConfig.from_env({
        "SIM_HISTORIAN_PORT": "9123", "SIM_HISTORIAN_METERS": "217", "SIM_HISTORIAN_MAX_ROWS": "1000", "SIM_HISTORIAN_LATE_MINUTES": "30",
        "SIM_HISTORIAN_ZONE": "Europe/London", "SIM_HISTORIAN_FAIL_EVERY": "5", "SIM_HISTORIAN_RATE": "2", "SIM_HISTORIAN_SLOW": "0.5",
        "SIM_API_KEY": "ignored", "SIM_FAULT_SLOW": "9",  # other families are not this module's business
    })
    assert config == HistorianConfig(port=9123, meters=217, max_rows=1000, late_minutes=30, zone="Europe/London", fail_every=5, rate=2, slow_seconds=0.5)


def test_a_name_it_does_not_know_is_refused_with_the_list_of_names():
    with pytest.raises(HistorianConfigError) as refused:
        HistorianConfig.from_env({"SIM_HISTORIAN_FAIL_EVRY": "2"})
    assert "SIM_HISTORIAN_FAIL_EVRY" in str(refused.value) and "SIM_HISTORIAN_FAIL_EVERY" in str(refused.value)
    assert isinstance(refused.value, FaultConfigError)  # so main() stops on it like on a bad SIM_FAULT_ switch


@pytest.mark.parametrize("name, value", [
    ("SIM_HISTORIAN_PORT", "0"), ("SIM_HISTORIAN_PORT", "99999"), ("SIM_HISTORIAN_PORT", "nine"),
    ("SIM_HISTORIAN_METERS", "-1"), ("SIM_HISTORIAN_METERS", "many"), ("SIM_HISTORIAN_METERS", "20.5"),
    ("SIM_HISTORIAN_MAX_ROWS", "0"), ("SIM_HISTORIAN_LATE_MINUTES", "-5"),
    ("SIM_HISTORIAN_ZONE", "Mars/Olympus"), ("SIM_HISTORIAN_ZONE", "Europe"), ("SIM_HISTORIAN_ZONE", "../etc/passwd"),
    ("SIM_HISTORIAN_FAIL_EVERY", "-1"), ("SIM_HISTORIAN_RATE", "fast"),
    ("SIM_HISTORIAN_SLOW", "-1"), ("SIM_HISTORIAN_SLOW", "nan"), ("SIM_HISTORIAN_SLOW", "inf"), ("SIM_HISTORIAN_SLOW", "3600"),
])
def test_a_bad_value_is_refused_with_a_sentence_naming_the_setting(name, value):
    with pytest.raises(HistorianConfigError) as refused:
        HistorianConfig.from_env({name: value})
    assert str(refused.value).startswith(name)


def test_describe_lists_only_the_faults_that_are_on():
    assert HistorianConfig().describe() == []
    assert HistorianConfig(meters=2000, max_rows=10, zone="Europe/London").describe() == []  # not faults
    lines = HistorianConfig(fail_every=5, rate=2, slow_seconds=1.5).describe()
    assert len(lines) == 3
    assert lines[0].startswith("SIM_HISTORIAN_FAIL_EVERY=5") and lines[1].startswith("SIM_HISTORIAN_RATE=2")
    assert lines[2].startswith("SIM_HISTORIAN_SLOW=1.5")


# ---- the surface: identity, routes, key, GET only ---------------------------------------------------------------------------


async def test_the_root_needs_no_key_and_lets_the_existing_probe_recognise_the_simulator():
    async with client_for(make_app(), headers={}) as c:
        response = await c.get("/")
    # `instance` is `<id>:historian`, so the stand-in does not share the plain simulator's id (the platform compares servers by it)
    assert response.status_code == 200 and response.json() == {"service": "dcdash-simulator", "history": True, "instance": "dev:historian"}


async def test_the_stand_in_names_itself_after_the_simulator_id_it_was_started_with():
    app = create_historian_app(HistorianConfig(), clock=Clock(), api_key="k", instance="lab-2")
    async with client_for(app, headers={}) as c:
        assert (await c.get("/")).json()["instance"] == "lab-2:historian"


def test_the_routes_are_exactly_these_and_all_are_get():
    app = make_app()
    routes = {(route.path, tuple(sorted(route.methods))) for route in app.routes}
    assert routes == {("/", ("GET",)), ("/points", ("GET",)), ("/read", ("GET",)), ("/history", ("GET",)), ("/stats", ("GET",))}


async def test_nothing_but_get_is_accepted_and_there_are_no_docs_routes():
    async with client() as c:
        for path in ("/", "/points", "/read", "/history", "/stats"):
            for method in ("POST", "PUT", "DELETE", "PATCH"):
                assert (await c.request(method, path)).status_code == 405, (method, path)
        for path in ("/docs", "/redoc", "/openapi.json", "/admin/fault"):
            assert (await c.get(path)).status_code == 404, path


async def test_a_wrong_or_missing_key_is_a_401_on_every_route_but_the_root():
    params = {"addresses": "M001_kW", "start": "2026-03-01T11:00:00Z", "end": "2026-03-01T12:00:00Z"}
    for headers in ({}, {"X-API-Key": "wrong"}):
        async with client_for(make_app(), headers=headers) as c:
            for path in ("/points", "/read", "/history", "/stats"):
                assert (await c.get(path, params=params)).status_code == 401, (headers, path)
            assert (await c.get("/")).status_code == 200


# ---- /points ----------------------------------------------------------------------------------------------------------------


BEHAVIOUR_TAGS = {
    "UNIT_Wh", "UNIT_MWh", "UNIT_W", "POWER_5MIN_kW", "GAP_kWh", "LATE_kWh", "DUP_kWh", "DIFF_kWh", "RESET_kWh", "WRAP_kWh", "BADQ_kW",
    "INTERVAL_kWh", "LOCAL_kWh", "DEADBAND_kW", "MISMATCH_kW",
}


async def test_points_lists_the_meters_and_one_tag_per_behaviour_with_their_facts():
    async with client() as c:
        body = (await c.get("/points")).json()
    points = {p["address"]: p for p in body["points"]}
    assert len(points) == len(body["points"]) == 2 * 20 + len(BEHAVIOUR_TAGS)
    assert {"M001_kWh", "M001_kW", "M020_kWh", "M020_kW"} <= set(points) and BEHAVIOUR_TAGS <= set(points)
    assert {"M021_kWh", "M021_kW"}.isdisjoint(points)
    plain = points["M001_kWh"]
    assert (plain["unit"], plain["kind"], plain["interval"], plain["zone"]) == ("kWh", "counter", 60, None)
    assert plain["stamp_start"] == "2026-01-01T00:00:00+00:00" and plain["stamp_end"] == NOW.isoformat() and plain["name"]
    assert {p["unit"] for p in (points["UNIT_Wh"], points["UNIT_MWh"], points["UNIT_W"])} == {"Wh", "MWh", "W"}
    assert points["UNIT_W"]["kind"] == "power" and points["M001_kW"]["kind"] == "power"
    assert (points["POWER_5MIN_kW"]["interval"], points["MISMATCH_kW"]["interval"], points["MISMATCH_kW"]["kind"]) == (300, 60, "power")
    assert (points["INTERVAL_kWh"]["kind"], points["INTERVAL_kWh"]["interval"]) == ("interval", 900)
    assert points["INTERVAL_kWh"]["stamp_start"] == "2026-01-01T00:15:00+00:00"  # the first period ends 15 minutes after the anchor
    assert points["LOCAL_kWh"]["zone"] == "Europe/Berlin"
    assert [p["address"] for p in body["points"] if p["zone"]] == ["LOCAL_kWh"]
    assert points["LATE_kWh"]["stamp_end"] == "2026-03-01T10:30:00+00:00"  # visible 90 minutes after its instant
    assert points["GAP_kWh"]["stamp_end"] == NOW.isoformat()


async def test_the_settings_shape_the_points():
    async with client(meters=3, zone="Europe/London", late_minutes=10) as c:
        points = {p["address"]: p for p in (await c.get("/points")).json()["points"]}
    assert len(points) == 6 + len(BEHAVIOUR_TAGS) and points["LOCAL_kWh"]["zone"] == "Europe/London"
    assert points["LATE_kWh"]["stamp_end"] == "2026-03-01T11:50:00+00:00"


# ---- the plain meters and the units ----------------------------------------------------------------------------------------


async def test_a_counter_only_rises_and_is_the_integral_of_the_power():
    async with client() as c:
        body = await history(c, "M001_kWh,M001_kW", at("2026-02-20"), at("2026-02-21"))
    counter, power = series(body)["M001_kWh"], series(body)["M001_kW"]
    values = [item["value"] for item in counter]
    assert len(counter) == len(power) == 1441
    assert all(later > earlier for earlier, later in zip(values, values[1:]))
    # one minute of power is a sixtieth of an hour: summing the kW samples lands on the counter's gain
    assert sum(item["value"] for item in power[:-1]) / 60 == pytest.approx(values[-1] - values[0], rel=1e-3)
    assert {item["quality"] for item in counter + power} == {"good"} and all(isinstance(v, float) for v in values)


async def test_the_unit_tags_carry_the_same_energy_and_power_as_the_plain_meter():
    async with client() as c:
        rows = series(await history(c, "UNIT_Wh,UNIT_MWh,UNIT_W,M001_kWh,M001_kW", NOW - timedelta(hours=1), NOW))
    assert all(len(items) == 61 for items in rows.values())
    for wh, mwh, kwh in zip(rows["UNIT_Wh"], rows["UNIT_MWh"], rows["M001_kWh"]):
        assert wh["ts"] == mwh["ts"] == kwh["ts"]
        assert wh["value"] / 1000 == pytest.approx(kwh["value"], abs=0.002)
        assert mwh["value"] * 1000 == pytest.approx(kwh["value"], abs=0.002)
    for watts, kw in zip(rows["UNIT_W"], rows["M001_kW"]):
        assert watts["value"] / 1000 == pytest.approx(kw["value"], abs=0.002)


async def test_the_five_minute_tag_has_one_sample_every_five_minutes_and_the_plain_meters_one_a_minute():
    async with client() as c:
        rows = series(await history(c, "POWER_5MIN_kW,M001_kW", NOW - timedelta(hours=2), NOW))
    five = [datetime.fromisoformat(item["ts"]) for item in rows["POWER_5MIN_kW"]]
    assert len(five) == 25 and {later - earlier for earlier, later in zip(five, five[1:])} == {timedelta(minutes=5)}
    plain = {item["ts"]: item["value"] for item in rows["M001_kW"]}
    assert all(plain[item["ts"]] == item["value"] for item in rows["POWER_5MIN_kW"])  # the same curve, sampled more thinly


async def test_the_mismatch_tag_is_a_one_minute_power_tag():
    async with client() as c:
        rows = series(await history(c, "MISMATCH_kW", NOW - timedelta(minutes=10), NOW))
    assert len(rows["MISMATCH_kW"]) == 11 and all(item["quality"] == "good" for item in rows["MISMATCH_kW"])


# ---- gap, late, duplicates, a re-read that differs ---------------------------------------------------------------------------


async def test_the_gap_tag_has_no_sample_from_0300_up_to_0600_utc_in_history_and_in_read():
    clock = Clock(at("2026-02-10", "12:00"))
    async with client(clock) as c:
        rows = series(await history(c, "GAP_kWh,M001_kWh", at("2026-02-10"), at("2026-02-10", "08:00")))
        times = [item["ts"][11:16] for item in rows["GAP_kWh"]]
        assert "02:59" in times and "06:00" in times and not any("03:00" <= t < "06:00" for t in times)
        assert len(rows["GAP_kWh"]) == 481 - 180 and len(rows["M001_kWh"]) == 481
        plain = {item["ts"]: item["value"] for item in rows["M001_kWh"]}
        assert all(plain[item["ts"]] == item["value"] for item in rows["GAP_kWh"])  # a gap hides samples, it does not change them
        clock.now = at("2026-02-10", "04:30")
        read = (await c.get("/read", params={"addresses": "GAP_kWh,M001_kWh"})).json()["values"]
    assert {item["address"]: item["ts"] for item in read} == {"GAP_kWh": "2026-02-10T02:59:00+00:00", "M001_kWh": "2026-02-10T04:30:00+00:00"}


async def test_a_late_sample_is_visible_only_after_the_delay_judged_with_the_clock_and_never_moves_complete_until():
    clock = Clock(NOW)
    async with client(clock) as c:
        first = await history(c, "LATE_kWh,M001_kWh", NOW - timedelta(hours=4), NOW)
        late, plain = series(first)["LATE_kWh"], series(first)["M001_kWh"]
        assert late[-1]["ts"] == "2026-03-01T10:30:00+00:00" and plain[-1]["ts"] == NOW.isoformat()
        assert first["complete_until"] == NOW.isoformat()  # lateness does not hold it back: the late pass finds the sample later
        assert (await c.get("/read", params={"addresses": "LATE_kWh"})).json()["values"][0]["ts"] == "2026-03-01T10:30:00+00:00"
        clock.now = NOW + timedelta(minutes=30)
        second = series(await history(c, "LATE_kWh", NOW - timedelta(hours=4), NOW))["LATE_kWh"]
    assert second[-1]["ts"] == "2026-03-01T11:00:00+00:00" and second[:len(late)] == late  # the earlier samples are untouched


async def test_the_dup_tag_sends_every_value_twice():
    async with client() as c:
        body = await history(c, "DUP_kWh,M001_kWh", NOW - timedelta(minutes=10), NOW)
    rows = series(body)
    assert len(rows["DUP_kWh"]) == 22 and len(rows["M001_kWh"]) == 11
    pairs = list(zip(rows["DUP_kWh"][0::2], rows["DUP_kWh"][1::2]))
    assert all(a == b for a, b in pairs)
    assert [a["value"] for a, _ in pairs] == [item["value"] for item in rows["M001_kWh"]]


async def test_the_diff_tag_answers_differently_for_a_few_instants_from_the_second_answer_on():
    day = (at("2026-02-10"), at("2026-02-11"))
    async with client() as c:
        first = (await history(c, "DIFF_kWh,M001_kWh", *day))
        second = (await history(c, "DIFF_kWh", *day))["values"]
        third = (await history(c, "DIFF_kWh", *day))["values"]
    original, plain = series(first)["DIFF_kWh"], series(first)["M001_kWh"]
    assert [item["value"] for item in original] == [item["value"] for item in plain]  # the first answer is the true series
    changed = [(a, b) for a, b in zip(original, second) if a != b]
    assert 5 <= len(changed) <= 30 and len(changed) < len(second) // 20  # a few instants, not the series
    assert all(b["ts"] == a["ts"] and b["value"] == pytest.approx(a["value"] + h.DIFF_BUMP) for a, b in changed)
    assert third == second  # and it stays that way from then on


async def test_a_read_counts_as_the_first_answer_of_its_instant_so_the_history_twin_may_differ_for_diff():
    on_the_beat = h.ANCHOR + timedelta(minutes=97 * 1000)  # an instant that DIFF answers differently the second time
    async with client(Clock(on_the_beat)) as c:
        live = (await c.get("/read", params={"addresses": "DIFF_kWh"})).json()["values"][0]
        stored = (await history(c, "DIFF_kWh", on_the_beat, on_the_beat))["values"][0]
    assert live["ts"] == stored["ts"] == on_the_beat.isoformat() and stored["value"] == pytest.approx(live["value"] + h.DIFF_BUMP)


# ---- reset, wrap, qualities, END-stamped intervals ------------------------------------------------------------------------------


async def zero_instants(c, start: datetime, end: datetime) -> list[datetime]:
    items = series(await history(c, "RESET_kWh", start, end))["RESET_kWh"]
    return [datetime.fromisoformat(item["ts"]) for item in items if item["value"] == 0.0]


async def test_the_reset_tag_returns_to_zero_at_0200_local_winter_and_summer():
    clock = Clock(at("2026-08-01"))
    async with client(clock) as c:
        winter = series(await history(c, "RESET_kWh", at("2026-02-10", "00:58"), at("2026-02-10", "01:02")))["RESET_kWh"]  # 02:00 CET is 01:00 UTC
        summer = series(await history(c, "RESET_kWh", at("2026-07-10", "23:58"), at("2026-07-11", "00:02")))["RESET_kWh"]  # 02:00 CEST is 00:00 UTC
    for items in (winter, summer):
        before, zero, after = items[1]["value"], items[2]["value"], items[3]["value"]
        assert items[2]["ts"][11:16] in ("01:00", "00:00") and zero == 0.0
        assert before > 100 and 0 < after < 2  # a day of energy collapses to one minute of it


async def test_the_reset_happens_once_a_day_also_on_the_two_days_the_clock_changes():
    clock = Clock(at("2026-12-01"))
    async with client(clock) as c:
        spring = await zero_instants(c, at("2026-03-27"), at("2026-03-30", "12:00"))
        autumn = await zero_instants(c, at("2026-10-23"), at("2026-10-27"))
    # 02:00 does not exist on 2026-03-29 (the clock jumps to 03:00 = 01:00 UTC); on 2026-10-25 it happens twice, the first one counts
    assert spring == [at("2026-03-27", "01:00"), at("2026-03-28", "01:00"), at("2026-03-29", "01:00"), at("2026-03-30", "00:00")]
    assert autumn == [at("2026-10-23", "00:00"), at("2026-10-24", "00:00"), at("2026-10-25", "00:00"), at("2026-10-26", "01:00")]


async def test_the_wrap_tag_rolls_over_to_zero_after_99999_9():
    async with client() as c:
        values = [item["value"] for item in series(await history(c, "WRAP_kWh", at("2026-02-10"), at("2026-02-12")))["WRAP_kWh"]]
    assert all(0.0 <= value <= 99_999.9 for value in values) and max(values) > 99_900
    drops = [(earlier, later) for earlier, later in zip(values, values[1:]) if later < earlier]
    assert 1 <= len(drops) <= 3
    assert all(earlier > 99_900 and later < 100 for earlier, later in drops)  # a drop is the roll-over, not a reset in the middle
    assert all(round(value, 1) == value for value in values)


async def test_the_quality_tag_cycles_good_uncertain_bad_substituted_interpolated():
    cycle = ("good", "uncertain", "bad", "substituted", "interpolated")
    async with client() as c:
        items = series(await history(c, "BADQ_kW,M001_kW", NOW - timedelta(minutes=30), NOW))
    qualities = [item["quality"] for item in items["BADQ_kW"]]
    offset = cycle.index(qualities[0])
    assert qualities == [cycle[(offset + i) % 5] for i in range(31)] and set(qualities) == set(cycle)
    assert [item["value"] for item in items["BADQ_kW"]] == [item["value"] for item in items["M001_kW"]]  # a bad sample still carries a number


async def test_the_interval_tag_is_stamped_at_the_end_of_each_fifteen_minute_period():
    async with client() as c:
        first = (await history(c, "INTERVAL_kWh", h.ANCHOR, h.ANCHOR + timedelta(hours=1)))["values"]
        body = await history(c, "INTERVAL_kWh,M001_kWh", at("2026-03-01", "10:00"), at("2026-03-01", "11:00"))
    assert [item["ts"] for item in first] == [(h.ANCHOR + timedelta(minutes=15 * n)).isoformat() for n in (1, 2, 3, 4)]  # no period ends at the anchor
    periods, counter = series(body)["INTERVAL_kWh"], series(body)["M001_kWh"]
    assert [item["ts"][11:16] for item in periods] == ["10:00", "10:15", "10:30", "10:45", "11:00"]
    assert all(item["period_seconds"] == 900 and item["stamp"] == "end" and item["quality"] == "good" for item in periods)
    assert "zone" not in periods[0] and "period_seconds" not in counter[0] and "stamp" not in counter[0]
    gained = counter[-1]["value"] - counter[0]["value"]  # the four periods that end after 10:00 add up to the hour's energy
    assert sum(item["value"] for item in periods[1:]) == pytest.approx(gained, abs=0.005)


# ---- naive local times ----------------------------------------------------------------------------------------------------------


async def test_local_times_are_naive_carry_the_zone_and_repeat_the_autumn_hour():
    async with client(Clock(at("2026-12-01"))) as c:
        body = await history(c, "LOCAL_kWh,M001_kWh", at("2026-10-24", "22:30"), at("2026-10-25", "02:30"))
    rows = series(body)
    local, plain = rows["LOCAL_kWh"], rows["M001_kWh"]
    assert len(local) == len(plain) == 241
    assert all(item["zone"] == "Europe/Berlin" and datetime.fromisoformat(item["ts"]).tzinfo is None for item in local)
    assert "zone" not in plain[0]
    stamps = [item["ts"] for item in local]
    two_to_three = [ts for ts in stamps if ts.startswith("2026-10-25T02:")]
    assert len(two_to_three) == 120 and len(set(two_to_three)) == 60  # the same wall-clock hour twice
    assert stamps[stamps.index("2026-10-25T02:59:00") + 1] == "2026-10-25T02:00:00"  # the clock steps back after the first 02:59
    assert stamps[0] == "2026-10-25T00:30:00" and stamps[-1] == "2026-10-25T03:30:00"
    values = [item["value"] for item in local]
    assert all(later > earlier for earlier, later in zip(values, values[1:]))  # a counter keeps rising through the repeated hour
    assert body["values"][0::2] == local and body["values"][1::2] == plain  # ordered by instant, then address, never by the local text
    assert [item["value"] for item in local] == [item["value"] for item in plain]


async def test_local_times_skip_the_spring_hour():
    async with client(Clock(at("2026-12-01"))) as c:
        local = series(await history(c, "LOCAL_kWh", at("2026-03-28", "23:00"), at("2026-03-29", "02:00")))["LOCAL_kWh"]
    stamps = [item["ts"] for item in local]
    assert not any(ts.startswith("2026-03-29T02:") for ts in stamps)  # 02:00 to 03:00 never happened
    assert stamps[stamps.index("2026-03-29T01:59:00") + 1] == "2026-03-29T03:00:00"
    assert len(stamps) == 181 and len(set(stamps)) == 181


# ---- the dead band ------------------------------------------------------------------------------------------------------------


async def test_the_deadband_tag_keeps_only_the_minutes_that_changed_by_more_than_half_a_kilowatt():
    start, end = at("2026-02-10"), at("2026-02-10", "03:00")
    clock = Clock(end)
    async with client(clock) as c:
        sparse = series(await history(c, "DEADBAND_kW", start, end))["DEADBAND_kW"]
        clock.now = at("2026-02-10", "02:59")
        read = (await c.get("/read", params={"addresses": "DEADBAND_kW"})).json()["values"][0]
    assert 8 <= len(sparse) <= 16 < 181  # a step every 17 minutes, not a sample a minute
    first = int((start - h.ANCHOR) / MINUTE)
    minute = {k: h.deadband_kw(k) for k in range(first - 1, first + 181)}  # the series the dead band is applied to
    changed = [k for k in range(first, first + 181) if abs(minute[k] - minute[k - 1]) > 0.5]
    assert [int((datetime.fromisoformat(item["ts"]) - h.ANCHOR) / MINUTE) for item in sparse] == changed
    assert [item["value"] for item in sparse] == [minute[k] for k in changed]
    latest = [k for k in changed if k <= first + 179][-1]  # the latest value at 02:59: the last stored change, with its own stamp
    assert read["ts"] == (h.ANCHOR + latest * MINUTE).isoformat() and read["value"] == minute[latest]


# ---- /read and /history are one code path --------------------------------------------------------------------------------------


@pytest.mark.parametrize("address", [
    "M001_kW", "M001_kWh", "UNIT_Wh", "UNIT_MWh", "UNIT_W", "POWER_5MIN_kW", "MISMATCH_kW", "GAP_kWh", "LATE_kWh", "RESET_kWh", "WRAP_kWh",
    "INTERVAL_kWh", "LOCAL_kWh", "BADQ_kW", "DEADBAND_kW",
])
@pytest.mark.parametrize("minutes", [0, 1, 2, 3, 4, 7])
async def test_a_live_value_and_its_history_twin_are_one_pair(address, minutes):
    clock = Clock(NOW + timedelta(minutes=minutes))
    async with client(clock) as c:
        live = (await c.get("/read", params={"addresses": address})).json()["values"]
        assert len(live) == 1
        stored = (await history(c, address, clock.now - timedelta(hours=6), clock.now))["values"]
    assert live[0] == stored[-1]  # same ts, value, quality and extra fields (zone, period_seconds, stamp)


async def test_read_leaves_an_unknown_address_out_and_sends_a_duplicated_tag_once():
    async with client() as c:
        values = (await c.get("/read", params={"addresses": "NOPE,DUP_kWh,M001_kW,DUP_kWh"})).json()["values"]
    assert [item["address"] for item in values] == ["DUP_kWh", "M001_kW"]
    assert all(item["ts"] == NOW.isoformat() for item in values)


# ---- the answer: cut, complete_until, unknown, bad requests --------------------------------------------------------------------


async def test_a_cut_answer_names_the_first_instant_it_left_out_and_the_next_page_starts_there():
    async with client() as c:
        window = (NOW - timedelta(hours=1), NOW)
        body = await history(c, "M001_kW", *window, limit=10)
        assert len(body["values"]) == 10 and body["complete_until"] == (window[0] + 10 * MINUTE).isoformat()
        rest = await history(c, "M001_kW", body["complete_until"], window[1])
        whole = (await history(c, "M001_kW", *window))["values"]
    assert rest["values"][0]["ts"] == body["complete_until"] and len(rest["values"]) == 51
    assert body["values"] + rest["values"] == whole  # nothing lost, nothing repeated


async def test_pages_joined_at_complete_until_make_the_whole_series():
    async with client() as c:
        whole = (await history(c, "M001_kW,M001_kWh", NOW - timedelta(hours=1), NOW))["values"]
        joined: dict[tuple[str, str], dict] = {}  # a page may repeat the rows of the instant it was cut in; the pair (ts, address) tells
        start, pages = NOW - timedelta(hours=1), 0
        while True:
            page = await history(c, "M001_kW,M001_kWh", start, NOW, limit=7)
            joined.update({(item["ts"], item["address"]): item for item in page["values"]})
            pages += 1
            if len(page["values"]) < 7:
                break
            start = datetime.fromisoformat(page["complete_until"])
    assert list(joined.values()) == whole and pages > 10


async def test_a_cut_between_two_addresses_still_completes_every_address_up_to_complete_until():
    async with client() as c:
        body = await history(c, "M001_kWh,M001_kW", NOW - timedelta(minutes=10), NOW, limit=7)
    values = body["values"]
    assert [(item["ts"][11:16], item["address"]) for item in values] == [
        ("11:50", "M001_kW"), ("11:50", "M001_kWh"), ("11:51", "M001_kW"), ("11:51", "M001_kWh"),
        ("11:52", "M001_kW"), ("11:52", "M001_kWh"), ("11:53", "M001_kW"),  # ordered by instant, then address: kW before kWh
    ]
    assert body["complete_until"] == "2026-03-01T11:53:00+00:00"  # the kWh row of 11:53 is the first row not sent: nothing earlier is missing


async def test_an_uncut_answer_is_complete_until_the_end_or_now_whichever_is_earlier():
    async with client() as c:
        past = await history(c, "M001_kW", NOW - timedelta(hours=1), NOW - timedelta(minutes=30))
        future = await history(c, "M001_kW", NOW - timedelta(hours=1), NOW + timedelta(days=3))
        exact = await history(c, "M001_kW", NOW - timedelta(minutes=4), NOW, limit=5)  # exactly as many rows as the limit: not cut
        empty = await history(c, "M001_kW", NOW + timedelta(hours=1), NOW + timedelta(hours=2))
    assert past["complete_until"] == (NOW - timedelta(minutes=30)).isoformat() and len(past["values"]) == 31
    assert future["complete_until"] == NOW.isoformat() and future["values"][-1]["ts"] == NOW.isoformat()  # nothing from the future
    assert exact["complete_until"] == NOW.isoformat() and len(exact["values"]) == 5
    assert empty["values"] == [] and empty["complete_until"] == NOW.isoformat()


async def test_the_row_limit_is_at_most_the_servers_own_maximum():
    async with client(max_rows=25) as c:
        asked_for_more = await history(c, "M001_kW", NOW - timedelta(hours=3), NOW, limit=1000)
        no_limit = await history(c, "M001_kW", NOW - timedelta(hours=3), NOW)
    assert len(asked_for_more["values"]) == len(no_limit["values"]) == 25
    assert asked_for_more["complete_until"] == no_limit["complete_until"] == (NOW - timedelta(hours=3) + 25 * MINUTE).isoformat()


async def test_start_and_end_are_inclusive_and_a_range_before_the_first_sample_is_clipped():
    async with client() as c:
        one = (await history(c, "M001_kW", NOW, NOW))["values"]
        early = (await history(c, "M001_kW", datetime(2025, 6, 1, tzinfo=timezone.utc), h.ANCHOR + 2 * MINUTE))["values"]
    assert [item["ts"] for item in one] == [NOW.isoformat()]
    assert [item["ts"] for item in early] == [(h.ANCHOR + n * MINUTE).isoformat() for n in range(3)]


async def test_unknown_addresses_are_listed_and_a_repeated_address_is_sent_once():
    async with client() as c:
        body = await history(c, "M001_kW,NOPE,M001_kW,M999_kW,NOPE", NOW - timedelta(minutes=2), NOW)
    assert body["unknown"] == ["NOPE", "M999_kW"] and [item["address"] for item in body["values"]] == ["M001_kW"] * 3


@pytest.mark.parametrize("params", [
    {"addresses": "M001_kW", "end": "2026-03-01T12:00:00Z"},  # no start
    {"addresses": "M001_kW", "start": "2026-03-01T11:00:00Z"},  # no end
    {"start": "2026-03-01T11:00:00Z", "end": "2026-03-01T12:00:00Z"},  # no addresses
    {"addresses": "M001_kW", "start": "2026-03-01T11:00:00", "end": "2026-03-01T12:00:00Z"},  # naive start
    {"addresses": "M001_kW", "start": "2026-03-01T11:00:00Z", "end": "2026-03-01T12:00:00"},  # naive end
    {"addresses": "M001_kW", "start": "yesterday", "end": "2026-03-01T12:00:00Z"},  # garbled
    {"addresses": "M001_kW", "start": "2026-03-01T11:00:00Z", "end": "12:00"},
    {"addresses": "M001_kW", "start": "2026-03-01T12:00:00Z", "end": "2026-03-01T11:00:00Z"},  # end before start
    {"addresses": "M001_kW", "start": "2026-03-01T11:00:00Z", "end": "2026-03-01T12:00:00Z", "limit": "0"},
    {"addresses": "M001_kW", "start": "2026-03-01T11:00:00Z", "end": "2026-03-01T12:00:00Z", "limit": "many"},
])
async def test_a_missing_naive_or_garbled_bound_is_a_422(params):
    async with client() as c:
        assert (await c.get("/history", params=params)).status_code == 422


async def test_a_read_without_addresses_is_a_422():
    async with client() as c:
        assert (await c.get("/read")).status_code == 422


async def test_an_offset_other_than_utc_is_converted():
    async with client() as c:
        plus_two = (await c.get("/history", params={"addresses": "M001_kW", "start": "2026-03-01T13:58:00+02:00", "end": "2026-03-01T14:00:00+02:00"}))
    assert [item["ts"] for item in plus_two.json()["values"]] == [(NOW + n * MINUTE).isoformat() for n in (-2, -1, 0)]


# ---- the three faults -----------------------------------------------------------------------------------------------------------


async def test_no_fault_is_on_by_default():
    async with client() as c:
        statuses = {(await c.get("/read", params={"addresses": "M001_kW"})).status_code for _ in range(12)}
        statuses |= {(await c.get("/history", params={"addresses": "M001_kW", "start": NOW.isoformat(), "end": NOW.isoformat()})).status_code for _ in range(12)}
    assert statuses == {200}


async def test_every_nth_history_request_answers_503_and_nothing_else_does():
    params = {"addresses": "M001_kW", "start": iso(NOW - timedelta(minutes=5)), "end": iso(NOW)}
    async with client(fail_every=3) as c:
        statuses = [(await c.get("/history", params=params)).status_code for _ in range(6)]
        others = [(await c.get(path, params={"addresses": "M001_kW"})).status_code for path in ("/read", "/points", "/read")]
        stats = (await c.get("/stats")).json()
    assert statuses == [200, 200, 503, 200, 200, 503] and others == [200, 200, 200]
    assert stats["responses_503"] == 2 and stats["responses_429"] == 0


async def test_above_the_rate_in_one_second_the_answer_is_429_with_retry_after_one():
    clock = Clock(NOW)
    async with client(clock, rate=2) as c:
        responses = [await c.get("/read", params={"addresses": "M001_kW"}) for _ in range(4)]
        assert [r.status_code for r in responses] == [200, 200, 429, 429]
        assert responses[2].headers["Retry-After"] == "1"
        assert (await c.get("/")).status_code == 200 and (await c.get("/stats")).status_code == 200  # the root and /stats never fault
        clock.now = NOW + timedelta(seconds=1)
        assert (await c.get("/read", params={"addresses": "M001_kW"})).status_code == 200  # a new second, a new allowance
        stats = (await c.get("/stats")).json()
    assert stats["responses_429"] == 2


async def test_a_refused_request_does_not_advance_the_failure_count():
    params = {"addresses": "M001_kW", "start": iso(NOW - timedelta(minutes=5)), "end": iso(NOW)}
    async with client(Clock(NOW), rate=2, fail_every=2) as c:
        statuses = [(await c.get("/history", params=params)).status_code for _ in range(5)]
    assert statuses == [200, 503, 429, 429, 429]  # the second request is the second one that was served; the 429s were never served


async def test_the_slow_fault_delays_every_data_answer_but_not_the_root_or_stats():
    async with client(slow_seconds=0.4) as c:
        started = time.perf_counter()
        assert (await c.get("/read", params={"addresses": "M001_kW"})).status_code == 200
        delayed = time.perf_counter() - started
        started = time.perf_counter()
        assert (await c.get("/")).status_code == 200 and (await c.get("/stats")).status_code == 200
        prompt = time.perf_counter() - started
    assert delayed >= 0.39 and prompt < 0.3


# ---- determinism ----------------------------------------------------------------------------------------------------------------


STEADY = ",".join(sorted(BEHAVIOUR_TAGS - {"DIFF_kWh"})) + ",M001_kWh,M002_kW,M020_kWh"  # DIFF is the one tag that answers differently on purpose


async def test_two_identical_requests_and_two_fresh_servers_give_identical_bodies():
    params = {"addresses": STEADY, "start": "2026-02-10T00:00:00Z", "end": "2026-02-10T12:00:00Z"}
    async with client() as c, client() as other:
        first, second = await c.get("/history", params=params), await c.get("/history", params=params)
        fresh = await other.get("/history", params=params)
    assert first.status_code == 200 and first.text == second.text == fresh.text and len(first.json()["values"]) > 5000


async def test_a_past_range_answers_the_same_at_two_different_clock_values():
    params = {"addresses": STEADY, "start": "2026-02-10T00:00:00Z", "end": "2026-02-10T12:00:00Z"}  # far older than LATE's 90 minutes
    async with client(Clock(NOW)) as early, client(Clock(NOW + timedelta(days=9, minutes=17))) as later:
        before, after = await early.get("/history", params=params), await later.get("/history", params=params)
    assert before.status_code == 200 and before.text == after.text


# ---- speed ----------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("meters", [217, 2000])
async def test_many_meters_build_and_list_quickly(meters):
    started = time.perf_counter()
    app = make_app(meters=meters)
    async with client_for(app) as c:
        response = await c.get("/points")
    elapsed = time.perf_counter() - started
    assert len(response.json()["points"]) == 2 * meters + len(BEHAVIOUR_TAGS)
    assert elapsed < 1.0, elapsed


async def test_a_twenty_thousand_row_answer_takes_well_under_a_second():
    addresses = ",".join(f"M{n:03d}_kW" for n in range(1, 41))
    best = 9.0
    async with client(meters=40) as c:
        for _ in range(3):  # best of three: other jobs share this machine
            started = time.perf_counter()
            body = await history(c, addresses, at("2026-02-01"), at("2026-03-01"), limit=20_000)
            best = min(best, time.perf_counter() - started)
    assert len(body["values"]) == 20_000 and best < 1.0, best


async def test_a_week_of_two_thousand_meters_is_asked_in_pages_without_building_it_all():
    addresses = ",".join(f"M{n:03d}_kWh" for n in range(1, 201))
    started = time.perf_counter()
    async with client(meters=2000) as c:
        body = await history(c, addresses, NOW - timedelta(days=7), NOW, limit=20_000)
    assert len(body["values"]) == 20_000 and time.perf_counter() - started < 2.0
    assert body["complete_until"] == (NOW - timedelta(days=7) + 100 * MINUTE).isoformat()  # 200 addresses x 100 instants


# ---- /stats ---------------------------------------------------------------------------------------------------------------------


async def test_stats_counts_requests_by_route_rows_served_and_the_refusals():
    app = make_app(fail_every=2)
    async with client_for(app) as c, client_for(app, headers={}) as stranger:
        await c.get("/")
        await stranger.get("/points")  # refused with 401, but it was asked
        params = {"addresses": "M001_kW", "start": iso(NOW - timedelta(minutes=4)), "end": iso(NOW)}
        await c.get("/history", params=params)  # 5 rows
        await c.get("/history", params=params)  # 503
        await c.get("/read", params={"addresses": "M001_kW,M002_kW,NOPE"})  # 2 rows
        await c.post("/history")
        await c.get("/nowhere")
        stats = (await c.get("/stats")).json()
        again = (await c.get("/stats")).json()
    assert stats["requests"] == {"GET /": 1, "GET /points": 1, "GET /history": 2, "GET /read": 1, "POST /history": 1, "GET other": 1}
    assert stats["rows_served"] == 7 and stats["responses_503"] == 1 and stats["responses_429"] == 0
    assert again == stats  # reading /stats is not itself counted


# ---- the server: serve() starts it beside the others when it is given a port ------------------------------------------------------


async def test_serve_starts_the_historian_on_its_own_port_when_given_one():
    from dcdash.simulator.main import serve
    # two uvicorn servers in one process each install the signal handlers and put back what they found, in the order they stop: the
    # second to stop can put back the first one's dead handler, which would swallow a Ctrl-C in the rest of the test session
    saved = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    http, ua_port, mb_port, hist = free_ports(4)
    task = asyncio.create_task(serve(http_port=http, opcua_port=ua_port, modbus_port=mb_port, host="127.0.0.1", api_key="sim-key",
                                     historian_port=hist, historian=HistorianConfig(meters=3)))
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{hist}", headers={"X-API-Key": "sim-key"}) as c:
            async def up() -> bool:
                try:
                    return (await c.get("/")).status_code == 200
                except httpx.HTTPError:
                    return False

            await wait_for(up, True)
            assert (await c.get("/")).json()["history"] is True
            assert len((await c.get("/points")).json()["points"]) == 6 + len(BEHAVIOUR_TAGS)
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{http}", headers={"X-API-Key": "sim-key"}) as c:
            assert "history" not in (await c.get("/")).json()  # the plain simulator on 9000 is still the plain one
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)  # let the servers unwind before the handlers are put back
        for sig, handler in saved.items():
            signal.signal(sig, handler)
