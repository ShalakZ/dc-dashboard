import pytest

from helpers import login_as


async def test_version_needs_a_session(client):
    assert (await client.get("/api/version")).status_code == 401


@pytest.mark.parametrize("role", ["viewer", "operator", "admin"])
async def test_every_role_may_read_the_version(client, db, role):
    await login_as(client, db, role)
    response = await client.get("/api/version")
    assert response.status_code == 200
    assert set(response.json()) == {"build_id", "build_time", "uptime_seconds"}


async def test_the_build_comes_from_the_environment_and_the_uptime_is_a_number(client, db, monkeypatch):
    monkeypatch.setenv("DCDASH_BUILD_ID", "227bd6a")
    monkeypatch.setenv("DCDASH_BUILD_TIME", "2026-10-12T14:03:11+02:00")
    await login_as(client, db, "viewer")
    body = (await client.get("/api/version")).json()
    assert body["build_id"] == "227bd6a" and body["build_time"] == "2026-10-12T14:03:11+02:00"
    assert isinstance(body["uptime_seconds"], float) and body["uptime_seconds"] >= 0


async def test_without_a_build_the_api_says_so(client, db, monkeypatch):
    monkeypatch.delenv("DCDASH_BUILD_ID", raising=False)
    monkeypatch.delenv("DCDASH_BUILD_TIME", raising=False)
    await login_as(client, db, "viewer")
    body = (await client.get("/api/version")).json()
    assert (body["build_id"], body["build_time"]) == ("dev", "unknown")
