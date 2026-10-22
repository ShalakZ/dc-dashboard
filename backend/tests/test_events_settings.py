"""How long system events are kept (w32): the stored setting, its two routes, the forecast of a shortening, and the hourly
housekeeping that deletes by it. Open incidents are never deleted; a closed one counts from the day it closed."""
from datetime import timedelta

import pytest

from dcdash.collector.housekeeping import housekeep
from dcdash.core.db import get_sessionmaker
from dcdash.events import settings as events_settings
from dcdash.events.settings import FACTORY, EventsSettings
from tests.helpers import login_as, make_role


async def put_row(db, value) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('events', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        value,
    )


async def add_rows(db, count: int, age: timedelta = timedelta(0), *, state: str | None = None, closed_ago: timedelta | None = None) -> None:
    """`count` journal rows `age` old; `state` "open" or "closed" gives them an incident detail (a closed one `closed_ago` ago)."""
    detail: dict[str, object] = {}
    if state is not None:
        detail["state"] = state
    await db.execute(
        "INSERT INTO diag_events (ts, level, component, kind, message, detail) "
        "SELECT now() - $1::interval, 'warning', 'collector', 'source.offline', 'event ' || n, "
        "       CASE WHEN $3::interval IS NULL THEN $2::jsonb "
        "            ELSE $2::jsonb || jsonb_build_object('closed_at', now() - $3::interval) END "
        "FROM generate_series(1, $4) AS n",
        age, detail, closed_ago, count,
    )


async def kept(db) -> int:
    return await db.fetchval("SELECT count(*) FROM diag_events")


async def audit_rows(db) -> list:
    return await db.fetch("SELECT actor_name, detail FROM audit_log WHERE action = 'events.retention_changed' ORDER BY id")


def test_the_factory_values_are_90_days_and_100000_rows():
    assert FACTORY == EventsSettings(retention_days=90, max_rows=100_000)
    assert events_settings.KEY == "events"


async def test_the_factory_values_are_used_when_nothing_is_stored(db):
    assert await events_settings.load_pool(db) == FACTORY
    async with get_sessionmaker()() as session:
        assert await events_settings.load(session) == FACTORY


@pytest.mark.parametrize(
    "stored",
    [
        {"retention_days": 3},                                    # max_rows missing
        {"retention_days": 3, "max_rows": 100_000},               # below the 7-day floor
        {"retention_days": 90, "max_rows": 5},                    # below the 10,000-row floor
        {"retention_days": 9000, "max_rows": 100_000},            # above the 400-day ceiling
        {"retention_days": "ninety", "max_rows": 100_000},        # not a number
        {"retention_days": True, "max_rows": 100_000},            # a boolean is not a number of days
        {"retention_days": 30.5, "max_rows": 100_000},            # not whole days
        [],                                                       # not an object
    ],
)
async def test_a_missing_broken_or_out_of_bounds_value_reads_as_the_factory_values(db, stored):
    await put_row(db, stored)
    assert await events_settings.load_pool(db) == FACTORY
    async with get_sessionmaker()() as session:
        assert await events_settings.load(session) == FACTORY


async def test_a_good_stored_value_is_read_back(db):
    await put_row(db, {"retention_days": 30, "max_rows": 50_000})
    assert await events_settings.load_pool(db) == EventsSettings(retention_days=30, max_rows=50_000)


async def test_load_pool_never_raises(db):
    class Broken:
        async def fetchval(self, *_args):
            raise OSError("the database went away")

    assert await events_settings.load_pool(Broken()) == FACTORY


async def test_get_has_the_stored_values_the_factory_values_the_bounds_and_what_is_kept(client, db):
    await login_as(client, db)
    await add_rows(db, 3, timedelta(days=2))
    body = (await client.get("/api/settings/events")).json()
    assert body["retention_days"] == 90 and body["max_rows"] == 100_000
    assert body["factory"] == {"retention_days": 90, "max_rows": 100_000}
    assert body["bounds"] == {"retention_days": [7, 400], "max_rows": [10_000, 1_000_000]}
    assert body["kept"] == 3
    assert body["oldest"][:10] == await db.fetchval("SELECT (now() - interval '2 days')::date::text")
    assert set(body) == {"retention_days", "max_rows", "factory", "bounds", "kept", "oldest"}


async def test_get_has_no_oldest_when_nothing_is_kept(client, db):
    await login_as(client, db)
    body = (await client.get("/api/settings/events")).json()
    assert body["kept"] == 0 and body["oldest"] is None


@pytest.mark.parametrize(
    "body",
    [
        {"retention_days": 6, "max_rows": 100_000},
        {"retention_days": 401, "max_rows": 100_000},
        {"retention_days": 90, "max_rows": 9_999},
        {"retention_days": 90, "max_rows": 1_000_001},
        {"retention_days": 90},
        {"max_rows": 100_000},
        {"retention_days": None, "max_rows": 100_000},
        {"retention_days": "90", "max_rows": 100_000},
        {"retention_days": 90.5, "max_rows": 100_000},
        {"retention_days": 90, "max_rows": 100_000, "extra": 1},
        {},
    ],
)
async def test_put_refuses_a_body_outside_the_bounds_or_with_a_wrong_shape_and_changes_nothing(client, db, body):
    await login_as(client, db)
    r = await client.put("/api/settings/events", json=body)
    assert r.status_code == 422
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'events'") == 0
    assert await audit_rows(db) == []


