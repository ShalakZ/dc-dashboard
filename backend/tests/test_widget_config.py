import json
from pathlib import Path

import pytest

from dcdash.core.metrics import Metric
from dcdash.core.timeutil import RANGE_PRESETS
from dcdash.core.widgets import (
    DATA_WIDGET_TYPES, TEXT_LIMITS, TEXT_STYLES, TRIM_SET, WIDGET_TYPES, TextConfig, WidgetConfig, normalize_text,
    validate_config, validate_data_config, validate_text_config,
)

# The rules of a Text widget's text, shared with the editor's vitest (frontend/src/lib/textWidget.test.ts). Pure ASCII.
SAMPLES = json.loads((Path(__file__).parent / "fixtures" / "text_widget_samples.json").read_text(encoding="ascii"))
BASE = {"assets": [1], "source": "metric", "metric": "active_power_kw", "aggregation": "avg"}
GAUGE = {**BASE, "aggregation": "last", "max": 100.0}  # valid for every widget type


def make(**overrides) -> dict:
    return {**BASE, **overrides}


def reject(widget_type: str, config: dict) -> str:
    """Validate a config that must fail and return the message."""
    with pytest.raises(ValueError) as caught:
        validate_config(widget_type, config)
    return str(caught.value)


def test_the_six_widget_types_and_the_five_that_draw_data():
    assert WIDGET_TYPES == ("timeseries", "bar", "stat", "gauge", "table", "text")
    assert DATA_WIDGET_TYPES == ("timeseries", "bar", "stat", "gauge", "table")


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


@pytest.mark.parametrize("widget_type", DATA_WIDGET_TYPES)
def test_the_default_bars_value_is_accepted_everywhere(widget_type):
    assert validate_config(widget_type, {**GAUGE, "bars": "asset"}).bars == "asset"


def test_an_unknown_bars_value_is_refused():
    assert reject("bar", make(bars="week")).startswith("bars:")


def test_unknown_keys_are_refused():
    assert reject("stat", make(aggregation="last", colour="red")).startswith("colour:")


def test_unknown_widget_type():
    message = reject("pie", make())
    assert message.startswith("type:") and "pie" in message and "gauge" in message and "text" in message


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


# ---- the Text widget (w22): a heading, a paragraph or a divider; no data ---------------------------------------------------

CASES = SAMPLES["cases"]


def typed(case: dict) -> str:
    """The text a sample feeds in: written out, or one string repeated."""
    return case["text"] if "text" in case else case["repeat"][0] * case["repeat"][1]


def stored(case: dict) -> str:
    return case["stored"] if "stored" in case else case["stored_repeat"][0] * case["stored_repeat"][1]


def test_the_sample_file_is_pure_ascii_and_shares_the_servers_constants():
    raw = (Path(__file__).parent / "fixtures" / "text_widget_samples.json").read_bytes()
    assert raw.isascii()
    assert TRIM_SET == SAMPLES["trim_set"]
    assert TEXT_LIMITS == SAMPLES["limits"] == {"heading": 200, "paragraph": 2000}
    assert TEXT_STYLES == ("heading", "paragraph", "divider")
    assert {case["style"] for case in CASES} == set(TEXT_STYLES)  # every style has samples
    assert {case["reason"] for case in CASES if not case["ok"]} == set(SAMPLES["server_message_contains"])  # every reason too


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_every_sample_of_the_shared_file_gets_the_same_answer_on_the_server(case):
    config = {"style": case["style"], "text": typed(case)}
    if case["ok"]:
        parsed = validate_config("text", config)
        assert isinstance(parsed, TextConfig)
        assert parsed.style == case["style"] and parsed.text == stored(case)
        assert len(parsed.text) == case["count"]
        assert parsed.model_dump(mode="json") == {"style": case["style"], "text": stored(case)}
        assert normalize_text(case["style"], typed(case)) == stored(case)
        assert validate_text_config(parsed.model_dump(mode="json")).text == stored(case)  # what is stored is stable
    else:
        message = reject("text", config)
        assert message.startswith("text:"), message
        assert SAMPLES["server_message_contains"][case["reason"]] in message, message
        with pytest.raises(ValueError):
            normalize_text(case["style"], typed(case))


