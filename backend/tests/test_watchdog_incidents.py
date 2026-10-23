"""The `data.stale` incident (w35): `watchdog_incidents.step` turns the freshness verdict into one counted incident per source in the
journal, with one `data.recovered` event when it ends, against the real database. The figures worker calls the step; here it is called
by hand, the way the worker does once a minute."""
import logging
from datetime import datetime, timedelta, timezone

import pytest

from dcdash.collector import incidents as collector_incidents
from dcdash.core.db import get_sessionmaker
from dcdash.events import read as events_read
from dcdash.events import watchdog, watchdog_incidents as incidents
from dcdash.ingest.kinds import DATA_RECOVERED, DATA_STALE
from helpers import make_asset, make_latest, make_mapping, make_point, make_source

HOUR = 3600.0
AWKWARD = "Plant <O'Brien> 10.0.0.5:4840 secret=hunter2"
FORBIDDEN = ("O'Brien", "10.0.0.5", "4840", "hunter2", "123456")  # a name, an address, a secret and a value must never reach a message


@pytest.fixture(autouse=True)
def _forget():
    incidents.reset()
    yield
    incidents.reset()


async def held() -> bool:
    return True


async def step() -> incidents.StepResult:
    return await incidents.step(get_sessionmaker(), held_now=held)


# ---- the world -----------------------------------------------------------------------------------------------------------------


async def meter(db, source: int, name: str, metric: str = "energy_kwh", interval: int = 60) -> int:
    asset = await make_asset(db, name)
    point = await make_point(db, source, f"{name}.{metric}.10.0.0.5:4840")
    await make_mapping(db, point, asset, metric, interval)
    return point


async def read_now(db, point: int, *, changed: float = 60.0) -> None:
    """A healthy reading: Good a second ago, its value last changed `changed` seconds ago."""
    await make_latest(db, point, age=1, good_age=1, good_value=123456.789, changed_age=changed)


async def silent_for(db, point: int, seconds: float) -> None:
    await make_latest(db, point, age=seconds, good_age=seconds, good_value=123456.789, changed_age=seconds)


async def plant(db, name: str = "Plant", healthy: int = 9, silent: int = 3, oldest: float = 7800.0) -> tuple[int, list[int], list[int]]:
    """A source with `healthy + silent` power meters; the silent ones have had no good reading for `oldest`, `oldest - 100`, ... seconds."""
    source = await make_source(db, name)
    quiet, fine = [], []
    for index in range(silent):
        point = await meter(db, source, f"s{index}", "active_power_kw")
        await silent_for(db, point, oldest - 100 * index)
        quiet.append(point)
    for index in range(healthy):
        point = await meter(db, source, f"h{index}", "active_power_kw")
        await read_now(db, point)
        fine.append(point)
    return source, quiet, fine


async def heal(db, points: list[int]) -> None:
    for point in points:
        await read_now(db, point)


async def rows_of(db, kind: str = DATA_STALE):
    return await db.fetch("SELECT * FROM diag_events WHERE kind = $1 ORDER BY id", kind)


async def insert_open(db, source_id: int | None, **detail) -> int:
    """An open `data.stale` row as an earlier process could have left it."""
    return await db.fetchval(
        "INSERT INTO diag_events (level, component, source_id, kind, message, detail) VALUES ('error', 'figures', $1, $2, 'old', $3) RETURNING id",
        source_id, DATA_STALE, {"state": "open", "count": 4, **detail},
    )


def when(value: str) -> datetime:
    return datetime.fromisoformat(value)


def no_private_words(*texts: object) -> None:
    for text_ in texts:
        for word in FORBIDDEN:
            assert word not in str(text_), (word, text_)


# ---- opening, bumping, closing -------------------------------------------------------------------------------------------------


async def test_the_incident_opens_on_the_second_evaluation_in_a_row_and_not_on_the_first(db):
    source, _, _ = await plant(db)

    first = await step()
    assert (first.waiting, first.opened, first.bumped) == ([source], [], [])
    assert await rows_of(db) == []

    second = await step()
    assert (second.waiting, second.opened, second.bumped) == ([], [source], [])
    (row,) = await rows_of(db)
    assert (row["level"], row["component"], row["source_id"], row["code"]) == ("error", "figures", source, None)
    assert row["message"] == "3 of 12 meters have had no good reading for up to 2 h 10 min"
    detail = row["detail"]
    assert (detail["state"], detail["count"], detail["meters"], detail["stale"], detail["not_advancing"], detail["frozen"]) == ("open", 1, 12, 3, 0, False)
    assert detail["oldest_stale_age_seconds"] == pytest.approx(7800, abs=5)
    assert abs((when(detail["since"]) - (datetime.now(timezone.utc) - timedelta(seconds=7800))).total_seconds()) < 10  # it began when the silence began
    assert "last_at" in detail and "closed_at" not in detail and "closed_by" not in detail


