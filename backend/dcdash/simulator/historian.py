"""A stand-in Historian: the history interface of a real Historian, played by the simulator process (dev profile only).

It lets the history read, the backfill and the normalisation rules be rehearsed without a real Historian, whose brand nobody knows yet.
GET only, the same `X-API-Key` as the plain simulator, on its own port (SIM_HISTORIAN_PORT, 9100). Wire format (plan D9):

  GET /                                        no key; {"service": "dcdash-simulator", "history": true} so the existing probe recognises it
  GET /points                                  {"points": [{address, name, unit, kind, zone, stamp_start, stamp_end, interval}]}
  GET /read?addresses=A,B                      {"values": [item]}: each tag's newest visible sample (an unknown address is left out)
  GET /history?addresses=&start=&end=&limit=   {"values": [item], "complete_until", "unknown"}: raw samples, start and end inclusive,
                                               ordered by INSTANT then address, cut at min(limit, SIM_HISTORIAN_MAX_ROWS) rows
  GET /stats                                   what was asked and sent (so a test can prove a client only called /history)

An item is {address, ts, value, quality} plus `zone` exactly when `ts` is a naive local time, and `period_seconds` + `stamp: "end"` for an
interval value stamped at the END of its period. `complete_until` is the instant of the first row NOT returned when the answer was cut,
else min(end, now): a late sample is simply missing until it is visible, it never moves `complete_until`.

Values are a PURE function of tag and instant (the style of seed/history.py): counters sit on a fixed grid counted from a fixed anchor and
are integrals of a smooth daily load curve in closed form, so a past range answers the same every time. The only state is the request
counters and the DIFF bookkeeping. Nothing outside `dcdash/simulator/` may import this module or name its variables (the walls are in
tests/test_simulator_faults_isolation.py). `/` and `/stats` never fault.
"""

from __future__ import annotations

import heapq
import itertools
import math
import os
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from datetime import time as time_of_day
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from dcdash.simulator.faults import FaultConfigError

PREFIX = "SIM_HISTORIAN_"
KNOWN = (
    "SIM_HISTORIAN_PORT", "SIM_HISTORIAN_METERS", "SIM_HISTORIAN_MAX_ROWS", "SIM_HISTORIAN_LATE_MINUTES", "SIM_HISTORIAN_ZONE",
    "SIM_HISTORIAN_FAIL_EVERY", "SIM_HISTORIAN_RATE", "SIM_HISTORIAN_SLOW",
)
MAX_SLOW = 60.0

ANCHOR = datetime(2026, 1, 1, tzinfo=timezone.utc)  # every grid counts from here; midnight UTC, so a grid second modulo a day is the UTC time of day
ANCHOR_S = int(ANCHOR.timestamp())
DAY_S = 86400
OMEGA = 2 * math.pi / DAY_S
QUALITIES = ("good", "uncertain", "bad", "substituted", "interpolated")
GAP_FROM_S, GAP_TO_S = 3 * 3600, 6 * 3600  # GAP_kWh has no samples in [03:00, 06:00) UTC: 03:00 is missing, 06:00 is there
WRAP_AT = 100_000.0  # WRAP_kWh shows 99,999.9 and then 0.0
DEADBAND_KW = 0.5  # DEADBAND_kW stores a minute only when it differs from the previous minute by more than this
DEADBAND_STEP = 17  # minutes the load stays on one level
DIFF_EVERY, DIFF_BUMP = 97, 0.01  # DIFF_kWh: every 97th minute answers differently from its second answer on (about 15 a day)
MAX_WALK_BACK = 400  # how far /read looks back from "now" for an instant the tag really has (GAP: 180 minutes at most)
INTERVAL_SECONDS = 900


class HistorianConfigError(FaultConfigError):
    """A SIM_HISTORIAN_* setting that cannot be honoured; main() stops on it exactly as it stops on a bad SIM_FAULT_* switch."""


