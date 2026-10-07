import json

import asyncpg

from dcdash.core.config import get_settings

CONFIG_CHANNEL = "dcdash_config"
JOBS_CHANNEL = "dcdash_jobs"
LATEST_CHANNEL = "dcdash_latest"


async def _init_connection(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def create_pool(dsn: str | None = None) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        dsn or get_settings().database_url, min_size=1, max_size=5, init=_init_connection
    )
