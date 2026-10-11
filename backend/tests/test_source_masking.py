"""A source's config is shown with its URL credentials and credential-named keys hidden, and editing it keeps them."""

import json

import pytest

from dcdash.core.audit import reconcile_config, scrub_url_credentials, strip_credentials
from helpers import login_as, make_source

PASSWORD = "Zq9-unique-pw"
STORED_URL = f"http://svc:{PASSWORD}@simulator:9000/"  # with the trailing slash validated_config would add
MASKED_URL = "http://simulator:9000/"
OVER_MASKED_STORED = f"opc.tcp://svc:pa/ss-{PASSWORD}@host:4840/x"  # an unencoded "/" ends the netloc early
OVER_MASKED_SHOWN = "opc.tcp://[hidden]@host:4840/x"


# --- scrub_url_credentials -------------------------------------------------------------------------------------------


def test_scrub_url_credentials_hides_what_precedes_the_at_sign_of_a_url():
    assert scrub_url_credentials("connect failed: http://svc:Zq9@simulator:9000/x (timeout)") == (
        "connect failed: http://[hidden]@simulator:9000/x (timeout)"
    )
    assert scrub_url_credentials("a http://u:p1@h1:1 and opc.tcp://v:p2@h2:2/x end") == (
        "a http://[hidden]@h1:1 and opc.tcp://[hidden]@h2:2/x end"
    )
    assert scrub_url_credentials("Client error for url 'http://svc:Zq9@simulator:9000/points'") == (
        "Client error for url 'http://[hidden]@simulator:9000/points'"
    )
    assert scrub_url_credentials("(http://svc:Zq9@sim:9000): refused") == "(http://[hidden]@sim:9000): refused"


def test_scrub_url_credentials_leaves_other_text_alone():
    for text in ("", "connect failed (timeout)", "mail me at user@example.com", "http://simulator:9000/x", "[hidden]"):
        assert scrub_url_credentials(text) == text
    once = scrub_url_credentials("failed http://svc:Zq9@sim:9000/x")
    assert scrub_url_credentials(once) == once  # scrubbing twice changes nothing


def test_scrub_url_credentials_also_replaces_the_known_values():
    assert scrub_url_credentials("login svc:p w rejected at http://svc:p w@host", known=["svc:p w"]) == (
        "login [hidden] rejected at http://[hidden]@host"
    )
    assert scrub_url_credentials("token abc123 was refused", known=["abc123", ""]) == "token [hidden] was refused"
    assert scrub_url_credentials("nothing to hide", known={"url": "svc:pw"}.values()) == "nothing to hide"
    # a longer known value goes before a shorter one that it contains
    assert scrub_url_credentials("p and pw and p", known=["p", "pw"]) == "[hidden] and [hidden] and [hidden]"


# --- strip_credentials ------------------------------------------------------------------------------------------------


def test_strip_credentials_removes_them_for_real():
    assert strip_credentials("http://user:pw@host:9000/x?y=1") == "http://host:9000/x?y=1"
    assert strip_credentials("opc.tcp://u@10.0.0.1:4840") == "opc.tcp://10.0.0.1:4840"
    assert strip_credentials(OVER_MASKED_STORED) == "opc.tcp://host:4840/x"  # NOT opc.tcp://[hidden]@host:4840/x
    for url, expected in {
        "opc.tcp://user:p#ss@10.0.0.1:4840": "opc.tcp://10.0.0.1:4840",
        "opc.tcp://user:p?ss@10.0.0.1:4840": "opc.tcp://10.0.0.1:4840",
        "http://us/er:pw@host:9000": "http://host:9000",
        "opc.tcp://admin@corp.com:p#ss@10.0.0.1:4840": "opc.tcp://10.0.0.1:4840",
        "opc.tcp://user:p[ss@10.0.0.1:4840": "opc.tcp://10.0.0.1:4840",  # urlsplit raises ValueError
    }.items():
        assert strip_credentials(url) == expected, url
        assert "[hidden]" not in strip_credentials(url)


def test_strip_credentials_keeps_what_has_nothing_to_hide():
    for url in ("http://host/x", "http://host:9000", "not a url", "me@example.com", "http://[::1", ""):
        assert strip_credentials(url) == url, url


# --- reconcile_config -------------------------------------------------------------------------------------------------


