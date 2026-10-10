from enum import StrEnum
from typing import Annotated

from pydantic import Field


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


# A scale multiplies every stored value when it is read. An infinite or absurd scale makes the result infinite, which the
# API writes as null (the UI reads "no rate"). 1e12 leaves room for any unit conversion and keeps float32 readings finite (a double near 1.8e308 can still overflow; that is a corrupt reading, not a scale).
MAX_SCALE = 1e12
Scale = Annotated[float, Field(gt=0, le=MAX_SCALE, allow_inf_nan=False)]


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
