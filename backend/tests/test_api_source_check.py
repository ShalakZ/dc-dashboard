"""POST /api/sources/{id}/check: who may start a check, the one-at-a-time and cooldown guards, what is audited, and the whole
path through the collector's job runner."""
import asyncio

from dcdash.collector.jobs import run_pending_jobs
from dcdash.diagnostics.check import Checker
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.model import Simulator
from helpers import login_as, make_source, sim_factory, wait_for


def factory():
    return sim_factory(create_sim_app(Simulator(), api_key="k"))


async def audit_rows(db):
    return await db.fetch("SELECT action, detail FROM audit_log WHERE action = 'source.checked' ORDER BY id")


async def test_roles_and_a_missing_source(client, db):
    source = await make_source(db, secret="k")
    assert (await client.post(f"/api/sources/{source}/check")).status_code == 401
    await login_as(client, db, "viewer")
    assert (await client.post(f"/api/sources/{source}/check")).status_code == 403
    await login_as(client, db, "operator")
    assert (await client.post("/api/sources/999/check")).status_code == 404
    assert await audit_rows(db) == [] and await db.fetchval("SELECT count(*) FROM jobs") == 0
    response = await client.post(f"/api/sources/{source}/check")
    assert response.status_code == 202 and set(response.json()) == {"job_id"}


async def test_a_check_is_queued_audited_and_run_by_the_collector(client, db):
    await login_as(client, db, "operator")
    source = await make_source(db, name="Main", secret="k")
    job_id = (await client.post(f"/api/sources/{source}/check")).json()["job_id"]
    job = await db.fetchrow("SELECT kind, params, status, requested_by FROM jobs WHERE id = $1", job_id)
    assert (job["kind"], job["params"], job["status"]) == ("check_connection", {"source_id": source}, "pending")
    [row] = await audit_rows(db)
    assert row["detail"] == {"source_id": source, "name": "Main", "job_id": job_id}
    await run_pending_jobs(db, factory())
    body = (await client.get(f"/api/jobs/{job_id}")).json()
    assert body["status"] == "done" and body["result"]["finished"] is True and body["result"]["ok"] is True
    assert [(s["id"], s["ok"]) for s in body["result"]["steps"]] == [("test", True)]


async def test_a_second_request_while_one_is_queued_or_running_is_refused_with_its_job_id(client, db):
    await login_as(client, db, "operator")
    source = await make_source(db, secret="k")
    other = await make_source(db, name="other", secret="k")
    first = (await client.post(f"/api/sources/{source}/check")).json()["job_id"]
    queued = await client.post(f"/api/sources/{source}/check")
    assert queued.status_code == 409 and queued.json()["job_id"] == first
    assert "already running" in queued.json()["detail"]
    await db.execute("UPDATE jobs SET status = 'running' WHERE id = $1", first)
    assert (await client.post(f"/api/sources/{source}/check")).status_code == 409
    assert (await client.post(f"/api/sources/{other}/check")).status_code == 202  # another source is not blocked
    assert len(await audit_rows(db)) == 2  # the refusals wrote nothing and queued nothing
    assert await db.fetchval("SELECT count(*) FROM jobs") == 2


async def test_a_check_job_that_has_waited_for_a_down_collector_still_blocks_a_second_one(client, db):
    """No second check may be queued behind it: when the collector returns, two would hit the device at once."""
    await login_as(client, db, "operator")
    source = await make_source(db, secret="k")
    old = await db.fetchval(
        "INSERT INTO jobs (kind, params, status, created_at) "
        "VALUES ('check_connection', $1, 'pending', now() - interval '11 minutes') RETURNING id", {"source_id": source},
    )
    response = await client.post(f"/api/sources/{source}/check")
    assert response.status_code == 409 and response.json()["job_id"] == old
    assert await db.fetchval("SELECT count(*) FROM jobs") == 1


async def test_just_after_a_check_finished_the_next_one_waits_five_seconds(client, db):
    await login_as(client, db, "operator")
    source = await make_source(db, secret="k")
    first = (await client.post(f"/api/sources/{source}/check")).json()["job_id"]
    await run_pending_jobs(db, factory())
    refused = await client.post(f"/api/sources/{source}/check")
    assert refused.status_code == 429 and refused.headers["Retry-After"] == "5"
    assert "try again" in refused.json()["detail"] and await db.fetchval("SELECT count(*) FROM jobs") == 1
    await db.execute("UPDATE jobs SET finished_at = now() - interval '6 seconds' WHERE id = $1", first)
    assert (await client.post(f"/api/sources/{source}/check")).status_code == 202
    # An ordinary connection test does not count as a check.
    await db.execute("UPDATE jobs SET status = 'done', finished_at = now() - interval '1 hour' WHERE kind = 'check_connection'")
    await db.execute(
        "INSERT INTO jobs (kind, params, status, finished_at) VALUES ('test_source', $1, 'done', now())", {"source_id": source}
    )
    assert (await client.post(f"/api/sources/{source}/check")).status_code == 202


async def test_two_requests_at_once_give_one_job(client, db):
    await login_as(client, db, "operator")
    source = await make_source(db, secret="k")
    responses = await asyncio.gather(*(client.post(f"/api/sources/{source}/check") for _ in range(4)))
    assert sorted(r.status_code for r in responses) == [202, 409, 409, 409]
    assert await db.fetchval("SELECT count(*) FROM jobs WHERE kind = 'check_connection'") == 1
    assert len(await audit_rows(db)) == 1


async def test_the_steps_are_visible_through_the_jobs_api_while_the_check_is_still_running(client, db):
    await login_as(client, db, "operator")
    source = await make_source(db, secret="k")
    job_id = (await client.post(f"/api/sources/{source}/check")).json()["job_id"]
    release = asyncio.Event()

    class Slow:
        async def check(self, points, publish):
            checker = Checker("fake", publish)

            async def first() -> str:
                return "done quickly"

            async def second() -> None:
                await release.wait()

            await checker.step("dns", "DNS", first)
            await checker.step("tcp", "TCP", second, needs=("dns",))
            return await checker.finish()

        async def close(self):
            pass

    task = asyncio.create_task(run_pending_jobs(db, lambda *_args: Slow()))
    try:
        async def partial():
            body = (await client.get(f"/api/jobs/{job_id}")).json()
            result = body["result"] or {}
            return body["status"], result.get("finished"), [s["id"] for s in result.get("steps", [])]

        assert await wait_for(partial, ("running", False, ["dns"]))
    finally:
        release.set()
        await task
    final = (await client.get(f"/api/jobs/{job_id}")).json()
    assert final["status"] == "done" and final["result"]["finished"] is True and len(final["result"]["steps"]) == 2


async def test_a_password_in_an_error_never_comes_out_of_the_jobs_api(client, db):
    await login_as(client, db, "operator")
    password = "Pw-only-the-secret-knows-3391"
    source = await make_source(db, secret=password)
    job_id = (await client.post(f"/api/sources/{source}/check")).json()["job_id"]

    class Leaky:
        async def check(self, points, publish):
            checker = Checker("fake", publish)

            async def session() -> None:
                raise RuntimeError(f"login with {password} refused")

            await checker.step("session", "Session", session)
            return await checker.finish()

        async def close(self):
            pass

    await run_pending_jobs(db, lambda *_args: Leaky())
    stored = await db.fetchval("SELECT result::text FROM jobs WHERE id = $1", job_id)
    assert password not in stored and "[hidden]" in stored
    assert password not in (await client.get(f"/api/jobs/{job_id}")).text
    assert password not in str(await db.fetchval("SELECT last_error FROM sources WHERE id = $1", source))
