import asyncio
import math
import time
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any

import httpx
from pydantic import AnyHttpUrl, BaseModel

from dcdash.connectors.base import (
    BAD, GOOD, Claim, ConnectionCheck, Connector, ConnectorError, HistoryPage, PointDescriptor, PointValue, register,
    url_host_port,
)
from dcdash.connectors.identity import clip
from dcdash.ingest import normalise  # the module, not its names: normalise imports connectors.base, so either import order must work

CHUNK = 200  # addresses in one request: a longer query string is refused by some servers, and one answer stays a size to reason about
THREAD_ABOVE = 2_000  # items: converting more than this in the event loop would hold up the live polls of every other source
# Per-value fields only a source with a history interface sends; an item without any of them is a plain simulator value.
_EXTRA = frozenset({"quality", "zone", "stamp", "period_seconds"})
# The statuses read_history tells apart; read() and test() keep reporting any other answer than 200 as a protocol_error.
_HISTORY_STATUSES = {
    404: ("not_supported", "the source has no history interface (HTTP 404)"),
    429: ("rate_limited", "the source asked for fewer requests (HTTP 429)"),
    503: ("unreachable", "the source is not available (HTTP 503)"),
}


def _retry_after(header: str | None) -> float | None:
    """Seconds from a Retry-After header, which is either a number of seconds or an HTTP date; None for anything else."""
    text = (header or "").strip()
    if not text:
        return None
    try:
        seconds = float(text)
    except ValueError:
        try:
            moment = parsedate_to_datetime(text)
        except (TypeError, ValueError, IndexError):  # which of them depends on the Python version and on the junk
            return None
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=UTC)
        return max((moment - datetime.now(UTC)).total_seconds(), 0.0)  # a date in the past: ask again now
    return seconds if math.isfinite(seconds) and seconds >= 0 else None


def _chunks(addresses: list[str]) -> Iterator[list[str]]:
    for first in range(0, len(addresses), CHUNK):
        yield addresses[first:first + CHUNK]


def _plain(item: dict[str, Any]) -> PointValue:
    """A value of the plain simulator: the source's own time, good when it is a number."""
    raw = item["value"]
    good = isinstance(raw, (int, float)) and not isinstance(raw, bool)
    return PointValue(item["address"], datetime.fromisoformat(item["ts"]), float(raw) if good else None, GOOD if good else BAD)


def _convert(items: list[Any], previous: dict[str, datetime], live: bool) -> tuple[list[PointValue], int]:
    """(values, how many items the rules refuse, or that no rule is written for). `previous` is the last instant kept per address, the
    order evidence for the repeated autumn hour; the items of one address must arrive in ascending order (a history answer does). `live`
    lets a plain simulator item (none of the per-value fields) keep the old conversion."""
    values: list[PointValue] = []
    rejected = 0
    for item in items:
        if not isinstance(item, dict):
            rejected += 1
            continue
        try:
            if live and _EXTRA.isdisjoint(item):
                kept = _plain(item)
            elif isinstance(item.get("address"), str):
                kept = _normalised(item, previous)
            else:
                kept = None
        except Exception:  # whatever a source sends that no rule above is written for: one bad item is rejected, never the whole answer
            kept = None
        if kept is None:
            rejected += 1
        else:
            values.append(kept)
    return values, rejected


def _normalised(item: dict[str, Any], previous: dict[str, datetime]) -> PointValue | None:
    address = item["address"]
    moment = normalise.parse_time(item.get("ts"), item.get("zone"), previous=previous.get(address))
    if isinstance(moment, normalise.Rejected):
        return None
    stamp = item.get("stamp")
    try:
        if stamp == "end":
            moment = normalise.period_start(moment, item.get("period_seconds"), stamp)
        elif stamp not in (None, "start"):
            return None  # a stamp that is neither: the value cannot be placed in time
    except (normalise.NormaliseError, TypeError, ValueError, OverflowError):  # no period, a period of zero or beyond the calendar
        return None
    raw = item.get("value")
    numeric = isinstance(raw, (int, float)) and not isinstance(raw, bool)
    number = float(raw) if numeric else None  # before the order evidence moves: an integer beyond a float raises here
    code, label = normalise.quality(item.get("quality"))  # no quality is not good: only a good code is
    previous[address] = moment  # what the caller gets back as `ts`, and so what it will hand in again as `after`
    if number is None:
        return PointValue(address, moment, None, BAD, label)
    return PointValue(address, moment, number, code, label)  # a bad-quality number is kept as evidence, out of every figure


