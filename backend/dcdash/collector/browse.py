import asyncpg

from dcdash.collector.scheduler import mark_source
from dcdash.connectors.base import Connector, ConnectorFactory
from dcdash.core.crypto import decrypt

_UPSERT_POINT = """
    INSERT INTO points (source_id, address, name, data_type, unit_hint)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (source_id, address) DO UPDATE
        SET name = EXCLUDED.name, data_type = EXCLUDED.data_type, unit_hint = EXCLUDED.unit_hint
"""


async def connector_for(pool: asyncpg.Pool, source_id: int, factory: ConnectorFactory) -> Connector:
    row = await pool.fetchrow("SELECT connector_type, config, secret FROM sources WHERE id = $1", source_id)
    if row is None:
        raise LookupError(f"source {source_id} not found")
    secret = decrypt(row["secret"]) if row["secret"] else None
    return factory(row["connector_type"], row["config"], secret)


async def browse_source(pool: asyncpg.Pool, source_id: int, factory: ConnectorFactory) -> int:
    """Browse a source's points and upsert them. Returns the count; raises what the connector raises.

    A successful browse proves the source is reachable with its current credentials, so it is marked
    online and a stale "credentials rejected" error is cleared (a failed browse changes nothing here).
    """
    connector = await connector_for(pool, source_id, factory)
    try:
        descriptors = await connector.browse()
    finally:
        await connector.close()
    await pool.executemany(
        _UPSERT_POINT, [(source_id, d.address, d.name, d.data_type, d.unit_hint) for d in descriptors]
    )
    await mark_source(pool, source_id, True)
    return len(descriptors)
