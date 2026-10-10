from dcdash.core.heartbeat import HEARTBEAT_KEY
from helpers import login_as


async def beat_at(db, seconds_ago: float) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ($1, jsonb_build_object('at', now() - make_interval(secs => $2))) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        HEARTBEAT_KEY, seconds_ago,
    )


async def test_roles_on_the_collector_status(client, db):
    assert (await client.get("/api/collector/status")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.get("/api/collector/status")).status_code == 403
    await login_as(client, db, "operator")
    assert (await client.get("/api/collector/status")).status_code == 200


async def test_no_beat_on_record_reads_as_silent(client, db):
    await login_as(client, db, "operator")
    assert (await client.get("/api/collector/status")).json() == {"alive": False, "age_seconds": None}


async def test_a_fresh_beat_reads_as_alive(client, db):
    await login_as(client, db, "operator")
    await beat_at(db, 3)
    body = (await client.get("/api/collector/status")).json()
    assert body["alive"] is True and 2 <= body["age_seconds"] < 10


async def test_an_old_beat_reads_as_silent_with_its_age(client, db):
    """What a restore brings back, or a collector that died two minutes ago."""
    await login_as(client, db, "operator")
    await beat_at(db, 120)
    body = (await client.get("/api/collector/status")).json()
    assert body["alive"] is False and 119 <= body["age_seconds"] < 135


async def test_a_beat_stamped_in_the_future_is_not_a_negative_age(client, db):
    await login_as(client, db, "operator")
    await beat_at(db, -3600)
    body = (await client.get("/api/collector/status")).json()
    assert body == {"alive": True, "age_seconds": 0.0}