async def _convert_off_loop(items: list[Any], previous: dict[str, datetime], live: bool) -> tuple[list[PointValue], int]:
    if len(items) > THREAD_ABOVE:
        return await asyncio.to_thread(_convert, items, previous, live)
    return _convert(items, previous, live)


def _utc(name: str, moment: datetime) -> datetime:
    if moment.utcoffset() is None:
        raise ValueError(f"{name} must be a timezone-aware time")
    return moment.astimezone(UTC)


class SimulatorConfig(BaseModel):
    url: AnyHttpUrl = AnyHttpUrl("http://simulator:9000")
    timeout_seconds: float = 5.0


@register
class SimulatorConnector(Connector):
    type = "simulator"
    config_schema = SimulatorConfig
    default_ports = (9000,)
    supports_history = True  # only a history-capable server answers /history; the plain simulator's 404 becomes not_supported

    @classmethod
    async def probe(cls, host: str, port: int, timeout: float = 3.0) -> Claim | None:
        url = f"http://{host}:{port}"
        try:
            # httpx timeouts apply per phase; the outer deadline bounds a server that trickles bytes.
            async with asyncio.timeout(timeout), httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(f"{url}/")
            body = response.json() if response.status_code == 200 else None
            if not isinstance(body, dict) or body.get("service") != "dcdash-simulator":
                return None
            config = SimulatorConfig(url=url).model_dump(mode="json")
        except (httpx.HTTPError, httpx.InvalidURL, TimeoutError, ValueError, AttributeError):  # ValueError: JSON, pydantic
            return None
        instance = clip(body.get("instance"))  # a simulator from before w33 does not say; a text is cut at 256 characters
        return Claim("simulator", config, f"DCDash simulator at {host}:{port}", {"instance": instance} if instance else None)

    @classmethod
    def endpoint_key(cls, config: dict[str, Any]) -> tuple[str, int, str] | None:
        if not isinstance(config, dict):
            return None
        found = url_host_port(config.get("url"))
        if found is None:
            return None
        host, port, scheme = found
        return host, port if port is not None else (443 if scheme == "https" else 80), ""

    def __init__(
        self,
        config: SimulatorConfig,
        secret: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(config, secret)
        self._client = httpx.AsyncClient(
            base_url=str(config.url),
            timeout=config.timeout_seconds,
            headers={"X-API-Key": secret or ""},
            transport=transport,
        )

    async def _get(self, path: str, *, statuses: Mapping[int, tuple[str, str]] | None = None, **params: str) -> dict[str, Any]:
        """`statuses` maps an HTTP status to the (ConnectorError status, message) it stands for; any other non-200 is a protocol_error."""
        try:
            response = await self._client.get(path, params=params)
        except httpx.TimeoutException as exc:
            raise ConnectorError("timeout", str(exc) or "request timed out") from exc
        except httpx.HTTPError as exc:
            raise ConnectorError("unreachable", str(exc) or type(exc).__name__) from exc
        if response.status_code in (401, 403):
            raise ConnectorError("auth_failed", "credentials rejected")
        if response.status_code != 200:
            known = (statuses or {}).get(response.status_code)
            if known is not None:
                raise ConnectorError(*known, retry_after=_retry_after(response.headers.get("Retry-After")))
            raise ConnectorError("protocol_error", f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise ConnectorError("protocol_error", "response is not JSON") from exc

    async def identity(self) -> dict[str, Any] | None:
        """The instance id the server announces at `GET /` (it needs no key), or None when it is not a simulator or does not say."""
        try:
            data = await self._get("/")
        except Exception:  # noqa: BLE001 - a refused, unreachable or odd answer is "unknown", never an error
            return None
        if not isinstance(data, dict) or data.get("service") != "dcdash-simulator":
            return None
        instance = clip(data.get("instance"))
        return {"instance": instance} if instance else None

    async def test(self) -> ConnectionCheck:
        started = time.perf_counter()
        try:
            await self._get("/points")
        except ConnectorError as exc:
            return ConnectionCheck(False, exc.status, None, exc.message)
        return ConnectionCheck(True, "ok", round((time.perf_counter() - started) * 1000, 1))

    async def browse(self) -> list[PointDescriptor]:
        data = await self._get("/points")
        return [
            PointDescriptor(p["address"], p["name"], "float", p.get("unit") or None)
            for p in data["points"]
        ]

    async def read(self, addresses: list[str]) -> list[PointValue]:
        # A value of a source with a history interface goes through the rules history values go through (the source's own time, the
        # quality, a local time with its zone), so a live value and its history twin are one (address, ts) pair. A single sample has no
        # series to tell the repeated autumn hour by: such a value is dropped, as a refused history time is.
        values: list[PointValue] = []
        for chunk in _chunks(addresses):
            data = await self._get("/read", addresses=",".join(chunk))
            converted, _ = await _convert_off_loop(data["values"], {}, True)
            values += converted
        return values

    async def read_history(
        self,
        addresses: list[str],
        start: datetime,
        end: datetime,
        resolution: timedelta | None = None,
        *,
        after: Mapping[str, datetime] | None = None,
        limit: int | None = None,
    ) -> HistoryPage:
        first, last = _utc("start", start), _utc("end", end)
        if resolution is not None:
            raise ConnectorError("not_supported", "this source answers raw samples only")
        if limit is not None and limit < 1:
            raise ValueError("limit must be at least one row")
        # The limit goes with every request, so with several chunks of addresses it is a limit per chunk (the engine asks for at most
        # one chunk at a time); a source cuts at its own row limit, the smaller of the two, and `complete_until` says where.
        extra = {} if limit is None else {"limit": str(limit)}
        # An address in `after` continues a series the caller already holds, so its first item here is simply the first at or after
        # `start`: the order evidence is `start` itself, never the older (or, in a re-read, later) instant `after` names. Without
        # `after` the first item of an address has no evidence, and an ambiguous local time is refused rather than guessed.
        for seen in (after or {}).values():
            _utc("after", seen)  # a naive instant is a caller's mistake, whatever it would be used for
        previous = {address: first - timedelta(microseconds=1) for address in after or {}}
        values: list[PointValue] = []
        rejected = 0
        unknown: list[str] = []
        complete: datetime | None = None
        for chunk in _chunks(list(dict.fromkeys(addresses))):  # one address twice would carry its own order evidence into itself
            data = await self._get(
                "/history", statuses=_HISTORY_STATUSES,
                addresses=",".join(chunk), start=first.isoformat(), end=last.isoformat(), **extra,
            )
            if not isinstance(data, dict) or not isinstance(data.get("values"), list):
                raise ConnectorError("protocol_error", "the history answer has no list of values")
            until = normalise.parse_time(data.get("complete_until"), None)
            if isinstance(until, normalise.Rejected):
                raise ConnectorError("protocol_error", "the history answer has no usable complete_until")
            converted, refused = await _convert_off_loop(data["values"], previous, False)
            values += converted
            rejected += refused
            if isinstance(data.get("unknown"), list):
                unknown += (str(address) for address in data["unknown"])
            complete = until if complete is None else min(complete, until)  # complete for EVERY address means the earliest of the chunks
        return HistoryPage(values, last if complete is None else complete, rejected, tuple(unknown))

    async def close(self) -> None:
        await self._client.aclose()
