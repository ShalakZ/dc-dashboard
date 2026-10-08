import asyncio
import contextlib
import socket
from datetime import timedelta

import asyncpg
import httpx

from dcdash.api.security import hash_password
from dcdash.connectors.simulator import SimulatorConfig, SimulatorConnector
from dcdash.core.crypto import encrypt
from dcdash.simulator.model import Simulator
from dcdash.simulator.modbus import ModbusSim
from dcdash.simulator.opcua import OpcUaSim


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


def sim_factory(sim_app):
    """A ConnectorFactory whose simulator connectors talk to an in-process app."""

    def factory(type_name, config, secret):
        return SimulatorConnector(
            SimulatorConfig(**config), secret, transport=httpx.ASGITransport(app=sim_app)
        )

    return factory


async def login_as(client, db, role="admin", username=None, password="correct-horse") -> None:
    """Create a user with the given role if needed, and sign the client in as them."""
    username = username or role
    await db.execute(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) "
        "ON CONFLICT (username) DO NOTHING",
        username, hash_password(password), role,
    )
    response = await client.post("/api/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def free_ports(count: int) -> list[int]:
    """`count` different free ports: free_port() can return the same number twice in a row, and a scan counts a
    repeated port once."""
    ports: list[int] = []
    while len(ports) < count:
        port = free_port()
        if port not in ports:
            ports.append(port)
    return ports


@contextlib.asynccontextmanager
async def opcua_server(sim: Simulator | None = None, password: str | None = None):
    """Run an in-process OPC UA simulator server on a free port."""
    srv = OpcUaSim(sim or Simulator(), free_port(), password=password)
    await srv.start()
    await srv.refresh()
    try:
        yield srv
    finally:
        await srv.stop()


@contextlib.asynccontextmanager
async def modbus_server(sim: Simulator | None = None):
    """Run an in-process Modbus TCP simulator server on a free port."""
    srv = ModbusSim(sim or Simulator(), free_port())
    await srv.start()
    srv.refresh()
    try:
        yield srv
    finally:
        await srv.stop()


@contextlib.asynccontextmanager
async def http_server(app):
    """Serve an ASGI app on a free 127.0.0.1 port with uvicorn; yields the port."""
    import uvicorn

    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    try:
        yield port
    finally:
        server.should_exit = True
        await task


@contextlib.asynccontextmanager
async def silent_server():
    """A TCP server that accepts connections and never answers; yields its port."""
    held = []

    async def handle(reader, writer):
        held.append((writer, asyncio.current_task()))
        await asyncio.sleep(3600)

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    try:
        yield server.sockets[0].getsockname()[1]
    finally:
        for writer, task in held:
            writer.close()
            task.cancel()
        server.close()
        await server.wait_closed()


async def insert_readings(db, point_id: int, start, step_seconds: float, values: list[float]) -> None:
    rows = [(point_id, start + timedelta(seconds=i * step_seconds), v, 0) for i, v in enumerate(values)]
    await db.executemany("INSERT INTO readings (point_id, ts, value, quality) VALUES ($1, $2, $3, $4)", rows)


async def refresh_rollup(db, view: str) -> None:
    """Refresh a rollup over all time, waiting out a policy job that is refreshing it right now.

    A migration round-trip test re-creates the refresh policies, and a new policy job can start at once, so the view
    may be locked ("concurrent refresh"); the lock clears when the job finishes. refresh_continuous_aggregate must run
    outside a transaction, which asyncpg's autocommitting pool.execute satisfies.
    """
    for attempt in range(50):
        try:
            await db.execute(f"CALL refresh_continuous_aggregate('{view}', NULL, NULL)")
            return
        except asyncpg.LockNotAvailableError:
            if attempt == 49:
                raise
            await asyncio.sleep(0.2)


async def settle_rollups(db) -> None:
    """Materialize both rollups now, so a test never depends on where the policy jobs left the real-time watermark."""
    await refresh_rollup(db, "readings_1m")
    await refresh_rollup(db, "readings_1h")  # built on readings_1m: refresh in this order


_REFRESH_POLICIES = """
    SELECT ca.view_name,
           (j.config->>'start_offset')::interval AS start_offset,
           (j.config->>'end_offset')::interval AS end_offset,
           j.schedule_interval
    FROM timescaledb_information.jobs j
    JOIN timescaledb_information.continuous_aggregates ca
      ON j.hypertable_name IN (ca.view_name, ca.materialization_hypertable_name)
    WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
"""


async def refresh_policies(db) -> dict[str, tuple[timedelta, timedelta, timedelta]]:
    """Each continuous aggregate's refresh policy: view name -> (start_offset, end_offset, schedule_interval).

    The offsets are cast to `interval` in SQL, so the test does not depend on how the config JSON spells them.
    """
    return {
        r["view_name"]: (r["start_offset"], r["end_offset"], r["schedule_interval"])
        for r in await db.fetch(_REFRESH_POLICIES)
    }
