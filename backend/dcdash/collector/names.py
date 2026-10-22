"""A name for an address that Docker hands out (w33 R7): `172.20.0.5` -> `simulator`.

On a Docker network a container gets a new address whenever it is recreated, but its service name keeps resolving to wherever it is
now. When a scan finds a server at a private address, this asks the resolver who the address belongs to and offers a NAME for it,
but only a name that provably leads back: the reverse lookup of the address gives `dcdash-simulator-1.dcdash_default`, the
candidates `simulator`, `dcdash-simulator`, `dcdash-simulator-1` and the full name are tried shortest first, and a candidate is
accepted only when looking IT up gives exactly the address again. A name that gives another address, several, or none is never
offered, so the hint can never point a source at a different machine.

Lookups block, so they run in a small pool of their own (never the loop's default executor: asyncio's own `getaddrinfo` uses that
one, and a hung lookup must not starve it). A thread cannot be stopped when its lookup times out; that is why the pool is small and
why a few timeouts in a row switch the lookups off for the rest of the scan. Nothing here raises, and nothing is logged above DEBUG.
"""
import asyncio
import ipaddress
import logging
import re
import socket
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

log = logging.getLogger(__name__)

LOOKUP_TIMEOUT = 3.0  # seconds for ONE lookup; read when a lookup starts so a test can shorten it
MAX_HOSTS_PER_SCAN = 50  # hosts that get an attempt in one scan
MAX_LOOKUPS_PER_HOST = 6  # the reverse lookup plus up to five forward checks
MAX_TIMEOUTS_IN_A_ROW = 4  # a resolver that times out this often in a row is not asked again in this scan
POOL_WORKERS = 4

_POOL = ThreadPoolExecutor(max_workers=POOL_WORKERS, thread_name_prefix="dcdash-names")
_HOSTNAME = re.compile(r"[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?")
# What a resolver would read as an address rather than look up as a name (`10`, `0x0a000005`, `10.1`): never a candidate.
_NUMERIC = re.compile(r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*")
_TRAILING_NUMBER = re.compile(r"(.+)-[0-9]+")


class LookupBudget:
    """What one scan may spend on name lookups: a number of hosts, and a stop after a few timeouts in a row. The scan creates one
    and hands it to every `name_hint` call, so the cap is per scan. (The loop is single-threaded: no locking is needed.)"""

    def __init__(self, max_hosts: int | None = None, per_host: int | None = None) -> None:
        self.hosts_left = MAX_HOSTS_PER_SCAN if max_hosts is None else max_hosts
        self.per_host = MAX_LOOKUPS_PER_HOST if per_host is None else per_host
        self.timeouts = 0  # in a row; any answer, even a failure, proves the resolver is alive and resets it

    def take_host(self) -> bool:
        """Spend one host of the budget; False when none is left or the resolver has stopped answering."""
        if self.hosts_left <= 0 or self.timeouts >= MAX_TIMEOUTS_IN_A_ROW:
            return False
        self.hosts_left -= 1
        return True

    @property
    def stopped(self) -> bool:
        return self.timeouts >= MAX_TIMEOUTS_IN_A_ROW


def is_candidate_host(host: object) -> bool:
    """True for a private IPv4 address that can be somebody's Docker address. Names, public addresses and IPv6 never; neither do
    loopback (`localhost` is no hint), link-local, unspecified and multicast addresses, which Python also counts as private."""
    if not isinstance(host, str):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.version == 4 and ip.is_private and not (ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast)


def candidates(reverse_name: str) -> list[str]:
    """The names to check for a reverse name, shortest first, without repeats: `dcdash-simulator-1.dcdash_default` gives
    `simulator`, `dcdash-simulator`, `dcdash-simulator-1`, `dcdash-simulator-1.dcdash_default`. Anything that is not a plain host
    name (it is written into a URL later) or that a resolver would read as an address is left out; an address echoed back gives none."""
    name = reverse_name.strip().rstrip(".").lower() if isinstance(reverse_name, str) else ""
    if not name or _is_address(name):
        return []
    container = name.split(".")[0]
    match = _TRAILING_NUMBER.fullmatch(container)
    service = match.group(1) if match else container  # the container number (`-1`) is not part of the service name
    parts = [part for part in service.split("-") if part]
    ordered = ["-".join(parts[start:]) for start in range(len(parts) - 1, -1, -1)] + [container, name]
    return [c for c in dict.fromkeys(ordered) if c and _HOSTNAME.fullmatch(c) and not _NUMERIC.fullmatch(c)]


def _is_address(text: str) -> bool:
    try:
        ipaddress.ip_address(text)
    except ValueError:
        return False
    return True


def _reverse(address: str) -> str | None:
    """The name the resolver gives an address (blocks; runs in the pool). Raises when there is none."""
    return socket.gethostbyaddr(address)[0]


def _forward(name: str) -> list[str]:
    """The IPv4 addresses of a name (blocks; runs in the pool). Raises when it does not resolve."""
    return socket.gethostbyname_ex(name)[2]


async def _run(function: Callable[[str], Any], argument: str, lookups: LookupBudget) -> Any:
    """One lookup in the pool under the timeout; None when it fails, answers nothing or takes too long. A cancellation of the scan
    is not swallowed."""
    try:
        result = await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(_POOL, function, argument), LOOKUP_TIMEOUT)
    except TimeoutError:  # the thread keeps running until the resolver gives up; that is what the small pool is for
        lookups.timeouts += 1
        return None
    except Exception:  # noqa: BLE001 - "no such host" and every other failure are the same answer: no name
        lookups.timeouts = 0
        return None
    lookups.timeouts = 0
    return result


async def _find(host: str, lookups: LookupBudget) -> str | None:
    address = str(ipaddress.ip_address(host))
    left = lookups.per_host
    reverse = await _run(_reverse, address, lookups)
    left -= 1
    if not isinstance(reverse, str):
        return None
    for candidate in candidates(reverse):
        if left <= 0 or lookups.stopped:
            break
        left -= 1
        forward = await _run(_forward, candidate, lookups)
        if isinstance(forward, list) and forward == [address]:  # exactly this address and no other: the name leads back
            return candidate
    return None


async def name_hint(host: str, *, lookups: LookupBudget) -> str | None:
    """A name that leads back to `host` (a private IPv4 address), or None. Never raises; makes no lookup at all for anything that
    is not a private IPv4 address or when the scan's budget is spent."""
    if not is_candidate_host(host) or not lookups.take_host():
        return None
    try:
        return await _find(host, lookups)
    except Exception:  # noqa: BLE001 - a hint is a nicety, never a reason to fail a scan
        log.debug("name lookup for %s failed", host, exc_info=True)
        return None
