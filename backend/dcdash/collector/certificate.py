import asyncio
import logging

import asyncpg

from dcdash.core.certificate import TLS_KEY, CertificateError, read_leaf

log = logging.getLogger(__name__)

CHECK_SECONDS = 3600.0
WRITE_TIMEOUT_SECONDS = 5.0


async def _publish(pool: asyncpg.Pool, path: str) -> str | None:
    """Store what the file says (or why it cannot be read) and return the read problem; None when the file was read
    or HTTPS is off. A database failure raises."""
    if not path:
        await asyncio.wait_for(
            pool.execute("DELETE FROM settings WHERE key = $1", TLS_KEY), timeout=WRITE_TIMEOUT_SECONDS
        )
        return None
    problem = None
    try:
        value = {"path": path, **await asyncio.to_thread(read_leaf, path)}
    except CertificateError as exc:
        problem = str(exc)
        value = {"path": path, "error": problem}
    # checked_at is the database's clock, like the heartbeat: the API judges its age without the collector's clock.
    await asyncio.wait_for(
        pool.execute(
            "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb || jsonb_build_object('checked_at', now())) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            TLS_KEY, value,
        ),
        timeout=WRITE_TIMEOUT_SECONDS,
    )
    return problem


async def publish_certificate(pool: asyncpg.Pool, path: str) -> None:
    """Write the certificate's expiry to the `tls_certificate` setting, or the reason it cannot be read; with no path
    (HTTPS off) remove the row."""
    await _publish(pool, path)


async def certificate_loop(
    pool: asyncpg.Pool, path: str, stop: asyncio.Event | None = None, interval_seconds: float = CHECK_SECONDS
) -> None:
    """Publish now, then every `interval_seconds`; log only when the file or the write starts or stops failing."""
    stop = stop or asyncio.Event()
    failing = False
    unreadable: str | None = None
    while not stop.is_set():
        try:
            problem = await _publish(pool, path)
        except Exception as exc:
            if not failing:
                log.warning("certificate expiry not published: %s", str(exc) or type(exc).__name__)
            failing = True
        else:
            if failing:
                log.info("certificate expiry published again")
            failing = False
            if problem != unreadable:
                if problem:
                    log.warning("certificate not readable: %s", problem)
                else:
                    log.info("certificate readable again")
                unreadable = problem
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
        except TimeoutError:
            pass
