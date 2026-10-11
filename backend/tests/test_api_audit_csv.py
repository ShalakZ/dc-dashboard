"""The audit log as CSV: the raw log, the screen's filters, the cap (W3c Task 2)."""
import csv
import io
import json
import re

import pytest

from helpers import login_as, make_user
from test_api_audit_filters import add, at, put_zone

HEADER = ["id", "time", "user", "action", "detail"]


async def get_csv(client, query: str = "") -> list[list[str]]:
    response = await client.get(f"/api/audit.csv{'?' + query if query else ''}")
    assert response.status_code == 200, response.text
    return list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"), newline="")))


async def test_the_csv_is_the_raw_log_with_a_bom_crlf_and_the_five_columns(client, db):
    await login_as(client, db, "admin")
    await put_zone(db, "Asia/Qatar")
    first = await add(db, "asset.updated", at(2026, 10, 5, 21, 30), actor_id=7, actor_name="seven", detail={"name": "Pump", "n": 3})
    second = await add(db, "login.failed", at(2026, 10, 6, 8, 0))
    response = await client.get("/api/audit.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert re.fullmatch(r'attachment; filename="audit-\d{8}-\d{4}\.csv"', response.headers["content-disposition"])
    assert response.content.startswith(b"\xef\xbb\xbf")
    text = response.content.decode("utf-8-sig")
    assert text.endswith("\r\n") and text.count("\r\n") == 3 and "\n" not in text.replace("\r\n", "")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    assert rows[0] == HEADER
    # newest first; time is the site clock with its offset; detail is the stored JSON as text
    assert rows[1] == [str(second), "2026-10-06T11:00:00+03:00", "", "login.failed", "{}"]
    assert rows[2][:4] == [str(first), "2026-10-06T00:30:00+03:00", "seven", "asset.updated"]
    assert json.loads(rows[2][4]) == {"name": "Pump", "n": 3}


async def test_an_empty_result_is_the_header_only(client, db):
    await login_as(client, db, "admin")
    assert await get_csv(client) == [HEADER]
    await add(db, "x.y")
    assert await get_csv(client, "action=nothing.here") == [HEADER]


async def test_the_screens_filters_apply_to_the_export(client, db):
    await login_as(client, db, "admin")
    await put_zone(db, "Asia/Qatar")
    await add(db, "asset.deleted", at(2026, 10, 5, 20, 59, 59))   # the 5th, local
    keep = await add(db, "source.deleted", at(2026, 10, 5, 21, 30))  # 00:30 on the 6th, local
    await add(db, "asset.created", at(2026, 10, 5, 22, 0))
    await add(db, "asset.deleted", at(2026, 10, 6, 21, 0))        # the 7th, local
    rows = await get_csv(client, "action=*.deleted&from=2026-10-06&to=2026-10-06")
    assert [(row[0], row[3]) for row in rows[1:]] == [(str(keep), "source.deleted")]


async def test_cells_that_could_run_as_formulas_are_prefixed(client, db):
    await login_as(client, db, "admin")
    evil = await make_user(db, "=cmd")
    await db.execute("INSERT INTO audit_log (user_id, action, detail) VALUES ($1, '-x.y', '{}')", evil)
    rows = await get_csv(client)
    assert rows[1][2:4] == ["'=cmd", "'-x.y"]


async def test_the_cap_answers_422_never_a_truncated_file(client, db, monkeypatch):
    await login_as(client, db, "admin")
    monkeypatch.setattr("dcdash.api.audit.EXPORT_LIMIT", 2)
    for action in ("c.one", "c.two"):
        await add(db, action)
    assert [row[3] for row in (await get_csv(client))[1:]] == ["c.two", "c.one"]  # exactly the cap still exports
    await add(db, "c.three")
    response = await client.get("/api/audit.csv")
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail.startswith("3 entries match") and "Narrow the date range" in detail
    # narrowing under the cap works again
    assert [row[3] for row in (await get_csv(client, "action=c.three"))[1:]] == ["c.three"]


@pytest.mark.parametrize("role, status", [("operator", 403), ("viewer", 403), (None, 401)])
async def test_the_csv_is_admin_only(client, db, role, status):
    if role:
        await login_as(client, db, role)
    await add(db, "s.secret")
    response = await client.get("/api/audit.csv")
    assert response.status_code == status
    assert b"s.secret" not in response.content
