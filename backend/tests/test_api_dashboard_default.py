import asyncio
import json
from contextlib import asynccontextmanager

import pytest

from dcdash.api.dashboards import DEFAULT_LOCK
from helpers import login_as

DEFAULT_URL = "/api/dashboards/default"


async def make_dashboard(db, name: str) -> int:
    return await db.fetchval("INSERT INTO dashboards (name) VALUES ($1) RETURNING id", name)


async def store(db, value) -> None:
    """Write `value` under the setting's key as it is, whatever shape it has (the pool's jsonb codec encodes it)."""
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('default_dashboard', $1::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        value,
    )


async def stored(db):
    return await db.fetchval("SELECT value FROM settings WHERE key = 'default_dashboard'")


async def default_of(client):
    response = await client.get(DEFAULT_URL)
    assert response.status_code == 200, response.text
    return response.json()["dashboard_id"]


async def audit_rows(db, action: str) -> list[dict]:
    return [r["detail"] for r in await db.fetch("SELECT detail FROM audit_log WHERE action = $1 ORDER BY id", action)]


async def wait_for_waiters(db, *fragments: str, timeout: float = 5.0, interval: float = 0.02) -> bool:
    """Poll pg_stat_activity until, for every fragment, some backend is waiting on a lock inside a statement that
    contains it, i.e. each request has reached the exact statement the test wants it stopped at."""
    clock = asyncio.get_running_loop().time
    deadline = clock() + timeout
    while clock() < deadline:
        waiting = [
            r["query"] for r in await db.fetch(
                "SELECT query FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'"
            )
        ]
        if all(any(fragment in query for query in waiting) for fragment in fragments):
            return True
        await asyncio.sleep(interval)
    return False


@asynccontextmanager
async def audit_log_held(db):
    """A second connection that blocks every audit insert until the block ends.

    Every route here writes its audit row last, so a request stops there with its other writes still uncommitted:
    that is how a test freezes two real requests in the middle of their transactions."""
    async with db.acquire() as rival, rival.transaction():
        await rival.execute("LOCK TABLE audit_log IN SHARE MODE")
        yield rival


async def test_none_is_set_at_first(client, db):
    await login_as(client, db, "viewer")
    assert await default_of(client) is None


async def test_routes_and_order(client, db):
    # "default" must not reach the {dashboard_id} routes (an int path parameter would answer 422).
    await login_as(client, db, "admin")
    dash = await make_dashboard(db, "Ops")
    assert (await client.get(DEFAULT_URL)).status_code == 200
    assert (await client.put(DEFAULT_URL, json={"dashboard_id": dash})).status_code == 200
    one = await client.get(f"/api/dashboards/{dash}")
    assert one.status_code == 200 and one.json()["name"] == "Ops"


async def test_roles(client, db):
    dash = await make_dashboard(db, "Ops")
    assert (await client.get(DEFAULT_URL)).status_code == 401
    assert (await client.put(DEFAULT_URL, json={"dashboard_id": dash})).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get(DEFAULT_URL)).status_code == 200
    assert (await client.put(DEFAULT_URL, json={"dashboard_id": dash})).status_code == 403
    await client.post("/api/logout")
    await login_as(client, db, "operator")
    assert (await client.get(DEFAULT_URL)).status_code == 200
    assert (await client.put(DEFAULT_URL, json={"dashboard_id": dash})).status_code == 403
    assert await stored(db) is None and await audit_rows(db, "dashboard.default_changed") == []
    await client.post("/api/logout")
    await login_as(client, db, "admin")
    assert (await client.put(DEFAULT_URL, json={"dashboard_id": dash})).status_code == 200


@pytest.mark.parametrize(
    "raw",
    [
        '"ID"', "true", "0", "-1", "1.5", "1.0", "null", "[]", "{}", "[ID]", '{"x": 1}', "99999999999",
        "2147483648", "424242",
    ],
)
async def test_stored_garbage_reads_as_none(client, db, raw):
    await login_as(client, db, "viewer")
    dash = await make_dashboard(db, "Ops")  # id 1, so `true` is equal to the id in Python
    assert dash == 1
    await store(db, {"dashboard_id": json.loads(raw.replace("ID", str(dash)))})
    assert await default_of(client) is None


@pytest.mark.parametrize("whole", [True, "x", 1.5, 3])
async def test_a_stored_value_that_is_not_an_object_reads_as_none(client, db, whole):
    await login_as(client, db, "viewer")
    await make_dashboard(db, "Ops")
    await store(db, whole)
    assert await default_of(client) is None


async def test_a_stored_dashboard_that_no_longer_exists_reads_as_none(client, db):
    await login_as(client, db, "viewer")
    dash = await make_dashboard(db, "Gone")
    await store(db, {"dashboard_id": dash})
    assert await default_of(client) == dash
    await db.execute("DELETE FROM dashboards WHERE id = $1", dash)  # no foreign key: the setting still names it
    assert await default_of(client) is None


