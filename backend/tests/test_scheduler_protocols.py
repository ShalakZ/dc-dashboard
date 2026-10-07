import asyncio

from dcdash.collector.scheduler import load_groups, run_group
from dcdash.collector.writer import Writer
from dcdash.connectors.base import create_connector
from dcdash.simulator.model import Simulator
from tests.helpers import make_asset, make_mapping, make_point, make_source, modbus_server, opcua_server, wait_for


async def _status(db, sid):
    row = await db.fetchrow("SELECT status, last_error FROM sources WHERE id = $1", sid)
    return row["status"], row["last_error"]


async def _first(db, sid):
    return (await _status(db, sid))[0]


async def _group(db, sid):
    return next(g for g in await load_groups(db) if g.source_id == sid)


async def test_opcua_source_outage_is_reported_and_recovers(db):
    sim = Simulator()
    async with opcua_server(sim) as srv:
        cfg = {"endpoint": srv.endpoint.replace("0.0.0.0", "127.0.0.1"), "timeout_seconds": 1}
        sid = await make_source(db, name="ua", connector_type="opcua", config=cfg)
        address = next(p.address for p in await create_connector("opcua", cfg).browse() if p.name == "LVP01 V")
        pid = await make_point(db, sid, address)
        aid = await make_asset(db, "Hall")
        await make_mapping(db, pid, aid, interval=1)
        task = asyncio.create_task(run_group(await _group(db, sid), db, Writer(db)))
        try:
            await wait_for(lambda: _first(db, sid), "online")
            await srv.stop()
            await wait_for(lambda: _first(db, sid), "offline")
            _, err = await _status(db, sid)
            assert err.startswith("unreachable:")
            await srv.start()
            await wait_for(lambda: _first(db, sid), "online", timeout=20)
        finally:
            task.cancel()


async def test_modbus_needs_profile_is_surfaced(db, monkeypatch):
    from dcdash.connectors import modbus as mod
    monkeypatch.setattr(mod, "match_profile", lambda v, p: None)
    async with modbus_server() as srv:
        sid = await make_source(db, name="mb", connector_type="modbus",
                                config={"host": "127.0.0.1", "port": srv.port, "timeout_seconds": 1})
        pid = await make_point(db, sid, "3:4")
        aid = await make_asset(db, "Hall")
        await make_mapping(db, pid, aid, interval=1)
        task = asyncio.create_task(run_group(await _group(db, sid), db, Writer(db)))
        try:
            await wait_for(lambda: _first(db, sid), "offline")
            _, err = await _status(db, sid)
            assert err.startswith("needs_profile:")
        finally:
            task.cancel()
