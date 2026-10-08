"""Widget configuration: the rules every saved or previewed widget must satisfy (spec 10.5).

`validate_config` is the only entry point for configs that come from a client. Messages are plain
text that names the field ("assets: at most 20 assets per widget (got 21)") so the editor can show them.
"""
import math
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator, model_validator

from dcdash.core.metrics import Metric
from dcdash.core.timeutil import RANGE_PRESETS

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