def test_the_messages_name_the_character_and_the_limits():
    assert reject("text", {"style": "paragraph", "text": "a" + chr(0) + "b"}) == "text: contains a control character (U+0000)"
    assert reject("text", {"style": "paragraph", "text": "ab" + chr(0x7F)}) == "text: contains a control character (U+007F)"
    assert reject("text", {"style": "paragraph", "text": "ab" + chr(0x85)}) == "text: contains a control character (U+0085)"
    assert reject("text", {"style": "heading", "text": "x" + chr(0xD800)}) == "text: contains a character that cannot be stored (U+D800)"
    assert reject("text", {"style": "heading", "text": " "}) == "text: a heading cannot be empty"
    assert reject("text", {"style": "paragraph", "text": ""}) == "text: a paragraph cannot be empty"
    assert reject("text", {"style": "heading", "text": "a" * 201}) == "text: a heading can have at most 200 characters (got 201)"
    assert reject("text", {"style": "paragraph", "text": "a" * 2001}) == "text: a paragraph can have at most 2000 characters (got 2001)"
    assert reject("text", {"style": "heading", "text": "a\nb"}) == "text: a heading is one line; remove the line break"
    assert reject("text", {"style": "divider", "text": "x"}) == "text: a divider has no text"


def test_the_first_control_character_is_the_one_named():
    assert reject("text", {"style": "paragraph", "text": "a" + chr(1) + "b" + chr(2)}).endswith("(U+0001)")


def test_a_control_character_wins_over_a_lone_surrogate_as_in_the_editor():
    assert "control character" in reject("text", {"style": "paragraph", "text": chr(0xD800) + chr(0)})


def test_a_text_config_takes_exactly_a_style_and_a_text():
    assert validate_config("text", {"style": "divider", "text": ""}).model_dump(mode="json") == {"style": "divider", "text": ""}
    assert reject("text", {"style": "heading", "text": "x", "colour": "red"}).startswith("colour:")
    assert reject("text", {"text": "x"}).startswith("style:")
    assert reject("text", {"style": "heading"}).startswith("text:")
    assert reject("text", {"style": "banner", "text": "x"}).startswith("style:")
    assert reject("text", {"style": "Heading", "text": "x"}).startswith("style:")  # exactly lower case
    assert reject("text", {"style": "heading", "text": 5}).startswith("text:")
    assert reject("text", {"style": "heading", "text": None}).startswith("text:")
    assert reject("text", {"style": ["heading"], "text": "x"}).startswith("style:")
    assert "\n" not in reject("text", {})


def test_a_text_widget_never_accepts_a_data_config_and_a_data_widget_never_a_text_config():
    message = reject("text", make())
    assert "style:" in message and "validation error" not in message  # the data fields are extra, the text fields are missing
    for widget_type in DATA_WIDGET_TYPES:
        message = reject(widget_type, {"style": "heading", "text": "Hall A"})
        assert "assets:" in message and "Field required" in message and "style:" in message, widget_type


def test_the_split_entry_points_each_know_their_own_types():
    assert isinstance(validate_data_config("stat", make(aggregation="last")), WidgetConfig)
    assert isinstance(validate_text_config({"style": "heading", "text": "Hall A"}), TextConfig)
    assert isinstance(validate_config("stat", make(aggregation="last")), WidgetConfig)
    with pytest.raises(ValueError, match="type: a text widget has no data"):
        validate_data_config("text", {"style": "heading", "text": "Hall A"})
    with pytest.raises(ValueError, match="type: 'pie' is not a widget type; use one of .*text"):
        validate_data_config("pie", make())
    with pytest.raises(ValueError, match="style:"):
        validate_text_config(make())
    with pytest.raises(ValueError, match="style: 'banner'"):
        normalize_text("banner", "x")


def test_a_trimmed_character_inside_the_text_is_kept():
    assert validate_config("text", {"style": "paragraph", "text": "a" + chr(0xA0) + "b" + chr(0xFEFF) + "c"}).text == (
        "a" + chr(0xA0) + "b" + chr(0xFEFF) + "c"
    )
