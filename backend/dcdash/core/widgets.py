"""Widget configuration (spec 10.5) and the figures a widget draws (spec 10.6).

`validate_config` is the entry point for configs that come from a client (`validate_data_config` for the five types that
draw figures, `validate_text_config` for the Text widget, which holds no data). Messages are plain text that names the
field ("assets: at most 20 assets per widget (got 21)") so the editor can show them.
`compute_widget` answers POST /api/widget-data and its CSV export for a validated data config.
"""
import asyncio
import bisect
import logging
import math
import re
from collections.abc import Awaitable, Iterable
from dataclasses import asdict, dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal, Self
from zoneinfo import ZoneInfo

from pydantic import (
    BaseModel, ConfigDict, SerializerFunctionWrapHandler, ValidationError, field_validator, model_serializer,
    model_validator,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.api.settings import current_timezone
from dcdash.core.asset_kinds import _BLANKS as KIND_BLANKS
from dcdash.core.breakdown import Bar, candidates, common_spelling, kinds_present, top_and_more, trim_kind
from dcdash.core.breakdown import order as order_bars
from dcdash.core.compare import (
    Side, change, contributing_meters, rate_change, side_from_entries, snapshot_entries, snapshot_status, windows,
)
from dcdash.core.cost import HourCost, cost_by_hour, load_tariffs, summarize
from dcdash.core.db import get_sessionmaker
from dcdash.core.energy import HourEnergy, hourly_energy
from dcdash.core.figures import entries_at, month_days, window_values
from dcdash.core.metrics import Metric, unit_for
from dcdash.core.models import Asset, BillingClose
from dcdash.core.series import (
    DEFAULT_BUCKETS, combine_hours, first_mappings, last_rollup_value, latest_values, metric_aggregate, metric_hours,
    metric_series, series_tier,
)
from dcdash.core.settings_store import get_currency
from dcdash.core.timeutil import (
    RANGE_PRESETS, ROLLING, day_start, local_days, month_bounds, resolve_range, validate_whole_hour_zone,
)
from dcdash.core.tree import AssetTree

log = logging.getLogger(__name__)

WIDGET_TYPES =("timeseries", "bar", "stat", "gauge", "table", "text")
DATA_WIDGET_TYPES = tuple(widget_type for widget_type in WIDGET_TYPES if widget_type != "text")  # the ones that draw figures
TEXT_STYLES = ("heading", "paragraph", "divider")
TEXT_LIMITS = {"heading": 200, "paragraph": 2000}  # in Unicode code points; a divider holds no text
# The characters trimmed from both ends of a text: exactly the `trim_set` of tests/fixtures/text_widget_samples.json, which the
# editor (frontend/src/lib/textWidget.ts) also reads. Python's bare strip() is not used: it and JavaScript's trim() differ on U+FEFF.
# (TAB, LF, space, NBSP, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF; built from code points so
# that the source stays pure ASCII.)
TRIM_SET = "".join(
    chr(code) for code in (0x09, 0x0A, 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)
)
MAX_ASSETS = 20
KIND_MAX = 100  # characters of the kind a breakdown looks for, after trimming
TOP_DEFAULT, TOP_MIN, TOP_MAX = 10, 3, 50  # bars a kind breakdown draws
KIND_ENDS = re.compile(rf"\A(?:{KIND_BLANKS.pattern})|(?:{KIND_BLANKS.pattern})\Z")  # white space at either end of a kind
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
    bars: Literal["asset", "time", "kind"] = "asset"
    min: float = 0.0
    max: float | None = None
    # w24. A key at its default is left out of the stored dump (see `_without_defaults`), so every widget saved before w24
    # keeps exactly the config it has.
    compare: Literal["none", "same_days_last_month"] = "none"
    kind: str | None = None  # bars "kind": the kind of asset that gets a bar (matched with kind_key)
    root: int | None = None  # bars "kind": the asset the breakdown looks under; None is the whole site
    top: int = TOP_DEFAULT  # bars "kind": how many bars are drawn
    # w25. Which assets the widget shows: "fixed" the ones in `assets`; "focus" the dashboard's focus asset; "children" the
    # focus asset's direct children. A following scope leaves `assets` empty (`_resolve_focus` fills them in per request).
    scope: Literal["fixed", "focus", "children"] = "fixed"

    @model_serializer(mode="wrap")
    def _without_defaults(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data = handler(self)
        for key, default in (
            ("compare", "none"), ("kind", None), ("root", None), ("top", TOP_DEFAULT), ("scope", "fixed"),
        ):
            if key in data and data[key] == default:
                del data[key]
        return data

    @field_validator("assets")
    @classmethod
    def _assets(cls, value: list[int]) -> list[int]:
        # An empty list is judged by `_check_type_rules`: a breakdown by kind has no assets of its own.
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

    @field_validator("kind")
    @classmethod
    def _kind(cls, value: str | None) -> str | None:
        return None if value is None else KIND_ENDS.sub("", value)  # trimmed with the white space kind_key ignores

    @field_validator("top")
    @classmethod
    def _top(cls, value: int) -> int:
        if not TOP_MIN <= value <= TOP_MAX:
            raise ValueError(f"must be between {TOP_MIN} and {TOP_MAX} (got {value})")
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
    """Rules that depend on the widget type, which the config model does not know. Every message starts with the field
    it is about. The empty-assets rule is first (a breakdown by kind is the one widget that holds no assets of its own)."""
    kind_mode = config.bars == "kind"
    following = config.scope != "fixed"  # w25: the dashboard's focus chooses the assets, so the rules about them step aside
    if following:
        if config.assets:
            raise ValueError("assets: leave the assets empty; the focus chooses them")
    elif not config.assets and not kind_mode:
        raise ValueError("assets: choose at least one asset")
    if config.scope == "children":
        if widget_type not in ("timeseries", "bar", "table"):
            raise ValueError(f"scope: 'children' only applies to a time series, a bar chart or a table, not to a {widget_type}")
        if kind_mode:
            raise ValueError("scope: 'children' does not apply to a breakdown by kind")
        if config.compare != "none":
            raise ValueError("scope: 'children' cannot be compared with last month")
    if config.bars == "time" and widget_type != "bar":
        raise ValueError(f"bars: 'time' only applies to bar widgets, not to a {widget_type}")
    if kind_mode:
        if widget_type != "bar":
            raise ValueError(f"bars: 'kind' only applies to bar widgets, not to a {widget_type}")
        if config.source == "metric":
            raise ValueError("bars: 'kind' needs the source 'energy' or 'cost', not 'metric'")
        if config.assets:
            raise ValueError("assets: leave the assets empty for one bar per asset of a kind; 'root' says where to look")
        if not config.kind:
            raise ValueError("kind: choose the kind of asset that gets a bar")
        if len(config.kind) > KIND_MAX:
            raise ValueError(f"kind: at most {KIND_MAX} characters (got {len(config.kind)})")
        if config.scope == "focus" and config.root is not None:
            raise ValueError("root: leave it empty; a breakdown that follows the focus looks under the focus")
    else:
        stray = (("kind", config.kind is not None), ("root", config.root is not None), ("top", config.top != TOP_DEFAULT))
        for name, given in stray:
            if given:
                raise ValueError(f"{name}: only applies when the bars are one per asset of a kind")
    if config.compare != "none":
        if widget_type not in ("stat", "timeseries"):
            raise ValueError(f"compare: only a stat or a time series can compare, not a {widget_type}")
        if config.source == "metric":
            raise ValueError("compare: a comparison needs the source 'energy' or 'cost', not 'metric'")
        if not following and len(config.assets) != 1:  # a following widget gets exactly one asset from the focus
            raise ValueError(f"assets: a comparison shows exactly one asset (got {len(config.assets)})")
        if config.range != "this_month":
            raise ValueError("range: a comparison needs the range this month")
    if widget_type in SINGLE_ASSET_TYPES and not following and len(config.assets) != 1:
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


_LINE_SEPARATORS = (chr(0x2028), chr(0x2029))  # LINE SEPARATOR and PARAGRAPH SEPARATOR: line breaks like LF


def _code_point(char: str) -> str:
    return f"U+{ord(char):04X}"


def normalize_text(style: str, raw: str) -> str:
    """The text a Text widget stores, or ValueError (a message that starts "text:"). The rules are the editor's too
    (frontend/src/lib/textWidget.ts), held to the same answers by tests/fixtures/text_widget_samples.json. Order: (1) CRLF,
    a lone CR, U+2028 and U+2029 become LF; (2) control characters (all but TAB and LF) and lone surrogates are refused;
    (3) both ends are trimmed with TRIM_SET; (4) Unicode code points are counted with len(): a heading is 1 to 200 and one
    line, a paragraph 1 to 2000, a divider has none."""
    if style not in TEXT_STYLES:
        raise ValueError(f"style: {style!r} is not a text style; use one of {_either(TEXT_STYLES)}")
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    for separator in _LINE_SEPARATORS:
        text = text.replace(separator, "\n")
    for char in text:
        code = ord(char)
        if code <= 0x08 or 0x0B <= code <= 0x1F or 0x7F <= code <= 0x9F:
            raise ValueError(f"text: contains a control character ({_code_point(char)})")
    for char in text:
        if 0xD800 <= ord(char) <= 0xDFFF:  # a surrogate in a Python str is never half of a pair: the JSON parser joined those
            raise ValueError(f"text: contains a character that cannot be stored ({_code_point(char)})")
    text = text.strip(TRIM_SET)
    if style == "divider":
        if text:
            raise ValueError("text: a divider has no text")
        return ""
    if not text:
        raise ValueError(f"text: a {style} cannot be empty")
    if style == "heading" and "\n" in text:
        raise ValueError("text: a heading is one line; remove the line break")
    if len(text) > TEXT_LIMITS[style]:
        raise ValueError(f"text: a {style} can have at most {TEXT_LIMITS[style]} characters (got {len(text)})")
    return text


class TextConfig(BaseModel):
    """The config of a Text widget: a heading, a paragraph or a divider. It holds no data, so none of WidgetConfig's fields."""

    model_config = ConfigDict(extra="forbid")

    style: Literal["heading", "paragraph", "divider"]
    text: str

    @model_validator(mode="after")
    def _normalized(self) -> Self:
        self.text = normalize_text(self.style, self.text)  # what is stored is the normalized text
        return self


def validate_data_config(widget_type: str, config: dict[str, Any]) -> WidgetConfig:
    """Parse and check the config of a widget that draws figures; raise ValueError with a readable message naming the field."""
    if widget_type == "text":
        raise ValueError("type: a text widget has no data")
    if widget_type not in DATA_WIDGET_TYPES:
        raise ValueError(f"type: {widget_type!r} is not a widget type; use one of {', '.join(WIDGET_TYPES)}")
    try:
        parsed = WidgetConfig.model_validate(config)
    except ValidationError as error:
        raise ValueError(_readable(error)) from None
    _check_type_rules(widget_type, parsed)
    return parsed


def validate_text_config(config: dict[str, Any]) -> TextConfig:
    """Parse and check the config of a Text widget; the returned text is the normalized one."""
    try:
        return TextConfig.model_validate(config)
    except ValidationError as error:
        raise ValueError(_readable(error)) from None


def validate_config(widget_type: str, config: dict[str, Any]) -> WidgetConfig | TextConfig:
    """Parse and check any widget config that comes from a client: a TextConfig for "text", else a WidgetConfig."""
    if widget_type == "text":
        return validate_text_config(config)
    return validate_data_config(widget_type, config)


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


def _point_json(p: _Point) -> dict[str, Any]:
    return {
        "ts": p.ts.isoformat(), "value": p.value, "min": p.min, "max": p.max,
        "estimated": p.estimated, "partial": p.partial, "no_data": p.no_data,
    }


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
    compare: dict[str, Any] | None = None  # w24: the month-to-date comparison block (a compare widget only), else None
    breakdown: dict[str, Any] | None = None  # w24: the breakdown by kind block (a bar widget with bars "kind"), else None
    focus: dict[str, Any] | None = None  # w25: what a widget that follows the focus resolved to (see _resolve_focus), else None
    compare_rows: list[tuple[str, _Point]] = field(default_factory=list)  # (path, point): the last window's CSV rows
    # w24: a breakdown by kind keeps every bar here, in order (`values` holds only the first `top`); the CSV lists all of them.
    breakdown_values: list[_Value] | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "type": self.type, "mode": self.mode, "source": self.source, "metric": self.metric, "unit": self.unit,
            "range": {"preset": self.preset, "start": self.start.isoformat(), "end": self.end.isoformat()},
            "tier": self.tier, "bucket": self.bucket,
            "series": [
                {
                    "asset_id": s.asset_id, "name": s.name,
                    "points": [_point_json(p) for p in s.points],
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
            "compare": self.compare,
            "breakdown": self.breakdown,
            "focus": self.focus,
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
        listed = self.values if self.breakdown_values is None else self.breakdown_values
        rows += [row(v.path, self.start, v.value, v.estimated, v.partial, v.no_data) for v in listed]
        rows += [row(path, p.ts, p.value, p.estimated, p.partial, p.no_data) for path, p in self.compare_rows]
        return rows


def _mode(widget_type: str, config: WidgetConfig) -> str:
    if config.bars == "kind":  # one bar per asset of a kind: values, whatever the type says
        return "values"
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


def is_stale(read_at: datetime, now: datetime, interval_seconds: int) -> bool:
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
                read_at, stale = reading.ts, is_stale(reading.ts, now, mapping.interval_seconds)
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
    if result.mode != "series":
        # A plain value (a stat, a gauge, a table row, a breakdown bar): every asset's figure for the window comes from one
        # value, shared by every widget that asks for the same window (core/figures.py). Names and paths are the request's.
        values = (await window_values(db, first, last, end, tz_name, cost)).values
        for asset_id in asset_ids:
            name, path = tree.nodes[asset_id].name, tree.path(asset_id)
            figure = values.get(asset_id)  # None: no energy anywhere in this asset's subtree
            if figure is None:
                result.values.append(_Value(asset_id, name, path, None, no_data=True))
            else:
                value, estimated, partial, nothing = figure
                result.values.append(_Value(asset_id, name, path, value, estimated, partial, no_data=nothing))
        return
    energy = await hourly_energy(db, tree, first, last)
    tariffs = await load_tariffs(db) if cost else []
    hours_of = cost_by_hour(energy, tariffs, tree, tz_name) if cost else energy.hours
    for asset_id in asset_ids:
        name, path = tree.nodes[asset_id].name, tree.path(asset_id)
        figures = hours_of.get(asset_id)  # None: no energy anywhere in this asset's subtree
        hours = {} if figures is None else {hour: fig for hour, fig in figures.items() if first <= hour < last}
        groups = _by_span(hours.items(), spans)
        point = _cost_point if cost else _energy_point
        points = [] if figures is None else [point(label, group) for (label, _, _), group in zip(spans, groups)]
        result.series.append(_Series(asset_id, name, path, points))


async def _active_close_figures(db: AsyncSession, month: str) -> dict[str, Any] | None:
    """The frozen figures of `month` while its close is active (not reopened), else None: what Billing shows for it."""
    return await db.scalar(
        select(BillingClose.figures).where(BillingClose.month == month, BillingClose.reopened_at.is_(None))
    )


def _entry_point(label: datetime, entry: dict[str, Any] | None, cost: bool, *, with_cost: bool = True) -> _Point:
    """One day of a compare chart, from the very entry Billing shows for that day. A day without readings is a gap; a day
    with readings but no rate has no cost (value None, no_data False: the dash of a cost with no rate). `with_cost` False
    (a closed month in another currency) takes the cost away."""
    if entry is None or entry["no_data"]:
        return _Point(label, None, no_data=True)
    if not cost:
        return _Point(label, entry["kwh"], estimated=entry["estimated"])
    return _Point(label, entry["cost"] if with_cost else None, estimated=entry["estimated"], partial=entry["partial"])


def _window_json(first: date | None, last: date | None) -> dict[str, str] | None:
    return None if first is None or last is None else {"from": first.isoformat(), "to": last.isoformat()}


async def _together[A, B](first: Awaitable[A], second: Awaitable[B]) -> tuple[A, B]:
    """Await two coroutines side by side. If one fails (or the caller is cancelled) the other is cancelled and awaited first, so
    nothing keeps using a session the caller is about to close, and the original error goes on unchanged."""
    tasks = (asyncio.ensure_future(first), asyncio.ensure_future(second))
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


async def _fill_compare(
    db: AsyncSession, result: WidgetResult, tree: AssetTree, config: WidgetConfig, asset_id: int, now: datetime,
    tz_name: str, zone: ZoneInfo,
) -> None:
    """The month to date against the same days of last month, for ONE asset (spec w24, core/compare.py).

    Every figure is a sum of the day entries Billing's own calculation (core/daycost.py) gives for that day. The energy is
    read exactly as `month_costs` reads it, a whole month at a time, so the estimated placeholder hours of a silent
    power-only meter, and with them the `~` marks, are Billing's. A closed last month is read from its stored snapshot."""
    cost, chart = config.source == "cost", result.type == "timeseries"
    win = windows(now, tz_name)
    currency = await get_currency(db)
    result.unit = currency if cost else "kWh"
    result.bucket = "day" if chart else None
    month_start = month_bounds(win.this_month, tz_name)[0].astimezone(zone)
    shown = win.this_days if chart else win.this_days[: win.days]  # the span the figures cover
    result.start = shown[0][1].astimezone(zone) if shown else month_start
    result.end = shown[-1][2].astimezone(zone) if shown else month_start
    block: dict[str, Any] = {
        "mode": config.compare, "state": win.state, "elapsed_days": win.elapsed, "days": win.days,
        "this_window": _window_json(win.this_first, win.this_last),
        "last_window": _window_json(win.last_first, win.last_last),
        "left_out_days": [day.isoformat() for day in win.left_out],
        "last_month": {"month": win.last_month, "closed": False},
        "currency": currency, "assets": [],
    }
    result.compare = block
    if asset_id not in tree.nodes:  # the asset is gone: `missing` already says so
        return
    name, path = tree.nodes[asset_id].name, tree.path(asset_id)

    def finish(
        this: Side | None, last: Side | None, last_state: str, same_currency: bool, rate_date: date | None,
        last_points: list[_Point],
    ) -> None:
        block["assets"].append({
            "asset_id": asset_id, "name": name,
            "this": None if this is None else asdict(this), "last": None if last is None else asdict(last),
            "last_state": last_state,
            "kwh": asdict(change(this, last, "kwh", days=win.days, last_state=last_state)),
            "cost": asdict(change(this, last, "cost", days=win.days, last_state=last_state, same_currency=same_currency)),
            "rate_change": None if rate_date is None else {"date": rate_date.isoformat()},
            "last_points": [_point_json(p) for p in last_points] if chart else [],
        })

    if win.state == "nothing_yet":  # the 1st: no complete day yet, so no figure and no energy query
        if chart:
            result.series.append(_Series(asset_id, name, path, []))
        else:
            result.values.append(_Value(asset_id, name, path, None, no_data=True))
        finish(None, None, "no_readings", True, None, [])
        return

    # Both months come from the shared month values (core/figures.py): the same day entries Billing shows. Every lookup on the
    # figure side below (rates, the contributing meters, the rate note) uses the values' own tree and tariffs, never the
    # request's, so a configuration edit that lands between the request's load and the values' snapshot cannot mix two
    # configurations. The two values must agree on the configuration; if an edit landed between them, ask again (a few times,
    # then go on, and say so once in the log: the card then prices last month with its tariffs and takes the rest from this month).
    # The two months are asked for side by side: on a cold cache the cache runs both computations at once (their reads overlap,
    # their pure parts take turns on the one compute thread), where one after the other took the sum. An AsyncSession serves one
    # task at a time, so the second month asks through a session of its own.
    async with get_sessionmaker()() as other:
        for _ in range(3):
            md_last, md_this = await _together(
                month_days(db, tz_name, *month_bounds(win.last_month, tz_name)),
                month_days(other, tz_name, *month_bounds(win.this_month, tz_name)),
            )
            if md_last.config_fp == md_this.config_fp:
                break
        else:
            log.warning(
                "the comparison went on with two configurations: last month %s, this month %s (three tries)",
                md_last.config_fp[:8], md_this.config_fp[:8],
            )

    # The windows' days are prefixes of the months' local days (core/compare.py `windows`): same entries, by position.
    this_entries = entries_at(md_this, asset_id, now)[: len(win.this_days)]
    this = side_from_entries(this_entries[: win.days])

    last_entries: list[dict[str, Any] | None] | None  # None: nothing of last month can be set against this month
    figures = await _active_close_figures(db, win.last_month)
    same_zone, same_currency, last_state = True, True, "ok"
    if figures is None:
        last_entries = entries_at(md_last, asset_id, now)[: len(win.last_days)]
    else:
        block["last_month"]["closed"] = True
        same_zone, same_currency = snapshot_status(figures, tz_name, currency)
        last_entries = snapshot_entries(figures, asset_id, win.days) if same_zone else None
        if not same_zone:
            last_state = "other_zone"
        elif last_entries is None:
            last_state = "not_in_closed"
    last = None if last_entries is None else side_from_entries(last_entries)
    if last_state == "ok" and (last is None or last.no_data_days >= win.days):
        last_state = "no_readings"
    if last is not None and not same_currency:
        last = replace(last, cost=None)  # another currency: its cost is not a number to set against today's

    # The rate note: a price change somewhere between the first day of last month's window and the last of this month's.
    partial_owns = {
        owner for md in (md_last, md_this) for owner in md.own
        if md.own_from.get(owner) is not None and md.own_from[owner] > md.start_utc
    }
    meters = contributing_meters(md_this.tree, md_this.own, asset_id, partial_owns)
    rate_date = None
    if win.last_first is not None and win.this_last is not None:  # always, once the state is "ok"
        rate_date = rate_change(md_this.tariffs, md_this.tree, meters, after=win.last_first, up_to=win.this_last)

    last_points: list[_Point] = []
    if chart and last_entries is not None:
        last_points = [
            _entry_point(label.astimezone(zone), entry, cost, with_cost=same_currency)
            for (_, label, _), entry in zip(win.last_days, last_entries)
        ]
    if chart:
        points = [
            _entry_point(label.astimezone(zone), entry, cost) for (_, label, _), entry in zip(win.this_days, this_entries)
        ]
        result.series.append(_Series(asset_id, name, path, points))
        result.compare_rows = [(path, point) for point in last_points]
    else:
        measured = None if this is None else (this.cost if cost else this.kwh)
        result.values.append(_Value(
            asset_id, name, path, measured, False if this is None else this.estimated,
            cost and this is not None and this.partial,
            no_data=this is None or this.no_data_days >= win.days,
        ))
        # The last window's own CSV row, dated at its first day: the figure of the widget's measure, with its marks.
        gone = last is None or last.no_data_days >= win.days
        figure_of_last = None if last is None else (last.cost if cost else last.kwh)
        result.compare_rows = [(path, _Point(
            win.last_days[0][1].astimezone(zone), figure_of_last,
            estimated=last is not None and last.estimated, partial=cost and last is not None and last.partial, no_data=gone,
        ))]
    finish(this, last, last_state, same_currency, rate_date, last_points)


async def _fill_breakdown(
    db: AsyncSession, result: WidgetResult, tree: AssetTree, config: WidgetConfig,
    first: datetime, last: datetime, end: datetime, tz_name: str, zone: ZoneInfo,
) -> None:
    """One bar per asset of a kind (spec w24, core/breakdown.py).

    The figures are `_fill_billing`'s own, asked for the outer candidates, so a bar is exactly what a plain bar widget on that
    asset would draw. `result.values` keeps the first `top` in order and `result.breakdown_values` every bar (the CSV)."""
    kind, root = config.kind or "", config.root
    kinds = {  # only assets of the tree go on: an id the tree does not hold is not a candidate
        asset_id: text for asset_id, text in (await db.execute(select(Asset.id, Asset.kind))).all() if asset_id in tree.nodes
    }
    gone = root is not None and root not in tree.nodes  # the asset to look under was deleted
    outer, nested = ([], 0) if gone else candidates(tree, kinds, root, kind)
    await _fill_billing(db, result, tree, config, outer, first, last, end, tz_name, zone)
    by_id = {value.asset_id: value for value in result.values}
    ordered = order_bars(
        Bar(value.asset_id, value.path, value.value, value.no_data, value.estimated, value.partial)
        for value in result.values
    )
    shown, more = top_and_more(ordered, config.top)
    result.breakdown_values = [by_id[bar.asset_id] for bar in ordered]
    result.values = [by_id[bar.asset_id] for bar in shown]
    if gone:
        result.missing = [root] if root is not None else []
    result.breakdown = {
        "kind": common_spelling(kinds[asset_id] for asset_id in outer) if outer else trim_kind(kind),
        "root": None if root is None or gone else {"id": root, "name": tree.nodes[root].name},
        "count": len(outer), "shown": len(shown), "more": asdict(more),
        "no_data": sum(1 for value in result.breakdown_values if value.no_data), "inside_others": nested,
        "kinds": [  # the whole tree's kinds when the root is gone, else the kinds under the root (before the nested rule)
            {"kind": text, "count": count} for text, count in kinds_present(tree, kinds, None if gone else root, kind)
        ],
    }


@dataclass
class _Resolved:
    """A config after the focus is applied: what to compute, and what to tell the client about the focus."""

    config: WidgetConfig  # always scope "fixed", with `assets` (or, for a breakdown, `root`) filled in from the focus
    block: dict[str, Any] | None  # the answer's `focus` block; None for a fixed widget
    empty: bool  # nothing to compute: the answer carries only the block
    missing: list[int]  # the focus itself when it is not in the tree


def _focus_block(
    tree: AssetTree, asset: int | None, state: str, children: dict[str, int] | None, top_level: int | None
) -> dict[str, Any]:
    named = None if asset is None else {"id": asset, "name": tree.nodes[asset].name, "path": tree.path(asset)}
    return {"asset": named, "state": state, "children": children, "top_level": top_level}


def _resolve_focus(tree: AssetTree, config: WidgetConfig, focus: int | None) -> _Resolved:
    """Turn a widget that follows the dashboard's focus into the plain widget it stands for, over the tree already loaded.

    `scope` "fixed" is returned as it is, whatever `focus` says. A `focus` that is not in the tree (deleted, or never an
    asset: the two look the same) resolves to nothing, with the id in `missing`. With no `focus`, a site with ONE top-level
    asset means that asset; with none or several, a breakdown looks at the whole site, a "children" widget lists the
    top-level assets, and any other widget asks for a focus (state "choose"). A stat, a gauge and a comparison therefore
    never see more than one asset, and a "children" widget never more than MAX_ASSETS."""
    if config.scope == "fixed":
        return _Resolved(config, None, False, [])
    following = config.model_copy(update={"scope": "fixed"})
    breakdown = config.bars == "kind"
    roots = tree.roots()
    if focus is not None and focus not in tree.nodes:
        return _Resolved(following, _focus_block(tree, None, "gone", None, None), True, [focus])
    target = focus if focus is not None else (roots[0] if len(roots) == 1 else None)
    top_level = len(roots) if focus is None else None
    if target is None:  # no focus, and the site has no single top-level asset to stand for it
        if config.scope == "children":
            shown = roots[:MAX_ASSETS]
            counted = {"shown": len(shown), "count": len(roots)}
            return _Resolved(
                following.model_copy(update={"assets": shown}), _focus_block(tree, None, "ok", counted, top_level),
                not shown, [],
            )
        if breakdown:  # the whole site: `root` stays unset
            return _Resolved(following, _focus_block(tree, None, "ok", None, top_level), False, [])
        return _Resolved(following, _focus_block(tree, None, "choose", None, top_level), True, [])
    if config.scope == "focus":
        chosen = {"root": target} if breakdown else {"assets": [target]}
        return _Resolved(following.model_copy(update=chosen), _focus_block(tree, target, "ok", None, top_level), False, [])
    kids = tree.children(target)
    shown = kids[:MAX_ASSETS]
    counted = {"shown": len(shown), "count": len(kids)}
    return _Resolved(
        following.model_copy(update={"assets": shown}), _focus_block(tree, target, "ok", counted, top_level), not shown, []
    )


async def compute_widget(
    db: AsyncSession, widget_type: str, config: WidgetConfig, preset: str, now: datetime, *, focus: int | None = None
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
    resolved = _resolve_focus(tree, config, focus)  # w25: from here on the plain widget a following one stands for
    config = resolved.config
    # Only ids in the tree go on to SQL: a deleted asset, or an id no integer column can hold, is just missing.
    asset_ids = [asset_id for asset_id in config.assets if asset_id in tree.nodes]
    result = WidgetResult(
        type=widget_type, mode=_mode(widget_type, config), source=config.source, metric=None, unit=None,
        preset=preset, start=first.astimezone(zone), end=end.astimezone(zone),
        missing=[asset_id for asset_id in config.assets if asset_id not in tree.nodes] + resolved.missing,
        focus=resolved.block,
    )
    if resolved.empty:  # a focus that is gone, none to follow, or no children: the block says why, nothing is computed
        return result
    if config.bars == "kind":  # validate_data_config made it a bar widget on energy or cost with no assets of its own
        await _fill_breakdown(db, result, tree, config, first, last, end, tz_name, zone)
    elif config.compare != "none":  # a comparison replaces the plain billing figures (validate_data_config made it one asset)
        await _fill_compare(db, result, tree, config, config.assets[0], now, tz_name, zone)
    elif billing:
        await _fill_billing(db, result, tree, config, asset_ids, first, last, end, tz_name, zone)
    else:
        await _fill_metric(db, result, tree, config, asset_ids, start, end, now, tz_name, zone)
    return result


async def widget_data(
    db: AsyncSession, widget_type: str, config: WidgetConfig, preset: str, now: datetime, *, focus: int | None = None
) -> dict[str, Any]:
    """The figures a widget draws, as the JSON body of POST /api/widget-data. `preset` is the effective range."""
    return (await compute_widget(db, widget_type, config, preset, now, focus=focus)).as_json()
