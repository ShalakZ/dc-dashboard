from sqlalchemy.exc import OperationalError

from dcdash.api.deps import get_db
from helpers import login_as

ADMIN = {"username": "admin", "password": "correct-horse"}


async def test_first_run_setup_creates_the_admin_and_signs_in(client):
    assert (await client.get("/api/setup")).json() == {"needed": True}
    response = await client.post("/api/setup", json=ADMIN)
    assert response.status_code == 201
    assert response.json()["username"] == "admin" and response.json()["role"] == "admin"
    assert (await client.get("/api/setup")).json() == {"needed": False}
    assert (await client.get("/api/me")).json()["username"] == "admin"


async def test_setup_only_works_once(client):
    await client.post("/api/setup", json=ADMIN)
    again = await client.post("/api/setup", json={"username": "evil", "password": "another-password"})
    assert again.status_code == 409


async def test_setup_rejects_a_short_password(client):
    response = await client.post("/api/setup", json={"username": "admin", "password": "short"})
    assert response.status_code == 422
    assert (await client.get("/api/setup")).json() == {"needed": True}


async def test_password_is_stored_hashed(client, db):
    await client.post("/api/setup", json=ADMIN)
    stored = await db.fetchval("SELECT password_hash FROM users")
    assert stored.startswith("$argon2") and "correct-horse" not in stored


async def test_session_cookie_is_http_only_and_same_site_strict(client, db):
    response = await client.post("/api/setup", json=ADMIN)
    cookie = response.headers["set-cookie"].lower()
    assert "dcdash_session=" in cookie and "httponly" in cookie and "samesite=strict" in cookie
    token = response.cookies["dcdash_session"]
    assert await db.fetchval("SELECT count(*) FROM sessions WHERE id = $1", token) == 0  # only its hash is stored


async def test_login_and_logout(client, db):
    await client.post("/api/setup", json=ADMIN)
    await client.post("/api/logout")
    assert (await client.get("/api/me")).status_code == 401
    assert await db.fetchval("SELECT count(*) FROM sessions") == 0

    wrong = await client.post("/api/login", json={"username": "admin", "password": "nope-nope-nope"})
    assert wrong.status_code == 401
    unknown = await client.post("/api/login", json={"username": "ghost", "password": "correct-horse"})
    assert unknown.status_code == 401 and unknown.json() == wrong.json()

    assert (await client.post("/api/login", json=ADMIN)).status_code == 200
    assert (await client.get("/api/me")).json()["role"] == "admin"


async def test_login_rejects_oversized_credentials(client):
    await client.post("/api/setup", json=ADMIN)
    huge = await client.post("/api/login", json={"username": "admin", "password": "x" * 300})
    assert huge.status_code == 422


async def test_me_requires_a_session(client):
    assert (await client.get("/api/me")).status_code == 401


async def test_expired_session_is_rejected(client, db):
    await login_as(client, db, "viewer")
    await db.execute("UPDATE sessions SET expires_at = now() - interval '1 minute'")
    assert (await client.get("/api/me")).status_code == 401


async def test_deactivated_user_loses_access_and_cannot_log_in(client, db):
    await login_as(client, db, "viewer")
    await db.execute("UPDATE users SET active = FALSE")
    assert (await client.get("/api/me")).status_code == 401
    response = await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})
    assert response.status_code == 401


async def test_login_is_rate_limited_per_user(client, db):
    await login_as(client, db, "viewer")
    for _ in range(5):
        bad = await client.post("/api/login", json={"username": "viewer", "password": "wrong-wrong"})
        assert bad.status_code == 401
    locked = await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})
    assert locked.status_code == 429


async def test_database_outage_returns_503(app, client):
    async def broken_db():
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))
        yield  # pragma: no cover

    app.dependency_overrides[get_db] = broken_db
    response = await client.get("/api/setup")
    assert response.status_code == 503
    assert response.json() == {"detail": "database unavailable"}


async def test_unknown_username_still_runs_a_verify(client, db, monkeypatch):
    from dcdash.api import auth as auth_module
    calls: list[str] = []
    real = auth_module.verify_password

    def spy(password_hash: str, password: str) -> bool:
        calls.append(password_hash)
        return real(password_hash, password)

    monkeypatch.setattr(auth_module, "verify_password", spy)
    assert (await client.post("/api/login", json={"username": "nobody", "password": "whatever1"})).status_code == 401
    assert len(calls) == 1 and calls[0].startswith("$argon2")
