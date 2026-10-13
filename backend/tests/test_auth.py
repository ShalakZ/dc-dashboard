import pytest
from sqlalchemy.exc import OperationalError

from dcdash.api.deps import get_db
from dcdash.api import auth as auth_module
from dcdash.core.permissions import ALL_IDS, BUILTIN
from helpers import login_as, make_role, make_user

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


async def test_cookie_secure_when_forwarded_https(client, db):
    await login_as(client, db, "viewer")
    plain = await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})
    assert "secure" not in plain.headers["set-cookie"].lower()
    tls = await client.post(
        "/api/login", json={"username": "viewer", "password": "correct-horse"},
        headers={"x-forwarded-proto": "https"},
    )
    assert "; secure" in tls.headers["set-cookie"].lower()
    assert "httponly" in tls.headers["set-cookie"].lower()


async def test_first_run_setup_is_audited_once(client, db):
    response = await client.post("/api/setup", json={"username": "boss", "password": "longenough"})
    assert response.status_code == 201
    row = await db.fetchrow("SELECT user_id, actor_name, detail FROM audit_log WHERE action = 'setup.completed'")
    assert row["actor_name"] == "boss" and row["user_id"] == response.json()["id"]
    assert row["detail"] == {"username": "boss", "role": "admin"}
    assert (await client.post("/api/setup", json={"username": "x", "password": "longenough"})).status_code == 409
    assert await db.fetchval("SELECT count(*) FROM audit_log WHERE action = 'setup.completed'") == 1


BAD = {"password": "wrong-wrong"}
GOOD = {"username": "viewer", "password": "correct-horse"}


def _from(address: str) -> dict[str, str]:
    return {"x-forwarded-for": address}


async def _fail(client, username: str, times: int, address: str | None = None) -> None:
    headers = _from(address) if address else {}
    for _ in range(times):
        bad = await client.post("/api/login", json={"username": username, **BAD}, headers=headers)
        assert bad.status_code == 401


async def test_the_429_says_how_long_and_carries_retry_after(client, db):
    await make_user(db, "viewer")
    await _fail(client, "viewer", 5)
    blocked = await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})
    assert blocked.status_code == 429
    assert blocked.json() == {"detail": "too many failed attempts, try again in about 5 minutes"}
    assert 295 <= int(blocked.headers["retry-after"]) <= 300


@pytest.mark.parametrize(
    "seconds,wording,retry_after",
    [
        (90.0, "about 2 minutes", "90"),
        (60.0, "about 1 minute", "60"),
        (0.2, "about 1 minute", "1"),  # the last fraction of a second still says a minute and waits one second
        (300.0, "about 5 minutes", "300"),
        (300.5, "about 6 minutes", "301"),  # both round up: a plain round() or int() would say 5 minutes and 300
    ],
)
def test_the_429_rounds_the_minutes_and_the_seconds_up(seconds, wording, retry_after):
    error = auth_module._too_many(seconds)
    assert error.status_code == 429
    assert error.detail == f"too many failed attempts, try again in {wording}"
    assert error.headers == {"Retry-After": retry_after}


async def test_the_429_for_a_one_minute_block_says_1_minute_in_the_singular(client, db):
    await make_user(db, "viewer")
    # The limiter's numbers come from the stored policy on every attempt, so a direct configure() would be overwritten.
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('sign_in', '{\"max_failures\": 5, \"block_minutes\": 1}'::jsonb)"
    )
    await _fail(client, "viewer", 5)
    one = await client.post("/api/login", json={"username": "viewer", "password": "correct-horse"})
    assert one.json()["detail"] == "too many failed attempts, try again in about 1 minute"
    assert int(one.headers["retry-after"]) >= 1


async def test_addresses_are_counted_separately(client, db):
    await make_user(db, "viewer")
    await _fail(client, "viewer", 5, "9.9.9.9")
    blocked = await client.post("/api/login", json=GOOD, headers=_from("9.9.9.9"))
    assert blocked.status_code == 429
    other = await client.post("/api/login", json={"username": "viewer", **BAD}, headers=_from("8.8.8.8"))
    assert other.status_code == 401  # reaches the password check, not the block
    own = await client.post("/api/login", json=GOOD, headers=_from("8.8.8.8"))
    assert own.status_code == 200


async def test_a_client_sent_forwarded_for_counts_as_its_last_entry(client, db):
    await make_user(db, "viewer")
    await _fail(client, "viewer", 5, "1.1.1.1, 9.9.9.9")
    assert (await client.post("/api/login", json={"username": "viewer", **BAD}, headers=_from("9.9.9.9"))).status_code == 429
    assert (await client.post("/api/login", json={"username": "viewer", **BAD}, headers=_from("1.1.1.1"))).status_code == 401


async def test_a_successful_sign_in_resets_only_its_own_key(client, db):
    await make_user(db, "viewer")
    await _fail(client, "viewer", 2, "9.9.9.9")
    await _fail(client, "viewer", 2, "8.8.8.8")
    ok = await client.post("/api/login", json=GOOD, headers=_from("9.9.9.9"))
    assert ok.status_code == 200
    await _fail(client, "viewer", 4, "9.9.9.9")  # its count started again, so 4 more do not block
    await _fail(client, "viewer", 2, "8.8.8.8")  # 2 + 2 = 4 is still below 5
    await _fail(client, "viewer", 1, "8.8.8.8")  # the fifth, never reset by the other address' sign-in
    assert (await client.post("/api/login", json={"username": "viewer", **BAD}, headers=_from("8.8.8.8"))).status_code == 429