async def test_the_row_reads_as_an_incident_on_the_events_page(db):
    source, _, _ = await plant(db)
    await step()
    await step()
    (row,) = await rows_of(db)
    view = events_read.incident(row["ts"], row["detail"], datetime.now(timezone.utc))
    assert view is not None and (view["state"], view["count"]) == ("open", 1)
    assert view["duration_seconds"] == pytest.approx(7800, abs=10)
    assert abs((view["first_at"] - (datetime.now(timezone.utc) - timedelta(seconds=7800))).total_seconds()) < 10


async def test_every_later_evaluation_bumps_the_one_row(db):
    source, _, _ = await plant(db)
    for _ in range(2):
        await step()
    third = await step()
    fourth = await step()
    assert (third.bumped, fourth.bumped, third.opened, fourth.opened) == ([source], [source], [], [])
    (row,) = await rows_of(db)
    assert row["detail"]["count"] == 3 and row["detail"]["state"] == "open"
    assert row["detail"]["since"] is not None


async def test_a_blip_of_one_evaluation_leaves_no_trace(db):
    source, quiet, _ = await plant(db)
    await step()  # trouble, seen once
    await heal(db, quiet)
    clean = await step()  # gone again: nothing was open, so nothing is written
    assert (clean.recovered, clean.opened) == ([], [])
    await silent_for(db, quiet[0], 900)
    again = await step()  # the count of consecutive evaluations started over
    assert (again.waiting, again.opened) == ([source], [])
    assert await rows_of(db) == [] and await rows_of(db, DATA_RECOVERED) == []


async def test_it_recovers_with_exactly_one_data_recovered_event(db):
    source, quiet, _ = await plant(db)
    for _ in range(3):
        await step()
    await heal(db, quiet)

    result = await step()
    assert result.recovered == [source]
    (row,) = await rows_of(db)
    detail = row["detail"]
    assert (detail["state"], detail["closed_by"], detail["count"]) == ("closed", "recovered", 2)
    assert detail["duration_seconds"] == pytest.approx(7800, abs=10) and "closed_at" in detail
    (event,) = await rows_of(db, DATA_RECOVERED)
    assert (event["level"], event["component"], event["source_id"], event["code"]) == ("info", "figures", source, None)
    assert event["message"] == "meters reporting again after 2 h 10 min"
    assert event["detail"]["incident_id"] == row["id"] and event["detail"]["meters"] == 12
    assert event["detail"]["stale_seconds"] == pytest.approx(7800, abs=10)

    await step()
    await step()
    assert len(await rows_of(db, DATA_RECOVERED)) == 1 and len(await rows_of(db)) == 1  # nothing more is written


async def test_a_new_trouble_after_a_recovery_is_a_new_incident(db):
    source, quiet, _ = await plant(db)
    for _ in range(2):
        await step()
    await heal(db, quiet)
    await step()
    await silent_for(db, quiet[0], 1200)
    await step()
    reopened = await step()
    assert reopened.opened == [source]
    rows = await rows_of(db)
    assert [r["detail"]["state"] for r in rows] == ["closed", "open"] and rows[1]["detail"]["count"] == 1


async def test_a_restart_continues_the_open_row(db):
    source, _, _ = await plant(db)
    for _ in range(3):
        await step()
    incidents.reset()  # the process restarted: it remembers nothing
    assert (await step()).waiting == [source]
    after = await step()
    assert (after.bumped, after.opened) == ([source], [])
    (row,) = await rows_of(db)
    assert row["detail"]["count"] == 3  # 1 opened, 1 bumped before the restart, 1 after


async def test_two_open_rows_left_by_overlapping_processes_close_together_with_one_recovery(db):
    source, quiet, _ = await plant(db)
    first = await insert_open(db, source, since=(datetime.now(timezone.utc) - timedelta(hours=3)).isoformat())
    second = await insert_open(db, source)
    await heal(db, quiet)

    result = await step()
    assert result.recovered == [source]
    rows = await rows_of(db)
    assert [(r["id"], r["detail"]["state"], r["detail"]["closed_by"]) for r in rows] == [(first, "closed", "recovered"), (second, "closed", "recovered")]
    (event,) = await rows_of(db, DATA_RECOVERED)
    assert event["detail"]["incident_id"] == first
    assert event["message"] == "meters reporting again after 3 h"  # the longest of the two


