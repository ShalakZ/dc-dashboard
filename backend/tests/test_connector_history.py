"""The history interface on Connector (w30 R4, R10) and its implementation on the simulator connector, pointed at the stand-in Historian.

No Docker, no sockets: the stand-in app is driven through httpx.ASGITransport with a fake clock; the cases the stand-in cannot produce (junk
answers, header spellings, request counts) use httpx.MockTransport. Wire format: plan D9; the rules applied: dcdash/ingest/normalise.py.
"""
import asyncio
import subprocess
import sys
from datetime import UTC, datetime, timedelta, timezone
from email.utils import format_datetime

import httpx
import pytest

from dcdash.connectors.base import BAD, GOOD, ConnectionCheck, Connector, ConnectorError, HistoryPage, create_connector
from dcdash.connectors.simulator import CHUNK, THREAD_ABOVE, SimulatorConfig, SimulatorConnector
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.historian import ANCHOR, QUALITIES, HistorianConfig, create_historian_app
from dcdash.simulator.model import Simulator

NOW = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
MINUTE = timedelta(minutes=1)
LABELS = ("uncertain", "bad", "substituted", "interpolated")


class Clock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def connector(clock=None, **settings) -> SimulatorConnector:
    app = create_historian_app(HistorianConfig(**settings), clock=clock or Clock(), api_key="k")
    return SimulatorConnector(SimulatorConfig(url="http://hist"), "k", transport=httpx.ASGITransport(app=app))


def mocked(handler) -> SimulatorConnector:
    return SimulatorConnector(SimulatorConfig(url="http://hist"), "k", transport=httpx.MockTransport(handler))


def at(day: str, clock_time: str = "00:00") -> datetime:
    return datetime.fromisoformat(f"{day}T{clock_time}:00+00:00")


def by_pair(values) -> dict:
    return {(v.address, v.ts): v for v in values}


async def walk(c: SimulatorConnector, addresses: list[str], start: datetime, end: datetime) -> tuple[list, list[datetime]]:
    """Every page of an answer cut by the row limit, each continued from the previous `complete_until` with the last instant received."""
    values, cuts, cursor, after = [], [], start, {}
    while True:
        page = await c.read_history(addresses, cursor, end, after=after)
        values += page.values
        after.update({v.address: v.ts for v in page.values})
        if page.complete_until >= end:
            # Rows AT complete_until may be missing (an answer cut right at `end`): the next window starts AT it, so ask once more.
            values += (await c.read_history(addresses, end, end, after=after)).values
            return values, cuts
        assert page.complete_until > cursor, "a cut answer must make progress"
        cuts.append(page.complete_until)
        cursor = page.complete_until


# ---- the interface -----------------------------------------------------------------------------------------------------------


class Bare(Connector):
    type = "bare-test"

    async def test(self) -> ConnectionCheck:
        return ConnectionCheck(True, "ok")

    async def browse(self) -> list:
        return []

    async def read(self, addresses: list[str]) -> list:
        return []


def test_the_base_class_has_no_history():
    assert Connector.supports_history is False and Bare.supports_history is False


async def test_the_default_read_history_says_not_supported():
    with pytest.raises(ConnectorError) as raised:
        await Bare(object()).read_history(["a"], NOW - MINUTE, NOW)
    assert raised.value.status == "not_supported" and raised.value.retry_after is None


def test_connector_error_takes_retry_after_by_keyword_and_defaults_to_none():
    assert ConnectorError("timeout", "slow").retry_after is None
    error = ConnectorError("rate_limited", "wait", retry_after=2.5)
    assert (error.status, error.message, error.retry_after, str(error)) == ("rate_limited", "wait", 2.5, "wait")
    with pytest.raises(TypeError):
        ConnectorError("rate_limited", "wait", 2.5)  # type: ignore[misc]


