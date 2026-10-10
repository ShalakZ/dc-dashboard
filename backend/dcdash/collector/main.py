import asyncio
import logging
import signal

import asyncpg

from dcdash import connectors  # noqa: F401  (registers built-in connectors)
from dcdash.collector.heartbeat import heartbeat_loop
from dcdash.collector.housekeeping import housekeeping_loop
from dcdash.collector.jobs import fail_stale_jobs, run_job_loop
from dcdash.collector.logs import configure_logging
from dcdash.collector.networks import publish_networks
from dcdash.collector.scheduler import Scheduler
from dcdash.collector.writer import Writer
from dcdash.connectors.base import ConnectorFactory, create_connector
from dcdash.core.config import get_settings
from dcdash.core.pg import CONFIG_CHANNEL, JOBS_CHANNEL, create_pool, listen_forever

log = logging.getLogger(__name__)

RETRY_SECONDS = 2
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)
# The longest the collector spends on its own shutdown (cancel the tasks, stop the pollers, last flush, close the pool). compose.yaml gives the
# service stop_grace_period 20 s before Docker sends SIGKILL; keep this well below it (a test pins the pair).
SHUTDOWN_SECONDS = 10.0


async def _close_down(tasks: list[asyncio.Task], scheduler: Scheduler, writer: Writer, pool: asyncpg.Pool) -> None:
    async def steps() -> None:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await scheduler.stop()
        await writer.flush()
        await pool.close()

    closing = asyncio.ensure_future(steps())
    done, _ = await asyncio.wait({closing}, timeout=SHUTDOWN_SECONDS)
    if not done:
        # asyncpg waits, without a deadline, for a database that accepted the connection and never answers; a single
        # cancellation does not end that wait, aborting the connections does.
        log.warning("shutdown did not finish in %.0f s", SHUTDOWN_SECONDS)
        pool.terminate()
        closing.cancel()
        stopping = asyncio.ensure_future(scheduler.stop())  # the groups were never cancelled if the gather hung
        await asyncio.wait({closing, stopping}, timeout=1)
    log.info("collector stopped, %d readings left unwritten", writer.pending)


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
        asyncio.create_task(heartbeat_loop(pool, stop=stop)),
    ]
    try:
        await stop.wait()
    finally:
        await _close_down(tasks, scheduler, writer, pool)


async def serve() -> None:
    """Run the collector until SIGTERM or SIGINT, then let run() shut down in an orderly way."""
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    installed: list[signal.Signals] = []
    for sig in STOP_SIGNALS:
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows event loops cannot; Ctrl+C then cancels run() through asyncio.run instead
            break
        installed.append(sig)
    try:
        await run(stop)
    finally:
        for sig in installed:
            loop.remove_signal_handler(sig)


def main() -> None:
    configure_logging()
    asyncio.run(serve())


if __name__ == "__main__":
    main()