@dataclass(frozen=True)
class HistorianConfig:
    port: int = 9100
    meters: int = 20  # plain meters, each a kWh counter and a kW tag (217 and 2,000 are the numbers the backfill is measured with)
    max_rows: int = 50_000  # rows in one /history answer
    late_minutes: int = 90  # LATE_kWh: a sample becomes visible this long after its instant
    zone: str = "Europe/Berlin"  # LOCAL_kWh answers naive times in this zone; RESET_kWh resets at 02:00 in it
    fail_every: int = 0  # every Nth /history request answers 503
    rate: int = 0  # above this many requests in one second: 429 with Retry-After
    slow_seconds: float = 0.0  # delay of every answer

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> HistorianConfig:
        unknown = sorted(name for name in environ if name.startswith(PREFIX) and name not in KNOWN)
        if unknown:
            raise HistorianConfigError(
                f"{', '.join(unknown)} is not a setting of the stand-in Historian (a typo would run the rehearsal with the defaults). "
                f"The settings are: {', '.join(KNOWN)}."
            )

        def value(name: str) -> str:
            return environ.get(name, "").strip()

        default = cls()
        return cls(
            port=_whole("SIM_HISTORIAN_PORT", value("SIM_HISTORIAN_PORT"), default.port, 1, 65535),
            meters=_whole("SIM_HISTORIAN_METERS", value("SIM_HISTORIAN_METERS"), default.meters, 0, 10_000),
            max_rows=_whole("SIM_HISTORIAN_MAX_ROWS", value("SIM_HISTORIAN_MAX_ROWS"), default.max_rows, 1, 1_000_000),
            late_minutes=_whole("SIM_HISTORIAN_LATE_MINUTES", value("SIM_HISTORIAN_LATE_MINUTES"), default.late_minutes, 0, 10_080),
            zone=_zone(value("SIM_HISTORIAN_ZONE"), default.zone),
            fail_every=_whole("SIM_HISTORIAN_FAIL_EVERY", value("SIM_HISTORIAN_FAIL_EVERY"), default.fail_every, 0, 1_000_000),
            rate=_whole("SIM_HISTORIAN_RATE", value("SIM_HISTORIAN_RATE"), default.rate, 0, 1_000_000),
            slow_seconds=_seconds("SIM_HISTORIAN_SLOW", value("SIM_HISTORIAN_SLOW"), default.slow_seconds),
        )

    def describe(self) -> list[str]:
        """One line per active fault, each starting with the variable and its value (the first thing to look for in the log)."""
        lines = []
        if self.fail_every:
            lines.append(f"SIM_HISTORIAN_FAIL_EVERY={self.fail_every}: every {self.fail_every}th history request is answered 503")
        if self.rate:
            lines.append(f"SIM_HISTORIAN_RATE={self.rate}: more than {self.rate} requests in one second are answered 429 (Retry-After: 1)")
        if self.slow_seconds:
            lines.append(f"SIM_HISTORIAN_SLOW={self.slow_seconds:g}: every answer comes {self.slow_seconds:g} s late")
        return lines


def _whole(name: str, text: str, default: int, low: int, high: int) -> int:
    if not text:
        return default
    try:
        number = int(text)
    except ValueError:
        raise HistorianConfigError(f"{name} must be a whole number, not '{text}'.") from None
    if not low <= number <= high:
        raise HistorianConfigError(f"{name} must be between {low} and {high}, not '{text}'.")
    return number


def _seconds(name: str, text: str, default: float) -> float:
    if not text:
        return default
    try:
        seconds = float(text)
    except ValueError:
        raise HistorianConfigError(f"{name} must be a number of seconds, not '{text}'.") from None
    if not math.isfinite(seconds) or not 0 <= seconds <= MAX_SLOW:
        raise HistorianConfigError(f"{name} must be between 0 and {MAX_SLOW:g} seconds, not '{text}'.")
    return seconds