async def test_lengthening_needs_no_confirmation_and_is_audited(client, db):
    await login_as(client, db)
    await add_rows(db, 40, timedelta(days=60))
    r = await client.put("/api/settings/events", json={"retention_days": 120, "max_rows": 200_000})
    assert r.status_code == 200
    assert (r.json()["retention_days"], r.json()["max_rows"]) == (120, 200_000)
    assert r.json()["kept"] == 40 and set(r.json()) == {"retention_days", "max_rows", "factory", "bounds", "kept", "oldest"}
    assert (await client.get("/api/settings/events")).json()["retention_days"] == 120
    (row,) = await audit_rows(db)
    assert row["actor_name"] == "admin"
    assert row["detail"]["before"] == {"retention_days": 90, "max_rows": 100_000}
    assert row["detail"]["after"] == {"retention_days": 120, "max_rows": 200_000}
    assert "will_delete" not in row["detail"]


async def test_saving_the_same_values_again_is_not_an_event(client, db):
    await login_as(client, db)
    assert (await client.put("/api/settings/events", json={"retention_days": 90, "max_rows": 100_000})).status_code == 200
    assert await audit_rows(db) == []


async def test_shortening_with_rows_that_would_go_is_refused_until_confirmed(client, db):
    await login_as(client, db)
    await add_rows(db, 40, timedelta(days=60))
    await add_rows(db, 5, timedelta(days=2))
    r = await client.put("/api/settings/events", json={"retention_days": 30, "max_rows": 100_000})
    assert r.status_code == 409
    assert r.json()["will_delete"] == 40
    assert "40 events" in r.json()["detail"] and "confirm" in r.json()["detail"]
    assert (await client.get("/api/settings/events")).json()["retention_days"] == 90   # nothing changed
    assert await kept(db) == 45 and await audit_rows(db) == []

    r = await client.put("/api/settings/events?confirm=true", json={"retention_days": 30, "max_rows": 100_000})
    assert r.status_code == 200 and r.json()["retention_days"] == 30
    assert await kept(db) == 45                                   # the PUT forecasts; the hourly run deletes
    (row,) = await audit_rows(db)
    assert row["detail"]["before"] == {"retention_days": 90}
    assert row["detail"]["after"] == {"retention_days": 30}
    assert row["detail"]["will_delete"] == 40


async def test_the_forecast_is_what_the_next_housekeeping_run_deletes(client, db, pool):
    await login_as(client, db)
    await add_rows(db, 30, timedelta(days=60))                    # past the new 30 days
    await add_rows(db, 10, timedelta(days=5))
    await add_rows(db, 4, timedelta(days=100), state="open")      # open: never counted, never deleted
    await add_rows(db, 3, timedelta(days=100), state="closed", closed_ago=timedelta(days=1))  # closed yesterday: stays
    forecast = (await client.put("/api/settings/events", json={"retention_days": 30, "max_rows": 100_000})).json()["will_delete"]
    assert forecast == 30
    assert (await client.put("/api/settings/events?confirm=true", json={"retention_days": 30, "max_rows": 100_000})).status_code == 200
    assert (await housekeep(pool))["journal"] == forecast
    assert await kept(db) == 10 + 4 + 3


async def test_a_row_both_rules_hit_counts_once(client, db):
    await login_as(client, db)
    await put_row(db, {"retention_days": 400, "max_rows": 100_000})
    await add_rows(db, 12_000, timedelta(days=60))                # older than 30 days AND beyond the newest 10,000
    await add_rows(db, 5_000)
    r = await client.put("/api/settings/events", json={"retention_days": 30, "max_rows": 10_000})
    assert r.status_code == 409
    assert r.json()["will_delete"] == 12_000                      # not 12,000 + 7,000


async def test_the_count_rule_alone_is_forecast_too(client, db, pool):
    await login_as(client, db)
    await add_rows(db, 10_030)                                    # all recent: only the row cap bites
    r = await client.put("/api/settings/events", json={"retention_days": 90, "max_rows": 10_000})
    assert r.status_code == 409 and r.json()["will_delete"] == 30
    assert (await client.put("/api/settings/events?confirm=true", json={"retention_days": 90, "max_rows": 10_000})).status_code == 200
    assert (await housekeep(pool))["journal"] == 30
    assert await kept(db) == 10_000


async def test_what_the_old_policy_already_deletes_is_not_counted_again(client, db):
    await login_as(client, db)
    await add_rows(db, 7, timedelta(days=200))                    # the old 90 days already deletes these at the next run
    await add_rows(db, 5, timedelta(days=60))
    r = await client.put("/api/settings/events", json={"retention_days": 30, "max_rows": 100_000})
    assert r.status_code == 409 and r.json()["will_delete"] == 5


