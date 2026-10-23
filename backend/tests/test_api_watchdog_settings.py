"""The data freshness watchdog's two thresholds (w35): GET and PUT /api/settings/watchdog. storage.view reads, storage.edit writes;
a save is audited as `watchdog.changed` and drops the cached verdict after its commit."""
import pytest

from dcdash.events import watchdog, watchdog_settings
from helpers import login_as, make_role

URL = "/api/settings/watchdog"
FACTORY = {"stale_floor_minutes": 5, "not_advancing_hours": 6}


async def audit_rows(db) -> list:
    return await db.fetch("SELECT actor_name, action, detail FROM audit_log WHERE action LIKE 'watchdog.%' ORDER BY id")


async def stored(db):
    return await db.fetchval("SELECT value FROM settings WHERE key = 'watchdog'")


async def test_get_has_the_factory_values_the_bounds_and_nothing_else(client, db):
    await login_as(client, db)
    body = (await client.get(URL)).json()
    assert body == {**FACTORY, "factory": FACTORY, "bounds": {"stale_floor_minutes": [2, 60], "not_advancing_hours": [1, 72]}}


async def test_get_has_the_stored_values(client, db):
    await login_as(client, db)
    await db.execute("INSERT INTO settings (key, value) VALUES ('watchdog', $1)", {"stale_floor_minutes": 10, "not_advancing_hours": 12})
    body = (await client.get(URL)).json()
    assert (body["stale_floor_minutes"], body["not_advancing_hours"]) == (10, 12) and body["factory"] == FACTORY


async def test_a_broken_stored_value_reads_as_the_factory_values(client, db):
    await login_as(client, db)
    await db.execute("INSERT INTO settings (key, value) VALUES ('watchdog', $1)", {"stale_floor_minutes": 1, "not_advancing_hours": "x"})
    body = (await client.get(URL)).json()
    assert (body["stale_floor_minutes"], body["not_advancing_hours"]) == (5, 6)


async def test_put_stores_answers_and_audits_the_changed_values_only(client, db):
    await login_as(client, db)
    r = await client.put(URL, json={"stale_floor_minutes": 10, "not_advancing_hours": 6})
    assert r.status_code == 200
    assert (r.json()["stale_floor_minutes"], r.json()["not_advancing_hours"]) == (10, 6)
    assert set(r.json()) == {"stale_floor_minutes", "not_advancing_hours", "factory", "bounds"}
    assert await stored(db) == {"stale_floor_minutes": 10, "not_advancing_hours": 6}
    assert (await client.get(URL)).json()["stale_floor_minutes"] == 10
    (row,) = await audit_rows(db)
    assert (row["actor_name"], row["action"]) == ("admin", "watchdog.changed")
    assert row["detail"] == {"before": {"stale_floor_minutes": 5}, "after": {"stale_floor_minutes": 10}}  # the changed value only


async def test_saving_the_same_values_again_is_not_an_event(client, db):
    await login_as(client, db)
    assert (await client.put(URL, json=FACTORY)).status_code == 200
    assert await audit_rows(db) == []
    assert (await client.put(URL, json={"stale_floor_minutes": 7, "not_advancing_hours": 6})).status_code == 200
    assert (await client.put(URL, json={"stale_floor_minutes": 7, "not_advancing_hours": 6})).status_code == 200
    assert len(await audit_rows(db)) == 1


@pytest.mark.parametrize("edge", [(2, 1), (60, 72)])
async def test_the_bounds_themselves_are_accepted(client, db, edge):
    await login_as(client, db)
    r = await client.put(URL, json={"stale_floor_minutes": edge[0], "not_advancing_hours": edge[1]})
    assert r.status_code == 200 and (r.json()["stale_floor_minutes"], r.json()["not_advancing_hours"]) == edge


@pytest.mark.parametrize(
    "body",
    [
        {"stale_floor_minutes": 1, "not_advancing_hours": 6},
        {"stale_floor_minutes": 61, "not_advancing_hours": 6},
        {"stale_floor_minutes": 5, "not_advancing_hours": 0},
        {"stale_floor_minutes": 5, "not_advancing_hours": 73},
        {"stale_floor_minutes": 5},
        {"not_advancing_hours": 6},
        {"stale_floor_minutes": None, "not_advancing_hours": 6},
        {"stale_floor_minutes": "5", "not_advancing_hours": 6},
        {"stale_floor_minutes": 5.5, "not_advancing_hours": 6},
        {"stale_floor_minutes": True, "not_advancing_hours": 6},
        {"stale_floor_minutes": 5, "not_advancing_hours": 6, "extra": 1},
        {},
    ],
)
async def test_put_refuses_a_body_outside_the_bounds_or_with_a_wrong_shape_and_changes_nothing(client, db, body):
    await login_as(client, db)
    r = await client.put(URL, json=body)
    assert r.status_code == 422
    assert await stored(db) is None and await audit_rows(db) == []