async def test_set_read_clear_and_the_audit_rows(client, db):
    await login_as(client, db, "admin")
    admin = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    ops = await make_dashboard(db, "Ops")
    plant = await make_dashboard(db, "Plant")

    response = await client.put(DEFAULT_URL, json={"dashboard_id": ops})
    assert response.status_code == 200 and response.json() == {"dashboard_id": ops}
    assert await default_of(client) == ops
    assert await stored(db) == {"dashboard_id": ops}

    # The same value again: nothing changed, so no second audit row.
    assert (await client.put(DEFAULT_URL, json={"dashboard_id": ops})).json() == {"dashboard_id": ops}
    assert len(await audit_rows(db, "dashboard.default_changed")) == 1

    assert (await client.put(DEFAULT_URL, json={"dashboard_id": plant})).status_code == 200
    cleared = await client.put(DEFAULT_URL, json={"dashboard_id": None})
    assert cleared.status_code == 200 and cleared.json() == {"dashboard_id": None}
    assert await default_of(client) is None
    assert (await client.put(DEFAULT_URL, json={"dashboard_id": None})).status_code == 200  # clearing a clear is a no-op

    rows = await audit_rows(db, "dashboard.default_changed")
    assert rows == [
        {"before": {"dashboard_id": None, "dashboard": None}, "after": {"dashboard_id": ops, "dashboard": "Ops"}},
        {"before": {"dashboard_id": ops, "dashboard": "Ops"}, "after": {"dashboard_id": plant, "dashboard": "Plant"}},
        {"before": {"dashboard_id": plant, "dashboard": "Plant"}, "after": {"dashboard_id": None, "dashboard": None}},
    ]
    assert await db.fetchval("SELECT user_id FROM audit_log WHERE action = 'dashboard.default_changed' LIMIT 1") == admin


async def test_an_unknown_dashboard_is_404_and_changes_nothing(client, db):
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    await client.put(DEFAULT_URL, json={"dashboard_id": ops})
    response = await client.put(DEFAULT_URL, json={"dashboard_id": 99999})
    assert response.status_code == 404 and response.json()["detail"] == "dashboard not found"
    assert await default_of(client) == ops
    assert len(await audit_rows(db, "dashboard.default_changed")) == 1


@pytest.mark.parametrize(
    "body",
    [
        {}, {"dashboard_id": True}, {"dashboard_id": 1.0}, {"dashboard_id": "1"}, {"dashboard_id": 0},
        {"dashboard_id": -1}, {"dashboard_id": 2_147_483_648}, {"dashboard_id": 99999999999},
        {"dashboard_id": [1]}, {"dashboard_id": 1, "extra": 1}, {"id": 1}, [], "1", 1,
    ],
)
async def test_a_bad_body_is_422_and_changes_nothing(client, db, body):
    await login_as(client, db, "admin")
    await make_dashboard(db, "Ops")  # id 1, which the bodies above tempt with
    response = await client.put(DEFAULT_URL, json=body)
    assert response.status_code == 422, response.text
    assert await stored(db) is None and await audit_rows(db, "dashboard.default_changed") == []


async def test_the_largest_id_is_accepted_as_a_body_and_reads_as_unknown(client, db):
    await login_as(client, db, "admin")
    assert (await client.put(DEFAULT_URL, json={"dashboard_id": 2_147_483_647})).status_code == 404


async def test_renaming_the_default_keeps_it_the_default(client, db):
    await login_as(client, db, "operator")
    created = (await client.post("/api/dashboards", json={"name": "Ops"})).json()
    await client.post("/api/logout")
    await login_as(client, db, "admin")
    await client.put(DEFAULT_URL, json={"dashboard_id": created["id"]})
    body = {"name": "Ops renamed", "range": created["range"], "updated_at": created["updated_at"], "widgets": []}
    assert (await client.put(f"/api/dashboards/{created['id']}", json=body)).status_code == 200
    assert await default_of(client) == created["id"]
    assert len(await audit_rows(db, "dashboard.default_changed")) == 1


async def test_deleting_the_default_clears_it_and_the_audit_row_says_so(client, db):
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    await client.put(DEFAULT_URL, json={"dashboard_id": ops})
    assert (await client.delete(f"/api/dashboards/{ops}")).status_code == 204
    assert await default_of(client) is None
    assert await stored(db) == {"dashboard_id": None}
    assert await audit_rows(db, "dashboard.deleted") == [
        {"dashboard_id": ops, "name": "Ops", "widgets": 0, "was_default": True}
    ]


async def test_deleting_another_dashboard_leaves_the_default_alone(client, db):
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    other = await make_dashboard(db, "Other")
    await client.put(DEFAULT_URL, json={"dashboard_id": ops})
    assert (await client.delete(f"/api/dashboards/{other}")).status_code == 204
    assert await default_of(client) == ops
    assert await audit_rows(db, "dashboard.deleted") == [{"dashboard_id": other, "name": "Other", "widgets": 0}]


