import asyncio
import logging

from dcdash import connectors  # noqa: F401  (registers built-in connectors)
from dcdash.collector.housekeeping import housekeeping_loop
from dcdash.collector.jobs import fail_stale_jobs, run_job_loop
from dcdash.collector.networks import publish_networks
from dcdash.collector.scheduler import Scheduler
from dcdash.collector.writer import Writer
from dcdash.connectors.base import ConnectorFactory, create_connector
from dcdash.core.config import get_settings
from dcdash.core.pg import CONFIG_CHANNEL, JOBS_CHANNEL, create_pool, listen_forever

log = logging.getLogger(__name__)

RETRY_SECONDS = 2


async def run(stop: asyncio.Event | None = None, factory: ConnectorFactory = create_connector) -> None:
    stop = stop or asyncio.Event()
    pool = await create_pool()
    writer = Writer(pool)
    scheduler = Scheduler(pool, writer, factory)
    reload_needed = asyncio.Event()
    jobs_ready = asyncio.Event()
    await fail_stale_jobs(pool)
    await publish_networks(pool)

    def catch_up() -> None:
        reload_needed.set()
        jobs_ready.set()

    async def reload_loop() -> None:
        while True:
            await reload_needed.wait()
            reload_needed.clear()
            try:
                log.info("schedule loaded: %d poll groups", await scheduler.reload())
            except Exception:
                log.exception("schedule reload failed, retrying")
                await asyncio.sleep(RETRY_SECONDS)
                reload_needed.set()

    handlers = {
        CONFIG_CHANNEL: lambda _payload: reload_needed.set(),
        JOBS_CHANNEL: lambda _payload: jobs_ready.set(),
    }
    tasks = [
        asyncio.create_task(listen_forever(get_settings().database_url, handlers, catch_up)),
        asyncio.create_task(writer.run()),
        asyncio.create_task(reload_loop()),
        asyncio.create_task(run_job_loop(pool, factory, jobs_ready, stop)),
        asyncio.create_task(housekeeping_loop(pool, stop=stop)),
    ]
    try:
        await stop.wait()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await scheduler.stop()
        await writer.flush()
        await pool.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(run())


if __name__ == "__main__":
    main()