def _zone(text: str, default: str) -> str:
    if not text:
        return default
    try:
        ZoneInfo(text)
    except (ZoneInfoNotFoundError, ValueError, OSError):  # OSError: a folder name such as 'Europe'
        raise HistorianConfigError(f"SIM_HISTORIAN_ZONE must be a time zone name such as Europe/Berlin, not '{text}'.") from None
    return text


# ---- the load: a smooth daily curve and its integral, in closed form ---------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Load:
    """kW(s) = base * (1 + amp * sin(w * (s - phase))) with s seconds since the anchor; amp < 1 keeps it positive, so the counter only rises."""

    base: float
    amp: float
    phase: float
    offset: float  # kWh on the counter at the anchor

    def kw(self, s: float) -> float:
        return self.base * (1 + self.amp * math.sin(OMEGA * (s - self.phase)))

    def kwh(self, s: float) -> float:
        swing = (math.cos(OMEGA * self.phase) - math.cos(OMEGA * (s - self.phase))) / OMEGA  # the integral of the sine, from 0 to s
        return self.offset + self.base / 3600 * (s + self.amp * swing)


def meter_load(n: int) -> Load:
    return Load(base=20.0 + (n * 7) % 41, amp=0.30 + 0.05 * (n % 5), phase=float((n * 1713) % DAY_S), offset=500.0 * n)


WRAP_LOAD = Load(base=4000.0, amp=0.3, phase=0.0, offset=90_000.0)  # a counter that fills up about once a day, so any two days show a wrap


