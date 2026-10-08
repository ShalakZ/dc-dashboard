"""Widget configuration (spec 10.5) and the figures a widget draws (spec 10.6).

`validate_config` is the only entry point for configs that come from a client. Messages are plain
text that names the field ("assets: at most 20 assets per widget (got 21)") so the editor can show them.
`compute_widget` answers POST /api/widget-data and its CSV export for a validated config.
"""
import bisect
import math
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Self
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.settings import current_timezone
from dcdash.core.cost import HourCost, cost_by_hour, load_tariffs, no_data, rate_at, summarize
from dcdash.core.energy import HourEnergy, hourly_energy
from dcdash.core.metrics import Metric, unit_for
from dcdash.core.series import (
    DEFAULT_BUCKETS, combine_hours, first_mappings, last_rollup_value, latest_values, metric_aggregate, metric_hours,
    metric_series, series_tier,
)
from dcdash.core.settings_store import get_currency
from dcdash.core.timeutil import (
    RANGE_PRESETS, ROLLING, day_start, local_days, resolve_range, validate_whole_hour_zone,
)
from dcdash.core.tree import AssetTree

WIDGET_TYPES = ("timeseries", "bar", "stat", "gauge", "table")
MAX_ASSETS = 20
METRIC_AGGREGATIONS = ("avg", "min", "max", "last")
SINGLE_ASSET_TYPES = ("stat", "gauge")


def _either(options: tuple[str, ...]) -> str:
    return options[0] if len(options) == 1 else ", ".join(options[:-1]) + " or " + options[-1]


class WidgetConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assets: list[int]
    source: Literal["metric", "energy", "cost"]
    metric: Metric | None = None
    aggregation: Literal["avg", "min", "max", "last", "sum"]
    range: str | None = None
    bars: Literal["asset", "time"] = "asset"
    min: float = 0.0
    max: float | None = None

    @field_validator("assets")
    @classmethod
    def _assets(cls, value: list[int]) -> list[int]:
        if not value:
            raise ValueError("choose at least one asset")
        if len(value) > MAX_ASSETS:
            raise ValueError(f"at most {MAX_ASSETS} assets per widget (got {len(value)})")
        if len(set(value)) != len(value):
            raise ValueError("each asset can appear only once")
        return value

    @field_validator("range")
    @classmethod
    def _range(cls, value: str | None) -> str | None:
        if value is not None and value not in RANGE_PRESETS:
            raise ValueError(
                f"{value!r} is not a range preset; use one of {', '.join(RANGE_PRESETS)}, "
                "or leave it empty to follow the dashboard"
            )
        return value

    @field_validator("min", "max")
    @classmethod
    def _finite(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("must be a finite number")
        return value

    @model_validator(mode="after")
    def _source_rules(self) -> Self:
        if self.source == "metric":
            if self.metric is None:
                raise ValueError("metric: required when the source is 'metric'")
            if self.metric is Metric.CUSTOM:
                raise ValueError("metric: 'custom' cannot be used in a widget; custom metrics stay on the asset page")
            if self.metric is Metric.ENERGY_KWH and self.aggregation != "last":
                raise ValueError(
                    "aggregation: energy_kwh is a cumulative meter reading, so only 'last' applies "
                    "(use the source 'energy' for the kWh used over a period)"
                )
            allowed: tuple[str, ...] = METRIC_AGGREGATIONS
        else:
            if self.metric is not None:
                raise ValueError(f"metric: must be empty when the source is '{self.source}'")
            allowed = ("sum",)
        if self.aggregation not in allowed:
            raise ValueError(
                f"aggregation: '{self.aggregation}' is not valid for the source '{self.source}'; use {_either(allowed)}"
            )
        return self


def _readable(error: ValidationError) -> str:
    """Pydantic's multi-line report as 'field: reason; field: reason'."""
    parts = []
    for item in error.errors():
        message = item["msg"].removeprefix("Value error, ")
        field = ".".join(str(part) for part in item["loc"])
        parts.append(f"{field}: {message}" if field else message)
    return "; ".join(parts)


def _check_type_rules(widget_type: str, config: WidgetConfig) -> None:
    """Rules that depend on the widget type, which the config model does not know."""
    if config.bars == "time" and widget_type != "bar":
        raise ValueError(f"bars: 'time' only applies to bar widgets, not to a {widget_type}")
    if widget_type in SINGLE_ASSET_TYPES and len(config.assets) != 1:
        raise ValueError(f"assets: a {widget_type} shows exactly one asset (got {len(config.assets)})")
    if widget_type == "gauge":
        if config.source != "metric":
            raise ValueError(f"source: a gauge needs the source 'metric', not '{config.source}'")
        if config.aggregation != "last":
            raise ValueError(f"aggregation: a gauge reads the 'last' value, not '{config.aggregation}'")
        if config.max is None:
            raise ValueError("max: a gauge needs a maximum value")
        if config.max <= config.min:
            raise ValueError(f"max: must be greater than min (min is {config.min:g}, max is {config.max:g})")


def validate_config(widget_type: str, config: dict[str, Any]) -> WidgetConfig:
    """Parse and check a widget config; raise ValueError with a readable message naming the field."""
    if widget_type not in WIDGET_TYPES:
        raise ValueError(f"type: {widget_type!r} is not a widget type; use one of {', '.join(WIDGET_TYPES)}")
    try:
        parsed = WidgetConfig.model_validate(config)
    except ValidationError as error:
        raise ValueError(_readable(error)) from None
    _check_type_rules(widget_type, parsed)
    return parsed


# ---- widget data -------------------------------------------------------------------------------------------

LIVE_LAST = ROLLING | {"today", "this_month"}  # presets that end now: `last` is the latest reading
HOUR = timedelta(hours=1)
HOURLY_UP_TO = timedelta(hours=48)  # series are bucketed by hour up to this range length, by local day beyond
STALE_AFTER_INTERVALS = 3  # a live reading older than this many polling intervals (and than STALE_MINIMUM) is stale
STALE_MINIMUM = timedelta(seconds=60)

Span = tuple[datetime, datetime, datetime]  # a bucket: (label in the site zone, from, to) with from and to in UTC


class SiteZoneError(Exception):
    """The stored site timezone breaks the whole-hour rule (spec section 6); the API answers 409."""


@dataclass
class _Point:
    ts: datetime
    value: float | None  # None: nothing was recorded (no_data), or consumption was recorded but no rate applies
    min: float | None = None
    max: float | None = None
    estimated: bool = False
    partial: bool = False
    no_data: bool = False  # nothing was recorded in the bucket; value None with no_data False is a cost with no rate


@dataclass
class _Series:
    asset_id: int
    name: str
    path: str
    points: list[_Point]


@dataclass
class _Value:
    asset_id: int
    name: str
    path: str
    value: float | None
    estimated: bool = False
    partial: bool = False
    point_id: int | None = None
    no_data: bool = False
    ts: datetime | None = None  # `last` only: when the value was read
    stale: bool = False  # `last` only: a live reading older than three polling intervals


@dataclass
class WidgetResult:
    type: str
    mode: str
    source: str
    metric: str | None
    unit: str | None
    preset: str
    start: datetime  # site zone; the window the figures cover (energy and cost: whole hours)
    end: datetime
    tier: str | None = None
    bucket: str | None = None
    series: list[_Series] = field(default_factory=list)
    values: list[_Value] = field(default_factory=list)
    missing: list[int] = field(default_factory=list)  # assets that no longer exist
    no_metric: list[int] = field(default_factory=list)  # assets with no mapping of their own for the metric

    def as_json(self) -> dict[str, Any]:
        return {
            "type": self.type, "mode": self.mode, "source": self.source, "metric": self.metric, "unit": self.unit,
            "range": {"preset": self.preset, "start": self.start.isoformat(), "end": self.end.isoformat()},
            "tier": self.tier, "bucket": self.bucket,
            "series": [
                {
                    "asset_id": s.asset_id, "name": s.name,
                    "points": [
                        {
                            "ts": p.ts.isoformat(), "value": p.value, "min": p.min, "max": p.max,
                            "estimated": p.estimated, "partial": p.partial, "no_data": p.no_data,
                        }
                        for p in s.points
                    ],
                    "estimated": any(p.estimated for p in s.points), "partial": any(p.partial for p in s.points),
                }
                for s in self.series
            ],
            "values": [
                {
                    "asset_id": v.asset_id, "name": v.name, "value": v.value, "estimated": v.estimated,
                    "partial": v.partial, "point_id": v.point_id, "no_data": v.no_data,
                    "ts": None if v.ts is None else v.ts.isoformat(), "stale": v.stale,
                }
                for v in self.values
            ],
            "missing": self.missing,
            "no_metric": self.no_metric,
        }

    def csv_rows(self) -> list[list[object]]:
        """Rows for core/csvout.write_csv: numbers stay numbers, a null value is an empty cell, flags are true/false."""
        source, unit = self.metric or self.source, self.unit or ""

        def row(
            path: str, ts: datetime, value: float | None, estimated: bool, partial: bool, no_data: bool
        ) -> list[object]:
            return [path, source, unit, ts.isoformat(), "" if value is None else value,
                    "true" if estimated else "false", "true" if partial else "false", "true" if no_data else "false"]

        rows = [row(s.path, p.ts, p.value, p.estimated, p.partial, p.no_data) for s in self.series for p in s.points]
        rows += [row(v.path, self.start, v.value, v.estimated, v.partial, v.no_data) for v in self.values]
        return rows


def _mode(widget_type: str, config: WidgetConfig) -> str:
    return "series" if widget_type == "timeseries" or (widget_type == "bar" and config.bars == "time") else "values"


def _floor_hour(moment: datetime) -> datetime:
    return moment.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def _ceil_hour(moment: datetime) -> datetime:
    floor = _floor_hour(moment)
    return floor if floor == moment else floor + HOUR


def _hour_window(preset: str, start: datetime, end: datetime) -> tuple[datetime, datetime]:
    """The whole UTC hours [first, last) that energy and cost cover. A rolling preset is its N most recent hour
    buckets including the current partial one, so 1h is the hour so far; a calendar preset is rounded outwards."""
    if preset in ROLLING:
        buckets = round((end - start) / HOUR)
        return _floor_hour(end) - (buckets - 1) * HOUR, _floor_hour(end) + HOUR
    return _floor_hour(start), _ceil_hour(end)


def _spans(first: datetime, last: datetime, tz_name: str, zone: ZoneInfo) -> tuple[str, list[Span]]:
    """The buckets a series over [first, last) is drawn in: one per hour that begins in it for a range of at most
    48 hours, else one per local day overlapping it (the first and last may be partial; each is labelled by its
    day, at the first instant that day has, which is not 00:00 where the zone skips midnight)."""
    if last - first <= HOURLY_UP_TO:
        hours, hour = [], _ceil_hour(first)
        while hour < last:
            hours.append((hour.astimezone(zone), hour, hour + HOUR))
            hour += HOUR
        return "hour", hours
    return "day", [(day_start(lo, tz_name).astimezone(zone), lo, hi) for _, lo, hi in local_days(first, last, tz_name)]


def _by_span[T](items: Iterable[tuple[datetime, T]], spans: list[Span]) -> list[list[T]]:
    """Each item, which is stamped with the hour it belongs to, in the list of the span that holds that hour."""
    starts = [lo for _, lo, _ in spans]
    groups: list[list[T]] = [[] for _ in spans]
    for hour, item in items:
        index = bisect.bisect_right(starts, hour) - 1
        if index >= 0 and hour < spans[index][2]:
            groups[index].append(item)
    return groups


def _energy_point(label: datetime, hours: list[HourEnergy]) -> _Point:
    measured = [h for h in hours if h.has_data]
    if not measured:  # nothing was recorded in this bucket: a gap, never a zero
        return _Point(label, None, no_data=True)
    return _Point(label, sum(h.kwh for h in measured), estimated=any(h.estimated for h in measured))


def _cost_point(label: datetime, hours: list[HourCost]) -> _Point:
    measured = [h for h in hours if h.has_data]
    if not measured:
        return _Point(label, None, no_data=True)
    cost = summarize(measured)  # value None here means hours were recorded but none has a rate: no_data stays False
    return _Point(label, cost.cost, estimated=cost.estimated, partial=cost.partial)


def _is_stale(read_at: datetime, now: datetime, interval_seconds: int) -> bool:
    return now - read_at > max(timedelta(seconds=STALE_AFTER_INTERVALS * interval_seconds), STALE_MINIMUM)


async def _fill_metric(
    db: AsyncSession, result: WidgetResult, tree: AssetTree, config: WidgetConfig, asset_ids: list[int],
    start: datetime, end: datetime, now: datetime, tz_name: str, zone: ZoneInfo,
) -> None:
    aggregation = config.aggregation
    metric = Metric(config.metric)
    result.metric, result.unit = metric.value, unit_for(metric, None)
    mappings = await first_mappings(db, asset_ids, metric)
    result.no_metric = [asset_id for asset_id in asset_ids if asset_id not in mappings]
    asset_ids = [asset_id for asset_id in asset_ids if asset_id in mappings]
    if result.type == "timeseries":  # always the average with a min-max band, whatever the aggregation says
        result.tier = series_tier(start, end, DEFAULT_BUCKETS)
        for asset_id in asset_ids:
            found = await metric_series(db, mappings[asset_id], start, end, DEFAULT_BUCKETS)
            points = [  # a negative scale swaps the band's edges
                _Point(p.ts.astimezone(zone), p.avg, min(p.min, p.max), max(p.min, p.max), no_data=p.avg is None)
                for p in found.points
            ]
            result.series.append(_Series(asset_id, tree.nodes[asset_id].name, tree.path(asset_id), points))
        return
    if result.mode == "series":  # bars over time: the aggregation inside each hour or day, from the hourly rollup
        result.tier = "1h"
        result.bucket, spans = _spans(start, end, tz_name, zone)
        for asset_id in asset_ids:
            mapping = mappings[asset_id]
            groups = _by_span(((r.bucket, r) for r in await metric_hours(db, mapping, start, end)), spans)
            points = []
            for (label, _, _), rows in zip(spans, groups):
                bucket = combine_hours(rows, mapping.scale)
                points.append(
                    _Point(label, None, no_data=True) if bucket.avg is None
                    else _Point(label, getattr(bucket, aggregation), bucket.min, bucket.max)
                )
            result.series.append(_Series(asset_id, tree.nodes[asset_id].name, tree.path(asset_id), points))
        return
    live = aggregation == "last" and result.preset in LIVE_LAST
    latest = await latest_values(db, list(mappings.values())) if live else {}
    result.tier = None if aggregation == "last" else series_tier(start, end, DEFAULT_BUCKETS)
    for asset_id in asset_ids:
        mapping = mappings[asset_id]
        value, read_at, stale = None, None, False
        if live:
            reading = latest.get(mapping.id)
            if reading is not None:
                read_at, stale = reading.ts, _is_stale(reading.ts, now, mapping.interval_seconds)
                value = reading.value if reading.ts >= start else None  # a reading from before the range is no data
        elif aggregation == "last":
            reading = await last_rollup_value(db, mapping, start, end)
            if reading is not None:
                value, read_at = reading.value, reading.ts
        else:
            value = getattr(await metric_aggregate(db, mapping, start, end, DEFAULT_BUCKETS), aggregation)
        result.values.append(_Value(
            asset_id, tree.nodes[asset_id].name, tree.path(asset_id), value, point_id=mapping.point_id,
            no_data=value is None, ts=None if read_at is None else read_at.astimezone(zone), stale=stale,
        ))


async def _fill_billing(
    db: AsyncSession, result: WidgetResult, tree: AssetTree, config: WidgetConfig, asset_ids: list[int],
    first: datetime, last: datetime, end: datetime, tz_name: str, zone: ZoneInfo,
) -> None:
    cost = config.source == "cost"
    result.unit = await get_currency(db) if cost else "kWh"
    if result.mode == "series":
        result.bucket, spans = _spans(first, last, tz_name, zone)
    if not asset_ids:
        return
    energy = await hourly_energy(db, tree, first, last)
    tariffs = await load_tariffs(db) if cost else []
    hours_of = cost_by_hour(energy, tariffs, tree, tz_name) if cost else energy.hours
    last_day = (end - timedelta(microseconds=1)).astimezone(zone).date()  # the local day the period ends on
    for asset_id in asset_ids:
        name, path = tree.nodes[asset_id].name, tree.path(asset_id)
        figures = hours_of.get(asset_id)  # None: no energy anywhere in this asset's subtree
        hours = {} if figures is None else {hour: fig for hour, fig in figures.items() if first <= hour < last}
        if result.mode == "series":
            groups = _by_span(hours.items(), spans)
            point = _cost_point if cost else _energy_point
            points = [] if figures is None else [point(label, group) for (label, _, _), group in zip(spans, groups)]
            result.series.append(_Series(asset_id, name, path, points))
        elif figures is None:
            result.values.append(_Value(asset_id, name, path, None, no_data=True))
        elif cost:
            # A period with no hours under a rate in effect costs 0.0, exactly as on Billing and the asset page.
            rated = rate_at(tariffs, tree, asset_id, last_day) is not None
            total = summarize(hours.values(), rate_in_effect=rated)
            # Billing prices each day on its own and adds the days up. A multi-day window whose recorded hours are all
            # unpriced (they fall before the rate starts) still ends under a rate, and Billing's later empty days
            # cost 0.0: so the window costs 0.0 there too, and `partial` keeps saying that some hours had no rate.
            cost_total = 0.0 if total.cost is None and rated else total.cost
            result.values.append(_Value(
                asset_id, name, path, cost_total, total.estimated, total.partial, no_data=no_data(hours.values())
            ))
        else:
            kwh = sum((h.kwh for h in hours.values()), 0.0)  # 0.0, not int 0, for an empty window
            result.values.append(_Value(
                asset_id, name, path, kwh, any(h.estimated for h in hours.values()),
                no_data=not any(h.has_data for h in hours.values()),
            ))


async def compute_widget(
    db: AsyncSession, widget_type: str, config: WidgetConfig, preset: str, now: datetime
) -> WidgetResult:
    tz_name = await current_timezone(db)
    try:
        validate_whole_hour_zone(tz_name)
    except ValueError as exc:
        raise SiteZoneError(f"the site timezone {tz_name} cannot be used for energy ranges: {exc}") from None
    zone = ZoneInfo(tz_name)
    start, end = resolve_range(preset, now, tz_name)
    billing = config.source != "metric"
    first, last = _hour_window(preset, start, end) if billing else (start, end)
    tree = await AssetTree.load(db)
    # Only ids in the tree go on to SQL: a deleted asset, or an id no integer column can hold, is just missing.
    asset_ids = [asset_id for asset_id in config.assets if asset_id in tree.nodes]
    result = WidgetResult(
        type=widget_type, mode=_mode(widget_type, config), source=config.source, metric=None, unit=None,
        preset=preset, start=first.astimezone(zone), end=end.astimezone(zone),
        missing=[asset_id for asset_id in config.assets if asset_id not in tree.nodes],
    )
    if billing:
        await _fill_billing(db, result, tree, config, asset_ids, first, last, end, tz_name, zone)
    else:
        await _fill_metric(db, result, tree, config, asset_ids, start, end, now, tz_name, zone)
    return result


async def widget_data(
    db: AsyncSession, widget_type: str, config: WidgetConfig, preset: str, now: datetime
) -> dict[str, Any]:
    """The figures a widget draws, as the JSON body of POST /api/widget-data. `preset` is the effective range."""
    return (await compute_widget(db, widget_type, config, preset, now)).as_json()
