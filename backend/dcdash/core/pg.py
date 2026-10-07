import asyncio
import json
from collections.abc import Callable

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


async def listen_forever(
    dsn: str,
    handlers: dict[str, Callable[[str], None]],
    on_connect: Callable[[], None] | None = None,
    retry_seconds: float = 2.0,
) -> None:
    """Keep a LISTEN connection open until cancelled, reconnecting after failures.

    Notifications sent while disconnected are lost, so `on_connect` runs after
    every (re)connect to let the caller catch up.
    """
    while True:
        try:
            conn = await asyncpg.connect(dsn)
        except (OSError, asyncpg.PostgresError):
            await asyncio.sleep(retry_seconds)
            continue
        closed = asyncio.Event()
        conn.add_termination_listener(lambda _conn: closed.set())
        try:
            for channel, handler in handlers.items():
                await conn.add_listener(
                    channel, lambda _c, _pid, _ch, payload, handler=handler: handler(payload)
                )
            if on_connect is not None:
                on_connect()
            await closed.wait()
        except (OSError, asyncpg.PostgresError):
            pass
        finally:
            if not conn.is_closed():
                conn.terminate()
        await asyncio.sleep(retry_seconds)
