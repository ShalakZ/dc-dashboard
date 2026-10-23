"""The two thresholds of the data freshness watchdog (w35): the stored setting, its bounds and what a broken value reads as."""

import pytest
from pydantic import ValidationError

from dcdash.core.db import get_sessionmaker
from dcdash.events import watchdog_settings as ws
from dcdash.events.watchdog_settings import FACTORY, WatchdogSettings


async def put_row(db, value) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('watchdog', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        value,
    )


def test_the_factory_values_are_5_minutes_and_6_hours():
    assert FACTORY == WatchdogSettings(stale_floor_minutes=5, not_advancing_hours=6)
    assert ws.KEY == "watchdog"
    assert (FACTORY.floor_seconds, FACTORY.not_advancing_seconds) == (300.0, 21_600.0)


def test_the_bounds_are_2_to_60_minutes_and_1_to_72_hours():
    assert ws.STALE_FLOOR_MINUTES_BOUNDS == (2, 60)
    assert ws.NOT_ADVANCING_HOURS_BOUNDS == (1, 72)


@pytest.mark.parametrize("minutes", [2, 5, 60])
@pytest.mark.parametrize("hours", [1, 6, 72])
def test_values_on_and_inside_the_bounds_are_kept(minutes, hours):
    assert ws.parse({"stale_floor_minutes": minutes, "not_advancing_hours": hours}) == WatchdogSettings(
        stale_floor_minutes=minutes, not_advancing_hours=hours
    )


@pytest.mark.parametrize(
    "stored",
    [
        None,
        [],
        "5",
        7,
        {},
        {"stale_floor_minutes": 10},                                        # not_advancing_hours missing
        {"not_advancing_hours": 10},                                        # stale_floor_minutes missing
        {"stale_floor_minutes": 1, "not_advancing_hours": 6},               # below the floor
        {"stale_floor_minutes": 61, "not_advancing_hours": 6},              # above the ceiling
        {"stale_floor_minutes": 5, "not_advancing_hours": 0},
        {"stale_floor_minutes": 5, "not_advancing_hours": 73},
        {"stale_floor_minutes": "5", "not_advancing_hours": 6},             # a text is not a number
        {"stale_floor_minutes": 5.5, "not_advancing_hours": 6},             # nor is a fraction
        {"stale_floor_minutes": True, "not_advancing_hours": 6},            # nor a boolean
        {"stale_floor_minutes": None, "not_advancing_hours": 6},
    ],
)
def test_a_missing_broken_or_out_of_bounds_value_reads_as_the_factory_values(stored):
    assert ws.parse(stored) == FACTORY


def test_an_unknown_key_in_a_stored_value_is_ignored_but_a_put_refuses_it():
    stored = {"stale_floor_minutes": 10, "not_advancing_hours": 12, "something": 1}
    assert ws.parse(stored) == WatchdogSettings(stale_floor_minutes=10, not_advancing_hours=12)
    with pytest.raises(ValidationError):
        WatchdogSettings.model_validate(stored)


async def test_nothing_stored_reads_as_the_factory_values(db):
    assert await ws.load_pool(db) == FACTORY
    async with get_sessionmaker()() as session:
        assert await ws.load(session) == FACTORY


async def test_a_stored_value_is_read_by_both_loaders(db):
    await put_row(db, {"stale_floor_minutes": 15, "not_advancing_hours": 24})
    expected = WatchdogSettings(stale_floor_minutes=15, not_advancing_hours=24)
    assert await ws.load_pool(db) == expected
    async with get_sessionmaker()() as session:
        assert await ws.load(session) == expected


@pytest.mark.parametrize("stored", [[1, 2], "text", 5, {"stale_floor_minutes": 1, "not_advancing_hours": 6}, {}])
async def test_a_broken_stored_value_never_raises_and_reads_as_the_factory_values(db, stored):
    await put_row(db, stored)
    assert await ws.load_pool(db) == FACTORY
    async with get_sessionmaker()() as session:
        assert await ws.load(session) == FACTORY


async def test_load_pool_never_raises_when_the_database_fails():
    class Broken:
        async def fetchval(self, *_args):
            raise RuntimeError("the pool is gone")

    assert await ws.load_pool(Broken()) == FACTORY
