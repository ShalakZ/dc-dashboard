import logging

import asyncpg

from dcdash.core.discovery import local_addresses, networks_from_addresses

log = logging.getLogger(__name__)


async def publish_networks(pool: asyncpg.Pool) -> list[str]:
    """Store the /24 around each of the collector's addresses so the API can pre-fill new scan scopes."""
    try:
        cidrs = networks_from_addresses(local_addresses())
        await pool.execute(
            "INSERT INTO settings (key, value) VALUES ('collector_networks', $1) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            {"cidrs": cidrs},
        )
    except Exception:  # noqa: BLE001 - a convenience feature must never stop the collector starting
        log.exception("could not publish collector networks")
        return []
    return cidrs
