import asyncio

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from dcdash.core.config import get_settings


def _run(connection) -> None:
    context.configure(connection=connection, target_metadata=None)
    with context.begin_transaction():
        context.run_migrations()


async def _main() -> None:
    engine = create_async_engine(get_settings().sqlalchemy_url)
    async with engine.connect() as connection:
        await connection.run_sync(_run)
    await engine.dispose()


asyncio.run(_main())
