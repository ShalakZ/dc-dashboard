import asyncio

from dcdash.core.pg import listen_forever
from helpers import wait_for


async def test_listen_forever_delivers_payloads(db, database_url):
    received: list[str] = []
    connected = asyncio.Event()
    task = asyncio.create_task(
        listen_forever(database_url, {"dcdash_test": received.append}, connected.set, retry_seconds=0.1)
    )

    async def got() -> list[str]:
        return list(received)

    try:
        await asyncio.wait_for(connected.wait(), timeout=5)
        await db.execute("SELECT pg_notify('dcdash_test', 'hello')")
        await wait_for(got, ["hello"])
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_listen_forever_reconnects(db, database_url):
    received: list[str] = []
    connections = 0

    def on_connect() -> None:
        nonlocal connections
        connections += 1

    async def count() -> int:
        return connections

    async def got() -> list[str]:
        return list(received)

    task = asyncio.create_task(
        listen_forever(database_url, {"dcdash_test": received.append}, on_connect, retry_seconds=0.1)
    )
    try:
        await wait_for(count, 1)
        await db.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()"
        )
        await wait_for(count, 2)
        await db.execute("SELECT pg_notify('dcdash_test', 'after')")
        await wait_for(got, ["after"])
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