def test_reconcile_config_keeps_a_stored_value_that_comes_back_masked():
    stored = {"url": STORED_URL, "timeout_seconds": 5.0, "note": "x"}
    submitted = {"url": MASKED_URL, "timeout_seconds": 9.0, "note": "y"}
    assert reconcile_config(stored, submitted, set()) == {"url": STORED_URL, "timeout_seconds": 9.0, "note": "y"}


def test_reconcile_config_replaces_a_value_that_is_not_the_masked_one():
    stored = {"url": STORED_URL}
    assert reconcile_config(stored, {"url": "http://other:9000/"}, set()) == {"url": "http://other:9000/"}
    new = {"url": "http://svc:new@other:9000/"}
    assert reconcile_config(stored, new, set()) == new


def test_reconcile_config_leaves_keys_without_a_hidden_part_and_absent_keys_alone():
    stored = {"url": STORED_URL, "timeout_seconds": 5.0}
    assert reconcile_config(stored, {"timeout_seconds": 5.0}, set()) == {"timeout_seconds": 5.0}  # absent stays absent
    assert reconcile_config(stored, {}, {"url"}) == {}
    assert reconcile_config({"url": "http://plain:9000/"}, {"url": "http://plain:9000/"}, {"url"}) == {
        "url": "http://plain:9000/"
    }
    assert reconcile_config({}, {"a": 1}, {"a"}) == {"a": 1}


def test_reconcile_config_clear_strips_a_url_for_real_and_empties_a_credential_named_key():
    stored = {"url": STORED_URL, "endpoint": OVER_MASKED_STORED, "api_key": "k-123", "password": ""}
    submitted = {"url": MASKED_URL, "endpoint": OVER_MASKED_SHOWN, "api_key": "[hidden]", "password": "[hidden]"}
    kept = reconcile_config(stored, submitted, set())
    assert kept == {"url": STORED_URL, "endpoint": OVER_MASKED_STORED, "api_key": "k-123", "password": ""}
    cleared = reconcile_config(stored, submitted, {"url", "endpoint", "api_key"})
    assert cleared == {"url": MASKED_URL, "endpoint": "opc.tcp://host:4840/x", "api_key": "", "password": ""}
    assert "[hidden]" not in json.dumps(cleared)


def test_reconcile_config_does_not_touch_its_arguments():
    stored, submitted = {"url": STORED_URL}, {"url": MASKED_URL}
    reconcile_config(stored, submitted, {"url"})
    assert stored == {"url": STORED_URL} and submitted == {"url": MASKED_URL}


# --- the API ----------------------------------------------------------------------------------------------------------


async def seed_credentialed(db, name="cred", url=STORED_URL) -> int:
    return await make_source(db, name, "simulator", {"url": url, "timeout_seconds": 5.0})


async def stored_config(db, source_id: int) -> dict:
    return await db.fetchval("SELECT config FROM sources WHERE id = $1", source_id)


async def listed(client, name="cred") -> dict:
    return next(s for s in (await client.get("/api/sources")).json() if s["name"] == name)


async def update_rows(db):
    return await db.fetch("SELECT detail FROM audit_log WHERE action = 'source.updated' ORDER BY id")


async def test_the_list_shows_a_source_without_its_credentials_and_says_what_it_hid(client, db):
    await login_as(client, db)
    await seed_credentialed(db)
    await make_source(db, "plain", "simulator", {"url": "http://plain:9000/", "timeout_seconds": 5.0})
    response = await client.get("/api/sources")
    assert response.status_code == 200 and PASSWORD not in response.text and "svc:" not in response.text
    by_name = {s["name"]: s for s in response.json()}
    assert by_name["cred"]["config"] == {"url": MASKED_URL, "timeout_seconds": 5.0}
    assert by_name["cred"]["hidden_config_keys"] == ["url"]
    assert by_name["plain"]["config"]["url"] == "http://plain:9000/" and by_name["plain"]["hidden_config_keys"] == []


async def test_last_error_in_the_list_loses_the_credentials(client, db):
    await login_as(client, db)
    source_id = await seed_credentialed(db, url="http://svc:p w@simulator:9000/")
    await db.execute(
        "UPDATE sources SET last_error = $2 WHERE id = $1", source_id,
        "connect failed: http://svc:Zq9-unique-pw@simulator:9000 (timeout); login svc:p w refused",
    )
    shown = (await listed(client))["last_error"]
    assert shown == "connect failed: http://[hidden]@simulator:9000 (timeout); login [hidden] refused"


