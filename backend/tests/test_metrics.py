from dcdash.core.metrics import Metric, default_interval, unit_for


def test_energy_counters_poll_slowly_everything_else_fast():
    assert default_interval(Metric.ENERGY_KWH) == 60
    assert default_interval(Metric.ACTIVE_POWER_KW) == 5
    assert default_interval(Metric.CUSTOM) == 5


def test_units():
    assert unit_for(Metric.ACTIVE_POWER_KW, None) == "kW"
    assert unit_for(Metric.ENERGY_KWH, None) == "kWh"
    assert unit_for(Metric.POWER_FACTOR, None) == ""
    assert unit_for(Metric.CUSTOM, "°C") == "°C"
    assert unit_for(Metric.CUSTOM, None) == ""


def test_metric_values_match_the_spec_list():
    assert {m.value for m in Metric} == {
        "active_power_kw", "energy_kwh", "voltage_v", "current_a", "power_factor",
        "frequency_hz", "reactive_power_kvar", "apparent_power_kva", "custom",
    }
