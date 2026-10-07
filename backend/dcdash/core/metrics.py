from enum import StrEnum


class Metric(StrEnum):
    ACTIVE_POWER_KW = "active_power_kw"
    ENERGY_KWH = "energy_kwh"
    VOLTAGE_V = "voltage_v"
    CURRENT_A = "current_a"
    POWER_FACTOR = "power_factor"
    FREQUENCY_HZ = "frequency_hz"
    REACTIVE_POWER_KVAR = "reactive_power_kvar"
    APPARENT_POWER_KVA = "apparent_power_kva"
    CUSTOM = "custom"


_UNITS = {
    Metric.ACTIVE_POWER_KW: "kW",
    Metric.ENERGY_KWH: "kWh",
    Metric.VOLTAGE_V: "V",
    Metric.CURRENT_A: "A",
    Metric.POWER_FACTOR: "",
    Metric.FREQUENCY_HZ: "Hz",
    Metric.REACTIVE_POWER_KVAR: "kvar",
    Metric.APPARENT_POWER_KVA: "kVA",
}


def default_interval(metric: Metric) -> int:
    """Polling interval in seconds used when a mapping does not set one."""
    return 60 if metric is Metric.ENERGY_KWH else 5


def unit_for(metric: Metric, custom_unit: str | None) -> str:
    if metric is Metric.CUSTOM:
        return custom_unit or ""
    return _UNITS[metric]