async def test_a_rename_leaves_the_stored_credentials_untouched(client, db):
    await login_as(client, db)
    source_id = await seed_credentialed(db)
    response = await client.patch(f"/api/sources/{source_id}", json={"name": "renamed"})
    assert response.status_code == 200 and PASSWORD not in response.text
    assert (await stored_config(db, source_id))["url"] == STORED_URL


async def test_sending_back_what_get_returned_keeps_the_stored_credentials_and_audits_no_credential_change(client, db):
    await login_as(client, db)
    source_id = await seed_credentialed(db)
    shown = await listed(client)
    response = await client.patch(f"/api/sources/{source_id}", json={"config": shown["config"]})
    assert response.status_code == 200 and PASSWORD not in response.text
    assert (await stored_config(db, source_id)) == {"url": STORED_URL, "timeout_seconds": 5.0}
    assert await update_rows(db) == []  # nothing changed, so nothing was audited
    # the same, together with a real change: the audit row has the change and no credentials marker
    again = await client.patch(f"/api/sources/{source_id}", json={"name": "renamed", "config": shown["config"]})
    assert again.status_code == 200
    assert (await stored_config(db, source_id))["url"] == STORED_URL
    (row,) = await update_rows(db)
    assert "config_credentials" not in row["detail"]["before"] and "config_credentials" not in row["detail"]["after"]
    assert row["detail"]["after"] == {"name": "renamed"}
    assert PASSWORD not in json.dumps(row["detail"])


async def test_a_different_host_without_credentials_stores_the_url_without_them(client, db):
    await login_as(client, db)
    source_id = await seed_credentialed(db)
    response = await client.patch(f"/api/sources/{source_id}", json={"config": {"url": "http://other:9000"}})
    assert response.status_code == 200
    assert (await stored_config(db, source_id))["url"] == "http://other:9000/"
    assert response.json()["hidden_config_keys"] == []
    (row,) = await update_rows(db)
    assert row["detail"]["before"]["config_credentials"] == "unchanged"
    assert row["detail"]["after"]["config_credentials"] == "changed"
    assert PASSWORD not in json.dumps(row["detail"])


async def test_new_credentials_are_stored_and_never_echoed(client, db):
    await login_as(client, db)
    source_id = await seed_credentialed(db)
    new_url = "http://svc2:Zq9-new-pw@other:9000"
    response = await client.patch(f"/api/sources/{source_id}", json={"config": {"url": new_url}})
    assert response.status_code == 200
    assert "Zq9-new-pw" not in response.text and PASSWORD not in response.text and "svc2" not in response.text
    assert response.json()["config"]["url"] == "http://other:9000/" and response.json()["hidden_config_keys"] == ["url"]
    assert (await stored_config(db, source_id))["url"] == "http://svc2:Zq9-new-pw@other:9000/"
    (row,) = await update_rows(db)
    assert "Zq9-new-pw" not in json.dumps(row["detail"]) and PASSWORD not in json.dumps(row["detail"])


async def test_clear_config_credentials_stores_the_url_without_them(client, db):
    await login_as(client, db)
    source_id = await seed_credentialed(db)
    body = {"config": {"url": MASKED_URL}, "clear_config_credentials": ["url"]}
    response = await client.patch(f"/api/sources/{source_id}", json=body)
    assert response.status_code == 200 and response.json()["hidden_config_keys"] == []
    assert (await stored_config(db, source_id))["url"] == MASKED_URL
    (row,) = await update_rows(db)
    assert row["detail"]["before"]["config_credentials"] == "unchanged"
    assert row["detail"]["after"]["config_credentials"] == "changed"
    assert PASSWORD not in json.dumps(row["detail"])


async def test_clear_config_credentials_for_a_key_with_nothing_hidden_is_ignored(client, db):
    await login_as(client, db)
    source_id = await make_source(db, "plain", "simulator", {"url": "http://plain:9000/", "timeout_seconds": 5.0})
    body = {"config": {"url": "http://plain:9000/", "timeout_seconds": 5.0}, "clear_config_credentials": ["url", "x"]}
    response = await client.patch(f"/api/sources/{source_id}", json=body)
    assert response.status_code == 200
    assert await stored_config(db, source_id) == {"url": "http://plain:9000/", "timeout_seconds": 5.0}
    assert await update_rows(db) == []