async def test_a_save_drops_the_cached_verdict(client, db):
    await login_as(client, db)
    await watchdog.get_verdict()
    assert watchdog._entry is not None
    assert (await client.put(URL, json={"stale_floor_minutes": 9, "not_advancing_hours": 6})).status_code == 200
    assert watchdog._entry is None and watchdog._task is None


async def test_the_cached_verdict_is_dropped_only_after_the_setting_is_committed(client, db, monkeypatch):
    """A verdict computed between the two would still use the old numbers and then be cached for 5 s."""
    from sqlalchemy.ext.asyncio import AsyncSession

    await login_as(client, db)
    order = []
    real_commit, real_reset = AsyncSession.commit, watchdog.reset_cache

    async def commit(self):
        await real_commit(self)
        order.append("commit")

    def reset():
        order.append("reset")
        real_reset()

    monkeypatch.setattr(AsyncSession, "commit", commit)
    monkeypatch.setattr(watchdog, "reset_cache", reset)
    assert (await client.put(URL, json={"stale_floor_minutes": 9, "not_advancing_hours": 6})).status_code == 200
    assert order[-2:] == ["commit", "reset"] and order.count("reset") == 1


async def test_a_save_changes_what_the_rule_says_at_once(client, db):
    from helpers import make_asset, make_latest, make_mapping, make_point, make_source

    await login_as(client, db)
    point = await make_point(db, await make_source(db, name="s"), "a")
    await make_mapping(db, point, await make_asset(db, "m"))
    await make_latest(db, point, age=200, good_age=200, good_value=1.0, changed_age=200)
    assert (await watchdog.get_verdict()).stale == 0  # 200 s is inside the 5-minute floor, and the answer is now cached
    assert (await client.put(URL, json={"stale_floor_minutes": 2, "not_advancing_hours": 6})).status_code == 200
    assert (await watchdog.get_verdict()).stale == 1


async def test_a_failed_save_leaves_the_cache_alone(client, db):
    await login_as(client, db)
    await watchdog.get_verdict()
    cached = watchdog._entry
    assert (await client.put(URL, json={"stale_floor_minutes": 1, "not_advancing_hours": 6})).status_code == 422
    assert watchdog._entry is cached


async def test_the_module_reads_what_the_route_stored(client, db):
    await login_as(client, db)
    await client.put(URL, json={"stale_floor_minutes": 15, "not_advancing_hours": 24})
    assert await watchdog_settings.load_pool(db) == watchdog_settings.WatchdogSettings(stale_floor_minutes=15, not_advancing_hours=24)


# Who may call the two routes: storage.view reads, storage.edit writes (tests/auth_expectations.py; the gate tests list them).
async def test_a_role_with_only_storage_view_reads_but_cannot_write(client, db):
    await make_role(db, "storage reader", ["storage.view"])
    await login_as(client, db, role="storage reader")
    assert (await client.get(URL)).status_code == 200
    assert (await client.put(URL, json={"stale_floor_minutes": 10, "not_advancing_hours": 6})).status_code == 403
    assert await stored(db) is None and await audit_rows(db) == []


async def test_a_role_with_only_storage_edit_writes_but_cannot_read(client, db):
    await make_role(db, "storage writer", ["storage.edit"])
    await login_as(client, db, role="storage writer")
    assert (await client.get(URL)).status_code == 403
    assert (await client.put(URL, json={"stale_floor_minutes": 10, "not_advancing_hours": 6})).status_code == 200


async def test_the_routes_are_closed_to_anonymous_and_a_write_to_the_operator(client, db):
    assert (await client.get(URL)).status_code == 401
    assert (await client.put(URL, json=FACTORY)).status_code == 401
    await login_as(client, db, role="operator")
    assert (await client.put(URL, json={"stale_floor_minutes": 10, "not_advancing_hours": 6})).status_code == 403
    assert await stored(db) is None