async def test_two_open_rows_are_bumped_once_and_the_newest_only(db):
    source, _, _ = await plant(db)
    older = await insert_open(db, source)
    newer = await insert_open(db, source)
    await step()
    await step()
    by_id = {r["id"]: r for r in await rows_of(db)}
    assert set(by_id) == {older, newer}
    assert by_id[older]["detail"]["count"] == 4 and by_id[newer]["detail"]["count"] == 5


# ---- the level, the words ------------------------------------------------------------------------------------------------------


async def counters_site(db, name: str = "Plant") -> tuple[int, list[int], int]:
    """A source with three energy counters, two of which have stood still for 7 and 8 hours while the third rises, and a voltage that moves:
    the slow counters are soft (not a frozen source)."""
    source = await make_source(db, name)
    counters = [await meter(db, source, f"c{index}", "energy_kwh") for index in range(3)]
    await read_now(db, counters[0], changed=7 * HOUR)
    await read_now(db, counters[1], changed=8 * HOUR)
    await read_now(db, counters[2], changed=60)
    voltage = await meter(db, source, "v", "voltage_v")
    await read_now(db, voltage, changed=5)
    return source, counters, voltage


async def test_slow_counters_alone_are_a_warning_and_a_silent_meter_that_appears_makes_it_an_error(db):
    source, counters, _ = await counters_site(db)
    await step()
    await step()
    (row,) = await rows_of(db)
    assert row["level"] == "warning"
    assert row["message"] == "2 of 3 energy counters have not risen for up to 8 h"
    assert (row["detail"]["stale"], row["detail"]["not_advancing"], row["detail"]["frozen"]) == (0, 2, False)
    assert row["detail"]["oldest_stale_age_seconds"] is None

    extra = await meter(db, source, "gone", "active_power_kw")
    await silent_for(db, extra, 900)
    await step()
    (row,) = await rows_of(db)
    assert row["level"] == "error" and row["detail"]["count"] == 2  # the same row, bumped, now an error
    assert row["message"] == "1 of 4 meters has had no good reading for 15 min; 2 of 3 energy counters have not risen for up to 8 h"
    assert (row["detail"]["stale"], row["detail"]["not_advancing"]) == (1, 2)

    await silent_for(db, extra, 1)
    await read_now(db, extra)
    await step()
    (row,) = await rows_of(db)
    assert row["level"] == "warning" and row["detail"]["count"] == 3  # and back to a warning when only the counters are left


async def test_a_frozen_source_is_an_error_that_says_each_counter_reads_good(db):
    source = await make_source(db, "Plant")
    first = await meter(db, source, "c1", "energy_kwh")
    second = await meter(db, source, "c2", "energy_kwh")
    voltage = await meter(db, source, "v", "voltage_v")
    await read_now(db, first, changed=7 * HOUR)
    await read_now(db, second, changed=8 * HOUR)
    await read_now(db, voltage, changed=9 * HOUR)  # nothing else moves either: a server serving cached values
    await step()
    await step()
    (row,) = await rows_of(db)
    assert row["level"] == "error"
    assert row["message"] == "every energy counter of this source has stood still for 7 h although each reads Good"
    assert (row["detail"]["frozen"], row["detail"]["stale"], row["detail"]["not_advancing"]) == (True, 2, 0)
    assert row["detail"]["oldest_stale_age_seconds"] == pytest.approx(8 * HOUR, abs=10)
    assert abs((when(row["detail"]["since"]) - (datetime.now(timezone.utc) - timedelta(hours=8))).total_seconds()) < 10


async def test_the_words_are_singular_for_one_meter(db):
    source = await make_source(db, "Plant")
    only = await meter(db, source, "only", "active_power_kw")
    await silent_for(db, only, 7200)
    await step()
    await step()
    (row,) = await rows_of(db)
    assert row["message"] == "1 of 1 meter has had no good reading for 2 h"


async def test_a_message_and_a_detail_never_name_a_source_an_address_or_a_value(db):
    source, _, _ = await plant(db, name=AWKWARD)
    other, _, _ = await counters_site(db, name=AWKWARD + " 2")
    for _ in range(3):
        await step()
    rows = await rows_of(db)
    assert len(rows) == 2
    for row in rows:
        no_private_words(row["message"], row["detail"], row["code"])
    assert {row["source_id"] for row in rows} == {source, other}


