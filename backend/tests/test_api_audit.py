from dcdash.core.audit import audit_pool
from helpers import login_as


async def test_audit_is_admin_only_and_newest_first_with_paging_and_usernames(client, db):
    await login_as(client, db, "admin")
    user = await db.fetchval("SELECT id FROM users WHERE username = 'admin'")
    for i in range(5):
        await audit_pool(db, user if i % 2 == 0 else None, f"a{i}", {"i": i})
    page = (await client.get("/api/audit?limit=2")).json()
    assert page["total"] == 5 and [e["action"] for e in page["items"]] == ["a4", "a3"]
    assert page["items"][0]["username"] == "admin" and page["items"][1]["username"] is None
    assert page["items"][0]["detail"] == {"i": 4} and page["items"][0]["ts"]
    rest = (await client.get("/api/audit?limit=2&offset=4")).json()
    assert [e["action"] for e in rest["items"]] == ["a0"]
    assert (await client.get("/api/audit?limit=0")).status_code == 422
    assert (await client.get("/api/audit?limit=201")).status_code == 422
    assert (await client.get("/api/audit?offset=-1")).status_code == 422
    await client.post("/api/logout")
    await login_as(client, db, "operator")
    assert (await client.get("/api/audit")).status_code == 403