async def test_deleting_a_dashboard_when_no_default_was_ever_stored(client, db):
    await login_as(client, db, "operator")
    ops = await make_dashboard(db, "Ops")
    assert (await client.delete(f"/api/dashboards/{ops}")).status_code == 204
    assert await stored(db) is None  # the clear is an UPDATE of an existing row, never an insert
    assert await audit_rows(db, "dashboard.deleted") == [{"dashboard_id": ops, "name": "Ops", "widgets": 0}]


async def test_a_change_waits_for_the_default_lock(client, db):
    await login_as(client, db, "admin")
    ops = await make_dashboard(db, "Ops")
    async with db.acquire() as holder, holder.transaction():
        await holder.execute("SELECT pg_advisory_xact_lock($1)", DEFAULT_LOCK)
        pending = asyncio.create_task(client.put(DEFAULT_URL, json={"dashboard_id": ops}))
        assert await wait_for_waiters(db, "pg_advisory_xact_lock")
        assert not pending.done()
    assert (await asyncio.wait_for(pending, timeout=5)).status_code == 200


# The two races. Each freezes two real requests inside their transactions (see audit_log_held) so that the
# interleaving is the one under test every time, not whichever one the scheduler happens to produce.


@pytest.mark.parametrize("first", ["set", "delete"])
async def test_setting_a_new_default_while_the_old_default_is_deleted_keeps_the_new_one(client, db, first):
    await login_as(client, db, "admin")
    new = await make_dashboard(db, "New")
    old = await make_dashboard(db, "Old")
    await store(db, {"dashboard_id": old})

    def put():
        return asyncio.create_task(client.put(DEFAULT_URL, json={"dashboard_id": new}))

    def delete():
        return asyncio.create_task(client.delete(f"/api/dashboards/{old}"))

    async with audit_log_held(db):
        if first == "set":
            # The set has written the new default (uncommitted) and waits for its audit row; the delete's one-statement
            # clear then waits on that write, and re-checks its condition after it commits.
            request_put = put()
            assert await wait_for_waiters(db, "INSERT INTO audit_log")
            request_delete = delete()
            assert await wait_for_waiters(db, "INSERT INTO audit_log", "UPDATE settings")
        else:
            # The delete has cleared the old default (uncommitted) and waits for its audit row; the set then waits on
            # that write and lands after it.
            request_delete = delete()
            assert await wait_for_waiters(db, "INSERT INTO audit_log")
            request_put = put()
            assert await wait_for_waiters(db, "INSERT INTO audit_log", "INSERT INTO settings")
    put_response = await asyncio.wait_for(request_put, timeout=5)
    delete_response = await asyncio.wait_for(request_delete, timeout=5)
    assert (put_response.status_code, delete_response.status_code) == (200, 204)

    assert await default_of(client) == new
    assert await stored(db) == {"dashboard_id": new}
    assert await db.fetchval("SELECT count(*) FROM dashboards WHERE id = $1", old) == 0
    changed = await audit_rows(db, "dashboard.default_changed")
    assert len(changed) == 1 and changed[0]["after"] == {"dashboard_id": new, "dashboard": "New"}
    [deleted] = await audit_rows(db, "dashboard.deleted")
    # Whether the delete cleared a default shows in its row; the set always ends as the default.
    assert deleted.get("was_default", False) is (first == "delete")


@pytest.mark.parametrize("first", ["set", "delete"])
async def test_setting_a_default_while_that_dashboard_is_deleted_ends_consistent(client, db, first):
    await login_as(client, db, "admin")
    doomed = await make_dashboard(db, "Doomed")
    if first == "delete":
        await store(db, {"dashboard_id": doomed})

    def put():
        return asyncio.create_task(client.put(DEFAULT_URL, json={"dashboard_id": doomed}))

    def delete():
        return asyncio.create_task(client.delete(f"/api/dashboards/{doomed}"))

    async with audit_log_held(db):
        if first == "set":
            request_put = put()
            assert await wait_for_waiters(db, "INSERT INTO audit_log")
            request_delete = delete()
            assert await wait_for_waiters(db, "INSERT INTO audit_log", "FOR UPDATE")  # the delete waits for the row lock
        else:
            request_delete = delete()
            assert await wait_for_waiters(db, "INSERT INTO audit_log")
            request_put = put()
            assert await wait_for_waiters(db, "INSERT INTO audit_log", "FOR UPDATE")  # the set waits for the row lock
    put_response = await asyncio.wait_for(request_put, timeout=5)
    delete_response = await asyncio.wait_for(request_delete, timeout=5)

    assert delete_response.status_code == 204
    assert put_response.status_code == (200 if first == "set" else 404)
    assert await default_of(client) is None  # whatever the order, no default is left pointing at a deleted dashboard
    assert await stored(db) == {"dashboard_id": None}
    assert await db.fetchval("SELECT count(*) FROM dashboards") == 0
    [deleted] = await audit_rows(db, "dashboard.deleted")
    assert deleted["was_default"] is True
    assert len(await audit_rows(db, "dashboard.default_changed")) == (1 if first == "set" else 0)