async def test_the_incident_and_the_chip_agree_on_the_same_data(db):
    await plant(db)
    await counters_site(db, name="Second")
    for _ in range(2):
        await step()
    verdict = await watchdog.compute_verdict(get_sessionmaker())
    rows = {row["source_id"]: row["detail"] for row in await rows_of(db)}
    assert set(rows) == set(verdict.sources) and len(rows) == 2
    for source_id, sv in verdict.sources.items():
        detail = rows[source_id]
        assert (detail["meters"], detail["stale"], detail["not_advancing"], detail["frozen"]) == (sv.meters, sv.stale, sv.not_advancing, sv.frozen)
        if sv.oldest_stale_age_seconds is None:
            assert detail["oldest_stale_age_seconds"] is None
        else:
            assert detail["oldest_stale_age_seconds"] == pytest.approx(sv.oldest_stale_age_seconds, abs=3)
    assert sum(d["stale"] for d in rows.values()) == verdict.stale and sum(d["not_advancing"] for d in rows.values()) == verdict.not_advancing


async def test_each_source_has_its_own_incident(db):
    broken, quiet, _ = await plant(db, name="Broken")
    mending, to_mend, _ = await plant(db, name="Mending", silent=1, healthy=2)
    for _ in range(2):
        await step()
    assert {r["source_id"] for r in await rows_of(db)} == {broken, mending}
    await heal(db, to_mend)
    result = await step()
    assert (result.recovered, result.bumped) == ([mending], [broken])
    states = {r["source_id"]: r["detail"]["state"] for r in await rows_of(db)}
    assert states == {broken: "open", mending: "closed"}
    assert [e["source_id"] for e in await rows_of(db, DATA_RECOVERED)] == [mending]


# ---- sources that are no longer judged ----------------------------------------------------------------------------------------------


async def test_a_disabled_source_closes_its_incident_as_polling_stopped_with_no_recovery(db):
    source, _, _ = await plant(db)
    for _ in range(2):
        await step()
    await db.execute("UPDATE sources SET enabled = false WHERE id = $1", source)

    result = await step()
    assert (result.stopped, result.recovered) == (1, [])
    (row,) = await rows_of(db)
    assert (row["detail"]["state"], row["detail"]["closed_by"]) == ("closed", "polling_stopped")
    assert await rows_of(db, DATA_RECOVERED) == []
    again = await step()
    assert again.stopped == 0


async def test_a_deleted_source_closes_its_incident_as_polling_stopped(db):
    source, quiet, _ = await plant(db)
    kept, _, _ = await plant(db, name="Kept")
    for _ in range(2):
        await step()
    await db.execute("DELETE FROM sources WHERE id = $1", source)  # (the journal has no foreign key: the rows stay, with the id of a source that is gone)

    result = await step()
    assert result.stopped == 1
    by_source = {r["source_id"]: r["detail"] for r in await rows_of(db)}
    assert by_source[source]["closed_by"] == "polling_stopped" and by_source[source]["state"] == "closed"
    assert by_source[kept]["state"] == "open"  # the source that is still judged keeps its incident
    assert await rows_of(db, DATA_RECOVERED) == []


async def test_with_no_judged_source_at_all_every_open_incident_is_closed(db):
    orphan = await insert_open(db, 77)
    nobody = await insert_open(db, None)
    source = await make_source(db, "No billing meter")
    await meter(db, source, "v", "voltage_v")  # a source with no billing meter is not judged
    stale_source = await insert_open(db, source)

    result = await step()
    assert (result.verdict is not None and result.verdict.sources == {}) and result.stopped == 3
    rows = {r["id"]: r["detail"] for r in await rows_of(db)}
    assert set(rows) == {orphan, nobody, stale_source}
    assert all(d["state"] == "closed" and d["closed_by"] == "polling_stopped" for d in rows.values())
    assert await rows_of(db, DATA_RECOVERED) == []


async def test_a_source_whose_meters_all_wait_keeps_its_row_as_it_is(db):
    source = await make_source(db, "New")
    for index in range(3):
        await meter(db, source, f"n{index}", "energy_kwh")  # mapped, never read: waiting
    row_id = await insert_open(db, source)
    before = (await rows_of(db))[0]["detail"]

    for _ in range(3):
        result = await step()
        assert (result.recovered, result.bumped, result.opened, result.stopped, result.waiting) == ([], [], [], 0, [])
    (row,) = await rows_of(db)
    assert row["id"] == row_id and row["detail"] == before
    assert await rows_of(db, DATA_RECOVERED) == []


