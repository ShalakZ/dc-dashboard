"""The fleet summary's rules that need no database: live power over the roots, and which readings need attention.

Both use the staleness rule of the asset pages (`core.widgets.is_stale`) and the quality convention of the readings
(0 is good). The route in `api.data` loads the rows and calls these.
"""
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from dcdash.core.rollup import power_sources
from dcdash.core.tree import AssetTree
from dcdash.core.widgets import is_stale

ATTENTION_LIMIT = 25  # the most items the summary lists; its `total` still counts them all


@dataclass(frozen=True)
class PowerReading:
    """The latest reading of an asset's own `active_power_kw` meter. `value_kw` is already scaled; all three of
    value_kw, ts and quality are None for a meter that was never read."""

    value_kw: float | None
    ts: datetime | None
    quality: int | None
    interval_seconds: int


def fleet_power(
    tree: AssetTree, meters: Mapping[int, PowerReading], now: datetime
) -> tuple[float | None, int, int]:
    """(kW, meters counted, meters in all) over every root of the tree. A root with its own meter counts that
    meter only; any other root, the meters below it (`power_sources`). A meter is counted when its reading is good
    and fresh. kW is None, never 0, when none is counted."""
    kw, counted, of = 0.0, 0, 0
    for root in tree.roots():
        sources = [root] if root in meters else power_sources(tree, meters.keys(), root)
        of += len(sources)
        for source in sources:
            reading = meters[source]
            if (
                reading.quality == 0
                and reading.value_kw is not None
                and reading.ts is not None
                and not is_stale(reading.ts, now, reading.interval_seconds)
            ):
                kw += reading.value_kw
                counted += 1
    return (kw if counted else None), counted, of


@dataclass(frozen=True)
class MappedReading:
    """One mapping of an enabled source with its point's latest reading (ts, value and quality None: never read)."""

    asset_id: int
    interval_seconds: int
    ts: datetime | None
    value: float | None
    quality: int | None


@dataclass(frozen=True)
class AttentionRow:
    asset_id: int
    problem: Literal["bad", "stale"]
    points: int  # how many of the asset's mappings have a problem
    last_ts: datetime  # the newest reading among them


def attention(readings: Iterable[MappedReading], now: datetime) -> list[AttentionRow]:
    """One row per asset with a problem reading, all of them (the caller cuts the list at ATTENTION_LIMIT). A
    reading is bad when its quality is not 0 or it has no value, else stale when it is older than the asset pages
    allow; a point never read is skipped. An asset is "bad" if any of its mappings is, else "stale". Bad before
    stale, then the oldest `last_ts` first, then the asset id."""
    found: dict[int, tuple[bool, int, datetime]] = {}  # asset id -> (any bad, problem mappings, newest ts)
    for reading in readings:
        if reading.ts is None:
            continue
        bad = reading.quality != 0 or reading.value is None
        if not bad and not is_stale(reading.ts, now, reading.interval_seconds):
            continue
        was_bad, points, last_ts = found.get(reading.asset_id, (False, 0, reading.ts))
        found[reading.asset_id] = (was_bad or bad, points + 1, max(last_ts, reading.ts))
    rows = [AttentionRow(a, "bad" if bad else "stale", points, last_ts) for a, (bad, points, last_ts) in found.items()]
    return sorted(rows, key=lambda r: (r.problem != "bad", r.last_ts, r.asset_id))
