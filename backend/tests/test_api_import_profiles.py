"""The import-profile routes (w31): GET / PUT / DELETE /api/import-profiles, gated by readings.import."""
import asyncio
import json

import pytest

from dcdash.ingest.import_profile import MAX_PROFILES
from helpers import login_as, make_role

PROFILE = {"tag": "Tag", "time": "Time", "value": "Value"}
URL = "/api/import-profiles"


async def audit_rows(db, action: str) -> list[dict]:
    rows = await db.fetch("SELECT detail FROM audit_log WHERE action = $1 ORDER BY id", action)
    return [json.loads(row["detail"]) if isinstance(row["detail"], str) else dict(row["detail"]) for row in rows]


async def fill(db, count: int) -> None:
    """`count` stored profiles named p00, p01, ... written straight into the settings row."""
    profiles = {f"p{n:02d}": {**PROFILE, "name": f"p{n:02d}"} for n in range(count)}
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('import_profiles', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"profiles": profiles},
    )


async def stored_names(db) -> list[str]:
    value = await db.fetchval("SELECT value FROM settings WHERE key = 'import_profiles'")
    value = json.loads(value) if isinstance(value, str) else value
    return sorted(value["profiles"]) if value else []


# ---- who may call them -------------------------------------------------------------------------------------------------

async def test_nobody_signed_out_may_call_them(client, db):
    assert (await client.get(URL)).status_code == 401
    assert (await client.put(f"{URL}/x", json=PROFILE)).status_code == 401
    assert (await client.delete(f"{URL}/x")).status_code == 401


@pytest.mark.parametrize("role", ["viewer", "operator"])
async def test_the_built_in_viewer_and_operator_are_refused(client, db, role):
    await login_as(client, db, role)
    assert (await client.get(URL)).status_code == 403
    assert (await client.put(f"{URL}/x", json=PROFILE)).status_code == 403
    assert (await client.delete(f"{URL}/x")).status_code == 403
    assert await stored_names(db) == []


async def test_a_custom_role_needs_readings_import_itself(client, db):
    await make_role(db, "nearly", ["sources.view", "sources.edit", "discovery.accept"])
    await login_as(client, db, "nearly")
    assert (await client.get(URL)).status_code == 403
    await make_role(db, "importer", ["readings.import"])
    await login_as(client, db, "importer")
    assert (await client.get(URL)).status_code == 200
    assert (await client.put(f"{URL}/mine", json=PROFILE)).status_code == 200
    assert (await client.delete(f"{URL}/mine")).status_code == 204


# ---- save, list, delete ------------------------------------------------------------------------------------------------

async def test_the_list_starts_empty(client, db):
    await login_as(client, db)
    assert (await client.get(URL)).json() == {"profiles": []}


async def test_a_saved_profile_comes_back_whole_and_is_listed_sorted_by_name(client, db):
    await login_as(client, db)
    saved = await client.put(f"{URL}/zeta", json={**PROFILE, "decimal": ",", "delimiter": ";"})
    assert saved.status_code == 200
    assert saved.json() == {
        "name": "zeta", "tag": "Tag", "time": "Time", "value": "Value", "unit": None, "quality": None, "delimiter": ";",
        "decimal": ",", "time_format": "iso", "zone": None, "reading": "counter", "period_seconds": None, "stamp": None,
        "good_codes": ["good"],
    }
    assert (await client.put(f"{URL}/Alpha", json=PROFILE)).status_code == 200
    assert (await client.put(f"{URL}/beta", json=PROFILE)).status_code == 200
    listed = (await client.get(URL)).json()["profiles"]
    assert [p["name"] for p in listed] == ["Alpha", "beta", "zeta"]
    assert listed[2] == saved.json()


async def test_the_name_in_the_path_wins_over_the_body(client, db):
    await login_as(client, db)
    saved = await client.put(f"{URL}/Meter%20export", json={**PROFILE, "name": "something else"})
    assert saved.status_code == 200 and saved.json()["name"] == "Meter export"
    assert await stored_names(db) == ["Meter export"]


async def test_saving_again_replaces_the_profile(client, db):
    await login_as(client, db)
    await client.put(f"{URL}/hourly", json=PROFILE)
    again = await client.put(f"{URL}/hourly", json={**PROFILE, "reading": "interval", "period_seconds": 3600, "stamp": "end"})
    assert again.status_code == 200
    listed = (await client.get(URL)).json()["profiles"]
    assert len(listed) == 1 and listed[0]["reading"] == "interval" and listed[0]["period_seconds"] == 3600


async def test_a_delete_removes_one_profile_and_keeps_the_rest(client, db):
    await login_as(client, db)
    for name in ("a", "b"):
        await client.put(f"{URL}/{name}", json=PROFILE)
    assert (await client.delete(f"{URL}/a")).status_code == 204
    assert await stored_names(db) == ["b"]


async def test_deleting_an_unknown_profile_is_a_404_and_writes_nothing(client, db):
    await login_as(client, db)
    gone = await client.delete(f"{URL}/nope")
    assert gone.status_code == 404 and gone.json() == {"detail": "import profile not found"}
    assert await audit_rows(db, "import_profile.deleted") == []