# ---- what must not be written ------------------------------------------------------------------------------------------------


async def test_a_failed_verdict_writes_nothing_and_closes_nothing(db, monkeypatch, caplog):
    source, quiet, _ = await plant(db)
    for _ in range(2):
        await step()
    orphan = await insert_open(db, 99)  # a reconcile would close this one
    await heal(db, quiet)  # and a clean verdict would close the first one
    before = await rows_of(db)

    real = incidents.compute_verdict

    async def broken(_sessions):
        raise RuntimeError("the database is away")

    monkeypatch.setattr(incidents, "compute_verdict", broken)
    caplog.set_level(logging.WARNING, logger=incidents.log.name)
    result = await step()
    assert result.verdict is None and (result.opened, result.bumped, result.recovered, result.stopped) == ([], [], [], 0)
    assert await rows_of(db) == before and await rows_of(db, DATA_RECOVERED) == []
    assert any("RuntimeError" in r.getMessage() and "the verdict could not be computed" in r.getMessage() for r in caplog.records)
    assert {r["id"]: r["detail"]["state"] for r in await rows_of(db)}[orphan] == "open"
    monkeypatch.setattr(incidents, "compute_verdict", real)
    assert (await step()).recovered == [source]  # and the next good evaluation does what it should


async def test_a_failed_verdict_does_not_break_the_count_of_consecutive_evaluations(db, monkeypatch):
    source, _, _ = await plant(db)
    await step()
    real = incidents.compute_verdict

    async def broken(_sessions):
        raise RuntimeError("away")

    monkeypatch.setattr(incidents, "compute_verdict", broken)
    await step()
    monkeypatch.setattr(incidents, "compute_verdict", real)
    assert (await step()).opened == [source]


async def test_a_worker_that_no_longer_holds_the_lock_writes_nothing(db):
    source, quiet, _ = await plant(db)
    await step()
    calls = []

    async def lost() -> bool:
        calls.append(True)
        return False

    result = await incidents.step(get_sessionmaker(), held_now=lost)
    assert result.lost_lock and result.opened == [] and calls == [True]
    assert await rows_of(db) == []
    orphan = await insert_open(db, 99)
    again = await incidents.step(get_sessionmaker(), held_now=lost)
    assert again.lost_lock and again.stopped == 0
    assert (await rows_of(db))[0]["detail"]["state"] == "open"
    assert orphan


async def test_held_now_may_be_a_plain_function(db):
    source, _, _ = await plant(db)
    await incidents.step(get_sessionmaker(), held_now=lambda: True)
    assert (await incidents.step(get_sessionmaker(), held_now=lambda: True)).opened == [source]


async def test_a_database_error_on_one_source_does_not_stop_the_others_and_warns_once(db, monkeypatch, caplog):
    first, _, _ = await plant(db, name="First")
    second, _, _ = await plant(db, name="Second")
    await step()
    real = incidents._open_or_bump

    async def flaky(sessions, sv):
        if sv.source_id == first:
            raise RuntimeError("deadlock detected")
        return await real(sessions, sv)

    monkeypatch.setattr(incidents, "_open_or_bump", flaky)
    caplog.set_level(logging.WARNING, logger=incidents.log.name)
    result = await step()
    assert result.errors == 1 and result.opened == [second]
    await step()
    assert sum("could not be written (RuntimeError)" in r.getMessage() for r in caplog.records) == 1  # throttled, and the message of the error is not quoted
    assert [r["source_id"] for r in await rows_of(db)] == [second]


async def test_a_statement_with_a_damaged_row_still_works(db):
    source, _, _ = await plant(db)
    await insert_open(db, source, count="many", since="yesterday-ish")  # edited by hand
    await step()
    bumped = await step()
    assert bumped.bumped == [source]
    (row,) = await rows_of(db)
    assert row["detail"]["count"] == 1  # a damaged count counts as 0
    await heal(db, [r["point_id"] for r in await db.fetch("SELECT point_id FROM mappings")])
    assert (await step()).recovered == [source]


def test_the_collectors_reconcile_never_touches_the_kind():
    assert DATA_STALE not in collector_incidents.KINDS and DATA_RECOVERED not in collector_incidents.KINDS
