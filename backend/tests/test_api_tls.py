from datetime import UTC, datetime, timedelta

from dcdash.core.certificate import TLS_KEY
from helpers import login_as

DISABLED = {
    "enabled": False, "state": None, "not_after": None, "days_left": None, "subject": None, "checked_at": None,
    "error": None,
}


async def store(db, *, expires_in_days: float | None = None, checked_hours_ago: float = 0, error: str | None = None):
    """Write the row the collector writes: `expires_in_days` from the database's now(), checked `checked_hours_ago`."""
    value = {"path": "/certs/fullchain.pem"}
    if error is not None:
        value["error"] = error
    else:
        not_after = datetime.now(UTC) + timedelta(days=expires_in_days)
        value.update(not_after=not_after.isoformat(), subject="CN=dc.example.test", serial="1a2b")
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb || jsonb_build_object("
        "'checked_at', now() - make_interval(secs => $3))) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        TLS_KEY, value, checked_hours_ago * 3600,
    )


async def test_roles_on_the_tls_status(client, db):
    assert (await client.get("/api/tls/status")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get("/api/tls/status")).status_code == 403
    await login_as(client, db, "operator")
    assert (await client.get("/api/tls/status")).status_code == 403
    await login_as(client, db, "admin")
    assert (await client.get("/api/tls/status")).status_code == 200


async def test_no_row_means_https_is_not_enabled(client, db):
    await login_as(client, db, "admin")
    assert (await client.get("/api/tls/status")).json() == DISABLED


async def test_a_far_expiry_is_ok(client, db):
    await login_as(client, db, "admin")
    await store(db, expires_in_days=90)
    body = (await client.get("/api/tls/status")).json()
    assert body["enabled"] is True and body["state"] == "ok" and body["error"] is None
    assert body["days_left"] in (89, 90)
    assert body["subject"] == "CN=dc.example.test"
    assert datetime.fromisoformat(body["not_after"]).utcoffset() == timedelta(0)
    assert 0 <= (datetime.now(UTC) - datetime.fromisoformat(body["checked_at"])).total_seconds() < 30


async def test_less_than_thirty_days_left_is_expiring(client, db):
    await login_as(client, db, "admin")
    await store(db, expires_in_days=29)
    body = (await client.get("/api/tls/status")).json()
    assert body["state"] == "expiring" and body["days_left"] in (28, 29)
    await store(db, expires_in_days=31)
    body = (await client.get("/api/tls/status")).json()
    assert body["state"] == "ok" and body["days_left"] in (30, 31)


async def test_a_past_expiry_is_expired_with_no_days_left(client, db):
    await login_as(client, db, "admin")
    await store(db, expires_in_days=-1)
    body = (await client.get("/api/tls/status")).json()
    assert body["enabled"] is True and body["state"] == "expired" and body["days_left"] == 0
    assert body["not_after"] is not None


async def test_an_unreadable_file_is_reported_with_its_error(client, db):
    await login_as(client, db, "admin")
    await store(db, error="cannot read /certs/fullchain.pem: No such file or directory")
    body = (await client.get("/api/tls/status")).json()
    assert body.pop("checked_at") is not None
    assert body == {
        "enabled": True, "state": "unreadable", "not_after": None, "days_left": None, "subject": None,
        "error": "cannot read /certs/fullchain.pem: No such file or directory",
    }


async def test_a_check_older_than_three_hours_is_unknown(client, db):
    await login_as(client, db, "admin")
    await store(db, expires_in_days=90, checked_hours_ago=4)
    body = (await client.get("/api/tls/status")).json()
    assert body["enabled"] is True and body["state"] == "unknown"
    await store(db, expires_in_days=90, checked_hours_ago=2)
    assert (await client.get("/api/tls/status")).json()["state"] == "ok"


async def test_a_stale_error_row_is_unknown_too(client, db):
    await login_as(client, db, "admin")
    await store(db, error="cannot read /certs/fullchain.pem: boom", checked_hours_ago=5)
    assert (await client.get("/api/tls/status")).json()["state"] == "unknown"


async def test_a_row_the_collector_did_not_write_reads_as_unknown_not_as_a_500(client, db):
    await login_as(client, db, "admin")
    await db.execute("INSERT INTO settings (key, value) VALUES ($1, '{\"path\": \"/x\", \"not_after\": \"soon\"}')", TLS_KEY)
    response = await client.get("/api/tls/status")
    assert response.status_code == 200
    assert response.json()["enabled"] is True and response.json()["state"] == "unknown"