def test_a_history_page_is_frozen_and_has_defaults():
    page = HistoryPage([], NOW)
    assert (page.rejected, page.unknown) == (0, ())
    with pytest.raises(AttributeError):
        page.rejected = 1  # type: ignore[misc]


@pytest.mark.parametrize("kind, config", [("opcua", {"endpoint": "opc.tcp://nowhere:4840"}), ("modbus", {"host": "nowhere"})])
async def test_opcua_and_modbus_keep_no_history(kind, config):
    other = create_connector(kind, config)
    assert type(other).supports_history is False
    with pytest.raises(ConnectorError) as raised:
        await other.read_history(["a"], NOW - MINUTE, NOW)  # answers before it would connect to anything
    assert raised.value.status == "not_supported"


def test_the_simulator_connector_supports_history_and_either_import_order_works():
    assert SimulatorConnector.supports_history is True
    for first in ("dcdash.ingest.normalise", "dcdash.connectors.simulator", "dcdash.connectors.base"):  # normalise imports connectors.base
        done = subprocess.run([sys.executable, "-c", f"import {first}; import dcdash.connectors.simulator"], capture_output=True, text=True)
        assert done.returncode == 0, done.stderr


# ---- the contract on the simulator connector, against the stand-in ------------------------------------------------------------


async def test_raw_samples_come_back_as_aware_utc_instants_of_the_source():
    page = await connector().read_history(["M001_kW"], NOW - 5 * MINUTE, NOW)
    assert [v.ts for v in page.values] == [NOW - i * MINUTE for i in range(5, -1, -1)]  # start and end inclusive, ascending
    assert all(v.ts.tzinfo is not None and v.ts.utcoffset() == timedelta(0) for v in page.values)
    assert all(v.quality == GOOD and v.status is None and isinstance(v.value, float) for v in page.values)
    assert page.complete_until == NOW and (page.rejected, page.unknown) == (0, ())


async def test_values_keep_the_sources_unit_and_number():
    c = connector()
    wh = await c.read_history(["UNIT_Wh"], NOW, NOW)
    kwh = await c.read_history(["M001_kWh"], NOW, NOW)
    assert wh.values[0].value == pytest.approx(kwh.values[0].value * 1000, abs=1)  # the Wh counter is not scaled to kWh here (abs: the kWh figure is rounded)


@pytest.mark.parametrize("address, offset", [
    ("M001_kW", 0), ("INTERVAL_kWh", 0), ("INTERVAL_kWh", 7), ("LOCAL_kWh", 0), ("LOCAL_kWh", 3),
    *(("BADQ_kW", minute) for minute in range(5)),  # every quality in turn
])
async def test_a_live_value_and_its_history_twin_are_one_pair(address, offset):
    c = connector(Clock(NOW + offset * MINUTE))
    (live,) = await c.read([address])
    page = await c.read_history([address], NOW - timedelta(hours=1), NOW + offset * MINUTE)
    twins = [v for v in page.values if v.ts == live.ts]
    assert twins == [live]  # the same address, instant, value, quality and status


async def test_a_live_local_time_in_the_repeated_hour_is_dropped_never_guessed():
    inside = connector(Clock(at("2026-10-25", "00:30")))  # 02:30 in Berlin, which is shown twice
    assert await inside.read(["LOCAL_kWh", "M001_kW"]) == [(await inside.read(["M001_kW"]))[0]]  # only the unambiguous tag answers
    after = connector(Clock(at("2026-10-25", "03:30")))
    (value,) = await after.read(["LOCAL_kWh"])
    assert value.ts == at("2026-10-25", "03:30")