async def test_password_change_and_sign_in_share_one_key(client, db):
    await login_as(client, db, "viewer")
    await _fail(client, "viewer", 3, "5.5.5.5")
    body = {"current_password": "wrong-wrong", "new_password": "newpassword1"}
    for _ in range(2):
        assert (await client.post("/api/me/password", json=body, headers=_from("5.5.5.5"))).status_code == 401
    blocked = await client.post("/api/login", json=GOOD, headers=_from("5.5.5.5"))
    assert blocked.status_code == 429
    elsewhere = await client.post("/api/me/password", json=body, headers=_from("6.6.6.6"))
    assert elsewhere.status_code == 401


async def test_user_names_are_not_folded_together_in_the_key(client, db):
    await make_user(db, "bob")
    await make_user(db, "Bob")
    await _fail(client, "BOB", 5)  # an unknown name typed in capitals
    assert (await client.post("/api/login", json={"username": "BOB", **BAD})).status_code == 429
    for name in ("bob", "Bob"):
        ok = await client.post("/api/login", json={"username": name, "password": "correct-horse"})
        assert ok.status_code == 200, name
    await _fail(client, "bob", 5)
    assert (await client.post("/api/login", json={"username": "bob", "password": "correct-horse"})).status_code == 429
    assert (await client.post("/api/login", json={"username": "Bob", "password": "correct-horse"})).status_code == 200


def test_clear_on_the_shared_limiter_restores_the_constructor_numbers():
    limiter = auth_module.limiter
    limiter.configure(3, 60)
    limiter.clear()
    try:
        for _ in range(4):
            limiter.record_failure("k")
        assert not limiter.blocked("k")  # 5 failures are needed again, not 3
        limiter.record_failure("k")
        assert limiter.blocked("k") and 299 < limiter.retry_after("k") <= 300
    finally:
        limiter.clear()


# ---- the permissions an answer carries ----------------------------------------------------------------------------------

async def test_setup_and_login_and_me_list_the_admin_s_permissions_sorted(client):
    created = await client.post("/api/setup", json=ADMIN)
    assert created.json()["role"] == "admin"
    assert created.json()["permissions"] == sorted(ALL_IDS) and len(ALL_IDS) == 28
    assert (await client.get("/api/me")).json()["permissions"] == sorted(ALL_IDS)
    await client.post("/api/logout")
    assert (await client.post("/api/login", json=ADMIN)).json()["permissions"] == sorted(ALL_IDS)


@pytest.mark.parametrize("role", ["viewer", "operator", "admin"])
async def test_each_built_in_role_lists_exactly_its_set(client, db, role):
    await make_user(db, "ann", role)
    login = await client.post("/api/login", json={"username": "ann", "password": "correct-horse"})
    assert login.json()["role"] == role
    assert login.json()["permissions"] == sorted(BUILTIN[role])
    me = (await client.get("/api/me")).json()
    assert me["role"] == role and me["permissions"] == sorted(BUILTIN[role])


async def test_a_custom_role_user_lists_only_what_its_role_really_grants(client, db):
    # roles.manage, an unknown id and a non-string in the stored list are ignored, and the list answers sorted.
    await make_role(db, "night shift", ["users.view", "assets.view", "roles.manage", "bogus.thing", 7, "assets.view"])
    await make_user(db, "nora", "night shift")
    login = await client.post("/api/login", json={"username": "nora", "password": "correct-horse"})
    assert login.json()["role"] == "night shift"
    assert login.json()["permissions"] == ["assets.view", "users.view"]
    assert (await client.get("/api/me")).json()["permissions"] == ["assets.view", "users.view"]


async def test_a_role_with_no_permissions_lists_none(client, db):
    await make_role(db, "nothing")
    await make_user(db, "nina", "nothing")
    assert (await client.post("/api/login", json={"username": "nina", "password": "correct-horse"})).json()["permissions"] == []


async def test_a_permission_removed_from_the_role_is_gone_from_the_next_answer(client, db):
    role = await make_role(db, "night shift", ["assets.view", "audit.view"])
    await make_user(db, "nora", "night shift")
    await client.post("/api/login", json={"username": "nora", "password": "correct-horse"})
    assert (await client.get("/api/me")).json()["permissions"] == ["assets.view", "audit.view"]
    await db.execute("UPDATE roles SET permissions = '[\"assets.view\"]'::jsonb WHERE id = $1", role)
    assert (await client.get("/api/me")).json()["permissions"] == ["assets.view"]


async def test_a_built_in_role_ignores_what_its_stored_mirror_says(client, db):
    await db.execute("UPDATE roles SET permissions = '[\"users.edit\", \"roles.manage\"]'::jsonb WHERE name = 'viewer'")
    await make_user(db, "vee", "viewer")
    await client.post("/api/login", json={"username": "vee", "password": "correct-horse"})
    assert (await client.get("/api/me")).json()["permissions"] == sorted(BUILTIN["viewer"])