async def test_shortening_that_deletes_nothing_needs_no_confirmation(client, db):
    await login_as(client, db)
    await add_rows(db, 5, timedelta(days=2))
    r = await client.put("/api/settings/events", json={"retention_days": 30, "max_rows": 50_000})
    assert r.status_code == 200
    (row,) = await audit_rows(db)
    assert "will_delete" not in row["detail"]


async def test_open_rows_are_not_in_the_forecast(client, db):
    await login_as(client, db)
    await add_rows(db, 6, timedelta(days=300), state="open")
    r = await client.put("/api/settings/events", json={"retention_days": 7, "max_rows": 10_000})
    assert r.status_code == 200                                   # nothing would go, so no confirmation


async def test_will_delete_counts_the_union_of_both_rules_once(db):
    await put_row(db, {"retention_days": 90, "max_rows": 100_000})
    await add_rows(db, 20, timedelta(days=60))
    await add_rows(db, 20)
    async with get_sessionmaker()() as session:
        old, new = EventsSettings(retention_days=90, max_rows=100_000), EventsSettings(retention_days=30, max_rows=10_000)
        assert await events_settings.will_delete(session, old, new) == 20
        assert await events_settings.will_delete(session, new, old) == 0   # lengthening deletes nothing
        assert await events_settings.will_delete(session, old, old) == 0


async def test_a_closed_at_that_is_not_a_time_never_breaks_the_forecast_or_housekeeping(client, db, pool):
    await login_as(client, db)
    for value in ("garbage", "", "2026-13-45T00:00:00Z", 7):
        await db.execute(
            "INSERT INTO diag_events (ts, level, component, kind, message, detail) "
            "VALUES (now() - interval '60 days', 'warning', 'collector', 'source.offline', 'old', $1)",
            {"state": "closed", "closed_at": value},
        )
    await add_rows(db, 3, timedelta(days=5))
    r = await client.put("/api/settings/events", json={"retention_days": 30, "max_rows": 100_000})
    assert r.status_code == 409 and r.json()["will_delete"] == 4   # the age falls back to the row's own time
    assert (await client.put("/api/settings/events?confirm=true", json={"retention_days": 30, "max_rows": 100_000})).status_code == 200
    assert (await housekeep(pool))["journal"] == 4
    assert await kept(db) == 3


async def test_stats_are_the_row_count_and_the_oldest_time(db):
    async with get_sessionmaker()() as session:
        assert await events_settings.stats(session) == (0, None)
        await add_rows(db, 2, timedelta(days=3))
        count, oldest = await events_settings.stats(session)
        assert count == 2 and oldest is not None


async def test_housekeeping_uses_the_stored_setting(db, pool):
    await put_row(db, {"retention_days": 7, "max_rows": 100_000})
    await add_rows(db, 3, timedelta(days=10))
    await add_rows(db, 2, timedelta(days=3))
    assert (await housekeep(pool))["journal"] == 3
    assert await kept(db) == 2


async def test_housekeeping_uses_the_stored_row_cap(db, pool):
    await put_row(db, {"retention_days": 90, "max_rows": 10_000})
    await add_rows(db, 10_004)
    assert (await housekeep(pool))["journal"] == 4


async def test_housekeeping_survives_a_broken_stored_value(db, pool):
    await put_row(db, {"retention_days": "x"})
    await add_rows(db, 2, timedelta(days=100))
    await add_rows(db, 2, timedelta(days=80))
    assert (await housekeep(pool))["journal"] == 2                # the factory 90 days
    assert await kept(db) == 2


# Who may call the two routes: storage.view reads, storage.edit writes (tests/auth_expectations.py; the gate tests list them).
async def test_a_role_with_only_storage_view_reads_but_cannot_write(client, db):
    await make_role(db, "storage reader", ["storage.view"])
    await login_as(client, db, role="storage reader")
    assert (await client.get("/api/settings/events")).status_code == 200
    assert (await client.put("/api/settings/events", json={"retention_days": 30, "max_rows": 50_000})).status_code == 403
    assert await db.fetchval("SELECT count(*) FROM settings WHERE key = 'events'") == 0


async def test_a_role_with_only_storage_edit_writes_but_cannot_read(client, db):
    await make_role(db, "storage writer", ["storage.edit"])
    await login_as(client, db, role="storage writer")
    assert (await client.get("/api/settings/events")).status_code == 403
    assert (await client.put("/api/settings/events", json={"retention_days": 120, "max_rows": 50_000})).status_code == 200


async def test_the_routes_are_closed_to_other_roles_and_to_anonymous(client, db):
    assert (await client.get("/api/settings/events")).status_code == 401
    assert (await client.put("/api/settings/events", json={"retention_days": 30, "max_rows": 50_000})).status_code == 401
    await login_as(client, db, role="operator")
    assert (await client.put("/api/settings/events", json={"retention_days": 30, "max_rows": 50_000})).status_code == 403