async def test_clear_config_credentials_takes_at_most_twenty_keys(client, db):
    await login_as(client, db)
    source_id = await seed_credentialed(db)
    url = f"/api/sources/{source_id}"
    twenty = [f"k{i}" for i in range(20)]
    assert (await client.patch(url, json={"clear_config_credentials": twenty})).status_code == 200
    assert (await client.patch(url, json={"clear_config_credentials": [*twenty, "k20"]})).status_code == 422


async def test_an_over_masked_url_round_trips_and_clearing_it_stores_a_real_url(client, db):
    await login_as(client, db)
    source_id = await make_source(db, "plc", "opcua", {"endpoint": OVER_MASKED_STORED})
    shown = await listed(client, "plc")
    assert shown["config"]["endpoint"] == OVER_MASKED_SHOWN and shown["hidden_config_keys"] == ["endpoint"]
    assert PASSWORD not in json.dumps(shown)
    url = f"/api/sources/{source_id}"
    kept = await client.patch(url, json={"config": {"endpoint": OVER_MASKED_SHOWN}})
    assert kept.status_code == 200, kept.text
    assert (await stored_config(db, source_id))["endpoint"] == OVER_MASKED_STORED
    cleared = await client.patch(
        url, json={"config": {"endpoint": OVER_MASKED_SHOWN}, "clear_config_credentials": ["endpoint"]}
    )
    assert cleared.status_code == 200, cleared.text
    assert (await stored_config(db, source_id))["endpoint"] == "opc.tcp://host:4840/x"  # not [hidden]@
    assert cleared.json()["hidden_config_keys"] == []
    assert cleared.json()["config"]["endpoint"] == "opc.tcp://host:4840/x"


async def test_a_failed_edit_does_not_echo_the_stored_credentials(client, db):
    await login_as(client, db)
    # The stored URL fails today's schema (an unencoded "/" in the password makes the port invalid), so putting the
    # stored value back for validation fails, and the 422 must not carry it.
    source_id = await seed_credentialed(db, url=f"http://svc:pa/ss-{PASSWORD}@simulator:9000")
    shown = await listed(client)
    assert PASSWORD not in json.dumps(shown)
    response = await client.patch(f"/api/sources/{source_id}", json={"config": shown["config"]})
    assert response.status_code == 422
    assert PASSWORD not in response.text
    assert (await stored_config(db, source_id))["url"] == f"http://svc:pa/ss-{PASSWORD}@simulator:9000"


async def test_a_failed_save_does_not_echo_the_submitted_credentials_either(client, db):
    await login_as(client, db)
    source_id = await seed_credentialed(db)
    bad = {"url": "http://svc:Zq9-typed@simulator:99999999"}
    patched = await client.patch(f"/api/sources/{source_id}", json={"config": bad})
    created = await client.post("/api/sources", json={"name": "new", "connector_type": "simulator", "config": bad})
    assert patched.status_code == 422 and created.status_code == 422
    assert "Zq9-typed" not in patched.text and "Zq9-typed" not in created.text


async def test_the_answers_to_create_and_update_are_masked_too(client, db):
    await login_as(client, db)
    created = await client.post(
        "/api/sources",
        json={"name": "new", "connector_type": "simulator", "config": {"url": f"http://svc:{PASSWORD}@simulator:9000"}},
    )
    assert created.status_code == 201, created.text
    assert PASSWORD not in created.text and "svc:" not in created.text
    assert created.json()["config"]["url"] == MASKED_URL and created.json()["hidden_config_keys"] == ["url"]
    source_id = created.json()["id"]
    assert (await stored_config(db, source_id))["url"] == STORED_URL
    patched = await client.patch(f"/api/sources/{source_id}", json={"enabled": False})
    assert patched.status_code == 200 and PASSWORD not in patched.text
    assert patched.json()["config"]["url"] == MASKED_URL and patched.json()["hidden_config_keys"] == ["url"]
    assert patched.json()["has_secret"] is False and "secret" not in patched.json()


@pytest.mark.parametrize("last_error", [None, "plain failure"])
async def test_last_error_without_a_url_comes_back_as_it_is(client, db, last_error):
    await login_as(client, db)
    source_id = await seed_credentialed(db)
    await db.execute("UPDATE sources SET last_error = $2 WHERE id = $1", source_id, last_error)
    assert (await listed(client))["last_error"] == last_error