async def test_quality_good_is_good_and_every_other_code_is_bad_with_its_label():
    page = await connector().read_history(["BADQ_kW"], NOW - 29 * MINUTE, NOW)
    assert len(page.values) == 30
    for v in page.values:
        label = QUALITIES[(v.ts - ANCHOR) // MINUTE % len(QUALITIES)]
        if label == "good":
            assert (v.quality, v.status) == (GOOD, None)
        else:
            assert (v.quality, v.status) == (BAD, label) and isinstance(v.value, float)  # kept as evidence, out of every figure
    assert {v.status for v in page.values} == {None, *LABELS}


async def test_a_local_time_across_the_spring_change_gives_the_right_instants():
    c = connector(Clock(at("2026-03-30")))
    start, end = at("2026-03-29"), at("2026-03-29", "04:00")  # 02:00 CET jumps to 03:00 CEST at 01:00 UTC
    page = await c.read_history(["LOCAL_kWh", "M001_kWh"], start, end)
    local = [v for v in page.values if v.address == "LOCAL_kWh"]
    assert [v.ts for v in local] == [start + i * MINUTE for i in range(241)] and page.rejected == 0  # nothing lost, nothing doubled
    plain = {v.ts: v.value for v in page.values if v.address == "M001_kWh"}
    assert all(plain[v.ts] == v.value for v in local)  # the same counter, so the same number at the same instant


async def test_a_local_time_across_the_autumn_change_resolves_the_repeated_hour_by_order():
    c = connector(Clock(at("2026-10-26")))
    start, end = at("2026-10-24", "23:00"), at("2026-10-25", "04:00")  # 02:00-03:00 CEST then 02:00-03:00 CET again: 00:00-02:00 UTC
    page = await c.read_history(["LOCAL_kWh", "M001_kWh"], start, end)
    local = [v for v in page.values if v.address == "LOCAL_kWh"]
    assert [v.ts for v in local] == [start + i * MINUTE for i in range(301)] and page.rejected == 0
    plain = {v.ts: v.value for v in page.values if v.address == "M001_kWh"}
    assert all(plain[v.ts] == v.value for v in local)  # the second pass did not land on the first


async def test_a_window_that_starts_inside_the_repeated_hour_is_refused_without_after_and_resolved_with_it():
    c = connector(Clock(at("2026-10-26")))
    start, end = at("2026-10-25"), at("2026-10-25", "04:00")
    blind = await c.read_history(["LOCAL_kWh"], start, end)  # nothing tells the first pass from the second
    assert blind.rejected == 120 and blind.values[0].ts == at("2026-10-25", "02:00")  # the two ambiguous hours: counted, never guessed
    told = await c.read_history(["LOCAL_kWh"], start, end, after={"LOCAL_kWh": start - MINUTE})
    assert told.rejected == 0 and [v.ts for v in told.values] == [start + i * MINUTE for i in range(241)]


async def test_a_stale_after_does_not_pull_a_second_pass_time_back_onto_the_first_pass():
    c = connector(Clock(at("2026-10-26")))
    start, end = at("2026-10-25", "01:00"), at("2026-10-25", "02:00")  # the second pass of 02:00-03:00 Berlin
    page = await c.read_history(["LOCAL_kWh"], start, end, after={"LOCAL_kWh": at("2026-10-24", "22:00")})
    assert [v.ts for v in page.values] == [start + i * MINUTE for i in range(61)] and page.rejected == 0  # nothing at 00:xx


async def test_a_page_cut_inside_the_repeated_hour_continues_without_a_gap_or_a_mistake():
    clock = Clock(at("2026-10-26"))
    start, end = at("2026-10-24", "23:00"), at("2026-10-25", "04:00")
    whole = await connector(clock).read_history(["LOCAL_kWh", "M001_kWh"], start, end)
    # An odd row limit with two tags cuts between the two tags of one instant, so the next page re-reads a value it already has.
    values, cuts = await walk(connector(clock, max_rows=81), ["LOCAL_kWh", "M001_kWh"], start, end)
    assert any(at("2026-10-25") <= cut < at("2026-10-25", "02:00") for cut in cuts)  # a cut really fell in the repeated hour
    assert len(cuts) >= 6
    assert by_pair(values) == by_pair(whole.values) and len(by_pair(values)) == 602


async def test_the_interval_tag_is_moved_back_by_its_period_so_the_last_quarter_hour_of_a_month_stays_in_it():
    c = connector(Clock(at("2026-03-02")))
    start, end = at("2026-02-28", "23:00"), at("2026-03-01", "01:00")
    page = await c.read_history(["INTERVAL_kWh", "M001_kWh"], start, end)
    interval = {v.ts: v.value for v in page.values if v.address == "INTERVAL_kWh"}
    counter = {v.ts: v.value for v in page.values if v.address == "M001_kWh"}
    assert min(interval) == at("2026-02-28", "22:45") and max(interval) == at("2026-03-01", "00:45")  # the stamps 23:00 to 01:00, less 15 min
    assert at("2026-02-28", "23:45") in interval and interval[at("2026-02-28", "23:45")] > 0  # stamped 00:00 on 1 March, a February value
    assert all(ts.minute % 15 == 0 for ts in interval)
    for ts, energy in interval.items():  # the energy of [ts, ts + 15 min) is the counter's rise over it
        if ts + 15 * MINUTE in counter and ts in counter:
            assert counter[ts + 15 * MINUTE] - counter[ts] == pytest.approx(energy, abs=2e-3)


async def test_the_gap_tag_has_a_hole_and_nothing_stands_in_for_it():
    page = await connector(Clock(at("2026-03-02"))).read_history(["GAP_kWh"], at("2026-03-01", "02:00"), at("2026-03-01", "07:00"))
    stamps = {v.ts for v in page.values}
    expected = {at("2026-03-01", "02:00") + i * MINUTE for i in range(60)} | {at("2026-03-01", "06:00") + i * MINUTE for i in range(61)}
    assert stamps == expected and page.rejected == 0


async def test_the_dup_tag_comes_back_twice_because_only_the_store_de_duplicates():
    page = await connector().read_history(["DUP_kWh"], NOW - 4 * MINUTE, NOW)
    assert len(page.values) == 10
    for ts in {v.ts for v in page.values}:
        twins = [v for v in page.values if v.ts == ts]
        assert len(twins) == 2 and twins[0] == twins[1]


async def test_a_cut_answer_stops_early_and_the_next_call_from_complete_until_continues_exactly():
    c = connector(max_rows=25)
    start, end = NOW - timedelta(hours=2), NOW
    first = await c.read_history(["M001_kWh", "M002_kWh"], start, end)
    assert len(first.values) == 25 and start < first.complete_until < end
    whole = await connector().read_history(["M001_kWh", "M002_kWh"], start, end)
    values, cuts = await walk(c, ["M001_kWh", "M002_kWh"], start, end)
    assert cuts[0] == first.complete_until and cuts == sorted(set(cuts))
    assert by_pair(values) == by_pair(whole.values) and len(by_pair(values)) == 242


async def test_an_unknown_address_lands_in_unknown_and_the_rest_is_answered():
    page = await connector().read_history(["M001_kW", "NOPE_kW"], NOW - MINUTE, NOW)
    assert page.unknown == ("NOPE_kW",) and {v.address for v in page.values} == {"M001_kW"}


async def test_no_address_means_no_request_and_complete_until_is_the_end():
    def refuse(request):
        raise AssertionError("no request expected")

    page = await mocked(refuse).read_history([], NOW - MINUTE, NOW)
    assert page == HistoryPage([], NOW)


async def test_a_naive_time_and_a_resolution_are_refused():
    c = connector()
    with pytest.raises(ValueError):
        await c.read_history(["M001_kW"], datetime(2026, 3, 1, 11, 0), NOW)
    with pytest.raises(ValueError):
        await c.read_history(["M001_kW"], NOW - MINUTE, NOW, after={"M001_kW": datetime(2026, 3, 1, 11, 0)})
    with pytest.raises(ConnectorError) as raised:
        await c.read_history(["M001_kW"], NOW - MINUTE, NOW, resolution=timedelta(minutes=15))
    assert raised.value.status == "not_supported"


async def test_a_start_with_an_offset_is_asked_in_utc():
    asked = []

    def handler(request):
        asked.append(dict(request.url.params))
        return httpx.Response(200, json={"values": [], "complete_until": "2026-03-01T12:00:00+00:00"})

    berlin = timezone(timedelta(hours=1))
    await mocked(handler).read_history(["a"], datetime(2026, 3, 1, 11, 0, tzinfo=berlin), datetime(2026, 3, 1, 13, 0, tzinfo=berlin))
    assert asked == [{"addresses": "a", "start": "2026-03-01T10:00:00+00:00", "end": "2026-03-01T12:00:00+00:00"}]


# ---- what the plain simulator and a failing source say ---------------------------------------------------------------------------


async def test_pointed_at_the_plain_simulator_history_is_not_supported():
    transport = httpx.ASGITransport(app=create_sim_app(Simulator(), api_key="k"))
    c = SimulatorConnector(SimulatorConfig(url="http://sim"), "k", transport=transport)
    with pytest.raises(ConnectorError) as raised:
        await c.read_history(["LVP01_kW"], NOW - MINUTE, NOW)
    assert raised.value.status == "not_supported"
    (value,) = await c.read(["LVP01_kW"])  # and a live read is exactly what it was
    assert value.quality == GOOD and value.status is None and value.ts.tzinfo is not None


async def test_the_stand_ins_503_and_429_become_connector_errors_with_the_wait():
    failing = connector(fail_every=1)
    with pytest.raises(ConnectorError) as raised:
        await failing.read_history(["M001_kW"], NOW - MINUTE, NOW)
    assert raised.value.status == "unreachable" and raised.value.retry_after is None
    limited = connector(rate=1)
    await limited.read_history(["M001_kW"], NOW - MINUTE, NOW)
    with pytest.raises(ConnectorError) as raised:
        await limited.read_history(["M001_kW"], NOW - MINUTE, NOW)
    assert raised.value.status == "rate_limited" and raised.value.retry_after == 1.0


@pytest.mark.parametrize("code, status", [
    (404, "not_supported"), (429, "rate_limited"), (503, "unreachable"), (401, "auth_failed"), (403, "auth_failed"), (500, "protocol_error"),
])
async def test_every_status_of_the_history_call_has_its_connector_status(code, status):
    with pytest.raises(ConnectorError) as raised:
        await mocked(lambda request: httpx.Response(code)).read_history(["a"], NOW - MINUTE, NOW)
    assert raised.value.status == status


@pytest.mark.parametrize("code", [404, 429, 503])
async def test_read_and_test_keep_protocol_error_for_those_statuses(code):
    c = mocked(lambda request: httpx.Response(code, headers={"Retry-After": "7"}))
    with pytest.raises(ConnectorError) as raised:
        await c.read(["a"])
    assert raised.value.status == "protocol_error" and raised.value.retry_after is None
    check = await c.test()
    assert not check.ok and check.status == "protocol_error"


@pytest.mark.parametrize("header, seconds", [
    ("120", 120.0), ("0", 0.0), ("1.5", 1.5), (" 30 ", 30.0),
    ("", None), ("soon", None), ("-5", None), ("nan", None), ("inf", None), ("Wed, 99 Foo 2015 07:28:00 GMT", None),
    ("Wed, 21 Oct 2015 07:28:00 GMT", 0.0),  # a date in the past: ask again now
])
@pytest.mark.parametrize("code, status", [(429, "rate_limited"), (503, "unreachable")])
async def test_retry_after_may_be_seconds_or_a_date_and_junk_is_ignored(code, status, header, seconds):
    c = mocked(lambda request: httpx.Response(code, headers={"Retry-After": header}))
    with pytest.raises(ConnectorError) as raised:
        await c.read_history(["a"], NOW - MINUTE, NOW)
    assert raised.value.status == status and raised.value.retry_after == seconds


async def test_retry_after_as_a_http_date_is_the_seconds_until_then():
    header = format_datetime(datetime.now(UTC) + timedelta(seconds=90), usegmt=True)
    with pytest.raises(ConnectorError) as raised:
        await mocked(lambda request: httpx.Response(429, headers={"Retry-After": header})).read_history(["a"], NOW - MINUTE, NOW)
    assert 80 < raised.value.retry_after <= 90


@pytest.mark.parametrize("failure, status", [(httpx.ReadTimeout("slow"), "timeout"), (httpx.ConnectError("down"), "unreachable")])
async def test_a_timeout_and_a_dead_source_are_told_apart(failure, status):
    def handler(request):
        raise failure

    with pytest.raises(ConnectorError) as raised:
        await mocked(handler).read_history(["a"], NOW - MINUTE, NOW)
    assert raised.value.status == status


@pytest.mark.parametrize("body", [[], {"values": "x"}, {"complete_until": "2026-03-01T12:00:00+00:00"}])
async def test_an_answer_without_values_is_a_protocol_error(body):
    with pytest.raises(ConnectorError) as raised:
        await mocked(lambda request: httpx.Response(200, json=body)).read_history(["a"], NOW - MINUTE, NOW)
    assert raised.value.status == "protocol_error"


@pytest.mark.parametrize("until", [None, "soon", "2026-03-01T12:00:00", "2026-03-01"])
async def test_an_answer_without_a_usable_complete_until_is_a_protocol_error(until):
    body = {"values": [], "complete_until": until}
    with pytest.raises(ConnectorError) as raised:  # a mark must never move on a guess
        await mocked(lambda request: httpx.Response(200, json=body)).read_history(["a"], NOW - MINUTE, NOW)
    assert raised.value.status == "protocol_error"


async def test_items_the_rules_refuse_are_dropped_and_counted():
    good = {"address": "a", "ts": "2026-03-01T11:00:00+00:00", "value": 1.0, "quality": "good"}
    items = [
        good,
        {"address": "a", "ts": "garbage", "value": 1.0},                                  # not a time
        {"address": "a", "ts": "2026-03-01T11:01:00", "value": 1.0},                       # naive, no zone
        {"address": "a", "ts": "2026-03-29T02:30:00", "value": 1.0, "zone": "Europe/Berlin"},  # the hour that did not exist
        {"address": "a", "ts": "2026-03-01T11:02:00", "value": 1.0, "zone": "Mars/Olympus"},   # not a zone
        {"address": "a", "ts": "2026-03-01T11:03:00+00:00", "value": 1.0, "stamp": "end"},     # an end stamp with no period
        {"address": "a", "ts": "2026-03-01T11:04:00+00:00", "value": 1.0, "stamp": "middle", "period_seconds": 60},
        {"address": "a", "ts": "2026-03-01T11:05:00+00:00", "value": 1.0, "stamp": "end", "period_seconds": 0},
        {"ts": "2026-03-01T11:06:00+00:00", "value": 1.0},                                 # no address
        "junk",
    ]
    body = {"values": items, "complete_until": "2026-03-01T12:00:00+00:00", "unknown": ["z"]}
    page = await mocked(lambda request: httpx.Response(200, json=body)).read_history(["a"], NOW - timedelta(hours=2), NOW)
    assert [v.ts for v in page.values] == [at("2026-03-01", "11:00")] and page.rejected == 9 and page.unknown == ("z",)


async def test_a_value_that_is_not_a_number_is_bad_and_so_is_a_value_with_no_quality():
    items = [
        {"address": "a", "ts": "2026-03-01T11:00:00+00:00", "value": None, "quality": "good"},
        {"address": "a", "ts": "2026-03-01T11:01:00+00:00", "value": True, "quality": "good"},
        {"address": "a", "ts": "2026-03-01T11:02:00+00:00", "value": 4, "quality": 0},
        {"address": "a", "ts": "2026-03-01T11:03:00+00:00", "value": 5.0, "quality": 192},
        {"address": "a", "ts": "2026-03-01T11:04:00+00:00", "value": 6.0},  # only a good code is good
    ]
    body = {"values": items, "complete_until": "2026-03-01T12:00:00+00:00"}
    page = await mocked(lambda request: httpx.Response(200, json=body)).read_history(["a"], NOW - timedelta(hours=2), NOW)
    assert [(v.value, v.quality, v.status) for v in page.values] == [
        (None, BAD, None), (None, BAD, None), (4.0, GOOD, None), (5.0, BAD, "unknown:192"), (6.0, BAD, "unknown:none"),
    ]


# ---- size: 200 addresses a request, and a thread for a long answer ----------------------------------------------------------------


def fake_source(seen: list[list[str]]):
    def handler(request: httpx.Request) -> httpx.Response:
        asked = request.url.params["addresses"].split(",")
        seen.append(asked)
        index = len(seen)
        if request.url.path == "/read":
            return httpx.Response(200, json={"values": [{"address": a, "ts": "2026-03-01T12:00:00+00:00", "value": 1.0} for a in asked]})
        values = [{"address": a, "ts": "2026-03-01T11:00:00+00:00", "value": 1.0, "quality": "good"} for a in asked]
        values.append({"address": asked[0], "ts": "garbage", "value": 1.0})
        until = (NOW - timedelta(minutes=index)).isoformat()
        return httpx.Response(200, json={"values": values, "complete_until": until, "unknown": [f"gone{index}"]})

    return handler


async def test_4000_addresses_are_read_in_20_requests_of_200_and_concatenated_in_order():
    addresses = [f"A{n:04d}" for n in range(4000)]
    seen: list[list[str]] = []
    values = await mocked(fake_source(seen)).read(addresses)
    assert CHUNK == 200 and len(seen) == 20 and all(len(asked) == 200 for asked in seen)
    assert [v.address for v in values] == addresses


async def test_4000_addresses_of_history_are_20_requests_and_complete_until_is_the_earliest():
    addresses = [f"A{n:04d}" for n in range(4000)]
    seen: list[list[str]] = []
    page = await mocked(fake_source(seen)).read_history(addresses + addresses[:5], NOW - timedelta(hours=2), NOW)  # a repeated address is asked once
    assert len(seen) == 20 and all(len(asked) == 200 for asked in seen)
    assert [v.address for v in page.values] == addresses
    assert page.complete_until == NOW - 20 * MINUTE  # complete for every address means the earliest of the 20 answers
    assert page.rejected == 20 and page.unknown == tuple(f"gone{n}" for n in range(1, 21))


@pytest.mark.parametrize("method", ["read", "history"])
@pytest.mark.parametrize("count, threaded", [(THREAD_ABOVE, 0), (THREAD_ABOVE + 1, 1)])
async def test_an_answer_of_more_than_2000_items_is_converted_in_a_thread(monkeypatch, method, count, threaded):
    used: list[int] = []
    real = asyncio.to_thread

    async def spy(function, *args, **kwargs):
        used.append(len(args[0]))
        return await real(function, *args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", spy)
    start = at("2026-03-01")
    items = [{"address": "a", "ts": (start + n * timedelta(seconds=1)).isoformat(), "value": float(n), "quality": "good"} for n in range(count)]

    def handler(request):
        return httpx.Response(200, json={"values": items, "complete_until": NOW.isoformat()})

    c = mocked(handler)
    values = await c.read(["a"]) if method == "read" else (await c.read_history(["a"], start, NOW)).values
    assert [v.value for v in values] == [float(n) for n in range(count)] and len(used) == threaded
    assert used == [count] * threaded
