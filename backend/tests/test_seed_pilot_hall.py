"""The pilot-hall demo seed (w16): the shared machinery it borrows from the old history seeder takes a sample step, a batch writer
and an undo sentence of its own, and its layout and series are pure functions of a seed.

These tests do not touch the old layout's figures (`test_seed_history.py` pins those and runs unmodified). The first group needs no
database: it checks the plan arithmetic, the batch writer's checks and the undo texts of `dcdash.seed.history`."""
from datetime import date, datetime, timedelta, timezone

import pytest

from dcdash.seed import history

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