def deadband_kw(k: int) -> float:
    """The 1-minute series behind DEADBAND_kW: steps of 5 kW or more every DEADBAND_STEP minutes and a ripple far below the dead band."""
    level = 20 + 5 * ((k // DEADBAND_STEP * 7919) % 11)  # consecutive levels differ by 5 or by 50
    return round(level + 0.2 * math.sin(k * 0.9), 3)


# ---- the tags ----------------------------------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Tag:
    name: str  # also the address
    description: str
    unit: str
    kind: str  # counter | interval | power
    interval: int  # seconds between two samples on the grid
    load: Load
    behaviour: str = ""  # gap late dup diff reset wrap badq interval local deadband, or plain
    scale: float = 1.0  # the unit's factor against kWh / kW
    digits: int = 3
    zone: str | None = None  # set when the answers carry naive local times

    @property
    def first(self) -> int:
        """Index of the first grid instant it can answer: an END-stamped period needs a whole period behind it."""
        return 1 if self.kind == "interval" else 0


def build_tags(config: HistorianConfig) -> list[Tag]:
    tags: list[Tag] = []
    for n in range(1, config.meters + 1):
        load, label = meter_load(n), f"M{n:03d}"
        tags.append(Tag(f"{label}_kWh", f"Meter {n:03d} energy", "kWh", "counter", 60, load))
        tags.append(Tag(f"{label}_kW", f"Meter {n:03d} power", "kW", "power", 60, load))
    one = meter_load(1)  # every behaviour tag follows the load of meter 1, so a test compares it with M001
    tags += [
        Tag("UNIT_Wh", "Energy counter in Wh", "Wh", "counter", 60, one, scale=1000.0, digits=1),
        Tag("UNIT_MWh", "Energy counter in MWh", "MWh", "counter", 60, one, scale=0.001, digits=6),
        Tag("UNIT_W", "Power in W", "W", "power", 60, one, scale=1000.0, digits=1),
        Tag("POWER_5MIN_kW", "Power, one sample every 5 minutes", "kW", "power", 300, one),
        Tag("GAP_kWh", "Energy counter with a daily hole", "kWh", "counter", 60, one, behaviour="gap"),
        Tag("LATE_kWh", "Energy counter whose samples arrive late", "kWh", "counter", 60, one, behaviour="late"),
        Tag("DUP_kWh", "Energy counter answered twice", "kWh", "counter", 60, one, behaviour="dup"),
        Tag("DIFF_kWh", "Energy counter that changes on a re-read", "kWh", "counter", 60, one, behaviour="diff"),
        Tag("RESET_kWh", "Energy counter reset daily at 02:00 local", "kWh", "counter", 60, one, behaviour="reset"),
        Tag("WRAP_kWh", "Energy counter that rolls over at 99,999.9", "kWh", "counter", 60, WRAP_LOAD, behaviour="wrap", digits=1),
        Tag("BADQ_kW", "Power with every quality", "kW", "power", 60, one, behaviour="badq"),
        Tag("INTERVAL_kWh", "Energy per 15 minutes, stamped at the end", "kWh", "interval", INTERVAL_SECONDS, one, behaviour="interval"),
        Tag("LOCAL_kWh", "Energy counter in local time", "kWh", "counter", 60, one, behaviour="local", zone=config.zone),
        Tag("DEADBAND_kW", "Power stored only on a change", "kW", "power", 60, one, behaviour="deadband"),
        Tag("MISMATCH_kW", "Power on a one-minute grid", "kW", "power", 60, one),
    ]
    return tags


# ---- the model: which instants a tag has, and what they say --------------------------------------------------------------------


def _utc_iso(sec: int, cache: dict[int, str]) -> str:
    found = cache.get(sec)
    if found is None:
        found = cache[sec] = datetime.fromtimestamp(sec, timezone.utc).isoformat()
    return found


class Historian:
    def __init__(self, config: HistorianConfig, clock: Callable[[], datetime]) -> None:
        self.config = config
        self.clock = clock
        self.zone = ZoneInfo(config.zone)
        self.tags = build_tags(config)
        self.by_name = {tag.name: tag for tag in self.tags}
        self._lock = threading.Lock()
        self._served: dict[tuple[str, int], int] = {}  # DIFF_kWh: how often each differing instant was answered

    def now(self) -> datetime:
        return self.clock().astimezone(timezone.utc)

    def _lag(self, tag: Tag) -> timedelta:
        return timedelta(minutes=self.config.late_minutes) if tag.behaviour == "late" else timedelta(0)

    def exists(self, tag: Tag, k: int) -> bool:
        if tag.behaviour == "gap":
            return not GAP_FROM_S <= (k * tag.interval) % DAY_S < GAP_TO_S
        if tag.behaviour == "deadband":
            return k == 0 or abs(deadband_kw(k) - deadband_kw(k - 1)) > DEADBAND_KW
        return True

    def newest(self, tag: Tag, now: datetime) -> int | None:
        """The newest sample of the tag that is visible at `now`, looked for by walking back from the newest grid instant."""
        k = (now - self._lag(tag) - ANCHOR) // timedelta(seconds=tag.interval)
        for _ in range(MAX_WALK_BACK):
            if k < tag.first:
                return None
            if self.exists(tag, k):
                return k
            k -= 1
        return None

    def window(self, tag: Tag, start: datetime, end: datetime, now: datetime) -> tuple[int, int]:
        """The grid indexes of the tag between start and end (both inclusive), nothing later than what is visible at `now`."""
        step = timedelta(seconds=tag.interval)
        low = max(tag.first, -((ANCHOR - start) // step))  # the ceiling of (start - anchor) / step
        high = min((end - ANCHOR) // step, (now - self._lag(tag) - ANCHOR) // step)
        return low, high

    def rows(self, tag: Tag, low: int, high: int) -> Iterator[tuple[int, str, int, Tag, int]]:
        """Ascending (instant, address, copy, tag, index) tuples, light enough to merge; the item itself is built only for the rows sent."""
        indexes = range(low, high + 1)
        if tag.behaviour in ("gap", "deadband"):
            indexes = (k for k in indexes if self.exists(tag, k))
        twice = tag.behaviour == "dup"
        for k in indexes:
            sec = ANCHOR_S + k * tag.interval
            yield sec, tag.name, 0, tag, k
            if twice:
                yield sec, tag.name, 1, tag, k

    def last_reset(self, sec: int) -> int:
        """The newest 02:00 local instant at or before `sec` (fold 0, so the repeated autumn hour and the missing spring hour reset once)."""
        day = datetime.fromtimestamp(sec, self.zone).date()
        at = self._reset_at(day)
        return at if at <= sec else self._reset_at(day - timedelta(days=1))

    def _reset_at(self, day: date) -> int:
        return int(datetime.combine(day, time_of_day(2, 0), tzinfo=self.zone).timestamp())

    def measure(self, tag: Tag, k: int) -> tuple[float, str]:
        s = k * tag.interval
        behaviour = tag.behaviour
        if behaviour == "deadband":
            return deadband_kw(k), "good"
        if tag.kind == "power":
            raw = tag.load.kw(s)
        elif tag.kind == "interval":
            raw = tag.load.kwh(s) - tag.load.kwh(s - tag.interval)
        elif behaviour == "reset":
            raw = tag.load.kwh(s) - tag.load.kwh(self.last_reset(ANCHOR_S + s) - ANCHOR_S)
        else:
            raw = tag.load.kwh(s)
        if behaviour == "wrap":
            raw %= WRAP_AT  # before rounding, so the value keeps its one decimal
        value = round(raw * tag.scale, tag.digits)
        if behaviour == "wrap":
            value %= WRAP_AT  # and again after it: 99,999.96 rounds to 100,000.0, which must show as 0.0, never above 99,999.9
        return value, QUALITIES[k % len(QUALITIES)] if behaviour == "badq" else "good"

    def item(self, tag: Tag, k: int, cache: dict[int, str]) -> dict:
        """One sample as /read and /history send it: the same fields on both routes, because it is the same code."""
        value, quality = self.measure(tag, k)
        if tag.behaviour == "diff" and k % DIFF_EVERY == 0:
            with self._lock:
                seen = self._served[tag.name, k] = self._served.get((tag.name, k), 0) + 1
            if seen > 1:
                value = round(value + DIFF_BUMP, tag.digits)
        sec = ANCHOR_S + k * tag.interval
        if tag.zone:  # a naive local time: the same wall-clock hour comes twice in autumn and never in spring
            local = datetime.fromtimestamp(sec, self.zone).replace(tzinfo=None).isoformat()
            return {"address": tag.name, "ts": local, "value": value, "quality": quality, "zone": tag.zone}
        item = {"address": tag.name, "ts": _utc_iso(sec, cache), "value": value, "quality": quality}
        if tag.kind == "interval":
            item["period_seconds"] = tag.interval
            item["stamp"] = "end"
        return item


# ---- the app -----------------------------------------------------------------------------------------------------------------


class _Stats:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: dict[str, int] = {}
        self.rows = 0
        self.history_requests = 0
        self.sent_503 = 0
        self.sent_429 = 0
        self.second: int | None = None
        self.in_second = 0


ROUTES = ("/", "/points", "/read", "/history", "/stats")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(name: str, text: str) -> datetime:
    try:
        moment = datetime.fromisoformat(text.strip())
        if moment.tzinfo is None:
            raise HTTPException(422, f"{name} needs a UTC offset (for example 2026-01-01T00:00:00Z), not '{text}'")
        return moment.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        raise HTTPException(422, f"{name} is not an ISO 8601 time: '{text}'") from None


def _addresses(text: str) -> list[str]:
    return list(dict.fromkeys(part.strip() for part in text.split(",") if part.strip()))


def create_historian_app(config: HistorianConfig, *, clock: Callable[[], datetime] = _utc_now, api_key: str | None = None) -> FastAPI:
    key = api_key or os.environ.get("SIM_API_KEY", "sim-key")
    historian = Historian(config, clock)
    stats = _Stats()
    app = FastAPI(title="DC Dashboard stand-in Historian", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.historian = historian

    @app.middleware("http")
    async def tally(request: Request, call_next):
        if request.url.path != "/stats":  # the observer does not disturb what it observes
            path = request.url.path if request.url.path in ROUTES else "other"
            with stats.lock:
                stats.requests[f"{request.method} {path}"] = stats.requests.get(f"{request.method} {path}", 0) + 1
        return await call_next(request)

    def guard(x_api_key: str | None = Header(default=None)) -> None:
        if x_api_key != key:
            raise HTTPException(401, "bad api key")

    def pace(history: bool) -> Callable[[], None]:
        """The faults, in this order: too many a second (429), every Nth /history (503), then the delay. A refused request is not delayed."""

        def check() -> None:
            if config.rate:
                second = int(historian.now().timestamp())
                with stats.lock:
                    if stats.second != second:
                        stats.second, stats.in_second = second, 0
                    stats.in_second += 1
                    over = stats.in_second > config.rate
                    stats.sent_429 += over
                if over:
                    raise HTTPException(429, "too many requests", headers={"Retry-After": "1"})
            if history:
                with stats.lock:
                    stats.history_requests += 1
                    failed = bool(config.fail_every) and stats.history_requests % config.fail_every == 0
                    stats.sent_503 += failed
                if failed:
                    raise HTTPException(503, "historian unavailable")
            if config.slow_seconds:
                time.sleep(config.slow_seconds)  # a sync route runs in a worker thread, so only this request waits

        return check

    def served(count: int) -> None:
        with stats.lock:
            stats.rows += count

    @app.get("/")
    def identify() -> dict:
        return {"service": "dcdash-simulator", "history": True}

    @app.get("/points", dependencies=[Depends(guard), Depends(pace(False))])
    def points() -> JSONResponse:
        now, cache = historian.now(), {}
        listed = []
        for tag in historian.tags:
            newest = historian.newest(tag, now)
            listed.append({
                "address": tag.name, "name": tag.description, "unit": tag.unit, "kind": tag.kind, "zone": tag.zone,
                "stamp_start": _utc_iso(ANCHOR_S + tag.first * tag.interval, cache),
                "stamp_end": None if newest is None else _utc_iso(ANCHOR_S + newest * tag.interval, cache),
                "interval": tag.interval,
            })
        return JSONResponse({"points": listed})

    @app.get("/read", dependencies=[Depends(guard), Depends(pace(False))])
    def read(addresses: str = Query(...)) -> JSONResponse:
        now, cache, values = historian.now(), {}, []
        for address in _addresses(addresses):
            tag = historian.by_name.get(address)
            newest = None if tag is None else historian.newest(tag, now)
            if tag is not None and newest is not None:
                values.append(historian.item(tag, newest, cache))
        served(len(values))
        return JSONResponse({"values": values})

    @app.get("/history", dependencies=[Depends(guard), Depends(pace(True))])
    def history(addresses: str = Query(...), start: str = Query(...), end: str = Query(...),
                limit: int | None = Query(default=None, ge=1)) -> JSONResponse:
        first, last = _aware("start", start), _aware("end", end)
        if last < first:
            raise HTTPException(422, "end is before start")
        now, cache = historian.now(), {}
        cap = min(limit or config.max_rows, config.max_rows)
        requested = _addresses(addresses)
        tags = [historian.by_name[a] for a in requested if a in historian.by_name]
        merged = heapq.merge(*(historian.rows(tag, *historian.window(tag, first, last, now)) for tag in tags))
        taken = list(itertools.islice(merged, cap + 1))  # one row more than sent, to know whether the answer was cut and where
        cut = len(taken) > cap
        complete = datetime.fromtimestamp(taken[cap][0], timezone.utc) if cut else min(last, now)
        values = [historian.item(tag, k, cache) for _, _, _, tag, k in taken[:cap]]
        served(len(values))
        unknown = [a for a in requested if a not in historian.by_name]
        return JSONResponse({"values": values, "complete_until": complete.isoformat(), "unknown": unknown})

    @app.get("/stats", dependencies=[Depends(guard)])
    def get_stats() -> dict:
        with stats.lock:
            return {"requests": dict(stats.requests), "rows_served": stats.rows,
                    "responses_503": stats.sent_503, "responses_429": stats.sent_429}

    return app