# ---- refusals ----------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("body", "words"),
    [
        ({"tag": "Tag", "time": "Time"}, "value is required"),
        ({**PROFILE, "colour": "red"}, "colour is not a field of an import profile"),
        ({**PROFILE, "zone": "Mars/Base"}, "is not a time zone name"),
        ({**PROFILE, "time_format": "%b %d %Y"}, "pattern made of %Y %m %d %H %M %S %f %z"),
        ({**PROFILE, "reading": "interval"}, "needs period_seconds and a stamp"),
        ({**PROFILE, "delimiter": "|"}, "the delimiter must be a comma, a semicolon or a tab"),
        ({}, "tag is required; time is required; value is required"),
    ],
)
async def test_an_invalid_profile_is_a_422_with_one_sentence_and_nothing_is_stored(client, db, body, words):
    await login_as(client, db)
    refused = await client.put(f"{URL}/x", json=body)
    assert refused.status_code == 422
    assert isinstance(refused.json()["detail"], str) and words in refused.json()["detail"]
    assert await stored_names(db) == [] and await audit_rows(db, "import_profile.saved") == []


@pytest.mark.parametrize("name", ["a%2Fb", "x" * 61, "..", "a%00b"])
async def test_a_bad_name_in_the_path_is_refused_in_words(client, db, name):
    await login_as(client, db)
    refused = await client.put(f"{URL}/{name}", json=PROFILE)
    assert refused.status_code in (404, 422)  # a slash never reaches the route (404); the rest are the name's own sentence
    if refused.status_code == 422:
        assert "name" in refused.json()["detail"]
    assert await stored_names(db) == []


@pytest.mark.parametrize("body", [[1, 2], "text", 5, None])
async def test_a_body_that_is_not_an_object_is_a_422(client, db, body):
    await login_as(client, db)
    assert (await client.put(f"{URL}/x", json=body)).status_code == 422


# ---- the cap -----------------------------------------------------------------------------------------------------------

async def test_the_21st_profile_is_a_409_with_a_sentence_and_changes_nothing(client, db):
    await login_as(client, db)
    await fill(db, MAX_PROFILES)
    refused = await client.put(f"{URL}/one-too-many", json=PROFILE)
    assert refused.status_code == 409
    assert refused.json()["detail"] == "there are already 20 import profiles; delete one to save another"
    assert len(await stored_names(db)) == MAX_PROFILES and "one-too-many" not in await stored_names(db)
    assert await audit_rows(db, "import_profile.saved") == []


async def test_one_of_the_twenty_can_still_be_replaced_and_a_delete_makes_room(client, db):
    await login_as(client, db)
    await fill(db, MAX_PROFILES)
    assert (await client.put(f"{URL}/p07", json={**PROFILE, "decimal": ","})).status_code == 200
    assert (await client.delete(f"{URL}/p00")).status_code == 204
    assert (await client.put(f"{URL}/fresh", json=PROFILE)).status_code == 200
    assert len(await stored_names(db)) == MAX_PROFILES


async def test_two_saves_at_once_cannot_pass_the_cap(client, db):
    await login_as(client, db)
    await fill(db, MAX_PROFILES - 1)
    first, second = await asyncio.gather(client.put(f"{URL}/late-a", json=PROFILE), client.put(f"{URL}/late-b", json=PROFILE))
    assert sorted([first.status_code, second.status_code]) == [200, 409]
    assert len(await stored_names(db)) == MAX_PROFILES


async def test_two_saves_at_once_both_survive(client, db):
    await login_as(client, db)
    results = await asyncio.gather(*(client.put(f"{URL}/n{n}", json=PROFILE) for n in range(6)))
    assert [r.status_code for r in results] == [200] * 6
    assert await stored_names(db) == [f"n{n}" for n in range(6)]


# ---- the audit rows ----------------------------------------------------------------------------------------------------

async def test_a_new_profile_is_audited_with_its_fields_and_nothing_else(client, db):
    await login_as(client, db)
    await client.put(f"{URL}/hourly", json={**PROFILE, "unit": "Unit", "zone": "Africa/Cairo"})
    [row] = await audit_rows(db, "import_profile.saved")
    assert row["name"] == "hourly" and row["created"] is True
    # only the fields that have a value: the ones left out (quality, delimiter, period_seconds, stamp) are null on both sides
    assert set(row["after"]) == {"name", "tag", "time", "value", "unit", "decimal", "time_format", "zone", "reading", "good_codes"}
    assert set(row["before"]) == set(row["after"]) and all(value is None for value in row["before"].values())
    assert row["after"]["tag"] == "Tag" and row["after"]["zone"] == "Africa/Cairo"


async def test_a_changed_profile_is_audited_with_only_the_changed_fields(client, db):
    await login_as(client, db)
    await client.put(f"{URL}/hourly", json=PROFILE)
    await db.execute("DELETE FROM audit_log")
    await client.put(f"{URL}/hourly", json={**PROFILE, "decimal": ",", "delimiter": ";"})
    [row] = await audit_rows(db, "import_profile.saved")
    assert row == {
        "name": "hourly", "created": False,
        "before": {"decimal": ".", "delimiter": None}, "after": {"decimal": ",", "delimiter": ";"},
    }


async def test_a_save_that_changes_nothing_writes_no_audit_row(client, db):
    await login_as(client, db)
    await client.put(f"{URL}/hourly", json=PROFILE)
    await db.execute("DELETE FROM audit_log")
    assert (await client.put(f"{URL}/hourly", json=PROFILE)).status_code == 200
    assert await audit_rows(db, "import_profile.saved") == []


async def test_a_delete_is_audited_by_name(client, db):
    await login_as(client, db)
    await client.put(f"{URL}/hourly", json=PROFILE)
    await client.delete(f"{URL}/hourly")
    assert await audit_rows(db, "import_profile.deleted") == [{"name": "hourly"}]
