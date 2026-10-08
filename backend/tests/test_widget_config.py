import pytest

from dcdash.core.metrics import Metric
from dcdash.core.timeutil import RANGE_PRESETS
from dcdash.core.widgets import WIDGET_TYPES, WidgetConfig, validate_config

BASE = {"assets": [1], "source": "metric", "metric": "active_power_kw", "aggregation": "avg"}
GAUGE = {**BASE, "aggregation": "last", "max": 100.0}  # valid for every widget type


def make(**overrides) -> dict:
    return {**BASE, **overrides}


def reject(widget_type: str, config: dict) -> str:
    """Validate a config that must fail and return the message."""
    with pytest.raises(ValueError) as caught:
        validate_config(widget_type, config)
    return str(caught.value)


def test_the_five_widget_types():
    assert WIDGET_TYPES == ("timeseries", "bar", "stat", "gauge", "table")


@pytest.mark.parametrize("widget_type", ["timeseries", "bar", "table"])
@pytest.mark.parametrize(
    "overrides",
    [
        {},
        {"assets": [1, 2, 3], "aggregation": "max"},
        {"source": "energy", "metric": None, "aggregation": "sum"},
        {"source": "cost", "metric": None, "aggregation": "sum", "range": "last_month"},
    ],
)
def test_timeseries_bar_and_table_accept_any_valid_source(widget_type, overrides):
    assert isinstance(validate_config(widget_type, make(**overrides)), WidgetConfig)


def test_defaults_are_filled_in():
    parsed = validate_config("stat", make(aggregation="last"))
    assert (parsed.range, parsed.bars, parsed.min, parsed.max) == (None, "asset", 0.0, None)
    assert parsed.model_dump(mode="json")["metric"] == "active_power_kw"


def test_assets_are_between_one_and_twenty():
    assert validate_config("table", make(assets=list(range(1, 21)))).assets == list(range(1, 21))
    message = reject("table", make(assets=list(range(1, 22))))  # Review Focus 4: 21 assets
    assert message.startswith("assets:") and "20" in message and "21" in message
    assert "at least one" in reject("table", make(assets=[]))


def test_an_asset_can_appear_only_once():
    message = reject("table", make(assets=[4, 5, 4]))
    assert message.startswith("assets:") and "once" in message


def test_asset_ids_must_be_integers():
    assert reject("table", make(assets=["north"])).startswith("assets.0:")


def test_source_metric_requires_a_metric():
    message = reject("stat", make(metric=None))  # Review Focus 4: missing metric for source metric
    assert message.startswith("metric:") and "required" in message
    without_key = {key: value for key, value in BASE.items() if key != "metric"}
    assert reject("stat", without_key).startswith("metric:")


def test_the_custom_metric_is_refused():
    message = reject("stat", make(metric="custom"))  # Review Focus 4: custom metric
    assert message.startswith("metric:") and "custom" in message


def test_an_unknown_metric_is_refused():
    assert reject("stat", make(metric="banana")).startswith("metric:")


@pytest.mark.parametrize("source", ["energy", "cost"])
def test_energy_and_cost_take_no_metric(source):
    assert validate_config("stat", make(source=source, metric=None, aggregation="sum")).metric is None
    message = reject("stat", make(source=source, metric="active_power_kw", aggregation="sum"))
    assert message.startswith("metric:") and source in message


@pytest.mark.parametrize("aggregation", ["avg", "min", "max", "last"])
def test_metric_sources_take_avg_min_max_last(aggregation):
    assert validate_config("table", make(aggregation=aggregation)).aggregation == aggregation


def test_sum_is_not_a_metric_aggregation():
    message = reject("table", make(aggregation="sum"))
    assert message.startswith("aggregation:") and "avg" in message


@pytest.mark.parametrize("source", ["energy", "cost"])
def test_energy_and_cost_take_sum_only(source):
    assert validate_config("table", make(source=source, metric=None, aggregation="sum")).aggregation == "sum"
    for aggregation in ("avg", "min", "max", "last"):
        message = reject("table", make(source=source, metric=None, aggregation=aggregation))
        assert message.startswith("aggregation:") and "sum" in message


def test_an_unknown_aggregation_is_refused():
    assert reject("table", make(aggregation="median")).startswith("aggregation:")


@pytest.mark.parametrize("preset", RANGE_PRESETS)
def test_every_preset_is_a_valid_range(preset):
    assert validate_config("timeseries", make(range=preset)).range == preset


def test_a_null_range_inherits_the_dashboard():
    assert validate_config("timeseries", make(range=None)).range is None
    assert validate_config("timeseries", make()).range is None


@pytest.mark.parametrize("bad", ["last_year", "2h", "", "TODAY", "24H"])
def test_a_range_that_is_not_a_preset_is_refused(bad):
    message = reject("timeseries", make(range=bad))  # Review Focus 4: range 'last_year'
    assert message.startswith("range:") and "last_month" in message


@pytest.mark.parametrize("widget_type", ["stat", "gauge"])
def test_stat_and_gauge_take_exactly_one_asset(widget_type):
    config = {**GAUGE, "assets": [7]}
    assert validate_config(widget_type, config).assets == [7]
    message = reject(widget_type, {**GAUGE, "assets": [7, 8]})  # Review Focus 4: stat with two assets
    assert message.startswith("assets:") and "exactly one" in message and widget_type in message


def test_a_gauge_needs_a_metric_source():
    energy = {"assets": [1], "source": "energy", "aggregation": "sum", "max": 10.0}
    message = reject("gauge", energy)  # Review Focus 4: gauge on energy
    assert message.startswith("source:") and "gauge" in message


