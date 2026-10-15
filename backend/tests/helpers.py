import asyncio
import contextlib
import os
import socket
import subprocess
import sys
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

import asyncpg
import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from dcdash.api.security import hash_password
from dcdash.connectors.simulator import SimulatorConfig, SimulatorConnector
from dcdash.core.crypto import encrypt
from dcdash.core.permissions import BUILTIN, CATALOGUE
from dcdash.simulator.faults import Faults
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
        "INSERT INTO users (username, password_hash, role_id) VALUES ($1, $2, (SELECT id FROM roles WHERE name = $3)) "
        "ON CONFLICT (username) DO NOTHING",
        username, hash_password(password), role,
    )
    response = await client.post("/api/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    # The sign-in wrote a login.succeeded audit row. Tests that list or count audit rows are about other actions, so
    # drop this user's rows here; the sign-in tests (test_security_events.py) call /api/login themselves and keep theirs.
    await db.execute(
        "DELETE FROM audit_log WHERE action = 'login.succeeded' AND user_id = (SELECT id FROM users WHERE username = $1)",
        username,
    )


async def make_user(db, username: str, role: str = "viewer", active: bool = True) -> int:
    """A user whose password is `correct-horse` (the one login_as uses). `role` is the NAME of a role that exists."""
    return await db.fetchval(
        "INSERT INTO users (username, password_hash, role_id, active) "
        "VALUES ($1, $2, (SELECT id FROM roles WHERE name = $3), $4) RETURNING id",
        username, hash_password("correct-horse"), role, active,
    )


async def make_role(db, name: str, permissions: Iterable[str] = (), description: str = "") -> int:
    """A custom role holding `permissions` (stored as given: pass junk to test that it is ignored)."""
    return await db.fetchval(
        "INSERT INTO roles (name, description, permissions) VALUES ($1, $2, $3) RETURNING id",
        name, description, list(permissions),
    )


# Permission ids added to the catalogue after migration 0009 wrote the built-in rows. The `roles.permissions` column of a
# built-in row is that migration's snapshot: never refreshed, no migration for it, and it grants nothing (a built-in role's
# permissions come from BUILTIN in code). So the Admin row below is the live catalogue MINUS these ids, which is what the
# 0009 seed wrote; add an id here whenever the catalogue grows, or test_schema_roles.py fails on the seed comparison.
ADDED_AFTER_0009: frozenset[str] = frozenset({"settings.security", "assets.kinds", "billing.close"})

# The three rows migration 0009 seeds, as (id, name, description, permissions). The permissions are the mirror of
# permissions.BUILTIN in catalogue order as of 0009; test_schema_roles.py checks that the migration seeds exactly these.
BUILTIN_ROLE_ROWS: list[tuple[int, str, str, list[str]]] = [
    (1, "viewer", "Sees assets, dashboards and billing.", [p.id for p in CATALOGUE if p.id in BUILTIN["viewer"]]),
    (2, "operator", "Also edits dashboards, tests sources and sees scans.", [p.id for p in CATALOGUE if p.id in BUILTIN["operator"]]),
    (3, "admin", "Everything, including users and roles.",
     [p.id for p in CATALOGUE if p.id in BUILTIN["admin"] and p.id not in ADDED_AFTER_0009]),
]


async def restore_builtin_roles(db) -> None:
    """Put the roles table back to the 0009 seed: drop every other role, reset the three built-in rows (a test may have
    edited them) and make the next new role id 4. Run it after the users are truncated (a role a user holds cannot go)."""
    await db.execute("DELETE FROM roles WHERE id NOT IN (1, 2, 3)")
    await db.executemany(
        "INSERT INTO roles (id, name, description, builtin, permissions) VALUES ($1, $2, $3, true, $4) "
        "ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, builtin = true, "
        "permissions = excluded.permissions",
        BUILTIN_ROLE_ROWS,
    )
    await db.execute("SELECT setval(pg_get_serial_sequence('roles', 'id'), 3)")


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


def write_client_certificate(directory: Path, *, stem: str = "client", uri: str = "urn:dcdash:collector",
                             key_usage: bool = False) -> tuple[str, str]:
    """A fresh self-signed OPC UA client certificate and its key as PEM files in `directory`; returns (certificate path, key path).

    `key_usage` adds the key-usage and client-auth extensions a real application certificate carries (many do not).
    """
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, stem)])
    start = datetime.now(timezone.utc) - timedelta(days=1)
    builder = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(start).not_valid_after(start + timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName([x509.UniformResourceIdentifier(uri), x509.DNSName("localhost")]), critical=False)
    )
    if key_usage:
        builder = builder.add_extension(x509.KeyUsage(
            digital_signature=True, content_commitment=True, key_encipherment=True, data_encipherment=True, key_agreement=False,
            key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False,
        ), critical=True).add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
    certificate = builder.sign(key, hashes.SHA256())
    cert_path, key_path = directory / f"{stem}.pem", directory / f"{stem}-key.pem"
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                           serialization.NoEncryption()))
    return str(cert_path), str(key_path)


@contextlib.asynccontextmanager
async def opcua_server(sim: Simulator | None = None, password: str | None = None, faults: Faults | None = None):
    """Run an in-process OPC UA simulator server on a free port (optionally with fault switches on)."""
    srv = OpcUaSim(sim or Simulator(), free_port(), password=password, faults=faults)
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
    held: list[asyncio.Transport] = []

    class Hold(asyncio.Protocol):  # takes the connection and never reads or answers
        def connection_made(self, transport):
            held.append(transport)

    server = await asyncio.get_running_loop().create_server(Hold, "127.0.0.1", 0)
    try:
        yield server.sockets[0].getsockname()[1]
    finally:
        server.close()
        # A client that connected an instant ago may still be on its way from accept() to connection_made(). Let the
        # loop run so that it arrives and is closed below; one that is missed would keep wait_closed() waiting forever
        # (the old handler-based version did that now and then, and there is no pytest-timeout), so wait a bounded time.
        for _ in range(3):
            await asyncio.sleep(0)
        for transport in held:
            transport.close()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(server.wait_closed(), 2.0)


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


@contextlib.asynccontextmanager
async def freezable_proxy(database_url: str):
    """A TCP proxy to the test database that freezes like `docker pause`: after `freeze()` it forwards nothing, and new
    connections are accepted and never answered. Yields (port, freeze); on exit it closes every socket."""
    target = urlsplit(database_url)
    frozen, closed = asyncio.Event(), asyncio.Event()
    writers: list[asyncio.StreamWriter] = []

    async def pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
        with contextlib.suppress(Exception):
            while data := await src.read(65536):
                while frozen.is_set() and not closed.is_set():
                    await asyncio.sleep(0.02)  # hold the bytes, as a frozen server does
                dst.write(data)
                await dst.drain()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        writers.append(writer)
        if frozen.is_set():
            return  # accepted, never answered
        up_reader, up_writer = await asyncio.open_connection(target.hostname, target.port)
        writers.append(up_writer)
        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    try:
        yield server.sockets[0].getsockname()[1], frozen.set
    finally:
        closed.set()
        server.close()
        for writer in writers:
            writer.close()


def run_alembic(*args: str) -> subprocess.CompletedProcess[str]:
    """Run `alembic <args>` against the test database (the database_url fixture exports DCDASH_DATABASE_URL)."""
    backend = Path(__file__).resolve().parents[1]
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args], cwd=backend, env=os.environ.copy(), capture_output=True, text=True
    )
