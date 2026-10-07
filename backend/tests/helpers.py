import asyncio
import contextlib

import asyncpg

from dcdash.core.crypto import encrypt


async def make_source(db, name="sim", connector_type="simulator", config=None, secret=None, enabled=True) -> int:
    return await db.fetchval(
        "INSERT INTO sources (name, connector_type, config, secret, enabled) "
        "VALUES ($1, $2, $3, $4, $5) RETURNING id",
        name, connector_type, config or {}, encrypt(secret) if secret else None, enabled,
    )


async def make_point(db, source_id: int, address: str) -> int:
    return await db.fetchval(
        "INSERT INTO points (source_id, address, name) VALUES ($1, $2, $2) RETURNING id",
        source_id, address,
    )


async def make_asset(db, name: str, parent_id: int | None = None) -> int:
    return await db.fetchval(
        "INSERT INTO assets (name, parent_id) VALUES ($1, $2) RETURNING id", name, parent_id
    )


async def make_mapping(db, point_id: int, asset_id: int, metric="active_power_kw", interval=5, scale=1.0) -> int:
    return await db.fetchval(
        "INSERT INTO mappings (point_id, asset_id, metric, interval_seconds, scale) "
        "VALUES ($1, $2, $3, $4, $5) RETURNING id",
        point_id, asset_id, metric, interval, scale,
    )


@contextlib.asynccontextmanager
async def listening(database_url: str, channel: str):
    """Yield a queue that receives the payload of every NOTIFY on `channel`."""
    conn = await asyncpg.connect(database_url)
    received: asyncio.Queue[str] = asyncio.Queue()
    await conn.add_listener(channel, lambda _c, _pid, _ch, payload: received.put_nowait(payload))
    try:
        yield received
    finally:
        await conn.close()


async def wait_for(check, expected, timeout: float = 10.0):
    """Poll the async callable `check` until it returns `expected`."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        value = await check()
        if value == expected:
            return value
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"timed out: last value {value!r}, expected {expected!r}")
        await asyncio.sleep(0.1)