@pytest.mark.parametrize("aggregation", ["avg", "min", "max"])
def test_a_gauge_reads_the_last_value(aggregation):
    message = reject("gauge", {**GAUGE, "aggregation": aggregation})
    assert message.startswith("aggregation:") and "last" in message


def test_a_gauge_needs_a_maximum():
    without_max = {key: value for key, value in GAUGE.items() if key != "max"}
    message = reject("gauge", without_max)  # Review Focus 4: gauge without max
    assert message.startswith("max:") and "maximum" in message


@pytest.mark.parametrize("low, high", [(0.0, 0.0), (10.0, 5.0), (-5.0, -5.0)])
def test_a_gauge_maximum_must_exceed_its_minimum(low, high):
    message = reject("gauge", {**GAUGE, "min": low, "max": high})
    assert message.startswith("max:") and "greater than min" in message


def test_a_gauge_may_have_a_negative_minimum():
    parsed = validate_config("gauge", {**GAUGE, "min": -50.0, "max": 50.0})
    assert (parsed.min, parsed.max) == (-50.0, 50.0)


@pytest.mark.parametrize("field", ["min", "max"])
@pytest.mark.parametrize("bad", [float("inf"), float("nan")])
def test_gauge_limits_must_be_finite(field, bad):
    assert reject("gauge", {**GAUGE, field: bad}).startswith(f"{field}:")


@pytest.mark.parametrize("widget_type", ["timeseries", "stat", "gauge", "table"])
def test_bars_time_only_applies_to_bar_widgets(widget_type):
    message = reject(widget_type, {**GAUGE, "bars": "time"})  # Review Focus 4: bars='time' on a stat
    assert message.startswith("bars:") and "bar" in message


def test_bar_widgets_accept_both_bar_modes():
    for bars in ("asset", "time"):
        assert validate_config("bar", make(bars=bars)).bars == bars


@pytest.mark.parametrize("widget_type", WIDGET_TYPES)
def test_the_default_bars_value_is_accepted_everywhere(widget_type):
    assert validate_config(widget_type, {**GAUGE, "bars": "asset"}).bars == "asset"


def test_an_unknown_bars_value_is_refused():
    assert reject("bar", make(bars="week")).startswith("bars:")


def test_unknown_keys_are_refused():
    assert reject("stat", make(aggregation="last", colour="red")).startswith("colour:")


def test_unknown_widget_type():
    message = reject("pie", make())
    assert message.startswith("type:") and "pie" in message and "gauge" in message


def test_several_problems_are_reported_together_in_plain_words():
    message = reject("table", make(assets=[], range="soon"))
    assert "assets:" in message and "range:" in message and "; " in message
    assert "validation error" not in message and "\n" not in message


# Controller rulings after the plan review (amendments for Task 5).


@pytest.mark.parametrize("aggregation", ["avg", "min", "max", "sum"])
@pytest.mark.parametrize("widget_type", ["timeseries", "bar", "stat", "table"])
def test_the_cumulative_energy_meter_reading_takes_last_only(widget_type, aggregation):
    message = reject(widget_type, make(metric="energy_kwh", aggregation=aggregation))
    assert message.startswith("aggregation:") and "energy_kwh" in message and "last" in message


@pytest.mark.parametrize("widget_type", ["timeseries", "bar", "stat", "table"])
def test_the_energy_meter_reading_with_last_is_accepted(widget_type):
    parsed = validate_config(widget_type, make(metric="energy_kwh", aggregation="last"))
    assert (parsed.metric, parsed.aggregation) == (Metric.ENERGY_KWH, "last")


def test_a_gauge_may_show_the_energy_meter_reading():
    assert validate_config("gauge", {**GAUGE, "metric": "energy_kwh"}).metric is Metric.ENERGY_KWH


def test_the_energy_meter_rule_does_not_restrict_other_metrics():
    for metric in Metric:
        if metric is Metric.CUSTOM or metric is Metric.ENERGY_KWH:
            continue
        for aggregation in ("avg", "min", "max", "last"):
            assert validate_config("table", make(metric=metric.value, aggregation=aggregation)).metric is metric


@pytest.mark.parametrize("aggregation", ["avg", "min", "max", "last"])
def test_a_timeseries_accepts_any_aggregation_valid_for_its_source(aggregation):
    # The chart always draws the average with a band; the setting is ignored but still has to make sense.
    assert validate_config("timeseries", make(aggregation=aggregation)).aggregation == aggregation


@pytest.mark.parametrize(
    "overrides",
    [
        {"aggregation": "sum"},
        {"source": "energy", "metric": None, "aggregation": "avg"},
        {"source": "cost", "metric": None, "aggregation": "last"},
        {"aggregation": "median"},
    ],
)
def test_a_timeseries_aggregation_must_still_be_valid_for_its_source(overrides):
    assert reject("timeseries", make(**overrides)).startswith("aggregation:")


@pytest.mark.parametrize("aggregation", ["avg", "min", "max", "last"])
def test_bars_over_time_take_every_metric_aggregation(aggregation):
    parsed = validate_config("bar", make(bars="time", aggregation=aggregation))
    assert (parsed.bars, parsed.aggregation) == ("time", aggregation)


@pytest.mark.parametrize("source", ["energy", "cost"])
def test_bars_over_time_on_energy_and_cost_take_sum_only(source):
    assert validate_config("bar", make(bars="time", source=source, metric=None, aggregation="sum")).bars == "time"
    message = reject("bar", make(bars="time", source=source, metric=None, aggregation="avg"))
    assert message.startswith("aggregation:") and "sum" in message
